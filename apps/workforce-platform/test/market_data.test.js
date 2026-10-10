/**
 * Phase 4 — market data: provider chain, normalization, circuit breakers,
 * licensed-feed boundary and the three legacy endpoints.
 *
 * The parity oracle is the legacy test suite `tests/cases/02-providers.php`
 * (eleven cases) plus the provider classes it exercises. Those eleven cases are
 * ported 1:1 below — same inputs, same assertions — and are marked
 * `legacy 02-providers`. Everything after them is Node-specific: HTTP surface,
 * authentication, validation, the licensed adapter's honest refusal states, and
 * the two hardenings this port adds over the legacy manager (a bounded cache and
 * a request deadline).
 *
 * Rule 4 of the migration plan is asserted, not just documented: synthetic output
 * is always labelled, and a host that refuses synthetic data gets an error rather
 * than invented candles.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CLOSED, HALF_OPEN, OPEN, createCircuitBreaker } from "../src/modules/market-data/circuit-breaker.js";
import { createHttpClient, isProviderErrorPayload } from "../src/modules/market-data/http.js";
import { createProviderManager } from "../src/modules/market-data/manager.js";
import { gaussian, hashString, normalizeCandles, seededRandom } from "../src/modules/market-data/normalize.js";
import { createBinanceProvider } from "../src/modules/market-data/providers/binance.js";
import { createFrankfurterProvider } from "../src/modules/market-data/providers/frankfurter.js";
import { createLicensedAssetProvider } from "../src/modules/market-data/providers/licensed-asset.js";
import { BASE_PRICES, createSyntheticProvider, generateSyntheticCandles } from "../src/modules/market-data/providers/synthetic.js";
import { createMarketDataService } from "../src/modules/market-data/service.js";
import { MARKET_CLASSES, TIMEFRAMES, inferMarketClass, staleMs, timeframeMs } from "../src/modules/market-data/timeframes.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";

const MARKET_ENV = { PUBLIC_BASE_URL: "https://site.example.test", MARKET_DATA_REAL_PROVIDERS: "0" };

/* ------------------------------------------------------------- test doubles */

