/**
 * Strategy Lab — the HTTP surface.
 *
 * Everything here is hermetic: `MARKET_DATA_REAL_PROVIDERS=0` settles the
 * provider chain to the synthetic generator alone, so no test can reach the
 * network. That has a consequence the tests assert rather than hide — every run
 * this suite produces is labelled `synthetic: true`, and a synthetic run is not
 * evidence for live trading. The lifecycle gates still accept it (they check that
 * a backtest exists and that its metrics clear the criteria), so the tests prove
 * the plumbing while the provenance column proves the data was never real.
 *
 * Rate limits and the concurrency cap are lifted for the behaviour tests,
 * following the `GENEROUS_ANALYSIS_LIMITS` convention, and proved separately at
 * the end of the file. Lifting them by default is deliberate: a limit that
 * silently throttled an unrelated test would look like a contract failure.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { cookieFrom, createFileStoreApp } from "./helpers.js";
import { createStrategyRunGate } from "../src/modules/strategies/routes.js";
import { LIFECYCLE_STAGES } from "../src/modules/strategies/registry.js";
import {
  STRATEGY_MARKET_CLASSES,
  STRATEGY_TIMEFRAMES,
} from "../src/modules/strategies/contracts.js";

const GENEROUS_STRATEGY_LIMITS = {
  RATE_LIMIT_STRATEGY_BACKTEST_MAX: "10000",
  RATE_LIMIT_STRATEGY_OPTIMIZE_MAX: "10000",
  STRATEGY_MAX_CONCURRENT_RUNS: "0",
};

const STRATEGIES_ENV = {
  PUBLIC_BASE_URL: "https://site.example.test",
  MARKET_DATA_REAL_PROVIDERS: "0",
  ...GENEROUS_STRATEGY_LIMITS,
};

async function signIn(app) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifier: "rootadmin", password: "Root administrator pass" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  return {
    cookie: cookieFrom(response),
    csrfToken: body.csrfToken,
    headers: { cookie: cookieFrom(response), "x-csrf-token": body.csrfToken },
  };
}

function harness(options = {}) {
  return createFileStoreApp({
    configOverrides: { env: { ...STRATEGIES_ENV, ...(options.env || {}) } },
    ...options,
  });
}

/** Validation failures carry `error.details` as a flat array of `{field, code, message}`. */
function rejectedFields(response) {
  const details = response.json()?.error?.details;
  const issues = Array.isArray(details) ? details : (details?.fields || []);
  return issues.map((issue) => issue.field);
}

const RUN_BODY = Object.freeze({
  strategyId: "trend-following",
  symbol: "BTCUSDT",
  marketClass: "crypto",
  timeframe: "1h",
});

// ============================================================================
// surface and authentication
// ============================================================================

test("the seven Strategy Lab routes are registered under /api/v1", async () => {
  const instance = await harness();
  try {
    const paths = instance.app.routes().map((route) => `${route.method} ${route.path}`);
    for (const expected of [
      "GET /api/v1/strategies",
      "GET /api/v1/strategies/:strategyId",
      "POST /api/v1/strategies/:strategyId/status",
      "POST /api/v1/strategies/:strategyId/optimize",
      "POST /api/v1/backtesting/run",
      "GET /api/v1/backtesting/results",
      "GET /api/v1/backtesting/results/:backtestId",
    ]) {
      assert.ok(paths.includes(expected), `${expected} must be registered; got ${paths.filter((p) => /strateg|backtest/i.test(p)).join(", ")}`);
    }
    // `GET …/status` is deliberately absent: the legacy path was method-agnostic
    // but the handler reads a JSON body, so a GET could only ever 400.
    assert.ok(
      !paths.includes("GET /api/v1/strategies/:strategyId/status"),
      "a read-only status route would duplicate GET /strategies/:id",
    );
  } finally {
    await instance.cleanup();
  }
});

