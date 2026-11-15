// Earned, revocable autonomy. Pure functions: state in, new state out.
import type { AutonomyLevel, Mandate } from '../domain/types.ts';
import { round2 } from '../domain/money.ts';

export const CYCLES_FOR_L1 = 8;
export const CYCLES_FOR_L2 = 20;
export const MIN_CONFIDENCE_FOR_L2 = 0.8;

export interface AutonomyState {
  readonly cleanCycles: number;
  readonly level: AutonomyLevel;
  readonly lastDemotion?: { readonly at: string; readonly reason: string };
  readonly history: readonly { readonly cycle: number; readonly level: AutonomyLevel; readonly envelopeBase: number }[];
}

export const INITIAL_AUTONOMY: AutonomyState = { cleanCycles: 0, level: 0, history: [] };

/** Track record counts only clean, reconciled cycles, saturating at CYCLES_FOR_L2. */
export const trackRecord = (cleanCycles: number): number => Math.min(1, cleanCycles / CYCLES_FOR_L2);

export const levelFor = (cleanCycles: number, confidence: number): AutonomyLevel => {
  if (cleanCycles >= CYCLES_FOR_L2 && confidence >= MIN_CONFIDENCE_FOR_L2) return 2;
  if (cleanCycles >= CYCLES_FOR_L1) return 1;
  return 0;
};

/** envelope = mandate cap × forecast confidence × track record (all computed in code). */
export const envelopeBase = (mandate: Mandate, level: AutonomyLevel, confidence: number, cleanCycles: number): number => {
  if (level === 0) return 0;
  const cap = level === 1 ? mandate.l1PaymentLimitBase : mandate.maxAutoPaymentBase;
  return round2(cap * confidence * trackRecord(cleanCycles));
};

export type CycleOutcome =
  | { readonly kind: 'clean' }
  | { readonly kind: 'break'; readonly reason: string };

/** A clean, fully reconciled cycle earns +1; any break, evidence conflict or injection resets to Shadow. */
export const applyCycleOutcome = (
  state: AutonomyState,
  outcome: CycleOutcome,
  confidence: number,
  mandate: Mandate,
  cycle: number,
  at: string,
): AutonomyState => {
  const cleanCycles = outcome.kind === 'clean' ? state.cleanCycles + 1 : 0;
  const level = levelFor(cleanCycles, confidence);
  const envelope = envelopeBase(mandate, level, confidence, cleanCycles);
  return {
    cleanCycles,
    level,
    lastDemotion: outcome.kind === 'break' ? { at, reason: outcome.reason } : state.lastDemotion,
    history: [...state.history, { cycle, level, envelopeBase: envelope }].slice(-200),
  };
};

/** Re-evaluate level when confidence changes mid-cycle (e.g. a deposit is late). */
export const recomputeLevel = (state: AutonomyState, confidence: number): AutonomyState => ({
  ...state,
  level: levelFor(state.cleanCycles, confidence),
});

export const demote = (state: AutonomyState, reason: string, at: string): AutonomyState => ({
  ...state,
  cleanCycles: 0,
  level: 0,
  lastDemotion: { at, reason },
});
