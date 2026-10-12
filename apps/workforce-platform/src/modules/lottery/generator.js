/**
 * The AI combination generator — the port of `Aegis\Lottery\CombinationGenerator`
 * (row 15, slice 2).
 *
 * Modes (legacy's own):
 *  - RANDOM        uniform seeded sampling, no constraints
 *  - BALANCED      profile-filtered sampling against the historical distribution
 *                  (sum within ±1 historical std, odd/even and low/high within
 *                  ±1 of the most common historical split, at most 1 adjacent pair)
 *  - HISTORICAL    frequency-weighted sampling (weight = 1 + appearances)
 *  - DIVERSIFIED   minimum-overlap greedy selection against context lines
 *  - ANTI-POPULAR  constrained sampling avoiding common human selection patterns
 *
 * LOCK / EXCLUDE: every mode respects locked numbers (always present) and
 * excluded numbers (never present), validated up front with legacy's exact
 * error strings.
 *
 * HONESTY CONTRACT (kept verbatim from legacy, spec §15/§17/§41):
 *  - Every valid EuroMillions combination has the same mathematical chance of
 *    being drawn. No mode increases that chance. The report says so.
 *  - Scores are labelled STATISTICAL BALANCE SCORE — never a probability of a
 *    line being drawn.
 *  - The AI decision report records the ACTUAL inputs used (mode, seed,
 *    constraints, factors, model version, method) — never invented after the fact.
 *  - Reproducible: the same seed + inputs yield the same lines (the xorshift32
 *    PRNG ported in slice 1, bit-identical to PHP's).
 */

import { DISCLAIMER } from "./statistics.js";
import { phpRound } from "../../lib/php.js";
import { createCombinationAnalyzer, bestMode, mathMean, mathStdev } from "./combinations.js";
import { MODEL_VERSION } from "./service.js";

export const GENERATOR_MODES = Object.freeze(["RANDOM", "BALANCED", "HISTORICAL", "DIVERSIFIED", "ANTI-POPULAR"]);
export const GENERATOR_MAX_LINES = 100;

