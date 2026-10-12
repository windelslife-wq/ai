/**
 * Research-only long-only portfolio optimizer.
 *
 * Ported from `application/libraries/Aegis/Optimization/PortfolioOptimizer.php`
 * (501 lines, Phase 11). This file is the **pure numeric core**: it takes price
 * observations and returns a report. It knows nothing about HTTP, storage,
 * permissions or providers — the caller is responsible for fetching the data and
 * for labelling its provenance, exactly as in the legacy class.
 *
 * What it estimates: annualized arithmetic returns and a sample covariance from
 * close-to-close observations aligned on the timestamps **every** asset shares,
 * applies diagonal covariance shrinkage plus a numerical ridge, then solves two
 * programs under a fully-invested, long-only, per-asset weight cap:
 *
 *  - minimum variance — a convex QP, solved by projected gradient with a
 *    Lipschitz-derived step size;
 *  - maximum Sharpe — non-convex, solved by deterministic multi-start projected
 *    ascent with backtracking line search. It is **approximate**, and the report
 *    says so rather than implying a proof of global optimality.
 *
 * **It never places or sizes an order.** There is no path from this module to the
 * execution supervisor: the output is a set of weights and a disclaimer.
 *
 * Divergence **PO-1**: the projection onto `{w: sum(w)=1, 0<=w_i<=cap}` uses
 * bisection (90 halvings) followed by a residue sweep, which is the legacy
 * algorithm kept instruction-for-instruction. The sweep runs while
 * `abs(residual) > 0`, i.e. it always executes at least one pass; a float-exact
 * reimplementation would skip it and could land a few ULP away from PHP. Bisection
 * is used in preference to the closed-form median-based water filling because the
 * two are not bit-identical, and a research number that differs from the legacy
 * number in the tenth decimal is a support ticket nobody can diagnose.
 */

/** Smallest universe the estimator will accept; two assets is a ratio, not a portfolio. */
export const MIN_ASSETS = 2;
/** Largest universe. Beyond this the O(n²) covariance and the multi-start cost grow for no research benefit. */
export const MAX_ASSETS = 12;
/** Aligned return observations required before any statistic is trusted. */
export const MIN_RETURN_OBSERVATIONS = 30;
/** Per-asset candle ceiling — bounds the alignment work a single request can demand. */
export const MAX_PRICE_ROWS_PER_ASSET = 2500;
/** Iteration ceiling for both solvers. Deterministic: no clock, no randomness. */
const MAX_ITERATIONS = 2000;
const EPSILON = 1.0e-12;

/** The only two objectives. Anything else is refused rather than defaulted. */
export const OBJECTIVES = Object.freeze(["max_sharpe", "min_variance"]);

/** Symbol vocabulary, identical to the legacy pattern. */
const SYMBOL_PATTERN = /^[A-Z0-9._:-]{1,64}$/;

const METHOD_NOTE =
  "Long-only, fully invested historical mean-variance analysis with a per-asset weight cap. " +
  "Minimum variance uses projected gradient; maximum Sharpe uses deterministic multi-start " +
  "projected ascent and is approximate, not a proof of global optimality. Results are sensitive " +
  "to the selected sample and are not forecasts.";

const DISCLAIMER =
  "Research output only; not investment advice, not a promise of returns, and never an order or " +
  "instruction to allocate capital. Fees, slippage, taxes, liquidity, currency conversion and " +
  "future market changes are not modeled.";

/**
 * Rounding convention (10 decimal places, matching PHP `round($v, 10)`).
 *
 * Reported values are rounded so a client comparing two runs of the same input
 * sees identical output; the *solvers* work at full double precision and are never
 * fed a rounded number, because rounding inside an iteration loop would make the
 * convergence test meaningless.
 */
function rounded(value) {
  if (!Number.isFinite(value)) return value;
  return Number(value.toFixed(10));
}

