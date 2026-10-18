/**
 * The Broker Center console against the API it reads (row 13, Phase 40).
 *
 * `views/brokers/index.php` → `Brokers::index` is legacy's one page over the broker module: a
 * routing banner, simulated-bridge switch, connector cards, account/quote panels and PLANNED
 * matrix. The port exposes status plus authenticated MT5/simulator account and quote reads;
 * the only order path is a separately governed proposal submission through Execution.
 *
 *  1. **The copy is legacy's.** Every heading, note, row label, banner arm and flash sentence in
 *     `client/src/brokers.js` is asserted against `views/brokers/index.php` and
 *     `controllers/Brokers.php`, read with `readFileSync`, with the sentences this port adds
 *     kept in a separate object so a legacy claim cannot quietly become the port's own.
 *  2. **The matrix is the server's.** The nine PLANNED adapters are compared to
 *     `registry.js`'s own export; the four states and their tones to the PHP's badge map (plus
 *     this port's fifth, `ERROR`, which the manager can emit); the ten connectors to the roster,
 *     in legacy's order.
 *  3. **The absences are absences.** The simulated-bridge toggle and the two MT5 reads are
 *     asserted **absent** from `/api/v1/system/routes`, because a docblock that says "not
 *     ported" while a route answers is the failure this suite exists to catch — and legacy's two
 *     MT5 reads were unauthenticated (F-32), so a port of them would have to be gated anyway.
 *
 * Hermetic like the other client suites: the file adapter, `createFileStoreApp` with
 * `MARKET_DATA_REAL_PROVIDERS=0`, no network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  BROKERS_COPY, BROKERS_PERMISSION, BROKERS_PORT_COPY, BROKERS_READS, CONNECTOR_STATES,
  LEGACY_ROUTES_NOT_PORTED, SUPER_ADMIN_PERMISSION,
  accountRows, connectorRows, countText, flagText, governanceFacts, holdsBrokersPermission,
  moneyText, mt5Panels, plannedRows, priceText, quoteRows, routingBanner, simulationState,
  stateSummary, stateTone,
} from "../client/src/brokers.js";
import { BROKER_CONNECTOR_ROSTER, plannedConnectors } from "../src/modules/brokers/registry.js";
import { hashPassword } from "../src/security/passwords.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";

const CLIENT = path.resolve(import.meta.dirname, "..", "client", "src");
const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const LEGACY_VIEW = path.join(REPO, "application", "views", "brokers", "index.php");
const LEGACY_CONTROLLER = path.join(REPO, "application", "controllers", "Brokers.php");

const view = () => readFileSync(LEGACY_VIEW, "utf8");
const controller = () => readFileSync(LEGACY_CONTROLLER, "utf8");
/** Legacy's prose with its inline markup and entities resolved, so a sentence compares whole. */
const plain = (text) => text
  .replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/\s+/g, " ");

const BROKER_ENV = { MARKET_DATA_REAL_PROVIDERS: "0", MARKET_DATA_ALLOW_SYNTHETIC: "1" };

async function instance(t) {
  const app = await createFileStoreApp({ configOverrides: { env: BROKER_ENV } });
  t.after(() => app.cleanup());
  return app;
}

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  return { headers: { cookie: cookieFrom(response), "x-csrf-token": body.csrfToken } };
}

const get = (app, url, headers) => app.inject({ method: "GET", url, headers });

/** A role carrying exactly the permissions named. */
async function roleSession(app, store, { username, phrase, permissions }) {
  const role = await store.ensureRole(`${username}_role`, `${username} role`);
  for (const key of ["system.authenticated", ...permissions]) {
    const permission = await store.ensurePermission(key, key);
    await store.grantRolePermission(role.id, permission.id);
  }
  const user = await store.createUser({
    username, email: `${username}@example.test`, passwordHash: await hashPassword(phrase), displayName: username,
  });
  await store.assignRole(user.id, role.id);
  return signIn(app, username, phrase);
}

/* ------------------------------------------------------------------ the page's words */

