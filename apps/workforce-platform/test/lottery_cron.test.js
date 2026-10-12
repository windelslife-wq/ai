/**
 * The lottery cron (row 15, slice 5): legacy's `LotteryCronService`, seven
 * jobs, execution-key idempotent on the lottery's OWN job-run table (not the
 * sports cron's window locks), CLI-only via `tools/lottery-jobs.mjs`.
 *
 * The pins that matter:
 *  - the queue of background system builds finally has its consumer;
 *  - auto post-draw checking touches OPEN tickets only, never the future-dated
 *    or the archived;
 *  - one backtest per strategy per day, baseline included, failures audited;
 *  - a default host fabricates nothing: every job answers with the honest
 *    nothing and the sweep is audited once as a whole.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { cookieFrom, createFileStoreApp } from "./helpers.js";
import { createLotteryCronService, LOTTERY_JOBS } from "../src/modules/lottery/cron.js";

const exec = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const DAY = "2026-10-13";

function cronOver(instance, { now = Date.parse("2026-10-13T05:30:00.000Z") } = {}) {
  return createLotteryCronService({
    lottery: instance.app.lottery,
    store: instance.store,
    now: typeof now === "function" ? now : () => now,
  });
}

async function adminHeaders(instance) {
  const login = await instance.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: "rootadmin", password: "Root administrator pass" } });
  return { cookie: cookieFrom(login), "x-csrf-token": login.json().csrfToken };
}

/** Twelve rule-valid lines — the statistics job validates shapes, so the seed data must be clean. */
const CLEAN_LINES = [
  [[5, 12, 23, 34, 49], [3, 11]], [[7, 13, 21, 35, 44], [1, 9]], [[9, 18, 27, 36, 45], [4, 10]],
  [[2, 11, 22, 33, 48], [5, 12]], [[3, 14, 25, 31, 47], [6, 8]], [[4, 15, 26, 37, 46], [7, 9]],
  [[6, 16, 24, 38, 50], [1, 12]], [[8, 17, 28, 39, 41], [2, 10]], [[10, 19, 29, 30, 43], [3, 12]],
  [[11, 20, 32, 40, 42], [4, 8]], [[6, 21, 29, 35, 47], [6, 11]], [[1, 8, 19, 31, 44], [2, 7]],
];

/** Deterministic VERIFIED draws; when withHit, the last one matches [1,2,3,4,5]/[2,5]. */
async function seedDraws(store, count, { withHit = false } = {}) {
  for (let i = 0; i < count; i += 1) {
    const day = i + 1;
    const [mains, stars] = CLEAN_LINES[i % CLEAN_LINES.length];
    const isHit = withHit && i === count - 1;
    await store.saveLotteryDraw({
      lotteryCode: "EUROMILLIONS",
      providerId: 1,
      externalId: `SIM-2026-01-${String(day).padStart(2, "0")}`,
      drawDate: `2026-01-${String(day).padStart(2, "0")}`,
      jackpot: "10000000.00",
      rollover: false,
      source: "sandbox-simulation",
      sourceTimestamp: `2026-01-${String(day).padStart(2, "0")}T21:00:00+00:00`,
      verificationStatus: "VERIFIED",
      payload: { main: isHit ? [1, 2, 3, 4, 5] : mains, stars: isHit ? [2, 5] : stars, source: "sandbox-simulation" },
    });
  }
}

test("seven jobs in legacy's order, refused names, factory guards, and the app wiring", async (t) => {
  assert.deepEqual([...LOTTERY_JOBS], ["sync", "health", "statistics", "systems", "tickets", "backtests", "cleanup"]);

  const instance = await createFileStoreApp({ configOverrides: { env: { WINDELS_LOTTERY_SANDBOX: "1" } } });
  t.after(() => instance.cleanup());
  const cron = cronOver(instance);
  assert.deepEqual([...cron.jobs], [...LOTTERY_JOBS], "the composed service publishes the same list");
  assert.ok(instance.app.lottery?.cron, "the app exposes the cron at lottery.cron");
  assert.ok(Object.isFrozen(cron), "the cron surface is frozen — no ad-hoc eighth job");

  await assert.rejects(() => cron.run("harvest"), /unknown lottery job: harvest/, "legacy's message for a name outside JOBS");

  // Boot-time guards are synchronous TypeErrors, not runtime rejections.
  assert.throws(() => createLotteryCronService({}), /requires the lottery service/);
  assert.throws(() => createLotteryCronService({ lottery: {} }), /requires a store/);
});

