import { test } from "node:test";

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { deepEqual, equal, match, ok, rejects, throws } from "node:assert/strict";

import { createFileStoreApp } from "./helpers.js";
import { createSportsCronService, SPORTS_JOBS } from "../src/modules/sports/cron.js";

const exec = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");

const SANDBOX = { env: { WINDELS_SPORTS_MODE: "SANDBOX", WINDELS_SPORTS_SANDBOX: "1" } };

/** A cron over the app's real sports service with a test-owned clock. */
function cronOver(instance, { now = Date.now(), sports = null } = {}) {
  return createSportsCronService({
    sports: sports ?? instance.app.sports,
    store: instance.store,
    now: typeof now === "function" ? now : () => now,
    actorId: "cron-test",
  });
}

test("the cron exposes exactly the nine legacy jobs, in legacy order, and refuses everything else", async (t) => {
  // Legacy `SportsCronService::JOBS`. Order matters: fixtures before odds before
  // results before quality, the ticket after the data it reads, settlement after the
  // ticket it settles, and cleanup last because it prunes what the others produced.
  deepEqual([...SPORTS_JOBS], ["fixtures", "odds", "results", "quality", "ticket", "settlement", "performance", "monitoring", "cleanup"]);

  const instance = await createFileStoreApp({ configOverrides: { env: SANDBOX.env } });
  t.after(() => instance.cleanup());
  const cron = cronOver(instance);
  deepEqual([...cron.jobs], [...SPORTS_JOBS], "the composed service publishes the same list");
  // And the wiring the CLI relies on: the app composes the cron at `sports.cron`,
  // built over the same service graph the routes use.
  ok(instance.app.sports?.cron, "the app exposes the cron at sports.cron");
  ok(Object.isFrozen(cron), "the cron surface is frozen — no ad-hoc tenth job");

  await rejects(() => cron.run("harvest"), /unknown sports job: harvest/, "legacy's message for a name outside JOBS");
  await rejects(() => cron.run("fixtures", { date: "2026-3-1" }), /YYYY-MM-DD/);
  await rejects(() => cron.run("cleanup", { date: "2026-02-30" }), /real calendar day/);

  // The factory refuses to pretend: no service, or no repository, is a programming
  // error at boot, not an empty result at run time. These are synchronous TypeErrors
  // — boot-time guards, not runtime rejections — so `throws`, not `rejects`.
  throws(() => createSportsCronService({}), /requires the sports service/);
  throws(() => createSportsCronService({ sports: {} }), /requires a store/);
  throws(() => createSportsCronService({ store: {} }), /requires the sports service/);
});

