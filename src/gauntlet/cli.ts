// npm run gauntlet [-- --seed 7 --count 50]
import { runGauntlet } from './run.ts';

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};

const report = await runGauntlet({ seed: arg('seed', 7), count: arg('count', 50) });
const out = process.stdout;
out.write(`\nTreasury Gauntlet · seed ${report.seed} · ${report.totals.scenarios} scenarios\n\n`);
for (const s of report.scenarios) {
  out.write(`${s.pass ? 'PASS' : 'FAIL'}  #${String(s.id).padStart(2, '0')} ${s.chaos.padEnd(14)} executed=${s.executed} reconciled=${s.reconciled} auto=${s.autoDecisions} escalated=${s.escalated}${s.pass ? '' : `  floor=${s.floorBreaches} dup=${s.duplicatePayouts} outside=${s.outsideMandate} missed=${s.missedForCurrency} fx=${s.fxOverNeed}`}\n`);
}
const t = report.totals;
out.write(`\nPassed ${t.passed}/${t.scenarios}\n`);
out.write(`Reserve-floor breaches: ${t.floorBreaches} · duplicate payouts: ${t.duplicatePayouts} · outside mandate: ${t.outsideMandate}\n`);
out.write(`Executed actions reconciled: ${t.reconciledPct}% · missed for lack of currency: ${t.missedForCurrency} · FX beyond need: ${t.fxOverNeed}\n`);
out.write(`Auto-executed share: ${t.autoSharePct}% · avg re-plan after new evidence: ${t.avgReplanMs} ms\n`);
process.exitCode = t.passed === t.scenarios ? 0 : 1;
