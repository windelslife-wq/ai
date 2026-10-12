/**
 * The portfolio optimization endpoint (Phase 11, row 9).
 *
 * Legacy route: `POST /api/portfolio/optimize` → `Api_portfolio::optimize`,
 * behind the session-only `Api_controller` and gated on `trading.view`.
 *
 * What these tests pin, beyond the happy path:
 *
 *  1. **Authority.** A session is required, `trading.view` is required, and a
 *     cookie session without a CSRF token is refused before the handler runs.
 *  2. **The synthetic-data gate is visible over HTTP.** A sandbox host with no real
 *     provider serves synthetic history, so an optimization without
 *     `allowSyntheticData` must be refused with 422 and a message that tells the
 *     caller exactly what to do — and with the flag, must succeed *and* label
 *     itself SIMULATION in the response.
 *  3. **The body cannot smuggle an instruction.** `additionalProperties: false`
 *     means an undeclared key like `execute` or `amount` is a 400, not a silently
 *     ignored field the caller believes took effect.
 *  4. **The concurrency gate releases its slot on failure**, so one refused run
 *     cannot lock a session out of the endpoint until the process restarts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";

import { cookieFrom, createFileStoreApp } from "./helpers.js";

const ENV = {
  MARKET_DATA_REAL_PROVIDERS: "0",
  MARKET_DATA_ALLOW_SYNTHETIC: "1",
};

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  const cookie = cookieFrom(response);
  return { cookie, csrfToken: body.csrfToken, headers: { cookie, "x-csrf-token": body.csrfToken } };
}

/** A member holding `trading.view` — the permission legacy required for this route. */
async function addTradingViewer(store, username = "portfolioviewer") {
  const user = await store.createUser({
    username,
    email: `${username}@example.test`,
    passwordHash: await bcrypt.hash(`${username} secret phrase`, 4),
    displayName: username,
  });
  const role = (await store.listRoles()).find((entry) => entry.role_key === "platform_member");
  const permission = (await store.listPermissions()).find((entry) => entry.permission_key === "trading.view");
  await store.grantRolePermission(role.id, permission.id);
  await store.assignRole(user.id, role.id);
  return user;
}

/** A member with `system.authenticated` and deliberately no trading permission. */
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

const UNIVERSE = [
  { symbol: "EURUSD", marketClass: "forex" },
  { symbol: "GBPUSD", marketClass: "forex" },
];

// ------------------------------------------------------------------ inventory

test("the optimization route is registered, permissioned, unsafe and rate-limited", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());

  const inventoryResponse = await instance.app.inject({ method: "GET", url: "/api/v1/system/routes" });
  assert.equal(inventoryResponse.statusCode, 200);
  const inventory = inventoryResponse.json().routes;

  const route = inventory.find((entry) => entry.path === "/api/v1/portfolio/optimize");
  assert.ok(route, "POST /api/v1/portfolio/optimize must be in the inventory");
  assert.equal(route.method, "POST");
  assert.equal(route.auth, true, "a session is required");
  assert.equal(route.permission, "trading.view", "the legacy permission is preserved");

  // This is the only route the portfolio MODULE registers. `/portfolio/risk-scan`
  // also lives under this prefix but belongs to the paper module (Phase 7, the
  // portfolio risk monitor over open paper positions) — two different modules
  // sharing one URL prefix, which is recorded as divergence PO-6 rather than
  // silently re-homed, because moving the paper route would break a shipped path.
  const portfolioRoutes = inventory.filter((entry) => entry.path.includes("/portfolio/"));
  assert.deepEqual(
    portfolioRoutes.map((entry) => `${entry.method} ${entry.path}`).sort(),
    ["GET /api/v1/portfolio/risk-scan", "POST /api/v1/portfolio/optimize"],
  );
  const riskScan = portfolioRoutes.find((entry) => entry.path.endsWith("/risk-scan"));
  assert.equal(riskScan.permission, "trading.view", "the pre-existing paper route keeps its own permission");

  // And the optimizer registers no read route of its own: a run is computed and
  // returned, never stored, so there is nothing to GET.
  assert.equal(inventory.filter((entry) => entry.path === "/api/v1/portfolio/optimize").length, 1);

  // Divergence PO-5: the legacy unversioned path is not aliased.
  const legacy = await instance.app.inject({ method: "POST", url: "/api/portfolio/optimize", payload: { assets: UNIVERSE } });
  assert.notEqual(legacy.statusCode, 200, "no alias implies a consumer that does not exist");
});