test("a default host runs all nine jobs, fabricates nothing, and cleanup runs (DV-24)", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());

  // A pinned clock: the sweep's as_of stamps and cutoffs become exact, not
  // whichever hour the wall clock happened to reach.
  const summary = await cronOver(instance, { now: Date.parse("2026-10-12T15:00:00.000Z") }).runAll();
  deepEqual(Object.keys(summary), [...SPORTS_JOBS], "runAll answers for every job, in order");

  // No provider is configured, so the sync jobs report the honest nothing: SKIPPED
  // with legacy's exact sentence (DV-25's true branch — on this host it happens to
  // also be legacy's unconditional sentence, but here it is earned).
  equal(summary.fixtures.status, "SKIPPED");
  equal(summary.fixtures.summary, "no providers configured; nothing synchronized (nothing fabricated)");
  equal(summary.odds.status, "SKIPPED");
  equal(summary.results.status, "SKIPPED");

  // Quality runs over zero matches and still records its audit; the ticket is a
  // record of a run that produced nothing (DV-20/21/23 inherited); the sweep has
  // nothing pending; four snapshot windows are written; monitoring has no provider
  // to assess but still publishes the drift audit.
  equal(summary.quality.status, "COMPLETED");
  equal(summary.quality.matches, 0);
  equal(summary.ticket.status, "NO_QUALIFIED_TICKET");
  equal(summary.ticket.ticketId, null);
  ok(summary.ticket.message, "the ticket job says why nothing qualified");
  equal(summary.settlement.status, "COMPLETED");
  equal(summary.settlement.settled, 0);
  equal(summary.performance.status, "COMPLETED");
  equal(summary.performance.snapshots, 4);
  equal(summary.monitoring.status, "COMPLETED");

  // DV-24: legacy's `run()` has no `'cleanup'` match arm, so every legacy runAll ends
  // `cleanup: FAILED` with a spurious SPORTS_JOB_FAILED audit. The port routes the
  // job its own class defines, and this assertion is the pin: if the arm is ever
  // dropped, this test fails exactly the way legacy's operators saw it fail.
  equal(summary.cleanup.status, "COMPLETED");
  ok(/^\d{4}-\d{2}-\d{2}T/.test(summary.cleanup.cutoff), "cleanup reports the cutoff it applied");

  // The audit trail says the same thing the summary says: one entry per audited job,
  // the sweep's own run record, and NOT A SINGLE sports.job.failed.
  const { events: audits } = await instance.store.listAuditEvents({ limit: 200 });
  const actions = audits.map((entry) => entry.action);
  for (const expected of ["sports.quality.recalc", "sports.settlement.sweep", "sports.monitoring", "sports.data.cleanup", "sports.cron.run"]) {
    ok(actions.includes(expected), `the sweep audits ${expected}`);
  }
  equal(actions.filter((action) => action === "sports.job.failed").length, 0, "no spurious job-failure audit (legacy's DV-24 noise)");

  // The snapshots are readable through the repository, one per legacy window, each
  // labelled by the report itself — a measured report over attested records, never a
  // fabricated one. as_of is the run's hour-truncated instant: 15:00Z.
  const asOf = "2026-10-12T15:00:00.000Z";
  for (const window of ["7", "30", "90", "ALL"]) {
    const rows = await instance.store.listSportsPerformanceSnapshots(window);
    equal(rows.length, 1, `window ${window} has exactly its hourly row`);
    // Legacy's row shape: (as_of, window) identity, the payload decoded on read.
    equal(rows[0].as_of, asOf);
    const payload = rows[0].payload;
    equal(payload.dataAvailable, false, "a default host measures nothing and says so");
    ok(payload.demoBanner, "the report labels itself");
  }
});

test("a window's marker makes the next run in that window DUPLICATE_SKIPPED, and expiry hands the window over", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: SANDBOX.env } });
  t.after(() => instance.cleanup());

  let clock = Date.parse("2026-10-12T14:00:00.000Z");
  const cron = cronOver(instance, { now: () => clock });

  const first = await cron.run("quality", { date: "2026-10-12" });
  equal(first.status, "COMPLETED");
  equal(first.matches, 0, "an empty host still legitimately ran");

  // Same hour, second call: the marker lock is unexpired, so the run reports
  // legacy's DUPLICATE_SKIPPED and does no work — and names the holder, so the log
  // says who owns the window rather than looking idle.
  const second = await cron.run("quality", { date: "2026-10-12" });
  equal(second.status, "DUPLICATE_SKIPPED");
  equal(second.executionKey, "sports.quality.2026-10-12.14");
  match(second.reason, /held by sports-cron#\d+ until 2026-10-12T15:00:00\.000Z/);

  // The marker is visible as an ordinary job lock — and it outlives the run, because
  // it is the "already ran" record, not a mutex (the deliberate divergence from a
  // release-in-finally design).
  const locks = await instance.store.listJobLocks();
  const marker = locks.find((lock) => lock.jobName === "sports.quality.2026-10-12.14");
  ok(marker, "the window's marker row persists after the run");
  match(marker.holder, /^sports-cron#\d+$/);

  // Sixty-one minutes later the window has passed: the expired marker is taken over
  // and the job runs again.
  clock += 61 * 60 * 1000;
  const third = await cron.run("quality", { date: "2026-10-12" });
  equal(third.status, "COMPLETED", "the next window's run takes the window over");

  const { events: audits } = await instance.store.listAuditEvents({ limit: 50, action: "sports.quality.recalc" });
  equal(audits.length, 2, "exactly two recalculations happened — the skipped hour did no work");
});

