/**
 * The ticket engine over HTTP (row 14, slice 4), against the file adapter.
 *
 * What these tests establish, and what they deliberately do not:
 *
 *  - A daily run over a day of REAL fixtures produces one ticket, awaiting a person's
 *    decision, with its legs, its window and its correlation. Nothing is executed.
 *  - A sandbox day produces no ticket, because every sandbox fixture is simulated and
 *    simulated candidates are refused for tickets (DV-20). Its predictions are still recorded.
 *  - A run is claimed per (day, configuration version): a repeat is skipped, and a
 *    configuration change opens a new run for the same day.
 *  - A decision moves a ticket once, is audited, and is refused for a second decision.
 *  - Reading is `sports.view`; running and decisions are `sports.manage` and
 *    `sports.approve`. A read-only analyst can read and cannot act.
 *  - A run that breaks is FAILED, not reported as "no candidate qualified" (DV-23).
 *
 * They do NOT establish that the numbers are right. That is `sports_tickets_parity.test.js`,
 * which holds correlation, classification and the optimizer to legacy's output.
 */
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { test } from "node:test";

import { cookieFrom, createFileStoreApp } from "./helpers.js";

const SANDBOX = { configOverrides: { env: { WINDELS_SPORTS_MODE: "SANDBOX", WINDELS_SPORTS_SANDBOX: "1" } } };
const DAY = "2026-10-12";

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  const cookie = cookieFrom(response);
  return { cookie, headers: { cookie, "x-csrf-token": body.csrfToken } };
}

/** A signed-in user with `sports.view` and nothing else: the read-only analyst. */
async function addAnalyst(store, username = "sportsanalyst") {
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
}

/**
 * The approver permission is seeded by the migrations and the platform baseline, not by the
 * test helper, so the root role is given it here.
 */
async function grantApprover(store) {
  const permission = await store.ensurePermission("sports.approve", "sports.approve");
  const superAdmin = (await store.listRoles()).find((role) => role.role_key === "super_admin");
  await store.grantRolePermission(superAdmin.id, permission.id);
}

/** Four real-data fixtures on one day: not simulated, with recent form, and different teams and leagues. */
async function seedRealFixtures(store, { day = DAY, observedAt = new Date().toISOString() } = {}) {
  const provider = await store.ensureSportsProvider("feed-test", "Feed test");
  const teams = [["Arsenal Test", "Chelsea Test", "League A"], ["Lyon Test", "Nice Test", "League B"],
    ["Porto Test", "Braga Test", "League C"], ["Ajax Test", "PSV Test", "League D"]];
  const matches = [];
  for (const [index, [home, away, competition]] of teams.entries()) {
    const hour = String(14 + index).padStart(2, "0");
    const match = await store.saveSportsMatch(provider.id, {
      externalId: `real-${day}-${index}`,
      kickoff: `${day}T${hour}:00:00.000Z`,
      sport: "football",
      competition,
      homeTeam: home,
      awayTeam: away,
      status: "SCHEDULED",
      sourceTimestamp: observedAt,
      context: {
        recentForm: {
          homeGoalsPerMatch: 1.9 + index * 0.1, awayGoalsPerMatch: 1.2,
          homeConcededPerMatch: 1.0, awayConcededPerMatch: 1.4,
          source: "feed-test:form", timestamp: observedAt,
        },
        marketLiquidity: 20000,
        restDays: 3,
      },
    });
    await store.saveSportsOdds(match.id, provider.id, {
      market: "TOTAL_GOALS", selection: "OVER_1_5", decimalOdds: 1.9, observedAt,
    });
    matches.push(match);
  }
  return matches;
}

