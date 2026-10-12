/**
 * Sports Intelligence HTTP surface (row 14, slice 1).
 *
 * Three things this file exists to prove:
 *
 *  1. **The one route is a read, and it is gated on `sports.view`.** Unlike the
 *     broker port this is not a finding being fixed: `Api_sports` is the
 *     best-gated controller in the legacy application, requiring `sports.view` for
 *     every read and `sports.manage` / `sports.approve` / `sports.settle` for its
 *     writes. The gate is reproduced because legacy had it, and the contrast with
 *     `Api_system` (**F-32**) is recorded in the phase doc — the same codebase got
 *     one module's authorization right and another's wrong.
 *  2. **Legacy's twenty-odd sports endpoints are absent, and the inventory says so.**
 *     Every one of them reads or writes the eleven tables this slice does not
 *     create. A `GET /api/v1/sports/matches` that answered from a live provider
 *     call would return a different thing under a familiar name, so it does not
 *     exist rather than existing approximately.
 *  3. **A default host configures no provider, performs no outbound I/O, and leaks
 *     no configuration.** The public status surface reports the module from
 *     configuration alone.
 */

import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { test } from "node:test";

import { cookieFrom, createFileStoreApp } from "./helpers.js";

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  const cookie = cookieFrom(response);
  return { cookie, headers: { cookie, "x-csrf-token": body.csrfToken } };
}

/** A signed-in operator who does NOT hold `sports.view`. */
async function addMemberWithoutSportsPermission(store, username = "sportsoutsider") {
  const user = await store.createUser({
    username,
    email: `${username}@example.test`,
    passwordHash: await bcrypt.hash("Sports outsider phrase", 4),
    displayName: "Sports Outsider",
  });
  const role = (await store.listRoles()).find((entry) => entry.role_key === "platform_member");
  const authenticated = await store.ensurePermission("system.authenticated", "Signed in");
  await store.grantRolePermission(role.id, authenticated.id);
  await store.assignRole(user.id, role.id);
  return user;
}

test("the sports status route requires a session and then requires sports.view", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());

  const anonymous = await instance.app.inject({ method: "GET", url: "/api/v1/sports/status" });
  assert.equal(anonymous.statusCode, 401, "an anonymous caller gets nothing");

  const outsider = await addMemberWithoutSportsPermission(instance.store);
  const limited = await signIn(instance.app, outsider.username, "Sports outsider phrase");
  const forbidden = await instance.app.inject({ method: "GET", url: "/api/v1/sports/status", headers: limited.headers });
  assert.equal(forbidden.statusCode, 403, "a signed-in user without sports.view is refused");
  assert.equal(forbidden.json().error.code, "PERMISSION_DENIED");

  const root = await signIn(instance.app);
  const allowed = await instance.app.inject({ method: "GET", url: "/api/v1/sports/status", headers: root.headers });
  assert.equal(allowed.statusCode, 200, allowed.body);
});

test("a default host configures no provider, fabricates nothing, and lists what is not ported", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  const response = await instance.app.inject({ method: "GET", url: "/api/v1/sports/status", headers });
  assert.equal(response.statusCode, 200);
  const body = response.json();

  assert.equal(body.module, "WINDELS Sports Intelligence");
  assert.equal(body.enabled, false);
  assert.equal(body.mode, "SANDBOX", "the documented default");
  assert.equal(body.isDemoData, true);
  assert.equal(body.providersConfigured, false, "a default host registers no provider at all");
  assert.deepEqual(body.providers, []);
  assert.equal(body.probed, false, "SP-10: the default reading performs no outbound I/O");
  assert.equal(body.liveHealth, null);
  assert.equal(body.ticketEngine, "NOT_PORTED", "not DISABLED — there is no engine to disable");
  assert.equal(body.message, "No sports provider is configured. No fixtures, odds, predictions, or tickets are fabricated.");
  assert.match(body.notice, /nothing is fabricated/i);

  // The honesty matrix travels in the response because no ported module has a
  // console screen (F-29) — the same decision as BC-10 in the broker port.
  assert.ok(body.notPorted.length >= 10);
  for (const entry of body.notPorted) {
    assert.ok(entry.area && entry.legacy && entry.state && entry.detail, JSON.stringify(entry));
    assert.notEqual(entry.state, "ported");
  }
  assert.match(JSON.stringify(body.notPorted), /SPORTS_MODEL_DRIFT/, "NV-6's last type is named where an operator can see it");
});

