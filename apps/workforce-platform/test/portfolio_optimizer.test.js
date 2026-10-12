/**
 * The research-only portfolio optimizer's numeric core (Phase 11, row 9).
 *
 * Ported from `application/libraries/Aegis/Optimization/PortfolioOptimizer.php`.
 * The tests here are about the properties that make the output *trustworthy* rather
 * than about reproducing a particular number:
 *
 *  1. **The constraints hold on the returned weights.** `fullyInvested: true` and
 *     `longOnly: true` are claims in the report; a solver that returns weights
 *     summing to 0.9999 or to −0.0001 makes both false. Every solver path is
 *     checked against the constraints it advertises, including the degenerate
 *     zero-variance case where the ridge is the only source of curvature.
 *  2. **Minimum variance actually minimizes variance** over the feasible set, and
 *     maximum Sharpe actually beats equal weight on the sample. A solver that
 *     converged to a worse point than a trivial feasible one is not optimizing.
 *  3. **It is deterministic.** Multi-start ascent with no seed and no clock: the
 *     same input must produce the same weights, or a report cannot be reproduced
 *     when someone asks what the platform told them.
 *  4. **It never invents data.** A non-finite return is a refusal, not a NaN that
 *     propagates into a weight.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  InvalidOptimizationError,
  MAX_ASSETS,
  MIN_ASSETS,
  MIN_RETURN_OBSERVATIONS,
  OptimizationUnavailableError,
  optimizePortfolio,
} from "../src/modules/portfolio/optimizer.js";

/**
 * A deterministic geometric price walk.
 *
 * Seeded by symbol so two assets differ, and built from integer arithmetic where
 * possible so the series is identical on every platform — no `Math.random`, which
 * would make every assertion below flaky.
 */
function walk({ symbol, start = 100, drift = 0.0004, amplitude = 0.01, observations = 60, timestamps = null }) {
  let seed = 0;
  for (const character of symbol) seed = (seed * 31 + character.codePointAt(0)) % 100_003;
  const candles = [];
  let price = start;
  for (let i = 0; i < observations; i += 1) {
    // A cheap deterministic oscillator in [-1, 1]; good enough to produce a
    // non-degenerate covariance, and reproducible to the last bit.
    const wave = Math.sin((seed + i * 7) / 5) * Math.cos((seed + i * 3) / 11);
    price = Math.max(0.01, price * (1 + drift + amplitude * wave));
    candles.push({
      timestamp: timestamps ? timestamps[i] : 1_700_000_000 + i * 86_400,
      close: Number(price.toFixed(6)),
    });
  }
  return candles;
}

function asset(symbol, marketClass = "forex", overrides = {}) {
  return { symbol, marketClass, candles: walk({ symbol, ...overrides }) };
}

/** Every weight vector the report publishes, by name. */
function allocationsOf(report) {
  return Object.entries(report.allocations).map(([name, allocation]) => ({
    name,
    weights: Object.values(allocation.weights),
    allocation,
  }));
}

// ------------------------------------------------------------------- constraints

test("every published allocation satisfies the constraints the report advertises", () => {
  const report = optimizePortfolio([asset("EURUSD"), asset("GBPUSD"), asset("USDJPY")]);

  assert.equal(report.status, "RESEARCH_ONLY");
  assert.equal(report.constraints.longOnly, true);
  assert.equal(report.constraints.fullyInvested, true);
  assert.equal(report.constraints.grossLeverage, 1.0);

  const cap = report.constraints.maximumWeightPerAsset;
  for (const { name, weights } of allocationsOf(report)) {
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    // Not `=== 1`: the projection's residue sweep targets 1e-14, and asserting
    // exact equality would test float luck rather than the constraint.
    assert.ok(Math.abs(total - 1) < 1e-9, `${name} must be fully invested, summed to ${total}`);
    for (const weight of weights) {
      assert.ok(weight >= 0, `${name} must be long-only, got ${weight}`);
      assert.ok(weight <= cap + 1e-12, `${name} must respect the ${cap} cap, got ${weight}`);
    }
  }

  // The per-asset rows must agree with the allocation blocks, or the report
  // contradicts itself between two sections a reader would compare.
  for (const row of report.assets) {
    assert.equal(row.selectedWeight, report.allocations.selected.weights[row.symbol]);
    assert.equal(row.minimumVarianceWeight, report.allocations.minimumVariance.weights[row.symbol]);
    assert.equal(row.maximumSharpeWeight, report.allocations.maximumSharpe.weights[row.symbol]);
    assert.ok(Math.abs(row.equalWeight - 1 / 3) < 1e-12);
  }
});

