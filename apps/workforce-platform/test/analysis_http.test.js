/**
 * Analysis module — the engine, the HTTP surface and persistence.
 *
 * The two cases prefixed `legacy 08-engine-journal` are ported from
 * `tests/cases/08-engine-journal.php`, which ran the engine against the legacy
 * database. Here they run against the durable file adapter, which is the same
 * adapter the local preview uses, so the persistence path is real rather than
 * mocked.
 *
 * Everything is hermetic: `MARKET_DATA_REAL_PROVIDERS=0` means the provider chain
 * contains only the synthetic generator, so no test in this file can reach the
 * network. Where a run needs a *live* or *stale* series — states this sandbox
 * cannot produce honestly — a test double supplies the series and the test says so.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { cookieFrom, createFileStoreApp } from "./helpers.js";
import { createMarketDataService } from "../src/modules/market-data/service.js";
import { createAnalysisService } from "../src/modules/analysis/service.js";
import { createAnalysisEngine, CANDLE_LIMIT, DEFAULT_TRADING_STATE, REFERENCE_SYMBOLS } from "../src/modules/analysis/engine.js";
import { AGENT_CATALOGUE, DEFAULT_WATCHLIST, inferMarketClass } from "../src/modules/analysis/contracts.js";
import { generateSyntheticCandles } from "../src/modules/market-data/providers/synthetic.js";

const ANALYSIS_ENV = { PUBLIC_BASE_URL: "https://site.example.test", MARKET_DATA_REAL_PROVIDERS: "0" };
const FIXTURE_NOW = 1_755_000_000_000;
const HOUR = 3_600_000;
const BIASES = ["BULLISH", "BEARISH", "NEUTRAL", "NO_TRADE"];

async function signIn(app) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifier: "rootadmin", password: "Root administrator pass" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  return { cookie: cookieFrom(response), csrfToken: body.csrfToken, headers: { cookie: cookieFrom(response), "x-csrf-token": body.csrfToken } };
}

/**
 * Validation failures carry `error.details` as a flat array of
 * `{field, code, message}` — the same envelope every other module uses.
 */
function rejectedFields(response) {
  const details = response.json()?.error?.details;
  const issues = Array.isArray(details) ? details : (details?.fields || []);
  return issues.map((issue) => issue.field);
}

function harness(options = {}) {
  return createFileStoreApp({ configOverrides: { env: { ...ANALYSIS_ENV, ...(options.env || {}) } }, ...options });
}

/** A service on the real file adapter with the provider chain settled to zero. */
function buildService(harnessInstance, overrides = {}) {
  const marketData = overrides.marketData || createMarketDataService({
    config: harnessInstance.config,
    store: harnessInstance.store,
    settleMs: 0,
  });
  return createAnalysisService({ store: harnessInstance.store, marketData, ...overrides });
}

/**
 * A market-data double. It serves deterministic candles with the provenance the
 * test needs (live, stale, synthetic) without touching a provider, and records
 * every call so a test can assert what the engine fetched.
 */
function stubMarketData({ synthetic = false, stale = false, source = "test-live", candles = null, failWith = null } = {}) {
  const calls = [];
  const series = (symbol, marketClass, timeframe, limit) => {
    const rows = candles || generateSyntheticCandles(symbol, timeframe, limit, FIXTURE_NOW);
    const lastTimestamp = rows.length ? rows[rows.length - 1].timestamp : 0;
    return {
      symbol,
      marketClass,
      timeframe,
      candles: rows,
      provenance: {
        source,
        synthetic,
        live: !synthetic,
        delayed: false,
        fetchedAt: FIXTURE_NOW,
        dataTimestamp: lastTimestamp,
        dataAgeMs: stale ? 99 * HOUR : 0,
        stale,
        staleThresholdMs: 3 * HOUR,
        fallbackChain: [],
        fromCache: false,
      },
      validation: {
        ok: true, droppedCount: 0, gapCount: 0, expectedIntervalMs: HOUR,
        coveredIntervalMs: 0, minTimestamp: 0, maxTimestamp: lastTimestamp, issues: [],
      },
    };
  };
  return {
    calls,
    async candles({ symbol, timeframe, marketClass = null, limit = 200 }) {
      calls.push({ kind: "candles", symbol, timeframe, marketClass, limit });
      if (failWith) throw failWith;
      return series(String(symbol).toUpperCase(), marketClass || "forex", timeframe, limit);
    },
    async quote({ symbol }) {
      calls.push({ kind: "quote", symbol });
      if (failWith) throw failWith;
      return { symbol: String(symbol).toUpperCase(), quote: { bid: 1, ask: 1.0001, last: 1 }, provenance: { source, synthetic } };
    },
  };
}

// ---- legacy 08-engine-journal -----------------------------------------------

