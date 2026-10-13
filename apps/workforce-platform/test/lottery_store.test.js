/**
 * The lottery foundation repository (row 15, slice 1) against a recording
 * MySQL-shaped executor and against the file adapter — the same two-lens proof the
 * sports foundation uses, for the same reason (**F-15**: there is no MySQL server in
 * this sandbox, and pretending otherwise would produce tests that pass against a
 * fiction).
 *
 *  - **Behaviour** is proven on the file adapter: the idempotency keys, the
 *    VERIFIED-conflict refusal (LT-2), the draw-numbers replace, the sync-run
 *    claim/null answer, the retention cutoffs, and close/reopen for all seven
 *    entities.
 *  - **SQL shape** is proven on the recording executor: the right statement with the
 *    right bound parameters, limits interpolated as bounded integers rather than
 *    caller text, and canonical cutoffs enforced.
 *
 * What this file cannot prove is that MariaDB accepts the statements. That gap is
 * F-15 and it is stated rather than papered over.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLotteryRepository, LOTTERY_REPOSITORY_METHODS } from "../src/db/lottery-repository.js";
import { createFileStore } from "../src/persistence/file-store.js";

const T0 = "2026-03-01T12:00:00.000Z";

function recordingExecutor({ rows = [], affectedRows = 1, insertId = 7 } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, values = []) {
      calls.push({ kind: "query", sql, values });
      return [rows.map((row) => ({ ...row })), []];
    },
    async execute(sql, values = []) {
      calls.push({ kind: "execute", sql, values });
      return [{ affectedRows, insertId }, []];
    },
  };
}

/** A real file store in a throwaway directory, closed by the test's after-hook. */
async function tempFileStore(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "windels-lottery-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFileStore({ dir: path.join(directory, "store"), logger: { warn() {} } });
  t.after(() => store.close());
  return store;
}

const DRAW = {
  lotteryCode: "EUROMILLIONS",
  providerId: 1,
  externalId: "SIM-2026-10-09",
  drawDate: "2026-10-09",
  jackpot: "11757064.00",
  rollover: false,
  source: "sandbox-simulation",
  sourceTimestamp: "2026-10-09T21:00:00+00:00",
  verificationStatus: "VERIFIED",
  payload: { main: [1, 6, 34, 43, 44], stars: [5, 11], source: "sandbox-simulation" },
};

test("the lottery repository exposes exactly the 41 methods the contract names, and no more", () => {
  assert.equal(LOTTERY_REPOSITORY_METHODS.length, 41, "slice 1's 23 + slice 2's 6 combination/decision methods + slice 3's 7 ticket methods + slice 4's 5 backtest/model methods");
  const repo = createLotteryRepository(recordingExecutor());
  for (const method of LOTTERY_REPOSITORY_METHODS) {
    assert.equal(typeof repo[method], "function", `${method} must exist on the MySQL adapter`);
  }
});

test("the game registry ensures idempotently, bumps the rules version in place, and lists oldest first", async (t) => {
  const store = await tempFileStore(t);

  const first = await store.ensureLotteryGame("EUROMILLIONS", "EuroMillions", "1.0");
  assert.equal(first.code, "EUROMILLIONS");
  assert.equal(first.enabled, 1);
  const second = await store.ensureLotteryGame("EUROMILLIONS", "EuroMillions", "1.0");
  assert.equal(second.id, first.id, "a second ensure returns the same row");

  // A rules-version bump is an UPDATE of the existing row, not a second game.
  const bumped = await store.ensureLotteryGame("EUROMILLIONS", "EuroMillions", "1.1");
  assert.equal(bumped.id, first.id);
  assert.equal(bumped.rules_version, "1.1");
  assert.equal((await store.listLotteryGames()).length, 1);

  await store.ensureLotteryGame("EUROJACKPOT", "EuroJackpot", "1.0");
  const games = await store.listLotteryGames();
  assert.equal(games.length, 2);
  assert.deepEqual(games.map((g) => g.code), ["EUROMILLIONS", "EUROJACKPOT"]);
});

