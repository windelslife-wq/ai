/**
 * The Sports Intelligence console against the API it reads (row 3, Phase 36).
 *
 * `views/sports/index.php` → `Sports::index` and `views/sports/tickets.php` →
 * `Sports::tickets` are legacy's two screens over one module. The port put both on
 * `/app/sports`, and this suite holds it to three things:
 *
 *  1. **The copy is legacy's.** Every heading, lede, banner, empty state and note in
 *     `client/src/sports.js` is asserted against the two PHP views, so a paraphrase
 *     cannot quietly replace a page's own words.
 *  2. **The numbers come from the payloads.** Every shaping function is exercised on an
 *     empty host and on a populated one, and no metric may render as `0` when the server
 *     sent `null` — the failure mode this screen exists to avoid (legacy's own sentence
 *     for the state is "metrics are intentionally unavailable rather than invented").
 *  3. **The wiring reaches the routes, and the guards are the server's.** Every read is
 *     checked against `/api/v1/system/routes` for its permission, and the approval guard
 *     is exercised over HTTP: refused with 409 while the kill switch is ACTIVE — which is
 *     how it boots — and recorded once it is released, with settlement available
 *     throughout, exactly as legacy's refusal sentence promises.
 *
 * Hermetic like the other client suites: the file adapter, `createFileStoreApp`, no
 * network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  KILL_SWITCH_MESSAGE, KILL_SWITCH_NOTICE, SPORTS_APPROVE, SPORTS_COPY, SPORTS_EMPTY, SPORTS_MANAGE, SPORTS_PERMISSION,
  SPORTS_READS, SPORTS_SETTLE, SPORTS_WINDOWS, SPORTS_WRITES, TRADING_READ_PERMISSION,
  approvalTone, boundaryPanel, countText, dailyRunRows, dayWindow, daysBefore, holdsSportsPermission,
  instantText, killSwitchNotice, killSwitchStateText, modelPanel, numberText, percentText, performanceCards,
  performanceWindow, present, providerRows, providerTone, qualityFromIntelligence, riskMeters, riskTone,
  runStatusTone, settlementTone, shortText, syncRunRows, ticketRows, ticketView, todayIntelligence,
  upcomingRows, utcDay,
} from "../client/src/sports.js";
import { TRADING_READ_PERMISSION as DASHBOARD_TRADING_READ } from "../client/src/dashboard.js";
import { hashPassword } from "../src/security/passwords.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";

const CLIENT = path.resolve(import.meta.dirname, "..", "client", "src");
const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const LEGACY_INDEX = path.join(REPO, "application", "views", "sports", "index.php");
const LEGACY_TICKETS = path.join(REPO, "application", "views", "sports", "tickets.php");
const LEGACY_ROUTES = path.join(REPO, "apps", "workforce-platform", "src", "modules", "sports", "routes.js");
const DAY = "2026-10-12";

async function instance(t, env = {}) {
  const app = await createFileStoreApp({ configOverrides: { env: { WINDELS_SPORTS_MODE: "SANDBOX", WINDELS_SPORTS_SANDBOX: "1", ...env } } });
  t.after(() => app.cleanup());
  return app;
}

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  return { headers: { cookie: cookieFrom(response), "x-csrf-token": body.csrfToken }, user: body.user, permissions: body.permissions };
}

const get = (app, url, headers) => app.inject({ method: "GET", url, headers });

/** Grant the sports writes the console's controls need; the test seed carries only `sports.view`. */
async function grantSports(store, keys = [SPORTS_APPROVE, SPORTS_SETTLE, SPORTS_MANAGE]) {
  const superAdmin = (await store.listRoles()).find((role) => role.role_key === "super_admin");
  for (const key of keys) {
    const permission = await store.ensurePermission(key, key);
    await store.grantRolePermission(superAdmin.id, permission.id);
  }
}

/** A signed-in member with `sports.view` and nothing else — the console's read-only viewer. */
async function analystSession(app, store) {
  const role = (await store.listRoles()).find((entry) => entry.role_key === "platform_member");
  const user = await store.createUser({
    username: "sportsviewer",
    email: "sportsviewer@example.test",
    passwordHash: await hashPassword("Sports viewer phrase"),
    displayName: "Sports Viewer",
  });
  for (const key of ["system.authenticated", SPORTS_PERMISSION]) {
    const permission = await store.ensurePermission(key, key);
    await store.grantRolePermission(role.id, permission.id);
  }
  await store.assignRole(user.id, role.id);
  return signIn(app, "sportsviewer", "Sports viewer phrase");
}

/** Four real fixtures on one UTC day, with odds, as the sports HTTP suite seeds them. */
async function seedRealFixtures(store, day = DAY) {
  const observedAt = new Date().toISOString();
  const provider = await store.ensureSportsProvider("feed-test", "Feed test");
  for (const [index, [home, away, competition]] of [["Arsenal Test", "Chelsea Test", "League A"], ["Lyon Test", "Nice Test", "League B"], ["Porto Test", "Braga Test", "League C"]].entries()) {
    const match = await store.saveSportsMatch(provider.id, {
      externalId: `real-${day}-${index}`,
      kickoff: `${day}T${String(14 + index).padStart(2, "0")}:00:00.000Z`,
      sport: "football", competition, homeTeam: home, awayTeam: away, status: "SCHEDULED", sourceTimestamp: observedAt,
      context: {
        recentForm: {
          homeGoalsPerMatch: 1.9, awayGoalsPerMatch: 1.2,
          homeConcededPerMatch: 1.0, awayConcededPerMatch: 1.4, source: "feed-test:form", timestamp: observedAt,
        },
        marketLiquidity: 20000, restDays: 3,
      },
    });
    await store.saveSportsOdds(match.id, provider.id, { market: "TOTAL_GOALS", selection: "OVER_1_5", decimalOdds: 1.9, observedAt });
  }
  return provider;
}

/** An approved calibration, which the decision chain needs before a ticket can be built. */
async function approveCalibration(app, headers, store) {
  const now = new Date().toISOString();
  const model = await store.ensureSportsModelVersion({
    modelName: "WINDELS Sports Baseline", modelVersion: "1.0.0", featureVersion: "sports-features-v1",
    calibrationVersion: "cal-sports-console", createdAt: now,
  });
  const calibration = await store.saveSportsCalibration({
    fit: { method: "platt", intercept: 0, slope: 1, samples: 25, positives: 12, ece: 0.04, brier: 0.2, identityBrier: 0.25, bins: [] },
    modelVersionId: model.id, calibrationVersion: "cal-sports-console", createdBy: "test", createdAt: now,
  });
  const approved = await app.inject({ method: "POST", url: `/api/v1/sports/calibrations/${calibration.id}/approve`, headers });
  assert.equal(approved.statusCode, 200, approved.body);
}

