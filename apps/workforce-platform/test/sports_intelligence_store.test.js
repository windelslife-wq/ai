/**
 * The MySQL side of the decision chain (row 14, slice 3), against a scripted executor.
 *
 * No MySQL server runs in this sandbox, so this test cannot prove the SQL executes. What it
 * proves is the adapter's own rules, which are the part a refactor is most likely to break:
 * a duplicate prediction is an error and not a silent overwrite; a duplicate configuration
 * version is `null` (a lost race); and a calibration decision is a compare-and-set that
 * reports whether it applied. Those are checked against the SQL the adapter sends and the
 * results it is given. The file adapter runs the same behaviour in `sports_intelligence_http`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createSportsIntelligenceRepository, SPORTS_INTELLIGENCE_METHODS } from "../src/db/sports-intelligence-repository.js";
import { createSportsRepository, SPORTS_REPOSITORY_METHODS } from "../src/db/sports-repository.js";

/**
 * A scripted executor. `queries` and `executes` are queues of responses; each call records
 * its SQL and parameters so a test can assert on what was sent, not only on what came back.
 */
function scriptedExecutor({ queries = [], executes = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ kind: "query", sql, params });
      const next = queries.shift();
      if (next instanceof Error) throw next;
      return [next ?? [], []];
    },
    async execute(sql, params = []) {
      calls.push({ kind: "execute", sql, params });
      const next = executes.shift();
      if (next instanceof Error) throw next;
      return [next ?? { affectedRows: 1, insertId: 0 }, []];
    },
  };
}

const duplicate = () => Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", sqlState: "23000" });

const modelRow = {
  id: 7, model_name: "WINDELS Sports Baseline", model_version: "1.0.0", feature_version: "sports-features-v1",
  calibration_version: "", status: "ACTIVE", created_at: "2026-10-12T10:00:00.000Z",
};

const calibrationRow = {
  id: 3, model_version_id: 7, method: "platt", intercept: "0.500000", slope: "1.200000", samples: 25, positives: 12,
  ece: "0.040000", brier: "0.200000", identity_brier: "0.250000", bins: "[]", calibration_version: "cal-x",
  status: "PENDING", created_by: "ops", created_at: "2026-10-12T10:00:00.000Z", approved_by: null, approved_at: null,
};

test("the MySQL intelligence repository implements exactly the twelve names the contract lists", () => {
  assert.equal(SPORTS_INTELLIGENCE_METHODS.length, 12);
  const repository = createSportsIntelligenceRepository(scriptedExecutor());
  assert.deepEqual(Object.keys(repository).sort(), [...SPORTS_INTELLIGENCE_METHODS].sort());
  for (const name of SPORTS_INTELLIGENCE_METHODS) assert.equal(typeof repository[name], "function", name);
  // Both sides of the seam: the combined sports repository exposes them, and the shared
  // contract names them, so a route cannot depend on a method only one adapter has.
  for (const name of SPORTS_INTELLIGENCE_METHODS) {
    assert.ok(SPORTS_REPOSITORY_METHODS.includes(name), `${name} is in the sports contract`);
  }
  assert.equal(SPORTS_REPOSITORY_METHODS.length, 56, "22 foundation + 12 decision chain + 13 tickets + 9 settlement-and-measurement");
  assert.equal(typeof createSportsRepository(scriptedExecutor()).decideSportsCalibration, "function");
});

test("a prediction is insert-only: a duplicate id is an error and is never swallowed", async () => {
  const executor = scriptedExecutor({ executes: [duplicate()] });
  const repository = createSportsIntelligenceRepository(executor);
  await assert.rejects(
    repository.saveSportsPrediction({
      id: "prd_0123456789abcdef01234567", matchId: 1, modelVersionId: 7, market: "TOTAL_GOALS", selection: "OVER_1_5",
      decision: "NO_PREDICTION", rejectionReasons: ["STALE_ODDS"], createdAt: "2026-10-12T10:00:00.000Z",
    }),
    (error) => error.code === "ER_DUP_ENTRY",
    "a second write of the same decision must fail, not overwrite it",
  );
  assert.equal(executor.calls.filter((call) => /UPDATE|DELETE/.test(call.sql)).length, 0, "and no statement changes a prediction");
});

test("a predictions list is filtered by parameter, ordered newest first, and bounded", async () => {
  const executor = scriptedExecutor({ queries: [[]] });
  await createSportsIntelligenceRepository(executor).listSportsPredictions({ matchId: 4, decision: "NO_PREDICTION" }, 99999);
  const [call] = executor.calls;
  assert.match(call.sql, /WHERE match_id = \? AND decision = \?/);
  assert.match(call.sql, /ORDER BY created_at DESC, id DESC/);
  assert.match(call.sql, /LIMIT 500\b/, "a request for more than 500 is bounded, not passed through");
  assert.deepEqual(call.params, [4, "NO_PREDICTION"], "filter values are parameters, never interpolated");
});

