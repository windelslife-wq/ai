/**
 * F-26 for the Strategy Lab and journal: the pure numeric policies are
 * recomputed against PHP's own output.
 *
 * The golden file (`test/fixtures/strategies-parity-golden.json`) is written by
 * `runtime/strategies-parity.mjs`, which runs the real legacy
 * `Aegis\Backtest\Backtester::simulate` (through all four built-in strategies),
 * `Aegis\Backtest\Metrics` and `Aegis\Journal\Analytics` in WASM PHP 8.2.
 * Regenerate after touching either side: `node runtime/strategies-parity.mjs`.
 *
 * One legacy defect is recorded as EVIDENCE rather than an expectation
 * (finding **F-48**): PHP's `Backtester::iso()` formats
 * `gmdate('Y-m-d\TH:i:s\Z') . '.' . ms . 'Z'`, emitting a double-Z string like
 * `2024-10-08T11:00:00Z.000Z`. The Node port reports canonical ISO-8601
 * (`…:00.000Z`), which is the same instant in a parseable string. This suite
 * (a) asserts the malformed evidence REALLY is in the golden — so the finding
 * can never shrink silently — and (b) canonicalizes the evidence to the same
 * instant before the exact comparison, so a numeric difference is never
 * allowed to hide behind the timestamp string.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { computeMetrics, sharpe, sortino } from "../src/modules/strategies/metrics.js";
import { simulate } from "../src/modules/strategies/backtester.js";
import { analyze, bucketMetrics, calibration } from "../src/modules/strategies/journal-analytics.js";
import {
  createBreakoutStrategy,
  createMeanReversionStrategy,
  createMomentumStrategy,
  createTrendFollowingStrategy,
} from "../src/modules/strategies/builtin.js";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "strategies-parity-golden.json");
const GOLDEN = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

function canon(value) {
  return JSON.parse(JSON.stringify(value));
}

/** F-48: PHP's double-Z evidence → the canonical ISO instant it denotes. */
const DOUBLE_Z = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})Z\.(\d{3})Z$/;
function canonicalizeIsoEvidence(value) {
  if (typeof value === "string") return value.replace(DOUBLE_Z, (_match, head, ms) => `${head}.${ms}Z`);
  if (Array.isArray(value)) return value.map(canonicalizeIsoEvidence);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = canonicalizeIsoEvidence(item);
    return out;
  }
  return value;
}

const STRATEGY_FACTORIES = Object.freeze({
  "trend-following": createTrendFollowingStrategy,
  "mean-reversion": createMeanReversionStrategy,
  momentum: createMomentumStrategy,
  breakout: createBreakoutStrategy,
});

function recompute(entry) {
  const input = entry.input ?? {};
  switch (entry.fn) {
    case "backtestSimulate": {
      const factory = STRATEGY_FACTORIES[input.strategy];
      if (!factory) throw new Error(`the golden file names a strategy the verifier cannot build: ${input.strategy}`);
      const strategy = factory(input.params ?? undefined);
      return simulate(strategy, input.candles, input.req, input.meta ?? {});
    }
    case "computeMetrics":
      return computeMetrics(input.trades, input.equityCurve, input.initialEquity, input.timeframe, input.barsInMarket);
    case "sharpe": return sharpe(input.r, input.barsPerYear);
    case "sortino": return sortino(input.r, input.barsPerYear);
    case "bucketMetrics": return bucketMetrics(input.entries);
    case "analyze": return analyze(input.entries, input.groupBy);
    case "calibration": return calibration(input.entries);
    default:
      throw new Error(`the golden file holds a case the verifier cannot replay: fn=${entry.fn}`);
  }
}

test("the generator's provenance is recorded and every case is well-formed", () => {
  assert.equal(typeof GOLDEN.php?.version, "string");
  assert.ok(Array.isArray(GOLDEN.cases) && GOLDEN.cases.length >= 25, "the golden set must not shrink silently");
  const seenNames = new Set();
  for (const entry of GOLDEN.cases) {
    assert.equal(typeof entry.name, "string");
    assert.equal(typeof entry.fn, "string");
    assert.ok("input" in entry && "result" in entry, `${entry.name}: input and result belong beside each other`);
    assert.ok(!seenNames.has(entry.name), `${entry.name}: names are the assertion messages and must be unique`);
    seenNames.add(entry.name);
  }
});

test("every strategy-lab policy is exercised, and every built-in strategy is diffed end to end", () => {
  const covered = new Set(GOLDEN.cases.map((entry) => entry.fn));
  for (const name of ["backtestSimulate", "computeMetrics", "sharpe", "sortino", "bucketMetrics", "analyze", "calibration"]) {
    assert.ok(covered.has(name), `${name}: no golden case — an undiffed numeric policy`);
  }
  const simulated = new Set(GOLDEN.cases.filter((entry) => entry.fn === "backtestSimulate").map((entry) => entry.input.strategy));
  for (const id of Object.keys(STRATEGY_FACTORIES)) {
    assert.ok(simulated.has(id), `${id}: not simulated against PHP — the engine port is undiffed for it`);
  }
});

test("F-48 evidence: the golden really does contain PHP's double-Z timestamps", () => {
  const text = JSON.stringify(GOLDEN);
  assert.ok(DOUBLE_Z.test(text) || /T\d{2}:\d{2}:\d{2}Z\.\d{3}Z/.test(text),
    "the evidence changed shape; the finding note and the canonicalizer must be reconsidered");
});

for (const entry of GOLDEN.cases) {
  test(entry.name, () => {
    const got = recompute(entry);
    assert.deepEqual(canon(got), canon(canonicalizeIsoEvidence(entry.result)), `${entry.name} (${entry.fn})`);
  });
}