/** @throws {InvalidOptimizationError} when the value is not a finite number. */
function finiteNumber(value, name) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InvalidOptimizationError(`${name} must be a finite number`);
    return value;
  }
  // The legacy guard was `is_numeric`, which accepts a numeric string. A JSON body
  // carrying `"0.4"` is accepted for the same reason; `""`, `"1e"` and `null` are not.
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  throw new InvalidOptimizationError(`${name} must be a finite number`);
}

/**
 * A refused input. Maps to HTTP 400 at the API boundary — the caller's request was
 * not usable — as distinct from {@link OptimizationUnavailableError}, which maps to
 * 422 because the request was well formed and the *data* was not.
 */
export class InvalidOptimizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidOptimizationError";
  }
}

/**
 * The inputs were valid but the estimation could not be completed: a return series
 * that is not finite, or a covariance that cannot be estimated. Legacy signalled
 * this with `\InvalidArgumentException` from deep inside the estimator and the
 * controller answered 400; keeping it a separate type lets the API answer 422,
 * because "your prices produced a non-finite return" is a data condition the caller
 * cannot fix by editing the request shape. Recorded as divergence **PO-2**.
 */
export class OptimizationUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "OptimizationUnavailableError";
  }
}

/**
 * Run an optimization over caller-supplied price history.
 *
 * @param {Array<{symbol: string, marketClass?: string, candles: Array<{timestamp: number|string, close: number|string}>, provenance?: object}>} assets
 *   2–12 assets. Invalid candles are *skipped* (not refused) exactly as in legacy,
 *   because a provider row with a zero close is a data defect to route around, not
 *   a reason to fail the whole request; skipped duplicates are counted and reported.
 * @param {{objective?: string, maxWeight?: number, riskFreeRate?: number, shrinkage?: number, periodsPerYear?: number, timeframe?: string}} [options]
 * @returns {object} the research report; `status` is always `RESEARCH_ONLY`
 * @throws {InvalidOptimizationError} on any unusable input
 * @throws {OptimizationUnavailableError} when estimation itself fails
 */
