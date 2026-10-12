/**
 * The lottery HTTP surface (row 15, slice 1): the permission matrix legacy's
 * `Api_lottery` header declares, the ingestion flow end to end over the file
 * adapter, and the honesty of the status surface.
 *
 * The authorization matrix is the point of this file: legacy's own controller
 * comment says status is plain-authenticated, reads need `lottery.view`, and the
 * two writes (provider probe, sync) need POST + `lottery.manage` + session CSRF.
 * The tests below pin each tier from both sides — allowed, and refused with the
 * platform's PERMISSION_DENIED — so the matrix cannot silently flatten.
 */

import bcrypt from "bcryptjs";
import assert from "node:assert/strict";
import test from "node:test";

import { cookieFrom, createFileStoreApp } from "./helpers.js";

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: cookieFrom(response), headers: { cookie: cookieFrom(response), "x-csrf-token": response.json().csrfToken } };
}

/** A signed-in operator who holds `system.authenticated` but NOT `lottery.view`. */
async function addOutsider(store, username = "lotteryoutsider") {
  const user = await store.createUser({
    username,
    email: `${username}@example.test`,
    passwordHash: await bcrypt.hash("Lottery outsider phrase", 4),
    displayName: "Lottery Outsider",
  });
  const role = (await store.listRoles()).find((entry) => entry.role_key === "platform_member");
  const authenticated = await store.ensurePermission("system.authenticated", "Signed in");
  await store.grantRolePermission(role.id, authenticated.id);
  await store.assignRole(user.id, role.id);
  return { ...user, password: "Lottery outsider phrase" };
}

function sandboxApp(t) {
  return createFileStoreApp({ configOverrides: { env: { WINDELS_LOTTERY_SANDBOX: "1" } } });
}

test("the permission matrix is legacy's: status is plain-authenticated, reads need lottery.view, writes need lottery.manage", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());

  // Anonymous: even the status route answers nothing.
  const anonymous = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/status" });
  assert.equal(anonymous.statusCode, 401);

  const outsider = await addOutsider(instance.store);
  const limited = await signIn(instance.app, outsider.username, outsider.password);

  // The one authenticated-only route: an outsider WITH no lottery.view may read it.
  const status = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/status", headers: limited.headers });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().engine, "ACTIVE", "the sandbox IS configured on this host, and the engine state carries no secret — an outsider may see it");

  // Every read: refused without lottery.view.
  for (const url of ["/api/v1/lottery/lotteries", "/api/v1/lottery/rules", "/api/v1/lottery/draws", "/api/v1/lottery/draws/1", "/api/v1/lottery/statistics/numbers", "/api/v1/lottery/providers", "/api/v1/lottery/health", "/api/v1/lottery/jobs"]) {
    const refused = await instance.app.inject({ method: "GET", url, headers: limited.headers });
    assert.equal(refused.statusCode, 403, `${url} must refuse a caller without lottery.view`);
    assert.equal(refused.json().error.code, "PERMISSION_DENIED");
  }
  // And the writes: refused too (a missing permission is 403 even before CSRF matters).
  const write = await instance.app.inject({ method: "POST", url: "/api/v1/lottery/sync", headers: limited.headers, payload: {} });
  assert.equal(write.statusCode, 403);

  // With the permission, the read answers.
  const root = await signIn(instance.app);
  const allowed = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/rules", headers: root.headers });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().rules.code, "EUROMILLIONS");
});

test("a default host: status answers with the honest empty state and the not-ported matrix travels in the response", async (t) => {
  const instance = await createFileStoreApp({}); // no WINDELS_LOTTERY_SANDBOX
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  const status = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/status", headers });
  assert.equal(status.statusCode, 200, status.body);
  const body = status.json();
  assert.equal(body.module, "lottery-intelligence");
  assert.equal(body.engine, "DISABLED_NO_PROVIDER");
  assert.equal(body.provider.state, "UNCONFIGURED");
  assert.equal(body.drawsTracked, 0);
  assert.equal(body.lastDraw, null);
  assert.equal(body.modelVersion, "1.0");
  assert.match(body.disclaimer, /independent random events/);
  assert.deepEqual(body.rules.main, { count: 5, min: 1, max: 50 });
  assert.deepEqual(body.rules.stars, { count: 2, min: 1, max: 12 });

  // The gap is stated, not silent (BC-10): six areas, each named, none re-labelled.
  assert.equal(body.notPorted.length, 6);
  const areas = body.notPorted.map((entry) => entry.area).join(" | ");
  for (const expected of ["combination intelligence", "tickets and checking", "backtests and model versions", "generation persistence", "scheduled jobs", "console screens"]) {
    assert.ok(areas.includes(expected), `the matrix names ${expected}`);
  }
  // The registries read back empty rather than pretending.
  const lotteries = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/lotteries", headers });
  assert.deepEqual(lotteries.json().lotteries, [{ code: "EUROMILLIONS", name: "EuroMillions", enabled: true }], "the game row is ensured by the first status read (LT-4), and it is the only seed");
  const providers = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/providers", headers });
  assert.equal(providers.json().providers.length, 0, "an unavailable provider registers no row");
});

