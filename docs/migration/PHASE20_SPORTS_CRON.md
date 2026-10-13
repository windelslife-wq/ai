# Phase 20 — Sports Intelligence: the cron (row 19)

> **Status: landed on `arena/653d6218-ai`.** This record covers the `SportsCronService` port — nine
> scheduled jobs on window locks, CLI-only — and the performance-snapshot writer (migration **015**),
> the table slice 5's migration deliberately refused to create early. It does **not** cover stake
> sizing (no slice owns it) or the console screens (F-29, platform-wide). *Forward pointer: Phase 28
> ported both console screens to `/app/sports`; F-29 now names the market-data, analysis and Strategy
> Lab consoles instead.* The previous record is
> [`PHASE19_SPORTS_MEASURED_HALF.md`](PHASE19_SPORTS_MEASURED_HALF.md).

## 1. What this phase is

Legacy ran its sports jobs from `php index.php tools sports-cron [job]` — `SportsCronService`, 255
lines, nine jobs in one fixed order: fixtures, odds and results syncs; the data-quality
recalculation; the daily ticket; the settlement sweep; the performance snapshotter; provider-health
and drift monitoring; and the 90-day retention cleanup. Slice 5 ported everything the jobs are made
*of*; this phase ports the thing that *runs* them, and the one table only a cron would write
(`wf_sports_performance_snapshots` — one measured report per UTC hour per legacy window).

The honesty boundary moves not at all: a scheduled job inherits the boundary of every service it
drives. The sync jobs call configured providers only (a default host registers none and reports
`SKIPPED`); the quality job's reliability comes from stored observations, never a live probe (the
cron-side extension of SP-10, §6.2); the ticket job is the same `runDaily` the HTTP route uses
(DV-20/21/23 inherit whole); the sweep settles records only; and a snapshot is a measured report
over attested records, labelled by the report itself. And the cron is **CLI-only** — there is no
HTTP route, and the `scheduledJobs` health label now says so (`tools/sports-jobs.mjs`,
`npm run sports:jobs`).

## 2. What was ported

| Legacy (PHP, read-only) | Node | Notes |
|---|---|---|
| `Aegis\Sports\SportsCronService` | `src/modules/sports/cron.js` | `createSportsCronService({sports, store, now, actorId})` → `{runAll, run, jobs}`. Nine jobs in legacy's `JOBS` order; `runAll` isolates one job's failure and closes with legacy's sweep audit; `run` refuses unknown names with legacy's message. |
| `wf_sports_performance_snapshots` (schema) | `src/db/migrations/015_sports_snapshots.sql` | One table, `UNIQUE (as_of, window)`, §5. |
| Snapshot repository methods | `src/db/sports-analytics-repository.js` | `saveSportsPerformanceSnapshot` (upsert: `ON DUPLICATE KEY UPDATE payload = VALUES(payload)`) and `listSportsPerformanceSnapshots` (read cap 366). Contract 142 → **144**; sports 56 → **58**. |
| — | `tools/sports-jobs.mjs` | The CLI the host's crontab calls; §4. |

Both adapters gained the snapshot pair (the file store's entity `sportsPerformanceSnapshots`,
keyed `as_of|window`, upsert-replacing), and both ticket adapters gained an additive `status`
filter on `listSportsTickets` — the `PENDING` filter the settlement sweep selects on.

## 3. Findings

### F-43 — a shadowed import made `GET /api/v1/sports/performance` hang forever

`service.js` defined a closure named `performanceReport` while also importing the pure function of
the same name from `performance-analytics.js`. The closure shadowed the import, so the report
assembler called **itself** — infinite async recursion, and the route hung until the client gave
up. No test could see it: the parity test imports the pure function directly, so the route was
never exercised end to end. Fixed with an aliased import (`performanceReport as
computePerformanceReport`); the assembler's comment cites F-43, and the alias must not be
"cleaned up" back into the shadow.

### F-44 — the CLI parsed `--now` and then ignored it

The original draft of `tools/sports-jobs.mjs` parsed `--now`, returned it as `timestamp` in the
report — and ran every job on the wall clock. The new CLI test pinned the cleanup cutoff at the
requested instant and caught it: `--now` decorated the report instead of driving the clock. Fixed:
the tool builds its clock-pinned cron through the **same factory** over the **same** service graph
and store, so it stays one wiring. The lesson is the same one F-41 taught: a report that *says* a
thing happened is not evidence that it did.

