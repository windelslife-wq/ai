/**
 * The diversification engine — the port of `Aegis\Lottery\DiversificationEngine`
 * (row 15, slice 2).
 *
 * Scores how different a SET of combinations is from itself:
 *  - number / pair / triplet / star overlap between every pair of lines
 *    (pair overlap of two lines = C(|A∩B|, 2); triplet overlap = C(|A∩B|, 3)
 *    — exact, without enumerating group sets)
 *  - distribution similarity (identical odd/even or low/high splits, average
 *    absolute sum difference)
 *  - duplicate lines and repeated number pairs across the set
 *  - a single DIVERSITY SCORE (0-100): higher = more different lines.
 *
 * HONESTY CONTRACT (kept verbatim): the Diversity Score measures how different
 * the combinations are from each other. It is NOT a measure of the probability
 * of any line being drawn, or of any prize chance.
 */

import { DISCLAIMER } from "./statistics.js";
import { phpRound } from "../../lib/php.js";

export function createDiversificationEngine(rules) {
  if (!rules) throw new TypeError("createDiversificationEngine requires rules");

  /** @param {{mains: number[], stars: number[]}[]} linesIn */
  function score(linesIn) {
    const lines = [...linesIn];
    const n = lines.length;
    if (n === 0) throw new TypeError("no lines provided");
    const lowBound = Math.floor((rules.mainMin() + rules.mainMax()) / 2);

    const normalized = lines.map((line, i) => {
      const mains = [...(Array.isArray(line?.mains) ? line.mains : [])];
      const stars = [...(Array.isArray(line?.stars) ? line.stars : [])];
      const check = rules.validateLine(mains, stars);
      if (!check.valid) {
        throw new TypeError(`line ${i + 1} invalid: ${check.errors.join("; ")}`);
      }
      mains.sort((a, b) => a - b);
      stars.sort((a, b) => a - b);
      return { mains, stars };
    });

    let pairCount = 0;
    let sumMain = 0;
    let maxMain = 0;
    let sumStar = 0;
    let maxStar = 0;
    let sumPairs = 0;
    let maxPairs = 0;
    let sumTriples = 0;
    let maxTriples = 0;
    let sameOE = 0;
    let sameLH = 0;
    let sumAbsDiff = 0;
    let identicalPairs = 0;

    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const a = normalized[i];
        const b = normalized[j];
        const sharedMain = a.mains.filter((x) => b.mains.includes(x)).length;
        const sharedStar = a.stars.filter((x) => b.stars.includes(x)).length;
        const sharedPairs = comb2(sharedMain);
        const sharedTriples = comb3(sharedMain);
        pairCount += 1;
        sumMain += sharedMain;
        maxMain = Math.max(maxMain, sharedMain);
        sumStar += sharedStar;
        maxStar = Math.max(maxStar, sharedStar);
        sumPairs += sharedPairs;
        maxPairs = Math.max(maxPairs, sharedPairs);
        sumTriples += sharedTriples;
        maxTriples = Math.max(maxTriples, sharedTriples);
        const oa = a.mains.filter((x) => x % 2 === 1).length;
        const ob = b.mains.filter((x) => x % 2 === 1).length;
        if (oa === ob) sameOE += 1;
        const la = a.mains.filter((x) => x <= lowBound).length;
        const lb = b.mains.filter((x) => x <= lowBound).length;
        if (la === lb) sameLH += 1;
        sumAbsDiff += Math.abs(a.mains.reduce((s, x) => s + x, 0) - b.mains.reduce((s, x) => s + x, 0));
        if (a.mains.join(",") === b.mains.join(",") && a.stars.join(",") === b.stars.join(",")) identicalPairs += 1;
      }
    }

    // duplicates: lines that appear more than once
    const keys = new Set(normalized.map((line) => `${line.mains.join(",")}|${line.stars.join(",")}`));
    const duplicates = n - keys.size;

    // pair reuse across the whole set
    const pairInstances = new Set();
    for (const line of normalized) {
      for (const p of pairsOf(line.mains)) pairInstances.add(p);
    }
    const totalPairInstances = n * comb2(rules.mainCount());
    const uniquePairs = pairInstances.size;
    const reusedShare = totalPairInstances > 0 ? phpRound(((totalPairInstances - uniquePairs) / totalPairInstances) * 100, 2) : 0.0;

    const avgMain = pairCount > 0 ? phpRound(sumMain / pairCount, 3) : 0.0;
    const avgStar = pairCount > 0 ? phpRound(sumStar / pairCount, 3) : 0.0;
    const avgPairs = pairCount > 0 ? phpRound(sumPairs / pairCount, 3) : 0.0;
    const avgTriples = pairCount > 0 ? phpRound(sumTriples / pairCount, 3) : 0.0;
    const sameOEPct = pairCount > 0 ? phpRound((sameOE / pairCount) * 100, 2) : 0.0;
    const sameLHPct = pairCount > 0 ? phpRound((sameLH / pairCount) * 100, 2) : 0.0;
    const avgAbsSumDiff = pairCount > 0 ? phpRound(sumAbsDiff / pairCount, 2) : 0.0;

    // diversity score: 100 minus overlap/similarity penalties
    let penalty = 0.0;
    penalty += 45 * (avgMain / rules.mainCount());
    penalty += 15 * (avgStar / rules.starCount());
    penalty += 10 * (sameOEPct / 100);
    penalty += 10 * (sameLHPct / 100);
    penalty += 5 * (1 - Math.min(1.0, avgAbsSumDiff / 30));
    penalty += 30 * (identicalPairs / Math.max(1, pairCount));
    const diversityScore = Math.trunc(phpRound(clamp(100 - penalty, 0, 100)));

    return {
      lineCount: n,
      duplicates,
      overlaps: {
        linePairs: pairCount,
        averageMain: avgMain,
        maxMain,
        averageStar: avgStar,
        maxStar,
        averageMainPairs: avgPairs,
        maxMainPairs: maxPairs,
        averageMainTriplets: avgTriples,
        maxMainTriplets: maxTriples,
      },
      distributionSimilarity: {
        sameOddEvenPct: sameOEPct,
        sameLowHighPct: sameLHPct,
        avgAbsSumDiff,
      },
      pairReuse: {
        totalPairInstances,
        uniquePairs,
        reusedSharePct: reusedShare,
      },
      diversityScore,
      scoreLabel: `DIVERSITY SCORE: ${diversityScore}/100`,
      scoreMeaning:
        "How different the combinations are from each other (number, pair, triplet and star overlap plus distribution similarity). It is NOT a measure of how likely any line is to be drawn.",
      disclaimer: DISCLAIMER,
    };
  }

  return Object.freeze({ score });
}

/** All sorted "a-b" pair keys of a sorted line. */
function pairsOf(mains) {
  const out = [];
  for (let i = 0; i < mains.length; i += 1) {
    for (let j = i + 1; j < mains.length; j += 1) {
      out.push(`${mains[i]}-${mains[j]}`);
    }
  }
  return out;
}

function comb2(k) {
  return k < 2 ? 0 : Math.trunc((k * (k - 1)) / 2);
}

function comb3(k) {
  return k < 3 ? 0 : Math.trunc((k * (k - 1) * (k - 2)) / 6);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
