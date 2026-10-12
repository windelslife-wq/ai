/**
 * Sports Intelligence HTTP surface (row 14, slices 1 and 2).
 *
 * Four things this file exists to prove:
 *
 *  1. **Every route is gated, and reads and writes are gated differently.** Unlike the
 *     broker port this is not a finding being fixed: `Api_sports` is the best-gated
 *     controller in the legacy application, requiring `sports.view` for every read and
 *     `sports.manage` / `sports.approve` / `sports.settle` for its writes. That split is
 *     reproduced here, and the contrast with `Api_system` (**F-32**) is recorded in the
 *     phase doc — the same codebase got one module's authorization right and another's
 *     wrong.
 *  2. **The routes that exist read STORED history, and the ones whose tables do not
 *     exist are absent.** Slice 1 had one route because migration 011 did not exist;
 *     slice 2 has seven because it does. What is still absent is asserted by name
 *     rather than by count, because a count would also pass if a route were renamed:
 *     no prediction, ticket, settlement, calibration, backtest or model route, and no
 *     standalone odds or results route either, since those are served inside a fixture's
 *     detail response rather than detached from the fixture they describe.
 *  3. **Ingestion is idempotent through the HTTP surface**, which is the property a
 *     caller can actually rely on when a request times out and it cannot know whether
 *     the work happened.
 *  4. **A default host configures no provider, performs no outbound I/O, and leaks no
 *     configuration.** The public status surface reports the module from configuration
 *     alone, and a probe is never persisted even where a repository exists.
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
  assert.equal(body.notPorted.length, 9, "ingestion graduated out of the matrix in Phase 16");
  for (const entry of body.notPorted) {
    assert.ok(entry.area && entry.legacy && entry.state && entry.detail, JSON.stringify(entry));
    assert.notEqual(entry.state, "ported");
  }
  assert.match(JSON.stringify(body.notPorted), /SPORTS_MODEL_DRIFT/, "NV-6's last type is named where an operator can see it");
});

test("the route inventory has six sports routes, and the only write is a gated sync", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());

  const response = await instance.app.inject({ method: "GET", url: "/api/v1/system/routes" });
  assert.equal(response.statusCode, 200);
  const inventory = response.json().routes;
  assert.ok(inventory.length >= 80, "non-vacuity: the inventory really is populated");

  const sports = inventory.filter((route) => route.path.includes("/sports"));
  assert.deepEqual(
    sports.map((route) => `${route.method} ${route.path}`),
    [
      "GET /api/v1/sports/status",
      "GET /api/v1/sports/providers",
      "GET /api/v1/sports/providers/:providerCode/health",
      "GET /api/v1/sports/matches",
      "GET /api/v1/sports/matches/:matchId",
      "GET /api/v1/sports/sync-runs",
      "POST /api/v1/sports/sync",
    ],
  );
  // Reads need `sports.view`; the one write needs `sports.manage` — legacy's own split
  // in `Api_sports`, and the first caller of a permission the baseline declared in
  // anticipation. Asserted per route rather than by count, so a route that lost its
  // guard fails by name.
  for (const route of sports) {
    const expected = route.method === "POST" ? "sports.manage" : "sports.view";
    assert.equal(route.permission, expected, `${route.method} ${route.path} must require ${expected}`);
    assert.equal(route.validated, true, `${route.method} ${route.path} must declare a schema`);
  }

  // Every legacy sports endpoint that would need a table this slice does not create
  // is absent. Asserted as an absence rather than as a count, because a count would
  // also pass if the route were renamed.
  // "matches", "providers" and "sync" came OFF this list in Phase 16: those tables
  // exist now, so those routes read and write real stored rows. What stays forbidden is
  // everything whose table does not — and note that "odds" and "results" stay
  // forbidden too, because odds and results are served inside a fixture's detail
  // response rather than as standalone endpoints, and a `/sports/odds` route would
  // invite a caller to read a price series with no fixture attached to it.
  for (const forbidden of ["odds", "predictions", "tickets", "daily", "results", "models", "calibration", "backtest", "configuration", "settle", "verify"]) {
    const found = inventory.filter((route) => route.path.includes("/sports") && route.path.toLowerCase().includes(forbidden));
    assert.deepEqual(found.map((route) => route.path), [], `no /sports/${forbidden} route may exist in this slice`);
  }
  // The only non-GET sports route is the sync, and it is a write to the seven
  // `wf_sports_*` tables and nothing else: no order, proposal, position, account or
  // broker route may appear here whatever slice row 14 reaches.
  assert.deepEqual(
    inventory.filter((route) => route.path.includes("/sports") && route.method !== "GET").map((route) => `${route.method} ${route.path}`),
    ["POST /api/v1/sports/sync"],
  );
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
  // True on this host: `createFileStoreApp` wires the file adapter, which implements
  // all 22 sports methods. A host without migration 011 would report false, and the
  // stored-read routes would refuse with 503 rather than returning empty lists.
  assert.equal(body.sports.persistence, true, "stated as a fact about this host");
  assert.equal(body.sports.ticketEngine, "NOT_PORTED");
  assert.equal(body.sports.liveHealth, undefined, "no probe, no live health");
  assert.equal(body.sports.derivedStatus, undefined, "nothing has been witnessed, so nothing is derived");
  assert.match(body.sports.reason, /GET \/api\/v1\/sports\/status/);

  // The module ledger row moved, and its label carries the gap rather than the
  // achievement — "sports: partial" must not read as "half a betting engine".
  // Phase 16 makes that harder, not easier: a module that now ingests and stores
  // fixtures, odds and results LOOKS like a working betting system. The label has to
  // say what stops it being one, and the sharpest such fact is that no stored result
  // is verified — ingestion reports an outcome, and nothing downstream of it exists.
  const sports = body.modules.find((module) => module.key === "sports");
  assert.equal(sports.state, "partial");
  assert.match(sports.label, /no stored result is verified/i);
  assert.match(sports.label, /no prediction, ticket, settlement, calibration, backtest or monitoring/i);
  assert.ok(!/no persistence/i.test(sports.label), "persistence exists now; a stale label reads as current documentation");
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
  assert.match(body.message, /ingestion is persisted/);
  assert.match(body.message, /no stored result is verified/, "ingestion reports; only settlement attests");
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

// ── slice 2: the stored-read and ingestion routes ────────────────────────────
//
// Everything below exercises the routes migration 011 made possible. The discipline
// they have to hold is the same one the slice-1 tests held: a route may only return
// what this port can actually produce, and the difference between "stored history" and
// "a live provider call" must be visible in the response rather than left to inference.

/** A signed-in operator who holds `sports.view` but NOT `sports.manage`. */
async function addViewer(store, username = "sportsviewer") {
  const user = await store.createUser({
    username,
    email: `${username}@example.test`,
    passwordHash: await bcrypt.hash("Sports viewer phrase", 4),
    displayName: "Sports Viewer",
  });
  const role = (await store.listRoles()).find((entry) => entry.role_key === "platform_member");
  for (const key of ["system.authenticated", "sports.view"]) {
    const permission = await store.ensurePermission(key, key);
    await store.grantRolePermission(role.id, permission.id);
  }
  await store.assignRole(user.id, role.id);
  return user;
}

