/**
 * Strategy Lab persistence — the ten contract methods, on both adapters.
 *
 * The file adapter is exercised for real: rows are written, read back, and
 * re-read after the store is closed and reopened, so the write-ahead log is
 * proved to replay the new entities. The MySQL adapter cannot be executed in
 * this sandbox (finding F-15: no server), so it is driven through a recording
 * fake pool and pinned on the SQL text and the bound values instead. That is a
 * weaker guarantee and is labelled as such wherever it applies.
 *
 * The parity cases at the end are the point of the exercise: one contract, two
 * adapters, and a route must not be able to tell which one it is talking to.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { REPOSITORY_METHODS, assertRepositoryContract } from "../src/persistence/contract.js";
import { createFileStore } from "../src/persistence/file-store.js";
import { createStrategyRepository } from "../src/db/strategy-repository.js";
import { createStore } from "../src/db/store.js";
import { newStrategyRecord } from "../src/modules/strategies/registry.js";
import { createTrendFollowingStrategy, createVersionedStrategy } from "../src/modules/strategies/builtin.js";

const STRATEGY_METHODS = Object.freeze([
  "saveStrategy",
  "findStrategy",
  "listStrategies",
  "saveBacktest",
  "findBacktest",
  "listBacktests",
  "countStrategyBacktests",
  "latestStrategyBacktest",
  "saveJournalEntry",
  "listJournalEntries",
]);

// ---- fixtures --------------------------------------------------------------

const NOW = "2026-10-10T12:00:00.000Z";

function tempStore(t) {
  return mkdtemp(path.join(tmpdir(), "wf-strategies-")).then(async (dir) => {
    t.after(() => rm(dir, { recursive: true, force: true }));
    return { dir, storeDir: path.join(dir, "store") };
  });
}

function strategyRecord(overrides = {}) {
  return {
    ...newStrategyRecord(createTrendFollowingStrategy(), "builtin", NOW),
    ...overrides,
  };
}

/** A backtest record shaped exactly as `buildBacktestRecord` produces it. */
function backtestRecord(overrides = {}) {
  return {
    id: "bt-1",
    created_at: NOW,
    request: {
      strategyId: "trend-following",
      strategyVersion: "1.0.0",
      symbol: "EURUSD",
      timeframe: "1h",
      marketClass: "forex",
      initialEquity: 10_000,
      riskPct: 0.01,
    },
    dataProvenance: { source: "synthetic", synthetic: true, candles: 200 },
    metrics: { trades: 40, profitFactor: 1.8, maxDrawdownPct: 12.5, expectancyPnl: 25 },
    equityCurve: [{ time: NOW, equity: 10_000, drawdownPct: 0 }],
    trades: [{ entryBar: 1, exitBar: 5, netPnl: 12 }],
    warnings: [],
    ...overrides,
  };
}

/** A journal row shaped exactly as `journalEntriesFromBacktest` produces it. */
function journalEntry(overrides = {}) {
  return {
    id: "j-1",
    source: "backtest",
    symbol: "EURUSD",
    market: "forex",
    strategy: "trend-following",
    strategy_version: "1.0.0",
    backtest_id: "bt-1",
    direction: "LONG",
    entry_time: NOW,
    entry_price: 1.08543210,
    exit_time: NOW,
    exit_price: 1.09123456,
    position_size: 15432.1,
    stop_loss: 1.08000000,
    take_profit: 1.10000000,
    fees: 0.6789,
    slippage: 0.1234,
    pnl: 89.65,
    pnl_pct: 0.529,
    r_multiple: 1.6,
    reason: "fresh EMA cross-up with ADX confirmation",
    ai_confidence: 0.8,
    confidence_source: "strategy",
    agent_consensus: null,
    risk_score: 0.01,
    execution_time: NOW,
    ...overrides,
  };
}

/**
 * A pool that records every statement and answers from a script.
 *
 * `execute` answers `[[rows], fields]` and `query` answers `[rows]`, matching
 * mysql2, because the repository destructures them differently in different
 * methods and getting that wrong would hide a real bug behind a test-only one.
 */
function fakePool({ rows = [], count = 0, affected = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async execute(sql, values = []) {
      calls.push({ kind: "execute", sql, values });
      if (/COUNT\(\*\)/i.test(sql)) return [[{ total: count }], []];
      return [rows, []];
    },
    async query(sql, values = []) {
      calls.push({ kind: "query", sql, values });
      if (/^\s*DELETE/i.test(sql)) return [{ affectedRows: affected }];
      return [rows];
    },
  };
}

// ---- the contract ----------------------------------------------------------

test("the ten Strategy Lab methods are part of the contract, not adapter extras", () => {
  for (const method of STRATEGY_METHODS) {
    assert.ok(REPOSITORY_METHODS.includes(method), `${method} must be in REPOSITORY_METHODS`);
  }
  assert.equal(STRATEGY_METHODS.length, 10);
  assert.equal(REPOSITORY_METHODS.length, 46);
  // No method may be declared twice: a duplicate would let one adapter satisfy
  // the count while missing a distinct behaviour.
  assert.equal(new Set(REPOSITORY_METHODS).size, REPOSITORY_METHODS.length);
});

