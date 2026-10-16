/**
 * The Strategy Lab console against the API it drives (row 8, Phase 31).
 *
 * The third console contract suite, and the first for a module whose routes are
 * **session-only**: legacy's `Api_controller` guarded `api/strategies`,
 * `api/backtesting/*` and the three form posts behind authentication alone, with
 * no permission, and the port kept that. So this file asserts the absence as well
 * as the presence — the screen must not be gated on a permission the API does not
 * require, and the one permissioned control it can render (the human sign-off,
 * `trading.control`) must be the only one.
 *
 * Everything here is hermetic, following `test/strategies_http.test.js`:
 * `MARKET_DATA_REAL_PROVIDERS=0` settles the provider chain to the synthetic
 * generator, so no test can reach the network — and every run produced is
 * labelled synthetic, which the assertions say out loud rather than hiding.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  BACKTEST_BARS, LIFECYCLE_ORDER, OPTIMIZE_BARS, RETIRED_STAGE, SYMBOLS, TIMEFRAMES,
  backtestSummary, buildBacktestBody, buildOptimizeBody, buildSignOffBody, buildTransitionBody, finalistRows,
  historyRows, lifecycleTone, marketClassFor, metricPairs, needsSignOff, optimizeHeadline, optimizeRecommendation,
  pctText, plainNumber, provenanceNote, ratioPctText, stageSteps, transitionFailure,
  validateBacktestForm, validateOptimizeForm, validateSignOffForm,
} from "../client/src/strategy.js";
import {
  BACKTEST_BODY, HUMAN_SIGNOFF_BODY, OPTIMIZE_BODY, OPTIMIZE_CANDLE_MAX, OPTIMIZE_CANDLE_MIN, STATUS_BODY,
  STRATEGY_MARKET_CLASSES, STRATEGY_TIMEFRAMES,
} from "../src/modules/strategies/contracts.js";
import { BACKTEST_LIMIT_MAX, BACKTEST_LIMIT_MIN } from "../src/modules/strategies/backtester.js";
import { LIFECYCLE_STAGES } from "../src/modules/strategies/registry.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";

const CLIENT = path.resolve(import.meta.dirname, "..", "client", "src");

/** The limits `test/strategies_http.test.js` lifts, for the same reason: a limit
 * silently throttling an unrelated assertion would look like a contract failure. */
const STRATEGIES_ENV = {
  MARKET_DATA_REAL_PROVIDERS: "0",
  RATE_LIMIT_STRATEGY_BACKTEST_MAX: "10000",
  RATE_LIMIT_STRATEGY_OPTIMIZE_MAX: "10000",
  STRATEGY_MAX_CONCURRENT_RUNS: "0",
};

async function signIn(app) {
  const response = await app.inject({
    method: "POST", url: "/api/v1/auth/login",
    payload: { identifier: "rootadmin", password: "Root administrator pass" },
  });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: cookieFrom(response), "x-csrf-token": response.json().csrfToken };
}

async function strategiesInstance(t) {
  const instance = await createFileStoreApp({ configOverrides: { env: STRATEGIES_ENV } });
  t.after(() => instance.cleanup());
  return { ...instance, headers: await signIn(instance.app) };
}

const post = (instance, url, payload) => instance.app.inject({ method: "POST", url, headers: instance.headers, payload });
const get = (instance, url) => instance.app.inject({ method: "GET", url, headers: instance.headers });

// ------------------------------------------------------------ vocabulary parity

