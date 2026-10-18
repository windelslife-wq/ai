/**
 * F-26 for the analysis module: every pure numeric policy the Node port claims
 * function-for-function is recomputed against PHP's own output.
 *
 * The golden file (`test/fixtures/analysis-parity-golden.json`) is written by
 * `runtime/analysis-parity.mjs`, which runs the real legacy `Aegis\Indicators`
 * and `Aegis\MathUtils` in WASM PHP 8.2 — so this suite asserts agreement with
 * what PHP *did*, not with a transcription of what PHP was believed to do.
 * Regenerating the fixture after touching either side's code is a normal
 * workflow step: `node runtime/analysis-parity.mjs`.
 *
 * Comparison is exact — the same rule every earlier F-26 slice set: both sides
 * compute on IEEE-754 doubles in the same operation order, and the earlier
 * harnesses (124 sports cases, the intelligence slice with its logistic map)
 * hold exact equality even through `exp()` and `sqrt()`. A single mismatch is
 * not noise to be tolerated; it is the next F-34/D-23, report it as one.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as indicators from "../src/modules/analysis/indicators.js";
import { clamp, fixedFormat, mean, numberFormat, roundTo, signedFormat, stdev } from "../src/modules/analysis/math.js";
import { gaussian, hashString, seededRandom } from "../src/modules/market-data/normalize.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "analysis-parity-golden.json",
);
const GOLDEN = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

/** Canonicalize through JSON so PHP's float printing and `-0` match the wire. */
function canon(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Recompute one golden case with the Node port. The keys are the generator's
 * `fn` strings; a case whose key has no entry here fails closed ('the golden
 * file holds a case the verifier does not know how to replay'), never skipped.
 *
 * @param {{fn: string, input: object}} entry
 */
function recompute(entry) {
  const input = entry.input ?? {};
  switch (entry.fn) {
    case "sma": return indicators.sma(input.values, input.period);
    case "ema": return indicators.ema(input.values, input.period);
    case "wilder": return indicators.wilder(input.values, input.period);
    case "rsi": return indicators.rsi(input.closes, input.period ?? 14);
    case "macd": return indicators.macd(input.closes, input.fast ?? 12, input.slow ?? 26, input.signal ?? 9);
    case "bollinger": return indicators.bollinger(input.closes, input.period ?? 20, input.mult ?? 2);
    case "stochastic": return indicators.stochastic(input.candles, input.kPeriod ?? 14, input.dPeriod ?? 3);
    case "trueRange": return indicators.trueRange(input.candles);
    case "atr": return indicators.atr(input.candles, input.period ?? 14);
    case "adx": return indicators.adx(input.candles, input.period ?? 14);
    case "vwap": return indicators.vwap(input.candles);
    case "volumeProfile": return indicators.volumeProfile(input.candles, input.bins ?? 24);
    case "findSwings": return indicators.findSwings(input.candles, input.k ?? 2);
    case "supportResistance": return indicators.supportResistance(input.candles, input.atrValue ?? null, input.currentPrice);
    case "pivotPoints": return indicators.pivotPoints(input.prev ?? null);
    case "regressionSlopePct": return indicators.regressionSlopePct(input.closes, input.period ?? 50);
    case "last": return indicators.last(input.arr);
    case "clamp": return clamp(input.v, input.min, input.max);
    case "mean": return mean(input.xs);
    case "stdev": return stdev(input.xs);
    case "hashString": return hashString(input.s);
    case "seededRandom": {
      // PHP captured the first N draws from one closure; the Node port must
      // produce the identical xorshift stream from the identical seed.
      const rand = seededRandom(input.seed);
      const outputs = [];
      for (let index = 0; index < input.draws; index += 1) outputs.push(rand());
      return outputs;
    }
    case "gaussian": {
      const rand = seededRandom(input.seed);
      const outputs = [];
      for (let index = 0; index < input.draws; index += 1) outputs.push(gaussian(rand));
      return outputs;
    }
    case "round": return roundTo(input.value, input.digits);
    case "numberFormat": return numberFormat(input.value, input.digits);
    case "signedFormat": return signedFormat(input.value, input.digits);
    case "fixedFormat": return fixedFormat(input.value, input.digits);
    default:
      throw new Error(`the golden file holds a case the verifier cannot replay: fn=${entry.fn}`);
  }
}

test("the generator's provenance is recorded and every case is well-formed", () => {
  assert.equal(typeof GOLDEN.php?.version, "string");
  assert.ok(Array.isArray(GOLDEN.cases) && GOLDEN.cases.length >= 90, "the golden set must not shrink silently");
  const seenNames = new Set();
  for (const entry of GOLDEN.cases) {
    assert.equal(typeof entry.name, "string");
    assert.equal(typeof entry.fn, "string");
    assert.ok("input" in entry, `${entry.name}: the input must be stored beside the result`);
    assert.ok("result" in entry, `${entry.name}: the result must be stored beside the input`);
    assert.ok(!seenNames.has(entry.name), `${entry.name}: names are the assertion messages and must be unique`);
    seenNames.add(entry.name);
  }
});

test("every exported indicator and helper is exercised by at least one case", () => {
  const covered = new Set(GOLDEN.cases.map((entry) => entry.fn));
  for (const name of [
    "sma", "ema", "wilder", "rsi", "macd", "bollinger", "stochastic", "trueRange", "atr",
    "adx", "vwap", "volumeProfile", "findSwings", "supportResistance", "pivotPoints",
    "regressionSlopePct", "last",
    "clamp", "mean", "stdev", "hashString", "seededRandom", "gaussian",
    "round", "numberFormat", "signedFormat", "fixedFormat",
  ]) {
    assert.ok(covered.has(name), `${name}: no golden case — an undiffed numeric policy`);
  }
});

for (const entry of GOLDEN.cases) {
  test(entry.name, () => {
    const got = recompute(entry);
    assert.deepEqual(canon(got), canon(entry.result), `${entry.name} (${entry.fn})`);
  });
}
