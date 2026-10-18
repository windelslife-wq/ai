/**
 * Bounded record-only stake sizing (row 14, slice 6, Phase 48 — DV-27).
 *
 * What these tests establish, and what they deliberately do not:
 *
 *  - The engine is FLAT by default and byte-identical to legacy: the configured fixed
 *    `stake_amount` is the recorded stake, factors are 1, and nothing is "sized". This
 *    is the parity claim, and every pre-Phase-48 ticket test passes unchanged to prove it.
 *  - `CONFIDENCE_SCALED` multiplies the flat stake by confidence × risk × correlation
 *    factors (each in (0, 1]) and can therefore only size DOWN from it; the bound is
 *    pinned as a contract, including at the boundary confidence where the factors are 1.
 *  - Every failure mode fails conservative: unknown method → FLAT; unknown
 *    risk/correlation → the HIGH factor; missing confidence → the 0.1 floor; a
 *    non-positive or non-numeric `stake_amount` → a null stake (a refusal to size, not
 *    zero, and never an exception at ticket time).
 *  - The configuration validates the new enumeration, and every read path supplies the
 *    default: the SQL INSERT names the column, the row readers default an absent key to
 *    FLAT (rows written before migration 022), and `PATCH /sports/configuration` accepts
 *    and refuses values exactly like legacy's own enums.
 *  - A daily run records the sized stake and carries the breakdown in the run's return
 *    and its audit event — with the stake recomputed from the STORED ticket, proving the
 *    engine is reconstructible from ticket + configuration version alone.
 *
 * They do NOT establish execution of any kind: a sized stake is recorded, never staked
 * with anyone — there is no external bookmaker connector, and no test here creates one.
 */
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { test } from "node:test";

import { cookieFrom, createFileStoreApp } from "./helpers.js";
import { createSportsIntelligenceRepository } from "../src/db/sports-intelligence-repository.js";
import { buildTicket } from "../src/modules/sports/ticket-governance.js";
import {
  STAKING_METHODS,
  defaultConfiguration,
  planConfigurationUpdate,
  validateConfiguration,
  changedConfigurationFields,
} from "../src/modules/sports/configuration.js";
import {
  CORRELATION_FACTORS,
  RISK_FACTORS,
  STAKE_FLOOR_COMPONENT,
  sizeStake,
} from "../src/modules/sports/stake-sizing.js";

const DAY = "2026-10-15";

/* ---------------------------------------------------------------- the engine */

test("FLAT is legacy byte-for-byte: the fixed stake is the stake, factors are 1, nothing is 'sized'", () => {
  for (const config of [
    { stake_amount: 10 },                              // pre-022 shape: no method key at all
    { stake_amount: 10, staking_method: "FLAT" },      // the default row
    { stake_amount: 10, staking_method: "KELLY" },     // unknown methods fail to FLAT
    { stake_amount: 25.5, staking_method: null },      // null, as a reader could hand it
  ]) {
    const sizing = sizeStake(config, { confidence: 88, risk: "LOW", correlation: "LOW" });
    assert.equal(sizing.method, "FLAT", JSON.stringify(config));
    assert.equal(sizing.stake, config.stake_amount, "the recorded stake is legacy's fixed stake, unmodified");
    assert.equal(sizing.flatStake, config.stake_amount);
    assert.equal(sizing.confidenceFactor, 1);
    assert.equal(sizing.riskFactor, 1);
    assert.equal(sizing.correlationFactor, 1);
    assert.equal(sizing.sized, false);
  }
});

test("a stake amount that cannot size is a null stake, not zero and not an exception", () => {
  for (const config of [{ stake_amount: 0 }, { stake_amount: -5 }, { stake_amount: "nonsense" }, {}, null]) {
    const flat = sizeStake(config ?? {}, { confidence: 90, risk: "LOW", correlation: "LOW" });
    assert.equal(flat.stake, null, JSON.stringify(config));
    assert.equal(flat.method, "FLAT", "an unsizable amount reports the flat path, which is the honest one");
    const scaled = sizeStake({ ...(config ?? {}), staking_method: "CONFIDENCE_SCALED" }, { confidence: 90, risk: "LOW", correlation: "LOW" });
    assert.equal(scaled.stake, null);
    assert.equal(scaled.sized, false, "and reports it did not size");
  }
});