test("every route requires a session, and none requires a permission", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const anonymous = [
      ["GET", "/api/v1/strategies"],
      ["GET", "/api/v1/strategies/trend-following"],
      ["GET", "/api/v1/backtesting/results"],
      ["GET", "/api/v1/backtesting/results/any-id"],
    ];
    for (const [method, url] of anonymous) {
      const response = await instance.app.inject({ method, url });
      assert.equal(response.statusCode, 401, `${method} ${url} must require a session`);
      assert.equal(response.json().error.code, "AUTH_REQUIRED");
    }
    // The three mutating routes are also session-gated. These bodies are VALID on
    // purpose: on this platform the body schema is checked before the auth
    // preHandler runs (finding D-8), so an empty body would answer 400 and prove
    // nothing about the session gate.
    for (const [url, payload] of [
      ["/api/v1/strategies/trend-following/status", { to: "BACKTESTED" }],
      ["/api/v1/strategies/trend-following/optimize", {}],
      ["/api/v1/backtesting/run", RUN_BODY],
    ]) {
      const response = await instance.app.inject({ method: "POST", url, payload });
      assert.equal(response.statusCode, 401, `POST ${url} must require a session`);
    }

    // The D-8 ordering pinned explicitly, because it is surprising and an operator
    // reading a 400 in the logs would otherwise assume the caller was signed in:
    // an unauthenticated caller with an invalid body gets the validation error.
    const invalidUnauthenticated = await instance.app.inject({
      method: "POST", url: "/api/v1/backtesting/run", payload: {},
    });
    assert.equal(invalidUnauthenticated.statusCode, 400);
    assert.deepEqual(rejectedFields(invalidUnauthenticated).sort(),
      ["marketClass", "strategyId", "symbol", "timeframe"]);

    // Signed in, the read routes answer — proving the gate is authentication only,
    // not a permission the seeded root admin might happen to hold.
    const list = await instance.app.inject({ method: "GET", url: "/api/v1/strategies", headers: session.headers });
    assert.equal(list.statusCode, 200, list.body);
  } finally {
    await instance.cleanup();
  }
});

test("the three mutating routes refuse a cookie session without a CSRF token", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const cookieOnly = { cookie: session.cookie };
    for (const [url, payload] of [
      ["/api/v1/strategies/trend-following/status", { to: "BACKTESTED" }],
      ["/api/v1/strategies/trend-following/optimize", {}],
      ["/api/v1/backtesting/run", RUN_BODY],
    ]) {
      const response = await instance.app.inject({ method: "POST", url, payload, headers: cookieOnly });
      assert.equal(response.statusCode, 403, `POST ${url} must be CSRF-gated`);
      assert.equal(response.json().error.code, "CSRF_INVALID");
    }
  } finally {
    await instance.cleanup();
  }
});

// ============================================================================
// reads
// ============================================================================

test("GET /strategies groups versions and reports the executable capability", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const response = await instance.app.inject({ method: "GET", url: "/api/v1/strategies", headers: session.headers });
    assert.equal(response.statusCode, 200, response.body);
    const { strategies } = response.json();

    assert.equal(strategies.length, 4, "the four builtins are seeded on boot");
    assert.deepEqual(
      strategies.map((entry) => entry.strategyId).sort(),
      ["breakout", "mean-reversion", "momentum", "trend-following"],
    );
    for (const entry of strategies) {
      assert.equal(entry.latest.lifecycle, "DRAFT");
      assert.equal(entry.latest.supportsShorts, true, "every builtin declares short support");
      assert.deepEqual(entry.versions, [
        { version: "1.0.0", lifecycle: "DRAFT", updatedAt: entry.latest.updated_at },
      ]);
      // The record is passed through with its stored field names, so a client that
      // read the legacy API sees the same keys.
      assert.equal(entry.latest.strategy_id, entry.strategyId);
      assert.ok(Array.isArray(entry.latest.market_classes));
    }
  } finally {
    await instance.cleanup();
  }
});

test("GET /strategies/:id returns the record plus the two derived fields", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const response = await instance.app.inject({
      method: "GET", url: "/api/v1/strategies/trend-following", headers: session.headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.strategy_id, "trend-following");
    assert.equal(body.version, "1.0.0");
    assert.equal(body.source, "builtin");
    assert.equal(body.supportsShorts, true);
    assert.equal(body.nextStage, "BACKTESTED", "a DRAFT strategy's only legal next stage");
    assert.deepEqual(body.params, { fast: 20, slow: 50, adxMin: 25, stopAtr: 2, targetR: 3 });

    const missing = await instance.app.inject({
      method: "GET", url: "/api/v1/strategies/not-a-strategy", headers: session.headers,
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "STRATEGY_NOT_FOUND");
  } finally {
    await instance.cleanup();
  }
});

