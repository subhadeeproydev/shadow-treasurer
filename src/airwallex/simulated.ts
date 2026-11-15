// In-memory replica of the Airwallex sandbox calls Shadow Treasurer uses. Same request/response
// semantics that matter for safety: request_id idempotency, quotes that expire, transfers that move
// through PROCESSING -> PAID | FAILED, refunds on failure, and financial transactions per source.
import { randomUUID } from 'node:crypto';
import type { Balances, Currency, Rates } from '../domain/types.ts';
import { round2, withDelta } from '../domain/money.ts';
import type {
  AirwallexPort, Conversion, CreateTransferInput, FinancialTransaction, Quote, Transfer,
} from './port.ts';
import { UncertainOutcomeError } from './port.ts';

const QUOTE_TTL_MS = 15 * 60_000; // mirrors validity MIN_15
const FX_SPREAD = 0.002;

export interface SimulatedOptions {
  readonly balances: Balances;
  /** Base-currency value of one unit of each currency (base = USD). */
  readonly rates: Rates;
  readonly now?: () => Date;
  readonly knownBeneficiaryIds?: readonly string[];
}

const id = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

export class SimulatedAirwallex implements AirwallexPort {
  readonly mode = 'simulated' as const;
  private balances: Balances;
  private rates: Rates;
  private readonly now: () => Date;
  private readonly quotes = new Map<string, Quote>();
  private readonly conversionsByRequest = new Map<string, Conversion>();
  private readonly transfers = new Map<string, Transfer>();
  private readonly transfersByRequest = new Map<string, string>();
  private readonly ledger: FinancialTransaction[] = [];
  private readonly knownBeneficiaries: Set<string>;
  /** Chaos hooks used by the Gauntlet. */
  private failNextCreateAfterCommit = false;
  private readonly forcedFailures = new Map<string, string>();

  constructor(opts: SimulatedOptions) {
    this.balances = opts.balances;
    this.rates = opts.rates;
    this.now = opts.now ?? (() => new Date());
    this.knownBeneficiaries = new Set(opts.knownBeneficiaryIds ?? []);
  }

  // ---- chaos controls (simulation only) ----
  setRate(currency: Currency, rate: number): void { this.rates = { ...this.rates, [currency]: rate }; }
  /** The next createTransfer commits server-side but the response is lost (timeout). */
  loseNextResponse(): void { this.failNextCreateAfterCommit = true; }
  failTransfersTo(beneficiaryId: string, reason: string): void { this.forcedFailures.set(beneficiaryId, reason); }
  addBeneficiary(beneficiaryId: string): void { this.knownBeneficiaries.add(beneficiaryId); }
  allTransfers(): readonly Transfer[] { return [...this.transfers.values()]; }

  async getBalances(): Promise<Balances> { return this.balances; }

  async getRates(): Promise<Rates> { return this.rates; }

  async createQuote(sell: Currency, buy: Currency, buyAmount: number): Promise<Quote> {
    const clientRate = round2((this.rates[buy] / this.rates[sell]) * (1 + FX_SPREAD) * 10_000) / 10_000;
    const quote: Quote = {
      quoteId: id('quote'), sellCurrency: sell, buyCurrency: buy, buyAmount,
      sellAmount: round2(buyAmount * clientRate), clientRate,
      validTo: new Date(this.now().getTime() + QUOTE_TTL_MS).toISOString(),
    };
    this.quotes.set(quote.quoteId, quote);
    return quote;
  }

  async createConversion(requestId: string, quote: Quote): Promise<Conversion> {
    const existing = this.conversionsByRequest.get(requestId);
    if (existing) return existing; // idempotent on request_id
    const q = this.quotes.get(quote.quoteId);
    if (!q) throw new Error('quote_not_found');
    if (new Date(q.validTo) < this.now()) throw new Error('quote_expired');
    if ((this.balances[q.sellCurrency] ?? 0) < q.sellAmount) throw new Error('insufficient_fund');
    this.balances = withDelta(withDelta(this.balances, q.sellCurrency, -q.sellAmount), q.buyCurrency, q.buyAmount);
    const conversion: Conversion = {
      conversionId: id('conv'), requestId, status: 'SETTLED', buyAmount: q.buyAmount, sellAmount: q.sellAmount,
    };
    this.conversionsByRequest.set(requestId, conversion);
    this.ledger.push({ id: id('ft'), sourceId: conversion.conversionId, sourceType: 'CONVERSION', amount: q.buyAmount, currency: q.buyCurrency, status: 'SETTLED' });
    return conversion;
  }

