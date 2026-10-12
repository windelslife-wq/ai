/**
 * The notification repository against a recording MySQL-shaped executor, and
 * against the file adapter — because both must answer the inbox, the dedupe
 * check and the two read transitions identically, or a route would silently
 * depend on whichever adapter the host happens to use.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createNotificationRepository } from "../src/db/notification-repository.js";
import { createFileStore } from "../src/persistence/file-store.js";

const NOW = "2026-10-11T12:00:00.000Z";

function mysqlRow(overrides = {}) {
  return {
    id: "4",
    user_id: null,
    type: "KILL_SWITCH",
    severity: "critical",
    title: "KILL SWITCH ACTIVATED — all order placement blocked",
    detail_json: JSON.stringify({ reason: "operator" }),
    dedupe_key: "kill-switch:active",
    read_at: null,
    created_at: NOW,
    ...overrides,
  };
}

function recordingExecutor({ rows = [mysqlRow()], affectedRows = 1, count = 1 } = {}) {
  const calls = [];
  const savedRows = rows.map((row) => ({ ...row }));
  return {
    calls,
    savedRows,
    async execute(sql, values = []) {
      calls.push({ kind: "execute", sql, values });
      if (/^\s*SELECT COUNT\(/i.test(sql)) return [[{ unread: count, matches: count }], []];
      if (/^\s*SELECT/i.test(sql)) return [savedRows, []];
      if (/^\s*UPDATE/i.test(sql)) {
        for (const row of savedRows) row.read_at = String(values[0]);
      }
      return [{ affectedRows, insertId: 4 }, []];
    },
    async query(sql, values = []) {
      calls.push({ kind: "query", sql, values });
      return [savedRows, []];
    },
  };
}

async function tempStore(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-notifications-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return createFileStore({ dir, syncWrites: false, logger: { warn() {} } });
}

// ------------------------------------------------------------------ SQL shape

test("the notification repository binds every value and scopes visibility in SQL", async () => {
  const executor = recordingExecutor();
  const repo = createNotificationRepository(executor);

  await repo.createNotification({
    userId: 7,
    type: "PORTFOLIO_RISK",
    severity: "warning",
    title: "DRAWDOWN_LIMIT: account 3 risk alert",
    detail: { code: "DRAWDOWN_LIMIT" },
    dedupeKey: "portfolio:3",
    createdAt: NOW,
  });
  const insert = executor.calls[0];
  assert.match(insert.sql, /INSERT INTO wf_notifications/);
  assert.equal(insert.sql.includes("7"), false, "the recipient id is bound, never interpolated");
  assert.deepEqual(insert.values, [7, "PORTFOLIO_RISK", "warning", "DRAWDOWN_LIMIT: account 3 risk alert", JSON.stringify({ code: "DRAWDOWN_LIMIT" }), "portfolio:3", NOW]);
  assert.match(insert.sql, /read_at, created_at\)\s+VALUES \([\s\S]*NULL/, "a new notification is always unread");

  // Signed-in: broadcast OR own.
  await repo.listNotifications(7, { limit: 25 });
  const signedIn = executor.calls.at(-1);
  assert.match(signedIn.sql, /\(user_id IS NULL OR user_id = \?\)/);
  assert.deepEqual(signedIn.values, [7]);
  assert.match(signedIn.sql, /LIMIT 25/);

  // Anonymous: broadcasts only, which is the whole legacy visibility rule.
  await repo.listNotifications(null, {});
  const anonymous = executor.calls.at(-1);
  assert.match(anonymous.sql, /user_id IS NULL/);
  assert.equal(anonymous.sql.includes("OR user_id"), false);
  assert.deepEqual(anonymous.values, []);
});

test("the SQL adapter bounds LIMIT and refuses to interpolate an unbounded one", async () => {
  const executor = recordingExecutor();
  const repo = createNotificationRepository(executor);
  await repo.listNotifications(7, { limit: 100_000 });
  assert.match(executor.calls.at(-1).sql, /LIMIT 200/, "capped at the legacy 200-row ceiling");
  await repo.listNotifications(7, { limit: "not-a-number" });
  assert.match(executor.calls.at(-1).sql, /LIMIT 50/, "an unparsable limit falls back, it does not vanish");
  await repo.listNotifications(7, { limit: 0 });
  assert.match(executor.calls.at(-1).sql, /LIMIT 1/);
});

test("markRead is a conditional update, so an already-read or foreign row reports false", async () => {
  const updated = createNotificationRepository(recordingExecutor({ affectedRows: 1 }));
  assert.equal(await updated.markNotificationRead(4, 7, NOW), true);

  const untouched = createNotificationRepository(recordingExecutor({ affectedRows: 0 }));
  assert.equal(await untouched.markNotificationRead(4, 7, NOW), false, "no row changed means nothing was read");

  const executor = recordingExecutor({ affectedRows: 1 });
  await createNotificationRepository(executor).markNotificationRead(4, 7, NOW);
  const update = executor.calls.at(-1);
  assert.match(update.sql, /read_at IS NULL/, "only an unread row can be marked read");
  assert.match(update.sql, /\(user_id IS NULL OR user_id = \?\)/);
  assert.deepEqual(update.values, [NOW, 4, 7]);
});

test("the dedupe check is global, not per recipient", async () => {
  const executor = recordingExecutor({ count: 1 });
  const repo = createNotificationRepository(executor);
  assert.equal(await repo.hasUnreadNotificationDedupe("kill-switch:active"), true);
  const check = executor.calls.at(-1);
  assert.match(check.sql, /dedupe_key = \? AND read_at IS NULL/);
  assert.equal(check.sql.includes("user_id"), false, "a broadcast alert must not be re-raised per operator");
  assert.deepEqual(check.values, ["kill-switch:active"]);

  const none = createNotificationRepository(recordingExecutor({ count: 0 }));
  assert.equal(await none.hasUnreadNotificationDedupe("kill-switch:active"), false);
});

test("an unreadable stored detail degrades to an empty object instead of failing the inbox", async () => {
  const executor = recordingExecutor({ rows: [mysqlRow({ detail_json: "{not json" })] });
  const rows = await createNotificationRepository(executor).listNotifications(7, {});
  assert.deepEqual(rows[0].detail, {});
  assert.equal(rows[0].title, mysqlRow().title, "the rest of the operator's evidence survives");
});

test("the SQL adapter hands back numbers for ids and a decoded detail object", async () => {
  const executor = recordingExecutor({ rows: [mysqlRow({ id: "42", user_id: "7", detail_json: JSON.stringify({ a: [1, 2] }) })] });
  const [row] = await createNotificationRepository(executor).listNotifications(7, {});
  assert.equal(row.id, 42);
  assert.equal(row.user_id, 7);
  assert.deepEqual(row.detail, { a: [1, 2] });
  assert.equal(row.read_at, null);
});

// ------------------------------------------------------- both adapters agree

test("both adapters implement the same notification visibility, dedupe and read rules", async (t) => {
  const file = await tempStore(t);
  t.after(() => file.close());

  const seed = async (store) => {
    const broadcast = await store.createNotification({ userId: null, type: "KILL_SWITCH", severity: "critical", title: "Kill switch engaged", detail: {}, dedupeKey: "kill-switch:active", createdAt: "2026-10-11T09:00:00.000Z" });
    const mine = await store.createNotification({ userId: 7, type: "TRADE_APPROVAL_REQUESTED", severity: "warning", title: "Approval required: EURUSD BUY", detail: { symbol: "EURUSD" }, dedupeKey: "proposal:a", createdAt: "2026-10-11T10:00:00.000Z" });
    const theirs = await store.createNotification({ userId: 9, type: "ORDER_FILLED", severity: "info", title: "Filled BUY XAUUSD (paper)", detail: {}, dedupeKey: null, createdAt: "2026-10-11T11:00:00.000Z" });
    return { broadcast, mine, theirs };
  };
  const rows = await seed(file);

  // Broadcast + own, newest first; the other operator's targeted row is invisible.
  const inbox = await file.listNotifications(7, {});
  assert.deepEqual(
    inbox.map((row) => row.title),
    ["Approval required: EURUSD BUY", "Kill switch engaged"],
    "newest first, own plus broadcast only",
  );
  assert.equal(inbox.some((row) => row.user_id === 9), false, "another operator's targeted alert is never visible");

  // An unauthenticated caller sees broadcasts only.
  const anonymous = await file.listNotifications(null, {});
  assert.deepEqual(anonymous.map((row) => row.title), ["Kill switch engaged"]);

  assert.equal(await file.countUnreadNotifications(7), 2);
  assert.equal(await file.countUnreadNotifications(null), 1, "anonymous unread counts broadcasts only");
  assert.equal(await file.countUnreadNotifications(9), 2, "the other operator sees the broadcast plus their own");

  // Dedupe is global: user 9's unread row suppresses a re-publish for user 7 too.
  assert.equal(await file.hasUnreadNotificationDedupe("kill-switch:active"), true);
  assert.equal(await file.hasUnreadNotificationDedupe("proposal:a"), true);
  assert.equal(await file.hasUnreadNotificationDedupe("never-published"), false);

  // A targeted row cannot be read by someone it is not visible to.
  assert.equal(await file.markNotificationRead(rows.mine.id, 9, NOW), false, "user 9 cannot read user 7's targeted alert");
  assert.equal(await file.markNotificationRead(rows.mine.id, 7, NOW), true);
  assert.equal(await file.markNotificationRead(rows.mine.id, 7, NOW), false, "reading is idempotent, and says so");
  assert.equal(await file.markNotificationRead(999_999, 7, NOW), false, "an unknown id reports false, not an error");

  // Read state is GLOBAL to the row (legacy behaviour, divergence NV-2): once
  // user 7 reads the broadcast it is read for user 9 as well.
  assert.equal(await file.markNotificationRead(rows.broadcast.id, 7, NOW), true);
  assert.equal(await file.countUnreadNotifications(9), 1, "the broadcast is now read for everyone — legacy semantics, preserved deliberately");

  // read-all covers broadcast + own, and reports how many changed.
  const second = await tempStore(t);
  t.after(() => second.close());
  await seed(second);
  assert.equal(await second.markAllNotificationsRead(7, NOW), 2);
  assert.equal(await second.markAllNotificationsRead(7, NOW), 0, "a second read-all has nothing left to do");
  assert.equal(await second.countUnreadNotifications(9), 1, "read-all never touches another operator's targeted rows");

  // Unread-only filtering.
  const third = await tempStore(t);
  t.after(() => third.close());
  const thirdRows = await seed(third);
  await third.markNotificationRead(thirdRows.mine.id, 7, NOW);
  const unreadOnly = await third.listNotifications(7, { unreadOnly: true });
  assert.deepEqual(unreadOnly.map((row) => row.title), ["Kill switch engaged"]);
  assert.equal((await third.listNotifications(7, {})).length, 2, "the unfiltered inbox still shows the read row");
});

test("the file adapter replays notifications from its write-ahead log", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-notifications-replay-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = await createFileStore({ dir, logger: { warn() {} } });
  const created = await first.createNotification({ userId: null, type: "KILL_SWITCH", severity: "critical", title: "Kill switch engaged", detail: { reason: "test" }, dedupeKey: "kill-switch:active", createdAt: NOW });
  await first.close();

  const second = await createFileStore({ dir, syncWrites: false, logger: { warn() {} } });
  t.after(() => second.close());
  const [row] = await second.listNotifications(null, {});
  assert.equal(row.id, created.id, "the id survives replay rather than being reallocated");
  assert.deepEqual(row.detail, { reason: "test" });
  assert.equal(row.read_at, null);
  assert.equal(await second.hasUnreadNotificationDedupe("kill-switch:active"), true, "dedupe still works after a restart");
  assert.equal((await second.stats()).notifications, 1);
});