test("GET /strategies/:id?version= selects an exact version, and empty means latest", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    // Register a second version so "latest" and "exact" can differ.
    await instance.store.saveStrategy({
      strategy_id: "trend-following",
      version: "1.0.1",
      name: "Trend Following (optimized 1.0.1)",
      description: "d",
      market_classes: ["forex", "crypto", "commodity"],
      timeframes: ["15m", "1h", "4h", "1d"],
      params: { fast: 10 },
      source: "ai",
      lifecycle: "DRAFT",
      created_at: "2026-10-11T00:00:00.000Z",
      updated_at: "2026-10-11T00:00:00.000Z",
      lifecycle_history: [{ from: null, to: "DRAFT", at: "2026-10-11T00:00:00.000Z", reason: "registered" }],
    });

    const exact = await instance.app.inject({
      method: "GET", url: "/api/v1/strategies/trend-following?version=1.0.0", headers: session.headers,
    });
    assert.equal(exact.json().version, "1.0.0");
    assert.equal(exact.json().source, "builtin");

    const latest = await instance.app.inject({
      method: "GET", url: "/api/v1/strategies/trend-following", headers: session.headers,
    });
    assert.equal(latest.json().version, "1.0.1", "no version means the most recently updated");
    assert.equal(latest.json().source, "ai");

    // A client that builds a query string from an unset variable sends `?version=`
    // and must get the latest, not a 400.
    const empty = await instance.app.inject({
      method: "GET", url: "/api/v1/strategies/trend-following?version=", headers: session.headers,
    });
    assert.equal(empty.statusCode, 200, empty.body);
    assert.equal(empty.json().version, "1.0.1");

    const absent = await instance.app.inject({
      method: "GET", url: "/api/v1/strategies/trend-following?version=9.9.9", headers: session.headers,
    });
    assert.equal(absent.statusCode, 404, "an exact version that does not exist is a 404, not a fallback");
  } finally {
    await instance.cleanup();
  }
});

// ============================================================================
// backtesting
// ============================================================================

test("POST /backtesting/run returns a full record and labels synthetic data", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const response = await instance.app.inject({
      method: "POST", url: "/api/v1/backtesting/run", headers: session.headers, payload: RUN_BODY,
    });
    assert.equal(response.statusCode, 200, response.body);
    const record = response.json();

    assert.match(record.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(record.request.strategyId, "trend-following");
    // The caller named no version, so the run cites the one it actually executed.
    assert.equal(record.request.strategyVersion, "1.0.0");
    assert.equal(record.request.symbol, "BTCUSDT");
    assert.equal(record.request.timeframe, "1h");
    assert.equal(typeof record.metrics.trades, "number");
    assert.equal(typeof record.metrics.profitFactor === "number" || record.metrics.profitFactor === null, true);
    assert.ok(Array.isArray(record.trades));
    assert.ok(Array.isArray(record.equityCurve));

    // Hermetic means synthetic, and the record must say so in two places: the
    // promoted column a listing can filter on, and the warning a human reads.
    assert.equal(record.dataProvenance.synthetic, true);
    assert.ok(
      record.warnings.some((warning) => /SYNTHETIC/i.test(warning)),
      `a synthetic run must warn; got ${JSON.stringify(record.warnings)}`,
    );

    // It is persisted as evidence, and every trade is journalled.
    assert.ok(await instance.store.findBacktest(record.id), "the run must be stored");
    assert.equal(await instance.store.countStrategyBacktests("trend-following", "1.0.0"), 1);
    const journal = await instance.store.listJournalEntries({ source: "backtest", strategy: "trend-following" });
    assert.equal(journal.length, record.trades.length, "one journal row per trade");
    for (const entry of journal) assert.equal(entry.backtest_id, record.id);
  } finally {
    await instance.cleanup();
  }
});

test("POST /backtesting/run validates the legacy vocabulary", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const post = (payload) =>
      instance.app.inject({ method: "POST", url: "/api/v1/backtesting/run", headers: session.headers, payload });

    for (const field of ["strategyId", "symbol", "marketClass", "timeframe"]) {
      const { [field]: _dropped, ...rest } = RUN_BODY;
      const response = await post(rest);
      assert.equal(response.statusCode, 400, `a missing ${field} must be rejected`);
      assert.ok(rejectedFields(response).includes(field), `${field} must be named in the rejection`);
    }

    const badTimeframe = await post({ ...RUN_BODY, timeframe: "5m" });
    assert.equal(badTimeframe.statusCode, 400);
    assert.ok(rejectedFields(badTimeframe).includes("timeframe"));
    // 5m is a timeframe the market-data module serves, so the rejection must name
    // the strategy vocabulary rather than look like a typo.
    const detail = badTimeframe.json().error.details.find((issue) => issue.field === "timeframe");
    assert.match(detail.message, new RegExp(STRATEGY_TIMEFRAMES.join(", ")));

    const badMarket = await post({ ...RUN_BODY, marketClass: "stock" });
    assert.equal(badMarket.statusCode, 400);
    assert.match(
      badMarket.json().error.details.find((issue) => issue.field === "marketClass").message,
      new RegExp(STRATEGY_MARKET_CLASSES.join(", ")),
    );

    const shortSymbol = await post({ ...RUN_BODY, symbol: "B" });
    assert.equal(shortSymbol.statusCode, 400);
    assert.ok(rejectedFields(shortSymbol).includes("symbol"));

    // An undeclared knob is refused rather than ignored, so a caller cannot smuggle
    // an unvalidated parameter into a run.
    const smuggled = await post({ ...RUN_BODY, notAField: 1 });
    assert.equal(smuggled.statusCode, 400);
    assert.ok(rejectedFields(smuggled).includes("notAField"));
  } finally {
    await instance.cleanup();
  }
});

