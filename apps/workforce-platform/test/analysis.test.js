/**
 * Analysis module — the pure layers.
 *
 * Every case prefixed `legacy …` is ported 1:1 from the PHP suite that runs
 * against the legacy application:
 *   tests/cases/01-indicators.php   → indicator math (hand-computed fixtures)
 *   tests/cases/03-agents.php       → agent honesty rules and consensus gates
 *   tests/cases/34-agent-debate.php → the adversarial review stage
 *   tests/cases/04-risk-engine.php  → vetoes and position sizing
 * The fixtures below are the ones from `tests/framework.php` (`fx_candles`,
 * `fx_noise_range`, `fx_series`, `fx_ctx`, `fx_setup`, `fx_risk_ctx`), so both
 * sides of the migration assert the same numbers against the same inputs.
 *
 * The unprefixed cases are Node-only: edges the legacy suite did not cover, the
 * sentiment validator, and the two recorded divergences (conflict counting in the
 * debate, and the additive `gates` field in the consensus).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  adx, atr, bollinger, ema, findSwings, last, macd, pivotPoints, regressionSlopePct, rsi,
  sma, stochastic, supportResistance, trueRange, volumeProfile, vwap, wilder,
} from "../src/modules/analysis/indicators.js";
import { clamp, mean, numberFormat, roundTo, signedFormat, stdev } from "../src/modules/analysis/math.js";
import { buildScenarios, detectRegime, generateSetup, regimeDirectionality } from "../src/modules/analysis/regime.js";
import { createRiskEngine, DEFAULT_RISK_LIMITS } from "../src/modules/analysis/risk-engine.js";
import { createSentimentSnapshotValidator, unavailableFundamentalsFeed, unavailableSentimentFeed } from "../src/modules/analysis/feeds.js";
import { createTechnicalAgent } from "../src/modules/analysis/agents/technical.js";
import { createMarketStructureAgent } from "../src/modules/analysis/agents/market-structure.js";
import { createForexAgent } from "../src/modules/analysis/agents/forex.js";
import { createCryptoAgent } from "../src/modules/analysis/agents/crypto.js";
import { createSentimentAgent } from "../src/modules/analysis/agents/sentiment.js";
import { createFundamentalsAgent } from "../src/modules/analysis/agents/fundamentals.js";
import { createTradingIntelligenceAgent } from "../src/modules/analysis/agents/intelligence.js";
import { runDebate } from "../src/modules/analysis/agents/debate.js";
import { dataQuality, makeVote, AGENT_WEIGHTS } from "../src/modules/analysis/agents/helper.js";
import { generateSyntheticCandles } from "../src/modules/market-data/providers/synthetic.js";
import { seededRandom } from "../src/modules/market-data/normalize.js";

// ---- fixtures (ported from tests/framework.php) -----------------------------

const FIXTURE_NOW = 1_755_000_000_000;
const HOUR = 3_600_000;

export function fxCandles(n, drift = 0.0, seed = 42, noise = 0.4) {
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
export function fxNoiseRange(n, seed = 7, amp = 0.8) {
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

export function fxSeries(candles, symbol = "TESTUSD", marketClass = "crypto", synthetic = true) {
  return {
    symbol,
    marketClass,
    timeframe: "1h",
    candles,
    provenance: {
      source: synthetic ? "synthetic-demo" : "test",
      synthetic,
      live: !synthetic,
      delayed: false,
      fetchedAt: FIXTURE_NOW,
      dataTimestamp: candles.length ? candles[candles.length - 1].timestamp : 0,
      dataAgeMs: 0,
      stale: false,
      staleThresholdMs: 3 * HOUR,
      fallbackChain: [],
      fromCache: false,
    },
    validation: {
      ok: true,
      droppedCount: 0,
      gapCount: 0,
      expectedIntervalMs: HOUR,
      coveredIntervalMs: 0,
      minTimestamp: 0,
      maxTimestamp: 0,
      issues: [],
    },
  };
}

export function fxCtx(series, now = FIXTURE_NOW) {
  return { series, now, referenceSeries: [] };
}

export function fxSetup(overrides = {}) {
  return {
    action: "BUY",
    symbol: "EURUSD",
    entry: { type: "ZONE", min: 1.081, max: 1.082, reference: 1.0815 },
    stopLoss: 1.0785,
    takeProfit: [1.0855],
    riskReward: 2.0,
    ...overrides,
  };
}

export function fxRiskCtx(overrides = {}) {
  return {
    killSwitchActive: false,
    dataQuality: 0.9,
    syntheticData: false,
    staleData: false,
    equity: 10_000,
    openRiskBySymbol: {},
    openPositions: 0,
    dailyPnl: 0,
    weeklyPnl: 0,
    peakEquity: 10_000,
    ...overrides,
  };
}

function range(from, to) {
  const step = from <= to ? 1 : -1;
  const out = [];
  for (let value = from; step > 0 ? value <= to : value >= to; value += step) out.push(value);
  return out;
}

function closeTo(actual, expected, tolerance, message = "") {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} expected ${expected} ±${tolerance}, got ${actual}`);
}

// ---- legacy 01-indicators ---------------------------------------------------

test("legacy 01-indicators: sma computes windowed means with leading nulls", () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2.0, 3.0, 4.0]);
});

test("legacy 01-indicators: ema seeds with SMA then applies the multiplier", () => {
  assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2.0, 3.0, 4.0]);
});

test("legacy 01-indicators: rsi is 100 on pure gains, 0 on pure losses, bounded on alternation", () => {
  const up = rsi(range(100, 130), 14);
  for (let i = 15; i < up.length; i += 1) closeTo(up[i], 100, 1e-9, `up[${i}]`);

  const down = rsi(range(130, 100), 14);
  for (let i = 15; i < down.length; i += 1) closeTo(down[i], 0, 1e-9, `down[${i}]`);

  const alternating = [];
  for (let i = 0; i < 31; i += 1) alternating.push(i % 2 === 0 ? 100.0 : 101.0);
  const oscillating = rsi(alternating, 14);
  for (let i = 15; i < 31; i += 1) {
    assert.ok(Math.abs(oscillating[i] - 50) < 5, `RSI should oscillate near 50, got ${oscillating[i]}`);
  }
});

test("legacy 01-indicators: macd histogram = macd − signal, positive in an exponential uptrend", () => {
  const closes = [];
  for (let i = 0; i < 80; i += 1) closes.push(100 * 1.01 ** i);
  const result = macd(closes);
  const lastIndex = 79;
  closeTo(result.macd[lastIndex] - result.signal[lastIndex], result.histogram[lastIndex], 1e-6);
  assert.ok(result.macd[lastIndex] > result.signal[lastIndex]);
});

test("legacy 01-indicators: bollinger matches hand-computed SMA ± 2σ", () => {
  const closes = range(1.0, 20.0);
  const bands = bollinger(closes, 20, 2);
  const expectedMean = 10.5;
  const expectedDeviation = Math.sqrt(33.25);
  closeTo(bands.mid[19], 10.5, 1e-9);
  closeTo(bands.upper[19], expectedMean + 2 * expectedDeviation, 1e-6);
  closeTo(bands.lower[19], expectedMean - 2 * expectedDeviation, 1e-6);
});

test("legacy 01-indicators: atr equals the constant range when there are no gaps", () => {
  const candles = [];
  for (let i = 0; i < 30; i += 1) {
    candles.push({ timestamp: i * HOUR, open: 101, high: 102, low: 100, close: 101, volume: 1 });
  }
  closeTo(last(atr(candles, 14)), 2.0, 1e-9);
});

test("legacy 01-indicators: adx is bounded and +DI dominates in an uptrend", () => {
  const candles = [];
  for (let i = 0; i < 80; i += 1) {
    const open = 100 + i * 0.7;
    const close = open + 0.6;
    candles.push({ timestamp: i * HOUR, open, high: close + 0.2, low: open - 0.2, close, volume: 1 });
  }
  const result = adx(candles, 14);
  const lastIndex = 79;
  assert.ok(result.adx[lastIndex] > 0 && result.adx[lastIndex] <= 100, `adx out of range: ${result.adx[lastIndex]}`);
  assert.ok(result.plusDi[lastIndex] > result.minusDi[lastIndex]);
});

test("legacy 01-indicators: vwap is the cumulative typical-price average and null on zero volume", () => {
  const first = { timestamp: 0, open: 10, high: 10, low: 9, close: 9.5, volume: 100 };
  const second = { timestamp: 1, open: 10.5, high: 11, low: 10, close: 10.5, volume: 100 };
  const result = vwap([first, second]);
  closeTo(result[0], 9.5, 1e-9);
  closeTo(result[1], 10.0, 1e-9);
  assert.deepEqual(vwap([{ timestamp: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }]), [null]);
});

test("legacy 01-indicators: classic floor-trader pivots", () => {
  const pivots = pivotPoints({ high: 10, low: 8, close: 9 });
  closeTo(pivots.p, 9, 1e-9);
  closeTo(pivots.r1, 10, 1e-9);
  closeTo(pivots.s1, 8, 1e-9);
  closeTo(pivots.r2, 11, 1e-9);
  closeTo(pivots.s2, 7, 1e-9);
  closeTo(pivots.r3, 12, 1e-9);
  closeTo(pivots.s3, 6, 1e-9);
});

test("legacy 01-indicators: fractal swing detection finds the peak", () => {
  const highs = [10, 11, 11.5, 11.8, 12, 11.5, 11, 10.5, 10, 9.5, 9, 8, 8.5, 9, 9.5, 10];
  const candles = highs.map((high, index) => ({
    timestamp: index * HOUR,
    open: high - 0.5,
    high,
    low: high - 1.5,
    close: high - 0.6,
    volume: 1,
  }));
  const swings = findSwings(candles, 2);
  const high = swings.filter((swing) => swing.type === "high").pop();
  assert.equal(high.index, 4);
  closeTo(high.price, 12.0, 1e-9);
});

test("legacy 01-indicators: regression slope is normalized by the price level", () => {
  const closes = [];
  for (let i = 0; i < 60; i += 1) closes.push(100 + i); // slope 1 per bar
  closeTo(regressionSlopePct(closes, 50), 100 / 134.5, 1e-9);
});

// ---- indicator edges the legacy suite did not cover -------------------------

test("indicators: warm-up positions are null, not zero, and last() skips them", () => {
  const closes = [1, 2, 3];
  assert.deepEqual(sma(closes, 5), [null, null, null], "a period longer than the series yields nothing");
  assert.equal(last(sma(closes, 5)), null);
  assert.equal(last([null, null, 4.5, null]), 4.5, "the last usable value wins over a trailing null");
  assert.equal(last([]), null);
  assert.equal(last([Number.NaN, Infinity]), null, "non-finite values are not usable");
  assert.deepEqual(ema(closes, 0), [null, null, null], "a zero period is refused, not treated as 1");
});

test("indicators: wilder smoothing converges to the constant input", () => {
  const values = new Array(40).fill(3);
  const smoothed = wilder(values, 14);
  closeTo(smoothed[39], 3, 1e-12);
  assert.equal(smoothed[12], null, "not warmed up yet");
  closeTo(smoothed[13], 3, 1e-12, "the seed is the SMA of the first period");
});

test("indicators: true range accounts for the gap against the previous close", () => {
  const candles = [
    { timestamp: 0, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    // Gaps up: the range must be measured from the previous close (100), not this open.
    { timestamp: 1, open: 110, high: 112, low: 109, close: 111, volume: 1 },
  ];
  const result = trueRange(candles);
  closeTo(result[0], 2, 1e-9);
  closeTo(result[1], 12, 1e-9, "high 112 − previous close 100");
});

test("indicators: stochastic masks the smoothed %D where %K is not warmed up", () => {
  const candles = fxCandles(20);
  const result = stochastic(candles, 14, 3);
  assert.equal(result.k.length, 20);
  assert.equal(result.k[12], null);
  assert.equal(result.d[12], null, "%D must not leak the zero-filled smoothing into a null position");
  assert.ok(result.k[13] !== null && result.d[15] !== null);
  for (const value of result.k.filter((entry) => entry !== null)) {
    assert.ok(value >= 0 && value <= 100, `%K out of range: ${value}`);
  }
});

test("indicators: a flat series cannot invent an oscillator reading", () => {
  const flat = [];
  for (let i = 0; i < 40; i += 1) {
    flat.push({ timestamp: i * HOUR, open: 100, high: 100, low: 100, close: 100, volume: 0 });
  }
  const result = stochastic(flat, 14, 3);
  assert.equal(result.k[39], 50, "highest === lowest is reported as neutral, never as a division by zero");
  assert.deepEqual(vwap(flat), new Array(40).fill(null), "no volume means no VWAP");
  const profile = volumeProfile(flat, 24);
  assert.deepEqual(profile, { poc: null, valueAreaHigh: null, valueAreaLow: null });
  assert.equal(last(adx(flat, 14).adx), null, "zero true range leaves ADX undefined rather than saturated");
});

test("indicators: volume profile locates the point of control and a bounded value area", () => {
  const candles = [];
  for (let i = 0; i < 60; i += 1) {
    // Cluster volume around 100 and thin it out towards the edges.
    const price = 95 + (i % 11);
    candles.push({ timestamp: i * HOUR, open: price, high: price + 0.5, low: price - 0.5, close: price, volume: price === 100 ? 500 : 50 });
  }
  const profile = volumeProfile(candles, 24);
  assert.ok(profile.poc > 95 && profile.poc < 106, `poc outside the traded range: ${profile.poc}`);
  assert.ok(profile.valueAreaLow <= profile.poc, "the value area starts at or below the POC");
  assert.ok(profile.valueAreaHigh >= profile.poc, "the value area ends at or above the POC");

  const degenerate = [{ timestamp: 0, open: 10, high: 10, low: 10, close: 10, volume: 5 }];
  assert.deepEqual(volumeProfile(degenerate, 24), { poc: 10, valueAreaHigh: 10, valueAreaLow: 10 });
});

test("indicators: support and resistance merge nearby swings and split on the current price", () => {
  const candles = fxCandles(120, 0, 11, 0.6);
  const price = candles[candles.length - 1].close;
  const levels = supportResistance(candles, last(atr(candles, 14)), price, 4);
  assert.ok(levels.support.length <= 4 && levels.resistance.length <= 4);
  for (const level of levels.support) assert.ok(level < price, "support sits below price");
  for (const level of levels.resistance) assert.ok(level >= price, "resistance sits at or above price");
  assert.deepEqual(supportResistance(candles.slice(0, 3), null, price), { support: [], resistance: [] }, "no swings, no levels");

  // With no ATR the tolerance falls back to 0.2% of price rather than dividing by null.
  const fallback = supportResistance(candles, null, price, 4);
  assert.ok(Array.isArray(fallback.support) && Array.isArray(fallback.resistance));
});

test("indicators: pivot points refuse to guess without a previous period", () => {
  assert.deepEqual(pivotPoints(null), { p: null, r1: null, r2: null, r3: null, s1: null, s2: null, s3: null });
  assert.deepEqual(pivotPoints(undefined), { p: null, r1: null, r2: null, r3: null, s1: null, s2: null, s3: null });
});

test("math helpers: PHP-compatible rounding and formatting", () => {
  assert.equal(roundTo(2.5), 3);
  assert.equal(roundTo(-2.5), -3, "PHP rounds half away from zero; Math.round would give -2");
  assert.equal(roundTo(0.12345, 4), 0.1235);
  assert.equal(roundTo(Number.NaN, 2), Number.NaN);
  assert.equal(numberFormat(64_000, 5), "64,000.00000", "PHP number_format groups thousands");
  assert.equal(numberFormat(1.5, 1), "1.5");
  assert.equal(numberFormat(-1234.5678, 2), "-1,234.57");
  assert.equal(numberFormat(1234), "1,234");
  assert.equal(signedFormat(0.7, 2), "+0.70");
  assert.equal(signedFormat(-0.7, 2), "-0.70");
  assert.equal(clamp(5, -1, 1), 1);
  assert.equal(clamp(-5, -1, 1), -1);
  assert.equal(mean([]), null);
  assert.equal(mean([2, 4]), 3);
  assert.equal(stdev([5]), null, "one sample has no spread");
  closeTo(stdev(range(1, 20)), Math.sqrt(33.25), 1e-9, "population standard deviation divides by n");
});

// ---- legacy 03-agents -------------------------------------------------------

test("legacy 03-agents: the technical agent returns the full structured report", () => {
  const series = fxSeries(generateSyntheticCandles("EURUSD", "1h", 300, FIXTURE_NOW));
  const report = createTechnicalAgent().analyze(fxCtx(series));
  assert.equal(report.agent, "technical");
  assert.ok(report.indicators.rsi14 !== null);
  assert.ok(report.signals.length >= 7, `expected a full indicator panel, got ${report.signals.length}`);
  assert.ok(Math.abs(report.vote.directionalScore) <= 1);
  assert.ok(report.dataQuality > 0);
  // The shape the UI and the debate stage both read.
  assert.deepEqual(Object.keys(report.structure).sort(), ["momentum", "pivots", "resistance", "support", "trend", "trendStrength", "volumeProfile"]);
  assert.ok(report.indicators.macd && "histogram" in report.indicators.macd);
  assert.equal(report.dataLimitations.length, 0, "300 candles is enough for SMA200");
});

test("legacy 03-agents: the technical agent refuses an empty candle series", () => {
  assert.throws(() => createTechnicalAgent().analyze(fxCtx(fxSeries([]))), /insufficient candles for technical analysis/);
});

test("legacy 03-agents: the market structure agent refuses an empty candle series", () => {
  assert.throws(() => createMarketStructureAgent().analyze(fxCtx(fxSeries([]))), /insufficient candles for market-structure analysis/);
});

test("legacy 03-agents: a wick beyond a swing NEVER confirms a break of structure", () => {
  const candles = [];
  const random = seededRandom(3);
  for (let i = 0; i < 60; i += 1) {
    const close = 100 + 1.5 * Math.sin(i / 3) + (random() - 0.5) * 0.1;
    const previous = i > 0 ? 100 + 1.5 * Math.sin((i - 1) / 3) : close;
    candles.push({
      timestamp: FIXTURE_NOW - (61 - i) * HOUR,
      open: previous,
      high: Math.max(previous, close) + 0.05 + 0.04 * Math.sin(i * 1.3),
      low: Math.min(previous, close) - 0.05 - 0.04 * Math.cos(i * 1.3),
      close,
      volume: 50,
    });
  }
  const swingHigh = Math.max(...candles.map((candle) => candle.high));
  const lastCandle = candles[candles.length - 1];

  // A long wick through the swing high that closes back inside: detected, unconfirmed.
  const wickOnly = [...candles, {
    timestamp: lastCandle.timestamp + HOUR, open: 100.1, high: swingHigh + 0.5, low: 100.0, close: 100.1, volume: 80,
  }];
  const report = createMarketStructureAgent().analyze(fxCtx(fxSeries(wickOnly)));
  assert.equal(report.events.breakOfStructure.detected, true);
  assert.equal(report.events.breakOfStructure.confirmedBy, "WICK");
  assert.ok(report.warnings.some((warning) => /wick/i.test(warning)), "the unconfirmed break must be surfaced");
  assert.match(report.vote.reason, /unconfirmed/, "the wick is reported as what it is");
  assert.ok(!/confirmed (bullish|bearish) break/.test(report.vote.reason), "a wick contributes no score");
  const beforeWick = createMarketStructureAgent().analyze(fxCtx(fxSeries(candles)));
  assert.equal(report.vote.directionalScore, beforeWick.vote.directionalScore,
    "adding an unconfirmed wick must not move the score at all");

  // The same bar closing beyond the level with a real body: confirmed.
  const closed = [...candles, {
    timestamp: lastCandle.timestamp + HOUR, open: 100.8, high: swingHigh + 0.5, low: 100.6, close: swingHigh + 0.3, volume: 120,
  }];
  const confirmed = createMarketStructureAgent().analyze(fxCtx(fxSeries(closed)));
  assert.equal(confirmed.events.breakOfStructure.confirmedBy, "CLOSE");
  assert.equal(confirmed.warnings.length, 0);
});

test("legacy 03-agents: the forex agent reports macro unavailable and price-momentum strength", () => {
  const series = fxSeries(generateSyntheticCandles("EURUSD", "1h", 200, FIXTURE_NOW), "EURUSD", "forex");
  const report = createForexAgent().analyze(fxCtx(series));
  assert.equal(report.macro.available, false);
  assert.match(report.macro.reason, /No economic-calendar/);
  assert.equal(report.currencyStrength.derivedFrom, "price-momentum");
  assert.equal(report.pair.classification, "major");
  assert.equal(report.dataLimitations.length, 3, "each missing macro input is named separately");
  assert.match(report.currencyStrength.note, /NOT news or fundamental data/);
  assert.equal(report.currencyStrength.synthetic, true, "the candles are labelled synthetic, so the strength table is too");
  assert.ok(report.warnings.some((warning) => /SYNTHETIC/.test(warning)));
});

test("legacy 03-agents: the crypto agent reports on-chain, derivatives and dominance as unavailable", () => {
  const series = fxSeries(generateSyntheticCandles("BTCUSDT", "1h", 200, FIXTURE_NOW), "BTCUSDT", "crypto");
  const report = createCryptoAgent().analyze(fxCtx(series));
  assert.deepEqual(report.onChain, { dataAvailable: false, warning: "On-chain provider not configured" });
  assert.equal(report.derivatives.dataAvailable, false);
  assert.equal(report.marketDominance.dataAvailable, false);
  assert.ok(report.priceAction.changePct24h !== null);
  assert.ok(report.warnings.some((warning) => /SYNTHETIC/.test(warning)));
});

test("legacy 03-agents: the sentiment agent abstains without providers", () => {
  const report = createSentimentAgent().analyze(fxCtx(fxSeries(fxCandles(100))));
  assert.equal(report.vote.votes, false);
  assert.equal(report.news.available, false);
  assert.equal(report.social.available, false);
  assert.equal(report.dataQuality, 0);
  assert.match(report.vote.reason, /No licensed sentiment feed configured — abstaining/);
  assert.match(report.note, /deliberately NOT presented as sentiment/);
});

test("legacy 03-agents: consensus computes agreement and conflicts, and honors the NO_TRADE gates", () => {
  let unique = 0;
  const makeReport = (score, quality, votes = true) => ({
    agent: `a${(unique += 1)}`,
    title: "A",
    dataQuality: quality,
    dataLimitations: [],
    warnings: [],
    vote: {
      directionalScore: score,
      signal: score > 0.15 ? "BUY" : (score < -0.15 ? "SELL" : "NEUTRAL"),
      weight: 1,
      votes,
      reason: "r",
    },
  });
  const intelligence = createTradingIntelligenceAgent();

  const strong = intelligence.combine(
    [makeReport(0.6, 0.9), makeReport(0.5, 0.9), makeReport(0.4, 0.9), makeReport(-0.2, 0.9)],
    { dataQuality: 0.9, regimeClarity: 0.7, freshnessFactor: 1.0 },
  );
  assert.equal(strong.bias, "BULLISH");
  assert.ok(strong.confidence > 0.5, `confidence too low: ${strong.confidence}`);
  assert.equal(strong.consensus.conflicts.length, 1);
  assert.deepEqual(strong.gates.hardBlocks, []);
  // A legacy quirk worth pinning rather than smoothing over: the reported
  // confidence is rounded to 0.55, but the action threshold is compared against
  // the *raw* 0.5498, so the recommendation is HOLD. The payload can therefore read
  // "BULLISH at 0.55 → HOLD". Rounding the comparison instead would silently turn
  // this panel into a BUY.
  assert.equal(strong.confidence, 0.55);
  assert.equal(strong.recommendation, "HOLD");

  const mixed = intelligence.combine(
    [makeReport(0.05, 0.9), makeReport(-0.05, 0.9)],
    { dataQuality: 0.9, regimeClarity: 0.5, freshnessFactor: 1.0 },
  );
  assert.equal(mixed.bias, "NEUTRAL");
  assert.equal(mixed.recommendation, "HOLD");

  const gated = intelligence.combine([makeReport(0.8, 0.9)], { dataQuality: 0.3, regimeClarity: 0.5, freshnessFactor: 1.0 });
  assert.equal(gated.bias, "NO_TRADE", "low data quality is a hard gate");
  assert.equal(gated.recommendation, "NO_TRADE");
  assert.deepEqual(gated.gates.hardBlocks, ["data quality too low"]);
});

// ---- agent behaviour the legacy suite did not cover -------------------------

test("agents: applicability follows the market class, so a crypto symbol gets no forex report", () => {
  const cryptoSeries = fxSeries(fxCandles(120), "BTCUSDT", "crypto");
  const forexSeries = fxSeries(fxCandles(120), "EURUSD", "forex");
  assert.equal(createCryptoAgent().applicable(fxCtx(cryptoSeries)), true);
  assert.equal(createCryptoAgent().applicable(fxCtx(forexSeries)), false);
  assert.equal(createForexAgent().applicable(fxCtx(forexSeries)), true);
  assert.equal(createForexAgent().applicable(fxCtx(cryptoSeries)), false);
  // Commodities are analysed by the forex agent (gold behaves like a currency pair).
  assert.equal(createForexAgent().applicable(fxCtx(fxSeries(fxCandles(120), "XAUUSD", "commodity"))), true);
  assert.equal(createTechnicalAgent().applicable(fxCtx(cryptoSeries)), true);
  assert.equal(createMarketStructureAgent().applicable(fxCtx(cryptoSeries)), true);
  assert.equal(createSentimentAgent().applicable(fxCtx(cryptoSeries)), true);
  assert.equal(createFundamentalsAgent().applicable(fxCtx(cryptoSeries)), true);
});

test("agents: data quality is penalised for short, synthetic, stale and gapped series", () => {
  const live = fxSeries(fxCandles(300), "EURUSD", "forex", false);
  assert.equal(dataQuality(live), 1);

  const synthetic = fxSeries(fxCandles(300));
  assert.equal(dataQuality(synthetic), 0.6, "labelled synthetic data can never score above 0.6");

  const short = { ...synthetic, candles: fxCandles(50) };
  assert.equal(dataQuality(short), 0.3, "0.5 for <60 candles × 0.6 for synthetic");

  const stale = { ...synthetic, provenance: { ...synthetic.provenance, stale: true } };
  assert.equal(dataQuality(stale), 0.42, "0.6 synthetic × 0.7 stale");

  const gapped = { ...live, validation: { ...live.validation, gapCount: 40 } };
  assert.equal(dataQuality(gapped), 0.8, "gaps above 10% of the series cost 20%");
});

test("agents: the vote threshold separates a small edge from no edge", () => {
  assert.equal(makeVote(0.15, 1, "at the threshold").votes, false, "exactly 0.15 abstains");
  assert.equal(makeVote(0.16, 1, "just over").votes, true);
  assert.equal(makeVote(0.16, 1, "just over").signal, "BUY");
  assert.equal(makeVote(-0.16, 1, "just under").signal, "SELL");
  assert.equal(makeVote(0, 1, "flat").signal, "NEUTRAL");
  assert.equal(makeVote(4, 1, "clamped").directionalScore, 1, "scores are clamped into [-1, 1]");
  assert.equal(makeVote(-4, 1, "clamped").directionalScore, -1);
  assert.deepEqual(AGENT_WEIGHTS, { technical: 1, "market-structure": 0.9, forex: 0.9, crypto: 0.9, sentiment: 0.5 });
});

test("agents: a sentiment agent with a licensed feed votes, and its quality stays bounded", () => {
  // Abstention is conditional, not hard-coded: the same agent votes when the feed
  // satisfies the validator. This is the only way to prove the boundary is a gate.
  const nowSeconds = Math.floor(FIXTURE_NOW / 1000);
  const feed = {
    id: () => "licensed-test-feed",
    health: () => ({ state: "UP", licensed: true, message: "test feed" }),
    snapshot: (symbol) => ({
      available: true,
      symbol,
      source: "test-newswire",
      observedAt: nowSeconds - 60,
      licensed: true,
      observations: [
        { channel: "news", source: "test-newswire", observedAt: nowSeconds - 60, score: 0.6, sampleSize: 40, headline: "Risk appetite improves" },
        { channel: "social", source: "test-social", observedAt: nowSeconds - 120, score: 0.2, sampleSize: 900 },
        { channel: "social", source: "", observedAt: nowSeconds - 120, score: 0.9, sampleSize: 900 }, // unattributable → rejected
        { channel: "news", source: "test-newswire", observedAt: nowSeconds - 99_999, score: 0.9, sampleSize: 10 }, // stale → rejected
      ],
    }),
  };
  const report = createSentimentAgent({ feed, nowSeconds: () => nowSeconds }).analyze(fxCtx(fxSeries(fxCandles(120), "EURUSD", "forex", false)));
  assert.equal(report.vote.votes, true);
  assert.equal(report.vote.signal, "BUY");
  assert.equal(report.provenance.feed, "licensed-test-feed");
  assert.equal(report.provenance.licensed, true);
  assert.equal(report.news.available, true);
  assert.equal(report.social.available, true);
  assert.equal(report.news.observations.length, 1);
  assert.equal(report.social.observations.length, 1);
  closeTo(report.vote.directionalScore, 0.4, 1e-9, "mean of the two valid observations");
  // 0.4 + 0.1×2 observations + 0.05×1 news + 0.05×1 social = 0.7
  assert.equal(report.dataQuality, 0.7);
  assert.equal(report.vote.weight, 0.5, "sentiment stays half the weight of a price-derived agent");
  assert.match(report.vote.reason, /2 observation\(s\) excluded as stale or unattributable/);
});

test("agents: the sentiment validator rejects unlicensed, unattributable, thin and stale snapshots", () => {
  const validator = createSentimentSnapshotValidator(3600);
  const now = 1_755_000_000;
  const base = {
    available: true,
    licensed: true,
    source: "test-newswire",
    observations: [
      { channel: "news", source: "a", observedAt: now - 10, score: 0.5, sampleSize: 10 },
      { channel: "news", source: "b", observedAt: now - 10, score: 0.5, sampleSize: 10 },
    ],
  };

  assert.equal(validator.validate({ available: false, reason: "SNAPSHOT_UNAVAILABLE" }, now).ok, false);
  assert.match(validator.validate({ ...base, licensed: false }, now).reason, /^UNLICENSED/);
  assert.match(validator.validate({ ...base, source: "   " }, now).reason, /^NO_SOURCE/);
  assert.match(validator.validate({ ...base, observations: base.observations.slice(0, 1) }, now).reason, /^STALE_OR_INCOMPLETE/);
  assert.match(
    validator.validate({ ...base, observations: [{ ...base.observations[0], observedAt: now - 7200 }, base.observations[1]] }, now).reason,
    /within 3600s/,
  );
  assert.match(
    validator.validate({ ...base, observations: [{ ...base.observations[0], score: 4 }, base.observations[1]] }, now).reason,
    /^STALE_OR_INCOMPLETE/,
    "an out-of-range score is not a sentiment value",
  );
  assert.match(
    validator.validate({ ...base, observations: [{ ...base.observations[0], sampleSize: 0 }, base.observations[1]] }, now).reason,
    /^STALE_OR_INCOMPLETE/,
    "a zero-sample observation carries no information",
  );
  assert.equal(validator.validate({ ...base, observations: [{ ...base.observations[0], observedAt: now + 30 }, base.observations[1]] }, now).ok, true,
    "small forward clock skew is tolerated");
  assert.equal(validator.validate({ ...base, observations: [{ ...base.observations[0], observedAt: now + 600 }, base.observations[1]] }, now).ok, false,
    "a snapshot from ten minutes in the future is not data");

  const accepted = validator.validate(base, now);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.score, 0.5);
  assert.deepEqual(accepted.provenance.observedAtRange, [now - 10, now - 10]);
  assert.equal(accepted.provenance.licensed, true);
  assert.equal(validator.maxAgeSeconds(), 3600);
});

test("agents: the fundamentals agent abstains and names each missing feed", () => {
  const report = createFundamentalsAgent().analyze(fxCtx(fxSeries(fxCandles(120))));
  assert.equal(report.vote.votes, false);
  assert.equal(report.dataQuality, 0);
  assert.equal(report.earnings.available, false);
  assert.equal(report.macro.available, false);
  assert.equal(report.valuation.available, false);
  assert.equal(report.provenance.feed, "unconfigured");
  assert.equal(report.snapshot.licensed, false);
  assert.equal(unavailableFundamentalsFeed().health().state, "UNCONFIGURED");
  assert.equal(unavailableSentimentFeed().id(), "unconfigured");
});

test("agents: consensus excludes abstainers instead of counting them as neutral votes", () => {
  const intelligence = createTradingIntelligenceAgent();
  const voting = {
    agent: "technical", title: "Technical Analysis Agent", dataQuality: 1,
    vote: { directionalScore: 0.5, signal: "BUY", weight: 1, votes: true, reason: "panel of one" },
  };
  const abstaining = {
    agent: "sentiment", title: "Sentiment Analysis Agent", dataQuality: 0,
    vote: { directionalScore: 0, signal: "NEUTRAL", weight: 0.5, votes: false, reason: "abstaining" },
  };

  const withAbstainer = intelligence.combine([voting, abstaining], { dataQuality: 1, regimeClarity: 1, freshnessFactor: 1 });
  const without = intelligence.combine([voting], { dataQuality: 1, regimeClarity: 1, freshnessFactor: 1 });
  assert.equal(withAbstainer.consensus.netScore, without.consensus.netScore, "an abstention does not dilute the net score");
  assert.deepEqual(withAbstainer.consensus.abstainingAgents, ["sentiment"]);
  assert.deepEqual(withAbstainer.consensus.votingAgents, ["technical"]);
  assert.ok(withAbstainer.reasoning.some((line) => /^Abstaining \(no data\): sentiment$/.test(line)));

  const nobody = intelligence.combine([abstaining], { dataQuality: 0.4, regimeClarity: 0.2, freshnessFactor: 1 });
  assert.equal(nobody.bias, "NO_TRADE", "a panel where nobody votes cannot recommend a trade");
  assert.equal(nobody.consensus.netScore, 0);
});

test("agents: a low-quality series cannot speak at full volume in the consensus", () => {
  const intelligence = createTradingIntelligenceAgent();
  const confident = {
    agent: "technical", title: "T", dataQuality: 1,
    vote: { directionalScore: 0.9, signal: "BUY", weight: 1, votes: true, reason: "strong" },
  };
  const degraded = { ...confident, dataQuality: 0.1 };
  const floor = { ...confident, dataQuality: 0 };

  const highQuality = intelligence.combine([confident], { dataQuality: 1, regimeClarity: 1, freshnessFactor: 1 });
  const lowQuality = intelligence.combine([degraded], { dataQuality: 1, regimeClarity: 1, freshnessFactor: 1 });
  const zeroQuality = intelligence.combine([floor], { dataQuality: 1, regimeClarity: 1, freshnessFactor: 1 });
  // The net score is a weighted mean, so a single voter keeps its score — but the
  // 0.05 floor is what stops a divide-by-zero and keeps a dead agent from vanishing.
  assert.equal(highQuality.consensus.netScore, lowQuality.consensus.netScore);
  assert.equal(zeroQuality.consensus.netScore, lowQuality.consensus.netScore);

  // With two voters of different quality the weighting is visible.
  const bearish = {
    agent: "structure", title: "S", dataQuality: 1,
    vote: { directionalScore: -0.9, signal: "SELL", weight: 0.9, votes: true, reason: "opposed" },
  };
  const balanced = intelligence.combine([confident, bearish], { dataQuality: 1, regimeClarity: 1, freshnessFactor: 1 });
  const tilted = intelligence.combine([degraded, bearish], { dataQuality: 1, regimeClarity: 1, freshnessFactor: 1 });
  assert.ok(tilted.consensus.netScore < balanced.consensus.netScore, "the degraded bullish vote carries less weight");
  assert.equal(balanced.consensus.conflicts.length, 1);
});

// ---- regime, setups and scenarios -------------------------------------------

test("regime: a short series is UNKNOWN with its reason stated, never guessed", () => {
  const assessment = detectRegime(fxSeries(fxCandles(30)));
  assert.equal(assessment.regime, "UNKNOWN");
  assert.equal(assessment.confidence, 0.2);
  assert.deepEqual(assessment.evidence, ["insufficient candles (<60) for regime classification"]);
  assert.equal(assessment.volatilityPct, null);
  assert.equal(assessment.adx, null);
});

test("regime: a trending series is classified with its ADX and evidence", () => {
  const candles = [];
  for (let i = 0; i < 200; i += 1) {
    const open = 100 + i * 0.5;
    candles.push({
      timestamp: FIXTURE_NOW - (200 - i) * HOUR,
      open,
      high: open + 0.6,
      low: open - 0.1,
      close: open + 0.45,
      volume: 100 + i,
    });
  }
  const assessment = detectRegime(fxSeries(candles));
  assert.equal(assessment.regime, "TRENDING_UP");
  assert.ok(assessment.confidence > 0.5 && assessment.confidence <= 0.9);
  assert.ok(assessment.adx >= 25, `ADX should confirm the trend, got ${assessment.adx}`);
  assert.ok(assessment.evidence.some((line) => /^ADX /.test(line)));
  assert.equal(regimeDirectionality("TRENDING_UP"), 1.0);
  assert.equal(regimeDirectionality("BREAKOUT"), 0.8);
  assert.equal(regimeDirectionality("RANGING"), 0.4);
  assert.equal(regimeDirectionality("SOMETHING_NEW"), 0.2, "an unrecognised regime contributes least");
});

test("regime: a mean-reverting series is RANGING, not a trend and not a volatility label", () => {
  // `fxNoiseRange` is seeded, so this is a deterministic fixture: it pulls back
  // toward 100 every bar and its ATR% sits mid-history, which is exactly the case
  // the volatility branches must decline to claim.
  const assessment = detectRegime(fxSeries(fxNoiseRange(200)));
  assert.equal(assessment.regime, "RANGING");
  assert.equal(assessment.confidence, 0.5);
  assert.ok(assessment.adx < 20, `RANGING requires ADX below 20, got ${assessment.adx}`);
  assert.equal(assessment.evidence[0], `ADX ${assessment.adx} below 20 — no directional trend`);
  assert.match(assessment.evidence[1], /^Bollinger bandwidth \d+\.\d\d%$/);
  assert.ok(assessment.volatilityPct > 0.1 && assessment.volatilityPct < 0.9,
    `a mid-history percentile must leave both volatility branches alone, got ${assessment.volatilityPct}`);
  assert.equal(regimeDirectionality("RANGING"), 0.4);
});

/**
 * Deterministic single-branch fixtures for the remaining regime labels. Each one
 * is built so exactly one test fires: closes are flat where a trend must not be
 * found, volume is flat where a breakout must not be found, and the range ramp
 * controls the self-referential ATR percentile.
 */