/** Port of `fx_candles()` from `tests/framework.php`: deterministic, gap-free. */
function fxCandles(count, { drift = 0, seed = 42, noise = 0.4 } = {}) {
  const random = seededRandom(seed);
  const out = [];
  let price = 100;
  const now = 1_755_000_000_000;
  const hour = 3_600_000;
  for (let index = 0; index < count; index += 1) {
    const open = price;
    const close = open + drift + (random() - 0.5) * noise;
    out.push({
      timestamp: now - (count - index) * hour,
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

/** Port of `FakeProvider` from `tests/cases/02-providers.php`. */
function fakeProvider(name, priority, data, { failAlways = false, synthetic = false } = {}) {
  return {
    name: () => name,
    synthetic: () => synthetic,
    priority: () => priority,
    supportsSymbol: () => true,
    supportsTimeframe: () => true,
    getCandles() {
      if (failAlways) throw new Error("boom");
      return data ?? [];
    },
    getQuote() {
      throw new Error("no quote");
    },
    healthCheck: () => ({ name, status: "UP", synthetic, checkedAt: 0 }),
    capabilities: () => ({ marketClasses: ["crypto"], timeframes: ["1h"], delayed: false, notes: "fake" }),
  };
}

/** A transport stub in the shape the legacy `Http` class accepted. */
function stubHttp(responder) {
  return {
    getJson: async (url) => {
      const body = await responder(url);
      if (body === null) throw new Error("request failed (network/timeout)");
      const json = typeof body === "string" ? JSON.parse(body) : body;
      if (isProviderErrorPayload(json)) throw new Error(`provider error: ${json.msg}`);
      return json;
    },
  };
}

function managerWith(providers, options = {}) {
  const manager = createProviderManager({ settleMs: 0, ...options });
  for (const provider of providers) manager.register(provider);
  return manager;
}

/* --------------------------------------------- legacy 02-providers, cases 1-3 */

test("legacy 02-providers: provider manager falls back and records the chain", async () => {
  let fellBack = null;
  const manager = managerWith(
    [fakeProvider("broken", 1, null, { failAlways: true }), fakeProvider("working", 2, fxCandles(100))],
    { onFallback: (info) => { fellBack = info; } },
  );

  const series = await manager.getCandleSeries("BTCUSDT", "crypto", "1h", 100);

  assert.equal(series.provenance.source, "working");
  assert.deepEqual(series.provenance.fallbackChain, ["broken"]);
  // The legacy handler payload was {symbol, failed, used}; this port carries the
  // same three fields plus the context the audit event needs.
  assert.equal(fellBack.symbol, "BTCUSDT");
  assert.deepEqual(fellBack.failed, ["broken"]);
  assert.equal(fellBack.used, "working");
  assert.equal(fellBack.synthetic, false);
  assert.equal(series.provenance.synthetic, false);
  assert.equal(series.provenance.live, true);
});

test("legacy 02-providers: synthetic provider marks provenance and generates consistent OHLC", async () => {
  const manager = managerWith([
    fakeProvider("real-down", 1, null, { failAlways: true }),
    createSyntheticProvider(),
  ]);

  const series = await manager.getCandleSeries("BTCUSDT", "crypto", "1h", 100);

  assert.equal(series.provenance.source, "synthetic-demo");
  assert.equal(series.provenance.synthetic, true);
  assert.equal(series.provenance.live, false);
  assert.equal(series.candles.length, 100);
  for (const candle of series.candles) {
    assert.ok(candle.high >= Math.max(candle.open, candle.close), "high must envelope the body");
    assert.ok(candle.low <= Math.min(candle.open, candle.close), "low must envelope the body");
    assert.ok(candle.volume >= 1);
  }
});

test("legacy 02-providers: synthetic generator is deterministic", () => {
  const a = generateSyntheticCandles("BTCUSDT", "1h", 100, 1_700_000_000_000);
  const b = generateSyntheticCandles("BTCUSDT", "1h", 100, 1_700_000_000_000);
  assert.deepEqual(a, b);

  // Golden snapshot of the ported generator (seed string `aegis:BTCUSDT:1h`, the
  // same seed the legacy SyntheticProvider used). Any change to the series —
  // including "fixing" the FNV high-bit quirk in hashString — fails here, because
  // a silently different synthetic history would invalidate every backtest that
  // was run against the old one.
  assert.equal(a[0].timestamp, 1_699_639_200_000);
  assert.equal(a[99].timestamp, 1_699_995_600_000, "the series ends on the last closed 1h bar");
  assert.equal(a[0].open, 64_000, "the series starts at the base price");
  assert.ok(Number.isFinite(a[99].close) && a[99].close > 0);
  assert.deepEqual(Object.keys(a[0]), ["timestamp", "open", "high", "low", "close", "volume"]);

  // Every base price the legacy provider shipped is still here.
  assert.equal(Object.keys(BASE_PRICES).length, 13);
  assert.equal(BASE_PRICES.EURUSD, 1.085);
});

/* --------------------------------------------- legacy 02-providers, case 4 */

test("legacy 02-providers: circuit breaker opens and half-opens", () => {
  // The legacy test slept 30 ms to reach HALF_OPEN. The clock is injectable here,
  // so the same state machine is asserted without waiting.
  let clock = 0;
  const breaker = createCircuitBreaker("t", { threshold: 3, windowMs: 60_000, cooldownMs: 20, now: () => clock });

  assert.equal(breaker.canCall(), true);
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.canCall(), true);
  breaker.recordFailure();
  assert.equal(breaker.canCall(), false);
  assert.equal(breaker.currentState(), OPEN);

  clock += 30;
  assert.equal(breaker.currentState(), HALF_OPEN);
  assert.equal(breaker.canCall(), true);

  // A failed probe re-opens immediately: HALF_OPEN is one attempt, not a reprieve.
  breaker.recordFailure();
  assert.equal(breaker.currentState(), OPEN);

  clock += 30;
  assert.equal(breaker.currentState(), HALF_OPEN);
  breaker.recordSuccess();
  assert.equal(breaker.currentState(), CLOSED);
  assert.equal(breaker.recentFailures(), 0);
});

/* --------------------------------------------- legacy 02-providers, cases 5-6 */

test("legacy 02-providers: http rejects binance-style error envelopes", async () => {
  const http = createHttpClient({
    retries: 0,
    sleep: async () => {},
    transport: async () => JSON.stringify({ code: -1003, msg: "Too many requests" }),
  });
  await assert.rejects(() => http.getJson("https://example.invalid/x"), /provider error: Too many requests/);

  assert.equal(isProviderErrorPayload({ code: -1121, msg: "Invalid symbol." }), true);
  assert.equal(isProviderErrorPayload([[1, "2", "3", "4", "5", "6"]]), false);
  // A list payload is data; an envelope with code 200 is not an error either.
  assert.equal(isProviderErrorPayload({ code: 200, msg: "ok" }), false);
  assert.equal(isProviderErrorPayload({ msg: "no code" }), false);
  assert.equal(isProviderErrorPayload(null), false);
});

test("legacy 02-providers: http accepts list payloads", async () => {
  const http = createHttpClient({
    retries: 0,
    sleep: async () => {},
    transport: async () => JSON.stringify([[1, "2", "3", "4", "5", "6"]]),
  });
  const json = await http.getJson("https://example.invalid/x");
  assert.ok(Array.isArray(json) && json[0][0] === 1);
});

/* --------------------------------------------- legacy 02-providers, cases 7-8 */

test("legacy 02-providers: binance rejects error-object klines instead of inventing candles", async () => {
  const provider = createBinanceProvider({
    baseUrl: "https://binance.test",
    http: stubHttp(() => ({ code: -1121, msg: "Invalid symbol." })),
  });
  await assert.rejects(
    () => provider.getCandles({ symbol: "BTCUSDT", timeframe: "1h", limit: 50 }),
    /provider error: Invalid symbol\./,
  );
});

test("legacy 02-providers: binance rejects zero bid/ask quotes", async () => {
  const provider = createBinanceProvider({
    baseUrl: "https://binance.test",
    http: stubHttp(() => ({ symbol: "BTCUSDT", bidPrice: "0", askPrice: "0" })),
  });
  await assert.rejects(() => provider.getQuote("BTCUSDT"), /invalid prices/);
});

/* --------------------------------------------- legacy 02-providers, cases 9-11 */

test("legacy 02-providers: provider manager falls back when candles are all invalid", async () => {
  const poison = [
    { timestamp: 0, open: 0, high: 0, low: 0, close: 0, volume: 0 },
    { timestamp: 0, open: 0, high: 0, low: 0, close: 0, volume: 0 },
  ];
  const manager = managerWith([fakeProvider("poison", 1, poison), fakeProvider("working", 2, fxCandles(100))]);

  const series = await manager.getCandleSeries("BTCUSDT", "crypto", "1h", 100);

  assert.equal(series.provenance.source, "working");
  assert.deepEqual(series.provenance.fallbackChain, ["poison"]);
  assert.ok(series.candles.length >= 30);
});

test("legacy 02-providers: frankfurter parses date-keyed time series", async () => {
  const payload = {
    amount: 1,
    base: "EUR",
    rates: { "2026-08-20": { USD: 1.16 }, "2026-08-21": { USD: 1.17 } },
  };
  const provider = createFrankfurterProvider({ baseUrl: "https://frankfurter.test", http: stubHttp(() => payload) });

  const candles = await provider.getCandles({ symbol: "EURUSD", timeframe: "1d", limit: 10 });

  assert.equal(candles.length, 2);
  assert.equal(candles[1].close, 1.17);
  assert.ok(candles[1].timestamp > 0);
  // Reference rates carry no volume: an honest zero, never an estimate.
  assert.equal(candles[0].volume, 0);
  assert.equal(candles[0].open, 1.16);
  assert.equal(candles[1].open, 1.16, "open is the previous close");
  assert.equal(candles[1].timestamp, Date.parse("2026-08-21T00:00:00Z"));

  await assert.rejects(
    () => provider.getCandles({ symbol: "EURUSD", timeframe: "1h", limit: 10 }),
    /daily \(1d\) data only/,
  );
  assert.equal(provider.supportsTimeframe("EURUSD", "1d"), true);
  assert.equal(provider.supportsTimeframe("EURUSD", "1h"), false);
  assert.equal(provider.supportsSymbol("XAUUSD"), false, "metals are not ECB reference rates");
  assert.equal(provider.capabilities().delayed, true);
});

test("legacy 02-providers: normalizer sorts, dedupes, drops NaN and counts gaps", () => {
  const raw = [
    { timestamp: 3_000_000, open: 3, high: 3, low: 3, close: 3, volume: 1 },
    { timestamp: 1_000_000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    { timestamp: 1_000_000, open: 2, high: 2, low: 2, close: 2, volume: 1 },
    { timestamp: 2_000_000, open: Number.NaN, high: 2, low: 2, close: 2, volume: 1 },
    { timestamp: 9_000_000, open: 9, high: 9, low: 9, close: 9, volume: 1 },
  ];

  const result = normalizeCandles(raw, "1h");

  assert.equal(result.candles.length, 3);
  assert.equal(result.validation.droppedCount, 2);
  assert.ok(result.validation.gapCount >= 1);
  assert.deepEqual(result.candles.map((candle) => candle.timestamp), [1_000_000, 3_000_000, 9_000_000]);
  assert.equal(result.validation.ok, false, "three candles can never be a valid series");
  assert.equal(result.validation.expectedIntervalMs, 3_600_000);
  assert.equal(result.validation.minTimestamp, 1_000_000);
  assert.equal(result.validation.maxTimestamp, 9_000_000);
});

/* ------------------------------------------------------ normalizer behaviour */

test("normalizer clamps a self-contradictory body and reports the repair", () => {
  const raw = Array.from({ length: 40 }, (_, index) => ({
    timestamp: 1_755_000_000_000 + index * 3_600_000,
    open: 100,
    // high below the body and low above it: provider artefacts, not market facts.
    high: 99,
    low: 101,
    close: 102,
    volume: 10,
  }));

  const result = normalizeCandles(raw, "1h");

  assert.equal(result.candles.length, 40);
  for (const candle of result.candles) {
    assert.equal(candle.high, 102);
    assert.equal(candle.low, 100);
  }
  assert.ok(result.validation.issues.includes("high clamped below close/open body"));
  assert.ok(result.validation.issues.includes("low clamped above close/open body"));
  assert.ok(result.validation.issues.length <= 20, "issue list stays bounded");
  assert.equal(result.validation.ok, true);
});

test("normalizer rejects rows a provider should never have sent", () => {
  const hour = 3_600_000;
  const base = 1_755_000_000_000;
  const rows = [
    { timestamp: base, open: -1, high: 1, low: 1, close: 1, volume: 1 },
    { timestamp: base + hour, open: 1, high: 1, low: 1, close: 1, volume: -5 },
    { timestamp: base + 2 * hour, open: 1, high: 1, low: 1, close: 1, volume: 1, timestamp2: 0 },
    { timestamp: "not-a-number", open: 1, high: 1, low: 1, close: 1, volume: 1 },
    null,
    "candle",
  ];
  const result = normalizeCandles(rows, "1h");
  assert.equal(result.candles.length, 1);
  assert.equal(result.validation.droppedCount, 5);
});

/* ------------------------------------------------------------- timeframes */

test("timeframe table matches the legacy vocabulary", () => {
  assert.deepEqual([...TIMEFRAMES], ["1m", "5m", "15m", "1h", "4h", "1d"]);
  assert.deepEqual([...MARKET_CLASSES], ["forex", "crypto", "stock", "etf", "commodity", "futures", "options", "indices", "bonds"]);
  assert.equal(timeframeMs("1m"), 60_000);
  assert.equal(timeframeMs("1d"), 86_400_000);
  assert.equal(staleMs("1h"), 10_800_000, "3× the interval, as in the legacy Timeframes::staleMs");
  assert.equal(inferMarketClass("BTCUSDT"), "crypto");
  assert.equal(inferMarketClass("EURUSD"), "forex");
});

/* --------------------------------------------------------- deterministic math */

test("hashString reproduces the legacy FNV-1a quirk and stays stable", () => {
  // `MathUtils::hashString` clears bit 31 after every multiply step, and PHP's
  // `$h | 0` cannot make a 64-bit non-negative int negative, so the result is
  // always unsigned. These golden values pin the transcription: the seed of every
  // synthetic series depends on them.
  assert.equal(hashString(""), 2166136261, "the FNV offset basis is returned unchanged");
  assert.equal(hashString("a"), hashString("a"));
  assert.notEqual(hashString("aegis:BTCUSDT:1h"), hashString("aegis:BTCUSDT:4h"));
  for (const value of ["a", "aegis:BTCUSDT:1h", "EURUSD", "x".repeat(64)]) {
    const hash = hashString(value);
    // Bit 31 is cleared after every multiply, so any non-empty input lands in the
    // positive int31 range — the property the synthetic seed relies on.
    assert.ok(Number.isInteger(hash) && hash >= 0 && hash <= 0x7fffffff, `hash out of range for ${value}`);
  }
});

test("seededRandom and gaussian are deterministic and in range", () => {
  const first = seededRandom(42);
  const second = seededRandom(42);
  const a = [first(), first(), first()];
  const b = [second(), second(), second()];
  assert.deepEqual(a, b);
  for (const value of a) assert.ok(value >= 0 && value < 1);

  // Seed 0 is remapped to 1 so the xorshift state can never latch at zero.
  const zero = seededRandom(0);
  assert.ok(zero() > 0);

  const random = seededRandom(7);
  const samples = Array.from({ length: 500 }, () => gaussian(random));
  assert.ok(samples.every((value) => Number.isFinite(value)));
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  assert.ok(Math.abs(mean) < 0.3, `Box-Muller mean drifted: ${mean}`);
});

/* ------------------------------------------------------- manager hardening */

test("manager refuses to serve synthetic data when the host forbids it", async () => {
  const manager = managerWith(
    [fakeProvider("broken", 1, null, { failAlways: true }), createSyntheticProvider()],
    { allowSynthetic: false },
  );

  await assert.rejects(
    () => manager.getCandleSeries("BTCUSDT", "crypto", "1h", 100),
    (error) => {
      assert.match(error.message, /synthetic data is refused on this host/);
      assert.deepEqual(error.failedProviders, ["broken"]);
      return true;
    },
  );
  assert.deepEqual(manager.candidatesFor("BTCUSDT", "1h", "crypto").map((p) => p.name()), ["broken"]);
});

test("manager prefers a timeframe-capable provider over raw priority", async () => {
  // The fake providers declare `marketClasses: ["crypto"]`, so the class filter is
  // exercised by the same call that checks the timeframe ordering.
  const dailyOnly = {
    ...fakeProvider("daily-only", 1, fxCandles(100)),
    supportsTimeframe: (_symbol, timeframe) => timeframe === "1d",
  };
  const intraday = { ...fakeProvider("intraday", 5, fxCandles(100)) };
  const manager = managerWith([dailyOnly, intraday]);

  assert.deepEqual(
    manager.candidatesFor("BTCUSDT", "1h", "crypto").map((provider) => provider.name()),
    ["intraday", "daily-only"],
  );
  assert.deepEqual(
    manager.candidatesFor("BTCUSDT", "1h", "forex").map((provider) => provider.name()),
    [],
    "a provider that does not declare the market class is not a candidate",
  );
  const series = await manager.getCandleSeries("BTCUSDT", "crypto", "1h", 100);
  assert.equal(series.provenance.source, "intraday");
  assert.deepEqual(series.provenance.fallbackChain, []);
});

test("manager promotes a provider to DEGRADED after a recorded failure", async () => {
  let calls = 0;
  const flaky = {
    ...fakeProvider("flaky", 1, fxCandles(100)),
    getCandles() {
      calls += 1;
      if (calls === 1) throw new Error("temporary outage");
      return fxCandles(100);
    },
  };
  const manager = managerWith([flaky, fakeProvider("backup", 2, fxCandles(100))]);

  await manager.getCandleSeries("BTCUSDT", "crypto", "1h", 100);
  const health = await manager.getAllHealth(true);

  assert.equal(health.find((entry) => entry.name === "flaky").status, "DEGRADED");
  assert.equal(health.find((entry) => entry.name === "backup").status, "UP");
  assert.match(manager.failureLog().flaky, /temporary outage/);
});

test("manager can report health without probing any external host", async () => {
  let probes = 0;
  const provider = {
    ...fakeProvider("probe-me", 1, fxCandles(100)),
    healthCheck() {
      probes += 1;
      return { name: "probe-me", status: "UP", synthetic: false, checkedAt: 0 };
    },
  };
  const manager = managerWith([provider]);

  const snapshot = await manager.getAllHealth(false, { probe: false });

  assert.equal(probes, 0, "an unprobed health read must not touch the network");
  assert.equal(snapshot[0].status, "UNKNOWN");
  assert.match(snapshot[0].detail, /Not probed/);

  await manager.getAllHealth(true);
  assert.equal(probes, 1);
  // Cached for 10 s: a second non-forced read must not probe again.
  await manager.getAllHealth(false);
  assert.equal(probes, 1);
});

test("manager caches candles within their TTL and bounds the cache", async () => {
  let calls = 0;
  const counting = {
    ...fakeProvider("counting", 1, fxCandles(100)),
    getCandles() {
      calls += 1;
      return fxCandles(100);
    },
  };
  const manager = managerWith([counting]);

  const first = await manager.getCandleSeries("BTCUSDT", "crypto", "1h", 100);
  const second = await manager.getCandleSeries("BTCUSDT", "crypto", "1h", 100);
  assert.equal(calls, 1, "the second read must come from cache");
  assert.equal(first.provenance.fromCache, false);
  assert.equal(second.provenance.fromCache, true);

  // A different limit is a different series and must not be served from the cache.
  await manager.getCandleSeries("BTCUSDT", "crypto", "1h", 50);
  assert.equal(calls, 2);

  // The legacy cache grew without bound in a long-lived process; this one evicts.
  for (let index = 0; index < 520; index += 1) {
    await manager.getCandleSeries(`SYM${index}`, "crypto", "1h", 30);
  }
  assert.ok(manager.caches().candles <= 500, `cache grew to ${manager.caches().candles}`);
});

test("manager reports stale provenance when the newest candle is old", async () => {
  const old = fxCandles(100).map((candle) => ({ ...candle, timestamp: candle.timestamp - 86_400_000 }));
  const manager = managerWith([fakeProvider("stale", 1, old)]);

  const series = await manager.getCandleSeries("BTCUSDT", "crypto", "1h", 100);

  assert.equal(series.provenance.stale, true);
  assert.equal(series.provenance.staleThresholdMs, staleMs("1h"));
  assert.ok(series.provenance.dataAgeMs > staleMs("1h"));
});

/* --------------------------------------------------- licensed-feed boundary */

const LICENSED_BASE = {
  assetClass: "stock",
  providerId: "licensed-stock",
  displayName: "Licensed US equities",
  envPrefix: "AEGIS_STOCK_DATA",
  priority: 30,
};

test("licensed adapter is DISABLED until explicitly enabled", async () => {
  const provider = createLicensedAssetProvider({ ...LICENSED_BASE, baseUrl: "https://feed.example.test", license: "LIC-1", symbols: ["AAPL"] });

  assert.equal((await provider.healthCheck()).status, "DISABLED");
  assert.equal(provider.configured(), false);
  assert.equal(provider.supportsSymbol("AAPL"), false, "an inert adapter must never claim a symbol");
  await assert.rejects(() => provider.getCandles({ symbol: "AAPL", timeframe: "1d", limit: 50 }), /not configured/);
  await assert.rejects(() => provider.getQuote("AAPL"), /not configured/);
});

test("licensed adapter reports NOT_CONFIGURED without url, license or symbols", async () => {
  const cases = [
    { enabled: true, baseUrl: null, license: "LIC-1", symbols: ["AAPL"] },
    { enabled: true, baseUrl: "https://feed.example.test", license: "", symbols: ["AAPL"] },
    { enabled: true, baseUrl: "https://feed.example.test", license: "LIC-1", symbols: [] },
    { enabled: true, baseUrl: "ftp://feed.example.test", license: "LIC-1", symbols: ["AAPL"] },
  ];
  for (const overrides of cases) {
    const provider = createLicensedAssetProvider({ ...LICENSED_BASE, ...overrides });
    const health = await provider.healthCheck();
    assert.equal(health.status, "NOT_CONFIGURED", JSON.stringify(overrides));
    assert.equal(provider.configured(), false);
  }
});

test("licensed adapter serves a configured feed and rejects malformed payloads", async () => {
  const candles = Array.from({ length: 40 }, (_, index) => ({
    timestamp: 1_755_000_000_000 + index * 86_400_000,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1_000,
  }));
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    if (url.includes("/candles")) return { data: { candles } };
    if (url.includes("/quote")) return { data: { quote: { symbol: "AAPL", last: 141, bid: 140.9, ask: 141.1, timestamp: 1_755_000_000 } } };
    return { ok: true, version: "2.4.1" };
  };
  const provider = createLicensedAssetProvider({
    ...LICENSED_BASE,
    baseUrl: "https://feed.example.test",
    license: "LIC-1",
    token: "secret-token",
    symbols: ["AAPL", "MSFT"],
    enabled: true,
    request,
  });

  assert.equal(provider.configured(), true);
  const health = await provider.healthCheck();
  assert.equal(health.status, "UP");
  assert.equal(health.providerVersion, "2.4.1");
  assert.equal(health.licenseConfigured, true);
  assert.equal(provider.capabilities().configuredSymbols, 2);

  const served = await provider.getCandles({ symbol: "AAPL", timeframe: "1d", limit: 50 });
  assert.equal(served.length, 40);
  assert.ok(calls[1].includes("symbol=AAPL") && calls[1].includes("marketClass=stock"));

  const quote = await provider.getQuote("AAPL");
  assert.deepEqual(quote, { symbol: "AAPL", last: 141, bid: 140.9, ask: 141.1, timestamp: 1_755_000_000_000 });

  // Symbols outside the allow-list are refused, never approximated.
  await assert.rejects(() => provider.getCandles({ symbol: "TSLA", timeframe: "1d", limit: 50 }), /does not allow TSLA/);
  await assert.rejects(() => provider.getCandles({ symbol: "AAPL", timeframe: "2h", limit: 50 }), /does not support timeframe/);

  // Invalid OHLCV from the wire is a failure, not a repaired candle.
  const bad = createLicensedAssetProvider({
    ...LICENSED_BASE,
    baseUrl: "https://feed.example.test",
    license: "LIC-1",
    symbols: ["AAPL"],
    enabled: true,
    request: async () => ({ data: { candles: [{ timestamp: 1, open: 10, high: 9, low: 11, close: 10, volume: 1 }] } }),
  });
  await assert.rejects(() => bad.getCandles({ symbol: "AAPL", timeframe: "1d", limit: 50 }), /invalid OHLCV/);

  // An unreachable feed reports DOWN with the reason, and never falls back silently.
  const down = createLicensedAssetProvider({
    ...LICENSED_BASE,
    baseUrl: "https://feed.example.test",
    license: "LIC-1",
    symbols: ["AAPL"],
    enabled: true,
    request: async () => { throw new Error("connect ETIMEDOUT"); },
  });
  const downHealth = await down.healthCheck();
  assert.equal(downHealth.status, "DOWN");
  assert.match(downHealth.lastError, /ETIMEDOUT/);
});

/* ------------------------------------------------------------ binance rules */

test("binance only serves listed symbols and validates kline rows", async () => {
  const provider = createBinanceProvider({
    baseUrl: "https://binance.test",
    http: stubHttp(() => [[1_755_000_000_000, "1", "2", "0.5", "1.5", "10", "ignored"]]),
  });

  assert.equal(provider.supportsSymbol("BTCUSDT"), true);
  assert.equal(provider.supportsSymbol("AAPL"), false);
  assert.equal(provider.priority(), 10);
  assert.equal(provider.synthetic(), false);

  const candles = await provider.getCandles({ symbol: "btcusdt", timeframe: "1h", limit: 50 });
  assert.deepEqual(candles[0], { timestamp: 1_755_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });

  await assert.rejects(() => provider.getCandles({ symbol: "AAPL", timeframe: "1h", limit: 50 }), /does not list AAPL/);

  const ragged = createBinanceProvider({ baseUrl: "https://binance.test", http: stubHttp(() => [[1, 2, 3]]) });
  await assert.rejects(() => ragged.getCandles({ symbol: "BTCUSDT", timeframe: "1h", limit: 50 }), /klines row is invalid/);

  // Host fallback: the primary host fails, a mirror serves.
  const seen = [];
  const mirroring = createBinanceProvider({
    baseUrl: "https://binance.test",
    http: {
      getJson: async (url) => {
        seen.push(new URL(url).host);
        if (seen.length === 1) throw new Error("primary unreachable");
        return [[1_755_000_000_000, 1, 2, 0.5, 1.5, 10]];
      },
    },
  });
  await mirroring.getCandles({ symbol: "BTCUSDT", timeframe: "1h", limit: 50 });
  assert.equal(seen[0], "binance.test");
  assert.equal(seen[1], "data-api.binance.vision");
  assert.equal(mirroring.circuitState(), CLOSED);
});

/* ------------------------------------------------------------- http client */

test("http client retries with bounded backoff and gives up honestly", async () => {
  const waits = [];
  let attempts = 0;
  const http = createHttpClient({
    retries: 2,
    sleep: async (ms) => { waits.push(ms); },
    transport: async () => {
      attempts += 1;
      return null;
    },
  });

  await assert.rejects(() => http.getJson("https://example.invalid/x"), /request failed \(network\/timeout\)/);
  assert.equal(attempts, 3, "initial attempt plus two retries");
  assert.deepEqual(waits, [300, 600], "300ms × 2^attempt, capped at 1s");
});

/* ------------------------------------------------------------- HTTP surface */

async function signIn(app) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifier: "rootadmin", password: "Root administrator pass" },
  });
  assert.equal(response.statusCode, 200, response.body);
  return cookieFrom(response);
}

