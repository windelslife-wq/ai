/**
 * The lottery consoles against the API and the engine behind them (row 15, Phase 30).
 *
 * `test/client_console.test.js` established the pattern for the optimizer screen:
 * import the console's plain-ESM module and the server's own contract, and let a
 * drift fail the suite. This file does the same for the lottery console, with one
 * difference that matters — the lottery engine *validates its own vocabulary at
 * runtime* rather than declaring it in a schema (a mode or strategy name is checked
 * inside the generator/backtester), so the check here is behavioural:
 *
 *   - every statistic kind the console offers is requested from the live API,
 *   - every generator mode it offers is used to generate a real report,
 *   - every backtest strategy it offers is run for real,
 *   - and an unknown value of each is asserted to be refused, so the console's list
 *     is proven to be the accepted one rather than merely a working subset.
 *
 * The normalisers are tested against **real payloads** fetched in the same run:
 * a table built from an empty fixture would pass while the mapping was wrong.
 *
 * No browser rendered either screen. Phase 30 says so.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  BACKTEST_STRATEGIES, GENERATOR_MODES, STATISTICS_KINDS, buildAnalyzeQuery, buildBacktestBody,
  buildCompareBody, buildGenerateBody, buildTicketBody, distributionMetrics, drawNumbers, formatCount,
  formatDate, formatNumber, generatedLineText, listToText, matchDistribution, parseNumberList,
  parseTicketLines, providerTone, statisticsRows, tierRows, validateAnalyzeForm, validateGenerateForm,
  verificationTone,
} from "../client/src/lottery.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";
import { GENERATOR_MODES as ENGINE_MODES } from "../src/modules/lottery/generator.js";
import { BACKTESTER_STRATEGIES as ENGINE_STRATEGIES } from "../src/modules/lottery/backtester.js";

const CLIENT = path.resolve(import.meta.dirname, "..", "client", "src");

async function sandboxInstance(t) {
  const instance = await createFileStoreApp({ configOverrides: { env: { WINDELS_LOTTERY_SANDBOX: "1" } } });
  t.after(() => instance.cleanup());
  const login = await instance.app.inject({
    method: "POST", url: "/api/v1/auth/login",
    payload: { identifier: "rootadmin", password: "Root administrator pass" },
  });
  assert.equal(login.statusCode, 200, login.body);
  return {
    ...instance,
    headers: { cookie: cookieFrom(login), "x-csrf-token": login.json().csrfToken },
  };
}

const get = (instance, url) => instance.app.inject({ method: "GET", url, headers: instance.headers });
const post = (instance, url, payload) => instance.app.inject({ method: "POST", url, headers: instance.headers, payload });

// -------------------------------------------------------------- vocabulary, live

test("every statistic kind the console offers is accepted by the live API, and an unknown kind is refused", async (t) => {
  const instance = await sandboxInstance(t);
  await post(instance, "/api/v1/lottery/sync", { limit: 40 });

  for (const kind of STATISTICS_KINDS) {
    const response = await get(instance, `/api/v1/lottery/statistics/${kind.value}?window=40`);
    assert.equal(response.statusCode, 200, `${kind.value} must be a served statistic: ${response.body}`);
    assert.equal(response.json().kind, kind.value);
  }

  const unknown = await get(instance, "/api/v1/lottery/statistics/clairvoyance");
  assert.equal(unknown.statusCode, 400, "a kind the engine does not implement must be refused, not answered from thin air");
  // The route declares its own enum, so the refusal names every kind it does serve —
  // the console's list is that list, checked above.
  assert.equal(unknown.json().error.code, "INVALID_REQUEST");
  assert.match(unknown.json().error.message, /kind must be one of/);
  assert.equal(new Set(STATISTICS_KINDS.map((entry) => entry.value)).size, STATISTICS_KINDS.length);
});

test("the console's modes and strategies are the engine's own lists, not a second vocabulary", () => {
  // The same rule as the optimizer console's contract test: the two lists are
  // compared as SETS, because the engine's order is its error-message order and the
  // console's is reading order — a *missing* value is what must fail here. The
  // spelling matters too: the generator's is `ANTI-POPULAR` while the backtester's
  // strategy of the same name is `ANTI_POPULAR`, and the console must not "fix" one
  // into the other (it did once — this assertion is why it cannot again).
  assert.deepEqual(
    [...GENERATOR_MODES.map((entry) => entry.value)].sort(),
    [...ENGINE_MODES].sort(),
    "src/modules/lottery/generator.js GENERATOR_MODES must drive the console's mode select",
  );
  assert.deepEqual(
    [...BACKTEST_STRATEGIES.map((entry) => entry.value)].sort(),
    [...ENGINE_STRATEGIES].sort(),
    "src/modules/lottery/backtester.js BACKTESTER_STRATEGIES must drive the Strategy Lab's strategy select",
  );
  assert.ok(GENERATOR_MODES.some((entry) => entry.value === "ANTI-POPULAR"), "the engine spells the generator mode with a hyphen");
  assert.ok(BACKTEST_STRATEGIES.some((entry) => entry.value === "ANTI_POPULAR"), "the backtester spells its strategy with an underscore");
});

test("every generator mode the console offers generates a real report, and an unknown mode is refused", async (t) => {
  const instance = await sandboxInstance(t);
  await post(instance, "/api/v1/lottery/sync", { limit: 40 });

  for (const mode of GENERATOR_MODES) {
    const response = await post(instance, "/api/v1/lottery/generate", { mode: mode.value, count: 1, seed: 11 });
    assert.equal(response.statusCode, 200, `${mode.value} must generate: ${response.body}`);
    const report = response.json();
    assert.equal(report.mode, mode.value, "the stored report must name the mode that produced it");
    assert.ok(report.saved?.combinationId > 0 && report.saved?.decisionId > 0, "a generation is stored with its report");
    assert.equal(report.lines.length, 1);
    assert.ok(report.lines[0].mains.length === 5 && report.lines[0].stars.length === 2);
  }

  const unknown = await post(instance, "/api/v1/lottery/generate", { mode: "ALCHEMY", count: 1 });
  assert.equal(unknown.statusCode, 400, "an unimplemented mode must be refused");
  assert.equal(unknown.json().error.code, "LOTTERY_INVALID_ARGUMENT");
  assert.match(unknown.json().error.message, /unknown generation mode: ALCHEMY/);
});

test("every backtest strategy the console offers runs, and the comparison always carries the mandatory baseline", async (t) => {
  const instance = await sandboxInstance(t);
  await post(instance, "/api/v1/lottery/sync", { limit: 40 });

  for (const strategy of BACKTEST_STRATEGIES) {
    const response = await post(instance, "/api/v1/lottery/backtest", { strategy: strategy.value, lines: 1, window: 20 });
    assert.equal(response.statusCode, 200, `${strategy.value} must run: ${response.body}`);
    assert.equal(response.json().strategy, strategy.value);
    assert.equal(response.json().label, "HISTORICAL SIMULATION", "a replay of the past must label itself as one");
  }

  const bogus = await post(instance, "/api/v1/lottery/backtest", { strategy: "BOGUS" });
  assert.equal(bogus.statusCode, 400, "an unknown strategy must be refused by the engine, not defaulted");
  assert.match(bogus.json().error.message, /unknown strategy: BOGUS/);

  // A comparison without the baseline is refused outright by the engine (spec §25),
  // so the console's builder has to inject it — otherwise the screen's Compare button
  // is a guaranteed 400 for anyone who unticked the box.
  const baselineFree = await post(instance, "/api/v1/lottery/backtest-compare", { strategies: ["BALANCED_PROFILE"], lines: 1, window: 20 });
  assert.equal(baselineFree.statusCode, 400, "the engine refuses a comparison that omits its own reference");
  assert.match(baselineFree.json().error.message, /random baseline must be part of every comparison/);

  const comparison = await post(instance, "/api/v1/lottery/backtest-compare", buildCompareBody({ strategies: ["BALANCED_PROFILE"], lines: "1", window: "20" }));
  assert.equal(comparison.statusCode, 200, comparison.body);
  const body = comparison.json();
  const names = body.strategies.map((entry) => entry.strategy);
  assert.deepEqual(names.sort(), ["BALANCED_PROFILE", "RANDOM_BASELINE"], "the builder's injection is what makes the call legal");
  assert.ok(body.strategies.every((entry) => entry.label === "HISTORICAL SIMULATION"), "no comparison may read as a prediction");
});

// ------------------------------------------------------------- request assembly

test("the console's bodies carry only what the endpoints accept", async (t) => {
  const instance = await sandboxInstance(t);
  await post(instance, "/api/v1/lottery/sync", { limit: 40 });

  // generate: blank seed and empty pools are *omitted*, so the engine's own defaults
  // apply instead of being shadowed by values the console invented.
  const minimal = buildGenerateBody({ mode: "BALANCED", count: 2, seed: "", locks: "", excludes: "" });
  assert.deepEqual(minimal, { mode: "BALANCED", count: 2 });
  assert.equal((await post(instance, "/api/v1/lottery/generate", minimal)).statusCode, 200);

  const full = buildGenerateBody({ mode: "BALANCED", count: 1, seed: "5", locks: "7, 21", excludes: "13" });
  assert.deepEqual(full, { mode: "BALANCED", count: 1, seed: 5, locks: { mains: [7, 21] }, excludes: { mains: [13] } });
  const locked = await post(instance, "/api/v1/lottery/generate", full);
  assert.equal(locked.statusCode, 200, locked.body);
  const lockedReport = locked.json();
  // Regression: the route declared these as keyless objects, and the body validator
  // keeps only declared keys, so `{mains: [7, 21]}` reached the engine as `{}` — the
  // lock was accepted and ignored. `test/lottery_combinations_http.test.js` pins the
  // server side; this pins the console's own body against a fixed server.
  assert.deepEqual(lockedReport.inputs.locks, { mains: [7, 21], stars: [] }, "a lock the console sends must reach the engine");
  assert.deepEqual(lockedReport.inputs.excludes, { mains: [13], stars: [] });
  for (const generated of lockedReport.lines) {
    assert.ok(generated.mains.includes(7) && generated.mains.includes(21), "locked numbers must be in every line");
    assert.ok(!generated.mains.includes(13), "excluded numbers must be absent");
  }

  // backtest: a zero/blank window is omitted rather than sent, because 0 is legacy's
  // "use the engine's default" and sending it as a number must not change that.
  assert.deepEqual(buildBacktestBody({ strategy: "RANDOM_BASELINE", lines: "", window: "" }), { strategy: "RANDOM_BASELINE" });
  assert.deepEqual(buildBacktestBody({ strategy: "RANDOM_BASELINE", lines: "2", window: "25" }), { strategy: "RANDOM_BASELINE", lines: 2, window: 25 });
  assert.equal((await post(instance, "/api/v1/lottery/backtest", buildBacktestBody({ strategy: "RANDOM_BASELINE", lines: "", window: "" }))).statusCode, 200);

  // compare: whichever strategies the form holds, the baseline is injected once.
  const compare = buildCompareBody({ strategies: ["RANDOM_BASELINE", "ANTI_POPULAR", "ANTI_POPULAR"], lines: 1, window: 20 });
  assert.deepEqual(compare.strategies, ["RANDOM_BASELINE", "ANTI_POPULAR"]);
  assert.equal((await post(instance, "/api/v1/lottery/backtest-compare", compare)).statusCode, 200);

  // tickets: the body is a record of numbers and a name, and nothing else. Asserted as
  // an absence, so a future edit that adds a price, a payment or an order fails here.
  const ticketBody = buildTicketBody({ name: "Console ticket", drawDate: "" }, {
    lines: [{ mains: [1, 2, 3, 4, 5], stars: [1, 2] }],
  });
  assert.deepEqual(Object.keys(ticketBody).sort(), ["generationMethod", "lines", "name"]);
  for (const forbidden of ["amount", "price", "payment", "orderId", "purchase", "quantity"]) {
    assert.ok(!(forbidden in ticketBody), `${forbidden} must never appear in a ticket body — the platform cannot buy a ticket`);
  }
  const created = await post(instance, "/api/v1/lottery/tickets", ticketBody);
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().ticket.status, "OPEN");
});

test("the line analyzer pre-flight matches the rules the console reads from the status route", () => {
  const rules = { main: { count: 5 }, stars: { count: 2 } };
  assert.deepEqual(validateAnalyzeForm({ mains: "1,2,3,4,5", stars: "1,2" }, rules), []);
  assert.ok(validateAnalyzeForm({ mains: "1,2,3,4", stars: "1,2" }, rules).some((problem) => problem.field === "mains"));
  assert.ok(validateAnalyzeForm({ mains: "1,2,3,4,5", stars: "1" }, rules).some((problem) => problem.field === "stars"));
  assert.ok(validateAnalyzeForm({ mains: "one,two", stars: "1,2" }, rules).some((problem) => problem.field === "mains"));
  assert.equal(buildAnalyzeQuery({ mains: "1,2,3,4,5", stars: "1,2" }), "?mains=1%2C2%2C3%2C4%2C5&stars=1%2C2");
  assert.equal(buildAnalyzeQuery({ mains: "", stars: "" }), "", "an empty form must not send empty pools");
});

test("the generator pre-flight refuses what the engine would refuse, and accepts the console's own defaults", () => {
  assert.deepEqual(validateGenerateForm({ mode: "RANDOM", count: 1, seed: "", locks: "", excludes: "" }), []);
  assert.ok(validateGenerateForm({ mode: "RANDOM", count: 0, seed: "", locks: "", excludes: "" }).some((problem) => problem.field === "count"));
  assert.ok(validateGenerateForm({ mode: "RANDOM", count: "many", seed: "", locks: "", excludes: "" }).some((problem) => problem.field === "count"));
  assert.ok(validateGenerateForm({ mode: "ALCHEMY", count: 1, seed: "", locks: "", excludes: "" }).some((problem) => problem.field === "mode"));
  assert.ok(validateGenerateForm({ mode: "RANDOM", count: 1, seed: "1.5", locks: "", excludes: "" }).some((problem) => problem.field === "seed"));
  assert.ok(validateGenerateForm({ mode: "RANDOM", count: 1, seed: "", locks: "seven", excludes: "" }).some((problem) => problem.field === "locks"));
});

test("ticket lines parse strictly: a row without a separator is a problem, never a guess", () => {
  const ok = parseTicketLines("1,2,3,4,5 | 1,2\n 10 20 30 40 50|3 4 \n");
  assert.deepEqual(ok.lines, [
    { mains: [1, 2, 3, 4, 5], stars: [1, 2] },
    { mains: [10, 20, 30, 40, 50], stars: [3, 4] },
  ]);
  assert.deepEqual(ok.problems, []);

  const missing = parseTicketLines("1,2,3,4,5");
  assert.equal(missing.lines.length, 0);
  assert.match(missing.problems[0], /exactly one "\|"/);

  const double = parseTicketLines("1,2,3,4,5 | 1 | 2");
  assert.equal(double.lines.length, 0);
  assert.equal(parseTicketLines("").problems.length, 1, "an empty ticket is a problem, not a valid empty ticket");
  assert.equal(parseTicketLines("1,2,3,4,5 | 1,two").problems.length, 1);
  assert.deepEqual(parseNumberList(""), [], "a blank list is an empty list, not a parse failure");
  assert.deepEqual(parseNumberList("7, 21"), [7, 21]);
  assert.equal(parseNumberList("7, twenty"), null, "a word in a number list is a problem, never a dropped entry");
});

// ------------------------------------------------------------ normalisers, on real payloads

test("the statistics normalisers turn the API's real payloads into complete tables", async (t) => {
  const instance = await sandboxInstance(t);
  await post(instance, "/api/v1/lottery/sync", { limit: 40 });

  // The endpoint populates the whole number pool, so a mapping that dropped rows
  // would show here rather than in a browser.
  for (const [kind, expectedRows] of [["numbers", 50], ["stars", 12]]) {
    const payload = (await get(instance, `/api/v1/lottery/statistics/${kind}?window=40`)).json();
    const table = statisticsRows(kind, payload.data);
    assert.equal(table.rows.length, expectedRows, `${kind} must list every entry in the pool`);
    for (const row of table.rows) {
      assert.equal(row.length, table.columns.length, "every row must fill every column");
      assert.ok(row.every((cell) => typeof cell === "string" && cell !== ""), "no cell may render as undefined");
    }
    assert.match(table.rows[0][0], /^\d+$/, "the first column is the number itself");
  }

  const hotCold = (await get(instance, "/api/v1/lottery/statistics/hot-cold?window=40")).json();
  const hotColdTable = statisticsRows("hot-cold", hotCold.data);
  assert.ok(hotColdTable.rows.length >= 5, "the ranked hot/cold lists must produce rows");
  assert.ok(hotColdTable.rows[0][1] !== "—", "the hottest number must be present");

  for (const kind of ["pairs", "triplets", "star-pairs"]) {
    const payload = (await get(instance, `/api/v1/lottery/statistics/${kind}?window=40`)).json();
    const table = statisticsRows(kind, payload.data);
    assert.ok(table.rows.length > 0, `${kind} has stored groups and must render them`);
    assert.equal(table.rows[0].length, table.columns.length);
    assert.match(table.rows[0][0], /^[\d-]+$/, "groups are keyed by their members");
  }

  const distribution = (await get(instance, "/api/v1/lottery/statistics/distribution?window=40")).json();
  const metrics = distributionMetrics(distribution.data);
  assert.ok(metrics.length >= 10, "the distribution panel must show every computed metric");
  for (const metric of metrics) {
    assert.ok(metric.label && metric.value !== "undefined", `every metric needs a label and a value: ${JSON.stringify(metric)}`);
  }
  assert.ok(metrics.some((metric) => /Draws in window/.test(metric.label)));
  assert.ok(metrics.some((metric) => /Odd \/ even/.test(metric.label)));

  // An empty window is a normal state, not a crash: no draws means no observations.
  const empty = statisticsRows("numbers", { numbers: {} });
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(statisticsRows("distribution", null), { columns: [], rows: [] }, "an absent payload is an empty table, not a crash");
  assert.ok(distributionMetrics(null).length > 0, "an absent payload still produces the window line");
});

test("the performance and backtest normalisers handle the payloads the service actually returns", async (t) => {
  const instance = await sandboxInstance(t);

  // Nothing checked yet: the service answers `byTier: []` — an ARRAY, not a map.
  const empty = (await get(instance, "/api/v1/lottery/performance")).json();
  assert.equal(Array.isArray(empty.actualTicketResults.byTier), true, "the empty case is an array; the normaliser must survive it");
  assert.deepEqual(tierRows(empty.actualTicketResults.byTier), []);

  await post(instance, "/api/v1/lottery/sync", { limit: 40 });
  const ticket = (await post(instance, "/api/v1/lottery/tickets", {
    name: "Normaliser ticket", lines: [{ mains: [1, 2, 3, 4, 5], stars: [1, 2] }], generationMethod: "MANUAL",
  })).json();
  const check = (await post(instance, `/api/v1/lottery/tickets/${ticket.ticket.id}/check`, {})).json();
  assert.equal(check.status, "CHECKED");
  assert.equal(check.ticketId, ticket.ticket.id);
  assert.equal(check.lines.length, 1);
  assert.ok("prizeTier" in check.lines[0], "a checked line carries a tier label (or null), never an amount");

  const report = (await post(instance, "/api/v1/lottery/backtest", { strategy: "RANDOM_BASELINE", lines: 1, window: 20 })).json();
  const distribution = matchDistribution(report);
  assert.equal(distribution.length, 9, "six main buckets and three star buckets");
  assert.match(distribution[0].label, /^0 main match/);
  assert.equal(report.simulatedCost, null, "cost is not fabricated");
  assert.equal(report.simulatedWinnings, null, "winnings are not fabricated");

  const performance = (await get(instance, "/api/v1/lottery/performance")).json();
  const checkedRows = tierRows(performance.actualTicketResults.byTier);
  assert.ok(Array.isArray(checkedRows), "the non-empty case is a map and must also be handled");
  assert.equal(performance.actualTicketResults.ticketsChecked, 1);
  for (const section of ["actualTicketResults", "historicalBacktestResults", "demoSandboxData"]) {
    assert.ok(performance[section]?.section, "each performance section names itself so they can never be mixed");
  }
});

test("formatting never invents a figure, and a draw renders from its typed rows", () => {
  assert.equal(formatNumber(0, 2), "0.00", "a real zero is a figure");
  assert.equal(formatNumber(null), "—");
  assert.equal(formatNumber("nonsense"), "—");
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(null), "—");
  assert.equal(formatDate("2026-10-13"), new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date("2026-10-13")));
  assert.equal(formatDate(""), "—");
  assert.equal(listToText([1, 2]), "1 · 2");
  assert.equal(listToText([]), "—");

  // The typed `numbers` rows win over the payload when both are present, because
  // they carry position; the payload is the fallback for a row stored before them.
  const draw = {
    numbers: [
      { kind: "MAIN", position: 1, number: 6 },
      { kind: "MAIN", position: 0, number: 1 },
      { kind: "STAR", position: 0, number: 5 },
    ],
    payload: { main: [99], stars: [98] },
  };
  assert.deepEqual(drawNumbers(draw, "MAIN"), [1, 6], "positions order the numbers");
  assert.deepEqual(drawNumbers(draw, "STAR"), [5]);
  assert.deepEqual(drawNumbers({ payload: { main: [3, 4], stars: [9] } }, "MAIN"), [3, 4]);
  assert.deepEqual(drawNumbers(null, "MAIN"), []);
  assert.equal(generatedLineText({ mains: [1, 2], stars: [3] }), "1 · 2 | 3");

  assert.equal(verificationTone("VERIFIED"), "badge-live");
  assert.equal(verificationTone("conflict"), "badge-warn");
  assert.equal(verificationTone(undefined), "badge-muted");
  assert.equal(providerTone("ONLINE"), "badge-live");
  assert.equal(providerTone("OFFLINE"), "badge-warn");
  assert.equal(providerTone("UNKNOWN"), "badge-muted");
});

// ------------------------------------------------------------- screens and routes

test("both lottery consoles are declared, permission-gated and reachable as deep links", async (t) => {
  const instance = await createFileStoreApp();
  t.after(() => instance.cleanup());

  // `public/app/` is generated and git-ignored, and a deep link is a 404 without it by
  // design — so say that before asserting 200, or a fresh checkout reads as a routing
  // bug. CI builds the client before this suite; locally, `npm run build:client`.
  assert.ok(existsSync(path.resolve(CLIENT, "..", "..", "public", "app", "index.html")), "the built SPA shell is required: npm run build:client");

  const app = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  const views = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");
  for (const path_ of ["/app/lottery", "/app/lottery/lab"]) {
    const route = app.match(new RegExp(`\\{[^{}]*path:\\s*"${path_.replace(/\//g, "\\/")}"[^{}]*\\}`));
    assert.ok(route, `${path_} must be a declared exact-path route`);
    assert.match(route[0], /requiresAuth:\s*true/);
    assert.match(route[0], /permission:\s*"lottery\.view"/, "the module's read gate, as legacy required");

    const nav = views.match(new RegExp(`\\{[^{}]*to:\\s*"${path_.replace(/\//g, "\\/")}"[^{}]*\\}`));
    assert.ok(nav, `${path_} needs a navigation entry, locked rather than hidden`);
    assert.match(nav[0], /permission:\s*"lottery\.view"/);

    const html = await instance.app.inject({ method: "GET", url: path_, headers: { accept: "text/html" } });
    assert.equal(html.statusCode, 200, `${path_} must answer the SPA shell for a browser navigation`);
  }

  // The two ingestion actions are administrator-only in the legacy console too, and
  // the screen must not render them for a viewer the API would refuse.
  assert.match(views, /canManage \? \(/, "the manage actions must be conditional");
  assert.match(views, /endpoints\.lotteryCheckProvider\(\)/);
  assert.match(views, /endpoints\.lotterySync\(/);
  const routes = readFileSync(path.resolve(import.meta.dirname, "..", "src", "modules", "lottery", "routes.js"), "utf8");
  assert.match(routes, /app\.post\("\/lottery\/providers\/check", \{ preHandler: manage, bodySchema: EMPTY_BODY \}/);
  assert.match(routes, /app\.post\("\/lottery\/sync", \{ preHandler: manage, bodySchema: SYNC_BODY \}/);

  // And the honesty words the module is required to keep in front of a reader.
  for (const phrase of [/do not predict/i, /not a purchase/i]) {
    assert.match(views, phrase);
  }
});

test("every lottery path the console calls exists in the server's own route inventory", async (t) => {
  const instance = await createFileStoreApp();
  t.after(() => instance.cleanup());
  const inventory = (await instance.app.inject({ method: "GET", url: "/api/v1/system/routes" })).json().routes;

  const source = readFileSync(path.join(CLIENT, "api.js"), "utf8");
  const calls = [...source.matchAll(/api\(\s*[`"](\/api\/v1\/lottery[^`"$]*)/g)].map((match) => match[1]);
  assert.ok(calls.length >= 20, `expected the lottery console to declare its endpoints, found ${calls.length}`);
  const unresolved = calls.filter((literal) => !inventory.some((route) => route.path.startsWith(literal)));
  assert.deepEqual(unresolved, [], "a console calling an unregistered lottery path is a dead screen");

  const lotteryRoutes = inventory.filter((route) => route.path.startsWith("/api/v1/lottery"));
  assert.equal(lotteryRoutes.length, 31, "the console covers the module's whole surface — the count is the honest report of it");
  const manageRoutes = lotteryRoutes.filter((route) => route.permission === "lottery.manage");
  assert.deepEqual(manageRoutes.map((route) => `${route.method} ${route.path}`).sort(), [
    "POST /api/v1/lottery/providers/check",
    "POST /api/v1/lottery/sync",
    "POST /api/v1/lottery/system-build",
  ], "only the three ingestion/queue writes are administrator actions");
  assert.equal(lotteryRoutes.filter((route) => route.permission === "lottery.view").length, 27);
  assert.equal(lotteryRoutes.find((route) => route.path === "/api/v1/lottery/status").permission, "system.authenticated",
    "status stays plain-authenticated, as legacy's controller declared — no lottery permission is needed to read it");
});
