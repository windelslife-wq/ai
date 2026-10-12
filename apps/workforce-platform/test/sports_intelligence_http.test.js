/**
 * The decision chain over HTTP (row 14, slice 3), against the file adapter.
 *
 * What these tests establish, and what they deliberately do not:
 *
 *  - Configuration is versioned and append-only, refuses a change with no reason, refuses
 *    `AUTOMATED_EXECUTION` whatever the body says, and drops fields it does not declare.
 *  - A decision is recorded for a fixture with its gate's reasons, and cannot be changed.
 *  - Evaluation refuses a fixture that has never been assessed for quality.
 *  - Calibration fitting is refused in this slice, and a decision on a calibration is
 *    accepted only from PENDING, exactly once, and audited.
 *
 * They do NOT establish that the chain's numbers are right. That is the parity test
 * (`sports_intelligence_parity.test.js`), which holds every stage to legacy's output.
 */
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { test } from "node:test";

import { cookieFrom, createFileStoreApp } from "./helpers.js";

const SANDBOX = { configOverrides: { env: { WINDELS_SPORTS_MODE: "SANDBOX", WINDELS_SPORTS_SANDBOX: "1" } } };

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  const cookie = cookieFrom(response);
  return { cookie, headers: { cookie, "x-csrf-token": body.csrfToken }, userId: body.user?.id ?? null };
}

/** A signed-in user with `sports.view` and nothing else: the read-only analyst. */
async function addViewer(store, username = "sportsanalyst") {
  const user = await store.createUser({
    username,
    email: `${username}@example.test`,
    passwordHash: await bcrypt.hash("Sports analyst phrase", 4),
    displayName: "Sports Analyst",
  });
  const role = (await store.listRoles()).find((entry) => entry.role_key === "platform_member");
  for (const key of ["system.authenticated", "sports.view"]) {
    const permission = await store.ensurePermission(key, key);
    await store.grantRolePermission(role.id, permission.id);
  }
  await store.assignRole(user.id, role.id);
  return user;
}

async function syncFixtures(app, headers, executionKey) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/sports/sync",
    headers,
    payload: { jobType: "FIXTURES", providerId: "sandbox-sim", executionKey },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function firstMatchId(app, headers) {
  const response = await app.inject({ method: "GET", url: "/api/v1/sports/matches", headers });
  assert.equal(response.statusCode, 200, response.body);
  const matches = response.json().matches ?? response.json();
  assert.ok(matches.length > 0, "the sandbox must have synced at least one fixture");
  return matches[0].id;
}

