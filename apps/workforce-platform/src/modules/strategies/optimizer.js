/**
 * Parameter grid search with walk-forward verification.
 *
 * Ported from `application/libraries/Aegis/Optimization/StrategyOptimizer.php`.
 *
 * The method is deliberately unglamorous, and the unglamorousness is the point:
 *
 *   1. Split the series — in-sample is the first 70%, out-of-sample the last 30%.
 *   2. Run every parameter combination on the in-sample segment only.
 *   3. Rank, and carry the top K to the out-of-sample segment.
 *   4. Recommend adoption only when a candidate *survives* out-of-sample
 *      (enough trades, profit factor above 1, positive expectancy) **and** beats
 *      the current parameters measured on that same out-of-sample segment.
 *
 * A parameter set that only ever wins in-sample is curve-fitting by definition,
 * so it is never recommended. That is stated in `methodNote` on every report
 * rather than left in a comment, because the report is what a human reads before
 * deciding whether to adopt new parameters.
 *
 * Two anti-blow-up measures are worth naming, since both look like they could be
 * removed:
 *
 *  - The search space is the strategy's own declared `paramGrid()`, which is
 *    small by design (8–24 combinations). Nothing here invents a wider search.
 *  - `minCandles` is 420 so that after the 70/30 split both segments still clear
 *    the backtester's own 120-candle floor. Optimizing on a sliver of history
 *    would produce a confident recommendation from almost no data, so a short
 *    series is refused outright.
 *
 * One legacy artefact is preserved with a note: `combinationsEvaluated` in the
 * PHP is written as `count($results) + ($baseline !== null ? 0 : 0)` — a ternary
 * that adds zero on both branches. It is ported as plain `results.length`; the
 * reported number is identical either way.
 */

import { roundTo } from "../analysis/math.js";
import { BACKTEST_DEFAULTS, MIN_BACKTEST_CANDLES, simulate } from "./backtester.js";
import { computeMetrics } from "./metrics.js";

/** Optimizer configuration. Every value is a threshold, not a tunable knob. */
export const OPTIMIZER_DEFAULTS = Object.freeze({
  /** In-sample fraction of the series. */
  split: 0.7,
  /** How many in-sample winners are re-tested out-of-sample. */
  topK: 3,
  /** Minimum in-sample trades for a candidate to be taken seriously. */
  minTrades: 8,
  /** Minimum out-of-sample trades for a candidate to be adopted. */
  oosMinTrades: 5,
  /** Hard ceiling on evaluated combinations. */
  maxCombinations: 81,
  /** Minimum series length, chosen so both segments clear 120 bars. */
  minCandles: 420,
});

/** Stand-in for a missing expectancy/profit-factor when ranking. */
const RANK_FLOOR = -99;

/** Epsilon for the "beats the baseline" comparison, so ties do not adopt. */
const ADOPT_EPSILON = 1e-9;

/** Metadata stamped on optimizer-internal simulations. */
const OPTIMIZER_META = Object.freeze({
  symbol: "OPTIMIZER",
  timeframe: "1h",
  marketClass: "optimizer",
});

/** Stated on every report so the method is never separable from the result. */
export const METHOD_NOTE =
  "in-sample grid search on the first 70% of the series, out-of-sample verification on the last 30%; in-sample-only performance is never recommended";

/**
 * Thrown when the series is too short to split meaningfully.
 *
 * Carries `statusCode: 400`: the request was well-formed, the history was not
 * sufficient. The legacy raises `InvalidArgumentException`, which its controller
 * also maps to 400.
 */
export class OptimizationInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "OptimizationInputError";
    this.code = "OPTIMIZATION_INPUT_INVALID";
    this.statusCode = 400;
  }
}

/**
 * Capped cartesian product of a parameter grid.
 *
 * When the product exceeds `cap` a deterministic stride sample is taken rather
 * than a random one, so two runs over the same grid evaluate the same
 * combinations. Grids are small by design; the cap is a safety valve against an
 * accidentally declared huge grid, not a routine path.
 *
 * Keys with a non-array or empty value list are skipped, which means a strategy
 * can declare a parameter it does not want searched by giving it no alternatives.
 *
 * @param {Record<string, Array<number>>} grid
 * @param {number} cap
 * @returns {Array<Record<string, number>>}
 */