export function optimizePortfolio(assets, options = {}) {
  const assetCount = Array.isArray(assets) ? assets.length : 0;
  if (assetCount < MIN_ASSETS || assetCount > MAX_ASSETS) {
    throw new InvalidOptimizationError(`portfolio optimization requires ${MIN_ASSETS}–${MAX_ASSETS} assets`);
  }

  const objective = String(options.objective ?? "max_sharpe").trim().toLowerCase();
  if (!OBJECTIVES.includes(objective)) {
    throw new InvalidOptimizationError("objective must be max_sharpe or min_variance");
  }

  const maxWeight = finiteNumber(options.maxWeight ?? 0.6, "maxWeight");
  // The cap must leave room to be fully invested: with n assets and a cap below
  // 1/n the box constraint and the simplex constraint cannot both hold. EPSILON
  // keeps `maxWeight: 0.5` legal for two assets rather than failing on float dust.
  if (maxWeight <= 0 || maxWeight > 1 || maxWeight + EPSILON < 1 / assetCount) {
    throw new InvalidOptimizationError(
      `maxWeight must be between ${(1 / assetCount).toFixed(6)} and 1.0 for ${assetCount} assets`,
    );
  }

  const riskFreeRate = finiteNumber(options.riskFreeRate ?? 0.0, "riskFreeRate");
  if (riskFreeRate < -0.1 || riskFreeRate > 1.0) {
    throw new InvalidOptimizationError("riskFreeRate must be an annual decimal between -0.10 and 1.00");
  }

  const shrinkage = finiteNumber(options.shrinkage ?? 0.15, "shrinkage");
  if (shrinkage < 0 || shrinkage > 1) {
    throw new InvalidOptimizationError("shrinkage must be between 0 and 1");
  }

  const periodsPerYear = integerOption(options.periodsPerYear ?? 252, "periodsPerYear", 1, 100_000);
  const timeframe = String(options.timeframe ?? "1d").trim().toLowerCase();

  const normalized = normalizeAssets(assets);
  const sharedTimestamps = commonTimestamps(normalized);
  const returnCount = sharedTimestamps.length - 1;
  if (returnCount < MIN_RETURN_OBSERVATIONS) {
    throw new InvalidOptimizationError(
      `portfolio optimization needs at least ${MIN_RETURN_OBSERVATIONS} aligned return observations; found ${Math.max(0, returnCount)}`,
    );
  }

  const returns = alignedReturns(normalized, sharedTimestamps);
  const { means, sampleCovariance } = estimate(returns, assetCount);
  const annualizedMeans = means.map((mean) => mean * periodsPerYear);
  const annualizedCovariance = annualizedShrunkCovariance(sampleCovariance, periodsPerYear, shrinkage);

  // Named `minVarianceWeights`/`maxSharpeWeights` rather than shadowing the two
  // solver functions of the same name: a `const` binding in TDZ makes
  // `f = f(...)` a ReferenceError at runtime, which `node --check` cannot see.
  const minVarianceWeights = minimumVarianceWeights(annualizedCovariance, maxWeight);
  const maxSharpeWeights = maximumSharpeWeights(
    annualizedMeans,
    annualizedCovariance,
    riskFreeRate,
    maxWeight,
    minVarianceWeights,
  );
  const equalWeights = new Array(assetCount).fill(1 / assetCount);

  const minimumVariance = portfolioMetrics(minVarianceWeights, annualizedMeans, annualizedCovariance, riskFreeRate);
  const maximumSharpe = portfolioMetrics(maxSharpeWeights, annualizedMeans, annualizedCovariance, riskFreeRate);
  const equalWeight = portfolioMetrics(equalWeights, annualizedMeans, annualizedCovariance, riskFreeRate);
  const isMinVariance = objective === "min_variance";
  const selectedWeights = isMinVariance ? minVarianceWeights : maxSharpeWeights;
  const selectedMetrics = isMinVariance ? minimumVariance : maximumSharpe;

  const symbols = normalized.map((asset) => asset.symbol);
  // The correlation matrix is reported from the **unshrunk sample** covariance:
  // shrinkage is a regularization device for the solver, and reporting shrunk
  // correlations would understate how correlated the sample actually was.
  const correlations = correlationMatrix(symbols, sampleCovariance);

  const warnings = collectWarnings({
    normalized,
    commonTimestamps: sharedTimestamps,
    shrinkage,
    maximumSharpe,
    riskFreeRate,
  });

  const assetReports = normalized.map((asset, index) => ({
    symbol: asset.symbol,
    marketClass: asset.marketClass,
    expectedReturnAnnualized: rounded(annualizedMeans[index]),
    volatilityAnnualized: rounded(Math.sqrt(Math.max(0.0, annualizedCovariance[index][index]))),
    selectedWeight: selectedWeights[index],
    minimumVarianceWeight: minVarianceWeights[index],
    maximumSharpeWeight: maxSharpeWeights[index],
    equalWeight: equalWeights[index],
    provenance: asset.provenance,
  }));

  return {
    status: "RESEARCH_ONLY",
    model: "historical-mean-variance-diagonal-shrinkage-v1",
    objective,
    computedAt: new Date().toISOString(),
    window: {
      timeframe,
      alignedPriceObservations: sharedTimestamps.length,
      returnObservations: returnCount,
      firstTimestamp: Number(sharedTimestamps[0]),
      lastTimestamp: Number(sharedTimestamps[sharedTimestamps.length - 1]),
      periodsPerYear,
    },
    constraints: {
      longOnly: true,
      fullyInvested: true,
      maximumWeightPerAsset: maxWeight,
      grossLeverage: 1.0,
    },
    estimation: {
      expectedReturn: "arithmetic sample mean, annualized by periodsPerYear",
      covariance: "sample covariance with diagonal shrinkage, then annualized",
      shrinkage,
      riskFreeRateAnnualized: riskFreeRate,
    },
    assets: assetReports,
    correlations,
    allocations: {
      selected: allocationReport(symbols, selectedWeights, selectedMetrics),
      minimumVariance: allocationReport(symbols, minVarianceWeights, minimumVariance),
      maximumSharpe: allocationReport(symbols, maxSharpeWeights, maximumSharpe),
      equalWeightBenchmark: allocationReport(symbols, equalWeights, equalWeight),
    },
    // De-duplicated while preserving first-seen order, matching
    // `array_values(array_unique(...))`.
    warnings: [...new Set(warnings)],
    methodNote: METHOD_NOTE,
    disclaimer: DISCLAIMER,
  };
}