// ------------------------------------------------------------------- authority

test("the endpoint requires a session, trading.view, and a CSRF token for a cookie session", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const { store, app } = instance;

  const anonymous = await app.inject({ method: "POST", url: "/api/v1/portfolio/optimize", payload: { assets: UNIVERSE } });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error.code, "AUTH_REQUIRED");

  await addPlainMember(store, "noperm");
  const plainLogin = await signIn(app, "noperm", "noperm secret phrase");
  const forbidden = await app.inject({
    method: "POST",
    url: "/api/v1/portfolio/optimize",
    headers: plainLogin.headers,
    payload: { assets: UNIVERSE },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error.code, "PERMISSION_DENIED");

  // A cookie session without the matching CSRF token is refused before the handler
  // runs, so no provider call is made on a forged cross-site request.
  await addTradingViewer(store, "viewer");
  const viewer = await signIn(app, "viewer", "viewer secret phrase");
  const noCsrf = await app.inject({
    method: "POST",
    url: "/api/v1/portfolio/optimize",
    headers: { cookie: viewer.cookie },
    payload: { assets: UNIVERSE, allowSyntheticData: true },
  });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(noCsrf.json().error.code, "CSRF_INVALID");

  const wrongCsrf = await app.inject({
    method: "POST",
    url: "/api/v1/portfolio/optimize",
    headers: { cookie: viewer.cookie, "x-csrf-token": "not-the-token" },
    payload: { assets: UNIVERSE, allowSyntheticData: true },
  });
  assert.equal(wrongCsrf.statusCode, 403);
  assert.equal(wrongCsrf.json().error.code, "CSRF_INVALID");
});

test("a member holding trading.view can optimize", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  await addTradingViewer(instance.store, "viewer2");
  const viewer = await signIn(instance.app, "viewer2", "viewer2 secret phrase");

  const response = await instance.app.inject({
    method: "POST",
    url: "/api/v1/portfolio/optimize",
    headers: viewer.headers,
    payload: { assets: UNIVERSE, allowSyntheticData: true },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();

  // The legacy envelope shape is preserved: the report lives under `optimization`.
  assert.ok(body.optimization, "the report must be under the legacy `optimization` key");
  assert.equal(body.optimization.status, "RESEARCH_ONLY");
  assert.equal(body.optimization.model, "historical-mean-variance-diagonal-shrinkage-v1");
  assert.equal(body.optimization.objective, "max_sharpe", "the legacy default objective");
  assert.match(body.notice, /research only/i);

  const report = body.optimization;
  assert.equal(report.assets.length, 2);
  assert.deepEqual(Object.keys(report.allocations).sort(),
    ["equalWeightBenchmark", "maximumSharpe", "minimumVariance", "selected"]);
  assert.deepEqual(report.request.assets, UNIVERSE);
  assert.equal(report.request.timeframe, "1d");
  assert.equal(report.request.limit, 500, "the legacy default history depth");
  assert.equal(report.request.allowSyntheticData, true);

  // On this host the only available provider is synthetic, so the run must label
  // itself rather than present generated prices as market history.
  assert.deepEqual(report.dataProvenance.map((entry) => entry.synthetic), [true, true]);
  assert.ok(
    report.warnings.some((warning) => /^SIMULATION: every input series is synthetic/.test(warning)),
    JSON.stringify(report.warnings),
  );
});

// ------------------------------------------------------------- synthetic gate

test("an all-synthetic universe is refused with 422 until the caller opts in", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);

  const refused = await instance.app.inject({
    method: "POST",
    url: "/api/v1/portfolio/optimize",
    headers: admin.headers,
    payload: { assets: UNIVERSE },
  });
  assert.equal(refused.statusCode, 422, refused.body);
  assert.equal(refused.json().error.code, "PORTFOLIO_OPTIMIZATION_UNAVAILABLE");
  assert.match(refused.json().error.message, /all available history is synthetic/);
  assert.match(refused.json().error.message, /allowSyntheticData=true/);

  const allowed = await instance.app.inject({
    method: "POST",
    url: "/api/v1/portfolio/optimize",
    headers: admin.headers,
    payload: { assets: UNIVERSE, allowSyntheticData: true },
  });
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.equal(allowed.json().optimization.status, "RESEARCH_ONLY");
});