test("stored rules: the newest active version wins, whatever the insert order", async (t) => {
  const store = await tempFileStore(t);

  assert.equal(await store.activeLotteryRules("EUROMILLIONS"), null);

  await store.saveLotteryRules({
    lotteryCode: "EUROMILLIONS", version: "1.0", mainCount: 5, mainMin: 1, mainMax: 50,
    starCount: 2, starMin: 1, starMax: 12, schedule: JSON.stringify({ days: [2, 5], time: "21:00", timezone: "UTC" }), active: 1,
  });
  await store.saveLotteryRules({
    lotteryCode: "EUROMILLIONS", version: "1.1", mainCount: 6, mainMin: 1, mainMax: 60,
    starCount: 3, starMin: 1, starMax: 16, schedule: JSON.stringify({ days: [3, 6] }), active: 1,
  });
  const active = await store.activeLotteryRules("EUROMILLIONS");
  assert.equal(active.version, "1.1");
  assert.equal(active.main_count, 6);
  // The schedule stays the stored text; the rules layer owns the decode.
  assert.equal(active.schedule, JSON.stringify({ days: [3, 6] }));
});

test("the provider registry creates disabled and derives synthetic from the code, as sports does", async (t) => {
  const store = await tempFileStore(t);

  const row = await store.ensureLotteryProvider("sandbox-sim", "Sandbox Simulation");
  assert.equal(row.enabled, 0, "a sync naming a vendor is not an operator approving it");
  assert.equal(row.synthetic, 1);
  const official = await store.ensureLotteryProvider("official-euromillions", "Authorized feed");
  assert.equal(official.synthetic, 0);
  assert.equal((await store.listLotteryProviders()).length, 2);
  assert.equal((await store.listLotteryProviders(true)).length, 0, "nothing is enabled by default");
});

test("health is an append-only series: latest wins, the window bounds the read, the cutoff prunes", async (t) => {
  const store = await tempFileStore(t);
  const provider = await store.ensureLotteryProvider("sandbox-sim", "Sandbox Simulation");

  await store.saveLotteryHealth(provider.id, { status: "ONLINE", responseMs: 40, recordsReceived: 12 });
  await store.saveLotteryHealth(provider.id, { status: "DEGRADED", responseMs: 900, recordsReceived: 3, lastFailureAt: "2026-03-01T00:00:00.000Z", lastDrawRetrieved: "2026-02-27" });

  const latest = await store.latestLotteryHealth(provider.id);
  assert.equal(latest.status, "DEGRADED");
  assert.equal(latest.last_draw_retrieved, "2026-02-27");
  const listed = await store.listLotteryHealth(provider.id, 1);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "DEGRADED");

  // Retention cutoffs are canonical or refused (R-27's discipline, both adapters).
  assert.equal(await store.deleteOldLotteryHealth("2000-01-01T00:00:00.000Z"), 0);
  assert.equal(await store.deleteOldLotteryHealth("2999-01-01T00:00:00.000Z"), 2);
  await assert.rejects(() => store.deleteOldLotteryHealth("yesterday"), /ISO-8601 UTC/);
  await assert.rejects(() => store.deleteOldLotteryJobRuns("2026-03-01T12:00:00+00:00"), /ISO-8601 UTC/);
});

