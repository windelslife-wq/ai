import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileStore } from "../src/persistence/file-store.js";
import { createPaperService } from "../src/modules/paper/service.js";

const ACTOR = 7;
const BASE_TIME = Date.parse("2026-10-10T12:00:00.000Z");

async function makeStore(t) {
  const directory = await mkdtemp(join(tmpdir(), "wf-paper-service-"));
  let store = await createFileStore({ dir: join(directory, "store"), syncWrites: false });
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    store,
    replaceStore: async () => {
      await store.close();
      store = await createFileStore({ dir: join(directory, "store"), syncWrites: false });
      return store;
    },
  };
}

function marketData({ now = () => BASE_TIME, price = 100, synthetic = false, quoteTimestamp = null } = {}) {
  const state = {
    price,
    synthetic,
    quoteTimestamp,
    bar: { low: price - 1, high: price + 1, close: price },
  };
  const quoteCalls = [];
  const candleCalls = [];
  return {
    state,
    quoteCalls,
    candleCalls,
    setPrice(value) { state.price = value; },
    setSynthetic(value) { state.synthetic = value; },
    setQuoteTimestamp(value) { state.quoteTimestamp = value; },
    setBar(value) { state.bar = { ...state.bar, ...value }; },
    async quote({ symbol }) {
      quoteCalls.push(symbol);
      return {
        quote: { symbol, last: state.price, timestamp: state.quoteTimestamp ?? now() },
        source: "paper-test-feed",
        synthetic: state.synthetic,
        fetchedAt: now(),
      };
    },
    async candles({ symbol, marketClass, timeframe, limit }) {
      candleCalls.push({ symbol, marketClass, timeframe, limit });
      const count = Math.max(Number(limit) || 2, 100);
      const candles = Array.from({ length: count }, (_, index) => ({
        timestamp: now() - (count - index) * 60_000,
        open: state.bar.close,
        high: state.bar.high,
        low: state.bar.low,
        close: state.bar.close,
        volume: 1_000,
      }));
      return {
        symbol,
        marketClass,
        timeframe,
        candles,
        provenance: {
          source: "paper-test-feed",
          synthetic: state.synthetic,
          live: !state.synthetic,
          dataTimestamp: now(),
          fetchedAt: now(),
          stale: false,
        },
      };
    },
  };
}

function serviceFor(store, data = marketData(), options = {}) {
  return createPaperService({
    store,
    marketData: data,
    now: options.now ?? (() => BASE_TIME),
    strategies: options.strategies ?? null,
  });
}

async function enablePaper(service, { allowSynthetic = false } = {}) {
  await service.setTradingMode("PAPER_TRADING", { actorId: ACTOR });
  await service.setKillSwitch(false, null, { actorId: ACTOR });
  if (allowSynthetic) await service.setSyntheticPaperData(true, { actorId: ACTOR });
}

async function accountFor(service, ownerUserId = ACTOR, startingBalance = 10_000) {
  const summary = await service.createAccount(ownerUserId, {
    name: "Test portfolio",
    startingBalance,
    currency: "USD",
  });
  return summary.account;
}

const ORDER = Object.freeze({
  symbol: "EURUSD",
  marketClass: "forex",
  side: "BUY",
  type: "MARKET",
  stopLoss: 95,
  takeProfit: 115,
  reason: "paper service fixture",
  confidence: 0.75,
});

const notFound = (error) => error?.statusCode === 404;

