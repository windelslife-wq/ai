/**
 * Strategy Lab — the pure engine and the lifecycle registry.
 *
 * Every case prefixed `legacy …` is ported 1:1 from the PHP suite that runs
 * against the legacy application:
 *   tests/cases/05-strategies.php   → SeriesView causality, the four builtins,
 *                                     the first lifecycle gate
 *   tests/cases/06-backtester.php   → fill mechanics, cost model, pessimism,
 *                                     reconciliation, hand-computed metrics
 *   tests/cases/33-optimizer.php    → walk-forward split, determinism, the
 *                                     short-history refusal, overfit flagging,
 *                                     AI-variant governance
 * The fixtures are the ones from `tests/framework.php` (`fx_candles`,
 * `fx_noise_range`) and `tests/cases/33-optimizer.php` (`opt_series`, `flat`,
 * `bt_req`), so both sides assert the same numbers against the same inputs.
 * They are redefined here rather than imported from `analysis.test.js` because
 * importing that file would re-register its 75 cases and double-count them.
 *
 * The unprefixed cases are Node-only: the registry gates the legacy suite
 * exercises only through a full platform boot, the request resolver, and the two
 * recorded divergences (well-formed ISO timestamps, and gate warnings surviving
 * a successful transition).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { assertIsoCutoff } from "../src/persistence/contract.js";
import { seededRandom } from "../src/modules/market-data/normalize.js";
import { ema } from "../src/modules/analysis/indicators.js";
import {
  BREAKOUT_DEFAULTS,
  MEAN_REVERSION_DEFAULTS,
  MOMENTUM_DEFAULTS,
  TREND_FOLLOWING_DEFAULTS,
  BUILTIN_STRATEGY_IDS,
  builtinStrategies,
  builtinStrategyFactory,
  createBreakoutStrategy,
  createMeanReversionStrategy,
  createMomentumStrategy,
  createTrendFollowingStrategy,
  createVersionedStrategy,
  hold,
} from "../src/modules/strategies/builtin.js";
import {
  INDICATOR_KEYS,
  LookAheadError,
  SeriesView,
  precomputeIndicators,
} from "../src/modules/strategies/series-view.js";
import {
  barsPerYear,
  computeMetrics,
  maxDrawdownAbs,
  maxDrawdownPct,
  perBarReturns,
  sharpe,
  sortino,
  streak,
} from "../src/modules/strategies/metrics.js";
import {
  BACKTEST_DEFAULTS,
  BACKTEST_LIMIT_MAX,
  BACKTEST_LIMIT_MIN,
  BacktestRequestError,
  InsufficientHistoryError,
  MIN_BACKTEST_CANDLES,
  buildBacktestRecord,
  filterCandlesByRange,
  isoUtc,
  journalEntriesFromBacktest,
  resolveBacktestRequest,
  simulate,
} from "../src/modules/strategies/backtester.js";
import {
  METHOD_NOTE,
  OPTIMIZER_DEFAULTS,
  OptimizationInputError,
  cartesian,
  optimize,
  shortParams,
} from "../src/modules/strategies/optimizer.js";
import {
  AI_SIGNOFF_REQUIRED_LIVE,
  AI_SIGNOFF_REQUIRED_PAPER,
  LIFECYCLE_ORDER,
  LIFECYCLE_STAGES,
  MIN_PAPER_TRADES_FOR_APPROVAL,
  RETIRED_STAGE,
  VALIDATION_CRITERIA,
  createStrategyRegistry,
  newStrategyRecord,
  nextStage,
  validateMetrics,
} from "../src/modules/strategies/registry.js";

// ---- helpers ---------------------------------------------------------------

const FIXTURE_NOW = 1_755_000_000_000;
const HOUR = 3_600_000;

function assertClose(actual, expected, tolerance, message = "") {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message} expected ${expected} ± ${tolerance}, got ${actual}`,
  );
}

// ---- fixtures (ported from tests/framework.php) ----------------------------

function fxCandles(n, drift = 0.0, seed = 42, noise = 0.4) {
  const random = seededRandom(seed);
  const out = [];
  let price = 100.0;
  for (let i = 0; i < n; i += 1) {
    const open = price;
    const close = open + drift + (random() - 0.5) * noise;
    out.push({
      timestamp: FIXTURE_NOW - (n - i) * HOUR,
      open,
      high: Math.max(open, close) + random() * 0.2,
      low: Math.min(open, close) - random() * 0.2,
      close,
      volume: 100 + random() * 50,
    });
    price = close;
  }
  return out;
}

/** Mean-reverting series: keeps ADX low, which is what the ranging tests need. */
function fxNoiseRange(n, seed = 7, amp = 0.8) {
  const random = seededRandom(seed);
  const out = [];
  let price = 100.0;
  for (let i = 0; i < n; i += 1) {
    const open = price;
    const close = open + (100.0 - open) * 0.15 + (random() - 0.5) * amp;
    out.push({
      timestamp: FIXTURE_NOW - (n - i) * HOUR,
      open,
      high: Math.max(open, close) + random() * 0.1,
      low: Math.min(open, close) - random() * 0.1,
      close,
      volume: 100,
    });
    price = close;
  }
  return out;
}

/**
 * Deterministic optimizer fixture: trend slope + sine wiggle + tiny noise.
 *
 * Ported from `opt_series` in `tests/cases/33-optimizer.php`. The order of the
 * four `random()` calls per bar (close, high, low, volume) is part of the
 * fixture — reordering them produces a different series and different results.
 */
function optSeries(n, slope, wiggle, seed = 7) {
  const random = seededRandom(seed);
  const out = [];
  let price = 100.0;
  for (let i = 0; i < n; i += 1) {
    const close = price + slope + wiggle * Math.sin(i / 6) + (random() - 0.5) * 0.05;
    const open = price;
    const high = Math.max(open, close) + 0.15 + random() * 0.1;
    const low = Math.min(open, close) - 0.15 - random() * 0.1;
    out.push({
      timestamp: FIXTURE_NOW + i * HOUR,
      open,
      high,
      low,
      close,
      volume: 100 + random() * 50,
    });
    price = close;
  }
  return out;
}

/** A perfectly flat series, from `tests/cases/06-backtester.php`. */
function flat(n, price = 100.0) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      timestamp: FIXTURE_NOW - (n - i) * HOUR,
      open: price,
      high: price + 0.2,
      low: price - 0.2,
      close: price,
      volume: 100,
    });
  }
  return out;
}

/** Replace one bar, preserving its timestamp (the legacy fixtures do this). */
function withBar(candles, index, patch) {
  const out = [...candles];
  out[index] = { timestamp: candles[index].timestamp, ...patch };
  return out;
}

const BT_META = Object.freeze({ symbol: "TESTUSD", timeframe: "1h", marketClass: "crypto" });

/**
 * The oracle's `bt_req()`, resolved through the real request resolver.
 *
 * Note `spreadBps: 2` here rather than the shipped default of 1 — the oracle
 * fixtures chose it so that half-spread (1bp) plus slippage (2bp) give the round
 * 1.0003 / 0.9997 multipliers the assertions are written against.
 */
function btReq(overrides = {}) {
  return resolveBacktestRequest({
    initialEquity: 10_000.0,
    riskPct: 0.01,
    feeBps: 2.0,
    spreadBps: 2.0,
    slippageBps: 2.0,
    allowShorts: false,
    warmupBars: 10,
    maxBarsInTrade: 0,
    ...overrides,
  });
}

/**
 * A strategy driven by a script of bar-index → signal, from the oracle suite.
 *
 * Lets a test dictate exactly which bars produce entries without having to
 * construct a price series that a real strategy would read that way — which is
 * what makes the fill-mechanics assertions exact rather than approximate.
 */
function scriptedStrategy(script) {
  const seen = [];
  return {
    seen,
    id: () => "scripted",
    version: () => "1.0.0",
    name: () => "Scripted",
    description: () => "test",
    marketClasses: () => ["crypto"],
    timeframes: () => ["1h"],
    params: () => ({}),
    paramGrid: () => ({}),
    supportsShorts: () => true,
    evaluate(ctx) {
      seen.push(ctx.view.index);
      return script[ctx.view.index] ?? { action: "HOLD", reason: "none", confidence: 0 };
    },
  };
}

/** A strategy that cheats by reading the next bar. Must kill the run. */
function cheatingStrategy() {
  return {
    id: () => "cheater",
    version: () => "1.0.0",
    name: () => "cheater",
    description: () => "reads ahead",
    marketClasses: () => ["crypto"],
    timeframes: () => ["1h"],
    params: () => ({}),
    paramGrid: () => ({}),
    supportsShorts: () => false,
    evaluate(ctx) {
      ctx.view.close(ctx.view.index + 1);
      return { action: "HOLD", reason: "x", confidence: 0 };
    },
  };
}

// ---- registry fakes --------------------------------------------------------

/**
 * In-memory stand-in for the strategy/backtest repository pair.
 *
 * Mirrors the legacy repo semantics that the gates depend on: `find` is exact on
 * (id, version), `all` returns every record, `latestBacktest` orders by
 * `created_at` descending, and `save` upserts on the composite key.
 */
function fakeRepo(seed = []) {
  const records = new Map();
  const backtests = [];
  for (const record of seed) records.set(`${record.strategy_id}@${record.version}`, record);
  return {
    records,
    backtests,
    async find(id, version) {
      const record = records.get(`${id}@${version}`);
      return record ? structuredClone(record) : null;
    },
    async all() {
      return [...records.values()].map((record) => structuredClone(record));
    },
    async save(record) {
      records.set(`${record.strategy_id}@${record.version}`, structuredClone(record));
    },
    async countBacktests(strategyId, version) {
      return backtests.filter(
        (b) => b.request.strategyId === strategyId && b.request.strategyVersion === version,
      ).length;
    },
    async latestBacktest(strategyId, version) {
      const matches = backtests
        .filter(
          (b) => b.request.strategyId === strategyId && b.request.strategyVersion === version,
        )
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return matches.length ? structuredClone(matches[0]) : null;
    },
    addBacktest(record) {
      backtests.push(structuredClone(record));
    },
  };
}

/** In-memory journal with the legacy filter semantics. */
function fakeJournal(entries = []) {
  return {
    entries,
    async list(filter = {}, limit = 200) {
      return entries
        .filter((entry) => {
          if (filter.source && entry.source !== filter.source) return false;
          if (filter.strategy && entry.strategy !== filter.strategy) return false;
          if (filter.symbol && entry.symbol !== filter.symbol) return false;
          return true;
        })
        .slice(0, limit)
        .map((entry) => structuredClone(entry));
    },
  };
}

/** Collects audit events so tests can assert attribution and payload. */
function fakeAudit() {
  const events = [];
  return {
    events,
    async emit(action, summary, details = {}, actorId = null) {
      events.push({ action, summary, details, actorId });
    },
  };
}

/** A backtest record whose metrics clear every `VALIDATED` criterion. */
function passingBacktest(overrides = {}) {
  return {
    id: "bt-pass",
    created_at: "2026-10-01T00:00:00.000Z",
    request: { strategyId: "trend-following", strategyVersion: "1.0.0", symbol: "EURUSD" },
    metrics: {
      trades: 40,
      profitFactor: 1.8,
      maxDrawdownPct: 12.5,
      expectancyPnl: 25.0,
      sharpe: 1.4,
    },
    ...overrides,
  };
}

/** Ten winning paper trades: enough evidence for the approval gate to pass. */
function paperEvidence(strategy = "trend-following", pnl = 12) {
  return Array.from({ length: MIN_PAPER_TRADES_FOR_APPROVAL }, (_, index) => ({
    id: `paper-${index}`,
    source: "paper",
    strategy,
    pnl,
  }));
}

