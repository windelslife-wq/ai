/**
 * PHP date-shape parity helpers shared by every module ported from a legacy
 * class that formatted an instant with `gmdate('c')`.
 *
 * Two ports need this — the broker normalizer (Phase 14, divergence BC-1) and the
 * sports normalizer (Phase 15, divergence SP-1) — and it lives here rather than
 * being copied because it is exactly the kind of one-line helper that drifts: if
 * one module keeps milliseconds and the other drops them, every differential
 * comparison between the PHP and Node implementations fails on formatting rather
 * than on behaviour, which is the whole reason both ports preserve the legacy
 * shape in the first place (finding F-26).
 *
 * PHP's `gmdate('c')` produces ISO-8601 with **second precision and an explicit
 * `+00:00` offset**: `2026-10-12T01:02:03+00:00`. JavaScript's
 * `Date#toISOString()` produces `2026-10-12T01:02:03.000Z`. Same instant,
 * different text — and text is what gets compared, stored and returned.
 */

/**
 * Format a `Date` the way PHP's `gmdate('c')` would: drop the milliseconds and
 * swap the `Z` for `+00:00`. Nothing else is changed, so the result is still a
 * valid ISO-8601 UTC instant that `Date.parse` and PHP's `DateTimeImmutable`
 * both accept.
 *
 * @param {Date} date
 * @returns {string}
 */
export function formatGmdateC(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/**
 * `gmdate('c')` for "now", as an offset-suffixed second-precision instant.
 *
 * @param {number} [epochMs] milliseconds since the epoch; defaults to the current time
 * @returns {string}
 */
export function gmdateCNow(epochMs = Date.now()) {
  return formatGmdateC(new Date(epochMs));
}

/**
 * Convert an instant to the platform's canonical stored shape — UTC with
 * millisecond precision and a `Z` suffix — which is what migrations 007 through
 * 011 use for every `VARCHAR(32)` timestamp column.
 *
 * This is the *other* half of divergence SP-1. A legacy-shaped `+00:00` string
 * and a canonical `…Z` string denote the same instant but do not compare equal as
 * text, and a column that mixes the two shapes invites a reader to believe a
 * `WHERE observed_at >= ?` filter is comparing like with like. Both order
 * correctly against each other (fixed width, UTC-only, date-first), but the
 * platform stores one shape so that a stored value can be compared against a
 * bound without thinking about which port produced it.
 *
 * @param {Date|string|number|null|undefined} value
 * @returns {string|null} `null` when the value is absent or unparseable, so a
 *   nullable column stays nullable rather than being written as the epoch
 */
export function toCanonicalUtc(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * An ISO-8601 calendar instant, optionally with a time part and an optional
 * offset. Deliberately narrow: it accepts what a provider contract asks for
 * ("UTC ISO-8601 timestamps") and nothing else.
 *
 * This exists because **`new Date()` is far more permissive than PHP's
 * `DateTimeImmutable`, and in the direction that fabricates data.** `new
 * Date("12345")` is the *year 12345* — the exact defect D-12 in
 * PHASE10_AUDIT_BROWSER.md, where `?from=12345` silently produced an empty window
 * that looked like a working filter — and `new Date("0")` is the year 2000,
 * where PHP throws. PHP's parser is also happy with relative text such as
 * `"now"` or `"+1 day"`, which would resolve differently in two runtimes at two
 * moments and so could never be compared.
 *
 * Refusing is fail-closed and is the honest answer for a record whose whole
 * purpose is to say when something was observed.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Parse a timestamp strictly, the way a provider payload should be read.
 *
 * @param {unknown} value
 * @returns {Date|null} the instant, or `null` when the value is absent or is not
 *   a calendar instant — never a guessed one
 */
export function parseStrictInstant(value) {
  if (typeof value !== "string") {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    // A bare number is refused rather than interpreted: epoch seconds and epoch
    // milliseconds differ by a factor of 1 000 and both are plausible things for
    // a provider to send, so guessing would place a fixture in 1970 or in the
    // year 55 000 depending on which convention this file happened to pick.
    return null;
  }
  const text = value.trim();
  if (!ISO_INSTANT.test(text)) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}