test("trading governance starts safe, validates limits, audits and survives a file-store restart", async (t) => {
  const harness = await makeStore(t);
  const data = marketData();
  let service = serviceFor(harness.store, data);

  const initial = await service.tradingState();
  assert.equal(initial.tradingMode, "ANALYSIS_ONLY");
  assert.equal(initial.killSwitch.active, true);
  assert.equal(initial.allowSyntheticPaperData, false);
  assert.equal(initial.simulationOnly, true);
  assert.equal(initial.liveTradingEnabled, false);

  await assert.rejects(
    service.updateRiskLimits({ requireStopLoss: false }, { actorId: ACTOR }),
    (error) => error.statusCode === 400 && error.code === "INVALID_RISK_LIMIT",
  );
  await assert.rejects(
    service.updateRiskLimits({ maxOpenPositions: 1.5 }, { actorId: ACTOR }),
    (error) => error.statusCode === 400 && error.code === "INVALID_RISK_LIMIT",
  );
  await assert.rejects(
    service.updateRiskLimits({ riskPerTradePct: 0.06 }, { actorId: ACTOR }),
    (error) => error.statusCode === 400 && error.code === "INVALID_RISK_LIMIT",
  );

  const updated = await service.updateRiskLimits({
    riskPerTradePct: 0.015,
    maxRiskPerTradePct: 0.02,
    maxOpenPositions: 3,
    blockSyntheticData: false,
  }, { actorId: ACTOR });
  assert.equal(updated.limits.riskPerTradePct, 0.015);
  assert.equal(updated.limits.maxOpenPositions, 3);
  assert.equal(updated.limits.blockSyntheticData, false);

  await service.setTradingMode("PAPER_TRADING", { actorId: ACTOR });
  await service.setKillSwitch(false, null, { actorId: ACTOR });
  await service.setSyntheticPaperData(true, { actorId: ACTOR });
  const beforeRestart = await service.tradingState();
  assert.equal(beforeRestart.tradingMode, "PAPER_TRADING");
  assert.equal(beforeRestart.killSwitch.active, false);
  assert.equal(beforeRestart.allowSyntheticPaperData, true);
  assert.equal(beforeRestart.riskLimits.maxOpenPositions, 3);

  const restartedStore = await harness.replaceStore();
  service = serviceFor(restartedStore, data);
  const afterRestart = await service.tradingState();
  assert.deepEqual(afterRestart, beforeRestart);
  const audit = (await restartedStore.snapshot()).audit;
  assert.deepEqual(
    audit.map((event) => event.action_key),
    [
      "governance.risk-limits.updated",
      "governance.trading-mode.changed",
      "governance.kill-switch.released",
      "governance.synthetic-paper.changed",
    ],
  );
  assert.ok(audit.every((event) => event.actor_user_id === ACTOR));
});

test("every account operation checks the owner before provider or strategy work", async (t) => {
  const { store } = await makeStore(t);
  const data = marketData();
  let strategyLookups = 0;
  const strategies = {
    async findRecordForPaper() { strategyLookups += 1; return null; },
    async findRecord() { strategyLookups += 1; return null; },
    implementation() { strategyLookups += 1; return null; },
    canDeployToPaper() { strategyLookups += 1; return { ok: false, reasons: ["not eligible"] }; },
  };
  const service = serviceFor(store, data, { strategies });
  const account = await accountFor(service, ACTOR);

  await assert.rejects(service.accountSummary(ACTOR + 1, account.id), notFound);
  await assert.rejects(service.listOrders(ACTOR + 1, account.id), notFound);
  await assert.rejects(service.positions(ACTOR + 1, account.id), notFound);
  await assert.rejects(service.listDeployments(ACTOR + 1, account.id), notFound);
  await assert.rejects(service.submitOrder(ACTOR + 1, account.id, ORDER), notFound);
  await assert.rejects(service.closePosition(ACTOR + 1, account.id, 1), notFound);
  await assert.rejects(service.tick(ACTOR + 1, account.id), notFound);
  await assert.rejects(service.deployStrategy(ACTOR + 1, account.id, { strategyId: "private-strategy" }), notFound);
  await assert.rejects(service.toggleDeployment(ACTOR + 1, account.id, 1, true), notFound);

  assert.deepEqual(data.quoteCalls, [], "a guessed account ID must not trigger quote retrieval");
  assert.deepEqual(data.candleCalls, [], "a guessed account ID must not trigger candle retrieval");
  assert.equal(strategyLookups, 0, "a guessed account ID must not trigger strategy resolution");
});

test("market orders are simulated, risk-sized, filled once and closed into the audit journal", async (t) => {
  const { store } = await makeStore(t);
  const data = marketData();
  const service = serviceFor(store, data);
  await enablePaper(service);
  const account = await accountFor(service);

  const result = await service.submitOrder(ACTOR, account.id, ORDER);
  assert.equal(result.filled, true);
  assert.equal(result.order.status, "FILLED");
  assert.equal(result.order.synthetic, false);
  assert.equal(result.position.direction, "LONG");
  assert.equal(result.position.units, 20);
  assert.equal(result.position.synthetic, false);
  assert.equal(result.position.entry_price, 100.03);
  assert.equal(result.position.stop_loss, 95);
  assert.equal(result.position.take_profit, 115);
  assert.equal(result.order.risk_amount, 100);
  assert.equal(result.riskDecision.approved, true);

  const duplicate = await service.submitOrder(ACTOR, account.id, ORDER);
  assert.equal(duplicate.filled, false);
  assert.equal(duplicate.order.status, "REJECTED");
  assert.match(duplicate.order.reject_reason, /Already holding/);
  assert.equal((await store.listPaperPositions({ accountId: account.id, ownerUserId: ACTOR, status: "OPEN" })).length, 1);

  const close = await service.closePosition(ACTOR, account.id, result.position.id);
  assert.equal(close.position.status, "CLOSED");
  assert.equal(close.position.exit_reason, "MANUAL");
  assert.ok(close.netPnl < 0, "a round trip at the same mark pays spread, slippage and commission");
  const trades = await store.listPaperTrades({ accountId: account.id, ownerUserId: ACTOR });
  assert.deepEqual(trades.map((trade) => trade.leg).sort(), ["ENTRY", "EXIT"]);
  assert.equal(trades.every((trade) => trade.synthetic === false), true);

  const [journal] = await store.listJournalEntries({ source: "paper", strategy: null });
  assert.equal(journal.synthetic, false);
  assert.equal(journal.paper_position_id, result.position.id);
  assert.equal(journal.source, "paper");
  assert.equal((await store.listPaperOrders({ accountId: account.id, ownerUserId: ACTOR })).length, 2);
  assert.ok((await store.snapshot()).audit.some((event) => event.action_key === "paper.position.closed"));
  const summary = await service.accountSummary(ACTOR, account.id);
  assert.equal(summary.simulationOnly, true);
  assert.equal(summary.liveTradingEnabled, false);
  assert.equal(summary.openPositions, 0);
});

