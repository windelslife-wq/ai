/**
 * The AI Workforce console against the API it drives (row 3, Phase 32).
 *
 * The fourth console contract suite. Like the third it guards a **session-only**
 * surface — the analysis and market-data routes are guarded by `authenticate` and
 * nothing else, as legacy's `Api_controller` guarded them — so the absence of a
 * screen permission is asserted alongside the presence of the controls.
 *
 * The suite is hermetic (`MARKET_DATA_REAL_PROVIDERS=0`), which has a consequence
 * worth stating: every run it produces is synthetic, and on a synthetic run the
 * risk engine vetoes the proposal. That is a real, deliberate outcome
 * (`tradeSetup: null`, `riskDecision: null`), so it is asserted as one — a console
 * that invented a setup to fill the panel would pass a happy-path test and lie to
 * an operator.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  MAX_WATCHLIST, REFUSED_MODES, RUN_TIMEFRAMES, SYMBOLS, SYMBOL_GROUPS, TRADING_MODES, WATCHLIST,
  agentPanels, biasTone, buildConsensusBody, buildKillSwitchBody, buildModeBody, buildRunBody,
  candleGeometry, chartPriceText, consensusSummary, debateView, emaSeries,
  historyRows, marketClassFor, meterRows, numberText, percentText, priceText, provenanceFacts,
  riskContextFacts, riskDecisionView, runHeadline, signalRows, structureLevels, tradeSetupView,
  validateRunForm, validateWatchlistForm, watchlistRows,
} from "../client/src/workforce.js";
import { marketClassFor as strategyMarketClassFor } from "../client/src/strategy.js";
import {
  CONSENSUS_BODY, CONSENSUS_TIMEFRAMES, MAX_CONSENSUS_SYMBOLS, RUN_BODY,
} from "../src/modules/analysis/contracts.js";
import { TIMEFRAMES } from "../src/modules/market-data/timeframes.js";
import { KILL_SWITCH_BODY, TRADING_MODE_BODY } from "../src/modules/paper/contracts.js";
import { hashPassword } from "../src/security/passwords.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";

const CLIENT = path.resolve(import.meta.dirname, "..", "client", "src");

const ANALYSIS_ENV = {
  MARKET_DATA_REAL_PROVIDERS: "0",
  RATE_LIMIT_ANALYSIS_RUN_MAX: "10000",
  RATE_LIMIT_ANALYSIS_CONSENSUS_MAX: "10000",
  ANALYSIS_MAX_CONCURRENT_RUNS: "0",
};

async function signIn(app) {
  const response = await app.inject({
    method: "POST", url: "/api/v1/auth/login",
    payload: { identifier: "rootadmin", password: "Root administrator pass" },
  });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: cookieFrom(response), "x-csrf-token": response.json().csrfToken, permissions: response.json().permissions };
}

async function consoleInstance(t, { grantTradingControl = false } = {}) {
  const instance = await createFileStoreApp({ configOverrides: { env: ANALYSIS_ENV } });
  t.after(() => instance.cleanup());
  if (grantTradingControl) {
    // The seeded baseline grants every permission it creates; `trading.control` is
    // not one of them, so a positive governance write needs its grant added. The
    // suite asserts the refusal without it as well.
    const permission = await instance.store.ensurePermission("trading.control", "trading.control");
    const role = (await instance.store.listRoles()).find((entry) => entry.role_key === "super_admin");
    await instance.store.grantRolePermission(role.id, permission.id);
  }
  const headers = await signIn(instance.app);
  return { ...instance, headers };
}

/**
 * A second account holding `platform_member` and only the permissions named. The
 * seeded administrator carries `system.super_admin`, which short-circuits every
 * permission check, so a refusal cannot be demonstrated with it.
 */
async function addViewer(instance, { permissions = [] } = {}) {
  const role = (await instance.store.listRoles()).find((entry) => entry.role_key === "platform_member");
  for (const key of permissions) {
    const permission = await instance.store.ensurePermission(key, key);
    await instance.store.grantRolePermission(role.id, permission.id);
  }
  const user = await instance.store.createUser({
    username: "viewer",
    email: "viewer@example.test",
    passwordHash: await hashPassword("Correct horse battery staple", { minLength: 14 }),
    displayName: "Trading viewer",
  });
  await instance.store.assignRole(user.id, role.id);
  const response = await instance.app.inject({
    method: "POST", url: "/api/v1/auth/login",
    payload: { identifier: "viewer", password: "Correct horse battery staple" },
  });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: cookieFrom(response), "x-csrf-token": response.json().csrfToken, permissions: response.json().permissions };
}