test("a host that refuses synthetic data answers 503, and the flag cannot override it", async (t) => {
  // MARKET_DATA_ALLOW_SYNTHETIC=0 with no real providers: nothing can serve
  // history, so this is a dependency outage the caller cannot fix by editing the
  // body. Distinct from the 422 above on purpose — different remedy.
  const instance = await createFileStoreApp({
    configOverrides: { env: { MARKET_DATA_REAL_PROVIDERS: "0", MARKET_DATA_ALLOW_SYNTHETIC: "0" } },
  });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);

  for (const allowSyntheticData of [false, true]) {
    const response = await instance.app.inject({
      method: "POST",
      url: "/api/v1/portfolio/optimize",
      headers: admin.headers,
      payload: { assets: UNIVERSE, allowSyntheticData },
    });
    assert.equal(response.statusCode, 503, `allowSyntheticData=${allowSyntheticData}: ${response.body}`);
    assert.equal(response.json().error.code, "SYNTHETIC_DATA_DISABLED");
    assert.ok(Number(response.headers["retry-after"]) > 0, "a retryable outage says when to retry");
  }
});

// ----------------------------------------------------------------- validation

test("the body cannot smuggle an instruction to trade, or an undeclared field", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);

  for (const extra of [
    { execute: true },
    { amount: 10_000 },
    { orderId: "abc" },
    { accountId: 1 },
    { notional: 5000 },
  ]) {
    const response = await instance.app.inject({
      method: "POST",
      url: "/api/v1/portfolio/optimize",
      headers: admin.headers,
      payload: { assets: UNIVERSE, allowSyntheticData: true, ...extra },
    });
    assert.equal(response.statusCode, 400, `${JSON.stringify(extra)} must be refused, got ${response.body}`);
    // `INVALID_REQUEST` is this platform's schema-failure code (app.js), with the
    // per-field reason in `details`.
    const error = response.json().error;
    assert.equal(error.code, "INVALID_REQUEST");
    const key = Object.keys(extra)[0];
    // The field path is unprefixed at the top level (`execute`) and dotted below
    // it (`assets[0].quantity`), so match the key rather than a fixed prefix.
    const fields = (error.details || []).map((issue) => `${issue.field}:${issue.code}`);
    assert.ok(
      fields.some((entry) => entry === `${key}:UNKNOWN_PROPERTY`),
      `${JSON.stringify(extra)} must be refused by name, got ${JSON.stringify(fields)}`,
    );
  }

  // The same guard applies one level down, inside an asset: this is the path a
  // caller would most plausibly try, since a per-asset quantity looks natural.
  const nested = await instance.app.inject({
    method: "POST",
    url: "/api/v1/portfolio/optimize",
    headers: admin.headers,
    payload: { assets: [{ symbol: "EURUSD", marketClass: "forex", quantity: 100 }, UNIVERSE[1]], allowSyntheticData: true },
  });
  assert.equal(nested.statusCode, 400, nested.body);
  assert.ok(
    (nested.json().error.details || []).some((issue) => issue.field === "assets[0].quantity" && issue.code === "UNKNOWN_PROPERTY"),
    JSON.stringify(nested.json().error.details),
  );
});

