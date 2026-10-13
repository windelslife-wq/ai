/**
 * The console screens (Phases 27 and 28, row 3 of `docs/migration/UNFINISHED_MODULES.md`).
 *
 * Finding **F-29** said no ported module had a console screen. Phase 27 built the
 * first three — the notification inbox, the audit browser and the research-only
 * portfolio optimizer — and Phase 28 built the last two, the sports and lottery
 * consoles, removing F-29's last two halves (the finding stays open for the market-data,
 * analysis and Strategy Lab consoles). This file is the evidence that a screen cannot
 * drift away from the API it claims to render:
 *
 *  1. **The vocabularies are the server's.** The client's pick-lists (notification
 *     types and severities, audit sorts and directions, market classes,
 *     timeframes, objectives, bounds) are compared entry for entry against the
 *     modules that validate them, so a drifted copy fails here rather than
 *     producing a 400 in an operator's browser.
 *  2. **Every endpoint the SPA calls exists.** `client/src/api.js` is parsed for
 *     each `api(...)` call — path and method — and every one must resolve to a
 *     route in the live inventory from `GET /api/v1/system/routes`. A screen
 *     cannot be written against an endpoint that was never registered.
 *  3. **No screen is broader than its API.** The permission a screen declares in
 *     its route must be the permission its endpoint enforces (or "any signed-in
 *     member" when the endpoint enforces exactly `system.authenticated`), and
 *     every permission named anywhere in the shell must exist in the seeded
 *     catalogue — never an invented string.
 *  4. **The module grid reads the server's ledger.** The overview cards take their
 *     state from `GET /api/v1/system/status` and keep no copy: this file asserts
 *     that every module the server reports has a card, that no card carries a
 *     hardcoded state, and that the grid's source really does fetch the ledger.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createFileStoreApp } from "./helpers.js";
import { PLATFORM_PERMISSIONS } from "../src/db/platform-baseline.js";
import { MODULE_STATUS } from "../src/modules/platform/health.js";
import { NOTIFICATION_SEVERITIES, NOTIFICATION_TYPES, INBOX_QUERY } from "../src/modules/notifications/contracts.js";
import { AUDIT_QUERY } from "../src/modules/identity/contracts.js";
import { MAX_ASSETS, MIN_ASSETS, OBJECTIVES } from "../src/modules/portfolio/optimizer.js";
import {
  MAX_CANDLE_LIMIT,
  MIN_CANDLE_LIMIT,
  PORTFOLIO_MARKET_CLASSES,
  PORTFOLIO_TIMEFRAMES,
} from "../src/modules/portfolio/service.js";
import {
  AUDIT_DIRECTIONS,
  AUDIT_LIMIT_MAX,
  AUDIT_SORTS,
  INBOX_LIMIT_MAX,
  MAX_ASSETS as CLIENT_MAX_ASSETS,
  MAX_CANDLE_LIMIT as CLIENT_MAX_CANDLE_LIMIT,
  MIN_ASSETS as CLIENT_MIN_ASSETS,
  MIN_CANDLE_LIMIT as CLIENT_MIN_CANDLE_LIMIT,
  NOTIFICATION_SEVERITIES as CLIENT_SEVERITIES,
  NOTIFICATION_TYPES as CLIENT_TYPES,
  PORTFOLIO_MARKET_CLASSES as CLIENT_MARKET_CLASSES,
  PORTFOLIO_OBJECTIVES as CLIENT_OBJECTIVES,
  PORTFOLIO_TIMEFRAMES as CLIENT_TIMEFRAMES,
} from "../client/src/contracts.js";

const CLIENT_SRC = path.join(import.meta.dirname, "..", "client", "src");
const read = (name) => readFileSync(path.join(CLIENT_SRC, name), "utf8");

const API_SOURCE = read("api.js");
const APP_SOURCE = read("App.jsx");
const VIEWS_SOURCE = read("views.jsx");
const SCREENS_SOURCE = read("screens.jsx");
const CONSOLES_SOURCE = read("consoles.jsx");
/** The two screen modules, so a component is looked up in the file it lives in. */
const SCREEN_SOURCES = Object.freeze({ "screens.jsx": SCREENS_SOURCE, "consoles.jsx": CONSOLES_SOURCE });

