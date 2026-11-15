// The 90-second demo, in the Builder Guide's order: goal -> plan -> new information -> revised decision -> result.
import { SimulatedAirwallex } from '../airwallex/simulated.ts';
import { AirwallexHttp } from '../airwallex/http.ts';
import type { AirwallexPort } from '../airwallex/port.ts';
import type { EvidenceExtractor } from '../agent/evidence.ts';
import { Treasurer } from '../engine/treasurer.ts';
import {
  BENEFICIARIES, DEMO_BALANCES, DEMO_EMAILS, DEMO_RATES, DEMO_RESERVE_BASE, DEMO_SHADOW_HISTORY,
  demoInflows, demoMandate, demoObligations,
} from './world.ts';

export interface DemoStep {
  readonly id: string;
  readonly title: string;
  readonly narration: string;
}

export const DEMO_STEPS: readonly DemoStep[] = [
  { id: 'earn', title: '1 · Earn trust', narration: 'Replay 20 shadow cycles. The agent proposes, never moves money; every proposal is scored against what actually settled. The autonomy meter climbs L0 → L2.' },
  { id: 'plan', title: '2 · Goal → plan', narration: 'Five obligations in USD, EUR and GBP. The agent funds three, converts only the EUR shortfall on a locked quote, waits for a customer deposit before the big EUR payment, and defers payroll.' },
  { id: 'late', title: '3 · Deposit is late', narration: 'Northwind’s USD 40k does not arrive and an email says “paying in two weeks”. Claude extracts the delay with a citation; forecast confidence drops, the meter falls, and the big EUR payment becomes an approval card with a reserve-recall plan.' },
  { id: 'fraud', title: '4 · Invoice fraud', narration: 'A look-alike “Brightline” email asks to pay GBP 12,500 to new bank details and tells the AI to skip approval. The screen flags the injection, the mandate blocks the payee, and autonomy drops to Shadow.' },
  { id: 'fail', title: '5 · Transfer fails', narration: 'A retry-worthy payment comes back FAILED (BENEFICIARY_NAME_MISMATCH). No blind re-payment: the refund is reconciled first, then one approved retry with a new request_id.' },
];

export interface DemoRuntime {
  readonly treasurer: Treasurer;
  readonly port: AirwallexPort;
  readonly sim: SimulatedAirwallex | null;
  readonly completed: readonly string[];
}

export const createDemo = (extractor: EvidenceExtractor): DemoRuntime => {
  const now = new Date();
  const useSandbox = Boolean(process.env.AIRWALLEX_CLIENT_ID && process.env.AIRWALLEX_API_KEY);
  const sim = useSandbox ? null : new SimulatedAirwallex({
    balances: DEMO_BALANCES, rates: DEMO_RATES, knownBeneficiaryIds: BENEFICIARIES.map((b) => b.id),
  });
  const port: AirwallexPort = sim ?? new AirwallexHttp({
    clientId: process.env.AIRWALLEX_CLIENT_ID!, apiKey: process.env.AIRWALLEX_API_KEY!,
    baseUrl: process.env.AIRWALLEX_BASE_URL, globalAccountId: process.env.AIRWALLEX_GLOBAL_ACCOUNT_ID,
  });
  const beneficiaries = BENEFICIARIES.map((b) => ({
    ...b, airwallexBeneficiaryId: process.env[`AIRWALLEX_BEN_${b.id.replace('ben_', '').toUpperCase()}`] ?? undefined,
  }));
  const treasurer = new Treasurer({
    port, extractor, mandate: demoMandate(now), beneficiaries, obligations: demoObligations(now),
    inflows: demoInflows(now), reserveBase: DEMO_RESERVE_BASE,
  });
  treasurer.systemNote(`Shadow Treasurer started against the ${port.mode === 'sandbox' ? 'Airwallex sandbox' : 'simulated Airwallex sandbox'} · evidence via ${extractor.usesClaude ? 'Claude' : 'rules (set ANTHROPIC_API_KEY for Claude)'}.`);
  return { treasurer, port, sim, completed: [] };
};

export const runStep = async (rt: DemoRuntime, stepId: string): Promise<DemoRuntime> => {
  const t = rt.treasurer;
  const now = new Date();
  switch (stepId) {
    case 'earn':
      await t.observe();
      t.recordShadowCycles(DEMO_SHADOW_HISTORY);
      break;
    case 'plan':
      await t.runCycle();
      break;
    case 'late':
      t.systemNote('Expected Northwind deposit window passed with no deposit in the Global Account.');
      await t.ingestEvidence(DEMO_EMAILS.depositDelay(now));
      await t.runCycle();
      break;
    case 'fraud':
      await t.ingestEvidence(DEMO_EMAILS.fraud(now));
      await t.runCycle();
      break;
    case 'fail': {
      // Contractor payroll is pulled forward (due now) and the bank rejects the name on file.
      rt.sim?.failTransfersTo('ben_contractors', 'BENEFICIARY_NAME_MISMATCH');
      t.systemNote('Contractor payroll moved up to today; the agent is at L0, so a human approves the run.');
      await t.pullForward('ob-contractors');
      await t.runCycle();
      const pending = t.snapshot().approvals.find((a) => a.status === 'pending' && a.obligationId === 'ob-contractors');
      if (pending) await t.approve(pending.id, pending.bindingHash);
      t.systemNote('Payee name corrected on the beneficiary record; retry requires a fresh approval.');
      rt.sim?.failTransfersTo('ben_contractors', '');
      await t.runCycle();
      break;
    }
    default:
      throw new Error(`unknown step ${stepId}`);
  }
  return { ...rt, completed: [...rt.completed, stepId] };
};
