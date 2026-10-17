/**
 * Row 5's retention policy — one window per table, one operator command.
 *
 * `test/retention.test.js` covers R-27 (analysis runs) and stays the record for
 * that table. This file covers the three windows row 5 added and the guards that
 * make each of them safe:
 *
 *  - `wf_audit_events` — DATETIME(3), off by default, no route can delete a row;
 *  - `wf_notifications` — read rows only, canonical ISO text only;
 *  - `wf_backtests` — never the newest report for a (strategy, version), so the
 *    BACKTESTED and VALIDATED gates cannot be emptied by retention.
 *
 * The SQL side is pinned against a fake pool because there is no MySQL in this
 * sandbox; the statements, bound values and batching loop are asserted as text
 * and as call sequences. The file side is real: a durable store on disk, reopened
 * after a prune to prove the write-ahead log replays the deletions. The generalized
 * CLI is driven as a subprocess, so flags, output and exit codes are an operator's.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createAccountRepository } from "../src/db/account-repository.js";
import { createNotificationRepository } from "../src/db/notification-repository.js";
import { createStrategyRepository } from "../src/db/strategy-repository.js";
import { createStore } from "../src/db/store.js";
import { createFileStore } from "../src/persistence/file-store.js";
import { REPOSITORY_METHODS } from "../src/persistence/contract.js";
import { pruneRetention, RETENTION_TARGETS } from "../tools/prune-retention.mjs";
import { retentionCutoff } from "../tools/prune-analysis-runs.mjs";
import { testConfig } from "./helpers.js";

const execFileAsync = promisify(execFile);
const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "prune-retention.mjs");
const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-10-17T12:00:00.000Z");

const at = (ageDays) => new Date(NOW - ageDays * DAY_MS).toISOString();
const cutoff90 = () => retentionCutoff({ retentionDays: 90, now: NOW });

async function tempDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function fakePool({ matching = 0, oldest = null, newest = null, bytes = 0, affected = [] } = {}) {
  const calls = [];
  const deletes = [...affected];
  return {
    calls,
    async execute(sql, values = []) {
      calls.push({ kind: "execute", sql, values });
      return [[{ total: matching, oldest, newest, bytes }], []];
    },
    async query(sql, values = []) {
      calls.push({ kind: "query", sql, values });
      return [{ affectedRows: deletes.length ? deletes.shift() : 0 }];
    },
  };
}

// -------------------------------------------------------------------- the policy

test("RETENTION the policy is four named windows and two rows are off by default", () => {
  const config = testConfig();
  assert.deepEqual(config.retention, {
    analysisDays: 90, auditDays: 0, notificationDays: 0, backtestDays: 0,
  });
  assert.equal(config.analysis.retentionDays, config.retention.analysisDays, "one value, two readers");

  // The contract owns the methods, so an adapter cannot ship without them.
  for (const name of ["pruneAuditEvents", "pruneNotifications", "pruneBacktests", "pruneAnalysisRuns"]) {
    assert.ok(REPOSITORY_METHODS.includes(name), `${name} must be part of the repository contract`);
  }
  assert.equal(REPOSITORY_METHODS.length, 210);

  // Every target names the environment variable that turns it on — that name is
  // what the CLI prints when the window is off, so a typo would be a dead end.
  assert.deepEqual(RETENTION_TARGETS.map((target) => target.env).sort(), [
    "ANALYSIS_RETENTION_DAYS", "AUDIT_RETENTION_DAYS", "BACKTEST_RETENTION_DAYS", "NOTIFICATION_RETENTION_DAYS",
  ]);
});

// ------------------------------------------------------------------- file store

test("RETENTION notifications: only read rows inside the window are deleted", async (t) => {
  const directory = await tempDir("wf-retention-notify-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: true });
  try {
    const rows = [
      { title: "old read", ageDays: 200, read: true },
      { title: "old unread", ageDays: 200, read: false },
      { title: "recent read", ageDays: 10, read: true },
      { title: "boundary read", ageDays: 90, read: true },
      { title: "malformed read", ageDays: 200, read: true, createdAt: "11/07/2026" },
    ];
    for (const [index, row] of rows.entries()) {
      await store.createNotification({
        userId: null,
        type: "KILL_SWITCH",
        severity: "warning",
        title: row.title,
        detail: { index },
        dedupeKey: `key-${index}`,
        createdAt: row.createdAt ?? at(row.ageDays),
      });
      if (row.read) await store.markNotificationRead(index + 1, null, at(row.ageDays - 1));
    }

    const dry = await store.pruneNotifications(cutoff90(), { dryRun: true });
    assert.equal(dry.matching, 1, "one old, read row is eligible; the unread one is not, nor the recent, the boundary or the malformed");
    assert.equal(dry.deleted, 0);
    assert.equal(dry.oldest, at(200));
    assert.equal(dry.bytes > 0, true);

    const applied = await store.pruneNotifications(cutoff90());
    assert.equal(applied.deleted, 1);
    assert.equal((await store.stats()).notifications, 4);
    const titles = (await store.listNotifications(null, { limit: 10 })).map((row) => row.title).sort();
    assert.deepEqual(titles, ["boundary read", "malformed read", "old unread", "recent read"]);

    // The unread row still suppresses a duplicate publish — the rule pruning must
    // not be allowed to break.
    assert.equal(await store.hasUnreadNotificationDedupe("key-1"), true);
    assert.equal(await store.hasUnreadNotificationDedupe("key-0"), false, "the read row's dedupe key went with the row");
  } finally {
    await store.close();
  }
});

test("RETENTION backtests: the newest report per (strategy, version) survives any window", async (t) => {
  const directory = await tempDir("wf-retention-backtest-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: true });
  const backtest = (id, strategy, version, ageDays, createdAt = null) => ({
    id,
    created_at: createdAt ?? at(ageDays),
    request: { strategyId: strategy, strategyVersion: version, symbol: "EURUSD", timeframe: "1h" },
    dataProvenance: { synthetic: false, candles: 500 },
    metrics: { trades: 10 },
    warnings: [],
    payload: { id, filler: "x".repeat(200) },
  });
  try {
    await store.saveBacktest(backtest("a-old", "s-1", "v1", 300));
    await store.saveBacktest(backtest("a-mid", "s-1", "v1", 200));
    await store.saveBacktest(backtest("a-new", "s-1", "v1", 100));
    await store.saveBacktest(backtest("b-only", "s-2", "v1", 250));
    await store.saveBacktest(backtest("c-bad", "s-3", "v1", 300, "11/07/2026"));

    const dry = await store.pruneBacktests(cutoff90(), { dryRun: true });
    assert.equal(dry.matching, 2, "a-old and a-mid are outside the window and are not their pair's newest");
    assert.equal(dry.deleted, 0);
    assert.equal(dry.bytes > 0, true);

    const applied = await store.pruneBacktests(cutoff90());
    assert.equal(applied.deleted, 2);
    assert.equal((await store.stats()).backtests, 3);

    // The gate the guard exists for: s-1 still has evidence, and its LATEST report
    // is the same row it was before the prune.
    assert.equal(await store.countStrategyBacktests("s-1", "v1"), 1);
    assert.equal((await store.latestStrategyBacktest("s-1", "v1")).id, "a-new");
    assert.equal(await store.countStrategyBacktests("s-2", "v1"), 1, "an only report is never pruned, however old");
    assert.equal(await store.latestStrategyBacktest("s-2", "v1").then((row) => row.id), "b-only");
    assert.equal(await store.countStrategyBacktests("s-3", "v1"), 1, "a malformed timestamp is never compared as text");
  } finally {
    await store.close();
  }

  // Reopened from disk: the deletions replay, and the protected rows are still there.
  const reopened = await createFileStore({ dir: path.join(directory, "store"), syncWrites: true });
  try {
    assert.equal((await reopened.stats()).backtests, 3);
    assert.equal(await reopened.countStrategyBacktests("s-1", "v1"), 1);
    assert.equal(await reopened.findBacktest("a-old"), null);
  } finally {
    await reopened.close();
  }
});

test("RETENTION audit: a future-dated window deletes, an empty window does not, and the log replays", async (t) => {
  const directory = await tempDir("wf-retention-audit-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: true });
  try {
    for (const action of ["AUTH_LOGIN", "AUTH_LOGOUT", "ADMIN_TEST_EMAIL"]) {
      await store.recordAudit({ actorId: null, action, entityType: "test", entityId: "1", details: { action } });
    }

    const nothing = await store.pruneAuditEvents(at(30), { dryRun: true });
    assert.equal(nothing.matching, 0, "a recordAudit row is never older than a window that has not elapsed");

    // `--now` in the future is how a test (or an operator with a fixed clock)
    // reaches every stored row; the predicate is still strictly "older than".
    const cutoff = at(-30);
    const dry = await store.pruneAuditEvents(cutoff, { dryRun: true });
    assert.equal(dry.matching, 3);
    assert.equal(dry.deleted, 0);
    assert.equal((await store.stats()).audit, 3, "measuring changed nothing");
    assert.ok(dry.bytes > 0);

    const applied = await store.pruneAuditEvents(cutoff);
    assert.equal(applied.deleted, 3);
    assert.equal((await store.stats()).audit, 0);
    assert.equal((await store.listAuditEvents({})).total, 0);
  } finally {
    await store.close();
  }

  const reopened = await createFileStore({ dir: path.join(directory, "store"), syncWrites: true });
  try {
    assert.equal((await reopened.stats()).audit, 0, "the write-ahead log replays the audit prune");
  } finally {
    await reopened.close();
  }
});

test("RETENTION both adapters refuse a non-canonical cutoff before touching storage", async (t) => {
  const directory = await tempDir("wf-retention-refuse-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: false });
  try {
    await store.recordAudit({ actorId: null, action: "X", details: {} });
    for (const method of ["pruneAuditEvents", "pruneNotifications", "pruneBacktests"]) {
      await assert.rejects(() => store[method]("2026-07-11T12:00:00+00:00"), /ISO-8601 UTC/, method);
    }
    assert.equal((await store.stats()).audit, 1, "a refused cutoff deletes nothing");
  } finally {
    await store.close();
  }
});

// -------------------------------------------------------------------- SQL store

test("RETENTION SQL audit: a DATETIME cutoff is bound as a Date and deletes in ordered batches", async () => {
  const pool = fakePool({ matching: 1200, oldest: "2026-01-02 00:00:00.000", newest: "2026-07-10 00:00:00.000", bytes: 9000, affected: [500, 500, 200] });
  const report = await createAccountRepository(pool).pruneAuditEvents(cutoff90(), { batchSize: 500 });
  assert.deepEqual(
    { matching: report.matching, deleted: report.deleted, batches: report.batches, exhausted: report.exhausted, dryRun: report.dryRun },
    { matching: 1200, deleted: 1200, batches: 3, exhausted: true, dryRun: false },
  );
  assert.equal(pool.calls.length, 4, "one measurement query plus three deletes");
  assert.match(pool.calls[0].sql, /FROM wf_audit_events\s+WHERE created_at < \?/);
  assert.ok(pool.calls[0].values[0] instanceof Date, "DATETIME(3) is compared by the server, not as text");
  assert.equal(pool.calls[0].values[0].toISOString(), cutoff90());
  for (const call of pool.calls.slice(1)) {
    assert.match(call.sql, /DELETE FROM wf_audit_events\s+WHERE created_at < \?\s+ORDER BY created_at ASC, id ASC\s+LIMIT 500/);
    assert.ok(call.values[0] instanceof Date);
  }

  const dry = fakePool({ matching: 4 });
  const dryReport = await createAccountRepository(dry).pruneAuditEvents(cutoff90(), { dryRun: true });
  assert.equal(dryReport.deleted, 0);
  assert.equal(dry.calls.length, 1);
  assert.equal(dry.calls.some((call) => /DELETE/.test(call.sql)), false);
});

test("RETENTION SQL notifications: read rows only, canonical ISO text only, and the cutoff is bound", async () => {
  const pool = fakePool({ matching: 3, bytes: 512, affected: [3] });
  const report = await createNotificationRepository(pool).pruneNotifications(cutoff90());
  assert.equal(report.deleted, 3);
  assert.equal(pool.calls.length, 2);
  assert.match(pool.calls[0].sql, /read_at IS NOT NULL AND created_at < \? AND created_at LIKE \?/);
  assert.deepEqual(pool.calls[0].values, [cutoff90(), "____-__-__T__:__:__%"]);
  assert.match(pool.calls[1].sql, /DELETE FROM wf_notifications\s+WHERE read_at IS NOT NULL AND created_at < \? AND created_at LIKE \?\s+ORDER BY created_at ASC, id ASC\s+LIMIT 500/);
  assert.deepEqual(pool.calls[1].values, pool.calls[0].values);
});

test("RETENTION SQL backtests: the newest-per-strategy guard is in both the measurement and the delete", async () => {
  const pool = fakePool({ matching: 9, oldest: "2026-01-01T00:00:00.000Z", newest: "2026-06-01T00:00:00.000Z", bytes: 1_048_576, affected: [9] });
  const report = await createStrategyRepository(pool).pruneBacktests(cutoff90());
  assert.equal(report.deleted, 9);
  assert.equal(report.bytes, 1_048_576);

  assert.match(pool.calls[0].sql, /COALESCE\(SUM\(LENGTH\(payload\) \+ LENGTH\(metrics\) \+ LENGTH\(warnings\)\), 0\) AS bytes/);
  for (const call of [pool.calls[0], pool.calls[1]]) {
    assert.match(call.sql, /id NOT IN \(/, "a delete without the guard could empty a lifecycle gate");
    assert.match(call.sql, /MAX\(created_at\) AS newest/);
    assert.match(call.sql, /created_at LIKE \?/);
  }
  assert.match(pool.calls[1].sql, /ORDER BY created_at ASC, id ASC\s+LIMIT 500/);
  assert.deepEqual(pool.calls[0].values, [cutoff90(), "____-__-__T__:__:__%"]);
});

test("RETENTION the SQL adapter clamps its work and is reachable through the assembled store", async () => {
  const capped = fakePool({ matching: 100_000, affected: [100, 100] });
  const report = await createNotificationRepository(capped).pruneNotifications(cutoff90(), { batchSize: 100, maxBatches: 2 });
  assert.equal(report.deleted, 200);
  assert.equal(report.exhausted, false, "the ceiling was reached with rows still matching");

  const huge = fakePool({ matching: 10, affected: [10] });
  await createStrategyRepository(huge).pruneBacktests(cutoff90(), { batchSize: 999_999 });
  assert.match(huge.calls[1].sql, /LIMIT 5000$/);

  const store = createStore(fakePool({ matching: 1, affected: [1] }), { logger: { info() {}, warn() {}, error() {} } });
  for (const method of ["pruneAuditEvents", "pruneNotifications", "pruneBacktests"]) {
    assert.equal(typeof store[method], "function", `${method} must be composed into the public store`);
  }
});

// -------------------------------------------------------------------------- CLI

async function cli(args, { env = {}, cwd } = {}) {
  const directory = cwd || await tempDir("wf-retention-cli-");
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TOOL, ...args], {
      cwd: path.join(path.dirname(TOOL), ".."),
      env: {
        ...process.env,
        NODE_ENV: "test",
        STORAGE_ADAPTER: "file",
        STORAGE_DIR: path.join(directory, "store"),
        UPLOAD_DIR: path.join(directory, "uploads"),
        SESSION_SECRET: "test-session-secret-with-at-least-32-bytes-long",
        LOG_LEVEL: "silent",
        ...env,
      },
    });
    return { stdout, stderr, code: 0, directory };
  } catch (error) {
    return { stdout: error.stdout || "", stderr: error.stderr || "", code: error.code ?? 1, directory };
  }
}

/** Seed one old read notification, one unread one and one old backtest pair. */
async function seed(directory) {
  const store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: true });
  try {
    for (const [index, row] of [
      { title: "old read", ageDays: 200, read: true },
      { title: "old unread", ageDays: 200, read: false },
    ].entries()) {
      await store.createNotification({
        userId: null, type: "KILL_SWITCH", severity: "warning", title: row.title,
        detail: {}, dedupeKey: `seed-${index}`, createdAt: at(row.ageDays),
      });
      if (row.read) await store.markNotificationRead(index + 1, null, at(190));
    }
    const backtest = (id, ageDays) => ({
      id,
      created_at: at(ageDays),
      request: { strategyId: "s-1", strategyVersion: "v1", symbol: "EURUSD", timeframe: "1h" },
      dataProvenance: { synthetic: false, candles: 100 },
      metrics: {}, warnings: [], payload: { id },
    });
    await store.saveBacktest(backtest("old", 200));
    await store.saveBacktest(backtest("newest", 100));
    await store.recordAudit({ actorId: null, action: "SEEDED", details: {} });
  } finally {
    await store.close();
  }
  return directory;
}

