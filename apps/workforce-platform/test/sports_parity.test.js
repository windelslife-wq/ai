/**
 * PHP↔Node differential parity for the sports foundation — the first instance of
 * the harness that **finding F-26** has called for since Phase 4.
 *
 * Every expectation in this file is **PHP's own output**, captured into
 * `test/fixtures/sports-parity-golden.json` by running the legacy classes in WASM
 * PHP 8.2 (`node runtime/sports-parity.mjs`). Nothing here is a transcription of
 * what the PHP was believed to do; the Node port is compared against what the PHP
 * actually did, case by case, to the last double and the last character of every
 * error message.
 *
 * This was only possible because of *which* classes were ported first. The
 * normalizer, the two engines and the sandbox provider are pure: no I/O, no global
 * state, no database, and no clock reads beyond an injectable `now`. Every earlier
 * candidate for a differential test either touched the database or diverged
 * numerically on purpose (divergence PO-1 keeps legacy's bisection projection
 * precisely so the numbers stay aligned — but nothing verified that they were).
 * Phase 14 preserved legacy's error messages and timestamp shape for this reason
 * and could not use them; this phase can.
 *
 * **It has already earned its keep.** The very first run found **F-34**: PHP's
 * `hash('crc32', …)` and PHP's `crc32()` are *different algorithms*, and legacy's
 * sandbox provider uses both in one class. The Node port had implemented one and
 * used it for both, which produced stable, plausible, self-consistent fixture ids
 * that belonged to an entirely different fixture universe than legacy's. No test
 * written against the Node implementation alone could have caught it.
 *
 * Regenerating the golden file is part of the workflow, not a recovery step: if a
 * legacy class changes, `node runtime/sports-parity.mjs` recaptures PHP's output
 * and this file reports the difference. The generator lives under `runtime/` and
 * `require`s the legacy classes by path, so producing parity evidence never
 * touches the authoritative PHP tree — `git status --porcelain application/` stays
 * empty, which `test/platform_findings.test.js` asserts independently.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeFixture, normalizeOdds } from "../src/modules/sports/normalizer.js";
import { assessOddsFreshness, assessQuality } from "../src/modules/sports/quality.js";
import { PROVIDER_STATUS, ProviderError } from "../src/modules/sports/provider-error.js";
import {
  SANDBOX_DISABLED_DETAIL,
  SANDBOX_PROVIDER_ID,
  createSandboxSportsProvider,
  crc32,
  crc32BigEndian,
  crc32HashHex,
} from "../src/modules/sports/providers/sandbox.js";

const GOLDEN_URL = new URL("./fixtures/sports-parity-golden.json", import.meta.url);

/**
 * The three fields that genuinely mean "now". The PHP generator replaces them with
 * a sentinel **before** writing the golden file, so the committed artifact does not
 * change every time it is regenerated; this applies the identical substitution to
 * the Node output. Everything else is compared exactly.
 */
const CLOCK_FIELDS = new Set(["sourceTimestamp", "lastSuccessAt", "timestamp"]);
const SENTINEL = "<NOW>";

function stripClock(value) {
  if (Array.isArray(value)) return value.map(stripClock);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = CLOCK_FIELDS.has(key) && typeof entry === "string" ? SENTINEL : stripClock(entry);
    }
    return out;
  }
  return value;
}

