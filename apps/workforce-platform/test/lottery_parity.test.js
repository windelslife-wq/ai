/**
 * PHP↔Node differential parity for the lottery foundation — row 15's instance of
 * the harness **finding F-26** started and the sports foundation proved (F-34).
 *
 * Every expectation in this file is **PHP's own output**, captured into
 * `test/fixtures/lottery-parity-golden.json` by running the legacy classes in WASM
 * PHP 8.2 (`node runtime/lottery-parity.mjs`). Nothing here asserts what the PHP
 * was believed to do; the Node port is compared against what the PHP actually
 * did — to the last double, the last error character, and the exact query string
 * the official provider builds.
 *
 * The classes compared are the foundation slice of row 15: the rules engine, the
 * draw validator, the statistics engine, the PRNG and the three-provider boundary
 * (`LotteryProvider.php`, `OfficialLotteryProvider.php`). All are pure or scripted:
 * no database, no network, and every clock-derived field the sandbox provider
 * emits is sentinel-substituted on BOTH sides before comparison (`<NOW>`), so the
 * committed golden does not churn while the draw *content* — which only the seed
 * decides — is compared exactly.
 *
 * Two behaviors this harness pins that hand-written tests could only paraphrase:
 * - the official provider's **safety defaults** (disabled unless explicitly
 *   enabled; a URL with credentials is not a safe URL; an offline feed truncates
 *   its reason at 180 characters — legacy's own message contract), and
 * - the sandbox opt-in being **re-read per call**: the harness withdraws
 *   `WINDELS_LOTTERY_SANDBOX` mid-sequence and the same instance goes dark, which
 *   the Node port reproduces by passing (and then mutating) the env object.
 *
 * Regenerating the golden is part of the workflow: `node runtime/lottery-parity.mjs`.
 * The generator `require`s the legacy classes by path and never writes them —
 * `git status --porcelain application/` stays empty.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createEuroMillionsRules,
  euroMillionsRulesFromArray,
} from "../src/modules/lottery/rules.js";
import { createLotteryResultValidator } from "../src/modules/lottery/validator.js";
import { createLotteryStatisticsEngine } from "../src/modules/lottery/statistics.js";
import { seededRandom } from "../src/modules/lottery/prng.js";
import {
  createOfficialLotteryProvider,
  createSandboxLotteryProvider,
  createUnavailableLotteryProvider,
} from "../src/modules/lottery/providers.js";

const GOLDEN_URL = new URL("./fixtures/lottery-parity-golden.json", import.meta.url);
const GOLDEN = JSON.parse(await readFile(GOLDEN_URL, "utf8"));
const CASES = GOLDEN.cases;

/** The PHP generator replaces clock-derived fields with '<NOW>' before writing; this is the identical substitution. */
function clockStrip(value, stripKeys = ["drawDate", "externalId", "sourceTimestamp"]) {
  if (Array.isArray(value)) return value.map((entry) => clockStrip(entry, stripKeys));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = stripKeys.includes(key) && typeof entry === "string" ? "<NOW>" : clockStrip(entry, stripKeys);
    }
    return out;
  }
  return value;
}