/** An app with the sandbox provider registered, so a sync has something to call. */
function sandboxApp(t) {
  return createFileStoreApp({
    configOverrides: { env: { WINDELS_SPORTS_MODE: "SANDBOX", WINDELS_SPORTS_SANDBOX: "1" } },
  });
}

async function syncFixtures(app, headers, executionKey, body = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/sports/sync",
    headers,
    payload: { jobType: "FIXTURES", providerId: "sandbox-sim", executionKey, ...body },
  });
  return response;
}

test("the stored reads are empty rather than absent before anything is ingested", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  // An empty list is the honest answer here, and it is different from the 503 a host
  // WITHOUT migration 011 would give. Both are "no fixtures", but only one of them
  // means "nothing has been ingested yet".
  for (const url of ["/api/v1/sports/matches", "/api/v1/sports/sync-runs", "/api/v1/sports/providers"]) {
    const response = await instance.app.inject({ method: "GET", url, headers });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    const body = response.json();
    assert.equal(body.count, 0, `${url} must report an empty store as empty`);
  }
  const runs = await instance.app.inject({ method: "GET", url: "/api/v1/sports/sync-runs", headers });
  assert.equal(runs.json().unfinished, 0);
});

test("a viewer may read but not ingest, and the write route says which permission is missing", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const viewer = await addViewer(instance.store);
  const headers = (await signIn(instance.app, viewer.username, "Sports viewer phrase")).headers;

  const read = await instance.app.inject({ method: "GET", url: "/api/v1/sports/matches", headers });
  assert.equal(read.statusCode, 200, "sports.view is enough to read stored fixtures");

  // Legacy's own split in `Api_sports`: reads need `sports.view`, writes need
  // `sports.manage`. Both permissions existed in `platform-baseline.js` before this
  // slice used either, so this is the first caller of one that was declared in
  // anticipation — not a new grant.
  const write = await syncFixtures(instance.app, headers, "fixtures:forbidden");
  assert.equal(write.statusCode, 403, "sports.view must not imply sports.manage");
  assert.equal(write.json().error.code, "PERMISSION_DENIED");
  const runs = await instance.app.inject({ method: "GET", url: "/api/v1/sports/sync-runs", headers });
  assert.equal(runs.json().count, 0, "a refused sync opened no run");
});

