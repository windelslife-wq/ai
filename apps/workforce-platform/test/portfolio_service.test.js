/**
 * The portfolio optimization service (Phase 11, row 9).
 *
 * The numeric core has its own file; this one covers the orchestration ported from
 * `Aegis\Platform::optimizePortfolio()`, and the properties that matter here are
 * about **honesty of provenance**, not arithmetic:
 *
 *  1. A universe that is *entirely* synthetic is refused unless the caller opts in
 *     explicitly, and then says SIMULATION in the report.
 *  2. A universe that *mixes* synthetic and live series is refused outright, with no
 *     flag that can unlock it — a covariance computed across one real and one
 *     generated series describes neither, and no label could make it meaningful.
 *  3. Annualization is inferred only for a single market calendar; a mixed universe
 *     must state `periodsPerYear` itself rather than be handed a number that is
 *     wrong for every asset in it.
 *  4. Provenance is reported per asset and never summarized away.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createPortfolioService } from "../src/modules/portfolio/service.js";
import { InvalidOptimizationError, OptimizationUnavailableError } from "../src/modules/portfolio/optimizer.js";

/**
 * A fake market-data service speaking the real `candles({...})` contract.
 *
 * That is the house seam — the same method the analysis, Strategy Lab and paper
 * modules call — and it returns the manager's `{candles, provenance, validation}`
 * shape. The gates under test read `provenance.synthetic`, so a fake that omitted
 * it would let the service pass while the real chain failed.
 */
function fakeMarketData(specs = {}) {
  const calls = [];
  return {
    calls,
    async candles({ symbol, marketClass, timeframe, limit }, options = {}) {
      calls.push({ symbol, marketClass, timeframe, limit, options });
      const spec = specs[symbol] || {};
      if (spec.error) throw spec.error;
      return {
        symbol,
        marketClass,
        timeframe,
        candles: series(symbol, spec.observations ?? 60),
        provenance: {
          source: spec.source || "fake",
          synthetic: Boolean(spec.synthetic),
          live: !spec.synthetic,
          delayed: false,
          fetchedAt: 1_700_000_999,
          dataTimestamp: spec.dataTimestamp ?? 1_700_000_000 + (spec.observations ?? 60) * 86_400,
          dataAgeMs: 0,
          stale: Boolean(spec.stale),
          staleThresholdMs: 86_400_000,
          fallbackChain: [],
          fromCache: false,
        },
        validation: { gapCount: spec.gapCount ?? 0, droppedCount: 0 },
      };
    },
  };
}

function series(symbol, observations = 60) {
  let seed = 0;
  for (const character of symbol) seed = (seed * 31 + character.codePointAt(0)) % 100_003;
  const candles = [];
  let price = 100;
  for (let i = 0; i < observations; i += 1) {
    const wave = Math.sin((seed + i * 7) / 5) * Math.cos((seed + i * 3) / 11);
    price = Math.max(0.01, price * (1 + 0.0005 + 0.012 * wave));
    candles.push({ timestamp: 1_700_000_000 + i * 86_400, close: Number(price.toFixed(6)) });
  }
  return candles;
}

/** A recording store: the service must audit a run, and must not fail if it cannot. */
function fakeStore({ failAudit = false } = {}) {
  const audits = [];
  return {
    audits,
    async recordAudit(event) {
      if (failAudit) throw new Error("audit store is down");
      audits.push(event);
    },
  };
}

const UNIVERSE = [
  { symbol: "EURUSD", marketClass: "forex" },
  { symbol: "GBPUSD", marketClass: "forex" },
];

// ------------------------------------------------------------- synthetic gates