test("a default host runs all seven jobs and fabricates nothing; the sweep is audited; the day's sync is idempotent", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());
  const cron = cronOver(instance);

  const summary = await cron.runAll();
  assert.deepEqual(Object.keys(summary), [...LOTTERY_JOBS], "runAll answers for every job, in order");

  // No provider: the sync reports the honest nothing (legacy's SKIPPED_NO_PROVIDER),
  // and the job run row records it.
  assert.equal(summary.sync.status, "SKIPPED_NO_PROVIDER");
  // Health without a provider is OFFLINE (UNCONFIGURED maps there, not DEGRADED).
  assert.equal(summary.health.status, "OFFLINE");
  assert.equal(summary.health.stale, false);
  assert.equal(summary.statistics.status, "OK");
  assert.equal(summary.statistics.drawsChecked, 0);
  assert.equal(summary.statistics.violations, 0);
  assert.equal(summary.systems.status, "OK");
  assert.deepEqual(summary.systems, { status: "OK", built: 0, failed: 0, pending: 0 });
  assert.equal(summary.tickets.status, "OK");
  assert.equal(summary.tickets.note, "no stored VERIFIED draw");
  // Backtests with no history: the job itself answers OK — the four per-strategy
  // failures live in their job runs and the audit trail, exactly legacy's shape.
  assert.equal(summary.backtests.status, "OK");
  assert.deepEqual(summary.backtests, { status: "OK", ran: 0, skipped: 0 });
  assert.equal(summary.cleanup.status, "OK");
  assert.match(summary.cleanup.runCutoff, /^2026-07-\d{2}T05:30:00\.000Z$/, "the 90-day job-run cutoff, canonical UTC");
  assert.match(summary.cleanup.healthCutoff, /^2026-09-\d{2}T05:30:00\.000Z$/, "the 30-day health cutoff, canonical UTC");

  const failedRuns = await instance.store.listLotteryJobRuns("backtest", 10);
  assert.equal(failedRuns.length, 4, "one job run per strategy");
  assert.ok(failedRuns.every((r) => r.status === "FAILED"), "insufficient history fails each strategy's run");
  assert.ok(failedRuns.every((r) => r.execution_key.startsWith(`backtest:EUROMILLIONS:`)));
  const failedAudits = await instance.store.listAuditEvents({ limit: 100, action: "lottery.backtest.failed" });
  assert.equal(failedAudits.events.length, 4);

  // The whole sweep audited once, statuses and all.
  const cronAudits = await instance.store.listAuditEvents({ limit: 100, action: "lottery.cron.run" });
  assert.equal(cronAudits.events.length, 1);
  assert.match(cronAudits.events[0].details.message, /Lottery scheduled jobs: /);

  // The day's sync already has its execution key: the re-run is a no-op, not a double-write.
  const again = await cron.run("sync", DAY);
  assert.equal(again.status, "ALREADY_RUN");
  assert.equal(again.note, `sync already completed for ${DAY} (idempotent)`);
});

test("the systems job is the queue's consumer: queued build in, SYSTEM combination out, queue drained", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: { WINDELS_LOTTERY_SANDBOX: "1" } } });
  t.after(() => instance.cleanup());
  const headers = await adminHeaders(instance);

  // A pool above the synchronous limit queues idempotently (118,755 lines).
  const mains = Array.from({ length: 28 }, (_, i) => i + 1);
  const queued = await instance.app.inject({ method: "POST", url: "/api/v1/lottery/system-build", headers, payload: { mains, stars: [1, 2] } });
  assert.equal(queued.statusCode, 200, queued.body);
  assert.equal(queued.json().queued, true);
  assert.match(queued.json().note, /consumed by the lottery cron/, "the note no longer says nothing consumes the queue");

  const cron = cronOver(instance);
  const built = await cron.run("systems", DAY);
  assert.deepEqual(built, { status: "OK", built: 1, failed: 0, pending: 1 });

  const runs = await instance.store.listLotteryJobRuns("system", 10);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "OK");
  assert.equal(runs[0].records_created, 1, "one SYSTEM combination row per build");
  const combinations = await instance.store.listLotteryCombinations(5, 0);
  assert.equal(combinations.length, 1);
  assert.equal(combinations[0].mode, "SYSTEM");
  assert.equal(combinations[0].line_count, 98280, "the full line set is stored, not a sample");

  // Execution-key idempotent: the pool is built at most once.
  const drained = await cron.run("systems", DAY);
  assert.deepEqual(drained, { status: "OK", built: 0, failed: 0, pending: 0 });

  // A corrupt queue entry fails loudly and does not abort the sweep of the rest.
  await instance.store.startLotteryJobRun({ id: "corrupt-1", jobType: "system", executionKey: "system:EUROMILLIONS:corrupt", payload: "not-an-object" });
  const withCorrupt = await cron.run("systems", DAY);
  assert.deepEqual(withCorrupt, { status: "OK", built: 0, failed: 1, pending: 1 });
  const corruptRuns = await instance.store.listLotteryJobRuns("system", 10);
  const corrupt = corruptRuns.find((r) => r.id === "corrupt-1");
  assert.equal(corrupt.status, "FAILED");
  assert.deepEqual(corrupt.errors, ["invalid system payload"]);
});