function flatBar(index, count, range, volume = 100, close = 100) {
  return {
    timestamp: FIXTURE_NOW - (count - index) * HOUR,
    open: close,
    high: close + range / 2,
    low: close - range / 2,
    close,
    volume,
  };
}

test("regime: a downtrend is TRENDING_DOWN, and flat volume keeps it out of the breakout branch", () => {
  const count = 200;
  const candles = [];
  for (let index = 0; index < count; index += 1) {
    const open = 200 - index * 0.5;
    candles.push({
      timestamp: FIXTURE_NOW - (count - index) * HOUR,
      open,
      high: open + 0.1,
      low: open - 0.6,
      close: open - 0.45,
      // Volume is deliberately flat: the last close *is* below the 48-bar low, so
      // without the >1.2 volume-expansion requirement this series would be called
      // a BREAKOUT. The trend branch must win on volume, and it does.
      volume: 200,
    });
  }
  const assessment = detectRegime(fxSeries(candles));
  assert.equal(assessment.regime, "TRENDING_DOWN");
  assert.equal(assessment.confidence, 0.9, "capped at 0.9 however strong ADX gets");
  assert.equal(assessment.adx, 100);
  assert.equal(assessment.evidence[0], "ADX 100.0 with -DI above +DI and EMA20 < EMA50");
  assert.match(assessment.evidence[1], /^note: ATR% is elevated \(\d+th percentile\) despite the trend$/);
  assert.equal(regimeDirectionality("TRENDING_DOWN"), 1.0, "a downtrend is as directional as an uptrend");
});