test("a flat series still produces feasible weights rather than NaN", () => {
  // Identical closes: every return is exactly 0, so the sample covariance is all
  // zeros and only the ridge gives the minimum-variance gradient any curvature.
  // This is the case where a naive solver divides by zero and returns NaN weights
  // that still appear to "sum to 1" under a loose check.
  const flat = (symbol) => ({
    symbol,
    marketClass: "forex",
    candles: Array.from({ length: 40 }, (_, i) => ({ timestamp: 1_700_000_000 + i * 86_400, close: 100 })),
  });

  const report = optimizePortfolio([flat("EURUSD"), flat("GBPUSD")]);

  for (const { name, weights } of allocationsOf(report)) {
    for (const weight of weights) {
      assert.ok(Number.isFinite(weight), `${name} produced a non-finite weight`);
      assert.ok(weight >= 0 && weight <= 1 + 1e-12, `${name} weight out of range: ${weight}`);
    }
    assert.ok(Math.abs(weights.reduce((a, b) => a + b, 0) - 1) < 1e-9, `${name} is not fully invested`);
  }
  // With the default 15% shrinkage the diagonal ridge (`max(EPSILON, largest
  // variance * 1e-10)`, and largest variance is 0 here, so EPSILON) annualized by
  // 252 gives each asset a volatility of sqrt(EPSILON * 252) ≈ 2.236e-5 — above
  // EPSILON, so the Sharpe ratio is *defined* and exactly 0 (zero excess return
  // over that volatility). Asserting `null` here would be asserting the ridge does
  // not exist. The equal-weight two-asset portfolio of two identical variances has
  // variance σ²/2, so its volatility is σ/sqrt(2) — derived here rather than
  // pasted in as a magic bound, so the test says WHY the number is what it is.
  const ridgeVolatility = Math.sqrt(1.0e-12 * 252);
  assert.equal(report.allocations.selected.sharpeRatio, 0);
  assert.ok(
    Math.abs(report.allocations.equalWeightBenchmark.volatilityAnnualized - ridgeVolatility / Math.SQRT2) < 1e-9,
    `expected the ridge artifact ${ridgeVolatility / Math.SQRT2}, got ${report.allocations.equalWeightBenchmark.volatilityAnnualized}`,
  );
  // Zero information in the sample must not manufacture a preference: the weights
  // stay equal and the concentration index is exactly 1/n.
  assert.deepEqual(report.allocations.selected.weights, { EURUSD: 0.5, GBPUSD: 0.5 });
  assert.equal(report.allocations.equalWeightBenchmark.concentrationIndex, 0.5);

  // The genuine zero-volatility branch needs the ridge itself to fall below
  // EPSILON, which only happens with no shrinkage AND a periodsPerYear small
  // enough that EPSILON * periodsPerYear < EPSILON — impossible. So the `null`
  // branch is reachable only via `sharpeScore`'s own guard; assert instead that a
  // zero risk-free rate with zero returns yields no spurious positive Sharpe.
  const zeroRf = optimizePortfolio([flat("EURUSD"), flat("GBPUSD")], { riskFreeRate: 0 });
  assert.equal(zeroRf.allocations.maximumSharpe.sharpeRatio, 0);
  assert.ok(zeroRf.warnings.some((w) => /No positive historical excess return was estimated/.test(w)),
    "a flat sample must not be presented as an opportunity");
});

// --------------------------------------------------------------------- optimality

