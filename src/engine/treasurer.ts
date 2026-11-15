// The Treasurer runs Observe -> Decide -> Act -> Reconcile -> Repeat.
// Only this module calls money-moving Airwallex methods, and only for decisions the policy engine
// marked autonomous or a human approved with a matching binding hash.
import type {
  ApprovalRequest, AuditEntry, Balances, Beneficiary, Decision, EvidenceDoc, ExecutedAction, ExpectedInflow,
  ExtractedEvidence, Mandate, Obligation, Rates,
} from '../domain/types.ts';
import { round2, toBase, totalBase, withDelta } from '../domain/money.ts';
import { sha256 } from '../domain/hash.ts';
import type { AirwallexPort, Transfer } from '../airwallex/port.ts';
import { UncertainOutcomeError } from '../airwallex/port.ts';
import type { EvidenceExtractor } from '../agent/evidence.ts';
import { decide } from './policy.ts';
import { forecastConfidence } from './forecast.ts';
import type { AutonomyState } from './autonomy.ts';
import { INITIAL_AUTONOMY, applyCycleOutcome, demote, envelopeBase, recomputeLevel } from './autonomy.ts';
import { createApproval, verifyApproval } from './approvals.ts';
import { reconcileAction } from './reconcile.ts';

export interface TreasurerConfig {
  readonly port: AirwallexPort;
  readonly mandate: Mandate;
  readonly beneficiaries: readonly Beneficiary[];
  readonly obligations: readonly Obligation[];
  readonly inflows: readonly ExpectedInflow[];
  readonly extractor: EvidenceExtractor;
  readonly reserveBase?: number;
  readonly now?: () => Date;
  readonly autonomy?: AutonomyState;
  /** In simulated/sandbox demo mode, push new transfers through the simulation endpoint after each cycle. */
  readonly autoSettle?: boolean;
}

