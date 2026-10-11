# Phase 13 — Execution Supervisor reconciliation and blocked-routing evidence

Date: 2026-10-12 · Branch `arena/8de8de2e-ai` · Version 0.11.0 → 0.12.0
Row 12 of `docs/migration/UNFINISHED_MODULES.md`: *Execution Supervisor and trading governance.*

Row 12's instruction is explicit about order: *"Reconcile the PHP supervisor source and real
test coverage step-by-step **before deciding the remaining port scope**; preserve fail-closed
governance; add bypass/recovery tests."* So this phase is mostly a reading exercise with a
verdict per step, plus the one portable gap that reading found, plus the tests row 12 asked
for by name.

## Scope

Source reconciled: `application/libraries/Aegis/ExecutionSupervisor.php` (515 lines),
`application/controllers/Execution.php` (the console controller that drove it),
`application/controllers/Api_system.php:265-275` (the two automation-limit endpoints) and
`application/core/MY_Controller.php:165-181` (`PUBLIC_ACTIONS`). Compared against
`src/modules/execution/service.js` and its three test files.

## The reconciliation's central finding

**Node's `execution` module is not a port of the legacy supervisor's broker pipeline. It is a
paper-scoped analogue of that pipeline's *human-approval workflow*.**

That is not a defect and not a shortcut — legacy says so itself. Step 2 rejects any trading
mode outside `HUMAN_APPROVAL / SEMI_AUTONOMOUS / FULLY_AUTOMATED` with the message
*"broker execution requires … (paper orders go through the Paper Trading engine)"*. The
supervisor was **always** the broker-bound path; the paper engine was separate and had its own
(much thinner) gates. Legacy's `Execution.php` console called `route()` to reach a connector,
and `Api_system` exposed automation limits for the two autonomous modes.

So the honest question for row 12 is not "which supervisor steps are missing from Node" — most
of them read from a broker connector that does not exist here — but **"which steps express a
governance principle that must hold in the paper workflow too, and does it hold?"**

## Steps 1–15, one verdict each

| # | Legacy step | Verdict in the Node paper workflow | Evidence |
|---:|---|---|---|
| 1 | Kill switch | **Ported, and re-verified** | Checked in `propose()` and **again inside the submission transaction** (`submitToPaper`), which is what legacy's `route()` did at routing time |
| 2 | Trading mode | **Ported with a different vocabulary** (ES-1) | Node requires `PAPER_TRADING`; legacy's three modes are broker-execution modes with no meaning while live routing is unavailable |
| 3 | Strategy APPROVED | **Ported and stricter** | Node additionally requires an *executable exact version* and, for `source: "ai"`, a **persisted human risk sign-off** |
| 4 | Broker connector READY with verified order submission | **Not portable** → row 13 | Needs `BrokerManager::tradingConnector()` |
| 5 | Market session open | **Not portable to this pipeline** (ES-5) | `sessionFor()` is broker-execution policy. Legacy's own `PaperTradingEngine` has **no** session gate — grep confirms it — so adding one here would refuse simulation trades the legacy simulator allowed |
| 6 | Data freshness per market class (crypto 120 s / forex 300 s / default 600 s) | **Not portable as written** (ES-5) | Legacy read the quote *from the connector*. Node's paper engine already checks staleness (`QUOTE_STALE_MS`, 5 min) while legacy's paper engine passed `staleData => false` **hard-coded** — so the Node paper path is already stricter than the legacy paper path |
| 7 | Duplicate orders (one net position per symbol, broker-wide) | **Not portable** → row 13 | Reads `connector->positions()` / `pendingOrders()` |
| 8 | Symbol permissions (`automationLimits.approvedSymbols`) | **Deliberately not ported** (ES-6) | Binds only to the automated modes. Porting the document without enforcement would recreate **F-30** |
| 9 | Margin estimate vs broker free margin (3.3 % initial) | **Not portable** → row 13 | Needs `connector->account()` |
| 10 | Risk engine with the actual order, plus automation limits | **Ported by delegation** | `submitToPaper` calls `paper.submitOrder`, which runs the same `RiskEngine` on the real order. The automation-limit sub-checks are mode-bound (see 8). Legacy sized from `volume × contractSize`; Node sizes from `riskPct` (ES-4) |
| 11 | Human approval | **Ported** | `decide()`, `trading.control`, 10–1000-character reason |
| 12 | Place order | **Not portable, and must stay that way** | Live order routing is required to remain unavailable |
| 13 | Confirm execution (validate `ticket > 0 && price > 0`) | **Not portable; the principle is honoured** | No broker result exists to validate, but `safePaperResult` and the status mapping refuse to treat an absent or `REJECTED` order as a fill |
| 14 | Audit log | **Ported and extended by this phase** | See below |
| 15 | Portfolio update (post-trade snapshot) | **Not portable** → row 13 | Broker account snapshot; the paper engine keeps its own balances |