test("a wholly synthetic universe is refused unless the caller opts in", async () => {
  const marketData = fakeMarketData({ EURUSD: { synthetic: true }, GBPUSD: { synthetic: true } });
  const portfolio = createPortfolioService({ marketData });

  await assert.rejects(
    () => portfolio.optimize({ assets: UNIVERSE }),
    (error) => {
      assert.ok(error instanceof OptimizationUnavailableError, "a data condition, not a bad request");
      assert.match(error.message, /all available history is synthetic/);
      assert.match(error.message, /allowSyntheticData=true/);
      assert.match(error.message, /clearly labeled simulation/);
      return true;
    },
  );

  // The opt-in is a strict boolean: a truthy string must not unlock a simulation,
  // because `allowSyntheticData: "yes"` arriving from a form post is exactly how a
  // gate like this gets bypassed by accident.
  await assert.rejects(() => portfolio.optimize({ assets: UNIVERSE, allowSyntheticData: "true" }), OptimizationUnavailableError);
  await assert.rejects(() => portfolio.optimize({ assets: UNIVERSE, allowSyntheticData: 1 }), OptimizationUnavailableError);

  const report = await portfolio.optimize({ assets: UNIVERSE, allowSyntheticData: true });
  assert.equal(report.status, "RESEARCH_ONLY");
  assert.ok(
    report.warnings.some((warning) => /^SIMULATION: every input series is synthetic/.test(warning)),
    `the opt-in run must still label itself, got ${JSON.stringify(report.warnings)}`,
  );
  assert.equal(report.request.allowSyntheticData, true);
  assert.deepEqual(report.dataProvenance.map((entry) => entry.synthetic), [true, true]);
});

test("a mixed synthetic and live universe is refused with no override", async () => {
  const marketData = fakeMarketData({ EURUSD: { synthetic: true }, GBPUSD: { synthetic: false } });
  const portfolio = createPortfolioService({ marketData });

  for (const allowSyntheticData of [undefined, false, true]) {
    await assert.rejects(
      () => portfolio.optimize({ assets: UNIVERSE, allowSyntheticData }),
      (error) => {
        assert.ok(error instanceof OptimizationUnavailableError);
        assert.match(error.message, /mixed synthetic and live data is not allowed/);
        return true;
      },
      `allowSyntheticData=${allowSyntheticData} must not unlock a mixed universe`,
    );
  }
  // And it must not have been reported as a simulation, which would imply the flag
  // was the reason for refusal.
  assert.equal(marketData.calls.length, 3 * UNIVERSE.length, "both assets are fetched before the gate decides");
});

test("a live universe carries no simulation warning and reports live provenance", async () => {
  const marketData = fakeMarketData({
    EURUSD: { source: "provider-a" },
    GBPUSD: { source: "provider-b" },
  });
  const portfolio = createPortfolioService({ marketData });
  const report = await portfolio.optimize({ assets: UNIVERSE });

  assert.ok(!report.warnings.some((warning) => /SIMULATION/.test(warning)));
  assert.deepEqual(report.dataProvenance.map((entry) => entry.synthetic), [false, false]);
  assert.deepEqual(report.dataProvenance.map((entry) => entry.source), ["provider-a", "provider-b"]);
  assert.equal(report.request.allowSyntheticData, false);
  // Provenance is per asset and keeps the fields a reviewer needs.
  for (const entry of report.dataProvenance) {
    assert.equal(typeof entry.symbol, "string");
    assert.equal(entry.stale, false);
    assert.equal(typeof entry.fetchedAt, "number");
    assert.equal(typeof entry.dataTimestamp, "number");
    assert.deepEqual(entry.validation, { gapCount: 0, droppedCount: 0 });
  }
});

// -------------------------------------------------------------- data warnings

test("stale series and history gaps are each disclosed by symbol", async () => {
  const marketData = fakeMarketData({
    EURUSD: { stale: true },
    GBPUSD: { gapCount: 3 },
  });
  const portfolio = createPortfolioService({ marketData });
  const report = await portfolio.optimize({ assets: UNIVERSE });

  assert.ok(
    report.warnings.some((warning) => /EURUSD latest candle is marked stale by its market-data provider/.test(warning)),
    JSON.stringify(report.warnings),
  );
  assert.ok(
    report.warnings.some((warning) => /GBPUSD history contains 3 timeframe gap\(s\)/.test(warning)),
    JSON.stringify(report.warnings),
  );
  assert.deepEqual(report.dataProvenance.map((entry) => entry.stale), [true, false]);
  // Warnings stay de-duplicated after the service appends to the optimizer's list.
  assert.equal(new Set(report.warnings).size, report.warnings.length);
});

