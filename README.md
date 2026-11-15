# Shadow Treasurer

**A multi-currency treasury agent on Airwallex that earns the right to move money without a human.**

Team **Shadow Protocol** · Airwallex Agentic Banking Hackathon · **Track 01 — Adaptive Treasury Controller**

> We decide. Airwallex enforces. Nothing counts until it reconciles.

![Shadow Treasurer dashboard](docs/dashboard.png)

Agents can already read balances and propose payments. The open question is *when an agent can be trusted to move money without a human confirming every payment*. Shadow Treasurer answers it with **earned, revocable autonomy**: it starts as a shadow that proposes but never moves money, earns a spending envelope only through clean, reconciled cycles, and loses it the moment the evidence gets shaky.

It runs **Observe → Decide → Act → Reconcile → Repeat** to decide what to **FUND, CONVERT, DEFER, ESCALATE, PLACE or RECALL** when cash is short.

---

## Quick start (60 seconds, no keys needed)

Requires **Node.js ≥ 22.18** (runs TypeScript directly, no build step).

```bash
git clone https://github.com/subhadeeproydev/shadow-treasurer.git
cd shadow-treasurer
npm install
npm start            # http://127.0.0.1:4747
```

Click the five demo steps in order, then use the approval inbox and **Run 50 scenarios**.

```bash
npm test             # 26 tests: policy, autonomy, approvals, reconciliation, webhooks, full demo, Gauntlet
npm run typecheck    # strict TypeScript
npm run gauntlet     # 50 seeded chaos scenarios with pass criteria (exit code 1 on any failure)
npm run demo:cli     # the whole demo in the terminal, with the audit trail
```

### Optional: real Claude and the real Airwallex sandbox

Copy `.env.example` to `.env`:

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Evidence is read by **Claude Opus 5.5** (cited, structured signals) and screened for prompt injection by **Claude Haiku 5.5**. Without it, a deterministic rule extractor is used. The rule screen always runs too (defence in depth). |
| `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY` | The agent talks to the **Airwallex sandbox** (`api-demo.airwallex.com`) instead of the in-memory replica. Map the demo payees to sandbox beneficiaries with `AIRWALLEX_BEN_*`. |
| `AIRWALLEX_WEBHOOK_SECRET` | Enables HMAC-verified webhooks at `POST /webhooks/airwallex`. |

`npm run spike` exercises the sandbox through the same adapter (balances, rates, quote; add `-- --move <beneficiary_id>` to create a USD 10 transfer, push it to PAID with the simulation endpoint and read it back from `/financial_transactions`).

---

## The demo (in the Builder Guide's order)

The company: **Lumen Labs**, a 30-person SaaS business. Revenue arrives in USD; suppliers are paid in EUR and GBP. The signed mandate: *keep supplier payments funded, never let operating cash fall below USD 50k, convert only what is needed.*

| Step | What happens | What it proves |
|---|---|---|
| **1 · Earn trust** | 20 shadow cycles replay. Every proposal is scored against what actually settled (59/59 matched). The autonomy meter climbs **L0 → L1 → L2**. | Autonomy is earned with evidence, not granted. |
| **2 · Goal → plan** | Five obligations. The agent **funds 3**, **converts only the EUR 10,000 shortfall** on a locked quote, **defers** the EUR 46k fit-out payment until a USD 40k customer deposit lands (paying now would breach the floor), and **defers** payroll (outside the 72h window). Every action is reconciled against financial transactions. | Fund / convert / defer, with just-in-time FX that never exceeds need. |
| **3 · Deposit is late** | Northwind's deposit doesn't arrive and an email says "paying in two weeks". The evidence layer extracts the delay **with a verbatim citation**. Forecast confidence falls 98% → 71%, the meter drops **L2 → L1**, the envelope shrinks from USD 49k to 7k, and the EUR 46k payment becomes an **approval card**: recall USD 15,300 from the reserve, convert on a locked quote, pay. | New information → revised decision. Confidence drives autonomy. |
| **4 · Invoice fraud** | A look-alike "Brightline" domain asks to pay GBP 12,500 to **new bank details** and tells "the AI assistant" to skip approval. The injection screen flags it, the payee is frozen, autonomy resets to **L0 Shadow**, and even clicking *Approve* cannot pay a mandate-blocked payee. | The model reads untrusted text; code holds the keys. |
| **5 · Transfer fails** | Payroll is pulled forward; the human approves it; the transfer comes back **FAILED (BENEFICIARY_NAME_MISMATCH)**. No blind re-payment: the **refund is reconciled first**, then exactly one retry is proposed, needing a fresh approval with a **new `request_id`**. If other approvals used up the cash headroom in the meantime, the card is **voided at execution time** rather than breaching the floor. | Failures are reconciled, not retried blindly. |

