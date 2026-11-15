// One interface for everything that touches Airwallex. Two implementations:
//  - AirwallexHttp: the real sandbox REST API (https://api-demo.airwallex.com)
//  - SimulatedAirwallex: an in-memory replica with the same shapes, for offline demos and the Gauntlet.
import type { Balances, Currency, Rates } from '../domain/types.ts';

export interface Quote {
  readonly quoteId: string;
  readonly sellCurrency: Currency;
  readonly buyCurrency: Currency;
  readonly buyAmount: number;
  readonly sellAmount: number;
  readonly clientRate: number;
  readonly validTo: string;
}

export interface Conversion {
  readonly conversionId: string;
  readonly requestId: string;
  readonly status: 'SCHEDULED' | 'SETTLED' | 'CANCELLED';
  readonly buyAmount: number;
  readonly sellAmount: number;
}

export type TransferStatus = 'PROCESSING' | 'SENT' | 'PAID' | 'FAILED' | 'CANCELLED';

export interface Transfer {
  readonly id: string;
  readonly requestId: string;
  readonly status: TransferStatus;
  readonly amount: number;
  readonly currency: Currency;
  readonly beneficiaryId: string;
  readonly failureReason?: string;
}

export interface FinancialTransaction {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceType: 'TRANSFER' | 'CONVERSION' | 'DEPOSIT' | 'REFUND';
  readonly amount: number;
  readonly currency: Currency;
  readonly status: 'PENDING' | 'SETTLED';
}

export interface CreateTransferInput {
  readonly requestId: string;
  readonly beneficiaryId: string;
  readonly currency: Currency;
  readonly amount: number;
  readonly reference: string;
}

/** Thrown when the outcome of a money-moving call is unknown (timeout, 5xx). Never retry blindly. */
export class UncertainOutcomeError extends Error {
  readonly requestId: string;
  constructor(requestId: string, message: string) {
    super(message);
    this.name = 'UncertainOutcomeError';
    this.requestId = requestId;
  }
}

export interface AirwallexPort {
  readonly mode: 'simulated' | 'sandbox';
  getBalances(): Promise<Balances>;
  getRates(base: Currency): Promise<Rates>;
  createQuote(sell: Currency, buy: Currency, buyAmount: number): Promise<Quote>;
  createConversion(requestId: string, quote: Quote): Promise<Conversion>;
  validateTransfer(input: CreateTransferInput): Promise<{ readonly ok: boolean; readonly reason?: string }>;
  createTransfer(input: CreateTransferInput): Promise<Transfer>;
  findTransferByRequestId(requestId: string): Promise<Transfer | null>;
  getTransfer(id: string): Promise<Transfer>;
  listFinancialTransactions(sourceId: string): Promise<readonly FinancialTransaction[]>;
  simulateDeposit(currency: Currency, amount: number, payer: string): Promise<{ readonly id: string }>;
  simulateTransferTransition(transferId: string, next: 'PAID' | 'FAILED', reason?: string): Promise<Transfer>;
}