/** The three screens this phase built, and the endpoint each one is bound to. */
const SCREENS = Object.freeze([
  Object.freeze({
    name: "notification inbox",
    route: "/app/notifications",
    component: "NotificationsView",
    /** The endpoint whose permission is the screen's own gate. */
    gate: "GET /api/v1/notifications",
    endpoints: Object.freeze(["GET /api/v1/notifications", "POST /api/v1/notifications/:param/read", "POST /api/v1/notifications/read-all"]),
  }),
  Object.freeze({
    name: "audit browser",
    route: "/app/admin/audit",
    component: "AuditBrowserView",
    gate: "GET /api/v1/admin/audit",
    endpoints: Object.freeze(["GET /api/v1/admin/audit"]),
  }),
  Object.freeze({
    name: "portfolio optimizer",
    route: "/app/portfolio/optimizer",
    component: "PortfolioOptimizerView",
    gate: "POST /api/v1/portfolio/optimize",
    endpoints: Object.freeze(["POST /api/v1/portfolio/optimize"]),
  }),
  Object.freeze({
    name: "sports console",
    route: "/app/sports",
    component: "SportsConsoleView",
    file: "consoles.jsx",
    gate: "GET /api/v1/sports/status",
    endpoints: Object.freeze([
      "GET /api/v1/sports/status",
      "GET /api/v1/sports/providers",
      "GET /api/v1/sports/sync-runs",
      "GET /api/v1/sports/matches",
      "GET /api/v1/sports/predictions",
      "GET /api/v1/sports/tickets",
      "GET /api/v1/sports/daily-tickets",
      "GET /api/v1/sports/performance",
      "GET /api/v1/sports/models",
      "GET /api/v1/sports/calibrations",
    ]),
    // The human-in-the-loop controls legacy's console carried, each behind its own
    // permission and each asserted below to be an endpoint the API really guards.
    elevated: Object.freeze([
      Object.freeze({ endpoint: "POST /api/v1/sports/tickets/:param/decision", permission: "sports.approve" }),
      Object.freeze({ endpoint: "POST /api/v1/sports/tickets/:param/settle", permission: "sports.settle" }),
    ]),
  }),
  Object.freeze({
    name: "lottery console",
    route: "/app/lottery",
    component: "LotteryConsoleView",
    file: "consoles.jsx",
    // The lottery module status is readable by any signed-in member, exactly as
    // legacy's was (`$this->requirePermission('system.authenticated')`), so it is
    // deliberately NOT the gate: the console renders draw, statistics, ticket and
    // performance reads, and every one of those needs `lottery.view`.
    gate: "GET /api/v1/lottery/health",
    endpoints: Object.freeze([
      "GET /api/v1/lottery/status",
      "GET /api/v1/lottery/health",
      "GET /api/v1/lottery/providers",
      "GET /api/v1/lottery/draws",
      "GET /api/v1/lottery/statistics/:param",
      "GET /api/v1/lottery/ai-decisions",
      "GET /api/v1/lottery/tickets",
      "GET /api/v1/lottery/performance",
      "GET /api/v1/lottery/models",
      "GET /api/v1/lottery/jobs",
      "POST /api/v1/lottery/tickets/:param/check",
    ]),
    elevated: Object.freeze([
      Object.freeze({ endpoint: "POST /api/v1/lottery/providers/check", permission: "lottery.manage" }),
      Object.freeze({ endpoint: "POST /api/v1/lottery/sync", permission: "lottery.manage" }),
    ]),
  }),
]);

/**
 * Every `api(...)` call in the client, as `METHOD path`.
 *
 * Template segments become `:param`, a `${query}` suffix is dropped (it is a
 * query string, not a path), and the method is read from the call's own options
 * so a GET cannot be checked against a POST route.
 */
