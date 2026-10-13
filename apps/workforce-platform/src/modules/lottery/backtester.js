/**
 * The lottery backtester — "Strategy Lab" (row 15, slice 4; legacy
 * `Aegis/Lottery/LotteryBacktester.php`, 192 lines, ported whole).
 *
 * A STRATEGY is a deterministic line-generation rule replayed against
 * historical draws WITHOUT look-ahead: for test draw i the strategy only
 * sees draws 1..i-1. Every line is compared with draw i (main/star match
 * counts + the official prize-tier LABEL — never an amount).
 *
 * Built-in strategies (all seeded, deterministic per strategy+draw+model):
 *  - RANDOM_BASELINE   spec §25: always available — prevents ordinary
 *                      random variation from being read as strategy value
 *  - BALANCED_PROFILE  BALANCED-mode generation against pre-draw history
 *  - HISTORICAL_FREQ   HISTORICAL-mode (frequency-weighted) generation
 *  - ANTI_POPULAR      ANTI-POPULAR-mode generation
 *
 * HONESTY CONTRACT (spec §23/§24/§25/§34):
 *  - Reports are labelled HISTORICAL SIMULATION.
 *  - Simulated cost/winnings stay NULL while official line pricing and
 *    prize amounts are unavailable — nothing is fabricated. Only tier
 *    counts are reported (the official tier structure is stable).
 *  - Strategies are compared on the SAME period; no strategy is declared
 *    "better" — differences in historical tier counts are descriptive,
 *    and the random baseline is always reported alongside.
 *
 * The differential golden pins `run` and `compare` to PHP byte-for-byte,
 * including the per-test-draw seed, which mixes CRC-32 of the strategy
 * name and of the model-version string with the draw index. `crc32` is
 * the sports provider's PHP-verified implementation (the standard check
 * value for "123456789" is 0xCBF43926 there).
 */

import { crc32 } from "../sports/providers/sandbox.js";
import { DISCLAIMER } from "./statistics.js";
// prizeTier is the official ladder exported pure from the service (a call-time
// use — the same safe engine<->service cycle the generator has had since slice 2;
// nothing here touches it at module scope).
import { prizeTier } from "./service.js";

export const BACKTESTER_STRATEGIES = Object.freeze([
  "RANDOM_BASELINE",
  "BALANCED_PROFILE",
  "HISTORICAL_FREQ",
  "ANTI_POPULAR",
]);

/** Minimum pre-draw history before the first test draw. */
export const BACKTESTER_MIN_HISTORY = 10;
/** Maximum test-draws per run (spec §23: "e.g. the last 100"). */
export const BACKTESTER_MAX_WINDOW = 100;
export const BACKTESTER_MAX_LINES = 10;

const STRATEGY_MODES = Object.freeze({
  RANDOM_BASELINE: "RANDOM",
  BALANCED_PROFILE: "BALANCED",
  HISTORICAL_FREQ: "HISTORICAL",
  ANTI_POPULAR: "ANTI-POPULAR",
});

export const BACKTESTER_DESCRIPTIONS = Object.freeze({
  RANDOM_BASELINE:
    "Uniform random lines (seeded per draw). The mandatory baseline — it shows how often each outcome happens by chance alone.",
  BALANCED_PROFILE:
    "BALANCED-mode lines: profile-filtered against the pre-draw historical distribution.",
  HISTORICAL_FREQ:
    "HISTORICAL-mode lines: frequency-weighted sampling from the pre-draw history.",
  ANTI_POPULAR:
    "ANTI-POPULAR-mode lines: avoids common human selection patterns.",
});

/**
 * Legacy extracts the tier rank as `(int) substr($tier, 5, 1)` — the FIRST
 * character after `TIER_`. For `TIER_1`…`TIER_9` that is the rank; for
 * `TIER_10 (2 stars)` it reads `'1'`, i.e. the worst prize tier is treated as
 * rank 1 (the best) when the best-line tracker sees it. That is legacy's own
 * behaviour, kept byte-for-byte (the differential golden pins it via
 * `rankOf`), recorded as finding F-45 — the port does not silently "fix"
 * operator-visible behaviour. With no prize amounts anywhere, the only
 * effect is which line the report calls `bestLine`.
 *
 * @param {string} tier a prizeTier label
 * @returns {number}
 */
