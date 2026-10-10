/**
 * Analysis-run retention (risk R-27) — the repository method on both adapters, the
 * cutoff contract they share, and the operator CLI that drives it.
 *
 * Nothing else in the platform deletes an analysis run, and the payload column is a
 * LONGTEXT copy of a whole run, so this is the only thing standing between the
 * table and unbounded growth on a shared host.
 *
 * The SQL side is pinned against a fake pool: there is no MySQL in this sandbox, so
 * the statements, their bound values and the batching loop are asserted as text and
 * as call sequences rather than executed. The file side is real — a durable store on
 * disk, reopened after the prune to prove the write-ahead log replays the deletions.
 * The CLI is driven as a subprocess, so its flags, output and exit codes are the ones
 * an operator would actually get.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { assertIsoCutoff, REPOSITORY_METHODS } from "../src/persistence/contract.js";
import { createFileStore } from "../src/persistence/file-store.js";
import { createStore } from "../src/db/store.js";
import { createAnalysisRepository } from "../src/db/analysis-repository.js";
import { humanBytes, pruneAnalysisRuns, retentionCutoff } from "../tools/prune-analysis-runs.mjs";
import { testConfig } from "./helpers.js";

const execFileAsync = promisify(execFile);
const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "prune-analysis-runs.mjs");
const DAY_MS = 86_400_000;
// A fixed clock: retention arithmetic is the thing under test, and a test that
// compares against `Date.now()` would drift into flakiness near a day boundary.
const NOW = Date.parse("2026-10-09T12:00:00.000Z");

async function tempDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function run({ id, ageDays, symbol = "EURUSD", filler = 0 }) {
  return {
    id,
    symbol,
    timeframe: "1h",
    bias: "BULLISH",
    confidence: 0.7123,
    regime: "TRENDING_UP",
    recommendation: "BUY",
    synthetic: false,
    source: "binance",
    completedAt: new Date(NOW - ageDays * DAY_MS).toISOString(),
    payload: { id, symbol, filler: "x".repeat(filler) },
  };
}

const FIXTURE = [
  run({ id: "11111111-1111-4111-8111-111111111111", ageDays: 200, symbol: "EURUSD", filler: 400 }),
  run({ id: "22222222-2222-4222-8222-222222222222", ageDays: 120, symbol: "BTCUSDT", filler: 200 }),
  run({ id: "33333333-3333-4333-8333-333333333333", ageDays: 91, symbol: "XAUUSD" }),
  run({ id: "44444444-4444-4444-8444-444444444444", ageDays: 89, symbol: "EURUSD" }),
  run({ id: "55555555-5555-4555-8555-555555555555", ageDays: 1, symbol: "ETHUSDT" }),
];

/** A pool that records every statement and answers with a scripted row count. */
function fakePool({ matching = 0, oldest = null, newest = null, bytes = 0, affected = [] } = {}) {
  const calls = [];
  const deletes = affected.length ? [...affected] : [];
  return {
    calls,
    async execute(sql, values = []) {
      calls.push({ kind: "execute", sql, values });
      return [[{ total: matching, oldest, newest, payload_bytes: bytes }], []];
    },
    async query(sql, values = []) {
      calls.push({ kind: "query", sql, values });
      const rows = deletes.length ? deletes.shift() : 0;
      return [{ affectedRows: rows }];
    },
  };
}

// ------------------------------------------------------------------- the contract