test("POST /backtesting/run refuses unsafe risk numbers with the engine's own message", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const post = (payload) =>
      instance.app.inject({ method: "POST", url: "/api/v1/backtesting/run", headers: session.headers, payload });

    // These are typed correctly, so the schema passes and the engine refuses them.
    // The point is that ONE definition of the rule produces the message.
    const zeroEquity = await post({ ...RUN_BODY, initialEquity: 0 });
    assert.equal(zeroEquity.statusCode, 400, zeroEquity.body);
    assert.match(zeroEquity.json().error.message, /initialEquity must be positive/);

    const highRisk = await post({ ...RUN_BODY, riskPct: 0.5 });
    assert.equal(highRisk.statusCode, 400);
    assert.match(highRisk.json().error.message, /riskPct must be in \(0, 5%\]/);

    const negativeFee = await post({ ...RUN_BODY, feeBps: -1 });
    assert.equal(negativeFee.statusCode, 400);
    assert.match(negativeFee.json().error.message, /feeBps must be a non-negative number/);
  } finally {
    await instance.cleanup();
  }
});

test("POST /backtesting/run reports an unknown strategy as 404, not 400", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const response = await instance.app.inject({
      method: "POST", url: "/api/v1/backtesting/run", headers: session.headers,
      payload: { ...RUN_BODY, strategyId: "not-a-strategy" },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "STRATEGY_NOT_FOUND");

    // A version that was never registered is also a 404: the strategy exists, but
    // not the thing the caller asked to test.
    const badVersion = await instance.app.inject({
      method: "POST", url: "/api/v1/backtesting/run", headers: session.headers,
      payload: { ...RUN_BODY, strategyVersion: "9.9.9" },
    });
    assert.equal(badVersion.statusCode, 404, badVersion.body);
  } finally {
    await instance.cleanup();
  }
});

test("POST /backtesting/run refuses a range that leaves too little history", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    // A range in the far past filters every synthetic candle away.
    const response = await instance.app.inject({
      method: "POST", url: "/api/v1/backtesting/run", headers: session.headers,
      payload: { ...RUN_BODY, from: "2001-01-01", to: "2001-01-02" },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, "INSUFFICIENT_HISTORY");
    assert.match(response.json().error.message, /need at least 120 for a meaningful backtest/);
  } finally {
    await instance.cleanup();
  }
});

test("GET /backtesting/results lists summaries and GET …/:id returns the run", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const run = await instance.app.inject({
      method: "POST", url: "/api/v1/backtesting/run", headers: session.headers, payload: RUN_BODY,
    });
    assert.equal(run.statusCode, 200, run.body);
    const record = run.json();

    const list = await instance.app.inject({
      method: "GET", url: "/api/v1/backtesting/results", headers: session.headers,
    });
    assert.equal(list.statusCode, 200, list.body);
    const { results } = list.json();
    assert.equal(results.length, 1);
    // Field names follow the legacy response, values come from the promoted columns.
    assert.deepEqual(results[0], {
      id: record.id,
      createdAt: record.created_at,
      strategyId: "trend-following",
      strategyVersion: "1.0.0",
      symbol: "BTCUSDT",
      timeframe: "1h",
      synthetic: true,
      candles: record.dataProvenance.candles,
      metrics: record.metrics,
      warnings: record.warnings,
    });
    // The heavy parts of a run are never in a listing.
    assert.equal("trades" in results[0], false);
    assert.equal("equityCurve" in results[0], false);

    const filtered = await instance.app.inject({
      method: "GET", url: "/api/v1/backtesting/results?strategyId=breakout", headers: session.headers,
    });
    assert.deepEqual(filtered.json().results, [], "a filter that matches nothing is an empty list");

    const detail = await instance.app.inject({
      method: "GET", url: `/api/v1/backtesting/results/${record.id}`, headers: session.headers,
    });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.deepEqual(detail.json(), record, "the detail route returns the whole stored run");

    const missing = await instance.app.inject({
      method: "GET", url: "/api/v1/backtesting/results/does-not-exist", headers: session.headers,
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "BACKTEST_NOT_FOUND");
  } finally {
    await instance.cleanup();
  }
});

