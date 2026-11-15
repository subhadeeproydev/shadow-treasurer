// Real Airwallex sandbox client (REST, https://api-demo.airwallex.com/api/v1).
// Enabled when AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY are set. Uses a scoped API key; only the
// executor module calls the money-moving methods. Every money-moving call carries a request_id.
import type { Balances, Currency, Rates } from '../domain/types.ts';
import { CURRENCIES } from '../domain/types.ts';
import type {
  AirwallexPort, Conversion, CreateTransferInput, FinancialTransaction, Quote, Transfer, TransferStatus,
} from './port.ts';
import { UncertainOutcomeError } from './port.ts';

const DEFAULT_BASE_URL = 'https://api-demo.airwallex.com';
const TOKEN_TTL_MS = 25 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

export interface AirwallexHttpConfig {
  readonly clientId: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly globalAccountId?: string;
}

type Json = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));

export class AirwallexHttp implements AirwallexPort {
  readonly mode = 'sandbox' as const;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly baseUrl: string;
  private readonly cfg: AirwallexHttpConfig;

  constructor(cfg: AirwallexHttpConfig) {
    this.cfg = cfg;
    this.baseUrl = cfg.baseUrl ?? DEFAULT_BASE_URL;
  }

  private async authToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const res = await fetch(`${this.baseUrl}/api/v1/authentication/login`, {
      method: 'POST',
      headers: { 'x-client-id': this.cfg.clientId, 'x-api-key': this.cfg.apiKey, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`airwallex_auth_failed: HTTP ${res.status}`);
    const body = (await res.json()) as Json;
    this.token = { value: str(body.token), expiresAt: Date.now() + TOKEN_TTL_MS };
    return this.token.value;
  }

  /** moneyMoving=true turns timeouts/5xx into UncertainOutcomeError so callers look up by request_id. */
  private async call(method: 'GET' | 'POST', path: string, body?: Json, moneyMovingRequestId?: string): Promise<Json> {
    const token = await this.authToken();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      if (moneyMovingRequestId) throw new UncertainOutcomeError(moneyMovingRequestId, `network: ${String(err)}`);
      throw err;
    }
    if (res.status >= 500 && moneyMovingRequestId) {
      throw new UncertainOutcomeError(moneyMovingRequestId, `HTTP ${res.status}`);
    }
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as Json) : {};
    if (!res.ok) throw new Error(`airwallex ${method} ${path} -> ${res.status}: ${str(parsed.code)} ${str(parsed.message)}`);
    return parsed;
  }

  async getBalances(): Promise<Balances> {
    const rows = (await this.call('GET', '/balances/current')) as unknown as Json[] | Json;
    const list = Array.isArray(rows) ? rows : ((rows.items as Json[]) ?? []);
    const empty = Object.fromEntries(CURRENCIES.map((c) => [c, 0])) as Record<Currency, number>;
    for (const row of list) {
      const c = str(row.currency) as Currency;
      if (CURRENCIES.includes(c)) empty[c] = num(row.available_amount);
    }
    return empty;
  }

  async getRates(base: Currency): Promise<Rates> {
    const out = { [base]: 1 } as Record<Currency, number>;
    for (const c of CURRENCIES.filter((x) => x !== base)) {
      const r = await this.call('GET', `/fx/rates/current?buy_currency=${base}&sell_currency=${c}&buy_amount=1000`);
      out[c] = num(r.client_rate ?? r.rate);
    }
    return out;
  }

  async createQuote(sell: Currency, buy: Currency, buyAmount: number): Promise<Quote> {
    const q = await this.call('POST', '/fx/quotes/create', {
      buy_currency: buy, sell_currency: sell, buy_amount: buyAmount, validity: 'MIN_15',
    });
    return {
      quoteId: str(q.quote_id), sellCurrency: sell, buyCurrency: buy, buyAmount: num(q.buy_amount),
      sellAmount: num(q.sell_amount), clientRate: num(q.client_rate), validTo: str(q.valid_to_at ?? q.valid_to),
    };
  }

  async createConversion(requestId: string, quote: Quote): Promise<Conversion> {
    const c = await this.call('POST', '/fx/conversions/create', {
      request_id: requestId, quote_id: quote.quoteId, buy_currency: quote.buyCurrency, sell_currency: quote.sellCurrency,
      buy_amount: quote.buyAmount, term_agreement: true,
    }, requestId);
    return {
      conversionId: str(c.conversion_id ?? c.id), requestId, status: str(c.status) as Conversion['status'],
      buyAmount: num(c.buy_amount), sellAmount: num(c.sell_amount),
    };
  }

  private transferBody(input: CreateTransferInput): Json {
    return {
      request_id: input.requestId, beneficiary_id: input.beneficiaryId, source_currency: input.currency,
      transfer_currency: input.currency, transfer_amount: input.amount, transfer_method: 'LOCAL',
      reference: input.reference.slice(0, 35), reason: 'business_expenses',
    };
  }

  async validateTransfer(input: CreateTransferInput): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.call('POST', '/transfers/validate', this.transferBody(input));
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  private toTransfer(t: Json): Transfer {
    return {
      id: str(t.id), requestId: str(t.request_id), status: str(t.status) as TransferStatus,
      amount: num(t.transfer_amount ?? t.amount), currency: str(t.transfer_currency) as Currency,
      beneficiaryId: str(t.beneficiary_id), failureReason: t.failure_reason ? str(t.failure_reason) : undefined,
    };
  }

  async createTransfer(input: CreateTransferInput): Promise<Transfer> {
    return this.toTransfer(await this.call('POST', '/transfers/create', this.transferBody(input), input.requestId));
  }

  async findTransferByRequestId(requestId: string): Promise<Transfer | null> {
    const r = await this.call('GET', `/transfers?request_id=${encodeURIComponent(requestId)}`);
    const items = (r.items as Json[]) ?? [];
    return items.length ? this.toTransfer(items[0]) : null;
  }

  async getTransfer(transferId: string): Promise<Transfer> {
    return this.toTransfer(await this.call('GET', `/transfers/${transferId}`));
  }

  async listFinancialTransactions(sourceId: string): Promise<readonly FinancialTransaction[]> {
    const r = await this.call('GET', `/financial_transactions?source_id=${encodeURIComponent(sourceId)}`);
    return ((r.items as Json[]) ?? []).map((f) => ({
      id: str(f.id), sourceId: str(f.source_id), sourceType: str(f.source_type) as FinancialTransaction['sourceType'],
      amount: num(f.amount), currency: str(f.currency) as Currency,
      status: str(f.status) === 'SETTLED' ? 'SETTLED' : 'PENDING',
    }));
  }

  async simulateDeposit(currency: Currency, amount: number, payer: string): Promise<{ id: string }> {
    const r = await this.call('POST', '/simulation/deposit/create', {
      amount, currency, global_account_id: this.cfg.globalAccountId, payer_name: payer,
    });
    return { id: str(r.id) };
  }

  async simulateTransferTransition(transferId: string, next: 'PAID' | 'FAILED', reason?: string): Promise<Transfer> {
    const body: Json = { next_status: next };
    if (reason) body.failure_reason = reason;
    return this.toTransfer(await this.call('POST', `/simulation/transfers/${transferId}/transition`, body));
  }
}
