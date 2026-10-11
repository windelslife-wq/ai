/**
 * The audit browser (Phase 10, row 5 of UNFINISHED_MODULES.md).
 *
 * Three properties matter more than the filtering convenience, and each has its
 * own test here:
 *
 *  1. **Attribution.** An audit trail that cannot say who acted is not evidence,
 *     so every event carries a resolved actor and a system event says so rather
 *     than borrowing a user's identity.
 *  2. **Narrowed authority.** The legacy `api/events` endpoint needed only a
 *     signed-in user, so every operator could read every other operator's trail.
 *     Node requires `identity.users.view` (divergence AV-1).
 *  3. **Immutability.** No route on either adapter can edit, redact or delete an
 *     audit event. An audit trail an API can prune is not an audit trail.
 */

import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { cookieFrom, createFileStoreApp } from "./helpers.js";
import { createFileStore } from "../src/persistence/file-store.js";
import { createAccountRepository } from "../src/db/account-repository.js";

const ENV = { PUBLIC_BASE_URL: "https://site.example.test" };

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  const cookie = cookieFrom(response);
  return { cookie, headers: { cookie, "x-csrf-token": body.csrfToken } };
}

/** A signed-in member with `system.authenticated` and deliberately nothing else. */
async function addPlainMember(store, username = "plainmember") {
  const user = await store.createUser({
    username,
    email: `${username}@example.test`,
    passwordHash: await bcrypt.hash(`${username} secret phrase`, 4),
    displayName: username,
  });
  const role = (await store.listRoles()).find((entry) => entry.role_key === "platform_member");
  const permission = await store.ensurePermission("system.authenticated", "Signed-in member baseline");
  await store.grantRolePermission(role.id, permission.id);
  await store.assignRole(user.id, role.id);
  return user;
}

// ------------------------------------------------------------------ authority

test("the audit browser is registered, permissioned, and read-only", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());

  const inventory = await instance.app.inject({ method: "GET", url: "/api/v1/system/routes" });
  const routes = inventory.json().routes;
  const byPath = new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));

  const browser = byPath.get("GET /api/v1/admin/audit");
  assert.ok(browser, "GET /api/v1/admin/audit is registered");
  assert.equal(browser.auth, true);
  assert.equal(browser.permission, "identity.users.view");
  assert.equal(browser.validated, true, "the query is schema-validated");

  // Immutability, asserted against the whole inventory rather than against a list
  // of paths someone remembered to write down.
  const auditRoutes = routes.filter((route) => /\/api\/v1\/(?:admin\/)?(?:audit|account\/activity)/.test(route.path));
  assert.deepEqual(auditRoutes.map((route) => route.method).sort(), ["GET", "GET"], "every audit route is a read");
  for (const route of auditRoutes) {
    assert.equal(route.method, "GET", `${route.path} must not mutate the trail`);
  }
  assert.equal(routes.some((route) => /audit/.test(route.path) && route.method !== "GET"), false, "no POST/PATCH/PUT/DELETE reaches the audit trail");
});

test("the legacy endpoint needed only a signed-in user; Node narrows it to identity.users.view (AV-1)", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  await addPlainMember(instance.store);

  const anonymous = await instance.app.inject({ method: "GET", url: "/api/v1/admin/audit" });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error.code, "AUTH_REQUIRED");

  const login = await instance.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: "plainmember", password: "plainmember secret phrase" } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = cookieFrom(login);
  const member = await instance.app.inject({ method: "GET", url: "/api/v1/admin/audit", headers: { cookie } });
  assert.equal(member.statusCode, 403, "a signed-in member is not an auditor");
  assert.equal(member.json().error.code, "PERMISSION_DENIED");

  const admin = await signIn(instance.app);
  const allowed = await instance.app.inject({ method: "GET", url: "/api/v1/admin/audit", headers: admin.headers });
  assert.equal(allowed.statusCode, 200, allowed.body);
});