// ============================================================================
// lifecycle over HTTP
// ============================================================================

test("POST /strategies/:id/status refuses a skipped stage with 409 and its reasons", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const response = await instance.app.inject({
      method: "POST", url: "/api/v1/strategies/trend-following/status", headers: session.headers,
      payload: { to: "VALIDATED" },
    });
    assert.equal(response.statusCode, 409, response.body);
    const error = response.json().error;
    assert.equal(error.code, "STRATEGY_TRANSITION_REJECTED");
    assert.match(error.details.reasons[0], /Invalid transition/);
    assert.match(error.details.reasons[0], /stages may not be skipped/);
    assert.deepEqual(error.details.warnings, []);
    assert.equal(error.details.to, "VALIDATED");

    // The stage did not move.
    const after = await instance.app.inject({
      method: "GET", url: "/api/v1/strategies/trend-following", headers: session.headers,
    });
    assert.equal(after.json().lifecycle, "DRAFT");
  } finally {
    await instance.cleanup();
  }
});

test("POST /strategies/:id/status validates the stage vocabulary", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const response = await instance.app.inject({
      method: "POST", url: "/api/v1/strategies/trend-following/status", headers: session.headers,
      payload: { to: "LAUNCHED" },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.ok(rejectedFields(response).includes("to"));
    assert.match(
      response.json().error.details.find((issue) => issue.field === "to").message,
      new RegExp(LIFECYCLE_STAGES.join(", ")),
    );

    const missing = await instance.app.inject({
      method: "POST", url: "/api/v1/strategies/trend-following/status", headers: session.headers, payload: {},
    });
    assert.equal(missing.statusCode, 400);
    assert.ok(rejectedFields(missing).includes("to"));
  } finally {
    await instance.cleanup();
  }
});

test("a persisted backtest is the evidence that unlocks BACKTESTED", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const status = (payload) =>
      instance.app.inject({
        method: "POST", url: "/api/v1/strategies/trend-following/status", headers: session.headers, payload,
      });

    // Before any run: the gate refuses for want of evidence.
    const before = await status({ to: "BACKTESTED" });
    assert.equal(before.statusCode, 409, before.body);
    assert.deepEqual(before.json().error.details.reasons, [
      "No completed backtest for this strategy version — run a backtest first",
    ]);

    const run = await instance.app.inject({
      method: "POST", url: "/api/v1/backtesting/run", headers: session.headers, payload: RUN_BODY,
    });
    assert.equal(run.statusCode, 200, run.body);

    // After the run: the same request succeeds, because the gate reads what the
    // run persisted. This is the integration the whole module exists for.
    const after = await status({ to: "BACKTESTED", reason: "backtest run over HTTP" });
    assert.equal(after.statusCode, 200, after.body);
    const body = after.json();
    assert.equal(body.ok, true);
    assert.equal(body.strategy.lifecycle, "BACKTESTED");
    assert.equal(body.strategy.lifecycle_history.at(-1).reason, "backtest run over HTTP");

    // VALIDATED now reads the persisted metrics rather than reporting "no results".
    const validated = await status({ to: "VALIDATED" });
    if (validated.statusCode === 409) {
      const reasons = validated.json().error.details.reasons.join(" | ");
      assert.equal(
        /No backtest results available/.test(reasons),
        false,
        `the gate must see the stored run; got ${reasons}`,
      );
    } else {
      assert.equal(validated.statusCode, 200, validated.body);
      assert.equal(validated.json().strategy.lifecycle, "VALIDATED");
    }
  } finally {
    await instance.cleanup();
  }
});