### DV-24 (found) — legacy's `run()` never routes `cleanup`

Legacy's `JOBS` list names `cleanup`, `jobCleanup()` exists and is documented — but `run()`'s
`match` has **no `'cleanup'` arm**, so every legacy `runAll` ends with `cleanup: FAILED` and a
spurious `SPORTS_JOB_FAILED` audit event, every day, forever. The port routes the job its own class
defines (the switch arm is marked DV-24) and `test/sports_cron.test.js` pins the pin: if the arm is
ever dropped, the test fails exactly the way legacy's operators watched it fail. **Pending user
confirmation** (§9) because it changes operator-visible behavior: the port's `runAll` reports a
`COMPLETED` cleanup where legacy reported `FAILED`.

### DV-25 (found) — legacy's fixtures summary is a lie by construction

Legacy's `jobFixtures` passes "no providers configured; nothing synchronized (nothing fabricated)"
as its summary **unconditionally** — so on a day three providers synced, the audit reads "no
providers configured". The port emits the sentence only when it is true, and otherwise says
"`N` provider(s) synced". **Pending user confirmation** (§9).

## 4. The surface

- **`node tools/sports-jobs.mjs`** — runs all nine jobs for today; `--job NAME` one job;
  `--date YYYY-MM-DD`; `--json` one document on stdout; `--now ISO` a fixed clock (F-44).
  Exit **0** when every job `COMPLETED` — and when it was `DUPLICATE_SKIPPED`/`SKIPPED`, because
  both are facts about the schedule, not failures; exit **1** when any job `FAILED` or the run was
  refused. A cron that exits 0 while a job is broken is how a job stops running and nobody notices
  for a month. The header documents the crontab line (absolute `node` path, `cd` first —
  `loadConfig` resolves relative storage paths against the working directory).
- **No dry run, deliberately** — unlike `tools/scheduled-jobs.mjs`: legacy's sports jobs have no
  measure-only form (a sync either fetches or does not), so the idempotency keys *are* the safety,
  and pointing cron at this file cannot double-write however often it fires.
- **No HTTP route** — a test-capable reader can verify the inventory; the `scheduledJobs` health
  label names the sports CLI and states the boundary as "stake sizing and the consoles".
- The `buildApp` composition exposes the cron at `api.sports.cron` — the handle the CLI uses, built
  over the same service graph the routes use (a second hand-rolled wiring in a tool is a wiring
  that drifts).

## 5. Migration 015

`015_sports_snapshots.sql` creates **one** table:

- `wf_sports_performance_snapshots` — `as_of VARCHAR(32)` (the hour-truncated UTC instant),
  `window VARCHAR(8)` (legacy's own spelling: `'7'`, `'30'`, `'90'`, `'ALL'`),
  `payload LONGTEXT` (the whole report as JSON), `UNIQUE KEY uq_sports_perf_snapshot (as_of, window)`.

Deliberately **no `wf_job_runs`** (§6.1): the window markers are `wf_job_locks` rows whose expiry
*is* the window. Schema 40 → **41** tables; migrations 001–**015**. As with 014, the migration has
never been applied to a real MySQL/MariaDB server (F-15).

## 6. Divergences

1. **Window locks instead of a job-run table.** Legacy marked "already ran" with a unique
   `wf_job_runs.execution_key` row per window. This schema has no job-run table — the arbiter the
   platform already trusts is `wf_job_locks` (migration 010), so each window-locked job takes a
   lock named `sports.<job>.<date>[.<hour>]` (dots — `assertJobName` refuses colons) whose
   **expiry is the window**: a re-run in the same window finds the marker unexpired and reports
   `DUPLICATE_SKIPPED` (naming the holder), the next window's run takes it over, and a lost marker
   re-runs the window with the snapshot upsert replacing rather than duplicating. The lock is
   **never released — not even on failure**: it is the marker, not a mutex, exactly legacy's
   execution-key semantics (legacy's key row also persisted when a job threw). TTLs are the
   windows themselves: 3,600,000 ms hourly, 86,400,000 ms daily. The three sync jobs need none of
   this — their per-provider execution keys already arbitrate inside the sync service, as in
   legacy.
2. **SP-10, cron-side extension: stored reliability, never a live probe.** The quality job reads
   each provider's newest stored health assessment (`provider_reliability_score`/100); a provider
   with no observations derives to 0 — what "nothing witnessed" scores — never a fabricated 0.9.
   A scheduled job must not turn into an outbound vendor call just because the clock fired.
3. **Audit actions.** Legacy audits `SCREAMING_SNAKE` labels (`SPORTS_QUALITY_RECALC`,
   `SPORTS_SETTLEMENT_SWEEP`, `SPORTS_MONITORING`, `SPORTS_DATA_CLEANUP`, `SPORTS_JOB_FAILED`,
   `SPORTS_CRON_RUN`); the platform's established convention maps them to dot-case actions
   (`sports.quality.recalc`, `sports.settlement.sweep`, `sports.monitoring`,
   `sports.data.cleanup`, `sports.job.failed`, `sports.cron.run`) — the same mapping every ported
   module uses.
4. **DV-24 / DV-25** (§3) are divergences *from legacy's bugs*, pending user confirmation.
5. **Cleanup's scope.** Legacy's cleanup also pruned `wf_job_runs`; this schema has no job-run
   table, and the window markers expire by construction. Audit retention is a platform-wide
   decision (R-27's open half), not this job's — so the port's cleanup prunes provider-health
   observations at 90 days and nothing else. Predictions, tickets and results are decision history
   and are kept forever (legacy's own comment).

## 7. How it is proven

`test/sports_cron.test.js` (8 tests, a 53rd file) pins, against a real file-store instance:

- the nine names in legacy's order, the unknown-name refusal, the `YYYY-MM-DD`/real-calendar-day
  date rule, and the factory's boot-time guards;
- a default host's `runAll`: every job answers, nothing fabricated, `SKIPPED` syncs with legacy's
  exact sentence, the ticket a `NO_QUALIFIED_TICKET` record, four snapshot windows written and
  readable with `dataAvailable: false`, **cleanup `COMPLETED` (the DV-24 pin)**, the five audits
  present, and **not one** `sports.job.failed`;
- `DUPLICATE_SKIPPED` within the window (reason naming holder and expiry), the marker's persistence
  in `wf_job_locks`, and takeover after expiry;
- the lost-marker re-run replacing snapshots — one row per `(hour, window)`, however many times the
  window ran;
- failure isolation: a broken drift monitor makes exactly `monitoring` `FAILED` (audited,
  `entityId` the job name) while every other job runs and the sweep's own audit closes the run —
  and the failed hour's marker still stands;
- legacy's `combine()`: `SKIPPED` (nothing to do), `PARTIAL` (any provider `FAILED`), `COMPLETED`,
  and the DV-25 honest-provider-count summary;
- the 90-day rule: the cutoff is exactly now minus ninety days, canonical UTC, derived by the cron
  and passed through untouched, audited, and one cleanup per date;
- the **CLI end to end**: `node tools/sports-jobs.mjs --job cleanup --json` against a real store
  exits 0 with one JSON document; a **second process** the same day honours the first process's
  marker (`DUPLICATE_SKIPPED` — exit still 0); an unknown `--job` is refused with exit 1. This test
  is what caught F-44.

**No WASM parity case for the cron, deliberately.** `combine()` and `ageOf()` are three-line pure
helpers over orchestration whose components already carry their own parity or differential evidence
(sync idempotency, quality, settlement, drift — Phases 16–19); the cron's observable behavior is
pinned against legacy's documented semantics by the suite above. A differential test would need the
legacy cron driven against a seeded legacy database for one summary JSON — evidence of the wiring,
which the suite already evidences on the port side. If the user wants the summary-shape parity
anyway, it is a half-day of harness work (§9).

## 8. What this phase does not claim

- No job ran under a real crontab (no crontab in the sandbox; the CLI is proven by execution, the
  schedule by documentation).
- No provider was contacted: every verified run was the sandbox or an unconfigured host; nothing
  against a vendor, ever (no verified vendor exists on this platform).
- No MySQL: migration 015 and the upsert's `ON DUPLICATE KEY UPDATE` path are unexercised against
  a server (F-15); the file adapter's upsert-replace is the exercised path.
- The snapshots written in verification are `dataAvailable: false` reports over an empty attested
  history — the machinery proven, not a measurement.
- Nothing is deployed; no release was cut (version 0.17.0 in `package.json` only).

## 9. Decisions

**Carried, unchanged:** DV-20 (simulated candidates refused for tickets), DV-23 (a throwing run
stored `NO_QUALIFIED_TICKET`), `ticketEngine` reports `ON_REQUEST`, F-39 kept as documented,
live execution disabled.

**New, need the user's word** (both change operator-visible behavior):

6. **DV-24** — the port routes `cleanup` (legacy's missing match arm). Legacy's operators saw
   `cleanup: FAILED` plus a spurious `SPORTS_JOB_FAILED` audit every day; the port reports
   `COMPLETED` and prunes health at 90 days. Confirm the port's behavior as the intended one.
7. **DV-25** — the port's fixtures summary says "no providers configured…" only when it is true.
   Confirm.

**Still open, unchanged from PHASE18/19 §9:** DV-21 (the daily run never fetches), DV-22 (the
engine never self-approves), sandbox qualification globally (PHASE17 §9), the calibration approval
policy, the Phase 16 golden count, and **SP-35** (PHP `is_int(2.0)` is false; the port accepts an
integral float — the golden keeps PHP's refusal as evidence). New and optional: whether the user
wants a WASM parity case for the cron's summary shape despite §7's reasoning.

## 10. Gates

Measured in `apps/workforce-platform` on this branch, on 2026-10-12, Node v22.22.3.

| Gate | Result |
|---|---|
| `npm test` (run by `npm run check`) | **893 / 893** across **53** files (was 885 / 885 across 52). The 8 new tests are `sports_cron` |
| `npm run check` | **exit 0**. `verify:install` **29 / 29**; **76** documented variables |
| PHP oracle (`node runtime/run-tests.mjs`) | **367 / 367** |
| Legacy tree | `git status --porcelain application/ system/ tests/` is **empty** |
| Routes | **115** total; **34** sports — unchanged, pinned; the cron adds none (CLI-only) |
| Contract | **144** repository methods (was 142); **58** sports (was 56) |
| Schema | **41** tables (was 40); migrations 001–**015** |
| Version | **0.17.0** (was 0.16.0) |

Fourteen existing pins moved with the counts — each for the reason the pin exists: the backup table
map (41, snapshot table + MySQL counterpart), the migration list (015 last), the retention and
Strategy-Lab contract pins (144), the platform findings F-01 pin (144, snapshots named), F-02's
label pin (the rewritten sports ledger label), the sports store pins (58, twice), the MySQL
intelligence pin (58), the not-ported matrix (**2** — the cron left it) and its HTTP twins, the
close/reopen entity stats (snapshots) in two files, and the readiness placeholder pin (15).
The four failures that were *not* yet-explained pins — the Phase 8A migration pin, R-27's retention
pin, the MySQL intelligence pin and the file-adapter replay pin — were each opened and read before
being updated: all four were count pins, none was behavior.

**Not run:** a real MySQL server; migration 015 against any database; a crontab.

## 11. Ledger

`sports` stays **partial**, and its label shrinks one more clause: the module now *runs on a
schedule* — syncs, quality, the daily ticket, the settlement sweep, performance snapshots,
monitoring, retention cleanup, from the CLI under window locks, never from an HTTP route — and what
keeps it partial is that nothing is executed, no stake is sized, no stored result is trusted before
a person attests to it, and no provider is verified against a vendor. `SPORTS_NOT_PORTED` shrinks
3 → **2** (stake sizing; the console screens, F-29) — the cron's entry was removed, not re-labelled.
`scheduledJobs` also names the sports CLI now. **After row 19 the sports module owes only stake
sizing (which no slice owns) and the console screens (F-29, platform-wide).** *Phase 28 ported the
console screens\) — so after Phase 28 this sentence reads "only stake sizing"; F-29 still names the
market-data, analysis and Strategy Lab consoles.*

## 12. Open items and risks

- **F-15.** No real MySQL: migrations 011–015, the repository transactions, the lock arbiter under
  concurrency and the backup/restore path remain unvalidated against a server; none of this is
  deployed.
- **R-30.** The file adapter is not atomic for tickets; only the MySQL adapter settles whole
  tickets transactionally. The sweep inherits exactly that boundary.
- **Marker semantics on the file adapter.** The duplicate-skip is proven across sequential
  processes; the file adapter's `crossProcessSafety: false` stands — the guarantee that matters is
  the SQL adapter's unique-key arbiter, unexercised against a server (F-15).
- **Stake sizing** has no owner slice, and the consoles (F-29) are platform-wide. Both are the
  sports module's whole remainder.
- **Platform-wide remaining:** row 15 (lottery intelligence and operations console), F-15 (real
  MySQL verification), R-30 (file-adapter atomicity), row 22 (full data migration and cutover,
  which owns F-32's reads).
- **PHASE18/19 §9 items and §9 above** remain user decisions, not silent defaults.