test("draws: insert, identical re-import is a no-op, differing numbers on VERIFIED are a conflict, and stats read oldest first", async (t) => {
  const store = await tempFileStore(t);

  const first = await store.saveLotteryDraw({ ...DRAW, retrievedAt: T0 });
  assert.equal(first.created, true);
  assert.equal(first.conflict, false);
  assert.deepEqual(first.row.payload.main, [1, 6, 34, 43, 44]);

  // Identical re-import: same row, not created, no conflict.
  const again = await store.saveLotteryDraw({ ...DRAW, retrievedAt: T0 });
  assert.equal(again.created, false);
  assert.equal(again.conflict, false);
  assert.equal(again.row.id, first.row.id);

  // LT-2: a differing VERIFIED draw is refused at the repository level.
  const conflict = await store.saveLotteryDraw({ ...DRAW, payload: { main: [2, 6, 34, 43, 44], stars: [5, 11] } });
  assert.equal(conflict.created, false);
  assert.equal(conflict.conflict, true);
  assert.deepEqual(conflict.row.payload.main, [1, 6, 34, 43, 44], "the stored draw is untouched");

  // An UNVERIFIED differing draw corrects in place.
  const corrected = await store.saveLotteryDraw({ ...DRAW, verificationStatus: "UNVERIFIED", payload: { main: [9, 6, 34, 43, 44], stars: [5, 11] } });
  assert.equal(corrected.created, false);
  assert.equal(corrected.conflict, false);
  assert.deepEqual(corrected.row.payload.main, [9, 6, 34, 43, 44]);

  // Numbers: wholesale replace, legacy positions = the index in the array AS GIVEN
  // (importDraws passes the provider's own order; the sandbox sorts before storing).
  await store.saveLotteryDrawNumbers(first.row.id, { main: [4, 3, 2, 1, 50], stars: [7, 1] });
  const numbers = await store.listLotteryDrawNumbers(first.row.id);
  assert.deepEqual(numbers.filter((n) => n.kind === "MAIN").map((n) => n.number), [4, 3, 2, 1, 50], "position order, which is the order the provider gave");
  assert.deepEqual(numbers.filter((n) => n.kind === "STAR").map((n) => n.number), [7, 1]);
  assert.equal(numbers.length, 7, "the replace removed the previous seven");

  // A second draw, earlier, for ordering.
  await store.saveLotteryDraw({ ...DRAW, externalId: "SIM-2026-10-06", drawDate: "2026-10-06", payload: { main: [13, 23, 35, 36, 40], stars: [2, 4] } });
  assert.equal(await store.countLotteryDraws("EUROMILLIONS"), 2);

  const asc = await store.listLotteryDraws({ lotteryCode: "EUROMILLIONS" }, 10, "ASC");
  assert.deepEqual(asc.map((d) => d.draw_date), ["2026-10-06", "2026-10-09"]);
  const desc = await store.listLotteryDraws({ lotteryCode: "EUROMILLIONS" }, 1);
  assert.equal(desc[0].draw_date, "2026-10-09");

  const filtered = await store.listLotteryDraws({ lotteryCode: "EUROMILLIONS", from: "2026-10-07", to: "2026-10-08" }, 10);
  assert.equal(filtered.length, 0);

  // drawsForStats: oldest first, numbers only, malformed payloads skipped.
  const stats = await store.lotteryDrawsForStats("EUROMILLIONS");
  assert.deepEqual(stats.map((d) => d.drawDate), ["2026-10-06", "2026-10-09"]);
  assert.deepEqual(stats[0].main, [13, 23, 35, 36, 40]);

  // Lookup by the idempotency key, and by id; a foreign code is not found.
  assert.equal((await store.findLotteryDrawByExternal("EUROMILLIONS", "SIM-2026-10-09")).id, first.row.id);
  assert.equal(await store.findLotteryDrawByExternal("EUROJACKPOT", "SIM-2026-10-09"), null);
  assert.equal((await store.findLotteryDraw(first.row.id)).external_id, "SIM-2026-10-09");
  assert.equal(await store.findLotteryDraw(99999), null);

  // Refusals: a bad date never reaches storage.
  await assert.rejects(() => store.saveLotteryDraw({ ...DRAW, externalId: "X2", drawDate: "2026-13-40" }), /draw_date/);
  await assert.rejects(() => store.saveLotteryDraw({ ...DRAW, externalId: "X3", lotteryCode: "euromillions" }), /lottery_code/);
});

test("sync runs: the execution key arbitrates, finish records the counters, the list is newest first", async (t) => {
  const store = await tempFileStore(t);

  const run = await store.startLotteryJobRun({ id: "run-1", providerId: 1, jobType: "sync", executionKey: "sync:sandbox-sim:2026-03-01", payload: { limit: 12 } });
  assert.equal(run.status, "RUNNING");
  assert.equal(await store.startLotteryJobRun({ id: "run-2", jobType: "sync", executionKey: "sync:sandbox-sim:2026-03-01" }), null, "the key answers null, not an error");

  await store.finishLotteryJobRun("run-1", { status: "OK", processed: 12, created: 12, updated: 0, errors: [] });
  const finished = await store.findLotteryJobRunByKey("sync:sandbox-sim:2026-03-01");
  assert.equal(finished.status, "OK");
  assert.equal(finished.records_created, 12);
  assert.deepEqual(finished.errors, []);

  const other = await store.startLotteryJobRun({ id: "run-3", jobType: "sync", executionKey: "sync:sandbox-sim:2026-03-02" });
  assert.notEqual(other, null);
  const listed = await store.listLotteryJobRuns("sync", 10);
  assert.equal(listed[0].id, "run-3", "newest first");
  assert.equal(await store.listLotteryJobRuns("backtests", 10).then((rows) => rows.length), 0);

  // Retention: a canonical cutoff prunes by started_at.
  assert.equal(await store.deleteOldLotteryJobRuns("2000-01-01T00:00:00.000Z"), 0);
  assert.equal(await store.deleteOldLotteryJobRuns("2999-01-01T00:00:00.000Z"), 2);
});