test("kill switch, analysis-only mode, synthetic provenance and stale data veto paper fills", async (t) => {
  const { store } = await makeStore(t);
  const data = marketData({ synthetic: true });
  const service = serviceFor(store, data);
  const account = await accountFor(service);

  const defaultRefusal = await service.submitOrder(ACTOR, account.id, ORDER);
  assert.equal(defaultRefusal.order.status, "REJECTED");
  assert.match(defaultRefusal.order.reject_reason, /Kill switch is ACTIVE/);
  assert.equal(defaultRefusal.order.synthetic, true);

  await service.setTradingMode("PAPER_TRADING", { actorId: ACTOR });
  const switchRefusal = await service.submitOrder(ACTOR, account.id, ORDER);
  assert.equal(switchRefusal.order.status, "REJECTED");
  assert.match(switchRefusal.order.reject_reason, /Kill switch is ACTIVE/);

  await service.setKillSwitch(false, null, { actorId: ACTOR });
  // The paper-specific synthetic switch remains a hard gate even if the more
  // general RiskEngine limit is relaxed for analysis proposals.
  await service.updateRiskLimits({ blockSyntheticData: false }, { actorId: ACTOR });
  const syntheticRefusal = await service.submitOrder(ACTOR, account.id, ORDER);
  assert.equal(syntheticRefusal.order.status, "REJECTED");
  assert.match(syntheticRefusal.order.reject_reason, /SYNTHETIC/);
  assert.equal(syntheticRefusal.order.synthetic, true);

  await service.setSyntheticPaperData(true, { actorId: ACTOR });
  const staleTimestamp = BASE_TIME - 10 * 60_000;
  data.setQuoteTimestamp(staleTimestamp);
  const staleRefusal = await service.submitOrder(ACTOR, account.id, ORDER);
  assert.equal(staleRefusal.order.status, "REJECTED");
  assert.match(staleRefusal.order.reject_reason, /stale/i);

  data.setQuoteTimestamp(BASE_TIME);
  const fill = await service.submitOrder(ACTOR, account.id, ORDER);
  assert.equal(fill.filled, true);
  assert.equal(fill.position.synthetic, true);
  await service.setSyntheticPaperData(false, { actorId: ACTOR });
  const scan = await service.portfolioRiskScan(ACTOR);
  assert.ok(scan.accounts[0].breaches.some((breach) => breach.code === "SYNTHETIC_EXPOSURE"),
    "the portfolio scan flags synthetic exposure when the explicit paper-data setting is disabled");
  const closed = await service.closePosition(ACTOR, account.id, fill.position.id);
  assert.equal(closed.position.synthetic, true);
  const trades = await store.listPaperTrades({ accountId: account.id, ownerUserId: ACTOR });
  assert.equal(trades.length, 2);
  assert.ok(trades.every((trade) => trade.synthetic === true), "both legs must preserve the trade's synthetic provenance");
  const [journal] = await store.listJournalEntries({ source: "paper", strategy: null });
  assert.equal(journal.synthetic, true, "synthetic executions are labelled and cannot masquerade as live evidence");
});