test("the console offers the timeframes, market classes and stage order the API declares", () => {
  assert.deepEqual(
    TIMEFRAMES.map((entry) => entry.value),
    [...STRATEGY_TIMEFRAMES],
    "src/modules/strategies/contracts.js STRATEGY_TIMEFRAMES must drive the console's timeframe select",
  );
  assert.deepEqual(
    [...new Set(SYMBOLS.map((entry) => entry.marketClass))].sort(),
    [...STRATEGY_MARKET_CLASSES].sort(),
    "the console's symbols must cover only classes the API accepts",
  );
  for (const entry of SYMBOLS) {
    assert.ok(STRATEGY_MARKET_CLASSES.includes(entry.marketClass), `${entry.value} maps to ${entry.marketClass}, which the API does not accept`);
    // The table and the legacy rule must agree for every offered symbol: the rule
    // is what a hand-typed symbol gets, the table is what the select sends, and a
    // disagreement would classify the same symbol two ways.
    assert.equal(marketClassFor(entry.value), entry.marketClass, `${entry.value} must classify the same way through the rule and the table`);
  }
  // legacy `Strategy_lab::run_backtest`'s own rule, including the lowercase entry
  // the engine upper-cases for us.
  assert.equal(marketClassFor("btcusdt"), "crypto");
  assert.equal(marketClassFor(" xauusd "), "commodity");
  assert.equal(marketClassFor("eurusd"), "forex");
  assert.equal(SYMBOLS.map((entry) => entry.value).join(","), "BTCUSDT,ETHUSDT,SOLUSDT,EURUSD,GBPUSD,XAUUSD",
    "the console keeps views/strategy/index.php's option order");

  // The stage order, and the one stage that is terminal rather than next.
  assert.deepEqual([...LIFECYCLE_ORDER], [...LIFECYCLE_STAGES].filter((stage) => stage !== RETIRED_STAGE));
  assert.equal(stageSteps("VALIDATED").map((step) => step.state).join(","), "done,done,current,pending,pending,pending");
  assert.equal(stageSteps("DRAFT")[0].state, "current");
  assert.equal(stageSteps("APPROVED").every((step) => step.state !== "pending"), true);
  assert.equal(stageSteps("RETIRED").every((step) => step.state === "pending"), true, "a retired version shows no current stage");
  assert.equal(stageSteps("PAPER_TRADING").find((step) => step.state === "current").label, "Paper trading (deploy)");
  assert.equal(lifecycleTone("APPROVED"), "badge-green");
  assert.equal(lifecycleTone("RETIRED"), "badge-red");
  assert.equal(lifecycleTone("RISK_REVIEWED"), "badge-violet");
  assert.equal(lifecycleTone("BACKTESTED"), "badge-sky");
  assert.equal(lifecycleTone("DRAFT"), "badge-gray");
});

test("the bar bounds the console shows are the engine's own, and its defaults are inside them", () => {
  assert.equal(BACKTEST_BARS.min, BACKTEST_LIMIT_MIN);
  assert.equal(BACKTEST_BARS.max, BACKTEST_LIMIT_MAX);
  assert.equal(OPTIMIZE_BARS.min, OPTIMIZE_CANDLE_MIN);
  assert.equal(OPTIMIZE_BARS.max, OPTIMIZE_CANDLE_MAX);
  // legacy's form defaults, which the console keeps.
  assert.equal(BACKTEST_BARS.default, 1500);
  assert.equal(OPTIMIZE_BARS.default, 1000);
  for (const bars of [BACKTEST_BARS, OPTIMIZE_BARS]) {
    assert.ok(bars.default >= bars.min && bars.default <= bars.max, `${bars.default} must be inside ${bars.min}..${bars.max}`);
  }
  // Out-of-range is CLAMPED by the engine, not refused — so the pre-flight must not
  // refuse it either. Asserting the absence: a client rule stricter than the API
  // would block a request the API accepts and answers.
  assert.deepEqual(validateBacktestForm({ symbol: "BTCUSDT", timeframe: "1h", limit: BACKTEST_BARS.max * 10 }), []);
  assert.deepEqual(validateOptimizeForm({ symbol: "BTCUSDT", timeframe: "1h", limit: OPTIMIZE_BARS.min - 10 }), []);
});

// ---------------------------------------------------------------- the bodies