test("R-27 the retention cutoff must be a canonical ISO-8601 UTC instant", () => {
  assert.equal(assertIsoCutoff("2026-07-11T12:00:00.000Z"), "2026-07-11T12:00:00.000Z");
  assert.equal(assertIsoCutoff("2026-07-11T12:00:00Z"), "2026-07-11T12:00:00Z", "second precision is canonical too");
  assert.equal(assertIsoCutoff("  2026-07-11T12:00:00.000Z  "), "2026-07-11T12:00:00.000Z", "surrounding space is trimmed");

  // `completed_at` is VARCHAR(32) compared as text, and text order is only
  // chronological while every writer uses one format. Migration 005 says so; a
  // `+00:00` offset sorts after the `Z` form of the same instant, so accepting it
  // would delete the wrong rows rather than fail loudly.
  for (const bad of [
    "2026-07-11T12:00:00+00:00",
    "2026-07-11 12:00:00",
    "2026-07-11",
    "11/07/2026",
    "2026-13-45T99:99:99.000Z",
    "",
    "   ",
    null,
    undefined,
    1_751_000_000_000,
    {},
    ["2026-07-11T12:00:00.000Z"],
  ]) {
    assert.throws(() => assertIsoCutoff(bad), /ISO-8601 UTC/, `cutoff ${JSON.stringify(bad)} must be refused`);
  }

  // Both adapters share this one guard, so they cannot disagree about a cutoff.
  assert.ok(REPOSITORY_METHODS.includes("pruneAnalysisRuns"), "retention is part of the contract, not an adapter extra");
  assert.equal(REPOSITORY_METHODS.length, 46);
});

test("R-27 the cutoff arithmetic keeps everything when retention is off, and 0 never means 'delete all'", () => {
  assert.equal(retentionCutoff({ retentionDays: 90, now: NOW }), "2026-07-11T12:00:00.000Z");
  assert.equal(retentionCutoff({ retentionDays: 1, now: NOW }), "2026-10-08T12:00:00.000Z");
  assert.equal(retentionCutoff({ retentionDays: 365, now: NOW }), "2025-10-09T12:00:00.000Z", "a leap-free year back");

  // The dangerous reading of `0` would be `now - 0`, i.e. delete every run ever
  // written. `0` means keep forever, so there is no cutoff at all.
  assert.equal(retentionCutoff({ retentionDays: 0, now: NOW }), null);
  assert.equal(retentionCutoff({ retentionDays: -30, now: NOW }), null);
  assert.equal(retentionCutoff({ retentionDays: Number.NaN, now: NOW }), null);
  assert.equal(retentionCutoff({ retentionDays: Number.POSITIVE_INFINITY, now: NOW }), null);
  assert.equal(retentionCutoff({ retentionDays: "90", now: NOW }), "2026-07-11T12:00:00.000Z", "a numeric string from the CLI is accepted");

  // The cutoff is always the canonical form the contract demands.
  assert.doesNotThrow(() => assertIsoCutoff(retentionCutoff({ retentionDays: 90, now: NOW })));
});

test("R-27 reclaimable space is reported in units an operator can read", () => {
  assert.equal(humanBytes(0), "0 B");
  assert.equal(humanBytes(512), "512 B");
  assert.equal(humanBytes(1023), "1023 B");
  assert.equal(humanBytes(1024), "1.0 KiB");
  assert.equal(humanBytes(16 * 1024), "16.0 KiB");
  assert.equal(humanBytes(5 * 1024 * 1024), "5.0 MiB");
  assert.equal(humanBytes(1536 * 1024 * 1024), "1.5 GiB");
  assert.equal(humanBytes(2 * 1024 ** 4), "2.0 TiB");
  assert.equal(humanBytes(Number.NaN), "0 B", "an absent measurement reads as zero, not NaN");
});

// ------------------------------------------------------------- the file adapter