test("regime: a close beyond the 48-bar range on expanded volume is BREAKOUT", () => {
  const count = 200;
  const candles = [];
  for (let index = 0; index < count - 1; index += 1) candles.push(flatBar(index, count, 1.0));
  // The break bar: outside the range that excludes the last two bars, on 4x volume.
  candles.push({
    timestamp: FIXTURE_NOW - HOUR,
    open: 100.4,
    high: 103,
    low: 100.3,
    close: 102.8,
    volume: 400,
  });
  const assessment = detectRegime(fxSeries(candles));
  assert.equal(assessment.regime, "BREAKOUT");
  assert.equal(assessment.confidence, 0.7);
  assert.equal(assessment.evidence[0], "close beyond 48-bar high (100.50000)", "the level is quoted with the legacy 5-decimal grouping-free format");
  assert.equal(assessment.evidence[1], "volume 4.0x average on the break");
  assert.equal(regimeDirectionality("BREAKOUT"), 0.8, "a break is directional but less so than a trend");
});

test("regime: rising ATR% with no direction is HIGH_VOLATILITY", () => {
  const count = 200;
  const candles = [];
  for (let index = 0; index < count; index += 1) candles.push(flatBar(index, count, 0.2 + index * 0.02));
  const assessment = detectRegime(fxSeries(candles));
  assert.equal(assessment.regime, "HIGH_VOLATILITY");
  assert.equal(assessment.confidence, 0.6);
  assert.equal(assessment.adx, 0, "symmetric bars around a flat close carry no directional movement");
  assert.equal(assessment.evidence[0], "ATR% at the 100th percentile of its own history with no directional trend");
  assert.equal(regimeDirectionality("HIGH_VOLATILITY"), 0.3, "volatility alone contributes least of the traded labels");
});