test("legacy 08-engine-journal: a full run persists, audits, and the risk engine vetoes synthetic data", async () => {
  const instance = await harness();
  try {
    const service = buildService(instance);

    // BTCUSDT on the deterministic synthetic series: the panel reports, no proposal.
    const scan = await service.run({ symbol: "BTCUSDT", marketClass: "crypto", timeframe: "1h" });
    assert.equal(scan.symbol, "BTCUSDT");
    assert.equal(scan.provenance.synthetic, true, "this sandbox has no egress, so the candles are labelled synthetic");
    assert.match(scan.provenance.source, /synthetic-demo/);
    assert.ok(BIASES.includes(scan.bias), `unexpected bias ${scan.bias}`);
    assert.ok(scan.confidence >= 0 && scan.confidence <= 1);
    assert.ok(scan.agents.length >= 3, `expected a panel, got ${scan.agents.length}`);
    const agentIds = scan.agents.map((agent) => agent.agent);
    assert.ok(agentIds.includes("technical"));
    assert.ok(agentIds.includes("crypto"));
    assert.ok(!agentIds.includes("forex"), "a crypto symbol must not be analysed by the forex agent");
    assert.ok(agentIds.includes("sentiment") && agentIds.includes("fundamentals"), "both abstaining agents still report");

    // ETHUSDT on the same series does produce a proposal, so the veto is exercised.
    const run = await service.run({ symbol: "ETHUSDT", marketClass: "crypto", timeframe: "1h" });
    assert.ok(run.tradeSetup, "the deterministic synthetic ETHUSDT series produces a proposal");
    assert.ok(run.riskDecision, "a proposal is always measured by the risk engine");
    assert.equal(run.riskDecision.approved, false, "nothing may be approved on this platform");
    assert.match(run.riskDecision.reasons[0], /Kill switch is ACTIVE/, "the kill switch is the first veto");
    assert.ok(run.riskDecision.reasons.some((reason) => /SYNTHETIC/.test(reason)), "the synthetic veto also fires");

    // Persisted, and readable back both ways.
    const found = await service.find(run.id);
    assert.ok(found, "the run is persisted");
    assert.equal(found.id, run.id);
    assert.equal(found.debate.verdict.bias, run.debate.verdict.bias, "the payload is the run, not a summary of it");
    const history = await service.history({ limit: 5 });
    assert.equal(history.runs.filter((row) => row.id === run.id).length, 1);
    assert.equal(history.runs.length, 2, "both runs are listed");
    // A history row is a summary: no payload, so the list stays cheap.
    assert.deepEqual(Object.keys(history.runs[0]).sort(), [
      "bias", "completedAt", "confidence", "id", "recommendation", "regime", "source", "symbol", "synthetic", "timeframe",
    ]);

    // Audited, with the legacy action names preserved for cutover traceability.
    const { events } = await instance.store.listAuditEvents({ limit: 100 });
    const analyzed = events.filter((event) => event.action === "analysis.run.completed");
    assert.equal(analyzed.length, 2);
    // Located by run id, never by position: this harness settles provider calls to
    // zero, so two runs can share a millisecond, and `listAuditEvents` sorts equal
    // timestamps in insertion order. Asserting on `[0]` would be a flake.
    const ethAudit = analyzed.find((event) => event.entityId === run.id);
    assert.ok(ethAudit, "the ETHUSDT run is audited");
    assert.equal(ethAudit.details.legacyAction, "TRADE_ANALYZED");
    assert.match(ethAudit.details.message, /^ETHUSDT 1h: (BULLISH|BEARISH|NEUTRAL|NO_TRADE) @ \d\.\d\d confidence$/);
    assert.equal(ethAudit.details.synthetic, true);
    assert.ok(analyzed.every((event) => event.details.legacyAction === "TRADE_ANALYZED"));
    assert.ok(events.some((event) => event.action === "analysis.signal.proposed" && event.details.legacyAction === "SIGNAL_GENERATED"));
    const rejected = events.find((event) => event.action === "risk.decision.rejected");
    assert.ok(rejected, "the veto is audited");
    assert.equal(rejected.details.legacyAction, "RISK_REJECTED");
    assert.equal(rejected.details.approved, false);
    assert.ok(rejected.details.reasons.length >= 2);
    assert.ok(!events.some((event) => event.action === "risk.decision.approved"), "nothing was approved");
  } finally {
    await instance.cleanup();
  }
});

