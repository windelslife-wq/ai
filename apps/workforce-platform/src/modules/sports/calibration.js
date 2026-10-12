/**
 * Probability calibration — the port of legacy `Aegis\Sports\CalibrationEngine`
 * (Phase 17, row 14 slice 3).
 *
 * A Platt-style affine map in logit space: `P = 1 / (1 + exp(-(intercept + slope * raw)))`,
 * fitted by deterministic grid search on **stored settled predictions** and never on
 * invented outcomes. A calibration is only usable after an administrator approves it;
 * until then a prediction reports `MODEL_NOT_CALIBRATED`.
 *
 * Two things differ from legacy, and both are recorded in the phase document:
 *
 *  - **Brier score (F-36).** Legacy accumulates `(int) (($p - $y) ** 2)`. An `int` cast
 *    truncates, and a squared error between two probabilities is always below 1, so
 *    every term is 0 and the reported Brier score is **always 0.0**. The port
 *    accumulates the squared error. The PHP golden file records the 0.0 and the test
 *    that compares against it asserts the difference explicitly, rather than treating
 *    the two as equal.
 *  - Nothing else. The grid, the clamps, the class-coverage guard, the identity fallback
 *    and the ECE binning are ported line for line, and the parity harness checks them.
 *
 * Pure: no I/O, no clock, no database.
 */

import { phpFloatString, phpIsNumeric, phpRound } from "../../lib/php.js";

export const MIN_SAMPLES = 20;
export const MIN_CLASS_MINIMUM = 3;
export const CALIBRATION_METHOD = "platt";
/**
 * The identity map, used when a fit carries no separable signal. It is stored under its
 * own method name, so a reader can tell "no calibration was learned" from a fitted line
 * that happens to be 0 + 1*x. See `applyFittedCalibration` and F-37 / DV-12.
 */
export const IDENTITY_METHOD = "identity";

/** Clamp the calibrated probability to the range every consumer is written for. */
const PROBABILITY_FLOOR = 0.01;
const PROBABILITY_CEILING = 0.99;

/**
 * Apply a stored calibration to a raw probability, respecting its method.
 *
 * An identity calibration returns the raw probability, clamped to the same range as every
 * other output. The user chose this (F-37): a degenerate fit means "no calibration was
 * learned", so the honest output is the uncalibrated probability, not a sigmoid of it.
 * Any other method, including a missing one from callers that predate the field, is the
 * logistic map.
 *
 * @param {{method?: string, intercept: number, slope: number}} calibration
 * @param {number} raw
 * @returns {number}
 */
export function applyFittedCalibration(calibration, raw) {
  if (calibration && calibration.method === IDENTITY_METHOD) {
    return Math.min(PROBABILITY_CEILING, Math.max(PROBABILITY_FLOOR, raw));
  }
  return applyCalibration(calibration.intercept, calibration.slope, raw);
}

/**
 * Apply a fitted calibration to a raw probability.
 *
 * Legacy `CalibrationEngine::apply()` — the logistic map. `PredictionEngine` in
 * legacy does NOT use this function; it computes `intercept + slope * raw` directly
 * (finding F-37, divergence DV-12). This port uses the logistic map there too, because
 * the calibration was fitted under it.
 *
 * @param {number} intercept
 * @param {number} slope
 * @param {number} raw
 * @returns {number}
 */
export function applyCalibration(intercept, slope, raw) {
  const z = intercept + slope * raw;
  const probability = 1 / (1 + Math.exp(-z));
  return Math.min(PROBABILITY_CEILING, Math.max(PROBABILITY_FLOOR, probability));
}

/**
 * Brier score, 10-bin expected calibration error and reliability bins for a
 * probability function over a set of rows.
 *
 * @param {Array<{outcome: number}>} rows `outcome` is 0 or 1
 * @param {(row: object) => number} probabilityOf
 * @returns {{brier: number, ece: number, bins: Array<object>}}
 */