test("regime: falling ATR% with no direction is LOW_VOLATILITY, legacy ordinal included", () => {
  const count = 200;
  const candles = [];
  for (let index = 0; index < count; index += 1) {
    candles.push(flatBar(index, count, Math.max(0.02, 4.0 - index * 0.018)));
  }
  const assessment = detectRegime(fxSeries(candles));
  assert.equal(assessment.regime, "LOW_VOLATILITY");
  assert.equal(assessment.confidence, 0.55);
  // "1th" is not a typo in the port: the legacy builds the ordinal as
  // `round($volPctile * 100) . 'th percentile'`, so 1% reads "1th". Kept verbatim
  // because this string is part of the payload a legacy consumer may match on.
  assert.equal(assessment.evidence[0], "ATR% at the 1th percentile of its own history");
  assert.equal(regimeDirectionality("LOW_VOLATILITY"), 0.5);
});

test("regime: the volatility percentile is self-referential, so a dead-flat series reads HIGH_VOLATILITY", () => {
  // A perfectly calm series with an identical range on every bar: every historical
  // ATR% is <= the current one, so the percentile is 1.0 and the label is
  // HIGH_VOLATILITY. That is the legacy rule (`count(value <= current)/n`), ported
  // faithfully — and a consumer must read the label as "at the top of its own
  // history", never as "volatile in absolute terms".
  const count = 200;
  const candles = [];
  for (let index = 0; index < count; index += 1) candles.push(flatBar(index, count, 1.0));
  const assessment = detectRegime(fxSeries(candles));
  assert.equal(assessment.regime, "HIGH_VOLATILITY");
  assert.equal(assessment.volatilityPct, 1, "ATR is exactly 1% of price on every bar");
  assert.equal(assessment.confidence, 0.6);
});