export function cartesian(grid, cap) {
  let combos = [{}];
  for (const [key, values] of Object.entries(grid ?? {})) {
    if (!Array.isArray(values) || values.length === 0) continue;
    const next = [];
    for (const combo of combos) {
      for (const value of values) next.push({ ...combo, [key]: value });
    }
    combos = next;
  }
  if (combos.length > cap) {
    const stride = Math.ceil(combos.length / cap);
    combos = combos.filter((_, index) => index % stride === 0);
  }
  return combos;
}

/**
 * Compact `key=value` rendering used inside overfit warnings.
 *
 * Floats are rounded to two decimals so a warning stays readable; a parameter
 * list of six full-precision numbers would bury the actual finding.
 *
 * @param {Record<string, number>} params
 * @returns {string}
 */
export function shortParams(params) {
  return Object.entries(params ?? {})
    .map(([key, value]) => `${key}=${typeof value === "number" ? roundTo(value, 2) : value}`)
    .join(",");
}

/**
 * Simulate one segment and reduce it to metrics.
 *
 * Returns `null` when the segment is shorter than the backtester's floor. The
 * caller treats `null` as "this candidate cannot be evaluated", which is
 * different from "this candidate scored badly" — conflating the two would let a
 * too-short segment silently rank last and still be reported.
 *
 * @param {import("./builtin.js").TradingStrategy} strategy
 * @param {Array<object>} candles
 * @param {Record<string, unknown>} req
 * @returns {{trades:number, metrics:Record<string, number|null>}|null}
 */
function runSegment(strategy, candles, req) {
  if (candles.length < MIN_BACKTEST_CANDLES) return null;
  const result = simulate(strategy, candles, req, OPTIMIZER_META);
  const metrics = computeMetrics(
    result.trades,
    result.equityCurve,
    req.initialEquity,
    "1h",
    result.barsInMarket,
  );
  return { trades: result.trades.length, metrics };
}

/**
 * Rank candidates best-first by expectancy in R, then profit factor.
 *
 * Expectancy leads because it is net of costs and scaled by what was risked;
 * profit factor alone rewards a strategy that wins often by small amounts while
 * occasionally losing large ones. Missing values sort last via `RANK_FLOOR`
 * rather than being treated as zero, since "unmeasured" is worse than "flat".
 *
 * The sort is stable in V8, and ties keep grid order, which is what makes the
 * whole optimizer deterministic for identical inputs — oracle case
 * `33-optimizer.php` pins exactly that.
 *
 * @param {Array<{metrics: Record<string, number|null>}>} results
 * @returns {Array<{metrics: Record<string, number|null>}>}
 */
function rankCandidates(results) {
  return [...results].sort((a, b) => {
    const aExp = a.metrics.expectancyR ?? RANK_FLOOR;
    const bExp = b.metrics.expectancyR ?? RANK_FLOOR;
    if (bExp !== aExp) return bExp - aExp;
    const aPf = a.metrics.profitFactor ?? RANK_FLOOR;
    const bPf = b.metrics.profitFactor ?? RANK_FLOOR;
    return bPf - aPf;
  });
}

/**
 * Run the walk-forward optimization.
 *
 * @param {object} params
 * @param {(p: Record<string, number>) => import("./builtin.js").TradingStrategy} params.make
 *        builds a strategy instance from a parameter set
 * @param {Record<string, number>} params.baselineParams the currently registered parameters
 * @param {Record<string, Array<number>>} params.grid the declared search space
 * @param {Array<object>} params.candles the full series, ascending by time
 * @param {Record<string, unknown>} [params.requestOverrides] backtest cost/risk overrides
 * @param {{ranAt?: string}} [params.stamp] injectable clock for tests
 * @returns {Record<string, unknown>} the report
 * @throws {OptimizationInputError} when the series is shorter than `minCandles`
 */