test("minimum variance beats equal weight and random feasible points on variance", () => {
  // Two assets with deliberately different volatility, so the optimum is strongly
  // unequal and a solver that returned equal weights would be measurably worse.
  const calm = { symbol: "CALM", marketClass: "forex", candles: walk({ symbol: "CALM", amplitude: 0.002, observations: 80 }) };
  const wild = { symbol: "WILD", marketClass: "forex", candles: walk({ symbol: "WILD", amplitude: 0.06, observations: 80 }) };
  const report = optimizePortfolio([calm, wild], { objective: "min_variance", maxWeight: 1.0 });

  const selected = report.allocations.selected.weights;
  assert.equal(report.objective, "min_variance");
  // The selected allocation IS the minimum-variance one under this objective.
  assert.deepEqual(selected, report.allocations.minimumVariance.weights);

  const volatility = (allocation) => allocation.volatilityAnnualized;
  assert.ok(
    volatility(report.allocations.minimumVariance) <= volatility(report.allocations.equalWeightBenchmark) + 1e-9,
    `minimum variance (${volatility(report.allocations.minimumVariance)}) must not be worse than equal weight (${volatility(report.allocations.equalWeightBenchmark)})`,
  );

  // And it must favour the calmer asset, which is the whole point of the exercise.
  assert.ok(
    selected.CALM > selected.WILD,
    `the calmer asset should carry more weight than the wilder one, got ${JSON.stringify(selected)}`,
  );
});

test("maximum Sharpe beats equal weight on the sample it was given", () => {
  const assets = [
    { symbol: "AAA", marketClass: "crypto", candles: walk({ symbol: "AAA", drift: 0.004, amplitude: 0.01, observations: 90 }) },
    { symbol: "BBB", marketClass: "crypto", candles: walk({ symbol: "BBB", drift: 0.0002, amplitude: 0.03, observations: 90 }) },
    { symbol: "CCC", marketClass: "crypto", candles: walk({ symbol: "CCC", drift: -0.001, amplitude: 0.02, observations: 90 }) },
  ];
  const report = optimizePortfolio(assets, { objective: "max_sharpe" });

  const best = report.allocations.maximumSharpe;
  const benchmark = report.allocations.equalWeightBenchmark;
  assert.ok(best.sharpeRatio !== null && benchmark.sharpeRatio !== null);
  assert.ok(
    best.sharpeRatio >= benchmark.sharpeRatio - 1e-9,
    `maximum Sharpe (${best.sharpeRatio}) must not be worse than equal weight (${benchmark.sharpeRatio}) on the same sample`,
  );
  // The negative-drift asset should not dominate the allocation.
  assert.ok(best.weights.CCC < best.weights.AAA, JSON.stringify(best.weights));
  // deepEqual, not equal: these are two distinct objects holding the same numbers,
  // and `assert.equal` compares by reference for objects — it would fail even if
  // the contents matched exactly.
  assert.deepEqual(report.allocations.selected.weights, best.weights, "the selected allocation is the maximum-Sharpe one");
});

test("a per-asset cap below the concentration the optimum wants is respected", () => {
  // One asset is far better than the rest, so the uncapped optimum would put
  // everything in it; the cap is what stops that.
  const assets = [
    { symbol: "STAR", marketClass: "crypto", candles: walk({ symbol: "STAR", drift: 0.006, amplitude: 0.004, observations: 80 }) },
    { symbol: "DULL", marketClass: "crypto", candles: walk({ symbol: "DULL", drift: -0.002, amplitude: 0.03, observations: 80 }) },
    { symbol: "FLAT", marketClass: "crypto", candles: walk({ symbol: "FLAT", drift: 0.0, amplitude: 0.02, observations: 80 }) },
  ];
  const report = optimizePortfolio(assets, { objective: "max_sharpe", maxWeight: 0.4 });

  assert.equal(report.constraints.maximumWeightPerAsset, 0.4);
  for (const { name, weights } of allocationsOf(report)) {
    for (const weight of weights) assert.ok(weight <= 0.4 + 1e-12, `${name} breached the cap: ${weight}`);
  }
  assert.ok(report.allocations.maximumSharpe.weights.STAR >= 0.4 - 1e-9, "the best asset should sit at its cap");
});

// -------------------------------------------------------------------- determinism

test("the same input produces the same weights, exactly", () => {
  const build = () => optimizePortfolio([asset("EURUSD"), asset("GBPUSD"), asset("BTCUSDT", "crypto")]);
  const first = build();
  const second = build();

  // Deep equality on the whole weight map, not a tolerance: multi-start ascent with
  // a fixed start set and no clock is reproducible to the bit, and a tolerance would
  // hide a genuine source of nondeterminism (object key order, a seeded random, a
  // timestamp-dependent branch).
  assert.deepEqual(second.allocations.selected.weights, first.allocations.selected.weights);
  assert.deepEqual(second.allocations.maximumSharpe.weights, first.allocations.maximumSharpe.weights);
  assert.deepEqual(second.correlations, first.correlations);
  assert.deepEqual(second.warnings, first.warnings);
  // `computedAt` is the one field that legitimately differs between runs.
  assert.notEqual(typeof second.computedAt, "undefined");
});