test("R-27 the file adapter deletes strictly older runs, keeps the rest, and replays the deletions", async (t) => {
  const directory = await tempDir("wf-retention-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: true });
  try {
    for (const row of FIXTURE) await store.saveAnalysisRun(row);
    assert.equal((await store.stats()).analysisRuns, 5);

    const cutoff = retentionCutoff({ retentionDays: 90, now: NOW });
    const measured = await store.pruneAnalysisRuns(cutoff, { dryRun: true });
    assert.equal(measured.matching, 3, "200, 120 and 91 days old are older than the cutoff");
    assert.equal(measured.deleted, 0, "a dry run deletes nothing");
    assert.equal(measured.dryRun, true);
    assert.equal(measured.batches, 0);
    assert.equal(measured.exhausted, true);
    assert.equal(measured.cutoff, cutoff);
    assert.equal(measured.oldest, FIXTURE[0].completedAt, "the oldest matching run, so an operator can see the reach of the cut");
    assert.equal(measured.newest, FIXTURE[2].completedAt, "the newest matching run is the one just inside the window");
    assert.ok(measured.payloadBytes > 600, `the reclaimable payload is measured, got ${measured.payloadBytes}`);
    assert.equal((await store.stats()).analysisRuns, 5, "measuring changed nothing");

    // The boundary is the point of the exercise: 91 days is out, 89 days is in.
    const applied = await store.pruneAnalysisRuns(cutoff);
    assert.equal(applied.dryRun, false);
    assert.equal(applied.matching, 3);
    assert.equal(applied.deleted, 3);
    assert.equal(applied.batches, 1);
    assert.deepEqual(
      (await store.listAnalysisRuns({ limit: 10 })).map((row) => row.symbol),
      ["ETHUSDT", "EURUSD"],
      "the two runs inside the window survive, newest first",
    );
    assert.equal((await store.stats()).analysisRuns, 2);
    assert.equal(await store.findAnalysisRun(FIXTURE[0].id), null, "a pruned run is gone, not merely unlisted");
    assert.deepEqual(await store.findAnalysisRun(FIXTURE[4].id), FIXTURE[4].payload, "a kept run still returns its payload");

    // Second run is a no-op: retention is safe to schedule.
    const again = await store.pruneAnalysisRuns(cutoff);
    assert.deepEqual({ matching: again.matching, deleted: again.deleted, batches: again.batches, oldest: again.oldest },
      { matching: 0, deleted: 0, batches: 0, oldest: null });

    // A cutoff of "now" clears the table, which is what makes retention usable as a
    // reset during an incident — and what makes the dry-run default worth having.
    const everything = await store.pruneAnalysisRuns(new Date(NOW + DAY_MS).toISOString());
    assert.equal(everything.deleted, 2);
    assert.equal((await store.stats()).analysisRuns, 0);
  } finally {
    await store.close();
  }

  // Reopened from disk: the deletions were written to the log with its existing
  // `delete` op, so replay reproduces the pruned state rather than resurrecting rows.
  const reopened = await createFileStore({ dir: path.join(directory, "store"), syncWrites: true });
  try {
    assert.equal((await reopened.stats()).analysisRuns, 0, "the write-ahead log replays the prune");
  } finally {
    await reopened.close();
  }

  // A partial reopen, before the "delete everything" step, proves rows that were
  // kept are still readable from disk.
  const partial = await tempDir("wf-retention-partial-");
  t.after(() => rm(partial, { recursive: true, force: true }));
  const first = await createFileStore({ dir: path.join(partial, "store"), syncWrites: true });
  for (const row of FIXTURE) await first.saveAnalysisRun(row);
  await first.pruneAnalysisRuns(retentionCutoff({ retentionDays: 90, now: NOW }));
  await first.close();
  const second = await createFileStore({ dir: path.join(partial, "store"), syncWrites: true });
  try {
    assert.equal((await second.stats()).analysisRuns, 2);
    assert.deepEqual((await second.listAnalysisRuns({ limit: 10 })).map((row) => row.id).sort(),
      [FIXTURE[3].id, FIXTURE[4].id].sort());
  } finally {
    await second.close();
  }
});

test("R-27 both adapters refuse a cutoff they cannot compare as text, before touching storage", async (t) => {
  const directory = await tempDir("wf-retention-refuse-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: false });
  try {
    await store.saveAnalysisRun(FIXTURE[0]);
    for (const bad of ["2026-07-11T12:00:00+00:00", "yesterday", null, 0]) {
      await assert.rejects(() => store.pruneAnalysisRuns(bad), /ISO-8601 UTC/);
    }
    assert.equal((await store.stats()).analysisRuns, 1, "a refused cutoff deletes nothing");
  } finally {
    await store.close();
  }

  const pool = fakePool({ matching: 5 });
  await assert.rejects(() => createAnalysisRepository(pool).pruneAnalysisRuns("2026-07-11T12:00:00+00:00"), /ISO-8601 UTC/);
  assert.equal(pool.calls.length, 0, "the SQL adapter validates before it queries");
});

// -------------------------------------------------------------- the SQL adapter

test("R-27 the SQL adapter measures with one query and deletes in bounded, ordered batches", async () => {
  const cutoff = retentionCutoff({ retentionDays: 90, now: NOW });

  // 1200 matching rows at 500 per statement: three deletes, the last one partial,
  // which is the loop's stop signal.
  const pool = fakePool({ matching: 1200, oldest: "2026-01-02T00:00:00.000Z", newest: "2026-07-10T00:00:00.000Z", bytes: 48_234_567, affected: [500, 500, 200] });
  const report = await createAnalysisRepository(pool).pruneAnalysisRuns(cutoff, { batchSize: 500 });
  assert.deepEqual(
    { matching: report.matching, deleted: report.deleted, batches: report.batches, exhausted: report.exhausted, payloadBytes: report.payloadBytes, dryRun: report.dryRun },
    { matching: 1200, deleted: 1200, batches: 3, exhausted: true, payloadBytes: 48_234_567, dryRun: false },
  );
  assert.equal(report.oldest, "2026-01-02T00:00:00.000Z");
  assert.equal(report.newest, "2026-07-10T00:00:00.000Z");

  assert.equal(pool.calls.length, 4, "one measurement query plus three deletes");
  assert.match(pool.calls[0].sql, /SELECT COUNT\(\*\) AS total/);
  assert.match(pool.calls[0].sql, /COALESCE\(SUM\(LENGTH\(payload\)\), 0\) AS payload_bytes/);
  assert.match(pool.calls[0].sql, /FROM wf_analysis_runs\s+WHERE completed_at < \?/);
  assert.deepEqual(pool.calls[0].values, [cutoff], "the cutoff is bound, never interpolated");

  for (const call of pool.calls.slice(1)) {
    assert.match(call.sql, /DELETE FROM wf_analysis_runs\s+WHERE completed_at < \?\s+ORDER BY completed_at ASC\s+LIMIT 500/);
    assert.deepEqual(call.values, [cutoff]);
  }
  // ORDER BY is not decoration: DELETE … LIMIT without it is non-deterministic, and
  // statement-based replication logs a non-deterministic delete as unsafe.
  assert.ok(pool.calls[1].sql.includes("ORDER BY completed_at ASC"));
});

test("R-27 the SQL adapter measures without deleting on a dry run, and skips both when nothing matches", async () => {
  const cutoff = retentionCutoff({ retentionDays: 90, now: NOW });

  const dry = fakePool({ matching: 7, oldest: "2026-02-01T00:00:00.000Z", newest: "2026-06-01T00:00:00.000Z", bytes: 2048 });
  const dryReport = await createAnalysisRepository(dry).pruneAnalysisRuns(cutoff, { dryRun: true });
  assert.equal(dryReport.matching, 7);
  assert.equal(dryReport.deleted, 0);
  assert.equal(dryReport.dryRun, true);
  assert.equal(dryReport.batches, 0);
  assert.equal(dry.calls.length, 1, "a dry run issues the measurement query and no DELETE at all");
  assert.equal(dry.calls.some((call) => /DELETE/.test(call.sql)), false);

  const empty = fakePool({ matching: 0 });
  const emptyReport = await createAnalysisRepository(empty).pruneAnalysisRuns(cutoff);
  assert.deepEqual({ matching: emptyReport.matching, deleted: emptyReport.deleted, batches: emptyReport.batches, oldest: emptyReport.oldest, exhausted: emptyReport.exhausted },
    { matching: 0, deleted: 0, batches: 0, oldest: null, exhausted: true });
  assert.equal(empty.calls.length, 1, "nothing to delete means one measurement query and no DELETE");
});

test("R-27 the SQL adapter bounds its work: batch size is clamped and the batch ceiling is reported", async () => {
  const cutoff = retentionCutoff({ retentionDays: 90, now: NOW });

  // A ceiling reached with rows still matching is reported, not hidden: the remedy
  // is to run again, and an operator must be able to see that it is unfinished.
  const capped = fakePool({ matching: 100_000, affected: [100, 100] });
  const report = await createAnalysisRepository(capped).pruneAnalysisRuns(cutoff, { batchSize: 100, maxBatches: 2 });
  assert.equal(report.deleted, 200);
  assert.equal(report.batches, 2);
  assert.equal(report.exhausted, false, "more rows still match the cutoff");

  // LIMIT is interpolated because mysql2 does not bind it reliably, so it is clamped
  // to a bounded integer first — an operator cannot turn this into an unbounded
  // statement, and a nonsense value falls back rather than reaching the query.
  const huge = fakePool({ matching: 10, affected: [10] });
  await createAnalysisRepository(huge).pruneAnalysisRuns(cutoff, { batchSize: 999_999 });
  assert.match(huge.calls[1].sql, /LIMIT 5000$/, "clamped to the ceiling");

  const nonsense = fakePool({ matching: 10, affected: [10] });
  await createAnalysisRepository(nonsense).pruneAnalysisRuns(cutoff, { batchSize: "many" });
  assert.match(nonsense.calls[1].sql, /LIMIT 500$/, "an unusable batch size falls back to the default");

  const tiny = fakePool({ matching: 10, affected: [10] });
  await createAnalysisRepository(tiny).pruneAnalysisRuns(cutoff, { batchSize: 0 });
  assert.match(tiny.calls[1].sql, /LIMIT 1$/, "a batch is never smaller than one row");
});

test("R-27 the SQL adapter is reachable through the assembled store, so both adapters answer the same call", async () => {
  const pool = fakePool({ matching: 2, bytes: 4096, affected: [2] });
  const store = createStore(pool, { logger: { info() {}, warn() {}, error() {} } });
  assert.equal(typeof store.pruneAnalysisRuns, "function");
  const report = await store.pruneAnalysisRuns(retentionCutoff({ retentionDays: 30, now: NOW }));
  assert.equal(report.deleted, 2);
  assert.equal(report.matching, 2);
});

// -------------------------------------------------------------------- the CLI

/** Run the tool exactly as an operator would: a subprocess with its own env. */
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
        ANALYSIS_RETENTION_DAYS: "90",
        ...env,
      },
    });
    return { stdout, stderr, code: 0, directory };
  } catch (error) {
    return { stdout: error.stdout || "", stderr: error.stderr || "", code: error.code ?? 1, directory };
  }
}

