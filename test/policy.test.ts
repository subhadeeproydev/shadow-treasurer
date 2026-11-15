import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type PolicyInput } from '../src/engine/policy.ts';
import { BENEFICIARIES, DEMO_RATES, demoInflows, demoMandate, demoObligations } from '../src/demo/world.ts';

const now = new Date('2026-11-15T09:00:00Z');
const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  cycle: 1, now, mandate: demoMandate(now), beneficiaries: BENEFICIARIES, obligations: demoObligations(now),
  balances: { USD: 100_000, EUR: 8_000, GBP: 6_000, AUD: 0 }, reserveBase: 30_000, rates: DEMO_RATES,
  inflows: demoInflows(now), level: 2, envelopeBase: 49_350, confidence: 0.987, fxUsedTodayBase: 0,
  flaggedBeneficiaryIds: new Set(), evidenceIdsByBeneficiary: {}, ...over,
});

test('L2 plan funds three, converts only the EUR shortfall, waits for inflow, defers payroll', () => {
  const d = decide(base());
  const byOb = (id: string) => d.filter((x) => x.obligationId === id).map((x) => `${x.action}:${x.rule}`);
  assert.deepEqual(byOb('ob-brightline'), ['FUND:FUND_DUE']);
  assert.deepEqual(byOb('ob-muller'), ['CONVERT:JIT_FX', 'FUND:FUND_DUE']);
  assert.equal(d.find((x) => x.action === 'CONVERT')!.amount, 10_000);
  assert.deepEqual(byOb('ob-nimbus'), ['FUND:FUND_DUE']);
  assert.deepEqual(byOb('ob-rossi'), ['DEFER:WAIT_FOR_INFLOW']);
  assert.deepEqual(byOb('ob-contractors'), ['DEFER:NOT_YET_DUE']);
});

test('is deterministic: same input, same decisions', () => {
  assert.deepEqual(decide(base()), decide(base()));
});

test('late inflow turns the big EUR payment into a reserve-recall escalation', () => {
  const inflows = demoInflows(now).map((i) => ({ ...i, confidence: 0.1, status: 'late' as const }));
  const balances = { USD: 82_678, EUR: 0, GBP: 1_800, AUD: 0 };
  const d = decide(base({ inflows, balances, level: 1, envelopeBase: 7_120, confidence: 0.71 }));
  const rossi = d.find((x) => x.obligationId === 'ob-rossi')!;
  assert.equal(rossi.action, 'ESCALATE');
  assert.equal(rossi.rule, 'FLOOR_BREACH_RECALL');
  assert.ok((rossi.recallBase ?? 0) > 0);
  assert.equal(rossi.autonomous, false);
});

test('flagged payee is always escalated, never funded', () => {
  const d = decide(base({ flaggedBeneficiaryIds: new Set(['ben_brightline']) }));
  const b = d.find((x) => x.obligationId === 'ob-brightline')!;
  assert.equal(b.action, 'ESCALATE');
  assert.equal(b.rule, 'BANK_DETAILS_CHANGED');
});

test('payee missing from mandate is escalated', () => {
  const m = demoMandate(now);
  const d = decide(base({ mandate: { ...m, approvedBeneficiaryIds: m.approvedBeneficiaryIds.filter((id) => id !== 'ben_nimbus') } }));
  assert.equal(d.find((x) => x.obligationId === 'ob-nimbus')!.rule, 'BENEFICIARY_NOT_ON_MANDATE');
});

test('L0 shadow never auto-executes; urgent items go to a human', () => {
  const d = decide(base({ level: 0, envelopeBase: 0 }));
  assert.ok(d.every((x) => !x.autonomous || x.action === 'DEFER' || x.action === 'PLACE'));
  assert.equal(d.find((x) => x.obligationId === 'ob-brightline')!.rule, 'SHADOW_NEEDS_HUMAN');
  assert.equal(d.find((x) => x.obligationId === 'ob-muller')!.rule, 'SHADOW_PROPOSAL');
});

test('payment above the envelope escalates', () => {
  const d = decide(base({ envelopeBase: 6_000 }));
  assert.equal(d.find((x) => x.obligationId === 'ob-muller')!.rule, 'ABOVE_ENVELOPE');
  assert.equal(d.find((x) => x.obligationId === 'ob-brightline')!.action, 'FUND');
});

test('daily FX cap is enforced', () => {
  const d = decide(base({ fxUsedTodayBase: 95_000 }));
  assert.equal(d.find((x) => x.obligationId === 'ob-muller')!.rule, 'FX_CAP');
});

test('retry after failure needs approval even at L2', () => {
  const obligations = demoObligations(now).map((o) => (o.id === 'ob-nimbus' ? { ...o, status: 'failed' as const, retryNeedsApproval: true, attempts: 1 } : o));
  const d = decide(base({ obligations }));
  assert.equal(d.find((x) => x.obligationId === 'ob-nimbus')!.rule, 'RETRY_NEEDS_APPROVAL');
});

test('places surplus above floor plus upcoming need', () => {
  const d = decide(base({ obligations: [], balances: { USD: 200_000, EUR: 0, GBP: 0, AUD: 0 } }));
  const place = d.find((x) => x.action === 'PLACE')!;
  assert.equal(place.amount, 150_000);
});
