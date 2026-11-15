// Exercise the real Airwallex sandbox through the same adapter the agent uses.
//   AIRWALLEX_CLIENT_ID=... AIRWALLEX_API_KEY=... npm run spike
//   add `-- --move <beneficiary_id>` to also create a USD 10 transfer, push it to PAID via the
//   simulation endpoint and check it appears in /financial_transactions (the Reconcile step).
import { AirwallexHttp } from '../src/airwallex/http.ts';

const clientId = process.env.AIRWALLEX_CLIENT_ID;
const apiKey = process.env.AIRWALLEX_API_KEY;
if (!clientId || !apiKey) {
  process.stderr.write('Set AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY (sandbox: Account > Developer > API keys).\n');
  process.exit(1);
}
const out = (label: string, v: unknown): void => { process.stdout.write(`${label}: ${JSON.stringify(v, null, 2)}\n`); };
const aw = new AirwallexHttp({ clientId, apiKey, baseUrl: process.env.AIRWALLEX_BASE_URL });

out('balances', await aw.getBalances());
out('rates (USD per unit)', await aw.getRates('USD'));
out('quote USD->EUR 1,000', await aw.createQuote('USD', 'EUR', 1000));

const i = process.argv.indexOf('--move');
if (i > -1) {
  const beneficiaryId = process.argv[i + 1];
  const requestId = `st-spike-${Date.now()}`;
  const input = { requestId, beneficiaryId, currency: 'USD' as const, amount: 10, reference: 'Shadow Treasurer spike' };
  out('validate', await aw.validateTransfer(input));
  const t = await aw.createTransfer(input);
  out('transfer', t);
  out('lookup by request_id', await aw.findTransferByRequestId(requestId));
  out('simulate PAID', await aw.simulateTransferTransition(t.id, 'PAID'));
  out('financial_transactions', await aw.listFinancialTransactions(t.id));
}