/** Integer option with the legacy `FILTER_VALIDATE_INT` semantics: a float is refused. */
function integerOption(value, name, min, max) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new InvalidOptimizationError(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

/**
 * Validate and normalize each asset into `{symbol, marketClass, prices, provenance, duplicateCount}`.
 * `prices` is a plain object keyed by integer timestamp, which preserves the legacy
 * "first row wins for a duplicate timestamp" rule — `Map` would need the same
 * explicit check and an object key gives the numeric sort for free.
 */
function normalizeAssets(assets) {
  const out = [];
  const seenSymbols = new Set();

  for (const asset of assets) {
    if (asset === null || typeof asset !== "object" || Array.isArray(asset)) {
      throw new InvalidOptimizationError("each asset must be an object");
    }
    const symbol = String(asset.symbol ?? "").trim().toUpperCase();
    if (symbol === "" || !SYMBOL_PATTERN.test(symbol)) {
      throw new InvalidOptimizationError("each asset needs a valid symbol");
    }
    if (seenSymbols.has(symbol)) throw new InvalidOptimizationError(`duplicate asset symbol: ${symbol}`);
    seenSymbols.add(symbol);

    const candles = asset.candles;
    if (!Array.isArray(candles) || candles.length > MAX_PRICE_ROWS_PER_ASSET) {
      throw new InvalidOptimizationError(
        `${symbol} candles must be an array with at most ${MAX_PRICE_ROWS_PER_ASSET} rows`,
      );
    }

    const prices = new Map();
    let duplicateCount = 0;
    for (const candle of candles) {
      if (candle === null || typeof candle !== "object") continue;
      if (candle.timestamp === undefined || candle.close === undefined) continue;
      if (!isNumeric(candle.timestamp) || !isNumeric(candle.close)) continue;
      const timestamp = Math.trunc(Number(candle.timestamp));
      const close = Number(candle.close);
      // A non-positive timestamp or close would produce a non-finite or infinite
      // return later; dropping the row here is what keeps the estimator total.
      if (timestamp <= 0 || !Number.isFinite(close) || close <= 0) continue;
      if (prices.has(timestamp)) {
        duplicateCount += 1;
        continue;
      }
      prices.set(timestamp, close);
    }

    if (prices.size < MIN_RETURN_OBSERVATIONS + 1) {
      throw new InvalidOptimizationError(
        `${symbol} needs at least ${MIN_RETURN_OBSERVATIONS + 1} valid close prices`,
      );
    }

    out.push({
      symbol,
      marketClass: String(asset.marketClass ?? "unknown").trim().toLowerCase(),
      // Sorted ascending: the return series is defined by consecutive timestamps,
      // so an unsorted map would silently compute returns across gaps in either
      // direction. `SORT_NUMERIC` in legacy, numeric comparator here.
      prices: new Map([...prices.entries()].sort((a, b) => a[0] - b[0])),
      provenance: asset.provenance !== null && typeof asset.provenance === "object" && !Array.isArray(asset.provenance)
        ? asset.provenance
        : {},
      duplicateCount,
    });
  }

  return out;
}

/** PHP `is_numeric`: a number, or a string that reads as one. */
function isNumeric(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim() !== "" && Number.isFinite(Number(value));
  return false;
}

/**
 * Timestamps present in **every** asset, ascending. This intersection is the whole
 * alignment story: an asset quoted on a different calendar simply contributes
 * fewer usable observations, and the caller is warned that rows were excluded.
 */
function commonTimestamps(assets) {
  let common = [...assets[0].prices.keys()];
  for (const asset of assets.slice(1)) {
    const keys = asset.prices;
    common = common.filter((timestamp) => keys.has(timestamp));
    if (common.length === 0) break;
  }
  return common.sort((a, b) => a - b).map((timestamp) => Number(timestamp));
}

/**
 * Simple close-to-close returns, one row per timestamp step, one column per asset.
 *
 * @returns {number[][]} rows = observations, columns = assets
 */
function alignedReturns(assets, timestamps) {
  const returns = [];
  for (let t = 1; t < timestamps.length; t += 1) {
    const row = [];
    for (const asset of assets) {
      const previous = asset.prices.get(timestamps[t - 1]);
      const current = asset.prices.get(timestamps[t]);
      const value = current / previous - 1.0;
      if (!Number.isFinite(value)) {
        throw new OptimizationUnavailableError("price history produced a non-finite return");
      }
      row.push(value);
    }
    returns.push(row);
  }
  return returns;
}

/** Arithmetic sample mean and the unbiased (`n-1`) sample covariance, symmetrized. */
function estimate(returns, assetCount) {
  const n = returns.length;
  const means = new Array(assetCount).fill(0.0);
  for (const row of returns) {
    for (let i = 0; i < assetCount; i += 1) means[i] += row[i];
  }
  for (let i = 0; i < assetCount; i += 1) {
    means[i] /= n;
    if (!Number.isFinite(means[i])) {
      throw new OptimizationUnavailableError("return history is too large to estimate safely");
    }
  }

  const covariance = Array.from({ length: assetCount }, () => new Array(assetCount).fill(0.0));
  for (let i = 0; i < assetCount; i += 1) {
    for (let j = i; j < assetCount; j += 1) {
      let sum = 0.0;
      for (const row of returns) sum += (row[i] - means[i]) * (row[j] - means[j]);
      const value = sum / Math.max(1, n - 1);
      if (!Number.isFinite(value)) {
        throw new OptimizationUnavailableError("return history produced an invalid covariance estimate");
      }
      covariance[i][j] = value;
      covariance[j][i] = value;
    }
  }
  return { means, sampleCovariance: covariance };
}

/**
 * Scale the sample covariance to annual terms and regularize it.
 *
 * Off-diagonal entries are shrunk toward zero by `shrinkage`; the diagonal keeps
 * the sample variance plus a **ridge** of `max(EPSILON, largestVariance * 1e-10)`.
 * The ridge is what makes the minimum-variance gradient step well defined when a
 * sample variance is exactly zero (a flat series), and it is scaled to the largest
 * variance so it stays negligible relative to real entries rather than dominating
 * a low-volatility universe.
 */
function annualizedShrunkCovariance(sample, periodsPerYear, shrinkage) {
  const n = sample.length;
  let largestVariance = 0.0;
  for (let i = 0; i < n; i += 1) largestVariance = Math.max(largestVariance, sample[i][i]);
  const ridge = Math.max(EPSILON, largestVariance * 1.0e-10);

  const out = Array.from({ length: n }, () => new Array(n).fill(0.0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const value = i === j ? sample[i][i] + ridge : (1.0 - shrinkage) * sample[i][j];
      out[i][j] = value * periodsPerYear;
    }
  }
  return out;
}

/**
 * Projected-gradient solution to the convex long-only minimum-variance QP
 * `min w'Σw  s.t.  Σw = 1, 0 <= w <= cap`.
 *
 * The objective's gradient is `2Σw` and its Hessian is `2Σ`, so `2 * max_i Σ_j|Σ_ij|`
 * (twice the largest absolute row sum, an ∞-norm bound on the spectral norm) is a
 * valid Lipschitz constant for the gradient. A fixed step of `1/L` then converges
 * monotonically without a line search, and every iterate is projected back onto the
 * feasible set — so the returned weights satisfy the constraints even if the
 * iteration limit is reached before the convergence test fires.
 */
function minimumVarianceWeights(covariance, maxWeight) {
  const n = covariance.length;
  let weights = new Array(n).fill(1 / n);

  let maxRowSum = 0.0;
  for (const row of covariance) {
    let rowSum = 0.0;
    for (const value of row) rowSum += Math.abs(value);
    maxRowSum = Math.max(maxRowSum, rowSum);
  }
  const lipschitz = 2.0 * maxRowSum;
  // A wholly zero covariance has no curvature to descend; equal weights is the
  // answer, and dividing by zero would produce NaN weights that still "sum to 1".
  if (lipschitz <= EPSILON) return weights;
  const step = 1.0 / lipschitz;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const gradient = covarianceTimesWeights(covariance, weights);
    const candidate = gradient.map((value, i) => weights[i] - 2.0 * step * value);
    const next = projectCappedSimplex(candidate, maxWeight);
    const converged = maxDistance(weights, next) < 1.0e-10;
    weights = next;
    if (converged) break;
  }
  return weights;
}