test("legacy 08-engine-journal: consensus across symbols", async () => {
  const instance = await harness();
  try {
    const service = buildService(instance);
    const result = await service.consensus({
      timeframe: "1h",
      symbols: ["BTCUSDT", "EURUSD"],
    });
    assert.equal(result.consensus.length, 2);
    for (const row of result.consensus) {
      assert.ok(BIASES.includes(row.bias), `unexpected bias ${row.bias}`);
      assert.ok(row.confidence >= 0 && row.confidence <= 1);
      assert.equal(row.synthetic, true);
      assert.match(row.source, /synthetic-demo/);
      assert.ok(row.runId, "each consensus row points at the run that produced it");
    }
    assert.equal(result.consensus[0].symbol, "btcusdt".toUpperCase(), "symbols are upper-cased");
    assert.equal(result.consensus[0].marketClass, "crypto");
    assert.equal(result.consensus[1].marketClass, "forex");
    assert.match(result.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await instance.cleanup();
  }
});

test("legacy 34-agent-debate: the engine run carries the transcript and honors the verdict", async () => {
  const instance = await harness();
  try {
    const run = await buildService(instance).run({ symbol: "BTCUSDT", marketClass: "crypto", timeframe: "1h" });

    assert.ok(run.debate, "debate present in the analysis run");
    assert.ok(run.debate.verdict.bias, "the verdict states a bias");
    assert.ok(Array.isArray(run.debate.verdict.reasoning));
    assert.equal(run.debate.rounds.length, 4, "the transcript keeps all four rounds");
    assert.equal(run.confidence, run.debate.verdict.confidence, "the run reports the post-debate confidence, not the pre-debate one");

    // Verdict binding: a downgrade carries through to the run and drops the proposal.
    if (run.debate.verdict.bias === "NO_TRADE") {
      assert.equal(run.bias, "NO_TRADE");
      assert.equal(run.tradeSetup, null);
      assert.equal(run.recommendation, "NO_TRADE");
    } else if (run.debate.verdict.bias === "NEUTRAL") {
      assert.equal(run.bias, "NEUTRAL");
      assert.equal(run.tradeSetup, null, "a neutral verdict cannot carry a proposal");
      assert.equal(run.recommendation, "HOLD");
    } else {
      assert.equal(run.bias, run.debate.verdict.bias);
    }

    assert.ok(run.confidence <= 1.0);
    // Node strengthening: the debate may only cut confidence, so the adjustment is
    // never positive and the pre-debate figure is recoverable from the verdict.
    assert.ok(run.debate.verdict.confidenceAdjustment <= 0, "the debate reduces confidence or leaves it alone");
    const preDebate = run.confidence - run.debate.verdict.confidenceAdjustment;
    assert.ok(run.confidence <= preDebate + 1e-9);
  } finally {
    await instance.cleanup();
  }
});

// ---- engine behaviour --------------------------------------------------------

test("engine: a stale series is a critical objection, so the run becomes NO_TRADE with no proposal", async () => {
  const instance = await harness();
  try {
    // EURUSD live-ish candles that produce a directional bias, then marked stale:
    // the same numbers, one flag different, and the answer must change.
    const fresh = buildService(instance, { marketData: stubMarketData({ synthetic: false }) });
    const freshRun = await fresh.run({ symbol: "EURUSD", marketClass: "forex", timeframe: "1h" });
    assert.notEqual(freshRun.bias, "NO_TRADE", "the fixture is directional before it is marked stale");

    const staleService = buildService(instance, { marketData: stubMarketData({ synthetic: false, stale: true }) });
    const staleRun = await staleService.run({ symbol: "EURUSD", marketClass: "forex", timeframe: "1h" });
    assert.equal(staleRun.provenance.stale, true);
    assert.equal(staleRun.bias, "NO_TRADE", "stale data is a sustained critical objection");
    assert.equal(staleRun.recommendation, "NO_TRADE");
    assert.equal(staleRun.tradeSetup, null, "the proposal is dropped, not merely vetoed");
    assert.equal(staleRun.riskDecision, null);
    const critical = staleRun.debate.rounds[2].objections.find((objection) => objection.id === "S3");
    assert.equal(critical.sustained, true);
    assert.match(staleRun.debate.verdict.reasoning.join(";"), /critical objection/);
    assert.ok(staleRun.confidence < freshRun.confidence, "the verdict reduces confidence");
  } finally {
    await instance.cleanup();
  }
});

test("engine: live data clears the data vetoes, and the kill switch is still the binding one", async () => {
  const instance = await harness();
  try {
    const service = buildService(instance, { marketData: stubMarketData({ synthetic: false, source: "test-live" }) });
    const run = await service.run({ symbol: "EURUSD", marketClass: "forex", timeframe: "1h" });

    assert.equal(run.provenance.synthetic, false);
    assert.equal(run.provenance.live, true);
    assert.equal(run.provenance.source, "test-live");
    assert.equal(run.riskContext.syntheticData, false);
    assert.equal(run.riskContext.staleData, false);
    // Freshness feeds the consensus: live data scores 1.0, synthetic 0.5, stale 0.2.
    assert.ok(run.confidence > 0, "a live series is not gated on freshness");

    if (run.tradeSetup) {
      assert.equal(run.riskDecision.approved, false);
      assert.match(run.riskDecision.reasons[0], /Kill switch is ACTIVE/);
      assert.ok(!run.riskDecision.reasons.some((reason) => /SYNTHETIC|stale/.test(reason)),
        "with live, fresh data only the kill switch objects");
    }
    // `riskContext` is the trading state carried into the run, so the kill switch
    // appears in its nested legacy shape rather than as a flat boolean.
    assert.equal(run.riskContext.killSwitch.active, true);
    assert.equal(run.riskContext.tradingMode, "ANALYSIS_ONLY");
    assert.match(run.riskContext.note, /not ported/, "the run states why the portfolio gates are vacuous");
  } finally {
    await instance.cleanup();
  }
});

test("engine: an agent that throws is audited and the run continues without it", async () => {
  const instance = await harness();
  try {
    const failing = {
      id: "technical",
      applicable: () => true,
      analyze: () => { throw new Error("indicator overflow"); },
    };
    const engine = createAnalysisEngine({
      marketData: stubMarketData({}),
      store: instance.store,
      agents: [failing],
    });
    const run = await engine.run("BTCUSDT", "crypto", "1h");

    assert.deepEqual(run.agents, [], "the failed agent contributes no report");
    assert.equal(run.bias, "NO_TRADE", "a panel with no votes cannot recommend a trade");
    assert.deepEqual(run.signals, []);
    assert.deepEqual(run.scenarios.bullish.triggers, [], "no technical report means no scenarios");
    assert.equal(run.scenarios.neutral.summary, "insufficient data");
    assert.equal(run.tradeSetup, null);

    const { events } = await instance.store.listAuditEvents({ limit: 20 });
    const failure = events.find((event) => event.action === "analysis.agent.failed");
    assert.ok(failure, "the failure is audited rather than swallowed");
    assert.equal(failure.details.legacyAction, "TRADE_REJECTED");
    assert.equal(failure.details.agent, "technical");
    assert.match(failure.details.error, /indicator overflow/);
  } finally {
    await instance.cleanup();
  }
});

test("engine: an injected sentiment feed reaches the panel and votes", async () => {
  const instance = await harness();
  try {
    const nowSeconds = Math.floor(FIXTURE_NOW / 1000);
    const feed = {
      id: () => "licensed-test-feed",
      health: () => ({ state: "UP", licensed: true, message: "test" }),
      snapshot: (symbol) => ({
        available: true,
        symbol,
        source: "test-newswire",
        observedAt: nowSeconds - 30,
        licensed: true,
        observations: [
          { channel: "news", source: "test-newswire", observedAt: nowSeconds - 30, score: 0.8, sampleSize: 25 },
          { channel: "social", source: "test-social", observedAt: nowSeconds - 45, score: 0.6, sampleSize: 500 },
        ],
      }),
    };
    const engine = createAnalysisEngine({
      marketData: stubMarketData({ synthetic: false }),
      store: instance.store,
      now: () => FIXTURE_NOW,
      sentimentFeed: feed,
    });
    const run = await engine.run("BTCUSDT", "crypto", "1h");
    const sentiment = run.agents.find((agent) => agent.agent === "sentiment");

    assert.equal(sentiment.vote.votes, true, "a licensed, fresh, attributable feed votes");
    assert.ok(sentiment.dataQuality > 0);
    assert.equal(sentiment.provenance.feed, "licensed-test-feed");
    assert.ok(run.consensus.votingAgents.includes("sentiment"));
    assert.ok(!run.consensus.abstainingAgents.includes("sentiment"));
    // Fundamentals still abstains: one licensed feed does not make the other exist.
    const fundamentals = run.agents.find((agent) => agent.agent === "fundamentals");
    assert.equal(fundamentals.vote.votes, false);
    assert.ok(run.consensus.abstainingAgents.includes("fundamentals"));
  } finally {
    await instance.cleanup();
  }
});

test("engine: a market-data outage surfaces as the provider's own refusal", async () => {
  const instance = await harness();
  try {
    const refused = Object.assign(new Error("No provider could serve candles for BTCUSDT 1h and synthetic data is refused on this host (MARKET_DATA_ALLOW_SYNTHETIC=0). Failed: binance"), { failedProviders: ["binance"] });
    const engine = createAnalysisEngine({ marketData: stubMarketData({ failWith: refused }), store: instance.store });
    await assert.rejects(() => engine.run("BTCUSDT", "crypto", "1h"), /synthetic data is refused on this host/);

    // A consensus scan reports the failure per symbol instead of failing the batch.
    const rows = await engine.consensus([
      { symbol: "BTCUSDT", marketClass: "crypto", timeframe: "1h" },
      { symbol: "EURUSD", marketClass: "forex", timeframe: "1h" },
    ]);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.bias, "NO_TRADE");
      assert.equal(row.confidence, 0);
      assert.equal(row.regime, "UNKNOWN");
      assert.match(row.source, /^error: /, "a symbol that cannot be analysed says why");
      assert.equal(row.runId, null);
    }
  } finally {
    await instance.cleanup();
  }
});