Auxiliary surface:

| Legacy | Verdict |
|---|---|
| `normalizeIntent()` | **Ported and stricter.** Mandatory positive `stopLoss`, `LIMIT` price, positive `takeProfit`, 500-char reason — all preserved. Node adds `riskPct` and `confidence` bounds, strategy-id/version patterns, and a rule that the two strategy fields arrive together. Legacy's directional stop-side check was **inert**: its `if` block has an empty body and only a comment. Legacy's `volume > 0 && is_finite` has no Node counterpart because Node carries no volume (ES-4) |
| `route()` steps 1–2 re-verification | **Ported** — the single most important governance property in the class, and until this phase **untested** |
| `routingBlocked()` | **Ported by this phase** — see below |
| `decide()` | **Ported** |
| `expireStaleProposals()` | **Ported in Phase 12**, with per-item isolation (SJ-1) |
| `proposals()` / `proposal()` | **Ported and stricter** — owner-scoped; legacy's were global |
| `executions()` / `listRecentExecutions()` | **Not portable** — no execution record can exist without routing |
| `executeAutomated()`, `SEMI_AUTONOMOUS`, `FULLY_AUTOMATED` | **Not portable** — requires steps 4–15 |
| `automationLimits()`, `Api_system::automation_limits` / `update_automation_limits` | **Deliberately not ported** (ES-6, and **F-31** below) |
| `sessionFor()` | **Not portable** (step 5) |

**Net verdict on row 12's remaining scope:** nine of the fifteen steps are bound to a broker
connector or to automated modes, and belong to row 13, not to this module. Steps 1, 3, 10, 11
and 14 were already ported. The governance principle that was ported but **not tested**, and
the evidence that was **not ported at all**, were the two real gaps. Both are closed here.

## What this phase changed

### Blocked submissions now leave evidence

Legacy ran every routing refusal through one `routingBlocked()` helper, which audited
`EXECUTION_ROUTING_BLOCKED` as `'system'` and published a `ROUTING_BLOCKED` notification
deduped to **one per UTC day** (`'routing-blocked:' . gmdate('Ymd')`). The Node port threw a
bare 409 for all three in-transaction submission refusals — so an attempt to submit an order
**while the kill switch was active left no trace whatsoever**, and *"who tried to route while
the platform was stopped, and when"* is the first question a governance review asks.

`recordSubmissionRefusal` now covers the three refusal codes:

| Code | Audit | Notification |
|---|---|---|
| `EXECUTION_GOVERNANCE_BLOCKED` | per attempt | `ROUTING_BLOCKED`, warning, broadcast, deduped per UTC day |
| `PAPER_SUBMISSION_NOT_APPROVED` | per attempt | none |
| `PAPER_SUBMISSION_ALREADY_CLAIMED` | per attempt | none |

The audit event is per attempt for **all three**, because each is a distinct event worth
reconstructing — including the concurrent-submit case, which is a bypass attempt. The
notification is limited to the governance refusal and keeps legacy's daily dedupe, because
`ROUTING_BLOCKED` means *"the platform cannot route today"*. Broadcasting it when a caller
merely submitted an undecided proposal would say the platform is down when it is not, and a
misleading alert is worse than no alert (ES-3).

Three implementation details that are load-bearing:

* **The evidence is written outside the transaction that rolled back.** The refusal is
  detected *inside* `withPaperTransaction`, which then throws and rolls back. An audit event
  written inside it would have been rolled back with it and the evidence would silently not
  exist — the exact failure this change is meant to prevent. Hence `auditOutsideTransaction`,
  which is the only audit writer in this service that does not go through `tx`. Legacy's
  `audit->emit` was likewise a separate write.
* **The proposal's status is not touched**, exactly as legacy left it. A blocked attempt is
  retryable; consuming the proposal would punish an operator for the platform's own state.
* **Both writers are best-effort.** A failing audit or notification write logs and continues,
  so an evidence outage cannot mask the refusal or — worse — turn a blocked submission into a
  successful one. Tested by breaking each writer in turn.