async function seed(directory) {
  const store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: true });
  try {
    for (const row of FIXTURE) await store.saveAnalysisRun(row);
  } finally {
    await store.close();
  }
  return directory;
}

test("R-27 the CLI measures by default and deletes nothing until --apply is explicit", async (t) => {
  const directory = await seed(await tempDir("wf-retention-default-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = new Date(NOW).toISOString();

  const dry = await cli(["--now", now], { cwd: directory });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /^DRY RUN — keep 90 day\(s\), cutoff 2026-07-11T12:00:00\.000Z, adapter file/);
  assert.match(dry.stdout, /matching : 3 run\(s\) older than the cutoff/);
  assert.match(dry.stdout, /deleted  : 0 \(dry run — re-run with --apply to delete these 3 run\(s\)\)/);
  assert.match(dry.stdout, /npm run backup/, "an irreversible delete of evidence points at the backup first");
  assert.match(dry.stdout, /oldest   : 2026-03-23T12:00:00\.000Z/);
  assert.match(dry.stdout, /payload  : \d+(\.\d+)? (B|KiB|MiB|GiB) of stored run data/, "the reclaimable size is reported in readable units");

  let store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: true });
  try {
    assert.equal((await store.stats()).analysisRuns, 5, "a dry run left every row in place");
  } finally {
    await store.close();
  }

  const applied = await cli(["--apply", "--now", now], { cwd: directory });
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(applied.stdout, /^APPLIED — keep 90 day\(s\)/);
  assert.match(applied.stdout, /deleted  : 3 run\(s\) in 1 batch\(es\)/);
  assert.ok(!/dry run/i.test(applied.stdout));

  store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: true });
  try {
    assert.equal((await store.stats()).analysisRuns, 2);
  } finally {
    await store.close();
  }

  const again = await cli(["--now", now], { cwd: directory });
  assert.match(again.stdout, /No analysis runs are older than the cutoff; nothing to do\./, "safe to schedule");
});