test("engine: reference series are fetched for forex and commodities only", async () => {
  const instance = await harness();
  try {
    const cryptoStub = stubMarketData({});
    await createAnalysisEngine({ marketData: cryptoStub, store: instance.store }).run("BTCUSDT", "crypto", "1h");
    const cryptoSymbols = cryptoStub.calls.filter((call) => call.kind === "candles").map((call) => call.symbol);
    assert.deepEqual(cryptoSymbols, ["BTCUSDT"], "a crypto run fetches one series");
    assert.ok(cryptoStub.calls.some((call) => call.kind === "quote"), "the quote is fetched for the run payload");
    assert.equal(cryptoStub.calls.find((call) => call.kind === "candles").limit, CANDLE_LIMIT);

    const forexStub = stubMarketData({});
    await createAnalysisEngine({ marketData: forexStub, store: instance.store }).run("EURUSD", "forex", "1h");
    const forexCalls = forexStub.calls.filter((call) => call.kind === "candles");
    assert.deepEqual(forexCalls.map((call) => call.symbol), ["EURUSD", ...REFERENCE_SYMBOLS]);
    assert.equal(forexCalls[1].limit, 60, "reference legs are short series");
    assert.equal(forexCalls[1].marketClass, "forex");

    // Gold is a commodity, and the forex agent accepts commodities, so it gets the
    // same currency-strength treatment.
    const goldStub = stubMarketData({});
    await createAnalysisEngine({ marketData: goldStub, store: instance.store }).run("XAUUSD", "commodity", "1h");
    assert.equal(goldStub.calls.filter((call) => call.kind === "candles").length, 1 + REFERENCE_SYMBOLS.length);
  } finally {
    await instance.cleanup();
  }
});