test("retirement is available over HTTP and records the reason", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const response = await instance.app.inject({
      method: "POST", url: "/api/v1/strategies/breakout/status", headers: session.headers,
      payload: { to: "RETIRED", reason: "superseded" },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().strategy.lifecycle, "RETIRED");
    assert.equal(response.json().strategy.lifecycle_history.at(-1).reason, "superseded");

    // RETIRED is terminal.
    const again = await instance.app.inject({
      method: "POST", url: "/api/v1/strategies/breakout/status", headers: session.headers,
      payload: { to: "BACKTESTED" },
    });
    assert.equal(again.statusCode, 409);
    assert.deepEqual(again.json().error.details.reasons, ["Strategy is RETIRED — lifecycle is terminal"]);
  } finally {
    await instance.cleanup();
  }
});

test("lifecycle changes are audited against the acting account", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    await instance.app.inject({
      method: "POST", url: "/api/v1/backtesting/run", headers: session.headers, payload: RUN_BODY,
    });
    await instance.app.inject({
      method: "POST", url: "/api/v1/strategies/trend-following/status", headers: session.headers,
      payload: { to: "BACKTESTED" },
    });

    // `listAuditEvents` returns {total, events}, not a bare array.
    const { events } = await instance.store.listAuditEvents({ limit: 200 });
    const actions = events.map((event) => event.action);
    assert.ok(actions.includes("strategies.backtest.started"), `got ${actions.join(", ")}`);
    assert.ok(actions.includes("strategies.backtest.completed"));
    assert.ok(actions.includes("strategies.status-changed"));

    const completed = events.find((event) => event.action === "strategies.backtest.completed");
    assert.equal(completed.entityType, "strategy");
    assert.equal(completed.entityId, "trend-following");
    assert.equal(completed.details.synthetic, true, "the audit row records that the evidence was synthetic");
    assert.equal(typeof completed.details.trades, "number");

    // `listAuditEvents` projects no actorId, so attribution is proved through its
    // userId filter rather than by reading a field that is not there.
    const admin = await instance.store.findUserByIdentifier("rootadmin");
    assert.ok(admin, "the seeded administrator must exist");
    const attributed = await instance.store.listAuditEvents({ userId: admin.id, limit: 200 });
    const attributedActions = attributed.events.map((event) => event.action);
    assert.ok(
      attributedActions.includes("strategies.backtest.completed"),
      `the run must be attributed to the account that requested it; got ${attributedActions.join(", ")}`,
    );
    assert.ok(attributedActions.includes("strategies.status-changed"));
    // And the filter really filters: an unrelated account sees none of them.
    const nobody = await instance.store.listAuditEvents({ userId: admin.id + 9999, limit: 200 });
    assert.equal(nobody.total, 0);
  } finally {
    await instance.cleanup();
  }
});

// ============================================================================
// optimization
// ============================================================================

test("POST /strategies/:id/optimize returns a walk-forward report", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const response = await instance.app.inject({
      method: "POST", url: "/api/v1/strategies/trend-following/optimize", headers: session.headers,
      payload: { symbol: "BTCUSDT", marketClass: "crypto", timeframe: "1h", limit: 600 },
    });
    assert.equal(response.statusCode, 200, response.body);
    const report = response.json();

    assert.equal(report.searchSpace.gridSize, 24, "the trend-following grid");
    assert.equal(report.split.inSampleBars + report.split.outOfSampleBars, 600);
    assert.ok(report.baseline.inSample);
    assert.ok(report.baseline.outOfSample);
    assert.ok(report.finalists.length <= 3);
    assert.match(report.methodNote, /never recommended/);
    // The request and provenance are attached so the report says what it ran on.
    assert.deepEqual(report.request, {
      strategyId: "trend-following",
      strategyVersion: "1.0.0",
      symbol: "BTCUSDT",
      marketClass: "crypto",
      timeframe: "1h",
      limit: 600,
    });
    assert.equal(report.dataProvenance.synthetic, true);
    assert.equal(report.registeredVariant, undefined, "nothing is registered unless asked");
  } finally {
    await instance.cleanup();
  }
});

test("POST /strategies/:id/optimize refuses a strategy that is not a builtin", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const response = await instance.app.inject({
      method: "POST", url: "/api/v1/strategies/not-a-strategy/optimize", headers: session.headers, payload: {},
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, "STRATEGY_NOT_OPTIMIZABLE");
    assert.match(
      response.json().error.message,
      /optimization requires a builtin strategy \(trend-following, mean-reversion, breakout, momentum\)/,
    );
  } finally {
    await instance.cleanup();
  }
});