export function evaluateCalibration(rows, probabilityOf) {
  let brier = 0;
  const bins = new Map();
  for (const row of rows) {
    const p = Math.min(0.999, Math.max(0.001, Number(probabilityOf(row))));
    const outcome = Number(row.outcome);
    // Squared error, NOT `(int)` of it — see F-36 in the module docblock.
    brier += (p - outcome) ** 2;
    const index = Math.min(9, Math.floor(p * 10));
    if (!bins.has(index)) bins.set(index, { n: 0, sumP: 0, hits: 0 });
    const bucket = bins.get(index);
    bucket.n += 1;
    bucket.sumP += p;
    bucket.hits += outcome;
  }

  let ece = 0;
  const outBins = [];
  for (let index = 0; index <= 9; index += 1) {
    const bucket = bins.get(index);
    if (!bucket) continue;
    const meanP = bucket.sumP / bucket.n;
    const frequency = bucket.hits / bucket.n;
    ece += (bucket.n / Math.max(1, rows.length)) * Math.abs(meanP - frequency);
    outBins.push({
      bin: index,
      label: `${index * 10}-${index * 10 + 9}`,
      n: bucket.n,
      meanCalibrated: phpRound(meanP, 4),
      observedFrequency: phpRound(frequency, 4),
      gap: phpRound(meanP - frequency, 4),
    });
  }

  return {
    brier: phpRound(brier / Math.max(1, rows.length), 6),
    ece: phpRound(ece, 6),
    bins: outBins,
  };
}

/**
 * Fit a calibration to settled outcomes.
 *
 * @param {Array<{raw_probability: number|string, outcome: 0|1}>} outcomes
 * @returns {{ok: true, fit: object, metrics: object, bins: Array<object>} |
 *   {ok: false, reason: string, samples: number}}
 */
export function fitCalibration(outcomes) {
  const rows = (Array.isArray(outcomes) ? outcomes : []).filter(
    (row) => row
      && row.raw_probability !== undefined && row.raw_probability !== null
      && row.outcome !== undefined && row.outcome !== null
      && phpIsNumeric(row.raw_probability)
      && (row.outcome === 0 || row.outcome === 1),
  );
  const n = rows.length;
  if (n < MIN_SAMPLES) return { ok: false, reason: "INSUFFICIENT_SETTLED_SAMPLE", samples: n };

  const ones = rows.filter((row) => Number(row.outcome) === 1).length;
  if (ones < MIN_CLASS_MINIMUM || n - ones < MIN_CLASS_MINIMUM) {
    return { ok: false, reason: "INSUFFICIENT_CLASS_COVERAGE", samples: n };
  }

  // The slope is capped at 3.0: beyond that the grid overfits small settled samples
  // and the calibrated error gets worse rather than better (legacy's own comment).
  let best = null;
  for (let slope = 0.5; slope <= 3.01; slope += 0.25) {
    for (let intercept = -8.0; intercept <= 8.01; intercept += 0.5) {
      let logLikelihood = 0;
      for (const row of rows) {
        const x = Number(row.raw_probability);
        const z = intercept + slope * x;
        const pz = Math.min(0.999999, Math.max(0.000001, 1 / (1 + Math.exp(-z))));
        logLikelihood += Number(row.outcome) === 1 ? Math.log(pz) : Math.log(1 - pz);
      }
      if (best === null || logLikelihood > best.logloss) {
        best = { logloss: logLikelihood, intercept: phpRound(intercept, 6), slope: phpRound(slope, 6) };
      }
    }
  }

  // A degenerate fit that pushes every row to one side of 0.5 is replaced by the
  // identity map, which is the honest answer when the data carry no separable signal.
  let predictedOnes = 0;
  for (const row of rows) {
    if (applyCalibration(best.intercept, best.slope, Number(row.raw_probability)) >= 0.5) predictedOnes += 1;
  }
  if (predictedOnes === 0 || predictedOnes === n) {
    best = { logloss: best.logloss, intercept: 0, slope: 1, method: IDENTITY_METHOD };
  }

  const metrics = evaluateCalibration(rows, (row) => applyFittedCalibration(best, Number(row.raw_probability)));
  metrics.identityBrier = evaluateCalibration(rows, (row) => Number(row.raw_probability)).brier;

  return {
    ok: true,
    fit: {
      method: best.method ?? CALIBRATION_METHOD,
      intercept: best.intercept,
      slope: best.slope,
      samples: n,
      positives: ones,
    },
    metrics,
    bins: metrics.bins,
  };
}

/**
 * The deterministic version label for a fitted calibration.
 *
 * Built from the fitted numbers, so the same fit always gets the same label. Legacy
 * builds it two ways that disagree on MySQL — `DailyTicketService::calibrationVersionLabel`
 * reads DECIMAL columns, which arrive as strings (`i0.500000`), while the fit path
 * reads floats (`i0.5`). See divergence SP-30. This port uses the float form everywhere.
 *
 * @param {{intercept: number, slope: number, samples: number}} fit
 * @returns {string}
 */
export function calibrationVersion(fit) {
  const method = fit.method ?? CALIBRATION_METHOD;
  return `cal-${method}-i${phpFloatString(fit.intercept)}-s${phpFloatString(fit.slope)}-n${Math.trunc(Number(fit.samples))}`;
}
