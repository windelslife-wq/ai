/**
 * PHP↔Node differential parity for the sports decision chain (row 14, slice 3).
 *
 * Every expectation is PHP's output, captured in `test/fixtures/sports-parity-golden.json`
 * under `cases.slice3` by `runtime/sports-parity.mjs`. The inputs come from the golden
 * file too, so the two sides cannot disagree about what was computed.
 *
 * Three kinds of assertion, and the difference matters:
 *
 *  1. **Exact** — the Node result equals PHP's, to the last double and the last
 *     character. This is the default, and it covers features, value, confidence, risk,
 *     intelligence, configuration validation and PHP `round()`.
 *
 *  2. **Corrected-oracle** — where a documented divergence changes a number, the golden
 *     file carries a second result, `resultLogistic`, produced by a PHP subclass that
 *     overrides exactly one formula (`LogisticPredictionEngine`). The Node port must
 *     equal that result exactly. This is how DV-12 is checked without pretending PHP
 *     agreed with it.
 *
 *  3. **Evidence** — where legacy is wrong, the test asserts the wrongness, so a future
 *     change to the legacy code that fixes it is noticed rather than silently absorbed.
 *     F-36 (Brier always 0) and F-37 (the linear formula) are both checked this way.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { phpIsNumeric, phpRound } from "../src/lib/php.js";
import {
  applyCalibration,
  applyFittedCalibration,
  calibrationVersion,
  evaluateCalibration,
  fitCalibration,
} from "../src/modules/sports/calibration.js";
import {
  BOOLEAN_FIELDS,
  defaultConfiguration,
  validateConfiguration,
} from "../src/modules/sports/configuration.js";
import {
  analyzeMatchIntelligence,
  assessConfidence,
  assessRisk,
  assessValue,
  buildFeatures,
  evaluatePrediction,
  predictOver15,
} from "../src/modules/sports/intelligence.js";

const golden = JSON.parse(await readFile(new URL("./fixtures/sports-parity-golden.json", import.meta.url), "utf8"));
const slice3 = golden.cases?.slice3;

/**
 * Canonical form for comparison. JSON round-trips away `undefined`, PHP's empty array
 * `[]` stands for JavaScript's empty object `{}` (`drivers` and `features` are built
 * that way on both sides), and `-0` is folded into `0`, which PHP's JSON writes as
 * `-0.0` and which no sports rule distinguishes.
 */
function canon(value) {
  if (value === -0) return 0;
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return [];
    const out = {};
    for (const key of keys.sort()) out[key] = canon(value[key]);
    return out;
  }
  return value;
}

/** The Node result, as it would be serialized, so it is compared the way PHP's is. */
function asJson(value) {
  return canon(JSON.parse(JSON.stringify(value)));
}

function expectOk(entry, label) {
  assert.equal(entry.ok, true, `${label}: PHP threw ${entry.error ?? "(no message)"}`);
  return entry.value;
}

/**
 * The rows `CalibrationEngine::fit` keeps: numeric raw probability, outcome exactly 0 or 1.
 * Recomputed here so that the Brier check is over the same sample the port scored.
 */
function fittedRows(rows) {
  return rows.filter((row) => row && row.raw_probability !== null && phpIsNumeric(row.raw_probability)
    && (row.outcome === 0 || row.outcome === 1));
}

/** Mean squared error over the same clamp `CalibrationEngine::evaluate` applies. */
function brierOf(rows, probabilityOf) {
  let total = 0;
  for (const row of fittedRows(rows)) {
    const p = Math.min(0.999, Math.max(0.001, probabilityOf(row)));
    total += (p - Number(row.outcome)) ** 2;
  }
  return phpRound(total / Math.max(1, fittedRows(rows).length), 6);
}

test("phpRound reproduces PHP 8.2 round(), including its pre-rounding", () => {
  for (const [name, entry] of Object.entries(slice3.phpRound)) {
    // phpRound entries store PHP's return value directly, not an ok/value envelope.
    const [value, places] = entry.input;
    assert.equal(phpRound(value, places), entry.result, `${name}`);
  }
});

/**
 * An identity fallback: PHP's fit degenerates to intercept 0, slope 1. Legacy keeps the
 * method `platt` and measures the fit through the logistic map. The port labels it
 * `identity` and measures it on the raw probability (F-37, DV-12). Asserted explicitly.
 */
const isIdentityFallback = (want) => want.fit.intercept === 0 && want.fit.slope === 1;