test("the route inventory has exactly one sports route and no write route", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());

  const response = await instance.app.inject({ method: "GET", url: "/api/v1/system/routes" });
  assert.equal(response.statusCode, 200);
  const inventory = response.json().routes;
  assert.ok(inventory.length >= 80, "non-vacuity: the inventory really is populated");

  const sports = inventory.filter((route) => route.path.includes("/sports"));
  assert.deepEqual(sports.map((route) => `${route.method} ${route.path}`), ["GET /api/v1/sports/status"]);
  assert.equal(sports[0].permission, "sports.view");

  // Every legacy sports endpoint that would need a table this slice does not create
  // is absent. Asserted as an absence rather than as a count, because a count would
  // also pass if the route were renamed.
  for (const forbidden of ["matches", "odds", "predictions", "tickets", "daily", "results", "providers", "models", "calibration", "backtest", "configuration", "sync", "settle", "verify"]) {
    const found = inventory.filter((route) => route.path.includes("/sports") && route.path.toLowerCase().includes(forbidden));
    assert.deepEqual(found.map((route) => route.path), [], `no /sports/${forbidden} route may exist in this slice`);
  }
  // And no sports route of any method other than GET.
  assert.deepEqual(inventory.filter((route) => route.path.includes("/sports") && route.method !== "GET"), []);
});

test("the public status surface reports sports from configuration and contacts no provider", async (t) => {
  // The sandbox provider performs no I/O by construction, so the observable proof
  // that this surface does not probe is that it reports no derived health at all:
  // a probe would have produced one.
  const instance = await createFileStoreApp({
    configOverrides: { env: { WINDELS_SPORTS_ENABLED: "1", WINDELS_SPORTS_MODE: "SANDBOX", WINDELS_SPORTS_SANDBOX: "1" } },
  });
  t.after(() => instance.cleanup());

  const response = await instance.app.inject({ method: "GET", url: "/api/v1/system/status" });
  assert.equal(response.statusCode, 200, "this surface is unauthenticated");
  const body = response.json();

  assert.ok(body.sports, "the module is reported alongside market data, analysis and notifications");
  assert.equal(body.sports.enabled, true);
  assert.equal(body.sports.mode, "SANDBOX");
  assert.equal(body.sports.isDemoData, true);
  assert.equal(body.sports.providersConfigured, true);
  assert.deepEqual(body.sports.providerIds, ["sandbox-sim"]);
  assert.equal(body.sports.simulatedProviders, 1);
  assert.equal(body.sports.persistence, false, "stated as a fact about this slice");
  assert.equal(body.sports.ticketEngine, "NOT_PORTED");
  assert.equal(body.sports.liveHealth, undefined, "no probe, no live health");
  assert.equal(body.sports.derivedStatus, undefined, "nothing has been witnessed, so nothing is derived");
  assert.match(body.sports.reason, /GET \/api\/v1\/sports\/status/);

  // The module ledger row moved, and its label carries the gap rather than the
  // achievement — "sports: partial" must not read as "half a betting engine".
  const sports = body.modules.find((module) => module.key === "sports");
  assert.equal(sports.state, "partial");
  assert.match(sports.label, /no persistence/i);
  assert.equal(body.modules.length, 17);
});

test("a configured sandbox provider is reported as simulated, unverified and UNKNOWN", async (t) => {
  const instance = await createFileStoreApp({
    configOverrides: { env: { WINDELS_SPORTS_MODE: "SANDBOX", WINDELS_SPORTS_SANDBOX: "1" } },
  });
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  const response = await instance.app.inject({ method: "GET", url: "/api/v1/sports/status", headers });
  const body = response.json();
  assert.equal(body.providersConfigured, true);
  assert.equal(body.providers.length, 1);
  const [provider] = body.providers;
  assert.equal(provider.id, "sandbox-sim");
  assert.equal(provider.kind, "sandbox");
  assert.equal(provider.simulated, true, "the provider itself is a simulation, before any record exists");
  assert.equal(provider.verifiedAgainstProvider, false);
  // UNKNOWN is the monitor's defined answer when it has witnessed nothing — not a
  // placeholder, and not OFFLINE, which would imply a failure nobody observed.
  assert.equal(provider.derivedStatus, "UNKNOWN");
  assert.equal(provider.detail, "no observations yet");
  assert.equal(provider.reliability, 0);
  assert.match(body.message, /Nothing is persisted yet/);
});