export function tierRank(tier) {
  return Number(String(tier).charAt(5));
}

/**
 * Deterministic seed for strategy + test-draw index (documented, reproducible):
 * legacy mixes CRC-32 of the strategy name and of `WINDELS-Lottery-Model-v…`
 * with `index * 2654435761` (the Knuth constant), each masked to 31 bits and
 * XORed. `index * 2654435761` stays below 2^53 for every index the caps allow
 * (≤ 100000), so double multiplication is exact and `% 0x80000000` is the same
 * value PHP's 64-bit `& 0x7FFFFFFF` produces. A zero seed becomes 1 — the
 * generator's own normalization would do it too, but legacy does it here.
 *
 * @param {string} strategy
 * @param {number} drawIndex
 * @param {string} modelVersion
 * @returns {number} 1 … 0x7fffffff
 */
export function strategySeed(strategy, drawIndex, modelVersion) {
  let seed =
    (crc32(strategy) % 0x80000000) ^
    ((Math.trunc(drawIndex) * 2654435761) % 0x80000000) ^
    (crc32(`WINDELS-Lottery-Model-v${modelVersion}`) % 0x80000000);
  seed = Math.abs(seed) % 0x80000000;
  if (seed === 0) seed = 1;
  return seed;
}

/**
 * @param {object} rules the resolved lottery rules
 * @param {object} _analyzer legacy's constructor takes the analyzer but its
 *   methods never call it — kept in the signature so the wiring reads the same
 *   on both sides of the parity record.
 * @param {object} generator the slice-2 combination generator
 * @param {string} modelVersion
 */