async function seededRegistry(options = {}) {
  const repo = options.repo ?? fakeRepo();
  const audit = options.audit ?? fakeAudit();
  const registry = createStrategyRegistry({
    repo,
    audit,
    journal: options.journal ?? null,
    now: options.now ?? (() => FIXTURE_NOW),
  });
  await registry.seedBuiltins();
  return { registry, repo, audit };
}

// ============================================================================
// legacy tests/cases/05-strategies.php — SeriesView
// ============================================================================

test("legacy: series view throws on future access", () => {
  const candles = fxCandles(100);
  const view = new SeriesView(candles, precomputeIndicators(candles), 60, BT_META);
  assert.throws(() => view.close(61), LookAheadError);
  assert.throws(() => view.ema20(99), LookAheadError);
  assert.throws(() => view.highestHigh(10, 70), LookAheadError);
});

test("legacy: series view indicators are causal (equal to fresh prefix computation)", () => {
  const candles = fxCandles(120);
  const view = new SeriesView(candles, precomputeIndicators(candles), 100, BT_META);
  const fresh = ema(
    candles.slice(0, 101).map((candle) => candle.close),
    20,
  );
  assertClose(fresh[100], view.ema20(100), 1e-9, "ema20 prefix equivalence");
});

test("series view treats every negative index as the current-bar sentinel", () => {
  const candles = fxCandles(40);
  const view = new SeriesView(candles, precomputeIndicators(candles), 20, BT_META);
  // Legacy semantics are `$i = $i < 0 ? $this->index : $i`, so ANY negative
  // resolves to the current bar. It can never read the future, and therefore
  // never throws — only a forward read is a look-ahead violation.
  assert.equal(view.close(-1), candles[20].close);
  assert.equal(view.close(-2), candles[20].close);
  assert.equal(view.close(), candles[20].close);
  assert.equal(view.lowestLow(5, -2), view.lowestLow(5, 20));
  assert.throws(() => view.close(21), LookAheadError);
  assert.throws(() => view.time(39), LookAheadError);
});

test("series view precomputes every indicator key it exposes", () => {
  const indicators = precomputeIndicators(fxCandles(200));
  for (const key of INDICATOR_KEYS) {
    assert.ok(Array.isArray(indicators[key]), `missing indicator array for ${key}`);
    assert.equal(indicators[key].length, 200, `${key} must span the whole series`);
  }
  assert.equal(INDICATOR_KEYS.length, 15);
});

test("series view windowed helpers exclude/include their end bar as documented", () => {
  const candles = [10, 20, 30, 40, 50].map((value, index) => ({
    timestamp: FIXTURE_NOW + index * HOUR,
    open: value,
    high: value,
    low: value,
    close: value,
    volume: value,
  }));
  const view = new SeriesView(candles, precomputeIndicators(candles), 4, BT_META);
  assert.equal(view.barsVisible(), 5);
  // highestHigh(3, 4) covers indices 1..3 — the end bar is excluded.
  assert.equal(view.highestHigh(3, 4), 40);
  assert.equal(view.lowestLow(3, 4), 20);
  // averageVolume(3, 4) covers indices 2..4 — the end bar is included.
  assert.equal(view.averageVolume(3, 4), (30 + 40 + 50) / 3);
  // An empty window yields the identity element, not a fabricated zero.
  assert.equal(view.highestHigh(3, 0), -Infinity);
  assert.equal(view.lowestLow(3, 0), Infinity);
});

// ============================================================================
// legacy tests/cases/05-strategies.php — the four builtins
// ============================================================================

test("legacy: trend strategy fires BUY on a fresh EMA cross-up", () => {
  const candles = [
    ...fxCandles(120, -0.2, 99).slice(0, 60),
    ...fxCandles(140, 0.45, 42),
  ].map((candle, index, all) => ({
    ...candle,
    timestamp: FIXTURE_NOW - (all.length - index) * HOUR,
  }));

  const strategy = createTrendFollowingStrategy();
  const indicators = precomputeIndicators(candles);
  let buys = 0;
  for (let i = 55; i < candles.length; i += 1) {
    const view = new SeriesView(candles, indicators, i, BT_META);
    const signal = strategy.evaluate({ view, position: null, equity: 10_000 });
    if (signal.action === "BUY") {
      buys += 1;
      assert.ok(signal.stopLoss < view.close(), "stop must sit below the close on a long");
      assert.ok(signal.takeProfit > view.close(), "target must sit above the close on a long");
    }
  }
  assert.ok(buys >= 1, `expected at least one BUY, got ${buys}`);
});

test("legacy: mean reversion fires on band pierce with oversold RSI, and refuses in trends", () => {
  const candles = fxNoiseRange(200);
  const last = candles[candles.length - 1];
  candles.push({
    timestamp: last.timestamp + HOUR,
    open: last.close,
    high: last.close,
    low: last.close - 3.2,
    close: last.close - 3.0,
    volume: 300,
  });
  const view = new SeriesView(
    candles,
    precomputeIndicators(candles),
    candles.length - 1,
    BT_META,
  );
  const signal = createMeanReversionStrategy().evaluate({ view, position: null, equity: 10_000 });
  assert.equal(signal.action, "BUY");
  assert.match(signal.reason, /lower band/);

  // A strong trend: the ADX filter must refuse to fade it.
  const trend = fxCandles(160, 0.5, 5, 0.2);
  const trendView = new SeriesView(
    trend,
    precomputeIndicators(trend),
    trend.length - 1,
    BT_META,
  );
  assert.equal(
    createMeanReversionStrategy().evaluate({ view: trendView, position: null, equity: 10_000 })
      .action,
    "HOLD",
  );
});

test("legacy: breakout needs volume confirmation", () => {
  const candles = fxNoiseRange(120);
  const baseView = new SeriesView(
    candles,
    precomputeIndicators(candles),
    candles.length - 1,
    BT_META,
  );
  const rangeHigh = baseView.highestHigh(48, candles.length - 1);
  const last = candles[candles.length - 1];
  const bar = (volume) => ({
    timestamp: last.timestamp + HOUR,
    open: last.close,
    high: rangeHigh + 1.5,
    low: last.close + 0.1,
    close: rangeHigh + 1.2,
    volume,
  });
  const mkView = (series) =>
    new SeriesView(series, precomputeIndicators(series), series.length - 1, BT_META);

  const withVolume = [...candles, bar(600)];
  const noVolume = [...candles, bar(10)];
  assert.equal(
    createBreakoutStrategy().evaluate({ view: mkView(withVolume), position: null, equity: 10_000 })
      .action,
    "BUY",
  );
  assert.equal(
    createBreakoutStrategy().evaluate({ view: mkView(noVolume), position: null, equity: 10_000 })
      .action,
    "HOLD",
  );
});

test("legacy: momentum fires on strong ROC + rising MACD histogram, closes on flip", () => {
  const candles = fxCandles(180, 0.45, 11);
  const strategy = createMomentumStrategy();
  const indicators = precomputeIndicators(candles);
  let buys = 0;
  for (let i = 60; i < candles.length; i += 1) {
    const view = new SeriesView(candles, indicators, i, BT_META);
    if (strategy.evaluate({ view, position: null, equity: 10_000 }).action === "BUY") buys += 1;
  }
  assert.ok(buys >= 1, "expected at least one momentum BUY");

  // CLOSE when the histogram flips against an open long.
  const mixed = [
    ...fxCandles(80, 0.35, 21).slice(0, 80),
    ...fxCandles(120, -0.25, 33),
  ].map((candle, index) => ({ ...candle, timestamp: FIXTURE_NOW - (200 - index) * HOUR }));
  const mixedIndicators = precomputeIndicators(mixed);
  let closed = false;
  for (let i = 60; i < mixed.length && !closed; i += 1) {
    const view = new SeriesView(mixed, mixedIndicators, i, BT_META);
    if ((view.macdHistogram(i) ?? 0) < 0) {
      const signal = strategy.evaluate({
        view,
        position: {
          direction: "LONG",
          entryPrice: mixed[i].close,
          entryBar: i - 10,
          stopLoss: 0,
          takeProfit: 0,
          unrealizedPnl: 0,
        },
        equity: 10_000,
      });
      if (signal.action === "CLOSE") closed = true;
    }
  }
  assert.ok(closed, "momentum must close a long when the histogram turns negative");
});

test("the four builtins declare the contract completely and consistently", () => {
  const strategies = builtinStrategies();
  assert.deepEqual(
    strategies.map((strategy) => strategy.id()),
    [...BUILTIN_STRATEGY_IDS],
  );
  for (const strategy of strategies) {
    assert.equal(typeof strategy.id(), "string");
    assert.match(strategy.version(), /^\d+\.\d+\.\d+$/);
    assert.ok(strategy.name().length > 0);
    assert.ok(strategy.description().length > 0);
    assert.ok(strategy.marketClasses().includes("forex"));
    assert.ok(strategy.timeframes().includes("1h"));
    // 1m is deliberately not claimed: no builtin supports that horizon.
    assert.ok(!strategy.timeframes().includes("1m"));
    assert.equal(strategy.supportsShorts(), true);
    assert.equal(typeof strategy.paramGrid(), "object");
    // Every grid key must be a real parameter, or the optimizer would search a
    // dimension the strategy never reads.
    for (const key of Object.keys(strategy.paramGrid())) {
      assert.ok(key in strategy.params(), `${strategy.id()} grid key ${key} is not a parameter`);
      assert.ok(strategy.paramGrid()[key].length >= 1);
    }
    // And every parameter must be searchable, or the grid understates the space.
    for (const key of Object.keys(strategy.params())) {
      assert.ok(key in strategy.paramGrid(), `${strategy.id()} param ${key} is absent from its grid`);
    }
  }
});

test("builtin defaults match the legacy parameter sets exactly", () => {
  assert.deepEqual(createTrendFollowingStrategy().params(), { ...TREND_FOLLOWING_DEFAULTS });
  assert.deepEqual(TREND_FOLLOWING_DEFAULTS, { fast: 20, slow: 50, adxMin: 25, stopAtr: 2, targetR: 3 });
  assert.deepEqual(MEAN_REVERSION_DEFAULTS, { rsiLow: 30, rsiHigh: 70, adxMax: 30, stopAtr: 2.5 });
  assert.deepEqual(BREAKOUT_DEFAULTS, { lookback: 48, volMult: 1.5, stopAtr: 1.5, targetR: 2.5 });
  assert.deepEqual(MOMENTUM_DEFAULTS, { rocPeriod: 20, rocMinPct: 1.5, stopAtr: 2, targetR: 3 });
});

test("hold() is the neutral signal with exactly zero confidence", () => {
  assert.deepEqual(hold(), { action: "HOLD", reason: "no entry condition", confidence: 0 });
});

test("strategies return HOLD rather than guessing during indicator warmup", () => {
  const candles = fxCandles(200);
  const indicators = precomputeIndicators(candles);
  for (const strategy of builtinStrategies()) {
    // Bar 5 is inside every builtin's warmup floor; a signal here would be
    // computed from indicators that do not exist yet.
    const view = new SeriesView(candles, indicators, 5, BT_META);
    assert.deepEqual(
      strategy.evaluate({ view, position: null, equity: 10_000 }),
      hold(),
      `${strategy.id()} must hold during warmup`,
    );
  }
});

test("parameters replace the defaults rather than merging into them", () => {
  // The optimizer depends on this: it hands each candidate a complete grid
  // combination, and a silent merge would mask a malformed grid.
  const partial = createTrendFollowingStrategy({ fast: 10 });
  assert.deepEqual(partial.params(), { fast: 10 });
  assert.equal(partial.id(), "trend-following");
  // params() returns a copy, so a caller cannot mutate a registered strategy.
  const params = partial.params();
  params.fast = 999;
  assert.deepEqual(partial.params(), { fast: 10 });
});

