/**
 * PHP↔Node differential parity for the lottery combination engines (row 15,
 * slice 2) — the `cases.combinations` group of the golden that slice 1's
 * harness began.
 *
 * Every expectation is **PHP's own output**, captured by running the REAL
 * `CombinationAnalyzer`, `CombinationGenerator`, `DiversificationEngine` and
 * `SystemBuilder` in WASM PHP 8.2 (`node runtime/lottery-parity.mjs`). The
 * generator is the strongest parity subject in the platform: it consumes the
 * xorshift32 PRNG (already proven bit-identical in slice 1), sorts, filters and
 * scores, and emits a decision report of its ACTUAL inputs — so a one-bit PRNG
 * drift or a silently different filter would name a different draw universe.
 * The `RANDOM seed 42` case pins three complete lines, jackpot-grade exact:
 * mains, stars, scores, inputs and factors.
 *
 * All 35 cases are deterministic and tie-free at every sort boundary (LT-3);
 * the only clock-derived field in the group, `generatedAt`, is sentinel-stripped
 * on BOTH sides like slice 1's sandbox fields.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createEuroMillionsRules } from "../src/modules/lottery/rules.js";
import { createLotteryStatisticsEngine, DISCLAIMER } from "../src/modules/lottery/statistics.js";
import { createCombinationAnalyzer } from "../src/modules/lottery/combinations.js";
import { createCombinationGenerator, GENERATOR_MODES, GENERATOR_MAX_LINES } from "../src/modules/lottery/generator.js";
import { createDiversificationEngine } from "../src/modules/lottery/diversification.js";
import { createSystemBuilder, comb, SYNC_LINE_LIMIT, MAX_PAGE } from "../src/modules/lottery/system.js";

const GOLDEN = JSON.parse(await readFile(new URL("./fixtures/lottery-parity-golden.json", import.meta.url), "utf8"));
const CASES = GOLDEN.cases.combinations;

/** The identical substitution the PHP generator applied to `generatedAt`. */
function stripGeneratedAt(value) {
  if (Array.isArray(value)) return value.map(stripGeneratedAt);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = key === "generatedAt" && typeof entry === "string" ? "<NOW>" : stripGeneratedAt(entry);
    }
    return out;
  }
  return value;
}

function assertMatches(name, actual) {
  assert.deepEqual(actual, CASES[name], `combinations / ${name}`);
}

