import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_AUTONOMY, applyCycleOutcome, envelopeBase, levelFor, demote } from '../src/engine/autonomy.ts';
import { createApproval, verifyApproval, bindingHash } from '../src/engine/approvals.ts';
import { forecastConfidence } from '../src/engine/forecast.ts';
import { screenForInjection, extractWithRules } from '../src/agent/screen.ts';
import { WebhookReceiver, signWebhook } from '../src/airwallex/webhooks.ts';
import { DEMO_EMAILS, DEMO_RATES, demoMandate } from '../src/demo/world.ts';
import type { Decision } from '../src/domain/types.ts';

const now = new Date('2026-11-15T09:00:00Z');
const mandate = demoMandate(now);

test('autonomy climbs only with clean cycles and resets on a break', () => {
  let s = INITIAL_AUTONOMY;
  for (let i = 1; i <= 20; i += 1) s = applyCycleOutcome(s, { kind: 'clean' }, 0.95, mandate, i, now.toISOString());
  assert.equal(s.level, 2);
  s = applyCycleOutcome(s, { kind: 'break', reason: 'mismatch' }, 0.95, mandate, 21, now.toISOString());
  assert.equal(s.level, 0);
  assert.equal(s.cleanCycles, 0);
});

test('L2 requires confidence; low confidence caps at L1', () => {
  assert.equal(levelFor(25, 0.95), 2);
  assert.equal(levelFor(25, 0.7), 1);
  assert.equal(levelFor(3, 0.99), 0);
});

test('envelope = cap × confidence × track record', () => {
  assert.equal(envelopeBase(mandate, 2, 0.5, 20), 25_000);
  assert.equal(envelopeBase(mandate, 2, 1, 10), 25_000);
  assert.equal(envelopeBase(mandate, 0, 1, 20), 0);
});

test('demote drops to shadow', () => {
  assert.equal(demote({ cleanCycles: 30, level: 2, history: [] }, 'x', now.toISOString()).level, 0);
});

test('forecast confidence falls when a promised inflow becomes unlikely', () => {
  const balances = { USD: 85_000, EUR: 0, GBP: 0, AUD: 0 };
  const inflow = { id: 'i', payer: 'N', currency: 'USD' as const, amount: 40_000, expectedAt: now.toISOString(), status: 'expected' as const };
  const high = forecastConfidence(balances, DEMO_RATES, [{ ...inflow, confidence: 0.95 }], 0);
  const low = forecastConfidence(balances, DEMO_RATES, [{ ...inflow, confidence: 0.1 }], 0);
  assert.ok(high > 0.95 && low < 0.75);
  assert.ok(forecastConfidence(balances, DEMO_RATES, [], 1) < 1);
});

const decision: Decision = {
  id: 'd1-ob', cycle: 1, obligationId: 'ob', action: 'ESCALATE', rule: 'ABOVE_ENVELOPE', reason: 'r', currency: 'EUR',
  amount: 46_000, amountBase: 49_680, autonomous: false, needsApproval: true, evidenceIds: [],
};

test('approval verifies only with the exact binding and before expiry', () => {
  const a = createApproval(decision, 'ben_rossi', 'quote_1', new Date(now.getTime() + 60_000).toISOString(), 'ehash', 'x', now);
  assert.deepEqual(verifyApproval(a, a.bindingHash, now), { ok: true });
  assert.equal(verifyApproval(a, bindingHash(a.id, { ...a.binding, amount: 46_001 }), now).ok, false);
  assert.equal(verifyApproval(a, a.bindingHash, new Date(now.getTime() + 120_000)).ok, false);
  assert.equal(verifyApproval({ ...a, binding: { ...a.binding, beneficiaryId: 'ben_evil' } }, a.bindingHash, now).ok, false);
});

test('injection screen flags the fraud email but not the honest delay email', () => {
  assert.equal(screenForInjection(DEMO_EMAILS.fraud(now)).injectionSuspected, true);
  assert.equal(screenForInjection(DEMO_EMAILS.depositDelay(now)).injectionSuspected, false);
});

test('rules extractor finds delay and bank change with citations', () => {
  const delay = extractWithRules(DEMO_EMAILS.depositDelay(now));
  assert.ok(delay.some((s) => s.type === 'deposit_delay' && s.citation.includes('two weeks')));
  const fraud = extractWithRules(DEMO_EMAILS.fraud(now));
  assert.ok(fraud.some((s) => s.type === 'bank_details_change'));
  assert.ok(fraud.some((s) => s.type === 'new_invoice' && s.amount === 12_500 && s.currency === 'GBP'));
});

test('webhooks: valid accepted, duplicates ignored, bad signatures and stale timestamps rejected', () => {
  const t = 1_800_000_000_000;
  const rx = new WebhookReceiver('secret', () => t);
  const body = JSON.stringify({ id: 'evt_1', name: 'payout.transfer.paid', data: { id: 'tfr_1' } });
  const sig = signWebhook('secret', String(t), body);
  assert.equal(rx.receive(body, String(t), sig).status, 'accepted');
  assert.equal(rx.receive(body, String(t), sig).status, 'duplicate');
  assert.equal(rx.receive(body, String(t), signWebhook('nope', String(t), body)).status, 'rejected');
  assert.equal(rx.receive(body, String(t - 600_000), signWebhook('secret', String(t - 600_000), body)).status, 'rejected');
});