test("configuration is versioned, needs a reason, refuses automated execution, and drops what it does not declare", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());
  const root = await signIn(instance.app);

  const initial = await instance.app.inject({ method: "GET", url: "/api/v1/sports/configuration", headers: root.headers });
  assert.equal(initial.statusCode, 200, initial.body);
  assert.equal(initial.json().source, "default", "before any change, the configuration is the built-in default");
  assert.equal(initial.json().configuration.version, 0);

  const noReason = await instance.app.inject({
    method: "PATCH", url: "/api/v1/sports/configuration", headers: root.headers, payload: { min_confidence: 70 },
  });
  assert.equal(noReason.statusCode, 422, "a change with no reason is refused, as legacy refuses it");
  assert.equal(noReason.json().error.code, "CONFIGURATION_REASON_REQUIRED");

  const automated = await instance.app.inject({
    method: "PATCH", url: "/api/v1/sports/configuration", headers: root.headers,
    payload: { reason: "try it", engine_mode: "AUTOMATED_EXECUTION" },
  });
  assert.equal(automated.statusCode, 422, "AUTOMATED_EXECUTION is refused whatever the body says (DV-14)");
  assert.equal(automated.json().error.code, "SPORTS_CONFIGURATION_INVALID");
  assert.match(automated.json().error.message, /AUTOMATED_EXECUTION/);

  const outOfRange = await instance.app.inject({
    method: "PATCH", url: "/api/v1/sports/configuration", headers: root.headers,
    payload: { reason: "too low", min_confidence: 10 },
  });
  assert.equal(outOfRange.statusCode, 422);
  assert.match(outOfRange.json().error.message, /min_confidence must be within \[50, 100\]/);

  const first = await instance.app.inject({
    method: "PATCH", url: "/api/v1/sports/configuration", headers: root.headers,
    payload: { reason: "Tighten the confidence floor", min_confidence: 70 },
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().configuration.version, 1);
  assert.deepEqual(first.json().changed, ["min_confidence"], "the audit names exactly what changed");

  // A field the schema does not declare is refused by name, never silently applied: the
  // allow-flag cannot be smuggled into a change (DV-14), and nothing is written.
  const smuggled = await instance.app.inject({
    method: "PATCH", url: "/api/v1/sports/configuration", headers: root.headers,
    payload: { reason: "Try a hidden flag", allow_automated_execution: true, min_confidence: 60 },
  });
  assert.equal(smuggled.statusCode, 400, smuggled.body);
  assert.equal(smuggled.json().error.details[0].code, "UNKNOWN_PROPERTY");
  assert.equal(smuggled.json().error.details[0].field, "allow_automated_execution");

  const second = await instance.app.inject({
    method: "PATCH", url: "/api/v1/sports/configuration", headers: root.headers,
    payload: { reason: "Lower the floor again", min_confidence: 60 },
  });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().configuration.version, 2);
  assert.equal(second.json().configuration.engine_mode, "USER_APPROVAL_REQUIRED", "the engine mode did not move");

  const current = await instance.app.inject({ method: "GET", url: "/api/v1/sports/configuration", headers: root.headers });
  assert.equal(current.json().source, "stored");
  assert.equal(current.json().configuration.version, 2);
  assert.equal(current.json().configuration.min_confidence, 60);

  const versions = await instance.app.inject({ method: "GET", url: "/api/v1/sports/configuration/versions", headers: root.headers });
  assert.equal(versions.statusCode, 200);
  assert.deepEqual(versions.json().versions.map((row) => row.version), [2, 1], "newest first, both kept");

  const audited = await instance.store.listAuditEvents({ action: "sports.configuration.updated" });
  assert.equal(audited.total, 2, "each published version is audited, and refused ones are not");
});

test("configuration reads and writes are gated sports.manage, so an analyst is refused", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());
  await addViewer(instance.store);
  const analyst = await signIn(instance.app, "sportsanalyst", "Sports analyst phrase");

  const read = await instance.app.inject({ method: "GET", url: "/api/v1/sports/configuration", headers: analyst.headers });
  assert.equal(read.statusCode, 403, "the engine's configuration is an administrator's to read");
  const write = await instance.app.inject({
    method: "PATCH", url: "/api/v1/sports/configuration", headers: analyst.headers,
    payload: { reason: "not allowed", min_confidence: 70 },
  });
  assert.equal(write.statusCode, 403);
});