/** An approved calibration, which the chain needs before any prediction is READY. */
async function approveCalibration(instance, headers, label = "cal-tickets") {
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

async function runDaily(instance, headers, date = DAY) {
  const response = await instance.app.inject({
    method: "POST", url: "/api/v1/sports/daily-tickets/run", headers, payload: { date },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function decide(instance, headers, ticketId, body) {
  return instance.app.inject({ method: "POST", url: `/api/v1/sports/tickets/${ticketId}/decision`, headers, payload: body });
}

test("a day of real fixtures produces one ticket, awaiting approval, with its legs and nothing executed", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());
  const root = await signIn(instance.app);
  await grantApprover(instance.store);
  await seedRealFixtures(instance.store);
  await approveCalibration(instance, root.headers);

  const run = await runDaily(instance, root.headers);
  assert.equal(run.status, "PENDING_USER_APPROVAL", JSON.stringify(run));
  assert.equal(run.fixturesRead, 4);
  assert.equal(run.simulatedRefused, 0, "real fixtures are never refused as simulated");
  assert.match(run.ticketId, /^tkt_[0-9a-f]{16}$/);

  const got = await instance.app.inject({ method: "GET", url: `/api/v1/sports/tickets/${run.ticketId}`, headers: root.headers });
  assert.equal(got.statusCode, 200, got.body);
  const { ticket, selections } = got.json();
  assert.equal(ticket.approval_status, "PENDING_USER_APPROVAL");
  assert.equal(ticket.status, "PENDING");
  assert.equal(ticket.settlement_status, "PENDING", "nothing has been settled, so nothing is claimed");
  assert.equal(ticket.selection_count, 3, "three 1.9 legs are the most that fit 5-8 with no padding");
  assert.equal(selections.length, 3, "a ticket is stored with every leg, not as a bare combination");
  assert.ok(ticket.total_odds >= 5 && ticket.total_odds <= 8, `odds ${ticket.total_odds} inside the window`);
  assert.ok(Math.abs(ticket.total_odds - 1.9 ** 3) < 1e-9);
  assert.equal(ticket.correlation, "LOW", "four different teams and leagues share no pair");
  assert.equal(new Set(selections.map((leg) => leg.match_id)).size, 3, "no two legs are the same match");

  const pending = await instance.app.inject({
    method: "GET", url: "/api/v1/sports/tickets?approvalStatus=PENDING_USER_APPROVAL", headers: root.headers,
  });
  assert.equal(pending.json().count, 1);
  const forDay = await instance.app.inject({ method: "GET", url: `/api/v1/sports/tickets?runDate=${DAY}`, headers: root.headers });
  assert.equal(forDay.json().count, 1, "a ticket is found through the day it was generated for");

  assert.equal((await instance.store.listAuditEvents({ action: "sports.daily_ticket.run" })).total, 1);
});

test("a sandbox day produces no ticket, because every sandbox fixture is simulated (DV-20), and its predictions are still recorded", async (t) => {
  const instance = await createFileStoreApp(SANDBOX);
  t.after(() => instance.cleanup());
  const root = await signIn(instance.app);
  const sync = await instance.app.inject({
    method: "POST", url: "/api/v1/sports/sync", headers: root.headers,
    payload: { jobType: "FIXTURES", providerId: "sandbox-sim", executionKey: "tickets-sandbox" },
  });
  assert.equal(sync.statusCode, 200, sync.body);
  const provider = await instance.store.ensureSportsProvider("sandbox-sim", "Sandbox");
  const matches = (await instance.app.inject({ method: "GET", url: "/api/v1/sports/matches", headers: root.headers })).json();
  const observedAt = new Date().toISOString();
  for (const match of matches.matches ?? matches) {
    await instance.store.saveSportsOdds(match.id, provider.id, { market: "TOTAL_GOALS", selection: "OVER_1_5", decimalOdds: 1.9, observedAt });
  }
  await approveCalibration(instance, root.headers, "cal-sandbox");

  const day = (matches.matches ?? matches)[0].kickoff_at.slice(0, 10);
  const run = await runDaily(instance, root.headers, day);
  assert.equal(run.status, "NO_QUALIFIED_TICKET", JSON.stringify(run));
  assert.equal(run.ticketId, null);
  assert.equal(run.simulatedRefused, run.fixturesRead, "every simulated candidate is refused for tickets");
  assert.equal(run.predictionsRecorded, run.fixturesRead, "they are still recorded as predictions");
  assert.match(run.message, /simulated candidate\(s\) refused for tickets \(DV-20\)/);

  assert.equal((await instance.app.inject({ method: "GET", url: "/api/v1/sports/tickets", headers: root.headers })).json().count, 0);
});

test("a repeat run for the same day and version is skipped; a configuration change opens a new run for that day", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());
  const root = await signIn(instance.app);
  await grantApprover(instance.store);
  await seedRealFixtures(instance.store);
  await approveCalibration(instance, root.headers);

  const first = await runDaily(instance, root.headers);
  assert.equal(first.status, "PENDING_USER_APPROVAL");
  const repeat = await runDaily(instance, root.headers);
  assert.equal(repeat.status, "DUPLICATE_SKIPPED", "the claim is keyed by (day, configuration version)");
  assert.equal(repeat.existingRunStatus, "PENDING_USER_APPROVAL");
  assert.equal((await instance.app.inject({ method: "GET", url: "/api/v1/sports/tickets", headers: root.headers })).json().count, 1,
    "a skipped run creates nothing");

  const patched = await instance.app.inject({
    method: "PATCH", url: "/api/v1/sports/configuration", headers: root.headers,
    payload: { reason: "tighten the confidence floor", min_confidence: 50 },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  const version = patched.json().configuration?.version ?? patched.json().version;
  assert.ok(version >= 1, "a change makes a new configuration version");

  const second = await runDaily(instance, root.headers);
  assert.equal(second.status, "PENDING_USER_APPROVAL", "the new version may generate its own ticket for the same day");
  assert.equal(second.configurationVersion, version);
  const runs = (await instance.app.inject({ method: "GET", url: "/api/v1/sports/daily-tickets", headers: root.headers })).json();
  assert.equal(runs.count, 2, "one run per (day, version)");
});

test("a decision moves a ticket once, is audited, and executes nothing; a second decision is refused", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());
  const root = await signIn(instance.app);
  await grantApprover(instance.store);
  await seedRealFixtures(instance.store);
  await approveCalibration(instance, root.headers);
  const first = await runDaily(instance, root.headers);

  const approved = await decide(instance, root.headers, first.ticketId, { approve: true, reason: "reviewed" });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().approvalStatus, "APPROVED_NOT_EXECUTED");
  assert.equal(approved.json().externalExecution, false, "approval is a record, never an order");

  const after = (await instance.app.inject({ method: "GET", url: `/api/v1/sports/tickets/${first.ticketId}`, headers: root.headers })).json().ticket;
  assert.equal(after.approval_status, "APPROVED_NOT_EXECUTED");
  assert.equal(after.status, "APPROVED");
  assert.equal(after.decided_by !== null, true, "the decider is recorded");
  assert.equal(after.reason, "reviewed");

  const again = await decide(instance, root.headers, first.ticketId, { approve: false, reason: "changed my mind" });
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().error?.code ?? again.json().code, "SPORTS_TICKET_ALREADY_DECIDED");
  assert.equal(((await instance.app.inject({ method: "GET", url: `/api/v1/sports/tickets/${first.ticketId}`, headers: root.headers })).json().ticket).approval_status,
    "APPROVED_NOT_EXECUTED", "the first decision stands");

  // A second ticket, on a new configuration version, to show rejection is recorded too.
  await instance.app.inject({
    method: "PATCH", url: "/api/v1/sports/configuration", headers: root.headers,
    payload: { reason: "a second version for the rejection path", min_confidence: 50 },
  });
  const second = await runDaily(instance, root.headers);
  const rejected = await decide(instance, root.headers, second.ticketId, { approve: false, reason: "not this one" });
  assert.equal(rejected.statusCode, 200, rejected.body);
  assert.equal(rejected.json().approvalStatus, "REJECTED");

  assert.equal((await instance.store.listAuditEvents({ action: "sports.ticket.approved" })).total, 1);
  assert.equal((await instance.store.listAuditEvents({ action: "sports.ticket.rejected" })).total, 1);
});