const releaseKillSwitch = (app, headers) => app.inject({
  method: "POST", url: "/api/v1/trading/kill-switch", headers,
  payload: { active: false, reason: "the console test releases the switch before deciding" },
});

// ---------------------------------------------------------- the two pages' words

test("the headings, ledes, banners and notes are the legacy views' own words", () => {
  const index = readFileSync(LEGACY_INDEX, "utf8");
  const tickets = readFileSync(LEGACY_TICKETS, "utf8");
  assert.ok(index.includes("Sports Intelligence — daily ticket engine"), "the dashboard heading");
  assert.equal(SPORTS_COPY.title, "Sports Intelligence — daily ticket engine");
  assert.ok(index.includes(SPORTS_COPY.lede), "the dashboard lede is transcribed, not paraphrased");
  assert.ok(tickets.includes("Sports tickets"), "the tickets heading");
  assert.equal(SPORTS_COPY.ticketsTitle, "Sports tickets");
  assert.ok(tickets.includes(SPORTS_COPY.ticketsLede), "the tickets lede is transcribed too");
  assert.ok(index.includes("SANDBOX / DEMO DATA"), "the demo banner");
  assert.match(SPORTS_COPY.demoBanner, /^SANDBOX \/ DEMO DATA — sports figures are simulated, not real-world performance\.$/);
  assert.ok(index.includes("DISABLED_NO_PROVIDER"), "the providerless banner");
  assert.ok(index.includes(SPORTS_COPY.noProviderBanner.replace("DISABLED_NO_PROVIDER — ", "").trim()), "the providerless banner's text");
  assert.ok(index.includes("There is no external execution connector — approval never places a bet"), "the execution note");
  assert.match(SPORTS_COPY.executionNote, /approval never places a bet/);
  assert.ok(index.includes("Ticket console &amp; history →"), "the link between the pages");
  assert.equal(SPORTS_COPY.ticketsLink, "Ticket console & history →");
  // The panel titles: two on the dashboard, three on the tickets page.
  for (const [title, copy] of [
    ["30-day performance (stored settlements only)", SPORTS_COPY.performanceTitle],
    ["Models &amp; calibration", SPORTS_COPY.modelsTitle],
    ["Performance (all stored settlements)", SPORTS_COPY.ticketsPerformanceTitle],
    ["Daily ticket runs", SPORTS_COPY.runsTitle],
  ]) {
    const source = title.startsWith("Models") ? index : index.includes(title) ? index : tickets;
    assert.ok(source.includes(title), `${title} is on one of the legacy pages`);
    assert.equal(copy, title.replace("&amp;", "&"));
  }
  assert.ok(tickets.includes(">Tickets<"), "the tickets table title");
  assert.equal(SPORTS_COPY.ticketsTableTitle, "Tickets");
});

test("every empty state and the calibration note are legacy's sentences", () => {
  const index = readFileSync(LEGACY_INDEX, "utf8");
  const tickets = readFileSync(LEGACY_TICKETS, "utf8");
  assert.ok(index.includes(SPORTS_EMPTY.fixtures), "no fixtures today");
  assert.ok(index.includes(SPORTS_EMPTY.performance), "the intentional-unavailability sentence");
  assert.ok(index.includes(SPORTS_EMPTY.models), "no model versions");
  assert.ok(index.includes(SPORTS_EMPTY.providers), "no providers");
  assert.ok(index.includes(SPORTS_EMPTY.noRun), "no daily run recorded today");
  assert.ok(index.includes("No ticket today."), "the run-without-ticket sentence the port renders through `noTickets`");
  assert.ok(tickets.includes(SPORTS_EMPTY.noTickets), "no tickets generated");
  assert.ok(tickets.includes(SPORTS_EMPTY.noRuns), "no daily runs");
  const note = modelPanel({ models: { models: [] }, calibrations: { calibrations: [{ status: "APPROVED" }] } }).note;
  assert.match(note, /^1 approved calibration version\. A calibration is only usable after administrator approval — until then ticket-grade decisions report MODEL_NOT_CALIBRATED\.$/);
  assert.ok(index.includes("approved calibration version(s). A calibration is only usable after administrator approval"));
  // The confirmation was a `confirm()` on the legacy form; the port asks the same question.
  assert.equal(SPORTS_COPY.rejectConfirm, "Reject this ticket?");
});

// ---------------------------------------------------------------- the read gates

test("the console's permission constants are the platform's own keys", () => {
  assert.equal(SPORTS_PERMISSION, "sports.view");
  assert.equal(SPORTS_MANAGE, "sports.manage");
  assert.equal(SPORTS_APPROVE, "sports.approve");
  assert.equal(SPORTS_SETTLE, "sports.settle");
  // The kill-switch state is read under the dashboard's own constant; two modules that
  // guessed the string differently would disagree about which read the control needs.
  assert.equal(TRADING_READ_PERMISSION, DASHBOARD_TRADING_READ);
  // The super-admin shortcut is mirrored rather than ignored, exactly as `admin.js` does.
  assert.equal(holdsSportsPermission(["system.super_admin"], SPORTS_PERMISSION), true);
  assert.equal(holdsSportsPermission([SPORTS_PERMISSION], SPORTS_PERMISSION), true);
  assert.equal(holdsSportsPermission([], SPORTS_PERMISSION), false);
  assert.equal(holdsSportsPermission(null, SPORTS_PERMISSION), false);
  assert.equal(holdsSportsPermission([], null), true, "a route with no permission is open to any session");
});