test("both shipped adapters satisfy the extended contract at boot", async (t) => {
  const { storeDir } = await tempStore(t);
  const file = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => file.close());
  const pool = fakePool();
  const sql = createStore(pool);

  assert.doesNotThrow(() => assertRepositoryContract(file, { adapter: "file" }));
  assert.doesNotThrow(() => assertRepositoryContract(sql, { adapter: "mysql" }));
  for (const method of STRATEGY_METHODS) {
    assert.equal(typeof file[method], "function", `file adapter is missing ${method}`);
    assert.equal(typeof sql[method], "function", `mysql adapter is missing ${method}`);
  }
});

// ---- file adapter: strategies ----------------------------------------------

test("file adapter round-trips a strategy on its composite key", async (t) => {
  const { storeDir } = await tempStore(t);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  const record = strategyRecord();
  await store.saveStrategy(record);
  const found = await store.findStrategy("trend-following", "1.0.0");

  assert.equal(found.strategy_id, "trend-following");
  assert.equal(found.version, "1.0.0");
  assert.equal(found.source, "builtin");
  assert.equal(found.lifecycle, "DRAFT");
  assert.deepEqual(found.params, record.params);
  assert.deepEqual(found.market_classes, record.market_classes);
  assert.deepEqual(found.timeframes, record.timeframes);
  assert.deepEqual(found.lifecycle_history, record.lifecycle_history);
  assert.equal(found.created_at, NOW);
  assert.equal(found.updated_at, NOW);
  assert.equal(await store.findStrategy("trend-following", "9.9.9"), null);
  assert.equal(await store.findStrategy("nope", "1.0.0"), null);
});

test("file adapter treats two versions of one strategy as two rows", async (t) => {
  const { storeDir } = await tempStore(t);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  const params = { fast: 10, slow: 40, adxMin: 20, stopAtr: 2, targetR: 2 };
  const variant = createVersionedStrategy(createTrendFollowingStrategy(params), "1.0.1", params);
  await store.saveStrategy(strategyRecord());
  await store.saveStrategy(newStrategyRecord(variant, "ai", NOW));

  const all = await store.listStrategies();
  assert.equal(all.length, 2, "a composite primary key means two rows, not one overwritten");
  assert.deepEqual(all.map((row) => row.version).sort(), ["1.0.0", "1.0.1"]);
  assert.equal((await store.findStrategy("trend-following", "1.0.0")).source, "builtin");
  assert.equal((await store.findStrategy("trend-following", "1.0.1")).source, "ai");
  assert.equal((await store.stats()).strategies, 2);
});

test("file adapter preserves created_at when a strategy is re-saved", async (t) => {
  const { storeDir } = await tempStore(t);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  await store.saveStrategy(strategyRecord({ created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }));
  // A stage change re-saves the whole row with a new updated_at. created_at must
  // survive it, or every promotion would make the strategy look newly registered.
  await store.saveStrategy(
    strategyRecord({
      lifecycle: "BACKTESTED",
      created_at: "2026-10-10T12:00:00.000Z",
      updated_at: "2026-10-10T12:00:00.000Z",
    }),
  );

  const found = await store.findStrategy("trend-following", "1.0.0");
  assert.equal(found.created_at, "2026-01-01T00:00:00.000Z", "created_at records first existence");
  assert.equal(found.updated_at, "2026-10-10T12:00:00.000Z");
  assert.equal(found.lifecycle, "BACKTESTED");
  assert.equal((await store.listStrategies()).length, 1, "the re-save must not add a row");
});

test("file adapter orders listStrategies by strategy_id then updated_at", async (t) => {
  const { storeDir } = await tempStore(t);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  // Written deliberately out of order, so the sort is what produces the result.
  await store.saveStrategy(strategyRecord({ strategy_id: "momentum", updated_at: "2026-03-01T00:00:00.000Z" }));
  await store.saveStrategy(strategyRecord({ strategy_id: "breakout", updated_at: "2026-05-01T00:00:00.000Z" }));
  await store.saveStrategy(
    strategyRecord({ strategy_id: "breakout", version: "1.0.1", updated_at: "2026-02-01T00:00:00.000Z" }),
  );
  await store.saveStrategy(strategyRecord({ strategy_id: "breakout", version: "1.0.2", updated_at: "2026-06-01T00:00:00.000Z" }));

  const all = await store.listStrategies();
  // Written out of order on purpose. breakout's versions sort by updated_at
  // (Feb, May, Jun) => 1.0.1, 1.0.0, 1.0.2 — NOT by version number, which is the
  // whole reason the ordering is pinned rather than assumed.
  assert.deepEqual(
    all.map((row) => `${row.strategy_id}@${row.version}`),
    ["breakout@1.0.1", "breakout@1.0.0", "breakout@1.0.2", "momentum@1.0.0"],
  );
  // Within one strategy the most recently updated version comes LAST, which is
  // what lets "latest version" be read as the final row of a contiguous group.
  const breakout = all.filter((row) => row.strategy_id === "breakout");
  assert.equal(breakout.at(-1).version, "1.0.2");
});