test("the built bodies carry only properties the four schemas declare", () => {
  const cases = [
    [buildBacktestBody({ strategyId: "breakout", strategyVersion: "1.0.0", symbol: "btcusdt", timeframe: "1h", limit: "1500", allowShorts: true }), BACKTEST_BODY],
    [buildOptimizeBody({ strategyVersion: "1.0.0", symbol: "EURUSD", timeframe: "4h", limit: "1000", register: true }), OPTIMIZE_BODY],
    [buildTransitionBody({ to: "BACKTESTED", version: "1.0.0", reason: "evidence" }), STATUS_BODY],
    [buildSignOffBody({ version: "1.0.0", reason: "reviewed the walk-forward report and the drawdown" }), HUMAN_SIGNOFF_BODY],
  ];
  for (const [body, schema] of cases) {
    const allowed = new Set(Object.keys(schema.properties));
    for (const key of Object.keys(body)) {
      assert.ok(allowed.has(key), `${key} is not a declared property — additionalProperties:false refuses it`);
    }
    for (const required of schema.required ?? []) {
      assert.ok(required in body, `${required} is required by the schema and must always be sent`);
    }
  }

  // The derived market class and the symbol normalisation, on the wire.
  const crypto = buildBacktestBody({ strategyId: "breakout", symbol: "  btcusdt ", timeframe: "1h" });
  assert.equal(crypto.symbol, "BTCUSDT");
  assert.equal(crypto.marketClass, "crypto");
  assert.equal(buildBacktestBody({ strategyId: "breakout", symbol: "GBPUSD", timeframe: "1h" }).marketClass, "forex");
  assert.equal(buildBacktestBody({ strategyId: "breakout", symbol: "XAUUSD", timeframe: "1h" }).marketClass, "commodity");

  // A blank optional field is omitted, not sent as "" — `strategyVersion` has a
  // pattern that an empty string fails, and the engine's "latest version" default
  // is the behaviour a blank field means.
  assert.ok(!("strategyVersion" in buildBacktestBody({ strategyId: "breakout", symbol: "BTCUSDT", timeframe: "1h", strategyVersion: "" })));
  assert.ok(!("limit" in buildOptimizeBody({ symbol: "BTCUSDT", timeframe: "1h", limit: "" })));
  assert.deepEqual(buildTransitionBody({ to: "VALIDATED", version: "1.0.0" }), { to: "VALIDATED", version: "1.0.0" });
  assert.equal(buildOptimizeBody({ symbol: "BTCUSDT", timeframe: "1h", register: "false" }).register, false, "only a strict true registers a variant");
});

test("the pre-flights refuse the shape the schemas refuse, and nothing stricter", () => {
  assert.deepEqual(validateBacktestForm({ symbol: "BTCUSDT", timeframe: "1h", limit: "1500" }), []);
  assert.ok(validateBacktestForm({ symbol: "", timeframe: "1h", limit: "1500" }).some((problem) => problem.field === "symbol"));
  assert.ok(validateBacktestForm({ symbol: "DOGEUSDT", timeframe: "1h", limit: "1500" }).some((problem) => problem.field === "symbol"), "a symbol outside the form's list is a typed mistake, not a request");
  assert.ok(validateBacktestForm({ symbol: "BTCUSDT", timeframe: "5m", limit: "1500" }).some((problem) => problem.field === "timeframe"), "5m is refused by the API and must be refused here");
  assert.ok(validateBacktestForm({ symbol: "BTCUSDT", timeframe: "1h", limit: "many" }).some((problem) => problem.field === "limit"));
  assert.deepEqual(validateOptimizeForm({ symbol: "XAUUSD", timeframe: "1d", limit: "1000" }), []);

  // The sign-off reason is the one place the client rule and the server rule are
  // deliberately identical (HUMAN_SIGNOFF_BODY minLength 10 after trim).
  assert.deepEqual(validateSignOffForm({ reason: "reviewed the report" }), []);
  assert.ok(validateSignOffForm({ reason: "   short  " }).some((problem) => problem.field === "reason"));
  assert.ok(validateSignOffForm({ reason: "x".repeat(1001) }).some((problem) => problem.field === "reason"));
});

// ------------------------------------------------------------ live behaviour

test("a backtest run through the console's own body is recorded, summarised and rendered", async (t) => {
  const instance = await strategiesInstance(t);
  const list = (await get(instance, "/api/v1/strategies")).json().strategies;
  assert.ok(list.some((entry) => entry.strategyId === "breakout"), "the built-in strategies are what the console lists");

  const body = buildBacktestBody({ strategyId: "breakout", strategyVersion: "1.0.0", symbol: "BTCUSDT", timeframe: "1h", limit: 300, allowShorts: false });
  const run = await post(instance, "/api/v1/backtesting/run", body);
  assert.equal(run.statusCode, 200, run.body);
  const report = run.json();
  assert.equal(report.request.strategyId, "breakout");
  assert.equal(report.request.marketClass, "crypto", "the derived class is what the report records");
  assert.equal(report.dataProvenance.synthetic, true, "hermetic: every run here is synthetic and says so");

  // The summary sentence legacy flashed, rebuilt from the report.
  const summary = backtestSummary(report);
  assert.match(summary, /^Backtest complete: \d+ trades · return -?\d+\.\d\d% · maxDD \d+\.\d%/);
  assert.match(summary, /SYNTHETIC data \(simulation\)$/, "a synthetic run may never be summarised as real data");
  assert.match(provenanceNote(report.dataProvenance), /SIMULATION/);

  // Every metric cell renders, and a missing one is an em dash rather than a zero.
  const pairs = metricPairs(report.metrics);
  assert.equal(pairs.length, 12);
  for (const pair of pairs) {
    assert.ok(pair.label && pair.value !== "undefined" && pair.value !== "null", `${pair.label} must render: ${JSON.stringify(pair)}`);
  }
  assert.equal(pctText(null), "—");
  assert.equal(plainNumber(null), "—");
  assert.equal(ratioPctText(0.6), "60%");
  assert.equal(ratioPctText(null), "—");
  assert.equal(pctText(4.9208), "4.92%");

  // The history the screen lists, through the console's own normaliser.
  const history = (await get(instance, "/api/v1/backtesting/results?strategyId=breakout&limit=15")).json();
  const rows = historyRows(history.results);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, "BTCUSDT");
  assert.equal(rows[0].synthetic, true);
  assert.notEqual(pctText(rows[0].metrics.totalReturnPct), "—", "the history table must show the run's own return");
  assert.equal(historyRows(null).length, 0, "an empty history is an empty table, not a crash");
});