This also makes `ROUTING_BLOCKED` the **second** Phase 9 notification type to gain a real
publisher (Phase 12 wired `PORTFOLIO_RISK`). NV-6 now lists three: `BROKER_CONNECTED`,
`BROKER_DISCONNECTED`, `SPORTS_MODEL_DRIFT`.

### Bypass and recovery tests

`test/execution_governance.test.js` (7 tests) exists because the re-verification was correct
and unproven:

* an approval granted while the platform was live **cannot** become an order after the kill
  switch is thrown, and the paper engine is never reached;
* the blocked attempt leaves exactly **one** audit event — not zero (rolled back), not two;
* three refusals on one UTC day produce **one** broadcast alert, and the next UTC day produces
  another, while every attempt is still individually audited;
* a trading-mode flip blocks identically;
* **recovery** — the same proposal submits once governance is restored, reaches the paper
  engine exactly once, and the at-most-once claim still holds afterwards, with the full story
  reconstructable in order from the trail;
* owner scoping — a foreign owner gets the owner-scoped 404, **not** a governance answer, so
  governance state cannot be used to probe another operator's proposals, and a 404 records no
  blocked-submission evidence;
* a broken audit writer and a broken notifier each still surface the real 409.

Two existing assertions were **strengthened rather than relaxed** to absorb the new events:
`execution_service.test.js` and `execution_http.test.js` both pinned the exact audit-action
sequence, and both now assert the refusals they already provoke, with details — including that
a concurrent submit against a row in `PAPER_SUBMITTING` is recorded as the bypass attempt it
is.

## Divergences

**ES-1 — trading-mode vocabulary.** Legacy step 2 admits `HUMAN_APPROVAL`, `SEMI_AUTONOMOUS`,
`FULLY_AUTOMATED`; Node admits `PAPER_TRADING`. These are not two names for one thing: legacy's
are *broker execution* modes and its own rejection message routes paper orders elsewhere. Node
has one workflow (human-approved paper), so it has one admissible mode. The three broker modes
stay unported with steps 4–15.

**ES-2 — a blocked attempt is attributed to whoever attempted it.** Legacy audited
`EXECUTION_ROUTING_BLOCKED` with actor `'system'` regardless of the caller, because `route()`
was usually invoked by the automated router. Node's `submitToPaper` is always called by an
identified owner, so the event carries that owner and the trail can answer "who tried".
Strictly more information; recorded because it is a difference.

**ES-3 — the HTTP answer stays 409.** Legacy's `route()` returned `200` with
`{status: "ROUTING_BLOCKED", brokerOrderCreated: false}`. Node keeps the 409
`EXECUTION_GOVERNANCE_BLOCKED` that Phase 8A established and that existing tests assert, and
adds the evidence legacy recorded. Changing the status code to match legacy would break an
accepted contract for no governance gain; the audit record now states `orderCreated: false`
and `retryable: true` so the body's meaning survives in the trail.

**ES-4 — no `volume`, no `contractSize`.** Legacy's intent carried a volume and a contract
size, and step 10 ran the risk engine against *that actual volume*. Node's intent carries
`riskPct` (bounded 0.000001–0.05) and the `RiskEngine` derives the size, so there is no
caller-supplied volume to check. Legacy's `volume > 0 && is_finite` guard therefore has no
counterpart and needs none. This was settled in Phase 7/8A; it is restated here because it is
why step 10's wording does not transfer literally.

**ES-5 — session, per-class freshness, duplicate-position and margin gates are not applied to
paper proposals.** All four read broker state in legacy (`connector->quote/positions/account`)
and all four are broker-execution policy. Legacy's `PaperTradingEngine` had none of them — it
passed `staleData => false` hard-coded to the risk engine — so importing them into the paper
workflow would refuse simulation trades the legacy simulator accepted. They are row 13 work,
and this is recorded so their absence is not later mistaken for an oversight.

**ES-6 — `automationLimits` is not ported, on purpose.** The document
(`maxTradeNotionalUsd` 500, `maxDailyTrades` 5, `maxRiskPerTradePct` 0.01, `approvedSymbols`
[]) is read only by step 8 and step 10's automation sub-checks, i.e. only in
`SEMI_AUTONOMOUS` / `FULLY_AUTOMATED`. Porting the state and its two endpoints without those
modes would produce a settable, echoed-back limit that nothing enforces — **exactly F-30**,
which Phase 12 recorded one day earlier for `maxCorrelatedPositions`. Porting it *with*
enforcement would mean applying a cap designed for robots to human-approved paper trades,
which legacy never did. Neither is acceptable inside a phase whose rule is to preserve
behaviour first, so the correct action is to leave it out and say so. When row 13 ports the
automated modes, the limits come with them and are enforced from the first commit.