test("the caller's own activity route still works and still shows only their events", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  await addPlainMember(instance.store);
  const memberLogin = await instance.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: "plainmember", password: "plainmember secret phrase" } });
  const memberCookie = cookieFrom(memberLogin);

  const own = await instance.app.inject({ method: "GET", url: "/api/v1/account/activity?limit=50", headers: { cookie: memberCookie } });
  assert.equal(own.statusCode, 200, own.body);
  const actors = own.json().events.map((event) => event.actor?.userId ?? null);
  assert.ok(actors.length > 0, "the login itself was audited");
  assert.deepEqual([...new Set(actors)], [2], "the activity route never widens to another actor");

  // The admin browser, by contrast, sees both actors.
  const admin = await signIn(instance.app);
  const all = await instance.app.inject({ method: "GET", url: "/api/v1/admin/audit?limit=200", headers: admin.headers });
  const allActors = new Set(all.json().events.map((event) => event.actor?.userId ?? "system"));
  assert.ok(allActors.has(1) && allActors.has(2), `the browser spans actors, got ${[...allActors].join(",")}`);
  assert.ok(all.json().meta.total >= own.json().meta.total);
});

// ----------------------------------------------------------------- attribution

test("every event names its actor, and a system event says so instead of borrowing an identity", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);

  await instance.store.recordAudit({ actorId: null, action: "platform.boot", entityType: "platform", entityId: null, details: { reason: "startup" } });
  await instance.store.recordAudit({ actorId: 1, action: "governance.kill-switch.released", entityType: "trading_state", entityId: "global", details: {} });

  const response = await instance.app.inject({ method: "GET", url: "/api/v1/admin/audit?limit=200", headers: admin.headers });
  const events = response.json().events;
  const boot = events.find((event) => event.action === "platform.boot");
  const governance = events.find((event) => event.action === "governance.kill-switch.released");

  assert.deepEqual(boot.actor, { userId: null, username: null, kind: "system" });
  assert.deepEqual(governance.actor, { userId: 1, username: "rootadmin", kind: "user" });
  assert.equal(events.every((event) => event.actor && typeof event.actor.kind === "string"), true, "no event is missing its actor");
});

test("a deleted actor resolves to null rather than to a misleading label", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);

  // An event attributed to a user id that no longer resolves. The id is still
  // reported, the name is genuinely gone, and nothing is substituted for it.
  await instance.store.recordAudit({ actorId: 4242, action: "identity.legacy.imported", entityType: "identity", entityId: "4242", details: {} });
  const response = await instance.app.inject({ method: "GET", url: "/api/v1/admin/audit?action=identity.legacy.imported", headers: admin.headers });
  const [event] = response.json().events;
  assert.equal(event.actor.userId, 4242, "the attribution survives the missing user");
  assert.equal(event.actor.username, null, "and the name is null, not a guess");
  assert.equal(event.actor.kind, "user");
});

// -------------------------------------------------------------------- filters