const post = (instance, url, payload) => instance.app.inject({ method: "POST", url, headers: instance.headers, payload });
const get = (instance, url) => instance.app.inject({ method: "GET", url, headers: instance.headers });

// ------------------------------------------------------------ vocabulary parity

test("the console's vocabulary is the API's, and the two symbol rules cannot disagree", () => {
  // Timeframes: the same four the legacy page offered, all of them servable, and
  // exactly the set a consensus scan accepts — one form drives both endpoints.
  assert.deepEqual([...RUN_TIMEFRAMES], [...CONSENSUS_TIMEFRAMES]);
  for (const timeframe of RUN_TIMEFRAMES) assert.ok(TIMEFRAMES.includes(timeframe), `${timeframe} must be servable`);

  // Modes: the two the API accepts, named from the schema; and the three it refuses
  // are named rather than hidden.
  assert.deepEqual([...TRADING_MODES], [...TRADING_MODE_BODY.properties.mode.values]);
  const refused = REFUSED_MODES.map((entry) => entry.mode);
  assert.equal(refused.length, 3);
  for (const mode of refused) {
    assert.ok(!TRADING_MODES.includes(mode), `${mode} is refused by the API and must not be offered`);
    assert.ok(["HUMAN_APPROVAL", "SEMI_AUTONOMOUS", "FULLY_AUTOMATED"].includes(mode));
  }
  assert.ok(REFUSED_MODES.every((entry) => entry.reason.length > 10), "each refusal must carry a reason");

  // Watchlist: legacy's own six, inside the API's cap, and every one of them in the
  // form's own symbol list.
  assert.equal(MAX_WATCHLIST, MAX_CONSENSUS_SYMBOLS);
  assert.equal(WATCHLIST.length, 6);
  assert.ok(WATCHLIST.length <= MAX_WATCHLIST);
  for (const symbol of WATCHLIST) assert.ok(SYMBOLS.includes(symbol), `${symbol} must be offered by the run form`);
  assert.deepEqual(SYMBOL_GROUPS.map((group) => group.label), ["Crypto", "Forex & Metals"]);
  assert.equal(SYMBOLS.length, SYMBOL_GROUPS.reduce((total, group) => total + group.symbols.length, 0));
  assert.equal(SYMBOLS[0], "BTCUSDT", "the legacy form opened on BTCUSDT");

  // The two consoles' market-class rules must agree on every input they share.
  const samples = [...SYMBOLS, ...WATCHLIST, "btcusdt", " usdcad ", "XAUUSD", "GBPJPY", "SOLUSDT", "ETHUSDT"];
  for (const symbol of samples) {
    assert.equal(marketClassFor(symbol), strategyMarketClassFor(symbol), `${symbol} classifies differently in the two consoles`);
  }
  assert.equal(marketClassFor("XAUUSD"), "commodity");
  assert.equal(marketClassFor("USDCAD"), "forex");
  assert.equal(marketClassFor("ethusdt"), "crypto");
});

// ---------------------------------------------------------------- the bodies