test("the reads are the module's sports.view surface, plus the one sports.manage read the screen names", () => {
  const keys = SPORTS_READS.map((read) => read.key);
  assert.deepEqual(keys, ["status", "scheduled", "live", "intelligence", "predictions", "performance", "models", "calibrations", "dailyRuns", "tickets", "ticket", "syncRuns", "configuration"]);
  for (const read of SPORTS_READS) {
    assert.equal(read.method, "GET");
    assert.ok(read.path.startsWith("/api/v1/sports/"), `${read.key} is a sports route`);
    assert.ok(read.section, `${read.key} names which panel reads it`);
  }
  // Exactly one read is `sports.manage` — the active configuration, which the System
  // panel declares instead of asking for without the permission.
  assert.deepEqual(SPORTS_READS.filter((read) => read.permission === SPORTS_MANAGE).map((read) => read.key), ["configuration"]);
  assert.deepEqual(SPORTS_READS.filter((read) => read.permission !== SPORTS_PERMISSION && read.permission !== SPORTS_MANAGE), []);
  // The three writes/state reads the controls depend on.
  assert.deepEqual(SPORTS_WRITES.map((write) => write.key), ["decision", "settle", "tradingState"]);
  assert.equal(SPORTS_WRITES.find((write) => write.key === "decision").permission, SPORTS_APPROVE);
  assert.equal(SPORTS_WRITES.find((write) => write.key === "settle").permission, SPORTS_SETTLE);
  assert.equal(SPORTS_WRITES.find((write) => write.key === "decision").guard, "the platform kill switch must be released");
  assert.equal(SPORTS_WRITES.find((write) => write.key === "settle").guard, null, "settlement is deliberately not behind the switch");
});

test("every declared read and write is a registered route with the permission the server enforces", async (t) => {
  const app = await instance(t);
  const inventory = (await get(app.app, "/api/v1/system/routes")).json().routes;
  for (const entry of [...SPORTS_READS, ...SPORTS_WRITES]) {
    const route = inventory.find((candidate) => candidate.method === entry.method && candidate.path === entry.path);
    assert.ok(route, `${entry.method} ${entry.path} must be registered`);
    assert.equal(route.permission, entry.permission, `${entry.path} is declared with the wrong permission`);
    assert.equal(route.auth, true, `${entry.path} requires a session`);
  }
  // And `/trading/mode` really is the read the guard's state comes from.
  const trading = inventory.find((route) => route.path === "/api/v1/trading/mode" && route.method === "GET");
  assert.equal(trading.permission, TRADING_READ_PERMISSION);
});