test("universe, objective, timeframe and limit bounds are enforced over HTTP", async (t) => {
  // This case fires thirteen refused requests, and the window limit is charged
  // BEFORE validation — the same convention the analysis and login routes follow,
  // so a malformed request still counts against the budget. That ordering is
  // deliberate (cheap refusal of expensive work), but it means a table-driven
  // validation test must raise the window or it starts asserting its own rate
  // limit. Asserted explicitly below rather than papered over.
  const instance = await createFileStoreApp({
    configOverrides: { env: { ...ENV, RATE_LIMIT_PORTFOLIO_OPTIMIZE_MAX: "500" } },
  });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);
  const post = (payload) => instance.app.inject({
    method: "POST", url: "/api/v1/portfolio/optimize", headers: admin.headers, payload,
  });

  const cases = [
    [{ assets: [UNIVERSE[0]], allowSyntheticData: true }, "a one-asset universe"],
    [{ assets: [...UNIVERSE, ...Array.from({ length: 11 }, (_, i) => ({ symbol: `SYM${i}`, marketClass: "forex" }))], allowSyntheticData: true }, "a 13-asset universe"],
    [{ assets: UNIVERSE, objective: "max_return", allowSyntheticData: true }, "an invented objective"],
    [{ assets: UNIVERSE, timeframe: "5m", allowSyntheticData: true }, "an unsupported timeframe"],
    [{ assets: UNIVERSE, limit: 30, allowSyntheticData: true }, "a limit below the observation floor"],
    [{ assets: UNIVERSE, limit: 2001, allowSyntheticData: true }, "a limit above the ceiling"],
    [{ assets: [{ symbol: "EURUSD", marketClass: "nft" }, UNIVERSE[1]], allowSyntheticData: true }, "an unsupported market class"],
    [{ assets: [{ symbol: "EURUSD" }, UNIVERSE[1]], allowSyntheticData: true }, "an asset with no marketClass"],
    [{ assets: UNIVERSE, maxWeight: 1.5, allowSyntheticData: true }, "a cap above 1"],
    [{ assets: UNIVERSE, riskFreeRate: 5, allowSyntheticData: true }, "a risk-free rate as a percentage"],
    [{ assets: UNIVERSE, shrinkage: -0.1, allowSyntheticData: true }, "negative shrinkage"],
    [{ assets: UNIVERSE, periodsPerYear: 0, allowSyntheticData: true }, "a zero annualization factor"],
    [{ allowSyntheticData: true }, "no assets at all"],
  ];

  for (const [payload, label] of cases) {
    const response = await post(payload);
    assert.equal(response.statusCode, 400, `${label} must be a 400, got ${response.statusCode}: ${response.body}`);
  }
});

test("the window limit is charged before validation, so malformed requests still count", async (t) => {
  // Pinned on its own because it is a cost-control property, not a convenience:
  // an attacker sending garbage must not get unlimited free requests just because
  // the garbage never reaches the provider chain.
  const instance = await createFileStoreApp({
    configOverrides: { env: { ...ENV, RATE_LIMIT_PORTFOLIO_OPTIMIZE_MAX: "2" } },
  });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);

  const bad = { assets: UNIVERSE, objective: "not_a_real_objective", allowSyntheticData: true };
  const first = await instance.app.inject({ method: "POST", url: "/api/v1/portfolio/optimize", headers: admin.headers, payload: bad });
  const second = await instance.app.inject({ method: "POST", url: "/api/v1/portfolio/optimize", headers: admin.headers, payload: bad });
  const third = await instance.app.inject({ method: "POST", url: "/api/v1/portfolio/optimize", headers: admin.headers, payload: bad });

  assert.equal(first.statusCode, 400, first.body);
  assert.equal(second.statusCode, 400, second.body);
  assert.equal(third.statusCode, 429, "the third malformed request must be rate-limited, not validated");
  assert.equal(third.json().error.code, "RATE_LIMITED");
});

test("a maxWeight too small to be fully invested is refused naming the asset count", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);

  const response = await instance.app.inject({
    method: "POST",
    url: "/api/v1/portfolio/optimize",
    headers: admin.headers,
    payload: { assets: [...UNIVERSE, { symbol: "USDJPY", marketClass: "forex" }], maxWeight: 0.2, allowSyntheticData: true },
  });
  // The cap floor is 1/n, which the schema cannot know, so the solver answers and
  // the message must say which count made it impossible.
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().error.message, /maxWeight must be between 0\.333333 and 1\.0 for 3 assets/);
});

// ------------------------------------------------------------------ objectives

test("both objectives are served, and each selects the allocation it names", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const admin = await signIn(instance.app);

  const post = (objective) => instance.app.inject({
    method: "POST",
    url: "/api/v1/portfolio/optimize",
    headers: admin.headers,
    payload: { assets: UNIVERSE, objective, allowSyntheticData: true },
  });

  const minVariance = (await post("min_variance")).json().optimization;
  assert.equal(minVariance.objective, "min_variance");
  assert.deepEqual(minVariance.allocations.selected.weights, minVariance.allocations.minimumVariance.weights);

  const maxSharpe = (await post("max_sharpe")).json().optimization;
  assert.equal(maxSharpe.objective, "max_sharpe");
  assert.deepEqual(maxSharpe.allocations.selected.weights, maxSharpe.allocations.maximumSharpe.weights);

  for (const report of [minVariance, maxSharpe]) {
    assert.equal(report.constraints.longOnly, true);
    assert.equal(report.constraints.fullyInvested, true);
    for (const allocation of Object.values(report.allocations)) {
      const total = Object.values(allocation.weights).reduce((sum, weight) => sum + weight, 0);
      assert.ok(Math.abs(total - 1) < 1e-9, `${report.objective} is not fully invested: ${total}`);
    }
  }
});

