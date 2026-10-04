import { test } from "node:test";
import assert from "node:assert/strict";
import { multiply, validateOdds } from "../server/prediction/odds.js";
import { optimize } from "../server/prediction/optimizer.js";
const now = Date.parse("2026-10-04T12:00:00Z");
const fixture = { id: 1, status: "NS", kickoff: "2026-10-04T18:00:00Z" };
const odds = {
  fixtureId: 1,
  market: "OVER_1_5",
  bookmakerId: 1,
  bookmaker: "test-only",
  price: "1.25",
  source: "API_FOOTBALL",
  verified: true,
  manuallyAltered: false,
  timestamp: "2026-10-04T11:59:00Z",
};
const candidate = (id, price) => ({
  fixtureId: id,
  price,
  probability: 0.85,
  risk: 10,
  competitionId: id,
  homeTeamId: id * 2,
  awayTeamId: id * 2 + 1,
});
test("exact multiplication preserves original prices", () => {
  assert.equal(multiply(["1.25", "1.30", "1.35"]), "2.193750");
  assert.equal(odds.price, "1.25");
});
test("accept verified over 1.5", () =>
  assert.equal(validateOdds(fixture, odds, { now }), null));
for (const status of ["1H", "CANC", "PST"])
  test(`reject ${status}`, () =>
    assert.equal(
      validateOdds({ ...fixture, status }, odds, { now }),
      "INELIGIBLE_STATUS",
    ));
test("reject other market", () =>
  assert.ok(validateOdds(fixture, { ...odds, market: "OVER_2_5" }, { now })));
test("reject altered, stale and future odds", () => {
  for (const patch of [
    { manuallyAltered: true },
    { timestamp: "2026-10-04T10:00:00Z" },
    { timestamp: "2026-10-04T13:00:00Z" },
  ])
    assert.ok(validateOdds(fixture, { ...odds, ...patch }, { now }));
});
test("qualifying odds", () => {
  const r = optimize([candidate(1, "1.5"), candidate(2, "1.5")]);
  assert.equal(r.ticket.odds, "2.25");
});
for (const price of ["1.1", "3"])
  test(`no forced combination for ${price}`, () =>
    assert.equal(
      optimize([candidate(1, price), candidate(2, price)]).status,
      "NO QUALIFYING TICKET",
    ));
test("duplicates and team correlation rejected", () => {
  assert.equal(
    optimize([candidate(1, "1.5"), candidate(1, "1.5")]).ticket,
    null,
  );
  assert.equal(
    optimize([candidate(1, "1.5"), { ...candidate(2, "1.5"), homeTeamId: 2 }])
      .ticket,
    null,
  );
});
test("bounded search", () =>
  assert.ok(
    optimize(
      Array.from({ length: 24 }, (_, i) => candidate(i + 1, "1.2")),
      { maxCombinations: 10 },
    ).truncated,
  ));
