# JavaScript / Node.js / cPanel migration status

**Updated:** 2026-10-12 · **Branch:** `arena/8de8de2e-ai`

## Current Phase 16 status (2026-10-12)

**Sports persistence and ingestion are ported** (row 14, slice 2 of 5). App version is
now **0.15.0**. The ledger stays at **9 ported / 5 partial / 3 not-ported** across **17**
modules — `sports` remains `partial`, and what changed is its label. Full record:
[`PHASE16_SPORTS_PERSISTENCE.md`](PHASE16_SPORTS_PERSISTENCE.md).

Migration **011** creates seven `wf_sports_*` tables, taking the schema to **31**. The
storage contract grows **86 → 108** methods, implemented identically on both adapters.
Fixture, odds and result ingestion runs end to end under a caller-supplied `executionKey`
whose `UNIQUE` constraint is the arbiter, and routes go **82 → 88**: five reads on
`sports.view`, one write on `sports.manage`, and the existing status route — whose
`derivedStatus` is now **measured** from stored rows instead of hard-coded `UNKNOWN`.
Node assertions **752 → 812**; the differential harness now compares **eight** legacy
classes over **124** cases (was six and 62). PHP oracle **367/367**, **0** PHP paths
modified.

**Finding F-35, and why it matters more than the table count.** Legacy's
`ProviderHealthMonitor::assess()` has **no caller anywhere** in `application/`, and its
own docblock documents its third parameter as *"newest-first `sports_sync_runs` rows"* —
a table the `SportsRepository` interface provides no method to read. Legacy wrote sync
evidence into a table it could not query, and built a monitor whose derived status it
never computed, so every quality assessment was scored against a provider reliability
that came from whatever a vendor self-reported. **Porting the class would not have closed
this**; Phase 15 already did that. Adding `listSportsSyncRuns` — which has no legacy
counterpart — did.

**Still not claimed:** no prediction, ticket, stake, settlement, calibration, backtest,
model metric, dashboard, configuration service or cron. **No stored result is verified** —
ingestion reports an outcome and `verifySportsResult` is not in the contract, so nothing
in this slice can attest to one. No provider is verified against a real vendor, and no
MySQL was exercised (**F-15**). **NV-6** is unchanged.

---

## Phase 15 status (2026-10-12) — superseded by Phase 16

**The sports data foundation is ported** (row 14, slice 1 of 5). App version is now
**0.14.0**. `sports` moves from `not-ported` to `partial`, taking the ledger to
**9 ported / 5 partial / 3 not-ported** across **17** modules. Full record:
[`PHASE15_SPORTS_FOUNDATION.md`](PHASE15_SPORTS_FOUNDATION.md).

Row 14 is the largest row in the backlog — **3 056 lines** of library code behind a
**65-method** repository interface spanning **18 tables**, with ~24 controller
endpoints and 16 oracle files. It is being landed in five slices along its
dependency order, and this one takes the layer everything else reads from:
`providers → normalizer → matches/odds/results → quality gates`.

**What is ported.** The fixture and odds normalizers, the data-quality and
odds-freshness engines, the typed provider failure, the fallback chain (which
returns a *structured failure* rather than an empty success — an empty list would be
indistinguishable from a day with no fixtures), the deterministic double-gated
sandbox provider, the generic REST provider with classified failures, and a health
monitor that derives status from observations and **invents none**: with nothing
witnessed it reports `UNKNOWN`, not `OFFLINE` and not `ONLINE`. One read-only route,
`GET /api/v1/sports/status`, gated on `sports.view`.

**The headline is F-26, closed.** This phase built the platform's first PHP↔Node
differential harness: a generator runs the real legacy classes in WASM PHP 8.2 and
emits their output, and **62 captured cases** are recomputed by the Node port and
compared to the last double and the last character of every refusal message. It was
only possible because these four classes are *pure* — every earlier candidate either
touched the database or diverged numerically on purpose.

**It found F-34 on its first run.** PHP exposes two different CRC-32 algorithms
under near-identical names, and legacy's sandbox provider uses **both in one class**.
The Node port had implemented one and used it for both, producing stable, plausible,
self-consistent fixture ids that belonged to an entirely different fixture universe
than legacy's. No test written against the Node implementation alone could have
caught it, and nothing downstream would have failed until **row 22** — the cutover —
which is the most expensive possible moment to discover it. Five defects (D-22 …
D-26) were found and fixed in total; two of them, D-24 and D-26, are the same lesson
twice: *read the platform's existing convention before writing a parallel one.*

**What is deliberately absent.** No persistence — seven tables were drafted and then
**removed from this change**, because tables nothing reads are dead schema that costs
four pinned counts and buys a host nothing. Therefore no sync, no prediction, no
value or staking calculation, no ticket, no settlement, no calibration, no backtest,
no model metric and no dashboard: **ten `notPorted` entries say so in the API
response**, because no ported module has a console screen (**F-29**) and the
distinction has to travel in the payload or it is lost (**BC-10**).
`SPORTS_MODEL_DRIFT` is still unpublished, so **NV-6 is unchanged**. Legacy's ~24
`Api_sports` endpoints are absent rather than approximated. No provider is verified
against a real vendor.

**One positive finding worth recording.** `Api_sports` is the **best-gated controller
in the legacy application** — `sports.view` for every read, `sports.manage` for
writes, and separate `sports.approve` and `sports.settle`. The Node route requires
`sports.view` because legacy did, not because a finding forced it. Set that beside
**F-32**, where `Api_system` left `brokers()` and `mt5_account()` ungated entirely:
the same codebase got one module's authorization right and another's wrong, so
"legacy did it this way" is evidence about a *controller*, never about the
application.

Gates: **752** Node assertions (was 689, **+63**), **367** PHP oracle passes,
**1 119** executed in total, **29/29** install checks with **76** documented
variables, **82** routes / **7** admin, storage contract **86** methods and **24**
tables both unchanged.

## Phase 14 status (2026-10-12)

**The broker connector boundary and its gates are ported** (row 13). App version was
**0.13.0**. `brokers` moves from `not-ported` to `partial`, taking the ledger to **9 ported /
4 partial / 4 not-ported** across **17** modules. Full record:
[`PHASE14_BROKER_CENTER.md`](PHASE14_BROKER_CENTER.md).

Row 13 asked for two things: port the connector boundary and health/demo gates, and verify
MT5 against a real demo terminal before any real-routing claim. **The second cannot be done
here** — there is no MetaTrader terminal in this sandbox — so it constrains the first: the
boundary and the gates are ported and proven, and **no routing claim is made anywhere**.

What exists now: the nine normalized data contracts every adapter must satisfy, with legacy's
error messages byte-identical and legacy's timestamp shape preserved; the four-state health
ladder `DISABLED → NOT_CONFIGURED → DOWN → READY`, where only `READY` carries the
bridge-reported fields; the safety model — local flag **and** a bridge that also reports
`tradingEnabled` **and** a demo account unless live trading is separately and explicitly
allowed, all re-verified against a **force-refreshed** probe on every write; `BrokerManager`'s
`tradingConnector()`, which returns `null` unless a connector is order-capable *and* `READY`
*and* effective; and legacy's ten connectors registered in legacy's order under legacy's
`AEGIS_*` variable names, all disabled by default. **One route, and it is a read**
(`GET /api/v1/brokers`, `trading.view`), carrying the `PLANNED` honesty matrix that legacy
showed only in its console.

**This phase also publishes the last two broker notification types.** `BROKER_CONNECTED` and
`BROKER_DISCONNECTED` came from `PortfolioRiskMonitor::brokerAlerts()`, inside the same cron
sweep Phase 12 ported. `DISABLED` is never counted, so a default host with ten disabled
connectors stays silent instead of raising ten critical alerts on its first run. **NV-6 now
lists one unpublished type**, `SPORTS_MODEL_DRIFT` (row 14).

**Two findings.** **F-32**: the legacy system API authorized its writes and left its reads
open — `brokers()`, `mt5_account()`, `mt5_quote()`, `risk_limits()`, `execution_preflight()`
and `automation_limits()` make no `requirePermission` call, and `status` is public, so
connector health was anonymous and the broker **login, balance and equity** were readable by
any signed-in user. That is AV-1 and F-31 again, and three instances across three phases is
a property of the legacy API rather than a run of oversights. **F-33**: the documentation gate
scans for literal dotted environment reads, so a name composed from a prefix table was
invisible to it — 21 licensed-feed variables had already shipped undocumented with the gate
green, and the 50 broker variables would have joined them. Found by strengthening the gate,
which then reported the pre-existing gaps itself.