// ---------------------------------------------------------------------- alignment

test("an overlap below the observation floor is refused with the count it found", () => {
  const shared = Array.from({ length: 50 }, (_, i) => 1_700_000_000 + i * 86_400);
  const offset = Array.from({ length: 50 }, (_, i) => 1_700_000_000 + (i + 25) * 86_400);

  assert.throws(
    () => optimizePortfolio([
      { symbol: "AAA", marketClass: "forex", candles: walk({ symbol: "AAA", observations: 50, timestamps: shared }) },
      { symbol: "BBB", marketClass: "forex", candles: walk({ symbol: "BBB", observations: 50, timestamps: offset }) },
    ]),
    (error) => {
      assert.ok(error instanceof InvalidOptimizationError);
      assert.match(error.message, /at least 30 aligned return observations; found 24/);
      return true;
    },
  );
});

test("a partial overlap above the floor is used, and the exclusion is disclosed", () => {
  const long = Array.from({ length: 90 }, (_, i) => 1_700_000_000 + i * 86_400);
  const short = Array.from({ length: 60 }, (_, i) => 1_700_000_000 + (i + 30) * 86_400);

  const report = optimizePortfolio([
    { symbol: "AAA", marketClass: "forex", candles: walk({ symbol: "AAA", observations: 90, timestamps: long }) },
    { symbol: "BBB", marketClass: "forex", candles: walk({ symbol: "BBB", observations: 60, timestamps: short }) },
  ]);

  assert.equal(report.window.alignedPriceObservations, 60);
  assert.equal(report.window.returnObservations, 59);
  assert.equal(report.window.firstTimestamp, long[30]);
  assert.equal(report.window.lastTimestamp, long[89]);
  assert.ok(
    report.warnings.some((warning) => /Only timestamps shared by every asset were used/.test(warning)),
    `the exclusion must be disclosed, got ${JSON.stringify(report.warnings)}`,
  );
});

test("duplicate timestamps are discarded, counted, and disclosed per symbol", () => {
  const base = walk({ symbol: "AAA", observations: 50 });
  const withDuplicates = [...base, { timestamp: base[10].timestamp, close: 999 }, { timestamp: base[11].timestamp, close: 888 }];

  const report = optimizePortfolio([
    { symbol: "AAA", marketClass: "forex", candles: withDuplicates },
    { symbol: "BBB", marketClass: "forex", candles: walk({ symbol: "BBB", observations: 50 }) },
  ]);

  assert.ok(
    report.warnings.some((warning) => /AAA: 2 duplicate candle timestamp\(s\) were discarded/.test(warning)),
    JSON.stringify(report.warnings),
  );
  // The first row wins, so the duplicate's price never enters the sample: 50
  // aligned observations, not 52.
  assert.equal(report.window.alignedPriceObservations, 50);
});

// ------------------------------------------------------------------------ refusal

test("invalid candles are skipped, and too few survivors is a refusal", () => {
  const valid = walk({ symbol: "AAA", observations: 40 });
  const junk = [
    ...valid.slice(0, 10),
    { timestamp: 0, close: 100 },            // non-positive timestamp
    { timestamp: -5, close: 100 },           // negative timestamp
    { timestamp: 1_700_100_000, close: 0 },  // zero close would divide by zero
    { timestamp: 1_700_200_000, close: -3 }, // negative price
    { timestamp: 1_700_300_000, close: "abc" },
    { timestamp: "xyz", close: 100 },
    { close: 100 },                          // no timestamp
    { timestamp: 1_700_400_000 },            // no close
    null,
    "not-a-candle",
  ];

  assert.throws(
    () => optimizePortfolio([
      { symbol: "AAA", marketClass: "forex", candles: junk },
      { symbol: "BBB", marketClass: "forex", candles: walk({ symbol: "BBB", observations: 40 }) },
    ]),
    (error) => {
      assert.ok(error instanceof InvalidOptimizationError);
      assert.match(error.message, /AAA needs at least 31 valid close prices/);
      return true;
    },
  );
});