test("a decision is recorded for a fixture with its gate's reasons, and cannot be changed afterwards", async (t) => {
  const instance = await createFileStoreApp(SANDBOX);
  t.after(() => instance.cleanup());
  const root = await signIn(instance.app);
  await syncFixtures(instance.app, root.headers, "decision-fixtures-1");
  const matchId = await firstMatchId(instance.app, root.headers);

  const recorded = await instance.app.inject({
    method: "POST", url: `/api/v1/sports/matches/${matchId}/evaluate`, headers: root.headers,
  });
  assert.equal(recorded.statusCode, 200, recorded.body);
  const body = recorded.json();
  assert.equal(body.persisted, true);
  assert.match(body.prediction.id, /^prd_[0-9a-f]{24}$/, "the id is legacy's shape");
  assert.equal(body.prediction.decision, "NO_PREDICTION", "no calibration is approved, so no prediction can be ready");
  assert.equal(body.gate.decision, "REJECTED");
  assert.ok(body.gate.rejectionReasons.length > 0, "a rejection always says why");
  assert.equal(body.prediction.correlation, "UNKNOWN", "correlation is not computed until slice 4");

  const listed = await instance.app.inject({ method: "GET", url: "/api/v1/sports/predictions", headers: root.headers });
  assert.equal(listed.json().count, 1);

  const decision = await instance.app.inject({
    method: "GET", url: `/api/v1/sports/predictions/${body.prediction.id}/decision`, headers: root.headers,
  });
  assert.equal(decision.statusCode, 200);
  assert.equal(decision.json().gate.decision, "REJECTED");
  assert.deepEqual(decision.json().gate.rejectionReasons, body.gate.rejectionReasons, "the stored reasons are the ones returned");

  // Reading the intelligence previews the chain and records nothing.
  const preview = await instance.app.inject({
    method: "GET", url: `/api/v1/sports/matches/${matchId}/intelligence`, headers: root.headers,
  });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().persisted, false);
  assert.equal(preview.json().qualityAssessed, true);
  const after = await instance.app.inject({ method: "GET", url: "/api/v1/sports/predictions", headers: root.headers });
  assert.equal(after.json().count, 1, "a preview adds no decision");

  // Immutability: there is no route that changes or removes a decision.
  const patched = await instance.app.inject({
    method: "PATCH", url: `/api/v1/sports/predictions/${body.prediction.id}`, headers: root.headers, payload: { decision: "PREDICTION_READY" },
  });
  assert.notEqual(patched.statusCode, 200, "a stored prediction cannot be updated");
  const deleted = await instance.app.inject({
    method: "DELETE", url: `/api/v1/sports/predictions/${body.prediction.id}`, headers: root.headers,
  });
  assert.notEqual(deleted.statusCode, 200, "a stored prediction cannot be deleted");

  const stillThere = await instance.app.inject({
    method: "GET", url: `/api/v1/sports/predictions/${body.prediction.id}/decision`, headers: root.headers,
  });
  assert.equal(stillThere.json().prediction.decision, "NO_PREDICTION");

  // The model registry records the identity the decision was made under, uncalibrated.
  const models = await instance.app.inject({ method: "GET", url: "/api/v1/sports/models", headers: root.headers });
  assert.equal(models.json().count, 1);
  // Stored as '' (the NOT NULL key's sentinel for "uncalibrated"), presented as null.
  assert.equal(models.json().models[0].calibration_version, null, "an uncalibrated model has no calibration version");

  // Performance has no outcomes yet, so it says so and reports no metric as zero.
  const performance = await instance.app.inject({ method: "GET", url: "/api/v1/sports/models/performance", headers: root.headers });
  assert.equal(performance.statusCode, 200);
  assert.equal(performance.json().predictions, 1);
  assert.equal(performance.json().samples, 0);
  assert.equal(performance.json().outcomesAvailable, false);
  assert.equal(performance.json().metrics.brier, null, "no outcome means no Brier score, not zero");
  assert.equal(performance.json().tickets.status, "NOT_PORTED");

  const audited = await instance.store.listAuditEvents({ action: "sports.decision.recorded" });
  assert.equal(audited.total, 1);
  assert.equal(audited.events[0].entityId, body.prediction.id);
});

test("evaluation needs no stored quality row: it re-assesses, and with no price it records NO_PREDICTION", async (t) => {
  // Legacy's daily ticket re-assesses quality before it evaluates (F-38), so a fixture stored
  // without the sync that would have assessed it is not refused. The decision records what was
  // re-assessed. With no price there is no prediction, and the gate says why.
  const instance = await createFileStoreApp(SANDBOX);
  t.after(() => instance.cleanup());
  const root = await signIn(instance.app);
  const provider = await instance.store.ensureSportsProvider("sandbox-sim", "Sandbox");
  const match = await instance.store.saveSportsMatch(provider.id, {
    externalId: "unassessed-1",
    kickoff: "2026-10-20T15:00:00.000Z",
    sport: "football",
    competition: "Test League",
    homeTeam: "Home FC",
    awayTeam: "Away FC",
    status: "SCHEDULED",
    sourceTimestamp: "2026-10-12T09:00:00.000Z",
  });

  const recorded = await instance.app.inject({
    method: "POST", url: `/api/v1/sports/matches/${match.id}/evaluate`, headers: root.headers,
  });
  assert.equal(recorded.statusCode, 200, recorded.body);
  const body = recorded.json();
  assert.equal(body.prediction.decision, "NO_PREDICTION");
  assert.equal(body.gate.decision, "REJECTED");
  assert.ok(body.gate.rejectionReasons.includes("ODDS_UNAVAILABLE"), "no price is the reason");
  assert.ok(body.prediction.factors.quality.missing.includes("odds"), "the re-assessment saw no odds");
  assert.equal(body.prediction.factors.quality.band, "REJECT", "a fixture with no price and no sync is weak data");

  const listed = await instance.app.inject({ method: "GET", url: "/api/v1/sports/predictions", headers: root.headers });
  assert.equal(listed.json().count, 1, "the refused decision is stored, so it can be read back");

  const preview = await instance.app.inject({
    method: "GET", url: `/api/v1/sports/matches/${match.id}/intelligence`, headers: root.headers,
  });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().qualityAssessed, true, "quality is always re-assessed, so this is always true");

  const missing = await instance.app.inject({
    method: "POST", url: "/api/v1/sports/matches/999999/evaluate", headers: root.headers,
  });
  assert.equal(missing.statusCode, 404, "an unknown fixture is not found, not refused");
});