test("reading is sports.view; running and deciding are refused to a read-only analyst", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());
  const root = await signIn(instance.app);
  await grantApprover(instance.store);
  await seedRealFixtures(instance.store);
  await approveCalibration(instance, root.headers);
  const run = await runDaily(instance, root.headers);
  await addAnalyst(instance.store);
  const analyst = await signIn(instance.app, "sportsanalyst", "Sports analyst phrase");

  const read = await instance.app.inject({ method: "GET", url: `/api/v1/sports/tickets/${run.ticketId}`, headers: analyst.headers });
  assert.equal(read.statusCode, 200, "the analyst can read a ticket");

  const daily = await instance.app.inject({
    method: "POST", url: "/api/v1/sports/daily-tickets/run", headers: analyst.headers, payload: { date: DAY },
  });
  assert.equal(daily.statusCode, 403, "the analyst cannot generate tickets");

  const decision = await decide(instance, analyst.headers, run.ticketId, { approve: true, reason: "" });
  assert.equal(decision.statusCode, 403, "the analyst cannot approve a ticket");
  assert.equal(((await instance.app.inject({ method: "GET", url: `/api/v1/sports/tickets/${run.ticketId}`, headers: root.headers })).json().ticket).approval_status,
    "PENDING_USER_APPROVAL", "a refused decision changes nothing");
});