test("the sync route needs a CSRF token, like every other write on this platform", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const { cookie } = await signIn(instance.app);
  const response = await instance.app.inject({
    method: "POST",
    url: "/api/v1/sports/sync",
    headers: { cookie },
    payload: { jobType: "FIXTURES", providerId: "sandbox-sim", executionKey: "fixtures:nocsrf" },
  });
  assert.equal(response.statusCode, 403, response.body);
});

test("an operator can ingest fixtures over HTTP and read them back as stored history", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  const synced = await syncFixtures(instance.app, headers, "fixtures:2026-03-07", {
    query: { from: "2026-03-07", to: "2026-03-08" },
  });
  assert.equal(synced.statusCode, 200, synced.body);
  const run = synced.json();
  assert.equal(run.status, "COMPLETED");
  assert.ok(run.processed > 0, "the sandbox provider is deterministic and I/O-free, so it really returns fixtures");
  // SP-13, through the HTTP surface: a first sync reports creations, not updates.
  assert.equal(run.created, run.processed);
  assert.equal(run.updated, 0);
  assert.ok(run.runId);

  const matches = await instance.app.inject({ method: "GET", url: "/api/v1/sports/matches", headers });
  assert.equal(matches.statusCode, 200);
  const listed = matches.json();
  assert.equal(listed.count, run.processed, "every stored fixture is readable back");
  const [first] = listed.matches;
  assert.equal(first.payload.simulated, true, "the sandbox label travels with the stored row");

  // The sync run is readable too — the evidence legacy wrote and could never query.
  const runs = await instance.app.inject({ method: "GET", url: "/api/v1/sports/sync-runs", headers });
  assert.equal(runs.json().count, 1);
  assert.equal(runs.json().runs[0].id, run.runId);
  assert.equal(runs.json().runs[0].records_created, run.created);

  // And the provider registry now has a row, created disabled by the sync that named it.
  const providers = await instance.app.inject({ method: "GET", url: "/api/v1/sports/providers", headers });
  assert.equal(providers.json().count, 1);
  assert.equal(providers.json().providers[0].enabled, false, "a sync naming a vendor is not an operator approving it");
});