test("the optimizer's candle floor is enforced, and a short history is a 400", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    // The service clamps `limit` into 420..2000, so a small request is raised to
    // the floor rather than refused — which is what makes the search valid.
    const clamped = await instance.app.inject({
      method: "POST", url: "/api/v1/strategies/momentum/optimize", headers: session.headers,
      payload: { symbol: "BTCUSDT", marketClass: "crypto", limit: 10 },
    });
    assert.equal(clamped.statusCode, 200, clamped.body);
    assert.equal(clamped.json().request.limit, 420, "the floor is 420 so both segments are usable");
    assert.equal(clamped.json().split.inSampleBars + clamped.json().split.outOfSampleBars, 420);

    const ceiling = await instance.app.inject({
      method: "POST", url: "/api/v1/strategies/momentum/optimize", headers: session.headers,
      payload: { symbol: "BTCUSDT", marketClass: "crypto", limit: 99999 },
    });
    assert.equal(ceiling.json().request.limit, 2000, "the ceiling bounds one request's work");
  } finally {
    await instance.cleanup();
  }
});

test("optimize infers the market class the legacy way, so gold is a commodity", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    // `market-data`'s own inferMarketClass would call XAUUSD forex; the legacy
    // PaperTradingEngine mapping the service imports calls it a commodity. Which
    // one is used decides which candles are fetched, so it is worth pinning.
    const response = await instance.app.inject({
      method: "POST", url: "/api/v1/strategies/breakout/optimize", headers: session.headers,
      payload: { symbol: "xauusd", limit: 420 },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().request.marketClass, "commodity");
    assert.equal(response.json().request.symbol, "XAUUSD", "the symbol is upper-cased by the service");
    assert.equal(response.json().request.timeframe, "1h", "the legacy default");
  } finally {
    await instance.cleanup();
  }
});

test("optimize with register=true adopts a winning variant as source ai at DRAFT", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const response = await instance.app.inject({
      method: "POST", url: "/api/v1/strategies/trend-following/optimize", headers: session.headers,
      payload: { symbol: "BTCUSDT", marketClass: "crypto", limit: 600, register: true },
    });
    assert.equal(response.statusCode, 200, response.body);
    const report = response.json();

    if (!report.recommendation.adopt) {
      // Nothing survived out-of-sample verification on this synthetic series, so
      // there is nothing to register — and registering anyway would be the bug.
      assert.equal(report.registeredVariant, undefined);
      return;
    }

    assert.ok(report.registeredVariant, "an adopted recommendation must be registered when asked");
    assert.equal(report.registeredVariant.strategyId, "trend-following");
    assert.equal(report.registeredVariant.version, "1.0.1", "the next patch version");
    assert.equal(report.registeredVariant.lifecycle, "DRAFT");
    assert.match(report.registeredVariant.note, /source ai/);

    const stored = await instance.store.findStrategy("trend-following", "1.0.1");
    assert.ok(stored, "the variant must be persisted");
    assert.equal(stored.source, "ai");
    assert.equal(stored.lifecycle, "DRAFT");
    assert.deepEqual(stored.params, report.recommendation.params);
    assert.match(stored.lifecycle_history[0].reason, /optimizer variant from @1\.0\.0/);

    // The governance consequence, over HTTP: an ai variant cannot reach paper.
    const paper = await instance.app.inject({
      method: "POST", url: "/api/v1/strategies/trend-following/status", headers: session.headers,
      payload: { to: "PAPER_TRADING", version: "1.0.1" },
    });
    assert.equal(paper.statusCode, 409, paper.body);
  } finally {
    await instance.cleanup();
  }
});

// ============================================================================
// cost control (R-26 applied at birth)
// ============================================================================