test("engine: a missing reference leg weakens the strength table but does not fail the run", async () => {
  const instance = await harness();
  try {
    const base = stubMarketData({});
    const partial = {
      ...base,
      async candles(request) {
        // Every other reference leg is unavailable.
        if (request.symbol !== "EURUSD" && REFERENCE_SYMBOLS.includes(request.symbol) && request.limit === 60) {
          if (["USDJPY", "AUDUSD", "USDCAD"].includes(request.symbol)) throw new Error("provider down");
        }
        return base.candles(request);
      },
    };
    const run = await createAnalysisEngine({ marketData: partial, store: instance.store }).run("EURUSD", "forex", "1h");
    const forex = run.agents.find((agent) => agent.agent === "forex");
    assert.ok(forex, "the forex agent still reports");
    const currencies = forex.currencyStrength.scores.map((entry) => entry.currency);
    assert.ok(!currencies.includes("JPY"), "a reference leg that failed contributes nothing");
    assert.ok(currencies.includes("EUR") && currencies.includes("USD"));
    assert.match(forex.currencyStrength.note, /NOT news or fundamental data/);
  } finally {
    await instance.cleanup();
  }
});

test("engine: the trading state cannot be quietly relaxed by a caller", () => {
  assert.equal(DEFAULT_TRADING_STATE.killSwitch.active, true, "the kill switch is engaged by default");
  assert.equal(DEFAULT_TRADING_STATE.tradingMode, "ANALYSIS_ONLY");
  assert.equal(Object.isFrozen(DEFAULT_TRADING_STATE), true);
  assert.equal(Object.isFrozen(DEFAULT_TRADING_STATE.killSwitch), true);
  assert.match(DEFAULT_TRADING_STATE.note, /no proposal can be approved/i);
  assert.equal(DEFAULT_TRADING_STATE.equity, 10_000);
  assert.deepEqual(DEFAULT_TRADING_STATE.openRiskBySymbol, {});
});

test("contracts: the legacy market-class inference maps gold to a commodity", () => {
  assert.equal(inferMarketClass("eurusd"), "forex");
  assert.equal(inferMarketClass("XAUUSD"), "commodity");
  assert.equal(inferMarketClass("BTCUSDT"), "crypto");
  assert.equal(inferMarketClass("SOLUSDT"), "crypto");
  assert.equal(inferMarketClass("GBPJPY"), "forex", "an unlisted pair falls back to forex, as the legacy mapping did");
  assert.equal(inferMarketClass("  nzdusd  "), "forex");
  assert.deepEqual([...DEFAULT_WATCHLIST], ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  assert.equal(AGENT_CATALOGUE.length, 7);
  assert.deepEqual(AGENT_CATALOGUE.map((agent) => agent.id), [
    "technical", "market-structure", "forex", "crypto", "sentiment", "fundamentals", "intelligence",
  ]);
});

// ---- HTTP surface ------------------------------------------------------------

test("analysis endpoints require an authenticated session", async () => {
  const instance = await harness();
  try {
    const attempts = [
      { method: "POST", url: "/api/v1/analysis/run", payload: { symbol: "BTCUSDT", marketClass: "crypto" } },
      { method: "GET", url: "/api/v1/analysis/history" },
      { method: "GET", url: "/api/v1/analysis/agents" },
      { method: "POST", url: "/api/v1/analysis/consensus", payload: {} },
      { method: "GET", url: "/api/v1/analysis/00000000-0000-0000-0000-000000000000" },
    ];
    for (const attempt of attempts) {
      const response = await instance.app.inject(attempt);
      assert.equal(response.statusCode, 401, `${attempt.method} ${attempt.url}`);
      assert.equal(response.json().error.code, "AUTH_REQUIRED");
    }
  } finally {
    await instance.cleanup();
  }
});

test("analysis mutations require the session CSRF token", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    for (const url of ["/api/v1/analysis/run", "/api/v1/analysis/consensus"]) {
      const withoutToken = await instance.app.inject({
        method: "POST", url, headers: { cookie: session.cookie },
        payload: url.endsWith("run") ? { symbol: "BTCUSDT", marketClass: "crypto" } : {},
      });
      assert.equal(withoutToken.statusCode, 403, url);
      assert.equal(withoutToken.json().error.code, "CSRF_INVALID");

      const wrongToken = await instance.app.inject({
        method: "POST", url, headers: { cookie: session.cookie, "x-csrf-token": "not-the-token" },
        payload: url.endsWith("run") ? { symbol: "BTCUSDT", marketClass: "crypto" } : {},
      });
      assert.equal(wrongToken.statusCode, 403, url);
    }
  } finally {
    await instance.cleanup();
  }
});