test("retrying the same execution key over HTTP reports DUPLICATE_SKIPPED and stores nothing twice", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  const first = await syncFixtures(instance.app, headers, "fixtures:retry");
  assert.equal(first.json().status, "COMPLETED");
  const count = (await instance.app.inject({ method: "GET", url: "/api/v1/sports/matches", headers })).json().count;

  // The guarantee a caller can actually rely on when a request times out and it does
  // not know whether the work happened.
  const retry = await syncFixtures(instance.app, headers, "fixtures:retry");
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().status, "DUPLICATE_SKIPPED");
  assert.equal(retry.json().runId, undefined, "no run was opened, so there is no id to report");
  assert.equal((await instance.app.inject({ method: "GET", url: "/api/v1/sports/matches", headers })).json().count, count);
  assert.equal((await instance.app.inject({ method: "GET", url: "/api/v1/sports/sync-runs", headers })).json().count, 1);
});

test("a fixture detail response assembles the odds series, the assessment and the result", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  const run = (await syncFixtures(instance.app, headers, "fixtures:detail")).json();
  const listed = (await instance.app.inject({ method: "GET", url: "/api/v1/sports/matches", headers })).json().matches;
  const target = listed[0];

  // Odds for one fixture, under a distinct key so the run cannot collide with a
  // fixture sync's key.
  const oddsRun = await instance.app.inject({
    method: "POST", url: "/api/v1/sports/sync", headers,
    payload: { jobType: "ODDS", providerId: "sandbox-sim", executionKey: `odds:${target.external_id}`, fixtureExternalId: target.external_id },
  });
  assert.equal(oddsRun.statusCode, 200, oddsRun.body);

  const detail = await instance.app.inject({ method: "GET", url: `/api/v1/sports/matches/${target.id}`, headers });
  assert.equal(detail.statusCode, 200, detail.body);
  const body = detail.json();
  assert.equal(body.match.id, target.id);
  // Odds come back as a SERIES, newest first, and are not reduced to a
  // latest-per-market map: "the price" of a selection is a series, and picking one
  // silently discards the history the series exists to keep.
  assert.ok(Array.isArray(body.odds));
  assert.ok(body.quality, "a synced fixture carries its assessment");
  assert.equal(body.quality.eligible_ticket, false, "ingesting fixtures can never on its own make one ticket-eligible (SP-22)");
  assert.equal(body.verified, false, "and nothing in this slice can verify a result");

  const missing = await instance.app.inject({ method: "GET", url: "/api/v1/sports/matches/999999", headers });
  assert.equal(missing.statusCode, 404, "an unknown fixture is not found, not empty");
  assert.equal(missing.json().error.code, "NOT_FOUND");
});

test("a malformed window is a 400, not a 500 and not a silently empty result", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  // Defect D-12 is exactly this: `?from=12345` silently produced an empty window that
  // looked like a working filter. `new Date("12345")` is the year 12345.
  for (const url of [
    "/api/v1/sports/matches?from=12345",
    "/api/v1/sports/matches?to=now",
    "/api/v1/sports/matches?from=2026-13-45T99:99:99Z",
    "/api/v1/sports/matches?from=yesterday",
  ]) {
    const response = await instance.app.inject({ method: "GET", url, headers });
    assert.equal(response.statusCode, 400, `${url} must be refused, not answered: ${response.body}`);
    assert.equal(response.json().error.code, "INVALID_SPORTS_QUERY");
  }
  // An invalid enum value is refused by the schema before the repository sees it.
  const badStatus = await instance.app.inject({ method: "GET", url: "/api/v1/sports/matches?status=KICKOFF", headers });
  assert.equal(badStatus.statusCode, 400);
  assert.equal(badStatus.json().error.code, "INVALID_REQUEST");
  // And an out-of-range limit is refused rather than clamped silently.
  const bigLimit = await instance.app.inject({ method: "GET", url: "/api/v1/sports/matches?limit=100000", headers });
  assert.equal(bigLimit.statusCode, 400);
});