export function createCombinationGenerator(rules, analyzer, statistics = null, modelVersion = MODEL_VERSION) {
  if (!rules) throw new TypeError("createCombinationGenerator requires rules");
  if (!analyzer) throw new TypeError("createCombinationGenerator requires an analyzer");
  const stats = statistics ?? createGeneratorStatistics();

  /**
   * @param {{drawDate: string, main: number[], stars: number[]}[]} draws oldest first
   * @param {{mode?: string, count?: number, seed?: number|null,
   *          locks?: {mains?: number[], stars?: number[]},
   *          excludes?: {mains?: number[], stars?: number[]},
   *          contextLines?: {mains: number[], stars: number[]}[]}} [opts]
   * @returns {object} the AI combination report + decision report (spec §16/§26)
   */
  function generate(draws, opts = {}) {
    const mode = String(opts.mode ?? "RANDOM").toUpperCase();
    if (!GENERATOR_MODES.includes(mode)) {
      throw new TypeError(`unknown generation mode: ${mode} (expected ${GENERATOR_MODES.join(", ")})`);
    }
    const count = Math.min(GENERATOR_MAX_LINES, Math.max(1, Math.trunc(Number(opts.count ?? 1)) || 0) || 1);
    // Legacy: ((int)$seed) & 0x7FFFFFFF, or microseconds of the clock when absent.
    const seed =
      opts.seed !== undefined && opts.seed !== null
        ? Math.trunc(Number(opts.seed)) & 0x7fffffff
        : Math.floor(Date.now() * 1000) % 2147483647;
    const normalizedSeed = seed === 0 ? 1 : seed;
    const rand = createGeneratorRandom(normalizedSeed);

    // ------------------------------------------------ locks / excludes
    const locksM = normalizeField(opts.locks?.mains ?? [], rules.mainMin(), rules.mainMax(), "locked main");
    const locksS = normalizeField(opts.locks?.stars ?? [], rules.starMin(), rules.starMax(), "locked star");
    const exclM = normalizeField(opts.excludes?.mains ?? [], rules.mainMin(), rules.mainMax(), "excluded main");
    const exclS = normalizeField(opts.excludes?.stars ?? [], rules.starMin(), rules.starMax(), "excluded star");
    if (locksM.length > rules.mainCount()) throw new TypeError(`cannot lock more than ${rules.mainCount()} main numbers`);
    if (locksS.length > rules.starCount()) throw new TypeError(`cannot lock more than ${rules.starCount()} lucky stars`);
    if (locksM.filter((l) => exclM.includes(l)).length !== 0) throw new TypeError("a main number is both locked and excluded");
    if (locksS.filter((l) => exclS.includes(l)).length !== 0) throw new TypeError("a lucky star is both locked and excluded");
    const poolM = range(rules.mainMin(), rules.mainMax()).filter((n) => !exclM.includes(n));
    const poolS = range(rules.starMin(), rules.starMax()).filter((n) => !exclS.includes(n));
    for (const l of locksM) if (!poolM.includes(l)) throw new TypeError(`locked main ${l} is outside the allowed pool`);
    for (const l of locksS) if (!poolS.includes(l)) throw new TypeError(`locked star ${l} is outside the allowed pool`);
    if (poolM.length < rules.mainCount()) throw new TypeError("not enough main numbers remain after exclusions");
    if (poolS.length < rules.starCount()) throw new TypeError("not enough lucky stars remain after exclusions");

    // ------------------------------------------------ historical data
    const context = [...(opts.contextLines ?? [])];
    let numberStats = null;
    let starStats = null;
    if (mode === "HISTORICAL") {
      numberStats = stats.numberStats(draws, rules.mainMin(), rules.mainMax());
      starStats = stats.starStats(draws, rules.starMin(), rules.starMax());
    }
    let targets = null;
    let balBasis = null;
    if (mode === "BALANCED" && draws.length > 0) {
      const sums = draws.map((d) => d.main.reduce((a, b) => a + b, 0));
      const sumAvg = mathMean(sums);
      const sumStd = mathStdev(sums) ?? 0.0;
      const lowBound = Math.floor((rules.mainMin() + rules.mainMax()) / 2);
      const oddCounts = new Map();
      const lowCounts = new Map();
      for (const d of draws) {
        const oddCount = d.main.filter((x) => x % 2 === 1).length;
        oddCounts.set(oddCount, (oddCounts.get(oddCount) ?? 0) + 1);
        const lowCount = d.main.filter((x) => x <= lowBound).length;
        lowCounts.set(lowCount, (lowCounts.get(lowCount) ?? 0) + 1);
      }
      const bestOdd = bestMode(oddCounts, rules.mainCount() / 2);
      const bestLow = bestMode(lowCounts, rules.mainCount() / 2);
      targets = {
        sumRange: [phpRound(sumAvg - sumStd, 1), phpRound(sumAvg + sumStd, 1)],
        oddRange: [Math.max(0, bestOdd - 1), Math.min(rules.mainCount(), bestOdd + 1)],
        lowRange: [Math.max(0, bestLow - 1), Math.min(rules.mainCount(), bestLow + 1)],
        maxAdjacentPairs: 1,
        lowBound,
      };
      balBasis = {
        drawsUsed: draws.length,
        sumAvg: phpRound(sumAvg, 2),
        sumStd: phpRound(sumStd, 2),
        mostCommonOddEven: `${bestOdd} odd / ${rules.mainCount() - bestOdd} even`,
        mostCommonLowHigh: `${bestLow} low / ${rules.mainCount() - bestLow} high`,
      };
    }

    // ------------------------------------------------ sample the lines
    const lines = [];
    for (let i = 0; i < count; i += 1) {
      const kMax = mode === "RANDOM" ? 1 : mode === "HISTORICAL" ? 1 : mode === "DIVERSIFIED" ? 24 : mode === "BALANCED" ? 60 : 80;
      const passing = [];
      const all = [];
      let k = 0;
      while (k < kMax && (passing.length === 0 || mode === "DIVERSIFIED")) {
        k += 1;
        const cm = sampleField(rand, poolM, rules.mainCount() - locksM.length, locksM, mode, numberStats);
        const cs = sampleField(rand, poolS, rules.starCount() - locksS.length, locksS, mode, starStats);
        cm.sort((a, b) => a - b);
        cs.sort((a, b) => a - b);
        all.push([cm, cs]);
        if (mode === "BALANCED" && targets !== null && !balancedOk(cm, targets)) continue;
        if (mode === "ANTI-POPULAR" && !antiPopularOk(cm)) continue;
        passing.push([cm, cs]);
        if (mode === "RANDOM" || mode === "HISTORICAL") break;
      }
      const pool = passing.length !== 0 ? passing : all;
      if (pool.length === 0) throw new Error("generation produced no candidates");
      if (mode === "DIVERSIFIED") {
        // PHP 8 usort is stable; the JS sort is stable too. Ties keep sample order.
        pool.sort((a, b) => overlapPenalty(a[0], a[1], context) - overlapPenalty(b[0], b[1], context));
      }
      const [mains, stars] = pool[0];

      const check = rules.validateLine(mains, stars);
      if (!check.valid) throw new Error(`generator produced an invalid line: ${check.errors.join("; ")}`);
      const profile = analyzer.analyze(mains, stars, draws);
      lines.push({
        mains,
        stars,
        score: profile.balanceScore,
        scoreLabel: profile.scoreLabel,
        profile: {
          sum: profile.composition.sum.value,
          spread: profile.composition.spread.value,
          oddEven: profile.composition.oddEven.label,
          lowHigh: profile.composition.lowHigh.label,
          adjacentPairs: profile.composition.consecutives.adjacentPairs,
        },
      });
      context.push({ mains, stars }); // within-batch diversification context
    }

    // ------------------------------------------------ report (§16/§26)
    const lastDate = draws.length !== 0 ? String(draws[draws.length - 1].drawDate) : null;
    const report = {
      model: `WINDELS Lottery Model v${modelVersion}`,
      lottery: rules.code(),
      mode,
      lineCount: count,
      lines,
      averageBalanceScore: count > 0 ? phpRound(lines.reduce((a, l) => a + l.score, 0) / count, 1) : 0,
      inputs: {
        seed: normalizedSeed,
        rulesVersion: rules.version(),
        drawsUsed: draws.length,
        lastDrawDate: lastDate,
        datasetVersion: `n=${draws.length};last=${lastDate ?? "none"}`,
        locks: { mains: locksM, stars: locksS },
        excludes: { mains: exclM, stars: exclS },
        contextLines: (opts.contextLines ?? []).length,
      },
      factors: factorsOf(mode, targets, balBasis, numberStats, starStats, (opts.contextLines ?? []).length),
      generatedAt: formatGmdateC(),
      disclaimer: DISCLAIMER,
      honestyNote:
        "Every valid EuroMillions combination has exactly the same mathematical chance of being drawn. No generation mode increases that chance; the modes only shape the statistical profile, the diversity or the pattern avoidance of the selections.",
    };
    return report;
  }

  // ------------------------------------------------------------- factors

  /** The ACTUAL factors used by this generation (spec §26 — recorded, not invented). */
  function factorsOf(mode, targets, balBasis, numberStats, starStats, contextCount) {
    if (mode === "RANDOM") {
      return {
        method: "uniform seeded sampling without replacement",
        note: "No historical factors applied. A random baseline is intentionally always available (spec §25).",
      };
    }
    if (mode === "BALANCED") {
      // PHP array_filter drops null entries — targets/balBasis disappear when empty.
      const out = {
        method: "profile-filtered sampling against the historical distribution",
        targets,
        historicalBasis: balBasis,
        note: "Targets describe the typical historical composition. Matching a typical composition does not improve the odds of any specific line.",
      };
      for (const key of Object.keys(out)) if (out[key] === null || out[key] === undefined) delete out[key];
      return out;
    }
    if (mode === "HISTORICAL") {
      return {
        method: "frequency-weighted sampling (weight = 1 + historical appearances)",
        topMainNumbers: topNumbers(numberStats),
        topStars: topNumbers(starStats, 3),
        note: "Historical frequency is used only as a sampling weight. It describes the past; it does not forecast future draws.",
      };
    }
    if (mode === "DIVERSIFIED") {
      return {
        method: "minimum-overlap greedy selection (10 points per shared main, 20 per shared star)",
        contextLines: contextCount,
        note: "Diversification makes the lines more different from each other. It does not change the odds of any line.",
      };
    }
    return {
      method: "constrained sampling avoiding common human selection patterns",
      constraints: [
        `at least ${rules.mainCount() - 2} of ${rules.mainCount()} mains above the 1-31 birthday range`,
        "no ascending runs of 3 or more",
        "at most 1 adjacent pair",
        "not all mains share the same last digit",
        "mains not confined to a single decade",
      ],
      note: "Avoiding popular patterns may reduce the chance of sharing a prize if a line happens to win. It never changes the chance of winning.",
    };
  }

  function topNumbers(engineStats, n = 5) {
    if (engineStats === null || Object.keys(engineStats.numbers ?? {}).length === 0) return [];
    const nums = Object.values(engineStats.numbers);
    nums.sort((a, b) => (b.appearances - a.appearances) || (a.number - b.number));
    return nums.slice(0, n).map((s) => ({ number: s.number, appearances: s.appearances }));
  }

  // ------------------------------------------------------------- sampling

  function sampleField(rand, pool, need, locks, mode, engineStats) {
    if (need <= 0) return locks;
    const remaining = pool.filter((n) => !locks.includes(n));
    if (remaining.length < need) throw new Error("not enough numbers remain in the pool");
    let picks;
    if (mode === "HISTORICAL" && engineStats !== null) {
      const weights = remaining.map((n) => 1 + (engineStats.numbers[n]?.appearances ?? 0));
      picks = weightedSample(rand, remaining, weights, need);
    } else {
      picks = uniformSample(rand, remaining, need);
    }
    return [...new Set([...locks, ...picks])];
  }

  /** Uniform sample without replacement (seeded Fisher-Yates prefix). */
  function uniformSample(rand, poolIn, need) {
    const pool = [...poolIn];
    const n = pool.length;
    for (let i = 0; i < need && i < n - 1; i += 1) {
      const j = i + Math.floor(rand() * (n - i));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    return pool.slice(0, need);
  }

  /** Sequential weighted sampling without replacement. */
  function weightedSample(rand, pool, weights, need) {
    let idx = pool.map((_, i) => i);
    const picks = [];
    for (let k = 0; k < need; k += 1) {
      let total = 0.0;
      for (const i of idx) total += weights[i];
      const x = rand() * total;
      let acc = 0.0;
      let chosen = idx[idx.length - 1]; // PHP: $chosen = end($idx)
      for (const i of idx) {
        acc += weights[i];
        if (x < acc) {
          chosen = i;
          break;
        }
      }
      picks.push(pool[chosen]);
      idx = idx.filter((i) => i !== chosen);
    }
    return picks;
  }

  function balancedOk(mains, targetSpec) {
    const sum = mains.reduce((a, b) => a + b, 0);
    if (sum < targetSpec.sumRange[0] || sum > targetSpec.sumRange[1]) return false;
    const odd = mains.filter((x) => x % 2 === 1).length;
    if (odd < targetSpec.oddRange[0] || odd > targetSpec.oddRange[1]) return false;
    const low = mains.filter((x) => x <= targetSpec.lowBound).length;
    if (low < targetSpec.lowRange[0] || low > targetSpec.lowRange[1]) return false;
    return adjacentPairs(mains) <= targetSpec.maxAdjacentPairs;
  }

  function antiPopularOk(mainsIn) {
    const mains = [...mainsIn].sort((a, b) => a - b);
    const birthday = mains.filter((x) => x <= 31).length;
    if (birthday > 2) return false; // at least 3 mains above the birthday range
    if (adjacentPairs(mains) > 1) return false;
    let run = 1;
    for (let i = 1; i < mains.length; i += 1) {
      if (mains[i] === mains[i - 1] + 1) {
        run += 1;
        if (run >= 3) return false;
      } else {
        run = 1;
      }
    }
    const digits = new Set(mains.map((x) => x % 10));
    if (digits.size === 1) return false;
    if (Math.max(...mains) - Math.min(...mains) < 10) return false;
    return true;
  }

  /** DIVERSIFIED overlap penalty against context lines. */
  function overlapPenalty(mains, stars, contextLines) {
    if (contextLines.length === 0) return 0;
    const ms = new Set(mains);
    const ss = new Set(stars);
    let pen = 0;
    for (const c of contextLines) {
      for (const m of c.mains ?? []) if (ms.has(m)) pen += 10;
      for (const s of c.stars ?? []) if (ss.has(s)) pen += 20;
    }
    return pen;
  }

  function adjacentPairs(sortedMains) {
    let pairs = 0;
    for (let i = 1; i < sortedMains.length; i += 1) {
      if (sortedMains[i] === sortedMains[i - 1] + 1) pairs += 1;
    }
    return pairs;
  }

  return Object.freeze({ generate });
}

export function normalizeField(valuesIn, min, max, label) {
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

function isPhpScalar(v) {
  return ["string", "number", "boolean"].includes(typeof v);
}

function range(min, max) {
  const out = [];
  for (let n = min; n <= max; n += 1) out.push(n);
  return out;
}

function formatGmdateC(date = new Date()) {
  // PHP gmdate('c'): ISO-8601 with seconds and a +00:00 offset.
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

import { seededRandom } from "./prng.js";
import * as statisticsModule from "./statistics.js";

function createGeneratorRandom(seed) {
  return seededRandom(seed);
}

function createGeneratorStatistics() {
  return statisticsModule.createLotteryStatisticsEngine();
}