test("the sandbox sync ingests idempotently, and a second sync is all unchanged", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  const first = await instance.app.inject({ method: "POST", url: "/api/v1/lottery/sync", headers, payload: { limit: 10 } });
  assert.equal(first.statusCode, 200, first.body);
  const result = first.json().result;
  assert.equal(result.status, "OK");
  assert.equal(result.imported, 10);
  assert.equal(result.failed, 0);
  assert.equal(result.provider, "sandbox-sim");

  // Idempotent: the second run changes nothing.
  const second = await instance.app.inject({ method: "POST", url: "/api/v1/lottery/sync", headers, payload: { limit: 10 } });
  assert.equal(second.json().result.imported, 0);
  assert.equal(second.json().result.unchanged, 10);

  // The draws read back with their numbers and provenance.
  const draws = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/draws?limit=3", headers });
  assert.equal(draws.statusCode, 200);
  const list = draws.json().draws;
  assert.equal(list.length, 3);
  for (const draw of list) {
    assert.equal(draw.source, "sandbox-simulation");
    assert.equal(draw.verification_status, "VERIFIED");
    assert.equal(draw.payload.main.length, 5);
  }

  // The detail route returns the row plus its number rows.
  const detail = await instance.app.inject({ method: "GET", url: `/api/v1/lottery/draws/${list[0].id}`, headers });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().draw.numbers.length, 7);

  // A missing draw is a 404 that says so.
  const missing = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/draws/999999", headers });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "LOTTERY_DRAW_NOT_FOUND");

  // Every draw import was audited.
  const { events } = await instance.store.listAuditEvents({ limit: 200 });
  const imported = events.filter((event) => event.action === "lottery.draw.imported");
  assert.equal(imported.length, 10);
  // And the sync itself, as the administrator action it is.
  assert.ok(events.some((event) => event.action === "lottery.admin.sync"));

  // The sync run left its evidence.
  const jobs = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/jobs", headers });
  assert.equal(jobs.json().jobs.length, 0, "the admin sync does not claim a job-run row; the cron does (slice 3)");
});

test("statistics over stored draws carry the disclaimer, and an unknown kind is a 400 that names the kinds", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);
  await instance.app.inject({ method: "POST", url: "/api/v1/lottery/sync", headers, payload: { limit: 14 } });

  for (const kind of ["numbers", "stars", "hot-cold", "distribution", "pairs", "triplets", "star-pairs"]) {
    const response = await instance.app.inject({ method: "GET", url: `/api/v1/lottery/statistics/${kind}`, headers });
    assert.equal(response.statusCode, 200, kind);
    assert.equal(response.json().data.disclaimer.includes("independent random events"), true, `${kind} carries the DISCLAIMER`);
  }
  // The window parameter flows through.
  const windowed = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/statistics/numbers?window=5", headers });
  assert.equal(windowed.json().window, 5);
  assert.equal(windowed.json().kind, "numbers");

  const unknown = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/statistics/tea-leaves", headers });
  assert.equal(unknown.statusCode, 400, "a kind that does not exist is refused, not answered with an empty object");
});

test("the provider probe is explicit, persisted, audited, and honest about a sandbox source", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  const probe = await instance.app.inject({ method: "POST", url: "/api/v1/lottery/providers/check", headers, payload: {} });
  assert.equal(probe.statusCode, 200, probe.body);
  const body = probe.json();
  assert.equal(body.provider, "sandbox-sim");
  assert.equal(body.live.state, "ONLINE");
  assert.equal(body.live.synthetic, true);
  assert.equal(body.persisted, true);
  assert.equal(body.latest.status, "ONLINE");
  assert.equal(body.history.length, 1);

  // The registry row was created disabled: probing is not enabling.
  const providers = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/providers", headers });
  assert.equal(providers.json().providers[0].enabled, 0);

  // Audited, with the actor.
  const { events } = await instance.store.listAuditEvents({ limit: 50, action: "lottery.provider.health.probed" });
  assert.equal(events.length, 1);
  assert.equal(events[0].actor.userId, 1);

  // A second probe appends history rather than overwriting it.
  await instance.app.inject({ method: "POST", url: "/api/v1/lottery/providers/check", headers, payload: {} });
  const health = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/health", headers });
  assert.equal(health.json().history.length, 2);
  assert.equal(health.json().latest.status, "ONLINE");
});