test("the headings, notes, row labels and flashes are the legacy page's and controller's own words", () => {
  const page = plain(view());
  // `eyebrow` is this shell's row label and the two simulation flashes are the *controller's*
  // sentences (asserted below against the controller); every other string is the page's.
  // Three of the labels are single words (`enabled`, `disabled`, `allowed`) and one is a
  // `yes`/`no` pair, so they are excluded from this loop and pinned where they are rendered.
  const controllerOnly = new Set([
    "eyebrow", "simulationEnabledFlash", "simulationDisabledFlash",
    "orderEnabled", "orderDisabled", "liveAllowed", "demoOnly",
  ]);
  for (const [key, value] of Object.entries(BROKERS_COPY).filter(([, value]) => typeof value === "string")) {
    if (controllerOnly.has(key)) continue;
    assert.ok(page.includes(value), `${key} must be the legacy page's own string: ${JSON.stringify(value)}`);
  }
  for (const label of BROKERS_COPY.accountRows) assert.ok(page.includes(label), `account row ${label}`);
  for (const label of BROKERS_COPY.quoteRows) assert.ok(page.includes(label), `quote row ${label}`);

  // The controller is PHP, not markup: `plain()` strips from `<?php` to the first `>`, which
  // would swallow the whole PLANNED constant, so its own text is compared raw.
  const source = controller();
  for (const flash of [BROKERS_COPY.simulationEnabledFlash, BROKERS_COPY.simulationDisabledFlash]) {
    assert.ok(source.includes(flash), `flash sentence must be the controller's own: ${JSON.stringify(flash)}`);
  }
  // The nine PLANNED details are the controller's `PLANNED` constant verbatim, and the matrix
  // the port renders is the registry's, so the two sources must agree.
  for (const entry of plannedConnectors()) {
    assert.ok(source.includes(entry.detail), `${entry.id}'s detail comes from the controller's PLANNED matrix`);
  }
});

test("the port's own sentences are its own, and never claim a capability the API lacks", () => {
  for (const [key, value] of Object.entries(BROKERS_PORT_COPY)) {
    assert.equal(typeof value, "string", `${key} is a string`);
    assert.ok(value.length > 20, `${key} must say something a reader can act on`);
  }
  // The two intentional boundaries: no runtime toggle and no direct order route.
  assert.match(BROKERS_PORT_COPY.toggleAbsent, /no runtime enable\/toggle endpoint/i);
  assert.match(BROKERS_PORT_COPY.accountAbsent, /authenticated account reads are available/i);
  assert.match(BROKERS_PORT_COPY.quoteAbsent, /authenticated quote reads are available/i);
  assert.match(BROKERS_PORT_COPY.oneRouteOnly, /no direct broker order route exists/i);
  assert.match(BROKERS_PORT_COPY.realValidation, /no real MT5 terminal was contacted/i);
  // And nothing in the page's copy may promise a working order path.
  for (const value of Object.values(BROKERS_COPY)) {
    if (typeof value !== "string") continue;
    assert.ok(!/you can now trade|live trading enabled/i.test(value), "no legacy sentence promises live trading");
  }
});

/* ------------------------------------------------------------------- the state ladder */