test("R-27 the CLI honours ANALYSIS_RETENTION_DAYS, --days, and treats 0 as 'keep everything'", async (t) => {
  const directory = await seed(await tempDir("wf-retention-days-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = new Date(NOW).toISOString();

  const configured = await cli(["--json", "--now", now], { cwd: directory });
  assert.equal(JSON.parse(configured.stdout).retentionDays, 90, "the policy comes from config");
  assert.equal(JSON.parse(configured.stdout).matching, 3);

  const overridden = await cli(["--json", "--days", "199", "--now", now], { cwd: directory });
  const wide = JSON.parse(overridden.stdout);
  assert.equal(wide.retentionDays, 199);
  assert.equal(wide.matching, 1, "only the 200-day-old run is outside a 199-day window");
  assert.equal(wide.cutoff, "2026-03-24T12:00:00.000Z");

  // The comparison is *strictly* older, so a run exactly on the cutoff is kept. A
  // 200-day window leaves the 200-day-old run alone rather than eating the boundary.
  const boundary = await cli(["--json", "--days", "200", "--now", now], { cwd: directory });
  assert.equal(JSON.parse(boundary.stdout).matching, 0, "a run exactly at the cutoff survives");
  assert.equal(JSON.parse(boundary.stdout).cutoff, "2026-03-23T12:00:00.000Z");

  const tight = await cli(["--json", "--days", "2", "--now", now], { cwd: directory });
  assert.equal(JSON.parse(tight.stdout).matching, 4, "a two-day window keeps only yesterday's run");

  // The dangerous reading of 0 would be `now - 0`, i.e. delete everything. The tool
  // refuses to guess and says what it did instead — even with --apply.
  const disabled = await cli(["--apply", "--now", now], { cwd: directory, env: { ANALYSIS_RETENTION_DAYS: "0" } });
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.match(disabled.stdout, /Retention is off: ANALYSIS_RETENTION_DAYS=0 keeps analysis runs forever; pass --days N to prune anyway/);
  let store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: true });
  try {
    assert.equal((await store.stats()).analysisRuns, 5, "retention off deleted nothing, even under --apply");
  } finally {
    await store.close();
  }

  // …but an explicit --days still works for an operator who wants a one-off cut.
  const forced = await cli(["--json", "--apply", "--days", "150", "--now", now], { cwd: directory, env: { ANALYSIS_RETENTION_DAYS: "0" } });
  assert.equal(JSON.parse(forced.stdout).deleted, 1);
});