test("RETENTION CLI skips a window that is off and says which variable would turn it on", async (t) => {
  const directory = await seed(await tempDir("wf-retention-off-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const audit = await cli(["--target", "audit", "--now", new Date(NOW).toISOString()], { cwd: directory });
  assert.equal(audit.code, 0, audit.stderr);
  assert.match(audit.stdout, /^DRY RUN — adapter file, 1 table\(s\), clock 2026-10-17T12:00:00\.000Z/);
  assert.match(audit.stdout, /audit\s+retention off — AUDIT_RETENTION_DAYS=0 keeps audit events forever; pass --audit-days N to prune anyway/);

  // The window is still selectable, and the guard still applies.
  const backtests = await cli(["--target", "backtests", "--backtest-days", "150", "--now", new Date(NOW).toISOString()], { cwd: directory });
  assert.match(backtests.stdout, /backtests\s+keep 150 day\(s\) — 1 backtest reports older than 2026-05-20T12:00:00\.000Z/);
  assert.match(backtests.stdout, /deleted  : 0 \(dry run — re-run with --apply to delete these 1\)/);

  const applied = await cli(["--target", "backtests", "--backtest-days", "150", "--apply", "--now", new Date(NOW).toISOString()], { cwd: directory });
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(applied.stdout, /^APPLIED —/);
  assert.match(applied.stdout, /deleted  : 1 in 1 batch\(es\)/);

  // The oldest report is gone; the newest for the pair is still there, so the
  // store answers the gate the same way it did before the prune.
  const store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: true });
  try {
    assert.equal(await store.countStrategyBacktests("s-1", "v1"), 1);
    assert.equal((await store.latestStrategyBacktest("s-1", "v1")).id, "newest");
    assert.equal((await store.stats()).notifications, 2, "a window that was not selected touched nothing");
  } finally {
    await store.close();
  }
});