// ------------------------------------------------------------- annualization

test("annualization is inferred for one calendar and refused for a mixed universe", async () => {
  const portfolio = createPortfolioService({ marketData: fakeMarketData() });

  // Crypto trades every day; forex and listed equities roughly 252 days.
  assert.equal(portfolio.portfolioPeriodsPerYear("1d", ["crypto"]), 365);
  assert.equal(portfolio.portfolioPeriodsPerYear("1h", ["crypto"]), 365 * 24);
  assert.equal(portfolio.portfolioPeriodsPerYear("1d", ["forex"]), 252);
  assert.equal(portfolio.portfolioPeriodsPerYear("15m", ["forex"]), 252 * 96);
  assert.equal(portfolio.portfolioPeriodsPerYear("1d", ["stock"]), 252);
  // An intraday equity bar approximates a 6.5-hour session: 252 * 6.5 / 4 = 409.5.
  assert.equal(portfolio.portfolioPeriodsPerYear("4h", ["stock"]), 410);
  assert.equal(portfolio.portfolioPeriodsPerYear("1h", ["etf"]), 1638);

  assert.throws(
    () => portfolio.portfolioPeriodsPerYear("1d", ["crypto", "forex"]),
    (error) => {
      assert.ok(error instanceof InvalidOptimizationError);
      assert.match(error.message, /periodsPerYear is required when optimizing across different market classes/);
      return true;
    },
  );
});

test("a mixed-class universe works once the caller states periodsPerYear", async () => {
  const marketData = fakeMarketData({
    EURUSD: { source: "fx-feed" },
    BTCUSDT: { source: "crypto-feed" },
  });
  const portfolio = createPortfolioService({ marketData });
  const assets = [
    { symbol: "EURUSD", marketClass: "forex" },
    { symbol: "BTCUSDT", marketClass: "crypto" },
  ];

  await assert.rejects(
    () => portfolio.optimize({ assets }),
    /periodsPerYear is required when optimizing across different market classes/,
  );

  const report = await portfolio.optimize({ assets, periodsPerYear: 365 });
  assert.equal(report.window.periodsPerYear, 365);
  assert.ok(report.warnings.some((warning) => /mixes market classes/.test(warning)));
});

test("an explicit periodsPerYear overrides the inferred calendar", async () => {
  const marketData = fakeMarketData();
  const portfolio = createPortfolioService({ marketData });
  const report = await portfolio.optimize({ assets: UNIVERSE, timeframe: "1d", periodsPerYear: 260 });
  assert.equal(report.window.periodsPerYear, 260, "a venue with its own calendar must be able to state it");
});

// ------------------------------------------------------------------- fetching

test("assets are fetched sequentially, with the requested timeframe and limit", async () => {
  const marketData = fakeMarketData();
  const portfolio = createPortfolioService({ marketData });
  await portfolio.optimize({
    assets: [
      { symbol: "eurusd", marketClass: "Forex" },
      { symbol: "gbpusd", marketClass: "FOREX" },
    ],
    timeframe: "4h",
    limit: 250,
  });

  assert.equal(marketData.calls.length, 2);
  // Symbols and classes are normalized before they reach the provider chain, so a
  // client's casing cannot produce two different cache keys for one instrument.
  assert.deepEqual(marketData.calls.map((call) => call.symbol), ["EURUSD", "GBPUSD"]);
  assert.deepEqual(marketData.calls.map((call) => call.marketClass), ["forex", "forex"]);
  assert.deepEqual(marketData.calls.map((call) => call.timeframe), ["4h", "4h"]);
  assert.deepEqual(marketData.calls.map((call) => call.limit), [250, 250]);
});

