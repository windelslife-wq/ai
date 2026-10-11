import assert from "node:assert/strict";
import test from "node:test";

import { createPaperRepository } from "../src/db/paper-repository.js";
import { createStore } from "../src/db/store.js";

function recordingExecutor({ resultRows = [], insertId = 1 } = {}) {
  const calls = [];
  return {
    calls,
    async execute(sql, values = []) {
      calls.push({ method: "execute", sql, values });
      if (/^\s*INSERT/i.test(sql)) return [{ insertId, affectedRows: 1 }, []];
      return [resultRows, []];
    },
    async query(sql, values = []) {
      calls.push({ method: "query", sql, values });
      return [resultRows];
    },
  };
}

test("MySQL paper reads bind the owner alongside account and child identifiers", async () => {
  const account = {
    id: "17", owner_user_id: "9", name: "Private", currency: "USD",
    starting_balance: "10000.00", balance: "9999.00", peak_equity: "10000.00", revision: "2",
    created_at: "2026-10-10T12:00:00.000Z",
  };
  const executor = recordingExecutor({ resultRows: [account] });
  const repo = createPaperRepository(executor, { lockRows: true });

  const found = await repo.findPaperAccount(17, 9);
  assert.equal(found.id, 17);
  assert.equal(found.owner_user_id, 9);
  assert.equal(found.balance, 9999);
  assert.deepEqual(executor.calls[0].values, [17, 9]);
  assert.match(executor.calls[0].sql, /WHERE id = \? AND owner_user_id = \? LIMIT 1 FOR UPDATE/);

  await repo.findPaperPosition(17, 31, 9);
  assert.deepEqual(executor.calls[1].values, [17, 31, 9]);
  assert.match(executor.calls[1].sql, /JOIN wf_paper_accounts a ON a\.id = p\.account_id/);
  assert.match(executor.calls[1].sql, /a\.owner_user_id = \?/);
  assert.match(executor.calls[1].sql, /FOR UPDATE/);

  await repo.findPaperDeployment(44, 9);
  assert.deepEqual(executor.calls[2].values, [44, 9]);
  assert.match(executor.calls[2].sql, /a\.owner_user_id = \?/);
});

test("MySQL account listings, orders, positions, trades and deployments carry owner filters", async () => {
  const executor = recordingExecutor();
  const repo = createPaperRepository(executor);

  await repo.listPaperAccounts(9, 25);
  assert.deepEqual(executor.calls[0].values, [9]);
  assert.match(executor.calls[0].sql, /WHERE owner_user_id = \?/);

  await repo.listPaperOrders({ accountId: 17, ownerUserId: 9, status: "PENDING", limit: 10 });
  assert.deepEqual(executor.calls[1].values, [17, 9, "PENDING"]);
  assert.match(executor.calls[1].sql, /JOIN wf_paper_accounts a ON a\.id = o\.account_id/);
  assert.match(executor.calls[1].sql, /a\.owner_user_id = \?/);

  await repo.listPaperPositions({ accountId: 17, ownerUserId: 9, status: "OPEN", limit: 10 });
  assert.deepEqual(executor.calls[2].values, [17, 9, "OPEN"]);
  assert.match(executor.calls[2].sql, /a\.owner_user_id = \?/);

  await repo.listPaperTrades({ accountId: 17, ownerUserId: 9, limit: 10 });
  assert.deepEqual(executor.calls[3].values, [17, 9]);
  assert.match(executor.calls[3].sql, /a\.owner_user_id = \?/);

  await repo.listPaperDeployments({ accountId: 17, ownerUserId: 9, active: true, limit: 10 });
  assert.deepEqual(executor.calls[4].values, [17, 9, 1]);
  assert.match(executor.calls[4].sql, /a\.owner_user_id = \?/);
});

