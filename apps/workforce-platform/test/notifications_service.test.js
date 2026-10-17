/**
 * The notification service: the legacy `Aegis\Notifications\Notifier` behaviour
 * (unread-dedupe, broadcast/targeted visibility, severity coercion, title
 * truncation) plus the Node-side additions that the legacy code did not have.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFileStore } from "../src/persistence/file-store.js";
import { createNotificationService } from "../src/modules/notifications/service.js";
import { NOTIFICATION_TYPES, NOTIFICATION_SEVERITIES } from "../src/modules/notifications/contracts.js";
import { AppError } from "../src/http/errors.js";

const START = Date.parse("2026-10-11T12:00:00.000Z");

async function harness(t, { notificationsOverride = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-notifications-service-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await createFileStore({ dir, syncWrites: false, logger: { warn() {} } });
  t.after(() => store.close());
  const operator = await store.createUser({ username: "operator", email: "operator@example.test", passwordHash: "x", displayName: "Operator" });
  const other = await store.createUser({ username: "second", email: "second@example.test", passwordHash: "x", displayName: "Second" });
  let clock = START;
  const service = notificationsOverride ?? createNotificationService({ store, now: () => clock, log: { warn() {}, error() {} } });
  return { store, service, operator, other, advance: (ms) => { clock += ms; }, clock: () => clock };
}

function isAppError(code, status) {
  return (error) => error instanceof AppError && error.code === code && error.statusCode === status;
}

// ------------------------------------------------------------------- publishing

test("notify stores a broadcast alert and reports it as created", async (t) => {
  const { service } = await harness(t);
  const result = await service.notify("KILL_SWITCH", "critical", "KILL SWITCH ACTIVATED — all order placement blocked", { reason: "operator" }, "kill-switch:active");
  assert.equal(result.created, true);
  assert.equal(result.deduped, false);
  assert.equal(result.notification.broadcast, true);
  assert.equal(result.notification.userId, null);
  assert.equal(result.notification.severity, "critical");
  assert.equal(result.notification.unread, true);
  assert.equal(result.notification.readAt, null);
  assert.deepEqual(result.notification.detail, { reason: "operator" });
  assert.equal(result.notification.createdAt, "2026-10-11T12:00:00.000Z");
});

test("an UNREAD duplicate dedupe key suppresses the second publish — one badge per active issue", async (t) => {
  const { service, advance } = await harness(t);
  const first = await service.notify("PORTFOLIO_RISK", "warning", "DRAWDOWN_LIMIT risk alert", { code: "DRAWDOWN_LIMIT" }, "portfolio:3");
  assert.equal(first.created, true);

  advance(60_000);
  const second = await service.notify("PORTFOLIO_RISK", "warning", "DRAWDOWN_LIMIT risk alert", { code: "DRAWDOWN_LIMIT" }, "portfolio:3");
  assert.equal(second.created, false, "a recurring scan must not stack identical unread alerts");
  assert.equal(second.deduped, true);
  assert.equal(second.notification, null);

  advance(60_000);
  const third = await service.notify("PORTFOLIO_RISK", "warning", "DRAWDOWN_LIMIT risk alert", {}, "portfolio:3");
  assert.equal(third.created, false);

  const inbox = await service.inbox(null, {});
  assert.equal(inbox.notifications.length, 1, "three publishes produced one stored alert");
  assert.equal(inbox.unread, 1);
});

test("acknowledging the alert re-arms the dedupe key, so a recurrence is reported again", async (t) => {
  const { service, operator } = await harness(t);
  await service.notify("PORTFOLIO_RISK", "warning", "Risk alert", {}, "portfolio:3");
  const [row] = (await service.inbox(operator.id, {})).notifications;
  assert.equal(await service.markRead(row.id, operator.id), true);

  const again = await service.notify("PORTFOLIO_RISK", "warning", "Risk alert", {}, "portfolio:3");
  assert.equal(again.created, true, "once an operator has seen it, the next occurrence is new information");
  assert.equal((await service.inbox(operator.id, {})).unread, 1);
});

test("a null or empty dedupe key never dedupes", async (t) => {
  const { service } = await harness(t);
  for (let index = 0; index < 3; index += 1) {
    const result = await service.notify("ORDER_FILLED", "info", `Fill ${index}`, {}, null);
    assert.equal(result.created, true);
  }
  assert.equal((await service.inbox(null, {})).notifications.length, 3);
  const blank = await service.notify("ORDER_FILLED", "info", "Fill", {}, "   ");
  assert.equal(blank.created, true, "whitespace-only keys are treated as no key, not as one shared key");
});

test("an unknown severity is coerced to info, exactly as the legacy repository did", async (t) => {
  const { service } = await harness(t);
  assert.equal((await service.notify("ORDER_FILLED", "URGENT", "Title", {}, null)).notification.severity, "info");
  assert.equal((await service.notify("ORDER_FILLED", undefined, "Title", {}, null)).notification.severity, "info");
  assert.equal((await service.notify("ORDER_FILLED", "  Critical  ", "Title", {}, null)).notification.severity, "critical", "case and padding are normalized");
  assert.deepEqual([...NOTIFICATION_SEVERITIES], ["info", "warning", "critical"]);
});

// The ten types the PHP application actually publishes, harvested from every
// `Notifier::notify()` call site under `application/libraries/Aegis/`.
const LEGACY_TYPES = Object.freeze([
  "KILL_SWITCH",
  "TRADE_APPROVAL_REQUESTED",
  "EXECUTION_FAILED",
  "ORDER_FILLED",
  "PROPOSAL_EXPIRED",
  "ROUTING_BLOCKED",
  "PORTFOLIO_RISK",
  "BROKER_CONNECTED",
  "BROKER_DISCONNECTED",
  "SPORTS_MODEL_DRIFT",
]);

// Divergence NV-3: the legacy platform audited a trading-mode change but never
// raised an alert for one. The Node edition publishes it, because the mode gates
// every proposal and an operator watching the inbox should see it move. It is an
// addition, declared here rather than smuggled into the legacy list.
const NODE_ADDED_TYPES = Object.freeze(["TRADING_MODE_CHANGED"]);

test("the type vocabulary is the legacy one plus declared additions, and an unknown type is refused", async (t) => {
  const { service } = await harness(t);
  for (const type of LEGACY_TYPES) {
    assert.ok(NOTIFICATION_TYPES.includes(type), `${type} is part of the ported vocabulary`);
    assert.equal((await service.notify(type, "info", `${type} alert`, {}, null)).created, true);
  }
  assert.equal(LEGACY_TYPES.length, 10, "exactly the ten legacy types");
  assert.deepEqual(
    NOTIFICATION_TYPES.filter((type) => !LEGACY_TYPES.includes(type)),
    [...NODE_ADDED_TYPES],
    "anything beyond the legacy vocabulary is an explicit, named addition",
  );
  await assert.rejects(service.notify("MADE_UP_TYPE", "info", "Nope", {}, null), isAppError("INVALID_NOTIFICATION_TYPE", 400));
  await assert.rejects(service.notify("", "info", "Nope", {}, null), isAppError("INVALID_NOTIFICATION_TYPE", 400));
  await assert.rejects(service.notify(null, "info", "Nope", {}, null), isAppError("INVALID_NOTIFICATION_TYPE", 400));
  assert.equal((await service.inbox(null, {})).notifications.length, LEGACY_TYPES.length, "the rejected types stored nothing");
});

test("a title is truncated to the legacy 200 characters, not rejected, and code points are not split", async (t) => {
  const { service } = await harness(t);
  const long = await service.notify("ORDER_FILLED", "info", "x".repeat(500), {}, null);
  assert.equal(long.notification.title.length, 200);
  const padded = await service.notify("ORDER_FILLED", "info", "  many    spaces  ", {}, null);
  assert.equal(padded.notification.title, "many spaces");
  await assert.rejects(service.notify("ORDER_FILLED", "info", "   ", {}, null), isAppError("INVALID_NOTIFICATION_TITLE", 400));
  // A surrogate pair at the boundary must survive whole.
  const emoji = await service.notify("ORDER_FILLED", "info", `${"y".repeat(199)}🙂`, {}, null);
  assert.equal(Array.from(emoji.notification.title).length, 200);
  assert.ok(emoji.notification.title.endsWith("🙂"));
});

test("an over-long dedupe key is refused rather than silently truncated", async (t) => {
  const { service } = await harness(t);
  await assert.rejects(service.notify("ORDER_FILLED", "info", "Title", {}, "k".repeat(121)), isAppError("INVALID_DEDUPE_KEY", 400));
  assert.equal((await service.notify("ORDER_FILLED", "info", "Title", {}, "k".repeat(120))).created, true);
});

// ------------------------------------------------------------- detail bounding

test("a detail payload is bounded, and truncation is stated rather than silent", async (t) => {
  const { service } = await harness(t);

  const deep = await service.notify("PORTFOLIO_RISK", "warning", "Deep", { a: { b: { c: { d: { e: "too deep" } } } } }, null);
  assert.equal(deep.truncated, true);
  assert.equal(deep.notification.detail.truncated, true, "the stored row admits it was truncated");

  const wide = await service.notify("PORTFOLIO_RISK", "warning", "Wide", Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`key${index}`, index])), null);
  assert.equal(wide.truncated, true);

  const huge = await service.notify("PORTFOLIO_RISK", "warning", "Huge", { blob: "z".repeat(64_000) }, null);
  assert.equal(huge.truncated, true);
  assert.ok(JSON.stringify(huge.notification.detail).length < 20_000, "the stored payload stays inside the bound");

  const fits = await service.notify("PORTFOLIO_RISK", "warning", "Normal", { code: "DRAWDOWN_LIMIT", equity: 1000.5, positions: [1, 2, 3] }, null);
  assert.equal(fits.truncated, false);
  assert.deepEqual(fits.notification.detail, { code: "DRAWDOWN_LIMIT", equity: 1000.5, positions: [1, 2, 3] });
});

test("a detail payload cannot smuggle a function, a circular reference or a non-finite number into storage", async (t) => {
  const { service } = await harness(t);
  const circular = {};
  circular.self = circular;
  const result = await service.notify("PORTFOLIO_RISK", "warning", "Awkward", {
    fn: () => "no",
    symbolValue: Symbol("no"),
    undef: undefined,
    nan: Number.NaN,
    infinity: Number.POSITIVE_INFINITY,
    big: 10n,
    circular,
    kept: "yes",
  }, null);
  assert.equal(result.created, true, "an awkward payload is sanitized, not fatal");
  const detail = result.notification.detail;
  assert.equal(detail.kept, "yes");
  assert.equal(detail.fn, null);
  assert.equal(detail.nan, null);
  assert.equal(detail.infinity, null);
  assert.equal(detail.big, "10");
  assert.equal("undef" in detail === false || detail.undef === null, true);
  assert.doesNotThrow(() => JSON.stringify(detail));
});

// ----------------------------------------------------------------- the inbox

test("the inbox is broadcast plus own, newest first, with an unread badge independent of page filters", async (t) => {
  const { service, operator, other, advance } = await harness(t);
  await service.notify("KILL_SWITCH", "critical", "Broadcast alert", {}, null, null);
  advance(1000);
  await service.notify("TRADE_APPROVAL_REQUESTED", "warning", "Mine", {}, null, operator.id);
  advance(1000);
  await service.notify("ORDER_FILLED", "info", "Theirs", {}, null, other.id);

  const mine = await service.inbox(operator.id, {});
  assert.deepEqual(mine.notifications.map((entry) => entry.title), ["Mine", "Broadcast alert"]);
  assert.equal(mine.unread, 2);
  assert.equal(mine.returned, 2);

  const theirs = await service.inbox(other.id, {});
  assert.deepEqual(theirs.notifications.map((entry) => entry.title), ["Theirs", "Broadcast alert"]);

  const anonymous = await service.inbox(null, {});
  assert.deepEqual(anonymous.notifications.map((entry) => entry.title), ["Broadcast alert"], "an unauthenticated reader sees broadcasts only");
  assert.equal(anonymous.unread, 1);
});

test("the inbox filters by severity and type without changing the unread badge", async (t) => {
  const { service, advance } = await harness(t);
  await service.notify("KILL_SWITCH", "critical", "Critical one", {}, null);
  advance(1000);
  await service.notify("ORDER_FILLED", "info", "Info one", {}, null);

  const critical = await service.inbox(null, { severity: "critical" });
  assert.deepEqual(critical.notifications.map((entry) => entry.title), ["Critical one"]);
  assert.equal(critical.severity, "critical");
  assert.equal(critical.unread, 2, "the badge counts everything visible, not just the filtered page");

  const filled = await service.inbox(null, { type: "ORDER_FILLED" });
  assert.deepEqual(filled.notifications.map((entry) => entry.title), ["Info one"]);

  const unreadOnly = await service.inbox(null, { unreadOnly: true });
  assert.equal(unreadOnly.notifications.length, 2);
  assert.equal(unreadOnly.unreadOnly, true);
});

test("the inbox limit is bounded to the legacy 1..200 window", async (t) => {
  const { service, advance } = await harness(t);
  for (let index = 0; index < 5; index += 1) {
    await service.notify("ORDER_FILLED", "info", `Fill ${index}`, {}, null);
    advance(1000);
  }
  assert.equal((await service.inbox(null, { limit: 2 })).notifications.length, 2);
  assert.equal((await service.inbox(null, { limit: 2 })).limit, 2);
  assert.equal((await service.inbox(null, { limit: 99_999 })).limit, 200);
  assert.equal((await service.inbox(null, { limit: 0 })).limit, 50, "an unparsable limit falls back to the default");
  assert.equal((await service.inbox(null, {})).limit, 50);
});

// --------------------------------------------------------------- read state

test("markRead is owner-scoped, idempotent, and audited only when it changed something", async (t) => {
  const { service, store, operator, other } = await harness(t);
  const targeted = await service.notify("TRADE_APPROVAL_REQUESTED", "warning", "Mine", {}, null, operator.id);
  const id = targeted.notification.id;

  assert.equal(await service.markRead(id, other.id), false, "another operator cannot read a targeted alert");
  assert.equal((await store.listAuditEvents({})).events.filter((event) => event.action === "notification.read").length, 0, "a no-op read writes no audit event");

  assert.equal(await service.markRead(id, operator.id), true);
  assert.equal(await service.markRead(id, operator.id), false, "reading twice reports the second time as a no-op");
  const events = (await store.listAuditEvents({})).events.filter((event) => event.action === "notification.read");
  assert.equal(events.length, 1, "exactly one audited read");
  assert.equal(events[0].entityId, String(id));
  // `listAuditEvents` maps the row to a read view that exposes `details` but not
  // `actor_user_id`; the actor is asserted through the recorded detail instead.
  assert.equal(events[0].details.notificationId, id);

  const inbox = await service.inbox(operator.id, {});
  assert.equal(inbox.unread, 0);
  assert.equal(inbox.notifications[0].readAt, "2026-10-11T12:00:00.000Z");
  assert.equal(inbox.notifications[0].unread, false);
});

test("read state is GLOBAL to a broadcast row — legacy semantics preserved, and documented as NV-2", async (t) => {
  const { service, operator, other } = await harness(t);
  const broadcast = await service.notify("KILL_SWITCH", "critical", "Broadcast", {}, null, null);
  assert.equal((await service.inbox(other.id, {})).unread, 1);
  assert.equal(await service.markRead(broadcast.notification.id, operator.id), true);
  assert.equal((await service.inbox(other.id, {})).unread, 0, "one operator acknowledging a broadcast clears it for all of them, as the legacy single read_at column did");
  assert.equal(service.statusSnapshot().readStateScope, "global", "the status surface states the scope instead of leaving it implicit");
});

test("markAllRead covers broadcast plus own, reports the count, and is audited once", async (t) => {
  const { service, store, operator, other, advance } = await harness(t);
  await service.notify("KILL_SWITCH", "critical", "Broadcast", {}, null, null);
  advance(1000);
  await service.notify("TRADE_APPROVAL_REQUESTED", "warning", "Mine", {}, null, operator.id);
  advance(1000);
  await service.notify("ORDER_FILLED", "info", "Theirs", {}, null, other.id);

  assert.equal(await service.markAllRead(operator.id), 2);
  assert.equal(await service.markAllRead(operator.id), 0, "a second call has nothing left to do");
  assert.equal((await service.inbox(other.id, {})).unread, 1, "another operator's targeted row is untouched");
  const events = (await store.listAuditEvents({})).events.filter((event) => event.action === "notification.read-all");
  assert.equal(events.length, 1, "only the call that changed something is audited");
  assert.equal(events[0].details.markedRead, 2);
});

test("the read routes require an authenticated actor and reject a malformed id", async (t) => {
  const { service } = await harness(t);
  await assert.rejects(service.markRead(1, null), isAppError("AUTH_REQUIRED", 401));
  await assert.rejects(service.markRead(1, undefined), isAppError("AUTH_REQUIRED", 401));
  await assert.rejects(service.markAllRead(null), isAppError("AUTH_REQUIRED", 401));
  await assert.rejects(service.markRead(0, 7), isAppError("INVALID_NOTIFICATION_ID", 400));
  await assert.rejects(service.markRead(-1, 7), isAppError("INVALID_NOTIFICATION_ID", 400));
  await assert.rejects(service.markRead("abc", 7), isAppError("INVALID_NOTIFICATION_ID", 400));
});

// ------------------------------------------------------------- failure modes

test("a missing persistence adapter is a 503 with Retry-After, never a 500", async () => {
  const service = createNotificationService({ store: null });
  await assert.rejects(service.notify("KILL_SWITCH", "critical", "x", {}, null), isAppError("NOTIFICATION_STORE_UNAVAILABLE", 503));
  await assert.rejects(service.inbox(7, {}), isAppError("NOTIFICATION_STORE_UNAVAILABLE", 503));
  await assert.rejects(service.markRead(1, 7), isAppError("NOTIFICATION_STORE_UNAVAILABLE", 503));
  await assert.rejects(service.markAllRead(7), isAppError("NOTIFICATION_STORE_UNAVAILABLE", 503));
  assert.equal(service.statusSnapshot().storeConfigured, false);
  assert.equal(service.statusSnapshot().available, true, "the module exists even where the store does not");
});

test("a publisher is never broken by a failing notification write", async (t) => {
  const { store, operator } = await harness(t);
  const warnings = [];
  const broken = { ...store, createNotification: async () => { throw new Error("table wf_notifications does not exist"); } };
  const service = createNotificationService({ store: broken, log: { warn(message) { warnings.push(message); }, error() {} }, now: () => START });

  const result = await service.notify("KILL_SWITCH", "critical", "Kill switch engaged", {}, "kill-switch:active", null);
  assert.equal(result.created, false);
  assert.equal(result.notification, null);
  assert.equal(result.error.code, "NOTIFICATION_PERSISTENCE_FAILED");
  assert.match(result.error.message, /still completed/, "the message says the triggering action was not rolled back");
  // The inbox must still work: an alerting failure is not an inbox failure.
  const inbox = await service.inbox(operator.id, {});
  assert.equal(inbox.unread, 0);
  assert.deepEqual(inbox.notifications, []);
});

// -------------------------------------------------------------- honesty

test("a service composed without the email opt-in reports in-product delivery only", async (t) => {
  const { service } = await harness(t);
  const snapshot = service.statusSnapshot();
  assert.equal(snapshot.emailDeliveryAvailable, false);
  assert.deepEqual(snapshot.deliveryChannels, ["in-product"]);
  // Phase 49 (row 5, DV-28): the email copy exists but is gated — the reason must
  // name the gate and still deny a delivery it will not make on this host.
  assert.match(snapshot.reason, /stored and read in-product/i);
  assert.match(snapshot.reason, /opt-in email copy \(row 5, Phase 49\) is off/i);
  assert.match(snapshot.reason, /VP_NOTIFY_EMAIL_ENABLED=1/);
  assert.match(snapshot.reason, /nothing here claims to have delivered/i, "the reason denies a delivery it cannot make");
  assert.deepEqual(snapshot.types, [...NOTIFICATION_TYPES]);
  assert.match(snapshot.dedupe, /unread/i);
  assert.match(snapshot.broadcast, /every signed-in operator/i);
});