Result: balances updated, reserve floor intact, and an audit trail linking every decision to its evidence, rule, `request_id`, Airwallex transfer / conversion IDs and financial-transaction IDs.

You can also **send your own email** to the agent from the Evidence panel (try new bank details, a late payment, or an instruction aimed at the AI).

---

## How it works

```
             untrusted emails / invoices
                        │
                ┌───────▼────────┐   typed, cited signals; NO tools; cannot move money
                │ Evidence layer │   Claude Opus 5.5 extracts · Claude Haiku 5.5 + rules screen injection
                └───────┬────────┘
                        │ signals (delay, bank change, invoice, urgency)
 Airwallex ──observe──► │
 balances, FX rates ┌───▼──────────────┐  forecast confidence · autonomy level · envelope
                    │  Policy engine   │  pure function, deterministic, unit-tested
                    │  (code decides)  │  FUND · CONVERT · DEFER · ESCALATE · PLACE · RECALL
                    └───┬──────────┬───┘
            autonomous  │          │ needs a human
                  ┌─────▼───┐  ┌───▼──────────────────────────────┐
                  │ Executor│  │ Approval bound to amount, ccy,   │
                  │ (only   │◄─┤ payee, FX quote id, evidence hash│
                  │ caller  │  │ expires with the quote; re-checks│
                  │ of money│  │ the floor at execution time      │
                  │ APIs)   │  └──────────────────────────────────┘
                  └────┬────┘
   /fx/quotes/create → /fx/conversions/create · /transfers/validate → /transfers/create (request_id)
                       │
                 ┌─────▼──────┐  done = PAID + settled + matched in /financial_transactions
                 │ Reconciler │  FAILED → wait for refund → retry needs approval + new request_id
                 └─────┬──────┘  a break revokes autonomy
                       ▼
             clean cycle → +1 track record      break / conflict / injection → L0 Shadow
```

### Earned autonomy

| Level | May do | Earned by |
|---|---|---|
| **L0 Shadow** | Propose only; urgent items go to a human | default; any break, evidence conflict or injection |
| **L1 Assist** | Auto-pay known payees up to the L1 limit × confidence × track record | 8 clean, reconciled cycles |
| **L2 Bounded** | Anything inside the envelope | 20 clean cycles **and** forecast confidence ≥ 80% |

`envelope = mandate cap × forecast confidence × track record` — computed in code (`src/engine/autonomy.ts`).
`forecast confidence = (cash + Σ inflow × p(on time)) / (cash + Σ inflow)`, × 0.9 per unresolved evidence conflict (`src/engine/forecast.ts`).

### Policy rules (src/engine/policy.ts)

| Rule | Action |
|---|---|
| `BENEFICIARY_NOT_ON_MANDATE` | ESCALATE: payee isn't in the signed mandate |
| `BANK_DETAILS_CHANGED` | ESCALATE: evidence claims new bank details / carries instructions to the agent; payee frozen |
| `NOT_YET_DUE` | DEFER: outside the funding window |
| `SHADOW_NEEDS_HUMAN` | ESCALATE: at L0, anything due within 24h goes to a human |
| `WAIT_FOR_INFLOW` | DEFER: paying now breaches the floor, but a likely inflow lands before the due date |
| `FLOOR_BREACH_RECALL` | ESCALATE with a plan to recall from the reserve |
| `FX_CAP` / `INSUFFICIENT_SOURCE_CURRENCY` | ESCALATE |
| `ABOVE_ENVELOPE` / `RETRY_NEEDS_APPROVAL` | ESCALATE |
| `JIT_FX` + `FUND_DUE` | CONVERT only the shortfall on a locked quote, then FUND |
| `PLACE_SURPLUS` | PLACE cash above floor + 90 days of payables into the reserve bucket |

Airwallex has no separate reserve product, so the **reserve bucket is an earmark inside the base-currency wallet**: operating cash = wallet balance − reserve. PLACE and RECALL move the earmark; the floor applies to operating cash.

### Safety properties