  async validateTransfer(input: CreateTransferInput): Promise<{ ok: boolean; reason?: string }> {
    if (input.amount <= 0) return { ok: false, reason: 'invalid_amount' };
    if (!this.knownBeneficiaries.has(input.beneficiaryId)) return { ok: false, reason: 'beneficiary_not_found' };
    if ((this.balances[input.currency] ?? 0) < input.amount) return { ok: false, reason: 'insufficient_fund' };
    return { ok: true };
  }

  async createTransfer(input: CreateTransferInput): Promise<Transfer> {
    const existingId = this.transfersByRequest.get(input.requestId);
    if (existingId) return this.transfers.get(existingId)!; // idempotent on request_id
    const v = await this.validateTransfer(input);
    if (!v.ok) throw new Error(v.reason);
    this.balances = withDelta(this.balances, input.currency, -input.amount);
    const transfer: Transfer = {
      id: id('tfr'), requestId: input.requestId, status: 'PROCESSING', amount: input.amount,
      currency: input.currency, beneficiaryId: input.beneficiaryId,
    };
    this.transfers.set(transfer.id, transfer);
    this.transfersByRequest.set(input.requestId, transfer.id);
    this.ledger.push({ id: id('ft'), sourceId: transfer.id, sourceType: 'TRANSFER', amount: -input.amount, currency: input.currency, status: 'PENDING' });
    if (this.failNextCreateAfterCommit) {
      this.failNextCreateAfterCommit = false;
      throw new UncertainOutcomeError(input.requestId, 'timeout after 30s (transfer may have been created)');
    }
    return transfer;
  }

  async findTransferByRequestId(requestId: string): Promise<Transfer | null> {
    const tid = this.transfersByRequest.get(requestId);
    return tid ? this.transfers.get(tid) ?? null : null;
  }

  async getTransfer(transferId: string): Promise<Transfer> {
    const t = this.transfers.get(transferId);
    if (!t) throw new Error('transfer_not_found');
    return t;
  }

  async listFinancialTransactions(sourceId: string): Promise<readonly FinancialTransaction[]> {
    return this.ledger.filter((f) => f.sourceId === sourceId);
  }

  async simulateDeposit(currency: Currency, amount: number, payer: string): Promise<{ id: string }> {
    const depositId = id('dep');
    this.balances = withDelta(this.balances, currency, amount);
    this.ledger.push({ id: id('ft'), sourceId: depositId, sourceType: 'DEPOSIT', amount, currency, status: 'SETTLED' });
    void payer;
    return { id: depositId };
  }

  /** Mirrors POST /simulation/transfers/{id}/transition. Settles pending transfers (auto-fails forced ones). */
  async simulateTransferTransition(transferId: string, next: 'PAID' | 'FAILED', reason?: string): Promise<Transfer> {
    const t = await this.getTransfer(transferId);
    if (t.status !== 'PROCESSING') return t;
    const forced = this.forcedFailures.get(t.beneficiaryId);
    const status = forced ? 'FAILED' : next;
    const updated: Transfer = { ...t, status, failureReason: status === 'FAILED' ? (reason ?? forced) : undefined };
    this.transfers.set(t.id, updated);
    const idx = this.ledger.findIndex((f) => f.sourceId === t.id && f.sourceType === 'TRANSFER');
    if (idx >= 0) this.ledger[idx] = { ...this.ledger[idx], status: 'SETTLED' };
    if (status === 'FAILED') {
      this.balances = withDelta(this.balances, t.currency, t.amount);
      this.ledger.push({ id: id('ft'), sourceId: t.id, sourceType: 'REFUND', amount: t.amount, currency: t.currency, status: 'SETTLED' });
    }
    return updated;
  }

  /** Settle every PROCESSING transfer (what the sandbox does when you transition them). */
  async settleAll(): Promise<readonly Transfer[]> {
    const pending = [...this.transfers.values()].filter((t) => t.status === 'PROCESSING');
    return Promise.all(pending.map((t) => this.simulateTransferTransition(t.id, 'PAID')));
  }
}