Two defects were found by the new tests and fixed: **D-20**, `read()` refused an array `data`
payload — legacy checked PHP's `is_array()`, true for a list *and* a map, so the port would
have rejected **every successful list read**; and **D-21**, the config composed MT5's trading
flags as `AEGIS_MT5_BRIDGE_TRADING_ENABLED` where legacy reads `AEGIS_MT5_TRADING_ENABLED`,
which would have left the only connector that can actually work permanently switched off
while the documented variable silently did nothing.

**Deliberately not ported:** the simulated demo bridge (it would create the first
order-routing path in this platform and needs a long-lived loopback listener that a
Passenger host does not offer); the two MT5 read endpoints (a route that can only answer 503
is worse than no route); and `automationLimits` / `automationModeGate` / the two automated
modes, which stay blocked on a verified adapter rather than on scope.

Gates: `npm test` **689 / 689** (was 616, **+73**), `verify:install` **29 / 29** with **69**
documented config variables, PHP oracle **367 / 367** with **0** PHP paths modified, **81**
routes (**7** admin), contract **86**, migrations **001–010**.

**Not claimed:** no adapter has spoken to its provider — every gate test runs against an
injected transport, which is how legacy tested its own bridge; **no order has been placed by
any path**; the one configured connector in the tests points at loopback port 9, where
nothing listens; the PHP↔Node differential harness still does not exist (**F-26**), although
this phase made it cheap; and row 13's own verification criterion is unmet and unmeetable
here.

## Phase 13 status (2026-10-12)

**The Execution Supervisor is reconciled, step by step** (row 12). App version is now
**0.12.0**. Full record: [`PHASE13_EXECUTION_GOVERNANCE.md`](PHASE13_EXECUTION_GOVERNANCE.md).

Row 12 told this phase to reconcile before deciding scope, and the reconciliation
changed the question. **Node's `execution` module was never a port of the legacy
supervisor's broker pipeline** — it is a paper-scoped analogue of that pipeline's
human-approval workflow. Legacy says so itself: step 2 rejects any mode outside
`HUMAN_APPROVAL / SEMI_AUTONOMOUS / FULLY_AUTOMATED` with *"broker execution requires
… (paper orders go through the Paper Trading engine)"*. The supervisor was always the
connector path, driven by the console controller `Execution.php`; **there is no
`Api_execution.php`**. Nine of its fifteen steps read broker state that does not
exist here and belong to row 13. Steps 1, 3, 10, 11 and 14 were already ported —
several **stricter** than legacy (an executable exact strategy version, a persisted
human risk sign-off for AI strategies, owner-scoped proposal reads, bounded `riskPct`).

**The real gap was evidence, and it is closed.** Legacy ran every routing refusal
through `routingBlocked()`, which audited `EXECUTION_ROUTING_BLOCKED` and published a
`ROUTING_BLOCKED` alert deduped to one per UTC day. Node threw a bare 409, so an
attempt to submit an order **while the kill switch was active left no trace at all** —
and "who tried to route while the platform was stopped, and when" is the first
question a governance review asks. All three in-transaction refusals are now audited
per attempt; the governance refusal also broadcasts. **The evidence is written outside
the transaction that rolled back**, because an audit event written inside it would have
vanished with it — the precise failure this change exists to prevent. Both writers are
best-effort, so an evidence outage cannot turn a blocked submission into a successful
one.

The re-verification itself was correct but **untested**: `route()`'s kill-switch and
status checks had been ported into `submitToPaper`'s transaction in Phase 8A with no
test proving an approval granted while live cannot become an order after the switch is
thrown. `test/execution_governance.test.js` (7 tests) adds the bypass *and recovery*
cases row 12 named, including that the same proposal submits once governance is
restored and reaches the paper engine exactly once. Two existing assertions were
**strengthened, not relaxed** to absorb the new events.

**One thing was deliberately not ported.** `automationLimits` and its two legacy JSON
endpoints bind only to the automated modes. Porting a settable, echoed-back limit with
nothing enforcing it would recreate **F-30** — recorded one day earlier for
`maxCorrelatedPositions` — and enforcing it would apply a cap designed for robots to
human-approved paper trades, which legacy never did (ES-6). Row 13 brings the limits
with the modes, enforced from the first commit.

Reading the legacy source also produced **F-31**: `Api_system::automation_limits()`
makes **no `requirePermission` call**, so every signed-in user could read the
automation governance envelope — the same authenticate-without-authorizing shape as
AV-1. Not exploitable in Node, because the endpoint was never ported.

