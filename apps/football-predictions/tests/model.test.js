import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../server/prediction/model.js";
const now = Date.parse("2026-10-04T12:00:00Z");
const mk = (id, venue, team, goals) => ({
  fixtureId: id,
  timestamp: new Date(now - (id + 1) * 86400000).toISOString(),
  homeId: venue === "home" ? team : 300 + id,
  awayId: venue === "away" ? team : 400 + id,
  homeGoals: goals,
  awayGoals: 1,
});
test("insufficient evidence fails closed", () =>
  assert.equal(
    analyze({ homeTeamId: 1, awayTeamId: 2 }, [], [], { now }).reason,
    "DATA_UNAVAILABLE",
  ));
test("evidence model is deterministic; odds not an input", () => {
  const fixture = { homeTeamId: 1, awayTeamId: 2 };
  const home = Array.from({ length: 10 }, (_, i) =>
    mk(i, i < 5 ? "home" : "away", 1, 1),
  );
  const away = Array.from({ length: 10 }, (_, i) =>
    mk(i + 10, i < 5 ? "away" : "home", 2, 1),
  );
  const first = analyze(fixture, home, away, { now });
  assert.ok(first.probability > 0 && first.probability < 1);
  assert.equal(first.explanation.calibration, "NOT_EMPIRICALLY_CALIBRATED");
  assert.deepEqual(
    first,
    analyze({ ...fixture, price: "99" }, home, away, { now }),
  );
});