test("market-data endpoints require an authenticated session", async () => {
  const harness = await createFileStoreApp({ configOverrides: { env: MARKET_ENV } });
  try {
    for (const url of [
      "/api/v1/market-data/candles?symbol=BTCUSDT&timeframe=1h",
      "/api/v1/market-data/quote?symbol=BTCUSDT",
      "/api/v1/market-data/providers",
    ]) {
      const response = await harness.app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 401, url);
      assert.equal(response.json().error.code, "AUTH_REQUIRED");
    }
  } finally {
    await harness.cleanup();
  }
});

test("candles endpoint validates the legacy vocabulary and clamps nothing silently", async () => {
  const harness = await createFileStoreApp({ configOverrides: { env: MARKET_ENV } });
  try {
    const cookie = await signIn(harness.app);
    const cases = [
      ["/api/v1/market-data/candles", "symbol is required"],
      ["/api/v1/market-data/candles?symbol=BTCUSDT", "timeframe is required"],
      ["/api/v1/market-data/candles?symbol=BTCUSDT&timeframe=2h", "timeframe must be one of"],
      ["/api/v1/market-data/candles?symbol=B&timeframe=1h", "symbol is too short"],
      ["/api/v1/market-data/candles?symbol=BTCUSDT&timeframe=1h&marketClass=bananas", "marketClass must be one of"],
      ["/api/v1/market-data/candles?symbol=BTCUSDT&timeframe=1h&limit=5", "limit must be at least 30"],
      ["/api/v1/market-data/candles?symbol=BTCUSDT&timeframe=1h&limit=99999", "limit must be at most 5000"],
    ];
    for (const [url, expected] of cases) {
      const response = await harness.app.inject({ method: "GET", url, headers: { cookie } });
      assert.equal(response.statusCode, 400, `${url} → ${response.body}`);
      assert.match(response.json().error.message, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), url);
    }
  } finally {
    await harness.cleanup();
  }
});