export interface TreasurySnapshot {
  readonly mode: AirwallexPort['mode'];
  readonly cycle: number;
  readonly mandate: Mandate;
  readonly balances: Balances;
  readonly rates: Rates;
  readonly reserveBase: number;
  readonly operatingBase: number;
  readonly confidence: number;
  readonly envelopeBase: number;
  readonly autonomy: AutonomyState;
  readonly obligations: readonly Obligation[];
  readonly inflows: readonly ExpectedInflow[];
  readonly beneficiaries: readonly Beneficiary[];
  readonly decisions: readonly Decision[];
  readonly approvals: readonly ApprovalRequest[];
  readonly executed: readonly ExecutedAction[];
  readonly evidence: readonly { readonly doc: EvidenceDoc; readonly extracted: ExtractedEvidence }[];
  readonly audit: readonly AuditEntry[];
  readonly fxUsedTodayBase: number;
  readonly flaggedBeneficiaryIds: readonly string[];
  readonly shadowScore: { readonly proposals: number; readonly matched: number };
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export class Treasurer {
  private readonly port: AirwallexPort;
  private readonly extractor: EvidenceExtractor;
  private readonly now: () => Date;
  private readonly autoSettle: boolean;
  private mandate: Mandate;
  private beneficiaries: readonly Beneficiary[];
  private obligations: readonly Obligation[];
  private inflows: readonly ExpectedInflow[];
  private reserveBase: number;
  private autonomy: AutonomyState;
  private cycle = 0;
  private balances: Balances = { USD: 0, EUR: 0, GBP: 0, AUD: 0 };
  private rates: Rates = { USD: 1, EUR: 1, GBP: 1, AUD: 1 };
  private decisions: readonly Decision[] = [];
  private approvals: readonly ApprovalRequest[] = [];
  private executed: readonly ExecutedAction[] = [];
  private evidence: readonly { doc: EvidenceDoc; extracted: ExtractedEvidence }[] = [];
  private audit: readonly AuditEntry[] = [];
  private fxUsedTodayBase = 0;
  private flagged: ReadonlySet<string> = new Set();
  private unresolvedConflicts = 0;
  private shadowScore = { proposals: 0, matched: 0 };

  constructor(cfg: TreasurerConfig) {
    this.port = cfg.port;
    this.extractor = cfg.extractor;
    this.now = cfg.now ?? (() => new Date());
    this.autoSettle = cfg.autoSettle ?? true;
    this.mandate = cfg.mandate;
    this.beneficiaries = cfg.beneficiaries;
    this.obligations = cfg.obligations;
    this.inflows = cfg.inflows;
    this.reserveBase = cfg.reserveBase ?? 0;
    this.autonomy = cfg.autonomy ?? INITIAL_AUTONOMY;
  }

  private log(kind: AuditEntry['kind'], message: string, refs?: Record<string, string>): void {
    this.audit = [...this.audit, { at: this.now().toISOString(), cycle: this.cycle, kind, message, refs }].slice(-500);
  }

  /**
   * Airwallex has no separate reserve product, so the reserve bucket is an earmark inside the
   * base-currency wallet: operating cash = wallet balances minus the earmarked reserve.
   */
  private operatingBalances(): Balances {
    return withDelta(this.balances, this.mandate.baseCurrency, -this.reserveBase);
  }

  private confidence(): number {
    return forecastConfidence(this.operatingBalances(), this.rates, this.inflows, this.unresolvedConflicts);
  }

  private envelope(): number {
    return envelopeBase(this.mandate, this.autonomy.level, this.confidence(), this.autonomy.cleanCycles);
  }

  private updateObligation(id: string, patch: Partial<Obligation>): void {
    this.obligations = this.obligations.map((o) => (o.id === id ? { ...o, ...patch } : o));
  }

  async observe(): Promise<void> {
    this.balances = await this.port.getBalances();
    this.rates = await this.port.getRates(this.mandate.baseCurrency);
    this.autonomy = recomputeLevel(this.autonomy, this.confidence());
  }

  // ---------------- Evidence ----------------

  private matchBeneficiary(counterparty: string, from: string): Beneficiary | undefined {
    const c = norm(counterparty);
    const domain = norm((from.match(/@([^>\s]+)/)?.[1] ?? '').split('.')[0] ?? '');
    return this.beneficiaries.find((b) => {
      const n = norm(b.name);
      return (c.length >= 4 && (n.includes(c) || c.includes(n.slice(0, 8)))) || (domain.length > 3 && n.includes(domain));
    });
  }

  async ingestEvidence(doc: EvidenceDoc): Promise<ExtractedEvidence> {
    const extracted = await this.extractor.extract(doc);
    this.evidence = [...this.evidence, { doc, extracted }];
    this.log('evidence', `${extracted.extractor === 'claude' ? 'Claude' : 'Rules'} read "${doc.subject}": ${extracted.summary}`, { evidence: doc.id, hash: extracted.hash.slice(0, 12) });
    const beneficiary = extracted.signals.map((s) => this.matchBeneficiary(s.counterparty, doc.from)).find(Boolean)
      ?? this.matchBeneficiary(doc.from, doc.from);

    if (extracted.injectionSuspected) {
      this.unresolvedConflicts += 1;
      if (beneficiary) this.flagged = new Set([...this.flagged, beneficiary.id]);
      this.autonomy = demote(this.autonomy, `Injection attempt in "${doc.subject}"`, this.now().toISOString());
      this.log('autonomy', `Prompt-injection attempt detected (${extracted.injectionReason ?? 'screen'}). Autonomy reset to L0 Shadow.`, { evidence: doc.id });
    }

    for (const s of extracted.signals) {
      if (s.type === 'deposit_delay' || s.type === 'deposit_confirmed') {
        const inflow = this.inflows.find((i) => i.status === 'expected' && norm(i.payer).includes(norm(s.counterparty).slice(0, 6)))
          ?? this.inflows.find((i) => i.status === 'expected' && norm(doc.from).includes(norm(i.payer).slice(0, 6)));
        if (inflow) {
          const confidence = s.type === 'deposit_delay' ? 0.1 : 0.98;
          this.inflows = this.inflows.map((i) => (i.id === inflow.id ? { ...i, confidence, status: s.type === 'deposit_delay' ? 'late' : i.status } : i));
          this.log('evidence', `${inflow.payer} inflow confidence → ${(confidence * 100).toFixed(0)}% ("${s.citation.slice(0, 90)}")`, { inflow: inflow.id });
        }
      }
      if (s.type === 'bank_details_change' && beneficiary) {
        this.flagged = new Set([...this.flagged, beneficiary.id]);
        this.unresolvedConflicts += extracted.injectionSuspected ? 0 : 1;
        this.log('evidence', `${beneficiary.name}: bank-details change claimed. Payee frozen pending out-of-band verification.`, { beneficiary: beneficiary.id });
      }
    }
    const invoice = extracted.signals.find((s) => s.type === 'new_invoice' && s.amount && s.currency);
    if (invoice && beneficiary) {
      const obligation: Obligation = {
        id: `ob-ev-${doc.id}`, beneficiaryId: beneficiary.id, currency: invoice.currency!, amount: invoice.amount!,
        dueAt: new Date(this.now().getTime() + 12 * 3_600_000).toISOString(), description: `${beneficiary.name} invoice (from email)`,
        status: 'open', source: 'evidence', attempts: 0, bankDetailsChanged: this.flagged.has(beneficiary.id),
      };
      const duplicate = this.obligations.some((o) => o.id === obligation.id || (o.beneficiaryId === obligation.beneficiaryId
        && o.currency === obligation.currency && o.amount === obligation.amount && o.status !== 'blocked'));
      if (duplicate) this.log('evidence', `Ignored duplicate invoice from ${beneficiary.name} for ${obligation.currency} ${obligation.amount.toLocaleString('en-US')}: an obligation with the same payee and amount already exists.`, { evidence: doc.id });
      else this.obligations = [...this.obligations, obligation];
    }
    this.autonomy = recomputeLevel(this.autonomy, this.confidence());
    return extracted;
  }

  // ---------------- Decide + Act ----------------

  async runCycle(): Promise<readonly Decision[]> {
    this.cycle += 1;
    const nowIso = this.now().toISOString();
    for (const a of this.approvals.filter((x) => x.status === 'pending' && x.expiresAt < nowIso)) {
      this.setApproval(a.id, 'expired');
      this.log('approval', `Approval expired with its FX quote: ${a.title}. Re-planning.`, { approval: a.id });
    }
    await this.observe();
    const confidence = this.confidence();
    this.log('observe', `Operating cash ${this.mandate.baseCurrency} ${totalBase(this.operatingBalances(), this.rates).toLocaleString('en-US')} · reserve ${this.reserveBase.toLocaleString('en-US')} · forecast confidence ${(confidence * 100).toFixed(0)}% · ${['L0', 'L1', 'L2'][this.autonomy.level]} envelope ${this.envelope().toLocaleString('en-US')}`);
    const evidenceIdsByBeneficiary: Record<string, string[]> = {};
    for (const e of this.evidence) {
      const b = this.matchBeneficiary(e.doc.from, e.doc.from);
      if (b) evidenceIdsByBeneficiary[b.id] = [...(evidenceIdsByBeneficiary[b.id] ?? []), e.doc.id];
    }
    const pendingApprovalObligations = new Set(this.approvals.filter((a) => a.status === 'pending').map((a) => a.obligationId));
    const decisions = decide({
      cycle: this.cycle, now: this.now(), mandate: this.mandate, beneficiaries: this.beneficiaries,
      obligations: this.obligations.filter((o) => !pendingApprovalObligations.has(o.id)),
      balances: this.operatingBalances(), reserveBase: this.reserveBase, rates: this.rates, inflows: this.inflows,
      level: this.autonomy.level, envelopeBase: this.envelope(), confidence, fxUsedTodayBase: this.fxUsedTodayBase,
      flaggedBeneficiaryIds: this.flagged, evidenceIdsByBeneficiary,
    });
    this.decisions = [...this.decisions, ...decisions].slice(-300);
    for (const d of decisions) this.log('decide', `${d.action}${d.autonomous ? '' : d.needsApproval ? ' (needs human)' : ' (shadow)'} · ${d.rule} · ${d.reason}`, { decision: d.id });
    for (const d of decisions) await this.act(d);
    await this.settleAndReconcile();
    return decisions;
  }

  private evidenceHashFor(d: Decision): string {
    return sha256(d.evidenceIds.map((id) => this.evidence.find((e) => e.doc.id === id)?.extracted.hash ?? id));
  }

  private async act(d: Decision): Promise<void> {
    if (d.action === 'ESCALATE') return this.openApproval(d);
    if (!d.autonomous) return;
    if (d.action === 'CONVERT' && d.convert) {
      await this.convert(d, d.convert.buyAmount, d.obligationId ?? d.id);
    } else if (d.action === 'FUND' && d.obligationId) {
      await this.pay(d, d.obligationId);
    } else if (d.action === 'PLACE') {
      this.moveReserve(d, d.amount);
    }
  }

  private async openApproval(d: Decision): Promise<void> {
    if (this.approvals.some((a) => a.status === 'pending' && a.obligationId === d.obligationId)) return;
    const obligation = this.obligations.find((o) => o.id === d.obligationId);
    let quoteId: string | null = null;
    let validTo: string | null = null;
    if (obligation && obligation.currency !== this.mandate.baseCurrency && d.rule !== 'BANK_DETAILS_CHANGED' && d.rule !== 'BENEFICIARY_NOT_ON_MANDATE') {
      const shortfall = round2(Math.max(0, obligation.amount - (this.balances[obligation.currency] ?? 0)));
      if (shortfall > 0) {
        const q = await this.port.createQuote(this.mandate.baseCurrency, obligation.currency, shortfall);
        quoteId = q.quoteId;
        validTo = q.validTo;
      }
    }
    const approval = createApproval(d, obligation?.beneficiaryId ?? '', quoteId, validTo, this.evidenceHashFor(d), d.reason, this.now());
    this.approvals = [...this.approvals, approval];
    this.log('approval', `Approval requested: ${approval.title}`, { approval: approval.id, binding: approval.bindingHash.slice(0, 12) });
  }

  private async convert(d: Decision, buyAmount: number, key: string): Promise<boolean> {
    const o = this.obligations.find((x) => x.id === d.obligationId);
    const requestId = `st-fx-${key}-a${o?.attempts ?? 0}`;
    const quote = await this.port.createQuote(this.mandate.baseCurrency, d.currency, buyAmount);
    try {
      const conv = await this.port.createConversion(requestId, quote);
      this.fxUsedTodayBase = round2(this.fxUsedTodayBase + toBase(conv.sellAmount, this.mandate.baseCurrency, this.rates));
      this.executed = [...this.executed, {
        id: `x-${requestId}`, decisionId: d.id, obligationId: d.obligationId, kind: 'conversion', requestId,
        airwallexId: conv.conversionId, currency: d.currency, amount: conv.buyAmount, status: 'submitted', reconciled: false,
        createdAt: this.now().toISOString(),
      }];
      this.log('act', `Converted ${this.mandate.baseCurrency} ${conv.sellAmount.toLocaleString('en-US')} → ${d.currency} ${conv.buyAmount.toLocaleString('en-US')} on quote ${quote.quoteId} @ ${quote.clientRate}`, { request_id: requestId, conversion: conv.conversionId, quote: quote.quoteId });
      return true;
    } catch (err: unknown) {
      this.log('act', `Conversion failed (${err instanceof Error ? err.message : String(err)}); will re-plan next cycle.`, { request_id: requestId });
      return false;
    }
  }

  private async pay(d: Decision, obligationId: string): Promise<void> {
    const o = this.obligations.find((x) => x.id === obligationId);
    const b = o && this.beneficiaries.find((x) => x.id === o.beneficiaryId);
    if (!o || !b) return;
    const requestId = `st-pay-${o.id}-a${o.attempts}`;
    const input = { requestId, beneficiaryId: b.airwallexBeneficiaryId ?? b.id, currency: o.currency, amount: o.amount, reference: o.description };
    const v = await this.port.validateTransfer(input);
    if (!v.ok) {
      this.log('act', `Transfer validation failed for ${o.description}: ${v.reason}. Not sent.`, { request_id: requestId });
      return;
    }
    let transfer: Transfer | null = null;
    try {
      transfer = await this.port.createTransfer(input);
    } catch (err: unknown) {
      if (err instanceof UncertainOutcomeError) {
        transfer = await this.port.findTransferByRequestId(requestId);
        this.log('act', `Outcome uncertain (${err.message}). Looked up by request_id instead of retrying: ${transfer ? `found ${transfer.id}, no second payment` : 'not found; safe to resend with the same request_id next cycle'}.`, { request_id: requestId });
        if (!transfer) return;
      } else {
        this.log('act', `Transfer rejected: ${err instanceof Error ? err.message : String(err)}`, { request_id: requestId });
        return;
      }
    }
    this.updateObligation(o.id, { status: 'in_flight' });
    if (this.executed.some((x) => x.airwallexId === transfer.id)) return;
    this.executed = [...this.executed, {
      id: `x-${requestId}`, decisionId: d.id, obligationId: o.id, kind: 'transfer', requestId, airwallexId: transfer.id,
      currency: o.currency, amount: o.amount, status: 'submitted', reconciled: false, createdAt: this.now().toISOString(),
    }];
    this.log('act', `Paid ${o.currency} ${o.amount.toLocaleString('en-US')} to ${b.name}`, { request_id: requestId, transfer: transfer.id });
  }

  private moveReserve(d: Decision, amountBase: number): void {
    const direction = d.action === 'PLACE' ? 'PLACE' : 'RECALL';
    this.reserveBase = round2(this.reserveBase + (direction === 'PLACE' ? amountBase : -amountBase));
    this.executed = [...this.executed, {
      id: `x-res-${d.id}`, decisionId: d.id, kind: 'reserve_move', requestId: `st-res-${d.id}`, airwallexId: `reserve:${direction}`,
      currency: this.mandate.baseCurrency, amount: amountBase, status: 'settled', reconciled: true, createdAt: this.now().toISOString(),
    }];
    this.log('act', `${direction} ${this.mandate.baseCurrency} ${amountBase.toLocaleString('en-US')} ${direction === 'PLACE' ? 'into' : 'from'} the reserve bucket (reserve now ${this.reserveBase.toLocaleString('en-US')}).`);
  }

  // ---------------- Reconcile ----------------

  async settleAndReconcile(): Promise<void> {
    if (this.autoSettle) {
      for (const x of this.executed.filter((e) => e.kind === 'transfer' && e.status === 'submitted')) {
        await this.port.simulateTransferTransition(x.airwallexId, 'PAID');
      }
    }
    let breaks = 0;
    const updated: ExecutedAction[] = [];
    for (const x of this.executed) {
      if (x.reconciled) { updated.push(x); continue; }
      const result = await reconcileAction(this.port, x);
      updated.push(result.action);
      if (result.obligationPatch && x.obligationId) this.updateObligation(x.obligationId, result.obligationPatch(this.obligations.find((o) => o.id === x.obligationId)!));
      if (result.note) this.log('reconcile', result.note, { request_id: x.requestId, airwallex: x.airwallexId, ...(result.action.financialTransactionId ? { financial_transaction: result.action.financialTransactionId } : {}) });
      if (result.isBreak) breaks += 1;
    }
    this.executed = updated;
    this.balances = await this.port.getBalances();
    const outcome = breaks > 0 ? { kind: 'break' as const, reason: `${breaks} unreconciled action(s)` } : { kind: 'clean' as const };
    const before = this.autonomy.level;
    this.autonomy = applyCycleOutcome(this.autonomy, outcome, this.confidence(), this.mandate, this.cycle, this.now().toISOString());
    if (this.autonomy.level !== before) this.log('autonomy', `Autonomy ${['L0 Shadow', 'L1 Assist', 'L2 Bounded'][before]} → ${['L0 Shadow', 'L1 Assist', 'L2 Bounded'][this.autonomy.level]} (${outcome.kind === 'clean' ? `${this.autonomy.cleanCycles} clean reconciled cycles` : outcome.reason})`);
  }

  // ---------------- Approvals ----------------

  async approve(approvalId: string, presentedHash: string): Promise<{ ok: boolean; reason?: string }> {
    const approval = this.approvals.find((a) => a.id === approvalId);
    if (!approval) return { ok: false, reason: 'not found' };
    const check = verifyApproval(approval, presentedHash, this.now());
    if (!check.ok) {
      this.log('approval', `Approval refused: ${check.reason}`, { approval: approvalId });
      if (check.reason.startsWith('approval expired')) this.setApproval(approvalId, 'expired');
      return check;
    }
    const decision = this.decisions.find((d) => d.id === approval.decisionId);
    const o = this.obligations.find((x) => x.id === approval.obligationId);
    if (!decision || !o) return { ok: false, reason: 'decision or obligation missing' };
    if (o.status !== 'open' && o.status !== 'failed') return { ok: false, reason: `obligation is ${o.status}` };
    const payeeBlocked = this.flagged.has(o.beneficiaryId) || o.bankDetailsChanged || !this.mandate.approvedBeneficiaryIds.includes(o.beneficiaryId);
    if (payeeBlocked || decision.rule === 'BANK_DETAILS_CHANGED' || decision.rule === 'BENEFICIARY_NOT_ON_MANDATE') {
      this.setApproval(approvalId, 'rejected');
      this.updateObligation(o.id, { status: 'blocked' });
      return { ok: false, reason: 'Mandate blocks this payee. Verify out of band and amend the mandate; one click cannot override it.' };
    }
    // Re-check the floor at execution time: other payments may have used the headroom since the human saw the card.
    await this.observe();
    const amountBase = toBase(o.amount, o.currency, this.rates);
    const fxBuffer = o.currency === this.mandate.baseCurrency ? 0 : amountBase * 0.005;
    const opAfter = totalBase(this.operatingBalances(), this.rates) + approval.binding.recallBase - amountBase - fxBuffer;
    if (opAfter < this.mandate.reserveFloorBase || approval.binding.recallBase > this.reserveBase) {
      this.setApproval(approvalId, 'expired');
      const reason = `Cash position changed since this card was issued: executing now would leave operating cash at ${this.mandate.baseCurrency} ${round2(opAfter).toLocaleString('en-US')}, below the floor. Approval voided; the agent re-plans next cycle.`;
      this.log('approval', reason, { approval: approvalId });
      return { ok: false, reason };
    }
    this.setApproval(approvalId, 'approved');
    this.log('approval', `Human approved ${approval.title} (binding ${approval.bindingHash.slice(0, 12)})`, { approval: approvalId });
    if (approval.binding.recallBase > 0) this.moveReserve({ ...decision, action: 'RECALL' }, approval.binding.recallBase);
    await this.observe();
    const shortfall = round2(Math.max(0, o.amount - (this.balances[o.currency] ?? 0)));
    const nextAttempt = o.status === 'failed' ? o.attempts : o.attempts;
    this.updateObligation(o.id, { status: 'open', retryNeedsApproval: false, attempts: nextAttempt });
    if (shortfall > 0 && o.currency !== this.mandate.baseCurrency) {
      const converted = await this.convert(decision, shortfall, o.id);
      if (!converted) return { ok: false, reason: 'conversion failed' };
    }
    await this.pay(decision, o.id);
    await this.settleAndReconcile();
    return { ok: true };
  }

  reject(approvalId: string): void {
    const a = this.approvals.find((x) => x.id === approvalId);
    this.setApproval(approvalId, 'rejected');
    if (a?.obligationId) this.updateObligation(a.obligationId, { status: 'blocked' });
    this.log('approval', `Human rejected ${a?.title ?? approvalId}`, { approval: approvalId });
  }

  private setApproval(id: string, status: ApprovalRequest['status']): void {
    this.approvals = this.approvals.map((a) => (a.id === id ? { ...a, status } : a));
  }

  // ---------------- Shadow mode history ----------------

  /** Replay N historical cycles in shadow: the agent proposes, the proposal is scored against what the human actually paid. */
  recordShadowCycles(results: readonly { readonly proposals: number; readonly matched: number }[]): void {
    for (const r of results) {
      this.cycle += 1;
      this.shadowScore = { proposals: this.shadowScore.proposals + r.proposals, matched: this.shadowScore.matched + r.matched };
      const clean = r.matched === r.proposals;
      const before = this.autonomy.level;
      this.autonomy = applyCycleOutcome(this.autonomy, clean ? { kind: 'clean' } : { kind: 'break', reason: 'shadow proposal disagreed with settled outcome' }, this.confidence(), this.mandate, this.cycle, this.now().toISOString());
      if (this.autonomy.level !== before) this.log('autonomy', `Shadow cycle ${this.cycle}: ${r.matched}/${r.proposals} proposals matched what settled. Autonomy → ${['L0 Shadow', 'L1 Assist', 'L2 Bounded'][this.autonomy.level]}.`);
    }
  }

  /** Move an obligation's due date to two hours from now (e.g. payroll pulled forward). */
  async pullForward(obligationId: string): Promise<void> {
    this.updateObligation(obligationId, { dueAt: new Date(this.now().getTime() + 2 * 3_600_000).toISOString() });
  }

  addInflow(inflow: ExpectedInflow): void { this.inflows = [...this.inflows, inflow]; }
  markInflowReceived(id: string): void { this.inflows = this.inflows.map((i) => (i.id === id ? { ...i, status: 'received', confidence: 1 } : i)); }
  systemNote(message: string): void { this.log('system', message); }

  snapshot(): TreasurySnapshot {
    return {
      mode: this.port.mode, cycle: this.cycle, mandate: this.mandate, balances: this.operatingBalances(), rates: this.rates,
      reserveBase: this.reserveBase, operatingBase: totalBase(this.operatingBalances(), this.rates), confidence: this.confidence(),
      envelopeBase: this.envelope(), autonomy: this.autonomy, obligations: this.obligations, inflows: this.inflows,
      beneficiaries: this.beneficiaries, decisions: this.decisions, approvals: this.approvals, executed: this.executed,
      evidence: this.evidence, audit: this.audit, fxUsedTodayBase: this.fxUsedTodayBase, flaggedBeneficiaryIds: [...this.flagged],
      shadowScore: this.shadowScore,
    };
  }
}