test("a configuration version that already exists is null (a lost race), and any other error propagates", async () => {
  const lost = createSportsIntelligenceRepository(scriptedExecutor({ executes: [duplicate()] }));
  assert.equal(await lost.saveSportsConfiguration({
    version: 2, module_enabled: true, ticket_engine_enabled: true, platform_mode: "SANDBOX", engine_mode: "USER_APPROVAL_REQUIRED",
    target_odds_min: 1.5, target_odds_max: 2.5, max_selections: 3, risk_level: "MODERATE", min_confidence: 60,
    min_expected_value: 0.02, max_correlation: "LOW", min_data_quality: 75, min_liquidity: null, max_exposure: 100,
    stake_amount: 10, void_policy: "RESTITUTE_ODDS", require_calibration: true, allowed_markets: [], allowed_leagues: [],
    updated_by: "ops", reason: "x", created_at: "2026-10-12T10:00:00.000Z",
  }), null, "the UNIQUE version key refused the second writer, reported as null (mapped to 409)");

  const broken = createSportsIntelligenceRepository(scriptedExecutor({ executes: [new Error("connection lost")] }));
  await assert.rejects(broken.saveSportsConfiguration({
    version: 3, platform_mode: "SANDBOX", engine_mode: "USER_APPROVAL_REQUIRED", target_odds_min: 1.5, target_odds_max: 2.5,
    max_selections: 3, risk_level: "MODERATE", min_confidence: 60, min_expected_value: 0.02, max_correlation: "LOW",
    min_data_quality: 75, max_exposure: 100, stake_amount: 10, void_policy: "RESTITUTE_ODDS", updated_by: "ops", reason: "x",
    created_at: "2026-10-12T10:00:00.000Z",
  }), /connection lost/, "only a duplicate key is a lost race; a dropped connection is not");
});

test("a calibration decision is a compare-and-set on PENDING, and reports whether it applied", async () => {
  // Applied: the UPDATE matched one PENDING row, and the decided row is read back.
  const applied = scriptedExecutor({
    executes: [{ affectedRows: 1, insertId: 0 }],
    queries: [[{ ...calibrationRow, status: "APPROVED", approved_by: "admin", approved_at: "2026-10-12T11:00:00.000Z" }]],
  });
  const decided = await createSportsIntelligenceRepository(applied).decideSportsCalibration(3, "APPROVED", "admin", "2026-10-12T11:00:00.000Z");
  assert.equal(decided.status, "APPROVED");
  const update = applied.calls.find((call) => call.kind === "execute");
  assert.match(update.sql, /WHERE id = \? AND status = 'PENDING'/, "the UPDATE is conditional, so a second decision cannot apply");

  // Not applied: another request decided it first, so nothing changed and null comes back.
  const lost = scriptedExecutor({ executes: [{ affectedRows: 0, insertId: 0 }] });
  assert.equal(await createSportsIntelligenceRepository(lost).decideSportsCalibration(3, "REJECTED", "admin", "2026-10-12T11:00:00.000Z"), null);
  assert.equal(lost.calls.filter((call) => call.kind === "query").length, 0, "and no read-back is attempted");

  await assert.rejects(
    createSportsIntelligenceRepository(scriptedExecutor()).decideSportsCalibration(3, "PENDING", "admin", "2026-10-12T11:00:00.000Z"),
    TypeError,
    "a decision can only be APPROVED or REJECTED; PENDING is not a decision",
  );
  await assert.rejects(
    createSportsIntelligenceRepository(scriptedExecutor()).decideSportsCalibration("abc", "APPROVED", "admin", "2026-10-12T11:00:00.000Z"),
    TypeError,
    "a non-numeric id is refused before any SQL is sent",
  );
});

test("a model version is found or registered once, and a concurrent registration is absorbed", async () => {
  // Found on the first read: no insert at all.
  const found = scriptedExecutor({ queries: [[modelRow]] });
  const existing = await createSportsIntelligenceRepository(found).ensureSportsModelVersion({
    modelName: "WINDELS Sports Baseline", modelVersion: "1.0.0", featureVersion: "sports-features-v1",
    calibrationVersion: "", createdAt: "2026-10-12T10:00:00.000Z",
  });
  assert.equal(existing.id, 7);
  assert.equal(found.calls.filter((call) => call.kind === "execute").length, 0);

  // Not found, then a concurrent writer registers it first: our insert is a duplicate, which
  // is the outcome we wanted, and the second read returns the row the other writer made.
  const raced = scriptedExecutor({ queries: [[], [modelRow]], executes: [duplicate()] });
  const registered = await createSportsIntelligenceRepository(raced).ensureSportsModelVersion({
    modelName: "WINDELS Sports Baseline", modelVersion: "1.0.0", featureVersion: "sports-features-v1",
    calibrationVersion: "", createdAt: "2026-10-12T10:00:00.000Z",
  });
  assert.equal(registered.id, 7, "the racing writers agree on one identity");
  assert.equal(registered.calibration_version, null, "the '' sentinel is presented as no calibration");
});
