// Nothing counts until it reconciles: an action is done only when Airwallex's financial
// transactions show it settled and the amount matches.
import type { ExecutedAction, Obligation } from '../domain/types.ts';
import type { AirwallexPort } from '../airwallex/port.ts';

export interface ReconcileResult {
  readonly action: ExecutedAction;
  readonly isBreak: boolean;
  readonly note?: string;
  readonly obligationPatch?: (o: Obligation) => Partial<Obligation>;
}

const AMOUNT_TOLERANCE = 0.01;

export const reconcileAction = async (port: AirwallexPort, x: ExecutedAction): Promise<ReconcileResult> => {
  if (x.kind === 'conversion') {
    const txns = await port.listFinancialTransactions(x.airwallexId);
    const match = txns.find((t) => t.sourceType === 'CONVERSION' && t.status === 'SETTLED');
    if (!match) return { action: x, isBreak: false, note: undefined };
    return {
      action: { ...x, status: 'settled', reconciled: true, financialTransactionId: match.id }, isBreak: false,
      note: `Conversion ${x.airwallexId} settled and matched to financial transaction ${match.id}.`,
    };
  }
  if (x.kind !== 'transfer') return { action: x, isBreak: false };

  const transfer = await port.getTransfer(x.airwallexId);
  const txns = await port.listFinancialTransactions(x.airwallexId);
  if (transfer.status === 'PAID') {
    const debit = txns.find((t) => t.sourceType === 'TRANSFER' && t.status === 'SETTLED');
    if (!debit) return { action: x, isBreak: false, note: `Transfer ${x.airwallexId} is PAID but not yet final in financial transactions; not counted as done.` };
    if (Math.abs(Math.abs(debit.amount) - x.amount) > AMOUNT_TOLERANCE) {
      return { action: x, isBreak: true, note: `BREAK: transfer ${x.airwallexId} settled ${debit.amount} vs intended ${x.amount}. Autonomy revoked.` };
    }
    return {
      action: { ...x, status: 'settled', reconciled: true, financialTransactionId: debit.id }, isBreak: false,
      note: `Transfer ${x.airwallexId} PAID and matched to financial transaction ${debit.id}.`,
      obligationPatch: () => ({ status: 'paid' }),
    };
  }
  if (transfer.status === 'FAILED' || transfer.status === 'CANCELLED') {
    const refund = txns.find((t) => t.sourceType === 'REFUND' && t.status === 'SETTLED');
    if (!refund) {
      return { action: { ...x, status: 'failed', failureReason: transfer.failureReason }, isBreak: false, note: `Transfer ${x.airwallexId} FAILED (${transfer.failureReason ?? 'unknown'}); waiting for the refund before any retry.` };
    }
    return {
      action: { ...x, status: 'refunded', reconciled: true, failureReason: transfer.failureReason, financialTransactionId: refund.id }, isBreak: false,
      note: `Transfer ${x.airwallexId} FAILED (${transfer.failureReason ?? 'unknown'}). Refund ${refund.id} reconciled. No blind re-payment: one retry needs human approval and a new request_id.`,
      obligationPatch: (o) => ({ status: 'failed', retryNeedsApproval: true, attempts: o.attempts + 1 }),
    };
  }
  return { action: x, isBreak: false };
};