test("filters narrow by action prefix, entity, actor and time window", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);
  const get = async (query) => {
    const response = await instance.app.inject({ method: "GET", url: `/api/v1/admin/audit${query}`, headers: admin.headers });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };

  await instance.store.recordAudit({ actorId: null, action: "marketData.provider.fallback", entityType: "provider", entityId: "binance", details: {}, });
  await instance.store.recordAudit({ actorId: 1, action: "governance.kill-switch.activated", entityType: "trading_state", entityId: "global", details: {} });
  await instance.store.recordAudit({ actorId: 1, action: "notification.read", entityType: "notification", entityId: "9", details: {} });

  // Action prefix: an exact key and its dotted children.
  const governance = await get("?action=governance");
  assert.ok(governance.events.length >= 1);
  assert.equal(governance.events.every((event) => event.action.startsWith("governance")), true);
  assert.equal(governance.meta.filters.action, "governance", "the applied filter is echoed so a screen can show it");

  const exact = await get("?action=notification.read");
  assert.deepEqual(exact.events.map((event) => event.action), ["notification.read"]);

  // Entity.
  const byEntity = await get("?entityType=trading_state&entityId=global");
  assert.ok(byEntity.events.length >= 1);
  assert.equal(byEntity.events.every((event) => event.entityType === "trading_state" && event.entityId === "global"), true);

  // Actor vocabulary: a user id, `system`, and `any`.
  const systemOnly = await get("?actor=system");
  assert.ok(systemOnly.events.length >= 1, "there is at least one actorless event");
  assert.equal(systemOnly.events.every((event) => event.actor.kind === "system"), true);

  const actorOne = await get("?actor=1");
  assert.equal(actorOne.events.every((event) => event.actor.userId === 1), true);
  assert.equal(actorOne.events.some((event) => event.actor.kind === "system"), false);

  const any = await get("?actor=any");
  assert.ok(any.meta.total >= systemOnly.meta.total + actorOne.meta.total, "`any` is the union, not a third category");

  const byActorId = await get("?actor=424242");
  assert.equal(byActorId.meta.total, 0, "an unknown actor is an empty page, not an error");

  // Time window.
  const future = await get(`?from=${new Date(Date.now() + 86_400_000).toISOString()}`);
  assert.equal(future.meta.total, 0, "a window in the future is empty");
  const past = await get(`?from=2000-01-01T00:00:00.000Z&to=${new Date(Date.now() + 60_000).toISOString()}`);
  assert.ok(past.meta.total > 0, "a window covering now has rows");
});

test("an unparseable or inverted time window is a 400, never a silently widened query", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);

  for (const query of ["?from=not-a-date", "?to=yesterday", "?from=12345"]) {
    const response = await instance.app.inject({ method: "GET", url: `/api/v1/admin/audit${query}`, headers: admin.headers });
    assert.equal(response.statusCode, 400, `${query} must be refused, got ${response.statusCode}`);
    assert.equal(response.json().error.code, "INVALID_AUDIT_WINDOW");
  }

  const inverted = await instance.app.inject({
    method: "GET",
    url: "/api/v1/admin/audit?from=2026-10-11T00:00:00.000Z&to=2026-10-01T00:00:00.000Z",
    headers: admin.headers,
  });
  assert.equal(inverted.statusCode, 400);
  assert.equal(inverted.json().error.code, "INVALID_AUDIT_WINDOW");
  assert.match(inverted.json().error.message, /later than/);

  const malformedActor = await instance.app.inject({ method: "GET", url: "/api/v1/admin/audit?actor=rootadmin", headers: admin.headers });
  assert.equal(malformedActor.statusCode, 400, "actor is an id, `system` or `any` — not a username");
});

test("pagination is bounded and its metadata reports the window it actually served", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);
  for (let index = 0; index < 5; index += 1) {
    await instance.store.recordAudit({ actorId: 1, action: `test.event.${index}`, entityType: "test", entityId: String(index), details: {} });
  }

  const page = await instance.app.inject({ method: "GET", url: "/api/v1/admin/audit?limit=2&offset=0&sort=id&direction=desc", headers: admin.headers });
  assert.equal(page.statusCode, 200, page.body);
  assert.equal(page.json().events.length, 2);
  assert.equal(page.json().meta.limit, 2);
  assert.equal(page.json().meta.offset, 0);
  assert.ok(page.json().meta.total >= 5);
  assert.equal(page.json().meta.mutable, false, "every page states that this endpoint cannot alter the trail");

  const second = await instance.app.inject({ method: "GET", url: "/api/v1/admin/audit?limit=2&offset=2&sort=id&direction=desc", headers: admin.headers });
  assert.deepEqual(
    second.json().events.map((event) => event.id),
    page.json().events.map((event) => event.id).concat(second.json().events.map((event) => event.id)).slice(2),
    "pages do not overlap",
  );

  const ascending = await instance.app.inject({ method: "GET", url: "/api/v1/admin/audit?limit=3&sort=id&direction=asc", headers: admin.headers });
  const ids = ascending.json().events.map((event) => Number(event.id));
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "direction is honoured");

  const tooBig = await instance.app.inject({ method: "GET", url: "/api/v1/admin/audit?limit=99999", headers: admin.headers });
  assert.equal(tooBig.statusCode, 400, "the limit is schema-bounded, not clamped silently");
  const badSort = await instance.app.inject({ method: "GET", url: "/api/v1/admin/audit?sort=details", headers: admin.headers });
  assert.equal(badSort.statusCode, 400, "only indexed columns are offered as sorts");
});

