// Core domain types for Shadow Treasurer. Amounts are in major units, rounded to 2dp.

export type Currency = 'USD' | 'EUR' | 'GBP' | 'AUD';
export const CURRENCIES: readonly Currency[] = ['USD', 'EUR', 'GBP', 'AUD'];

export type Action = 'FUND' | 'CONVERT' | 'DEFER' | 'ESCALATE' | 'PLACE' | 'RECALL';

export type AutonomyLevel = 0 | 1 | 2;
export const LEVEL_NAMES: Record<AutonomyLevel, string> = { 0: 'L0 Shadow', 1: 'L1 Assist', 2: 'L2 Bounded' };

/** The signed, versioned contract between the human and the agent. Code enforces every field. */
export interface Mandate {
  readonly id: string;
  readonly version: number;
  readonly goal: string;
  readonly baseCurrency: Currency;
  /** Operating cash (excluding the reserve bucket) must never fall below this, in base currency. */
  readonly reserveFloorBase: number;
  /** Largest single autonomous payment, in base currency, before confidence and track record. */
  readonly maxAutoPaymentBase: number;
  /** L1 may only auto-execute payments at or below this, in base currency. */
  readonly l1PaymentLimitBase: number;
  readonly dailyFxCapBase: number;
  readonly fundWindowHours: number;
  /** Cash above (floor + this many days of payables) is placed into the reserve bucket. */
  readonly placeAboveDaysOfNeed: number;
  readonly approvedBeneficiaryIds: readonly string[];
  readonly signedBy: string;
  readonly signedAt: string;
}

export interface Beneficiary {
  readonly id: string;
  readonly name: string;
  readonly currency: Currency;
  /** Fingerprint of the bank details on file (e.g. last 4 of IBAN + bank code). */
  readonly bankFingerprint: string;
  /** Airwallex beneficiary id when running against the real sandbox. */
  readonly airwallexBeneficiaryId?: string;
}

export type ObligationStatus = 'open' | 'in_flight' | 'paid' | 'failed' | 'blocked';

export interface Obligation {
  readonly id: string;
  readonly beneficiaryId: string;
  readonly currency: Currency;
  readonly amount: number;
  readonly dueAt: string;
  readonly description: string;
  readonly status: ObligationStatus;
  /** Set when evidence suggests the payee's bank details changed. */
  readonly bankDetailsChanged?: boolean;
  readonly source?: 'ledger' | 'evidence';
  readonly attempts: number;
  /** A failed payment may only be retried after a human approves the retry. */
  readonly retryNeedsApproval?: boolean;
}

export interface ExpectedInflow {
  readonly id: string;
  readonly payer: string;
  readonly currency: Currency;
  readonly amount: number;
  readonly expectedAt: string;
  /** 0..1 probability it lands on time, updated from evidence. */
  readonly confidence: number;
  readonly status: 'expected' | 'received' | 'late';
}

export type Balances = Readonly<Record<Currency, number>>;
/** Units of base currency per one unit of the keyed currency. */
export type Rates = Readonly<Record<Currency, number>>;

export interface ConvertStep {
  readonly sellCurrency: Currency;
  readonly buyCurrency: Currency;
  readonly buyAmount: number;
  readonly estSellAmount: number;
}

export interface Decision {
  readonly id: string;
  readonly cycle: number;
  readonly obligationId?: string;
  readonly action: Action;
  readonly rule: string;
  readonly reason: string;
  readonly currency: Currency;
  readonly amount: number;
  readonly amountBase: number;
  readonly convert?: ConvertStep;
  readonly recallBase?: number;
  /** true = code will execute without a human; false = proposal only / needs approval. */
  readonly autonomous: boolean;
  readonly needsApproval: boolean;
  readonly evidenceIds: readonly string[];
}

export interface EvidenceDoc {
  readonly id: string;
  readonly kind: 'email' | 'invoice' | 'remittance';
  readonly from: string;
  readonly subject: string;
  readonly body: string;
  readonly receivedAt: string;
}

export type SignalType =
  | 'deposit_delay'
  | 'deposit_confirmed'
  | 'bank_details_change'
  | 'new_invoice'
  | 'payment_urgency';

export interface EvidenceSignal {
  readonly type: SignalType;
  readonly counterparty: string;
  readonly currency?: Currency;
  readonly amount?: number;
  readonly newDate?: string;
  /** Verbatim quote from the document supporting this signal. */
  readonly citation: string;
}

export interface ExtractedEvidence {
  readonly evidenceId: string;
  readonly signals: readonly EvidenceSignal[];
  readonly injectionSuspected: boolean;
  readonly injectionReason?: string;
  readonly summary: string;
  readonly extractor: 'claude' | 'rules';
  readonly hash: string;
}

export interface ApprovalBinding {
  readonly amount: number;
  readonly currency: Currency;
  readonly beneficiaryId: string;
  readonly quoteId: string | null;
  readonly recallBase: number;
  readonly evidenceHash: string;
}

export interface ApprovalRequest {
  readonly id: string;
  readonly decisionId: string;
  readonly obligationId?: string;
  readonly title: string;
  readonly explanation: string;
  readonly binding: ApprovalBinding;
  readonly bindingHash: string;
  readonly expiresAt: string;
  readonly status: 'pending' | 'approved' | 'rejected' | 'expired';
}

export interface ExecutedAction {
  readonly id: string;
  readonly decisionId: string;
  readonly obligationId?: string;
  readonly kind: 'conversion' | 'transfer' | 'reserve_move';
  readonly requestId: string;
  readonly airwallexId: string;
  readonly currency: Currency;
  readonly amount: number;
  readonly status: 'submitted' | 'settled' | 'failed' | 'refunded';
  readonly reconciled: boolean;
  readonly failureReason?: string;
  readonly financialTransactionId?: string;
  readonly createdAt: string;
}

export interface AuditEntry {
  readonly at: string;
  readonly cycle: number;
  readonly kind: 'observe' | 'decide' | 'act' | 'reconcile' | 'autonomy' | 'evidence' | 'approval' | 'system';
  readonly message: string;
  readonly refs?: Readonly<Record<string, string>>;
}