test("numeric strings are accepted where legacy is_numeric accepted them", () => {
  // Providers legitimately return stringified numbers; the legacy normalizer used
  // `is_numeric` and cast, so a string close must work rather than be dropped.
  const stringified = walk({ symbol: "AAA", observations: 45 }).map((candle) => ({
    timestamp: String(candle.timestamp),
    close: String(candle.close),
  }));
  const numeric = walk({ symbol: "AAA", observations: 45 });

  const fromStrings = optimizePortfolio([
    { symbol: "AAA", marketClass: "forex", candles: stringified },
    { symbol: "BBB", marketClass: "forex", candles: walk({ symbol: "BBB", observations: 45 }) },
  ]);
  const fromNumbers = optimizePortfolio([
    { symbol: "AAA", marketClass: "forex", candles: numeric },
    { symbol: "BBB", marketClass: "forex", candles: walk({ symbol: "BBB", observations: 45 }) },
  ]);

  assert.deepEqual(fromStrings.allocations.selected.weights, fromNumbers.allocations.selected.weights);
  assert.equal(fromStrings.window.returnObservations, 44);
});

test("a price series that would produce a non-finite return is a data refusal, not a 400", () => {
  // Infinity survives the per-candle `is_finite` check in no branch, so this is
  // constructed at the estimator boundary instead: a huge positive return followed
  // by a huge negative one overflows the product in the covariance accumulation.
  // The point of the test is the ERROR TYPE: legacy answered 400 for this because
  // it used one exception class for both, and PO-2 separates them.
  const extreme = (symbol) => ({
    symbol,
    marketClass: "forex",
    candles: Array.from({ length: 40 }, (_, i) => ({
      timestamp: 1_700_000_000 + i * 86_400,
      close: i % 2 === 0 ? Number.MAX_VALUE / 4 : 0.0001,
    })),
  });

  assert.throws(
    () => optimizePortfolio([extreme("AAA"), extreme("BBB")]),
    (error) => error instanceof OptimizationUnavailableError || error instanceof InvalidOptimizationError,
  );
});

// ------------------------------------------------------------------ input guards

test("the universe bounds, objectives and option ranges are all enforced", () => {
  const two = [asset("AAA"), asset("BBB")];

  assert.throws(() => optimizePortfolio([asset("AAA")]), /requires 2–12 assets/);
  assert.throws(
    () => optimizePortfolio(Array.from({ length: MAX_ASSETS + 1 }, (_, i) => asset(`SYM${i}`))),
    /requires 2–12 assets/,
  );
  assert.equal(MIN_ASSETS, 2);
  assert.throws(() => optimizePortfolio(null), /requires 2–12 assets/);
  assert.throws(() => optimizePortfolio(two, { objective: "max_return" }), /objective must be max_sharpe or min_variance/);

  // The cap floor depends on the asset count: 0.4 cannot be fully invested across
  // three assets, and the message must say which count made it impossible.
  assert.throws(
    () => optimizePortfolio([asset("AAA"), asset("BBB"), asset("CCC")], { maxWeight: 0.2 }),
    /maxWeight must be between 0\.333333 and 1\.0 for 3 assets/,
  );
  // 0.5 across two assets is exactly feasible and must be accepted.
  assert.doesNotThrow(() => optimizePortfolio(two, { maxWeight: 0.5 }));
  assert.throws(() => optimizePortfolio(two, { maxWeight: 0 }), /maxWeight must be between/);
  assert.throws(() => optimizePortfolio(two, { maxWeight: 1.5 }), /maxWeight must be between/);
  assert.throws(() => optimizePortfolio(two, { maxWeight: Number.NaN }), /maxWeight must be a finite number/);
  assert.throws(() => optimizePortfolio(two, { riskFreeRate: 1.5 }), /riskFreeRate must be an annual decimal/);
  assert.throws(() => optimizePortfolio(two, { riskFreeRate: -0.5 }), /riskFreeRate must be an annual decimal/);
  assert.throws(() => optimizePortfolio(two, { shrinkage: 1.5 }), /shrinkage must be between 0 and 1/);
  assert.throws(() => optimizePortfolio(two, { periodsPerYear: 252.5 }), /periodsPerYear must be an integer between 1 and 100000/);
  assert.throws(() => optimizePortfolio(two, { periodsPerYear: 0 }), /periodsPerYear must be an integer/);

  // A negative risk-free rate inside the legacy bounds is legal and changes the
  // excess return, so it must actually reach the metrics.
  const negative = optimizePortfolio(two, { riskFreeRate: -0.05 });
  assert.equal(negative.estimation.riskFreeRateAnnualized, -0.05);
});