test("the file adapter survives close and reopen with every lottery entity intact", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "windels-lottery-reopen-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dir = path.join(directory, "store");

  const first = await createFileStore({ dir, logger: { warn() {} } });
  await first.ensureLotteryGame("EUROMILLIONS", "EuroMillions", "1.0");
  const provider = await first.ensureLotteryProvider("sandbox-sim", "Sandbox Simulation");
  await first.saveLotteryHealth(provider.id, { status: "ONLINE", responseMs: 5 });
  await first.saveLotteryRules({ lotteryCode: "EUROMILLIONS", version: "1.0", mainCount: 5, mainMin: 1, mainMax: 50, starCount: 2, starMin: 1, starMax: 12, schedule: "{}", active: 1 });
  const { row: draw } = await first.saveLotteryDraw({ ...DRAW, retrievedAt: T0 });
  await first.saveLotteryDrawNumbers(draw.id, { main: DRAW.payload.main, stars: DRAW.payload.stars });
  await first.startLotteryJobRun({ id: "run-1", providerId: provider.id, jobType: "sync", executionKey: "sync:sandbox-sim:2026-03-01" });
  await first.close();

  const second = await createFileStore({ dir, logger: { warn() {} } });
  t.after(() => second.close());
  const stats = await second.stats();
  assert.deepEqual({
    lotteries: stats.lotteries,
    lotteryRules: stats.lotteryRules,
    lotteryProviders: stats.lotteryProviders,
    lotteryHealth: stats.lotteryHealth,
    lotteryDraws: stats.lotteryDraws,
    lotteryDrawNumbers: stats.lotteryDrawNumbers,
    lotterySyncRuns: stats.lotterySyncRuns,
  }, { lotteries: 1, lotteryRules: 1, lotteryProviders: 1, lotteryHealth: 1, lotteryDraws: 1, lotteryDrawNumbers: 7, lotterySyncRuns: 1 });

  const reopened = await second.findLotteryDrawByExternal("EUROMILLIONS", "SIM-2026-10-09");
  assert.deepEqual(reopened.payload.main, [1, 6, 34, 43, 44]);
  assert.equal((await second.latestLotteryHealth(provider.id)).status, "ONLINE");
  assert.equal(await second.activeLotteryRules("EUROMILLIONS").then((r) => r.main_count), 5);
  // And the idempotency arbiter survived the restart: the same key answers null.
  assert.equal(await second.startLotteryJobRun({ id: "run-2", jobType: "sync", executionKey: "sync:sandbox-sim:2026-03-01" }), null);
});

test("the MySQL adapter bounds its limits as integers and never interpolates caller text", async () => {
  const executor = recordingExecutor();
  const repo = createLotteryRepository(executor);
  executor.calls.length = 0;

  await repo.listLotteryDraws({}, 5000);
  await repo.listLotteryDraws({}, 0);
  await repo.listLotteryDraws({}, "5000; DROP TABLE wf_lottery_draws");
  await repo.listLotteryHealth(1, 900);
  await repo.listLotteryJobRuns(null, 9000);

  const drawn = executor.calls.filter((c) => c.sql.includes("FROM wf_lottery_draws"));
  assert.match(drawn[0].sql, /LIMIT 5000/, "5000 is inside the 100000 cap, so it is the limit");
  assert.match(drawn[1].sql, /LIMIT 1/, "a 0 limit reads ONE row, as legacy's max(1, …) does");
  assert.match(drawn[2].sql, /LIMIT 1/, "a non-numeric limit is (int) 0 in PHP, which is 1 — and never text");
  const health = executor.calls.find((c) => c.sql.includes("FROM wf_lottery_provider_health"));
  assert.match(health.sql, /LIMIT 200/);
  const runs = executor.calls.find((c) => c.sql.includes("FROM wf_lottery_sync_runs"));
  assert.match(runs.sql, /LIMIT 500/);
  // Every interpolated number is an integer literal, never caller text.
  for (const call of executor.calls) {
    for (const match of call.sql.matchAll(/LIMIT (\d+)/g)) {
      assert.ok(Number.isInteger(Number(match[1])), `LIMIT ${match[1]} is an integer literal`);
    }
  }
});