test("file adapter survives close and reopen for all three new entities", async (t) => {
  const { storeDir } = await tempStore(t);
  const first = await createFileStore({ dir: storeDir, syncWrites: true });
  await first.saveStrategy(strategyRecord());
  await first.saveBacktest(backtestRecord());
  await first.saveJournalEntry(journalEntry());
  await first.close();

  // Reopening replays the write-ahead log; a composite key that the replay did
  // not understand would come back as a row keyed by "undefined".
  const second = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => second.close());

  assert.equal((await second.findStrategy("trend-following", "1.0.0")).lifecycle, "DRAFT");
  assert.equal((await second.findBacktest("bt-1")).metrics.profitFactor, 1.8);
  assert.equal((await second.listJournalEntries({}))[0].pnl, 89.65);
  assert.deepEqual(await second.stats(), {
    users: 0, profiles: 0, sessions: 0, roles: 0, permissions: 0, userRoles: 0,
    rolePermissions: 0, audit: 0, inquiries: 0, analysisRuns: 0,
    strategies: 1, backtests: 1, journalEntries: 1,
  });
  // The checksum covers the new entities, so a restore can prove they came back.
  assert.match(await second.checksum(), /^[0-9a-f]{64}$/);
});

// ---- file adapter: backtests -----------------------------------------------

test("file adapter round-trips a backtest and returns summaries without payloads", async (t) => {
  const { storeDir } = await tempStore(t);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  const record = backtestRecord();
  await store.saveBacktest(record);

  const found = await store.findBacktest("bt-1");
  assert.deepEqual(found, record, "findBacktest returns the whole stored run");
  assert.equal(await store.findBacktest("missing"), null);

  const [summary] = await store.listBacktests({});
  assert.deepEqual(summary, {
    id: "bt-1",
    created_at: NOW,
    strategy_id: "trend-following",
    strategy_version: "1.0.0",
    symbol: "EURUSD",
    timeframe: "1h",
    synthetic: true,
    candles: 200,
    metrics: { trades: 40, profitFactor: 1.8, maxDrawdownPct: 12.5, expectancyPnl: 25 },
    warnings: [],
  });
  // The headline numbers a listing shows are promoted to columns, because the
  // legacy listing decoded every payload to reach them. The LARGE parts of a run
  // stay in the payload for the detail route — that split is the whole point.
  assert.equal("payload" in summary, false, "a listing must not carry the payload");
  assert.equal("trades" in summary, false, "the trade list belongs to the detail route");
  assert.equal("equityCurve" in summary, false, "the equity curve belongs to the detail route");
  assert.equal("dataProvenance" in summary, false);
  assert.equal("request" in summary, false);
  // A promoted column must come back as a deep copy, so a caller that mutates one
  // listed row cannot corrupt the stored run behind it.
  summary.metrics.profitFactor = 999;
  summary.warnings.push("tampered");
  const reread = await store.findBacktest("bt-1");
  assert.equal(reread.metrics.profitFactor, 1.8, "mutating a summary must not touch the store");
  assert.deepEqual(reread.warnings, []);
});

test("file adapter lists backtests newest first and clamps the limit", async (t) => {
  const { storeDir } = await tempStore(t);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  await store.saveBacktest(backtestRecord({ id: "bt-old", created_at: "2026-01-01T00:00:00.000Z" }));
  await store.saveBacktest(backtestRecord({ id: "bt-new", created_at: "2026-09-01T00:00:00.000Z" }));
  await store.saveBacktest(backtestRecord({ id: "bt-mid", created_at: "2026-05-01T00:00:00.000Z" }));
  await store.saveBacktest(
    backtestRecord({
      id: "bt-other",
      created_at: "2026-10-01T00:00:00.000Z",
      request: { strategyId: "breakout", strategyVersion: "1.0.0", symbol: "XAUUSD", timeframe: "4h" },
    }),
  );

  const all = await store.listBacktests({});
  assert.deepEqual(all.map((row) => row.id), ["bt-other", "bt-new", "bt-mid", "bt-old"]);

  const filtered = await store.listBacktests({ strategyId: "trend-following" });
  assert.deepEqual(filtered.map((row) => row.id), ["bt-new", "bt-mid", "bt-old"]);

  assert.equal((await store.listBacktests({ limit: 2 })).length, 2);
  assert.equal((await store.listBacktests({ limit: 0 })).length, 4, "a non-positive limit falls back to the default");
  assert.equal((await store.listBacktests({ limit: 9999 })).length, 4, "the ceiling is 100 but only 4 rows exist");
  assert.equal((await store.listBacktests({ strategyId: "" })).length, 4, "an empty filter means no filter");
});

