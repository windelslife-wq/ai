/**
 * The notification endpoints over HTTP, and the governance/execution transitions
 * that publish through them.
 *
 * This is where the module's two safety properties are actually proven: that no
 * HTTP caller can inject an alert that looks like it came from the risk engine,
 * and that a notification failure can never break the governance action that
 * caused it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";

import { cookieFrom, createFileStoreApp } from "./helpers.js";

const ENV = {
  PUBLIC_BASE_URL: "https://site.example.test",
  MARKET_DATA_REAL_PROVIDERS: "0",
  MARKET_DATA_ALLOW_SYNTHETIC: "1",
};

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  const cookie = cookieFrom(response);
  return { cookie, headers: { cookie, "x-csrf-token": body.csrfToken } };
}

async function addMember(store, username, { permissions = ["system.authenticated"] } = {}) {
  const user = await store.createUser({
    username,
    email: `${username}@example.test`,
    passwordHash: await bcrypt.hash(`${username} secret phrase`, 4),
    displayName: username,
  });
  const role = (await store.listRoles()).find((entry) => entry.role_key === "platform_member");
  for (const key of permissions) {
    const permission = await store.ensurePermission(key, key);
    await store.grantRolePermission(role.id, permission.id);
  }
  await store.assignRole(user.id, role.id);
  return user;
}

async function signInAs(app, username) {
  return signIn(app, username, `${username} secret phrase`);
}

// ------------------------------------------------------------- route inventory

test("the three legacy notification endpoints are registered, authenticated, and there is no publish route", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());

  const inventory = await instance.app.inject({ method: "GET", url: "/api/v1/system/routes" });
  assert.equal(inventory.statusCode, 200);
  const routes = inventory.json().routes;
  const byPath = new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));

  for (const [method, path] of [
    ["GET", "/api/v1/notifications"],
    ["POST", "/api/v1/notifications/:notificationId/read"],
    ["POST", "/api/v1/notifications/read-all"],
  ]) {
    const route = byPath.get(`${method} ${path}`);
    assert.ok(route, `${method} ${path} is registered`);
    assert.equal(route.auth, true);
    assert.equal(route.permission, "system.authenticated", "the legacy endpoints used the signed-in baseline");
  }

  // Publishing stays internal. An HTTP caller must not be able to inject an alert
  // that appears to come from the risk engine or the execution supervisor.
  const publishing = routes.filter((route) => route.path.startsWith("/api/v1/notifications") && route.method !== "GET");
  assert.deepEqual(publishing.map((route) => route.path).sort(), [
    "/api/v1/notifications/:notificationId/read",
    "/api/v1/notifications/read-all",
  ], "read transitions only — no create, publish, delete or broadcast route");
});

test("the notification endpoints refuse an anonymous caller", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());

  const inbox = await instance.app.inject({ method: "GET", url: "/api/v1/notifications" });
  assert.equal(inbox.statusCode, 401);
  assert.equal(inbox.json().error.code, "AUTH_REQUIRED");
  const readAll = await instance.app.inject({ method: "POST", url: "/api/v1/notifications/read-all", payload: {} });
  assert.equal(readAll.statusCode, 401);
});

test("a signed-in member without any trading permission still reads their own inbox", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  await addMember(instance.store, "plainmember");
  const member = await signInAs(instance.app, "plainmember");

  const inbox = await instance.app.inject({ method: "GET", url: "/api/v1/notifications", headers: member.headers });
  assert.equal(inbox.statusCode, 200, inbox.body);
  assert.deepEqual(inbox.json().notifications, []);
  assert.equal(inbox.json().unread, 0);
});

// ------------------------------------------------------------------- the inbox

test("the inbox answers unread counts, filtering and the legacy ?unread=1 flag", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);

  await instance.store.createNotification({ userId: null, type: "KILL_SWITCH", severity: "critical", title: "Kill switch engaged", detail: {}, dedupeKey: "kill-switch:active", createdAt: "2026-10-11T09:00:00.000Z" });
  await instance.store.createNotification({ userId: null, type: "ORDER_FILLED", severity: "info", title: "Filled BUY EURUSD (paper)", detail: {}, dedupeKey: null, createdAt: "2026-10-11T10:00:00.000Z" });

  const all = await instance.app.inject({ method: "GET", url: "/api/v1/notifications", headers: admin.headers });
  assert.equal(all.statusCode, 200, all.body);
  assert.equal(all.json().unread, 2);
  assert.deepEqual(all.json().notifications.map((entry) => entry.title), ["Filled BUY EURUSD (paper)", "Kill switch engaged"], "newest first");
  assert.equal(all.json().notifications[0].broadcast, true);

  const unread = await instance.app.inject({ method: "GET", url: "/api/v1/notifications?unread=1", headers: admin.headers });
  assert.equal(unread.json().notifications.length, 2);
  assert.equal(unread.json().unreadOnly, true);

  const notUnread = await instance.app.inject({ method: "GET", url: "/api/v1/notifications?unread=0", headers: admin.headers });
  assert.equal(notUnread.json().unreadOnly, false, "the legacy flag was `=1` or absent");

  const critical = await instance.app.inject({ method: "GET", url: "/api/v1/notifications?severity=critical", headers: admin.headers });
  assert.deepEqual(critical.json().notifications.map((entry) => entry.title), ["Kill switch engaged"]);
  assert.equal(critical.json().unread, 2, "the badge is not narrowed by the page filter");

  const bogus = await instance.app.inject({ method: "GET", url: "/api/v1/notifications?severity=urgent", headers: admin.headers });
  assert.equal(bogus.statusCode, 400, "an unknown severity is a client bug, not an empty page");

  const limited = await instance.app.inject({ method: "GET", url: "/api/v1/notifications?limit=1", headers: admin.headers });
  assert.equal(limited.json().notifications.length, 1);
  assert.equal(limited.json().limit, 1);
});

test("marking read is idempotent, answers 404 for an unknown or foreign id, and read-all reports its count", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  await addMember(instance.store, "plainmember");
  const admin = await signIn(instance.app);
  const member = await signInAs(instance.app, "plainmember");

  const targeted = await instance.store.createNotification({ userId: member.userId ?? 2, type: "TRADE_APPROVAL_REQUESTED", severity: "warning", title: "Approval required", detail: {}, dedupeKey: null, createdAt: "2026-10-11T09:00:00.000Z" });
  const broadcast = await instance.store.createNotification({ userId: null, type: "KILL_SWITCH", severity: "critical", title: "Kill switch engaged", detail: {}, dedupeKey: "kill-switch:active", createdAt: "2026-10-11T10:00:00.000Z" });

  const unknown = await instance.app.inject({ method: "POST", url: "/api/v1/notifications/999999/read", headers: admin.headers, payload: {} });
  assert.equal(unknown.statusCode, 404);
  assert.match(unknown.json().error.message, /not found or already read/, "the legacy wording, and one answer for missing/already-read/foreign");

  const malformed = await instance.app.inject({ method: "POST", url: "/api/v1/notifications/abc/read", headers: admin.headers, payload: {} });
  assert.equal(malformed.statusCode, 400, "a non-numeric id is rejected by the route contract");

  const foreign = await instance.app.inject({ method: "POST", url: `/api/v1/notifications/${targeted.id}/read`, headers: admin.headers, payload: {} });
  // The admin is not the recipient; a targeted row is visible only to its owner.
  assert.equal(foreign.statusCode, 404, "an alert targeted at someone else cannot be read — or discovered — through this route");

  const ownRead = await instance.app.inject({ method: "POST", url: `/api/v1/notifications/${targeted.id}/read`, headers: member.headers, payload: {} });
  assert.equal(ownRead.statusCode, 200, ownRead.body);
  assert.deepEqual(ownRead.json(), { ok: true });
  const twice = await instance.app.inject({ method: "POST", url: `/api/v1/notifications/${targeted.id}/read`, headers: member.headers, payload: {} });
  assert.equal(twice.statusCode, 404, "the second read reports that nothing changed");

  const readAll = await instance.app.inject({ method: "POST", url: "/api/v1/notifications/read-all", headers: member.headers, payload: {} });
  assert.equal(readAll.statusCode, 200, readAll.body);
  assert.equal(readAll.json().markedRead, 1, "the remaining broadcast");
  assert.equal(readAll.json().ok, true);

  const after = await instance.app.inject({ method: "GET", url: "/api/v1/notifications", headers: member.headers });
  assert.equal(after.json().unread, 0);
  assert.equal(after.json().notifications.find((entry) => entry.id === broadcast.id).unread, false);

  const audit = await instance.store.listAuditEvents({});
  const actions = audit.events.map((event) => event.action);
  assert.ok(actions.includes("notification.read"), "the read transition is audited");
  assert.ok(actions.includes("notification.read-all"), "read-all is audited");
});

test("the read mutations require a CSRF token for a cookie session", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const response = await instance.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: "rootadmin", password: "Root administrator pass" } });
  const cookie = cookieFrom(response);

  await instance.store.createNotification({ userId: null, type: "KILL_SWITCH", severity: "critical", title: "Kill switch engaged", detail: {}, dedupeKey: null, createdAt: "2026-10-11T09:00:00.000Z" });
  const withoutCsrf = await instance.app.inject({ method: "POST", url: "/api/v1/notifications/read-all", headers: { cookie }, payload: {} });
  assert.equal(withoutCsrf.statusCode, 403);
  assert.equal(withoutCsrf.json().error.code, "CSRF_INVALID");
});

// ------------------------------------------------------------------ publishers

test("engaging the kill switch publishes one deduped critical broadcast, and releasing it publishes the recovery", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);
  const post = (url, payload) => instance.app.inject({ method: "POST", url, headers: admin.headers, payload });
  const unreadCount = async () => (await instance.app.inject({ method: "GET", url: "/api/v1/notifications", headers: admin.headers })).json().unread;

  // The switch is ENGAGED at boot ("orders blocked until explicitly released"),
  // so the first observable transition is a release. Asserting an engagement
  // first would be asserting a change from a state the platform is not in.
  const boot = await post("/api/v1/trading/kill-switch", { active: true, reason: "Re-affirming the boot state" });
  assert.equal(boot.statusCode, 200, boot.body);
  assert.equal(boot.json().changed, false, "already engaged at boot");
  assert.equal(boot.json().notification, null, "so re-affirming it raises no alert");
  assert.equal(await unreadCount(), 0);

  const release = await post("/api/v1/trading/kill-switch", { active: false });
  assert.equal(release.statusCode, 200, release.body);
  assert.equal(release.json().changed, true);
  assert.equal(release.json().notification.type, "KILL_SWITCH");
  assert.equal(release.json().notification.severity, "info");
  assert.match(release.json().notification.title, /released/i);
  assert.equal(release.json().notification.broadcast, true);
  assert.equal(await unreadCount(), 1);

  // The legacy alert, with the legacy dedupe key `kill-switch:active`.
  const engage = await post("/api/v1/trading/kill-switch", { active: true, reason: "Unbounded drawdown during a data outage" });
  assert.equal(engage.json().changed, true);
  assert.ok(engage.json().notification, "the response names the alert it raised");
  assert.equal(engage.json().notification.severity, "critical");
  assert.equal(engage.json().notification.title, "KILL SWITCH ACTIVATED — all order placement blocked");
  assert.equal(engage.json().notification.dedupeKey, "kill-switch:active", "the legacy dedupe key");
  assert.equal(engage.json().notification.detail.reason, "Unbounded drawdown during a data outage");

  // While that alert is unread, re-engaging raises nothing: one badge per active
  // issue rather than one per attempt.
  const again = await post("/api/v1/trading/kill-switch", { active: false });
  assert.equal(again.json().changed, true);
  const reEngage = await post("/api/v1/trading/kill-switch", { active: true, reason: "Second engagement" });
  assert.equal(reEngage.json().changed, true);
  assert.equal(reEngage.json().notification, null, "the unread kill-switch alert suppresses the duplicate");
  assert.equal(await unreadCount(), 2, "the release and the one engagement alert");

  // Acknowledging it re-arms the key, so the next engagement is reported again.
  const inbox = await instance.app.inject({ method: "GET", url: "/api/v1/notifications?unread=1", headers: admin.headers });
  const active = inbox.json().notifications.find((entry) => entry.dedupeKey === "kill-switch:active");
  assert.ok(active, "the engagement alert is in the inbox");
  const read = await instance.app.inject({ method: "POST", url: `/api/v1/notifications/${active.id}/read`, headers: admin.headers, payload: {} });
  assert.equal(read.statusCode, 200, read.body);
  await post("/api/v1/trading/kill-switch", { active: false });
  const reArmed = await post("/api/v1/trading/kill-switch", { active: true, reason: "Third engagement" });
  assert.ok(reArmed.json().notification, "once acknowledged, a new engagement is new information");
});

test("a trading-mode change is alerted, and re-selecting the same mode is not", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);

  // ANALYSIS_ONLY is the boot mode, so re-selecting it is a no-op that must not
  // alert — the first observable change is the move to PAPER_TRADING.
  const same = await instance.app.inject({ method: "POST", url: "/api/v1/trading/mode", headers: admin.headers, payload: { mode: "ANALYSIS_ONLY" } });
  assert.equal(same.statusCode, 200, same.body);
  assert.equal(same.json().changed, false);
  assert.equal(same.json().notification, null, "an operator re-selecting the current mode does not fill the inbox");

  const first = await instance.app.inject({ method: "POST", url: "/api/v1/trading/mode", headers: admin.headers, payload: { mode: "PAPER_TRADING" } });
  assert.equal(first.json().changed, true);
  assert.equal(first.json().notification.type, "TRADING_MODE_CHANGED");
  assert.equal(first.json().notification.severity, "info", "moving towards paper trading is not a warning");
  assert.match(first.json().notification.title, /ANALYSIS_ONLY -> PAPER_TRADING/);
  assert.equal(first.json().notification.broadcast, true);

  const back = await instance.app.inject({ method: "POST", url: "/api/v1/trading/mode", headers: admin.headers, payload: { mode: "ANALYSIS_ONLY" } });
  assert.equal(back.json().notification.severity, "warning", "leaving paper trading is the direction worth flagging");
  assert.match(back.json().notification.title, /PAPER_TRADING -> ANALYSIS_ONLY/);

  const inbox = await instance.app.inject({ method: "GET", url: "/api/v1/notifications", headers: admin.headers });
  assert.equal(inbox.json().notifications.filter((entry) => entry.type === "TRADING_MODE_CHANGED").length, 2, "two real transitions, two alerts");
});

test("a governance action still succeeds when the notification cannot be stored", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);

  // Simulate a host whose migration 009 has not been applied: the alerting table
  // is missing, but the kill switch must still move. An alerting outage must not
  // look like a trading outage.
  const original = instance.store.createNotification;
  instance.store.createNotification = async () => { throw new Error("Table 'wf_notifications' doesn't exist"); };
  t.after(() => { instance.store.createNotification = original; });

  const engage = await instance.app.inject({ method: "POST", url: "/api/v1/trading/kill-switch", headers: admin.headers, payload: { active: true, reason: "Alerting is down but governance must not be" } });
  assert.equal(engage.statusCode, 200, engage.body);
  assert.equal(engage.json().killSwitch.active, true, "the governance change committed");
  assert.equal(engage.json().notification, null, "and the response admits no alert was raised");

  const state = await instance.app.inject({ method: "GET", url: "/api/v1/trading/mode", headers: admin.headers });
  assert.equal(state.json().killSwitch.active, true, "verified by reading the persisted state back");
});

test("the paper proposal lifecycle publishes the legacy alerts with the legacy dedupe keys", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);

  // Governance must permit paper trading before a proposal can be created.
  await instance.app.inject({ method: "POST", url: "/api/v1/trading/kill-switch", headers: admin.headers, payload: { active: false } });
  await instance.app.inject({ method: "POST", url: "/api/v1/trading/mode", headers: admin.headers, payload: { mode: "PAPER_TRADING" } });
  const account = await instance.app.inject({ method: "POST", url: "/api/v1/paper/accounts", headers: admin.headers, payload: { name: "Alerts", startingBalance: 10_000 } });
  assert.equal(account.statusCode, 201, account.body);
  const accountId = account.json().account.id;

  const proposal = await instance.app.inject({
    method: "POST",
    url: "/api/v1/execution/proposals",
    headers: admin.headers,
    payload: { accountId, symbol: "EURUSD", marketClass: "forex", side: "buy", stopLoss: 1.05 },
  });
  assert.equal(proposal.statusCode, 201, proposal.body);
  const proposalId = proposal.json().id;
  assert.equal(proposal.json().status, "PENDING_APPROVAL");

  // Legacy `TRADE_APPROVAL_REQUESTED`, warning, broadcast, keyed on the proposal.
  const afterPropose = await instance.app.inject({ method: "GET", url: "/api/v1/notifications", headers: admin.headers });
  const approval = afterPropose.json().notifications.find((entry) => entry.type === "TRADE_APPROVAL_REQUESTED");
  assert.ok(approval, "an approval request alert was raised");
  assert.equal(approval.severity, "warning");
  assert.equal(approval.title, "Approval required: EURUSD BUY");
  assert.equal(approval.dedupeKey, `proposal:${proposalId}`, "the legacy dedupe key");
  assert.equal(approval.detail.proposalId, proposalId);
  assert.ok(approval.detail.expiresAt, "the alert says when the request expires");
  assert.equal(approval.broadcast, true);
  assert.equal(proposal.json().notification, undefined, "propose() keeps its pre-existing response shape");

  const decision = await instance.app.inject({
    method: "POST",
    url: `/api/v1/execution/proposals/${proposalId}/decision`,
    headers: admin.headers,
    payload: { approve: true, reason: "Setup matches the approved strategy and risk is within limits" },
  });
  assert.equal(decision.statusCode, 200, decision.body);

  const submit = await instance.app.inject({
    method: "POST",
    url: `/api/v1/execution/proposals/${proposalId}/paper-submit`,
    headers: admin.headers,
    payload: {},
  });
  assert.ok([201, 202, 409].includes(submit.statusCode), submit.body);

  const afterSubmit = await instance.app.inject({ method: "GET", url: "/api/v1/notifications", headers: admin.headers });
  const outcome = afterSubmit.json().notifications.find((entry) => entry.dedupeKey?.startsWith(`proposal:${proposalId}:`));
  assert.ok(outcome, `the submission outcome was alerted (status ${submit.json().proposal?.status})`);
  assert.ok(
    ["ORDER_FILLED", "EXECUTION_FAILED"].includes(outcome.type),
    `the outcome alert is one of the legacy result types, got ${outcome.type}`,
  );
  assert.match(outcome.dedupeKey, new RegExp(`^proposal:${proposalId}:(filled|pending|rejected|failed)$`), "the legacy per-outcome dedupe key");
});

test("a proposal rejected by its own pre-checks raises no approval alert", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);

  // The kill switch is engaged by default, so this proposal is rejected at once.
  const account = await instance.app.inject({ method: "POST", url: "/api/v1/paper/accounts", headers: admin.headers, payload: { name: "Blocked", startingBalance: 10_000 } });
  assert.equal(account.statusCode, 201, account.body);
  const proposal = await instance.app.inject({
    method: "POST",
    url: "/api/v1/execution/proposals",
    headers: admin.headers,
    payload: { accountId: account.json().account.id, symbol: "EURUSD", marketClass: "forex", side: "buy", stopLoss: 1.05 },
  });
  assert.equal(proposal.statusCode, 201, proposal.body);
  assert.equal(proposal.json().status, "REJECTED");

  const inbox = await instance.app.inject({ method: "GET", url: "/api/v1/notifications?severity=warning", headers: admin.headers });
  assert.equal(inbox.json().notifications.some((entry) => entry.type === "TRADE_APPROVAL_REQUESTED"), false, "nothing reached the approval queue, so there is no decision to request");
});

// --------------------------------------------------------------- status surface

test("the status surface reports notifications as ported and denies a delivery channel it does not have", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());

  const status = await instance.app.inject({ method: "GET", url: "/api/v1/system/status" });
  assert.equal(status.statusCode, 200);
  const body = status.json();
  const module = body.modules.find((entry) => entry.key === "notifications");
  assert.equal(module.state, "ported");
  assert.match(module.label, /no outbound delivery/i, "the label itself states the limitation");
  assert.match(module.tests, /unit \+ http/);

  assert.equal(body.notifications.available, true);
  assert.equal(body.notifications.storeConfigured, true);
  assert.equal(body.notifications.emailDeliveryAvailable, false);
  assert.deepEqual(body.notifications.deliveryChannels, []);
  assert.equal(body.notifications.readStateScope, "global");
  assert.ok(body.notifications.types.includes("KILL_SWITCH"));

  const features = await instance.app.inject({ method: "GET", url: "/api/v1/system/features" });
  assert.equal(features.json().features.notifications, "ported");
  assert.equal(features.json().features.brokers, "not-ported", "the other modules are unaffected by this port");
});