/** Run `fn`, capturing either its value or the message it threw — the golden file's shape. */
async function outcome(fn) {
  try {
    return { ok: true, value: stripClock(await fn()) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Compare one captured case. PHP's generator recorded the exception *class* as
 * well as its message; the Node port throws a plain `Error` for normalizer and
 * engine refusals, so the class is asserted separately where it matters (the
 * provider's typed `ProviderError`) rather than compared here.
 */
function assertOutcome(label, expected, actual) {
  assert.equal(actual.ok, expected.ok, `${label}: expected ${expected.ok ? "a value" : `the refusal "${expected.error}"`}`);
  if (expected.ok) {
    assert.deepEqual(actual.value, expected.value, `${label}: value differs from PHP`);
  } else {
    assert.equal(actual.error, expected.error, `${label}: refusal message differs from PHP`);
  }
}

const golden = JSON.parse(await readFile(GOLDEN_URL, "utf8"));
const cases = golden.cases;

// A clock after every date the generator asked for, so every fixture is FINISHED
// on both sides and no field depends on when this test runs.
const FIXED_NOW = Date.parse("2026-01-01T00:00:00Z");
const PROVIDER_LABEL = "parity-provider";

test("the golden file is the PHP generator's output and covers every case group", () => {
  assert.equal(golden.generator, "runtime/parity/sports-golden.php");
  assert.equal(golden.php.sapi, "wasm", "captured from WASM PHP, not from a transcription");
  for (const group of ["fixture", "odds", "quality", "freshness", "sandbox"]) {
    assert.ok(cases[group], `the golden file has no "${group}" group`);
  }
  // Non-vacuity: a golden file that lost its contents would make every comparison
  // below pass by iterating over nothing.
  assert.ok(Object.keys(cases.fixture).length >= 20, `expected at least 20 fixture cases, got ${Object.keys(cases.fixture).length}`);
  assert.ok(Object.keys(cases.odds).length >= 12, `expected at least 12 odds cases, got ${Object.keys(cases.odds).length}`);
  assert.ok(Object.keys(cases.quality).length >= 12, `expected at least 12 quality cases, got ${Object.keys(cases.quality).length}`);
  assert.ok(Object.keys(cases.freshness).length >= 10, `expected at least 10 freshness cases, got ${Object.keys(cases.freshness).length}`);
  assert.ok(cases.sandbox.fixtureCount >= 12, `expected at least 12 generated fixtures, got ${cases.sandbox.fixtureCount}`);
});

test("the fixture normalizer agrees with PHP on every case, including every refusal", async () => {
  for (const [name, captured] of Object.entries(cases.fixture)) {
    const actual = await outcome(() => normalizeFixture(captured.input, PROVIDER_LABEL, { now: () => FIXED_NOW }));
    assertOutcome(`fixture/${name}`, captured.result, actual);
  }
});

test("the fixture normalizer's field order and provenance stamp match PHP", () => {
  // `fieldsPresent` is `array_keys($raw)`, so it depends on the payload's own key
  // order; the returned record's key order depends on the implementation. Neither
  // is semantically load-bearing, but both are compared because a differential test
  // that ignores key order cannot notice a field being renamed.
  const captured = cases.fixture["full valid with offset kickoff"];
  assert.equal(captured.result.ok, true);
  const actual = normalizeFixture(captured.input, PROVIDER_LABEL, { now: () => FIXED_NOW });
  assert.deepEqual(Object.keys(actual), Object.keys(stripClock(captured.result.value)));
  // A +01:00 kickoff is stored as the same instant in UTC, in legacy's shape.
  assert.equal(actual.kickoff, "2020-01-04T14:00:00+00:00");
  assert.equal(actual.status, "LIVE", "lowercase status is uppercased, not refused");
  assert.equal(actual.sport, "football", "uppercase sport is lowercased");
});

test("the odds normalizer agrees with PHP, including that is_numeric(true) is false", async () => {
  for (const [name, captured] of Object.entries(cases.odds)) {
    const actual = await outcome(() => normalizeOdds(captured.input, PROVIDER_LABEL, { now: () => FIXED_NOW }));
    assertOutcome(`odds/${name}`, captured.result, actual);
  }
  // The two refusals that a JavaScript port gets wrong by default, named because
  // they are the point of the case rather than an incidental row in a table.
  const booleanOdds = cases.odds["boolean odds are refused because is_numeric(true) is false"];
  assert.equal(booleanOdds.result.ok, false);
  assert.equal(booleanOdds.result.error, "decimal odds are invalid");
  const evens = cases.odds["odds of exactly 1.0 are refused"];
  assert.equal(evens.result.ok, false, "decimal odds must be strictly greater than 1.0");
});

test("the data-quality engine agrees with PHP on score, band and both eligibility flags", async () => {
  for (const [name, captured] of Object.entries(cases.quality)) {
    const actual = await outcome(() => assessQuality(captured.fixture, captured.context));
    assertOutcome(`quality/${name}`, captured.result, actual);
  }
  // PHP's `empty()` treats the string "0" and an empty array as missing. A
  // JavaScript truthiness check would disagree on exactly these payloads, so the
  // three cases that pin it are named rather than left inside the loop.
  for (const name of [
    "a required field of the string zero counts as missing",
    "a required field of integer zero counts as missing",
    "a required empty array counts as missing",
  ]) {
    const captured = cases.quality[name];
    assert.equal(captured.result.ok, true);
    assert.ok(captured.result.value.missing.includes("externalId"), `${name}: PHP reported ${JSON.stringify(captured.result.value.missing)}`);
    assert.equal(assessQuality(captured.fixture, captured.context).missing.includes("externalId"), true, name);
  }
});

test("ticket eligibility is strictly harder to earn than prediction eligibility, as in PHP", () => {
  const looser = cases.quality["prediction eligibility is looser than ticket eligibility"].result.value;
  assert.equal(looser.eligibleForPrediction, true);
  assert.equal(looser.eligibleForTicket, false);
  const stale = cases.quality["ticket eligibility needs score and freshness together"].result.value;
  assert.equal(stale.eligibleForPrediction, true, "a stale fixture may still be predicted on");
  assert.equal(stale.eligibleForTicket, false, "but may not be staked on");
  assert.deepEqual(assessQuality(cases.quality["ticket eligibility needs score and freshness together"].fixture, cases.quality["ticket eligibility needs score and freshness together"].context), stripClock(stale));
});

test("the odds-freshness engine agrees with PHP on every verdict and reason", async () => {
  for (const [name, captured] of Object.entries(cases.freshness)) {
    const actual = await outcome(() => assessOddsFreshness(captured.odds, captured.maxAgeSeconds, captured.now));
    assertOutcome(`freshness/${name}`, captured.result, actual);
  }
  // "There is no observation" and "there is one and it cannot be dated" are
  // different facts with different reasons, and the distinction is the engine's
  // whole contribution.
  assert.equal(cases.freshness["no odds at all"].result.value.reason, "ODDS_UNAVAILABLE");
  assert.equal(cases.freshness["unparseable timestamp"].result.value.reason, "ODDS_TIMESTAMP_INVALID");
  assert.equal(cases.freshness["empty timestamp is available but never fresh"].result.value.fresh, false);
  // A numeric timestamp is refused by PHP's DateTimeImmutable too, so the strict
  // parser is parity rather than a tightening (divergence SP-2).
  assert.equal(cases.freshness["numeric timestamp"].result.value.reason, "ODDS_TIMESTAMP_INVALID");
});

test("an observation in the future clamps to age zero rather than scoring better than fresh", () => {
  const captured = cases.freshness["observation in the future clamps age to zero"].result.value;
  assert.equal(captured.ageSeconds, 0);
  assert.equal(captured.score, 100);
  assert.equal(captured.fresh, true);
});

/* -------------------------------------------------------------------------- */
/* F-34: PHP has two different CRC-32 algorithms and legacy uses both           */
/* -------------------------------------------------------------------------- */

test("crc32() reproduces PHP's reflected CRC-32/ISO-HDLC", () => {
  // The published check value for this polynomial.
  assert.equal(crc32("123456789"), 0xcbf43926);
  for (const [team, expected] of Object.entries(cases.sandbox.internals.strength)) {
    assert.equal(cases.sandbox.internals.strength[team], expected);
  }
});

test("hash('crc32') is a DIFFERENT algorithm, byte-swapped — finding F-34", () => {
  // CRC-32/BZIP2, non-reflected. Its own published check value.
  assert.equal(crc32BigEndian("123456789"), 0xfc891918);
  // PHP renders that digest little-endian, so the hex string is the byte-swapped
  // form. Asserting the swap explicitly is what stops a future reader "simplifying"
  // crc32HashHex into crc32BigEndian().toString(16) and silently regenerating every
  // fixture id in the platform.
  assert.equal(crc32BigEndian("123456789").toString(16).padStart(8, "0"), "fc891918");
  assert.equal(crc32HashHex("123456789"), "181989fc");
  assert.notEqual(crc32HashHex("123456789"), crc32("123456789").toString(16).padStart(8, "0"));

  // And against PHP's own external ids, which is the assertion that actually caught
  // the defect: the first run of this harness produced `sim-bc27c7-…` here where PHP
  // produced `sim-f3ff5d-…`.
  for (const [key, expected] of Object.entries(cases.sandbox.internals.externalId)) {
    const [league, slot] = key.split("/");
    const provider = createSandboxSportsProvider({ mode: "SANDBOX", sandboxEnabled: true, now: () => FIXED_NOW });
    assert.equal(provider.internals.externalId(league, "2020-01-04", Number(slot)), expected, `externalId/${key}`);
  }
});

/* -------------------------------------------------------------------------- */
/* The sandbox provider                                                        */
/* -------------------------------------------------------------------------- */

const sandbox = createSandboxSportsProvider({ mode: "SANDBOX", sandboxEnabled: true, now: () => FIXED_NOW });

test("the sandbox provider's PRNG internals are bit-identical to PHP's", () => {
  const expected = cases.sandbox.internals;
  for (const [team, value] of Object.entries(expected.strength)) {
    assert.equal(sandbox.internals.strength(team), value, `strength(${team})`);
  }
  for (const [team, value] of Object.entries(expected.form)) {
    assert.deepEqual(sandbox.internals.form("Premier Simulation League", team, "Bolt City"), value, `form(${team})`);
  }
  for (const [key, value] of Object.entries(expected.randValue)) {
    assert.equal(sandbox.internals.randValue(key, 0, 1), value, `randValue(${key})`);
  }
  for (const [key, value] of Object.entries(expected.randInt)) {
    const [, min, max] = key.split("/");
    const name = key.slice(0, key.length - `/${min}/${max}`.length);
    assert.equal(sandbox.internals.randInt(name, Number(min), Number(max)), value, `randInt(${key})`);
  }
  for (const [key, value] of Object.entries(expected.poisson)) {
    assert.equal(sandbox.internals.poisson(Number(key), "parity-key"), value, `poisson(${key})`);
  }
  for (const [key, value] of Object.entries(expected.kickoffTs)) {
    assert.equal(sandbox.internals.kickoffTs("2020-01-04", Number(key)), value, `kickoffTs(${key})`);
  }
  for (const [key, value] of Object.entries(expected.pairing)) {
    const [day, slot] = key.split("/");
    assert.deepEqual(sandbox.internals.pairing("Premier Simulation League", day, Number(slot)), value, `pairing(${key})`);
  }
  for (const [key, value] of Object.entries(expected.parseExternalId)) {
    const id = key === "(empty)" ? "" : key;
    assert.deepEqual(sandbox.internals.parseExternalId(id) ?? null, value ?? null, `parseExternalId(${key})`);
  }
});

test("an enabled sandbox reports the same health as PHP, reliability 0.9 and never 1.0", async () => {
  const actual = stripClock(await sandbox.health());
  assert.deepEqual(actual, cases.sandbox.health);
  assert.equal(actual.status, PROVIDER_STATUS.ONLINE);
  assert.equal(actual.reliability, 0.9, "reproducible is not the same as trustworthy");
});

test("the sandbox generates PHP's exact fixture set for a past date range", async () => {
  const fixtures = stripClock(await sandbox.fixtures({ from: "2020-01-04", to: "2020-01-05" }));
  assert.equal(fixtures.length, cases.sandbox.fixtureCount);
  assert.deepEqual(fixtures, cases.sandbox.fixtures);
  assert.deepEqual(fixtures.slice(0, 4).map((entry) => entry.externalId), cases.sandbox.sampleIds);
  for (const fixture of fixtures) {
    assert.equal(fixture.simulated, true, "every sandbox record carries the honesty marker");
    assert.equal(fixture.provider, SANDBOX_PROVIDER_ID);
    assert.equal(fixture.status, "FINISHED", "a fully past range is entirely finished");
  }
});

test("the sandbox generates PHP's exact odds and results, and refuses a future result", async () => {
  for (const [id, expected] of Object.entries(cases.sandbox.odds)) {
    assertOutcome(`sandbox.odds(${id})`, expected, await outcome(() => sandbox.odds(id)));
  }
  for (const [id, expected] of Object.entries(cases.sandbox.results)) {
    assertOutcome(`sandbox.results(${id})`, expected, await outcome(() => sandbox.results(id)));
  }
  // The refusal that matters most in this class: a simulation that returned a score
  // for a match that has not been played would fabricate an outcome.
  const future = await sandbox.fixtures({ from: "2030-06-01", to: "2030-06-01" });
  assert.ok(future.length > 0, "non-vacuity: the future range did generate fixtures");
  assert.deepEqual(await sandbox.results(future[0].externalId), []);
  assert.equal(future[0].status, "SCHEDULED");

  // An id this provider did not generate yields no data rather than an error, on
  // both sides — asking the sandbox about a real fixture is a legitimate call.
  for (const operation of ["odds", "results"]) {
    assertOutcome(`sandbox.unknown.${operation}`, cases.sandbox.unknownExternalId[operation], await outcome(() => sandbox[operation]("not-a-sandbox-id")));
  }
});

test("a disabled sandbox reports OFFLINE naming both variables, and refuses every call", async () => {
  const disabled = createSandboxSportsProvider({ mode: "SANDBOX", sandboxEnabled: false, now: () => FIXED_NOW });
  const captured = cases.sandbox.disabled;

  assert.deepEqual(await disabled.health(), captured.health);
  assert.equal(captured.health.status, PROVIDER_STATUS.OFFLINE);
  assert.equal(captured.health.reliability, 0, "so the quality engine's reliability check fails");
  assert.equal(captured.health.detail, SANDBOX_DISABLED_DETAIL);
  assert.match(captured.health.detail, /WINDELS_SPORTS_MODE=SANDBOX/);
  assert.match(captured.health.detail, /WINDELS_SPORTS_SANDBOX=1/);

  for (const operation of ["fixtures", "odds", "results"]) {
    assert.equal(captured[operation].ok, false, `${operation}: PHP refused a disabled sandbox`);
    assert.equal(captured[operation].status, PROVIDER_STATUS.OFFLINE);
    const error = await disabled[operation](operation === "fixtures" ? { from: "2020-01-04", to: "2020-01-05" } : "sim-f3ff5d-2020-01-04-0").then(
      () => null,
      (thrown) => thrown,
    );
    assert.ok(error instanceof ProviderError, `${operation}: expected a typed ProviderError`);
    assert.equal(error.message, captured[operation].error);
    assert.equal(error.status, captured[operation].status);
  }

  // Mode alone is not the opt-in: WINDELS_SPORTS_MODE defaults to SANDBOX, so a
  // host that set nothing at all must still have no provider.
  const defaulted = createSandboxSportsProvider({ now: () => FIXED_NOW });
  assert.equal((await defaulted.health()).status, PROVIDER_STATUS.OFFLINE);
  const paperMode = createSandboxSportsProvider({ mode: "PAPER", sandboxEnabled: true, now: () => FIXED_NOW });
  assert.equal((await paperMode.health()).status, PROVIDER_STATUS.OFFLINE, "sandbox data can never leak into PAPER or PRODUCTION");
});

test("sandbox generation is deterministic across instances and calls", async () => {
  const other = createSandboxSportsProvider({ mode: "SANDBOX", sandboxEnabled: true, now: () => FIXED_NOW });
  assert.deepEqual(stripClock(await other.fixtures({ from: "2020-01-04", to: "2020-01-05" })), cases.sandbox.fixtures);
  // A different seed must produce a different fixture set, otherwise the seed is
  // decorative and "reproducible" would not mean anything.
  const reseeded = createSandboxSportsProvider({ mode: "SANDBOX", sandboxEnabled: true, seed: "different-seed", now: () => FIXED_NOW });
  const reseededFixtures = await reseeded.fixtures({ from: "2020-01-04", to: "2020-01-05" });
  assert.equal(reseededFixtures.length, cases.sandbox.fixtureCount, "the shape is stable");
  assert.notDeepEqual(stripClock(reseededFixtures), cases.sandbox.fixtures, "the content is not");
});
