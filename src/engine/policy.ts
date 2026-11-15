// The deterministic policy engine. Code, not the model, decides FUND / CONVERT / DEFER / ESCALATE / PLACE.
// Pure function: same inputs always produce the same decisions.
import type {
  AutonomyLevel, Balances, Beneficiary, Currency, Decision, ExpectedInflow, Mandate, Obligation, Rates,
} from '../domain/types.ts';
import { hoursUntil, round2, toBase, totalBase, withDelta, fmt } from '../domain/money.ts';
import { reliableInflowBaseBefore } from './forecast.ts';

export const MIN_PLACE_BASE = 1000;
export const URGENT_HOURS = 24;
/** Allowance for FX spread when checking the floor, as a share of the converted amount. */
export const FX_COST_BUFFER = 0.005;
/** Recall a little more than the exact gap so spreads and rounding never dip below the floor. */
export const RECALL_BUFFER = 1.02;

export interface PolicyInput {
  readonly cycle: number;
  readonly now: Date;
  readonly mandate: Mandate;
  readonly beneficiaries: readonly Beneficiary[];
  readonly obligations: readonly Obligation[];
  readonly balances: Balances;
  readonly reserveBase: number;
  readonly rates: Rates;
  readonly inflows: readonly ExpectedInflow[];
  readonly level: AutonomyLevel;
  readonly envelopeBase: number;
  readonly confidence: number;
  readonly fxUsedTodayBase: number;
  /** Beneficiary ids with unresolved fraud / bank-change flags from evidence. */
  readonly flaggedBeneficiaryIds: ReadonlySet<string>;
  readonly evidenceIdsByBeneficiary: Readonly<Record<string, readonly string[]>>;
}

interface Running {
  readonly balances: Balances;
  readonly fxUsedBase: number;
  readonly reserveBase: number;
  readonly decisions: readonly Decision[];
}

const base = (input: PolicyInput): Currency => input.mandate.baseCurrency;

const mkDecision = (input: PolicyInput, o: Obligation | null, partial: Omit<Decision, 'id' | 'cycle' | 'evidenceIds'> & { suffix?: string }): Decision => {
  const { suffix, ...rest } = partial;
  return {
    id: `d${input.cycle}-${o ? o.id : 'treasury'}${suffix ? `-${suffix}` : ''}`,
    cycle: input.cycle,
    evidenceIds: o ? input.evidenceIdsByBeneficiary[o.beneficiaryId] ?? [] : [],
    ...rest,
  };
};

/** Invoices that arrived only by email never auto-pay: a human confirms the first payment. */
const canAutoExecute = (input: PolicyInput, amountBase: number, obligation: Obligation): boolean =>
  input.level > 0 && amountBase <= input.envelopeBase && !obligation.retryNeedsApproval && obligation.source !== 'evidence';

const escalate = (input: PolicyInput, o: Obligation, amountBase: number, rule: string, reason: string, recallBase = 0): Decision =>
  mkDecision(input, o, {
    obligationId: o.id, action: 'ESCALATE', rule, reason, currency: o.currency, amount: o.amount, amountBase,
    recallBase: recallBase > 0 ? round2(recallBase) : undefined, autonomous: false, needsApproval: true,
  });

const defer = (input: PolicyInput, o: Obligation, amountBase: number, rule: string, reason: string): Decision =>
  mkDecision(input, o, {
    obligationId: o.id, action: 'DEFER', rule, reason, currency: o.currency, amount: o.amount, amountBase,
    autonomous: true, needsApproval: false,
  });