test("an unsupported market class is refused with a 400-class error naming the symbol", async () => {
  const marketData = fakeMarketData();
  const portfolio = createPortfolioService({ marketData });

  // The invalid class is second, so the first asset has already been fetched by the
  // time it is reached — legacy validated per asset in encounter order too, and
  // that is preserved rather than restructured into a pre-pass. What matters is
  // that the bad asset is never fetched at all: an unsupported class must not
  // reach the provider chain and come back as an "outage".
  await assert.rejects(
    () => portfolio.optimize({ assets: [{ symbol: "EURUSD", marketClass: "forex" }, { symbol: "AAA", marketClass: "nft" }] }),
    (error) => {
      assert.ok(error instanceof InvalidOptimizationError);
      assert.match(error.message, /invalid marketClass for AAA/);
      return true;
    },
  );
  assert.deepEqual(marketData.calls.map((call) => call.symbol), ["EURUSD"], "the invalid asset is never fetched");

  // And when the invalid class is FIRST, nothing is fetched at all.
  const fresh = fakeMarketData();
  const freshService = createPortfolioService({ marketData: fresh });
  await assert.rejects(
    () => freshService.optimize({ assets: [{ symbol: "AAA", marketClass: "nft" }, { symbol: "EURUSD", marketClass: "forex" }] }),
    /invalid marketClass for AAA/,
  );
  assert.equal(fresh.calls.length, 0);
});

test("a duplicate symbol is refused, and the second asset is never fetched", async () => {
  const marketData = fakeMarketData();
  const portfolio = createPortfolioService({ marketData });

  await assert.rejects(
    () => portfolio.optimize({ assets: [{ symbol: "EURUSD", marketClass: "forex" }, { symbol: "eurusd", marketClass: "forex" }] }),
    /duplicate asset symbol: EURUSD/,
  );
  assert.equal(marketData.calls.length, 1);
});

test("a provider failure is surfaced, not swallowed into a smaller universe", async () => {
  const outage = new Error("No provider could serve candles for GBPUSD 1d. Failed: alpha");
  outage.failedProviders = ["alpha"];
  const marketData = fakeMarketData({ GBPUSD: { error: outage } });
  const portfolio = createPortfolioService({ marketData });

  // The failure must propagate: optimizing the one asset that did load would
  // silently answer a different question than the one asked. It propagates through
  // the shared `marketDataFailure` mapping, so a portfolio run reports a provider
  // outage with the same 503, code and `Retry-After` as a candle request, and the
  // chain's own reason (which names the symbol) travels in `details.reason`.
  await assert.rejects(
    () => portfolio.optimize({ assets: UNIVERSE }),
    (error) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "MARKET_DATA_UNAVAILABLE");
      assert.match(error.details.reason, /No provider could serve candles for GBPUSD/);
      assert.deepEqual(error.details.failedProviders, ["alpha"]);
      return true;
    },
  );
  assert.equal(marketData.calls.length, 2, "the run stops at the failing asset, having fetched both");
});

test("a host refusing synthetic data reports that reason, not a generic outage", async () => {
  const refused = new Error("No provider could serve candles for EURUSD 1d and synthetic data is refused on this host (MARKET_DATA_ALLOW_SYNTHETIC=0).");
  const marketData = fakeMarketData({ EURUSD: { error: refused }, GBPUSD: { error: refused } });
  const portfolio = createPortfolioService({ marketData });

  await assert.rejects(
    () => portfolio.optimize({ assets: UNIVERSE }),
    (error) => {
      assert.equal(error.statusCode, 503);
      // Distinct code: the remedy is a host configuration change, not a retry.
      assert.equal(error.code, "SYNTHETIC_DATA_DISABLED");
      return true;
    },
  );
});

test("no provider chain at all is a 503, not a fabricated report", async () => {
  const portfolio = createPortfolioService({ marketData: null });
  await assert.rejects(
    () => portfolio.optimize({ assets: UNIVERSE }),
    (error) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "PORTFOLIO_DATA_UNAVAILABLE");
      assert.match(error.message, /market-data provider chain/);
      return true;
    },
  );
});

// ---------------------------------------------------------------- input bounds

