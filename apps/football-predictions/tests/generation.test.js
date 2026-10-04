import { test } from "node:test";
import assert from "node:assert/strict";
import { generate } from "../server/generation.js";
import { runJob } from "../server/jobs/sync.js";
function emptyPool() {
  const calls = [];
  const pool = {
    calls,
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith("INSERT IGNORE INTO fp_generation"))
        return [{ insertId: 1, affectedRows: 1 }];
      if (sql.startsWith("SELECT * FROM fp_settings"))
        return [
          [
            {
              max_odds_age_seconds: 900,
              max_selections: 8,
              restrict_teams: 1,
              max_per_competition: 2,
              min_quality: 80,
              min_confidence: 70,
              max_risk: 30,
            },
          ],
        ];
      if (sql.includes("FROM fp_fixtures")) return [[]];
      return [{}];
    },
  };
  return pool;
}
test("no provider means failed generation, no persisted ticket", async () => {
  const pool = emptyPool();
  await assert.rejects(
    generate(pool, 1, {
      provider: {
        async status() {
          throw Object.assign(Error("offline"), {
            code: "PROVIDER_UNREACHABLE",
          });
        },
      },
      now: new Date("2026-10-04T12:00:00Z"),
    }),
  );
  assert.equal(
    pool.calls.filter((c) => c.sql.startsWith("INSERT INTO fp_tickets")).length,
    0,
  );
  assert.ok(pool.calls.some((c) => c.sql.includes("status='FAILED'")));
});
test("no qualifying fixture is valid without forcing a ticket or accepting submitted odds", async () => {
  const pool = emptyPool();
  const outcome = await generate(pool, 1, {
    provider: {
      async status() {
        return { response: {} };
      },
    },
    now: new Date("2026-10-04T12:00:00Z"),
    price: "9999",
  });
  assert.equal(outcome.status, "NO_QUALIFYING_TICKET");
  assert.equal(outcome.report.fixturesScanned, 0);
  assert.equal(outcome.report.combinationsTested, 0);
  assert.equal(
    pool.calls.filter((c) => c.sql.startsWith("INSERT INTO fp_tickets")).length,
    0,
  );
});
test("health cron has no generation or publication path", async () => {
  const pool = emptyPool();
  pool.getConnection = async () => ({
    async query(sql) {
      return [[{ acquired: 1 }]];
    },
    release() {},
  });
  pool.execute = async (sql, params = []) => {
    pool.calls.push({ sql, params });
    if (sql.startsWith("INSERT INTO fp_sync_logs")) return [{ insertId: 7 }];
    return [{}];
  };
  const result = await runJob(pool, "health", {
    provider: {
      async status() {
        return { response: {} };
      },
    },
  });
  assert.equal(result.status, "OK");
  assert.equal(
    pool.calls.filter((c) => /fp_tickets|fp_generation/.test(c.sql)).length,
    0,
  );
});