test("createStrategyRunGate caps in-flight jobs per session and releases on error", () => {
  const held = new Map();
  const tracker = {
    acquire(key, max) {
      const current = held.get(key) ?? 0;
      if (current >= max) return false;
      held.set(key, current + 1);
      return true;
    },
    release(key) {
      const current = held.get(key) ?? 0;
      if (current > 0) held.set(key, current - 1);
    },
    count: (key) => held.get(key) ?? 0,
  };
  const gate = createStrategyRunGate({ tracker, max: 1 });
  const request = { auth: { user: { id: 7 } }, clientAddress: "203.0.113.9" };

  assert.equal(gate.disabled, false);
  assert.equal(gate.keyOf(request), "strategies:session:7");
  const slot = gate.acquire(request);
  assert.equal(slot, "strategies:session:7");
  assert.equal(gate.inFlight(request), 1);

  let thrown = null;
  try {
    gate.acquire(request);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "a second concurrent job must be refused");
  assert.equal(thrown.statusCode, 429);
  assert.equal(thrown.code, "TOO_MANY_CONCURRENT_STRATEGY_RUNS");
  assert.equal(thrown.retryAfter, 1);
  assert.match(thrown.message, /At most 1 strategy job may be in flight per session/);

  gate.release(slot);
  assert.equal(gate.inFlight(request), 0);
  // Releasing twice, and releasing a disabled gate's null, must both be safe: the
  // route calls release in `finally` whatever happened.
  gate.release(slot);
  gate.release(null);
  assert.equal(gate.inFlight(request), 0);

  // A different session is unaffected — the cap is per session, not global.
  const other = { auth: { user: { id: 8 } } };
  assert.equal(gate.keyOf(other), "strategies:session:8");
  assert.notEqual(gate.acquire(other), null);

  // Unauthenticated falls back to the address, so the key stays total.
  assert.equal(gate.keyOf({ clientAddress: "203.0.113.9" }), "strategies:client:203.0.113.9");
});

test("createStrategyRunGate is disabled by 0 or a missing tracker, and never refuses", () => {
  const request = { auth: { user: { id: 7 } } };
  for (const options of [{ tracker: null, max: 5 }, { tracker: {}, max: 0 }, { tracker: {}, max: -1 }]) {
    const gate = createStrategyRunGate(options);
    assert.equal(gate.disabled, true, `${JSON.stringify(options)} must disable the cap`);
    assert.equal(gate.acquire(request), null);
    assert.equal(gate.inFlight(request), 0);
    gate.release(null);
  }
});

test("the backtest window limit throttles its own route and leaves the reads alone", async () => {
  const instance = await harness({ env: { RATE_LIMIT_STRATEGY_BACKTEST_MAX: "2" } });
  try {
    const session = await signIn(instance.app);
    const post = () =>
      instance.app.inject({ method: "POST", url: "/api/v1/backtesting/run", headers: session.headers, payload: RUN_BODY });

    assert.equal((await post()).statusCode, 200);
    assert.equal((await post()).statusCode, 200);
    const limited = await post();
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal(limited.json().error.code, "RATE_LIMITED");
    assert.ok(Number(limited.headers["retry-after"]) > 0, "the client is told how long to wait");

    // The limit is per route: the cheap reads still answer, and so does optimize,
    // which has its own separate budget.
    const list = await instance.app.inject({
      method: "GET", url: "/api/v1/backtesting/results", headers: session.headers,
    });
    assert.equal(list.statusCode, 200);
    const strategies = await instance.app.inject({ method: "GET", url: "/api/v1/strategies", headers: session.headers });
    assert.equal(strategies.statusCode, 200);
  } finally {
    await instance.cleanup();
  }
});

test("the optimize window limit is separate from the backtest limit", async () => {
  const instance = await harness({ env: { RATE_LIMIT_STRATEGY_OPTIMIZE_MAX: "1" } });
  try {
    const session = await signIn(instance.app);
    const optimize = () =>
      instance.app.inject({
        method: "POST", url: "/api/v1/strategies/momentum/optimize", headers: session.headers,
        payload: { symbol: "BTCUSDT", marketClass: "crypto", limit: 420 },
      });

    assert.equal((await optimize()).statusCode, 200);
    const limited = await optimize();
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal(limited.json().error.code, "RATE_LIMITED");

    // A backtest has its own budget and is unaffected by the optimize limit.
    const run = await instance.app.inject({
      method: "POST", url: "/api/v1/backtesting/run", headers: session.headers, payload: RUN_BODY,
    });
    assert.equal(run.statusCode, 200, run.body);
  } finally {
    await instance.cleanup();
  }
});

test("a route limit is charged before validation, so a bad request cannot probe for free", async () => {
  const instance = await harness({ env: { RATE_LIMIT_STRATEGY_BACKTEST_MAX: "1" } });
  try {
    const session = await signIn(instance.app);
    // The first request is invalid, but it still consumes the window budget.
    const invalid = await instance.app.inject({
      method: "POST", url: "/api/v1/backtesting/run", headers: session.headers, payload: { symbol: "BTCUSDT" },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);

    const valid = await instance.app.inject({
      method: "POST", url: "/api/v1/backtesting/run", headers: session.headers, payload: RUN_BODY,
    });
    assert.equal(valid.statusCode, 429, "the budget was already spent by the refused request");
    assert.equal(valid.json().error.code, "RATE_LIMITED");
  } finally {
    await instance.cleanup();
  }
});