/** Same outcome envelope as the PHP harness: the value, or the thrown message. */
async function outcome(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

function assertMatches(group, name, actual) {
  assert.deepEqual(actual, CASES[group][name], `${group} / ${name}`);
}

// A fixed clock inside the same Tue/Fri window the golden was generated in
// (2026-10-12, a Monday): the sandbox walk lands on the same six draws.
const NOW = new Date("2026-10-12T12:00:00Z").getTime();

test("the golden file is the PHP generator's output and covers every case group", () => {
  assert.equal(GOLDEN.generator, "runtime/parity/lottery-golden.php");
  assert.equal(GOLDEN.php.version, "8.2 (normalized)");
  for (const group of ["rules", "validator", "statistics", "prng", "sandbox", "official", "unavailable"]) {
    assert.ok(Object.keys(CASES[group] ?? {}).length > 0, `${group} is represented`);
  }
  assert.ok(Object.keys(CASES.rules).length >= 17);
  assert.ok(Object.keys(CASES.official).length >= 20);
});

test("the rules engine agrees with PHP on every case, including PHP's scalar semantics", () => {
  const rules = createEuroMillionsRules();
  const inputs = {
    "a valid line": [[5, 12, 23, 34, 49], [3, 11]],
    "unordered mains are the callers problem": [[49, 34, 23, 12, 5], [3, 11]],
    "a duplicate main": [[5, 5, 23, 34, 49], [3, 11]],
    "a duplicate star": [[5, 12, 23, 34, 49], [3, 3]],
    "four mains": [[5, 12, 23, 34], [3, 11]],
    "six mains": [[1, 2, 3, 4, 5, 6], [3, 11]],
    "one star": [[5, 12, 23, 34, 49], [3]],
    "main above the range": [[5, 12, 23, 34, 51], [3, 11]],
    "main below the range": [[0, 12, 23, 34, 49], [3, 11]],
    "star above the range": [[5, 12, 23, 34, 49], [3, 13]],
    "a string main is a scalar and is named": [["12", 12, 23, 34, 49], [3, 11]],
    // PHP's is_int(12.5) is false — JS agrees for genuinely fractional values and
    // names the value as PHP does. The sibling case 12.0 is NOT in this table: JS
    // numbers cannot distinguish 12.0 from 12, so that input is unrepresentable
    // here (the SP-35 divergence; the PHP harness documents its own omission).
    "a float main is not is_int": [[12.5, 12, 23, 34, 49], [3, 11]],
    "a null main is invalid, not a string": [[null, 12, 23, 34, 49], [3, 11]],
    "an array where a number belongs": [[[1], 12, 23, 34, 49], [3, 11]],
  };
  for (const [name, [main, stars]] of Object.entries(inputs)) {
    assertMatches("rules", name, rules.validateLine(main, stars));
  }
});

test("stored rules rebuild exactly as PHP rebuilds them, including the schedule fallbacks", () => {
  const rebuilt = euroMillionsRulesFromArray("EUROMILLIONS", "EuroMillions", {
    version: "1.1",
    main_count: 6,
    main_min: 1,
    main_max: 60,
    star_count: 3,
    star_min: 1,
    star_max: 16,
    schedule: JSON.stringify({ days: [3, 6], time: "20:00", timezone: "UTC" }),
  });
  assertMatches("rules", "stored rules rebuild the format", {
    version: rebuilt.version(),
    mainCount: rebuilt.mainCount(),
    starCount: rebuilt.starCount(),
    schedule: rebuilt.drawSchedule(),
    validSixThree: rebuilt.validateLine([1, 2, 3, 4, 5, 60], [1, 2, 16]),
  });

  const brokenJson = euroMillionsRulesFromArray("EUROMILLIONS", "EuroMillions", {
    version: "1.0", main_count: 5, main_min: 1, main_max: 50, star_count: 2, star_min: 1, star_max: 12, schedule: "not json",
  });
  assertMatches("rules", "an unparseable stored schedule falls back to the default", { schedule: brokenJson.drawSchedule() });

  const missingDays = euroMillionsRulesFromArray("EUROMILLIONS", "EuroMillions", {
    version: "1.0", main_count: 5, main_min: 1, main_max: 50, star_count: 2, star_min: 1, star_max: 12, schedule: JSON.stringify({ time: "21:00" }),
  });
  assertMatches("rules", "a stored schedule without days falls back to the default", { schedule: missingDays.drawSchedule() });
});

test("the draw validator agrees with PHP on every case, including the coercion order", () => {
  const validator = createLotteryResultValidator(createEuroMillionsRules());
  const base = {
    externalId: "SIM-2026-10-09",
    drawDate: "2026-10-09",
    main: [1, 6, 34, 43, 44],
    stars: [5, 11],
    source: "sandbox-simulation",
    sourceTimestamp: "2026-10-09T21:00:00+00:00",
  };
  const inputs = {
    "a valid draw": base,
    "a missing external id": { ...base, externalId: undefined },
    "an empty external id": { ...base, externalId: "" },
    "a missing draw date": { ...base, drawDate: undefined },
    "an impossible calendar day": { ...base, drawDate: "2026-02-30" },
    "a non-leap february 29": { ...base, drawDate: "2027-02-29" },
    "a leap february 29 is real": { ...base, drawDate: "2028-02-29" },
    "a malformed draw date": { ...base, drawDate: "09/10/2026" },
    "a missing source": { ...base, source: undefined },
    "an empty source": { ...base, source: "" },
    "a missing source timestamp": { ...base, sourceTimestamp: undefined },
    "numeric-string numbers are coerced": { ...base, main: ["1", 6, 34, 43, 44] },
    "a non-numeric entry becomes -1 and reports the range": { ...base, main: [1, "x", 34, 43, 44] },
    "a float number is truncated then judged": { ...base, main: [1.9, 6, 34, 43, 44] },
    "a non-array main is an empty list": { ...base, main: 7 },
    "a null main is an empty list": { ...base, main: null },
    "a wrong count via coercion": { ...base, stars: [5, 11, 99] },
  };
  for (const [name, draw] of Object.entries(inputs)) {
    assertMatches("validator", name, validator.validate(draw));
  }
});

test("the statistics engine agrees with PHP on every engine and the empty history", () => {
  const engine = createLotteryStatisticsEngine();
  const draws = [
    { drawDate: "2026-09-22", main: [1, 2, 3, 4, 5], stars: [1, 2] },
    { drawDate: "2026-09-25", main: [5, 10, 15, 20, 25], stars: [2, 3] },
    { drawDate: "2026-09-29", main: [1, 5, 10, 20, 25], stars: [1, 3] },
    { drawDate: "2026-10-02", main: [7, 14, 21, 28, 35], stars: [4, 5] },
    { drawDate: "2026-10-06", main: [1, 5, 7, 14, 35], stars: [1, 4] },
    { drawDate: "2026-10-09", main: [2, 3, 7, 21, 28], stars: [2, 5] },
    { drawDate: "2026-10-12", main: [7, 14, 21, 28, 35], stars: [4, 5] },
  ];

  assertMatches("statistics", "numbers", engine.numberStats(draws, 1, 50, 4));
  assertMatches("statistics", "stars", engine.starStats(draws, 1, 12, 0));
  assertMatches("statistics", "hot-cold", engine.hotCold(draws, "main", 1, 50, 3, 3));
  assertMatches("statistics", "hot-cold default window", engine.hotCold(draws, "main", 1, 50));
  assertMatches("statistics", "distribution", engine.distribution(draws, 1, 50, 5));
  assertMatches("statistics", "pairs", engine.groupStats(draws, "main", 1, 50, 2, 8));
  assertMatches("statistics", "triplets", engine.groupStats(draws, "main", 1, 50, 3, 8));
  assertMatches("statistics", "star-pairs", engine.groupStats(draws, "stars", 1, 12, 2, 5));
  assertMatches("statistics", "empty history", {
    numbers: engine.numberStats([], 1, 50, 4),
    "hot-cold": engine.hotCold([], "main", 1, 50),
    distribution: engine.distribution([], 1, 50, 5),
  });
});

test("the PRNG internals are bit-identical to PHP's xorshift32", () => {
  const first = (seed, count) => {
    const rand = seededRandom(seed);
    return Array.from({ length: count }, () => rand());
  };
  assertMatches("prng", "seed42-first10", first(42, 10));
  assertMatches("prng", "seed1-first5", first(1, 5));
  assertMatches("prng", "seed0-is-seed1", [first(0, 1)[0], first(1, 1)[0]]);
  assertMatches("prng", "seed-negative-masks-like-php", first(-42, 1));
});

test("the sandbox provider agrees with PHP, including the mid-sequence withdrawal", async () => {
  // The env object is shared and later mutated: legacy reads getenv per call, and
  // the port must too — a provider that captured the flag at construction would
  // stay online after the withdrawal below.
  const env = { WINDELS_LOTTERY_SANDBOX: "1" };
  const sandbox = createSandboxLotteryProvider({ seed: 42, now: () => NOW, env });

  // Enabled-state observations first — enabled() re-reads the env object per call,
  // exactly as legacy re-reads getenv, so ordering is part of what is pinned.
  const draws = await sandbox.draws(null, null, 6);
  const bounded = await sandbox.draws("2026-10-07", null, 100);
  assertMatches("sandbox", "health online", sandbox.health());
  assertMatches("sandbox", "jackpot info while enabled states the simulation", await sandbox.jackpotInfo());
  assertMatches("sandbox", "draw-count-6", draws.length);
  assertMatches("sandbox", "draws stripped of clock fields", clockStrip(draws));
  assertMatches("sandbox", "a from-bound stops the walk", [bounded.length, clockStrip(bounded)]);
  assertMatches("sandbox", "limit is capped at 1000", (await sandbox.draws(null, null, 5000)).length === 1000 ? "capped" : "not capped");

  // Withdraw the opt-in: the SAME instance goes dark for health, draws and jackpot.
  delete env.WINDELS_LOTTERY_SANDBOX;
  assertMatches("sandbox", "disabled health", sandbox.health());
  assertMatches("sandbox", "disabled draws are empty", await sandbox.draws(null, null, 10));
  assertMatches("sandbox", "disabled jackpot is null", await sandbox.jackpotInfo());
  assertMatches("sandbox", "jackpot info after the withdrawal is null (the env is read per call)", await sandbox.jackpotInfo());
});

test("the official provider agrees with PHP on every safety default and alias", async () => {
  const cases = CASES.official;

  assertMatches(
    "official",
    "disabled by default",
    await createOfficialLotteryProvider().health());
  assertMatches(
    "official",
    "an explicit url does not enable the feed",
    await createOfficialLotteryProvider({ url: "https://feed.example/v1" }).health());
  assertMatches(
    "official",
    "missing license is unconfigured",
    await createOfficialLotteryProvider({ url: "https://feed.example/v1", enabled: true }).health());
  assertMatches(
    "official",
    "an insecure url is unconfigured",
    await createOfficialLotteryProvider({ url: "http://feed.example/v1", enabled: true, license: "LIC", source: "src" }).health());
  assertMatches(
    "official",
    "credentials in the url are unsafe",
    await createOfficialLotteryProvider({ url: "https://user:pass@feed.example/v1", enabled: true, license: "LIC", source: "src" }).health());
  assertMatches(
    "official",
    "an empty url is unconfigured",
    await createOfficialLotteryProvider({ url: "", enabled: true, license: "LIC", source: "src" }).health());

  assertMatches(
    "official",
    "a health endpoint that reports failure is offline",
    await createOfficialLotteryProvider({ url: "https://feed.example/v1", enabled: true, license: "LIC", source: "src", request: () => ({ ok: false }) }).health(),
  );
  assertMatches(
    "official",
    "an unreachable feed is offline with the reason truncated",
    await createOfficialLotteryProvider({
      url: "https://feed.example/v1", enabled: true, license: "LIC", source: "src",
      request: () => { throw new Error(`connection refused ${"x".repeat(200)}`); },
    }).health(),
  );

  const seen = [];
  const online = createOfficialLotteryProvider({
    url: "https://feed.example/v1", enabled: true, token: "secret-token", license: "LIC-2026", source: "licensed-source",
    request: (url, token) => { seen.push({ url, token }); return { ok: true, version: 9 }; },
  });
  assertMatches("official", "an online feed reports its version and source", await online.health());
  assertMatches("official", "the url and token travel to the transport", seen);

  assertMatches(
    "official",
    "a non-scalar version is null",
    await createOfficialLotteryProvider({ url: "https://feed.example/v1", enabled: true, license: "LIC", source: "src", request: () => ({ ok: true, version: ["9"] }) }).health(),
  );

  assertMatches(
    "official",
    "draws map the vendor aliases",
    await createOfficialLotteryProvider({
      url: "https://feed.example/v1", enabled: true, license: "LIC", source: "licensed-source",
      request: () => ({ data: { draws: [{ drawId: "D9", date: "2026-10-09", winningNumbers: [1, 2, 3, 4, 5], luckyStars: [2, 5], updatedAt: "2026-10-09T21:00:00Z", jackpot: 17000000, rollover: 1, winners: 3 }] } }),
    }).draws(null, null, 10),
  );

  assertMatches(
    "official",
    "snake_case aliases map too",
    await createOfficialLotteryProvider({
      url: "https://feed.example/v1", enabled: true, license: "LIC", source: "src",
      request: () => ({ draws: [{ external_id: "D10", draw_date: "2026-10-06", main: [13, 23, 35, 36, 40], stars: [2, 4], source_timestamp: "2026-10-06T21:00:00Z", rollover: 0 }] }),
    }).draws(null, null, 10),
  );

  assertMatches(
    "official",
    "nested main and stars objects unwrap one level",
    await createOfficialLotteryProvider({
      url: "https://feed.example/v1", enabled: true, license: "LIC", source: "src",
      request: () => ({ draws: [{ externalId: "N1", drawDate: "2026-10-09", main: { main: [1, 2, 3, 4, 5] }, stars: { stars: [2, 5] }, sourceTimestamp: "2026-10-09T21:00:00Z" }] }),
    }).draws(null, null, 10),
  );

  assertMatches(
    "official",
    "missing fields stay missing so the validator can reject them",
    await createOfficialLotteryProvider({
      url: "https://feed.example/v1", enabled: true, license: "LIC", source: "src",
      request: () => ({ draws: [{ externalId: "H1" }] }),
    }).draws(null, null, 10),
  );

  assertMatches(
    "official",
    "rollover follows PHP truthiness, not JS truthiness",
    await createOfficialLotteryProvider({
      url: "https://feed.example/v1", enabled: true, license: "LIC", source: "src",
      request: () => ({ draws: [
        { externalId: "R0", rollover: "0" },
        { externalId: "R1", rollover: "0.0" },
        { externalId: "R2", rollover: [] },
        { externalId: "R3", rollover: true },
      ] }),
    }).draws(null, null, 10).then((draws) => draws.map((d) => d.rollover)),
  );

  const urls = [];
  const query = createOfficialLotteryProvider({
    url: "https://feed.example/v1/", enabled: true, license: "LIC", source: "src",
    request: (url) => { urls.push(url); return { draws: [] }; },
  });
  query.draws(null, null, 5000);
  query.draws("2026-10-01", "2026-10-09", 5);
  assertMatches("official", "the endpoint query carries limit first, then from and to, RFC3986-encoded", urls);

  assertMatches(
    "official",
    "an empty draw list is an empty list, not an error",
    await createOfficialLotteryProvider({ url: "https://feed.example/v1", enabled: true, license: "LIC", source: "src", request: () => ({ draws: [] }) }).draws(null, null, 10),
  );

  assertMatches(
    "official",
    "a non-list payload is refused",
    await outcome(() => createOfficialLotteryProvider({ url: "https://feed.example/v1", enabled: true, license: "LIC", source: "src", request: () => ({ draws: { not: "a list" } }) }).draws(null, null, 10)),
  );
  assertMatches(
    "official",
    "invalid json is refused",
    await outcome(() => createOfficialLotteryProvider({ url: "https://feed.example/v1", enabled: true, license: "LIC", source: "src", request: () => "nope" }).draws(null, null, 10)),
  );

  assertMatches("official", "unconfigured draws are empty, not an error", await createOfficialLotteryProvider().draws(null, null, 10));
  assertMatches(
    "official",
    "jackpot info without a jackpot url is null",
    await createOfficialLotteryProvider({ url: "https://feed.example/v1", enabled: true, license: "LIC", source: "src", request: () => ({ ok: true }) }).jackpotInfo(),
  );
  assertMatches(
    "official",
    "unconfigured jackpot info is null",
    await createOfficialLotteryProvider().jackpotInfo());
});

test("the unavailable provider is PHP's safe default, word for word", async () => {
  const provider = createUnavailableLotteryProvider();
  assertMatches("unavailable", "health", await provider.health());
  assertMatches("unavailable", "draws", await provider.draws(null, null, 10));
  assertMatches("unavailable", "jackpot", await provider.jackpotInfo());
});
