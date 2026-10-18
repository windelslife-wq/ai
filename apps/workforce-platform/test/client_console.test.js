/**
 * The workspace consoles against the API they call (rows 3, 5, 9 — Phase 29).
 *
 * A console is the one part of this platform that no server test can see: it is
 * JSX, it is bundled for a browser, and a mistake in it is invisible to
 * `npm test` until a person clicks the button. These tests close the two gaps that
 * actually break a screen in production, using only the real artefacts on both
 * sides:
 *
 *  1. **Vocabulary drift.** The optimizer console declares the market classes, the
 *     timeframes, the objectives and the request body it will send. The endpoint
 *     declares its own. Both are imported here — the client module is plain ESM
 *     with no JSX on purpose — and compared, so adding a market class to the API
 *     fails the suite until the console offers it, instead of producing a 400 a
 *     user discovers.
 *
 *  2. **Dead endpoints.** Every path the API client calls is checked against the
 *     route inventory the server itself reports (`GET /api/v1/system/routes`),
 *     which is derived from what each route declares. A client pointing at a path
 *     that no longer exists is a failing test rather than a broken page.
 *
 * What these tests do **not** claim: no browser rendered either console, and the
 * SPA's rendered output is not asserted. Phase 28 and Phase 29 both say so.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  ALLOCATION_ROWS, MARKET_CLASSES, OBJECTIVES, TIMEFRAMES, buildOptimizeBody, defaultForm,
  formatNumber, formatPercent, isSimulation, provenanceLabel, validateOptimizeForm,
} from "../client/src/portfolio.js";
import {
  MAX_ASSETS, MIN_ASSETS, OPTIMIZE_BODY, PORTFOLIO_MARKET_CLASSES, PORTFOLIO_TIMEFRAMES,
} from "../src/modules/portfolio/contracts.js";
import { OBJECTIVES as SERVER_OBJECTIVES } from "../src/modules/portfolio/optimizer.js";
import { MAX_CANDLE_LIMIT, MIN_CANDLE_LIMIT } from "../src/modules/portfolio/service.js";
import { createFileStoreApp } from "./helpers.js";

const CLIENT = path.resolve(import.meta.dirname, "..", "client", "src");

// ------------------------------------------------------------- vocabulary parity

test("the console offers exactly the market classes, timeframes and objectives the endpoint accepts", () => {
  // Sets, not sequences: the service lists `forex` first (its canonical order) while
  // the console keeps the legacy view's display order, which puts Crypto first
  // because that is the seeded default. A *missing* class is the failure this
  // guards — the order is presentation and is asserted where it belongs, below.
  assert.deepEqual(
    [...MARKET_CLASSES.map((entry) => entry.value)].sort(),
    [...PORTFOLIO_MARKET_CLASSES].sort(),
    "src/modules/portfolio/service.js PORTFOLIO_MARKET_CLASSES must drive the console's select",
  );
  assert.deepEqual(
    MARKET_CLASSES.map((entry) => entry.value),
    ["crypto", "forex", "commodity", "stock", "etf", "futures", "options", "indices", "bonds"],
    "the console keeps views/portfolio/optimizer.php's option order so the screen looks the same after cutover",
  );
  assert.deepEqual(
    [...TIMEFRAMES.map((entry) => entry.value)].sort(),
    [...PORTFOLIO_TIMEFRAMES].sort(),
    "the console's timeframe select must offer the service's four timeframes",
  );
  assert.deepEqual(
    TIMEFRAMES.map((entry) => entry.value),
    ["1d", "4h", "1h", "15m"],
    "the console keeps the legacy view's order (longest bar first, 1 day selected)",
  );
  assert.deepEqual(
    OBJECTIVES.map((entry) => entry.value),
    [...SERVER_OBJECTIVES],
    "the console's objective select must match the optimizer's two objectives",
  );
  // Labels are for humans, but a duplicate value would render two options that
  // submit differently-looking identical bodies.
  for (const list of [MARKET_CLASSES, TIMEFRAMES, OBJECTIVES]) {
    assert.equal(new Set(list.map((entry) => entry.value)).size, list.length);
    assert.ok(list.every((entry) => entry.value && entry.label), "every option needs a value and a label");
  }
});

test("the console's numeric bounds are the endpoint's own, not a second set that can drift", () => {
  const form = defaultForm();
  assert.equal(form.limit, 365, "the legacy screen's default history depth");
  assert.ok(form.limit >= MIN_CANDLE_LIMIT && form.limit <= MAX_CANDLE_LIMIT, `${form.limit} must be a legal limit`);

  // The pre-flight must refuse what the route schema refuses: below the minimum,
  // above the maximum, and a non-integer.
  for (const limit of [MIN_CANDLE_LIMIT - 1, MAX_CANDLE_LIMIT + 1, 31.5, "many"]) {
    const problems = validateOptimizeForm({ ...form, limit });
    assert.ok(problems.some((problem) => problem.field === "limit"), `limit ${limit} must be refused before the request`);
  }
  for (const limit of [MIN_CANDLE_LIMIT, 365, MAX_CANDLE_LIMIT]) {
    assert.deepEqual(
      validateOptimizeForm({ ...form, limit }).filter((problem) => problem.field === "limit"),
      [],
      `limit ${limit} is legal and must not be refused`,
    );
  }
  assert.equal(MIN_ASSETS, 2);
  assert.equal(MAX_ASSETS, 12);
});

// ------------------------------------------------------------- the request body

test("the built body carries only properties the endpoint declares", () => {
  const allowed = new Set(Object.keys(OPTIMIZE_BODY.properties));
  const body = buildOptimizeBody({
    ...defaultForm(),
    limit: "365",
    maxWeight: "0.6",
    riskFreeRatePct: "4",
    periodsPerYear: "252",
  });
  for (const key of Object.keys(body)) {
    assert.ok(allowed.has(key), `${key} is not a declared property of OPTIMIZE_BODY — additionalProperties:false refuses it`);
  }
  for (const required of OPTIMIZE_BODY.required) {
    assert.ok(required in body, `${required} is required by the schema and must always be sent`);
  }

  // The structural half of "this screen cannot trade": the body has no way to say
  // an amount, an account or an order. Asserted as an absence, so a future edit
  // that adds one fails here rather than at the risk review.
  for (const forbidden of ["execute", "amount", "orderId", "notional", "accountId", "side", "quantity"]) {
    assert.ok(!(forbidden in body), `${forbidden} must never appear in an optimization body`);
  }
});

test("risk-free rate is converted to the annual decimal the API expects", () => {
  const zero = buildOptimizeBody({ ...defaultForm(), riskFreeRatePct: "0" });
  assert.equal(zero.riskFreeRate, 0);
  const four = buildOptimizeBody({ ...defaultForm(), riskFreeRatePct: "4" });
  assert.equal(four.riskFreeRate, 0.04, "4% must reach the API as 0.04, not 4");
  const negative = buildOptimizeBody({ ...defaultForm(), riskFreeRatePct: "-2.5" });
  assert.equal(negative.riskFreeRate, -0.025);
  // A blank field means "no risk-free rate", which the service defaults to 0 — sent
  // as an explicit 0 rather than omitted, because 0 is also a legal provided value.
  assert.equal(buildOptimizeBody({ ...defaultForm(), riskFreeRatePct: "" }).riskFreeRate, 0);
});

test("periodsPerYear is omitted unless it was given, and symbols are normalised the way the service does", () => {
  const auto = buildOptimizeBody({ ...defaultForm(), periodsPerYear: "" });
  assert.ok(!("periodsPerYear" in auto), "a blank override must be omitted so the service infers it");

  const explicit = buildOptimizeBody({ ...defaultForm(), periodsPerYear: "365" });
  assert.equal(explicit.periodsPerYear, 365);

  const body = buildOptimizeBody({
    ...defaultForm(),
    allowSyntheticData: "yes",
    assets: [{ symbol: "  btcusdt ", marketClass: "CRYPTO" }, { symbol: "eurusd", marketClass: "forex" }],
  });
  assert.deepEqual(body.assets, [
    { symbol: "BTCUSDT", marketClass: "crypto" },
    { symbol: "EURUSD", marketClass: "forex" },
  ]);
  assert.equal(body.allowSyntheticData, false, "only a strict true opts into a simulation");
  assert.equal(buildOptimizeBody({ ...defaultForm(), allowSyntheticData: true }).allowSyntheticData, true);
});

// ------------------------------------------------------------- the pre-flight

test("the pre-flight catches the refusals a person can fix, and never invents a stricter rule", () => {
  const form = defaultForm();

  // Universe size.
  assert.ok(validateOptimizeForm({ ...form, assets: [{ symbol: "BTCUSDT", marketClass: "crypto" }] })
    .some((problem) => problem.field === "assets"));
  assert.ok(validateOptimizeForm({
    ...form,
    assets: Array.from({ length: MAX_ASSETS + 1 }, (_, index) => ({ symbol: `SYM${index}`, marketClass: "crypto" })),
  }).some((problem) => problem.field === "assets"));

  // Symbols: empty, too short for the schema's minLength of 2, and not in the
  // allowed alphabet — all three would be a 400 after a provider fan-out otherwise.
  assert.ok(validateOptimizeForm({ ...form, assets: [{ symbol: "", marketClass: "crypto" }, { symbol: "E", marketClass: "crypto" }] })
    .some((problem) => problem.field === "assets.0.symbol"));
  assert.ok(validateOptimizeForm({ ...form, assets: [{ symbol: "BTC USDT", marketClass: "crypto" }, { symbol: "ETHUSDT", marketClass: "crypto" }] })
    .some((problem) => problem.field === "assets.0.symbol"));

  // Duplicates: the service refuses `duplicate asset symbol`, and the two would
  // otherwise be merged into one column of a covariance matrix.
  const duplicate = validateOptimizeForm({ ...form, assets: [{ symbol: "btcusdt", marketClass: "crypto" }, { symbol: "BTCUSDT", marketClass: "crypto" }] });
  assert.ok(duplicate.some((problem) => /listed twice/.test(problem.message)), "a duplicate must be caught case-insensitively");

  // The cap floor is 1/n and the schema cannot know n, so the solver refuses it —
  // the console says the same thing with the count filled in.
  const capped = validateOptimizeForm({ ...form, maxWeight: "0.4" });
  assert.ok(capped.some((problem) => problem.field === "maxWeight" && /at least 0\.5000/.test(problem.message)));
  assert.deepEqual(validateOptimizeForm({ ...form, maxWeight: "0.5" }), [], "0.5 is legal for two assets and must pass");

  // Mixed calendars: crypto trades 365 days, forex roughly 252. The service refuses
  // without an explicit periodsPerYear rather than averaging the two.
  const mixed = validateOptimizeForm({
    ...form,
    assets: [{ symbol: "BTCUSDT", marketClass: "crypto" }, { symbol: "EURUSD", marketClass: "forex" }],
  });
  assert.ok(mixed.some((problem) => problem.field === "periodsPerYear"), "a mixed universe must ask for periodsPerYear");
  assert.deepEqual(
    validateOptimizeForm({ ...form, periodsPerYear: "252" }),
    [],
    "a single class with an explicit factor passes",
  );

  // The default form is sendable as it opens: a console whose first click is a
  // validation error teaches the wrong lesson about its own defaults.
  assert.deepEqual(validateOptimizeForm(defaultForm()), []);
});

// ------------------------------------------------------------- report rendering

test("report formatting never renders a fabricated number", () => {
  assert.equal(formatPercent(0.0412), "4.12%");
  assert.equal(formatPercent(null), "—", "a missing figure is an em dash, never 0%");
  assert.equal(formatPercent(undefined), "—");
  assert.equal(formatPercent("not a number"), "—");
  assert.equal(formatPercent(0), "0.00%", "a real zero still renders as a zero");

  assert.equal(formatNumber(1.23456, 3), "1.235");
  assert.equal(formatNumber(null, 3), "—", "a Sharpe ratio with no volatility is null, not zero");
  assert.equal(formatNumber(0, 4), "0.0000");
  assert.equal(formatNumber(undefined), "—");

  assert.equal(isSimulation({ dataProvenance: [{ synthetic: true }] }), true);
  assert.equal(isSimulation({ dataProvenance: [{ synthetic: false }] }), false);
  assert.equal(isSimulation({}), false);
  assert.equal(isSimulation(null), false);

  assert.equal(provenanceLabel(null), "unknown");
  assert.equal(provenanceLabel({ source: "binance", synthetic: false, stale: false }), "binance");
  assert.match(provenanceLabel({ source: "sandbox", synthetic: true }), /sandbox · SIMULATION/);
  assert.match(provenanceLabel({ source: "binance", validation: { gapCount: 2 } }), /2 gaps/);
});

test("the comparison table reads the report's own allocation keys", () => {
  // `allocations` is keyed by the optimizer's own names; a console renaming one
  // would silently render three rows for four published allocations.
  assert.deepEqual(
    ALLOCATION_ROWS.map((row) => row.key),
    ["selected", "minimumVariance", "maximumSharpe", "equalWeightBenchmark"],
  );
});

// ------------------------------------------------------------- live route inventory

test("every endpoint the workspace client calls exists in the server's own route inventory", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: { MARKET_DATA_ALLOW_SYNTHETIC: "1" } } });
  t.after(() => instance.cleanup());

  const inventoryResponse = await instance.app.inject({ method: "GET", url: "/api/v1/system/routes" });
  assert.equal(inventoryResponse.statusCode, 200);
  const inventory = inventoryResponse.json().routes;
  const known = new Set(inventory.map((route) => `${route.method} ${route.path}`));

  // Read the client from disk rather than importing it: api.js is browser code with
  // `import.meta.env` in it, and what is under test is the literal path each call
  // is built from — the exact string that reaches the network.
  const source = readFileSync(path.join(CLIENT, "api.js"), "utf8");
  const calls = [...source.matchAll(/api\(\s*[`"](\/api\/[^`"$]*)/g)];
  assert.ok(calls.length >= 20, `expected the client to declare its endpoints, found ${calls.length}`);

  const unresolved = [];
  for (const call of calls) {
    const literal = call[1].split("?", 1)[0];
    // Query strings (including a dynamic `?symbol=${...}`) are not part of the
    // registered route path. `/api/v1/account/activity${query}` and
    // `/api/v1/notifications/${id}/read` are templates too: check the fixed path
    // against the inventory so each parameterised endpoint still has to exist.
    const exact = known.has(`GET ${literal}`) || known.has(`POST ${literal}`)
      || inventory.some((route) => route.path.startsWith(literal));
    if (!exact) unresolved.push(literal);
  }
  assert.deepEqual(unresolved, [], "a console calling a path the server does not register is a dead screen");

  // The optimizer console's own call, checked for method and authority rather than
  // just existence: the screen exists, so the route it drives must be the guarded
  // POST the console is written against.
  const optimize = inventory.find((route) => route.path === "/api/v1/portfolio/optimize");
  assert.equal(optimize.method, "POST");
  assert.equal(optimize.auth, true, "a session is required");
  assert.equal(optimize.permission, "trading.view");
  assert.ok(source.includes('"/api/v1/portfolio/optimize"'), "the client must target the versioned path (divergence PO-5)");
});

test("every declared workspace path is reachable as a deep link, not only by in-app navigation", async (t) => {
  const instance = await createFileStoreApp();
  t.after(() => instance.cleanup());

  // `public/app/` is generated and git-ignored, and a deep link is a 404 without it by
  // design — so say that before asserting 200, or a fresh checkout reads as a routing
  // bug. CI builds the client before this suite; locally, `npm run build:client`.
  assert.ok(existsSync(path.resolve(CLIENT, "..", "..", "public", "app", "index.html")), "the built SPA shell is required: npm run build:client");

  const app = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  const declared = [...app.matchAll(/path:\s*"(\/app[^"]*)"/g)].map((match) => match[1]);
  assert.ok(declared.includes("/app/portfolio/optimizer"), "the console must be a declared route");
  assert.ok(declared.length >= 9, `expected the shell's declared surfaces, found ${declared.length}`);

  // A route that only works when clicked is a screen a bookmark, a refresh or a
  // pasted link cannot reach — and the failure is a 404 from the static handler,
  // which reads as "this console does not exist" rather than as a routing bug.
  for (const path of declared) {
    const html = await instance.app.inject({ method: "GET", url: path, headers: { accept: "text/html" } });
    assert.equal(html.statusCode, 200, `${path} must answer the SPA shell for a browser navigation`);
    assert.match(html.headers["content-type"] || "", /text\/html/, `${path} must be served as HTML`);
  }

  // The fallback stays narrow: a non-browser client asking for the same path does
  // not get the shell, so an API caller cannot mistake a page for data.
  const json = await instance.app.inject({ method: "GET", url: "/app/portfolio/optimizer", headers: { accept: "application/json" } });
  assert.notEqual(json.statusCode, 200, "the SPA fallback requires an HTML accept header");
});

test("the optimizer console is declared as a permission-gated route with a locked navigation entry", () => {
  const app = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  const views = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");

  const route = app.match(/\{[^{}]*path:\s*"\/app\/portfolio\/optimizer"[^{}]*\}/);
  assert.ok(route, "the console must be a declared exact-path route, not reachable by wildcard");
  assert.match(route[0], /requiresAuth:\s*true/);
  assert.match(route[0], /permission:\s*"trading\.view"/, "the same gate the API and the legacy page used");
  assert.match(app, /"portfolio-optimizer":\s*<PortfolioOptimizerView/, "the route must resolve to a view, or it renders blank");

  const nav = views.match(/\{[^{}]*to:\s*"\/app\/portfolio\/optimizer"[^{}]*\}/);
  assert.ok(nav, "the console needs a navigation entry");
  assert.match(nav[0], /permission:\s*"trading\.view"/, "an entry without its permission would look open to a role that is refused");

  // The permission literal used by the console must be the one the guards module
  // actually checks — a typo in a string literal is a screen that 403s forever.
  const guards = readFileSync(path.resolve(import.meta.dirname, "..", "src", "modules", "portfolio", "routes.js"), "utf8");
  assert.match(guards, /requirePermission\(\s*"trading\.view"/);
});