test("RETENTION CLI applies only the tables it was asked for, and defaults to every window", async (t) => {
  const directory = await seed(await tempDir("wf-retention-targets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = new Date(NOW).toISOString();

  // One target, one window, one deletion. The read notification goes; the unread
  // one stays; no backtest and no audit row is touched.
  const notifications = await cli([
    "--target", "notifications", "--notification-days", "150", "--apply", "--now", now,
  ], { cwd: directory });
  assert.equal(notifications.code, 0, notifications.stderr);
  assert.match(notifications.stdout, /notifications\s+keep 150 day\(s\) — 1 read notifications older/);
  assert.match(notifications.stdout, /deleted  : 1 in 1 batch/);

  let store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: true });
  try {
    assert.equal((await store.stats()).notifications, 1);
    assert.equal((await store.stats()).backtests, 2, "a target not named was not pruned");
    assert.equal((await store.stats()).audit, 1);
  } finally {
    await store.close();
  }

  // A fixed clock in the future reaches the audit row; the backup reminder and the
  // security-evidence note are printed for an apply that deletes audit events.
  const audit = await cli(["--target", "audit", "--audit-days", "1", "--apply", "--now", "2030-01-01T00:00:00.000Z"], { cwd: directory });
  assert.equal(audit.code, 0, audit.stderr);
  assert.match(audit.stdout, /Note: the audit trail is security evidence\. A deleted event cannot be re-attributed\./);

  store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: true });
  try {
    assert.equal((await store.stats()).audit, 0);
    assert.equal((await store.stats()).backtests, 2);
  } finally {
    await store.close();
  }

  // No --target means all four windows; the JSON report names every one of them,
  // including the two that are off, so a cron log is a complete record.
  const all = await cli(["--json", "--now", now], { cwd: directory });
  assert.equal(all.code, 0, all.stderr);
  const report = JSON.parse(all.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.apply, false);
  assert.equal(report.dryRun, true);
  assert.deepEqual(Object.keys(report.targets).sort(), ["analysis", "audit", "backtests", "notifications"]);
  assert.equal(report.targets.audit.skipped, "AUDIT_RETENTION_DAYS=0 keeps audit events forever; pass --audit-days N to prune anyway");
  assert.equal(report.targets.backtests.retentionDays, 0);
  assert.equal(report.targets.analysis.retentionDays, 90);
  assert.deepEqual(Object.keys(report.totals).sort(), ["bytes", "deleted", "matching"]);
});

