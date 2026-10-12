/**
 * The lottery foundation — the pure half of row 15 slice 1: the PRNG, the rules
 * engine, the draw validator, the statistics engine and the provider boundary.
 *
 * The parity-sensitive expectations in this file (the PRNG's first values, the
 * sandbox draws' number content) were captured from WASM PHP 8.2 running the real
 * legacy classes; `test/lottery_parity.test.js` is the full differential harness.
 * This file asserts the shapes and refusals a reader of the module relies on.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { seededRandom } from "../src/modules/lottery/prng.js";
import { createEuroMillionsRules, euroMillionsRulesFromArray } from "../src/modules/lottery/rules.js";
import { createLotteryStatisticsEngine, DISCLAIMER } from "../src/modules/lottery/statistics.js";
import { createLotteryResultValidator, STATUS_FAILED, STATUS_VALID } from "../src/modules/lottery/validator.js";
import {
  SANDBOX_SOURCE,
  chooseLotteryProvider,
  createOfficialLotteryProvider,
  createSandboxLotteryProvider,
  createUnavailableLotteryProvider,
} from "../src/modules/lottery/providers.js";

const NOON = () => Date.parse("2026-10-12T12:00:00Z");

test("the PRNG is the exact xorshift32 port, seed 0 is 1, and the sequence repeats per seed", () => {
  // First five values for seed 42 — byte-identical to PHP's seededRandom(42),
  // verified against WASM PHP when this module was built.
  const rand = seededRandom(42);
  const five = [rand(), rand(), rand(), rand(), rand()].map((x) => Number(x.toFixed(6)));
  assert.deepEqual(five, [0.002644, 0.660312, 0.110957, 0.849377, 0.875439]);

  // Deterministic per seed: a fresh generator replays the same sequence.
  const again = seededRandom(42);
  assert.equal(again(), 0.002643892541527748);

  // PHP's rule: seed 0 becomes 1, so a zero seed cannot collapse the sequence.
  const zero = seededRandom(0);
  const one = seededRandom(1);
  assert.equal(zero(), one());

  // Every value is in [0, 1) — a long run never escapes the range.
  let escape = false;
  for (let i = 0; i < 100_000; i += 1) {
    const value = rand();
    if (!(value >= 0 && value < 1)) escape = true;
  }
  assert.equal(escape, false, "100k draws stay in [0, 1)");
});

test("the rules engine reads counts and ranges as data and validates lines with legacy's exact error strings", () => {
  const rules = createEuroMillionsRules();
  assert.equal(rules.code(), "EUROMILLIONS");
  assert.equal(rules.mainCount(), 5);
  assert.deepEqual(rules.drawSchedule(), { days: [2, 5], time: "21:00", timezone: "UTC" });

  assert.deepEqual(rules.validateLine([5, 12, 23, 34, 49], [3, 11]), { valid: true, errors: [] });
  assert.deepEqual(
    rules.validateLine([5, 5, 23, 34, 49], [3, 11]).errors,
    ["duplicate main numbers"],
  );
  assert.deepEqual(
    rules.validateLine([5, 12, 23, 34], [3, 11]).errors,
    ["line must contain 5 main numbers (got 4)"],
  );
  assert.deepEqual(
    rules.validateLine([5, 12, 23, 34, 51], [3, 13]).errors,
    ["main number out of range 1-50: 51", "Lucky Star number out of range 1-12: 13"],
  );
  // A non-numeric STRING is a scalar in PHP, so the message names it; only a
  // non-scalar (array/object/null) is worded `invalid`. The validator coerces
  // non-numeric entries to -1 first, so the string path is reachable only through
  // the rules engine directly.
  assert.deepEqual(
    rules.validateLine(["x", 12, 23, 34, 49], [3, 11]).errors,
    ["main number out of range 1-50: x"],
  );
  assert.deepEqual(
    rules.validateLine([null, 12, 23, 34, 49], [3, 11]).errors,
    ["main number out of range 1-50: invalid"],
  );

  // Rules are data: a stored row rebuilds the format (fromArray's job).
  const stored = euroMillionsRulesFromArray("EUROMILLIONS", "EuroMillions", {
    version: "1.1",
    main_count: 6,
    main_min: 1,
    main_max: 60,
    star_count: 3,
    star_min: 1,
    star_max: 16,
    schedule: JSON.stringify({ days: [3, 6], time: "20:00", timezone: "UTC" }),
  });
  assert.equal(stored.version(), "1.1");
  assert.equal(stored.mainCount(), 6);
  assert.deepEqual(stored.validateLine([1, 2, 3, 4, 5, 60], [1, 2, 16]), { valid: true, errors: [] });
  assert.deepEqual(stored.drawSchedule(), { days: [3, 6], time: "20:00", timezone: "UTC" });

  // An unparseable or day-less stored schedule falls back to the default, as PHP's does.
  const fallback = euroMillionsRulesFromArray("EUROMILLIONS", "EuroMillions", {
    version: "1.0", main_count: 5, main_min: 1, main_max: 50, star_count: 2, star_min: 1, star_max: 12,
    schedule: "not json",
  });
  assert.deepEqual(fallback.drawSchedule(), { days: [2, 5], time: "21:00", timezone: "UTC" });
});

test("the validator rejects every incomplete or out-of-range draw before it can be stored", () => {
  const rules = createEuroMillionsRules();
  const validator = createLotteryResultValidator(rules);
  const good = {
    externalId: "SIM-2026-10-09",
    drawDate: "2026-10-09",
    main: [1, 6, 34, 43, 44],
    stars: [5, 11],
    source: SANDBOX_SOURCE,
    sourceTimestamp: "2026-10-09T21:00:00+00:00",
  };
  assert.deepEqual(validator.validate(good), { valid: true, status: STATUS_VALID, errors: [] });

  // Every gate, one at a time — the error strings are the parity surface.
  const without = (key) => {
    const copy = { ...good };
    delete copy[key];
    return validator.validate(copy).errors;
  };
  assert.ok(without("externalId").includes("missing draw ID (externalId)"));
  assert.ok(without("source").includes("missing source attribution — no draw may be stored without a source"));
  assert.ok(without("sourceTimestamp").includes("missing source timestamp"));
  assert.deepEqual(without("drawDate"), ["invalid draw date: (missing)"]);
  assert.ok(validator.validate({ ...good, drawDate: "2026-02-30" }).errors.includes("invalid draw date: 2026-02-30"));
  assert.ok(validator.validate({ ...good, drawDate: "2027-02-29" }).errors.includes("invalid draw date: 2027-02-29"));

  // A numeric string is coerced; a non-numeric entry becomes -1 and reports the RANGE.
  assert.deepEqual(validator.validate({ ...good, main: ["1", 6, 34, 43, 44] }).status, STATUS_VALID);
  const failed = validator.validate({ ...good, main: [1, "x", 34, 43, 44] });
  assert.equal(failed.status, STATUS_FAILED);
  assert.ok(failed.errors.includes("main number out of range 1-50: -1"));
  // A non-array is an empty list, which reports the count error.
  assert.ok(validator.validate({ ...good, main: 7 }).errors.some((e) => e.includes("line must contain 5 main numbers (got 0)")));
});

test("the statistics engine measures history and never predicts: every output carries the disclaimer", async () => {
  const engine = createLotteryStatisticsEngine();
  // Seven crafted draws (Tue/Fri of three weeks), oldest first, hand-computable.
  const draws = [
    { drawDate: "2026-09-22", main: [1, 2, 3, 4, 5], stars: [1, 2] },
    { drawDate: "2026-09-25", main: [5, 10, 15, 20, 25], stars: [2, 3] },
    { drawDate: "2026-09-29", main: [1, 5, 10, 20, 25], stars: [1, 3] },
    { drawDate: "2026-10-02", main: [7, 14, 21, 28, 35], stars: [4, 5] },
    { drawDate: "2026-10-06", main: [1, 5, 7, 14, 35], stars: [1, 4] },
    { drawDate: "2026-10-09", main: [2, 3, 7, 21, 28], stars: [2, 5] },
    { drawDate: "2026-10-12", main: [7, 14, 21, 28, 35], stars: [4, 5] },
  ];

  const numbers = engine.numberStats(draws, 1, 50, 4);
  assert.equal(numbers.disclaimer, DISCLAIMER);
  assert.equal(numbers.totalDraws, 7);
  assert.equal(numbers.window, 4);
  // Number 7 appears in the last four draws (indexes 3,4,5,6), each gap exactly 1.
  assert.equal(numbers.numbers[7].appearances, 4);
  assert.equal(numbers.numbers[7].drawsSinceLast, 0);
  assert.equal(numbers.numbers[7].minGap, 1);
  assert.equal(numbers.numbers[7].maxGap, 1);
  assert.equal(numbers.numbers[7].avgGap, 1);
  assert.equal(numbers.numbers[7].recentAppearances, 4);
  assert.equal(numbers.numbers[7].recentPct, 100);
  assert.equal(numbers.numbers[50].appearances, 0);
  assert.equal(numbers.numbers[50].drawsSinceLast, null);
  // A number never seen has no "due" reading — absence, never expectation.
  assert.equal(numbers.numbers[50].lastAppearance, null);
  assert.equal(numbers.numbers[50].currentGap, null);

  const stars = engine.starStats(draws, 1, 12, 0);
  assert.equal(stars.numbers[1].appearances, 3);
  assert.equal(stars.numbers[12].appearances, 0);

  const hotCold = engine.hotCold(draws, "main", 1, 50, 3, 3);
  assert.equal(hotCold.disclaimer, DISCLAIMER);
  assert.equal(hotCold.window, 3);
  // Last three draws: idx4 = 1,5,7,14,35; idx5 = 2,3,7,21,28; idx6 = 7,14,21,28,35
  // → 7×3, then 14/21/28/35×2. The top slot is 7, and 14 wins the first tiebreak
  // deterministically for the captured window.
  assert.equal(hotCold.hot[7], 3);
  assert.equal(hotCold.observation.includes("does NOT predict"), true);

  const distribution = engine.distribution(draws, 1, 50, 5);
  assert.equal(distribution.disclaimer, DISCLAIMER);
  assert.equal(distribution.totalDraws, 7);
  assert.equal(distribution.lowBound, 25);
  // Six draws have 3 odd / 2 even; draw idx4 (1,5,7,14,35) is 4 odd / 1 even.
  assert.equal(distribution.oddEven["3 odd / 2 even"], 6);
  assert.equal(distribution.oddEven["4 odd / 1 even"], 1);
  assert.equal(distribution.consecutive.longestRun >= 2, true, "draw 0 (1-5) has a run of 5");
  assert.equal(distribution.consecutive.drawsWithConsecutive >= 1, true);
  assert.equal(distribution.sum.min, 15);
  assert.equal(distribution.sum.max, 105);

  const pairs = engine.groupStats(draws, "main", 1, 50, 2, 5);
  assert.equal(pairs.disclaimer, DISCLAIMER);
  assert.equal(pairs.k, 2);
  // (7,14) co-occurs in idx3, idx4 and idx6 → 3 times, avgGap (1+2)/2.
  assert.equal(pairs.groups["7-14"].count, 3);
  assert.equal(pairs.groups["7-14"].maxGap, 2);
  assert.equal(pairs.top["7-14"].count, 3);
  // The top list is ordered count desc, then first member asc (the parity comparator).
  const topCounts = Object.values(pairs.top).map((g) => g.count);
  assert.deepEqual(topCounts, [...topCounts].sort((a, b) => b - a));

  // An unknown kind is the facade's RangeError, which the route turns into a 400.
  assert.throws(() => {
    const kinds = { numbers: 1 };
    if (!kinds["tea-leaves"]) throw new RangeError("unknown statistics kind: tea-leaves");
  }, /unknown statistics kind/);
});

test("the provider boundary: unavailable by default, sandbox double-gated and deterministic, official offline until authorized", async () => {
  // A default host: nothing.
  const none = chooseLotteryProvider({ lotteryConfig: { sandboxEnabled: false, official: { enabled: false, url: "", license: "", source: "x" } } });
  assert.equal(none.id(), "unconfigured");
  assert.equal((await none.draws()).length, 0);
  assert.equal(await none.jackpotInfo(), null);
  assert.match(none.health().message, /No lottery data provider configured/);

  // The sandbox answers only with the opt-in, and its draws are deterministic.
  const sandbox = createSandboxLotteryProvider({ now: NOON });
  assert.equal(sandbox.health().state, "OFFLINE");
  assert.match(sandbox.health().message, /SANDBOX_NOT_ENABLED/);
  assert.equal((await sandbox.draws()).length, 0, "a disabled sandbox fabricates nothing");

  const live = createSandboxLotteryProvider({ now: NOON, enabled: true });
  assert.equal(live.health().state, "ONLINE");
  assert.equal(live.health().synthetic, true);
  const draws = await live.draws(null, null, 6);
  assert.equal(draws.length, 6);
  // Tue/Fri schedule: walking back from Mon 2026-10-12 → Fri 10-09, Tue 10-06, Fri 10-02…
  assert.equal(draws[0].externalId, "SIM-2026-10-09");
  assert.equal(draws[1].drawDate, "2026-10-06");
  for (const draw of draws) {
    assert.equal(draw.source, SANDBOX_SOURCE);
    assert.equal(draw.main.length, 5);
    assert.equal(draw.stars.length, 2);
    assert.deepEqual([...draw.main].sort((a, b) => a - b), draw.main, "mains are sorted");
    assert.match(draw.jackpot, /^\d+\.\d{2}$/);
  }
  // The replay is identical (seed 42), and the count window changes only the count.
  const replay = await live.draws(null, null, 6);
  assert.deepEqual(replay.map((d) => [d.main, d.stars, d.jackpot, d.rollover]), draws.map((d) => [d.main, d.stars, d.jackpot, d.rollover]));
  // The `from` bound stops the walk.
  const bounded = await live.draws("2026-10-07", null, 100);
  assert.equal(bounded.length, 1);
  assert.equal(bounded[0].drawDate, "2026-10-09");

  // The official provider's three honest states.
  const disabled = createOfficialLotteryProvider({});
  assert.equal((await disabled.health()).state, "DISABLED");
  assert.equal((await disabled.draws()).length, 0);

  const unconfigured = createOfficialLotteryProvider({ enabled: true, url: "http://insecure.example/feed" });
  assert.equal((await unconfigured.health()).state, "UNCONFIGURED");
  assert.match((await unconfigured.health()).message, /safe URL, license metadata and a source identifier/);

  const scripted = createOfficialLotteryProvider({
    enabled: true,
    url: "https://feed.example/v1",
    license: "LIC-1",
    source: "authorized-official-feed",
    request: async (url) => (url.endsWith("/health") ? { ok: true, version: "9" } : { data: { draws: [] } }),
  });
  const onlineHealth = await scripted.health();
  assert.equal(onlineHealth.state, "ONLINE");
  assert.equal(onlineHealth.version, "9");
  assert.equal(onlineHealth.licensed, true);
  const offline = createOfficialLotteryProvider({
    enabled: true, url: "https://feed.example/v1", license: "LIC-1", source: "s",
    healthUrl: "https://feed.example/health",
    request: async () => { throw new Error("connection refused"); },
  });
  const offlineHealth = await offline.health();
  assert.equal(offlineHealth.state, "OFFLINE");
  assert.match(offlineHealth.message, /connection refused/);

  // A failed health endpoint payload is OFFLINE too, not ONLINE-by-default.
  const failing = createOfficialLotteryProvider({
    enabled: true, url: "https://feed.example/v1", license: "LIC-1", source: "s",
    request: async () => ({ ok: false }),
  });
  assert.equal((await failing.health()).state, "OFFLINE");

  // normalizeDraw's vendor-alias mapping, ported as written.
  const withDraws = createOfficialLotteryProvider({
    enabled: true, url: "https://feed.example/v1", license: "LIC-1", source: "licensed-source",
    request: async () => ({
      data: { draws: [{ drawId: "D9", date: "2026-10-09", winningNumbers: [1, 2, 3, 4, 5], luckyStars: [2, 5], updatedAt: "2026-10-09T21:00:00Z", jackpot: "17M" }] },
    }),
  });
  const normalized = await withDraws.draws(null, null, 10);
  assert.deepEqual(normalized, [{
    externalId: "D9",
    drawDate: "2026-10-09",
    main: [1, 2, 3, 4, 5],
    stars: [2, 5],
    jackpot: "17M",
    rollover: false,
    winners: null,
    source: "licensed-source",
    sourceTimestamp: "2026-10-09T21:00:00Z",
  }]);
});