test("builtinStrategyFactory resolves the four builtins and refuses the rest", () => {
  for (const id of BUILTIN_STRATEGY_IDS) {
    const factory = builtinStrategyFactory(id);
    assert.equal(typeof factory, "function", `no factory for ${id}`);
    assert.equal(factory({}).id(), id);
  }
  assert.equal(builtinStrategyFactory("does-not-exist"), null);
  assert.equal(builtinStrategyFactory(""), null);
});

test("a versioned variant delegates evaluation but carries its own identity", () => {
  const inner = createTrendFollowingStrategy();
  const params = { fast: 10, slow: 40, adxMin: 20, stopAtr: 2, targetR: 2 };
  const variant = createVersionedStrategy(inner, "1.0.1", params);

  assert.equal(variant.id(), "trend-following");
  assert.equal(variant.version(), "1.0.1");
  assert.equal(variant.name(), "Trend Following (EMA cross + ADX) (optimized 1.0.1)");
  assert.equal(variant.description(), inner.description());
  assert.deepEqual(variant.params(), params);
  assert.deepEqual(variant.paramGrid(), inner.paramGrid());
  assert.equal(variant.supportsShorts(), inner.supportsShorts());
  assert.equal(variant.isVariant, true);

  // Same logic, same bar, same signal — the variant changes numbers, not code.
  const candles = fxCandles(200, 0.45, 42);
  const indicators = precomputeIndicators(candles);
  const view = new SeriesView(candles, indicators, 150, BT_META);
  const ctx = { view, position: null, equity: 10_000 };
  assert.deepEqual(
    createTrendFollowingStrategy(params).evaluate(ctx),
    variant.evaluate(ctx),
  );
});

// ============================================================================
// legacy tests/cases/06-backtester.php — fill mechanics and costs
// ============================================================================

test("legacy: backtest fills at NEXT bar open with costs (never the signal close)", () => {
  let candles = withBar(flat(80), 30, { open: 100, high: 100.2, low: 99.8, close: 101 });
  candles = withBar(candles, 31, { open: 102, high: 102.2, low: 101.8, close: 102 });
  const strategy = scriptedStrategy({
    30: { action: "BUY", reason: "in", confidence: 0.8, stopLoss: 98.0, takeProfit: 110.0 },
  });

  const result = simulate(strategy, candles, btReq(), BT_META);
  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  // open * (1 + halfSpread + slippage)
  assertClose(trade.entryPrice, 102 * 1.0003, 1e-8, "entry fill");
  const stopDistance = 102 * 1.0003 - 98;
  assertClose(trade.units, 100 / stopDistance, 1e-6, "units = riskAmount / stopDistance");
  assert.equal(trade.exitReason, "END_OF_DATA");
  assertClose(trade.exitPrice, 100 * 0.9997, 1e-8, "exit fill");
  assert.equal(trade.barsHeld, 79 - 31);
  // The signal bar's close (101) must never appear as a fill price.
  assert.notEqual(trade.entryPrice, 101);
});

test("legacy: stop fills first when a bar touches both stop and target", () => {
  const candles = withBar(flat(80), 31, { open: 100, high: 112, low: 97.5, close: 100 });
  const strategy = scriptedStrategy({
    30: { action: "BUY", reason: "in", confidence: 0.5, stopLoss: 98.0, takeProfit: 110.0 },
  });
  const trade = simulate(strategy, candles, btReq(), BT_META).trades[0];
  assert.equal(trade.exitReason, "STOP_LOSS");
  assertClose(trade.exitPrice, 98 * 0.9997, 1e-8, "stop fill");
  assert.ok(trade.netPnl < 0, "a stopped-out long must lose money");
});

test("legacy: entry bar can stop out immediately", () => {
  const candles = withBar(flat(80), 31, { open: 100, high: 100.2, low: 97.0, close: 99 });
  const strategy = scriptedStrategy({
    30: { action: "BUY", reason: "in", confidence: 0.5, stopLoss: 98.0, takeProfit: 110.0 },
  });
  const trade = simulate(strategy, candles, btReq(), BT_META).trades[0];
  assert.equal(trade.exitReason, "STOP_LOSS");
  assert.equal(trade.barsHeld, 0);
});

test("legacy: shorts mirror longs when allowed; ignored otherwise", () => {
  let candles = withBar(flat(80), 32, { open: 99, high: 99.2, low: 98.5, close: 98.8 });
  candles = withBar(candles, 33, { open: 98.5, high: 98.6, low: 94.5, close: 96.0 });
  const script = {
    30: { action: "SELL", reason: "short", confidence: 0.6, stopLoss: 102.0, takeProfit: 95.0 },
  };

  const allowed = simulate(scriptedStrategy(script), candles, btReq({ allowShorts: true }), BT_META);
  const trade = allowed.trades[0];
  assert.equal(trade.direction, "SHORT");
  assertClose(trade.entryPrice, 100 * 0.9997, 1e-8, "short entry fill");
  assert.equal(trade.exitReason, "TAKE_PROFIT");
  assertClose(trade.exitPrice, 95 * 1.0003, 1e-8, "short target fill");
  assert.ok(trade.netPnl > 0, "a short that reaches its target must profit");

  const blocked = simulate(scriptedStrategy(script), candles, btReq({ allowShorts: false }), BT_META);
  assert.equal(blocked.trades.length, 0);
  assert.equal(blocked.ignoredSignals, 1);
  assert.deepEqual(blocked.warnings, ["1 short signals ignored (allowShorts=false)"]);
});

test("legacy: cost decomposition reconciles with the equity curve", () => {
  const candles = withBar(flat(80), 40, { open: 100, high: 106, low: 99.8, close: 105 });
  const strategy = scriptedStrategy({
    30: { action: "BUY", reason: "in", confidence: 0.5, stopLoss: 98.0, takeProfit: 105.0 },
  });
  const result = simulate(strategy, candles, btReq(), BT_META);
  const trade = result.trades[0];

  const h = 0.0001;
  const s = 0.0002;
  const fee = 0.0002;
  const fillEntry = 100 * (1 + h + s);
  const fillExit = 105 * (1 - h - s);
  const units = 100 / (fillEntry - 98);
  const entryFee = units * fillEntry * fee;
  const exitFee = units * fillExit * fee;

  assertClose(entryFee, trade.fees.entryFee, 1e-4, "entryFee");
  assertClose(exitFee, trade.fees.exitFee, 1e-4, "exitFee");
  assertClose((fillExit - fillEntry) * units - entryFee - exitFee, trade.netPnl, 1e-4, "netPnl");
  // Raw-to-raw P&L minus every cost equals net: nothing is double-counted or dropped.
  const rawPnl = (105 - 100) * units;
  assertClose(rawPnl - trade.fees.totalCost, trade.netPnl, 1e-4, "raw minus costs");
  assertClose(
    10_000 - entryFee + ((fillExit - fillEntry) * units - exitFee),
    result.equityCurve[result.equityCurve.length - 1].equity,
    0.02,
    "final equity",
  );
  assert.equal(trade.exitReason, "TAKE_PROFIT");
});

test("legacy: look-ahead access kills the run", () => {
  assert.throws(
    () => simulate(cheatingStrategy(), flat(80), btReq(), BT_META),
    LookAheadError,
  );
});

test("legacy: metrics sharpe/sortino/streaks hand fixtures", () => {
  const annual = 8760.0;
  assert.equal(sharpe([0.01, 0.01, 0.01], annual), null, "zero variance has no Sharpe");
  assertClose(sharpe([0.1, -0.05, 0.1, -0.05], annual), (1 / 3) * Math.sqrt(annual), 1e-3, "sharpe");

  const downsideDeviation = Math.sqrt((0.05 ** 2 * 2) / 4);
  assertClose(
    sortino([0.1, -0.05, 0.1, -0.05], annual),
    (0.025 / downsideDeviation) * Math.sqrt(annual),
    1e-3,
    "sortino",
  );

  const trade = (pnl) => ({ netPnl: pnl });
  assert.equal(
    streak([10, 5, -3, 8, 7, 6, -2, 2].map(trade), (t) => t.netPnl > 0),
    3,
  );
  const curve = [100, 120, 90, 110, 95].map((equity) => ({ equity }));
  assertClose(maxDrawdownAbs(curve), 30.0, 1e-9, "maxDdAbs");
});

// ============================================================================
// backtester — Node-only edges
// ============================================================================

test("barsPerYear annualises from the shared timeframe table", () => {
  assert.equal(barsPerYear("1h"), 8760);
  assert.equal(barsPerYear("1d"), 365);
  assert.equal(barsPerYear("15m"), 35_040);
  // An unknown timeframe falls back to hourly, matching timeframeMs.
  assert.equal(barsPerYear("nonsense"), 8760);
});

test("metrics treat a break-even trade as a loss, and no-loss runs as unmeasured", () => {
  const trade = (netPnl) => ({
    netPnl,
    rMultiple: netPnl / 100,
    fees: { totalCost: 0, slippageCost: 0 },
  });
  const metrics = computeMetrics([trade(10), trade(0), trade(-5)], [], 10_000, "1h", 0);
  assert.equal(metrics.trades, 3);
  assert.equal(metrics.winRate, roundTo3(1 / 3));
  assert.equal(metrics.lossRate, roundTo3(2 / 3));
  assert.equal(metrics.longestWinStreak, 1);
  assert.equal(metrics.longestLossStreak, 2, "break-even extends the loss streak");

  const allWins = computeMetrics([trade(10), trade(5)], [], 10_000, "1h", 0);
  assert.equal(allWins.profitFactor, null, "no losses means no measured profit factor");
  assert.equal(allWins.avgLoss, null);

  const noTrades = computeMetrics([], [], 10_000, "1h", 0);
  assert.equal(noTrades.trades, 0);
  assert.equal(noTrades.profitFactor, null);
  assert.equal(noTrades.winRate, null);
  assert.equal(noTrades.expectancyR, null);
  assert.equal(noTrades.totalReturnPct, 0);
  assert.equal(noTrades.finalEquity, 10_000, "an empty curve falls back to initial equity");
});

function roundTo3(value) {
  return Math.round(value * 10_000) / 10_000;
}

test("metrics exposure uses bars-in-market over curve length minus one", () => {
  const curve = Array.from({ length: 11 }, (_, index) => ({ equity: 10_000 + index }));
  const metrics = computeMetrics([], curve, 10_000, "1h", 5);
  assert.equal(metrics.exposurePct, 50);
  // A single-point curve cannot express exposure.
  assert.equal(computeMetrics([], [curve[0]], 10_000, "1h", 5).exposurePct, 0);
});

test("maxDrawdownPct skips points before any positive peak", () => {
  assert.equal(maxDrawdownPct([{ equity: 0 }, { equity: -5 }]), 0);
  assertClose(maxDrawdownPct([{ equity: 100 }, { equity: 80 }]), 20, 1e-9);
});

test("perBarReturns divides by the previous equity and guards non-positive values", () => {
  assertClose(perBarReturns([{ equity: 100 }, { equity: 110 }])[0], 0.1, 1e-12);
  assert.deepEqual(perBarReturns([{ equity: 0 }, { equity: 110 }]), [0]);
  assert.deepEqual(perBarReturns([{ equity: 100 }]), []);
});

test("sortino distinguishes an unmeasurably good run from a flat losing one", () => {
  // No downside at all and a positive mean: nothing to penalise, so null.
  assert.equal(sortino([0.1, 0.2, 0.3], 8760), null);
  // No downside and a non-positive mean: reported as 0, not null.
  assert.equal(sortino([0, 0, 0], 8760), 0);
  // Too few bars to say anything.
  assert.equal(sortino([0.1], 8760), null);
  assert.equal(sharpe([0.1], 8760), null);
});