test("the built bodies carry only properties the four schemas declare", () => {
  const cases = [
    [buildRunBody({ symbol: "btcusdt", timeframe: "1h" }), RUN_BODY],
    [buildConsensusBody({ symbols: "EURUSD, BTCUSDT", timeframe: "4h" }), CONSENSUS_BODY],
    [buildConsensusBody({ symbols: "", timeframe: "1h" }), CONSENSUS_BODY],
    [buildModeBody("PAPER_TRADING"), TRADING_MODE_BODY],
    [buildKillSwitchBody(true), KILL_SWITCH_BODY],
    [buildKillSwitchBody(false, "released after the incident review"), KILL_SWITCH_BODY],
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

  const run = buildRunBody({ symbol: "  ethusdt ", timeframe: "4h" });
  assert.deepEqual(run, { symbol: "ETHUSDT", marketClass: "crypto", timeframe: "4h" });

  // An empty watchlist is OMITTED, not sent as [] — an absent `symbols` is what
  // makes the server use its own default list, and [] would be refused.
  assert.deepEqual(buildConsensusBody({ symbols: "   ", timeframe: "1h" }), { timeframe: "1h" });
  assert.deepEqual(buildConsensusBody({ symbols: "eurusd btcusdt", timeframe: "1h" }).symbols, ["EURUSD", "BTCUSDT"]);

  // A blank kill-switch reason is omitted rather than written as an empty string
  // into the audit trail.
  assert.deepEqual(buildKillSwitchBody(true, "  "), { active: true });
  // A mode outside the supported pair cannot be sent by accident: the builder falls
  // back to the first supported value instead of forwarding a value the API refuses.
  assert.deepEqual(buildModeBody("FULLY_AUTOMATED"), { mode: "ANALYSIS_ONLY" });
});

test("the pre-flights refuse the shape the schemas refuse, and nothing stricter", () => {
  assert.deepEqual(validateRunForm({ symbol: "BTCUSDT", timeframe: "1h" }), []);
  assert.ok(validateRunForm({ symbol: "", timeframe: "1h" }).some((problem) => problem.field === "symbol"));
  assert.ok(validateRunForm({ symbol: "DOGEUSDT", timeframe: "1h" }).some((problem) => problem.field === "symbol"), "a symbol outside the form's list is a typed mistake");
  assert.ok(validateRunForm({ symbol: "BTCUSDT", timeframe: "5m" }).some((problem) => problem.field === "timeframe"), "5m is servable but the form and the scan both use the legacy four");

  assert.deepEqual(validateWatchlistForm({ symbols: "EURUSD, BTCUSDT", timeframe: "1h" }), []);
  assert.ok(validateWatchlistForm({ symbols: "", timeframe: "1h" }).some((problem) => problem.field === "symbols"));
  assert.ok(validateWatchlistForm({ symbols: "EURUSD EURUSD", timeframe: "1h" }).some((problem) => problem.field === "symbols"), "a duplicate is refused by the API with its own message");
  assert.ok(validateWatchlistForm({ symbols: "E", timeframe: "1h" }).some((problem) => problem.field === "symbols"), "one character is below the schema's minLength");
  assert.ok(validateWatchlistForm({ symbols: Array.from({ length: MAX_WATCHLIST + 1 }, (unused, index) => `SYM${index}0`).join(" "), timeframe: "1h" })
    .some((problem) => problem.field === "symbols"), `more than ${MAX_WATCHLIST} symbols is more than the API accepts`);
});

// -------------------------------------------------------------- formatting

test("formatting never invents a figure, and the chart's own formatter is intact", () => {
  assert.equal(percentText(0.27), "27%");
  assert.equal(percentText(null), "—");
  assert.equal(percentText(""), "—");
  assert.equal(numberText(0), "0.00", "a real zero is a figure, not a missing value");
  assert.equal(numberText(null), "—");
  assert.equal(priceText(64271.625506), "64271.63");
  assert.equal(priceText(0.123456789), "0.12346", "below 10 the legacy formatter keeps five decimals");
  assert.equal(chartPriceText(68372.24639), "68,372.2", "at or above 100 the chart keeps one decimal");
  assert.equal(chartPriceText(23.45678), "23.457");
  assert.equal(chartPriceText(1.234567), "1.23457");
  assert.equal(chartPriceText(null), "—");

  // Provenance decides the banner, exactly as the legacy partial did.
  assert.equal(provenanceFacts({ synthetic: true, source: "synthetic-demo", dataTimestamp: 0, dataAgeMs: 60_000 }).tone, "warn");
  assert.equal(provenanceFacts({ synthetic: false, stale: true, source: "demo" }).tone, "error");
  assert.equal(provenanceFacts({ synthetic: false, stale: false, delayed: true, source: "demo" }).tone, "ok");
  assert.equal(provenanceFacts({ synthetic: false, stale: false, source: "demo" }).facts.includes("LIVE"), true);
  assert.equal(provenanceFacts(null), null, "no provenance renders no banner rather than an empty one");
  assert.match(provenanceFacts({ synthetic: true, source: "synthetic-demo" }).note, /Risk Engine vetoes trades on synthetic data/);
});

// -------------------------------------------------------------- chart geometry

test("the EMA warm-up is the one the legacy partial computes, and the chart cannot spike", () => {
  // Hand-computed: seed = (1+2+3)/3 = 2 at index 2, k = 0.5, then 4·0.5+2·0.5 = 3, 5·0.5+3·0.5 = 4.
  assert.deepEqual(emaSeries([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  assert.deepEqual(emaSeries([2, 4], 5), [null, null], "a series shorter than the period has no EMA at all");

  const candles = Array.from({ length: 200 }, (unused, index) => ({
    timestamp: 1_700_000_000_000 + index * 3_600_000,
    open: 100 + index, high: 101 + index, low: 99 + index, close: 100.5 + index, volume: 10 + index,
  }));
  const geometry = candleGeometry({ candles, support: [250], resistance: [400] });
  assert.equal(geometry.visibleCount, 140, "the legacy window is the last 140 bars");
  assert.equal(geometry.totalCount, 200);
  assert.equal(geometry.bars.length, 140);
  assert.equal(geometry.gridlines.length, 5, "four gridlines plus the floor, as the PHP loop drew");
  // Every visible bar's volume sits inside the strip that the geometry reserves.
  for (const bar of geometry.bars) {
    assert.ok(bar.volume.y >= geometry.height - 10 - 56 - 0.001 && bar.volume.y <= geometry.height - 10, `volume bar ${bar.index} outside the strip`);
    assert.ok(bar.body.height >= 1, "a doji still draws a 1px body");
  }
  // The EMA is computed over the whole series and then sliced, so the visible
  // window has no warm-up nulls at 200 bars and the polyline starts at the first bar.
  assert.equal(geometry.ema20.drawn, 140);
  assert.equal(geometry.ema50.drawn, 140);
  assert.ok(!geometry.ema20.points.includes("0,0"), "a zero-filled warm-up would draw a spike to the origin");
  // Levels inside ±10% of the range are drawn; the axis labels use the chart formatter.
  assert.equal(geometry.support.length, 1);
  assert.equal(geometry.resistance.length, 1);
  assert.ok(geometry.support[0].y > 0 && geometry.support[0].y < geometry.height);
  assert.match(geometry.gridlines[0].label, /^\d+\.\d$/);
  assert.ok(geometry.lo < 299 && geometry.hi > 300, "the padded range is wider than the bars it contains");
  // A price series in the thousands prints grouped axis labels, as legacy's
  // `number_format` did — the chart is read next to levels printed the same way.
  const crypto = candleGeometry({ candles: Array.from({ length: 40 }, (unused, index) => ({ timestamp: index, open: 68_000 + index, high: 68_100 + index, low: 67_900 + index, close: 68_050 + index, volume: 5 })) });
  assert.match(crypto.gridlines[0].label, /^\d{2},\d{3}\.\d$/);
  assert.equal(candleGeometry({ candles: [] }), null, "no candles is no chart");
  assert.equal(candleGeometry({ candles: [{ close: "not a number" }] }), null);
});

// ------------------------------------------------------------- live behaviour

test("a run through the console's own body renders, and the synthetic veto is shown rather than filled in", async (t) => {
  const instance = await consoleInstance(t);

  const body = buildRunBody({ symbol: "BTCUSDT", timeframe: "1h" });
  const response = await post(instance, "/api/v1/analysis/run", body);
  assert.equal(response.statusCode, 200, response.body);
  const run = response.json();
  assert.equal(run.request.marketClass, "crypto", "the console's derived class is what the run recorded");
  assert.equal(run.provenance.synthetic, true, "hermetic: every run here is synthetic and says so");

  // The headline, the meters and the consensus strip all render from the payload.
  assert.match(runHeadline(run), /^BTCUSDT · 1h · [A-Z_]+ \(/);
  const meters = meterRows(run);
  assert.deepEqual(meters.map((meter) => meter.label), ["Confidence", "Confluence", "Agent agreement"]);
  for (const meter of meters) assert.match(meter.text, /^(\d+%|—)$/);
  const consensus = consensusSummary(run);
  assert.ok(consensus.voting.length > 0);
  assert.match(consensus.netScore, /^-?\d+\.\d\d$/);

  // Signals and agents: nine rows, five panels, and an abstaining agent stays
  // labelled as abstaining.
  const signals = signalRows(run.signals);
  assert.equal(signals.length, 9);
  for (const signal of signals) assert.ok(signal.name && signal.value && signal.tone);
  const agents = agentPanels(run.agents);
  assert.equal(agents.length, 5);
  const abstaining = agents.filter((agent) => !agent.votes);
  assert.equal(abstaining.length, 2, "sentiment and fundamentals abstain without a licensed feed");
  for (const agent of abstaining) assert.equal(agent.voteLabel, "ABSTAIN");

  // The veto path: synthetic candles are blocked by the risk limits, so there is no
  // setup and no decision. The console renders that as the deliberate outcome.
  assert.equal(tradeSetupView(run.tradeSetup), null);
  assert.equal(riskDecisionView(run.riskDecision), null);
  const context = riskContextFacts(run.riskContext);
  assert.equal(context.mode, "ANALYSIS_ONLY");
  assert.equal(context.killSwitch, true, "the boot default is an engaged kill switch");
  assert.match(context.note, /analysis surface/);

  // The proposal panel's alternative branch, from a setup-shaped payload: the rows
  // are the legacy table's, and the veto carries every reason the engine gave.
  const setup = tradeSetupView({ action: "BUY", symbol: "BTCUSDT", timeframe: "1h", riskReward: 2, confidence: 0.5, entry: { min: 1, max: 2 }, stopLoss: 0.5, takeProfit: [3, 4], expiration: "2026-10-16T14:00:00Z" });
  assert.deepEqual(setup.rows.map((row) => row.label), ["Entry zone", "Stop loss", "Target 1", "Target 2", "Expires"]);
  assert.equal(setup.tone, "badge-green");
  const decision = riskDecisionView({ approved: false, reasons: ["synthetic data is blocked by the persisted risk limits"] });
  assert.equal(decision.tone, "badge-red");
  assert.match(decision.label, /VETOED/);

  // Structure levels and the chart the console draws from the same run.
  const levels = structureLevels(run.agents);
  assert.ok(levels.support.length > 0 && levels.resistance.length > 0, "the technical agent publishes both sides");
  const series = (await get(instance, "/api/v1/market-data/candles?symbol=BTCUSDT&marketClass=crypto&timeframe=1h&limit=200")).json();
  const geometry = candleGeometry({ candles: series.candles, support: levels.support, resistance: levels.resistance, setup: run.tradeSetup });
  assert.equal(geometry.totalCount, series.candles.length);
  assert.equal(geometry.visibleCount, Math.min(140, series.candles.length));
  assert.equal(geometry.ema20.drawn > 0, true, "the run's own candles must produce a drawable EMA");

  // History and the debate, through the console's own normalisers.
  const history = (await get(instance, "/api/v1/analysis/history?limit=8")).json();
  const rows = historyRows(history);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, "BTCUSDT");
  assert.match(rows[0].time, /^\d\d:\d\d:\d\d$/);
  assert.equal(historyRows(null).length, 0);
  const debate = debateView(run.debate);
  assert.equal(debate.rounds.length, 4);
  assert.ok(debate.rounds.every((round) => round.role && !round.role.includes("-")), "the roles are printed the way legacy printed them");

  // A watchlist scan, with the console's own body.
  const scan = await post(instance, "/api/v1/analysis/consensus", buildConsensusBody({ symbols: WATCHLIST.slice(0, 3).join(", "), timeframe: "1h" }));
  assert.equal(scan.statusCode, 200, scan.body);
  const watch = watchlistRows(scan.json());
  assert.equal(watch.length, 3);
  for (const row of watch) {
    assert.ok(SYMBOLS.includes(row.symbol) || WATCHLIST.includes(row.symbol));
    assert.ok(row.short.length <= 4, "legacy abbreviated the bias to four characters");
    assert.equal(row.regime, row.regime.toLowerCase());
    assert.ok(row.tone.endsWith("badge-gray") || row.tone.includes("green") || row.tone.includes("red"));
  }
  assert.equal(biasTone("NO_TRADE"), "badge-amber");
});

test("the two governance writes are the API's, including the refusal the console never offers", async (t) => {
  // A role that carries `trading.view` but not `trading.control` — and no
  // `system.super_admin`, which short-circuits every permission check
  // (`userHasPermission`). This is the role the screen's disabled controls describe.
  const without = await consoleInstance(t);
  const viewer = await addViewer(without, { permissions: ["trading.view"] });
  const read = await without.app.inject({ method: "GET", url: "/api/v1/trading/mode", headers: viewer });
  assert.equal(read.statusCode, 200, "trading.view reads the state");
  const denied = await without.app.inject({ method: "POST", url: "/api/v1/trading/mode", headers: viewer, payload: buildModeBody("PAPER_TRADING") });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "PERMISSION_DENIED");
  const deniedKill = await without.app.inject({ method: "POST", url: "/api/v1/trading/kill-switch", headers: viewer, payload: buildKillSwitchBody(false) });
  assert.equal(deniedKill.statusCode, 403, "the kill switch is the stricter write");

  const instance = await consoleInstance(t, { grantTradingControl: true });
  assert.ok(instance.headers.permissions.includes("trading.control"));

  const state = (await get(instance, "/api/v1/trading/mode")).json();
  assert.equal(state.tradingMode, "ANALYSIS_ONLY");
  assert.equal(state.killSwitch.active, true, "a fresh store boots with the kill switch engaged");

  const changed = await post(instance, "/api/v1/trading/mode", buildModeBody("PAPER_TRADING"));
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().tradingMode, "PAPER_TRADING");
  assert.equal(changed.json().message, "Trading mode set to PAPER_TRADING");

  // The three modes legacy offered and this edition does not have. They are refused
  // by the request schema — `TRADING_MODE_BODY` declares the two values — so the
  // answer is a 400 naming them, not the service's 409 `TRADING_MODE_UNSUPPORTED`:
  // that guard sits behind the schema and is unreachable over HTTP, which is why the
  // console's copy of the reason is about the missing capability rather than an
  // error code an operator would never see.
  for (const entry of REFUSED_MODES) {
    const refused = await post(instance, "/api/v1/trading/mode", { mode: entry.mode });
    assert.equal(refused.statusCode, 400, `${entry.mode} must be refused at the request edge`);
    assert.equal(refused.json().error.code, "INVALID_REQUEST");
    assert.match(refused.json().error.message, /mode must be one of: ANALYSIS_ONLY, PAPER_TRADING/);
    assert.equal(refused.json().error.details[0].code, "ENUM");
  }

  // Kill switch: release, engage with a reason, engage without one.
  //
  // The stored `reason` describes why the switch is ENGAGED and is cleared when it
  // is released — legacy kept it in both directions (`$reason ?? ($active ?
  // 'engaged' : 'released')`) and also stamped `activatedAt` on release, which is
  // the shape the port deliberately left behind: a released switch with an
  // activation timestamp claims to be both. The operator's release reason is not
  // lost — it is the audit row's own detail (`governance.kill-switch.released`).
  const released = await post(instance, "/api/v1/trading/kill-switch", buildKillSwitchBody(false, "console test: releasing after review"));
  assert.equal(released.statusCode, 200, released.body);
  assert.equal(released.json().killSwitch.active, false);
  assert.equal(released.json().killSwitch.reason, null, "a release clears the reason it was engaged for");
  assert.equal(released.json().killSwitch.activatedAt, null, "and the activation stamp with it");
  const engaged = await post(instance, "/api/v1/trading/kill-switch", buildKillSwitchBody(true));
  assert.equal(engaged.statusCode, 200, engaged.body);
  assert.equal(engaged.json().killSwitch.active, true);
  assert.equal(engaged.json().killSwitch.reason, "Activated by operator", "an activation with no reason records its own");
  const reasoned = await post(instance, "/api/v1/trading/kill-switch", buildKillSwitchBody(true, "console test: drawn down past the daily limit"));
  assert.equal(reasoned.json().killSwitch.reason, "console test: drawn down past the daily limit");
  const after = (await get(instance, "/api/v1/trading/mode")).json();
  assert.equal(after.tradingMode, "PAPER_TRADING", "the mode change survived the kill-switch writes");
  assert.equal(after.killSwitch.active, true);

  // The reason field's own edges: a blank one is stored as null (the builder omits
  // it, and the validator's `trim` does the same for an empty string), and an
  // overlong one is refused — the console's input carries `maxLength={500}`, so the
  // 400 is unreachable from the form and the API is the thing that enforces it.
  const blank = await post(instance, "/api/v1/trading/kill-switch", buildKillSwitchBody(true, "   "));
  assert.equal(blank.statusCode, 200);
  assert.equal(blank.json().killSwitch.reason, "Activated by operator", "a blank reason is omitted by the builder, so the server's default applies");
  const overlong = await post(instance, "/api/v1/trading/kill-switch", { active: false, reason: "x".repeat(501) });
  assert.equal(overlong.statusCode, 400);
  assert.equal(overlong.json().error.details[0].field, "reason");
});

// ------------------------------------------------------------- screens, routes

test("the AI Workforce console is session-only, and session-only is what its routes are", async (t) => {
  const instance = await createFileStoreApp();
  t.after(() => instance.cleanup());

  const app = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  const views = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");

  const route = app.match(/\{[^{}]*path:\s*"\/app\/analysis"[^{}]*\}/);
  assert.ok(route, "/app/analysis must be a declared exact-path route");
  assert.match(route[0], /requiresAuth:\s*true/);
  assert.ok(!/permission:/.test(route[0]), "the analysis routes are guarded by authentication alone — the screen must not invent a permission");
  assert.match(app, /"analysis-workforce":\s*<AnalysisWorkforceView/, "the route must resolve to a view, or it renders blank");

  const nav = views.match(/\{[^{}]*to:\s*"\/app\/analysis"[^{}]*\}/);
  assert.ok(nav, "the console needs a navigation entry");
  assert.match(nav[0], /permission:\s*null/, "an entry that required a permission would hide a screen the API serves to every signed-in role");
  assert.match(views, /number:\s*"01",\s*title:\s*"Market intelligence"[^}]*to:\s*"\/app\/analysis"/, "the module card must open the console it describes");

  const html = await instance.app.inject({ method: "GET", url: "/app/analysis", headers: { accept: "text/html" } });
  assert.equal(html.statusCode, 200, "a bookmark, a refresh or a pasted link must reach the screen");
  assert.match(html.headers["content-type"] || "", /text\/html/);

  // The permissioned controls on the screen are exactly the API's two governance
  // writes, and the session-only reads carry no permission at all.
  assert.match(views, /trading\.control/, "the governance controls must name the permission the routes enforce");
  const inventory = (await instance.app.inject({ method: "GET", url: "/api/v1/system/routes" })).json().routes;
  const consoleRoutes = inventory.filter((entry) => entry.path.startsWith("/api/v1/analysis") || entry.path.startsWith("/api/v1/market-data/")
    || entry.path === "/api/v1/trading/mode" || entry.path === "/api/v1/trading/kill-switch");
  assert.ok(consoleRoutes.length >= 9, `expected the console's whole route surface, found ${consoleRoutes.length}`);
  assert.deepEqual(
    consoleRoutes.filter((entry) => entry.permission !== null).map((entry) => `${entry.method} ${entry.path} ${entry.permission}`).sort(),
    ["GET /api/v1/trading/mode trading.view", "POST /api/v1/trading/kill-switch trading.control", "POST /api/v1/trading/mode trading.control"],
    "the reads are session-only; the kill switch and the mode write are the only permissioned routes, and the kill switch is the stricter of the two",
  );
  for (const entry of consoleRoutes.filter((route_) => route_.path.startsWith("/api/v1/analysis") || route_.path.startsWith("/api/v1/market-data/"))) {
    assert.equal(entry.permission, null, `${entry.method} ${entry.path} is session-only`);
  }

  // Every path the client calls is registered, so a screen cannot point at a route
  // that no longer exists.
  const source = readFileSync(path.join(CLIENT, "api.js"), "utf8");
  const calls = [...source.matchAll(/api\(\s*[`"](\/api\/v1\/(?:analysis|market-data|trading)[^`"$]*)/g)].map((match) => match[1]);
  assert.ok(calls.length >= 6, `expected the console to declare its endpoints, found ${calls.length}`);
  const unresolved = calls.filter((literal) => !inventory.some((entry) => entry.path.startsWith(literal)));
  assert.deepEqual(unresolved, [], "a console calling an unregistered path is a dead screen");
});