test("the lifecycle stepper's controls match what the API answers: an advance, and a refusal with reasons", async (t) => {
  const instance = await strategiesInstance(t);
  await post(instance, "/api/v1/backtesting/run", buildBacktestBody({ strategyId: "breakout", symbol: "BTCUSDT", timeframe: "1h", limit: 300 }));
  const detail = (await get(instance, "/api/v1/strategies/breakout")).json();
  assert.equal(detail.lifecycle, "DRAFT");
  assert.equal(detail.nextStage, "BACKTESTED", "the button's target is the server's nextStage, not a client-side order");

  const advanced = await post(instance, "/api/v1/strategies/breakout/status", buildTransitionBody({ to: detail.nextStage, version: detail.version, reason: "console test" }));
  assert.equal(advanced.statusCode, 200, advanced.body);
  assert.equal(advanced.json().strategy.lifecycle, "BACKTESTED");

  // The next advance is refused on evidence — a 409 whose `details` is what the
  // screen must render. A console showing only the message would lose the reasons
  // legacy flashed ("Transition rejected: …").
  const refused = await post(instance, "/api/v1/strategies/breakout/status", buildTransitionBody({ to: "VALIDATED", version: detail.version }));
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error.code, "STRATEGY_TRANSITION_REJECTED");
  const failure = transitionFailure({ details: refused.json().error.details });
  assert.ok(failure.reasons.length > 0, "the refusal carries reasons the screen can show");
  assert.ok(failure.warnings.length > 0, "and warnings — legacy printed both");
  assert.equal(transitionFailure(new Error("network")).reasons.length, 0, "an error without details yields empty lists, never undefined");

  // A stage may not be skipped: the message names the expected next stage.
  const skipped = await post(instance, "/api/v1/strategies/breakout/status", buildTransitionBody({ to: "APPROVED", version: detail.version }));
  assert.equal(skipped.statusCode, 409);
  assert.match(skipped.json().error.details.reasons.join(" "), /may not be skipped/);
});

test("the optimizer's report renders from its own fields, and only an ai variant asks for sign-off", async (t) => {
  const instance = await strategiesInstance(t);
  const optimize = await post(instance, "/api/v1/strategies/breakout/optimize", buildOptimizeBody({ strategyVersion: "1.0.0", symbol: "BTCUSDT", timeframe: "1h", limit: 500, register: false }));
  assert.equal(optimize.statusCode, 200, optimize.body);
  const report = optimize.json();
  assert.match(optimizeHeadline(report), /^\d+ combinations · split \d+\/\d+ bars$/);
  const recommendation = optimizeRecommendation(report);
  assert.match(recommendation, /^(ADOPT |keep current parameters — )/);
  // The engine's refusal reason already opens with the phrase; the console must not
  // say it twice (the live endpoint's reason is "keep current parameters — no
  // candidate beat the baseline out-of-sample").
  assert.equal(recommendation.match(/keep current parameters/gi).length, 1, `the phrase must appear once: ${recommendation}`);
  assert.equal(optimizeRecommendation({ recommendation: { adopt: false, reason: "no candidate beat the baseline out-of-sample" } }), "keep current parameters — no candidate beat the baseline out-of-sample");
  assert.match(optimizeRecommendation({ recommendation: { adopt: true, params: { lookback: 48 } } }), /^ADOPT \{"lookback":48\}$/);
  assert.equal(report.registeredVariant, undefined, "an unregistered search writes no variant");
  for (const row of finalistRows(report)) {
    assert.equal(typeof row.params, "object");
    assert.ok(row.inSample === null || Number.isFinite(Number(row.inSample)));
    assert.ok(row.outOfSample === null || Number.isFinite(Number(row.outOfSample)));
  }
  assert.equal(finalistRows(null).length, 0);

  // `signOffAiStrategy` refuses a built-in in as many words, so the console hides
  // the control for one — `needsSignOff` is that decision, not an inference from
  // the lifecycle stage.
  const detail = (await get(instance, "/api/v1/strategies/breakout")).json();
  assert.equal(detail.source, "builtin");
  assert.equal(needsSignOff(detail), false);
  assert.equal(needsSignOff({ source: "ai" }), true);
  const refused = await post(instance, "/api/v1/strategies/breakout/sign-off", buildSignOffBody({ version: detail.version, reason: "a reviewer looked at the report" }));
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error.code, "STRATEGY_SIGNOFF_REJECTED");
  assert.match(refused.json().error.details.reasons.join(" "), /only required for AI-generated strategies/);
});