test("the kill-switch refusal the console prints is the string the API throws", () => {
  const routes = readFileSync(LEGACY_ROUTES, "utf8");
  assert.ok(routes.includes(KILL_SWITCH_MESSAGE), "the API's 409 message is the console's constant, verbatim");
  assert.match(routes, /const KILL_SWITCH_ACTIVE_MESSAGE = "kill switch is ACTIVE/);
  // And the guard is on the decision route only: exactly one call site, and the
  // settlement route — the one legacy's sentence promises stays open — is not it.
  assert.match(routes, /await assertKillSwitchReleased\(paper\);/, "the decision route calls the guard");
  assert.equal(routes.split("await assertKillSwitchReleased(paper);").length - 1, 1, "one call site, so settlement cannot have grown one by accident");
  const settleRoute = routes.slice(routes.indexOf('"/sports/tickets/:ticketId/settle"'));
  assert.ok(!settleRoute.includes("assertKillSwitchReleased"), "settlement stays behind sports.settle alone");
  assert.match(routes, /async function assertKillSwitchReleased\(paper\) \{[\s\S]*state\.killSwitch\?\.active !== false[\s\S]*\n\}/, "the guard fails closed on anything but a released switch");
  assert.match(KILL_SWITCH_NOTICE, /release it before approving sports tickets \(settlement remains available\)/);
});

// ----------------------------------------------------------------- the shaping

test("today's intelligence attributes predictions to the UTC day and says when the page was full", () => {
  const scheduled = { matches: [{ id: 1, kickoff_at: `${DAY}T14:00:00.000Z`, home_team: "A", away_team: "B", competition: "L" }] };
  const live = { matches: [{ id: 9, kickoff_at: `${DAY}T13:00:00.000Z`, home_team: "C", away_team: "D", competition: "L" }] };
  const predictions = {
    predictions: [
      { id: "p1", created_at: `${DAY}T09:00:00.000Z`, decision: "PREDICTION_READY", confidence: 80, risk: "LOW" },
      { id: "p2", created_at: `${DAY}T10:00:00.000Z`, decision: "PREDICTION_READY", confidence: 90.5, risk: "MEDIUM" },
      { id: "p3", created_at: `${DAY}T11:00:00.000Z`, decision: "NO_PREDICTION", confidence: null, risk: "HIGH" },
      { id: "p4", created_at: "2026-10-11T23:59:59.000Z", decision: "PREDICTION_READY", confidence: 99, risk: "LOW" },
      { id: "p5", created_at: null, decision: "NO_PREDICTION", risk: "REJECTED" },
    ],
  };
  const board = todayIntelligence({ day: DAY, scheduled, live, predictions });
  assert.equal(board.date, DAY);
  assert.equal(board.upcomingCount, 1);
  assert.equal(board.liveCount, 1, "the Live card is every stored LIVE fixture, as legacy's read was");
  assert.equal(board.predictionsRead, 5);
  assert.equal(board.predictionsForDay, 3, "yesterday's prediction is not today's");
  assert.equal(board.predictionsUndated, 1, "a row with no timestamp is counted as such, not dropped silently");
  assert.equal(board.qualifiedPredictions, 2);
  assert.equal(board.rejectedPredictions, 1, "legacy counted everything that is not PREDICTION_READY as rejected");
  assert.equal(board.averageConfidence, 85.25, "the mean of the day's own confidences");
  assert.deepEqual(board.riskDistribution, { LOW: 1, MEDIUM: 1, HIGH: 1, REJECTED: 0 }, "the day's three rows, by their own risk");
  assert.equal(board.predictionsTruncated, false);

  // An empty host: no counts, and an average confidence of null rather than zero.
  const empty = todayIntelligence({ day: DAY, scheduled: { matches: [] }, live: { matches: [] }, predictions: { predictions: [] } });
  assert.equal(empty.averageConfidence, null);
  assert.equal(empty.upcomingCount, 0);
  const full = todayIntelligence({ day: DAY, predictions: { predictions: Array.from({ length: SPORTS_WINDOWS.predictions }, (_, index) => ({ created_at: `${DAY}T00:00:0${index % 10}.000Z`, decision: "NO_PREDICTION" })) } });
  assert.equal(full.predictionsTruncated, true, "a full page is stated as a floor, not read as the total");
});

test("the risk meters mirror legacy's four buckets and stay empty when nothing was counted", () => {
  assert.deepEqual(riskMeters({ LOW: 0, MEDIUM: 0, HIGH: 0, REJECTED: 0 }), [], "four empty bars are a picture of nothing");
  assert.deepEqual(riskMeters(null), []);
  const meters = riskMeters({ LOW: 1, MEDIUM: 1, HIGH: 2, REJECTED: 0 });
  assert.deepEqual(meters.map((meter) => meter.label), ["Risk LOW", "Risk MEDIUM", "Risk HIGH", "Risk REJECTED"]);
  assert.deepEqual(meters.map((meter) => meter.count), [1, 1, 2, 0]);
  assert.deepEqual(meters.map((meter) => meter.percent), [25, 25, 50, 0]);
  assert.equal(meters[0].fill, "meter-green");
  assert.equal(meters[1].fill, "meter-amber");
  assert.equal(meters[2].fill, "meter-red");
  assert.equal(meters[3].fill, "meter-muted");
  // A row with no risk is counted as REJECTED (legacy's `?? 'REJECTED'`); a risk name
  // the page does not know keeps its own bucket, and the meters render it, so the bars
  // account for everything counted.
  const missing = todayIntelligence({ day: DAY, predictions: { predictions: [{ created_at: `${DAY}T09:00:00.000Z`, decision: "NO_PREDICTION" }] } });
  assert.equal(missing.riskDistribution.REJECTED, 1);
  const unknown = todayIntelligence({ day: DAY, predictions: { predictions: [
    { created_at: `${DAY}T09:00:00.000Z`, decision: "NO_PREDICTION", risk: "SOMETHING_NEW" },
    { created_at: `${DAY}T09:01:00.000Z`, decision: "PREDICTION_READY", risk: "LOW" },
  ] } });
  assert.equal(unknown.riskDistribution.SOMETHING_NEW, 1);
  const extended = riskMeters(unknown.riskDistribution);
  assert.deepEqual(extended.map((meter) => meter.label), ["Risk LOW", "Risk MEDIUM", "Risk HIGH", "Risk REJECTED", "Risk SOMETHING_NEW"]);
  assert.deepEqual(extended.map((meter) => meter.percent), [50, 0, 0, 0, 50], "the extra bar is part of the total, not invisible in it");
});

test("the upcoming table assesses the rows it shows, and says 'not assessed' where it did not", () => {
  const matches = Array.from({ length: 30 }, (_, index) => ({
    id: index + 1, kickoff_at: `${DAY}T${String(14 + (index % 8)).padStart(2, "0")}:00:00.000Z`,
    home_team: `Home ${index}`, away_team: `Away ${index}`, competition: "League",
  }));
  const assessed = matches.slice(0, SPORTS_WINDOWS.listedFixtures).map((match) => match.id);
  const quality = { "1": { band: "EXCELLENT", score: 91 }, "2": null };
  const table = upcomingRows({ matches, quality, assessed });
  assert.equal(table.total, 30);
  assert.equal(table.shown, SPORTS_WINDOWS.listedFixtures, "the table is bounded by the console's own limit");
  assert.equal(table.assessed, SPORTS_WINDOWS.listedFixtures);
  assert.equal(table.rows[0].qualityText, "EXCELLENT · 91");
  assert.equal(table.rows[0].kickoff, `${DAY}T14:00`, "legacy printed substr(kickoff, 0, 16)");
  assert.equal(table.rows[0].match, "Home 0 vs Away 0");
  assert.equal(table.rows[1].qualityText, "not assessed", "an assessment that came back empty is not a score");
  assert.equal(table.rows[SPORTS_WINDOWS.listedFixtures - 1].assessed, true, "the last shown row was assessed");
  assert.equal(table.rows.length, SPORTS_WINDOWS.listedFixtures, "a row past the limit is not rendered at all");

  // The intelligence payload's quality block is what the column reads, and only when it
  // was actually assessed.
  assert.deepEqual(qualityFromIntelligence({ evaluation: { factors: { quality: { band: "GOOD", score: 72.4 } } } }), { band: "GOOD", score: 72.4 });
  assert.equal(qualityFromIntelligence({ qualityAssessed: false, evaluation: { factors: {} } }), null);
  assert.equal(qualityFromIntelligence(null), null);
});

test("the two performance panels carry legacy's own cards and never print a null as zero", () => {
  const empty = {
    dataAvailable: false, demoBanner: "DEMO / SANDBOX DATA — simulated statistics, not real-world performance",
    totalTickets: 0, settledTickets: 0, won: 0, lost: 0,
    winRate: null, roi: null, profitLoss: null, maxDrawdown: null, averageOdds: null,
    modelAccuracy: null, expectedValue: null, calibration: null,
  };
  const windowPanel = performanceCards(empty, { kind: "window" });
  assert.deepEqual(windowPanel.cards.map((card) => card.label), ["Settled tickets", "Win rate", "ROI", "Profit / loss", "Max drawdown", "Avg odds", "Model accuracy", "Brier", "ECE"]);
  assert.equal(windowPanel.dataAvailable, false);
  assert.equal(windowPanel.emptyNote, SPORTS_EMPTY.performance);
  assert.match(windowPanel.demoBanner, /^DEMO \/ SANDBOX DATA/);
  for (const card of windowPanel.cards) {
    if (card.key === "settledTickets") continue;
    assert.equal(card.value, "—", `${card.key} must not fabricate a number the server did not send`);
  }
  assert.equal(windowPanel.cards.find((card) => card.key === "settledTickets").value, "0", "a stored count of zero is a zero");

  const allPanel = performanceCards(empty, { kind: "all" });
  assert.deepEqual(allPanel.cards.map((card) => card.label), ["Tickets", "Settled", "Won / lost", "Win rate", "ROI", "Profit / loss", "Model accuracy", "Avg EV / selection"]);
  assert.equal(allPanel.cards.find((card) => card.key === "wonLost").value, "0 / 0");

  const measured = performanceCards({
    dataAvailable: true, settledTickets: 4, winRate: 0.5, roi: -0.125, profitLoss: -12.5, maxDrawdown: 30.25,
    averageOdds: 6.859, modelAccuracy: 0.625, expectedValue: 0.3086, calibration: { brier: 0.2, ece: 0.04 },
  }, { kind: "window" });
  const byKey = Object.fromEntries(measured.cards.map((card) => [card.key, card]));
  assert.equal(byKey.winRate.value, "50.0%");
  assert.equal(byKey.roi.value, "-12.5%");
  assert.equal(byKey.roi.tone, "down");
  assert.equal(byKey.profitLoss.value, "-12.50");
  assert.equal(byKey.averageOdds.value, "6.86", "legacy's two decimals");
  assert.equal(byKey.brier.value, "0.200");
  assert.equal(byKey.ece.value, "0.040");
  assert.equal(measured.emptyNote, "", "a measured panel does not carry the empty sentence");
});

test("today's ticket panel prints legacy's four cards, its legs, and the engine badge's gate", () => {
  const ticket = {
    id: "tkt_0123456789abcdef", total_odds: 6.859, selection_count: 3, confidence: 89.11, stake: 10,
    approval_status: "PENDING_USER_APPROVAL", settlement_status: "PENDING",
  };
  const selections = [{
    id: 1, match_id: 1, market: "TOTAL_GOALS", selection: "OVER_1_5", odds: 1.9,
    calibrated_probability: 0.685098, expected_value: 0.301686, status: "PENDING",
  }];
  const matches = [{ id: 1, home_team: "Arsenal Test", away_team: "Chelsea Test" }];
  const view = ticketView({
    run: { id: 1, run_date: DAY, status: "PENDING_USER_APPROVAL", ticket_id: ticket.id, message: "ticket generated; awaiting user approval" },
    ticket, selections, matches, engineMode: "USER_APPROVAL_REQUIRED", canReadConfiguration: true,
  });
  assert.deepEqual(view.cards.map((card) => [card.label, card.value]), [
    ["Total odds", "6.86"], ["Selections", "3"], ["Confidence", "89%"], ["Stake", "10.00"],
  ]);
  assert.equal(view.status, "PENDING_USER_APPROVAL");
  assert.equal(view.pendingApproval, true);
  assert.equal(view.pendingSettlement, true);
  assert.equal(view.externalExecution, false);
  assert.equal(view.engineLabel, "USER_APPROVAL_REQUIRED");
  assert.equal(view.legs[0].matchLabel, "Arsenal Test vs Chelsea Test");
  assert.equal(view.legs[0].odds, "1.90");
  assert.equal(view.legs[0].calibratedProbability, "0.685");
  assert.equal(view.legs[0].expectedValue, "0.302");
  assert.equal(view.legs[0].expectedValueTone, "up");

  // The configuration read is `sports.manage`: without it the badge names the gate
  // instead of showing a mode the screen never read.
  const gated = ticketView({ run: null, ticket: null, canReadConfiguration: false });
  assert.equal(gated.engineLabel, `requires ${SPORTS_MANAGE}`);
  assert.equal(gated.noRun, SPORTS_EMPTY.noRun);
  const runWithoutTicket = ticketView({ run: { run_date: DAY, status: "NO_QUALIFIED_TICKET", message: "no ticket" }, ticket: null, canReadConfiguration: false });
  assert.equal(runWithoutTicket.noRun, SPORTS_EMPTY.noTickets, "a run with no ticket says so rather than looking empty");
  assert.equal(runWithoutTicket.message, "no ticket", "…and carries the run's own message");
  assert.equal(ticketView({ run: null, ticket: null, canReadConfiguration: false }).cards[0].value, "—");
});

test("the ticket, run, sync, provider and model tables are formatted as the pages printed them", () => {
  const rows = ticketRows([
    { id: "tkt_1", created_at: `${DAY}T09:00:00.000Z`, total_odds: 6.859, selection_count: 3, confidence: 89.11, risk: "LOW", approval_status: "PENDING_USER_APPROVAL", settlement_status: "PENDING" },
    { id: "tkt_2", created_at: `${DAY}T10:00:00.000Z`, total_odds: 2.5, selection_count: 1, confidence: null, risk: "HIGH", approval_status: "APPROVED_NOT_EXECUTED", settlement_status: "WON", pnl: 15.5 },
    { id: "tkt_3", created_at: `${DAY}T11:00:00.000Z`, total_odds: 3.4, selection_count: 2, confidence: 70, risk: "MEDIUM", approval_status: "REJECTED", settlement_status: "CANCELLED", pnl: -10 },
  ]);
  assert.equal(rows[0].createdAt, `${DAY}T09:00`);
  assert.equal(rows[0].odds, "6.86");
  assert.equal(rows[0].riskTone, "badge-green");
  assert.equal(rows[0].settlementTone, "badge-gray");
  assert.equal(rows[0].decidable, true);
  assert.equal(rows[0].settleable, true);
  assert.equal(rows[0].pnl, "—", "a ticket with no stored P/L prints an em dash");
  assert.equal(rows[1].riskTone, "badge-red");
  assert.equal(rows[1].settlementTone, "badge-green");
  assert.equal(rows[1].decidable, false, "a decided ticket offers no control");
  assert.equal(rows[2].settlementTone, "badge-gray");
  assert.equal(rows[2].pnlTone, "down");
  assert.equal(rows[0].confidence, "89", "legacy printed the confidence as an integer, without a percent sign");
  assert.equal(rows[1].confidence, "—", "a null confidence is an em dash");
  assert.equal(rows[2].approvalTone, "badge-red");

  assert.equal(approvalTone("PENDING_USER_APPROVAL"), "badge-gray");
  assert.equal(approvalTone("APPROVED_NOT_EXECUTED"), "badge-green");
  assert.equal(approvalTone("REJECTED"), "badge-red");
  assert.equal(settlementTone("WON"), "badge-green");
  assert.equal(settlementTone("LOST"), "badge-red");
  assert.equal(riskTone("LOW"), "badge-green");
  assert.equal(riskTone("HIGH"), "badge-red");
  assert.equal(riskTone("MEDIUM"), "badge-violet");
  assert.equal(runStatusTone("PENDING_USER_APPROVAL"), "badge-violet");
  assert.equal(runStatusTone("NO_QUALIFIED_TICKET"), "badge-gray");

  const runs = dailyRunRows([{ id: 1, run_date: DAY, status: "PENDING_USER_APPROVAL", ticket_id: "tkt_1", candidates_evaluated: 3, predictions_recorded: 3, rejections: 0, message: "x".repeat(200) }]);
  assert.equal(runs[0].message.length, 120, "legacy truncated the message to 120 characters");
  assert.equal(runs[0].ticketId, "tkt_1");
  assert.equal(dailyRunRows([{ id: 2, run_date: DAY, status: "NO_QUALIFIED_TICKET" }])[0].ticketId, "—");

  const syncs = syncRunRows([{ id: 1, job_type: "FIXTURES", status: "COMPLETED", started_at: `${DAY}T06:00:00.000Z`, execution_key: "key-1" }]);
  assert.deepEqual([syncs[0].jobType, syncs[0].startedAt, syncs[0].status], ["FIXTURES", `${DAY}T06:00`, "COMPLETED"]);

  const providers = providerRows([
    { id: "sandbox-sim", derivedStatus: "UNKNOWN", reliability: 0, detail: "no observations yet", simulated: true },
    { provider_code: "feed-test", derivedStatus: "ONLINE", reliability: null, detail: "observed now" },
  ]);
  assert.equal(providers[0].code, "sandbox-sim");
  assert.equal(providers[0].status, "UNKNOWN");
  assert.equal(providerTone("UNKNOWN"), "badge-muted", "the monitor's defined answer is never dressed as health");
  assert.equal(providerTone("ONLINE"), "badge-live");
  assert.equal(providerTone("DEGRADED"), "badge-amber");
  assert.equal(providers[1].reliability, "—", "a null reliability is an em dash, not 0.00");
  assert.equal(providerRows(null).length, 0);

  const panel = modelPanel({
    models: { models: [{ id: 1, model_name: "WINDELS Sports Baseline", model_version: "1.0.0", feature_version: "sports-features-v1", calibration_version: "cal-pop", status: "ACTIVE" }] },
    calibrations: { calibrations: [{ status: "APPROVED" }, { status: "PENDING" }] },
  });
  assert.equal(panel.rows.length, 1);
  assert.equal(panel.versions, 1);
  assert.equal(panel.approvedCalibrations, 1, "only APPROVED calibrations count, as the page counted them");
  assert.match(panel.note, /^1 approved calibration version\./);
  assert.equal(modelPanel({ models: { models: [] }, calibrations: null }).approvedCalibrations, 0);
});

test("the boundary panel carries the server's matrix and the console's own residual lines", () => {
  const panel = boundaryPanel([
    { area: "specimen", legacy: "somewhere", state: "not ported", detail: "an example entry" },
    { area: "vendor verification", legacy: "providers", state: "not ported", detail: "unverified" },
  ]);
  assert.deepEqual(panel.rows.map((row) => row.area), ["specimen", "vendor verification"]);
  assert.equal(panel.rows[0].state, "not ported");
  assert.equal(boundaryPanel(null).rows.length, 0);
  // The matrix is empty since Phase 48 (DV-27), so the panel's rows are [] in
  // production; the residual lines are what the panel keeps showing, and the first one
  // states the sizing boundary (record-only, bounded) rather than the old "not ported" claim.
  assert.deepEqual(boundaryPanel([]).rows, []);
  assert.equal(panel.residual.length, 3);
  assert.match(panel.residual[0], /Stake sizing is record-only and bounded/);
  assert.match(panel.residual[0], /staking_method \(FLAT by default/);
  assert.match(panel.residual[0], /nothing is executed\./i);
  assert.match(panel.residual[2], /Nothing is executed/);
});

test("the kill-switch state is named, not guessed, and only banners when it was actually read", () => {
  assert.equal(killSwitchStateText({ killSwitch: { active: true } }, [TRADING_READ_PERMISSION]), "ACTIVE");
  assert.equal(killSwitchStateText({ killSwitch: { active: false } }, [TRADING_READ_PERMISSION]), "released");
  assert.equal(killSwitchStateText(null, []), `requires ${TRADING_READ_PERMISSION}`);
  assert.equal(killSwitchStateText({ killSwitch: { active: true } }, []), `requires ${TRADING_READ_PERMISSION}`, "a viewer without the read is told the gate, not the state");
  assert.equal(killSwitchStateText(null, [TRADING_READ_PERMISSION]), "not read");
  assert.equal(killSwitchStateText({ killSwitch: { active: true } }, ["system.super_admin"]), "ACTIVE", "the super-admin shortcut passes the read too");

  const notice = killSwitchNotice({ killSwitch: { active: true } }, [TRADING_READ_PERMISSION]);
  assert.equal(notice.tone, "warn");
  assert.equal(notice.text, KILL_SWITCH_NOTICE);
  assert.equal(notice.api, KILL_SWITCH_MESSAGE, "the banner also carries the sentence the API will answer with");
  assert.equal(killSwitchNotice({ killSwitch: { active: false } }, [TRADING_READ_PERMISSION]), null);
  assert.equal(killSwitchNotice(null, [TRADING_READ_PERMISSION]), null, "an unread switch is not a warning the screen cannot support");
  assert.equal(killSwitchNotice({ killSwitch: { active: true } }, []), null);
});

test("the formatting helpers match the PHP they replace", () => {
  assert.equal(numberText(null, 2), "—");
  assert.equal(numberText(undefined), "—");
  assert.equal(numberText("nonsense"), "—");
  assert.equal(numberText(6.859, 2), "6.86");
  assert.equal(numberText(1234.5, 2), "1,234.50", "legacy's number_format groups thousands");
  assert.equal(countText(0), "0");
  assert.equal(countText(null), "—");
  assert.equal(percentText(0.5), "50.0%");
  assert.equal(percentText(0), "0.0%", "a measured zero percent is a measurement");
  assert.equal(percentText(null), "—");
  assert.equal(instantText(`${DAY}T14:00:00.000Z`), `${DAY}T14:00`);
  assert.equal(instantText(null), "—");
  assert.equal(shortText("abc", 2), "ab");
  assert.equal(shortText("abc"), "abc");
  assert.equal(present(0), true, "a stored zero is present");
  assert.equal(present(null), false);
  assert.equal(present(""), false);
});

test("the day helpers are UTC, and the performance window is legacy's thirty days", () => {
  assert.equal(utcDay(new Date(`${DAY}T23:59:59.999Z`)), DAY);
  assert.equal(utcDay(new Date("2026-01-01T00:00:00.000Z")), "2026-01-01");
  assert.equal(daysBefore(DAY, 29), "2026-09-13");
  assert.equal(daysBefore("2026-03-01", 1), "2026-02-28", "a calendar subtraction, not 30-day arithmetic on the month");
  assert.deepEqual(dayWindow(DAY), { day: DAY, from: `${DAY}T00:00:00.000Z`, to: `${DAY}T23:59:59.999Z` });
  const window = performanceWindow(DAY);
  assert.equal(window.from, "2026-09-13T00:00:00.000Z", "today and the 29 days before it");
  assert.equal(window.to, `${DAY}T23:59:59.999Z`);
  assert.equal(SPORTS_WINDOWS.performanceDays, 30);
  assert.equal(SPORTS_WINDOWS.listedFixtures, 25);
  assert.equal(SPORTS_WINDOWS.tickets, 100, "tickets.php read 100");
  assert.equal(SPORTS_WINDOWS.dailyRuns, 30, "tickets.php read 30 daily runs");
  assert.equal(SPORTS_WINDOWS.syncRuns, 8, "dashboard() sliced the job runs to 8");
});

// --------------------------------------------------------------- the screen itself

test("the screen is declared where the router and the navigation will find it", () => {
  const app = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  const views = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");
  const api = readFileSync(path.join(CLIENT, "api.js"), "utf8");
  assert.match(app, /path: "\/app\/sports", view: "sports-intelligence", requiresAuth: true, permission: "sports\.view"/);
  assert.match(app, /"sports-intelligence": <SportsIntelligenceView permissions=\{permissions\} \/>/);
  assert.match(views, /export function SportsIntelligenceView\(\{ permissions \}\)/);
  assert.match(views, /\{ to: "\/app\/sports", label: "Sports intelligence", permission: SPORTS_PERMISSION \}/, "the navigation entry carries the same gate the route does");
  assert.match(views, /<h1>\{SPORTS_COPY\.title\}\.<\/h1>/, "the heading is the legacy page's own string, not a literal");
  assert.match(views, /<a className="panel-foot-link" href="#sports-tickets">\{SPORTS_COPY\.ticketsLink\}<\/a>/, "the link between the two legacy pages becomes the anchor between the two sections");
  assert.match(views, /<section className="panel" id="sports-tickets">/);
  // The module index card stops saying there is no console.
  assert.match(views, /to: "\/app\/sports", permission: SPORTS_PERMISSION \}/);
  assert.ok(!views.includes("Measured half ported · no console"), "the sports card no longer claims the console is missing");
  assert.ok(!/the sports dashboard,\n \* the settings screens/.test(views), "nor does the card list's own comment");

  // Every read the console makes is a wrapper, and every wrapper is declared once.
  for (const name of ["sportsStatus", "sportsMatches", "sportsMatchIntelligence", "sportsPredictions", "sportsDailyRuns", "sportsTickets", "sportsTicket", "sportsDecideTicket", "sportsSettleTicket", "sportsPerformance", "sportsModels", "sportsCalibrations", "sportsSyncRuns", "sportsConfiguration"]) {
    assert.match(api, new RegExp(`\\n  ${name}:`), `${name} is a declared endpoint`);
    assert.ok(views.includes(`endpoints.${name}(`), `${name} is used by the console`);
  }
  assert.match(views, /endpoints\.tradingMode\(\)/, "the kill-switch state read");
  // The three controls, each guarded by the session's permissions before it is offered.
  assert.match(views, /const canApprove = holdsSportsPermission\(permissions, SPORTS_APPROVE\);/);
  assert.match(views, /const canSettle = holdsSportsPermission\(permissions, SPORTS_SETTLE\);/);
  assert.match(views, /const canReadConfiguration = holdsSportsPermission\(permissions, SPORTS_MANAGE\);/);
  assert.match(views, /\{row\.decidable && canApprove \? \(/);
  assert.match(views, /\{row\.settleable && canSettle \? \(/);
  // The quality column is fetched per displayed fixture and only for those rows.
  assert.match(views, /Promise\.allSettled\(listedIds\.map\(\(id\) => endpoints\.sportsMatchIntelligence\(id\)\)\)/);
  assert.match(views, /slice\(0, SPORTS_WINDOWS\.listedFixtures\)/);
});

// --------------------------------------------------------------- over HTTP

test("an empty host reports DISABLED_NO_PROVIDER, the demo banner, and the empty not-ported matrix (Phase 48)", async (t) => {
  const app = await instance(t, { WINDELS_SPORTS_MODE: "", WINDELS_SPORTS_SANDBOX: "" });
  const root = await signIn(app.app);
  const status = (await get(app.app, "/api/v1/sports/status", root.headers)).json();
  assert.equal(status.providersConfigured, false, "a default host configures no provider");
  assert.equal(status.isDemoData, true, "and it is in SANDBOX mode, which is what legacy's demo flag reflects");
  assert.deepEqual(status.providers, []);
  assert.equal(status.ticketEngine, "ON_REQUEST", "the module's own field: the engine runs when a person asks");
  // The matrix the boundary panel renders is empty: Phase 48 (DV-27) ported its last
  // entry, stake sizing, as bounded record-only sizing, and an empty matrix — not a
  // re-worded one — is the honest claim now. The panel then shows the residual
  // sentences, which name the boundaries that remain (no execution, no verified vendor).
  assert.deepEqual(status.notPorted, [], "Phase 48 ported the matrix's last entry; an entry that is no longer true must not stay listed");
  assert.deepEqual(boundaryPanel(status.notPorted).rows, []);
  assert.equal(status.persistence, true, "this host has a sports repository");
});

test("a sports.view viewer reads every sports.view surface and is refused the sports.manage one", async (t) => {
  const app = await instance(t);
  await grantSports(app.store);
  await seedRealFixtures(app.store);
  const root = await signIn(app.app);
  await approveCalibration(app.app, root.headers, app.store);
  await app.app.inject({ method: "POST", url: "/api/v1/sports/daily-tickets/run", headers: root.headers, payload: { date: DAY } });
  const viewer = await analystSession(app.app, app.store);

  const readable = [
    "/api/v1/sports/status",
    `/api/v1/sports/matches?status=SCHEDULED&from=${DAY}T00:00:00.000Z&to=${DAY}T23:59:59.999Z&limit=${SPORTS_WINDOWS.scheduledFixtures}`,
    `/api/v1/sports/matches?status=LIVE&limit=${SPORTS_WINDOWS.liveFixtures}`,
    "/api/v1/sports/matches/1/intelligence",
    `/api/v1/sports/predictions?limit=${SPORTS_WINDOWS.predictions}`,
    "/api/v1/sports/performance",
    "/api/v1/sports/models",
    "/api/v1/sports/calibrations?status=APPROVED",
    `/api/v1/sports/daily-tickets?limit=${SPORTS_WINDOWS.dailyRuns}`,
    `/api/v1/sports/tickets?limit=${SPORTS_WINDOWS.tickets}`,
    `/api/v1/sports/sync-runs?limit=${SPORTS_WINDOWS.syncRuns}`,
  ];
  for (const url of readable) {
    const response = await get(app.app, url, viewer.headers);
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
  }
  const tickets = (await get(app.app, `/api/v1/sports/tickets?limit=${SPORTS_WINDOWS.tickets}`, viewer.headers)).json();
  assert.equal(tickets.count, 1);
  const detail = await get(app.app, `/api/v1/sports/tickets/${tickets.tickets[0].id}`, viewer.headers);
  assert.equal(detail.statusCode, 200, "the ticket detail read is sports.view too");
  assert.equal(detail.json().selections.length, 3);

  // The one read the screen declares as `sports.manage`, and does not attempt without it.
  const configuration = await get(app.app, "/api/v1/sports/configuration", viewer.headers);
  assert.equal(configuration.statusCode, 403, configuration.body);

  // And the console's own reads shape into the panels the viewer sees.
  const board = todayIntelligence({
    day: DAY,
    scheduled: (await get(app.app, `/api/v1/sports/matches?status=SCHEDULED&from=${DAY}T00:00:00.000Z&to=${DAY}T23:59:59.999Z&limit=50`, viewer.headers)).json(),
    live: (await get(app.app, "/api/v1/sports/matches?status=LIVE&limit=50", viewer.headers)).json(),
    predictions: (await get(app.app, "/api/v1/sports/predictions?limit=200", viewer.headers)).json(),
  });
  assert.equal(board.upcomingCount, 3);
  // The predictions were recorded now, not on the fixture's day, so the day's counts are
  // zero — which is the honest answer, and the panel says why the count is what it is.
  assert.equal(board.predictionsForDay, 0);
  assert.equal(board.averageConfidence, null);
  const performance = performanceCards((await get(app.app, "/api/v1/sports/performance", viewer.headers)).json(), { kind: "all" });
  assert.equal(performance.dataAvailable, false);
  assert.equal(performance.cards.find((card) => card.key === "roi").value, "—");
  assert.equal(performance.emptyNote, SPORTS_EMPTY.performance);
  const modelList = modelPanel({
    models: (await get(app.app, "/api/v1/sports/models", viewer.headers)).json(),
    calibrations: (await get(app.app, "/api/v1/sports/calibrations?status=APPROVED", viewer.headers)).json(),
  });
  assert.equal(modelList.approvedCalibrations, 1);
  const quality = qualityFromIntelligence((await get(app.app, "/api/v1/sports/matches/1/intelligence", viewer.headers)).json());
  assert.equal(quality.band, "EXCELLENT");
  assert.equal(Number.isInteger(quality.score), true);
});

test("approval is refused under the boot switch with the API's sentence, and recorded once it is released", async (t) => {
  const app = await instance(t);
  await grantSports(app.store);
  await seedRealFixtures(app.store);
  const root = await signIn(app.app);
  await approveCalibration(app.app, root.headers, app.store);
  const run = (await app.app.inject({ method: "POST", url: "/api/v1/sports/daily-tickets/run", headers: root.headers, payload: { date: DAY } })).json();
  assert.equal(run.status, "PENDING_USER_APPROVAL", JSON.stringify(run));

  // The console reads the state the guard will use, and shows the banner for it.
  const state = (await get(app.app, "/api/v1/trading/mode", root.headers)).json();
  assert.equal(killSwitchStateText(state, root.permissions), "ACTIVE", "the switch boots ACTIVE, as `Platform::state()` does");
  assert.equal(killSwitchNotice(state, root.permissions).text, KILL_SWITCH_NOTICE);

  const refused = await app.app.inject({ method: "POST", url: `/api/v1/sports/tickets/${run.ticketId}/decision`, headers: root.headers, payload: { approve: true, reason: "reviewed" } });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().error.code, "SPORTS_KILL_SWITCH_ACTIVE");
  assert.equal(refused.json().error.message, KILL_SWITCH_MESSAGE, "the console prints the server's own sentence, so they must be the same string");

  const approved = await app.app.inject({ method: "POST", url: `/api/v1/sports/tickets/${run.ticketId}/decision`, headers: root.headers, payload: { approve: true, reason: "reviewed" } });
  assert.equal(approved.statusCode, 409, "still refused: nothing released the switch");
  assert.equal(SPORTS_COPY.decisionNotice(true), "Ticket approved and audited — no external execution exists in this deployment.");

  await releaseKillSwitch(app.app, root.headers);
  const decided = await app.app.inject({ method: "POST", url: `/api/v1/sports/tickets/${run.ticketId}/decision`, headers: root.headers, payload: { approve: true, reason: "reviewed" } });
  assert.equal(decided.statusCode, 200, decided.body);
  assert.equal(decided.json().approvalStatus, "APPROVED_NOT_EXECUTED");
  assert.equal(decided.json().externalExecution, false, "approval is a record, never an order");

  // What the screen then renders: the row is no longer decidable and its badge moved.
  const rows = ticketRows((await get(app.app, `/api/v1/sports/tickets?limit=${SPORTS_WINDOWS.tickets}`, root.headers)).json().tickets);
  assert.equal(rows[0].decidable, false);
  assert.equal(rows[0].approvalTone, "badge-green");
  assert.equal(rows[0].approvalStatus, "APPROVED_NOT_EXECUTED");

  // Settlement is available throughout — the sentence in the refusal says so.
  const settled = await app.app.inject({ method: "POST", url: `/api/v1/sports/tickets/${run.ticketId}/settle`, headers: root.headers });
  assert.equal(settled.statusCode, 200, settled.body);
  assert.match(SPORTS_COPY.settlementNotice(settled.json().settlement), /^Ticket settlement: PENDING \(effective odds 6\.859, P\/L 0\)$/);

  // Today's ticket panel: the run and the ticket resolve from the two reads it uses.
  const runs = (await get(app.app, `/api/v1/sports/daily-tickets?limit=${SPORTS_WINDOWS.dailyRuns}`, root.headers)).json();
  const todaysRun = runs.runs.find((row) => row.run_date === DAY);
  assert.ok(todaysRun, "the day's run is in the daily-runs read");
  const detail = (await get(app.app, `/api/v1/sports/tickets/${todaysRun.ticket_id}`, root.headers)).json();
  const view = ticketView({ run: todaysRun, ticket: detail.ticket, selections: detail.selections, matches: [], engineMode: null, canReadConfiguration: false });
  assert.equal(view.status, "PENDING_USER_APPROVAL");
  assert.equal(view.pendingApproval, false, "the ticket has been decided, so the controls are gone");
  assert.equal(view.legs.length, 3);
});