test("file adapter scopes the two gate queries to an exact version", async (t) => {
  const { storeDir } = await tempStore(t);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  await store.saveBacktest(backtestRecord({ id: "bt-a", created_at: "2026-01-01T00:00:00.000Z" }));
  await store.saveBacktest(backtestRecord({ id: "bt-b", created_at: "2026-09-01T00:00:00.000Z" }));
  // Same strategy id, different version: must not count towards 1.0.0's evidence.
  await store.saveBacktest(
    backtestRecord({
      id: "bt-v2",
      created_at: "2026-10-01T00:00:00.000Z",
      request: { strategyId: "trend-following", strategyVersion: "1.0.1", symbol: "EURUSD", timeframe: "1h" },
      metrics: { trades: 1, profitFactor: 99, maxDrawdownPct: 0.1, expectancyPnl: 500 },
    }),
  );

  assert.equal(await store.countStrategyBacktests("trend-following", "1.0.0"), 2);
  assert.equal(await store.countStrategyBacktests("trend-following", "1.0.1"), 1);
  assert.equal(await store.countStrategyBacktests("trend-following", "9.9.9"), 0);
  assert.equal(await store.countStrategyBacktests("nope", "1.0.0"), 0);

  const latest = await store.latestStrategyBacktest("trend-following", "1.0.0");
  assert.equal(latest.id, "bt-b", "newest by created_at, not by insertion order");
  assert.equal(latest.metrics.profitFactor, 1.8);
  assert.equal((await store.latestStrategyBacktest("trend-following", "1.0.1")).id, "bt-v2");
  assert.equal(await store.latestStrategyBacktest("trend-following", "9.9.9"), null);
});

// ---- file adapter: journal -------------------------------------------------

test("file adapter round-trips journal entries and coerces money to numbers", async (t) => {
  const { storeDir } = await tempStore(t);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  // Deliberately written with STRINGS, as MySQL's decimalNumbers:false would
  // return them, to prove the adapter hands callers numbers either way.
  await store.saveJournalEntry(
    journalEntry({
      entry_price: "1.08543210",
      exit_price: "1.09123456",
      pnl: "89.65",
      pnl_pct: "0.529",
      r_multiple: "1.6",
      fees: "0.6789",
      slippage: "0.1234",
      ai_confidence: "0.8",
      risk_score: "0.01",
      position_size: "15432.1",
      stop_loss: "1.08",
      take_profit: "1.10",
    }),
  );

  const [entry] = await store.listJournalEntries({});
  for (const column of [
    "entry_price", "exit_price", "position_size", "stop_loss", "take_profit",
    "fees", "slippage", "pnl", "pnl_pct", "r_multiple", "ai_confidence", "risk_score",
  ]) {
    assert.equal(typeof entry[column], "number", `${column} must be a number, got ${typeof entry[column]}`);
  }
  assert.equal(entry.pnl, 89.65);
  assert.equal(entry.r_multiple, 1.6);
  assert.equal(entry.reason, "fresh EMA cross-up with ADX confirmation");
  assert.equal(entry.agent_consensus, null, "a nullable column stays null, it is not coerced to 0");
});

test("file adapter filters journal rows by source, strategy and symbol", async (t) => {
  const { storeDir } = await tempStore(t);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  await store.saveJournalEntry(journalEntry({ id: "j-bt", source: "backtest", strategy: "trend-following" }));
  await store.saveJournalEntry(journalEntry({ id: "j-paper", source: "paper", strategy: "trend-following" }));
  await store.saveJournalEntry(journalEntry({ id: "j-other", source: "paper", strategy: "breakout" }));
  await store.saveJournalEntry(
    journalEntry({ id: "j-symbol", source: "paper", strategy: "trend-following", symbol: "BTCUSDT", market: "crypto" }),
  );

  assert.deepEqual((await store.listJournalEntries({})).length, 4);
  const paper = await store.listJournalEntries({ source: "paper" });
  assert.deepEqual(paper.map((row) => row.id).sort(), ["j-other", "j-paper", "j-symbol"]);
  // This is the exact query the approval gate makes.
  const gate = await store.listJournalEntries({ source: "paper", strategy: "trend-following" });
  assert.deepEqual(gate.map((row) => row.id).sort(), ["j-paper", "j-symbol"]);
  assert.deepEqual((await store.listJournalEntries({ symbol: "BTCUSDT" })).map((row) => row.id), ["j-symbol"]);
  assert.deepEqual(await store.listJournalEntries({ source: "live" }), []);
  assert.equal((await store.listJournalEntries({ limit: 1 })).length, 1);
});

test("file adapter orders journal rows newest execution first", async (t) => {
  const { storeDir } = await tempStore(t);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  await store.saveJournalEntry(journalEntry({ id: "j-1", execution_time: "2026-01-01T00:00:00.000Z" }));
  await store.saveJournalEntry(journalEntry({ id: "j-3", execution_time: "2026-09-01T00:00:00.000Z" }));
  await store.saveJournalEntry(journalEntry({ id: "j-2", execution_time: "2026-05-01T00:00:00.000Z" }));

  assert.deepEqual(
    (await store.listJournalEntries({})).map((row) => row.id),
    ["j-3", "j-2", "j-1"],
  );
});

// ---- MySQL adapter: SQL text and bound values (not executed — F-15) ---------