test("R-27 the CLI refuses bad input with exit 1 and one JSON document under --json", async (t) => {
  const directory = await seed(await tempDir("wf-retention-refuse-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const cases = [
    { args: ["--nope"], message: /unknown flag --nope/ },
    { args: ["--days", "-5"], message: /--days must be 0 or a positive number of days/ },
    { args: ["--days", "soon"], message: /--days must be 0 or a positive number of days/ },
    { args: ["--batch", "99999"], message: /--batch must be an integer between 1 and 5000/ },
    { args: ["--batch", "0"], message: /--batch must be an integer between 1 and 5000/ },
    { args: ["--now", "garbage"], message: /--now must be an ISO-8601 instant/ },
  ];
  for (const { args, message } of cases) {
    const result = await cli(args, { cwd: directory });
    assert.equal(result.code, 1, `${args.join(" ")} must exit 1`);
    assert.match(result.stderr, message, `${args.join(" ")} must say why`);
    assert.match(result.stderr, /Usage: node tools\/prune-analysis-runs\.mjs/, "and print the usage line");
  }

  // Cron and pipelines parse stdout, so a failure must not interleave prose with JSON.
  const asJson = await cli(["--json", "--days", "-5"], { cwd: directory });
  assert.equal(asJson.code, 1);
  assert.equal(asJson.stdout.trim().split("\n").filter((line) => line.startsWith("{")).length, 1);
  const document = JSON.parse(asJson.stdout);
  assert.deepEqual(document, { ok: false, error: "--days must be 0 or a positive number of days" });

  // A successful run is one document too, with everything an operator needs in it.
  const ok = await cli(["--json", "--now", new Date(NOW).toISOString()], { cwd: directory });
  const report = JSON.parse(ok.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(
    { adapter: report.adapter, retentionDays: report.retentionDays, matching: report.matching, deleted: report.deleted, dryRun: report.dryRun, exhausted: report.exhausted, apply: report.apply },
    { adapter: "file", retentionDays: 90, matching: 3, deleted: 0, dryRun: true, exhausted: true, apply: false },
  );
  assert.ok(report.payloadBytes > 0);
});

test("R-27 the CLI reports an empty store truthfully instead of inventing work", async (t) => {
  // A path no run was ever written to is how an operator typo shows up. On the file
  // adapter the store directory is created on demand, so the honest outcome is "there
  // is nothing here" — which is safe, because no other data was touched. On MySQL the
  // same situation is caught earlier: `readiness` reports the database unreachable and
  // the tool refuses rather than reporting a false zero.
  const directory = await tempDir("wf-retention-nostore-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await cli(["--now", new Date(NOW).toISOString()], {
    cwd: directory,
    env: { STORAGE_DIR: path.join(directory, "does-not-exist") },
  });
  assert.equal(result.code, 0, `an empty store is not an error: ${result.stderr}`);
  assert.match(result.stdout, /No analysis runs are older than the cutoff/, "it says there is nothing there rather than inventing rows");
  assert.ok(!/matching : \d/.test(result.stdout), "and reports no matches at all, not a zero it had to go and look for");
});

// ------------------------------------------------------- the shape of the policy

test("R-27 retention is an operator tool, not an HTTP surface", async () => {
  // The deliberate part of this design: there is no route that can delete analysis
  // history. A session-scoped API with a delete verb over the audit copy of what a
  // user was shown is not a trade worth making, so the only caller is the CLI.
  const { analysisRoutes } = await import("../src/modules/analysis/routes.js");
  const registered = [];
  const recorder = {
    log: () => {},
    get: (p) => registered.push(`GET ${p}`),
    post: (p) => registered.push(`POST ${p}`),
    put: (p) => registered.push(`PUT ${p}`),
    patch: (p) => registered.push(`PATCH ${p}`),
    delete: (p) => registered.push(`DELETE ${p}`),
  };
  analysisRoutes(recorder, {
    store: null,
    config: { rateLimit: { analysisRun: { max: 1, windowMs: 1 }, analysisConsensus: { max: 1, windowMs: 1 }, analysisMaxConcurrentRuns: 0 } },
    service: { run: async () => ({}), consensus: async () => ({}), history: async () => [], agents: async () => [], find: async () => null },
  });
  assert.deepEqual(registered.sort(), [
    "GET /analysis/:runId",
    "GET /analysis/agents",
    "GET /analysis/history",
    "POST /analysis/consensus",
    "POST /analysis/run",
  ]);
  assert.equal(registered.filter((route) => route.startsWith("DELETE")).length, 0, "no delete verb anywhere in the module");
});