test("calibration fitting is refused, and approval is accepted once from PENDING and audited", async (t) => {
  const instance = await createFileStoreApp(SANDBOX);
  t.after(() => instance.cleanup());
  const root = await signIn(instance.app);
  await addViewer(instance.store);
  const analyst = await signIn(instance.app, "sportsanalyst", "Sports analyst phrase");

  const fit = await instance.app.inject({ method: "POST", url: "/api/v1/sports/calibrations/fit", headers: root.headers });
  assert.equal(fit.statusCode, 422, "a fit needs settled outcomes, which slice 5 supplies");
  assert.equal(fit.json().error.code, "SETTLED_OUTCOMES_UNAVAILABLE");
  const stillNone = await instance.app.inject({ method: "GET", url: "/api/v1/sports/calibrations", headers: root.headers });
  assert.equal(stillNone.json().count, 0, "a refused fit stores nothing");

  // Calibrations can only come from a fit, which is refused, so this test stores one PENDING
  // row directly, the way a future fit will, and tests the decision on it.
  const model = await instance.store.ensureSportsModelVersion({
    modelName: "WINDELS Sports Baseline", modelVersion: "1.0.0", featureVersion: "sports-features-v1",
    calibrationVersion: "cal-test", createdAt: "2026-10-12T10:00:00.000Z",
  });
  const fitted = {
    method: "platt", intercept: 0.5, slope: 1.2, samples: 25, positives: 12,
    ece: 0.04, brier: 0.2, identityBrier: 0.25, bins: [],
  };
  const pending = await instance.store.saveSportsCalibration({
    fit: fitted, modelVersionId: model.id, calibrationVersion: "cal-test", createdBy: "test", createdAt: "2026-10-12T10:00:00.000Z",
  });
  assert.equal(pending.status, "PENDING");

  const analystList = await instance.app.inject({
    method: "GET", url: "/api/v1/sports/calibrations?status=PENDING", headers: analyst.headers,
  });
  assert.equal(analystList.statusCode, 200, "reading calibrations needs sports.view only");
  assert.equal(analystList.json().count, 1);

  const refusedForAnalyst = await instance.app.inject({
    method: "POST", url: `/api/v1/sports/calibrations/${pending.id}/approve`, headers: analyst.headers,
  });
  assert.equal(refusedForAnalyst.statusCode, 403, "deciding a calibration needs sports.manage");

  const approved = await instance.app.inject({
    method: "POST", url: `/api/v1/sports/calibrations/${pending.id}/approve`, headers: root.headers,
  });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().calibration.status, "APPROVED");
  assert.ok(approved.json().calibration.approved_by, "the decision names its actor");
  assert.ok(approved.json().calibration.approved_at, "and its time");

  const again = await instance.app.inject({
    method: "POST", url: `/api/v1/sports/calibrations/${pending.id}/reject`, headers: root.headers,
  });
  assert.equal(again.statusCode, 409, "a decided calibration cannot be decided again");
  assert.equal(again.json().error.code, "CALIBRATION_NOT_PENDING");

  const second = await instance.store.saveSportsCalibration({
    fit: fitted, modelVersionId: model.id, calibrationVersion: "cal-test-2", createdBy: "test", createdAt: "2026-10-12T10:05:00.000Z",
  });
  const rejected = await instance.app.inject({
    method: "POST", url: `/api/v1/sports/calibrations/${second.id}/reject`, headers: root.headers,
  });
  assert.equal(rejected.statusCode, 200, rejected.body);
  assert.equal(rejected.json().calibration.status, "REJECTED");
  // SP-27: legacy stamps approved_by/approved_at on a rejection too, and the port keeps that.
  assert.ok(rejected.json().calibration.approved_by, "a rejection is stamped as legacy stamps it (SP-27)");

  const missing = await instance.app.inject({
    method: "POST", url: "/api/v1/sports/calibrations/999999/approve", headers: root.headers,
  });
  assert.equal(missing.statusCode, 404);

  assert.equal((await instance.store.listAuditEvents({ action: "sports.calibration.approved" })).total, 1);
  assert.equal((await instance.store.listAuditEvents({ action: "sports.calibration.rejected" })).total, 1);
});