## F-31 — legacy `automation_limits` was readable by every signed-in user (new finding)

`Api_system::automation_limits()` makes **no `requirePermission` call**:

```php
public function automation_limits()
{
    $this->json(['limits' => \Aegis\ExecutionSupervisor::automationLimits($this->platform->state())]);
}
```

`api_system/automation_limits` is not in `MY_Controller::PUBLIC_ACTIONS`, so it is not
anonymous — but authentication without authorization means **every signed-in user** could read
the automation governance envelope: the approved-symbol list, the daily automated-trade cap,
the maximum notional and the maximum risk per trade. Its sibling `update_automation_limits()`
correctly requires `trading.control`, which makes the omission on the read side look like an
oversight rather than a decision.

This is the same shape as **AV-1** (Phase 10: the audit trail was readable by any signed-in
operator because `Api_system::events()` never called `requirePermission`). Lower severity —
configuration rather than identity and trade history — but the same class, and worth stating
plainly: **the legacy API authenticated broadly and authorized inconsistently.**

Not exploitable in Node, because the endpoint was never ported (ES-6). Recorded so that row 13
ports it *gated* — `trading.control` for the write and at minimum `trading.view` for the read —
instead of inheriting the hole along with the feature.

## Verification

| Gate | Result |
|---|---|
| `npm test` | **616 / 616** (was 609; +7) |
| `npm run verify:install` | **29 / 29**, 67 config vars |
| PHP oracle (`node runtime/run-tests.mjs`) | **367 / 367**, 0 PHP files modified |
| API routes | **80** (unchanged — no route added or removed) |
| Admin routes | **7** (unchanged) |
| Persistence contract | **86** methods (unchanged) |
| Migrations | **001–010** (unchanged — no new table) |
| Module ledger | **17** rows; 9 ported / 3 partial / 5 not-ported (unchanged) |
| Version | 0.11.0 → **0.12.0** |

No migration, no contract method and no route: this phase changed one service, added one test
file and strengthened two existing assertions.

### Not exercised, and therefore not claimed

* **No broker-bound step was exercised**, because none was ported. Steps 4–9 and 12–15 have no
  Node code path, so nothing here is evidence about them.
* **`SEMI_AUTONOMOUS` and `FULLY_AUTOMATED` remain unreachable.** No test can fail on a mode
  that cannot be set, and that is the point — but it also means the automation limits are
  unexercised in both codebases as far as this port is concerned.
* **The daily dedupe is proven on the file adapter only.** `hasUnreadNotificationDedupe` is
  Phase 9 machinery; its MySQL path is pinned by a recording executor and has never run
  against a server (F-15).
* **Concurrency was simulated, not raced.** The "concurrent submit" case uses a gate to hold
  one submission in `PAPER_SUBMITTING` while another is attempted inside one process. Two real
  Passenger workers claiming the same proposal have not been tested, and F-24 (a shared health
  store for multi-process Passenger) is the same unresolved question in a different place.
* **No legacy `executions` table import**, because no Node equivalent exists. Row 22 must
  decide whether legacy execution history is carried across at cutover or left behind.
* **The reconciliation is a reading, not a differential test.** F-26 still stands: no harness
  runs one intent through the PHP supervisor and the Node service and compares the verdicts.
  Every verdict in the table above was reached by reading both implementations.

## Next

* Row 13 (broker connectors) owns steps 4–9 and 12–15, the two automated modes,
  `automationLimits` **with** enforcement from the first commit (ES-6), and the
  `BROKER_CONNECTED` / `BROKER_DISCONNECTED` publishers still on NV-6. It must port
  `automation_limits` gated (F-31).
* `execution` stays **`partial`** and its label now says the remainder is broker-bound rather
  than unfinished governance work — a reader should not have to open this file to learn that.
* F-30 still needs its decision: enforce `maxCorrelatedPositions`, port legacy's static
  correlation-group table, or remove the limit from the API so it stops reading as enforced.
* A differential harness for the intent validator (F-26) would be cheap and high-value: both
  `normalizeIntent` implementations are pure functions, so the same table of malformed intents
  could be run through PHP and Node and compared directly.
