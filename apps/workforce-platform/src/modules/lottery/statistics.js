/**
 * The lottery statistical engine — the port of `Aegis\Lottery\LotteryStatisticsEngine`
 * (legacy spec §8–§14), a set of pure functions over stored draws: no I/O, no clock,
 * fully testable — which is why it is the heart of the PHP differential harness.
 *
 * Legacy's honesty contract is reproduced verbatim, because it is the module's
 * reason to exist:
 *  - every output carries DISCLAIMER: draws are independent random events;
 *  - "frequency", "gap" and "hot/cold" are HISTORICAL OBSERVATIONS, labelled as such;
 *  - the engine deliberately has NO "due" concept: a long gap is reported as
 *    "absent for X draws" — never as "likely to appear next".
 *
 * PHP shape semantics are preserved exactly: numeric maps become JS objects keyed by
 * the number (`{"7": …}`), string-keyed maps keep PHP's insertion order, `round()`
 * goes through `phpRound` (half away from zero, pre-rounded to 15 significant
 * digits — NOT `Math.round`), and `null` survives where PHP would return null. The
 * sort comparators are PHP's (`arsort` value-desc, `uasort` count-desc then first
 * member asc); PHP's sorts are unstable for ties while JavaScript's are stable, so
 * the differential cases pin tie-free boundaries — recorded as divergence LT-3.
 */

import { phpRound } from "../../lib/php.js";

export const DISCLAIMER = "Lottery draws are independent random events. Historical frequency, gaps and patterns are statistical observations only — they do not change the probability of future draws and are not forecasts of future results.";

export function createLotteryStatisticsEngine() {
  return Object.freeze({
    numberStats: (draws, min, max, window = 0) => fieldStats(draws, "main", min, max, window),
    starStats: (draws, min, max, window = 0) => fieldStats(draws, "stars", min, max, window),
    hotCold,
    distribution,
    groupStats,
  });
}

function fieldStats(draws, field, min, max, window) {
  const total = draws.length;
  const numbers = {};
  for (let n = min; n <= max; n += 1) {
    let appearances = 0;
    let recent = 0;
    let lastSeen = null;
    const gaps = [];
    for (let i = 0; i < total; i += 1) {
      if (!draws[i][field].includes(n)) continue;
      appearances += 1;
      if (lastSeen !== null) gaps.push(i - lastSeen);
      lastSeen = i;
      if (window > 0 && (total - i) <= window) recent += 1;
    }
    const drawsSinceLast = lastSeen === null ? null : total - 1 - lastSeen;
    const windowSize = window > 0 ? Math.min(window, total) : total;
    numbers[n] = {
      number: n,
      appearances,
      appearancePct: total > 0 ? phpRound((appearances / total) * 100, 2) : 0.0,
      lastAppearance: lastSeen !== null ? draws[lastSeen].drawDate : null,
      drawsSinceLast,
      currentGap: drawsSinceLast,
      avgGap: gaps.length > 0 ? phpRound(gaps.reduce((a, b) => a + b, 0) / gaps.length, 2) : null,
      minGap: gaps.length > 0 ? Math.min(...gaps) : null,
      maxGap: gaps.length > 0 ? Math.max(...gaps) : null,
      recentAppearances: recent,
      recentPct: windowSize > 0 ? phpRound((recent / windowSize) * 100, 2) : 0.0,
      // trend = recent share minus overall share; an OBSERVATION label, not a forecast
      trend: window > 0
        ? phpRound((recent / Math.max(1, windowSize)) * 100 - (total > 0 ? (appearances / total) * 100 : 0), 2)
        : 0.0,
    };
  }
  return {
    field,
    disclaimer: DISCLAIMER,
    totalDraws: total,
    window: window > 0 ? Math.min(window, total) : total,
    numbers,
  };
}

/**
 * Hot / cold by selected analysis window (spec §10). HOT/COLD are HISTORICAL
 * FREQUENCY labels for the window — explicitly not forecasts.
 */
