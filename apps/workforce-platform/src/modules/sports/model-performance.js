/**
 * Model performance from stored settled data — the metric half of legacy
 * `Aegis\Sports\ModelPerformanceService` (Phase 17, row 14 slice 3).
 *
 * Only prediction-level metrics are computed here: accuracy, Brier score and ECE over
 * predictions that have a recorded outcome. Those outcomes come from settlement
 * (slice 5), so until slice 5 this reports `samples: 0` and null metrics. That is what
 * "no measured data" looks like, and it is not a zero.
 *
 * Ticket-level metrics (win rate, ROI, drawdown, per-market and per-league breakdowns)
 * need settled tickets and selections, which arrive in slice 4 and slice 5. They are
 * reported as `NOT_PORTED`, not as zero, because a zero would claim a measurement.
 *
 * Divergences recorded in the phase document:
 *  - The window boundary is compared as an instant. Legacy compares a `Y-m-d H:i:s`
 *    string against ISO timestamps as strings, which misplaces rows on the boundary day.
 *  - The Brier score here is the corrected one (F-36; see `calibration.js`).
 *
 * Pure: the caller supplies outcomes and the clock.
 */

import { phpFloat, phpInt, phpIsset, phpRound } from "../../lib/php.js";
import { evaluateCalibration } from "./calibration.js";

export const DEFAULT_WINDOW_DAYS = 90;
export const MAX_WINDOW_DAYS = 3650;
export const NOT_PORTED = "NOT_PORTED";
export const TICKET_METRICS_STATUS = Object.freeze({
  status: NOT_PORTED,
  reason: "Ticket metrics need settled tickets and selections (row 14 slices 4 and 5).",
  winRate: null,
  roi: null,
  maxDrawdown: null,
  settledTickets: null,
  byMarket: null,
  byLeague: null,
});

/**
 * Prediction-level metrics over outcomes that have a recorded result.
 *
 * `predicted` is "over 1.5" when the probability is at or above one half, measured after
 * rounding to a tenth of a percent (legacy's `(int) round($p * 1000) >= 500`).
 *
 * @param {Array<{calibrated_probability?: number|null, raw_probability?: number|null, outcome: 0|1}>} outcomes
 * @returns {{samples: number, accuracy: number|null, brier: number|null, ece: number|null}}
 */
export function metricsFromOutcomes(outcomes) {
  const rows = Array.isArray(outcomes) ? outcomes : [];
  const metrics = { samples: rows.length, accuracy: null, brier: null, ece: null };
  if (rows.length === 0) return metrics;

  const probabilityOf = (row) => phpFloat(row.calibrated_probability ?? row.raw_probability ?? 0.5);

  let correct = 0;
  for (const row of rows) {
    const predictedOver = phpRound(probabilityOf(row) * 1000) >= 500;
    const outcome = phpInt(row.outcome);
    if (predictedOver ? outcome === 1 : outcome === 0) correct += 1;
  }
  metrics.accuracy = phpRound(correct / rows.length, 5);

  const calibration = evaluateCalibration(rows, probabilityOf);
  metrics.brier = calibration.brier;
  metrics.ece = calibration.ece;
  return metrics;
}

/**
 * The window's lower bound, in epoch seconds.
 *
 * @param {number} nowSeconds
 * @param {number} windowDays
 */
export function windowStartSeconds(nowSeconds, windowDays) {
  return nowSeconds - windowDays * 86400;
}

/**
 * Whether a stored timestamp falls inside the window. Compared as instants, so a row
 * stamped `…Z` and a row stamped `…+00:00` for the same moment compare the same.
 *
 * @param {string|null|undefined} createdAt
 * @param {number} sinceSeconds
 */
export function inWindow(createdAt, sinceSeconds) {
  if (!phpIsset(createdAt)) return false;
  const at = Date.parse(String(createdAt));
  if (Number.isNaN(at)) return false;
  return Math.floor(at / 1000) >= sinceSeconds;
}