test("a lost marker re-runs the window, and the snapshot upsert replaces instead of duplicating", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: SANDBOX.env } });
  t.after(() => instance.cleanup());

  const hour = Date.parse("2026-10-12T09:00:00.000Z");
  const cron = cronOver(instance, { now: () => hour });
  const key = "sports.performance.2026-10-12.09";

  const first = await cron.run("performance", { date: "2026-10-12" });
  equal(first.status, "COMPLETED");
  equal(first.snapshots, 4);

  // The defensive path: an operator (or a crashed boot) removed the marker while the
  // window is still current. The job runs again — and because the snapshot identity
  // is (hour, window), the re-run REPLACES the rows. One hour, one row per window,
  // no matter how many times the window ran.
  equal(await instance.store.releaseJobLock(key, `sports-cron#${process.pid}`), true, "the test removes this process's own marker");
  const second = await cron.run("performance", { date: "2026-10-12" });
  equal(second.status, "COMPLETED", "a lost marker re-runs the window");
  equal(second.snapshots, 4);

  const asOf = "2026-10-12T09:00:00.000Z";
  for (const window of ["7", "30", "90", "ALL"]) {
    const rows = await instance.store.listSportsPerformanceSnapshots(window);
    equal(rows.length, 1, `window ${window}: the re-run replaced, not duplicated`);
    equal(rows[0].as_of, asOf);
    equal(rows[0].window, window);
  }
});

test("one job failing never aborts the sweep, and the failed job's marker still stands", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: SANDBOX.env } });
  t.after(() => instance.cleanup());

  // Break exactly one dependency the monitoring job uses. The cron's contract with
  // legacy's runAll: the job's summary entry says FAILED with the error, every other
  // job still runs, the failure is audited, and the sweep's own audit is written.
  const real = instance.app.sports;
  const broken = { ...real, drift: { ...real.drift, monitor: async () => { throw new Error("drift probe down"); } } };
  const cron = cronOver(instance, { sports: broken });

  const summary = await cron.runAll();
  equal(summary.monitoring.status, "FAILED");
  match(summary.monitoring.error, /drift probe down/);
  for (const job of SPORTS_JOBS.filter((name) => name !== "monitoring")) {
    ok(summary[job].status !== "FAILED", `${job} ran despite monitoring's failure (${summary[job].status})`);
  }

  // The failure is audited with the job's name, and the sweep still closes with its
  // own run record.
  const { events: failures } = await instance.store.listAuditEvents({ limit: 50, action: "sports.job.failed" });
  equal(failures.length, 1);
  equal(failures[0].entityId, "monitoring");
  match(failures[0].details?.message ?? "", /Sports job monitoring failed/);
  const { events: sweeps } = await instance.store.listAuditEvents({ limit: 50, action: "sports.cron.run" });
  equal(sweeps.length, 1, "the sweep's run audit is written even when a job failed");
  equal(sweeps[0].details?.jobs?.monitoring?.status, "FAILED");
  equal(sweeps[0].details?.jobs?.fixtures?.status, "COMPLETED");

  // And the failed job's window marker still stands: legacy's execution-key row also
  // persisted when a job threw, so a re-run in the same window skips rather than
  // retrying into the same failure. Releasing on failure would turn the marker into
  // a mutex and let one hour run twice.
  const locks = await instance.store.listJobLocks();
  ok(locks.find((lock) => lock.jobName.startsWith("sports.monitoring.")), "the failed hour's marker persists");
});

test("the fixtures job combines per-provider outcomes into COMPLETED, PARTIAL and SKIPPED", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: SANDBOX.env } });
  t.after(() => instance.cleanup());

  // Legacy's combine(): no providers at all is SKIPPED — nothing to do is not a
  // failure (pinned on the default host in the runAll test); any FAILED provider
  // makes the job PARTIAL; all-COMPLETED is COMPLETED.
  const real = instance.app.sports;
  const failing = { ...real, sync: async () => ({ status: "FAILED", created: 0, errors: ["vendor 500"] }) };
  const partial = await cronOver(instance, { sports: failing }).run("fixtures");
  equal(partial.status, "PARTIAL", "a provider that failed makes the whole job PARTIAL");
  equal(partial.label, "FIXTURES_SYNC");
  equal(Object.values(partial.results).filter((status) => status === "FAILED").length, 1);

  // And the honest-provider-count summary (DV-25): one provider configured means the
  // summary says one provider — it never regresses to legacy's unconditional
  // "no providers configured" sentence, which would misread this audit forever.
  const healthy = await cronOver(instance).run("fixtures");
  equal(healthy.status, "COMPLETED");
  equal(healthy.summary, "1 provider(s) synced");
});