/**
 * Deterministic multi-start projected ascent for the long-only Sharpe ratio.
 *
 * `w'μ - rf / sqrt(w'Σw)` is not concave, so a single ascent can stop at a local
 * maximum. The start set is therefore: equal weights, the minimum-variance point,
 * and one corner per asset (that asset at the cap, the rest sharing the remainder).
 * Every start is itself projected, so all of them are feasible, and the number of
 * starts depends only on the asset count — nothing is random, so two runs of the
 * same input produce the same weights.
 */
function maximumSharpeWeights(means, covariance, riskFreeRate, maxWeight, minimumVariance) {
  const n = means.length;
  const starts = [new Array(n).fill(1 / n), minimumVariance];
  for (let asset = 0; asset < n; asset += 1) {
    const share = (1.0 - maxWeight) / Math.max(1, n - 1);
    const start = new Array(n).fill(share);
    start[asset] = maxWeight;
    starts.push(projectCappedSimplex(start, maxWeight));
  }

  let best = starts[0];
  let bestScore = sharpeScore(best, means, covariance, riskFreeRate);

  for (const start of starts) {
    let weights = start;
    let score = sharpeScore(weights, means, covariance, riskFreeRate);
    let step = 0.12;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
      const gradient = sharpeGradient(weights, means, covariance, riskFreeRate);
      // Normalize the ascent direction by its largest component. The Sharpe ratio
      // is scale-invariant in the *unconstrained* sense but the projection is not,
      // so an unnormalized gradient would take steps whose size depends on the
      // units of the inputs rather than on the geometry of the feasible set.
      let scale = 0.0;
      for (const value of gradient) scale = Math.max(scale, Math.abs(value));
      if (!Number.isFinite(scale) || scale < 1.0e-10) break;
      const direction = gradient.map((value) => value / scale);

      let accepted = false;
      let trialStep = step;
      let candidate = null;
      let candidateScore = score;
      for (let lineSearch = 0; lineSearch < 24; lineSearch += 1) {
        candidate = projectCappedSimplex(weights.map((weight, i) => weight + trialStep * direction[i]), maxWeight);
        candidateScore = sharpeScore(candidate, means, covariance, riskFreeRate);
        // Strict improvement with a tolerance: accepting an equal score would let
        // the loop oscillate between two projections for the full iteration budget.
        if (candidateScore > score + 1.0e-12) {
          accepted = true;
          break;
        }
        trialStep *= 0.5;
      }
      if (!accepted) break;

      const distance = maxDistance(weights, candidate);
      weights = candidate;
      score = candidateScore;
      // Grow the step back gently after a successful backtrack, capped so a single
      // accepted move cannot leap across the simplex.
      step = Math.min(0.25, trialStep * 1.15);
      if (distance < 1.0e-9) break;
    }

    if (score > bestScore) {
      best = weights;
      bestScore = score;
    }
  }
  return best;
}