test("CONFIDENCE_SCALED sizes down from the flat stake by exact, documented factors", () => {
  const config = { stake_amount: 10, min_confidence: 75, staking_method: "CONFIDENCE_SCALED" };
  // confidence 100 → (100 − 75) / 25 = 1; risk LOW = 1; correlation LOW = 1 → cap reached, never exceeded
  assert.equal(sizeStake(config, { confidence: 100, risk: "LOW", correlation: "LOW" }).stake, 10);
  // confidence 87.5 → 12.5 / 25 = 0.5
  assert.equal(sizeStake(config, { confidence: 87.5, risk: "LOW", correlation: "LOW" }).stake, 5);
  // confidence at the gate → below the floor → the 0.1 floor applies
  assert.equal(sizeStake(config, { confidence: 75, risk: "LOW", correlation: "LOW" }).stake, 1);
  // no confidence on the ticket → the floor, not zero and not full stake
  assert.equal(sizeStake(config, { confidence: null, risk: "LOW", correlation: "LOW" }).stake, 1);
  // risk and correlation dampers, each documented in the factor tables
  assert.equal(sizeStake(config, { confidence: 100, risk: "MEDIUM", correlation: "LOW" }).stake, 5);
  assert.equal(sizeStake(config, { confidence: 100, risk: "HIGH", correlation: "LOW" }).stake, 2.5);
  assert.equal(sizeStake(config, { confidence: 100, risk: "LOW", correlation: "MEDIUM" }).stake, 5);
  assert.equal(sizeStake(config, { confidence: 100, risk: "LOW", correlation: "HIGH" }).stake, 2.5);
  // composed: 0.5 × 0.5 × 0.5 × 10 = 1.25
  assert.equal(sizeStake(config, { confidence: 87.5, risk: "MEDIUM", correlation: "MEDIUM" }).stake, 1.25);
});

test("the sized stake can never exceed the flat stake, at every corner of the factor space", () => {
  for (const flat of [0.5, 1, 10, 99.99]) {
    for (const confidence of [null, 50, 75, 88.4, 100]) {
      for (const risk of ["LOW", "MEDIUM", "HIGH", "EXTREME_UNKNOWN"]) {
        for (const correlation of ["LOW", "MEDIUM", "HIGH", "UNKNOWN"]) {
          const sizing = sizeStake(
            { stake_amount: flat, min_confidence: 75, staking_method: "CONFIDENCE_SCALED" },
            { confidence, risk, correlation },
          );
          assert.ok(sizing.stake <= flat, `${JSON.stringify(sizing)} exceeded the flat stake ${flat}`);
          assert.ok(sizing.stake >= 0);
        }
      }
    }
  }
});

test("unknown classifications fail to the HIGH factor, and the breakdown is rounded for the audit trail", () => {
  const sizing = sizeStake(
    { stake_amount: 9.99, min_confidence: 75, staking_method: "CONFIDENCE_SCALED" },
    { confidence: 87.5, risk: "UNKNOWN_CLASS", correlation: "UNREADABLE" },
  );
  assert.equal(sizing.riskFactor, RISK_FACTORS.HIGH, "an unclassified risk is the worst classification, not the best");
  assert.equal(sizing.correlationFactor, CORRELATION_FACTORS.HIGH);
  assert.equal(sizing.confidenceFactor, 0.5);
  // 9.99 × 0.5 × 0.25 × 0.25 = 0.3121875 → the documented two-decimal rounding: 0.31
  assert.equal(sizing.stake, 0.31);
  assert.equal(sizing.stake, Math.round(9.99 * 0.5 * 0.25 * 0.25 * 100) / 100);
  assert.equal(STAKE_FLOOR_COMPONENT, 0.1, "the floor is one shared constant, not scattered literals");
});

test("a min_confidence of 100 cannot divide by zero, and rounding follows phpRound", () => {
  const sizing = sizeStake(
    { stake_amount: 10, min_confidence: 100, staking_method: "CONFIDENCE_SCALED" },
    { confidence: 100, risk: "LOW", correlation: "LOW" },
  );
  assert.equal(sizing.stake, 1, "divisor clamps to 1, so even full confidence floors to 10% when the gate is 100");
  // phpRound(3.105, 2) — half away from zero, as PHP's round() does
  const half = sizeStake(
    { stake_amount: 6.21, min_confidence: 75, staking_method: "CONFIDENCE_SCALED" },
    { confidence: 87.5, risk: "LOW", correlation: "LOW" },
  );
  assert.equal(half.stake, 3.11, "6.21 × 0.5 = 3.105 → PHP's round() rounds half away from zero");
});

/* ------------------------------------------------------- configuration wiring */

