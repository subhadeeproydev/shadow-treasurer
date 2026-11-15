import { createDemo, runStep, DEMO_STEPS } from '../src/demo/scenario.ts';
import { rulesExtractor } from '../src/agent/evidence.ts';
let rt = createDemo(rulesExtractor);
for (const s of DEMO_STEPS) {
  rt = await runStep(rt, s.id);
  const snap = rt.treasurer.snapshot();
  process.stdout.write(`\n=== ${s.title}: level=${snap.autonomy.level} conf=${snap.confidence} env=${snap.envelopeBase} cash=${snap.operatingBase} reserve=${snap.reserveBase}\n`);
}
const snap = rt.treasurer.snapshot();
for (const a of snap.audit) process.stdout.write(`[${a.cycle}] ${a.kind}: ${a.message}\n`);
process.stdout.write(JSON.stringify(snap.approvals.map(a=>[a.id,a.status]))+'\n');
