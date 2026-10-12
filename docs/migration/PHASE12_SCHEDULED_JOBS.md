# Phase 12 — Scheduled jobs, DB-backed locks and the operations CLI

Date: 2026-10-11 · Branch `arena/8de8de2e-ai` · Version 0.10.0 → 0.11.0
Row 19 of `docs/migration/UNFINISHED_MODULES.md`: *scheduled jobs, CLI, resumable work.*

## Scope

Legacy ran one cron line every minute:

```
* * * * * php /path/to/index.php tools cron >> /var/log/aegis-cron.log 2>&1
```

`Tools::cron()` (`application/controllers/Tools.php:104`) did exactly two things, built
one JSON document from them, audited `CRON_RUN` as actor `'system'`, and echoed it:

1. `PortfolioRiskMonitor::scan()` — every paper account **globally**, with per-account
   failure isolation, plus broker connector transitions, plus edge-triggered alerting
   against a persisted `alertKeys` memory.
2. `ExecutionSupervisor::expireStaleProposals()` — proposals past their approval window,
   **across every owner**.

Ported here as `src/jobs/scheduled.js` plus `tools/scheduled-jobs.mjs`, coordinated by a
new `wf_job_locks` table (migration 010). `Tools::sports_cron()` and
`Tools::lottery_cron()` are rows 14 and 15 — both `not-ported` — and are out of scope.

Row 19 names the lock as a **prerequisite**, not an extra: the retention CLI shipped in
Phase 5 is safe to overlap because its deletes are idempotent and batched, but "the
pattern will not hold for a job that writes, so add the lock before the next one." This
job writes, so the lock lands in the same change as the job.

## What it does

**`src/db/migrations/010_job_locks.sql`** — one row per named job. `job_name` is the
primary key, which *is* the mutual-exclusion guarantee: two concurrent acquirers both
attempt an `INSERT` and the loser gets a duplicate-key error, so the arbiter is the
storage engine rather than a check-then-act race. `holder` (VARCHAR 120),
`acquired_at` and `expires_at` are canonical-UTC VARCHAR(32), matching 007/008/009, so
`expires_at <= ?` is a correct string comparison that no host `time_zone` setting can
reorder. Additive only; no seed row, because a lock that exists before any job runs
would block the first run.

**`src/db/job-repository.js`** — `findJobLock`, `listJobLocks`, `acquireJobLock`,
`releaseJobLock`, `extendJobLock`, plus `loadJobState` / `saveJobState`. Acquire is:
steal an expired row (`UPDATE … WHERE expires_at <= now`) → else `INSERT` and catch the
duplicate → then **read the row back and confirm `holder === us`**. Never throws for
"held by someone else": that is an expected outcome and the caller reports it with a
`reason` string usable in a cron log. Release and extend are holder-scoped.

**`src/jobs/scheduled.js`** — `createScheduledJobs({store, paper, execution,
notifications, log, now})` exposing `runOperations`, `portfolioRiskSweep`,
`recordTransitions` and `lastRiskReport`. The sweep lists every paper account
(`listPaperAccounts(null)`), groups by owner, and runs each group through the
already-ported `paper.portfolioRiskScan`, so the breach rules, limit source and
valuation path are the ones Phase 7 shipped and tested — there is no second copy of the
risk arithmetic here to drift from it. Breaches become alerts keyed
`paper:<accountId>:<CODE>`, legacy's `"{$scope}:{$code}"`.

**`src/modules/execution/service.js`** — `expireStaleProposals({limit, dryRun})`, the
cross-owner sweep, reading through the new `listExecutionProposalsAllOwners` and expiring
each row through the *existing* owner-bound `expireInTransaction` with the owner read off
the row.

**`tools/scheduled-jobs.mjs`** — the cron entry point, following
`tools/prune-analysis-runs.mjs` exactly: dry run by default, `--apply` to write, `--json`
for one document on stdout, `--now` for a fixed clock, `--holder`, `--lock-ttl-ms`,
`--account-limit`, `--proposal-limit`, usage on stderr with exit 1.

**Wiring** — `buildApp` constructs the jobs and exposes `api.jobs`. There is **no route**.
`npm run jobs` / `npm run jobs:apply`.