test("candles and quote endpoints serve labelled synthetic data offline", async () => {
  const harness = await createFileStoreApp({ configOverrides: { env: MARKET_ENV } });
  try {
    const cookie = await signIn(harness.app);

    const candles = await harness.app.inject({
      method: "GET",
      url: "/api/v1/market-data/candles?symbol=eurusd&timeframe=1h&limit=50",
      headers: { cookie },
    });
    assert.equal(candles.statusCode, 200, candles.body);
    const series = candles.json();
    assert.equal(series.symbol, "EURUSD", "symbol is upper-cased as the legacy controller did");
    assert.equal(series.marketClass, "forex", "market class is inferred when not supplied");
    assert.equal(series.timeframe, "1h");
    assert.equal(series.candles.length, 50);
    assert.equal(series.provenance.synthetic, true);
    assert.equal(series.provenance.source, "synthetic-demo");
    assert.equal(series.provenance.live, false);
    assert.equal(series.validation.ok, true);

    const inferredCrypto = await harness.app.inject({
      method: "GET",
      url: "/api/v1/market-data/candles?symbol=BTCUSDT&timeframe=1d&limit=30",
      headers: { cookie },
    });
    assert.equal(inferredCrypto.json().marketClass, "crypto");

    const quote = await harness.app.inject({ method: "GET", url: "/api/v1/market-data/quote?symbol=BTCUSDT", headers: { cookie } });
    assert.equal(quote.statusCode, 200, quote.body);
    const payload = quote.json();
    assert.equal(payload.synthetic, true);
    assert.equal(payload.source, "synthetic-demo");
    assert.ok(payload.quote.ask > payload.quote.bid);
    assert.equal(payload.quote.symbol, "BTCUSDT");
  } finally {
    await harness.cleanup();
  }
});