test("POST /analysis/run refuses an incomplete or out-of-vocabulary request", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const bodies = [
      [{ marketClass: "crypto" }, /symbol/],
      [{ symbol: "B", marketClass: "crypto" }, /symbol/],
      [{ symbol: "BTCUSDT" }, /marketClass/],
      [{ symbol: "BTCUSDT", marketClass: "forex", timeframe: "1h" }, null], // valid: checked below
      [{ symbol: "BTCUSDT", marketClass: "spot", timeframe: "1h" }, /marketClass/],
      [{ symbol: "BTCUSDT", marketClass: "crypto", timeframe: "2h" }, /timeframe/],
      [{ symbol: "BTCUSDT", marketClass: "crypto", timeframe: 60 }, /timeframe/],
      [{ symbol: 12345, marketClass: "crypto" }, /symbol/],
      [{ symbol: "BTCUSDT", marketClass: "CRYPTO", timeframe: "1h" }, /marketClass/],
    ];
    for (const [body, expected] of bodies) {
      const response = await instance.app.inject({ method: "POST", url: "/api/v1/analysis/run", headers: session.headers, payload: body });
      if (expected === null) {
        assert.equal(response.statusCode, 200, response.body);
        continue;
      }
      assert.equal(response.statusCode, 400, `${JSON.stringify(body)} → ${response.body}`);
      const fields = rejectedFields(response);
      assert.ok(fields.some((field) => expected.test(field)), `${JSON.stringify(body)} should complain about ${expected}, got ${fields.join(", ")}`);
    }
  } finally {
    await instance.cleanup();
  }
});

test("POST /analysis/run returns the full run, labelled and gated", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const response = await instance.app.inject({
      method: "POST",
      url: "/api/v1/analysis/run",
      headers: session.headers,
      payload: { symbol: "btcusdt", marketClass: "crypto", timeframe: "1h" },
    });
    assert.equal(response.statusCode, 200, response.body);
    const run = response.json();

    assert.equal(run.symbol, "BTCUSDT", "the symbol is upper-cased");
    assert.deepEqual(run.request, { symbol: "BTCUSDT", marketClass: "crypto", timeframe: "1h" });
    assert.ok(BIASES.includes(run.bias));
    assert.ok(["BUY", "SELL", "HOLD", "NO_TRADE"].includes(run.recommendation));
    assert.match(run.id, /^[0-9a-f-]{36}$/);
    assert.match(run.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(run.completedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(Object.keys(run.scenarios), ["bullish", "bearish", "neutral"]);
    assert.equal(run.debate.rounds.length, 4);
    assert.ok(Array.isArray(run.debate.verdict.reasoning));
    assert.equal(run.provenance.synthetic, true, "the response carries the market-data provenance forward");
    assert.equal(run.validation.ok, true);
    assert.ok(run.agents.length >= 3);
    // The kill switch appears in the nested trading-state shape the run carries.
    assert.equal(run.riskContext.killSwitch.active, true);
    assert.equal(run.riskContext.tradingMode, "ANALYSIS_ONLY");
    assert.equal(run.riskContext.canPlaceOrders, undefined, "the run does not claim an execution capability");

    // The run is retrievable by id, and the audit trail is attributed to the caller.
    const fetched = await instance.app.inject({ method: "GET", url: `/api/v1/analysis/${run.id}`, headers: { cookie: session.cookie } });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.json().id, run.id);
    assert.equal(fetched.json().bias, run.bias);

    // `listAuditEvents` does not project the actor column, so attribution is
    // proven through its filter: the row is visible to the account that ran it and
    // to nobody else. That is a stronger claim than reading a field back.
    const mine = await instance.store.listAuditEvents({ userId: 1, limit: 20 });
    const analyzed = mine.events.find((event) => event.action === "analysis.run.completed" && event.entityId === run.id);
    assert.ok(analyzed, "the run is audited against the signed-in account, not 'system'");
    assert.equal(analyzed.entityType, "analysis_run");
    assert.equal(analyzed.details.legacyAction, "TRADE_ANALYZED");
    const someoneElse = await instance.store.listAuditEvents({ userId: 999, limit: 20 });
    assert.ok(!someoneElse.events.some((event) => event.entityId === run.id), "the run is not attributed to another account");
  } finally {
    await instance.cleanup();
  }
});

test("GET /analysis/history lists summaries newest first and honors a bounded limit", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    for (const symbol of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
      const response = await instance.app.inject({
        method: "POST", url: "/api/v1/analysis/run", headers: session.headers,
        payload: { symbol, marketClass: "crypto", timeframe: "1h" },
      });
      assert.equal(response.statusCode, 200, response.body);
    }

    const all = await instance.app.inject({ method: "GET", url: "/api/v1/analysis/history", headers: { cookie: session.cookie } });
    assert.equal(all.statusCode, 200);
    const rows = all.json().runs;
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.symbol), ["SOLUSDT", "ETHUSDT", "BTCUSDT"], "newest first");
    const stamps = rows.map((row) => row.completedAt);
    assert.deepEqual(stamps, [...stamps].sort().reverse(), "the listing is ordered by completion time, descending");
    assert.ok(rows.every((row) => row.payload === undefined), "a summary row carries no payload");
    assert.ok(rows.every((row) => typeof row.synthetic === "boolean"));
    assert.ok(rows.every((row) => typeof row.confidence === "number"));

    const one = await instance.app.inject({ method: "GET", url: "/api/v1/analysis/history?limit=1", headers: { cookie: session.cookie } });
    assert.equal(one.json().runs.length, 1);
    assert.equal(one.json().runs[0].symbol, "SOLUSDT");

    const tooMany = await instance.app.inject({ method: "GET", url: "/api/v1/analysis/history?limit=500", headers: { cookie: session.cookie } });
    assert.equal(tooMany.statusCode, 400, "the limit is bounded by the contract, not silently clamped");

    const notANumber = await instance.app.inject({ method: "GET", url: "/api/v1/analysis/history?limit=abc", headers: { cookie: session.cookie } });
    assert.equal(notANumber.statusCode, 400);
  } finally {
    await instance.cleanup();
  }
});