test("ticks fill a crossed limit order, enforce stop-first exits, and retain fill history", async (t) => {
  const { store } = await makeStore(t);
  const data = marketData();
  const service = serviceFor(store, data);
  await enablePaper(service);
  const account = await accountFor(service);

  const submitted = await service.submitOrder(ACTOR, account.id, {
    ...ORDER,
    type: "LIMIT",
    price: 100,
  });
  assert.equal(submitted.filled, false);
  assert.equal(submitted.order.status, "PENDING");
  assert.equal(submitted.order.units, 20);

  data.setBar({ low: 99, high: 101, close: 100 });
  const fillTick = await service.tick(ACTOR, account.id);
  assert.equal(fillTick.actions.filledOrders.length, 1);
  assert.equal(fillTick.actions.filledOrders[0].id, submitted.order.id);
  assert.equal(fillTick.actions.filledOrders[0].status, "FILLED");
  assert.equal(fillTick.summary.openPositions, 1);

  data.setBar({ low: 94, high: 116, close: 105 });
  const closeTick = await service.tick(ACTOR, account.id);
  assert.equal(closeTick.actions.closedPositions.length, 1);
  assert.equal(closeTick.actions.closedPositions[0].position.exit_reason, "STOP_LOSS");
  assert.equal(closeTick.summary.openPositions, 0);
  const trades = await store.listPaperTrades({ accountId: account.id, ownerUserId: ACTOR });
  assert.deepEqual(trades.map((trade) => trade.leg).sort(), ["ENTRY", "EXIT"]);
  assert.equal((await store.listPaperOrders({ accountId: account.id, ownerUserId: ACTOR }))[0].status, "FILLED");
  assert.ok((await store.snapshot()).audit.some((event) => event.action_key === "paper.stop-loss.triggered"));
});

test("deployment and tick evaluate an executable strategy only for an owned account", async (t) => {
  const { store } = await makeStore(t);
  const data = marketData();
  let evaluations = 0;
  const strategyRecord = {
    strategy_id: "trend-following",
    version: "1.0.0",
    name: "Fixture strategy",
    description: "test-only strategy",
    market_classes: ["forex"],
    timeframes: ["1h"],
    params: {},
    source: "builtin",
    lifecycle: "RISK_REVIEWED",
    created_at: new Date(BASE_TIME).toISOString(),
    updated_at: new Date(BASE_TIME).toISOString(),
    lifecycle_history: [],
    human_signoff: null,
  };
  await store.saveStrategy(strategyRecord);
  const executable = {
    marketClasses: () => ["forex"],
    timeframes: () => ["1h"],
    supportsShorts: () => true,
    evaluate: () => {
      evaluations += 1;
      return { action: "BUY", stopLoss: 95, takeProfit: 115, confidence: 0.8, reason: "fixture signal" };
    },
  };
  const strategies = {
    async findRecordForPaper(id, version) {
      return store.findStrategy(id, version || "1.0.0");
    },
    async findRecord(id) {
      return store.findStrategy(id, "1.0.0");
    },
    implementation(id, version) {
      return id === "trend-following" && version === "1.0.0" ? executable : null;
    },
    canDeployToPaper(record) {
      return record?.lifecycle === "RISK_REVIEWED" || record?.lifecycle === "PAPER_TRADING"
        ? { ok: true, reasons: [] }
        : { ok: false, reasons: ["risk review required"] };
    },
  };
  const service = serviceFor(store, data, { strategies });
  await enablePaper(service);
  const account = await accountFor(service);

  await assert.rejects(
    service.deployStrategy(ACTOR + 1, account.id, {
      strategyId: "trend-following", symbol: "EURUSD", marketClass: "forex", timeframe: "1h",
    }),
    notFound,
  );
  const deployment = await service.deployStrategy(ACTOR, account.id, {
    strategyId: "trend-following", symbol: "EURUSD", marketClass: "forex", timeframe: "1h",
  });
  assert.equal(deployment.active, true);
  assert.equal(deployment.strategy_id, "trend-following");
  assert.equal((await store.findStrategy("trend-following", "1.0.0")).lifecycle, "PAPER_TRADING");

  const tick = await service.tick(ACTOR, account.id);
  assert.equal(evaluations, 1);
  assert.equal(tick.actions.strategySignals.length, 1);
  assert.equal(tick.actions.strategySignals[0].action, "BUY");
  assert.equal(tick.actions.strategySignals[0].submitted, true);
  assert.equal(tick.summary.openPositions, 1);

  const paused = await service.toggleDeployment(ACTOR, account.id, deployment.id, false);
  assert.equal(paused.active, false);
  await service.tick(ACTOR, account.id);
  assert.equal(evaluations, 1, "a paused deployment must not evaluate on subsequent ticks");
  assert.ok((await store.snapshot()).audit.some((event) => event.action_key === "paper.strategy.deployed"));
});

test("portfolio risk scans contain only the requesting owner's accounts and identify unmarkable exposure", async (t) => {
  const { store } = await makeStore(t);
  const data = marketData();
  const service = serviceFor(store, data);
  const own = await accountFor(service, ACTOR);
  const other = await accountFor(service, ACTOR + 1);

  const scan = await service.portfolioRiskScan(ACTOR);
  assert.deepEqual(scan.accounts.map((entry) => entry.accountId), [own.id]);
  assert.equal(scan.simulationOnly, true);
  assert.equal(scan.totals.accounts, 1);
  assert.equal((await service.listAccounts(ACTOR + 1)).accounts.length, 1);
  assert.equal((await service.accountSummary(ACTOR, own.id)).account.id, own.id);
  assert.equal(other.owner_user_id, ACTOR + 1);
});