test("calibration fit matches PHP for every sample, outside the Brier score", () => {
  for (const [name, entry] of Object.entries(slice3.calibration)) {
    const got = fitCalibration(entry.rows);
    const want = expectOk(entry.result, name);
    if (want.ok === false) {
      assert.deepEqual(asJson(got), canon(want), name);
      continue;
    }
    if (isIdentityFallback(want)) {
      assert.equal(got.fit.method, "identity", `${name}: the fallback is labelled identity (F-37)`);
      assert.equal(got.fit.intercept, want.fit.intercept, name);
      assert.equal(got.fit.slope, want.fit.slope, name);
      assert.equal(got.fit.samples, want.fit.samples, name);
      assert.equal(got.fit.positives, want.fit.positives, name);
      assert.equal(calibrationVersion(got.fit), entry.version.replace("cal-platt-", "cal-identity-"), name);
      // The ECE is measured on the raw probability, not on the sigmoid of it.
      const rawEce = evaluateCalibration(fittedRows(entry.rows), (row) => Number(row.raw_probability)).ece;
      assert.equal(got.metrics.ece, rawEce, `${name}: identity ECE is measured on the raw probability`);
      continue;
    }
    // Brier is compared separately below, against the evidence and the recomputation.
    const gotMetrics = { ...got.metrics };
    const wantMetrics = { ...want.metrics };
    delete gotMetrics.brier;
    delete gotMetrics.identityBrier;
    delete wantMetrics.brier;
    delete wantMetrics.identityBrier;
    assert.deepEqual(asJson({ ...got, metrics: gotMetrics }), canon({ ...want, metrics: wantMetrics }), name);
    assert.equal(calibrationVersion(got.fit), entry.version, `${name}: version label`);
  }
});

test("F-37: an identity calibration returns the raw probability; a fitted one is logistic", () => {
  assert.equal(applyFittedCalibration({ method: "identity", intercept: 0, slope: 1 }, 0.754), 0.754);
  // Clamped like every other output, so the identity cannot escape the consumers' range.
  assert.equal(applyFittedCalibration({ method: "identity", intercept: 0, slope: 1 }, 1), 0.99);
  assert.equal(applyFittedCalibration({ method: "identity", intercept: 0, slope: 1 }, 0), 0.01);
  // A fit that happens to be 0 + 1*x is still a logistic map, because the label says so.
  assert.equal(applyFittedCalibration({ method: "platt", intercept: 0, slope: 1 }, 0.754), applyCalibration(0, 1, 0.754));
  // A caller that predates the method field gets the logistic map, as before.
  assert.equal(applyFittedCalibration({ intercept: 0, slope: 1 }, 0.754), applyCalibration(0, 1, 0.754));
});

test("F-36 evidence: legacy's Brier score is always 0, and the port's is the real value", () => {
  for (const [name, entry] of Object.entries(slice3.calibration)) {
    const want = expectOk(entry.result, name);
    if (want.ok === false) continue;
    // Evidence: the golden file records legacy's zero.
    assert.equal(want.metrics.brier, 0, `${name}: legacy brier should be the truncated zero (F-36)`);
    assert.equal(want.metrics.identityBrier, 0, `${name}: legacy identityBrier should be zero (F-36)`);
    // The port: the recomputed mean squared error.
    const got = fitCalibration(entry.rows);
    const { fit } = got;
    assert.equal(
      got.metrics.brier,
      brierOf(entry.rows, (row) => applyFittedCalibration(fit, Number(row.raw_probability))),
      `${name}: corrected brier`,
    );
    assert.equal(
      got.metrics.identityBrier,
      brierOf(entry.rows, (row) => Number(row.raw_probability)),
      `${name}: corrected identityBrier`,
    );
  }
});

test("calibration apply is the logistic map, clamped to [0.01, 0.99]", () => {
  for (const [name, entry] of Object.entries(slice3.calibrationApply)) {
    const [intercept, slope, raw] = entry.input;
    assert.equal(applyCalibration(intercept, slope, raw), expectOk(entry.result, name), name);
  }
});

test("calibration evaluate matches PHP on everything except the truncated Brier score", () => {
  const { rows, result } = slice3.calibrationEvaluate;
  const want = expectOk(result, "evaluate");
  const got = evaluateCalibration(rows, (row) => Number(row.raw_probability));
  assert.equal(got.ece, want.ece);
  assert.deepEqual(asJson(got.bins), canon(want.bins));
  assert.equal(want.brier, 0, "F-36: legacy evaluate reports brier 0");
  assert.equal(got.brier, brierOf(rows, (row) => Number(row.raw_probability)));
});

test("the configuration defaults match PHP, with booleans for PHP's 0/1", () => {
  const want = { ...slice3.configurationDefaults };
  for (const field of BOOLEAN_FIELDS) want[field] = Boolean(want[field]);
  assert.deepEqual(asJson(defaultConfiguration()), canon(want));
});