- **The model never holds a money tool.** Claude returns structured data (`zod` schemas via `messages.parse`); the policy engine decides; only `src/engine/treasurer.ts` calls money-moving endpoints.
- **Untrusted documents are labelled data** (`<untrusted_document>`), screened by a small model *and* deterministic rules. An injection attempt resets autonomy to Shadow.
- **Idempotency:** every conversion and transfer carries a deterministic `request_id` (`st-pay-<obligation>-a<attempt>`). Uncertain outcomes (timeouts, 5xx) are **looked up by `request_id`, never retried blindly**.
- **Approvals are bound** to amount, currency, payee, FX quote id, reserve recall and an evidence hash (SHA-256), expire with the quote, and **re-check the floor at execution**.
- **Webhooks** are verified with HMAC-SHA256 over `timestamp + body`, a 5-minute freshness window, constant-time comparison and event-id dedupe.
- **Emailed invoices never auto-pay** and are de-duplicated by payee, currency and amount; an approval also re-checks at execution that the payee is still on the mandate and not flagged.
- **The local API refuses cross-origin and non-JSON writes** and checks the Host header (CSRF and DNS-rebinding guard); binding hashes include a per-process secret salt; webhook reconciliation runs under the same lock as cycles.
- **Reconciliation** counts an action as done only when the financial transactions show it settled with a matching amount. A mismatch is a break that revokes autonomy.

---

## The Treasury Gauntlet

`npm run gauntlet` (or the button in the UI) runs 50 seeded, replayable scenarios. Each one builds a random company, runs the real `Treasurer` against the simulated sandbox and injects chaos between cycles: **deposit misses, failed transfers, lost responses after commit, prompt injection, bank-detail changes, FX spikes, and double-fired cycles**. It then checks invariants against the sandbox's own records.

| Pass criterion | Result (seed 7) |
|---|---|
| Reserve-floor breaches | **0** |
| Duplicate payouts | **0** |
| Payments outside the mandate | **0** |
| Executed actions reconciled | **100%** |
| Obligations missed for lack of the right currency | **0** |
| FX bought beyond need | **0** |
| Scenarios passed | **50 / 50** |
| Decisions auto-executed vs escalated | 75% auto |

Building the Gauntlet and clicking through the demo surfaced two real bugs, both fixed with regression tests: FX bought for an obligation awaiting retry was miscounted, and an approved payment could execute after other approvals had used up the headroom above the floor (approvals now re-check the floor at execution time).

---

## Airwallex APIs used

| Purpose | Endpoint |
|---|---|
| Auth | `POST /api/v1/authentication/login` |
| Observe | `GET /balances/current`, `GET /fx/rates/current` |
| Convert | `POST /fx/quotes/create` → `POST /fx/conversions/create` (`request_id`, `quote_id`) |
| Pay | `POST /transfers/validate` → `POST /transfers/create` (`request_id`), `GET /transfers?request_id=` |
| Reconcile | `GET /transfers/{id}`, `GET /financial_transactions?source_id=` |
| Simulate | `POST /simulation/transfers/{id}/transition`, `POST /simulation/deposit/create` |
| Events | Webhooks `payout.transfer.*`, `conversion.*`, `deposit.*` → `POST /webhooks/airwallex` |

All of it sits behind one interface (`src/airwallex/port.ts`) with two implementations: `AirwallexHttp` (real sandbox) and `SimulatedAirwallex` (an in-memory replica with the same safety-relevant semantics: request_id idempotency, expiring quotes, PROCESSING → PAID | FAILED, refunds on failure, per-source financial transactions). The demo and Gauntlet run on the replica so they are deterministic and work offline.

**Honest status.** The demo, tests and Gauntlet run against the simulated sandbox. The HTTP adapter follows the documented sandbox endpoints and can be checked with `npm run spike` once sandbox keys are set. Field names in the responses should be verified against the live sandbox before relying on them.

---

## Project layout

```
src/
  domain/      types, money helpers, stable hashing
  engine/      policy.ts (decide) · autonomy.ts · forecast.ts · approvals.ts · reconcile.ts · treasurer.ts (the loop)
  agent/       evidence.ts (Claude) · screen.ts (deterministic screen + rule extractor)
  airwallex/   port.ts · http.ts (sandbox REST) · simulated.ts · webhooks.ts
  gauntlet/    run.ts · cli.ts
  demo/        world.ts (Lumen Labs) · scenario.ts (the five steps)
  server.ts    JSON API + static dashboard, no framework
public/        dashboard (vanilla JS, every dynamic string escaped)
test/          node:test suites
```

## Built with

- **Airwallex**: balances, FX quotes and conversions, transfers, financial transactions, simulation endpoints, webhooks.
- **Claude** (Anthropic TypeScript SDK): Opus 5.5 for evidence extraction with citations, Haiku 5.5 as an injection screen. Structured outputs only; no tools.
- Node.js 22+ native TypeScript, zod. No other runtime dependencies.

## Scope

Sandbox only, no real money, no production keys. Out of scope: connected accounts, ML forecasting beyond the simple cash-flow confidence model. Stretch (not built): two-entity intercompany top-ups; parking surplus in tokenized cash on Metal.

MIT License.