// ------------------------------------------------------------ both adapters

test("both adapters answer the audit browser identically for the same filters", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-audit-parity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await createFileStore({ dir, syncWrites: false, logger: { warn() {} } });
  t.after(() => file.close());

  const actor = await file.createUser({ username: "auditor", email: "auditor@example.test", passwordHash: "x", displayName: "Auditor" });
  const seed = [
    { actorId: null, action: "platform.boot", entityType: "platform", entityId: null },
    { actorId: actor.id, action: "governance.kill-switch.activated", entityType: "trading_state", entityId: "global" },
    { actorId: actor.id, action: "governance.kill-switch.released", entityType: "trading_state", entityId: "global" },
    { actorId: actor.id, action: "notification.read", entityType: "notification", entityId: "3" },
  ];
  for (const [index, event] of seed.entries()) {
    await file.recordAudit({ ...event, details: { index }, });
  }

  // A recording executor standing in for MySQL: the file adapter is executed for
  // real, the SQL adapter is asserted on the statements and bound values it would
  // send, which is the same evidence standard the other repository tests use.
  const calls = [];
  const sqlRows = seed.map((event, index) => ({
    id: index + 1,
    actor_user_id: event.actorId,
    action_key: event.action,
    entity_type: event.entityType,
    entity_id: event.entityId,
    detail_json: JSON.stringify({ index }),
    created_at: new Date(Date.parse("2026-10-11T12:00:00.000Z") + index * 1000).toISOString(),
    actor_username: event.actorId === null ? null : "auditor",
  }));
  /**
   * A recording executor that also applies the WHERE clause it was handed, so the
   * comparison below is about *filtering* and not just about projection. Returning
   * every row regardless of the clause would make the two adapters agree trivially
   * and prove nothing.
   */
  function applyRecordedFilters(query, values) {
    let rows = [...sqlRows];
    const bindings = [...values];
    const next = () => bindings.shift();
    if (/e\.actor_user_id IS NULL/.test(query)) rows = rows.filter((row) => row.actor_user_id === null);
    if (/e\.actor_user_id = \?/.test(query)) { const id = Number(next()); rows = rows.filter((row) => Number(row.actor_user_id) === id); }
    if (/action_key LIKE \?/.test(query)) { next(); const term = String(next()).replace(/^%|%$/g, ""); rows = rows.filter((row) => row.action_key.startsWith(term)); }
    if (/e\.entity_type = \?/.test(query)) { const type = next(); rows = rows.filter((row) => row.entity_type === type); }
    if (/e\.entity_id = \?/.test(query)) { const id = next(); rows = rows.filter((row) => String(row.entity_id) === String(id)); }
    if (/e\.created_at >= \?/.test(query)) { const from = Date.parse(next()); rows = rows.filter((row) => Date.parse(row.created_at) >= from); }
    if (/e\.created_at <= \?/.test(query)) { const to = Date.parse(next()); rows = rows.filter((row) => Date.parse(row.created_at) <= to); }
    // Honour the ORDER BY too. A double that returned rows in insertion order
    // would make the two adapters disagree about ordering for a reason that has
    // nothing to do with the code under test — and would hide a real difference.
    const order = /ORDER BY e\.(id|action_key|created_at) (ASC|DESC), e\.id DESC/.exec(query);
    if (order) {
      const [, column, dir] = order;
      const descending = dir === "DESC";
      rows.sort((a, b) => {
        const left = column === "id" ? Number(a.id) - Number(b.id)
          : column === "action_key" ? String(a.action_key).localeCompare(String(b.action_key))
            : String(a.created_at).localeCompare(String(b.created_at));
        if (left !== 0) return descending ? -left : left;
        return descending ? Number(b.id) - Number(a.id) : Number(a.id) - Number(b.id);
      });
    }
    return rows;
  }
  const sql = createAccountRepository({
    async query(query, values = []) {
      calls.push({ kind: "query", query, values });
      if (/^\s*SELECT COUNT/i.test(query)) return [[{ total: applyRecordedFilters(query, values).length }], []];
      return [applyRecordedFilters(query, values), []];
    },
    async execute(query, values = []) { calls.push({ kind: "execute", query, values }); return [[{ total: 0 }], []]; },
  });

  const fileResult = await file.listAuditEvents({ action: "governance", limit: 50 });
  const sqlResult = await sql.listAuditEvents({ action: "governance", limit: 50 });

  assert.equal(fileResult.events.length, 2);
  assert.deepEqual(
    fileResult.events.map((event) => [event.action, event.actor.kind, event.actor.username]),
    sqlResult.events.map((event) => [event.action, event.actor.kind, event.actor.username]),
    "the actor projection agrees across adapters",
  );

  const systemFile = await file.listAuditEvents({ actor: "system" });
  assert.equal(systemFile.events.length, 1);
  assert.equal(systemFile.events[0].action, "platform.boot");
  const systemFileCount = systemFile.events.length;
  await sql.listAuditEvents({ actor: "system" });
  const systemCall = calls.find((entry) => /actor_user_id IS NULL/.test(entry.query) && !/^\s*SELECT COUNT/i.test(entry.query));
  assert.ok(systemCall, "the SQL adapter expressed `system` as IS NULL");
  assert.match(systemCall.query, /actor_user_id IS NULL/, "the SQL adapter expresses `system` as IS NULL, not as a bound value");
  assert.equal(systemCall.values.length, 0, "and binds nothing for it");
  const systemSql = await sql.listAuditEvents({ actor: "system" });
  assert.equal(systemSql.events.length, systemFileCount, "both adapters find the same single actorless event");
  assert.equal(systemSql.total, systemFileCount);

  await sql.listAuditEvents({ actor: String(actor.id), entityType: "trading_state", entityId: "global", from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" });
  const filtered = calls.at(-1);
  assert.match(filtered.query, /e\.actor_user_id = \?/);
  assert.match(filtered.query, /e\.entity_type = \?/);
  assert.match(filtered.query, /e\.entity_id = \?/);
  assert.match(filtered.query, /e\.created_at >= \?/);
  assert.match(filtered.query, /e\.created_at <= \?/);
  assert.equal(filtered.values[0], Number(actor.id));
  assert.ok(filtered.values[3] instanceof Date, "an ISO instant is bound as a Date, not compared as text");
  assert.match(filtered.query, /LEFT JOIN wf_users u ON u\.id = e\.actor_user_id/, "attribution comes from a join, so a deleted user yields null");

  // The own-activity route's call shape must be unchanged: userId only.
  calls.length = 0;
  await sql.listAuditEvents({ userId: actor.id, limit: 50, offset: 0, action: null });
  assert.match(calls.at(-1).query, /e\.actor_user_id = \?/);
  assert.equal(calls.at(-1).query.includes("IS NULL"), false, "userId: null still means 'do not filter', not 'system only'");
});

test("the audit browser reads events that survived a file-store restart", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-audit-replay-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = await createFileStore({ dir, logger: { warn() {} } });
  const user = await first.createUser({ username: "durable", email: "durable@example.test", passwordHash: "x", displayName: "Durable" });
  await first.recordAudit({ actorId: user.id, action: "governance.kill-switch.activated", entityType: "trading_state", entityId: "global", details: { reason: "before restart" } });
  await first.close();

  const second = await createFileStore({ dir, syncWrites: false, logger: { warn() {} } });
  t.after(() => second.close());
  const result = await second.listAuditEvents({ action: "governance", actor: String(user.id) });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].details.reason, "before restart");
  assert.equal(result.events[0].actor.username, "durable", "attribution is re-resolved after replay, not stored as a stale copy");
});