function hotCold(draws, field, min, max, window = 50, top = 5) {
  const total = draws.length;
  const effectiveWindow = total === 0 ? 0 : Math.min(Math.max(1, window), total);
  const counts = new Map();
  for (let n = min; n <= max; n += 1) counts.set(n, 0);
  for (let i = total - effectiveWindow; i < total; i += 1) {
    for (const x of draws[i][field]) {
      if (counts.has(x)) counts.set(x, counts.get(x) + 1);
    }
  }
  const byCountDesc = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const byCountAsc = [...counts.entries()].sort((a, b) => a[1] - b[1]);
  return {
    field,
    disclaimer: DISCLAIMER,
    window: effectiveWindow,
    hot: Object.fromEntries(byCountDesc.slice(0, top)),
    cold: Object.fromEntries(byCountAsc.slice(0, top)),
    observation: `Historical frequency within the last ${effectiveWindow} draw(s) only. This does NOT predict future draws — every number keeps its exact probability each draw.`,
  };
}

/**
 * Distribution analysis over all draws (spec §12): odd/even, low/high, sum,
 * spread, consecutive numbers.
 */
/**
 * PHP's json_encode turns an EMPTY assoc array into `[]` (a JSON array), not `{}`.
 * The port reproduces that serialization so an API response with no data is
 * byte-identical to legacy's (the parity golden pins the empty-history case).
 */
function phpEmptyMap(map) {
  return Object.keys(map).length === 0 ? [] : map;
}

function distribution(draws, min, max, mainCount) {
  void mainCount; // legacy's signature carries it; the implementation never reads it
  const total = draws.length;
  const oddEven = {};
  const lowHigh = {};
  const sums = [];
  const spreads = [];
  let consecDraws = 0;
  let longestRun = 0;
  const runLengths = new Map();
  const mid = Math.floor((min + max) / 2);

  for (let i = 0; i < total; i += 1) {
    const mains = draws[i].main;
    let odds = 0;
    let lows = 0;
    let sum = 0;
    for (const x of mains) {
      if (x % 2 === 1) odds += 1; // PHP's % keeps the sign: -3 % 2 is -1, counted EVEN by legacy — kept exactly
      if (x <= mid) lows += 1;
      sum += x;
    }
    const even = mains.length - odds;
    const oKey = `${odds} odd / ${even} even`;
    oddEven[oKey] = (oddEven[oKey] ?? 0) + 1;
    const lKey = `${lows} low / ${mains.length - lows} high`;
    lowHigh[lKey] = (lowHigh[lKey] ?? 0) + 1;
    sums.push(sum);
    spreads.push(Math.max(...mains) - Math.min(...mains));

    const sorted = [...mains].sort((a, b) => a - b);
    let run = 1;
    let drawHasRun = false;
    for (let j = 1; j < sorted.length; j += 1) {
      if (sorted[j] === sorted[j - 1] + 1) {
        run += 1;
        drawHasRun = true;
      } else {
        run = 1;
      }
      if (run > longestRun) longestRun = run;
    }
    if (drawHasRun) {
      consecDraws += 1;
      // longest run in THIS draw
      let r = 1;
      let best = 1;
      for (let j = 1; j < sorted.length; j += 1) {
        r = sorted[j] === sorted[j - 1] + 1 ? r + 1 : 1;
        if (r > best) best = r;
      }
      runLengths.set(best, (runLengths.get(best) ?? 0) + 1);
    }
  }
  const sumsArr = [...sums].sort((a, b) => a - b);
  const spreadsArr = [...spreads].sort((a, b) => a - b);
  const runLengthsSorted = [...runLengths.entries()].sort((a, b) => a[0] - b[0]);

  return {
    disclaimer: DISCLAIMER,
    totalDraws: total,
    oddEven: phpEmptyMap(oddEven),
    oddEvenPct: phpEmptyMap(pct(oddEven, total)),
    lowHigh: phpEmptyMap(lowHigh),
    lowHighPct: phpEmptyMap(pct(lowHigh, total)),
    lowBound: mid,
    sum: {
      min: sumsArr.length > 0 ? sumsArr[0] : null,
      max: sumsArr.length > 0 ? sumsArr[sumsArr.length - 1] : null,
      avg: total > 0 ? phpRound(sums.reduce((a, b) => a + b, 0) / total, 2) : null,
      median: sumsArr.length > 0 ? phpMedian(sumsArr) : null,
    },
    spread: {
      min: spreadsArr.length > 0 ? spreadsArr[0] : null,
      max: spreadsArr.length > 0 ? spreadsArr[spreadsArr.length - 1] : null,
      avg: total > 0 ? phpRound(spreads.reduce((a, b) => a + b, 0) / total, 2) : null,
    },
    consecutive: {
      drawsWithConsecutive: consecDraws,
      pct: total > 0 ? phpRound((consecDraws / total) * 100, 2) : 0.0,
      longestRun,
      runLengthDistribution: phpEmptyMap(Object.fromEntries(runLengthsSorted)),
    },
  };
}

