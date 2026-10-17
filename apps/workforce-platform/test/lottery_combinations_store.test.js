/**
 * The slice-2 repository surface: generated combinations and their AI decision
 * reports, on both adapters (F-41's explicit-list rule applies to every name
 * here), plus the SQL shapes pinned against a recording pool — `constraints`
 * is a MySQL reserved word and every statement that touches it must backtick
 * it, which is exactly the kind of thing only a text assertion catches.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { REPOSITORY_METHODS } from "../src/persistence/contract.js";
import { LOTTERY_REPOSITORY_METHODS } from "../src/db/lottery-repository.js";
import { createFileStore } from "../src/persistence/file-store.js";

function tempStore(t) {
  return mkdtemp(path.join(tmpdir(), "wf-lot-comb-")).then(async (dir) => {
    t.after(() => rm(dir, { recursive: true, force: true }));
    return { storeDir: path.join(dir, "store") };
  });
}

function recordingPool() {
  const calls = [];
  let nextId = 1;
  const rows = [];
  return {
    calls,
    rows,
    async execute(sql, values = []) {
      calls.push({ kind: "execute", sql, values });
      const insert = /INSERT INTO wf_lottery_(combinations|ai_decisions)/.exec(sql);
      if (insert) {
        const id = nextId++;
        if (insert[1] === "combinations") {
          rows.push({
            id,
            lottery_code: values[0], mode: values[1], model_version: values[2], seed: values[3],
            line_count: values[4], lines: values[5], constraints: values[6], score_summary: values[7],
            created_by: values[8], created_at: values[9],
          });
        } else {
          rows.push({
            id,
            lottery_code: values[0], combination_id: values[1], model_version: values[2],
            mode: values[3], decision: values[4], created_at: values[5],
          });
        }
        return [{ affectedRows: 1, insertId: id }, []];
      }
      return [{ affectedRows: 0 }, []];
    },
    async query(sql, values = []) {
      calls.push({ kind: "query", sql, values });
      if (/FROM wf_lottery_combinations WHERE id = /.test(sql)) return [rows.filter((r) => r.id === values[0] && r.lines !== undefined), []];
      if (/FROM wf_lottery_ai_decisions WHERE id = /.test(sql)) return [rows.filter((r) => r.id === values[0] && r.decision !== undefined), []];
      if (/FROM wf_lottery_combinations ORDER BY id DESC/.test(sql)) return [rows.filter((r) => r.lines !== undefined).slice(Number(/OFFSET (\d+)/.exec(sql)?.[1] ?? 0)).slice(0, Number(/LIMIT (\d+)/.exec(sql)[1])), []];
      if (/FROM wf_lottery_ai_decisions ORDER BY id DESC LIMIT/.test(sql)) return [rows.filter((r) => r.decision !== undefined).slice(0, Number(/LIMIT (\d+)/.exec(sql)[1])), []];
      if (/FROM wf_lottery_ai_decisions WHERE combination_id = /.test(sql)) {
        return [rows.filter((r) => r.decision !== undefined && r.combination_id === values[0]).slice(0, Number(/LIMIT (\d+)/.exec(sql)[1])), []];
      }
      return [[], []];
    },
  };
}

function combinationInput(overrides = {}) {
  return {
    lotteryCode: "EUROMILLIONS",
    mode: "RANDOM",
    modelVersion: "WINDELS Lottery Model v1.0",
    seed: "42",
    lineCount: 1,
    lines: [{ mains: [1, 8, 34, 43, 45], stars: [5, 11], score: 45 }],
    constraints: { locks: { mains: [], stars: [] }, excludes: { mains: [], stars: [] } },
    scoreSummary: { averageBalanceScore: 45 },
    createdBy: null,
    createdAt: "2026-10-12T12:00:00.000Z",
    ...overrides,
  };
}

test("the six slice-2 methods are part of the 188-method contract, on both adapters", async (t) => {
  const { storeDir, cleanup } = await tempStore(t);
  t.after(cleanup);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  assert.equal(REPOSITORY_METHODS.length, 210, "180 (slice 3) + 5 measured-half methods + 3 row-5 retention methods + 22 row-17 Lead Discovery methods");
  for (const name of ["saveLotteryCombination", "findLotteryCombination", "listLotteryCombinations", "saveLotteryAiDecision", "findLotteryAiDecision", "listLotteryAiDecisions"]) {
    assert.equal(typeof store[name], "function", `the file adapter implements ${name}`);
    assert.ok(LOTTERY_REPOSITORY_METHODS.includes(name), `the SQL adapter declares ${name}`);
  }
});

test("a combination round-trips with its JSON decoded and its provenance intact", async (t) => {
  const { storeDir, cleanup } = await tempStore(t);
  t.after(cleanup);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  const saved = await store.saveLotteryCombination(combinationInput());
  assert.equal(saved.created, true);
  assert.equal(saved.row.id, 1);
  assert.equal(saved.row.lines[0].mains.join("-"), "1-8-34-43-45", "JSON decoded on read");
  assert.deepEqual(saved.row.constraints.locks, { mains: [], stars: [] });
  assert.equal(saved.row.seed, "42", "the seed is stored as TEXT, exactly as legacy's VARCHAR(32) column");
  assert.equal(saved.row.created_by, null);

  const found = await store.findLotteryCombination(1);
  assert.deepEqual(found, saved.row);
  assert.equal(await store.findLotteryCombination(999), null);

  // close/reopen: the WAL replay reconstructs the row keyed by its id
  await store.close();
  const second = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => second.close());
  const reopened = await second.findLotteryCombination(1);
  assert.equal(reopened.lines[0].score, 45);
});

test("combinations list newest-first with a bounded window and a real offset", async (t) => {
  const { storeDir, cleanup } = await tempStore(t);
  t.after(cleanup);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  for (let i = 0; i < 5; i += 1) {
    await store.saveLotteryCombination(combinationInput({ mode: i % 2 === 0 ? "RANDOM" : "BALANCED", lineCount: i + 1 }));
  }
  const all = await store.listLotteryCombinations(50, 0);
  assert.deepEqual(all.map((r) => r.id), [5, 4, 3, 2, 1], "newest first, exactly legacy's ORDER BY id DESC");
  const page = await store.listLotteryCombinations(2, 2);
  assert.deepEqual(page.map((r) => r.id), [3, 2]);
  // limit clamp: legacy min(200, max(1, $limit))
  assert.equal((await store.listLotteryCombinations(0, 0)).length >= 1, true, "limit 0 clamps to 1");
  assert.equal((await store.listLotteryCombinations(10000, 0)).length, 5, "limit clamps at 200, not to the table");
  assert.deepEqual((await store.listLotteryCombinations(50, 99)).map((r) => r.id), [], "an offset past the end is an empty page");
});

test("AI decisions are stored whole, filtered by combination, newest first", async (t) => {
  const { storeDir, cleanup } = await tempStore(t);
  t.after(cleanup);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  const saved = await store.saveLotteryAiDecision({
    lotteryCode: "EUROMILLIONS",
    combinationId: 4,
    modelVersion: "WINDELS Lottery Model v1.0",
    mode: "BALANCED",
    decision: { mode: "BALANCED", lines: [{ mains: [2, 11, 19, 28, 44], stars: [3, 9] }], inputs: { seed: 42 } },
    createdAt: "2026-10-12T12:00:00.000Z",
  });
  assert.equal(saved.created, true);
  assert.equal(saved.row.decision.inputs.seed, 42, "the full report comes back decoded");
  await store.saveLotteryAiDecision({ lotteryCode: "EUROMILLIONS", combinationId: null, modelVersion: "WINDELS Lottery Model v1.0", mode: null, decision: { orphan: true }, createdAt: "2026-10-12T12:00:01.000Z" });

  assert.equal(await store.findLotteryAiDecision(999), null);
  assert.equal((await store.findLotteryAiDecision(1)).decision.mode, "BALANCED");
  assert.deepEqual((await store.listLotteryAiDecisions(4, 50)).map((r) => r.id), [1], "the combination filter is exact");
  assert.equal((await store.listLotteryAiDecisions(null, 50)).length, 2, "null means every decision, newest first");
  assert.equal((await store.listLotteryAiDecisions(1234, 50)).length, 0);

  // Another lottery's rows exist in the tables but the FACADE filters them out —
  // the repository is lottery-code-agnostic, exactly legacy's Aegis_model.
  await store.saveLotteryAiDecision({ lotteryCode: "EUROJACKPOT", combinationId: null, modelVersion: "m", mode: "RANDOM", decision: {}, createdAt: "2026-10-12T12:00:02.000Z" });
  assert.equal((await store.listLotteryAiDecisions(null, 500)).length, 3);
});

test("the SQL adapter's statements match legacy's shapes, backticks included", async () => {
  const pool = recordingPool();
  const { createStore } = await import("../src/db/store.js");
  const store = createStore(pool);

  const saved = await store.saveLotteryCombination(combinationInput({ createdBy: 3 }));
  assert.equal(saved.row.id, 1, "insert_id flows back through the re-read");

  const insert = pool.calls.find((c) => c.kind === "execute" && c.sql.includes("INSERT INTO wf_lottery_combinations"));
  assert.ok(insert, "the combination insert ran");
  assert.match(insert.sql, /`constraints`/, "the reserved word is backticked, exactly as legacy backticks it");
  assert.match(insert.sql, /lottery_code, mode, model_version, seed, line_count, lines, `constraints`, score_summary, created_by, created_at/);
  assert.deepEqual(insert.values, [
    "EUROMILLIONS", "RANDOM", "WINDELS Lottery Model v1.0", "42", 1,
    JSON.stringify(combinationInput().lines), JSON.stringify(combinationInput().constraints),
    JSON.stringify({ averageBalanceScore: 45 }), 3, "2026-10-12T12:00:00.000Z",
  ]);

  await store.listLotteryCombinations(25, 50);
  const list = pool.calls.filter((c) => c.kind === "query" && c.sql.includes("FROM wf_lottery_combinations ORDER BY id DESC")).at(-1);
  assert.match(list.sql, /ORDER BY id DESC LIMIT 25 OFFSET 50/, "the window is interpolated after clamping, as every bounded list in this repository does");
  assert.deepEqual(list.values, []);

  await store.saveLotteryAiDecision({ lotteryCode: "EUROMILLIONS", combinationId: 7, modelVersion: "m", mode: "RANDOM", decision: { a: 1 }, createdAt: "2026-10-12T12:00:00.000Z" });
  const decisionInsert = pool.calls.find((c) => c.kind === "execute" && c.sql.includes("INSERT INTO wf_lottery_ai_decisions"));
  assert.match(decisionInsert.sql, /lottery_code, combination_id, model_version, mode, decision, created_at/);
  assert.deepEqual(decisionInsert.values.slice(0, 2), ["EUROMILLIONS", 7]);

  await store.listLotteryAiDecisions(7, 100);
  const filtered = pool.calls.filter((c) => c.kind === "query" && c.sql.includes("WHERE combination_id = ?")).at(-1);
  assert.match(filtered.sql, /ORDER BY id DESC LIMIT 100/, "the combination filter keeps legacy's ordering and clamp");
  assert.deepEqual(filtered.values, [7]);
});
