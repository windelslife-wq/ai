import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiFootball,
  normalizeOdds,
  normalizeForm,
  normalizeFixture,
} from "../server/providers/apiFootball.js";
const fixture = {
  fixture: { id: 20, date: "2026-10-04T18:00:00Z", status: { short: "NS" } },
  league: { id: 1, name: "Test League" },
  teams: { home: { id: 1, name: "H" }, away: { id: 2, name: "A" } },
  goals: { home: null, away: null },
};
test("provider fixture normalization rejects incomplete identities", () => {
  assert.equal(normalizeFixture(fixture).homeTeam, "H");
  assert.equal(normalizeFixture({ ...fixture, teams: {} }), null);
});
test("only exact provider Over 1.5 odds normalized; no substitution or price boost", () => {
  const payload = {
    fixture: { id: 20 },
    update: "2026-10-04T11:00:00Z",
    bookmakers: [
      {
        id: 2,
        name: "Test only",
        bets: [
          {
            id: 3,
            name: "Goals Over/Under",
            values: [
              { value: "Over 2.5", odd: "1.80" },
              { value: "Over 1.5", odd: "1.25" },
            ],
          },
        ],
      },
    ],
  };
  assert.deepEqual(
    normalizeOdds(payload, 20).map((o) => o.price),
    ["1.25"],
  );
  assert.deepEqual(
    normalizeOdds(
      {
        ...payload,
        bookmakers: [
          {
            ...payload.bookmakers[0],
            bets: [
              {
                ...payload.bookmakers[0].bets[0],
                values: [{ value: "Over 2.5", odd: "1.80" }],
              },
            ],
          },
        ],
      },
      20,
    ),
    [],
  );
  assert.deepEqual(normalizeOdds({ ...payload, update: null }, 20), []);
});
test("form excludes unfinished and future matches", () => {
  const row = {
    fixture: { id: 1, date: "2026-10-02T15:00:00Z", status: { short: "FT" } },
    teams: { home: { id: 1 }, away: { id: 2 } },
    goals: { home: 1, away: 1 },
  };
  assert.equal(
    normalizeForm(
      [
        row,
        { ...row, fixture: { ...row.fixture, id: 2, status: { short: "NS" } } },
      ],
      1,
      Date.parse("2026-10-04"),
    ).length,
    1,
  );
});
test("provider failures block without leaking key", async () => {
  const provider = new ApiFootball(null, {
    key: "test-secret",
    fetcher: async () => ({ ok: false, status: 401 }),
  });
  await assert.rejects(
    provider.get("status"),
    (e) =>
      e.code === "PROVIDER_AUTH_FAILED" && !e.message.includes("test-secret"),
  );
});