test("setups: a neutral or weak-conviction bias produces no proposal at all", () => {
  const series = fxSeries(generateSyntheticCandles("EURUSD", "1h", 300, FIXTURE_NOW), "EURUSD", "forex");
  const technical = createTechnicalAgent().analyze(fxCtx(series));
  const structure = createMarketStructureAgent().analyze(fxCtx(series));

  assert.equal(generateSetup(series, technical, structure, "NEUTRAL", 0.9), null);
  assert.equal(generateSetup(series, technical, structure, "NO_TRADE", 0.9), null);
  assert.equal(generateSetup(series, technical, structure, "BULLISH", 0.54), null, "below the 0.55 conviction floor");
  assert.equal(generateSetup(series, technical, structure, "SIDEWAYS", 0.9), null, "an unknown bias is not directional");
});

test("setups: a directional bias with conviction produces a complete, self-consistent proposal", () => {
  const series = fxSeries(generateSyntheticCandles("EURUSD", "1h", 300, FIXTURE_NOW), "EURUSD", "forex");
  const technical = createTechnicalAgent().analyze(fxCtx(series));
  const structure = createMarketStructureAgent().analyze(fxCtx(series));

  for (const bias of ["BULLISH", "BEARISH"]) {
    const setup = generateSetup(series, technical, structure, bias, 0.72);
    assert.ok(setup, `${bias} should produce a setup on this series`);
    assert.equal(setup.action, bias === "BULLISH" ? "BUY" : "SELL");
    assert.equal(setup.entry.type, "ZONE");
    assert.ok(setup.entry.min <= setup.entry.max, "the entry zone must not be inverted");
    assert.ok(setup.entry.reference >= setup.entry.min && setup.entry.reference <= setup.entry.max);
    assert.equal(setup.takeProfit.length, 3, "the ladder is 1.5R/2.5R/3.5R");
    assert.ok(Number.isFinite(setup.stopLoss));
    assert.ok(setup.riskReward > 0);
    assert.equal(setup.confidence, 0.72);
    assert.ok(setup.invalidationReasons.length >= 1);
    assert.equal(setup.rationale.length, 4);
    assert.match(setup.expiration, /^\d{4}-\d{2}-\d{2}T/, "the setup expires");

    const stopDistance = Math.abs(setup.entry.reference - setup.stopLoss);
    assert.ok(stopDistance > 0, "a zero stop distance is refused rather than divided by");
    if (bias === "BULLISH") {
      assert.ok(setup.stopLoss < setup.entry.min, "a long stop sits below the entry zone");
      assert.ok(setup.takeProfit[0] < setup.takeProfit[1] && setup.takeProfit[1] < setup.takeProfit[2], "targets ascend");
      assert.ok(setup.takeProfit[0] > setup.entry.reference);
    } else {
      assert.ok(setup.stopLoss > setup.entry.max, "a short stop sits above the entry zone");
      assert.ok(setup.takeProfit[0] > setup.takeProfit[1] && setup.takeProfit[1] > setup.takeProfit[2], "targets descend");
      assert.ok(setup.takeProfit[0] < setup.entry.reference);
    }
    // The stop is capped at 2 ATR from the entry reference, so a wide stop cannot
    // be used to inflate the size the risk engine derives from it.
    const price = series.candles[series.candles.length - 1].close;
    assert.ok(stopDistance <= 2 * price * 0.05, "the stop distance stays bounded relative to price");
  }
});

