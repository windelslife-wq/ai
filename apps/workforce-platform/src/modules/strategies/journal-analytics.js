/**
 * Journal analytics and confidence calibration (spec §15).
 *
 * Ported from `application/libraries/Aegis/Journal/Analytics.php`, which serves
 * `Api_journal::summary` and `Api_journal::calibration`. This is the
 * "model/decision analytics" half of row 8 in `UNFINISHED_MODULES.md`: the
 * question it answers is not "did this strategy make money" (that is
 * `metrics.js`) but "when the platform said it was confident, was it right?"
 *
 * Four porting details that are easy to lose and change the numbers:
 *
 *  - Rounding uses `roundTo`, not `Math.round`. PHP's `round()` is
 *    half-away-from-zero, so `round(-0.5)` is `-1`; `Math.round(-0.5)` is `-0`.
 *    Every figure here is a negative number often enough for that to matter
 *    (`avgLoss`, `expectancyPnl`, `totalPnl`).
 *  - Two DIFFERENT dash characters are load-bearing. Bucket keys use an EN dash
 *    ("0–40% (low)"); the fallback group key and both calibration verdicts use an
 *    EM dash ("—"). The oracle case asserts `str_contains($b['key'], '0–40')`
 *    with an en dash, so normalising them would break a caller matching on the
 *    label.
 *  - The top bucket's ceiling is `1.0001`, not `1.0`, because membership is
 *    `min <= c < max` and a confidence of exactly 1.0 must land somewhere.
 *  - `totalPnl` is `0` rather than `null` when there are no closed trades, while
 *    every other aggregate is `null`. That asymmetry is the legacy's, and a
 *    caller summing `totalPnl` across groups depends on it being numeric.
 *
 * One legacy defect is ported faithfully and recorded rather than fixed:
 * `analyze` orders trades by `execution_time` as TEXT. Backtest entries store a
 * canonical ISO-8601 UTC string, but a manual entry stores whatever the caller
 * submitted, so an offset timestamp like `2026-10-01T10:00:00+01:00` sorts after
 * every `…Z` string for the same instant. That makes `maxDrawdownAbs` depend on
 * the order trades were written in. See divergence DV-5 in
 * `docs/migration/PHASE6_STRATEGIES.md`.
 */

import { roundTo } from "../analysis/math.js";

/**
 * AI-confidence buckets.
 *
 * The keys are user-facing labels and are matched on by callers, so they are part
 * of the contract rather than cosmetics.
 */
export const CONFIDENCE_BUCKETS = Object.freeze([
  Object.freeze({ key: "0–40% (low)", min: 0.0, max: 0.4 }),
  Object.freeze({ key: "40–60% (moderate)", min: 0.4, max: 0.6 }),
  Object.freeze({ key: "60–80% (high)", min: 0.6, max: 0.8 }),
  // 1.0001 so a confidence of exactly 1.0 is inside the top bucket: membership is
  // `min <= c < max`, and there is no bucket above this one.
  Object.freeze({ key: "80–100% (very high)", min: 0.8, max: 1.0001 }),
]);

/** Group keys the summary endpoint accepts (legacy `Api_journal::summary`). */
export const GROUP_KEYS = Object.freeze(["strategy", "market", "symbol", "source", "confidence"]);

/** Fallback label for an entry whose group field is absent. EM dash, not en dash. */
export const MISSING_GROUP_KEY = "—";

/** Below this many confidence-tagged closed trades, no calibration verdict is offered. */
export const CALIBRATION_MIN_SAMPLE = 30;

/**
 * Slack allowed between adjacent buckets before the trend is called non-monotonic.
 *
 * Without it, a one-trade difference between two buckets would flip the verdict,
 * and the verdict is what tells an operator whether to trust the confidence
 * signal when sizing.
 */
const MONOTONIC_TOLERANCE = 0.05;

export const CALIBRATION_VERDICTS = Object.freeze({
  INFORMATIVE:
    "Win rate broadly increases with confidence — the confidence signal is directionally informative. (Not a guarantee: verify across regimes and symbols.)",
  SKEPTICAL:
    "Win rate does NOT consistently increase with confidence — treat the confidence signal with skepticism and re-examine before sizing up on it.",
  smallSample: (count) =>
    `Sample too small for a calibration verdict (${count} confidence-tagged closed trades; need ${CALIBRATION_MIN_SAMPLE}+). Collect more journal entries.`,
});

export const NO_CONFIDENCE_NOTE =
  "No confidence-tagged trades yet — buckets populate once entries carry aiConfidence (strategy signals tag it already; paper trades tag both).";

function present(value) {
  return value !== null && value !== undefined;
}

/**
 * A trade counts as closed only when it has BOTH a realised P&L and an exit time.
 *
 * Requiring both is what keeps an open position out of every aggregate: a row with
 * a mark-to-market `pnl` but no `exit_time` is a live trade, and including it
 * would report an unrealised number as a result.
 */