test("mysql saveStrategy binds every value and never rewrites created_at", async () => {
  const pool = fakePool();
  const repo = createStrategyRepository(pool);
  await repo.saveStrategy(strategyRecord());

  assert.equal(pool.calls.length, 1);
  const { sql, values } = pool.calls[0];
  assert.match(sql, /INSERT INTO wf_strategies/);
  assert.match(sql, /ON DUPLICATE KEY UPDATE/);
  // created_at is in the INSERT column list but must be absent from the UPDATE
  // list, or a stage change would reset the registration timestamp.
  const updateList = sql.slice(sql.indexOf("ON DUPLICATE KEY UPDATE"));
  assert.equal(/created_at/.test(updateList), false, "created_at must not be updated");
  assert.match(updateList, /updated_at = VALUES\(updated_at\)/);
  assert.match(updateList, /lifecycle = VALUES\(lifecycle\)/);
  assert.match(updateList, /lifecycle_history = VALUES\(lifecycle_history\)/);

  // The four JSON columns are bound as strings, never interpolated.
  const record = strategyRecord();
  assert.deepEqual(values, [
    "trend-following",
    "1.0.0",
    record.name,
    record.description,
    JSON.stringify(record.market_classes),
    JSON.stringify(record.timeframes),
    JSON.stringify(record.params),
    "builtin",
    "DRAFT",
    NOW,
    NOW,
    JSON.stringify(record.lifecycle_history),
  ]);
  assert.equal(sql.split("?").length - 1, 12, "twelve placeholders for twelve columns");
});

test("mysql findStrategy decodes JSON columns and returns null when absent", async () => {
  const absent = fakePool({ rows: [] });
  assert.equal(await createStrategyRepository(absent).findStrategy("nope", "1.0.0"), null);
  assert.match(absent.calls[0].sql, /WHERE strategy_id = \? AND version = \?/);
  assert.match(absent.calls[0].sql, /LIMIT 1/);
  assert.deepEqual(absent.calls[0].values, ["nope", "1.0.0"]);

  const present = fakePool({
    rows: [{
      strategy_id: "trend-following",
      version: "1.0.0",
      name: "Trend Following",
      description: "d",
      market_classes: '["forex","crypto"]',
      timeframes: '["15m","1h"]',
      params: '{"fast":20}',
      source: "builtin",
      lifecycle: "VALIDATED",
      created_at: NOW,
      updated_at: NOW,
      lifecycle_history: '[{"from":null,"to":"DRAFT"}]',
    }],
  });
  const found = await createStrategyRepository(present).findStrategy("trend-following", "1.0.0");
  assert.deepEqual(found.market_classes, ["forex", "crypto"]);
  assert.deepEqual(found.timeframes, ["15m", "1h"]);
  assert.deepEqual(found.params, { fast: 20 });
  assert.deepEqual(found.lifecycle_history, [{ from: null, to: "DRAFT" }]);
  assert.equal(found.lifecycle, "VALIDATED");
});

test("mysql treats an unreadable JSON column as a 500, not as an empty default", async () => {
  const pool = fakePool({
    rows: [{
      strategy_id: "trend-following", version: "1.0.0", name: "n", description: null,
      market_classes: "{not json", timeframes: "[]", params: "{}",
      source: "builtin", lifecycle: "DRAFT", created_at: NOW, updated_at: NOW,
      lifecycle_history: "[]",
    }],
  });
  // Reporting a damaged row as `[]` would let a gate read "no criteria declared"
  // and pass a strategy it should refuse. That is the distinction under test.
  await assert.rejects(
    () => createStrategyRepository(pool).findStrategy("trend-following", "1.0.0"),
    (error) => {
      assert.equal(error.statusCode, 500);
      assert.match(error.message, /unreadable JSON column/);
      return true;
    },
  );

  // A genuinely absent column is different: it decodes to the fallback.
  const empty = fakePool({
    rows: [{
      strategy_id: "x", version: "1.0.0", name: "n", description: null,
      market_classes: null, timeframes: "", params: null,
      source: "builtin", lifecycle: "DRAFT", created_at: NOW, updated_at: NOW,
      lifecycle_history: null,
    }],
  });
  const found = await createStrategyRepository(empty).findStrategy("x", "1.0.0");
  assert.deepEqual(found.market_classes, []);
  assert.deepEqual(found.timeframes, []);
  assert.deepEqual(found.params, {});
  assert.deepEqual(found.lifecycle_history, []);
  assert.equal(found.description, "", "a NULL description reads as an empty string");
});