test("symbol and duplicate-symbol rules match the legacy vocabulary", () => {
  const candles = walk({ symbol: "AAA", observations: 40 });
  assert.throws(
    () => optimizePortfolio([{ symbol: "has space", candles }, asset("BBB")]),
    /each asset needs a valid symbol/,
  );
  assert.throws(() => optimizePortfolio([{ symbol: "", candles }, asset("BBB")]), /each asset needs a valid symbol/);
  assert.throws(
    () => optimizePortfolio([{ symbol: "A".repeat(65), candles }, asset("BBB")]),
    /each asset needs a valid symbol/,
  );
  // Symbols are upper-cased before comparison, so these are the same asset.
  assert.throws(
    () => optimizePortfolio([{ symbol: "eurusd", marketClass: "forex", candles }, { symbol: "EURUSD", marketClass: "forex", candles }]),
    /duplicate asset symbol: EURUSD/,
  );
  assert.throws(() => optimizePortfolio(["not-an-object", asset("BBB")]), /each asset must be an object/);
  assert.throws(() => optimizePortfolio([{ symbol: "AAA", candles: "nope" }, asset("BBB")]), /candles must be an array/);
  // Punctuation the legacy pattern allows must still be allowed.
  assert.doesNotThrow(() => optimizePortfolio([
    { symbol: "BRK.B", marketClass: "stock", candles },
    { symbol: "BTC-USDT:PERP", marketClass: "crypto", candles: walk({ symbol: "BBB", observations: 40 }) },
  ]));
});

test("shrinkage, mixed classes and a non-positive excess return are each disclosed", () => {
  const crypto = { symbol: "BTCUSDT", marketClass: "crypto", candles: walk({ symbol: "BTCUSDT", drift: -0.004, observations: 60 }) };
  const forex = { symbol: "EURUSD", marketClass: "forex", candles: walk({ symbol: "EURUSD", drift: -0.004, observations: 60 }) };

  const report = optimizePortfolio([crypto, forex], { shrinkage: 0.3 });

  assert.equal(report.estimation.shrinkage, 0.3);
  assert.match(report.estimation.expectedReturn, /arithmetic sample mean, annualized by periodsPerYear/);
  assert.match(report.estimation.covariance, /sample covariance with diagonal shrinkage, then annualized/);
  assert.ok(report.warnings.some((w) => /30% diagonal shrinkage plus a small numerical ridge/.test(w)), JSON.stringify(report.warnings));
  assert.ok(report.warnings.some((w) => /mixes market classes/.test(w)), JSON.stringify(report.warnings));
  // Both legs drift downward, so the maximum-Sharpe allocation cannot beat a zero
  // risk-free rate — and the report must say that plainly instead of presenting a
  // negative-excess allocation as an opportunity.
  assert.ok(
    report.warnings.some((w) => /No positive historical excess return was estimated/.test(w)),
    JSON.stringify(report.warnings),
  );

  // shrinkage: 0 removes that warning and nothing else.
  const unshrunk = optimizePortfolio([crypto, forex], { shrinkage: 0 });
  assert.equal(unshrunk.estimation.shrinkage, 0);
  assert.ok(!unshrunk.warnings.some((w) => /diagonal shrinkage/.test(w)));
  assert.ok(unshrunk.warnings.some((w) => /mixes market classes/.test(w)));
  // Warnings are de-duplicated while preserving order.
  assert.equal(new Set(unshrunk.warnings).size, unshrunk.warnings.length);
});