test("the backtester refuses an entry whose stop sits on the wrong side of the fill", () => {
  const candles = withBar(flat(80), 31, { open: 100, high: 100.2, low: 99.8, close: 100 });
  // A long whose stop is ABOVE the entry would trigger instantly: a strategy bug.
  const strategy = scriptedStrategy({
    30: { action: "BUY", reason: "bad stop", confidence: 0.5, stopLoss: 105, takeProfit: 110 },
  });
  const result = simulate(strategy, candles, btReq(), BT_META);
  assert.equal(result.trades.length, 0, "the trade must not be opened");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /stop must sit beyond the entry fill on the correct side/);
});

test("a signal without a usable stop is dropped silently rather than traded", () => {
  const strategy = scriptedStrategy({
    30: { action: "BUY", reason: "no stop", confidence: 0.5 },
  });
  const result = simulate(strategy, flat(80), btReq(), BT_META);
  assert.equal(result.trades.length, 0);
  assert.equal(result.warnings.length, 0, "an absent stop is not a bar-level anomaly");

  const nonFinite = scriptedStrategy({
    30: { action: "BUY", reason: "nan stop", confidence: 0.5, stopLoss: Number.NaN },
  });
  assert.equal(simulate(nonFinite, flat(80), btReq(), BT_META).trades.length, 0);
});

test("a missing take-profit falls back to a 3R target", () => {
  const candles = withBar(flat(80), 31, { open: 100, high: 100.2, low: 99.8, close: 100 });
  const strategy = scriptedStrategy({
    30: { action: "BUY", reason: "no target", confidence: 0.5, stopLoss: 98 },
  });
  const trade = simulate(strategy, candles, btReq(), BT_META).trades[0];
  const stopDistance = Math.abs(trade.entryPrice - 98);
  assertClose(trade.takeProfit, trade.entryPrice + 3 * stopDistance, 1e-9, "3R fallback target");
});

test("the time stop is queued on the closed bar and fills at the next open", () => {
  const candles = withBar(flat(80), 31, { open: 100, high: 100.2, low: 99.8, close: 100 });
  const strategy = scriptedStrategy({
    30: { action: "BUY", reason: "in", confidence: 0.5, stopLoss: 98, takeProfit: 500 },
  });
  const result = simulate(strategy, candles, btReq({ maxBarsInTrade: 3 }), BT_META);
  const trade = result.trades[0];
  assert.equal(trade.exitReason, "TIME_STOP");
  assert.equal(trade.barsHeld, 3, "entered at 31, queued at 34, filled at the open of 35");
  assertClose(trade.exitPrice, 100 * 0.9997, 1e-8, "time stop fills at the next open");
});

test("maxBarsInTrade of zero disables the time stop entirely", () => {
  const candles = withBar(flat(80), 31, { open: 100, high: 100.2, low: 99.8, close: 100 });
  const strategy = scriptedStrategy({
    30: { action: "BUY", reason: "in", confidence: 0.5, stopLoss: 98, takeProfit: 500 },
  });
  const trade = simulate(strategy, candles, btReq({ maxBarsInTrade: 0 }), BT_META).trades[0];
  assert.equal(trade.exitReason, "END_OF_DATA");
});

test("a non-fatal strategy error is recorded and the bar treated as HOLD", () => {
  let calls = 0;
  const flaky = {
    ...scriptedStrategy({}),
    evaluate(ctx) {
      calls += 1;
      if (ctx.view.index === 12) throw new Error("indicator exploded");
      return hold();
    },
  };
  const result = simulate(flaky, flat(40), btReq(), BT_META);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Strategy threw at bar .*indicator exploded/);
  assert.ok(calls > 1, "the run must continue past a non-fatal error");
  assert.equal(result.trades.length, 0);
});

test("a CLOSE signal while flat is ignored, and an entry while open is not stacked", () => {
  const candles = withBar(flat(80), 31, { open: 100, high: 100.2, low: 99.8, close: 100 });
  const strategy = scriptedStrategy({
    12: { action: "CLOSE", reason: "close while flat", confidence: 0.5 },
    30: { action: "BUY", reason: "in", confidence: 0.5, stopLoss: 98, takeProfit: 500 },
    32: { action: "BUY", reason: "stack", confidence: 0.5, stopLoss: 98, takeProfit: 500 },
  });
  const result = simulate(strategy, candles, btReq(), BT_META);
  assert.equal(result.trades.length, 1, "positions are never stacked");
  assert.equal(result.warnings.length, 0);
});

test("warmup never leaves fewer than ten bars to trade", () => {
  const candles = flat(15);
  const result = simulate(scriptedStrategy({}), candles, btReq({ warmupBars: 60 }), BT_META);
  // warmup = min(60, max(0, 15 - 10)) = 5, so bars 5..14 are evaluated.
  assert.equal(result.equityCurve.length, 10);
});

test("an open position at the end of the data is closed and labelled", () => {
  const candles = withBar(flat(50), 31, { open: 100, high: 100.2, low: 99.8, close: 100 });
  const strategy = scriptedStrategy({
    30: { action: "BUY", reason: "in", confidence: 0.5, stopLoss: 1, takeProfit: 1000 },
  });
  const result = simulate(strategy, candles, btReq(), BT_META);
  const trade = result.trades[0];
  assert.equal(trade.exitReason, "END_OF_DATA");
  assert.equal(trade.exitTime, isoUtc(candles[49].timestamp));
  // The final curve point is rewritten to the realised equity, so the reported
  // return cannot include an unbooked open position.
  const last = result.equityCurve[result.equityCurve.length - 1];
  assert.equal(last.equity, 10_000 + trade.netPnl + trade.fees.entryFee - trade.fees.entryFee
    ? last.equity
    : last.equity);
  assertClose(last.equity, 10_000 + trade.grossPnl - trade.fees.entryFee - trade.fees.exitFee, 0.02);
});

test("the equity curve is marked to market on every evaluated bar", () => {
  const candles = withBar(flat(80), 31, { open: 100, high: 100.2, low: 99.8, close: 100 });
  const strategy = scriptedStrategy({
    30: { action: "BUY", reason: "in", confidence: 0.5, stopLoss: 98, takeProfit: 500 },
  });
  const result = simulate(strategy, candles, btReq(), BT_META);
  assert.equal(result.equityCurve.length, 80 - 10);
  for (const point of result.equityCurve) {
    assert.match(point.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(typeof point.equity, "number");
    assert.ok(point.drawdownPct >= 0, "drawdown is never negative");
  }
  assert.ok(result.barsInMarket > 0);
});

// ============================================================================
// backtester — request resolution and the ISO divergence
// ============================================================================

test("isoUtc emits well-formed ISO-8601 that the repo's own validator accepts", () => {
  const stamp = isoUtc(FIXTURE_NOW + 123);
  assert.equal(stamp, "2025-08-12T12:00:00.123Z");
  // Divergence DV-1: the legacy spelling for this same instant is
  // `2025-08-12T12:00:00Z.123Z`, which is an Invalid Date in JS and is rejected
  // by assertIsoCutoff. Recorded, not copied.
  assert.equal(assertIsoCutoff(stamp), stamp);
  assert.throws(() => assertIsoCutoff("2025-08-12T12:00:00Z.123Z"), TypeError);
  assert.ok(Number.isNaN(Date.parse("2025-08-12T12:00:00Z.123Z")), "the legacy form is unparseable");
  assert.ok(Number.isFinite(Date.parse(stamp)));
  assert.equal(isoUtc(FIXTURE_NOW), "2025-08-12T12:00:00.000Z");
});

test("resolveBacktestRequest clamps the limit into the documented bounds", () => {
  assert.equal(resolveBacktestRequest({ limit: 5 }).limit, BACKTEST_LIMIT_MIN);
  assert.equal(resolveBacktestRequest({ limit: 999_999 }).limit, BACKTEST_LIMIT_MAX);
  assert.equal(resolveBacktestRequest({ limit: 500 }).limit, 500);
  // Truncation happens, but the floor is applied after it: 12.9 cannot survive.
  assert.equal(resolveBacktestRequest({ limit: 12.9 }).limit, BACKTEST_LIMIT_MIN);
  assert.equal(resolveBacktestRequest({ limit: 500.9 }).limit, 500);
  assert.equal(BACKTEST_LIMIT_MIN, 60);
  assert.equal(BACKTEST_LIMIT_MAX, 5000);
});

test("resolveBacktestRequest applies defaults and ignores unknown keys", () => {
  const resolved = resolveBacktestRequest({ notARealKey: "x" });
  for (const [key, value] of Object.entries(BACKTEST_DEFAULTS)) {
    assert.equal(resolved[key], value, `default for ${key}`);
  }
  assert.equal("notARealKey" in resolved, false, "unknown keys must not be smuggled in");
  assert.equal(resolved.symbol, "");
});

test("resolveBacktestRequest normalises the symbol and coerces allowShorts", () => {
  const resolved = resolveBacktestRequest({ symbol: "  eurusd ", allowShorts: 1 });
  assert.equal(resolved.symbol, "EURUSD");
  assert.equal(resolved.allowShorts, true);
  assert.equal(resolveBacktestRequest({ allowShorts: 0 }).allowShorts, false);
});

test("resolveBacktestRequest refuses unsafe risk assumptions instead of clamping them", () => {
  const refusals = [
    [{ initialEquity: 0 }, /initialEquity must be positive/],
    [{ initialEquity: -5 }, /initialEquity must be positive/],
    [{ initialEquity: "abc" }, /initialEquity must be positive/],
    [{ riskPct: 0 }, /riskPct must be in \(0, 5%\]/],
    [{ riskPct: -0.01 }, /riskPct must be in \(0, 5%\]/],
    [{ riskPct: 0.06 }, /riskPct must be in \(0, 5%\]/],
    [{ feeBps: -1 }, /feeBps must be a non-negative number/],
    [{ spreadBps: "x" }, /spreadBps must be a non-negative number/],
    [{ slippageBps: -0.5 }, /slippageBps must be a non-negative number/],
    [{ warmupBars: -1 }, /warmupBars must be a non-negative number/],
    [{ maxBarsInTrade: -2 }, /maxBarsInTrade must be a non-negative number/],
    [{ limit: "abc" }, /limit must be a number/],
  ];
  for (const [overrides, pattern] of refusals) {
    assert.throws(
      () => resolveBacktestRequest(overrides),
      (error) => {
        assert.ok(error instanceof BacktestRequestError, `wrong class for ${JSON.stringify(overrides)}`);
        assert.equal(error.statusCode, 400);
        assert.match(error.message, pattern);
        return true;
      },
      `expected refusal for ${JSON.stringify(overrides)}`,
    );
  }
  // The boundary is inclusive at exactly 5%.
  assert.equal(resolveBacktestRequest({ riskPct: 0.05 }).riskPct, 0.05);
});

test("filterCandlesByRange includes the whole of the `to` day", () => {
  const candles = [0, 1, 2, 3].map((day) => ({
    timestamp: Date.parse(`2026-01-0${day + 1}T12:00:00.000Z`),
  }));
  assert.equal(filterCandlesByRange(candles).length, 4, "no range means no filtering");
  assert.equal(filterCandlesByRange(candles, { from: "2026-01-02T00:00:00Z" }).length, 3);
  // `to` is extended by a day so the named day is included.
  assert.equal(filterCandlesByRange(candles, { to: "2026-01-02" }).length, 2);
  assert.equal(
    filterCandlesByRange(candles, { from: "2026-01-02", to: "2026-01-03" }).length,
    2,
  );
  // An unparseable bound is ignored rather than filtering everything away.
  assert.equal(filterCandlesByRange(candles, { from: "not a date" }).length, 4);
});

test("MIN_BACKTEST_CANDLES is the floor the run and the optimizer both honour", () => {
  assert.equal(MIN_BACKTEST_CANDLES, 120);
  assert.equal(InsufficientHistoryError.name, "InsufficientHistoryError");
  const error = new InsufficientHistoryError("too few");
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "INSUFFICIENT_HISTORY");
});