/** Decide one obligation against the running (projected) state. */
const decideObligation = (input: PolicyInput, run: Running, o: Obligation): Running => {
  const { mandate, rates, now } = input;
  const amountBase = toBase(o.amount, o.currency, rates);
  const hours = hoursUntil(o.dueAt, now);
  const beneficiary = input.beneficiaries.find((b) => b.id === o.beneficiaryId);
  const push = (...ds: Decision[]): Running => ({ ...run, decisions: [...run.decisions, ...ds] });

  if (!beneficiary || !mandate.approvedBeneficiaryIds.includes(o.beneficiaryId)) {
    return push(escalate(input, o, amountBase, 'BENEFICIARY_NOT_ON_MANDATE',
      `${o.description}: payee is not an approved beneficiary in mandate v${mandate.version}. A human must verify and add them.`));
  }
  if (o.bankDetailsChanged || input.flaggedBeneficiaryIds.has(o.beneficiaryId)) {
    return push(escalate(input, o, amountBase, 'BANK_DETAILS_CHANGED',
      `${beneficiary.name}: evidence claims new bank details or carries instructions to the agent. Suspected invoice fraud; verify by phone on a known number before paying.`));
  }
  if (hours > mandate.fundWindowHours) {
    return push(defer(input, o, amountBase, 'NOT_YET_DUE',
      `Due in ${Math.round(hours)}h, outside the ${mandate.fundWindowHours}h funding window. Cash stays flexible; re-evaluated next cycle.`));
  }

  // Currency gap: convert just in time, only the shortfall, never beyond the mandate's daily cap.
  const held = run.balances[o.currency] ?? 0;
  const shortfall = round2(Math.max(0, o.amount - held));
  const sellCcy = base(input);
  const estSell = shortfall > 0 ? round2(toBase(shortfall, o.currency, rates) / rates[sellCcy]) : 0;
  const fxCost = o.currency !== sellCcy ? toBase(shortfall, o.currency, rates) * FX_COST_BUFFER : 0;
  const opAfter = totalBase(run.balances, rates) - amountBase - fxCost;
  if (input.level === 0 && hours <= URGENT_HOURS && !o.retryNeedsApproval && opAfter >= mandate.reserveFloorBase) {
    return push(escalate(input, o, amountBase, 'SHADOW_NEEDS_HUMAN',
      `${o.description} is due in ${Math.max(0, Math.round(hours))}h. The agent is in Shadow mode, so nothing moves without a human; approve to execute exactly these terms.`));
  }
  if (opAfter < mandate.reserveFloorBase) {
    const gap = Math.ceil(((mandate.reserveFloorBase - opAfter) * RECALL_BUFFER) / 100) * 100;
    const inflowBase = reliableInflowBaseBefore(input.inflows, rates, o.dueAt);
    if (inflowBase >= gap && hours > URGENT_HOURS) {
      return push(defer(input, o, amountBase, 'WAIT_FOR_INFLOW',
        `Paying now would leave operating cash at ${fmt(round2(opAfter), base(input))}, below the ${fmt(mandate.reserveFloorBase, base(input))} floor. A likely inflow of ${fmt(round2(inflowBase), base(input))} lands before the due date, so wait for it.`));
    }
    if (run.reserveBase >= gap) {
      return push(escalate(input, o, amountBase, 'FLOOR_BREACH_RECALL',
        `Paying would breach the ${fmt(mandate.reserveFloorBase, base(input))} floor and the expected inflow is no longer reliable (forecast confidence ${(input.confidence * 100).toFixed(0)}%). Proposal: recall ${fmt(round2(gap), base(input))} from the reserve, convert on a locked quote, then pay.`, gap));
    }
    return push(escalate(input, o, amountBase, 'FLOOR_BREACH',
      `Paying would breach the reserve floor and neither inflows nor the reserve can cover the ${fmt(round2(gap), base(input))} gap.`));
  }

  if (shortfall > 0 && o.currency !== sellCcy) {
    if (run.fxUsedBase + toBase(estSell, sellCcy, rates) > mandate.dailyFxCapBase) {
      return push(escalate(input, o, amountBase, 'FX_CAP',
        `Needs ${fmt(shortfall, o.currency)} of FX but that would exceed today's FX cap of ${fmt(mandate.dailyFxCapBase, base(input))}.`));
    }
    if ((run.balances[sellCcy] ?? 0) < estSell) {
      return push(escalate(input, o, amountBase, 'INSUFFICIENT_SOURCE_CURRENCY',
        `Not enough ${sellCcy} to convert ${fmt(shortfall, o.currency)}.`));
    }
  }

  if (!canAutoExecute(input, amountBase, o)) {
    const why = o.retryNeedsApproval
      ? 'A previous attempt failed and its refund is reconciled; one retry needs a human and goes out with a new request_id.'
      : input.level === 0
        ? 'Shadow mode: proposal only, scored against what actually settles.'
        : o.source === 'evidence'
          ? 'This invoice arrived only by email; the first payment to it needs a human.'
          : `${fmt(amountBase, base(input))} is above the current autonomy envelope of ${fmt(input.envelopeBase, base(input))}.`;
    if (input.level === 0 && !o.retryNeedsApproval) {
      const shadow = mkDecision(input, o, {
        obligationId: o.id, action: 'FUND', rule: 'SHADOW_PROPOSAL', reason: `Would pay ${o.description}. ${why}`,
        currency: o.currency, amount: o.amount, amountBase, autonomous: false, needsApproval: false,
        convert: shortfall > 0 && o.currency !== sellCcy ? { sellCurrency: sellCcy, buyCurrency: o.currency, buyAmount: shortfall, estSellAmount: estSell } : undefined,
      });
      return push(shadow);
    }
    return push(escalate(input, o, amountBase, o.retryNeedsApproval ? 'RETRY_NEEDS_APPROVAL' : o.source === 'evidence' ? 'EMAILED_INVOICE' : 'ABOVE_ENVELOPE', `${o.description}: ${why}`));
  }

  const decisions: Decision[] = [];
  let balances = run.balances;
  let fxUsedBase = run.fxUsedBase;
  if (shortfall > 0 && o.currency !== sellCcy) {
    decisions.push(mkDecision(input, o, {
      obligationId: o.id, action: 'CONVERT', rule: 'JIT_FX', suffix: 'fx',
      reason: `Hold ${fmt(held, o.currency)}; convert only the ${fmt(shortfall, o.currency)} shortfall from ${sellCcy} on a locked quote.`,
      currency: o.currency, amount: shortfall, amountBase: toBase(shortfall, o.currency, rates),
      convert: { sellCurrency: sellCcy, buyCurrency: o.currency, buyAmount: shortfall, estSellAmount: estSell },
      autonomous: true, needsApproval: false,
    }));
    balances = withDelta(withDelta(balances, sellCcy, -estSell), o.currency, shortfall);
    fxUsedBase = round2(fxUsedBase + toBase(estSell, sellCcy, rates));
  }
  decisions.push(mkDecision(input, o, {
    obligationId: o.id, action: 'FUND', rule: 'FUND_DUE',
    reason: `Due in ${Math.max(0, Math.round(hours))}h, payee on file, ${fmt(amountBase, base(input))} inside the ${fmt(input.envelopeBase, base(input))} envelope; operating cash stays at ${fmt(round2(opAfter), base(input))}, above the floor.`,
    currency: o.currency, amount: o.amount, amountBase, autonomous: true, needsApproval: false,
  }));
  balances = withDelta(balances, o.currency, -o.amount);
  return { ...run, balances, fxUsedBase, decisions: [...run.decisions, ...decisions] };
};