test("a disabled module runs nothing, and the run says why", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());
  const root = await signIn(instance.app);
  await seedRealFixtures(instance.store);
  const off = await instance.app.inject({
    method: "PATCH", url: "/api/v1/sports/configuration", headers: root.headers,
    payload: { reason: "switch the module off for the test", module_enabled: false },
  });
  assert.equal(off.statusCode, 200, off.body);

  const run = await runDaily(instance, root.headers);
  assert.equal(run.status, "NO_QUALIFIED_TICKET");
  assert.equal(run.message, "Sports Intelligence module is disabled");
  assert.equal(run.fixturesRead, 0, "a disabled module reads no fixtures");
  assert.equal(run.ticketId, null);
});

test("a run that breaks is recorded FAILED, not as no-qualified-ticket (DV-23)", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());
  const root = await signIn(instance.app);
  await seedRealFixtures(instance.store);
  await approveCalibration(instance, root.headers);

  // The ticket write is the only one a run cannot recover from without a clear report.
  const original = instance.store.saveSportsTicket;
  instance.store.saveSportsTicket = async () => { throw new Error("disk full"); };
  t.after(() => { instance.store.saveSportsTicket = original; });

  const run = await runDaily(instance, root.headers);
  assert.equal(run.status, "FAILED", JSON.stringify(run));
  assert.match(run.message, /unexpected failure: disk full/);
  assert.equal(run.ticketId, null);

  const runs = (await instance.app.inject({ method: "GET", url: "/api/v1/sports/daily-tickets", headers: root.headers })).json();
  assert.equal(runs.runs[0].status, "FAILED", "the stored run says so, so a later reader is not misled");
});

test("input is validated: a malformed date is refused, a malformed or unknown ticket id is 404, a non-boolean decision is 400", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());
  const root = await signIn(instance.app);
  await grantApprover(instance.store);

  const badDate = await instance.app.inject({
    method: "POST", url: "/api/v1/sports/daily-tickets/run", headers: root.headers, payload: { date: "2026-13-40" },
  });
  assert.equal(badDate.statusCode, 400, badDate.body);

  for (const id of ["not-a-ticket", "tkt_0000000000000000"]) {
    const response = await instance.app.inject({ method: "GET", url: `/api/v1/sports/tickets/${id}`, headers: root.headers });
    assert.equal(response.statusCode, 404, `${id}: ${response.body}`);
  }

  const notBoolean = await decide(instance, root.headers, "tkt_0000000000000000", { approve: "yes" });
  assert.equal(notBoolean.statusCode, 400, notBoolean.body);
});