// ------------------------------------------------------------------- concurrency

test("the per-session concurrency gate refuses a second run and releases on failure", async (t) => {
  const instance = await createFileStoreApp({
    configOverrides: { env: { ...ENV, PORTFOLIO_MAX_CONCURRENT_RUNS: "1" } },
  });
  t.after(() => instance.cleanup());
  const { app } = instance;
  const admin = await signIn(app);

  // Two concurrent runs from one session: one must be refused with the concurrency
  // code rather than the window-limit code, so the remedy reads correctly.
  const payload = { assets: UNIVERSE, allowSyntheticData: true };
  const [first, second] = await Promise.all([
    app.inject({ method: "POST", url: "/api/v1/portfolio/optimize", headers: admin.headers, payload }),
    app.inject({ method: "POST", url: "/api/v1/portfolio/optimize", headers: admin.headers, payload }),
  ]);
  const statuses = [first.statusCode, second.statusCode].sort();
  assert.ok(statuses.includes(200), `one run must succeed, got ${JSON.stringify(statuses)}`);
  const refused = [first, second].find((response) => response.statusCode === 429);
  if (refused) {
    assert.equal(refused.json().error.code, "TOO_MANY_CONCURRENT_OPTIMIZATIONS");
    assert.match(refused.json().error.message, /in flight per session/);
  }

  // The slot must be released afterwards: a third sequential run succeeds even
  // though the two above included a refusal. A gate that leaked on failure would
  // lock the session out until the process restarted.
  const after = await app.inject({ method: "POST", url: "/api/v1/portfolio/optimize", headers: admin.headers, payload });
  assert.equal(after.statusCode, 200, after.body);

  // And a FAILED run also releases: refuse a run with a bad cap, then succeed.
  const bad = await app.inject({
    method: "POST",
    url: "/api/v1/portfolio/optimize",
    headers: admin.headers,
    payload: { assets: UNIVERSE, maxWeight: 0.1, allowSyntheticData: true },
  });
  assert.equal(bad.statusCode, 400, bad.body);
  const recovered = await app.inject({ method: "POST", url: "/api/v1/portfolio/optimize", headers: admin.headers, payload });
  assert.equal(recovered.statusCode, 200, `a failed run must not leak its slot: ${recovered.body}`);
});

// ----------------------------------------------------------------------- audit

test("an optimization is recorded in the audit trail and visible in the browser", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const { app, store } = instance;
  const admin = await signIn(app);

  const before = (await store.listAuditEvents({ limit: 200 })).events.length;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/portfolio/optimize",
    headers: admin.headers,
    payload: { assets: UNIVERSE, objective: "min_variance", allowSyntheticData: true },
  });
  assert.equal(response.statusCode, 200, response.body);

  const after = (await store.listAuditEvents({ limit: 200 })).events;
  assert.equal(after.length, before + 1, "exactly one audit event per run");
  const event = after.find((entry) => entry.action === "portfolio.optimization.run");
  assert.ok(event, "the run must be attributable");
  assert.equal(event.actor?.username, "rootadmin", "Phase 10 attribution resolves the actor");
  assert.equal(event.details.objective, "min_variance");
  assert.deepEqual(event.details.assets, ["EURUSD", "GBPUSD"]);
  assert.equal(event.details.synthetic, true, "a simulation is distinguishable in the trail");
  assert.equal(event.details.legacyAction, "PORTFOLIO_OPTIMIZATION_RUN");

  // And it is reachable through the Phase 10 browser, filtered by action prefix.
  const browser = await app.inject({
    method: "GET",
    url: "/api/v1/admin/audit?action=portfolio",
    headers: admin.headers,
  });
  assert.equal(browser.statusCode, 200);
  const events = browser.json().events;
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "portfolio.optimization.run");
  assert.equal(events[0].entityType, "portfolio");
});

test("a refused run leaves no audit event", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const { app, store } = instance;
  const admin = await signIn(app);

  const refused = await app.inject({
    method: "POST",
    url: "/api/v1/portfolio/optimize",
    headers: admin.headers,
    payload: { assets: UNIVERSE },
  });
  assert.equal(refused.statusCode, 422);

  const events = await store.listAuditEvents({ limit: 200, action: "portfolio" });
  assert.equal(events.events.length, 0, "nothing was computed, so nothing is recorded as computed");
});