test("the tickets job checks OPEN tickets against the latest VERIFIED draw and leaves the rest alone", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: { WINDELS_LOTTERY_SANDBOX: "1" } } });
  t.after(() => instance.cleanup());
  const headers = await adminHeaders(instance);
  await seedDraws(instance.store, 15, { withHit: true });

  const make = async (name, drawDate) => {
    const made = await instance.app.inject({
      method: "POST", url: "/api/v1/lottery/tickets", headers,
      payload: { name, lines: [{ mains: [1, 2, 3, 4, 5], stars: [2, 5] }], drawDate },
    });
    assert.equal(made.statusCode, 200, made.body);
    return made.json().ticket.id;
  };
  await make("past", "2026-01-15");   // draw date reached → checked
  await make("future", "2026-06-01"); // future-dated → waits for its draw
  await make("toArchive", "2026-01-15");
  await instance.app.inject({ method: "POST", url: "/api/v1/lottery/tickets/3/delete", headers, payload: {} });

  const cron = cronOver(instance);
  const result = await cron.run("tickets", DAY);
  assert.deepEqual(result, { status: "OK", attempted: 1, checked: 1 });

  const first = await instance.store.findLotteryTicket(1, null);
  assert.equal(first.status, "CHECKED");
  assert.equal(first.result.lines[0].prizeTier, "TIER_1 (5 mains + 2 stars)");
  const future = await instance.store.findLotteryTicket(2, null);
  assert.equal(future.status, "OPEN", "a future-dated ticket waits for its draw");
  const archived = await instance.store.findLotteryTicket(3, null);
  assert.equal(archived.status, "ARCHIVED", "an archived ticket is never re-checked");

  // Idempotent by status: CHECKED tickets are not re-attempted.
  const rerun = await cron.run("tickets", DAY);
  assert.deepEqual(rerun, { status: "OK", attempted: 0, checked: 0 });
});

test("the backtests job runs one backtest per strategy per day and skips the same day on a re-run", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: { WINDELS_LOTTERY_SANDBOX: "1" } } });
  t.after(() => instance.cleanup());
  await seedDraws(instance.store, 15);
  const cron = cronOver(instance);

  const first = await cron.run("backtests", DAY);
  assert.deepEqual(first, { status: "OK", ran: 4, skipped: 0 });
  const saved = await instance.store.listLotteryBacktests(10);
  assert.deepEqual(
    saved.map((row) => row.strategy).sort(),
    ["ANTI_POPULAR", "BALANCED_PROFILE", "HISTORICAL_FREQ", "RANDOM_BASELINE"],
    "the baseline ran alongside every strategy",
  );

  const rerun = await cron.run("backtests", DAY);
  assert.deepEqual(rerun, { status: "OK", ran: 0, skipped: 4 }, "the same day never duplicates rows or job runs");
  assert.equal((await instance.store.listLotteryBacktests(10)).length, 4);

  // A different day runs again — the date is part of the key.
  const nextDay = await cron.run("backtests", "2026-10-14");
  assert.deepEqual(nextDay, { status: "OK", ran: 4, skipped: 0 });
  assert.equal((await instance.store.listLotteryBacktests(10)).length, 8);
});

test("the statistics job flags a stored draw that violates the rules, audits it, and corrects nothing", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: { WINDELS_LOTTERY_SANDBOX: "1" } } });
  t.after(() => instance.cleanup());
  await seedDraws(instance.store, 12);
  // A hand-corrupted row: the ingestion path could never store this.
  await instance.store.saveLotteryDraw({
    lotteryCode: "EUROMILLIONS",
    providerId: 1,
    externalId: "CORRUPT-2026-01-16",
    drawDate: "2026-01-16",
    jackpot: null,
    rollover: false,
    source: "hand-edit",
    sourceTimestamp: "2026-01-16T21:00:00+00:00",
    verificationStatus: "VERIFIED",
    payload: { main: [1, 1, 2, 3, 99], stars: [2, 5], source: "hand-edit" },
  });

  const cron = cronOver(instance);
  const result = await cron.run("statistics", DAY);
  assert.equal(result.status, "OK");
  assert.equal(result.drawsChecked, 13);
  assert.equal(result.violations, 1);
  assert.equal(result.detail[0].externalId, "CORRUPT-2026-01-16");
  const audits = await instance.store.listAuditEvents({ limit: 100, action: "lottery.integrity.violations" });
  assert.equal(audits.events.length, 1, "the violation is audited for manual correction");
  // And nothing was rewritten: the corrupt row is still exactly as stored.
  const corrupt = await instance.store.listLotteryDraws({ lotteryCode: "EUROMILLIONS" }, 100);
  assert.ok(corrupt.some((d) => d.external_id === "CORRUPT-2026-01-16" && d.verification_status === "VERIFIED"));
});

