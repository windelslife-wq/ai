# Phase 19 — Sports Intelligence: the measured half (row 14, slice 5 of 5)

> **Status: slice 5 landed on `arena/653d6218-ai`. All five slices of row 14 are now ported.** This
> record covers ticket settlement, result verification, calibration **fitting**, the point-in-time
> backtester, the model drift monitor and measured performance analytics. It does **not** cover the
> `SportsCronService` (row 19), stake sizing, or console screens (F-29). The previous record is
> [`PHASE18_SPORTS_TICKETS.md`](PHASE18_SPORTS_TICKETS.md).

## 1. What this slice is

Slice 4 proposed tickets and a person approved them. Slice 5 is the half that **closes the book**:
a stored provider result is attested by a person (`verified`), a ticket is settled **only** from a
verified result, the platform's own settled outcomes fit a calibration (stored `PENDING` until an
administrator approves it), history is replayed point-in-time by the backtester, the drift monitor
compares a recent window against its baseline and publishes `SPORTS_MODEL_DRIFT` (which closes
**NV-6** — the last declared notification type gains a publisher), and performance analytics
measure tickets, selections and predictions from stored records.

The honesty boundary does not move. Settlement closes existing records; it does not approve new
ones — the ticket-decision route keeps its own kill-switch gate, and the settle routes deliberately
do not sit behind it (routes comment in `routes.js`). Nothing is executed, no stake is sized, and
no stored result is trusted before a person attests to it.

## 2. What was ported