`ROUTING_BLOCKED` is now the second Phase 9 type to gain a real publisher (after
Phase 12's `PORTFOLIO_RISK`); **NV-6 lists three**, not four.

Gates: `npm test` **616 / 616** (was 609, +7), `verify:install` **29 / 29** with 67
config vars, PHP oracle **367 / 367** with **0** PHP files modified. **No migration,
no contract method, no route and no table** — 80 routes, 7 admin routes, 86 contract
methods, migrations 001–010, ledger unchanged at **9 ported / 3 partial / 5
not-ported**.

**Not claimed:** no broker-bound step was exercised, because none was ported; the daily
dedupe is proven on the file adapter only (F-15); concurrency was simulated by gating
one submission inside one process, not raced between two Passenger workers (F-24); and
the reconciliation is a **reading**, not a differential test — F-26 still stands.

## Phase 12 status (2026-10-11)

**The scheduled operations cron is ported** (row 19). App version is now **0.11.0**.
`scheduledJobs` is a new key in `MODULE_STATUS`, taking the ledger to **9 ported /
3 partial / 5 not-ported** across **17** modules. Full record:
[`PHASE12_SCHEDULED_JOBS.md`](PHASE12_SCHEDULED_JOBS.md).

`tools/scheduled-jobs.mjs` replaces legacy's `php index.php tools cron`, which
`Tools::cron()` ran every minute: the cross-owner **portfolio risk sweep** and the
cross-owner **stale-proposal expiry**, one `system.job.run` audit event as the
**system** actor carrying legacy's `CRON_RUN` summary sentence verbatim. Migration
**010** adds `wf_job_locks` (23 → **24** tables) and the persistence contract grows
**84 → 86** methods. **No route was added** — the inventory stays at **80** routes
and **7** admin routes.

**This phase closes a Phase 9 gap.** `PORTFOLIO_RISK` was declared in the
notification vocabulary with no publisher, because the monitor's transition memory
did not exist. It does now: alerts are keyed `paper:<accountId>:<CODE>` exactly as
legacy keyed them, diffed against a persisted `alertKeys` document, and only
**transitions** are audited and notified — so a per-minute cron alerts once per
breach instead of 1 440 times. NV-6 now lists four unpublished types, not five.

**The lock is the one row 19 demanded as a prerequisite**, and legacy had none.
`job_name` is the primary key, so the arbiter is a duplicate-key error rather than a
check-then-act race; every lock carries `expires_at`, so a host that kills a job
cannot wedge the schedule forever; release and extend are holder-scoped, so a run
whose lock expired cannot delete the new holder's row on its way out. Ownership is
never inferred from `affectedRows` — MySQL counts *changed* rows, not matched ones —
so both adapters read the row back and compare `holder`.

**It is `partial`, and the label says why.** Legacy alerted at 80 % / 70 % / 60 % of
a limit as a `warning` and at the limit as `critical`; this port alerts on the paper
scan's **at-limit** breaches only (SJ-8). Two legacy codes have no Node equivalent —
`EXCESSIVE_LEVERAGE` and `CORRELATED_POSITIONS` (SJ-9). Adding either would have
meant changing row 11's already-accepted breach vocabulary inside a phase whose rule
is to preserve behaviour first, so the gap is recorded rather than closed by stealth.
`sports_cron` and `lottery_cron` belong to unported rows 14/15; broker transition
alerts belong to unported row 13 and stay on NV-6.

Two defects were found by the new tests and fixed: **D-18**, the two adapters
returned different shapes for a job lock (`lock.expiresAt` was a string on MySQL and
`undefined` on the file store — the class of divergence that only surfaces when a
deployment switches adapters), and **D-19**, the scheduled expiry audited the *owner*
where legacy audited `'system'`. One new finding is recorded: **F-30**,
`maxCorrelatedPositions` is a declared, settable risk limit with **no enforcement
anywhere** — the only one of the fifteen.

Gates: `npm test` **609 / 609** (was 582, +27), `verify:install` **29 / 29** with 67
config vars, PHP oracle **367 / 367** with **0** PHP files modified.

**Not claimed:** the lock has not been proven against real MySQL (F-15 — mutual
exclusion is tested on the file adapter, the SQL shapes against a recording
executor); **cPanel cron was not installed**, because this sandbox has no crontab
and no Passenger; and no overlapping run was produced by two real processes.

## Phase 11 status (2026-10-11)

**The research-only portfolio optimizer is ported** (row 9). App version is now
**0.10.0**. `portfolioOptimizer` is a new key in `MODULE_STATUS`, taking the ledger
to **9 ported / 2 partial / 5 not-ported** across **16** modules. Full record:
[`PHASE11_PORTFOLIO_OPTIMIZER.md`](PHASE11_PORTFOLIO_OPTIMIZER.md).

`POST /api/v1/portfolio/optimize` ports the 501-line `PortfolioOptimizer` class and
`Aegis\Platform::optimizePortfolio()`: annualized arithmetic returns and a sample
covariance aligned on the timestamps every asset shares, diagonal shrinkage plus a
numerical ridge, minimum variance by projected gradient and maximum Sharpe by
deterministic multi-start projected ascent, all under a fully-invested, long-only,
per-asset weight cap. **No migration, no contract method and no new table** — the
contract stays at 78 and the migrations at 001–009, and runs are recorded in the
existing audit trail.

**It cannot reach an order path, structurally rather than by comment.** The service
is constructed with `{store, marketData, log}` and is not given the paper service,
the strategy registry or the execution supervisor. The body schema cannot express an
instruction either: `additionalProperties: false` makes `execute`, `amount`,
`orderId`, `accountId` and `notional` a 400 at both the top level and inside an
asset, and a test asserts each by name.

Seven divergences (PO-1…PO-7) are recorded in the phase record. Three matter beyond
this module:

- **PO-2** separates estimation failures (**422**) from input-shape failures
  (**400**). Legacy used one exception class for both, so "your prices produced a
  non-finite return" answered 400 — a status telling the caller to fix a request
  that was not wrong.
- **PO-3** refuses an unsupported `marketClass` before any provider call. Legacy let
  a bad class fall through to `getCandleSeries`, so a typo surfaced as an outage.
- **PO-6** records that the `/portfolio/` prefix is now shared by two modules — this
  optimizer and the paper module's pre-existing `GET /portfolio/risk-scan` (Phase 7)
  — rather than silently re-homing a shipped path.

The synthetic-data gates are the honesty core and both are asserted over HTTP: an
all-synthetic universe is refused with 422 unless the caller passes
`allowSyntheticData: true` (a strict boolean — `"true"` and `1` do not unlock it),
and an opted-in run still carries a warning beginning `SIMULATION:`. A **mixed**
synthetic/live universe is refused with no flag that can unlock it, because a
covariance across one real and one generated series describes neither. Annualization
is inferred only for a single market calendar; a mixed universe must state
`periodsPerYear` itself rather than be handed a number wrong for every asset in it.

**A defect in shared infrastructure was found and fixed (D-15).**
`src/http/validate.js` threw a `TypeError` on any object-typed array item, surfacing
as a 500: the array branch forced `required: true` onto the item schema to mark the
item mandatory, and the object branch then called `.includes()` on that boolean
while reading it as the list of mandatory keys. It was **latent, not live** — every
`items` node in the platform was a string until this phase declared the first
object-typed one — and it is fixed rather than worked around, because a validator
that crashes on a valid schema shape is worse than one that rejects it. Verified
against eight schema shapes and by the full suite, since `validate.js` backs every
route in the platform. Two further defects (D-16 shadowed solver functions causing a
runtime `ReferenceError` that `node --check` cannot see; D-17 the service calling the
market-data **manager's** method rather than the **service's** house seam, so every
request 503'd on a host that had a provider chain) were found by this phase's own
tests and fixed before commit.

Measured in this sandbox on 2026-10-11 (Node v22.22.3): workforce-platform
`npm test` **582/582** (up from 532; **50** new tests across
`portfolio_optimizer` 19, `portfolio_service` 18, `portfolio_http` 13),
`npm run verify:install` **29/29** with **67** documented config variables (was 64;
the three new portfolio rate-limit variables are in `.env.example`), and the legacy
PHP oracle **367/367** with `git status --porcelain` reporting **0** modified paths
under `application/`, `system/` or `tests/`. Route count **79 → 80**; admin routes
unchanged at **7**.

**Not** exercised, and therefore not claimed: **real market data** — every HTTP test
runs with `MARKET_DATA_REAL_PROVIDERS=0` and `MARKET_DATA_ALLOW_SYNTHETIC=1`, so no
claim is made that a licensed feed produces a well-conditioned covariance, and row
6's provider gaps are what stop this optimizing a real equity universe; a
**numerical parity check against the PHP implementation** — the two were ported
instruction-for-instruction and the constraints are asserted, but no test runs the
same candles through both engines (**F-26**, and PO-1 exists precisely to keep the
numbers aligned, which nothing currently verifies); a **console screen**
(`views/portfolio/optimizer.php` unported, **F-29 still stands** — this is the third
ported API with no screen, after notifications and the audit browser); **saved
reports** (a run is returned, never persisted, so there is no history endpoint and a
caller cannot read back what the platform told them last week — only the audit event
records that a run happened); a real MySQL server (**F-15 unchanged**, though this
phase adds no new SQL); and any load measurement, the 12-asset bound being a guard
against a future quadratic inner loop rather than a benchmark.

Phases 8A, 9 and 10 remain in force and unchanged. The next gates are unchanged too
— validate migrations **001–009** and repository transactions against real
MySQL/MariaDB, then rehearse deployment, backup/restore and rollback on the actual
cPanel/Passenger host.

## Phase 10 status (2026-10-11)

**The audit browser is ported.** App version is now **0.9.0**. `audit` moves from
`partial` to `ported`, taking the ledger to **8 ported / 2 partial / 5 not-ported**.
Full record: [`PHASE10_AUDIT_BROWSER.md`](PHASE10_AUDIT_BROWSER.md). This closes
most of row 5 alongside Phase 9; what remains of that row is settings screens and
the security-event retention policy.

`GET /api/v1/admin/audit` serves the whole trail, filterable by actor, action
prefix, entity and inclusive time window, paginated and sorted on the three
columns migrations 001/003 actually index. It ports `Api_system::events()` and
extends `listAuditEvents`. **No new migration and no new contract method** — the
contract stays at 78 and the migration set at 001–009 — and it puts
`ix_wf_audit_entity` `(entity_type, entity_id, created_at)` to use for the first
time since migration 003 created it.

The substantive gap was not the missing page: **the audit read view did not
include the actor at all**, so no caller could answer "who did this". Every event
now carries `{ userId, username, kind }`, a system event says `kind: "system"`
rather than borrowing an identity, and a user id that no longer resolves keeps the
id with a null username instead of substituting a label.

Five divergences (AV-1…AV-5) are recorded in the phase record. Two matter beyond
this module:

- **AV-1 is a security tightening, not parity.** `Api_controller::PUBLIC_ACTIONS`
  does not list `api_system/events`, so the legacy endpoint required
  authentication — but `events()` makes no `requirePermission` call, meaning
  *every* signed-in operator could read *every* operator's identity, governance
  and execution trail. Node requires `identity.users.view`. This is stated as a
  deliberate narrowing rather than presented as an equivalent port.
- **AV-2 refuses a timezone offset** on `from`/`to` with a 400 that explains
  itself. `wf_audit_events.created_at` is `DATETIME(3)` with no timezone, so the
  SQL adapter would bind an offset instant through the connection's session
  timezone while the file adapter compares absolute instants — the same window
  could select different rows on the two adapters. Canonical `…Z` only, matching
  the `assertIsoCutoff` convention.

Read-only is asserted against the whole route inventory rather than a list of
paths: the test filters the inventory for anything matching `/audit` or
`/account/activity`, requires every one to be a `GET`, and separately requires
that no non-`GET` route anywhere matches `audit`. `/account/activity` is proven
not to have widened — `userId: null` still means "do not filter", so "events with
no actor" got its own word (`actor: "system"`) instead of a reinterpretation of
null that would have turned a personal view into a platform-wide one.

Two defects found by this phase's own tests and fixed before the record was
written, rather than relaxing the assertions to match the code. **D-13:** the
first window guard used `Number.isFinite(Date.parse(value))`, and
`Date.parse("12345")` is the **year 12345**, so `?from=12345` was accepted and
silently produced an empty window that looked like a working filter. **D-14:** the
parity double returned every row regardless of the `WHERE` clause and in insertion
order, so the adapters "agreed" for reasons unrelated to the code under test and
then disagreed about ordering; it now applies the filters and the `ORDER BY` it is
handed.

Measured in this sandbox on 2026-10-11 (Node v22.22.3): workforce-platform
`npm test` **532/532** (up from 522; 10 new tests in `test/audit_browser.test.js`),
`npm run verify:install` **29/29** with 64 documented config variables (this phase
adds no configuration and no migration), and the legacy PHP oracle **367/367** with
`git status --porcelain` reporting **0** modified paths under `application/`,
`system/` or `tests/`. Route count **78 → 79**, admin routes **6 → 7**.

**Not** exercised, and therefore not claimed: a real MySQL/MariaDB server — the
extended query is pinned by a recording executor that applies the recorded
`WHERE`/`ORDER BY` and has never run against a server (**F-15 unchanged**), so the
`LEFT JOIN wf_users` and the selectivity of `ix_wf_audit_entity` are unmeasured;
any **console screen** (`views/admin/index.php` unported, **F-29 still stands** —
the SPA's existing `/app/account` activity list is unaffected because it reads
named fields and the `actor` projection is additive); a **retention policy**
(`wf_audit_events` is unbounded with no delete path, which is correct for evidence
but leaves row 5's retention item undecided — it needs one policy covering audit,
notifications, R-27 and R-28, not four); a PHP↔Node value-for-value diff
(**F-26**), where AV-5 means the two schemas hold different data models anyway;
any **legacy `audit_logs` import**, so a cutover starts the Node trail empty
unless row 22 covers it; and any load measurement of pagination.

Phase 8A and Phase 9 remain in force and unchanged. The next gates are unchanged
too — validate migrations **001–009** and repository transactions against real
MySQL/MariaDB, then rehearse deployment, backup/restore and rollback on the actual
cPanel/Passenger host.

## Phase 9 status (2026-10-11)

**Operator notifications are ported.** App version is now **0.8.0**. Row 5 of
[`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md) is partly closed and the
`notifications` entry the status surface reported as `not-ported` now reports
`ported`. Full record: [`PHASE9_NOTIFICATIONS.md`](PHASE9_NOTIFICATIONS.md).

Ported from `Aegis/Notifications/Notifier.php`, the `NotificationRepository`
implementation in `Aegis_model.php`, the `notifications` table and the three
`Api_system` endpoints. Migration `009_notifications` adds `wf_notifications`;
the Node schema now has **23** tables and the repository contract **78** methods.
Route count **75 → 78**.

Behaviour preserved rather than redesigned: unread-dedupe (one badge per active
issue until acknowledged), broadcast-plus-own visibility, severity coercion to
`info`, 200-character title truncation, the `?unread=1` flag, the 50/200 limit
window, the legacy dedupe keys verbatim, and one indistinguishable `404` for a
missing/already-read/foreign id so the route cannot enumerate notification ids.
Six divergences (NV-1…NV-6) are recorded in §"Divergences" of the phase record;
the two that matter are that `detail` payloads are now **bounded** (legacy stored
an unbounded LONGTEXT) and that read state stays **global** to a broadcast row —
legacy behaviour, kept deliberately, with per-recipient read state left as a
product decision rather than a silent "fix".

Real publishers are wired, so the inbox carries actual platform events: the kill
switch (`KILL_SWITCH` / `kill-switch:active`, the legacy key), trading-mode
changes, and the paper-proposal lifecycle (`TRADE_APPROVAL_REQUESTED`,
`PROPOSAL_EXPIRED`, `ORDER_FILLED`, `EXECUTION_FAILED`). Five declared types have
**no publisher yet** because their legacy publishers (`PortfolioRiskMonitor`, the
broker health loop, `ModelDriftMonitor`) are not ported; inventing publishers
would fabricate alerts.

Two safety properties are asserted by test, not asserted in prose. **Publishing is
not reachable over HTTP** — the module registers one read and two read-state
transitions and nothing else, so no caller can inject an alert that looks like it
came from the risk engine. **A notification can never break the action that caused
it** — publishers run after the audit row commits and swallow their own failures,
because `wf_audit_events` is the evidence and the alert is the nudge; a host
without migration 009 can still move the kill switch.

Two defects were found by this phase's own tests rather than shipped. **D-12** was
a deadlock: the first implementation published from *inside*
`withPaperTransaction`, and the file adapter holds its single mutation queue for
the whole transaction, so the suite **hung** past a 600 s timeout instead of
failing. Every call site now queues the alert inside and publishes it after
commit. The second was the inbox filter being destructured as `unreadOnly` while
the route contract and the legacy query string name it `unread`, so `?unread=1`
silently returned an unfiltered page.

Measured in this sandbox on 2026-10-11 (Node v22.22.3): workforce-platform
`npm test` **522/522** (up from 482; 40 new tests), `npm run verify:install`
**29/29** with the migration check listing `009_notifications.sql` and 64 config
variables documented (this phase adds **no** configuration — the bounds and the
type vocabulary are code constants on purpose), and the legacy PHP oracle
**367/367** with `git status` showing no change under `application/`, `system/`
or `tests/`. The generated client-bundle check was skipped because
`public/app/index.html` is absent.

**Not** exercised, and therefore not claimed: a real MySQL/MariaDB server (the SQL
repository is pinned by a recording executor and has never run against a server —
F-15 unchanged), any delivery channel (`emailDeliveryAvailable: false`,
`deliveryChannels: []`), the console UI (`views/notifications/index.php` is
unported; F-29 still stands — no ported module has a workspace console), retention
(`wf_notifications` is unbounded with no delete path, the same open question as
R-27/R-28), a PHP↔Node value-for-value diff (F-26), and cross-worker contention on
the conditional `UPDATE`.

Phase 8A remains in force and is unchanged: owner-scoped paper proposals, explicit
human approve/decline, four-hour expiry, no generic route, no broker connector, no
live order path, `liveTradingEnabled` false. The next gates are unchanged too —
validate migrations **001–009** and repository transactions against real
MySQL/MariaDB, then rehearse deployment, backup/restore and rollback on the actual
cPanel/Passenger host.

## Phase 8A status (2026-10-11)

The Execution Supervisor workstream has a **partial, paper-only proposal workflow**:
owner-scoped proposals, explicit human approve/decline, four-hour approval expiry,
audited state transitions, and one-time submission through the existing Paper
Trading service. Migration `008_execution_supervisor` adds one table; the Node
schema contains 22 tables. `execution` reports `partial`, not `ported`. This is a
bounded start, not a port of the broader legacy supervisor, and it does not assume
a fixed number of supervisor steps.

- Phase record: [`PHASE8_EXECUTION_PROPOSALS.md`](PHASE8_EXECUTION_PROPOSALS.md).
- Phase 7 remains in force: persisted risk/governance, owner-scoped paper accounts,
  simulation-only fills, synthetic provenance, DV-10 equity veto, and exclusion of
  synthetic paper trades from live-approval evidence.
- Node has no generic route, broker connector, live order path or automated mode.
  Proposal submission calls only Paper Trading, which reruns its risk and governance
  checks. `liveTradingEnabled` remains `false`.
- MySQL/MariaDB SQL is covered by static parsing and a recording fake only. No real
  MySQL/MariaDB or cPanel/Passenger validation, multi-worker rehearsal, PHP↔Node
  parity sign-off, live-feed validation or cutover has occurred. Keep PHP
  authoritative and live trading disabled.
- Final Phase 8A verification: workforce-platform `npm test` **482/482** and
  `npm run verify:install` **29/29** (102 source files syntax-checked; 64 config
  variables documented). The generated client-bundle check was skipped because
  `public/app/index.html` is absent. These checks do not substitute for real DB or
  host validation.

The Phase 1–7 detail below is dated implementation history. For today's state,
use this Phase 8A record, the phase report and current backlog; historical statements
about earlier migration counts or which module was next are not current deployment
evidence.

## Decision and safety boundary

The migration is the whole WINDELS AI WORKFORCE platform, not just the PHP front end. Proceed side-by-side, module by module, with MySQL/MariaDB, Passenger-compatible Node.js, parity/security evidence, and rollback. Keep PHP authoritative until the complete replacement is explicitly accepted. Never enable live trading, alter production data, deploy, or cut over traffic without approval.

The implementation slice now follows the requested Node-core HTTP + Vanilla public site + React/Vite SPA + PWA + Capacitor-shell shape. The user selected MySQL/MariaDB as the database target. Therefore `mysql2` remains necessary and `pg@8.16.3` is not installed: `pg` cannot connect to MySQL. The legacy PHP bcrypt verifier also remains until an explicitly approved password-reset or hash-migration decision.

## Confirmed decisions (2026-10-06, branch `arena/9643b72f-ai`)

A feasibility review of the target shape — dependency-light Node monolith, Vanilla JS public site, React/Vite SPA, PWA, Capacitor native apps — was requested with "`pg@8.16.3` as the only production dependency". Two decisions were taken and are recorded here as authoritative.

**1. MySQL/MariaDB is retained; `pg@8.16.3` is out of scope.** The production schema is MySQL/MariaDB DDL: `database/production.sql` is 1,159 lines defining 79 tables, all 79 `ENGINE=InnoDB`, with 39 `AUTO_INCREMENT`, 36 `LONGTEXT` and 80 `utf8mb4` occurrences, targeting cPanel. `pg` implements the PostgreSQL wire protocol and cannot connect to MySQL, so "only `pg`" is not satisfiable against this baseline. No PostgreSQL rewrite is authorized. The only `pg` reference in the repository remains `apps/api/package.json` at `8.15.6`, which is unrelated to this platform.

**2. Legacy passwords move to lazy rehash on next login.** `bcryptjs` is retained now and becomes removable only after the rollout completes. This is a **new feature that does not yet exist**; the following gaps were verified rather than assumed:

- `verifyPassword` normalizes PHP `$2y$` to `$2b$` before comparing, so legacy login works.
- **Update (2026-10-09):** the store surface is no longer seven methods — `src/persistence/contract.js` defines 30, `updatePasswordHash` included, and both adapters implement it under contract assertion at boot. Lazy bcrypt→scrypt rehash remains **deliberately deferred**: re-hashing live credentials is a security decision that needs approval, a rollback path and its own tests. It is the only item from this list still open.

## Verified state of the foundation (2026-10-06)

Re-run on Node v22.22.3 in this branch, not carried forward from an earlier claim:

- `npm run check` (`apps/workforce-platform`): **43 passed, 0 failed** at that date. Replaced by the Phase 2 measurement below (85 tests). These use deterministic test stores and do not prove real MySQL behavior.
- `npm run build` (`client/`): Vite transformed **16 modules** to `public/app/`, 231.19 kB JS / **72.20 kB gzip**. Build output is generated and git-ignored.
- Live server on `0.0.0.0:3000`: `/`, `/manifest.webmanifest`, `/service-worker.js`, `/site.js`, `/styles.css`, `/robots.txt` all returned **200**; `/api/v1/health/live` **200**; `/api/v1/health/ready` **503** with `{"status":"not_ready","database":false,"schema":false}` in the absence of MySQL.
- `public/index.html` contains **0** React references, confirming the public site is genuinely Vanilla JS.
- Security headers observed on `/`: full CSP, `x-frame-options: DENY`, `cross-origin-opener-policy: same-origin`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `permissions-policy`, `x-request-id`.
- Path traversal `/../etc/passwd` returned **404**.
- The `/app/*` SPA fallback is content-negotiated by design (`src/app.js:220-222`): requests sending `Accept: text/html` receive the SPA shell (**200** for `/app/deep/link`), while requests without it correctly stay **404** so missing assets are not masked. This is intended behavior, not a defect.
- Runtime production dependencies are exactly `bcryptjs@^3.0.2` and `mysql2@^3.24.5`; every other import in `server.js` and `src/` is `node:*` or local project code.

Still outstanding and unchanged: only 7 API routes are ported (5 auth, 2 health) against 32 PHP controllers; no real MySQL server, production import, cPanel/Passenger host, native SDK build or traffic cutover has been exercised.

---

## Phase 2 — identity, accounts and the platform core (2026-10-09, branch `arena/c204b9d0-ai`)

**This section supersedes the route counts, the dependency story and the "no storage
adapter" gaps above.** Full record: [`PHASE2_IDENTITY.md`](PHASE2_IDENTITY.md); finding
by finding: [`PHASE0_AUDIT_20261008.md`](PHASE0_AUDIT_20261008.md) §10.

- **28 API routes** across identity, accounts, administration, health and the status
  surface — listed by `GET /api/v1/system/routes`, mirrored in `docs/migration/ROUTE_MAP.md`.
- **Storage adapters**: `STORAGE_ADAPTER=mysql|file|auto` behind one 30-method
  repository contract, asserted before the server listens. The file adapter exists so
  the platform runs where no database is reachable; it is refused in production unless
  `ALLOW_FILE_STORE_IN_PRODUCTION=1` is set deliberately.
- **Platform core rebuilt**: 7-verb router with path params and 405/`Allow`, full
  validation with field-level issues, multipart + upload policy with signature sniffing,
  exact-origin CORS, bounded rate limits with per-account lockout, `AppError` taxonomy
  (dependency outage = 503 + `Retry-After`, never 500), request logging, fatal-error
  handlers, static serving that distinguishes document/asset/SPA route.
- **RBAC parity**: migration `003_account_management.sql` plus
  `src/db/platform-baseline.js` seed the legacy 8 roles / 14 permissions including
  `system.super_admin`; a test asserts the SQL and the code agree key for key.
- **Operations**: `verify:install` (21 checks), `verify:data`, `seed:platform`,
  `backup` / `restore` (sha256 manifest, `mysqldump --single-transaction`, password in a
  `0600` defaults file), `migrate:status` / `migrate:dry-run`.
- **Dependencies unchanged**: `mysql2` + `bcryptjs`, nothing else, no `devDependencies`;
  tests are `node:test`. `.env.example` documents all 38 config variables and a check
  keeps it true.

Measured in this sandbox on 2026-10-09: **85** app tests passing, **367** legacy runtime
tests passing, **21/21** install checks, `verify:data` exit 1 on an unseeded store and
exit 0 after `seed:platform`, backup → verify → wipe → restore round trip proven by test.
**Not** exercised: a real MySQL server, production data, a cPanel/Passenger host, any
provider, any native build, any cutover.

Unchanged and still true: the PHP application is the source of truth and the rollback
target; `application-deployment.zip` remains stale and the deployment docs now say so;
F-11/F-12 await approval-gated decisions; F-15 cannot be closed without a staging
database. F-09/F-10 (PWA/SEO) were deferred to Phase 3 and are closed there — see the
next section.

---

## Phase 3 — public site, SEO/PWA shell and contact intake (2026-10-09, branch `arena/774d9e70-ai`)

**This section supersedes the route counts, the public-site description and the PWA
description above.** Full record: [`PHASE3_PUBLIC_SITE.md`](PHASE3_PUBLIC_SITE.md).

- **30 API routes** (28 from Phase 2 plus `POST /api/v1/site/contact` and
  `GET /api/v1/admin/inquiries`) and **22 rendered document routes** — 8 marketing pages,
  9 legacy aliases/redirects, `robots.txt`, `sitemap.xml`, `manifest.webmanifest`,
  `service-worker.js`, and `POST /contact/submit`. The two ledgers are asserted disjoint.
- **F-10 closed**: every legacy `Site`/`Seo` route is answered, page copy is compared
  heading-for-heading against `application/views/site/*.php`, metadata comes from one
  validated `SITE_*` surface, robots keeps all six legacy disallow rules (plus three
  Node-only private prefixes), and the sitemap refuses to publish relative URLs.
- **F-09 closed**: a real PNG icon set (192, 512, maskable-512, apple-touch-180) rendered
  by `tools/generate-icons.mjs` and proven byte-reproducible; a service worker whose cache
  name is derived from the shell's content hash; hashed build assets cache-first, unhashed
  shell never cache-first; `/api/`, uploads, private and data paths never cached; and a
  waiting-worker **Reload / Not now** prompt in both the vanilla site and the SPA.
- **Generated documents replaced static files**: `public/index.html`, `public/robots.txt`,
  `public/sitemap.xml`, `public/manifest.webmanifest` and `public/service-worker.js` are
  deleted from the tree and rendered per request; `verify:install` fails if any returns.
- **Contact intake**: `wf_contact_inquiries` (migration `004_public_site.sql`, additive),
  a 26-character ULID receipt reference, an HMAC-SHA256 client fingerprint instead of a raw
  IP, the `CONTACT_INQUIRY` audit entry, a per-address throttle (3/hour default), a signed
  one-shot `wf_flash` cookie for the no-script path, and `mail.sent:false` in every response
  because no outbound transport exists. Repository contract: **32** methods.
- **SPA slice**: typed `ApiError` client, an exact-path history router, permission-gated
  navigation, loading/empty/error/offline states, and register / account / admin-users /
  contact-inbox / platform-status views — so the `/login` and `/register` redirects land on
  real surfaces. Client build green: 20 modules, 265.27 kB JS (79.47 kB gzip).
- **Deliberate divergences** are recorded in `PHASE3_PUBLIC_SITE.md` §5, including the two
  that keep `publicSite` at `partial`: the legacy public chat widget is not ported, and the
  legacy announcement-bar default copy (which advertises the unported AI Language Teacher)
  is not reproduced.

Measured in this sandbox on 2026-10-09: **103** app tests passing (18 new in
`test/site.test.js`, which reads the legacy PHP as its oracle), **30/30** install checks,
**4/4** icon checks, **367** legacy runtime tests, **12** Scout contract tests, **29**
football-prediction tests — **511** passed, 0 failed — plus a live `curl` rehearsal of every
document route, both contact paths, the admin listing and its 401/403 boundaries on the file
adapter. **Not** exercised: a real MySQL server (migration 004 has never been applied by one),
a cPanel/Passenger host, a real browser (no Lighthouse or install-prompt observation),
outbound mail, any provider, any native build, any cutover.


## Phase 4 — market data and provider health (2026-10-09, branch `arena/774d9e70-ai`)

**This section supersedes the route count and the market-data status above.** Full record:
[`PHASE4_MARKET_DATA.md`](PHASE4_MARKET_DATA.md). App version is now **0.5.0**.

- **33 API routes** (the 30 from Phase 3 plus `GET /api/v1/market-data/candles`,
  `/quote` and `/providers`); the 22 rendered document routes are unchanged. All three new
  routes require a session and no permission, matching `Api_marketdata` — none of them is in
  the legacy `Api_controller::PUBLIC_ACTIONS` list.
- **The provider chain is ported**: priority ordering (Binance 10 → Frankfurter/ECB 20 →
  licensed stock/ETF/futures/options 30–33 → synthetic 999), capability and market-class
  filtering, timeframe-capable-first ordering, circuit breakers (5 failures / 60 s window /
  30 s cooldown, a failed probe re-opens), bounded TTL caches, retries with
  `min(1000, 300×2^attempt)` ms backoff, `DEGRADED` health promotion, provenance
  (`source`, `synthetic`, `live`, `delayed`, `dataAgeMs`, `stale`, `fallbackChain`) and
  candle validation (`ok`, `droppedCount`, `gapCount`, issues).
- **Honesty rules are enforced, not documented**: synthetic output is always labelled and
  registered last; `MARKET_DATA_ALLOW_SYNTHETIC=0` refuses it outright with
  `503 SYNTHETIC_DATA_DISABLED` and no candle array; a provider returning an error envelope,
  a zero/inverted bid-ask, fewer than 30 valid candles or invalid OHLCV **fails** instead of
  being repaired into a chart; ECB reference rates serve `1d` only with a real `volume: 0.0`;
  every fallback writes the audited `PROVIDER_FALLBACK` event; the four licensed adapters stay
  `DISABLED`/`NOT_CONFIGURED` and cannot be selected while inert.
- **Two hardenings over the legacy manager**, both recorded as divergences: a per-request
  deadline (`MARKET_DATA_DEADLINE_MS`, 15 s default; health probes 5 s) and bounded in-process
  caches (500 entries) — the legacy version had neither, and a Node process is long-lived.
- **Public status surface stays cheap**: `/api/v1/system/status` reports the registry, the
  synthetic policy and cached provider health, but **never probes** an external host, so an
  unauthenticated caller cannot make the server fan out to third parties.
- **No new dependency, no new table, no migration.** `fetch`/`AbortSignal` are platform
  built-ins; the module persists only the fallback audit event; migrations stay at 001–004.
  Eight new environment variables are documented in `.env.example` (53 total).

Measured in this sandbox on 2026-10-09: **140** app tests passing (37 new in
`test/market_data.test.js`, which ports the eleven `tests/cases/02-providers.php` cases 1:1
and makes no outbound network call), **30/30** install checks, **367** legacy PHP/WASM oracle
tests — the eleven provider cases passing on **both** sides of the migration — **12** Scout
contract tests, **29** football-prediction tests and a clean `npm run typecheck`: **548
passed, 0 failed**, plus a live `curl` rehearsal of all three endpoints, their 401/400
boundaries, the provider-health registry and the audit trail on the file adapter. CI caught
one network-dependent test that this sandbox could not (no egress): with real providers
reachable, the synthetic-refusal endpoint answers 200 rather than 503. It is fixed and
recorded as defect **D-6** in `PHASE4_MARKET_DATA.md` §6, and the suite is now asserted green
under both network conditions.
**Not** exercised: a live upstream provider (this sandbox has no egress to Binance or
Frankfurter — both reported `DOWN` and the chain fell back to labelled synthetic data, which
is the correct honest behaviour), a licensed feed of any kind, a value-for-value diff of PHP
versus Node numeric output (new finding **F-26**), a real MySQL server, a market-data user
interface, or any cutover.

## Phase 5 — analysis engines, agents, consensus and the risk veto gate (2026-10-09, branch `arena/774d9e70-ai`)

**This section supersedes the route count, the module counts and the analysis/risk status above.** Full
record: [`PHASE5_ANALYSIS.md`](PHASE5_ANALYSIS.md). App version is now **0.6.1** — `0.6.0` was Phase 5 as
delivered, and the patch release is the hardening pass below, which added no route, no module and no
dependency.

- **38 API routes** (the 33 from Phase 4 plus `POST /api/v1/analysis/run`, `GET /api/v1/analysis/history`,
  `GET /api/v1/analysis/agents`, `POST /api/v1/analysis/consensus` and `GET /api/v1/analysis/:runId`); the
  22 rendered document routes are unchanged. All five require a session and **no permission**, matching
  `Api_analysis` — none is in the legacy `Api_controller::PUBLIC_ACTIONS` list. The two mutations also
  require the session CSRF token; this is the first ported module with an authenticated unsafe method.
- **The analysis pipeline is ported**: 300 candles per symbol, `detectRegime` with all seven legacy labels,
  a seven-agent panel (technical, market structure, forex, crypto, sentiment, fundamentals, trading
  intelligence) with the legacy weights (1.0 / 0.9 / 0.9 / 0.9 / 0.5) and the ±0.15 vote threshold,
  weighted consensus with agreement, conflicts, confluence and the two hard gates, a four-round
  adversarial debate whose transcript is persisted, setup generation with 1.5/2.5/3.5 R targets, three
  scenarios per run, and `RiskEngine::evaluate` as the veto gate. Forex and commodity runs also fetch the
  seven legacy reference legs (60 candles each) for currency strength.
- **Nothing can be approved on this platform.** `DEFAULT_TRADING_STATE` is frozen with the kill switch
  **engaged** and `tradingMode: ANALYSIS_ONLY`, and no ported code path releases it — the kill-switch
  control surface, the portfolio monitor and the limits API are still legacy-only, which is why
  `/api/v1/system/features` reports `risk` as **`partial`**, not `ported`. Every run carries
  `riskContext.note` stating that the portfolio gates are evaluated against an empty portfolio.
- **Honesty rules are enforced, not documented**: the synthetic label is carried from market data into the
  run payload, the persisted row (as a column), the audit details and the risk veto; freshness is graded
  (live 1.0 / synthetic 0.5 / stale 0.2) and stale data is sustained as a **critical** objection that
  forces `NO_TRADE` and drops the proposal; sentiment and fundamentals abstain through a *computed*
  validator (`votes: false`, excluded from the panel) and vote when a licensed feed is injected; price is
  never relabelled as sentiment, fundamentals or on-chain data; a wick beyond a swing never confirms a
  break of structure; and the debate can only reduce confidence.
- **One table, one migration, and no *engine* configuration.** `wf_analysis_runs` (migration `005`) stores
  the summary columns, `synthetic`/`source` promoted out of the payload so a query can find every run built
  on labelled synthetic data, and the full run as the audit copy. The repository contract grows
  **32 → 35** methods as delivered, then **35 → 36** with the hardening pass (`pruneAnalysisRuns`). The
  engine adds **no environment variable** — agent weights, thresholds and risk limits stay code constants,
  because they are safety parameters, not deployment knobs — but the hardening pass added **six operational
  ones** (R-26 limits, R-27 retention), so `.env.example` goes **53 → 59**. See the hardening subsection
  below, which supersedes both figures here.
- **Six defects found and closed while porting** (`PHASE5_ANALYSIS.md` §6), including a JS
  operator-precedence bug in the open-risk reduction, body schemas written in the query dialect (which made
  the run route answer `400` *before* authentication), the engine's injectable clock not reaching the feed
  agents' freshness check, a hard store requirement that broke the documented store-less boot, and a
  position-based audit assertion that was a latent flake in the test itself.

Measured in this sandbox on 2026-10-09: **257** app tests passing (**+117** for Phase 5 and its hardening
pass, across `test/analysis.test.js`, `test/analysis_http.test.js` and the new `test/retention.test.js`,
which port **36 of the 38** legacy cases in `01-indicators`, `03-agents`, `04-risk-engine`,
`34-agent-debate` and `08-engine-journal` — the two it does not are the backtester and journal-analytics
cases, which belong to unported modules), **30/30** install checks, **367** legacy PHP/WASM oracle tests,
**12** Scout contract tests, **29** football-prediction tests and a clean `npm run typecheck`:
**665 passed, 0 failed** (`node:test` cases; 257 + 367 + 12 + 29). The suite is hermetic — **257/257 with
and without** a whole-suite egress interceptor, which reports *"no outbound requests attempted"* for all 16
files. As delivered, before the hardening pass in §13 of `PHASE5_ANALYSIS.md`, these figures were 235 app
tests and 643 total. No client *source* changed, but the rebuilt bundle hash moved
(`index-Ci3bygYZ.js` → `index-DSbqgd7N.js`, 78 bytes smaller) purely because dependencies were re-installed
without a lockfile — the build is deterministic for a given `node_modules`, just not reproducible from the
repository alone. That is **F-12/R-04** observed in the wild, and it is recorded in
`PHASE5_ANALYSIS.md` §9.1 rather than papered over as "unchanged".
**Not** exercised: any live upstream data (no egress; every run here is labelled synthetic or comes from an
injected double), a value-for-value PHP↔Node numeric diff (**F-26**, still a cutover prerequisite), real
MySQL, the risk engine's approve path over HTTP (unit-tested only, unreachable by design), any portfolio
state, an analysis user interface, or any cutover.

### Phase 5 hardening pass (0.6.0 → 0.6.1) — F-27, R-26 and R-27 closed

Phase 5 opened three findings about itself, and the instruction was to close all three **before** porting
another module. It added no route, no module and no dependency: **+2 056 / −139 lines across 27 files**
(git-measured; code 18 files, docs 9). Every one of its five commits was verified green on its own tree
state in a separate worktree — **235 → 242 → 256 → 257 → 257** — so the branch stays bisectable.

* **F-27 closed in Node, recorded as divergence DV-10.** The legacy risk engine approves a proposal when
  equity is `0`, because every portfolio gate sits behind `equity > 0` and the notional and leverage checks
  then clear trivially. The Node engine now vetoes zero, negative and non-finite equity before sizing, and
  the test that pinned the legacy approval was **inverted** rather than deleted — it now covers all three
  cases plus a positive-equity control that must not trip the veto. **The legacy PHP is untouched**, so the
  oracle is still 367/367 and the two engines disagree on purpose until cutover; no legacy case exercises
  it (`04-risk-engine` uses equity 100 and 10 000), so the 36-of-38 parity is unchanged.
* **R-26 closed.** Per-route window limits on both POST routes (12 runs / 4 scans per 10 minutes per
  address, charged *before* validation so a malformed body still costs budget) plus a per-session
  in-flight cap (`createAnalysisRunGate`, default 2, `0` disables, released in `finally`). Keyed by
  **session**, not address, so a shared office NAT cannot let one colleague's scan starve another's.
  `429 TOO_MANY_CONCURRENT_ANALYSES` is deliberately distinct from `RATE_LIMITED`, because the remedy
  differs. Worst case per window: **≤ 416** upstream series instead of 120 requests/min × 80 calls.
* **R-27 closed.** `ANALYSIS_RETENTION_DAYS` (default 90, `0` keeps forever) plus
  `tools/prune-analysis-runs.mjs` / `npm run prune:analysis`, backed by `pruneAnalysisRuns` on both
  adapters — repository contract **35 → 36**. Dry run is the default and reports the matching count, the
  oldest and newest affected timestamps and the reclaimable bytes before deleting anything; MySQL deletes
  in clamped, `ORDER BY`-deterministic batches for a shared host. **No HTTP route can delete analysis
  history**, pinned by a test.
* **F-28 found and fixed on the way (🟠).** Implementing retention meant an operator had to be able to
  prove row counts around a prune, which exposed `tools/backup.mjs`: its MySQL counts came from a
  hardcoded list that omitted `wf_contact_inquiries`, `wf_data_imports` and `wf_analysis_runs`, and counted
  **`wf_user_files` — a table nothing in this repository creates** (avatars live in
  `wf_user_profiles.profile_image`). On MySQL that made `npm run backup` **fail outright** with
  `ER_NO_SUCH_TABLE`. No test caught it, because the backup suite drives the file adapter only. The list is
  now derived from `src/db/migrations/*.sql`, so the drift is impossible by construction.
* Six new env vars (`.env.example` **53 → 59**), all operational; the engine's safety parameters remain
  code constants. `verify:install` still **30/30**.

Full detail, including what the pass deliberately did **not** do (no PHP diff, no real MySQL, no cron
entry on any host, no load test — this sandbox has no egress, so any throughput figure would have been
invented): `PHASE5_ANALYSIS.md` §13.

## Phase 1 implementation snapshot — foundation only (historical)

`apps/workforce-platform/` now contains:

- **Node.js `>=22.20.0 <25`** and a top-level `server.js` using Node's `http` module. The internal router, bounded JSON parser, static allow-list, security headers, request IDs, request timeouts, generic errors, rate limits and graceful shutdown are implemented with core modules and local project code. Fastify, Express and Fastify plugins are not runtime dependencies of this server.
- **MySQL identity foundation:** the existing bounded `mysql2` pool, checksum-versioned migrations, isolated `wf_*` identity/session/RBAC/audit tables, and dry-run-first one-time identity importer are retained. The importer has **not** been run against production or source user data.
- **Authentication/security slice:** username/email/6-digit-UID login compatible with PHP bcrypt hashes, opaque hashed server-side sessions, host-only `HttpOnly`/`Secure` production cookies, session rotation, session-bound CSRF, audit events and deny-by-default permission checks.
- **Vanilla public site:** 8 semantic server-rendered pages plus `robots.txt`, `sitemap.xml`, `manifest.webmanifest` and `service-worker.js`, all generated per request from validated `SITE_*` config — no React hydration, no third-party runtime asset calls, no inline script or style, and no committed static copy of any generated document.
- **React/Vite SPA:** source in `client/`, built and served under `/app/`. Sign-in, registration, workspace overview, account management, admin user directory, the contact inbox and the platform-status view, behind an exact-path router with permission-gated navigation and loading/empty/error/offline states; non-ported product domains are plainly marked as not yet migrated.
- **PWA shell:** generated manifest with a real PNG icon set (including a maskable 512) and a generated service worker whose cache name is derived from the shell's content hash. Hashed build assets are cache-first, the unhashed shell is not, and `/api/`, `/uploads/`, `/private/`, `/data/`, the worker itself and the contact form bypass caching entirely. Update flow offers Reload / Not now instead of swapping silently. Offline writes and sensitive-operation queuing are not implemented; no real browser has been used to observe an install prompt.
- **Capacitor wrapper:** Android/iOS project configuration and HTTPS API-origin validation. Native sign-in is intentionally disabled: a native token/refresh/revocation contract, API-origin policy and audited Keychain/Android Keystore storage plugin still need design and tests. Native SDK builds, signing and store releases have not been verified.
- **Separate dependency boundary:** the server package has `mysql2` and `bcryptjs` as its production dependencies. React/Vite and Capacitor dependencies live in their own client/native packages and are build-time/native dependencies; they are not loaded by the HTTP server.

This paragraph records the Phase 1 foundation snapshot, not the current feature set. Phases 2–7 subsequently added identity/public-site work, market data, analysis, strategies and paper-risk APIs; their dated records are linked above. The production boundaries remain: no real MySQL integration test, import rehearsal, cPanel/Passenger host validation, live provider/broker validation or traffic cutover has been performed. The PHP application remains intact as the source of truth and rollback target.

## Migration inputs still to consolidate

- `application/`: PHP/CodeIgniter platform; authoritative and preserved as rollback target.
- `apps/api/` + `apps/web/` + `packages/shared/`: Scout, currently Fastify/TypeScript + Next.js/TypeScript and PostgreSQL/Redis; requires a deliberate MySQL persistence and product/API parity migration.
- `apps/football-predictions/`: independent Express/JavaScript/MySQL app with its own auth, migrations and tests; not yet consolidated or first-run deployment-verified.
- `python-services/mt5-bridge/`: Python/FastAPI and Windows-only MetaTrader dependency; remains an explicit adapter/migration decision until safely replaced and tested.
- `runtime/`: PHP-WASM developer/test runtime; not part of the production Node target.

## Phase 6 — Strategy Lab, backtesting, lifecycle gates and confidence calibration (2026-10-10, branch `arena/774d9e70-ai`)

Row 8 of [`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md) and item 3 in the master plan's
module order. Six code commits plus this record, `b3c5d35..HEAD`, 30 files, **+10 124 −16**.
Full record: [`PHASE6_STRATEGIES.md`](PHASE6_STRATEGIES.md). App version is now **0.7.0**.

Ported: `SeriesView.php`, `BuiltinStrategies.php`, `Metrics.php`, `Backtester.php`,
`StrategyOptimizer.php`, `StrategyRegistry.php`, `Journal/Analytics.php` and the
`Api_strategies`/`Api_journal` controllers. **Eleven** endpoints under `/api/v1/strategies`,
`/api/v1/backtesting` and `/api/v1/journal` (platform route count 38 → 49), persisted in
three new tables from migration `006` (platform tables 12 → 15, repository contract
36 → 46 methods, file-store entities 10 → 13).

It imports the Phase 4/5 primitives rather than reimplementing them — indicators, `roundTo`,
`timeframeMs`, `seededRandom`, the provider-failure mapping, and deliberately the
`inferMarketClass` that knows `XAUUSD` is a commodity, because the market-data one would
fetch the wrong series for gold.

The mechanics that make a backtest evidence rather than fiction are all carried over: signals
fill at the **next** bar's open, half-spread plus slippage move every fill, fees are charged
both ways, a bar touching both stop and target resolves to the stop, an entry bar can stop out
immediately, and reading a future bar throws `LookAheadError` which **escapes** the run rather
than being recorded as a warning. Cost control is applied at birth rather than discovered
later as R-26 was: an optimization re-runs the backtester ~50 times, so it gets a 2/10-minute
window and a per-session in-flight cap of **1** — lower than the analysis module's 2, because
one strategy slot holds about fifty times the work.

**Eleven divergences** (DV-1…DV-11) are recorded in §5 of the phase record. The two that
matter most: legacy `iso()` emits `2025-08-12T12:00:00Z.123Z`, which is an **Invalid Date** in
JavaScript and is rejected by this repo's own `assertIsoCutoff`, so Node emits well-formed
ISO-8601 (DV-1); and legacy `transition()` returns a hardcoded empty `warnings` array on
success, discarding the advisories its own gates compute at exactly the moment a strategy is
promoted (DV-3).

At the Phase-6 boundary, the AI human-sign-off path was a reported gap. Phase 7
closed that specific gap with a separately permissioned, persisted one-time sign-off;
`source: "ai"` is preserved, and sign-off does not advance lifecycle by itself. See
[`PHASE7_PAPER_TRADING.md`](PHASE7_PAPER_TRADING.md). **F-29** remains: the four legacy
document routes and `views/strategy/index.php` are unported. **R-28** remains open:
`wf_backtests` grows without bound, and deleting evidence needs a separate retention
decision.

Measured in this sandbox on 2026-10-10: app suite **428/428** (**+171**), `tsc --noEmit`
clean, `verify-install --require-bundle` **30/30** with **64** documented environment
variables, and the legacy PHP oracle still **367/367** with `application/`, `system/` and
`tests/` verifiably untouched. No MySQL server exists here, so migration 006, every statement
in `strategy-repository.js` and the MySQL branch of `verify-data.mjs` are pinned on SQL text
and bound values through a recording fake pool and were **never executed** (F-15, unchanged).
Every backtest in every test ran on synthetic candles and asserts that it did.

## Next phases and acceptance gates

1. **Validate the current Node database work on real MySQL/MariaDB.** Execute migrations 001–008 and test repository locking/transactions, backup/restore and integrity checks against the supported server version. Static SQL parsing and recording fake pools are not substitutes.
2. **Rehearse cPanel/Passenger deployment and rollback.** Confirm Node version, proxy behavior, quotas, cron policy, DB settings, clean packaging, health/readiness, backups, logs and rollback on the actual target host. No cPanel rehearsal has occurred.
3. **Keep live execution separate.** Phase 8A adds only owner-scoped, human-reviewed paper proposals; the broader Execution Supervisor and Broker Center remain incomplete. Reconcile the PHP flow instead of assuming a fixed step count. Add bypass/recovery tests and demo-terminal validation before considering live capability; Node has no broker route.
4. **Finish shared UI and other product modules** as ordered in [`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md): notifications/audit/settings, domain consoles, public chat, password-reset delivery, outbound mail, portfolio optimization and the remaining product surfaces.
5. **Compare behavior to PHP before any parity claim.** Produce value-for-value fixtures for critical numeric and lifecycle behavior; record DV-10 (Node refuses non-positive/non-finite equity while legacy PHP approves) as an intentional difference, not a parity defect to erase.
6. Consolidate Scout, Football Predictions and the MT5 bridge only after their separate storage/runtime assumptions are mapped and tested.
7. Keep PHP authoritative through full data import, checksum reconciliation, backup/restore, a stability window and explicit human cutover approval.

See [`FULL_STACK_ARCHITECTURE_PROPOSAL.md`](FULL_STACK_ARCHITECTURE_PROPOSAL.md) for the target boundaries and [`IDENTITY_IMPORT.md`](IDENTITY_IMPORT.md) for the one-time importer contract and dry-run/apply procedure.

## Foundation test evidence — 2026-10-06 snapshot (historical)

- Node HTTP/auth/database-contract suite: **43 passed, 0 failed** (`npm run check:workforce`). These use deterministic test stores; they do not prove real MySQL behavior.
- React/Vite production build: **passed** (`npm run build:workforce-client` and clean nested `npm ci`). Build output under `apps/workforce-platform/public/app/` is generated and ignored.
- Scout contracts: **12 passed**; TypeScript typecheck clean. Football Predictions: **29 passed**. Existing PHP/WASM suite: **367 passed**.
- Capacitor CLI config validation: **passed**; no Android/iOS platform build or signing was run.
- Live local HTTP smoke check: public site, PWA manifest/service worker, SPA deep link and built JS/CSS assets returned **200**; a missing JS asset returned **404**; liveness returned **200** and readiness returned **503** without MySQL.
- Node version in the sandbox: **v22.22.3**. The configured engine range is `>=22.20.0 <25`.
- Earlier root `npm audit` output reported **10 vulnerabilities (9 high, 1 critical)**; that finding has not been rechecked or addressed in this implementation slice.

No real MySQL server, production data migration, live provider, production broker, native SDK, signed app or cPanel host was exercised. The broader repository suites should continue to run in CI; this foundation does not replace their evidence.