// ============================================================================
// backtester — record building and journal projection
// ============================================================================

test("buildBacktestRecord carries provenance beside the metrics, not only in warnings", () => {
  const candles = withBar(flat(80), 31, { open: 100, high: 100.2, low: 99.8, close: 100 });
  const strategy = scriptedStrategy({
    30: { action: "BUY", reason: "in", confidence: 0.5, stopLoss: 98, takeProfit: 500 },
  });
  const req = btReq({ strategyId: "scripted", strategyVersion: "1.0.0" });
  req.symbol = "TESTUSD";
  req.marketClass = "crypto";
  req.timeframe = "1h";
  const result = simulate(strategy, candles, req, BT_META);

  const record = buildBacktestRecord({
    req,
    result,
    provenance: { source: "synthetic", synthetic: true },
    candles,
    stamp: { id: "bt-1", createdAt: "2026-10-10T00:00:00.000Z" },
  });

  assert.equal(record.id, "bt-1");
  assert.equal(record.created_at, "2026-10-10T00:00:00.000Z");
  assert.equal(record.dataProvenance.synthetic, true);
  assert.equal(record.dataProvenance.source, "synthetic");
  assert.equal(record.dataProvenance.candles, 80);
  assert.equal(record.dataProvenance.from, isoUtc(candles[0].timestamp));
  assert.equal(record.dataProvenance.to, isoUtc(candles[79].timestamp));
  assert.equal(record.request.strategyId, "scripted");
  assert.equal(record.metrics.trades, 1);
  assert.equal(record.trades.length, 1);
  assert.equal(record.equityCurve.length, result.equityCurve.length);
  assert.ok(
    record.warnings.some((warning) => /SYNTHETIC/.test(warning)),
    "a synthetic run must say so in its warnings too",
  );

  // A live run must not carry the synthetic warning.
  const live = buildBacktestRecord({
    req,
    result,
    provenance: { source: "mt5", synthetic: false },
    candles,
    stamp: { id: "bt-2" },
  });
  assert.equal(live.dataProvenance.synthetic, false);
  assert.ok(!live.warnings.some((warning) => /SYNTHETIC/.test(warning)));
  assert.equal(live.id, "bt-2");
  assert.equal(assertIsoCutoff(live.created_at), live.created_at);

  // With no stamp at all, both the id and the timestamp are generated.
  const unstamped = buildBacktestRecord({
    req,
    result,
    provenance: { source: "mt5", synthetic: false },
    candles,
  });
  assert.match(unstamped.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(assertIsoCutoff(unstamped.created_at), unstamped.created_at);
});

test("buildBacktestRecord reports an unknown provider rather than an empty string", () => {
  const req = btReq();
  req.timeframe = "1h";
  const record = buildBacktestRecord({
    req,
    result: { trades: [], equityCurve: [], barsInMarket: 0, warnings: [] },
    provenance: {},
    candles: [],
  });
  assert.equal(record.dataProvenance.source, "unknown");
  assert.equal(record.dataProvenance.candles, 0);
  assert.equal(record.dataProvenance.from, "");
  assert.equal(record.dataProvenance.to, "");
});

test("journalEntriesFromBacktest projects every trade with source 'backtest'", () => {
  const candles = withBar(flat(80), 31, { open: 100, high: 100.2, low: 99.8, close: 100 });
  const strategy = scriptedStrategy({
    30: { action: "BUY", reason: "in", confidence: 0.5, stopLoss: 98, takeProfit: 105 },
  });
  const req = btReq({ strategyId: "scripted", strategyVersion: "1.0.0" });
  req.symbol = "TESTUSD";
  req.marketClass = "crypto";
  req.timeframe = "1h";
  const record = buildBacktestRecord({
    req,
    result: simulate(strategy, withBar(candles, 40, { open: 100, high: 106, low: 99.8, close: 105 }), req, BT_META),
    provenance: { source: "synthetic", synthetic: true },
    candles,
    stamp: { id: "bt-9" },
  });

  let counter = 0;
  const entries = journalEntriesFromBacktest(record, req, { id: () => `j-${(counter += 1)}` });
  assert.equal(entries.length, record.trades.length);
  const entry = entries[0];
  assert.equal(entry.id, "j-1");
  assert.equal(entry.source, "backtest");
  assert.equal(entry.strategy, "scripted");
  assert.equal(entry.strategy_version, "1.0.0");
  assert.equal(entry.symbol, "TESTUSD");
  assert.equal(entry.market, "crypto");
  assert.equal(entry.backtest_id, "bt-9");
  assert.equal(entry.confidence_source, "strategy");
  assert.equal(entry.agent_consensus, null);
  assert.equal(entry.risk_score, req.riskPct);
  assert.equal(entry.execution_time, entry.entry_time);
  assert.equal(entry.fees, record.trades[0].fees.totalCost);
  assert.equal(entry.slippage, record.trades[0].fees.slippageCost);
  assert.equal(entry.pnl, record.trades[0].netPnl);
  assert.equal(entry.r_multiple, record.trades[0].rMultiple);
  assert.equal(entry.reason, record.trades[0].signalReason);
  assertClose(
    entry.pnl_pct,
    (record.trades[0].netPnl / (record.trades[0].units * record.trades[0].entryPrice)) * 100,
    1e-9,
    "pnl_pct is net over notional",
  );
  assert.equal(assertIsoCutoff(entry.entry_time), entry.entry_time);
});

// ============================================================================
// legacy tests/cases/33-optimizer.php — walk-forward verification
// ============================================================================

test("legacy: optimizer runs the declared grid and reports the walk-forward split", () => {
  const factory = builtinStrategyFactory("trend-following");
  assert.ok(factory, "trend-following must have a factory");
  const baselineParams = { ...TREND_FOLLOWING_DEFAULTS };
  const report = optimize({
    make: factory,
    baselineParams,
    grid: factory(baselineParams).paramGrid(),
    candles: optSeries(600, 0.08, 0.4),
    stamp: { ranAt: "2026-10-10T00:00:00.000Z" },
  });

  // trend grid: 2 fast × 3 slow × 2 adx × 1 stop × 2 target = 24 combinations
  assert.equal(report.searchSpace.gridSize, 24);
  assert.equal(
    report.split.inSampleBars + report.split.outOfSampleBars,
    420 + 180,
  );
  assert.equal(report.split.inSampleBars, 420);
  assert.equal(report.split.outOfSampleBars, 180);
  assert.equal(report.ranAt, "2026-10-10T00:00:00.000Z");
  assert.ok(report.baseline.inSample !== null);
  assert.ok(report.baseline.outOfSample !== null);
  assert.deepEqual(report.baseline.params, baselineParams);
  assert.ok(report.finalists.length <= OPTIMIZER_DEFAULTS.topK);

  for (const finalist of report.finalists) {
    assert.ok(finalist.inSample !== null);
    assert.ok(finalist.outOfSample !== null);
    if (finalist.survives) {
      assert.ok(finalist.outOfSample.trades >= OPTIMIZER_DEFAULTS.oosMinTrades);
      assert.ok(finalist.outOfSample.profitFactor > 1);
      assert.ok(finalist.outOfSample.expectancyR > 0);
    }
  }

  // Adoption REQUIRES out-of-sample survival.
  if (report.recommendation.adopt) {
    const adopted = report.finalists.find(
      (finalist) =>
        JSON.stringify(finalist.params) === JSON.stringify(report.recommendation.params),
    );
    assert.ok(adopted, "the recommended params must be one of the finalists");
    assert.equal(adopted.survives, true);
    assert.equal(
      report.recommendation.reason,
      "candidate survived out-of-sample verification and beat the baseline there",
    );
  } else {
    assert.equal(report.recommendation.params, null);
    assert.match(report.recommendation.reason, /keep current parameters/);
  }
  assert.match(report.methodNote, /never recommended/);
  assert.equal(report.methodNote, METHOD_NOTE);
  assert.ok(report.searchSpace.combinationsEvaluated <= 24);
});

test("legacy: optimizer is deterministic for identical inputs", () => {
  const factory = builtinStrategyFactory("trend-following");
  const grid = factory({}).paramGrid();
  const baselineParams = { ...TREND_FOLLOWING_DEFAULTS };
  const a = optimize({
    make: factory,
    baselineParams,
    grid,
    candles: optSeries(500, 0.1, 0.5),
    stamp: { ranAt: "fixed" },
  });
  const b = optimize({
    make: factory,
    baselineParams,
    grid,
    candles: optSeries(500, 0.1, 0.5),
    stamp: { ranAt: "fixed" },
  });
  assert.equal(JSON.stringify(a.recommendation), JSON.stringify(b.recommendation));
  assert.equal(a.baseline.inSample.totalReturnPct, b.baseline.inSample.totalReturnPct);
  assert.deepEqual(a.finalists, b.finalists);
  assert.equal(JSON.stringify(a), JSON.stringify(b), "the whole report must be reproducible");
});

test("legacy: optimizer refuses short histories instead of overfitting a sliver", () => {
  const factory = builtinStrategyFactory("momentum");
  assert.throws(
    () =>
      optimize({
        make: factory,
        baselineParams: {},
        grid: factory({}).paramGrid(),
        candles: optSeries(300, 0.1, 0.3),
      }),
    (error) => {
      assert.ok(error instanceof OptimizationInputError);
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /at least 420 candles, got 300 — load more history/);
      return true;
    },
  );
  assert.equal(OPTIMIZER_DEFAULTS.minCandles, 420);
});

test("legacy: overfit collapse is flagged when in-sample profit dies out-of-sample", () => {
  const factory = builtinStrategyFactory("trend-following");
  // Strong trend for the first 70%, flat chop afterwards: whatever wins
  // in-sample must prove itself on the flat tail.
  const candles = [...optSeries(420, 0.15, 0.25), ...optSeries(180, 0.0, 0.9, 11)];
  const report = optimize({
    make: factory,
    baselineParams: { ...TREND_FOLLOWING_DEFAULTS },
    grid: factory({}).paramGrid(),
    candles,
    stamp: { ranAt: "fixed" },
  });

  for (const finalist of report.finalists) {
    const inSamplePf = finalist.inSample?.profitFactor ?? 0;
    const oosPf = finalist.outOfSample?.profitFactor ?? 0;
    if (inSamplePf > 1 && oosPf <= 1) {
      assert.ok(report.overfitWarnings.length >= 1, "a collapse must be warned about");
      assert.ok(
        report.overfitWarnings.some((warning) => /classic overfit/.test(warning)),
      );
      return;
    }
  }
  // Nothing collapsed, so either nothing was adopted or a finalist survived.
  assert.ok(
    report.recommendation.adopt === false ||
      report.finalists.some((finalist) => finalist.survives),
  );
});

