/**
 * The system builder — the port of `Aegis\Lottery\SystemBuilder`
 * (row 15, slice 2).
 *
 * A main-number pool of N numbers (selecting 5) and a star pool of S numbers
 * (selecting 2) define the FULL system: every valid combination of the pool.
 *
 *   line count = C(N, 5) x C(S, 2)   — computed combinatorially, NEVER hardcoded.
 *
 * Processing rules (kept from legacy, spec §18):
 *  - lines are enumerated LAZILY (a JS generator here, a PHP generator there) —
 *    constant memory, so a 200k-line system is never materialised at once
 *  - paginated windows (page/offset/limit) for interactive use
 *  - systems above SYNC_LINE_LIMIT are not dumped synchronously; the port keeps
 *    legacy's queue-to-job-run semantics (buildSystem in the service), and the
 *    background consumer is the lottery cron, which is slice 3 — the queue note
 *    says so rather than pointing at a command that does not exist yet.
 *
 * Honesty (kept verbatim):
 *  - estimated cost is NULL unless official line pricing is available — no cost
 *    is ever fabricated
 *  - a full system covers 100% of the chosen pool — coverage of the POOL, not a
 *    statement about winning
 */

import { DISCLAIMER } from "./statistics.js";

export const SYNC_LINE_LIMIT = 10_000;
export const MAX_BACKGROUND_LINES = 200_000;
export const MAX_PAGE = 500;

export function createSystemBuilder(rules) {
  if (!rules) throw new TypeError("createSystemBuilder requires rules");

  /** Validate + normalize a pool (unique in-range ints, sorted). */
  function normalizePool(valuesIn, min, max, label) {
    const out = [];
    for (const v of Array.isArray(valuesIn) ? valuesIn : []) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
        throw new TypeError(`${label} out of range ${min}-${max}: ${isPhpScalar(v) ? String(v) : "invalid"}`);
      }
      if (out.includes(v)) throw new TypeError(`duplicate ${label}: ${v}`);
      out.push(v);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  /** System plan WITHOUT enumerating lines: counts, formula, coverage, honest cost, background flag. */
  function plan(mainPoolIn, starPoolIn) {
    const mains = normalizePool(mainPoolIn, rules.mainMin(), rules.mainMax(), "pool main number");
    const stars = normalizePool(starPoolIn, rules.starMin(), rules.starMax(), "pool lucky star");
    const n = mains.length;
    const s = stars.length;
    if (n < rules.mainCount()) {
      throw new TypeError(`a system needs at least ${rules.mainCount()} main numbers in the pool (got ${n})`);
    }
    if (s < rules.starCount()) {
      throw new TypeError(`a system needs at least ${rules.starCount()} lucky stars in the pool (got ${s})`);
    }
    const mainCombos = comb(n, rules.mainCount());
    const starCombos = comb(s, rules.starCount());
    const totalLines = mainCombos * starCombos;
    return {
      lottery: rules.code(),
      mainPool: mains,
      starPool: stars,
      mainCombos,
      starCombos,
      totalLines,
      formula: `C(${n},${rules.mainCount()}) x C(${s},${rules.starCount()}) = ${mainCombos} x ${starCombos}`,
      estimatedCost: null,
      costNote: "Official line pricing is not available in this environment — no cost is fabricated.",
      coverage: {
        mainNumbersPct: 100.0,
        mainPairsPct: 100.0,
        starPairsPct: 100.0,
        note: `A full system contains every ${rules.mainCount()}-subset of the main pool and every ${rules.starCount()}-subset of the star pool: 100% coverage of the chosen pool (numbers, main pairs and star pairs). Coverage of the pool is not a statement about winning.`,
      },
      requiresBackground: totalLines > SYNC_LINE_LIMIT,
      disclaimer: DISCLAIMER,
    };
  }

  /** Lazy enumeration of every line (constant memory). Order: lexicographic main combinations, star combinations nested. */
  function* lines(mainsIn, starsIn) {
    for (const mainCombo of combinationsOf([...mainsIn], rules.mainCount())) {
      for (const starCombo of combinationsOf([...starsIn], rules.starCount())) {
        yield { mains: mainCombo, stars: starCombo };
      }
    }
  }

  /** Paginated window over the lazy enumeration. */
  function page(mains, stars, offset, limit) {
    const safeOffset = Math.max(0, offset);
    const safeLimit = Math.min(MAX_PAGE, Math.max(1, limit));
    const out = [];
    let i = 0;
    for (const line of lines(mains, stars)) {
      if (i >= safeOffset + safeLimit) break;
      if (i >= safeOffset) out.push(line);
      i += 1;
    }
    return out;
  }

  /** Materialised lines — only for bounded builds (inline + background). */
  function allLines(mains, stars) {
    return [...lines(mains, stars)];
  }

  /** Lexicographic k-subset index iterator. */
  function* combinationsOf(values, k) {
    const n = values.length;
    if (k <= 0 || k > n) return;
    const idx = [];
    for (let i = 0; i < k; i += 1) idx.push(i);
    while (true) {
      yield idx.map((i) => values[i]);
      let i = k - 1;
      while (i >= 0 && idx[i] === n - k + i) i -= 1;
      if (i < 0) return;
      idx[i] += 1;
      for (let j = i + 1; j < k; j += 1) idx[j] = idx[j - 1] + 1;
    }
  }

  return Object.freeze({ normalizePool, plan, lines, page, allLines, combinationsOf });
}

/** Binomial coefficient C(n, k) — computed, never hardcoded. */
export function comb(n, k) {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let c = 1;
  for (let i = 1; i <= kk; i += 1) {
    c = Math.trunc((c * (n - kk + i)) / i);
  }
  return c;
}

function isPhpScalar(v) {
  return ["string", "number", "boolean"].includes(typeof v);
}