test("RETENTION CLI refuses ambiguous input with exit 1 and one JSON document", async (t) => {
  const directory = await seed(await tempDir("wf-retention-refuse-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const cases = [
    { args: ["--nope"], message: /unknown flag --nope/ },
    { args: ["--target", "users"], message: /unknown retention target --target users/ },
    { args: ["--days", "30"], message: /--days needs exactly one --target/ },
    { args: ["--target", "audit", "--days", "-5"], message: /--days must be 0 or a positive number of days/ },
    { args: ["--audit-days", "soon"], message: /--audit-days must be 0 or a positive number of days/ },
    { args: ["--batch", "99999"], message: /--batch must be an integer between 1 and 5000/ },
    { args: ["--now", "garbage"], message: /--now must be an ISO-8601 instant/ },
  ];
  for (const { args, message } of cases) {
    const result = await cli(args, { cwd: directory });
    assert.equal(result.code, 1, `${args.join(" ")} must exit 1`);
    assert.match(result.stderr, message, `${args.join(" ")} must say why`);
    assert.match(result.stderr, /Usage: node tools\/prune-retention\.mjs/);
  }

  const asJson = await cli(["--json", "--target", "audit", "--days", "-5"], { cwd: directory });
  assert.equal(asJson.code, 1);
  assert.deepEqual(JSON.parse(asJson.stdout), { ok: false, error: "--days must be 0 or a positive number of days" });

  // `--days` is the shorthand for one target and works with --target.
  const one = await cli(["--json", "--target", "notifications", "--days", "150"], { cwd: directory });
  assert.equal(one.code, 0, one.stderr);
  assert.equal(JSON.parse(one.stdout).targets.notifications.retentionDays, 150);
});

test("RETENTION pruneRetention is callable without a subprocess, and refuses a target the store cannot serve", async (t) => {
  const directory = await seed(await tempDir("wf-retention-lib-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: true });
  try {
    const config = testConfig();
    const report = await pruneRetention({ store, adapter: "file", config, targets: ["backtests"], now: NOW });
    assert.equal(report.targets.backtests.retentionDays, 0, "the library reads the same config the CLI does");
    assert.equal(report.targets.backtests.skipped.startsWith("BACKTEST_RETENTION_DAYS=0"), true);

    await assert.rejects(() => pruneRetention({ store, adapter: "file", config, targets: ["users"], now: NOW }), /unknown retention target/);
    await assert.rejects(
      () => pruneRetention({ store: {}, adapter: "file", config, targets: ["audit"], overrides: new Map([["audit", 30]]), now: NOW }),
      /does not implement pruneAuditEvents/,
    );
  } finally {
    await store.close();
  }
});