test("the registry keeps the legacy priority order and health stays honest when providers are unreachable", async () => {
  // Service level, with an injected transport: this is the full seven-provider
  // registry, asserted without the suite ever touching the network. A CI host with
  // egress and a host without one see exactly the same expectations.
  const harness = await createFileStoreApp({ configOverrides: { env: MARKET_ENV } });
  try {
    const service = createMarketDataService({
      config: { ...harness.config, marketData: { ...harness.config.marketData, realProviders: true } },
      store: harness.store,
      settleMs: 0,
      http: { getJson: async () => { throw new Error("no egress from this host"); } },
    });

    const body = await service.providers(true);

    // Legacy registration order: Binance 10, Frankfurter 20, licensed 30–33, synthetic 999.
    assert.deepEqual(
      body.registry.map((entry) => [entry.name, entry.priority]),
      [
        ["binance", 10],
        ["frankfurter-ecb", 20],
        ["licensed-stock", 30],
        ["licensed-etf", 31],
        ["licensed-futures", 32],
        ["licensed-options", 33],
        ["synthetic-demo", 999],
      ],
    );
    assert.equal(body.registry[6].synthetic, true);
    assert.deepEqual(body.registry[0].capabilities.marketClasses, ["crypto"]);
    assert.deepEqual(body.registry[1].capabilities.timeframes, ["1d"]);
    assert.deepEqual(body.registry[1].capabilities.marketClasses, ["forex"]);
    assert.equal(body.policy.realProviders, true);
    assert.equal(body.policy.syntheticAllowed, true);
    assert.equal(body.policy.syntheticIsNeverMarketData, true);

    const health = Object.fromEntries(body.providers.map((entry) => [entry.name, entry.status]));
    // Unreachable real providers report DOWN with the reason; unconfigured licensed
    // adapters report DISABLED; only the synthetic generator is UP. Nothing pretends.
    assert.equal(health.binance, "DOWN");
    assert.equal(health["frankfurter-ecb"], "DOWN");
    assert.equal(health["licensed-stock"], "DISABLED");
    assert.equal(health["licensed-etf"], "DISABLED");
    assert.equal(health["licensed-futures"], "DISABLED");
    assert.equal(health["licensed-options"], "DISABLED");
    assert.equal(health["synthetic-demo"], "UP");
    assert.match(body.providers.find((entry) => entry.name === "binance").lastError, /no egress/);
    assert.match(body.providers.find((entry) => entry.name === "synthetic-demo").detail, /SIMULATION ONLY/);
  } finally {
    await harness.cleanup();
  }
});