test("the health job degrades when the last successful sync is older than eight days", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: { WINDELS_LOTTERY_SANDBOX: "1" } } });
  t.after(() => instance.cleanup());
  // The provider's OWN code — the service's providerHealth looks the row up by
  // chosenProvider.id(), which for the sandbox is "sandbox-sim".
  const providerId = (await instance.store.ensureLotteryProvider("sandbox-sim", "Sandbox simulation")).id ?? 1;
  const pid = Number(providerId) || 1;
  const now = Date.parse("2026-10-13T05:30:00.000Z");
  await instance.store.saveLotteryHealth(pid, {
    status: "ONLINE", responseMs: 5, recordsReceived: 10, invalidRecords: 0,
    lastSuccessAt: new Date(now - 9 * 86_400_000).toISOString(), lastFailureAt: null, lastDrawRetrieved: null, synthetic: 1,
  });
  const cron = cronOver(instance, { now });
  const stale = await cron.run("health", DAY);
  assert.equal(stale.status, "DEGRADED", "ONLINE but 9 days stale reads DEGRADED");
  assert.equal(stale.stale, true);
});

test("cleanup prunes job runs and health observations older than the cutoffs", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: { WINDELS_LOTTERY_SANDBOX: "1" } } });
  t.after(() => instance.cleanup());
  await instance.store.startLotteryJobRun({ id: "old-run", jobType: "sync", executionKey: "sync:EUROMILLIONS:2026-01-01" });
  const providerId = 1;
  await instance.store.saveLotteryHealth(providerId, {
    status: "ONLINE", responseMs: 1, recordsReceived: 0, invalidRecords: 0,
    lastSuccessAt: "2026-01-01T00:00:00.000Z", lastFailureAt: null, lastDrawRetrieved: null, synthetic: 0,
  });

  // Running "now" = 2027: everything from 2026 is older than both cutoffs.
  const cron = cronOver(instance, { now: Date.parse("2027-06-01T00:00:00.000Z") });
  const result = await cron.run("cleanup", "2027-06-01");
  assert.equal(result.status, "OK");
  assert.equal(await instance.store.findLotteryJobRunByKey("sync:EUROMILLIONS:2026-01-01"), null, "the old job run is pruned");
  const health = await instance.store.listLotteryHealth(providerId, 10);
  assert.equal(health.length, 0, "the old observation is pruned");
});

test("the CLI runs one job end-to-end, refuses a bad name with exit 1, and reports FAILED honestly", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "windels-lottery-cli-"));
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
    WINDELS_LOTTERY_SANDBOX: "1",
  };
  const run = (args) => exec(process.execPath, [path.join(REPOSITORY_ROOT, "tools", "lottery-jobs.mjs"), ...args], { env, cwd: REPOSITORY_ROOT });

  // One job, one JSON document, exit 0 — the command the host's crontab line executes.
  const first = await run(["--job", "statistics", "--date", DAY, "--json", "--now", "2026-10-13T05:30:00Z"]);
  assert.ok(first.stdout !== "", "the CLI writes its report to stdout");
  const report = JSON.parse(first.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.adapter, "file");
  assert.deepEqual(report.failed, []);
  assert.equal(report.summary.statistics.status, "OK");

  // An unknown job is refused before any store is touched, with the job list on stderr.
  await assert.rejects(() => run(["--job", "harvest", "--json"]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /--job must be one of sync, health, statistics, systems, tickets, backtests, cleanup/);
    return true;
  });

  // On a host with no draws, the backtests job is OK while its four strategy
  // runs FAILED — the summary reports what happened, exit code stays 0 (the
  // per-strategy failures are facts about an empty host, audited in the store).
  const backtests = await run(["--job", "backtests", "--date", DAY, "--json", "--now", "2026-10-13T06:00:00Z"]);
  const bt = JSON.parse(backtests.stdout);
  assert.equal(bt.ok, true);
  assert.deepEqual(bt.summary.backtests, { status: "OK", ran: 0, skipped: 0 });
});