test("setups: rounding follows the instrument's price scale", () => {
  const build = (price) => {
    const candles = [];
    for (let i = 0; i < 120; i += 1) {
      candles.push({ timestamp: FIXTURE_NOW - (120 - i) * HOUR, open: price, high: price * 1.001, low: price * 0.999, close: price, volume: 10 });
    }
    const series = fxSeries(candles, "TESTUSD", "forex", false);
    const technical = { structure: { support: [price * 0.99], resistance: [price * 1.01] } };
    return generateSetup(series, technical, { events: {} }, "BULLISH", 0.8);
  };
  const forex = build(1.0815);
  assert.ok(String(forex.entry.reference).split(".")[1].length <= 6, `forex rounds to 6 decimals, got ${forex.entry.reference}`);
  const index = build(4500);
  assert.ok(String(index.entry.reference).split(".")[1].length <= 3, `a large price rounds to 3 decimals, got ${index.entry.reference}`);
});

test("scenarios: all three paths are always stated, with triggers and invalidation", () => {
  const series = fxSeries(generateSyntheticCandles("EURUSD", "1h", 300, FIXTURE_NOW), "EURUSD", "forex");
  const technical = createTechnicalAgent().analyze(fxCtx(series));
  const price = series.candles[series.candles.length - 1].close;

  for (const bias of ["BULLISH", "BEARISH", "NEUTRAL", "NO_TRADE"]) {
    const scenarios = buildScenarios(series, technical, bias, price);
    assert.deepEqual(Object.keys(scenarios), ["bullish", "bearish", "neutral"]);
    for (const scenario of Object.values(scenarios)) {
      assert.ok(scenario.summary.length > 0);
      assert.ok(scenario.triggers.length >= 1, "a scenario without a trigger is not falsifiable");
      assert.ok(scenario.targets.length >= 1);
      assert.ok(scenario.invalidation.length > 0, "every scenario states what disproves it");
      assert.ok(["primary", "alternate", "base"].includes(scenario.probabilityHint));
    }
    assert.equal(scenarios.bullish.probabilityHint, bias === "BULLISH" ? "primary" : "alternate");
    assert.equal(scenarios.bearish.probabilityHint, bias === "BEARISH" ? "primary" : "alternate");
    assert.equal(scenarios.neutral.probabilityHint, bias === "NEUTRAL" || bias === "NO_TRADE" ? "base" : "alternate");
  }

  // With no structure at all the scenarios fall back to price-relative levels
  // rather than emitting empty arrays.
  const empty = buildScenarios(series, { structure: { support: [], resistance: [] } }, "NEUTRAL", 100);
  assert.deepEqual(empty.bullish.targets, [102], "the fallback target is 2% beyond price");
  assert.deepEqual(empty.bearish.targets, [98]);
  assert.match(empty.bullish.triggers[0], /close above 101\.00000/, "the trigger is the 1% level, not the target");
  assert.match(empty.neutral.invalidation, /decisive close beyond 99\.00000 or 101\.00000/);
});

// ---- legacy 34-agent-debate -------------------------------------------------

function debateReports(extra = []) {
  return [
    {
      agent: "technical",
      dataQuality: 1.0,
      // The legacy fixture stores an array here (truthy in PHP). Kept as an array
      // to prove the port reads truthiness, not a boolean.
      vote: { directionalScore: 0.7, weight: 1.0, votes: [{ direction: "BULLISH", weight: 0.7 }] },
      signals: [
        { name: "ema20/50", signal: "bullish", detail: "fast above slow" },
        { name: "rsi14", signal: "bullish", detail: "58 rising" },
        { name: "macd", signal: "bearish", detail: "histogram fading" },
      ],
    },
    ...extra,
  ];
}

function debateConsensus(patch = {}) {
  return {
    bias: "BULLISH",
    confidence: 0.72,
    confluenceScore: 0.65,
    recommendation: "BUY",
    consensus: { conflicts: 0, agreement: 0.8 },
    ...patch,
  };
}

test("legacy 34-agent-debate: a clean strong case is sustained with an auditable transcript", () => {
  const debate = runDebate(
    debateReports(), debateConsensus(),
    { regime: "TRENDING_UP", confidence: 0.8 },
    null,
    { synthetic: false, stale: false },
    DEFAULT_RISK_LIMITS,
  );
  assert.equal(debate.verdict.bias, "BULLISH");
  assert.ok(debate.verdict.confidence <= 0.72, "the debate can never inflate confidence");
  assert.deepEqual(debate.rounds.map((round) => round.role), ["bull-advocate", "bear-advocate", "skeptic", "risk-critic"]);
  assert.ok(debate.rounds[0].statements.length >= 2);
  assert.match(debate.rounds[0].statements[0].evidence, /technical:ema20\/50/);
  assert.ok(debate.rounds[1].statements.length >= 1, "the bear advocate states the opposing evidence");
  assert.equal(debate.motion, "Sustain BULLISH bias at 0.72 confidence");
});

test("legacy 34-agent-debate: stale data is a sustained CRITICAL objection → NO_TRADE", () => {
  const debate = runDebate(
    debateReports(), debateConsensus(),
    { regime: "TRENDING_UP", confidence: 0.8 },
    null,
    { synthetic: false, stale: true },
    DEFAULT_RISK_LIMITS,
  );
  assert.equal(debate.verdict.bias, "NO_TRADE");
  assert.ok(debate.verdict.confidence < 0.72);
  assert.match(debate.verdict.reasoning.join(";"), /critical objection/);
});

