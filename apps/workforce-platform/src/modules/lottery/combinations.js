/**
 * The combination analyzer — the port of `Aegis\Lottery\CombinationAnalyzer`
 * (row 15, slice 2). Full statistical profile of one complete line (5 mains +
 * 2 stars) against stored historical draws: composition (odd/even, low/high),
 * sum and spread with historical context, consecutive patterns, per-number
 * historical profiles, historical similarity, pattern traits and a clearly
 * labelled STATISTICAL BALANCE SCORE.
 *
 * HONESTY CONTRACT (legacy's own, spec §16/§17/§41 — kept verbatim):
 *  - Every field is a HISTORICAL OBSERVATION about past draws.
 *  - The score is labelled "STATISTICAL BALANCE SCORE: N/100". It measures how
 *    closely the line's composition matches typical historical draws. It is NOT
 *    a probability and it never uses win-chance wording.
 *  - No "due" concept: a number absent for X draws is only reported as absent
 *    for X draws.
 *
 * Numeric fidelity: every rounded value goes through `phpRound` (half away from
 * zero), PHP's `x % 2 === 1` odd test is kept for non-negative pool values (all
 * rule values are ≥ 1 here, so PHP's negative-modulo quirk cannot arise), and
 * `MathUtils::mean`/`stdev` semantics are local — `mean([])` is null, `stdev`
 * of fewer than two samples is null (the caller substitutes 0.0 exactly where
 * legacy does).
 */

import { DISCLAIMER } from "./statistics.js";
import { phpRound } from "../../lib/php.js";

/** Documented score-component weights (legacy's const, sum to 1.0). */
export const ANALYZER_WEIGHTS = Object.freeze({
  sum: 0.3,
  oddEven: 0.2,
  lowHigh: 0.2,
  spread: 0.15,
  consecutives: 0.15,
});