export function createLotteryBacktester(rules, _analyzer, generator, modelVersion) {
  /**
   * @param {{drawDate:string, main:number[], stars:number[]}[]} draws oldest first (full stored history)
   * @returns {object} HISTORICAL SIMULATION report
   */
  function run(draws, strategy, lines = 1, window = 0) {
    if (!BACKTESTER_STRATEGIES.includes(strategy)) {
      throw new TypeError(
        `unknown strategy: ${strategy} (expected ${BACKTESTER_STRATEGIES.join(", ")})`,
      );
    }
    const perDrawCount = Math.min(BACKTESTER_MAX_LINES, Math.max(1, Math.trunc(Number(lines)) || 1));
    const total = draws.length;
    if (total < BACKTESTER_MIN_HISTORY + 1) {
      throw new TypeError(
        `backtesting needs at least ${BACKTESTER_MIN_HISTORY + 1} stored draws (got ${total})`,
      );
    }
    const windowDraws = Math.min(
      BACKTESTER_MAX_WINDOW,
      window > 0 ? Math.trunc(Number(window)) : BACKTESTER_MAX_WINDOW,
    );
    const startIdx = Math.max(BACKTESTER_MIN_HISTORY, total - windowDraws);

    const perDraw = [];
    // The distributions are PLAIN ARRAYS (index = match count): PHP declares
    // them with sequential 0-based keys, so json_encode sends them onward as
    // JSON lists — and so does this port. tierCounts, keyed by the label
    // strings, is the one object-shaped aggregate.
    const mainDist = [0, 0, 0, 0, 0, 0];
    const starDist = [0, 0, 0];
    const tierCounts = {};
    let best = null;
    let bestRank = 11; // TIER_1 is rank 1 (best)

    for (let i = startIdx; i < total; i++) {
      const history = draws.slice(0, i); // NO look-ahead: draw i excluded
      const generated = strategyLines(strategy, history, i, perDrawCount);
      const draw = draws[i];
      const drawMains = new Set(draw.main.map((value) => Math.trunc(Number(value))));
      const drawStars = new Set(draw.stars.map((value) => Math.trunc(Number(value))));
      const lineResults = [];
      for (const line of generated) {
        const mainMatches = line.mains.filter((m) => drawMains.has(m)).length;
        const starMatches = line.stars.filter((s) => drawStars.has(s)).length;
        const tier = prizeTier(mainMatches, starMatches);
        mainDist[mainMatches] += 1;
        starDist[starMatches] += 1;
        if (tier !== null) tierCounts[tier] = (tierCounts[tier] ?? 0) + 1;
        const lineResult = {
          mains: line.mains,
          stars: line.stars,
          mainMatches,
          starMatches,
          prizeTier: tier,
        };
        lineResults.push(lineResult);
        if (tier !== null) {
          const rank = tierRank(tier); // F-45: legacy's substr(tier, 5, 1), kept
          if (rank < bestRank) {
            bestRank = rank;
            best = { drawDate: String(draw.drawDate), line: lineResult };
          }
        }
      }
      perDraw.push({
        drawDate: String(draw.drawDate),
        historySize: i,
        lines: lineResults,
      });
    }
    // PHP ksort() on the string tier keys — plain string order, NOT numeric
    // ("TIER_1 …" < "TIER_10 …" < "TIER_2 …"), which is default Array#sort on
    // those keys. An EMPTY ksorted PHP array json_encodes as [], not {} — the
    // empty case keeps that shape so both sides emit byte-identical reports.
    const sortedEntries = Object.entries(tierCounts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sortedTiers = sortedEntries.length > 0 ? Object.fromEntries(sortedEntries) : [];

    return {
      label: "HISTORICAL SIMULATION",
      strategy,
      strategyDescription: BACKTESTER_DESCRIPTIONS[strategy],
      modelVersion,
      lottery: rules.code(),
      period: {
        from: String(draws[startIdx].drawDate),
        to: String(draws[total - 1].drawDate),
        drawsTested: total - startIdx,
        minHistoryDraws: startIdx,
        windowCap: BACKTESTER_MAX_WINDOW,
      },
      linesPerDraw: perDrawCount,
      totalLines: (total - startIdx) * perDrawCount,
      matchDistribution: { mains: mainDist, stars: starDist },
      tierCounts: sortedTiers,
      bestLine: best,
      simulatedCost: null,
      costNote: "Official line pricing is not available in this environment — no cost is fabricated.",
      simulatedWinnings: null,
      winningsNote:
        "Official prize amounts vary per draw and are unavailable — only tier counts are reported; no winnings figure is fabricated.",
      perDraw,
      disclaimer: DISCLAIMER,
      note: "Historical simulation: the strategy was replayed against past draws without look-ahead. Past tier counts are descriptive — they do not improve future results. The random baseline exists so ordinary random variation is never mistaken for strategy value (spec §25).",
    };
  }

  /**
   * Strategy comparison on the SAME period (spec §24): every strategy is
   * replayed over identical draws, so differences are comparable — but
   * none is declared "better" (spec §34).
   * @param {{drawDate:string, main:number[], stars:number[]}[]} draws oldest first
   * @param {string[]} strategies must include RANDOM_BASELINE
   */
  function compare(draws, strategies, lines = 1, window = 0) {
    const unique = [...new Set(strategies.map((s) => String(s).toUpperCase()))];
    if (unique.length === 0) throw new TypeError("at least one strategy is required");
    if (!unique.includes("RANDOM_BASELINE")) {
      throw new TypeError("the random baseline must be part of every comparison (spec §25)");
    }
    for (const s of unique) {
      if (!BACKTESTER_STRATEGIES.includes(s)) throw new TypeError(`unknown strategy: ${s}`);
    }
    const reports = [];
    let period = null;
    for (const s of unique) {
      const r = run(draws, s, lines, window);
      reports.push(r);
      period = r.period;
    }
    return {
      label: "HISTORICAL SIMULATION — strategy comparison",
      lottery: rules.code(),
      modelVersion,
      period,
      // Legacy reports the argument AS GIVEN here (only `run` clamps): the
      // controller's `(int)($body['lines'] ?: 1)` is what arrives, and no
      // second normalization happens on this level.
      linesPerDraw: Math.trunc(Number(lines)),
      strategies: reports,
      note: "All strategies are replayed on the SAME period, including the mandatory random baseline. Differences in tier counts are descriptive only; with no official prize amounts and independent random draws, no strategy is declared \"better\" (spec §24/§34).",
      disclaimer: DISCLAIMER,
    };
  }

  /**
   * Deterministic lines for strategy + test-draw index: seed derived from
   * strategy name + index + model version (documented, reproducible).
   * @returns {{mains:number[], stars:number[]}[]}
   */
  function strategyLines(strategy, history, drawIndex, lines) {
    const seed = strategySeed(strategy, drawIndex, modelVersion);
    return generator.generate(history, {
      mode: STRATEGY_MODES[strategy],
      count: lines,
      seed,
    }).lines;
  }

  return Object.freeze({ run, compare });
}