test("legacy 34-agent-debate: two sustained major objections downgrade the bias to NEUTRAL", () => {
  const debate = runDebate(
    debateReports(), debateConsensus({ consensus: { conflicts: 2, agreement: 0.45 } }),
    { regime: "RANGING", confidence: 0.75 }, // contradicts BULLISH, and confidently
    null,
    { synthetic: false, stale: false },
    DEFAULT_RISK_LIMITS,
  );
  assert.equal(debate.verdict.bias, "NEUTRAL");
  assert.match(debate.verdict.reasoning.join(";"), /downgraded to NEUTRAL/);
});

test("legacy 34-agent-debate: one sustained major objection keeps the bias and cuts confidence by 0.10", () => {
  const debate = runDebate(
    debateReports(), debateConsensus(),
    { regime: "RANGING", confidence: 0.75 },
    null,
    { synthetic: false, stale: false },
    DEFAULT_RISK_LIMITS,
  );
  assert.equal(debate.verdict.bias, "BULLISH");
  closeTo(debate.verdict.confidence, 0.62, 1e-9);
  closeTo(debate.verdict.confidenceAdjustment, -0.1, 1e-9);
});

test("legacy 34-agent-debate: weak conviction is challenged and the adjustment is bounded", () => {
  const debate = runDebate(
    debateReports(), debateConsensus({ bias: "BULLISH", confidence: 0.42 }),
    { regime: "TRENDING_UP", confidence: 0.8 },
    null,
    { synthetic: false, stale: false },
    DEFAULT_RISK_LIMITS,
  );
  const skeptical = debate.rounds[2].objections.filter((objection) => objection.id === "S5");
  assert.equal(skeptical[0].severity, "major");
  assert.equal(skeptical[0].sustained, true);
  closeTo(debate.verdict.confidence, 0.32, 1e-9);
});

test("legacy 34-agent-debate: the risk critic challenges a poor setup; already-discounted factors do not bite", () => {
  const setup = { entry: { reference: 100.0 }, stopLoss: 90.0, riskReward: 1.1 };
  const debate = runDebate(
    debateReports(), debateConsensus(),
    { regime: "TRENDING_UP", confidence: 0.8 },
    setup,
    { synthetic: true, stale: false }, // synthetic: informational only
    DEFAULT_RISK_LIMITS,
  );
  const criticIds = debate.rounds[3].objections.map((objection) => objection.id);
  assert.ok(criticIds.includes("R1"), "risk/reward below the minimum is challenged");
  assert.ok(criticIds.includes("R2"), "a wide stop is challenged");
  const syntheticObjection = debate.rounds[2].objections.find((objection) => objection.id === "S4");
  assert.equal(syntheticObjection.sustained, false, "synthetic origin is already discounted by the freshness factor");
  assert.equal(debate.verdict.bias, "BULLISH", "the risk critic's objections do not change the bias on their own");
});

test("debate: no proposal at all is recorded as R0 rather than silently skipped", () => {
  const debate = runDebate(debateReports(), debateConsensus(), { regime: "TRENDING_UP", confidence: 0.8 }, null, { synthetic: false, stale: false }, DEFAULT_RISK_LIMITS);
  assert.deepEqual(debate.rounds[3].objections, [{ id: "R0", severity: "minor", grounds: "no concrete trade setup to challenge", sustained: false }]);
});

test("debate: the verdict can only reduce confidence, never raise it", () => {
  for (const confidence of [0, 0.1, 0.42, 0.55, 0.72, 0.95, 1]) {
    const debate = runDebate(debateReports(), debateConsensus({ confidence }), { regime: "TRENDING_UP", confidence: 0.8 }, null, { synthetic: false, stale: false }, DEFAULT_RISK_LIMITS);
    assert.ok(debate.verdict.confidence <= confidence + 1e-12, `confidence rose from ${confidence} to ${debate.verdict.confidence}`);
    assert.ok(debate.verdict.confidence >= 0, "confidence never goes negative");
  }
});

test("debate: minor objections accumulate but are capped at −0.15", () => {
  // Six sustained minor objections would be −0.12; twelve would be −0.24 uncapped.
  const manyMinors = [];
  for (let i = 0; i < 12; i += 1) {
    manyMinors.push({
      agent: `extra-${i}`, dataQuality: 1, title: "E",
      vote: { directionalScore: 0.5, weight: 1, votes: true, reason: "agree" },
    });
  }
  // Every extra voter reduces the abstention count, so build the minors directly
  // through a report panel that abstains instead.
  const abstainers = [];
  for (let i = 0; i < 4; i += 1) {
    abstainers.push({
      agent: `quiet-${i}`, dataQuality: 0, title: "Q",
      vote: { directionalScore: 0, weight: 1, votes: false, reason: "no data" },
    });
  }
  const debate = runDebate([...debateReports(), ...abstainers], debateConsensus(), { regime: "UNKNOWN", confidence: 0.3 }, null, { synthetic: true, stale: false }, DEFAULT_RISK_LIMITS);
  const minors = debate.rounds[2].objections.filter((objection) => objection.severity === "minor");
  assert.ok(minors.length >= 3, "S1, S4 and S6 are all raised as minors");
  assert.ok(debate.verdict.confidenceAdjustment >= -0.15, `the minor penalty is capped, got ${debate.verdict.confidenceAdjustment}`);
  assert.equal(debate.verdict.bias, "BULLISH", "minors alone never change the bias");
});

test("debate: conflict counting handles the array the engine actually produces (divergence D-1)", () => {
  // The legacy line casts `consensus.conflicts` — an array — to `(int)`, which
  // yields 1 for any non-empty array, so a split panel could never reach the
  // "≥ 2 majors" branch. The port counts the array.
  const conflicts = [
    { agent: "technical", theirBias: "SELL", reason: "opposed" },
    { agent: "crypto", theirBias: "SELL", reason: "opposed" },
  ];
  const debate = runDebate(
    debateReports(), debateConsensus({ consensus: { conflicts, agreement: 0.4 } }),
    { regime: "TRENDING_UP", confidence: 0.8 }, // no S2 contradiction
    null, { synthetic: false, stale: false }, DEFAULT_RISK_LIMITS,
  );
  const s1 = debate.rounds[2].objections.find((objection) => objection.id === "S1");
  assert.equal(s1.severity, "major");
  assert.equal(s1.sustained, true);
  assert.match(s1.grounds, /^2 conflicting agent signal\(s\)/);
  // Only one sustained major → the bias stands with a 0.10 cut.
  assert.equal(debate.verdict.bias, "BULLISH");
  closeTo(debate.verdict.confidence, 0.62, 1e-9);

  const single = runDebate(
    debateReports(), debateConsensus({ consensus: { conflicts: conflicts.slice(0, 1), agreement: 0.6 } }),
    { regime: "TRENDING_UP", confidence: 0.8 }, null, { synthetic: false, stale: false }, DEFAULT_RISK_LIMITS,
  );
  assert.equal(single.rounds[2].objections.find((objection) => objection.id === "S1").severity, "minor",
    "one conflict is already priced into confluence");
});

test("debate: a missing or malformed consensus is treated as no conviction, not as a crash", () => {
  const debate = runDebate([], {}, {}, null, {}, {});
  assert.equal(debate.verdict.bias, "NEUTRAL");
  assert.equal(debate.verdict.confidence, 0);
  assert.equal(debate.rounds[2].objections.length, 6, "all six skeptical objections are still raised");
  assert.deepEqual(debate.rounds[0].statements, []);
});

// ---- legacy 04-risk-engine --------------------------------------------------