test("MySQL paper writes bind synthetic provenance and use the migration's column counts", async () => {
  const executor = recordingExecutor({ insertId: 23 });
  const repo = createPaperRepository(executor);
  const order = await repo.savePaperOrder({
    account_id: 17,
    symbol: "EURUSD",
    market_class: "forex",
    side: "BUY",
    type: "MARKET",
    units: 20,
    price: 100,
    stop_loss: 95,
    take_profit: 115,
    status: "FILLED",
    reject_reason: null,
    risk_amount: 100,
    reason: "fixture",
    ai_confidence: 0.75,
    strategy: "trend-following",
    strategy_version: "1.0.0",
    synthetic: true,
    created_at: "2026-10-10T12:00:00.000Z",
    filled_at: "2026-10-10T12:00:01.000Z",
    fill_price: 100.03,
  });
  assert.equal(order.id, 23);
  assert.equal(order.synthetic, true);
  assert.equal(executor.calls[0].sql.split("?").length - 1, 20);
  assert.equal(executor.calls[0].values[0], 17);
  assert.equal(executor.calls[0].values[16], 1, "synthetic is bound as a boolean bit");
  assert.equal(executor.calls[0].values[19], 100.03);
  assert.match(executor.calls[0].sql, /synthetic, created_at, filled_at, fill_price/);

  await repo.savePaperPosition({
    account_id: 17,
    symbol: "EURUSD",
    market_class: "forex",
    direction: "LONG",
    units: 20,
    entry_price: 100.03,
    stop_loss: 95,
    take_profit: 115,
    entry_fee: 0.4,
    risk_amount: 100,
    strategy: null,
    strategy_version: null,
    reason: null,
    ai_confidence: null,
    synthetic: true,
    opened_at: "2026-10-10T12:00:01.000Z",
    status: "OPEN",
    closed_at: null,
    exit_price: null,
    realized_pnl: null,
    exit_reason: null,
  });
  assert.equal(executor.calls[1].sql.split("?").length - 1, 21);
  assert.equal(executor.calls[1].values[14], 1);
  assert.ok(executor.calls[1].sql.includes("synthetic,\n              opened_at, status"));
});

test("MySQL trading state stores JSON separately from updater metadata", async () => {
  const row = {
    state_json: JSON.stringify({
      tradingMode: "PAPER_TRADING",
      killSwitch: { active: false, activatedAt: null, reason: null },
      allowSyntheticPaperData: true,
      riskLimits: { riskPerTradePct: 0.01 },
    }),
    updated_by_user_id: "9",
    updated_at: "2026-10-10T12:00:00.000Z",
  };
  const executor = recordingExecutor({ resultRows: [row] });
  const repo = createPaperRepository(executor);
  const state = await repo.loadTradingState();
  assert.equal(state.tradingMode, "PAPER_TRADING");
  assert.equal(state.allowSyntheticPaperData, true);
  assert.equal(state.updatedByUserId, 9);
  assert.equal(state.updatedAt, row.updated_at);

  await repo.saveTradingState(state, { updatedByUserId: 9, updatedAt: row.updated_at });
  assert.deepEqual(executor.calls[1].values, [
    JSON.stringify({
      tradingMode: "PAPER_TRADING",
      killSwitch: { active: false, activatedAt: null, reason: null },
      allowSyntheticPaperData: true,
      riskLimits: { riskPerTradePct: 0.01 },
    }),
    9,
    row.updated_at,
  ]);
});

test("paper mutations run on a pinned SQL transaction with row locks and rollback on errors", async () => {
  const calls = [];
  const accountRow = {
    id: 17, owner_user_id: 9, name: "Private", currency: "USD",
    starting_balance: 10000, balance: 10000, peak_equity: 10000, revision: 0,
    created_at: "2026-10-10T12:00:00.000Z",
  };
  const connection = {
    async beginTransaction() { calls.push({ operation: "begin" }); },
    async commit() { calls.push({ operation: "commit" }); },
    async rollback() { calls.push({ operation: "rollback" }); },
    release() { calls.push({ operation: "release" }); },
    async execute(sql, values = []) {
      calls.push({ operation: "execute", sql, values });
      if (/FROM wf_trading_state/.test(sql)) return [[], []];
      if (/FROM wf_paper_accounts/.test(sql)) return [[accountRow], []];
      return [{ affectedRows: 1, insertId: 1 }, []];
    },
    async query(sql, values = []) {
      calls.push({ operation: "query", sql, values });
      return [[], []];
    },
  };
  const store = createStore({
    async getConnection() { return connection; },
  });

  const result = await store.withPaperTransaction(async (tx) => {
    assert.equal(await tx.loadTradingState(), null);
    return tx.findPaperAccount(17, 9);
  });
  assert.equal(result.owner_user_id, 9);
  assert.ok(calls.some((entry) => entry.operation === "begin"));
  assert.ok(calls.some((entry) => entry.operation === "commit"));
  assert.equal(calls.some((entry) => entry.operation === "rollback"), false);
  const lockedReads = calls.filter((entry) => entry.operation === "execute" && /SELECT/.test(entry.sql));
  assert.equal(lockedReads.length, 2);
  assert.ok(lockedReads.every((entry) => /FOR UPDATE/.test(entry.sql)));
  assert.ok(lockedReads[0].sql.includes("LIMIT 1 FOR UPDATE"), "the locking clause follows LIMIT in MySQL SELECT syntax");
  assert.deepEqual(lockedReads[1].values, [17, 9]);

  await assert.rejects(
    store.withPaperTransaction(async () => { throw new Error("fixture failure"); }),
    /fixture failure/,
  );
  assert.equal(calls.filter((entry) => entry.operation === "rollback").length, 1);
  assert.equal(calls.filter((entry) => entry.operation === "release").length, 2);
});
