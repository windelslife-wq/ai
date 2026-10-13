/**
 * The console screens (Phase 27, row 3 of `docs/migration/UNFINISHED_MODULES.md`).
 *
 * Finding **F-29** said no ported module had a console screen. Phase 27 built the
 * first three — the notification inbox, the audit browser and the research-only
 * portfolio optimizer — and this file is the evidence that a screen cannot drift
 * away from the API it claims to render:
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

/** The three screens this phase built, and the endpoint each one is bound to. */
const SCREENS = Object.freeze([
  Object.freeze({
    name: "notification inbox",
    route: "/app/notifications",
    component: "NotificationsView",
    endpoints: Object.freeze(["GET /api/v1/notifications", "POST /api/v1/notifications/:param/read", "POST /api/v1/notifications/read-all"]),
  }),
  Object.freeze({
    name: "audit browser",
    route: "/app/admin/audit",
    component: "AuditBrowserView",
    endpoints: Object.freeze(["GET /api/v1/admin/audit"]),
  }),
  Object.freeze({
    name: "portfolio optimizer",
    route: "/app/portfolio/optimizer",
    component: "PortfolioOptimizerView",
    endpoints: Object.freeze(["POST /api/v1/portfolio/optimize"]),
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
    for (const endpoint of screen.endpoints) {
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

  for (const screen of SCREENS) {
    const screenRoute = clientRoutes.find((entry) => entry.path === screen.route);
    assert.ok(screenRoute, `${screen.name} must be a declared route (${screen.route})`);
    assert.equal(screenRoute.requiresAuth, true, `${screen.name} is a signed-in surface`);

    const [method, endpoint] = screen.endpoints[0].split(" ");
    const serverRoute = servedBy(method, endpoint);
    assert.ok(serverRoute, `${screen.name}'s endpoint ${screen.endpoints[0]} must be served`);
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
    assert.match(SCREENS_SOURCE, new RegExp(`export function ${screen.component}\\(`), `${screen.component} must be an exported screen`);
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

  // Every data source a screen touches must be a declared endpoint key: a screen
  // cannot invent a call, and renaming one in api.js breaks this test.
  const declaredKeys = new Set([...API_SOURCE.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*\(/gm)].map((match) => match[1]));
  const usedKeys = new Set([...SCREENS_SOURCE.matchAll(/endpoints\.([a-zA-Z][a-zA-Z0-9]*)\(/g)].map((match) => match[1]));
  assert.ok(usedKeys.size > 0, "the screens must call the API client");
  for (const key of usedKeys) {
    assert.ok(declaredKeys.has(key), `screens.jsx calls endpoints.${key}, which api.js does not declare`);
  }
});