## Divergences

**SJ-1 — per-item failure isolation.** Legacy's `expireStaleProposals` had none: one
throwing row abandoned the whole `foreach`, so a deterministic failure on proposal 3 of
200 left the other 197 pending forever. The port collects `{proposalId, reason}` failures
and continues. Its `scan()` *did* isolate per account (`catch` → `SCAN_FAILED` →
`continue`); the port isolates **per owner**, because the Node scan is owner-scoped, and a
failed group yields one `SCAN_FAILED` alert per account in it — the same observable
outcome. At the job level the two stages are isolated from each other too: a risk sweep
that throws must not stop proposals expiring, since an approval window lapsing unactioned
is the more time-sensitive failure. Legacy ran them in sequence with no isolation, so a
scan failure skipped expiry entirely.

**SJ-2 — staleness predicate.** Legacy compared `created_at >= gmdate('c')` as **strings**.
`gmdate('c')` emits a `+00:00` offset while this platform stores canonical `…Z`, and those
two forms do not sort consistently against each other — the same hazard as AV-2. The port
reuses this module's `isProposalStale` (`Date.parse` comparison), so the sweep and the HTTP
path can never disagree about what "stale" means. The cutoff is deliberately **not** pushed
into SQL: `isProposalStale` treats an unparseable `created_at` as stale, whereas a VARCHAR
`created_at <= ?` sorts garbage like `not-a-date` *after* a real instant and excludes it, so
SQL and the file adapter would disagree about exactly the malformed rows that most need
expiring.

**SJ-3 — richer reports.** The sweep returns `{scanned, staleFound, expiredIds,
alreadyExpired, failures, exhausted, dryRun}` instead of legacy's bare array of ids.
`exhausted: false` means the batch ceiling was reached and more remain; the CLI says so
rather than implying the backlog is clear. `runOperations` reports the adapter and its
`crossProcessSafety`, so a log reader knows which lock guarantee they actually got.

**SJ-4 — job state is a separate `state_key`, not a sub-key of the governance blob.**
Legacy wrote `$state['portfolioRisk']` *inside the same platform-state document* as
`tradingMode` and `killSwitch` and saved the whole thing. The port keeps the same
`wf_trading_state` table but a different `state_key` (`portfolio-risk`), and the job
repository **refuses the `'global'` key outright** on both adapters. `loadTradingState`
reads only `'global'`, so the two documents cannot see or clobber each other. A cron run
that rewrote the governance row could overwrite a kill-switch change made concurrently by
an operator; the separation makes that structurally impossible rather than merely unlikely.

**SJ-5 — the lock is a table row, not `GET_LOCK()`.** `GET_LOCK()` is per-connection and
dies with it, so a job killed mid-run leaves no evidence it ever held anything; it is not
portable to the file adapter, which must satisfy the same contract; and it is not
observable. A row survives a kill and answers "who was running and when" — the first
question after a cron log goes quiet. Legacy had **no lock at all**, so this is an addition
required by row 19, not a behaviour change to preserve. Expiry is what makes it safe on
shared hosting: a host can kill a job (CPU limit, deploy, reboot) without running its
`finally`, so a lock only its holder could release would wedge the schedule forever.

**SJ-6 — severity ordering by explicit rank.** Legacy sorted with a tuple comparison on
`[severity, code]`, which orders severity **alphabetically**: `critical` before `warning`
before `info`. That coincides with importance for exactly the three severities in use. The
port uses an explicit rank, giving the same order without depending on the alphabet, and
would still be right if a severity like `high` were ever added.

**SJ-7 — the notification title keeps legacy's ambiguous form.** Legacy titled an alert
`"{$code}: " . explode(':', $scope)[0] . " risk alert"`, so scope `paper:123` yields
`DRAWDOWN_LIMIT: paper risk alert`. For an operator with several accounts that does not say
which account; the account is in the payload (`detail.accountId`, `detail.scope`) and in the
dedupe key. Rewriting the title is a product decision, so it is recorded rather than
quietly improved.