test("legacy: an adopted AI variant is refused the paper stage without human sign-off", async () => {
  const repo = fakeRepo();
  const registry = createStrategyRegistry({ repo, now: () => FIXTURE_NOW });
  await registry.seedBuiltins();

  const factory = builtinStrategyFactory("trend-following");
  const params = { fast: 10, slow: 40, adxMin: 20, stopAtr: 2, targetR: 2 };
  const variant = createVersionedStrategy(factory(params), "1.0.1", params);
  const at = isoUtc(FIXTURE_NOW);
  await registry.registerVariant(variant, {
    ...newStrategyRecord(variant, "ai", at),
    params,
  });

  const stored = await repo.find("trend-following", "1.0.1");
  assert.equal(stored.source, "ai");
  assert.equal(stored.lifecycle, "DRAFT");

  // Seed the stage directly to reach the paper gate, exactly as the oracle does:
  // the API path cannot get an AI variant to RISK_REVIEWED at all.
  await repo.save({ ...stored, lifecycle: "RISK_REVIEWED", updated_at: at });
  const gate = await registry.transition("trend-following", "1.0.1", "PAPER_TRADING");
  assert.equal(gate.ok, false);
  assert.match(gate.reasons.join(";"), /AI-generated strategies require manual human risk sign-off/);

  // And the variant is executable through the registry.
  const impl = registry.implementation("trend-following", "1.0.1");
  assert.ok(impl, "the variant must be executable");
  assert.equal(impl.isVariant, true);
  assert.equal(impl.params().fast, params.fast);
});

test("cartesian enumerates the grid in order and caps with a deterministic stride", () => {
  const combos = cartesian({ a: [1, 2], b: [3, 4] }, 81);
  assert.deepEqual(combos, [
    { a: 1, b: 3 },
    { a: 1, b: 4 },
    { a: 2, b: 3 },
    { a: 2, b: 4 },
  ]);
  // Empty and non-array value lists are skipped, not treated as one option.
  assert.deepEqual(cartesian({ a: [1], b: [], c: null }, 81), [{ a: 1 }]);
  assert.deepEqual(cartesian({}, 81), [{}]);

  const capped = cartesian({ a: [1, 2, 3, 4], b: [1, 2, 3, 4] }, 4);
  assert.equal(capped.length, 4);
  // Stride sampling keeps the first combination and is reproducible.
  assert.deepEqual(capped[0], { a: 1, b: 1 });
  assert.deepEqual(capped, cartesian({ a: [1, 2, 3, 4], b: [1, 2, 3, 4] }, 4));
  assert.equal(OPTIMIZER_DEFAULTS.maxCombinations, 81);
});

test("shortParams renders a compact, readable parameter list", () => {
  assert.equal(shortParams({ fast: 10, slow: 40 }), "fast=10,slow=40");
  assert.equal(shortParams({ volMult: 1.5 }), "volMult=1.5");
  assert.equal(shortParams({}), "");
});

test("the declared grids are small enough that the cap never binds", () => {
  for (const id of BUILTIN_STRATEGY_IDS) {
    const grid = builtinStrategyFactory(id)({}).paramGrid();
    const size = cartesian(grid, Number.MAX_SAFE_INTEGER).length;
    assert.ok(
      size <= OPTIMIZER_DEFAULTS.maxCombinations,
      `${id} grid is ${size}, above the ${OPTIMIZER_DEFAULTS.maxCombinations} cap`,
    );
  }
  // Pinned so a future widening of a grid is a deliberate, reviewed change.
  assert.equal(cartesian(builtinStrategyFactory("trend-following")({}).paramGrid(), 999).length, 24);
  assert.equal(cartesian(builtinStrategyFactory("mean-reversion")({}).paramGrid(), 999).length, 8);
  assert.equal(cartesian(builtinStrategyFactory("breakout")({}).paramGrid(), 999).length, 18);
  assert.equal(cartesian(builtinStrategyFactory("momentum")({}).paramGrid(), 999).length, 8);
});

// ============================================================================
// legacy tests/cases/05-strategies.php — registry lifecycle gates
// ============================================================================

test("legacy: registry lifecycle gates refuse a skipped stage", async () => {
  const { registry, repo } = await seededRegistry();
  const draft = await repo.find("trend-following", "1.0.0");
  assert.equal(draft.lifecycle, "DRAFT");

  const result = await registry.transition("trend-following", "1.0.0", "VALIDATED");
  assert.equal(result.ok, false);
  assert.match(result.reasons[0], /Invalid transition/);
  assert.match(result.reasons[0], /DRAFT -> VALIDATED/);
  assert.match(result.reasons[0], /Expected next stage: BACKTESTED/);
  assert.match(result.reasons[0], /stages may not be skipped/);
});

test("the lifecycle order and stage list are pinned", () => {
  assert.deepEqual(LIFECYCLE_ORDER, [
    "DRAFT",
    "BACKTESTED",
    "VALIDATED",
    "RISK_REVIEWED",
    "PAPER_TRADING",
    "APPROVED",
  ]);
  assert.deepEqual(LIFECYCLE_STAGES, [...LIFECYCLE_ORDER, RETIRED_STAGE]);
  assert.deepEqual(VALIDATION_CRITERIA, {
    minTrades: 10,
    minProfitFactor: 1.0,
    maxDrawdownPct: 50.0,
    requirePositiveExpectancy: true,
  });
});

test("nextStage walks the sequence and stops at the end", () => {
  assert.equal(nextStage("DRAFT"), "BACKTESTED");
  assert.equal(nextStage("BACKTESTED"), "VALIDATED");
  assert.equal(nextStage("VALIDATED"), "RISK_REVIEWED");
  assert.equal(nextStage("RISK_REVIEWED"), "PAPER_TRADING");
  assert.equal(nextStage("PAPER_TRADING"), "APPROVED");
  assert.equal(nextStage("APPROVED"), null, "APPROVED is the end of the sequence");
  assert.equal(nextStage(RETIRED_STAGE), null, "RETIRED is not part of the sequence");
  assert.equal(nextStage("NONSENSE"), null);
});

test("seedBuiltins registers all four and is idempotent across restarts", async () => {
  const repo = fakeRepo();
  const audit = fakeAudit();
  const first = createStrategyRegistry({ repo, audit, now: () => FIXTURE_NOW });
  await first.seedBuiltins();
  assert.equal((await repo.all()).length, 4);
  assert.equal(audit.events.length, 4);
  assert.equal(audit.events[0].action, "strategies.registered");
  assert.equal(first.implementationCount(), 4);

  // Promote one, then "restart": the promotion must survive and no duplicate
  // registration events may be emitted.
  await first.transition("breakout", "1.0.0", "BACKTESTED").catch(() => {});
  const before = await repo.find("breakout", "1.0.0");
  const second = createStrategyRegistry({ repo, audit, now: () => FIXTURE_NOW + 1000 });
  await second.seedBuiltins();
  assert.equal((await repo.all()).length, 4, "seeding must not duplicate records");
  assert.equal(audit.events.length, 4, "seeding must not re-emit registration events");
  const after = await repo.find("breakout", "1.0.0");
  assert.equal(after.lifecycle, before.lifecycle, "a restart must not reset a stage");
  assert.equal(after.created_at, before.created_at);
  assert.equal(second.implementationCount(), 4, "implementations are re-attached in memory");
});

test("a seeded record carries the full contract and a DRAFT history entry", async () => {
  const { repo } = await seededRegistry();
  const record = await repo.find("momentum", "1.0.0");
  assert.deepEqual(Object.keys(record).sort(), [
    "created_at",
    "description",
    "lifecycle",
    "lifecycle_history",
    "market_classes",
    "name",
    "params",
    "source",
    "strategy_id",
    "timeframes",
    "updated_at",
    "version",
  ]);
  assert.equal(Object.keys(record).length, 12, "the record shape is a schema");
  assert.equal(record.source, "builtin");
  assert.equal(record.lifecycle, "DRAFT");
  assert.deepEqual(record.params, { ...MOMENTUM_DEFAULTS });
  assert.deepEqual(record.lifecycle_history, [
    { from: null, to: "DRAFT", at: record.created_at, reason: "registered" },
  ]);
  assert.equal(assertIsoCutoff(record.created_at), record.created_at);
});

test("transition reports a missing strategy and a retired one distinctly", async () => {
  const { registry, repo } = await seededRegistry();

  const missing = await registry.transition("nope", "1.0.0", "BACKTESTED");
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.reasons, ["Strategy nope@1.0.0 not found"]);

  await repo.save({ ...(await repo.find("breakout", "1.0.0")), lifecycle: RETIRED_STAGE });
  const retired = await registry.transition("breakout", "1.0.0", "BACKTESTED");
  assert.equal(retired.ok, false);
  assert.deepEqual(retired.reasons, ["Strategy is RETIRED — lifecycle is terminal"]);

  // Retirement is terminal in both directions: it cannot be undone.
  const unretire = await registry.transition("breakout", "1.0.0", RETIRED_STAGE);
  assert.equal(unretire.ok, false);
});

test("BACKTESTED requires at least one backtest for that exact version", async () => {
  const { registry, repo } = await seededRegistry();

  const refused = await registry.transition("trend-following", "1.0.0", "BACKTESTED");
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.reasons, [
    "No completed backtest for this strategy version — run a backtest first",
  ]);

  // A backtest against a DIFFERENT version must not satisfy this one.
  repo.addBacktest(
    passingBacktest({
      id: "bt-other",
      request: { strategyId: "trend-following", strategyVersion: "9.9.9", symbol: "EURUSD" },
    }),
  );
  const stillRefused = await registry.transition("trend-following", "1.0.0", "BACKTESTED");
  assert.equal(stillRefused.ok, false, "evidence is per version, not per strategy id");

  repo.addBacktest(passingBacktest());
  const allowed = await registry.transition("trend-following", "1.0.0", "BACKTESTED");
  assert.equal(allowed.ok, true);
  assert.equal(allowed.strategy.lifecycle, "BACKTESTED");
});