test("mysql interpolates a bounded LIMIT and never binds it", async () => {
  const pool = fakePool({ rows: [] });
  const repo = createStrategyRepository(pool);

  await repo.listBacktests({ limit: 25 });
  assert.match(pool.calls[0].sql, /LIMIT 25/);
  assert.deepEqual(pool.calls[0].values, [], "no filter means no bound values");

  // mysql2 does not bind LIMIT reliably, so the value is interpolated. That is
  // safe because what is interpolated is always a parsed, bounded INTEGER and
  // never the caller's string: parseInt keeps the leading digits of a hostile
  // value and discards the rest, so an injection attempt yields `LIMIT 50`.
  // Surprising, but inert — the property that matters is that no text survives.
  await repo.listBacktests({ limit: "50; DROP TABLE wf_backtests" });
  assert.match(pool.calls[1].sql, /LIMIT 50$/);
  assert.equal(/DROP/i.test(pool.calls[1].sql), false, "no injected keyword may reach the statement");
  assert.equal(pool.calls[1].sql.includes(";"), false, "no statement separator may reach the statement");

  // A value with no leading digits parses to NaN and falls back to the default.
  await repo.listBacktests({ limit: "abc" });
  assert.match(pool.calls[2].sql, /LIMIT 20$/, "an unparseable limit falls back to the default");

  await repo.listBacktests({ limit: 99999 });
  assert.match(pool.calls[3].sql, /LIMIT 100$/, "the ceiling is 100");
  await repo.listBacktests({ limit: -5 });
  assert.match(pool.calls[4].sql, /LIMIT 1$/, "the floor is 1");
  await repo.listBacktests({ limit: 12.9 });
  assert.match(pool.calls[5].sql, /LIMIT 12$/, "a fractional limit is truncated, not rounded up");
  await repo.listBacktests({ limit: null });
  assert.match(pool.calls[6].sql, /LIMIT 20$/, "an absent limit falls back to the default");
});