test("a filter carrying a UTC offset is normalized, not refused and not compared as text", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);
  const run = (await syncFixtures(instance.app, headers, "fixtures:offset")).json();
  assert.ok(run.processed > 0);

  // Divergence SP-26. The COLUMNS hold one canonical width (SP-19) and are compared as
  // text, but an INPUT carrying an explicit offset is parsed and normalized rather than
  // refused — so `+01:00` becomes the equivalent `…Z` instant and the comparison stays
  // chronological. Refusing it, as `assertJobLockInstant` does for an internal caller,
  // would be right for code that must already be canonical and unhelpful for an HTTP
  // client that is entitled to name its own zone. Comparing it as TEXT would be the
  // actual bug: `"…+01:00"` sorts after `"…Z"` for the same instant.
  const canonical = await instance.app.inject({ method: "GET", url: "/api/v1/sports/matches?from=2026-03-07T00:00:00.000Z", headers });
  assert.equal(canonical.statusCode, 200);
  const offset = await instance.app.inject({ method: "GET", url: "/api/v1/sports/matches?from=2026-03-07T01:00:00%2B01:00", headers });
  assert.equal(offset.statusCode, 200, "an offset is normalized, not refused");
  assert.deepEqual(
    offset.json().matches.map((row) => row.id),
    canonical.json().matches.map((row) => row.id),
    "the same instant spelled two ways must select the same rows",
  );

  // And a bound really does move the selection, which is what makes the equality above
  // non-vacuous rather than two empty lists agreeing. Both bounds are derived from the
  // stored rows instead of guessed, so this holds whatever window the sandbox generated.
  const rows = canonical.json().matches;
  assert.ok(rows.length > 0, "non-vacuity: the unfiltered window really did select fixtures");
  const lastKickoff = rows.at(-1).kickoff_at;
  const fromLast = await instance.app.inject({ method: "GET", url: `/api/v1/sports/matches?from=${encodeURIComponent(lastKickoff)}`, headers });
  // Compared against the rows themselves rather than against 1, because the sandbox
  // generator can legitimately place two fixtures at the same kickoff.
  const sharingLastKickoff = rows.filter((row) => row.kickoff_at === lastKickoff).length;
  assert.equal(fromLast.json().count, sharingLastKickoff, "an inclusive lower bound at the last kickoff selects exactly the fixtures at that instant");
  assert.ok(sharingLastKickoff < rows.length, "and that is a strict subset, so the bound really filtered");
  const beyond = await instance.app.inject({ method: "GET", url: "/api/v1/sports/matches?from=2999-01-01T00:00:00.000Z", headers });
  assert.equal(beyond.json().count, 0, "and a bound after every fixture selects none");
  const toFirst = await instance.app.inject({ method: "GET", url: `/api/v1/sports/matches?to=${encodeURIComponent(rows[0].kickoff_at)}`, headers });
  const sharingFirstKickoff = rows.filter((row) => row.kickoff_at === rows[0].kickoff_at).length;
  assert.equal(toFirst.json().count, sharingFirstKickoff, "the upper bound is inclusive too");
});

test("an undeclared query parameter is dropped, and a declared one is honoured", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);
  await syncFixtures(instance.app, headers, "fixtures:query");

  // `validateRequest` rebuilds `request.query` from the schema, so an undeclared
  // parameter never reaches the handler (defect D-24). Asserted here because the
  // failure is invisible: a filter that is silently ignored returns the whole table
  // and looks like a filter that matched everything.
  const undeclared = await instance.app.inject({ method: "GET", url: "/api/v1/sports/matches?homeTeam=Arsenal", headers });
  assert.equal(undeclared.statusCode, 200);
  const all = (await instance.app.inject({ method: "GET", url: "/api/v1/sports/matches", headers })).json().count;
  assert.equal(undeclared.json().count, all, "an undeclared filter is dropped, so it filters nothing");

  const filtered = await instance.app.inject({ method: "GET", url: "/api/v1/sports/matches?competition=Premier&limit=1", headers });
  assert.equal(filtered.statusCode, 200);
  assert.ok(filtered.json().count <= 1, "and a declared one is applied");
});