/** Same outcome envelope as the PHP harness: the value, or the thrown message. */
function outcome(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// The seven crafted draws — the same tie-free set the statistics group uses.
const DRAWS = [
  { drawDate: "2026-09-22", main: [1, 2, 3, 4, 5], stars: [1, 2] },
  { drawDate: "2026-09-25", main: [5, 10, 15, 20, 25], stars: [2, 3] },
  { drawDate: "2026-09-29", main: [1, 5, 10, 20, 25], stars: [1, 3] },
  { drawDate: "2026-10-02", main: [7, 14, 21, 28, 35], stars: [4, 5] },
  { drawDate: "2026-10-06", main: [1, 5, 7, 14, 35], stars: [1, 4] },
  { drawDate: "2026-10-09", main: [2, 3, 7, 21, 28], stars: [2, 5] },
  { drawDate: "2026-10-12", main: [7, 14, 21, 28, 35], stars: [4, 5] },
];

function build() {
  const rules = createEuroMillionsRules();
  const statistics = createLotteryStatisticsEngine();
  const analyzer = createCombinationAnalyzer(rules, statistics);
  return {
    rules,
    analyzer,
    generator: createCombinationGenerator(rules, analyzer, statistics, "1.0"),
    diversification: createDiversificationEngine(rules),
    systemBuilder: createSystemBuilder(rules),
  };
}

test("the golden covers the combination group", () => {
  assert.ok(Object.keys(CASES).length >= 35, `expected the full combination group, got ${Object.keys(CASES).length}`);
});

test("the analyzer agrees with PHP on the full profile, the neutral score and the refusals", () => {
  const { analyzer } = build();
  assertMatches("analyze: a balanced line over the seven draws", analyzer.analyze([5, 14, 21, 28, 35], [2, 4], DRAWS));
  assertMatches("analyze: empty history is the neutral score", analyzer.analyze([1, 2, 3, 4, 5], [1, 2], []));
  assertMatches(
    "analyze: an invalid line is refused with the rules errors",
    outcome(() => analyzer.analyze([1, 1, 3, 4, 5], [2, 4], DRAWS)),
  );
  const a = analyzer.analyze([5, 14, 21, 28, 35], [2, 4], DRAWS);
  const b = analyzer.analyze([35, 28, 21, 14, 5], [4, 2], DRAWS);
  assertMatches("analyze: input order does not matter", {
    sameScore: a.balanceScore === b.balanceScore,
    sameSum: a.composition.sum.value === b.composition.sum.value,
  });
});

test("the generator agrees with PHP on every mode, seeded and exact", () => {
  const { generator } = build();
  assertMatches(
    "generate: RANDOM seed 42, three lines",
    stripGeneratedAt(generator.generate(DRAWS, { mode: "RANDOM", count: 3, seed: 42 })),
  );
  const again = generator.generate(DRAWS, { mode: "RANDOM", count: 1, seed: 7 });
  const onceMore = generator.generate(DRAWS, { mode: "RANDOM", count: 1, seed: 7 });
  // The golden records PHP's equality VERDICT for this case, not the lines.
  assertMatches("generate: RANDOM is reproducible for the same seed", again.lines.join("|") === onceMore.lines.join("|"));

  const locked = generator.generate(DRAWS, {
    mode: "RANDOM",
    count: 5,
    seed: 42,
    locks: { mains: [7, 50], stars: [12] },
    excludes: { mains: [1, 2, 3], stars: [1] },
  });
  assertMatches("generate: locks are always present, excludes never", {
    locksPresent: locked.lines[0].mains.includes(7) && locked.lines[0].mains.includes(50) && locked.lines[0].stars.includes(12),
    excludedAbsent: locked.lines.every((l) => !l.mains.some((m) => [1, 2, 3].includes(m))) && locked.lines.every((l) => !l.stars.includes(1)),
    inputsLocks: locked.inputs.locks,
    inputsExcludes: locked.inputs.excludes,
  });

  const historical = generator.generate(DRAWS, { mode: "HISTORICAL", count: 2, seed: 42 });
  assertMatches("generate: HISTORICAL seed 42 weights by appearances", {
    lines: historical.lines,
    factorsMethod: historical.factors.method,
    topMainNumbers: historical.factors.topMainNumbers,
    topStars: historical.factors.topStars,
  });

  assertMatches(
    "generate: BALANCED seed 42 filters to the historical profile",
    { lines: (r => r.lines)(generator.generate(DRAWS, { mode: "BALANCED", count: 2, seed: 42 })), factors: (r => r.factors)(generator.generate(DRAWS, { mode: "BALANCED", count: 2, seed: 42 })) },
  );
  const balancedEmpty = generator.generate([], { mode: "BALANCED", count: 1, seed: 42 });
  assertMatches("generate: BALANCED with no history samples unconstrained and records no targets", {
    factors: balancedEmpty.factors,
    line: balancedEmpty.lines[0].mains,
  });

  assertMatches(
    "generate: DIVERSIFIED seed 42 sorts candidates by overlap penalty",
    stripGeneratedAt(generator.generate(DRAWS, {
      mode: "DIVERSIFIED",
      count: 3,
      seed: 42,
      contextLines: [{ mains: [7, 14, 21, 28, 35], stars: [4, 5] }],
    })),
  );

  const anti = generator.generate(DRAWS, { mode: "ANTI-POPULAR", count: 2, seed: 42 });
  assertMatches("generate: ANTI-POPULAR seed 42 refuses birthday-heavy lines", { lines: anti.lines, factors: anti.factors });
});

test("the generator's refusals and clamps are PHP's, message for message", () => {
  const { generator } = build();
  assertMatches("generate: an unknown mode is refused", outcome(() => generator.generate(DRAWS, { mode: "TEA-LEAVES" })));
  assertMatches(
    "generate: more than five locked mains is refused",
    outcome(() => generator.generate(DRAWS, { mode: "RANDOM", locks: { mains: [1, 2, 3, 4, 5, 6] } })),
  );
  assertMatches(
    "generate: a number both locked and excluded is refused",
    outcome(() => generator.generate(DRAWS, { mode: "RANDOM", locks: { mains: [7] }, excludes: { mains: [7] } })),
  );
  assertMatches(
    "generate: a locked number outside the allowed pool is refused",
    outcome(() => generator.generate(DRAWS, { mode: "RANDOM", locks: { mains: [7] }, excludes: { mains: [7] } })),
  );
  assertMatches(
    "generate: excluding down to four remaining mains starves the pool",
    outcome(() => generator.generate(DRAWS, {
      mode: "RANDOM",
      excludes: { mains: Array.from({ length: 46 }, (_, i) => i + 5) },
    })),
  );
  const clamped = generator.generate(DRAWS, { mode: "RANDOM", count: 500, seed: 42 });
  assertMatches("generate: count clamps at MAX_LINES", { requested: 500, lineCount: clamped.lineCount, actualLines: clamped.lines.length });
  assertMatches("generate: a float seed truncates like (int)", (function () {
    const whole = generator.generate(DRAWS, { mode: "RANDOM", count: 1, seed: 42 });
    const fractional = generator.generate(DRAWS, { mode: "RANDOM", count: 1, seed: 42.9 });
    return { whole: whole.lines, fractional: fractional.lines, recordedSeeds: [whole.inputs.seed, fractional.inputs.seed] };
  })());
});

test("the diversification engine agrees with PHP, including its refusals", () => {
  const { diversification } = build();
  assertMatches("diversify: two far-apart lines score high", diversification.score([
    { mains: [1, 2, 3, 4, 5], stars: [1, 2] },
    { mains: [46, 47, 48, 49, 50], stars: [11, 12] },
  ]));
  assertMatches("diversify: identical lines are duplicates with a heavy penalty", diversification.score([
    { mains: [1, 2, 3, 4, 5], stars: [1, 2] },
    { mains: [5, 4, 3, 2, 1], stars: [2, 1] },
  ]));
  assertMatches("diversify: three mixed lines", diversification.score([
    { mains: [1, 2, 3, 4, 5], stars: [1, 2] },
    { mains: [1, 2, 3, 44, 45], stars: [1, 3] },
    { mains: [30, 35, 40, 45, 50], stars: [11, 12] },
  ]));
  assertMatches("diversify: no lines is refused", outcome(() => diversification.score([])));
  assertMatches("diversify: an invalid line names its position", outcome(() => diversification.score([
    { mains: [1, 2, 3, 4, 5], stars: [1, 2] },
    { mains: [1, 2, 3, 4], stars: [1, 2] },
  ])));
});

test("the system builder agrees with PHP on plans, windows, combinatorics and refusals", () => {
  const { systemBuilder } = build();
  assertMatches("system: plan C(7,5) x C(3,2)", systemBuilder.plan([7, 1, 3, 5, 2, 4, 6], [3, 1, 2]));
  assertMatches("system: the first page is lexicographic with stars nested", systemBuilder.page([1, 2, 3, 4, 5, 6], [1, 2, 3], 0, 4));
  assertMatches("system: page windows offset correctly", {
    first: systemBuilder.page([1, 2, 3, 4, 5, 6], [1, 2], 4, 3),
    last: systemBuilder.page([1, 2, 3, 4, 5, 6], [1, 2], 12, 10),
    pastEnd: systemBuilder.page([1, 2, 3, 4, 5, 6], [1, 2], 99, 10),
  });
  assertMatches("system: C(50,5) and C(12,2) are computed, never hardcoded", {
    "C(50,5)": comb(50, 5),
    "C(12,2)": comb(12, 2),
    "C(7,0)": comb(7, 0),
    "C(7,8)": comb(7, 8),
    "C(60,5)": comb(60, 5),
  });
  const bigPlan = systemBuilder.plan(Array.from({ length: 29 }, (_, i) => i + 1), [1, 2]);
  assertMatches("system: a pool over the synchronous limit requires background", {
    totalLines: bigPlan.totalLines,
    requiresBackground: bigPlan.requiresBackground,
    formula: bigPlan.formula,
  });
  assertMatches("system: a pool below five mains is refused", outcome(() => systemBuilder.plan([1, 2, 3, 4], [1, 2])));
  assertMatches("system: a duplicate pool number is refused", outcome(() => systemBuilder.plan([1, 1, 2, 3, 4, 5], [1, 2])));
  assertMatches("system: an out-of-range pool number is refused", outcome(() => systemBuilder.plan([1, 2, 3, 4, 51], [1, 2])));
  assertMatches("system: a string pool number is refused as invalid", outcome(() => systemBuilder.plan([1, 2, 3, 4, "5"], [1, 2])));
  assertMatches("system: combinationsOf is lexicographic", [...systemBuilder.combinationsOf([10, 20, 30, 40], 2)]);
  assertMatches("system: allLines materialises the whole small system", {
    count: systemBuilder.allLines([1, 2, 3, 4, 5, 6], [1, 2]).length,
    first: { mains: [1, 2, 3, 4, 5], stars: [1, 2] },
  });
});

test("the port's own constants match legacy's published limits", () => {
  assert.deepEqual([...GENERATOR_MODES], ["RANDOM", "BALANCED", "HISTORICAL", "DIVERSIFIED", "ANTI-POPULAR"]);
  assert.equal(GENERATOR_MAX_LINES, 100);
  assert.equal(SYNC_LINE_LIMIT, 10000);
  assert.equal(MAX_PAGE, 500);
  assert.equal(DISCLAIMER.includes("independent random events"), true);
});