/** `Aegis\MathUtils::mean` — null for an empty list, else the arithmetic mean. */
export function mathMean(values) {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

/** `Aegis\MathUtils::stdev` — population stdev; null below two samples. */
export function mathStdev(values) {
  if (values.length < 2) return null;
  const m = mathMean(values);
  let acc = 0;
  for (const x of values) acc += (x - m) ** 2;
  return Math.sqrt(acc / values.length);
}

export function createCombinationAnalyzer(rules, statistics = null) {
  if (!rules) throw new TypeError("createCombinationAnalyzer requires rules");
  const stats = statistics ?? createAnalyzerStatistics();

  /**
   * @param {number[]} mainsIn
   * @param {number[]} starsIn
   * @param {{drawDate: string, main: number[], stars: number[]}[]} draws oldest first
   */
  function analyze(mainsIn, starsIn, draws) {
    const check = rules.validateLine([...mainsIn], [...starsIn]);
    if (!check.valid) {
      throw new TypeError(`invalid line: ${check.errors.join("; ")}`);
    }
    const mains = [...mainsIn].sort((a, b) => a - b);
    const stars = [...starsIn].sort((a, b) => a - b);
    const total = draws.length;
    const lowBound = Math.floor((rules.mainMin() + rules.mainMax()) / 2);

    // ---------------------------------------------------- composition
    const odd = mains.filter((x) => x % 2 === 1).length;
    const even = mains.length - odd;
    const low = mains.filter((x) => x <= lowBound).length;
    const high = mains.length - low;
    const sum = mains.reduce((a, b) => a + b, 0);
    const spread = Math.max(...mains) - Math.min(...mains);

    let adjacentPairs = 0;
    let longestRun = 1;
    let runs3plus = 0;
    let run = 1;
    for (let i = 1; i < mains.length; i += 1) {
      if (mains[i] === mains[i - 1] + 1) {
        adjacentPairs += 1;
        run += 1;
        if (run > longestRun) longestRun = run;
      } else {
        if (run >= 3) runs3plus += 1;
        run = 1;
      }
    }
    if (run >= 3) runs3plus += 1;

    // ------------------------------------------------ pattern traits
    const lastDigits = new Set(mains.map((x) => x % 10));
    const birthdayCount = mains.filter((x) => x >= 1 && x <= 31).length;
    const multiplesOf5 = mains.filter((x) => x % 5 === 0).length;

    // ------------------------------------------- historical context
    const histSums = [];
    const histSpreads = [];
    const oddCounts = new Map(); // insertion-ordered, like PHP's assoc array
    const lowCounts = new Map();
    const mainSet = new Set(mains);
    let bestMatch = null;
    let share3plus = 0;
    let sameOE = 0;
    let sumWithin10 = 0;
    for (const d of draws) {
      const m = [...d.main].sort((a, b) => a - b);
      const dSum = m.reduce((a, b) => a + b, 0);
      const dSpread = Math.max(...m) - Math.min(...m);
      const dOdd = m.filter((x) => x % 2 === 1).length;
      const dLow = m.filter((x) => x <= lowBound).length;
      histSums.push(dSum);
      histSpreads.push(dSpread);
      oddCounts.set(dOdd, (oddCounts.get(dOdd) ?? 0) + 1);
      lowCounts.set(dLow, (lowCounts.get(dLow) ?? 0) + 1);
      const overlap = m.filter((x) => mainSet.has(x)).length;
      if (overlap >= 3) share3plus += 1;
      if (dOdd === odd) sameOE += 1;
      if (Math.abs(dSum - sum) <= 10) sumWithin10 += 1;
      if (bestMatch === null || overlap > bestMatch.overlap) {
        bestMatch = { drawDate: String(d.drawDate), overlap };
      }
    }
    const sumAvg = mathMean(histSums);
    const sumStd = mathStdev(histSums) ?? 0.0;
    const spreadAvg = mathMean(histSpreads);
    const halfCount = mains.length / 2;
    const bestOdd = total > 0 ? bestMode(oddCounts, halfCount) : Math.round(halfCount);
    const bestLow = total > 0 ? bestMode(lowCounts, halfCount) : Math.round(halfCount);
    const sumPct = total > 0 ? phpRound((histSums.filter((s) => s <= sum).length / total) * 100, 2) : null;
    const spreadPct = total > 0 ? phpRound((histSpreads.filter((s) => s <= spread).length / total) * 100, 2) : null;

    // ------------------------------------------------ balance score
    let score;
    let breakdown;
    if (total === 0) {
      score = 50;
      breakdown = { note: "no historical data — neutral score" };
    } else {
      const sumFit =
        sumStd > 0
          ? Math.max(0.0, 100 * (1 - Math.abs(sum - sumAvg) / (2 * sumStd)))
          : sum === sumAvg
            ? 100.0
            : 50.0;
      const oddEvenFit = Math.max(0, 100 - 20 * Math.abs(odd - bestOdd));
      const lowHighFit = Math.max(0, 100 - 20 * Math.abs(low - bestLow));
      const spreadFit = spreadAvg > 0 ? Math.max(0.0, 100 * (1 - Math.abs(spread - spreadAvg) / spreadAvg)) : 100.0;
      const consecFit = Math.max(0, 100 - 25 * adjacentPairs);
      const w = ANALYZER_WEIGHTS;
      // PHP: (int) round($w['sum'] * $sumFit + …) — round half away from zero,
      // then the (int) cast truncates the (already integral) float.
      score = Math.trunc(
        phpRound(w.sum * sumFit + w.oddEven * oddEvenFit + w.lowHigh * lowHighFit + w.spread * spreadFit + w.consecutives * consecFit),
      );
      breakdown = {
        sumFit: phpRound(sumFit, 1),
        oddEvenFit,
        lowHighFit,
        spreadFit: phpRound(spreadFit, 1),
        consecutivesFit: consecFit,
      };
    }

    // ------------------------------------------- number/star profiles
    const numberStats = stats.numberStats(draws, rules.mainMin(), rules.mainMax());
    const starStats = stats.starStats(draws, rules.starMin(), rules.starMax());
    const numberProfile = mains.map((n) => numberStats.numbers[n]);
    const starProfile = stars.map((n) => starStats.numbers[n]);

    return {
      mains,
      stars,
      composition: {
        oddEven: { odd, even, label: `${odd} odd / ${even} even` },
        lowHigh: { low, high, lowBound, label: `${low} low / ${high} high` },
        sum: {
          value: sum,
          historical: {
            min: total > 0 ? Math.min(...histSums) : null,
            max: total > 0 ? Math.max(...histSums) : null,
            avg: sumAvg !== null ? phpRound(sumAvg, 2) : null,
            percentile: sumPct,
          },
        },
        spread: {
          value: spread,
          historical: {
            min: total > 0 ? Math.min(...histSpreads) : null,
            max: total > 0 ? Math.max(...histSpreads) : null,
            avg: spreadAvg !== null ? phpRound(spreadAvg, 2) : null,
            percentile: spreadPct,
          },
        },
        consecutives: { adjacentPairs, longestRun, runsOf3Plus: runs3plus },
      },
      patternCharacteristics: {
        allSameLastDigit: lastDigits.size === 1,
        withinSingleDecade: Math.max(...mains) - Math.min(...mains) < 10,
        birthdayCount,
        birthdayNote: `${birthdayCount} of ${mains.length} mains fall in the 1-31 birthday range`,
        multiplesOf5,
        note: "Pattern traits describe how selections with these characteristics appear in historical draws. They do not change the odds of this line being drawn.",
      },
      numberProfile,
      starProfile,
      historicalSimilarity: {
        bestNumberOverlap: bestMatch !== null ? bestMatch.overlap : 0,
        bestMatch,
        drawsSharing3PlusNumbers: share3plus,
        sameOddEvenDraws: sameOE,
        sameOddEvenPct: total > 0 ? phpRound((sameOE / total) * 100, 2) : 0.0,
        sumWithin10: { draws: sumWithin10, pct: total > 0 ? phpRound((sumWithin10 / total) * 100, 2) : 0.0 },
        note: "Similarity with past draws is a historical observation only — past draws do not influence future draws.",
      },
      balanceScore: score,
      scoreBreakdown: breakdown,
      scoreLabel: `STATISTICAL BALANCE SCORE: ${score}/100`,
      scoreMeaning:
        "How closely this line matches typical historical draw composition (sum, odd/even, low/high, spread, consecutive patterns). It is NOT a probability and it does not indicate how likely the line is to be drawn.",
      disclaimer: DISCLAIMER,
    };
  }

  return Object.freeze({ analyze });
}

/** Mode of a count distribution; ties resolve toward the value nearest $ideal, then the smaller. */
export function bestMode(counts, ideal) {
  let best = null;
  for (const [key, value] of counts) {
    const k = Number(key);
    if (best === null) {
      best = k;
      continue;
    }
    const cmp = Math.trunc(value) < Math.trunc(counts.get(best)) ? -1 : Math.trunc(value) > Math.trunc(counts.get(best)) ? 1 : 0;
    if (cmp > 0) {
      best = k;
    } else if (cmp === 0) {
      if (Math.abs(k - ideal) < Math.abs(best - ideal)) best = k;
      else if (Math.abs(k - ideal) === Math.abs(best - ideal) && k < best) best = k;
    }
  }
  return best;
}

function createAnalyzerStatistics() {
  // Imported lazily to keep this module's dependency list explicit at the top.
  const { createLotteryStatisticsEngine } = statisticsModule;
  return createLotteryStatisticsEngine();
}

import * as statisticsModule from "./statistics.js";