**SJ-8 — no early-warning tiers.** Legacy raised a `warning` at **80%** of the exposure and
leverage limits, **70%** of the drawdown limit and **60%** of the daily-loss limit, and
`critical` at the limit itself. The port alerts on the paper scan's **at-limit** breaches
only. An operator therefore hears about a breach when it happens, not as it approaches.
Adding the tiers would have meant either a second, divergent set of thresholds inside the
job or a change to `portfolioRiskScan`'s accepted vocabulary from row 11 — neither belongs
in a phase whose rule is to preserve behaviour before improving it. This is the primary
reason `scheduledJobs` is `partial` rather than `ported`.

**SJ-9 — two legacy alert codes have no Node equivalent.** The legacy monitor computed
`EXCESSIVE_LEVERAGE` (gross notional ÷ equity vs `maxLeverage`) and `CORRELATED_POSITIONS`
(a static disclosed group table: `CRYPTO_MAJORS`, `USD_MAJORS`, `USD_COUNTER`, `METALS`,
`ENERGY`, `US_EQUITY_INDEX`, flagged when two or more open positions share a group). The
Node portfolio scan emits neither. The Node vocabulary is also broader in other places
(`WEEKLY_LOSS_LIMIT`, `OPEN_POSITION_LIMIT`, `SYMBOL_EXPOSURE_LIMIT`,
`SYNTHETIC_EXPOSURE`, `NON_POSITIVE_EQUITY`, `VALUATION_UNAVAILABLE`), and the port uses
**that** vocabulary rather than reintroducing legacy's code names: row 11 was already
accepted with it, and one codebase carrying two names for the same breach is worse than one
carrying a documented gap. Legacy's `HIGH_EXPOSURE`, `MAX_DRAWDOWN_WARNING` and
`DAILY_LOSS_WARNING` correspond to `PORTFOLIO_EXPOSURE_LIMIT`, `DRAWDOWN_LIMIT` and
`DAILY_LOSS_LIMIT`.

**SJ-10 — the sweep is not reachable over HTTP.** Legacy's `cron()` was a public
controller method (`tools/cron`) whose only protection was that nobody knew the URL.
`runOperations` takes no owner argument: it scans every account on the platform and expires
every operator's proposals. Exposing it would turn any reachable caller into a
platform-wide actor, so it is CLI-only and a test asserts no route in the entire inventory
matches `job|cron|schedul|sweep|stale|lock`.

## Safety properties

* **A run that is skipped is reported as skipped.** `runOperations` returns
  `{skipped: true, lock: {acquired: false, reason}}`, records no `system.job.run` event and
  reaches neither service. An every-minute cron whose previous run is still going will skip,
  and the log reads as a fact rather than a failure or a silent no-op.
* **Ownership is never inferred from `affectedRows`.** MySQL counts *changed* rows, not
  matched ones: an `UPDATE` that matches but writes identical values reports 0, and a
  concurrent writer can land between the steal and the read. Both adapters read the row back
  and compare `holder`. A test drives a lying executor that reports `affectedRows: 1` for a
  row belonging to someone else and asserts the acquire still fails.
* **Release and extend are holder-scoped.** A run whose lock expired and was taken over must
  not delete the new holder's row on its way out — that is what would let a third run in.
  Both the file adapter and the SQL are scoped by `AND holder = ?`, and a failed release is
  reported with a reason rather than treated as success.
* **The lock is released in `finally`,** so a throwing stage does not leave the job wedged
  until its TTL expires.
* **A dry run takes no lock.** This matters as much as taking no writes: a measurement run
  that reserved `operations.cron` would lock out the real run that follows it, so a dry run
  scheduled every minute would silently stop the job it was measuring. It also leaves the
  transition memory untouched, so the real run still sees the alert as new.
* **Alerting is edge-triggered.** Only transitions are audited and notified. Without the
  persisted `alertKeys` memory a per-minute cron would re-alert 1 440 times a day, and
  Phase 9's dedupe would not save it — that dedupe only suppresses while an *unread* row
  exists, so an operator who reads an alert would immediately get it again while the breach
  persists. Losing the memory is self-healing (every alert reads as new once, then the
  baseline is re-established) rather than fatal. The two reasons "every alert looks new" are
  reported separately, because they mean different things to an operator: `firstRun: true` is
  expected and harmless — nothing was recorded yet, so this run establishes the baseline —
  while `memoryReadable: false` is a fault, meaning a baseline existed, could not be read, and
  alerts that were already sent are about to be sent again. The CLI says "note" for the first
  and "warning" for the second.