test("mysql binds filter values rather than interpolating them", async () => {
  const pool = fakePool({ rows: [] });
  const repo = createStrategyRepository(pool);

  await repo.listBacktests({ strategyId: "trend-following", limit: 10 });
  assert.match(pool.calls[0].sql, /WHERE strategy_id = \?/);
  assert.deepEqual(pool.calls[0].values, ["trend-following"]);

  await repo.listJournalEntries({ source: "paper", strategy: "trend-following", symbol: "EURUSD" });
  const { sql, values } = pool.calls[1];
  assert.match(sql, /WHERE source = \? AND strategy = \? AND symbol = \?/);
  assert.deepEqual(values, ["paper", "trend-following", "EURUSD"]);
  assert.match(sql, /ORDER BY execution_time DESC, id ASC/);
  assert.match(sql, /LIMIT 200$/);

  // A hostile strategy id must reach the driver as a bound value, never as SQL.
  await repo.listJournalEntries({ strategy: "x' OR '1'='1" });
  assert.deepEqual(pool.calls[2].values, ["x' OR '1'='1"]);
  assert.equal(/OR '1'='1/.test(pool.calls[2].sql), false, "the literal must not appear in the statement");

  await repo.listJournalEntries({ limit: 100000 });
  // 2000, not 1000: the legacy calibration query reads list([], 2000), and a lower
  // ceiling would truncate the sample a calibration verdict is computed from.
  assert.match(pool.calls[3].sql, /LIMIT 2000$/, "journal listings cap higher than backtest listings");
});

test("mysql returns counts as numbers and the latest backtest decoded", async () => {
  const counting = fakePool({ count: 7 });
  const count = await createStrategyRepository(counting).countStrategyBacktests("trend-following", "1.0.0");
  assert.equal(count, 7);
  assert.equal(typeof count, "number", "COUNT(*) comes back as a string from some drivers");
  assert.match(counting.calls[0].sql, /WHERE strategy_id = \? AND strategy_version = \?/);
  assert.deepEqual(counting.calls[0].values, ["trend-following", "1.0.0"]);

  const zero = fakePool({ rows: [[undefined]] });
  // A COUNT row that is somehow absent must read as 0, not NaN.
  const emptyPool = { async execute() { return [[], []]; } };
  assert.equal(await createStrategyRepository(emptyPool).countStrategyBacktests("x", "1"), 0);
  void zero;

  const payload = { id: "bt-9", metrics: { profitFactor: 2.1 } };
  const latestPool = fakePool({ rows: [{ payload: JSON.stringify(payload) }] });
  const latest = await createStrategyRepository(latestPool).latestStrategyBacktest("trend-following", "1.0.0");
  assert.deepEqual(latest, payload);
  assert.match(latestPool.calls[0].sql, /ORDER BY created_at DESC, id ASC/);
  assert.match(latestPool.calls[0].sql, /LIMIT 1/);

  const nonePool = fakePool({ rows: [] });
  assert.equal(await createStrategyRepository(nonePool).latestStrategyBacktest("x", "1"), null);
});

test("mysql converts DECIMAL columns to numbers on the way out", async () => {
  // The pool runs with decimalNumbers:false, so every DECIMAL arrives as a string.
  const pool = fakePool({
    rows: [{
      id: "j-1", source: "paper", symbol: "EURUSD", market: "forex",
      strategy: "trend-following", strategy_version: "1.0.0", direction: "LONG",
      entry_time: NOW, entry_price: "1.08543210", exit_time: NOW, exit_price: "1.09123456",
      position_size: "15432.10000000", stop_loss: "1.08000000", take_profit: "1.10000000",
      fees: "0.678900", slippage: "0.123400", pnl: "89.650000", pnl_pct: "0.529000",
      r_multiple: "1.600000", reason: "r", ai_confidence: "0.8000",
      confidence_source: "strategy", agent_consensus: null, risk_score: "0.010000",
      execution_time: NOW, backtest_id: null, paper_position_id: null,
    }],
  });
  const [entry] = await createStrategyRepository(pool).listJournalEntries({ source: "paper" });

  assert.equal(entry.entry_price, 1.0854321);
  assert.equal(entry.pnl, 89.65);
  assert.equal(entry.r_multiple, 1.6);
  assert.equal(entry.ai_confidence, 0.8);
  assert.equal(entry.position_size, 15432.1);
  // Nullables stay null rather than becoming 0, because 0 is a meaningful price.
  assert.equal(entry.exit_price, 1.09123456);
  assert.equal(entry.backtest_id, null);
  assert.equal(entry.paper_position_id, null);
  assert.equal(entry.agent_consensus, null);
});

test("mysql saveBacktest denormalises the payload's identifying fields", async () => {
  const pool = fakePool();
  await createStrategyRepository(pool).saveBacktest(backtestRecord());
  const { sql, values } = pool.calls[0];

  assert.match(sql, /INSERT INTO wf_backtests/);
  assert.match(sql, /ON DUPLICATE KEY UPDATE/);
  assert.equal(sql.split("?").length - 1, 11, "eleven placeholders for eleven columns");
  assert.deepEqual(values, [
    "bt-1",
    NOW,
    "trend-following",
    "1.0.0",
    "EURUSD",
    "1h",
    1,
    200,
    JSON.stringify({ trades: 40, profitFactor: 1.8, maxDrawdownPct: 12.5, expectancyPnl: 25 }),
    "[]",
    JSON.stringify(backtestRecord()),
  ]);
  // `synthetic` is bound as 1/0, not true/false: the column is TINYINT(1).
  assert.equal(values[6], 1);
  // The promoted columns are bound as JSON text, never interpolated.
  assert.equal(typeof values[8], "string");
  assert.equal(values[9], "[]");
  assert.match(sql, /candles = VALUES\(candles\)/);
  assert.match(sql, /metrics = VALUES\(metrics\)/);
  assert.match(sql, /warnings = VALUES\(warnings\)/);

  const live = fakePool();
  await createStrategyRepository(live).saveBacktest(
    backtestRecord({ id: "bt-live", dataProvenance: { source: "mt5", synthetic: false, candles: 500 } }),
  );
  assert.equal(live.calls[0].values[6], 0, "a live run must not be flagged synthetic");

  // A record missing its provenance block still writes, and defaults to not synthetic
  // rather than throwing on an optional field.
  const bare = fakePool();
  await createStrategyRepository(bare).saveBacktest({ id: "bt-bare", created_at: NOW, request: {} });
  assert.equal(bare.calls[0].values[2], "");
  assert.equal(bare.calls[0].values[6], 0);
  assert.equal(bare.calls[0].values[7], 0, "candles defaults to 0");
  assert.equal(bare.calls[0].values[8], "{}", "metrics defaults to an empty object");
  assert.equal(bare.calls[0].values[9], "[]", "warnings defaults to an empty array");
});

test("mysql saveJournalEntry binds nulls for absent optional columns", async () => {
  const pool = fakePool();
  await createStrategyRepository(pool).saveJournalEntry(
    journalEntry({
      exit_time: null,
      exit_price: null,
      stop_loss: null,
      take_profit: null,
      pnl: null,
      pnl_pct: null,
      r_multiple: null,
      reason: null,
      ai_confidence: null,
      confidence_source: null,
      agent_consensus: null,
      risk_score: null,
      backtest_id: null,
    }),
  );
  const { sql, values } = pool.calls[0];
  assert.equal(sql.split("?").length - 1, 27, "twenty-seven columns");
  // paper_position_id belongs to paper trading (row 10) and is never written here.
  assert.equal(values[26], null);
  assert.equal(values[9], null, "exit_time");
  assert.equal(values[10], null, "exit_price");
  assert.equal(values[16], null, "pnl");
  // Non-nullable money columns are still numbers.
  assert.equal(typeof values[8], "number", "entry_price");
  assert.equal(typeof values[11], "number", "position_size");
  assert.equal(typeof values[14], "number", "fees");
});

test("mysql listBacktests selects the promoted columns and never the payload", async () => {
  const pool = fakePool({ rows: [] });
  await createStrategyRepository(pool).listBacktests({ limit: 5 });
  const { sql } = pool.calls[0];
  assert.match(
    sql,
    /SELECT id, created_at, strategy_id, strategy_version, symbol, timeframe, synthetic,\s+candles, metrics, warnings/,
  );
  // This is the assertion the column promotion exists to make possible: a listing
  // of thirty runs must not read thirty LONGTEXT payloads.
  assert.equal(/payload/.test(sql), false, "a listing must never select the payload column");
  assert.match(sql, /LIMIT 5$/);

  // A corrupt metrics column on one row must not be reported as an empty object,
  // which would render as "no trades, no edge" rather than as damage.
  const corrupt = fakePool({ rows: [{ id: "bt-x", metrics: "{not json", warnings: "[]" }] });
  await assert.rejects(
    () => createStrategyRepository(corrupt).listBacktests({}),
    (error) => {
      assert.equal(error.statusCode, 500);
      assert.match(error.message, /unreadable JSON column/);
      return true;
    },
  );
});

test("mysql listStrategies orders by strategy_id then updated_at", async () => {
  const pool = fakePool({ rows: [] });
  await createStrategyRepository(pool).listStrategies();
  assert.match(pool.calls[0].sql, /ORDER BY strategy_id ASC, updated_at ASC/);
  assert.equal(pool.calls[0].kind, "query", "an unbounded listing uses query, not execute");
  assert.deepEqual(pool.calls[0].values, []);
});

// ---- parity ----------------------------------------------------------------

test("both adapters return the same strategy record for the same input", async (t) => {
  const { storeDir } = await tempStore(t);
  const file = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => file.close());

  const record = strategyRecord({ lifecycle: "VALIDATED", updated_at: "2026-10-11T00:00:00.000Z" });
  const sqlRows = [{
    strategy_id: record.strategy_id,
    version: record.version,
    name: record.name,
    description: record.description,
    market_classes: JSON.stringify(record.market_classes),
    timeframes: JSON.stringify(record.timeframes),
    params: JSON.stringify(record.params),
    source: record.source,
    lifecycle: record.lifecycle,
    created_at: record.created_at,
    updated_at: record.updated_at,
    lifecycle_history: JSON.stringify(record.lifecycle_history),
  }];

  await file.saveStrategy(record);
  const sql = createStrategyRepository(fakePool({ rows: sqlRows }));

  const fromFile = await file.findStrategy("trend-following", "1.0.0");
  const fromSql = await sql.findStrategy("trend-following", "1.0.0");
  assert.deepEqual(fromSql, fromFile, "a route must not be able to tell the adapters apart");
  assert.deepEqual(Object.keys(fromSql).sort(), Object.keys(fromFile).sort());
});