| Legacy (PHP, read-only) | Node | Notes |
|---|---|---|
| `Aegis\Sports\ResultVerificationEngine` | `src/modules/sports/result-verification.js` | `verifyResult` and `settleSelection`, ported as written; `verifiedAt` stamped from the injectable clock. |
| `Aegis\Sports\TicketSettlementService` | `src/modules/sports/settlement.js` | `verifyStoredResult` (the `PersistedResultVerifier` port: attests a stored row), `applyStoredResult`, `applyVerifiedResult`, `settlePending`, `finalizeTicket`. `RESTITUTE_ODDS` by default; the ALL_VOID_ONLY asymmetry ported as written; Q-4's reason overwrite preserved. |
| `Aegis\Sports\SportsBacktester` | `src/modules/sports/backtester.js` | `runBacktest`: strict point-in-time replay (odds `observed_at` before kickoff, quality re-assessed at the historical moment, `SCHEDULED` replay shape), report flagged `simulation: true` with the legacy warning, rows capped at 500, range capped at 90 days. |
| `Aegis\Sports\ModelDriftMonitor` | `src/modules/sports/drift.js` | `monitor()` with legacy's windows (14/28), thresholds and reason strings, `INSUFFICIENT_RECENT_DATA` under 20 samples; publishes `SPORTS_MODEL_DRIFT` deduped once per model per UTC day. |
| `Aegis\Sports\PerformanceAnalytics` | `src/modules/sports/performance-analytics.js` | `performanceReport` (pure) and `summarizeTickets` (the deprecated path, kept). |
| `Aegis\Sports\ModelPerformanceService` | `src/modules/sports/intelligence-service.js` | `modelPerformance`: the measured window (`outcomesAvailable: true` — an empty history is a measurement of nothing, not a refusal), per-model `comparison[]` (legacy's `compare`), ticket metrics with legacy's shared-leg stake allocation. |
| `Api_sports` slice-5 routes | `src/modules/sports/routes.js` | Nine routes (§4). |

Calibration **fitting** (`CalibrationEngine::fit` was ported and parity-tested in slice 3) is now
*driven*: `fitCalibration` reads the platform's settled outcomes, refuses with 422
`CALIBRATION_CANNOT_BE_FITTED` (naming the reason and the sample size) when the settled sample is
short or one-sided, and stores a `PENDING` calibration with the audited `sports.calibration.fitted`
event. `calibrationInput` now carries `method ?? null` — an `identity` calibration measures the raw
probability (DV-19), everything else runs the logistic map (DV-12); method-less inputs keep the
pre-slice-5 behaviour.

## 3. Findings

### F-41 — `createStore` listed sports methods by hand, and the list went stale

`createStore` (`src/db/store.js`) spreads the platform repositories but lists the sports methods
**explicitly**, "so the boundary is stated instead of implied". Slice 4's four settlement updates
and all nine slice-5 methods were never added, so the MySQL adapter failed
`assertRepositoryContract` at boot while the file adapter (which derives its methods from the row
mappers) passed. The boot test caught it before any commit. Fixed by listing the thirteen methods
with their boundary comments. The standing risk is the pattern itself: an explicit list next to a
contract pin is what made F-02's count go stale once before, which is why `REPOSITORY_METHODS` is
asserted in three test files, not one.

### F-42 — the port's drift reason string dropped legacy's parentheses (parity found it)

`ModelDriftMonitor` builds a human-readable reason with
`sprintf('accuracy dropped %.1fpp (%.1f%% → %.1f%%)')`. The port's template omitted the parentheses
around the percentages. Nothing in the Node-only tests could see it — the string was never pinned —
but the new differential harness compares PHP's reason strings character by character, and the very
first golden run failed on it. Fixed to byte-identical; the parity test now pins the format.

### Q-4 (carried, recorded) — the settlement reason overwrite

`finalizeTicket` writes `reason: 'waiting on unverified results'` while a ticket is `PENDING` and
`NULL` once decided — overwriting an approval rejection's reason, as legacy does. The port keeps
it as written; the decision trail stays in the audit log.

## 4. The surface

### Repository

Thirteen methods added to the shared contract, which grows from 129 to **142**:

- `SPORTS_TICKET_METHODS` 9 → **13**: `updateSportsTicket`, `updateSportsTicketSelection`,
  `recordSportsTicketOutcome`, `recoverSportsDailyTicketRuns` — the writes settlement applies and
  the stuck-run release.
- Two attestation methods in the sports foundation block: `verifySportsResult` and
  `findSportsResultByMatch`. `verifySportsResult` was deliberately absent before this slice; it now
  exists, but the ingest writes and the attesting write stay **distinct names on one repository** —
  nothing lets a sync attest to its own result.
- `SPORTS_ANALYTICS_METHODS` (**7**): `listSportsPredictionOutcomes`,
  `listSportsSettledSelections`, `saveSportsModelMetrics`, `listSportsModelMetrics`,
  `saveSportsBacktest`, `findSportsBacktest`, `listSportsBacktests`.

Both adapters implement all thirteen (`src/db/sports-analytics-repository.js`,
`src/persistence/sports-rows.js`). `listSportsPredictionOutcomes` is the honesty mechanism: a
prediction joined to its match and to a **VERIFIED, FINISHED** result — a prediction whose result is
unverified has no outcome, and nothing downstream invents one.

### Routes

Nine routes, the sports surface 25 → **34**, the total 106 → **115**. Reads are `sports.view`; the
backtest, drift and recovery runs are `sports.manage`; and the two attestation writes are
`sports.settle`, the distinct permission legacy itself gates them with — a `sports.manage` grant
must not be able to attest.

| Route | Permission | Purpose |
|---|---|---|
| `GET /api/v1/sports/results` | `sports.view` | Finished fixtures with their best stored result and attestation state. |
| `POST /api/v1/sports/results/verify` | `sports.settle` | Attest one stored result. 409 `RESULT_NOT_VERIFIABLE` on a bad shape. |
| `POST /api/v1/sports/tickets/:ticketId/settle` | `sports.settle` | Settle one ticket (one match via body, or the `PENDING` sweep). Idempotent. |
| `GET /api/v1/sports/performance` | `sports.view` | The measured report; `dataAvailable: false` on an empty history. |
| `POST /api/v1/sports/backtests/run` | `sports.manage` | One point-in-time replay, stored flagged `simulation`. |
| `GET /api/v1/sports/backtests` | `sports.view` | Summaries only — no report bodies. |
| `GET /api/v1/sports/backtests/:backtestId` | `sports.view` | The whole stored run. |
| `POST /api/v1/sports/models/drift/run` | `sports.manage` | Run the monitor now (the cron is row 19); publishes `SPORTS_MODEL_DRIFT`. |
| `POST /api/v1/sports/daily-tickets/recover` | `sports.manage` | **R-29 closed.** Deletes RUNNING claims for one day, reports their counters, audits each release (`sports.daily_ticket.recovered`). 503 without a store. |

## 5. Migration 014

Two tables, taking the schema to **40**: `wf_sports_backtests` (id, created_at, created_by, params,
report, status) and `wf_sports_model_metrics` (model_version_id, window_days, sample_type,
predictions, settled, accuracy, brier, ece, win_rate, roi, max_drawdown, computed_at). The drift
monitor writes `sample_type: 'drift'` rows; legacy's `'live'` snapshot writer lives in
`ModelPerformanceService::metricsFor`, which this port measures **without persisting** — a
`performance_snapshots` writer is row-19 scope, and a table with no writer must not exist
(`SPORTS_NOT_PORTED`, "scheduled jobs").

## 6. Divergences

Numbering continues from Phase 18 (DV-23) and SP-34.

| ID | Divergence | Kind | Why |
|---|---|---|---|
| **SP-35** | `verifyResult` accepts an integral score that arrived as a float (`2.0`) | Recorded, unavoidable in JS | PHP's `is_int(2.0)` is false, so PHP refuses. JSON has erased the distinction before the port can see it — `JSON.parse("2.0")` IS `2` — and every platform caller coerces the stored column with `Number(...)` before the check, as legacy coerces with `(int)`. The golden case stays as evidence of what PHP does. |
| **DV-19/DV-12 (extended)** | `calibrationInput` carries `method` | Extension, documented | An `identity` calibration measures the raw probability (DV-19); the logistic map stays the default (DV-12); a method-less input keeps the pre-slice-5 behaviour. The backtest identity replay is unaffected: legacy's linear form and the port's logistic map are the same function at intercept 0 / slope 1. |
| **Preserved quirks** | `predictionOutcomes` narrows to `OVER_1_5`/`UNDER_1_5`; `settledSelections` shares a ticket's stake and P/L equally across ALL its legs, settled or not, so shared predictions double-count; accuracy everywhere prefers `calibrated_probability` with a raw fallback, so a window spanning a calibration change mixes mappings | Ported as written | These are legacy's denominators. Changing them would change every measured number relative to the system being migrated. |

Two behaviours that are not divergences, but a reader must know:

- **Settlement is deliberately not kill-switch-blocked.** Settling existing records closes the book
  while new approvals wait; the ticket-decision route keeps its own gate.
- **The port measures without snapshotting.** Legacy's `metricsFor` writes a `'live'` metrics row as
  a side effect of a read; the port's read writes nothing (§5).

## 7. The differential harness

`runtime/parity/sports-settlement-golden.php` holds eight groups, included by
`runtime/parity/sports-golden.php` as `cases.slice5`: `verify` (14), `settleSelection` (11),
`settlement` (18 scenarios), `performance` (6), `drift` (5 scenarios + constants), `metricsFor`
(1), `backtestRefusals` (6) and `backtestRun` (1 full replay). Slices 3 and 4 could confine
themselves to pure engines; slice 5's engines are repository-bound, so the generator drives each
**real legacy class over a scripted fake repository** — an array-backed implementation of the real
`Aegis\Persistence\SportsRepository` interface that records every write — and the Node test drives
the port over an equally scripted store, reading the scenario from the golden file itself.

`test/sports_analytics_parity.test.js` checks the groups in **10 tests**, with the slice-3 test's
three assertion kinds. Two spots deserve their name:

- **The full identity replay.** No approved calibration, so legacy's linear form and the port's
  logistic map are the same function — DV-12 does not bite and the whole report is compared exact,
  F-36 aside (below). It exercises quality re-assessment, the point-in-time gate, P/L, drawdown,
  groups, `overTime` and what each side stores.
- **F-36 evidence, four times.** PHP casts each squared error to int inside
  `CalibrationEngine::evaluate`, so PHP's Brier is always 0.0 — in the drift windows, the
  performance report, `metricsFor` and the backtest report. Each occurrence asserts the golden
  value IS 0.0 and the port's is the real score, then compares the rest. A legacy fix would fail
  these tests loudly instead of being silently absorbed.

The regenerated golden adds `cases.slice5` and nothing else: **4,757 insertions and zero
deletions**, and two consecutive regenerations hash identically. Two generator defects were found
and fixed on the way, both of them the harness's own honesty, not the platform's: a PHP 7-ism
(`[$a, ...$rest] = $arr` spread destructuring is not valid PHP) and a saved backtest's
`json_encode`d report carrying `generatedAt` inside the string, which made the golden
non-deterministic between runs.

## 8. What this slice does not claim

- **Nothing is executed.** Settlement settles records; approval is a record; the kill switch on
  approvals is untouched.
- **No stake is sized.** The backtest's `stake` is a parameter. `SPORTS_NOT_PORTED` keeps "stake
  sizing".
- **No stored result is trusted before a person attests to it.** On a fresh host there are no
  verified results, so there is no settlement, no fit, no measured outcome — every measured read
  reports an empty history (`dataAvailable: false`, `outcomesAvailable: true`), never a number.
- **No provider has been verified against a real vendor.** The sandbox remains the only provider
  the tests exercise, and sandbox data never reaches a ticket (DV-20).
- **No MySQL was exercised** (F-15). The MySQL paths are proven against scripted connections and a
  recording executor; migration 014 is **not applied to any database**.
- **No cron.** `SportsCronService` (255 lines) is row 19. The drift run, the daily run and the
  recovery are operator actions over HTTP.
- **Nothing is deployed.** Version bumped to **0.16.0** for the schema and contract growth; no
  release was cut.

## 9. Decisions

**Carried and unchanged:** DV-20 (simulated candidates refused for tickets), DV-23 (a throwing run
stored `NO_QUALIFIED_TICKET`), `ticketEngine` reports `ON_REQUEST`, F-39 kept as documented.

**Still open for the user, unchanged from PHASE18 §9:**

1. **DV-21** — the daily run reads stored fixtures and odds and never fetches. Acceptable?
2. **DV-22** — the engine never marks a ticket approved, and the automated branch is absent.
   Confirm.
3. **Sandbox qualification, globally** (PHASE17 §9) — should a sandbox `QUALIFIED` decision be
   refused everywhere, not only for tickets?
4. **Calibration approval policy.** Fitting is now real, so an administrator *will* find PENDING
   calibrations to approve. Who approves, and is a fit on SANDBOX-settled outcomes ever approvable?
   (A sandbox-only host fits on simulated outcomes; the rows are labelled, but an approval is a
   platform-wide act.)
5. **Phase 16 golden count** (124 in its record, 134 in its golden sections). Not reconciled.

## 10. Gates

Measured in `apps/workforce-platform` on this branch, on 2026-10-12, Node v22.22.3.

| Gate | Result |
|---|---|
| `npm test` (run by `npm run check`) | **885 / 885** across **52** files (was 875 / 875 across 51). The 10 new tests are `sports_analytics_parity` |
| `npm run check` | **exit 0**. `verify:install` **29 / 29**; **76** documented variables |
| PHP oracle (`node runtime/run-tests.mjs`) | **367 / 367** |
| Legacy tree | `git status --porcelain application/ system/ tests/` is **empty** |
| Routes | **115** total (was 106); **34** sports (was 25) |
| Contract | **142** repository methods (was 129); **56** sports (was 43) |
| Schema | **40** tables (was 38); migrations **001–014** |
| Golden | `cases.slice5` added, **4,757 insertions and zero deletions**; two consecutive regenerations hash identically |
| Version | **0.16.0** (was 0.15.0) |

Test pins updated for the new counts: the retention and Strategy-Lab contract pins (142, two
files), the backup table map (40, with the two slice-5 tables and their MySQL counterparts), the
migration list (014), the platform findings F-01 contract pin (142, with the nine new methods
named) and F-02 label pin (the rewritten sports ledger label), the sports store pins (56, and the
ticket repository's thirteen names), the MySQL intelligence pin (56), the sports route inventory
(34 routes, 13 writes, the two `sports.settle` attestations named), the boundary test (which now
asserts what slice 5 legalises instead of what it forbids), the not-ported matrix (3), and the
calibration-fit refusal (`CALIBRATION_CANNOT_BE_FITTED`, with its reason and sample count).

**Not run:** a real MySQL server, and migration 014 against any database.

## 11. Ledger

`sports` stays **partial**, and its label is rewritten to carry the slice-5 boundary: the module
now verifies, settles, fits, backtests, monitors drift and measures — and what keeps it partial is
that nothing is executed, no stake is sized, no stored result is trusted before a person attests to
it, no provider is verified against a vendor, and there is no cron and no console screen.
`SPORTS_NOT_PORTED` shrinks 6 → **3** (stake sizing; the sports cron, row 19; the console screens,
F-29) — entries that became untrue were removed, not re-labelled. **NV-6 is closed**: every
declared notification type now has a publisher.

## 12. Open items and risks

- **Row 19 (the sports cron).** `SportsCronService` (255 lines) would own the sync, the daily
  ticket, the settlement sweep and the drift run; the `performance_snapshots` table has no writer
  until then.
- **R-30, the file adapter is not atomic for tickets.** The recovery route releases the stuck runs
  (R-29), but only the MySQL adapter settles whole tickets transactionally.
- **F-15.** No real MySQL: migrations 011–014, the repository transactions and the backup/restore
  path remain unvalidated against a server, and none of this is deployed anywhere.
- **PHASE18 §9 items** (§9 above) remain user decisions, not silent defaults.
- **Row 22** owns the legacy-side open findings (F-32 reads) at cutover.