/** PLACE surplus above (floor + upcoming need) into the reserve bucket. */
const decidePlacement = (input: PolicyInput, run: Running): Running => {
  const { mandate, rates, now } = input;
  const horizon = new Date(now.getTime() + mandate.placeAboveDaysOfNeed * 86_400_000).toISOString();
  const stillOpen = input.obligations.filter((o) => o.status === 'open' && o.dueAt <= horizon);
  const fundedIds = new Set(run.decisions.filter((d) => d.action === 'FUND' && d.autonomous).map((d) => d.obligationId));
  const need = stillOpen.filter((o) => !fundedIds.has(o.id)).reduce((s, o) => s + toBase(o.amount, o.currency, rates), 0);
  const surplus = round2(totalBase(run.balances, rates) - mandate.reserveFloorBase - need);
  const baseHeld = run.balances[base(input)] ?? 0;
  const placeable = round2(Math.min(surplus, baseHeld));
  if (placeable < MIN_PLACE_BASE || run.decisions.some((d) => d.action === 'ESCALATE')) return run;
  const decision = mkDecision(input, null, {
    action: 'PLACE', rule: 'PLACE_SURPLUS', suffix: 'place',
    reason: `${fmt(placeable, base(input))} is above the floor plus the next ${mandate.placeAboveDaysOfNeed} days of payables; move it to the reserve bucket.`,
    currency: base(input), amount: placeable, amountBase: placeable, autonomous: input.level > 0, needsApproval: false,
  });
  return { ...run, balances: withDelta(run.balances, base(input), -placeable), reserveBase: round2(run.reserveBase + placeable), decisions: [...run.decisions, decision] };
};

export const decide = (input: PolicyInput): readonly Decision[] => {
  const open = input.obligations
    .filter((o) => o.status === 'open' || o.status === 'failed')
    .filter((o) => o.status === 'open' || o.retryNeedsApproval)
    .slice()
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const start: Running = { balances: input.balances, fxUsedBase: input.fxUsedTodayBase, reserveBase: input.reserveBase, decisions: [] };
  const afterObligations = open.reduce((run, o) => decideObligation(input, run, o), start);
  return decidePlacement(input, afterObligations).decisions;
};