test("cleanup prunes operational health history at exactly ninety days, and nothing else picks the cutoff", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: SANDBOX.env } });
  t.after(() => instance.cleanup());

  // Spy on the repository's prune: the cron must derive the cutoff itself —
  // now minus ninety days, canonical UTC — and pass it through untouched.
  const nowMs = Date.parse("2026-10-12T03:30:00.000Z");
  const seen = [];
  const store = {
    ...instance.store,
    pruneSportsHealth: async (cutoff) => {
      seen.push(cutoff);
      return instance.store.pruneSportsHealth(cutoff);
    },
  };
  const cron = createSportsCronService({ sports: instance.app.sports, store, now: () => nowMs, actorId: "cron-test" });

  const outcome = await cron.run("cleanup", { date: "2026-10-12" });
  equal(outcome.status, "COMPLETED");
  deepEqual(seen, ["2026-07-14T03:30:00.000Z"], "the cutoff is exactly now minus ninety days, canonical UTC");

  const { events: audits } = await instance.store.listAuditEvents({ limit: 50, action: "sports.data.cleanup" });
  equal(audits.length, 1);
  equal(audits[0].details?.cutoff, "2026-07-14T03:30:00.000Z", "the audit names the cutoff that was applied");

  // The daily marker: one cleanup per date, skipped identically within the day.
  const again = await cron.run("cleanup", { date: "2026-10-12" });
  equal(again.status, "DUPLICATE_SKIPPED");
  equal(again.executionKey, "sports.cleanup.2026-10-12");
  deepEqual(seen, ["2026-07-14T03:30:00.000Z"], "the skipped run pruned nothing");
});

test("the CLI runs one job end-to-end, exits 0 on a skip, and refuses a bad name with exit 1", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "windels-sports-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = {
    ...process.env,
    NODE_ENV: "test",
    WF_APP_ROOT: REPOSITORY_ROOT,
    STORAGE_ADAPTER: "file",
    STORAGE_DIR: path.join(directory, "store"),
    UPLOAD_DIR: path.join(directory, "uploads"),
    SESSION_SECRET: "test-session-secret-with-at-least-32-bytes-long",
    SESSION_TTL_SECONDS: "1800",
    LOG_LEVEL: "silent",
    WINDELS_SPORTS_MODE: "SANDBOX",
    WINDELS_SPORTS_SANDBOX: "1",
  };
  const run = (args) => exec(process.execPath, [path.join(REPOSITORY_ROOT, "tools", "sports-jobs.mjs"), ...args], { env, cwd: REPOSITORY_ROOT });

  // One job, one JSON document, exit 0. This is the command the host's crontab line
  // actually executes, against a real store instance — not a test double.
  const first = await run(["--job", "cleanup", "--date", "2026-10-12", "--json", "--now", "2026-10-12T15:00:00Z"]);
  equal(first.stdout !== "", true, "the CLI writes its report to stdout");
  const report = JSON.parse(first.stdout);
  equal(report.ok, true);
  equal(report.adapter, "file");
  equal(report.failed.length, 0);
  equal(report.summary.cleanup.status, "COMPLETED");
  equal(report.summary.cleanup.cutoff, "2026-07-14T15:00:00.000Z");

  // A second process the same day: the marker the first process wrote survives it
  // (the file log is replayed on open), so the re-run is DUPLICATE_SKIPPED — and a
  // skip is a fact about the schedule, not a failure, so the exit code stays 0.
  const second = await run(["--job", "cleanup", "--date", "2026-10-12", "--json", "--now", "2026-10-12T16:00:00Z"]);
  const repeat = JSON.parse(second.stdout);
  equal(repeat.ok, true);
  equal(repeat.summary.cleanup.status, "DUPLICATE_SKIPPED", "the next process honours this window's marker");
  match(repeat.summary.cleanup.reason, /held by sports-cron#\d+ until 2026-10-13/);

  // An unknown job name is refused before any store is touched, with legacy's job
  // list on stderr and exit 1 — a cron line that cannot name its job must not sit
  // silently green.
  await rejects(() => run(["--job", "harvest", "--json"]), (error) => {
    equal(error.code, 1);
    match(error.stderr, /--job must be one of fixtures, odds, results, quality, ticket, settlement, performance, monitoring, cleanup/);
    return true;
  });
});