test("GET /analysis/:runId distinguishes a malformed id from a missing run", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);

    const missing = await instance.app.inject({
      method: "GET",
      url: "/api/v1/analysis/00000000-0000-0000-0000-000000000000",
      headers: { cookie: session.cookie },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "ANALYSIS_RUN_NOT_FOUND");

    const malformed = await instance.app.inject({
      method: "GET",
      url: `/api/v1/analysis/${"a".repeat(80)}`,
      headers: { cookie: session.cookie },
    });
    assert.equal(malformed.statusCode, 400, "an over-long id is refused by the contract");
  } finally {
    await instance.cleanup();
  }
});

test("GET /analysis/agents is not swallowed by the :runId route, and stays honest", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);

    // Static segments are registered first, so these must not be read as run ids.
    for (const url of ["/api/v1/analysis/agents", "/api/v1/analysis/history"]) {
      const response = await instance.app.inject({ method: "GET", url, headers: { cookie: session.cookie } });
      assert.equal(response.statusCode, 200, `${url} → ${response.body}`);
    }

    const body = (await instance.app.inject({ method: "GET", url: "/api/v1/analysis/agents", headers: { cookie: session.cookie } })).json();
    assert.equal(body.agents.length, 7);
    const byId = Object.fromEntries(body.agents.map((agent) => [agent.id, agent]));
    assert.match(byId.forex.description, /macro unavailable \(no provider\)/);
    assert.match(byId.crypto.description, /honestly unavailable/);
    assert.match(byId.sentiment.description, /Abstains until real news\/social providers/);
    assert.match(byId.fundamentals.description, /Abstains until a licensed/);
    assert.match(byId.intelligence.description, /NO_TRADE/);
    for (const agent of body.agents) {
      assert.ok(agent.title && agent.description, `${agent.id} must describe itself`);
    }
  } finally {
    await instance.cleanup();
  }
});

test("POST /analysis/consensus bounds the scan and refuses an unsupported timeframe", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);

    const scan = await instance.app.inject({
      method: "POST", url: "/api/v1/analysis/consensus", headers: session.headers,
      payload: { timeframe: "1h", symbols: ["BTCUSDT", "eurusd"] },
    });
    assert.equal(scan.statusCode, 200, scan.body);
    const body = scan.json();
    assert.equal(body.consensus.length, 2);
    assert.equal(body.timeframe, "1h");
    assert.deepEqual(body.consensus.map((row) => row.symbol), ["BTCUSDT", "EURUSD"]);
    assert.deepEqual(body.consensus.map((row) => row.marketClass), ["crypto", "forex"]);

    // No symbols: the legacy default watchlist, including gold as a commodity.
    const watchlist = await instance.app.inject({
      method: "POST", url: "/api/v1/analysis/consensus", headers: session.headers, payload: {},
    });
    assert.equal(watchlist.statusCode, 200, watchlist.body);
    const rows = watchlist.json().consensus;
    assert.deepEqual(rows.map((row) => row.symbol), [...DEFAULT_WATCHLIST]);
    assert.equal(rows.find((row) => row.symbol === "XAUUSD").marketClass, "commodity");
    assert.ok(rows.every((row) => BIASES.includes(row.bias)));

    const refusals = [
      [{ symbols: [] }, /symbols/],
      [{ symbols: new Array(11).fill("BTCUSDT").map((symbol, index) => `${symbol}${index}`) }, /symbols/],
      [{ symbols: "BTCUSDT" }, /symbols/],
      [{ symbols: ["BTCUSDT", "BTCUSDT"] }, /symbols/],
      [{ symbols: ["B"] }, /symbols/],
      [{ timeframe: "5m" }, /timeframe/],
      [{ timeframe: "1m" }, /timeframe/],
    ];
    for (const [payload, expected] of refusals) {
      const response = await instance.app.inject({ method: "POST", url: "/api/v1/analysis/consensus", headers: session.headers, payload });
      assert.equal(response.statusCode, 400, `${JSON.stringify(payload)} → ${response.body}`);
      const fields = rejectedFields(response);
      assert.ok(fields.some((field) => expected.test(field)), `${JSON.stringify(payload)}: got ${fields.join(", ")}`);
    }

    // The narrower consensus vocabulary is accepted.
    for (const timeframe of ["15m", "1h", "4h", "1d"]) {
      const response = await instance.app.inject({
        method: "POST", url: "/api/v1/analysis/consensus", headers: session.headers,
        payload: { timeframe, symbols: ["BTCUSDT"] },
      });
      assert.equal(response.statusCode, 200, `${timeframe} → ${response.body}`);
      assert.equal(response.json().timeframe, timeframe);
    }
  } finally {
    await instance.cleanup();
  }
});

