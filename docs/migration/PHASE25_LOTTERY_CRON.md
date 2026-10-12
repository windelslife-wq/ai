# Phase 25 — Lottery Intelligence: the cron (row 15, slice 5)

> **Status: landed on `arena/653d6218-ai`.** This record covers slice 5: the lottery cron —
> legacy's `LotteryCronService` (248 lines) ported whole as seven execution-key-idempotent jobs,
> CLI-only at `tools/lottery-jobs.mjs` (`npm run lottery:jobs`), with **no HTTP route**. It
> retires row 15's last code gap; the console screens remain not-ported under F-29
> (platform-wide — no ported module has one). The previous record is
> [`PHASE24_LOTTERY_BACKTESTS.md`](PHASE24_LOTTERY_BACKTESTS.md).

## 1. What this phase is

The scheduler row 15 has owed since slice 2 queued its first background system build. Seven jobs,
in legacy's order: **sync** (once per day per lottery, `sync:EUROMILLIONS:<date>`), **health**
(read-only staleness: ONLINE but more than 8 days since the last successful sync reads
DEGRADED — EuroMillions draws twice a week), **statistics** (the data-integrity sweep: every
stored draw must still satisfy the rules; violations are audited for manual correction, never
silently rewritten), **systems** (THE consumer for the queued background builds — the queue
finally drains), **tickets** (auto post-draw checking of OPEN tickets against the latest stored
VERIFIED draw, future-dated and archived tickets untouched), **backtests** (one HISTORICAL
SIMULATION per strategy per day, the mandatory random baseline included every day) and
**cleanup** (the 90-day job-run / 30-day health-observation retention sweep).

One failing job never aborts the sweep: its summary entry becomes `{status: "FAILED", error}`
(message truncated to legacy's 300 chars) and the failure is audited (`lottery.job.failed`);
the whole run is audited once at the end (`lottery.cron.run`) with the status map, exactly
legacy's shape.

## 2. The idempotency mechanism is legacy's own, not the sports cron's

The sports cron (row 19) arbitrates windows with `wf_job_locks` markers. The lottery cron does
not need them: legacy's lottery repository has its own job-run table (`wf_lottery_sync_runs`,
migration 016) whose `startLotteryJobRun` returns **NULL when the execution key already exists**
— so `sync:EUROMILLIONS:<date>` and `backtest:EUROMILLIONS:<strategy>:<date>` arbitrate
themselves, a re-run reports ALREADY_RUN or skips, and **a failed run's key still blocks the
window**, exactly as legacy's does. The `systems` queue needs no marker at all: its job runs ARE
the queue, flipped RUNNING → OK/FAILED by this consumer.

Cutoffs are canonical UTC (`…Z`), not legacy's `Y-m-d H:i:s` — this platform's timestamps are
canonical (LT-1) and both adapters compare text, so the cutoff must be the same format (the R-27
rule the retention sweep already follows: one format, or the comparison silently lies).

## 3. A real slice-1 bug the cleanup test caught

`deleteOldLotteryJobRuns` on the **file adapter** deleted by `{id}` — but the job-run table keys
rows by `execution_key` (`keyOf`), so every delete named an undefined key and **silently pruned
nothing** (the SQL adapter was always correct; the existing store test asserted only the returned
count, never the effect). Found by the slice-5 cleanup test asserting the store after the sweep;
fixed with the key the table actually uses, comment left at the delete.

## 4. Honest states over the wire and in the log

A default host with no provider: sync reports `SKIPPED_NO_PROVIDER`, health `OFFLINE`
(UNCONFIGURED maps there, not DEGRADED), statistics `OK` with zero draws checked, tickets
`no stored VERIFIED draw`, backtests `OK` while each strategy's own job run FAILED with
`backtesting needs at least 11 stored draws (got 0)` and an audit event apiece — the job's
summary stays OK because the per-strategy failures are facts about an empty host, audited in the
store, exactly legacy's contract. The queued-build API note no longer points at a command that
did not exist: it names `npm run lottery:jobs` and says a host that never runs the cron leaves
the queue waiting honestly.

## 5. What this phase does not claim

No MySQL server was exercised (F-15); migrations 016–019 are unchanged and nothing new is
applied. **No HTTP route exists for the cron** — CLI only, like every scheduled job on this
platform, enforced by the `scheduledJobs` ledger label and a test that pins the jobs read as a
GET of stored history only. Nothing runs on a schedule in this sandbox (no crontab); the CLI is
proven end-to-end by spawning the real tool against a real file store. The console screens
(`Lottery.php`, `views/lottery/*.php`) are not ported — F-29 is platform-wide.

## 6. Gates

| Gate | Result |
| --- | --- |
| `npm run check` (`verify:install` + full suite) | exit 0 — 970/970 tests, 66 files, 29/29 install checks |
| PHP/WASM oracle (`node runtime/run-tests.mjs`) | 367 passed, 0 failed |
| Legacy tree (`application/`, `system/`, `tests/`) | byte-identical, 0 changes |
| Routes | unchanged at 146 (the cron is CLI-only — the count not moving is the point) |
| Version | 0.22.0 |