test("the four legacy states keep legacy's tones, and this port's fifth is stated", () => {
  const php = view();
  const block = php.slice(php.indexOf("['READY' =>"), php.indexOf("['READY' =>") + 300);
  const legacy = [...block.matchAll(/'(READY|DOWN|DISABLED|NOT_CONFIGURED)' => 'b-(\w+)'/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(legacy, [["READY", "green"], ["DOWN", "red"], ["DISABLED", "gray"], ["NOT_CONFIGURED", "amber"]], "legacy's own badge map");
  for (const [state, tone] of legacy) {
    assert.equal(stateTone(state), `badge-${tone}`, `${state} keeps legacy's tone`);
  }
  // `manager.allStatus()` answers ERROR when an adapter throws; a screen that only knew four
  // states would paint that green or crash, so it is declared, neutral and documented.
  const manager = readFileSync(path.join(import.meta.dirname, "..", "src", "modules", "brokers", "manager.js"), "utf8");
  assert.match(manager, /state: "ERROR"/, "the manager can answer a fifth state");
  assert.equal(stateTone("ERROR"), "badge-gray", "ERROR is never green");
  assert.ok(CONNECTOR_STATES.ERROR.note.includes("Not READY"));
  assert.equal(stateTone("SOMETHING_ELSE"), "badge-gray", "an unknown state is neutral, never green");
  for (const state of Object.keys(CONNECTOR_STATES)) assert.ok(stateTone(state).startsWith("badge-"));
});

/* --------------------------------------------------------------------- the matrix */

test("the ten connectors are the roster's, in legacy's order", () => {
  const payload = {
    brokers: Object.fromEntries(BROKER_CONNECTOR_ROSTER.map((entry) => [entry.id, {
      state: "DISABLED", message: "Connector disabled by default.", configured: false, connector: entry.id,
      capabilities: { accountRead: true, marketData: true, tradingRead: true, orderSubmission: false, liveTrading: false, reason: "Read-only by default." },
    }])),
    planned: plannedConnectors(),
    routable: false,
  };
  const rows = connectorRows(payload);
  assert.deepEqual(rows.map((row) => row.id), BROKER_CONNECTOR_ROSTER.map((entry) => entry.id), "no re-sorting of a safety list");
  assert.equal(rows.length, 10);
  assert.deepEqual(stateSummary(rows), { total: 10, ready: 0, configured: 0, tally: { DISABLED: 10 } });
  assert.deepEqual(plannedRows(payload).map((entry) => entry.name), plannedConnectors().map((entry) => entry.name));
  assert.equal(plannedRows(payload).length, 9, "nine adapters have never spoken to their provider");
});

test("the nine PLANNED adapters are the registry's own entries, with legacy's controller wording", () => {
  const registry = plannedConnectors();
  const controllerText = controller();
  assert.equal(registry.length, 9);
  for (const entry of registry) {
    assert.equal(entry.status, "PLANNED");
    assert.ok(controllerText.includes(entry.detail), `${entry.id}'s detail is the controller's`);
    assert.ok(controllerText.includes(`'id' => '${entry.id}'`), `${entry.id} is named in the controller's PLANNED array`);
  }
  // The controller's display names are its own choice (`InteractiveBrokers`, `Alpaca`, …) and
  // the registry's differ for three of them; the console takes the registry's because a screen
  // may not invent a name the API does not send.
  assert.equal(plannedRows({ planned: registry }).find((row) => row.key === "ib").name, "Interactive Brokers");
});

test("a connector card never prints a bridge field the adapter did not report", () => {
  const ready = connectorRows({
    brokers: {
      "mt5-bridge": {
        state: "READY", message: "Adapter reachable — SIMULATION only.", configured: true, simulated: true,
        bridgeVersion: "0.9.1", bridgeTradingEnabled: false, accountType: "demo", orderSubmissionEffective: false,
        capabilities: { accountRead: true, marketData: true, orderSubmission: false, liveTrading: false, reason: "Read-only by default." },
      },
    },
  })[0];
  assert.deepEqual(ready.bridgeFields.map(([key]) => key), ["bridgeVersion", "bridgeTradingEnabled", "accountType", "orderSubmissionEffective"]);
  const disabled = connectorRows({ brokers: { "mt4-bridge": { state: "DISABLED", message: "…", configured: false } } })[0];
  assert.deepEqual(disabled.bridgeFields, [], "a DISABLED adapter carries none of the four fields");
  assert.equal(disabled.capabilities.accountRead, false, "an absent capability is false, not undefined");
  // The `ERROR` row the manager synthesises has a message and no capabilities at all.
  const errored = connectorRows({ brokers: { alpaca: { state: "ERROR", message: "alpaca could not report its status", configured: false, reason: "boom" } } })[0];
  assert.equal(errored.tone, "badge-gray");
  assert.equal(errored.capabilities.reason, null, "a manufactured capabilities block is not fabricated");
  assert.deepEqual(connectorRows(null), [], "no payload is no rows");
});

/* --------------------------------------------------------------------- the banner */

test("the routing banner separates real-connector eligibility from the demo simulator", () => {
  const simulated = routingBanner({ routable: false, simulation: { enabled: true, ordersEnabled: true, memoryOnly: true, liveTradingEnabled: false, state: "READY" } });
  assert.equal(simulated.key, "simulator-ready");
  assert.equal(simulated.tone, "info");
  assert.match(simulated.message, /process-local simulator/);
  const readOnly = routingBanner({ routable: false, simulation: { enabled: true, ordersEnabled: false } });
  assert.equal(readOnly.key, "simulator-read-only");
  const activeReal = routingBanner({ routable: true, simulation: { enabled: true, ordersEnabled: true } });
  assert.equal(activeReal.key, "real-connector-eligible");
  assert.equal(activeReal.tone, "warn", "eligible real connector status does not imply a live-order route");
  const disabled = routingBanner({ routable: false, simulation: { enabled: false, ordersEnabled: false } });
  assert.equal(disabled.key, "disabled");
  assert.equal(disabled.tone, "warn");
  assert.match(disabled.message, /Real broker routing is disabled/);
  assert.equal(routingBanner(null).key, "disabled", "an unread payload is not permission to route");
  assert.equal(routingBanner({}).key, "disabled");
});

test("the simulated-bridge panel reads explicit config, memory and order flags, and offers no runtime toggle", () => {
  assert.deepEqual(simulationState({ simulation: { enabled: true, ordersEnabled: true, memoryOnly: true, liveTradingEnabled: false, state: "READY", message: "ready" } }), {
    enabled: true, ordersEnabled: true, memoryOnly: true, liveTradingEnabled: false, state: "READY", message: "ready", toggleAvailable: false,
  });
  assert.equal(simulationState({}).enabled, false);
  assert.equal(simulationState(null).toggleAvailable, false, "the port has no runtime toggle to offer, in any state");
});

/* ------------------------------------------------------------------ the MT5 panels */

test("MT5 and simulator panels format authenticated account and quote payloads without inventing values", () => {
  const account = { accountId: "SIM-0001", currency: "USD", balance: 10_000, equity: 10_125.5, freeMargin: 8_000, timestamp: "2026-10-17T07:00:00Z" };
  const quote = { symbol: "EURUSD", bid: 1.07501, ask: 1.07521, spread: 0.0002, timestamp: "t" };
  const panels = mt5Panels({ account, quote });
  assert.deepEqual(panels, { account, quote, accountAvailable: true, quoteAvailable: true });
  assert.equal(accountRows(account)[2].value, "10,000.00 / 10,125.50");
  assert.equal(accountRows(null).length, 0);
  assert.equal(quoteRows(quote)[1].value, "1.07501 / 1.07521");
  assert.equal(quoteRows(undefined).length, 0);
  assert.deepEqual(mt5Panels({}), { account: null, quote: null, accountAvailable: false, quoteAvailable: false });
});

test("the formatting helpers never invent a figure", () => {
  assert.equal(moneyText(null), "—");
  assert.equal(moneyText(500), "500.00");
  assert.equal(priceText(null), "—");
  assert.equal(priceText(1.075), "1.07500", "legacy's five decimals");
  assert.equal(countText(0), "0");
  assert.equal(countText(undefined), "—");
  assert.equal(flagText(true), "yes");
  assert.equal(flagText(false), "no");
  assert.equal(flagText(null), "—", "an unreported flag is a gap, not a no");
  assert.equal(flagText(true, { trueText: "true", falseText: "false" }), "true");
});

test("the governance strip reads the mode and switch rather than assuming either", () => {
  assert.deepEqual(governanceFacts({ tradingMode: "PAPER_TRADING", executionMode: "HUMAN_APPROVAL", killSwitch: { active: false }, allowSyntheticPaperData: true, simulationOnly: true }), {
    mode: "PAPER_TRADING", executionMode: "HUMAN_APPROVAL", killSwitch: false, synthetic: true, simulated: true,
  });
  assert.equal(governanceFacts({ tradingMode: "ANALYSIS_ONLY", killSwitch: { active: true } }).killSwitch, true);
  assert.equal(governanceFacts(null), null);
  assert.equal(holdsBrokersPermission(["trading.view"], BROKERS_PERMISSION), true);
  assert.equal(holdsBrokersPermission([], BROKERS_PERMISSION), false);
  assert.equal(holdsBrokersPermission([SUPER_ADMIN_PERMISSION], BROKERS_PERMISSION), true, "the super-admin shortcut is mirrored");
});

/* ------------------------------------------------------------------------- the wiring */

test("all declared read routes are permissioned; only the runtime toggle remains absent", async (t) => {
  const app = await instance(t);
  const inventory = (await get(app.app, "/api/v1/system/routes")).json().routes;
  for (const entry of BROKERS_READS) {
    const route = inventory.filter((candidate) => candidate.method === entry.method && candidate.path === entry.path).at(-1);
    assert.ok(route, `${entry.method} ${entry.path} must be registered`);
    assert.equal(route.permission, entry.permission, `${entry.path} is declared with the wrong permission`);
    assert.equal(route.auth, true);
  }
  const brokerRoutes = inventory.filter((route) => route.path.startsWith("/api/v1/brokers"));
  assert.deepEqual(brokerRoutes.map((route) => `${route.method} ${route.path}`), [
    "GET /api/v1/brokers",
    "GET /api/v1/brokers/mt5/account",
    "GET /api/v1/brokers/mt5/quote",
    "GET /api/v1/brokers/simulation/account",
    "GET /api/v1/brokers/simulation/quote",
  ], "status/account/quote reads are authenticated, but no broker write route exists");
  for (const entry of LEGACY_ROUTES_NOT_PORTED) {
    assert.ok(!inventory.some((route) => route.path === entry.route), `${entry.route} is declared absent but exists`);
  }
  assert.deepEqual(LEGACY_ROUTES_NOT_PORTED.map((entry) => entry.key), ["simToggle"]);
  const { headers } = await signIn(app.app);
  const toggle = await post(app.app, "/api/v1/brokers/sim-toggle", headers, { enable: "1" });
  assert.equal(toggle.statusCode, 404, "the opt-in bridge cannot be toggled at runtime");
  const mt5Account = await get(app.app, "/api/v1/brokers/mt5/account", headers);
  assert.equal(mt5Account.statusCode, 503, "the authenticated read exists but the default host has no MT5 connector");
  const mt5Quote = await get(app.app, "/api/v1/brokers/mt5/quote?symbol=EURUSD", headers);
  assert.equal(mt5Quote.statusCode, 503, "the authenticated quote read exists but the default host has no MT5 connector");
});

const post = (app, url, headers, payload = {}) => app.inject({ method: "POST", url, headers, payload });

test("the screen is declared where the router and the navigation will find it", () => {
  const app = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  const views = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");
  const api = readFileSync(path.join(CLIENT, "api.js"), "utf8");
  assert.match(app, /path: "\/app\/brokers", view: "broker-center", requiresAuth: true, permission: "trading\.view"/);
  assert.match(app, /"broker-center": <BrokerCenterView permissions=\{permissions\} \/>/);
  assert.match(views, /export function BrokerCenterView\(\{ permissions \}\)/);
  assert.match(views, /\{ to: "\/app\/brokers", label: "Brokers", permission: BROKERS_PERMISSION \}/);
  assert.match(views, /<h1>\{BROKERS_COPY\.title\}\.<\/h1>/);
  assert.match(api, /\n  brokers: \(\) => api\("\/api\/v1\/brokers"\)/);
  for (const name of ["brokerMt5Account", "brokerMt5Quote", "brokerSimulationAccount", "brokerSimulationQuote"]) {
    assert.match(api, new RegExp(`\\n  ${name}:`), `${name} is a declared account/quote wrapper`);
  }
  // Broker Center is read-only; the separate Execution Center owns simulator order writes.
  const viewSource = views.slice(views.indexOf("export function BrokerCenterView"), views.indexOf("/* ------------------------------------------------------------- journal console */"));
  for (const method of ["method: \"POST\"", "method: \"PUT\"", "method: \"PATCH\"", "method: \"DELETE\""]) {
    assert.ok(!viewSource.includes(method), `the broker console issues no ${method}`);
  }
  assert.ok(!viewSource.includes("small-button") && !/onClick=\{\(\) => void act/.test(viewSource));
  assert.match(viewSource, /BROKERS_READS\.map/);
  assert.match(viewSource, /<code>\{LEGACY_ROUTES_NOT_PORTED\[0\]\.route\}<\/code>/, "the runtime toggle's absent route is rendered");
  assert.match(viewSource, /disabled=\{!mt5Configured\}/, "real MT5 reads require a configured bridge");
  assert.match(viewSource, /disabled=\{!simulation\.enabled\}/, "simulator quotes require the opt-in bridge");
  // The planned table is a plain table, not a `StateBox`, so its empty state is the render arm
  // that only appears when the API returns no PLANNED adapter.
  assert.match(viewSource, /planned\.length === 0 \? <p className="empty">No adapter is marked PLANNED\.<\/p> : \(/);
});

test("the live read returns the ten connectors, the nine planned adapters and no secret", async (t) => {
  const app = await instance(t);
  const viewer = await roleSession(app.app, app.store, {
    username: "brokerconsole", phrase: "Broker console phrase", permissions: [BROKERS_PERMISSION],
  });
  const response = await get(app.app, "/api/v1/brokers", viewer.headers);
  assert.equal(response.statusCode, 200, response.body);
  const payload = response.json();

  const rows = connectorRows(payload);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((row) => row.id), BROKER_CONNECTOR_ROSTER.map((entry) => entry.id));
  assert.equal(rows.every((row) => row.state === "DISABLED"), true, "a default host enables nothing");
  assert.equal(stateSummary(rows).ready, 0);
  assert.equal(routingBanner(payload).key, "disabled");
  assert.equal(simulationState(payload).enabled, false);
  assert.equal(mt5Panels(payload).accountAvailable, false);
  assert.equal(plannedRows(payload).length, 9);
  // The live body is the screen's only source, and it must not carry a credential.
  const serialized = JSON.stringify(payload);
  assert.equal(/Bearer|127\.0\.0\.1|"token"\s*:\s*"[^"]+"/.test(serialized), false, "the response the screen renders carries no secret");
  // The screen's summary sentence is built from figures that are in the payload.
  assert.match(payload.notice, /No real connector is READY with effective order submission/i);
  assert.equal(payload.simulation.enabled, false);
  assert.equal(payload.simulation.ordersEnabled, false);

  // A session without `trading.view` is refused, and the screen would render the reason.
  const signedOut = await roleSession(app.app, app.store, { username: "brokerplain", phrase: "Broker plain phrase", permissions: [] });
  const forbidden = await get(app.app, "/api/v1/brokers", signedOut.headers);
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  assert.equal(forbidden.json().error.code, "PERMISSION_DENIED");
});

test("the optional simulator account and quote reads remain isolated from real connector routability", async (t) => {
  const app = await createFileStoreApp({ configOverrides: { env: {
    ...BROKER_ENV,
    WF_SIMULATED_BROKER_ENABLED: "1",
    WF_SIMULATED_BROKER_ORDERS_ENABLED: "1",
    WF_SIMULATED_BROKER_INITIAL_BALANCE: "23000",
  } } });
  t.after(() => app.cleanup());
  const viewer = await roleSession(app.app, app.store, {
    username: "brokersimviewer", phrase: "Broker sim viewer phrase", permissions: [BROKERS_PERMISSION],
  });
  const status = (await get(app.app, "/api/v1/brokers", viewer.headers)).json();
  assert.equal(status.routable, false, "the simulator never changes real connector routability");
  assert.equal(simulationState(status).enabled, true);
  assert.equal(simulationState(status).ordersEnabled, true);

  const account = await get(app.app, "/api/v1/brokers/simulation/account", viewer.headers);
  assert.equal(account.statusCode, 200, account.body);
  assert.equal(account.json().simulationOnly, true);
  assert.equal(account.json().memoryOnly, true);
  assert.equal(accountRows(account.json().account)[0].value, "SIM-0001");
  assert.equal(account.json().account.balance, 23_000);

  const quote = await get(app.app, "/api/v1/brokers/simulation/quote?symbol=EURUSD", viewer.headers);
  assert.equal(quote.statusCode, 200, quote.body);
  assert.equal(quoteRows(quote.json().quote)[0].value, "EURUSD");
  assert.equal(quote.json().simulationOnly, true);

  const plain = await roleSession(app.app, app.store, { username: "brokernoview", phrase: "Broker no view phrase", permissions: [] });
  assert.equal((await get(app.app, "/api/v1/brokers/simulation/account", plain.headers)).statusCode, 403);
  assert.equal((await get(app.app, "/api/v1/brokers/simulation/quote?symbol=EURUSD", plain.headers)).statusCode, 403);
});

test("a configured bridge that cannot be reached is DOWN, and the banner still says DISABLED", async (t) => {
  // Port 9 (discard) on loopback: nothing listens. The card must say DOWN and the page must
  // still refuse to call the platform routable — the distinction the whole screen is about.
  const app = await createFileStoreApp({
    configOverrides: {
      env: {
        ...BROKER_ENV,
        AEGIS_MT5_BRIDGE_URL: "http://127.0.0.1:9",
        AEGIS_MT5_BRIDGE_TOKEN: "a-bridge-token-that-is-long-enough",
        AEGIS_MT5_BRIDGE_ENABLED: "1",
        AEGIS_MT5_TRADING_ENABLED: "1",
        BROKER_REQUEST_TIMEOUT_MS: "1500",
      },
    },
  });
  t.after(() => app.cleanup());
  const { headers } = await signIn(app.app);
  const payload = (await get(app.app, "/api/v1/brokers", headers)).json();
  const row = connectorRows(payload).find((entry) => entry.id === "mt5-bridge");
  assert.equal(row.state, "DOWN");
  assert.equal(row.tone, "badge-red");
  assert.equal(row.configured, true);
  assert.equal(row.capabilities.orderSubmission, true, "the local intent flag is on");
  assert.equal(row.bridgeFields.length, 0, "a DOWN adapter reports no bridge fields");
  assert.equal(payload.routable, false, "intent is not permission");
  assert.equal(routingBanner(payload).key, "disabled");
  assert.equal(stateSummary(connectorRows(payload)).ready, 0);
});

test("the served shell carries the screen, and the deep link answers", async (t) => {
  const app = await instance(t);
  const shell = path.resolve(CLIENT, "..", "..", "public", "app", "index.html");
  assert.ok(existsSync(shell), "the built SPA shell is required: npm run build:workforce-client");
  const html = await get(app.app, "/app/brokers", { accept: "text/html" });
  assert.equal(html.statusCode, 200, "a bookmark, a refresh or a pasted link must reach the screen");
  assert.match(html.headers["content-type"] || "", /text\/html/);
  const assets = [...html.body.matchAll(/assets\/index-[A-Za-z0-9_-]+\.js/g)].map((match) => match[0]);
  assert.ok(assets.length >= 1, "the shell must reference the built bundle");
  const bundle = readFileSync(path.resolve(CLIENT, "..", "..", "public", "app", ...assets[0].split("/")), "utf8");
  for (const needle of ["Brokers", "Not production-verified (PLANNED) — do not treat as working", "/app/brokers", "Order routing DISABLED"]) {
    assert.ok(bundle.includes(needle), `the served bundle carries ${JSON.stringify(needle)}`);
  }
  // The bundle names the absent route (so the screen can say what is missing) but carries no
  // request to it: there is no `api("…/sim-toggle")` wrapper to call.
  assert.ok(!/api\(\s*[`"]\/api\/v1\/brokers\/sim-toggle/.test(bundle), "the served bundle offers no simulated-bridge toggle");
});