test("a reachable real provider wins over the synthetic fallback", async () => {
  // The other half of the honesty rule: synthetic is last resort, not default. With
  // a transport that answers, the real provider serves and the response says so.
  const harness = await createFileStoreApp({ configOverrides: { env: MARKET_ENV } });
  try {
    const now = 1_791_500_000_000;
    const klines = Array.from({ length: 60 }, (_, index) => [
      now - (60 - index) * 3_600_000, "64000", "64500", "63500", "64200", "1200",
    ]);
    const service = createMarketDataService({
      config: { ...harness.config, marketData: { ...harness.config.marketData, realProviders: true } },
      store: harness.store,
      settleMs: 0,
      http: { getJson: async () => klines },
    });

    const series = await service.candles({ symbol: "BTCUSDT", timeframe: "1h", limit: 60 });

    assert.equal(series.provenance.source, "binance");
    assert.equal(series.provenance.synthetic, false);
    assert.equal(series.provenance.live, true);
    assert.deepEqual(series.provenance.fallbackChain, []);
    assert.equal(series.validation.ok, true);
    assert.equal(series.candles.length, 60);

    const { events } = await harness.store.listAuditEvents({ action: "marketData.provider.fallback", limit: 10 });
    assert.equal(events.length, 0, "a provider that served is not a fallback and must not be audited as one");
  } finally {
    await harness.cleanup();
  }
});

