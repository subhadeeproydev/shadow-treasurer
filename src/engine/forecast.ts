// Forecast confidence: how much of the cash we are counting on is actually likely to be there.
import type { Balances, ExpectedInflow, Rates } from '../domain/types.ts';
import { toBase, totalBase } from '../domain/money.ts';

export const EVIDENCE_CONFLICT_PENALTY = 0.9;

/**
 * confidence = (cash on hand + Σ inflow × p(inflow on time)) / (cash on hand + Σ inflow),
 * then × 0.9 for every unresolved evidence conflict. Range 0..1.
 */
export const forecastConfidence = (
  balances: Balances,
  rates: Rates,
  inflows: readonly ExpectedInflow[],
  unresolvedConflicts: number,
): number => {
  const cash = totalBase(balances, rates);
  const pending = inflows.filter((i) => i.status !== 'received');
  const promised = pending.reduce((s, i) => s + toBase(i.amount, i.currency, rates), 0);
  const weighted = pending.reduce((s, i) => s + toBase(i.amount, i.currency, rates) * i.confidence, 0);
  const denominator = cash + promised;
  const base = denominator <= 0 ? 0 : (cash + weighted) / denominator;
  const penalised = base * EVIDENCE_CONFLICT_PENALTY ** Math.max(0, unresolvedConflicts);
  return Math.max(0, Math.min(1, Math.round(penalised * 1000) / 1000));
};

/** Inflows we may plan around: likely (p ≥ 0.8) and expected before the given time. */
export const reliableInflowBaseBefore = (
  inflows: readonly ExpectedInflow[],
  rates: Rates,
  beforeIso: string,
): number =>
  inflows
    .filter((i) => i.status === 'expected' && i.confidence >= 0.8 && i.expectedAt <= beforeIso)
    .reduce((s, i) => s + toBase(i.amount, i.currency, rates), 0);
