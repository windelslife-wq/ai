/**
 * Slice-4 parity: the Node backtester reproduces PHP's `LotteryBacktester`
 * byte-for-byte against the golden — constants, the crc32-mixed per-draw
 * seeds, every report field of four strategies (including the window clamp
 * and the lines clamp), the comparison envelope, every refusal string, and
 * F-45: legacy extracts the tier rank as `substr($tier, 5, 1)`, so TIER_10
 * reads as rank 1. The port keeps that behaviour; a "fix" would be a
 * deliberate, documented divergence.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createEuroMillionsRules } from "../src/modules/lottery/rules.js";
import { createLotteryStatisticsEngine } from "../src/modules/lottery/statistics.js";
import { createCombinationAnalyzer } from "../src/modules/lottery/combinations.js";
import { createCombinationGenerator } from "../src/modules/lottery/generator.js";
import {
  createLotteryBacktester,
  BACKTESTER_STRATEGIES,
  BACKTESTER_MIN_HISTORY,
  BACKTESTER_MAX_WINDOW,
  BACKTESTER_MAX_LINES,
  BACKTESTER_DESCRIPTIONS,
  strategySeed,
  tierRank,
} from "../src/modules/lottery/backtester.js";
import { MODEL_VERSION } from "../src/modules/lottery/service.js";

const GOLDEN = JSON.parse(
  readFileSync(new URL("./fixtures/lottery-parity-golden.json", import.meta.url), "utf8"),
).cases.backtests;

/** PHP `ksort` on an empty tierCounts serializes as [] — an empty JS object is the same report. */
function normalize(report) {
  if (report === null || typeof report !== "object") return report;
  if (Array.isArray(report)) return report.map(normalize);
  const out = {};
  for (const [key, value] of Object.entries(report)) {
    if (key === "tierCounts" && Array.isArray(value) && value.length === 0) out[key] = {};
    else out[key] = normalize(value);
  }
  return out;
}

const rules = createEuroMillionsRules();
const statistics = createLotteryStatisticsEngine();
const analyzer = createCombinationAnalyzer(rules, statistics);
const generator = createCombinationGenerator(rules, analyzer, statistics, MODEL_VERSION);
const backtester = createLotteryBacktester(rules, analyzer, generator, MODEL_VERSION);
const draws = GOLDEN.drawsUsed;

test("the Strategy Lab's constants and per-draw seeds are PHP's, crc32 mixing included", () => {
  assert.deepEqual([...BACKTESTER_STRATEGIES], GOLDEN.constants.strategies);
  assert.equal(BACKTESTER_MIN_HISTORY, GOLDEN.constants.minHistory);
  assert.equal(BACKTESTER_MAX_WINDOW, GOLDEN.constants.maxWindow);
  assert.equal(BACKTESTER_MAX_LINES, GOLDEN.constants.maxLines);
  assert.deepEqual(BACKTESTER_DESCRIPTIONS, GOLDEN.constants.descriptions);
  assert.equal(MODEL_VERSION, GOLDEN.constants.modelVersion);
  for (const strategy of GOLDEN.constants.strategies) {
    for (const [key, expected] of Object.entries(GOLDEN.seeds[strategy])) {
      const index = Number(key.slice(1));
      assert.equal(
        strategySeed(strategy, index, MODEL_VERSION),
        expected,
        `${strategy} @ draw index ${index}`,
      );
    }
  }
});

test("each strategy's HISTORICAL SIMULATION report matches PHP to the last line", () => {
  const cases = [
    ["RANDOM_BASELINE two lines over the last five draws", 2, 5],
    ["BALANCED_PROFILE full window one line", 1, 0],
    ["HISTORICAL_FREQ three lines", 3, 0],
    ["ANTI_POPULAR window clamped above the cap", 1, 9999],
  ];
  for (const [name, lines, window] of cases) {
    const actual = backtester.run(draws, name.split(" ")[0], lines ?? 1, window ?? 0);
    assert.deepEqual(normalize(actual), normalize(GOLDEN[name]), name);
  }
  // The clamp case: twelve asked, ten answered (the golden stores the projection).
  const clamped = backtester.run(draws, "RANDOM_BASELINE", 12, 2);
  assert.deepEqual(
    {
      linesPerDraw: clamped.linesPerDraw,
      totalLines: clamped.totalLines,
      perDrawLineCount: clamped.perDraw[0].lines.length,
    },
    GOLDEN["lines clamped: twelve asked, ten answered"],
  );
});

test("refusals are legacy's strings, and the comparison envelope matches", () => {
  assert.deepEqual(
    (() => { try { backtester.run(draws, "MARTINGALE"); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } })(),
    GOLDEN["an unknown strategy is refused"],
  );
  assert.deepEqual(
    (() => { try { backtester.run(draws.slice(0, 8), "RANDOM_BASELINE"); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } })(),
    GOLDEN["insufficient history is refused"],
  );
  const compare = backtester.compare(draws, ["random_baseline", "ANTI_POPULAR", "RANDOM_BASELINE"], 1, 3);
  assert.deepEqual(normalize(compare), normalize(GOLDEN["a comparison on the same period"]));
  assert.deepEqual(
    (() => { try { backtester.compare(draws, ["BALANCED_PROFILE"]); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } })(),
    GOLDEN["a comparison without the baseline is refused"],
  );
  assert.deepEqual(
    (() => { try { backtester.compare(draws, []); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } })(),
    GOLDEN["an empty comparison is refused"],
  );
  assert.deepEqual(
    (() => { try { backtester.compare(draws, ["RANDOM_BASELINE", "WIZARD"]); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } })(),
    GOLDEN["an unknown comparison member is refused"],
  );
});

test("F-45: the rank of a tier label is its sixth character — TIER_10 reads as rank 1", () => {
  const goldenRanks = GOLDEN["rankOf the ten official labels (F-45 substr behaviour)"];
  for (const [tier, expected] of Object.entries(goldenRanks)) {
    assert.equal(tierRank(tier), expected, `${tier} → rank ${expected}`);
  }
  assert.equal(goldenRanks["TIER_10 (2 stars)"], 1, "the quirk itself is pinned: TIER_10 is NOT rank 10");
});