test("a provider outage on the run route is a 503 with a retry, never a 500", async () => {
  const instance = await harness({ env: { MARKET_DATA_ALLOW_SYNTHETIC: "0" } });
  try {
    const session = await signIn(instance.app);
    const response = await instance.app.inject({
      method: "POST", url: "/api/v1/analysis/run", headers: session.headers,
      payload: { symbol: "BTCUSDT", marketClass: "crypto", timeframe: "1h" },
    });
    // Real providers are off and synthetic is refused, so the chain is empty.
    assert.equal(response.statusCode, 503, response.body);
    const body = response.json();
    assert.equal(body.error.code, "SYNTHETIC_DATA_DISABLED");
    assert.equal(body.error.details.syntheticAllowed, false);
    assert.ok(Number(response.headers["retry-after"]) > 0, "a dependency outage tells the caller when to come back");
    assert.ok(!("bias" in body), "an outage produces no analysis, not an empty one");
  } finally {
    await instance.cleanup();
  }
});

test("persistence: a run id is upserted, not duplicated", async () => {
  const instance = await harness();
  try {
    const run = {
      id: "11111111-2222-3333-4444-555555555555",
      symbol: "BTCUSDT", timeframe: "1h", bias: "NEUTRAL", confidence: 0.4,
      regime: "RANGING", recommendation: "HOLD", synthetic: true, source: "synthetic-demo",
      completedAt: "2026-10-09T00:00:00.000Z", payload: { id: "11111111-2222-3333-4444-555555555555", bias: "NEUTRAL" },
    };
    await instance.store.saveAnalysisRun(run);
    await instance.store.saveAnalysisRun({ ...run, bias: "BULLISH", payload: { ...run.payload, bias: "BULLISH" } });

    const rows = await instance.store.listAnalysisRuns({ limit: 10 });
    assert.equal(rows.length, 1, "the second save updates the row");
    assert.equal(rows[0].bias, "BULLISH");
    assert.equal((await instance.store.findAnalysisRun(run.id)).bias, "BULLISH");
    assert.equal(await instance.store.findAnalysisRun("nope"), null);
    assert.equal(rows[0].confidence, 0.4);
    assert.equal(rows[0].synthetic, true);
  } finally {
    await instance.cleanup();
  }
});

test("status surface: analysis is ported, risk is partial, and trading stays disabled", async () => {
  const instance = await harness();
  try {
    const status = await instance.app.inject({ method: "GET", url: "/api/v1/system/status" });
    assert.equal(status.statusCode, 200);
    const body = status.json();

    const moduleState = Object.fromEntries(body.modules.map((entry) => [entry.key, entry.state]));
    assert.equal(moduleState.analysis, "ported");
    assert.equal(moduleState.risk, "partial", "only the veto gate is ported, not the risk module");
    assert.equal(moduleState.marketData, "ported");
    assert.equal(moduleState.execution, "not-ported");
    assert.equal(moduleState.brokers, "not-ported");
    assert.equal(moduleState.paperTrading, "not-ported");

    assert.deepEqual(body.analysis.agents, ["technical", "market-structure", "forex", "crypto", "sentiment", "fundamentals"]);
    assert.equal(body.analysis.candleLimit, 300);
    assert.equal(body.analysis.killSwitchActive, true);
    assert.equal(body.analysis.proposalsOnly, true);
    assert.equal(body.analysis.canPlaceOrders, false, "the status surface states the platform cannot trade");
    assert.match(body.analysis.note, /not ported/);
    assert.deepEqual(body.analysis.referenceSymbols, [...REFERENCE_SYMBOLS]);

    assert.equal(body.trading.enabled, false);
    assert.match(body.trading.reason, /not ported/i);
    assert.match(body.trading.reason, /kill switch stays engaged/i);

    const features = await instance.app.inject({ method: "GET", url: "/api/v1/system/features" });
    assert.equal(features.json().features.analysis, "ported");
    assert.equal(features.json().features.risk, "partial");
    assert.equal(features.json().features.execution, "not-ported");
  } finally {
    await instance.cleanup();
  }
});

test("route inventory: all five analysis routes are listed with what they enforce", async () => {
  const instance = await harness();
  try {
    const response = await instance.app.inject({ method: "GET", url: "/api/v1/system/routes" });
    assert.equal(response.statusCode, 200);
    const routes = response.json().routes.filter((route) => route.path.includes("/analysis"));
    const listed = routes.map((route) => `${route.method} ${route.path}`).sort();
    assert.deepEqual(listed, [
      "GET /api/v1/analysis/:runId",
      "GET /api/v1/analysis/agents",
      "GET /api/v1/analysis/history",
      "POST /api/v1/analysis/consensus",
      "POST /api/v1/analysis/run",
    ]);
    for (const route of routes) {
      assert.equal(route.auth, true, `${route.method} ${route.path} must report its session guard`);
      assert.equal(route.permission, null, "analysis needs no permission, exactly as the legacy controller did");
    }
    const run = routes.find((route) => route.path.endsWith("/analysis/run"));
    assert.equal(run.validated, true, "the mutating route declares a body schema");
    const agents = routes.find((route) => route.path.endsWith("/analysis/agents"));
    assert.equal(agents.validated, false);
  } finally {
    await instance.cleanup();
  }
});
