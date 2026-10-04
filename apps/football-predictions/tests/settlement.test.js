import { test } from "node:test";
import assert from "node:assert/strict";
import { settle } from "../server/jobs/sync.js";
function fake(status, homeGoals, awayGoals, previous = "PENDING") {
  const state = {
    ticket: {
      id: 1,
      original_odds: "2.2500",
      result: "PENDING",
      settlement_odds: null,
    },
    selection: {
      id: 2,
      price: "1.50",
      result: previous,
      fixture_status: status,
      home_goals: homeGoals,
      away_goals: awayGoals,
    },
    begin: 0,
    commits: 0,
    rollbacks: 0,
  };
  const connection = {
    async beginTransaction() {
      state.begin++;
    },
    async commit() {
      state.commits++;
    },
    async rollback() {
      state.rollbacks++;
    },
    release() {},
    async execute(sql, params) {
      if (sql.startsWith("SELECT id,original_odds"))
        return [
          [
            state.ticket.result === "PENDING" ? { ...state.ticket } : undefined,
          ].filter(Boolean),
        ];
      if (sql.startsWith("SELECT s.id,s.price_text"))
        return [[{ ...state.selection }]];
      if (sql.startsWith("UPDATE fp_selections")) {
        state.selection.result = params[0];
        return [{}];
      }
      if (sql.startsWith("UPDATE fp_tickets")) {
        state.ticket.result = params[0];
        state.ticket.settlement_odds = params[1];
        return [{}];
      }
      throw Error("unexpected SQL " + sql);
    },
  };
  return {
    state,
    pool: {
      async getConnection() {
        return connection;
      },
    },
  };
}
for (const [name, status, h, a, expected] of [
  ["two goals", "FT", 1, 1, "WON"],
  ["one goal", "FT", 1, 0, "LOST"],
  ["zero goals", "FT", 0, 0, "LOST"],
  ["cancelled", "CANC", null, null, "VOID"],
  ["postponed", "PST", null, null, "POSTPONED"],
])
  test(`settlement ${name}`, async () => {
    const { pool, state } = fake(status, h, a);
    await settle(pool);
    assert.equal(state.selection.result, expected);
    assert.equal(
      state.ticket.result,
      expected === "POSTPONED" ? "PENDING" : expected,
    );
    assert.equal(state.ticket.original_odds, "2.2500");
    assert.equal(state.commits, 1);
  });
test("unfinished match stays pending; repeated results cannot settle twice", async () => {
  const { pool, state } = fake("1H", 1, 1);
  await settle(pool);
  assert.equal(state.ticket.result, "PENDING");
  state.selection.fixture_status = "FT";
  await settle(pool);
  await settle(pool);
  assert.equal(state.ticket.result, "WON");
  assert.equal(state.selection.result, "WON");
  assert.equal(state.ticket.original_odds, "2.2500");
});