function extractClientEndpoints(source) {
  const found = new Set();
  for (const call of source.matchAll(/api\(\s*(`[^`]*`|"[^"]*")\s*([^)]*)/g)) {
    const raw = call[1].slice(1, -1).replace(/\$\{[^}]*\}/g, "\u0001");
    const route = raw.replace(/([^/])\u0001/g, "$1").replace(/\u0001/g, ":param").replace(/\/+$/, "");
    const method = /method:\s*"([A-Z]+)"/.exec(call[2] || "")?.[1] || "GET";
    found.add(`${method} ${route}`);
  }
  return found;
}

/** Server-side inventory paths, normalized the same way (`:any` → `:param`). */
function normalizeServerPath(route) {
  return route.replace(/:[^/]+/g, ":param").replace(/\/+$/, "");
}

/** The route table in `App.jsx`. */
function extractClientRoutes(source) {
  const routes = [];
  for (const match of source.matchAll(/\{\s*path:\s*"([^"]+)"([^}]*)\}/g)) {
    const [, routePath, rest] = match;
    routes.push({
      path: routePath,
      permission: /permission:\s*"([^"]+)"/.exec(rest)?.[1] || null,
      requiresAuth: /requiresAuth:\s*true/.test(rest),
      guestOnly: /guestOnly:\s*true/.test(rest),
    });
  }
  return routes;
}

/** The navigation entries in `views.jsx`. */
function extractNavEntries(source) {
  const entries = [];
  for (const match of source.matchAll(/\{\s*to:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*permission:\s*(null|"([^"]+)")/g)) {
    entries.push({ to: match[1], label: match[2], permission: match[4] || null });
  }
  return entries;
}

/** The keys of the `MODULE_CARDS` map, and its literal text. */
function extractModuleCards(source) {
  const start = source.indexOf("const MODULE_CARDS = {");
  assert.ok(start > -1, "MODULE_CARDS must exist in views.jsx");
  const end = source.indexOf("\n};", start);
  assert.ok(end > start, "MODULE_CARDS must be a closed object literal");
  const literal = source.slice(start, end);
  const keys = [...literal.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*\{/gm)].map((match) => match[1]);
  return { keys, literal };
}

// ------------------------------------------------------------------ vocabularies

test("the client's pick-lists are the server's vocabularies, entry for entry", () => {
  assert.deepEqual([...CLIENT_TYPES], [...NOTIFICATION_TYPES], "notification types");
  assert.deepEqual([...CLIENT_SEVERITIES], [...NOTIFICATION_SEVERITIES], "notification severities");
  assert.equal(INBOX_LIMIT_MAX, INBOX_QUERY.limit.max, "inbox page size ceiling");
  assert.deepEqual([...AUDIT_SORTS], [...AUDIT_QUERY.sort.values], "audit sorts");
  assert.deepEqual([...AUDIT_DIRECTIONS], [...AUDIT_QUERY.direction.values], "audit directions");
  assert.equal(AUDIT_LIMIT_MAX, AUDIT_QUERY.limit.max, "audit page size ceiling");
  assert.deepEqual([...CLIENT_MARKET_CLASSES], [...PORTFOLIO_MARKET_CLASSES], "portfolio market classes");
  assert.deepEqual([...CLIENT_TIMEFRAMES], [...PORTFOLIO_TIMEFRAMES], "portfolio timeframes");
  assert.deepEqual([...CLIENT_OBJECTIVES], [...OBJECTIVES], "portfolio objectives");
  assert.equal(CLIENT_MIN_ASSETS, MIN_ASSETS, "minimum asset count");
  assert.equal(CLIENT_MAX_ASSETS, MAX_ASSETS, "maximum asset count");
  assert.equal(CLIENT_MIN_CANDLE_LIMIT, MIN_CANDLE_LIMIT, "minimum history depth");
  assert.equal(CLIENT_MAX_CANDLE_LIMIT, MAX_CANDLE_LIMIT, "maximum history depth");
});

// --------------------------------------------------------------------- endpoints

test("every endpoint the SPA calls exists in the served route inventory", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());

  const inventory = await instance.app.inject({ method: "GET", url: "/api/v1/system/routes" });
  assert.equal(inventory.statusCode, 200);
  const served = new Set(inventory.json().routes.map((route) => `${route.method} ${normalizeServerPath(route.path)}`));

  const declared = extractClientEndpoints(API_SOURCE);
  assert.ok(declared.size >= 20, `expected the whole SPA surface, found ${declared.size}`);

  const missing = [...declared].filter((entry) => !served.has(entry));
  assert.deepEqual(missing, [], `the SPA calls endpoints the server does not serve: ${missing.join(", ")}`);

  for (const screen of SCREENS) {
    for (const endpoint of [...screen.endpoints, ...(screen.elevated || []).map((entry) => entry.endpoint)]) {
      assert.ok(declared.has(endpoint), `${screen.name} must call ${endpoint}`);
      assert.ok(served.has(endpoint), `${screen.name} binds to ${endpoint}, which must be served`);
    }
  }

  // The audit browser is a read surface. A screen cannot reach a mutation of the
  // trail because no such route exists — this asserts the client does not try.
  for (const entry of declared) {
    if (entry.includes("/audit")) assert.match(entry, /^GET /, "the audit trail has no mutating client call");
  }
});

test("no screen is broader than the API behind it, and no permission is invented", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());

  const inventory = await instance.app.inject({ method: "GET", url: "/api/v1/system/routes" });
  const routes = inventory.json().routes;
  const servedBy = (method, route) => routes.find((entry) => entry.method === method && normalizeServerPath(entry.path) === route);

  const clientRoutes = extractClientRoutes(APP_SOURCE);
  const catalogue = new Set(PLATFORM_PERMISSIONS.map((permission) => permission.key));
  const sourceOf = (screen) => SCREEN_SOURCES[screen.file || "screens.jsx"];

  for (const screen of SCREENS) {
    const screenRoute = clientRoutes.find((entry) => entry.path === screen.route);
    assert.ok(screenRoute, `${screen.name} must be a declared route (${screen.route})`);
    assert.equal(screenRoute.requiresAuth, true, `${screen.name} is a signed-in surface`);

    const [method, endpoint] = screen.gate.split(" ");
    const serverRoute = servedBy(method, endpoint);
    assert.ok(serverRoute, `${screen.name}'s gate ${screen.gate} must be served`);
    assert.equal(serverRoute.auth, true, `${screen.name}'s endpoint requires a session`);

    if (screenRoute.permission) {
      assert.equal(
        screenRoute.permission,
        serverRoute.permission,
        `${screen.name} declares ${screenRoute.permission}; the API enforces ${serverRoute.permission}`,
      );
      assert.ok(catalogue.has(screenRoute.permission), `${screenRoute.permission} must exist in the seeded catalogue`);
    } else {
      assert.equal(
        serverRoute.permission,
        "system.authenticated",
        `${screen.name} declares no extra permission, so its API must need exactly the signed-in baseline`,
      );
    }

    // Elevated controls: each must be guarded by a real, distinct permission on the
    // API — and the screen must actually name that permission before rendering the
    // control, so the button and the server agree about who may press it.
    for (const entry of screen.elevated || []) {
      const [elevatedMethod, elevatedRoute] = entry.endpoint.split(" ");
      const elevatedServerRoute = servedBy(elevatedMethod, elevatedRoute);
      assert.ok(elevatedServerRoute, `${screen.name} binds to ${entry.endpoint}, which must be served`);
      assert.equal(
        elevatedServerRoute.permission,
        entry.permission,
        `${entry.endpoint} is declared as ${entry.permission}; the API enforces ${elevatedServerRoute.permission}`,
      );
      assert.ok(catalogue.has(entry.permission), `${entry.permission} must exist in the seeded catalogue`);
      assert.notEqual(entry.permission, serverRoute.permission, `${screen.name}: an elevated control must need more than the screen's own permission`);
      assert.ok(
        sourceOf(screen).includes(`"${entry.permission}"`) || sourceOf(screen).includes(`'${entry.permission}'`),
        `${screen.name} must name ${entry.permission} in the source that gates the control`,
      );
    }
  }

  // Every permission string the shell names — in a route guard or a nav entry —
  // must be one the platform seeds. A typo here would render a locked entry that
  // can never be unlocked.
  for (const entry of [...clientRoutes.filter((route) => route.permission), ...extractNavEntries(VIEWS_SOURCE).filter((nav) => nav.permission)]) {
    assert.ok(catalogue.has(entry.permission), `${entry.permission} is declared in the shell and must be in the catalogue`);
  }
});

test("the navigation offers the three screens, locked rather than hidden when refused", () => {
  const clientRoutes = extractClientRoutes(APP_SOURCE);
  const nav = extractNavEntries(VIEWS_SOURCE);

  for (const screen of SCREENS) {
    const navEntry = nav.find((entry) => entry.to === screen.route);
    assert.ok(navEntry, `${screen.name} must appear in the workspace navigation`);
    assert.ok(
      clientRoutes.some((entry) => entry.path === screen.route),
      `${navEntry.label} must point at a declared route`,
    );
    const screenRoute = clientRoutes.find((entry) => entry.path === screen.route);
    assert.equal(
      navEntry.permission,
      screenRoute.permission,
      `${navEntry.label}: the nav must lock exactly what the route guards`,
    );
    const source = SCREEN_SOURCES[screen.file || "screens.jsx"];
    assert.ok(source, `${screen.name} must name a screen module that exists`);
    assert.match(source, new RegExp(`export function ${screen.component}\\(`), `${screen.component} must be an exported screen`);
  }

  // A nav entry that matches no route would render the not-found view from a
  // menu item — the shell's own links must resolve.
  const declared = new Set([...clientRoutes.map((entry) => entry.path), "/app/"]);
  for (const entry of nav) {
    assert.ok(declared.has(entry.to), `${entry.label} points at ${entry.to}, which is not a declared route`);
  }
});

// ---------------------------------------------------------------- module ledger

test("the overview grid reads the module ledger instead of keeping its own copy", () => {
  const { keys, literal } = extractModuleCards(VIEWS_SOURCE);

  for (const module of MODULE_STATUS) {
    assert.ok(keys.includes(module.key), `module ${module.key} must have a card, or it disappears from the grid`);
  }
  assert.ok(keys.length >= MODULE_STATUS.length, "the grid covers every module the server reports");

  // The whole point of Phase 27's shell fix: the state comes from the server.
  // A card carrying its own `state:`/`ported`/`partial` word would drift again,
  // exactly as "Not yet ported to Node" did for sports and lottery after they
  // were ported.
  for (const forbidden of ["state:", "ported", "partial", "not-ported"]) {
    assert.ok(!literal.toLowerCase().includes(forbidden), `MODULE_CARDS must not hardcode "${forbidden}"`);
  }
  assert.match(VIEWS_SOURCE, /endpoints\.status\(\)/, "the grid fetches the server's module ledger");

  // The state words live in one mapping keyed by the server's vocabulary, so a
  // new state cannot be rendered as a colour with no explanation.
  const labelStart = VIEWS_SOURCE.indexOf("const STATE_LABEL = {");
  assert.ok(labelStart > -1, "STATE_LABEL must exist");
  const labelLiteral = VIEWS_SOURCE.slice(labelStart, VIEWS_SOURCE.indexOf("\n};", labelStart));
  for (const state of MODULE_STATUS.map((module) => module.state)) {
    assert.ok(labelLiteral.includes(state), `the state vocabulary must render "${state}"`);
  }
});

// ----------------------------------------------------------------- screens bind

test("the screens bind to the API's own facts rather than restating them", () => {
  // Delivery: the inbox states the absence of a transport using the server's
  // `deliveryChannels`, so the sentence cannot outlive the fact.
  assert.match(SCREENS_SOURCE, /deliveryChannels/, "the inbox reads the server's delivery channels");

  // Immutability: the audit browser renders the server's `mutable` flag.
  assert.match(SCREENS_SOURCE, /meta\.mutable/, "the audit browser renders the server's mutability flag");
  assert.match(SCREENS_SOURCE, /filters\?\.action|meta\.filters/, "the audit browser echoes the filters the server applied");

  // Research-only: the optimizer shows the server's `notice` and the provenance
  // of every input series instead of presenting generated prices as market data.
  assert.match(SCREENS_SOURCE, /result\?\.notice/, "the optimizer renders the server's research-only notice");
  assert.match(SCREENS_SOURCE, /provenance/, "the optimizer renders per-asset provenance");
  assert.match(SCREENS_SOURCE, /SIMULATION/, "a synthetic input is labelled on the screen");

  // The consoles render the module's own honesty surfaces rather than restating
  // them: the sports matrix travels in `/sports/status`, the lottery disclaimer and
  // matrix in `/lottery/status`, and the lottery performance sections stay separated
  // exactly as the API separates them.
  assert.match(CONSOLES_SOURCE, /report\.notPorted|report\?\.notPorted/, "the consoles render the module's not-ported matrix");
  assert.match(CONSOLES_SOURCE, /disclaimer/, "the lottery console renders the API's independence disclaimer");
  assert.match(CONSOLES_SOURCE, /actualTicketResults/, "the performance sections are rendered by the names the API uses");
  assert.match(CONSOLES_SOURCE, /demoBanner/, "the sports console renders the server's sandbox banner");

  // Every data source a screen touches must be a declared endpoint key: a screen
  // cannot invent a call, and renaming one in api.js breaks this test.
  const declaredKeys = new Set([...API_SOURCE.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*\(/gm)].map((match) => match[1]));
  assert.ok(declaredKeys.size > 0, "api.js must declare endpoint keys");
  for (const [file, source] of Object.entries(SCREEN_SOURCES)) {
    const usedKeys = new Set([...source.matchAll(/endpoints\.([a-zA-Z][a-zA-Z0-9]*)\(/g)].map((match) => match[1]));
    assert.ok(usedKeys.size > 0, `${file} must call the API client`);
    for (const key of usedKeys) {
      assert.ok(declaredKeys.has(key), `${file} calls endpoints.${key}, which api.js does not declare`);
    }
  }
});