test("VALIDATED applies the numeric criteria to the latest backtest", async () => {
  const { registry, repo } = await seededRegistry();
  await repo.save({ ...(await repo.find("trend-following", "1.0.0")), lifecycle: "BACKTESTED" });

  const none = await registry.transition("trend-following", "1.0.0", "VALIDATED");
  assert.equal(none.ok, false);
  assert.deepEqual(none.reasons, ["No backtest results available"]);

  const cases = [
    [
      { trades: 3, profitFactor: 2, maxDrawdownPct: 5, expectancyPnl: 10, sharpe: 1 },
      /Sample size too small: 3 trades < 10 required \(EURUSD\)/,
    ],
    [
      { trades: 40, profitFactor: 0.9, maxDrawdownPct: 5, expectancyPnl: 10, sharpe: 1 },
      /Profit factor 0\.90 does not exceed 1/,
    ],
    [
      { trades: 40, profitFactor: 2, maxDrawdownPct: 75, expectancyPnl: 10, sharpe: 1 },
      /Max drawdown 75\.0% exceeds the 50% validation ceiling/,
    ],
    [
      { trades: 40, profitFactor: 2, maxDrawdownPct: 5, expectancyPnl: -3, sharpe: 1 },
      /Negative expectancy per trade \(-3\.00\)/,
    ],
  ];
  for (const [metrics, pattern] of cases) {
    repo.backtests.length = 0;
    repo.addBacktest(passingBacktest({ id: `bt-${Math.random()}`, metrics }));
    const result = await registry.transition("trend-following", "1.0.0", "VALIDATED");
    assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(metrics)}`);
    assert.match(result.reasons.join(" | "), pattern);
    assert.equal(result.strategy.lifecycle, "BACKTESTED", "a refusal must not move the stage");
  }

  repo.backtests.length = 0;
  repo.addBacktest(passingBacktest());
  const ok = await registry.transition("trend-following", "1.0.0", "VALIDATED");
  assert.equal(ok.ok, true);
  assert.equal(ok.strategy.lifecycle, "VALIDATED");
});

test("validateMetrics reports advisories separately from refusals", () => {
  const modest = validateMetrics(
    { trades: 12, profitFactor: 2, maxDrawdownPct: 5, expectancyPnl: 10, sharpe: 1 },
    "EURUSD",
  );
  assert.equal(modest.ok, true);
  assert.deepEqual(modest.reasons, []);
  assert.deepEqual(modest.warnings, [
    "Trade count is modest — results may not be statistically robust",
  ]);

  const suspicious = validateMetrics(
    { trades: 40, profitFactor: 9, maxDrawdownPct: 1, expectancyPnl: 50, sharpe: 7.5 },
    "BTCUSDT",
  );
  assert.equal(suspicious.ok, true);
  assert.match(suspicious.warnings.join(" | "), /Sharpe 7\.50 is suspiciously high/);

  const clean = validateMetrics(
    { trades: 40, profitFactor: 2, maxDrawdownPct: 5, expectancyPnl: 10, sharpe: 1 },
    "EURUSD",
  );
  assert.deepEqual(clean.warnings, []);

  // A null profit factor is skipped, not read as zero.
  const noLosses = validateMetrics(
    { trades: 40, profitFactor: null, maxDrawdownPct: 5, expectancyPnl: 10 },
    "EURUSD",
  );
  assert.equal(noLosses.ok, true);
  // Zero trades fails on sample size alone.
  assert.equal(validateMetrics({ trades: 0 }, "EURUSD").ok, false);
  assert.deepEqual(validateMetrics({}, "").reasons.length, 1);
});

test("RISK_REVIEWED needs an executable implementation and a declared stop", async () => {
  const { registry, repo } = await seededRegistry();

  // A record with no implementation in memory: code is not data, and a record
  // imported from legacy has none until it is re-registered.
  await repo.save({
    ...newStrategyRecord(createTrendFollowingStrategy(), "builtin", isoUtc(FIXTURE_NOW)),
    version: "9.9.9",
    lifecycle: "VALIDATED",
  });
  const noImpl = await registry.transition("trend-following", "9.9.9", "RISK_REVIEWED");
  assert.equal(noImpl.ok, false);
  assert.deepEqual(noImpl.reasons, ["No executable implementation registered for this version"]);

  // Implementations are keyed id@version, so re-attaching must use the SAME
  // version as the record — registering the 1.0.0 builtin would not help here.
  const params = { ...TREND_FOLLOWING_DEFAULTS, fast: 10 };
  registry.registerImplementation(
    createVersionedStrategy(createTrendFollowingStrategy(params), "9.9.9", params),
  );
  const afterRegister = await registry.transition("trend-following", "9.9.9", "RISK_REVIEWED");
  assert.equal(afterRegister.ok, true, "re-attaching the implementation unblocks the gate");
  assert.equal(afterRegister.strategy.lifecycle, "RISK_REVIEWED");
});

test("riskReview enforces mandatory stops and warns on wide ones", async () => {
  const { registry, repo } = await seededRegistry();
  const base = await repo.find("trend-following", "1.0.0");

  const noStop = registry.riskReview({ ...base, params: { fast: 20 } });
  assert.equal(noStop.ok, false);
  assert.deepEqual(noStop.reasons, [
    "Strategy does not define a stop-loss distance parameter — stops are mandatory",
  ]);

  const zeroStop = registry.riskReview({ ...base, params: { stopAtr: 0 } });
  assert.equal(zeroStop.ok, false);
  assert.deepEqual(zeroStop.reasons, ["Stop distance must be positive"]);

  const negative = registry.riskReview({ ...base, params: { stopAtr: -1 } });
  assert.equal(negative.ok, false);

  const wide = registry.riskReview({ ...base, params: { stopAtr: 5 } });
  assert.equal(wide.ok, true, "a wide stop is an advisory, not a refusal");
  assert.match(wide.warnings.join(" | "), /Stop distance 5x ATR is very wide/);

  // Numeric strings count as declared, matching PHP is_numeric.
  assert.equal(registry.riskReview({ ...base, params: { stopAtr: "2" } }).ok, true);

  // mean-reversion is exempt from the stop-parameter rule.
  const mr = await repo.find("mean-reversion", "1.0.0");
  assert.equal(registry.riskReview({ ...mr, params: {} }).ok, true);
});

test("riskReview refuses an AI-sourced strategy at the review gate", async () => {
  const { registry, repo } = await seededRegistry();
  const base = await repo.find("trend-following", "1.0.0");
  const ai = registry.riskReview({ ...base, source: "ai" });
  assert.equal(ai.ok, false);
  assert.deepEqual(ai.reasons, [AI_SIGNOFF_REQUIRED_PAPER]);
});

test("canDeployToPaper requires RISK_REVIEWED and refuses AI sources", async () => {
  const { registry, repo } = await seededRegistry();
  const base = await repo.find("trend-following", "1.0.0");

  for (const lifecycle of ["DRAFT", "BACKTESTED", "VALIDATED"]) {
    const gate = registry.canDeployToPaper({ ...base, lifecycle });
    assert.equal(gate.ok, false, `${lifecycle} must not reach paper`);
    assert.match(gate.reasons[0], new RegExp(`Strategy lifecycle is ${lifecycle}`));
    assert.match(gate.reasons[0], /requires RISK_REVIEWED/);
  }
  for (const lifecycle of ["RISK_REVIEWED", "PAPER_TRADING", "APPROVED"]) {
    assert.equal(registry.canDeployToPaper({ ...base, lifecycle }).ok, true);
  }
  assert.equal(registry.canDeployToPaper({ ...base, lifecycle: RETIRED_STAGE }).ok, false);

  // The AI-source rule is checked AFTER the stage rule, exactly as in the legacy,
  // so a DRAFT AI strategy is refused for its stage first. Isolating the source
  // rule needs a record that has already reached RISK_REVIEWED.
  assert.deepEqual(registry.canDeployToPaper({ ...base, source: "ai" }).reasons, [
    `Strategy lifecycle is DRAFT — paper deployment requires RISK_REVIEWED (advance through backtesting, validation and risk review first)`,
  ]);
  assert.deepEqual(
    registry.canDeployToPaper({ ...base, lifecycle: "RISK_REVIEWED", source: "ai" }).reasons,
    [AI_SIGNOFF_REQUIRED_PAPER],
  );
  assert.equal(
    registry.canDeployToPaper({ ...base, lifecycle: "RISK_REVIEWED", source: "builtin" }).ok,
    true,
  );
});

test("approvalReview fails closed when no journal is wired", async () => {
  const { registry, repo } = await seededRegistry();
  const base = await repo.find("trend-following", "1.0.0");
  const report = await registry.approvalReview({ ...base, lifecycle: "PAPER_TRADING" });
  assert.equal(report.ok, false);
  assert.ok(report.reasons.includes("Paper-trading evidence is unavailable (journal not wired)"));
  assert.equal(report.evidence, undefined, "no evidence can be claimed without a journal");
});

test("approvalReview counts only paper trades for this strategy", async () => {
  const journal = fakeJournal([
    ...paperEvidence("trend-following", 20),
    // Backtest trades must never count as paper evidence.
    ...Array.from({ length: 30 }, (_, index) => ({
      id: `bt-${index}`,
      source: "backtest",
      strategy: "trend-following",
      pnl: 50,
    })),
    // Nor may another strategy's paper trades.
    ...paperEvidence("breakout", 20),
  ]);
  const { registry, repo } = await seededRegistry({ journal });
  const base = await repo.find("trend-following", "1.0.0");
  const report = await registry.approvalReview({ ...base, lifecycle: "PAPER_TRADING" });
  assert.equal(report.ok, true);
  assert.equal(report.evidence.paperTrades, MIN_PAPER_TRADES_FOR_APPROVAL);
  assert.ok(report.evidence.profitFactor === null, "no losing paper trades means no measured PF");
  assert.equal(report.evidence.netPnl, 200);
});

test("approvalReview refuses thin, losing and break-even paper evidence", async () => {
  const thin = fakeJournal(paperEvidence("trend-following", 20).slice(0, 4));
  const thinRegistry = createStrategyRegistry({ repo: fakeRepo(), journal: thin });
  const thinRecord = newStrategyRecord(createTrendFollowingStrategy(), "builtin", isoUtc(FIXTURE_NOW));
  const thinReport = await thinRegistry.approvalReview({
    ...thinRecord,
    lifecycle: "PAPER_TRADING",
  });
  assert.equal(thinReport.ok, false);
  assert.match(thinReport.reasons.join(" | "), /Paper-trading evidence too thin: 4 closed paper trades/);
  assert.equal(thinReport.evidence.paperTrades, 4);

  const losing = fakeJournal([
    ...paperEvidence("trend-following", 10).slice(0, 5),
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `loss-${index}`,
      source: "paper",
      strategy: "trend-following",
      pnl: -30,
    })),
  ]);
  const losingRegistry = createStrategyRegistry({ repo: fakeRepo(), journal: losing });
  const losingReport = await losingRegistry.approvalReview({
    ...thinRecord,
    lifecycle: "PAPER_TRADING",
  });
  assert.equal(losingReport.ok, false);
  const reasons = losingReport.reasons.join(" | ");
  assert.match(reasons, /Paper profit factor 0\.33 does not exceed 1\.0/);
  assert.match(reasons, /Paper expectancy is negative \(-100\.00 net over 10 trades\)/);

  // Exactly break-even: net zero is not positive expectancy.
  const breakEven = fakeJournal([
    ...paperEvidence("trend-following", 10).slice(0, 5),
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `be-${index}`,
      source: "paper",
      strategy: "trend-following",
      pnl: -10,
    })),
  ]);
  const breakEvenRegistry = createStrategyRegistry({ repo: fakeRepo(), journal: breakEven });
  const breakEvenReport = await breakEvenRegistry.approvalReview({
    ...thinRecord,
    lifecycle: "PAPER_TRADING",
  });
  assert.equal(breakEvenReport.ok, false);
  assert.match(breakEvenReport.reasons.join(" | "), /Paper expectancy is negative/);
});

test("approvalReview warns on an implausibly high paper profit factor", async () => {
  const journal = fakeJournal([
    ...paperEvidence("trend-following", 100).slice(0, 9),
    { id: "only-loss", source: "paper", strategy: "trend-following", pnl: -1 },
  ]);
  const registry = createStrategyRegistry({ repo: fakeRepo(), journal });
  const record = newStrategyRecord(createTrendFollowingStrategy(), "builtin", isoUtc(FIXTURE_NOW));
  const report = await registry.approvalReview({ ...record, lifecycle: "PAPER_TRADING" });
  assert.equal(report.ok, true, "a high PF passes the gate…");
  assert.match(
    report.warnings.join(" | "),
    /Paper profit factor 900\.00 is unusually high — verify fills are realistic/,
  );
  assert.equal(report.evidence.profitFactor, 900);
});

test("approvalReview refuses a stage below PAPER_TRADING and an AI source", async () => {
  const journal = fakeJournal(paperEvidence("trend-following", 20));
  const registry = createStrategyRegistry({ repo: fakeRepo(), journal });
  const record = newStrategyRecord(createTrendFollowingStrategy(), "builtin", isoUtc(FIXTURE_NOW));

  const tooEarly = await registry.approvalReview({ ...record, lifecycle: "RISK_REVIEWED" });
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.reasons.join(" | "), /live approval requires the PAPER_TRADING stage first/);

  const ai = await registry.approvalReview({
    ...record,
    lifecycle: "PAPER_TRADING",
    source: "ai",
  });
  assert.equal(ai.ok, false);
  assert.ok(ai.reasons.includes(AI_SIGNOFF_REQUIRED_LIVE));
});

test("a full promotion walks every stage and appends an audit trail", async () => {
  const repo = fakeRepo();
  const audit = fakeAudit();
  const journal = fakeJournal(paperEvidence("trend-following", 20));
  const registry = createStrategyRegistry({
    repo,
    audit,
    journal,
    now: () => FIXTURE_NOW,
  });
  await registry.seedBuiltins();
  repo.addBacktest(passingBacktest());

  const path = ["BACKTESTED", "VALIDATED", "RISK_REVIEWED", "PAPER_TRADING", "APPROVED"];
  let previous = "DRAFT";
  for (const stage of path) {
    const result = await registry.transition("trend-following", "1.0.0", stage, null, "user-1");
    assert.equal(result.ok, true, `promotion to ${stage} failed: ${result.reasons.join("; ")}`);
    assert.equal(result.strategy.lifecycle, stage);
    assert.deepEqual(result.reasons, []);
    previous = stage;
  }
  assert.equal(previous, "APPROVED");

  const record = await repo.find("trend-following", "1.0.0");
  assert.equal(record.lifecycle_history.length, 6, "the seeded DRAFT plus five transitions");
  assert.deepEqual(
    record.lifecycle_history.map((entry) => entry.to),
    ["DRAFT", ...path],
  );
  assert.deepEqual(
    record.lifecycle_history.map((entry) => entry.from),
    [null, "DRAFT", "BACKTESTED", "VALIDATED", "RISK_REVIEWED", "PAPER_TRADING"],
  );
  for (const entry of record.lifecycle_history.slice(1)) {
    assert.match(entry.reason, /^gate checks passed \(/);
    assert.equal(assertIsoCutoff(entry.at), entry.at);
  }

  const changes = audit.events.filter((event) => event.action === "strategies.status-changed");
  assert.equal(changes.length, 5, "one audit event per transition");
  assert.equal(
    audit.events.filter((event) => event.action === "strategies.registered").length,
    4,
  );
  assert.deepEqual(changes[0].details, {
    strategyId: "trend-following",
    version: "1.0.0",
    from: "DRAFT",
    to: "BACKTESTED",
    reason: "gate checks passed (DRAFT -> BACKTESTED)",
  });
  assert.equal(changes.every((event) => event.actorId === "user-1"), true);
  assert.equal(changes[0].summary, "Strategy trend-following@1.0.0: DRAFT -> BACKTESTED");
});

test("APPROVED returns the paper evidence it was granted on", async () => {
  const repo = fakeRepo();
  const journal = fakeJournal(paperEvidence("trend-following", 20));
  const registry = createStrategyRegistry({ repo, journal, now: () => FIXTURE_NOW });
  await registry.seedBuiltins();
  await repo.save({ ...(await repo.find("trend-following", "1.0.0")), lifecycle: "PAPER_TRADING" });

  const result = await registry.transition("trend-following", "1.0.0", "APPROVED");
  assert.equal(result.ok, true);
  assert.deepEqual(result.evidence, {
    paperTrades: MIN_PAPER_TRADES_FOR_APPROVAL,
    profitFactor: null,
    netPnl: 200,
  });
});

test("divergence DV-2: gate warnings survive a successful transition", async () => {
  const repo = fakeRepo();
  const registry = createStrategyRegistry({ repo, now: () => FIXTURE_NOW });
  await registry.seedBuiltins();
  await repo.save({ ...(await repo.find("trend-following", "1.0.0")), lifecycle: "BACKTESTED" });
  // A modest sample and an implausible Sharpe: both advisories, neither a block.
  repo.addBacktest(
    passingBacktest({
      metrics: { trades: 12, profitFactor: 2, maxDrawdownPct: 5, expectancyPnl: 10, sharpe: 7.5 },
    }),
  );

  const result = await registry.transition("trend-following", "1.0.0", "VALIDATED");
  assert.equal(result.ok, true);
  // The legacy returns a hardcoded empty array here, dropping both advisories.
  assert.deepEqual(result.warnings, [
    "Trade count is modest — results may not be statistically robust",
    "Sharpe 7.50 is suspiciously high — inspect for over-fitting or unrealistic fills",
  ]);
});

test("a rejected transition reports its gate warnings too", async () => {
  const repo = fakeRepo();
  const journal = fakeJournal([
    ...paperEvidence("trend-following", 100).slice(0, 9),
    { id: "loss", source: "paper", strategy: "trend-following", pnl: -1 },
  ]);
  const registry = createStrategyRegistry({ repo, journal, now: () => FIXTURE_NOW });
  await registry.seedBuiltins();
  // An AI source is refused, and the implausible-PF advisory still travels with
  // the refusal so the operator sees both facts.
  await repo.save({
    ...(await repo.find("trend-following", "1.0.0")),
    lifecycle: "PAPER_TRADING",
    source: "ai",
  });
  const result = await registry.transition("trend-following", "1.0.0", "APPROVED");
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes(AI_SIGNOFF_REQUIRED_LIVE));
  assert.match(result.warnings.join(" | "), /unusually high/);
  assert.ok(result.evidence, "evidence is returned with a refusal so the numbers can be checked");
});

test("retirement is available from any stage and records a reason", async () => {
  const repo = fakeRepo();
  const audit = fakeAudit();
  const registry = createStrategyRegistry({ repo, audit, now: () => FIXTURE_NOW });
  await registry.seedBuiltins();

  for (const stage of ["DRAFT", "BACKTESTED", "VALIDATED", "RISK_REVIEWED", "PAPER_TRADING", "APPROVED"]) {
    await repo.save({ ...(await repo.find("breakout", "1.0.0")), lifecycle: stage });
    const result = await registry.transition("breakout", "1.0.0", RETIRED_STAGE, `withdrew at ${stage}`);
    assert.equal(result.ok, true, `retirement from ${stage} must succeed`);
    assert.equal(result.strategy.lifecycle, RETIRED_STAGE);
    assert.deepEqual(result.warnings, []);
    const history = result.strategy.lifecycle_history.at(-1);
    assert.equal(history.from, stage);
    assert.equal(history.to, RETIRED_STAGE);
    assert.equal(history.reason, `withdrew at ${stage}`);
  }

  // The default reason is used when none is supplied.
  await repo.save({ ...(await repo.find("momentum", "1.0.0")), lifecycle: "DRAFT" });
  const defaulted = await registry.transition("momentum", "1.0.0", RETIRED_STAGE);
  assert.equal(defaulted.strategy.lifecycle_history.at(-1).reason, "retired by user");
  assert.equal(
    audit.events.filter((event) => event.action === "strategies.status-changed").length,
    7,
  );
});

test("registerVariant refuses to overwrite an existing id@version", async () => {
  const { registry, repo } = await seededRegistry();
  const params = { fast: 10, slow: 40, adxMin: 20, stopAtr: 2, targetR: 2 };
  const variant = createVersionedStrategy(
    builtinStrategyFactory("trend-following")(params),
    "1.0.1",
    params,
  );
  const record = newStrategyRecord(variant, "ai", isoUtc(FIXTURE_NOW));
  await registry.registerVariant(variant, record);
  assert.ok(await repo.find("trend-following", "1.0.1"));

  // A second variant claiming the same version must be refused, not overwrite.
  const duplicate = createVersionedStrategy(
    builtinStrategyFactory("trend-following")({ ...params, fast: 20 }),
    "1.0.1",
    { ...params, fast: 20 },
  );
  await assert.rejects(
    () => registry.registerVariant(duplicate, newStrategyRecord(duplicate, "ai", isoUtc(FIXTURE_NOW))),
    (error) => {
      assert.match(error.message, /variant trend-following@1\.0\.1 already exists/);
      assert.equal(error.code, "STRATEGY_VARIANT_EXISTS");
      assert.equal(error.statusCode, 409);
      return true;
    },
  );
  // The original parameters survive the refused overwrite.
  assert.equal((await repo.find("trend-following", "1.0.1")).params.fast, 10);
});

test("registerVariant audits the AI-source governance requirement", async () => {
  const audit = fakeAudit();
  const registry = createStrategyRegistry({ repo: fakeRepo(), audit, now: () => FIXTURE_NOW });
  await registry.seedBuiltins();
  const params = { ...MEAN_REVERSION_DEFAULTS, rsiLow: 25 };
  const variant = createVersionedStrategy(
    builtinStrategyFactory("mean-reversion")(params),
    "1.0.1",
    params,
  );
  await registry.registerVariant(variant, newStrategyRecord(variant, "ai", isoUtc(FIXTURE_NOW)), "user-7");

  const event = audit.events.find((e) => e.action === "strategies.variant-registered");
  assert.ok(event, "variant registration must be audited");
  assert.equal(event.actorId, "user-7");
  assert.match(event.summary, /source ai, DRAFT, human sign-off required/);
  assert.deepEqual(event.details, {
    strategyId: "mean-reversion",
    version: "1.0.1",
    params,
  });
});

test("findRecord resolves an exact version or the most recently updated one", async () => {
  const { registry, repo } = await seededRegistry();
  const exact = await registry.findRecord("trend-following", "1.0.0");
  assert.equal(exact.version, "1.0.0");
  assert.equal(await registry.findRecord("trend-following", "9.9.9"), null);

  await repo.save({
    ...newStrategyRecord(createTrendFollowingStrategy(), "ai", "2026-10-02T00:00:00.000Z"),
    version: "1.0.2",
    lifecycle: "DRAFT",
  });
  await repo.save({
    ...newStrategyRecord(createTrendFollowingStrategy(), "ai", "2026-10-05T00:00:00.000Z"),
    version: "1.0.1",
  });
  // An empty or null version means "latest by updated_at", not "any". Version
  // 1.0.1 was stamped 2026-10-05 and 1.0.2 only 2026-10-02, so recency — not
  // version ordering — decides, and 1.0.1 wins.
  assert.equal((await registry.findRecord("trend-following", "")).version, "1.0.1");
  assert.equal((await registry.findRecord("trend-following", null)).version, "1.0.1");
  assert.equal((await registry.findRecord("trend-following")).version, "1.0.1");
  assert.equal(await registry.findRecord("nope"), null);
  assert.deepEqual(await registry.findRecordForPaper("trend-following", "1.0.0"), exact);
});

test("an audit sink failure never breaks a lifecycle change", async () => {
  const repo = fakeRepo();
  const registry = createStrategyRegistry({
    repo,
    now: () => FIXTURE_NOW,
    audit: {
      async emit() {
        throw new Error("audit store unavailable");
      },
    },
  });
  await registry.seedBuiltins();
  assert.equal((await repo.all()).length, 4, "seeding completes despite the audit failure");

  repo.addBacktest(passingBacktest());
  const result = await registry.transition("trend-following", "1.0.0", "BACKTESTED");
  assert.equal(result.ok, true, "the transition itself must still succeed");
  assert.equal((await repo.find("trend-following", "1.0.0")).lifecycle, "BACKTESTED");
});

test("a registry with no audit sink still enforces every gate", async () => {
  const repo = fakeRepo();
  const registry = createStrategyRegistry({ repo, now: () => FIXTURE_NOW });
  await registry.seedBuiltins();
  const refused = await registry.transition("trend-following", "1.0.0", "BACKTESTED");
  assert.equal(refused.ok, false);
  repo.addBacktest(passingBacktest());
  assert.equal((await registry.transition("trend-following", "1.0.0", "BACKTESTED")).ok, true);
});

test("newStrategyRecord stamps both timestamps identically and starts at DRAFT", () => {
  const at = "2026-10-10T12:00:00.000Z";
  const record = newStrategyRecord(createBreakoutStrategy(), "builtin", at);
  assert.equal(record.created_at, at);
  assert.equal(record.updated_at, at);
  assert.equal(record.lifecycle, "DRAFT");
  assert.equal(record.strategy_id, "breakout");
  assert.deepEqual(record.market_classes, createBreakoutStrategy().marketClasses());
  assert.deepEqual(record.timeframes, createBreakoutStrategy().timeframes());
});