test("probe=1 takes a live reading and stamps it as not persisted", async (t) => {
  const instance = await createFileStoreApp({
    configOverrides: { env: { WINDELS_SPORTS_MODE: "SANDBOX", WINDELS_SPORTS_SANDBOX: "1" } },
  });
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  for (const value of ["1", "true", "yes", "YES", "True"]) {
    const response = await instance.app.inject({ method: "GET", url: `/api/v1/sports/status?probe=${value}`, headers });
    const body = response.json();
    assert.equal(body.probed, true, `probe=${value}`);
    assert.equal(body.persisted, false, "a reading with no history behind it must not look like an observation");
    assert.equal(body.liveHealth["sandbox-sim"].status, "ONLINE");
    assert.equal(body.liveHealth["sandbox-sim"].reliability, 0.9);
  }

  // The explicit off spellings take the cheap reading, and so does omitting the flag.
  // `?probe=` with an empty value is the one loose case: the validator treats an
  // empty query value as absent, so the schema default applies and the reading is
  // cheap. Asserted rather than left to chance, because "an empty flag means off" is
  // a behaviour a reader would otherwise have to discover by experiment.
  for (const url of ["/api/v1/sports/status", "/api/v1/sports/status?probe=", "/api/v1/sports/status?probe=0", "/api/v1/sports/status?probe=false", "/api/v1/sports/status?probe=no"]) {
    const response = await instance.app.inject({ method: "GET", url, headers });
    const body = response.json();
    assert.equal(body.probed, false, url);
    assert.equal(body.liveHealth, null, url);
  }

  // An unrecognized value is a 400, not a silent "off" — the same choice AV-3 made
  // for an over-large `limit`. A flag that is quietly ignored is indistinguishable
  // from a flag that was never sent, and the caller believes they asked for a probe.
  // Coercion is case-insensitive, so the refusals here are genuinely unparseable
  // values rather than unfamiliar spellings of a real one.
  for (const value of ["maybe", "2", "yess", "FALSE!"]) {
    const response = await instance.app.inject({ method: "GET", url: `/api/v1/sports/status?probe=${value}`, headers });
    assert.equal(response.statusCode, 400, `probe=${value} should be refused, got ${response.statusCode}`);
    const error = response.json().error;
    assert.equal(error.code, "INVALID_REQUEST");
    assert.deepEqual(error.details.map((entry) => entry.field), ["probe"]);
    assert.match(error.details[0].message, /must be true or false/);
  }
});

test("a configured HTTP provider is described without revealing its URL or token", async (t) => {
  const instance = await createFileStoreApp({
    configOverrides: {
      env: {
        WINDELS_SPORTS_HTTP_ID: "vendor-one",
        WINDELS_SPORTS_HTTP_BASE_URL: "https://feed.example.invalid/v1",
        WINDELS_SPORTS_HTTP_TOKEN: "super-secret-feed-token",
      },
    },
  });
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  const response = await instance.app.inject({ method: "GET", url: "/api/v1/sports/status", headers });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.providersConfigured, true);
  assert.deepEqual(body.providers.map((entry) => entry.id), ["vendor-one"]);
  assert.equal(body.providers[0].kind, "http");
  assert.equal(body.providers[0].simulated, false);
  assert.equal(body.providers[0].verifiedAgainstProvider, false, "no adapter here has ever spoken to its provider");
  assert.equal(body.providers[0].derivedStatus, "UNKNOWN", "configured is not the same as observed");

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("super-secret-feed-token"), false, "the token must not appear");
  assert.equal(serialized.includes("feed.example.invalid"), false, "nor the host — configuration is not a status field");
  assert.equal(serialized.includes("Bearer"), false);

  // A probe is refused by the host being unreachable, not by this code, and the
  // refusal must classify rather than leak.
  const probed = await instance.app.inject({ method: "GET", url: "/api/v1/sports/status?probe=1", headers });
  const probedBody = probed.json();
  assert.equal(probedBody.probed, true);
  const live = probedBody.liveHealth["vendor-one"];
  assert.equal(live.status, "OFFLINE", "an unreachable vendor is OFFLINE, not DATA_ERROR and not ONLINE");
  assert.equal(JSON.stringify(live).includes("super-secret-feed-token"), false);
});

test("the sports config gate refuses an unusable feed configuration at boot", async () => {
  const refusals = [
    [{ WINDELS_SPORTS_HTTP_BASE_URL: "not-a-url" }, /must be an absolute URL/],
    [{ WINDELS_SPORTS_HTTP_BASE_URL: "https://user:pw@feed.example.invalid" }, /must not contain credentials/],
    [{ WINDELS_SPORTS_HTTP_BASE_URL: "https://feed.example.invalid/v1?key=1" }, /must not contain a query string/],
    [{ WINDELS_SPORTS_HTTP_TIMEOUT: "0" }, /must be an integer between 1 and 120/],
    [{ WINDELS_SPORTS_HTTP_TIMEOUT: "9999" }, /must be an integer between 1 and 120/],
    [{ WINDELS_SPORTS_ENABLED: "perhaps" }, /WINDELS_SPORTS_ENABLED/],
  ];
  for (const [env, pattern] of refusals) {
    await assert.rejects(() => createFileStoreApp({ configOverrides: { env } }), pattern, JSON.stringify(env));
  }

  // A base URL keeps its path prefix — the difference from the broker bridge URLs,
  // which are reduced to their origin. A vendor hosted under /v1 would otherwise
  // 404 against a path that looks correct in the configuration (divergence SP-9).
  const instance = await createFileStoreApp({
    configOverrides: { env: { WINDELS_SPORTS_HTTP_BASE_URL: "https://feed.example.invalid/v1/" } },
  });
  try {
    const { headers } = await signIn(instance.app);
    const response = await instance.app.inject({ method: "GET", url: "/api/v1/sports/status?probe=1", headers });
    assert.equal(response.json().providersConfigured, true);
  } finally {
    await instance.cleanup();
  }
});