test("legacy 04-risk-engine: a clean setup is approved with exact sizing", () => {
  const decision = createRiskEngine().evaluate(fxSetup(), fxRiskCtx());
  assert.equal(decision.approved, true, decision.reasons.join("; "));
  closeTo(decision.sizing.riskAmount, 100.0, 1e-6);
  closeTo(decision.sizing.stopDistance, 0.003, 1e-9);
  closeTo(decision.sizing.units, 100 / 0.003, 0.01);
  assert.equal(decision.sizing.riskPct, 0.01);
  assert.equal(decision.sizing.equity, 10_000);
  assert.deepEqual(decision.warnings, []);
  assert.match(decision.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("legacy 04-risk-engine: veto below the minimum risk/reward", () => {
  const decision = createRiskEngine().evaluate(fxSetup({ riskReward: 1.0 }), fxRiskCtx());
  assert.equal(decision.approved, false);
  assert.equal(decision.reasons.filter((reason) => reason.includes("Risk/reward")).length, 1);
  assert.match(decision.reasons.find((reason) => reason.includes("Risk/reward")), /Risk\/reward 1\.00 below minimum 1\.5/);
});

test("legacy 04-risk-engine: veto when the stop is missing", () => {
  const decision = createRiskEngine().evaluate(fxSetup({ stopLoss: Number.NaN }), fxRiskCtx());
  assert.equal(decision.approved, false);
  assert.equal(decision.reasons.filter((reason) => reason.includes("Stop loss is required")).length, 1);
  assert.equal(decision.sizing, null, "no stop means no position size can be derived");
});

test("legacy 04-risk-engine: the kill switch vetoes everything (Rule 7)", () => {
  const decision = createRiskEngine().evaluate(fxSetup(), fxRiskCtx({ killSwitchActive: true }));
  assert.equal(decision.approved, false);
  assert.match(decision.reasons[0], /Kill switch is ACTIVE/, "the kill switch is the first reason");
});

test("legacy 04-risk-engine: synthetic and stale data are vetoed (Rule 2)", () => {
  const engine = createRiskEngine();
  const synthetic = engine.evaluate(fxSetup(), fxRiskCtx({ syntheticData: true }));
  assert.equal(synthetic.approved, false);
  assert.match(synthetic.reasons[0], /SYNTHETIC/);
  const stale = engine.evaluate(fxSetup(), fxRiskCtx({ staleData: true }));
  assert.equal(stale.approved, false);
  assert.match(stale.reasons.join(";"), /stale beyond the freshness threshold/);

  // The vetoes are configuration, and a host may turn them off explicitly.
  const permissive = createRiskEngine({ blockSyntheticData: false, blockStaleData: false });
  assert.equal(permissive.evaluate(fxSetup(), fxRiskCtx({ syntheticData: true, staleData: true })).approved, true);
  assert.equal(permissive.getLimits().blockSyntheticData, false);
});

test("legacy 04-risk-engine: portfolio gates — daily loss, drawdown and symbol concentration", () => {
  const engine = createRiskEngine();

  const daily = engine.evaluate(fxSetup(), fxRiskCtx({ dailyPnl: -500 }));
  assert.ok(daily.reasons.includes("Daily loss limit exceeded"));

  const weekly = engine.evaluate(fxSetup(), fxRiskCtx({ weeklyPnl: -700 }));
  assert.ok(weekly.reasons.includes("Weekly loss limit exceeded"));

  const drawdown = engine.evaluate(fxSetup(), fxRiskCtx({ equity: 8500, peakEquity: 10_000 }));
  assert.equal(drawdown.reasons.filter((reason) => /drawdown/i.test(reason)).length, 1);
  assert.match(drawdown.reasons.find((reason) => /drawdown/i.test(reason)), /Maximum drawdown 15\.0% exceeds limit 10%/);

  const concentration = engine.evaluate(fxSetup(), fxRiskCtx({ openRiskBySymbol: { EURUSD: 450 } }));
  assert.equal(concentration.reasons.filter((reason) => reason.includes("concentration")).length, 1);
  assert.match(concentration.reasons.find((reason) => reason.includes("concentration")), /Risk concentration in EURUSD would exceed 5% of equity/);

  const tooMany = engine.evaluate(fxSetup(), fxRiskCtx({ openPositions: 10 }));
  assert.ok(tooMany.reasons.includes("Open position count would exceed limit 10"));

  const portfolio = engine.evaluate(fxSetup(), fxRiskCtx({ openRiskBySymbol: { GBPUSD: 1450 } }));
  assert.match(portfolio.reasons.join(";"), /Total open risk .* would exceed limit 15%/);
});

test("legacy 04-risk-engine: a tight stop hits the notional and leverage caps", () => {
  const decision = createRiskEngine().evaluate(
    fxSetup({ entry: { type: "ZONE", min: 1.0819, max: 1.082, reference: 1.08195 }, stopLoss: 1.0819 }),
    fxRiskCtx(),
  );
  assert.equal(decision.approved, false);
  assert.equal(decision.reasons.filter((reason) => /notional/i.test(reason)).length, 1);
  assert.match(decision.reasons.join(";"), /Implied leverage .*x exceeds limit 5x/);
});

test("legacy 04-risk-engine: updateLimits clamps the configured risk to the hard cap", () => {
  const engine = createRiskEngine();
  const limits = engine.updateLimits({ riskPerTradePct: 0.5 });
  assert.equal(limits.riskPerTradePct, limits.maxRiskPerTradePct);
  assert.equal(engine.getLimits().riskPerTradePct, limits.maxRiskPerTradePct, "the clamp persists");
});

test("risk engine: an actual order volume is measured, not a derived position", () => {
  const engine = createRiskEngine();
  // givenUnits is what broker execution passes: the checks must apply to the real
  // order rather than to a position derived from the risk budget.
  const decision = engine.evaluate(fxSetup(), fxRiskCtx({ givenUnits: 100_000 }));
  assert.equal(decision.approved, false);
  closeTo(decision.sizing.riskAmount, 300, 1e-6, "100k units x a 0.0030 stop");
  assert.equal(decision.sizing.units, 100_000, "the given volume is used, not a derived one");
  assert.equal(decision.sizing.riskPct, 0.03);
  assert.match(decision.reasons.join(";"), /Order risk 3\.00% of equity exceeds hard cap 2%/);
  assert.match(decision.reasons.join(";"), /Position notional \$108,150 exceeds limit \$50,000/);
  assert.match(decision.reasons.join(";"), /Implied leverage 10\.8x exceeds limit 5x/);

  const small = engine.evaluate(fxSetup(), fxRiskCtx({ givenUnits: 1000 }));
  closeTo(small.sizing.riskAmount, 3, 1e-9);
  assert.equal(small.sizing.riskPct, 0.0003);
});

test("risk engine: a degenerate entry zone is a warning, and a misconfigured limit is a veto", () => {
  const engine = createRiskEngine();
  const degenerate = engine.evaluate(fxSetup({ entry: { min: 1.082, max: 1.082, reference: 1.082 } }), fxRiskCtx());
  assert.deepEqual(degenerate.warnings, ["Entry zone is degenerate"]);

  // A limit set above its own hard cap cannot be used to approve anything.
  const misconfigured = createRiskEngine({ riskPerTradePct: 0.5, maxRiskPerTradePct: 0.02 });
  const decision = misconfigured.evaluate(fxSetup(), fxRiskCtx());
  assert.equal(decision.approved, false);
  assert.match(decision.reasons.join(";"), /exceeds hard cap/);
});

test("risk engine: default limits are the legacy table, unchanged", () => {
  assert.deepEqual(DEFAULT_RISK_LIMITS, {
    riskPerTradePct: 0.01,
    maxRiskPerTradePct: 0.02,
    minRiskReward: 1.5,
    requireStopLoss: true,
    maxPositionNotionalUsd: 50_000,
    maxLeverage: 5,
    maxOpenPositions: 10,
    maxDailyLossPct: 0.03,
    maxWeeklyLossPct: 0.06,
    maxDrawdownPct: 0.1,
    maxSymbolExposurePct: 0.05,
    maxPortfolioExposurePct: 0.15,
    maxCorrelatedPositions: 3,
    minDataQuality: 0.5,
    blockSyntheticData: true,
    blockStaleData: true,
  });
  assert.equal(Object.isFrozen(DEFAULT_RISK_LIMITS), true);
  const engine = createRiskEngine();
  const limits = engine.getLimits();
  limits.minRiskReward = 99;
  assert.equal(engine.getLimits().minRiskReward, 1.5, "getLimits returns a copy, so a caller cannot mutate the engine");
});

test("risk engine: zero equity produces no NaN — and exposes a legacy gate gap", () => {
  const engine = createRiskEngine();
  const decision = engine.evaluate(fxSetup(), fxRiskCtx({ equity: 0, peakEquity: 0 }));
  assert.equal(decision.sizing.impliedLeverage, null, "leverage is undefined without equity");
  assert.equal(decision.sizing.riskAmount, 0);
  assert.equal(decision.sizing.units, 0);
  assert.ok(decision.reasons.every((reason) => !reason.includes("NaN")), `NaN leaked into a reason: ${decision.reasons.join(";")}`);
  assert.ok(Number.isFinite(decision.sizing.notionalUsd));

  // Recorded, not repaired: with zero equity every portfolio gate is behind an
  // `equity > 0` guard, and a zero risk amount clears the notional and leverage
  // caps trivially, so the legacy engine APPROVES. The port reproduces that. It
  // cannot arise from the analysis path — the engine always supplies the default
  // 10 000 paper equity and the kill switch is engaged — but the broker/execution
  // port must never call this with an uninitialised equity, and finding F-27 says
  // so in the ledger.
  assert.equal(decision.approved, true, "legacy behaviour: no equity means no portfolio gate can fire");

  // The gates that do not depend on equity still fire at zero equity.
  const stillVetoed = engine.evaluate(fxSetup(), fxRiskCtx({ equity: 0, peakEquity: 0, syntheticData: true }));
  assert.equal(stillVetoed.approved, false);
  assert.match(stillVetoed.reasons[0], /SYNTHETIC/);
});