test("both adapters return the same journal entry types for the same input", async (t) => {
  const { storeDir } = await tempStore(t);
  const file = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => file.close());

  const entry = journalEntry();
  await file.saveJournalEntry(entry);
  const fromFile = (await file.listJournalEntries({ source: "backtest" }))[0];

  // The same row as MySQL would return it: every DECIMAL a string.
  const sqlRow = { ...entry };
  for (const column of [
    "entry_price", "exit_price", "position_size", "stop_loss", "take_profit",
    "fees", "slippage", "pnl", "pnl_pct", "r_multiple", "ai_confidence", "risk_score",
  ]) {
    if (sqlRow[column] !== null) sqlRow[column] = String(sqlRow[column]);
  }
  sqlRow.backtest_id = entry.backtest_id;
  sqlRow.paper_position_id = null;
  const fromSql = (await createStrategyRepository(fakePool({ rows: [sqlRow] })).listJournalEntries({ source: "backtest" }))[0];

  assert.equal(typeof fromSql.pnl, typeof fromFile.pnl, "pnl type must match");
  assert.equal(fromSql.pnl, fromFile.pnl);
  assert.equal(fromSql.r_multiple, fromFile.r_multiple);
  assert.equal(fromSql.entry_price, fromFile.entry_price);
  // The approval gate sums pnl and compares a profit factor, so a string from one
  // adapter and a number from the other would give different verdicts on the same
  // evidence.
  assert.equal(
    fromSql.pnl > 0,
    fromFile.pnl > 0,
    "the same evidence must produce the same comparison result",
  );
});

test("both adapters answer the approval gate's query identically", async (t) => {
  const { storeDir } = await tempStore(t);
  const file = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => file.close());

  const evidence = Array.from({ length: 10 }, (_, index) =>
    journalEntry({
      id: `j-${index}`,
      source: "paper",
      strategy: "trend-following",
      pnl: index < 6 ? 20 : -10,
      execution_time: `2026-10-0${index + 1}T00:00:00.000Z`,
    }),
  );
  for (const entry of evidence) await file.saveJournalEntry(entry);

  const fromFile = await file.listJournalEntries({ source: "paper", strategy: "trend-following" }, 200);
  const sqlRows = evidence
    .map((entry) => ({ ...entry, pnl: String(entry.pnl), paper_position_id: null }))
    .sort((a, b) => String(b.execution_time).localeCompare(String(a.execution_time)));
  const fromSql = await createStrategyRepository(fakePool({ rows: sqlRows })).listJournalEntries(
    { source: "paper", strategy: "trend-following" },
    200,
  );

  // Same rows, same order, same numeric verdicts — which is what makes the gate's
  // arithmetic adapter-independent.
  assert.deepEqual(fromFile.map((row) => row.id), fromSql.map((row) => row.id));
  const sum = (rows) => rows.reduce((total, row) => total + Number(row.pnl), 0);
  assert.equal(sum(fromFile), sum(fromSql));
  assert.equal(sum(fromFile), 6 * 20 - 4 * 10);
  const grossWin = (rows) => rows.filter((row) => row.pnl > 0).reduce((total, row) => total + row.pnl, 0);
  const grossLoss = (rows) => rows.filter((row) => row.pnl <= 0).reduce((total, row) => total - row.pnl, 0);
  assert.equal(grossWin(fromFile) / grossLoss(fromFile), grossWin(fromSql) / grossLoss(fromSql));
  assert.equal(grossWin(fromFile) / grossLoss(fromFile), 120 / 40);
});