/** Gradient of the Sharpe ratio with respect to the weights. */
function sharpeGradient(weights, means, covariance, riskFreeRate) {
  const covarianceWeights = covarianceTimesWeights(covariance, weights);
  const variance = Math.max(0.0, dot(weights, covarianceWeights));
  const volatility = Math.sqrt(variance);
  if (volatility <= EPSILON) return new Array(weights.length).fill(0.0);

  const excessReturn = dot(weights, means) - riskFreeRate;
  const volatilityCubed = volatility * volatility * volatility;
  return means.map((mean, i) => mean / volatility - (excessReturn * covarianceWeights[i]) / volatilityCubed);
}

/**
 * Sharpe ratio used as the ascent objective.
 *
 * A zero-volatility portfolio is a degenerate corner (only reachable when the
 * covariance ridge is the sole source of curvature), where the ratio is `x/0`.
 * Rather than returning `Infinity` — which would make every subsequent comparison
 * true and freeze the search on that corner — it returns a large finite sentinel
 * whose sign follows the excess return.
 */
function sharpeScore(weights, means, covariance, riskFreeRate) {
  const metrics = portfolioMetrics(weights, means, covariance, riskFreeRate);
  if (metrics.volatilityAnnualized <= EPSILON) {
    const excess = metrics.expectedReturnAnnualized - riskFreeRate;
    if (excess > 0) return 1.0e6;
    return excess < 0 ? -1.0e6 : 0.0;
  }
  return metrics.sharpeRatio;
}