test("the universe size, timeframe and limit bounds are enforced at the facade", async () => {
  const portfolio = createPortfolioService({ marketData: fakeMarketData() });

  await assert.rejects(() => portfolio.optimize({ assets: [{ symbol: "EURUSD", marketClass: "forex" }] }), /assets must contain 2–12/);
  await assert.rejects(
    () => portfolio.optimize({ assets: Array.from({ length: 13 }, (_, i) => ({ symbol: `SYM${i}`, marketClass: "forex" })) }),
    /assets must contain 2–12/,
  );
  await assert.rejects(() => portfolio.optimize({ assets: UNIVERSE, timeframe: "5m" }), /timeframe must be one of 15m, 1h, 4h or 1d/);
  await assert.rejects(() => portfolio.optimize({ assets: UNIVERSE, limit: 30 }), /limit must be an integer between 31 and 2000/);
  await assert.rejects(() => portfolio.optimize({ assets: UNIVERSE, limit: 2001 }), /limit must be an integer between 31 and 2000/);
  await assert.rejects(() => portfolio.optimize({ assets: ["nope", { symbol: "GBPUSD", marketClass: "forex" }] }), /each asset must be an object/);
});

// ----------------------------------------------------------------------- audit

test("a run is audited with its actor, objective, universe and selected weights", async () => {
  const store = fakeStore();
  const portfolio = createPortfolioService({ store, marketData: fakeMarketData() });
  const report = await portfolio.optimize({ assets: UNIVERSE, objective: "min_variance" }, { actorId: 42 });

  assert.equal(store.audits.length, 1);
  const event = store.audits[0];
  assert.equal(event.actorId, 42);
  assert.equal(event.action, "portfolio.optimization.run");
  assert.equal(event.entityType, "portfolio");
  assert.equal(event.details.legacyAction, "PORTFOLIO_OPTIMIZATION_RUN", "the PHP trail stays correlatable");
  assert.equal(event.details.objective, "min_variance");
  assert.deepEqual(event.details.assets, ["EURUSD", "GBPUSD"]);
  assert.equal(event.details.assetCount, 2);
  assert.equal(event.details.synthetic, false);
  assert.equal(event.details.returnObservations, report.window.returnObservations);
  assert.deepEqual(event.details.selectedWeights, report.allocations.selected.weights);
  assert.match(event.details.summary, /Portfolio optimization \(min_variance, 2 assets, \d+ aligned returns\)/);
});

test("a synthetic run is audited as synthetic", async () => {
  const store = fakeStore();
  const marketData = fakeMarketData({ EURUSD: { synthetic: true }, GBPUSD: { synthetic: true } });
  const portfolio = createPortfolioService({ store, marketData });
  await portfolio.optimize({ assets: UNIVERSE, allowSyntheticData: true }, { actorId: 7 });

  assert.equal(store.audits[0].details.synthetic, true, "a simulation must be distinguishable in the trail");
});

test("an audit failure is logged and never costs the caller a valid report", async () => {
  const warnings = [];
  const store = fakeStore({ failAudit: true });
  const portfolio = createPortfolioService({
    store,
    marketData: fakeMarketData(),
    log: { warn: (fields, message) => warnings.push({ fields, message }) },
  });

  const report = await portfolio.optimize({ assets: UNIVERSE }, { actorId: 1 });
  assert.equal(report.status, "RESEARCH_ONLY", "the optimization is computed and correct; refusing to return it would not make anything safer");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /audit event could not be recorded/);
});

// ------------------------------------------------------- research-only framing

test("the report cannot express an instruction to trade", async () => {
  const portfolio = createPortfolioService({ marketData: fakeMarketData() });
  const report = await portfolio.optimize({ assets: UNIVERSE });

  assert.equal(report.status, "RESEARCH_ONLY");
  assert.match(report.disclaimer, /never an order or instruction to allocate capital/);
  const serialized = JSON.stringify(report);
  for (const forbidden of ["orderId", "accountId", "quantity", "notional", "execute", "placeOrder"]) {
    assert.ok(!serialized.includes(forbidden), `the report must not contain "${forbidden}"`);
  }
  // The request echo records what was asked, and nothing that could be acted on.
  assert.deepEqual(Object.keys(report.request).sort(), ["allowSyntheticData", "assets", "limit", "timeframe"]);
});