/**
 * Pair / triplet / group co-occurrence (spec §14).
 */
function groupStats(draws, field, min, max, k = 2, topN = 20) {
  void min; void max; // legacy's signature carries them; the implementation never reads them
  const total = draws.length;
  const size = Math.min(5, Math.max(2, k));
  const groups = new Map(); // key "a-b-c" (sorted) => {count, lastDraw, gaps, lastIndex}
  for (let i = 0; i < total; i += 1) {
    const nums = draws[i][field];
    for (const combo of combinations(nums, size)) {
      const sorted = [...combo].sort((a, b) => a - b);
      const key = sorted.join("-");
      if (!groups.has(key)) groups.set(key, { count: 0, lastDraw: null, gaps: [], lastIndex: null });
      const g = groups.get(key);
      g.count += 1;
      if (g.lastIndex !== null) g.gaps.push(i - g.lastIndex);
      g.lastIndex = i;
      g.lastDraw = draws[i].drawDate;
    }
  }
  const out = {};
  for (const [key, g] of groups) {
    out[key] = {
      members: key.split("-").map((value) => Number.parseInt(value, 10)),
      count: g.count,
      lastSeen: g.lastDraw,
      avgGap: g.gaps.length > 0 ? phpRound(g.gaps.reduce((a, b) => a + b, 0) / g.gaps.length, 2) : null,
      maxGap: g.gaps.length > 0 ? Math.max(...g.gaps) : null,
    };
  }
  const ordered = Object.fromEntries(
    Object.entries(out).sort((a, b) => (b[1].count - a[1].count) || (a[1].members[0] - b[1].members[0])),
  );
  return {
    field,
    disclaimer: DISCLAIMER,
    totalDraws: total,
    k: size,
    groups: Object.keys(ordered).length === 0 ? [] : ordered,
    top: phpEmptyMap(Object.fromEntries(Object.entries(ordered).slice(0, topN))),
  };
}

/** All k-combinations of a list (k<=5, small n — exhaustive). */
function combinations(values, k) {
  const out = [];
  const list = [...values];
  const acc = [];
  const walk = (start) => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    const n = list.length;
    for (let i = start; i <= n - (k - acc.length); i += 1) {
      acc.push(list[i]);
      walk(i + 1);
      acc.pop();
    }
  };
  walk(0);
  return out;
}

function pct(counts, total) {
  const out = {};
  for (const [key, value] of Object.entries(counts)) {
    out[key] = total > 0 ? phpRound((value / total) * 100, 2) : 0.0;
  }
  return out;
}

function phpMedian(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  // PHP: odd → the middle element (an int); even → ($a+$b)/2, an int when exact and
  // a float otherwise. JSON erases the int/float distinction on the wire, so a
  // JS number is the same evidence.
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}