/**
 * Portfolio statistics for one weight vector. `sharpeRatio` is `null` when the
 * volatility is not meaningfully positive, because a ratio with a zero denominator
 * is not a large number — it is undefined, and reporting `Infinity` would invite a
 * client to sort on it.
 */
function portfolioMetrics(weights, means, covariance, riskFreeRate) {
  const expectedReturn = dot(weights, means);
  const covarianceWeights = covarianceTimesWeights(covariance, weights);
  const variance = dot(weights, covarianceWeights);
  const volatility = Math.sqrt(Math.max(0.0, variance));
  return {
    expectedReturnAnnualized: rounded(expectedReturn),
    volatilityAnnualized: rounded(volatility),
    sharpeRatio: volatility <= EPSILON ? null : rounded((expectedReturn - riskFreeRate) / volatility),
    // Σw² — the Herfindahl-style concentration index. 1/n at equal weight, 1.0 when
    // everything sits in one asset, so it reads as "how undiversified is this".
    concentrationIndex: rounded(dot(weights, weights)),
  };
}

/** Weights keyed by symbol, then the metrics for that allocation. */
function allocationReport(symbols, weights, metrics) {
  const mapped = {};
  symbols.forEach((symbol, i) => {
    mapped[symbol] = weights[i];
  });
  return { weights: mapped, ...metrics };
}

/** Pairwise correlations, keyed by symbol both ways; `null` where a variance is zero. */
function correlationMatrix(symbols, covariance) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 1) {
    const row = {};
    for (let j = 0; j < symbols.length; j += 1) {
      const denominator = Math.sqrt(Math.max(0.0, covariance[i][i] * covariance[j][j]));
      if (denominator <= EPSILON) {
        row[symbols[j]] = null;
        continue;
      }
      const value = covariance[i][j] / denominator;
      // Clamp before rounding: a sample correlation can come out at 1.0000000000004
      // from float error, and reporting that would look like a bug rather than one.
      row[symbols[j]] = rounded(Math.max(-1.0, Math.min(1.0, value)));
    }
    out[symbols[i]] = row;
  }
  return out;
}

/** Σ·w for one weight vector. */
function covarianceTimesWeights(covariance, weights) {
  return covariance.map((row) => {
    let sum = 0.0;
    for (let j = 0; j < row.length; j += 1) sum += row[j] * weights[j];
    return sum;
  });
}

