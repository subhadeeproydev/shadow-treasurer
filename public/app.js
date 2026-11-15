// Shadow Treasurer dashboard. Vanilla JS; every dynamic string goes through esc() (evidence is untrusted).
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, ccy = '') => `${ccy ? ccy + ' ' : ''}${Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const LEVELS = ['L0 Shadow', 'L1 Assist', 'L2 Bounded'];
const GAUGE_LEN = 252;

let state = null;
let lastBalances = {};

const api = async (path, body) => {
  const res = await fetch(path, { method: body === undefined && path === '/api/state' ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'request failed');
  return json;
};

const setBusy = (on, label = '') => {
  document.querySelectorAll('button').forEach((b) => { b.disabled = on; });
  $('busy').textContent = on ? label : '';
};

const act = async (path, body, label) => {
  setBusy(true, label);
  try {
    const json = await api(path, body ?? {});
    state = json.data;
    render();
    if (json.result && json.result.ok === false && json.result.reason) toast(json.result.reason);
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(false);
  }
};

const toast = (msg) => {
  $('busy').textContent = msg;
  setTimeout(() => { if ($('busy').textContent === msg) $('busy').textContent = ''; }, 6000);
};

const renderMeter = (s) => {
  const level = s.autonomy.level;
  const cap = level === 1 ? s.mandate.l1PaymentLimitBase : s.mandate.maxAutoPaymentBase;
  const share = level === 0 ? 0.04 : Math.min(1, (level - 1) / 2 + 0.5 * (s.envelopeBase / Math.max(1, cap)));
  const fill = $('gaugeFill');
  fill.style.strokeDashoffset = String(GAUGE_LEN * (1 - share));
  fill.style.stroke = level === 0 ? 'var(--defer)' : level === 1 ? 'var(--convert)' : 'var(--brass)';
  $('levelName').textContent = LEVELS[level];
  $('levelSub').textContent = level === 0 ? 'proposes only · nothing moves' : `may move up to ${money(s.envelopeBase, s.mandate.baseCurrency)} per payment`;
  document.querySelectorAll('.levels div').forEach((d) => d.classList.toggle('on', Number(d.dataset.l) === level));
  $('envelope').textContent = money(s.envelopeBase, s.mandate.baseCurrency);
  $('confidence').textContent = `${(s.confidence * 100).toFixed(1)}%`;
  $('clean').textContent = `${s.autonomy.cleanCycles}`;
  $('shadow').textContent = s.shadowScore.proposals ? `${s.shadowScore.matched}/${s.shadowScore.proposals}` : '–';
  $('demotion').textContent = s.autonomy.lastDemotion ? `Last demotion: ${s.autonomy.lastDemotion.reason}` : '';
};

const renderSteps = (s) => {
  const nextIdx = s.steps.findIndex((st) => !s.completed.includes(st.id));
  $('steps').innerHTML = s.steps.map((st, i) => `<button class="step ${s.completed.includes(st.id) ? 'done' : ''} ${i === nextIdx ? 'next' : ''}" data-step="${esc(st.id)}">${esc(st.title)}</button>`).join('');
  const shown = s.steps[nextIdx] ?? null;
  const lastDone = s.steps.filter((st) => s.completed.includes(st.id)).pop();
  $('narration').innerHTML = shown
    ? `<b>Next:</b> ${esc(shown.narration)}`
    : `<b>Done.</b> Balances updated, reserve floor intact, every executed action reconciled. Approve the pending retry to finish, then run the Gauntlet.${lastDone ? '' : ''}`;
  const lastCycle = Math.max(0, ...s.decisions.map((d) => d.cycle));
  const latest = s.decisions.filter((d) => d.cycle === lastCycle);
  const label = (d) => s.obligations.find((o) => o.id === d.obligationId)?.description.split(',')[0] ?? 'Treasury';
  $('latest').innerHTML = latest.length ? `<h3>Latest cycle (c${lastCycle}) · what the agent decided</h3><div class="latest-row">${latest.map((d) => `<div class="lt"><span class="pill a-${esc(d.action)}">${esc(d.action)}</span><b>${esc(label(d))}</b><span class="mono">${money(d.amount, d.currency)}</span><span class="small muted">${d.autonomous ? (d.action === 'DEFER' ? 'deferred by code' : 'executed by code') : d.needsApproval ? 'waiting for a human' : 'shadow proposal'}</span></div>`).join('')}</div>` : '';
  document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => act(`/api/step/${b.dataset.step}`, {}, 'running…')));
};

const renderBalances = (s) => {
  const ccys = ['USD', 'EUR', 'GBP', 'AUD'];
  $('balances').innerHTML = ccys.map((c) => `<div class="bal ${lastBalances[c] !== undefined && lastBalances[c] !== s.balances[c] ? 'flash' : ''}"><div class="ccy">${c}</div><div class="amt">${money(s.balances[c])}</div></div>`).join('')
    + `<div class="bal reserve"><div class="ccy">RESERVE (${esc(s.mandate.baseCurrency)})</div><div class="amt">${money(s.reserveBase)}</div></div>`;
  lastBalances = { ...s.balances };
  const max = Math.max(s.operatingBase, s.mandate.reserveFloorBase) * 1.4;
  $('floorFill').style.transform = `scaleX(${Math.min(1, s.operatingBase / max)})`;
  $('floorMark').style.left = `${(s.mandate.reserveFloorBase / max) * 100}%`;
  const ok = s.operatingBase >= s.mandate.reserveFloorBase;
  $('floorText').innerHTML = `Operating cash <b class="mono">${money(s.operatingBase, s.mandate.baseCurrency)}</b> vs floor <b class="mono">${money(s.mandate.reserveFloorBase, s.mandate.baseCurrency)}</b> · <span style="color:var(${ok ? '--fund' : '--danger'})">${ok ? 'floor intact' : 'BELOW FLOOR'}</span> · FX used today ${money(s.fxUsedTodayBase, s.mandate.baseCurrency)}`;
};

const renderMandate = (s) => {
  const m = s.mandate;
  $('mandateVer').textContent = `v${m.version} · signed by ${m.signedBy}`;
  $('goal').textContent = `“${m.goal}”`;
  const rows = [
    ['Reserve floor', money(m.reserveFloorBase, m.baseCurrency)], ['Max auto payment (L2)', money(m.maxAutoPaymentBase, m.baseCurrency)],
    ['L1 payment limit', money(m.l1PaymentLimitBase, m.baseCurrency)], ['Daily FX cap', money(m.dailyFxCapBase, m.baseCurrency)],
    ['Funding window', `${m.fundWindowHours}h`], ['Approved payees', `${m.approvedBeneficiaryIds.length}`],
  ];
  $('mandate').innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
};

const renderApprovals = (s) => {
  const list = [...s.approvals].reverse();
  if (!list.length) { $('approvals').innerHTML = '<p class="empty">No approvals pending. The agent is acting inside its envelope.</p>'; return; }
  $('approvals').innerHTML = list.map((a) => {
    const b = a.binding;
    const pending = a.status === 'pending';
    return `<article class="approval ${pending ? '' : 'done'}">
      <h4>${esc(a.title)} ${pending ? '' : `<span class="pill s-${a.status === 'approved' ? 'paid' : 'blocked'}">${esc(a.status)}</span>`}</h4>
      <p>${esc(a.explanation)}</p>
      <div class="binding">amount ${esc(b.currency)} ${esc(b.amount)} · payee ${esc(b.beneficiaryId)}<br>quote ${esc(b.quoteId ?? '–')} · recall ${esc(b.recallBase)}<br>evidence ${esc(b.evidenceHash.slice(0, 16))}… · binding ${esc(a.bindingHash.slice(0, 16))}…<br>expires ${esc(new Date(a.expiresAt).toLocaleTimeString())}</div>
      ${pending ? `<div class="row gap"><button data-approve="${esc(a.id)}" data-hash="${esc(a.bindingHash)}">Approve exactly this</button><button class="reject" data-reject="${esc(a.id)}">Reject</button></div>` : ''}
    </article>`;
  }).join('');
  document.querySelectorAll('[data-approve]').forEach((btn) => btn.addEventListener('click', () => act(`/api/approvals/${btn.dataset.approve}/approve`, { bindingHash: btn.dataset.hash }, 'executing approved plan…')));
  document.querySelectorAll('[data-reject]').forEach((btn) => btn.addEventListener('click', () => act(`/api/approvals/${btn.dataset.reject}/reject`, {}, 'rejecting…')));
};

const renderTables = (s) => {
  const name = (id) => s.beneficiaries.find((b) => b.id === id)?.name ?? id;
  const due = (iso) => { const h = (new Date(iso) - Date.now()) / 3.6e6; return h < 48 ? `${Math.max(0, Math.round(h))}h` : `${Math.round(h / 24)}d`; };
  $('obligations').innerHTML = s.obligations.map((o) => `<tr><td>${esc(name(o.beneficiaryId))}${o.source === 'evidence' ? ' <span class="chip bad">from email</span>' : ''}<div class="small muted">${esc(o.description)}</div></td><td class="num">${money(o.amount, o.currency)}</td><td class="num">${due(o.dueAt)}</td><td><span class="pill s-${esc(o.status)}">${esc(o.status.replace('_', ' '))}</span></td></tr>`).join('');
  $('inflows').innerHTML = s.inflows.map((i) => `<tr><td>${esc(i.payer)}</td><td class="num">${money(i.amount, i.currency)}</td><td class="num">${due(i.expectedAt)}</td><td class="num" style="color:var(${i.confidence >= 0.8 ? '--fund' : '--escalate'})">${(i.confidence * 100).toFixed(0)}%</td></tr>`).join('');
};

const renderEvidence = (s) => {
  if (!s.evidence.length) { $('evidence').innerHTML = '<p class="empty">No outside documents yet.</p>'; return; }
  $('evidence').innerHTML = [...s.evidence].reverse().map(({ doc, extracted: x }) => `<div class="ev ${x.injectionSuspected ? 'inj' : ''}">
      <div class="subj">${esc(doc.subject)}</div><div class="small muted">${esc(doc.from)} · read by ${esc(x.extractor)}</div>
      <div>${x.signals.map((sg) => `<span class="chip">${esc(sg.type.replace(/_/g, ' '))}</span>`).join('')}${x.injectionSuspected ? '<span class="chip bad">prompt injection</span>' : ''}</div>
      ${x.signals.slice(0, 2).map((sg) => `<blockquote>${esc(sg.citation)}</blockquote>`).join('')}
      <div class="small">${esc(x.summary)}</div></div>`).join('');
};

const renderDecisions = (s) => {
  const name = (id) => s.obligations.find((o) => o.id === id)?.description ?? 'Treasury';
  const list = [...s.decisions].reverse().slice(0, 40);
  $('decisions').innerHTML = list.length ? list.map((d) => `<div class="dec"><div><span class="pill a-${esc(d.action)}">${esc(d.action)}</span><div class="who">${d.autonomous ? 'auto' : d.needsApproval ? 'human' : 'shadow'} · c${esc(d.cycle)}</div></div>
    <div><div><b>${esc(name(d.obligationId))}</b> · <span class="mono">${money(d.amount, d.currency)}</span></div><div class="rule">${esc(d.rule)}</div><div class="small">${esc(d.reason)}</div></div></div>`).join('') : '<p class="empty">Run a cycle to see decisions.</p>';
};

const renderRecon = (s) => {
  const list = [...s.executed].reverse();
  $('recon').innerHTML = list.length ? list.map((x) => `<div class="rc"><div><b>${esc(x.kind)}</b> ${money(x.amount, x.currency)} <span class="pill ${x.reconciled ? 's-paid' : 's-open'}">${x.reconciled ? 'reconciled' : 'pending'}</span> <span class="pill ${x.status === 'failed' || x.status === 'refunded' ? 's-failed' : 's-in_flight'}">${esc(x.status)}</span>${x.failureReason ? `<div class="small" style="color:var(--escalate)">${esc(x.failureReason)}</div>` : ''}
    <div class="ids">request_id ${esc(x.requestId)}<br>${esc(x.airwallexId)}${x.financialTransactionId ? `<br>fin_txn ${esc(x.financialTransactionId)}` : ''}</div></div></div>`).join('') : '<p class="empty">Nothing executed yet.</p>';
};

const renderAudit = (s) => {
  $('audit').innerHTML = [...s.audit].reverse().map((a) => `<div class="au"><span class="muted">c${esc(a.cycle)}</span><span class="k">${esc(a.kind)}</span><span>${esc(a.message)}${a.refs ? `<span class="refs"> · ${Object.entries(a.refs).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(' ')}</span>` : ''}</span></div>`).join('');
};

const render = () => {
  const s = state;
  $('modeBadge').textContent = s.mode === 'sandbox' ? 'Airwallex sandbox · live' : 'Simulated Airwallex sandbox';
  $('modeBadge').className = `badge ${s.mode === 'sandbox' ? 'live' : ''}`;
  $('claudeBadge').textContent = s.claude ? 'Evidence: Claude' : 'Evidence: rules (no API key)';
  $('claudeBadge').className = `badge ${s.claude ? 'claude' : ''}`;
  renderMeter(s); renderSteps(s); renderBalances(s); renderMandate(s); renderApprovals(s);
  renderTables(s); renderEvidence(s); renderDecisions(s); renderRecon(s); renderAudit(s);
};

const renderGauntlet = (g) => {
  const t = g.totals;
  const stat = (v, label, bad) => `<div class="g-stat ${bad ? 'bad' : ''}"><b>${esc(v)}</b><span>${esc(label)}</span></div>`;
  $('gauntlet').classList.remove('muted');
  $('gauntlet').innerHTML = `<div class="g-totals">
    ${stat(`${t.passed}/${t.scenarios}`, 'scenarios passed', t.passed !== t.scenarios)}
    ${stat(t.floorBreaches, 'reserve-floor breaches', t.floorBreaches > 0)}
    ${stat(t.duplicatePayouts, 'duplicate payouts', t.duplicatePayouts > 0)}
    ${stat(t.outsideMandate, 'payments outside mandate', t.outsideMandate > 0)}
    ${stat(`${t.reconciledPct}%`, 'executed actions reconciled', t.reconciledPct < 100)}
    ${stat(t.missedForCurrency, 'missed for lack of currency', t.missedForCurrency > 0)}
    ${stat(t.fxOverNeed, 'FX beyond need', t.fxOverNeed > 0)}
    ${stat(`${t.autoSharePct}%`, 'decisions auto-executed', false)}
    ${stat(`${t.avgReplanMs} ms`, 'avg re-plan after evidence', false)}
  </div><div class="g-dots">${g.scenarios.map((sc) => `<span class="g-dot ${sc.pass ? '' : 'fail'}" title="#${sc.id} ${esc(sc.chaos)} · executed ${sc.executed}, escalated ${sc.escalated}"></span>`).join('')}</div>
  <p class="small muted">Seed ${esc(g.seed)} · replay with <span class="mono">npm run gauntlet -- --seed ${esc(g.seed)}</span></p>`;
};

$('resetBtn').addEventListener('click', () => act('/api/reset', {}, 'resetting…'));
$('cycleBtn').addEventListener('click', () => act('/api/cycle', {}, 'running cycle…'));
$('gauntletBtn').addEventListener('click', async () => {
  setBusy(true, 'running the Gauntlet…');
  try { renderGauntlet((await api('/api/gauntlet?seed=7&count=50', {})).data); } catch (e) { toast(e.message); } finally { setBusy(false); }
});
$('evForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  act('/api/evidence', { from: f.get('from'), subject: f.get('subject'), body: f.get('body') }, 'reading evidence…').then(() => e.target.reset());
});

api('/api/state').then((j) => { state = j.data; render(); }).catch((e) => toast(e.message));