test("the configuration accepts the new enumeration, refuses anything else, and defaults to FLAT", () => {
  assert.ok(STAKING_METHODS.includes("FLAT") && STAKING_METHODS.includes("CONFIDENCE_SCALED"));
  assert.equal(defaultConfiguration().staking_method, "FLAT", "the default is legacy's behaviour, exactly");

  const scaled = { ...defaultConfiguration(), staking_method: "CONFIDENCE_SCALED" };
  assert.equal(validateConfiguration(scaled), null);
  assert.equal(
    validateConfiguration({ ...defaultConfiguration(), staking_method: "KELLY" }),
    "staking_method must be one of FLAT, CONFIDENCE_SCALED",
    "legacy's style: one enumeration, one sentence",
  );
  // An absent key is not an error — every read path supplies the default (DDL,
  // prepare/read row functions), and the PHP-parity golden carries only legacy's keys.
  const absent = { ...defaultConfiguration() };
  delete absent.staking_method;
  assert.equal(validateConfiguration(absent), null, "absent means the storage default 'FLAT' applies, as the DDL says");
});

test("a configuration patch versioning carries the method and reports the change", () => {
  const base = defaultConfiguration();
  const planned = planConfigurationUpdate(base, { staking_method: "CONFIDENCE_SCALED", ignored: "dropped" }, {
    actor: "ops", reason: "enable bounded sizing", createdAt: "2026-10-17T10:00:00.000Z",
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.row.staking_method, "CONFIDENCE_SCALED");
  assert.equal(planned.row.ignored, undefined, "undeclared keys are still dropped, as legacy drops them");
  assert.equal(planned.row.version, 1);
  assert.deepEqual(changedConfigurationFields(base, planned.next), ["staking_method"]);
});

/** A scripted executor, like the store suite's: SQL and params are recorded for assertion. */
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

test("the MySQL write names the column, and both row readers default an absent key to FLAT", async () => {
  const row = {
    version: 4, module_enabled: true, ticket_engine_enabled: true, platform_mode: "SANDBOX", engine_mode: "USER_APPROVAL_REQUIRED",
    target_odds_min: 5, target_odds_max: 8, max_selections: 5, risk_level: "CONSERVATIVE", min_confidence: 75,
    min_expected_value: 0.02, max_correlation: "MEDIUM", min_data_quality: 80, min_liquidity: null, max_exposure: 100,
    stake_amount: 10, staking_method: "CONFIDENCE_SCALED", void_policy: "RESTITUTE_ODDS", require_calibration: true,
    allowed_markets: [], allowed_leagues: [], updated_by: "ops", reason: "bounded sizing on", created_at: "2026-10-17T10:00:00.000Z",
  };
  const stored = { id: 44, ...row, module_enabled: 1, ticket_engine_enabled: 1, require_calibration: 1,
    allowed_markets: "[]", allowed_leagues: "[]" };
  const executor = scriptedExecutor({ queries: [[stored]] });
  const saved = await createSportsIntelligenceRepository(executor).saveSportsConfiguration(row);
  const insert = executor.calls.find((call) => call.kind === "execute");
  assert.match(insert.sql, /staking_method/, "the INSERT names the column a host gains in migration 022");
  assert.equal(insert.sql.split("?").length, 25, "24 columns, 24 bound parameters");
  assert.ok(insert.params.includes("CONFIDENCE_SCALED"), "the method is a bound parameter, never interpolated");
  assert.equal(saved.staking_method, "CONFIDENCE_SCALED");

  // A row written before migration 022 (file adapter) has no key; both readers must
  // project FLAT, the value the DDL would have supplied — storage's absence must not
  // surface as a distinguishing state between adapters.
  const legacyStored = { id: 1, ...row, staking_method: undefined, module_enabled: 1, ticket_engine_enabled: 1,
    require_calibration: 1, allowed_markets: "[]", allowed_leagues: "[]" };
  delete legacyStored.staking_method;
  const reader = createSportsIntelligenceRepository(scriptedExecutor({ queries: [[legacyStored]] }));
  const active = await reader.activeSportsConfiguration();
  assert.equal(active.staking_method, "FLAT", "rows that predate the column read as legacy's only behaviour");
});

/* ------------------------------------------------------------ tickets + HTTP */

const SANDBOX = { configOverrides: { env: { WINDELS_SPORTS_MODE: "SANDBOX", WINDELS_SPORTS_SANDBOX: "1" } } };

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  const cookie = cookieFrom(response);
  return { cookie, headers: { cookie, "x-csrf-token": body.csrfToken } };
}

async function grantApprover(store) {
  const permission = await store.ensurePermission("sports.approve", "sports.approve");
  const superAdmin = (await store.listRoles()).find((role) => role.role_key === "super_admin");
  await store.grantRolePermission(superAdmin.id, permission.id);
}