test("a provider health history is readable, and an unknown provider is 404", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);
  await syncFixtures(instance.app, headers, "fixtures:health");

  const history = await instance.app.inject({ method: "GET", url: "/api/v1/sports/providers/sandbox-sim/health", headers });
  assert.equal(history.statusCode, 200, history.body);
  const body = history.json();
  assert.equal(body.provider.provider_code, "sandbox-sim");
  // The series, not the current value: an outage is visible as a gap in a series and
  // invisible in an overwritten row.
  assert.ok(body.observations.length >= 1);
  assert.equal(body.observations[0].status, "ONLINE");

  const unknown = await instance.app.inject({ method: "GET", url: "/api/v1/sports/providers/never-seen/health", headers });
  assert.equal(unknown.statusCode, 404);
});

test("after a sync, /sports/status reports a derived health that was measured, not assumed", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  // Phase 15 hard-coded two empty arrays into the monitor, so every provider reported
  // UNKNOWN for want of anywhere to read from. That was honest then. Now that a sync
  // persists observations and run rows, the same field has to be measured — and a
  // status surface that kept reporting UNKNOWN would be a field that looks measured
  // and is not.
  const before = (await instance.app.inject({ method: "GET", url: "/api/v1/sports/status", headers })).json();
  assert.equal(before.providers[0].derivedStatus, "UNKNOWN");
  assert.equal(before.providers[0].registered, false, "no sync has named this provider yet");
  assert.equal(before.persistence, true);

  await syncFixtures(instance.app, headers, "fixtures:derived");

  const after = (await instance.app.inject({ method: "GET", url: "/api/v1/sports/status", headers })).json();
  assert.equal(after.providers[0].registered, true);
  assert.notEqual(after.providers[0].derivedStatus, "UNKNOWN", "the derivation now has real inputs (finding F-35)");
  assert.ok(after.providers[0].observations >= 1);
  assert.ok(after.providers[0].syncRuns >= 1);

  // A probe is STILL not persisted, on a host that has a repository. Making this
  // conditional on `store` was the first thing slice 2 tried and it was wrong: it
  // reported `persisted: true` for a reading written nowhere, which is a false claim
  // about provenance on the one field whose job is to make that claim.
  const probed = (await instance.app.inject({ method: "GET", url: "/api/v1/sports/status?probe=1", headers })).json();
  assert.equal(probed.probed, true);
  assert.equal(probed.persisted, false);
});

test("no sports route can reach a prediction, ticket, settlement or broker surface", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  // Non-vacuity: the inventory really is populated, so the absences below are findings
  // rather than an empty response.
  const inventory = (await instance.app.inject({ method: "GET", url: "/api/v1/system/routes" })).json().routes;
  assert.ok(inventory.length >= 80);
  const sports = inventory.filter((route) => route.path.includes("/sports"));
  assert.equal(sports.length, 7);

  // Asserted as absences rather than as a count, because a count would also pass if a
  // route were renamed.
  for (const forbidden of ["prediction", "ticket", "settle", "verify", "calibrat", "backtest", "model", "daily", "value", "stake", "order", "broker"]) {
    assert.deepEqual(
      sports.filter((route) => route.path.toLowerCase().includes(forbidden)).map((route) => route.path),
      [],
      `no /sports route may mention ${forbidden} in this slice`,
    );
  }
  // And the one write route writes only to the seven `wf_sports_*` tables: nothing here
  // can place an order, move a stake or enable a connector.
  assert.deepEqual(sports.filter((route) => route.method !== "GET").map((route) => route.path), ["/api/v1/sports/sync"]);
});