test("configuration validation returns PHP's message for every rule", () => {
  for (const [name, entry] of Object.entries(slice3.configuration)) {
    const config = { ...entry.input.config };
    for (const field of BOOLEAN_FIELDS) config[field] = Boolean(config[field]);
    const want = expectOk(entry.result, name);
    assert.equal(
      validateConfiguration(config, { allowAutomatedExecution: entry.input.allowAutomatedExecution }),
      want,
      name,
    );
  }
});

test("match intelligence matches PHP for every input, including freshness and liquidity", () => {
  for (const [name, entry] of Object.entries(slice3.intelligence)) {
    const { match, odds, verifiedContext, now } = entry.input;
    const got = analyzeMatchIntelligence(match, odds, verifiedContext, now);
    assert.deepEqual(asJson(got), canon(expectOk(entry.result, name)), name);
  }
});

test("feature engineering matches PHP, and refuses anything non-numeric", () => {
  for (const [name, entry] of Object.entries(slice3.features)) {
    assert.deepEqual(asJson(buildFeatures(entry.input)), canon(expectOk(entry.result, name)), name);
  }
});

test("prediction matches PHP's structure, and the logistic oracle exactly (DV-12)", () => {
  for (const [name, entry] of Object.entries(slice3.prediction)) {
    const { featureSet, calibration } = entry.input;
    const got = asJson(predictOver15(featureSet, calibration));
    const logistic = expectOk(entry.resultLogistic, name);
    assert.deepEqual(got, canon(logistic), `${name}: corrected oracle`);

    // F-37 evidence: legacy's calibrated probability is the linear formula, clamped.
    const legacy = expectOk(entry.result, name);
    if (legacy.decision === "PREDICTION_READY") {
      const raw = 1 / (1 + Math.exp(-(featureSet.features.expectedGoalsProxy - 1.5)));
      const linear = Math.min(0.99, Math.max(0.01, calibration.intercept + calibration.slope * raw));
      assert.equal(legacy.calibratedProbability, phpRound(linear, 6), `${name}: legacy is linear (F-37)`);
      assert.equal(got.rawModelProbability, legacy.rawModelProbability, `${name}: raw probability is unaffected`);
    }
  }
});

test("value matches PHP for each edge case", () => {
  for (const [name, entry] of Object.entries(slice3.value)) {
    const { prediction, odds } = entry.input;
    assert.deepEqual(asJson(assessValue(prediction, odds)), canon(expectOk(entry.result, name)), name);
  }
});

test("confidence matches PHP, including the cap and the calibration-sample gate", () => {
  for (const [name, entry] of Object.entries(slice3.confidence)) {
    const { prediction, quality, calibration } = entry.input;
    assert.deepEqual(asJson(assessConfidence(prediction, quality, calibration)), canon(expectOk(entry.result, name)), name);
  }
});

test("risk matches PHP for every rule, including the volatility upgrade", () => {
  for (const [name, entry] of Object.entries(slice3.risk)) {
    const { value, quality, config, context } = entry.input;
    assert.deepEqual(asJson(assessRisk(value, quality, config, context)), canon(expectOk(entry.result, name)), name);
  }
});

test("the pipeline matches the corrected oracle, and legacy where no calibration is involved", () => {
  for (const [name, entry] of Object.entries(slice3.pipeline)) {
    const { match, odds, quality, calibration, config, now } = entry.input;
    const got = asJson(evaluatePrediction({ match, odds, quality, calibration, config, now }));
    assert.deepEqual(got, canon(expectOk(entry.resultLogistic, name)), `${name}: corrected oracle`);
    if (calibration === null) {
      // No calibrated probability is produced, so DV-12 cannot apply and legacy must agree.
      assert.deepEqual(canon(expectOk(entry.result, name)), canon(expectOk(entry.resultLogistic, name)), `${name}: legacy and corrected agree`);
    }
  }
});

test("Q-2 is captured: the NO_PREDICTION path gains LOW_CONFIDENCE when min_confidence is positive", () => {
  // The case that reaches the gate: intelligence is ready, the price is present, and the
  // calibration is absent, so the prediction is NO_PREDICTION and the confidence is null.
  const entry = slice3.pipeline["no calibration is rejected by the gate"];
  const legacy = expectOk(entry.result, "Q-2");
  assert.equal(legacy.prediction.decision, "NO_PREDICTION");
  assert.equal(legacy.confidence.confidence, null);
  assert.ok(legacy.rejectionReasons.includes("LOW_CONFIDENCE"), "legacy appends LOW_CONFIDENCE on a null confidence");
  const got = evaluatePrediction({ ...entry.input });
  assert.ok(got.rejectionReasons.includes("LOW_CONFIDENCE"), "the port keeps the quirk");
});