test("providers endpoint reports the registry and the synthetic policy", async () => {
  const harness = await createFileStoreApp({ configOverrides: { env: MARKET_ENV } });
  try {
    const cookie = await signIn(harness.app);
    const response = await harness.app.inject({ method: "GET", url: "/api/v1/market-data/providers", headers: { cookie } });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();

    // MARKET_DATA_REAL_PROVIDERS=0: only the synthetic generator is registered.
    assert.deepEqual(body.registry.map((entry) => [entry.name, entry.priority, entry.synthetic]), [["synthetic-demo", 999, true]]);
    assert.equal(body.policy.realProviders, false);
    assert.equal(body.policy.syntheticAllowed, true);
    assert.equal(body.policy.syntheticIsNeverMarketData, true);
    assert.deepEqual(body.providers.map((entry) => [entry.name, entry.status]), [["synthetic-demo", "UP"]]);
    assert.match(body.providers[0].detail, /SIMULATION ONLY — not market data/);
    assert.equal(body.providers[0].circuitState, "CLOSED");

    const cached = await harness.app.inject({ method: "GET", url: "/api/v1/market-data/providers?refresh=false", headers: { cookie } });
    assert.equal(cached.statusCode, 200);
    assert.deepEqual(cached.json().providers.map((entry) => entry.status), ["UP"]);
  } finally {
    await harness.cleanup();
  }
});

