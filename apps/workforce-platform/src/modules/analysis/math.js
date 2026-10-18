/**
 * Numeric helpers for the analysis module.
 *
 * Ported from the parts of `application/libraries/Aegis/MathUtils.php` that the
 * indicator and agent layers need (`clamp`, `mean`, `stdev`). The other three
 * members of that legacy class — `hashString`, `seededRandom`, `gaussian` — were
 * ported in Phase 4 into `../market-data/normalize.js`, because the synthetic
 * candle generator is their only caller. Splitting one legacy class across two
 * modules is a deliberate divergence, recorded in
 * `docs/migration/PHASE5_ANALYSIS.md`; re-exporting them from here would create
 * an import cycle between analysis and market-data for no benefit.
 *
 * The two formatting helpers exist for payload parity: the legacy reports embed
 * numbers in human-readable sentences produced by PHP's `number_format()` and
 * `sprintf('%+.2f')`. Those strings are part of the API response, so they are
 * reproduced rather than approximated — `number_format(64000, 5)` is
 * `"64,000.00000"`, comma included.
 */

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Population standard deviation (divides by n), matching the legacy helper. */
export function stdev(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const average = mean(values);
  let accumulator = 0;
  for (const value of values) accumulator += (value - average) ** 2;
  return Math.sqrt(accumulator / values.length);
}

import { phpRound } from "../../lib/php.js";

/**
 * PHP `round()`: half away from zero. `Math.round()` is half-up towards
 * +infinity, so -0.5 would round to -0 instead of -1.
 *
 * Finding **F-47** (surfaced by the F-26 analysis golden): the earlier body
 * (`sign * Math.round(abs * factor) / factor`) got the sign rule right but not
 * the *decimal-representation* rule — PHP pre-rounds to 15 significant digits,
 * so `round(1.005, 2)` is `1.01` while `Math.round(1.005_00 × 100) / 100` is
 * `1` because the double is `1.00499…`. The sports oracle proved the genuine
 * algorithm in Phase 17 (`src/lib/php.js:phpRound`); this export delegates to
 * it so the analysis layer — and every module that shares the helper — rounds
 * the way PHP does. Pinned to the last double by `test/analysis_parity.test.js`.
 */
export function roundTo(value, digits = 0) {
  return phpRound(value, digits);
}

/** PHP `number_format($v, $d)`: fixed decimals plus thousands separators. */
export function numberFormat(value, digits = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  const negative = numeric < 0;
  const fixed = Math.abs(numeric).toFixed(digits);
  const [integer, fraction] = fixed.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

/** PHP `sprintf('%+.<digits>f', $v)`: always signed, fixed decimals. */
export function signedFormat(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return `${numeric < 0 ? "-" : "+"}${Math.abs(numeric).toFixed(digits)}`;
}

/** PHP `sprintf('%.<digits>f', $v)`. */
export function fixedFormat(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return numeric.toFixed(digits);
}