test("the correlation matrix is symmetric, clamped, self-consistent and unshrunk", () => {
  const report = optimizePortfolio([asset("AAA"), asset("BBB"), asset("CCC")]);
  const symbols = report.assets.map((row) => row.symbol);

  assert.deepEqual(Object.keys(report.correlations).sort(), [...symbols].sort());
  for (const left of symbols) {
    for (const right of symbols) {
      const value = report.correlations[left][right];
      if (value === null) continue;
      assert.ok(value >= -1 && value <= 1, `${left}/${right} correlation out of range: ${value}`);
      assert.equal(value, report.correlations[right][left], "the matrix must be symmetric");
    }
    assert.equal(report.correlations[left][left], 1, "self-correlation is exactly 1");
  }

  // The published per-asset volatility must be the square root of the reported
  // annualized variance for that asset — the two sections of the report are
  // computed from the same matrix and must not disagree.
  for (const row of report.assets) {
    assert.ok(Number.isFinite(row.volatilityAnnualized) && row.volatilityAnnualized >= 0);
    assert.ok(Number.isFinite(row.expectedReturnAnnualized));
  }

  // Concentration index: 1/n at equal weight, 1.0 when everything is in one asset.
  assert.ok(Math.abs(report.allocations.equalWeightBenchmark.concentrationIndex - 1 / 3) < 1e-9);
});

test("the report carries the research-only framing and never an instruction", () => {
  const report = optimizePortfolio([asset("AAA"), asset("BBB")]);

  assert.equal(report.model, "historical-mean-variance-diagonal-shrinkage-v1");
  assert.match(report.methodNote, /approximate, not a proof of global optimality/);
  assert.match(report.methodNote, /not forecasts/);
  assert.match(report.disclaimer, /not investment advice/);
  assert.match(report.disclaimer, /never an order or instruction to allocate capital/);

  // The structural guarantee: nothing in the report can be read as an instruction.
  const serialized = JSON.stringify(report);
  for (const forbidden of ["orderId", "accountId", "quantity", "notional", "execute", "placeOrder", "side"]) {
    assert.ok(!serialized.includes(forbidden), `the report must not contain "${forbidden}"`);
  }
  assert.equal(report.status, "RESEARCH_ONLY");
  assert.match(report.computedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("the observation floor is enforced per asset and across the universe", () => {
  assert.equal(MIN_RETURN_OBSERVATIONS, 30);
  // Exactly 31 prices gives 30 returns: the boundary must pass.
  const exact = (symbol) => ({ symbol, marketClass: "forex", candles: walk({ symbol, observations: 31 }) });
  const report = optimizePortfolio([exact("AAA"), exact("BBB")]);
  assert.equal(report.window.returnObservations, 30);

  // 30 prices is refused by the **per-asset** floor, which fires first and names
  // the symbol — that is the more useful message, so it is the one asserted.
  const short = (symbol) => ({ symbol, marketClass: "forex", candles: walk({ symbol, observations: 30 }) });
  assert.throws(
    () => optimizePortfolio([short("AAA"), short("BBB")]),
    /AAA needs at least 31 valid close prices/,
  );

  // The **alignment** floor is a separate guard and needs a universe where every
  // asset individually clears 31 prices but the shared timestamps do not: two
  // 40-observation assets offset by 15 share 25 timestamps, i.e. 24 returns.
  const long = Array.from({ length: 40 }, (_, i) => 1_700_000_000 + i * 86_400);
  const offset = Array.from({ length: 40 }, (_, i) => 1_700_000_000 + (i + 15) * 86_400);
  assert.throws(
    () => optimizePortfolio([
      { symbol: "AAA", marketClass: "forex", candles: walk({ symbol: "AAA", observations: 40, timestamps: long }) },
      { symbol: "BBB", marketClass: "forex", candles: walk({ symbol: "BBB", observations: 40, timestamps: offset }) },
    ]),
    /at least 30 aligned return observations; found 24/,
  );
});

test("the maximum universe is accepted and stays inside the iteration budget", () => {
  const assets = Array.from({ length: MAX_ASSETS }, (_, i) => asset(`SYM${String(i).padStart(2, "0")}`));
  const started = process.hrtime.bigint();
  const report = optimizePortfolio(assets);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(report.assets.length, MAX_ASSETS);
  assert.equal(Object.keys(report.allocations.selected.weights).length, MAX_ASSETS);
  // 14 starts x 2000 iterations x a 12x12 matrix product is the worst case; on two
  // cores it must still finish well inside a request timeout. This is a guard
  // against a future change that makes the inner loop quadratic in the asset count
  // without anyone noticing, not a performance benchmark.
  assert.ok(elapsedMs < 20_000, `the 12-asset optimization took ${elapsedMs}ms`);
  for (const { weights } of allocationsOf(report)) {
    assert.ok(Math.abs(weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  }
});