/** Real (non-simulated) fixtures, as the slice-4 HTTP suite seeds them. */
async function seedRealFixtures(store, { day = DAY, observedAt = new Date().toISOString() } = {}) {
  const provider = await store.ensureSportsProvider("feed-test", "Feed test");
  const teams = [["Arsenal Test", "Chelsea Test", "League A"], ["Lyon Test", "Nice Test", "League B"],
    ["Porto Test", "Braga Test", "League C"], ["Ajax Test", "PSV Test", "League D"]];
  for (const [index, [home, away, competition]] of teams.entries()) {
    const hour = String(14 + index).padStart(2, "0");
    const match = await store.saveSportsMatch(provider.id, {
      externalId: `sizing-${day}-${index}`, kickoff: `${day}T${hour}:00:00.000Z`, sport: "football",
      competition, homeTeam: home, awayTeam: away, status: "SCHEDULED", sourceTimestamp: observedAt,
      context: {
        recentForm: { homeGoalsPerMatch: 1.9 + index * 0.1, awayGoalsPerMatch: 1.2, homeConcededPerMatch: 1.0, awayConcededPerMatch: 1.4, source: "feed-test:form", timestamp: observedAt },
        marketLiquidity: 20000, restDays: 3,
      },
    });
    await store.saveSportsOdds(match.id, provider.id, { market: "TOTAL_GOALS", selection: "OVER_1_5", decimalOdds: 1.9, observedAt });
  }
}

async function approveCalibration(instance, headers, label = "cal-sizing") {
  const now = new Date().toISOString();
  const model = await instance.store.ensureSportsModelVersion({
    modelName: "WINDELS Sports Baseline", modelVersion: "1.0.0", featureVersion: "sports-features-v1",
    calibrationVersion: label, createdAt: now,
  });
  const cal = await instance.store.saveSportsCalibration({
    fit: { method: "platt", intercept: 0, slope: 1, samples: 25, positives: 12, ece: 0.04, brier: 0.2, identityBrier: 0.25, bins: [] },
    modelVersionId: model.id, calibrationVersion: label, createdBy: "test", createdAt: now,
  });
  const approved = await instance.app.inject({ method: "POST", url: `/api/v1/sports/calibrations/${cal.id}/approve`, headers });
  assert.equal(approved.statusCode, 200, approved.body);
}

test("PATCH /sports/configuration accepts the method like legacy's enums, and refuses an unknown one at the edge", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());
  const root = await signIn(instance.app);

  const refused = await instance.app.inject({
    method: "PATCH", url: "/api/v1/sports/configuration", headers: root.headers,
    payload: { staking_method: "KELLY_CRITERION", reason: "try an unbounded method" },
  });
  assert.equal(refused.statusCode, 400, "the route schema owns the enumeration, like legacy's other enum fields");

  const before = (await instance.app.inject({ method: "GET", url: "/api/v1/sports/configuration", headers: root.headers })).json();
  assert.equal(before.configuration.staking_method, "FLAT", "the built-in default is legacy's behaviour");

  const changed = await instance.app.inject({
    method: "PATCH", url: "/api/v1/sports/configuration", headers: root.headers,
    payload: { staking_method: "CONFIDENCE_SCALED", reason: "enable bounded sizing for the sizing suite" },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  const after = (await instance.app.inject({ method: "GET", url: "/api/v1/sports/configuration", headers: root.headers })).json();
  assert.equal(after.configuration.staking_method, "CONFIDENCE_SCALED");
  assert.equal(after.configuration.version, before.configuration.version + 1, "append-only: a change is a new version");

  const audit = await instance.store.listAuditEvents({ action: "sports.configuration.updated" });
  assert.equal(audit.total, 1);
  assert.match(JSON.stringify(audit.events[0]), /staking_method/, "the change is audited with what changed");
});