/**
 * Euclidean projection onto `{w: Σw = 1, 0 <= w_i <= cap}` by water filling.
 *
 * The projection of `v` is `clamp(v - shift, 0, cap)` for the unique `shift` that
 * makes the clamped values sum to 1; that sum is monotone decreasing in `shift`, so
 * bisection finds it. The bracket starts wide enough (`min(v) - cap - 1` to
 * `max(v) + 1`) to contain the root for any input, and 90 halvings take a
 * double-precision interval past its resolution.
 *
 * The trailing sweep removes the bisection residue. It is what makes the returned
 * weights sum to 1 *exactly enough* for the report to be honest about
 * `fullyInvested: true`, and it only ever moves a weight within its box — up toward
 * `cap` when the sum is short, down toward 0 when it is long — so it cannot create
 * a constraint violation while repairing one.
 */
function projectCappedSimplex(values, cap) {
  let low = Math.min(...values) - cap - 1.0;
  let high = Math.max(...values) + 1.0;

  for (let iteration = 0; iteration < 90; iteration += 1) {
    const shift = (low + high) / 2.0;
    let sum = 0.0;
    for (const value of values) sum += Math.max(0.0, Math.min(cap, value - shift));
    if (sum > 1.0) low = shift;
    else high = shift;
  }

  const shift = (low + high) / 2.0;
  const weights = values.map((value) => Math.max(0.0, Math.min(cap, value - shift)));

  let residual = 1.0 - weights.reduce((total, weight) => total + weight, 0.0);
  if (Math.abs(residual) > 0) {
    for (let i = 0; i < weights.length; i += 1) {
      const weight = weights[i];
      const room = residual > 0 ? cap - weight : weight;
      if (room <= 0) continue;
      const adjustment = residual > 0 ? Math.min(residual, room) : -Math.min(-residual, room);
      weights[i] += adjustment;
      residual -= adjustment;
      if (Math.abs(residual) < 1.0e-14) break;
    }
  }
  return weights;
}

function dot(left, right) {
  let sum = 0.0;
  for (let i = 0; i < left.length; i += 1) sum += left[i] * right[i];
  return sum;
}

/** Chebyshev (max-norm) distance — the convergence test both solvers use. */
function maxDistance(left, right) {
  let distance = 0.0;
  for (let i = 0; i < left.length; i += 1) distance = Math.max(distance, Math.abs(left[i] - right[i]));
  return distance;
}

/**
 * The report's warning list, in the legacy order.
 *
 * Every warning is a statement about the *data* or the *method*, never a hedge
 * invented for its own sake: the alignment warning fires only when rows were
 * actually excluded, the excess-return warning only when the estimated return does
 * not beat the risk-free rate.
 */
function collectWarnings({ normalized, commonTimestamps, shrinkage, maximumSharpe, riskFreeRate }) {
  const warnings = [];

  const availableCounts = normalized.map((asset) => asset.prices.size);
  const distinctCounts = new Set(availableCounts);
  // Uneven histories, or a minimum larger than the intersection, both mean the
  // alignment dropped something the caller supplied.
  if (distinctCounts.size > 1 || Math.min(...availableCounts) > commonTimestamps.length) {
    warnings.push("Only timestamps shared by every asset were used; unmatched observations were excluded.");
  }

  for (const asset of normalized) {
    if (asset.duplicateCount > 0) {
      warnings.push(`${asset.symbol}: ${asset.duplicateCount} duplicate candle timestamp(s) were discarded.`);
    }
  }

  if (shrinkage > 0) {
    warnings.push(
      `Covariance estimates use ${Math.round(shrinkage * 100)}% diagonal shrinkage plus a small numerical ridge.`,
    );
  }

  const classes = [...new Set(normalized.map((asset) => asset.marketClass).filter(Boolean))];
  if (classes.length > 1) {
    warnings.push(
      "The universe mixes market classes; annualization and currency comparability depend on the supplied data configuration.",
    );
  }

  if ((maximumSharpe.expectedReturnAnnualized ?? 0) <= riskFreeRate) {
    warnings.push(
      "No positive historical excess return was estimated for the maximum-Sharpe allocation; this is not a positive-return forecast.",
    );
  }

  return warnings;
}
