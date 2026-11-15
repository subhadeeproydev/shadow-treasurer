// Approvals are bound to exact terms. Change one cent, the payee, the quote or the evidence and the
// approval no longer verifies. They expire with the FX quote.
import type { ApprovalBinding, ApprovalRequest, Decision } from '../domain/types.ts';
import { randomBytes } from 'node:crypto';
import { sha256 } from '../domain/hash.ts';

/** Per-process secret so binding hashes cannot be computed from public data. */
const BINDING_SALT = randomBytes(32).toString('hex');

export const APPROVAL_TTL_MS = 15 * 60_000;

export const bindingHash = (approvalId: string, binding: ApprovalBinding): string =>
  sha256({ approvalId, salt: BINDING_SALT, ...binding });

export const createApproval = (
  decision: Decision,
  beneficiaryId: string,
  quoteId: string | null,
  quoteValidTo: string | null,
  evidenceHash: string,
  explanation: string,
  now: Date,
): ApprovalRequest => {
  const id = `apr-${decision.id}`;
  const binding: ApprovalBinding = {
    amount: decision.amount, currency: decision.currency, beneficiaryId, quoteId,
    recallBase: decision.recallBase ?? 0, evidenceHash,
  };
  const ttlEnd = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
  return {
    id, decisionId: decision.id, obligationId: decision.obligationId,
    title: `${decision.rule.replace(/_/g, ' ')} · ${decision.currency} ${decision.amount.toLocaleString('en-US')}`,
    explanation, binding, bindingHash: bindingHash(id, binding),
    expiresAt: quoteValidTo && quoteValidTo < ttlEnd ? quoteValidTo : ttlEnd,
    status: 'pending',
  };
};

export type ApprovalCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export const verifyApproval = (approval: ApprovalRequest, presentedHash: string, now: Date): ApprovalCheck => {
  if (approval.status !== 'pending') return { ok: false, reason: `approval is ${approval.status}` };
  if (new Date(approval.expiresAt) < now) return { ok: false, reason: 'approval expired with its FX quote; re-plan' };
  if (presentedHash !== approval.bindingHash) return { ok: false, reason: 'binding hash mismatch: terms changed since the human saw them' };
  if (bindingHash(approval.id, approval.binding) !== approval.bindingHash) return { ok: false, reason: 'binding tampered' };
  return { ok: true };
};