test("a daily run under CONFIDENCE_SCALED records the sized stake, reconstructible from the stored ticket", async (t) => {
  const instance = await createFileStoreApp(SANDBOX);
  t.after(() => instance.cleanup());
  const root = await signIn(instance.app);
  await grantApprover(instance.store);
  await seedRealFixtures(instance.store);
  await approveCalibration(instance, root.headers);

  // First run, default FLAT — legacy's stake exactly, as every pre-Phase-48 run stored it.
  let run = (await instance.app.inject({
    method: "POST", url: "/api/v1/sports/daily-tickets/run", headers: root.headers, payload: { date: DAY },
  })).json();
  assert.equal(run.status, "PENDING_USER_APPROVAL", JSON.stringify(run));
  assert.equal(run.stakeSizing.method, "FLAT");
  assert.equal(run.stakeSizing.stake, 10, "the default configuration remains byte-identical to legacy");
  assert.equal(run.stakeSizing.sized, false);
  assert.equal(run.stakeSizing.confidenceFactor, 1);

  // Switch method and run again: the (day, configuration version) claim allows it,
  // because a new configuration version is a new run — as legacy's own key says.
  const changed = await instance.app.inject({
    method: "PATCH", url: "/api/v1/sports/configuration", headers: root.headers,
    payload: { staking_method: "CONFIDENCE_SCALED", reason: "compare the sized ticket against the flat one" },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  run = (await instance.app.inject({
    method: "POST", url: "/api/v1/sports/daily-tickets/run", headers: root.headers, payload: { date: DAY },
  })).json();
  assert.equal(run.status, "PENDING_USER_APPROVAL", JSON.stringify(run));
  assert.equal(run.stakeSizing.method, "CONFIDENCE_SCALED");
  assert.equal(run.stakeSizing.sized, true);
  assert.ok(run.stakeSizing.stake < 10 && run.stakeSizing.stake > 0, `bounded below the flat stake: ${run.stakeSizing.stake}`);
  assert.equal(run.stakeSizing.flatStake, 10, "the anchor the factors size down from");

  // The stored ticket carries the SAME sized stake, and re-deriving the sizing from the
  // stored ticket's own numbers (confidence, risk, correlation) plus the configuration
  // reproduces it exactly — the whole point of requiring no breakdown column.
  const got = await instance.app.inject({ method: "GET", url: `/api/v1/sports/tickets/${run.ticketId}`, headers: root.headers });
  const { ticket } = got.json();
  assert.equal(ticket.stake, run.stakeSizing.stake, "what is stored is what the run reported");
  const rederived = sizeStake(
    { stake_amount: 10, min_confidence: 75, staking_method: "CONFIDENCE_SCALED" },
    { confidence: ticket.confidence, risk: ticket.risk, correlation: ticket.correlation },
  );
  assert.equal(rederived.stake, ticket.stake, "reconstructible from ticket + configuration alone (DV-27)");
  assert.equal(rederived.method, run.stakeSizing.method);
  assert.equal(rederived.confidenceFactor, run.stakeSizing.confidenceFactor);
  assert.equal(rederived.riskFactor, run.stakeSizing.riskFactor);
  assert.equal(rederived.correlationFactor, run.stakeSizing.correlationFactor);

  // And the breakdown is in the audit event's details, so the record carries it even
  // when nobody kept the response.
  const audit = await instance.store.listAuditEvents({ action: "sports.daily_ticket.run" });
  assert.equal(audit.total, 2);
  const sizedRun = audit.events.find((event) => JSON.stringify(event).includes("CONFIDENCE_SCALED"));
  assert.ok(sizedRun, "the sized run's breakdown is in the audit event details");
  const flatRun = audit.events.find((event) => JSON.stringify(event).includes("\"FLAT\""));
  assert.ok(flatRun, "and the flat run's, identically — the default is stated, not implied by absence");
});

test("buildTicket returns the sizing breakdown as a third key the repositories do not persist", () => {
  // A ticket built by hand (the HTTP suite covers the stored path; this pins the shape:
  // `sizing` is returned for audit/response, and `prepareTicket` — which the repositories
  // call — reads only `ticket` and `selections`, so the breakdown never becomes a column).
  const optimized = {
    ticketId: "tkt_0123456789abcdef", totalOdds: 6.859, optimizationScore: 1, poolSize: 1, status: "QUALIFIED",
    selections: [{
      predictionId: "p1", matchId: 5, market: "TOTAL_GOALS", selection: "OVER_1_5",
      value: { odds: 1.9, expectedValue: 0.05, classification: "VALUE" },
      prediction: { rawModelProbability: 0.7, calibratedProbability: 0.72 },
      confidence: { confidence: 88.4 },
      risk: { classification: "MEDIUM" },
      quality: { score: 90 },
    }],
  };
  const built = buildTicket(optimized, {
    configurationVersion: 2, modelVersionId: 7,
    config: { stake_amount: 10, staking_method: "CONFIDENCE_SCALED", min_confidence: 75 },
    createdAt: "2026-10-17T11:00:00.000Z",
  });
  assert.equal(built.sizing.method, "CONFIDENCE_SCALED");
  assert.equal(built.ticket.stake, built.sizing.stake, "the stored stake is the sized stake");
  assert.ok(built.ticket.stake <= 10);
  const keys = Object.keys(built).sort();
  assert.deepEqual(keys, ["selections", "sizing", "ticket"], "three keys; the repositories destructure two of them");
});
