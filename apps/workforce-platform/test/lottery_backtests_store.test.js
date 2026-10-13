/**
 * The slice-4 repository surface: backtest reports and model versions, on both
 * adapters. The pins that matter here:
 *
 *  - a model version is ENSURED, never replaced: the second call with the same
 *    (model_name, model_version) returns the FIRST row (spec §33 — historical
 *    results stay connected to the model that produced them);
 *  - a backtest round-trips with its report decoded, period bounds as strings;
 *  - the SQL statements match legacy's column lists and clamps.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { REPOSITORY_METHODS } from "../src/persistence/contract.js";
import { LOTTERY_REPOSITORY_METHODS } from "../src/db/lottery-repository.js";
import { createFileStore } from "../src/persistence/file-store.js";

function tempStore(t) {
  return mkdtemp(path.join(tmpdir(), "wf-lot-backtest-")).then(async (dir) => {
    t.after(() => rm(dir, { recursive: true, force: true }));
    return { storeDir: path.join(dir, "store") };
  });
}

const REPORT = {
  label: "HISTORICAL SIMULATION",
  strategy: "RANDOM_BASELINE",
  linesPerDraw: 2,
  period: { from: "2026-01-11", to: "2026-01-15", drawsTested: 5, minHistoryDraws: 10, windowCap: 100 },
  simulatedCost: null,
  tierCounts: {},
};

function backtestInput(overrides = {}) {
  return {
    lotteryCode: "EUROMILLIONS",
    strategy: "RANDOM_BASELINE",
    modelVersion: "1.0",
    linesPerDraw: 2,
    drawsTested: 5,
    periodFrom: "2026-01-11",
    periodTo: "2026-01-15",
    datasetVersion: "n=15;last=2026-01-15",
    report: REPORT,
    createdAt: "2026-10-13T09:00:00.000Z",
    ...overrides,
  };
}

const MODEL = {
  modelName: "WINDELS Lottery Model",
  modelVersion: "1.0",
  config: { model: "WINDELS Lottery Model v1.0", backtester: { minHistory: 10, maxWindow: 100, maxLines: 10 } },
  datasetVersion: null,
  status: "ACTIVE",
  createdAt: "2026-10-13T09:00:00.000Z",
};

test("the five slice-4 methods are part of the 185-method contract, on both adapters", async (t) => {
  const { storeDir, cleanup } = await tempStore(t);
  t.after(cleanup);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  assert.equal(REPOSITORY_METHODS.length, 185, "180 (slice 3) + 5 backtest/model methods");
  for (const name of ["ensureLotteryModelVersion", "listLotteryModelVersions", "saveLotteryBacktest", "findLotteryBacktest", "listLotteryBacktests"]) {
    assert.equal(typeof store[name], "function", `the file adapter implements ${name}`);
    assert.ok(LOTTERY_REPOSITORY_METHODS.includes(name), `the SQL adapter declares ${name}`);
  }
});

test("a backtest round-trips with its report decoded, and lists newest first with legacy's clamp", async (t) => {
  const { storeDir, cleanup } = await tempStore(t);
  t.after(cleanup);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  const first = await store.saveLotteryBacktest(backtestInput());
  assert.ok(first.created);
  assert.equal(first.row.id, 1);
  assert.equal(first.row.report.label, "HISTORICAL SIMULATION", "the report is stored as JSON, decoded on read");
  assert.deepEqual(first.row.report.period, REPORT.period);
  assert.equal(first.row.period_from, "2026-01-11", "legacy's DATE column reads back as a string");
  assert.equal(first.row.lines_per_draw, 2);
  assert.equal(first.row.dataset_version, "n=15;last=2026-01-15");

  await store.saveLotteryBacktest(backtestInput({ strategy: "COMPARISON", periodFrom: null, periodTo: null, report: { label: "comparison" } }));
  const found = await store.findLotteryBacktest(2);
  assert.equal(found.strategy, "COMPARISON");
  assert.equal(found.period_from, null, "a null period bound stays null");
  assert.equal(await store.findLotteryBacktest(999), null);

  // Newest first, and the limit is legacy's own clamp min(500, max(1, limit)).
  const third = await store.saveLotteryBacktest(backtestInput({ strategy: "BALANCED_PROFILE" }));
  const listed = await store.listLotteryBacktests(2);
  assert.deepEqual(listed.map((row) => row.id), [third.row.id, 2]);
  assert.equal((await store.listLotteryBacktests(0)).length, 1, "clamp floor: 0 asks for 1");
  assert.equal((await store.listLotteryBacktests(10_000)).length, 3, "clamp ceiling: 500 or the table, whichever is smaller");
});

test("a model version is ensured once and never replaced; rows list oldest first", async (t) => {
  const { storeDir, cleanup } = await tempStore(t);
  t.after(cleanup);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  const first = await store.ensureLotteryModelVersion(MODEL);
  assert.ok(first.id >= 1);
  assert.equal(first.status, "ACTIVE");
  assert.deepEqual(first.config.backtester, { minHistory: 10, maxWindow: 100, maxLines: 10 }, "the config round-trips decoded");

  const again = await store.ensureLotteryModelVersion({ ...MODEL, config: { changed: true } });
  assert.equal(again.id, first.id, "an existing (name, version) pair returns the FIRST row");
  assert.deepEqual(again.config.backtester, { minHistory: 10, maxWindow: 100, maxLines: 10 }, "the stored config is not overwritten");

  const v2 = await store.ensureLotteryModelVersion({ ...MODEL, modelVersion: "1.1", createdAt: "2026-10-13T10:00:00.000Z" });
  assert.notEqual(v2.id, first.id, "a new version is a new row — rows are never deleted or replaced");
  const listed = await store.listLotteryModelVersions();
  assert.deepEqual(listed.map((row) => row.model_version), ["1.0", "1.1"], "oldest first");
});

test("the SQL adapter's statements match legacy's column lists, clamps and ensured-read shape", async () => {
  const calls = [];
  let nextId = 1;
  const backtests = [];
  const models = [];
  const pool = {
    async execute(sql, values = []) {
      calls.push({ kind: "execute", sql, values });
      if (/INSERT INTO wf_lottery_backtests/.test(sql)) {
        const id = nextId++;
        backtests.push({
          id, lottery_code: values[0], strategy: values[1], model_version: values[2],
          lines_per_draw: values[3], draws_tested: values[4], period_from: values[5], period_to: values[6],
          dataset_version: values[7], report: values[8], created_at: values[9],
        });
        return [{ affectedRows: 1, insertId: id }, []];
      }
      if (/INSERT INTO wf_lottery_model_versions/.test(sql)) {
        const id = nextId++;
        models.push({
          id, model_name: values[0], model_version: values[1], config: values[2],
          dataset_version: values[3], status: values[4], created_at: values[5],
        });
        return [{ affectedRows: 1, insertId: id }, []];
      }
      return [{ affectedRows: 0 }, []];
    },
    async query(sql, values = []) {
      calls.push({ kind: "query", sql, values });
      let candidate = [];
      if (/FROM wf_lottery_backtests WHERE id = \?/.test(sql)) candidate = backtests.filter((r) => r.id === values[0]);
      else if (/FROM wf_lottery_backtests ORDER BY id DESC/.test(sql)) candidate = [...backtests].sort((a, b) => b.id - a.id);
      else if (/FROM wf_lottery_model_versions WHERE model_name = \? AND model_version = \?/.test(sql)) candidate = models.filter((r) => r.model_name === values[0] && r.model_version === values[1]);
      else if (/FROM wf_lottery_model_versions ORDER BY id ASC/.test(sql)) candidate = [...models].sort((a, b) => a.id - b.id);
      const limitMatch = /LIMIT (\d+)/.exec(sql);
      return [candidate.slice(0, limitMatch ? Number(limitMatch[1]) : undefined), []];
    },
  };
  const { createStore } = await import("../src/db/store.js");
  const store = createStore(pool);

  const saved = await store.saveLotteryBacktest(backtestInput());
  assert.equal(saved.row.id, 1, "insert_id flows back through the re-read");
  const insert = calls.find((c) => c.kind === "execute" && c.sql.includes("INSERT INTO wf_lottery_backtests"));
  assert.match(insert.sql, /lottery_code, strategy, model_version, lines_per_draw, draws_tested, period_from, period_to, dataset_version, report, created_at/);
  assert.deepEqual(insert.values[3], 2);

  // The ensure: the WHERE names BOTH key columns, and the INSERT names legacy's six.
  await store.ensureLotteryModelVersion(MODEL);
  const ensureSelect = calls.filter((c) => c.kind === "query" && c.sql.includes("FROM wf_lottery_model_versions WHERE")).at(-1);
  assert.match(ensureSelect.sql, /WHERE model_name = \? AND model_version = \? LIMIT 1/);
  assert.deepEqual(ensureSelect.values, ["WINDELS Lottery Model", "1.0"]);
  const modelInsert = calls.find((c) => c.kind === "execute" && c.sql.includes("INSERT INTO wf_lottery_model_versions"));
  assert.match(modelInsert.sql, /model_name, model_version, config, dataset_version, status, created_at/);

  await store.listLotteryBacktests(25);
  const list = calls.filter((c) => c.kind === "query" && c.sql.includes("FROM wf_lottery_backtests ORDER BY id DESC")).at(-1);
  assert.match(list.sql, /ORDER BY id DESC LIMIT 25/);

  await store.listLotteryModelVersions();
  const versions = calls.filter((c) => c.kind === "query" && c.sql.includes("FROM wf_lottery_model_versions ORDER BY id ASC")).at(-1);
  assert.match(versions.sql, /ORDER BY id ASC/);
});