* **The job cannot move the kill switch.** See SJ-4; both adapters refuse `'global'`, and a
  test writes job state and then asserts the governance document is byte-identical,
  including `updatedByUserId`.
* **A job writes as the system actor.** Every audit event passes `actorId: null`, which
  Phase 10 renders as `kind: "system"`. No scheduled write borrows an operator's identity,
  so filtering the trail by one's own user id does not surface expiries the platform
  performed.
* **Bounded batches with visible exhaustion.** Accounts 1–5 000 (default 500), proposals
  1–500 (default 200, legacy's figure), locks 1–500, oldest-first ordering on proposals so
  a bounded batch drains the backlog in the order it accrued. Every ceiling reports
  `exhausted`, and the CLI warns when one was reached.
* **Notifications are best-effort; the audit trail is the evidence.** A host whose
  notification surface is missing or failing must still complete the sweep and still record
  what it found — otherwise an alerting outage would look like a risk outage.
* **No persistent worker.** There is no loop, no timer and no `setInterval`. cPanel and
  Passenger do not guarantee a long-lived process, so scheduling belongs to the host's cron
  and this module is a short-lived entry point that runs once and exits.

## Defects found and fixed

**D-18 — the two adapters returned different shapes for a job lock.** The SQL repository
maps rows through `lockRow()` to `{jobName, holder, acquiredAt, expiresAt}`; the file
adapter returned the raw snake_case row. So `lock.expiresAt` was a string on MySQL and
`undefined` on the file store, and the file adapter's own `reason` strings interpolated
`lock.expires_at`. `contract.js` describes one interface, and a caller cannot be expected to
branch on which adapter it got. Found by the first lock test, which asserted `expiresAt` and
got `undefined`. Fixed by adding the file adapter's `jobLockRow()` mapper and using it in
`findJobLock`, `listJobLocks` and every `acquireJobLock` return. This is precisely the class
of divergence that only surfaces when a deployment switches adapters — which is when it is
hardest to debug.

**D-19 — the scheduled expiry audited the owner instead of the system.**
`expireInTransaction` hard-coded `actorId: owner`, which is correct for the HTTP path (there
an operator's own read or decision found the lapsed window) but wrong for the sweep: legacy
audited `EXECUTION_PROPOSAL_EXPIRED` with actor `'system'`, and the operator did nothing —
the clock did. Found by the system-actor test, which expected three system-attributed events
and got two. Fixed with an `{actorId = owner}` option on `expireInTransaction`, defaulted so
the HTTP path is unchanged and `null` from the sweep.

**F-30 (new finding) — `maxCorrelatedPositions` is a declared limit with no enforcement.**
It appears in the risk-engine defaults, the paper contract schema and the bounds table, and
in **no check anywhere**: every other risk limit has at least one enforcement point
(`maxLeverage` at order time in `risk-engine.js:154`, `minDataQuality` and `blockStaleData`
in the same file, the exposure and loss limits in the portfolio scan). An operator can set
`maxCorrelatedPositions: 3` through the permissioned API and be told it was saved, and
nothing will ever act on it. Legacy enforced it in the monitor via the static
`CORRELATION_GROUPS` table (SJ-9). Not fixed here — inventing a correlation heuristic is a
risk-modelling decision, not a port — but recorded, because a limit that reads as enforced
and is not is worse than no limit.

## Verification

| Gate | Result |
| --- | --- |
| `npm test` | **609 / 609** (was 582; +27) |
| `npm run verify:install` | **29 / 29**, 67 config vars |
| PHP oracle (`node runtime/run-tests.mjs`) | **367 / 367**, 0 PHP files modified |
| API routes | **80** (unchanged — no route was added) |
| Admin routes | **7** (unchanged) |
| Persistence contract | **84 → 86** methods |
| Migrations | 001–009 → **001–010**, 23 → **24** tables |
| Module ledger | 16 → **17** rows; 9 ported / 2 → **3** partial / 5 not-ported |
| Version | 0.10.0 → **0.11.0** |

`test/scheduled_jobs.test.js` (26 tests) covers: acquire/refuse/release/extend; expiry
takeover and the overrun run being unable to release; durability of lock rows and job state
across close/reopen; the `'global'` key refusal in both directions and the governance
document being untouched; dry run writing nothing (verified through the store, **not**
through `execution.find`, which lazily expires on read and would have made the dry run look
like a writer); cross-owner expiry with per-proposal notifications and dedupe keys;
idempotency of a second sweep; storage-failure and ownerless-row isolation; a real
`VALUATION_UNAVAILABLE` breach from the real paper service producing a keyed, classified
alert; per-owner scan isolation; ownerless accounts; edge-triggered transitions across three
runs; an unreadable transition memory being reported as a fault rather than as a first
run; clearing and re-raising; the persisted report dropping `key` and `classified`; a
source-reading tripwire asserting every code the paper scan can emit is classified;
concurrent-run skipping with no writes; the legacy `CRON_RUN` summary sentence and system
actor; dry run taking no lock; `finally` releasing the lock when a stage throws; no HTTP
route exposing any of it; and the MySQL SQL shapes, bindings and bounds against a recording
executor.

Ledger tripwires moved by the new entity and migration, all updated: two pinned `stats()`
maps (`strategies_store`, `platform_findings`), `backup.test.js`'s collection→table map and
its F-13 table count (23 → 24), `migrator.test.js`'s last-migration pin, `store.test.js`'s
readiness placeholder count and migration list, and three pins on the contract method count.

### Not exercised, and therefore not claimed

* **The lock has not been proven against real MySQL.** There is still no staging database
  (F-15). The SQL shapes, bindings and bounds are asserted against a recording executor, and
  mutual exclusion is proven on the file adapter — but a real duplicate-key race under two
  concurrent connections is untested. `crossProcessSafety: false` is reported for the file
  adapter, and the CLI warns that cron on shared hosting needs MySQL.
* **cPanel cron itself was not installed.** This sandbox has no crontab and no Passenger. The
  documented line, the absolute `node` path and the `cd` are reasoned from the host's
  behaviour, not observed. Note that the job needs the **same environment as the web app**
  (`SESSION_SECRET`, `DB_*`) because `loadConfig` is one gate for the whole platform, and
  cPanel supplies those to Passenger rather than from a `.env` file — so a cron line must
  source them itself, from a file outside the web root with `0600` permissions. No secret is
  committed here.
* **No overlapping run was produced in practice.** The skip path is driven by holding the
  lock directly, not by two real processes racing.
* **The 500/5 000 batch ceilings were not reached.** Tests use small fixtures, so
  `exhausted: false` is asserted only through the cross-owner proposal read's SQL bound.
* **Broker, sports and lottery cron output.** Not produced, because those modules are not
  ported. `BROKER_CONNECTED` and `BROKER_DISCONNECTED` remain on Phase 9's NV-6 list of
  declared-but-unpublished notification types; `PORTFOLIO_RISK` is **removed** from that
  list, because this phase is its publisher.
* **No end-to-end run against a populated portfolio.** The sweep is proven against one real
  account with one unmarkable position and against scripted scans; it has not been run over
  a portfolio with dozens of accounts and live valuations, so its wall-clock duration — and
  therefore whether the default 10-minute TTL is genuinely generous — is reasoned, not
  measured.

## Next

* Row 22 (full legacy data migration and cutover) must decide whether legacy's
  `portfolioRisk.alertKeys` state is imported; if it is not, the first Node sweep re-alerts
  every active breach once. That is acceptable but should be expected rather than discovered.
* F-25 (a scheduled live-provider probe) is now cheap to add: the lock, the CLI shape and
  the audit attribution all exist, and a probe job is a third stage in the same run.
* F-30 needs a decision — enforce `maxCorrelatedPositions`, port legacy's static group
  table, or remove the limit from the API so it stops reading as enforced.
* SJ-8's early-warning tiers and SJ-9's leverage alert are both additions to
  `portfolioRiskScan`'s vocabulary; if they are wanted, they belong in one change to row 11
  with the monitor's tests, not in the job.