/**
 * Set up a READY path: a sync (which stores a quality row), an approved calibration, and a
 * price observed at `observedAt`. Returns what the evaluate route needs.
 */
async function readyFixture(t, observedAt) {
  const instance = await createFileStoreApp(SANDBOX);
  t.after(() => instance.cleanup());
  const root = await signIn(instance.app);
  await syncFixtures(instance.app, root.headers, `ready-${observedAt}`);
  const matchId = await firstMatchId(instance.app, root.headers);
  const provider = await instance.store.ensureSportsProvider("sandbox-sim", "Sandbox");
  await instance.store.saveSportsOdds(matchId, provider.id, {
    market: "TOTAL_GOALS", selection: "OVER_1_5", decimalOdds: 1.9, observedAt,
  });
  const model = await instance.store.ensureSportsModelVersion({
    modelName: "WINDELS Sports Baseline", modelVersion: "1.0.0", featureVersion: "sports-features-v1",
    calibrationVersion: "cal-ready", createdAt: "2026-10-12T10:00:00.000Z",
  });
  const cal = await instance.store.saveSportsCalibration({
    fit: { method: "platt", intercept: 0, slope: 1, samples: 25, positives: 12, ece: 0.04, brier: 0.2, identityBrier: 0.25, bins: [] },
    modelVersionId: model.id, calibrationVersion: "cal-ready", createdBy: "test", createdAt: "2026-10-12T10:00:00.000Z",
  });
  const approved = await instance.app.inject({
    method: "POST", url: `/api/v1/sports/calibrations/${cal.id}/approve`, headers: root.headers,
  });
  assert.equal(approved.statusCode, 200, approved.body);
  return { instance, root, matchId };
}

test("a READY prediction is QUALIFIED when the quality re-assessed now passes, and the stored quality row is untouched", async (t) => {
  // The structural finding of slice 3 (F-38) is closed by re-assessment. The stored assessment
  // was made at sync, without odds, so it could never qualify anything. The evaluate route now
  // re-assesses with the current price, and the same fixture qualifies. The decision says it
  // was built on simulated data: the sandbox emits `simulated: true`, legacy treats the flag as
  // informational, and the port does the same. The flag is recorded, so a reader can see it.
  const { instance, root, matchId } = await readyFixture(t, new Date().toISOString());
  const before = await instance.store.latestSportsQuality(matchId);

  const recorded = await instance.app.inject({
    method: "POST", url: `/api/v1/sports/matches/${matchId}/evaluate`, headers: root.headers,
  });
  assert.equal(recorded.statusCode, 200, recorded.body);
  const body = recorded.json();
  assert.equal(body.prediction.decision, "PREDICTION_READY", "the model produced a prediction");
  assert.equal(body.gate.decision, "QUALIFIED", "the re-assessed quality passed the gate");
  assert.deepEqual(body.gate.rejectionReasons, []);
  assert.ok(body.prediction.factors.quality.score >= 75, "the re-assessed score clears the floor");
  assert.equal(body.prediction.factors.simulated, true, "the simulated flag is recorded, not dropped");

  const after = await instance.store.latestSportsQuality(matchId);
  assert.equal(after.score, before.score, "re-assessment writes no quality row; the sync stays the only writer");
});

test("a stale price is refused, because the re-assessment sees how old the odds are", async (t) => {
  // Three hours is past the one-hour limit legacy's daily ticket uses (`maxAgeSeconds` 3600).
  const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const { instance, root, matchId } = await readyFixture(t, threeHoursAgo);

  const recorded = await instance.app.inject({
    method: "POST", url: `/api/v1/sports/matches/${matchId}/evaluate`, headers: root.headers,
  });
  assert.equal(recorded.statusCode, 200, recorded.body);
  const body = recorded.json();
  assert.equal(body.gate.decision, "REJECTED", "a stale price cannot qualify");
  assert.ok(body.gate.rejectionReasons.length > 0, "the refusal names its reasons");
  assert.ok(body.prediction.factors.quality.missing.includes("freshness"), "freshness is what failed");
});