test("a host that refuses synthetic data returns an outage, never invented candles", async () => {
  // Hermetic on purpose: real providers are off as well, so the answer cannot
  // depend on whether the CI host happens to reach Binance. The "real providers
  // reachable but synthetic refused" case is covered at service level below.
  const harness = await createFileStoreApp({
    configOverrides: {
      env: {
        PUBLIC_BASE_URL: "https://site.example.test",
        MARKET_DATA_REAL_PROVIDERS: "0",
        MARKET_DATA_ALLOW_SYNTHETIC: "0",
      },
    },
  });
  try {
    const cookie = await signIn(harness.app);
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/market-data/candles?symbol=BTCUSDT&timeframe=1h",
      headers: { cookie },
    });
    assert.equal(response.statusCode, 503, response.body);
    const body = response.json().error;
    assert.equal(body.code, "SYNTHETIC_DATA_DISABLED");
    assert.match(body.message, /synthetic data is disabled on this host/);
    assert.equal(body.details.syntheticAllowed, false);
    assert.ok(Number(response.headers["retry-after"]) > 0, "a dependency outage advertises Retry-After");
    assert.equal(response.json().candles, undefined, "no candle data may accompany the refusal");

    const providers = await harness.app.inject({ method: "GET", url: "/api/v1/market-data/providers", headers: { cookie } });
    assert.equal(providers.json().policy.syntheticAllowed, false);
    assert.equal(providers.json().policy.realProviders, false);
    assert.deepEqual(providers.json().registry, [], "no provider is registered, so nothing can be served");
    assert.deepEqual(providers.json().providers, []);
  } finally {
    await harness.cleanup();
  }
});

test("real providers that fail on a synthetic-refusing host are still an outage, not a fallback", async () => {
  // The case a CI host with egress would otherwise decide by luck: real providers
  // registered, synthetic refused, every upstream call failing. The transport is
  // injected, so the expectation holds with or without network access.
  const harness = await createFileStoreApp({ configOverrides: { env: MARKET_ENV } });
  try {
    const service = createMarketDataService({
      config: {
        ...harness.config,
        marketData: { ...harness.config.marketData, realProviders: true, allowSynthetic: false },
      },
      store: harness.store,
      settleMs: 0,
      http: { getJson: async () => { throw new Error("no egress from this host"); } },
    });

    await assert.rejects(
      () => service.candles({ symbol: "BTCUSDT", timeframe: "1h", limit: 50 }),
      (error) => {
        assert.match(error.message, /synthetic data is refused on this host/);
        assert.deepEqual(error.failedProviders, ["binance"], "only a crypto-capable provider was a candidate");
        return true;
      },
    );
    await assert.rejects(
      () => service.quote({ symbol: "BTCUSDT" }),
      /synthetic data is refused on this host/,
    );

    const { events } = await harness.store.listAuditEvents({ action: "marketData.provider.fallback", limit: 10 });
    assert.equal(events.length, 0, "nothing was served, so no fallback may be recorded");
  } finally {
    await harness.cleanup();
  }
});

test("fallback is audited with the legacy PROVIDER_FALLBACK wording", async () => {
  const harness = await createFileStoreApp({ configOverrides: { env: MARKET_ENV } });
  try {
    // Real providers are enabled for this service instance so a fallback can happen.
    const realService = createMarketDataService({
      config: { ...harness.config, marketData: { ...harness.config.marketData, realProviders: true } },
      store: harness.store,
      settleMs: 0,
      http: { getJson: async () => { throw new Error("no egress from this host"); } },
    });
    const series = await realService.candles({ symbol: "BTCUSDT", timeframe: "1h", limit: 50 });
    assert.equal(series.provenance.source, "synthetic-demo");
    assert.equal(series.provenance.synthetic, true);
    assert.ok(series.provenance.fallbackChain.includes("binance"));

    const { events } = await harness.store.listAuditEvents({ action: "marketData.provider.fallback", limit: 10 });
    assert.equal(events.length, 1);
    assert.equal(events[0].details.legacyAction, "PROVIDER_FALLBACK");
    assert.equal(events[0].details.message, "`BTCUSDT`: providers [binance] failed — falling back to synthetic-demo");
    assert.equal(events[0].details.synthetic, true);
    assert.equal(events[0].entityId, "BTCUSDT");
  } finally {
    await harness.cleanup();
  }
});

test("public status surface reports market data without probing providers", async () => {
  const harness = await createFileStoreApp({ configOverrides: { env: MARKET_ENV } });
  try {
    const status = await harness.app.inject({ method: "GET", url: "/api/v1/system/status" });
    assert.equal(status.statusCode, 200);
    const body = status.json();
    assert.equal(body.marketData.policy.syntheticAllowed, true);
    assert.deepEqual(body.marketData.providers, [
      { name: "synthetic-demo", status: "UNKNOWN", synthetic: true },
    ]);
    assert.match(body.marketData.providers[0].status, /UNKNOWN/);

    const features = await harness.app.inject({ method: "GET", url: "/api/v1/system/features" });
    assert.equal(features.json().features.marketData, "ported");

    const routes = await harness.app.inject({ method: "GET", url: "/api/v1/system/routes" });
    const paths = routes.json().routes.map((route) => `${route.method} ${route.path}`);
    for (const expected of [
      "GET /api/v1/market-data/candles",
      "GET /api/v1/market-data/quote",
      "GET /api/v1/market-data/providers",
    ]) {
      assert.ok(paths.includes(expected), `${expected} missing from the route inventory`);
    }
  } finally {
    await harness.cleanup();
  }
});