function isClosed(entry) {
  return present(entry?.pnl) && present(entry?.exit_time);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Aggregate one set of journal entries.
 *
 * `winRate` and `profitFactor` are `null` rather than `0` when they cannot be
 * measured — no closed trades, or no losing trades to divide by. Reporting `0`
 * would read as "measured and terrible" instead of "not measurable", which is the
 * distinction this platform's honesty rules turn on.
 */
export function bucketMetrics(entries) {
  const closed = entries.filter(isClosed);
  const wins = closed.filter((entry) => entry.pnl > 0);
  // A break-even trade counts as a loss, matching `metrics.js`: it did not work.
  const losses = closed.filter((entry) => entry.pnl <= 0);
  const grossWin = sum(wins.map((entry) => entry.pnl));
  const grossLoss = Math.abs(sum(losses.map((entry) => entry.pnl)));
  const withR = closed.filter((entry) => present(entry.r_multiple));

  return {
    count: closed.length,
    winRate: closed.length ? roundTo(wins.length / closed.length, 4) : null,
    profitFactor: closed.length === 0 || grossLoss === 0 ? null : roundTo(grossWin / grossLoss, 4),
    expectancyPnl: closed.length ? roundTo((grossWin - grossLoss) / closed.length, 2) : null,
    avgWin: wins.length ? roundTo(grossWin / wins.length, 2) : null,
    avgLoss: losses.length ? roundTo(-grossLoss / losses.length, 2) : null,
    // Deliberately numeric even with no trades, unlike every field above.
    totalPnl: roundTo(grossWin - grossLoss, 2),
    avgRMultiple: withR.length ? roundTo(sum(withR.map((entry) => entry.r_multiple)) / withR.length, 4) : null,
  };
}

/**
 * Group closed trades and measure the cumulative drawdown across them.
 *
 * The drawdown walk starts its peak at `0`, not at the first trade's P&L, so a
 * series that loses from the outset reports a drawdown measured from break-even.
 * That is the legacy behaviour and it is the more conservative reading: it never
 * hides an early losing streak by treating the trough as the baseline.
 */
export function analyze(entries, groupBy) {
  const overall = bucketMetrics(entries);
  const closed = entries.filter(isClosed);

  // Ordered by execution_time as TEXT — see the DV-5 note in the header. A plain
  // comparison is used rather than localeCompare so the order is byte order, which
  // for canonical ISO-8601 UTC strings is chronological order.
  const chronological = [...closed].sort((a, b) => {
    const left = String(a.execution_time ?? "");
    const right = String(b.execution_time ?? "");
    return left < right ? -1 : left > right ? 1 : 0;
  });
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const entry of chronological) {
    cumulative += entry.pnl;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }

  const groups = [];
  if (groupBy === "confidence") {
    const tagged = closed.filter((entry) => present(entry.ai_confidence));
    for (const bucket of CONFIDENCE_BUCKETS) {
      const inside = tagged.filter(
        (entry) => entry.ai_confidence >= bucket.min && entry.ai_confidence < bucket.max,
      );
      const metrics = bucketMetrics(inside);
      // Empty buckets are omitted rather than reported as zeroes, so a caller sees
      // only the bands that actually have evidence.
      if (metrics.count > 0) groups.push({ key: bucket.key, metrics });
    }
  } else {
    const keyOf = (entry) => String(present(entry?.[groupBy]) ? entry[groupBy] : MISSING_GROUP_KEY);
    const keys = [...new Set(closed.map(keyOf))].sort();
    for (const key of keys) {
      const metrics = bucketMetrics(closed.filter((entry) => keyOf(entry) === key));
      if (metrics.count > 0) groups.push({ key, metrics });
    }
  }

  let note = null;
  if (groupBy === "confidence") {
    const untagged = closed.filter((entry) => !present(entry.ai_confidence));
    // True for an empty journal too (0 === 0), which is the legacy behaviour and
    // reads correctly: there is nothing tagged yet.
    if (untagged.length === closed.length) note = NO_CONFIDENCE_NOTE;
  }

  return {
    groupBy,
    groups,
    overall: {
      ...overall,
      closedTrades: closed.length,
      openOrPending: entries.length - closed.length,
      maxDrawdownAbs: roundTo(maxDrawdown, 2),
    },
    note,
  };
}

/**
 * Does win rate actually rise with stated confidence?
 *
 * This is the check that keeps a confidence score honest. A signal that says "80%"
 * and wins half the time is worse than useless, because it invites larger size —
 * so the verdict says so in terms an operator can act on, and refuses to offer any
 * verdict at all under 30 confidence-tagged closed trades rather than extrapolate
 * from a handful.
 */
export function calibration(entries) {
  const closed = entries.filter((entry) => isClosed(entry) && present(entry.ai_confidence));

  const buckets = [];
  for (const bucket of CONFIDENCE_BUCKETS) {
    const inside = closed.filter(
      (entry) => entry.ai_confidence >= bucket.min && entry.ai_confidence < bucket.max,
    );
    if (inside.length === 0) continue;
    const wins = inside.filter((entry) => entry.pnl > 0).length;
    const withR = inside.filter((entry) => present(entry.r_multiple));
    buckets.push({
      key: bucket.key,
      count: inside.length,
      winRate: roundTo(wins / inside.length, 4),
      expectancyR: withR.length ? roundTo(sum(withR.map((entry) => entry.r_multiple)) / withR.length, 4) : null,
    });
  }

  if (closed.length < CALIBRATION_MIN_SAMPLE) {
    return {
      buckets,
      sufficientData: false,
      verdict: CALIBRATION_VERDICTS.smallSample(closed.length),
    };
  }

  // Buckets are already in ascending-confidence order, so comparing each to its
  // predecessor tests the trend directly.
  const rates = buckets.filter((bucket) => bucket.winRate !== null).map((bucket) => bucket.winRate);
  let monotonic = true;
  for (let index = 1; index < rates.length; index += 1) {
    if (rates[index] < rates[index - 1] - MONOTONIC_TOLERANCE) monotonic = false;
  }

  return {
    buckets,
    sufficientData: true,
    verdict: monotonic ? CALIBRATION_VERDICTS.INFORMATIVE : CALIBRATION_VERDICTS.SKEPTICAL,
  };
}