// ------------------------------------------------------------- screens, routes

test("the Strategy Lab is a session-only screen, and session-only is what its routes are", async (t) => {
  const instance = await createFileStoreApp();
  t.after(() => instance.cleanup());

  // `public/app/` is generated and git-ignored, and a deep link is a 404 without it by
  // design — so say that before asserting 200, or a fresh checkout reads as a routing
  // bug. CI builds the client before this suite; locally, `npm run build:client`.
  assert.ok(existsSync(path.resolve(CLIENT, "..", "..", "public", "app", "index.html")), "the built SPA shell is required: npm run build:client");

  const app = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  const views = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");

  const route = app.match(/\{[^{}]*path:\s*"\/app\/strategy"[^{}]*\}/);
  assert.ok(route, "/app/strategy must be a declared exact-path route");
  assert.match(route[0], /requiresAuth:\s*true/);
  assert.ok(!/permission:/.test(route[0]), "legacy's guard for these routes was a session and no permission — the screen must not invent one");
  assert.match(app, /"strategy-lab":\s*<StrategyLabView/, "the route must resolve to a view, or it renders blank");

  const nav = views.match(/\{[^{}]*to:\s*"\/app\/strategy"[^{}]*\}/);
  assert.ok(nav, "the console needs a navigation entry");
  assert.match(nav[0], /permission:\s*null/, "an entry that required a permission would hide a screen the API serves to every signed-in role");
  assert.match(views, /number:\s*"02",\s*title:\s*"Strategy Lab"[^}]*to:\s*"\/app\/strategy"/, "the module card must open the console it describes");

  const html = await instance.app.inject({ method: "GET", url: "/app/strategy", headers: { accept: "text/html" } });
  assert.equal(html.statusCode, 200, "a bookmark, a refresh or a pasted link must reach the screen");
  assert.match(html.headers["content-type"] || "", /text\/html/);

  // The permissioned control on the screen is exactly one, and it is the API's own.
  assert.match(views, /trading\.control/, "the sign-off control must name the permission the route enforces");
  const inventory = (await instance.app.inject({ method: "GET", url: "/api/v1/system/routes" })).json().routes;
  const strategyRoutes = inventory.filter((entry) => entry.path.startsWith("/api/v1/strategies") || entry.path.startsWith("/api/v1/backtesting"));
  assert.equal(strategyRoutes.length, 8, "the console drives the module's whole route surface");
  assert.deepEqual(
    strategyRoutes.filter((entry) => entry.permission !== null).map((entry) => `${entry.method} ${entry.path} ${entry.permission}`),
    ["POST /api/v1/strategies/:strategyId/sign-off trading.control"],
    "exactly one of these routes is permission-gated; every other one is legacy's session-only guard",
  );

  // Every path the client calls is registered, so a screen cannot point at a route
  // that no longer exists.
  const source = readFileSync(path.join(CLIENT, "api.js"), "utf8");
  const calls = [...source.matchAll(/api\(\s*[`"](\/api\/v1\/(?:strategies|backtesting)[^`"$]*)/g)].map((match) => match[1]);
  assert.ok(calls.length >= 7, `expected the console to declare its endpoints, found ${calls.length}`);
  const unresolved = calls.filter((literal) => !inventory.some((entry) => entry.path.startsWith(literal)));
  assert.deepEqual(unresolved, [], "a console calling an unregistered strategy path is a dead screen");
});