export function optimize({
  make,
  baselineParams,
  grid,
  candles,
  requestOverrides = {},
  stamp = {},
}) {
  const cfg = OPTIMIZER_DEFAULTS;
  if (candles.length < cfg.minCandles) {
    throw new OptimizationInputError(
      `optimization needs at least ${cfg.minCandles} candles, got ${candles.length} — load more history`,
    );
  }

  // Overrides are merged onto the backtester defaults without re-validating
  // them: the HTTP layer validates the request, and re-checking here would
  // reject the optimizer's own internal segments.
  const req = { ...BACKTEST_DEFAULTS, ...requestOverrides };
  const splitAt = Math.floor(candles.length * cfg.split);
  const inSample = candles.slice(0, splitAt);
  const outSample = candles.slice(splitAt);

  const combinations = cartesian(grid, cfg.maxCombinations);
  const results = [];
  for (const params of combinations) {
    const segment = runSegment(make(params), inSample, req);
    if (segment === null) continue;
    results.push({ ...segment, params });
  }
  const ranked = rankCandidates(results);

  const baseline = runSegment(make(baselineParams), inSample, req);
  const baselineOos = runSegment(make(baselineParams), outSample, req);

  const carried = ranked
    .filter((candidate) => (candidate.metrics.trades ?? 0) >= cfg.minTrades)
    .slice(0, cfg.topK);

  const finalists = carried.map((candidate) => {
    const oos = runSegment(make(candidate.params), outSample, req);
    const oosMetrics = oos ? oos.metrics : null;
    return {
      params: candidate.params,
      inSample: candidate.metrics,
      outOfSample: oosMetrics,
      // Survival is the whole gate: enough out-of-sample trades to mean
      // anything, a profit factor above break-even, and positive expectancy.
      // A null profit factor (no losses recorded) fails the `> 1.0` test rather
      // than passing it, because an unmeasured downside is not evidence of edge.
      survives:
        oos !== null &&
        (oosMetrics.trades ?? 0) >= cfg.oosMinTrades &&
        (oosMetrics.profitFactor ?? 0) > 1.0 &&
        (oosMetrics.expectancyR ?? 0) > 0,
    };
  });

  // Adoption additionally requires beating the *current* parameters on the same
  // out-of-sample data. `max(0, baselineExp)` means a baseline that lost money
  // out-of-sample sets the bar at zero, not at its own negative score — a
  // candidate should not be adopted merely for losing less.
  const baselineOosExp = baselineOos?.metrics?.expectancyR ?? RANK_FLOOR;
  let adopted = null;
  for (const finalist of finalists) {
    if (!finalist.survives) continue;
    const candidateExp = finalist.outOfSample?.expectancyR ?? RANK_FLOOR;
    if (candidateExp > Math.max(0, baselineOosExp) + ADOPT_EPSILON) {
      adopted = finalist;
      break;
    }
  }

  const overfitWarnings = [];
  for (const finalist of finalists) {
    const inSamplePf = finalist.inSample?.profitFactor ?? null;
    const oosPf = finalist.outOfSample?.profitFactor ?? null;
    if (inSamplePf !== null && oosPf !== null && inSamplePf > 1 && oosPf <= 1) {
      overfitWarnings.push(
        `params ${shortParams(finalist.params)}: in-sample PF ${inSamplePf.toFixed(2)} collapsed to ${oosPf.toFixed(2)} out-of-sample — classic overfit`,
      );
    }
  }
  if (adopted === null && finalists.length > 0) {
    overfitWarnings.push(
      "no candidate survived out-of-sample verification — keeping current parameters",
    );
  }

  return {
    ranAt: stamp.ranAt ?? new Date().toISOString(),
    split: { inSampleBars: inSample.length, outOfSampleBars: outSample.length },
    searchSpace: {
      combinationsEvaluated: results.length,
      gridSize: combinations.length,
      grid,
    },
    baseline: {
      params: baselineParams,
      inSample: baseline ? baseline.metrics : null,
      outOfSample: baselineOos ? baselineOos.metrics : null,
    },
    finalists,
    recommendation: {
      adopt: adopted !== null,
      params: adopted ? adopted.params : null,
      reason:
        adopted !== null
          ? "candidate survived out-of-sample verification and beat the baseline there"
          : "keep current parameters — no candidate beat the baseline out-of-sample",
    },
    overfitWarnings,
    methodNote: METHOD_NOTE,
  };
}
