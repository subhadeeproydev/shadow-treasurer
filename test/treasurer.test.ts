import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemo, runStep, DEMO_STEPS } from '../src/demo/scenario.ts';
import { rulesExtractor } from '../src/agent/evidence.ts';
import { SimulatedAirwallex } from '../src/airwallex/simulated.ts';
import { Treasurer } from '../src/engine/treasurer.ts';
import { BENEFICIARIES, DEMO_RATES, demoMandate } from '../src/demo/world.ts';
import { runGauntlet } from '../src/gauntlet/run.ts';

test('full demo: floor intact, every executed action reconciled, injection drops to shadow', async () => {
  let rt = createDemo(rulesExtractor);
  for (const s of DEMO_STEPS) rt = await runStep(rt, s.id);
  const snap = rt.treasurer.snapshot();
  assert.ok(snap.operatingBase >= snap.mandate.reserveFloorBase);
  assert.ok(snap.executed.every((x) => x.reconciled));
  assert.equal(snap.autonomy.level, 0);
  assert.ok(snap.approvals.some((a) => a.status === 'pending' && a.obligationId === 'ob-contractors'));
  const fraud = snap.obligations.find((o) => o.source === 'evidence')!;
  assert.notEqual(fraud.status, 'paid');
});

test('approving the fraud card cannot pay the flagged payee', async () => {
  let rt = createDemo(rulesExtractor);
  for (const s of ['earn', 'plan', 'late', 'fraud']) rt = await runStep(rt, s);
  const card = rt.treasurer.snapshot().approvals.find((a) => a.title.startsWith('BANK DETAILS'))!;
  const res = await rt.treasurer.approve(card.id, card.bindingHash);
  assert.equal(res.ok, false);
  assert.equal(rt.treasurer.snapshot().obligations.find((o) => o.id === card.obligationId)!.status, 'blocked');
});

test('approval is voided when the cash position changed since it was issued', async () => {
  let rt = createDemo(rulesExtractor);
  for (const s of DEMO_STEPS) rt = await runStep(rt, s.id);
  const t = rt.treasurer;
  const rossi = t.snapshot().approvals.find((a) => a.obligationId === 'ob-rossi' && a.status === 'pending')!;
  assert.equal((await t.approve(rossi.id, rossi.bindingHash)).ok, true);
  const retry = t.snapshot().approvals.find((a) => a.obligationId === 'ob-contractors' && a.status === 'pending')!;
  const res = await t.approve(retry.id, retry.bindingHash);
  assert.equal(res.ok, false);
  assert.ok(t.snapshot().operatingBase >= t.snapshot().mandate.reserveFloorBase);
});

test('lost response: looks up by request_id and never pays twice', async () => {
  const now = new Date('2026-11-15T09:00:00Z');
  const sim = new SimulatedAirwallex({ balances: { USD: 200_000, EUR: 0, GBP: 0, AUD: 0 }, rates: DEMO_RATES, now: () => now, knownBeneficiaryIds: BENEFICIARIES.map((b) => b.id) });
  const t = new Treasurer({
    port: sim, extractor: rulesExtractor, mandate: demoMandate(now), beneficiaries: BENEFICIARIES, inflows: [], now: () => now,
    obligations: [{ id: 'o1', beneficiaryId: 'ben_nimbus', currency: 'USD', amount: 5_000, dueAt: new Date(now.getTime() + 3_600_000).toISOString(), description: 'x', status: 'open', attempts: 0 }],
    autonomy: { cleanCycles: 20, level: 2, history: [] },
  });
  sim.loseNextResponse();
  await t.runCycle();
  await t.runCycle();
  await t.runCycle();
  assert.equal(sim.allTransfers().length, 1);
  assert.equal(t.snapshot().obligations[0].status, 'paid');
});

test('gauntlet: 50 seeded scenarios all pass', async () => {
  const r = await runGauntlet({ seed: 7, count: 50 });
  assert.equal(r.totals.passed, 50);
  assert.equal(r.totals.floorBreaches, 0);
  assert.equal(r.totals.duplicatePayouts, 0);
  assert.equal(r.totals.reconciledPct, 100);
});

test('a payee flagged after a card was issued cannot be paid by approving that card', async () => {
  let rt = createDemo(rulesExtractor);
  for (const s of ['earn', 'plan', 'late']) rt = await runStep(rt, s);
  const t = rt.treasurer;
  const card = t.snapshot().approvals.find((a) => a.obligationId === 'ob-rossi' && a.status === 'pending')!;
  await t.ingestEvidence({ id: 'ev-rossi-bank', kind: 'email', from: 'Atelier Rossi <ar@atelierrossi-pay.it>', subject: 'New bank details', body: 'Please note our new bank details for all future payments.', receivedAt: new Date().toISOString() });
  const res = await t.approve(card.id, card.bindingHash);
  assert.equal(res.ok, false);
  assert.notEqual(t.snapshot().obligations.find((o) => o.id === 'ob-rossi')!.status, 'paid');
});

test('the same emailed invoice twice creates one obligation, and it never auto-pays', async () => {
  let rt = createDemo(rulesExtractor);
  for (const s of ['earn', 'plan']) rt = await runStep(rt, s);
  const t = rt.treasurer;
  const doc = (id: string) => ({ id, kind: 'email' as const, from: 'Nimbus Cloud Billing <billing@nimbuscloud.com>', subject: 'Invoice NC-1', body: 'Kindly settle USD 2,000 for overage.', receivedAt: new Date().toISOString() });
  await t.ingestEvidence(doc('ev-a'));
  await t.ingestEvidence(doc('ev-b'));
  const fromEmail = t.snapshot().obligations.filter((o) => o.source === 'evidence');
  assert.equal(fromEmail.length, 1);
  await t.runCycle();
  assert.notEqual(t.snapshot().obligations.find((o) => o.source === 'evidence')!.status, 'paid');
});
