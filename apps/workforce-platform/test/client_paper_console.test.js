/**
 * The paper trading console against the API it reads (row 10, Phase 37).
 *
 * `views/paper/index.php` → `Paper::index` and `views/paper/account.php` → `Paper::account`
 * are legacy's two screens over one module. The port put both on `/app/paper`, and this
 * suite holds it to the same three things the sports console's suite holds its screen to:
 *
 *  1. **The copy is legacy's.** Every heading, lede, banner, empty state, table caption and
 *     footnote in `client/src/paper.js` is asserted against the two PHP views, read with
 *     `readFileSync` — a paraphrase cannot quietly replace a page's own words, and the two
 *     labels the port deliberately changes are named as changes with their reason.
 *  2. **The numbers come from the payloads.** Every shaper is exercised on an empty host and
 *     on a live one; a null renders an em dash, never a zero, and the outcome builders print
 *     the server's own sentences — a rejection with every reason the Risk Engine returned.
 *  3. **The wiring reaches the routes, and the guards are the server's.** Every declared read
 *     and write is checked against `/api/v1/system/routes` for its permission, the three
 *     governance writes the screen deliberately does **not** carry are asserted absent from
 *     the view, and the whole flow is driven over HTTP: create an account, be refused while
 *     the kill switch is ACTIVE (how it boots), release it, be refused again in
 *     ANALYSIS_ONLY, switch to PAPER_TRADING, fill, tick and close.
 *
 * Hermetic like the other client suites: the file adapter, `createFileStoreApp`, no network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  ORDER_SIDES, ORDER_TYPES, PAPER_BOUNDARY, PAPER_COPY, PAPER_COSTS, PAPER_EXECUTE,
  PAPER_MARKET_CLASSES, PAPER_PERMISSION, PAPER_READS, PAPER_TIMEFRAMES, PAPER_WINDOWS, PAPER_WRITES,
  SUPER_ADMIN_PERMISSION,
  accountCards, accountGate, accountOutcome, accountRows, accountSelection, banners,
  buildAccountBody, buildDeployBody, buildOrderBody, closedRows, closeOutcome, deployOptions,
  deployOutcome, deploymentRows, directionGlyph, holdsPaperPermission, moneyText, orderOutcome,
  orderRows, orderStatusTone, orderTimeText, pctText, pnlTone, positionRows, priceText,
  riskLimitRows, tickOutcome, toggleOutcome, unitsText, validateAccountForm, validateDeployForm,
  validateOrderForm,
} from "../client/src/paper.js";
import { PAPER_COSTS as SERVER_PAPER_COSTS } from "../src/modules/paper/engine.js";
import { MARKET_CLASSES } from "../src/modules/market-data/timeframes.js";
import { STRATEGY_TIMEFRAMES } from "../src/modules/strategies/contracts.js";
import { ROLE_GRANTS } from "../src/db/platform-baseline.js";
import { hashPassword } from "../src/security/passwords.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";

const CLIENT = path.resolve(import.meta.dirname, "..", "client", "src");
const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const LEGACY_INDEX = path.join(REPO, "application", "views", "paper", "index.php");
const LEGACY_ACCOUNT = path.join(REPO, "application", "views", "paper", "account.php");
const LEGACY_CONTROLLER = path.join(REPO, "application", "controllers", "Paper.php");

const indexView = () => readFileSync(LEGACY_INDEX, "utf8");
const accountView = () => readFileSync(LEGACY_ACCOUNT, "utf8");

async function instance(t) {
  const app = await createFileStoreApp({});
  t.after(() => app.cleanup());
  return app;
}

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  return { headers: { cookie: cookieFrom(response), "x-csrf-token": body.csrfToken }, user: body.user, permissions: body.permissions };
}

const get = (app, url, headers) => app.inject({ method: "GET", url, headers });
const post = (app, url, headers, payload = {}) => app.inject({ method: "POST", url, headers, payload });

/**
 * The test seed creates `super_admin` and `platform_member` only, so the read-only role is
 * created here with the grant the platform baseline gives it — `ROLE_GRANTS.trading_viewer`
 * is `["trading.view"]` and nothing else.
 */
async function sessionWithRole(app, store, roleKey, username, phrase) {
  assert.deepEqual(ROLE_GRANTS[roleKey], [PAPER_PERMISSION], `${roleKey} is the read-only trading role`);
  const role = await store.ensureRole(roleKey, roleKey === "trading_viewer" ? "Trading viewer" : roleKey);
  for (const key of ["system.authenticated", PAPER_PERMISSION]) {
    const permission = await store.ensurePermission(key, key);
    await store.grantRolePermission(role.id, permission.id);
  }
  const user = await store.createUser({
    username,
    email: `${username}@example.test`,
    passwordHash: await hashPassword(phrase),
    displayName: username,
  });
  await store.assignRole(user.id, role.id);
  return signIn(app, username, phrase);
}

const releaseKillSwitch = (app, headers) => post(app, "/api/v1/trading/kill-switch", headers, {
  active: false, reason: "the console test releases the switch before ordering",
});

const setMode = (app, headers, mode) => post(app, "/api/v1/trading/mode", headers, { mode });
const allowSynthetic = (app, headers) => post(app, "/api/v1/trading/synthetic-paper", headers, { allow: true });

/** Create an account through the console's own body builder and return its id. */
async function createAccount(app, headers, name = "Console simulator", startingBalance = 10000) {
  const body = buildAccountBody({ name, startingBalance });
  const response = await post(app, "/api/v1/paper/accounts", headers, body);
  assert.equal(response.statusCode, 201, response.body);
  return response.json().account.id;
}

const summaryOf = async (app, headers, accountId) => {
  const response = await get(app, `/api/v1/paper/accounts/${accountId}`, headers);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
};

// ------------------------------------------------------------ the two pages' words

test("the headings, ledes, banners and notes are the legacy views' own words", () => {
  const index = indexView();
  const account = accountView();
  for (const [key, value] of [
    ["title", PAPER_COPY.title],
    ["lede", PAPER_COPY.lede],
    ["accountsTitle", PAPER_COPY.accountsTitle],
    ["createTitle", PAPER_COPY.createTitle],
    ["nameLabel", PAPER_COPY.nameLabel],
    ["namePlaceholder", PAPER_COPY.namePlaceholder],
    ["balanceLabel", PAPER_COPY.balanceLabel],
    ["createLabel", PAPER_COPY.createLabel],
    ["createNote", PAPER_COPY.createNote],
    ["openLabel", PAPER_COPY.openLabel],
    ["positionsTitle", PAPER_COPY.positionsTitle],
    ["ordersTitle", PAPER_COPY.ordersTitle],
    ["closedTitle", PAPER_COPY.closedTitle],
    ["orderTitle", PAPER_COPY.orderTitle],
    ["orderSubmit", PAPER_COPY.orderSubmit],
    ["orderNote", PAPER_COPY.orderNote],
    ["deployTitle", PAPER_COPY.deployTitle],
    ["deploySubmit", PAPER_COPY.deploySubmit],
    ["deployNote", PAPER_COPY.deployNote],
    ["backLabel", PAPER_COPY.backLabel],
    ["tickLabel", PAPER_COPY.tickLabel],
  ]) {
    const source = `${index}\n${account}`;
    assert.ok(source.includes(value), `${key} must be the legacy page's own string: ${JSON.stringify(value)}`);
  }
});

test("the three banners are legacy's sentences, including the two the HTML splits", () => {
  const index = indexView();
  // `<b>Kill switch ACTIVE</b> — all order placement…` is one sentence in two tags, and
  // `Trading mode is <?= … ?>` interpolates the mode.
  assert.ok(index.includes("Kill switch ACTIVE"));
  assert.ok(index.includes("— all order placement (paper included) is vetoed."));
  assert.equal(PAPER_COPY.killSwitchBanner, "Kill switch ACTIVE — all order placement (paper included) is vetoed.");
  assert.ok(index.includes("— paper orders are blocked until you switch to PAPER_TRADING on the Dashboard. The kill switch must also be released."));
  assert.equal(PAPER_COPY.modeBanner("ANALYSIS_ONLY"), "Trading mode is ANALYSIS_ONLY — paper orders are blocked until you switch to PAPER_TRADING on the Dashboard. The kill switch must also be released.");
  assert.ok(index.includes("— synthetic-paper mode is ON for this offline demo: fills use clearly-labeled synthetic quotes (no market egress here). Production keeps this OFF; the Risk Engine then vetoes any synthetic-data trade."));
  assert.ok(PAPER_COPY.syntheticBanner.endsWith(index.match(/— synthetic-paper mode is ON[^<]*/)[0]));
});

test("every empty state and footnote is legacy's sentence", () => {
  const index = indexView();
  const account = accountView();
  assert.ok(index.includes(PAPER_COPY.accountsEmpty));
  assert.ok(index.includes("Risk limits apply per order: 1% risk default, mandatory stops, exposure/drawdown gates — the same Risk Engine that governs every other layer."));
  assert.ok(account.includes(PAPER_COPY.positionsEmpty));
  assert.ok(account.includes(PAPER_COPY.ordersEmpty));
  assert.ok(account.includes(PAPER_COPY.closedEmpty));
  assert.ok(account.includes("* Stops are mandatory. Sizing = risk% × equity ÷ stop distance (capped by notional limits). Limit orders fill on the next tick; SL/TP evaluate on candle extremes with the stop-first rule."));
  assert.ok(account.includes("Gate: strategy must be RISK_REVIEWED or beyond (AI-source strategies blocked without human sign-off). Deploying advances the lifecycle to PAPER_TRADING. Signals fire on ticks."));
});

test("the fills note is legacy's sentence with the engine's own basis points, from the server module", () => {
  const account = accountView();
  // The legacy line interpolates the class constants, so the fragments are what is asserted.
  assert.ok(account.includes("Simulated fills with full governance: "));
  assert.ok(account.includes("bps spread + "));
  assert.ok(account.includes("bps slippage + "));
  assert.ok(account.includes("bps commission per side."));
  assert.equal(PAPER_COPY.fillsNote, `Simulated fills with full governance: ${SERVER_PAPER_COSTS.spreadBps}bps spread + ${SERVER_PAPER_COSTS.slippageBps}bps slippage + ${SERVER_PAPER_COSTS.feeBps}bps commission per side.`);
  // And the client's copy of the constants is the engine's, not a second opinion.
  assert.deepEqual({ ...PAPER_COSTS }, { ...SERVER_PAPER_COSTS });
  assert.ok(account.includes("Paper account #"));
  assert.ok(account.includes("Paper account #"));
  assert.ok(readFileSync(LEGACY_CONTROLLER, "utf8").includes("Paper account #{"));
});

test("the order-form labels are legacy's, and the one that was wrong in legacy is named as changed", () => {
  const account = accountView();
  for (const label of ["Symbol", "Side", "Type", "Limit price", "Stop loss *", "Take profit", "Reason (journaled)", "Confidence 0–1", "Strategy", "TF"]) {
    assert.ok(account.includes(label), `${label} is a legacy form label`);
  }
  // Legacy labelled this field `Risk %` and bounded it `min="0.1" max="2"` while the engine
  // multiplies equity by the value as a FRACTION (`PaperTradingEngine`: `$riskAmount =
  // $summary['equity'] * $riskPct`), so "1" meant 100% of equity, capped to the 2% limit.
  // The port keeps the fraction and names it.
  assert.ok(account.includes("Risk %"));
  assert.ok(!("riskLabel" in PAPER_COPY), "the port does not export a `Risk %` label: the view labels the fraction");
  assert.match(readFileSync(path.join(CLIENT, "views.jsx"), "utf8"), /label="Risk \(fraction of equity\)"/);
  assert.match(readFileSync(path.join(CLIENT, "views.jsx"), "utf8"), /min="0\.000001" max="0\.05"/);
});

test("what the port adds says which permission gates it, and where the governance lives", () => {
  for (const line of PAPER_BOUNDARY) assert.ok(line.length > 40, "each boundary line is a sentence, not a label");
  assert.ok(PAPER_BOUNDARY.some((line) => line.includes("no broker connector")), "the module's design is stated: nothing is routed");
  assert.ok(PAPER_BOUNDARY.some((line) => line.includes("tick is an operator's action")), "the tick is an operator action, not a schedule");
  assert.ok(PAPER_BOUNDARY.some((line) => line.includes("trading.control") && line.includes("/app/analysis")), "the governance screens are named");
  const views = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");
  assert.ok(views.includes("{PAPER_COPY.boundaryTitle}"));
  assert.ok(views.includes("PAPER_BOUNDARY.map"));
});

// --------------------------------------------------------------- constants and routes

test("the console's permission constants are the platform's own keys", () => {
  assert.equal(PAPER_PERMISSION, "trading.view");
  assert.equal(PAPER_EXECUTE, "trading.execute");
  assert.deepEqual(PAPER_READS.map((read) => read.key), ["tradingState", "accounts", "account", "orders", "positions", "deployments", "strategies"]);
  assert.deepEqual(PAPER_WRITES.map((write) => write.key), [
    "createAccount", "submitOrder", "closePosition", "tick", "deploy", "toggleDeployment",
    "tradingMode", "killSwitch", "syntheticPaper",
  ]);
  for (const read of PAPER_READS) {
    assert.equal(read.method, "GET");
    assert.ok(read.permission === PAPER_PERMISSION || read.permission === null, `${read.key} is a read under trading.view or the session`);
  }
  // Every carried write is `trading.execute`; the three governance ones are `trading.control`
  // and are declared uncarried, which the view's own source is asserted against below.
  assert.deepEqual(PAPER_WRITES.filter((write) => write.carried).map((write) => write.permission), Array(6).fill(PAPER_EXECUTE));
  assert.deepEqual(PAPER_WRITES.filter((write) => !write.carried).map((write) => write.permission), ["trading.control", "trading.control", "trading.control"]);
});

test("the super-admin shortcut is mirrored, not forgotten", () => {
  assert.equal(holdsPaperPermission([PAPER_PERMISSION], PAPER_EXECUTE), false);
  assert.equal(holdsPaperPermission([PAPER_PERMISSION, PAPER_EXECUTE], PAPER_EXECUTE), true);
  assert.equal(holdsPaperPermission([SUPER_ADMIN_PERMISSION], PAPER_EXECUTE), true, "system.super_admin passes every check server-side");
  assert.equal(holdsPaperPermission([], PAPER_PERMISSION), false);
  assert.equal(holdsPaperPermission(undefined, null), true, "an ungated surface needs nothing");
});

test("the client's vocabularies are the server's own lists", () => {
  assert.deepEqual([...PAPER_MARKET_CLASSES], [...MARKET_CLASSES]);
  assert.deepEqual([...PAPER_TIMEFRAMES], [...STRATEGY_TIMEFRAMES]);
  assert.deepEqual([...ORDER_SIDES], ["BUY", "SELL"]);
  assert.deepEqual([...ORDER_TYPES], ["MARKET", "LIMIT"]);
  assert.equal(PAPER_WINDOWS.listedOrders, 25, "legacy's `array_slice($orders, 0, 25)`");
});

test("every declared read and write is a registered route with the permission the server enforces", async (t) => {
  const app = await instance(t);
  const inventory = (await get(app.app, "/api/v1/system/routes")).json().routes;
  for (const entry of [...PAPER_READS, ...PAPER_WRITES]) {
    const routes = inventory.filter((route) => route.method === entry.method && route.path === entry.path);
    if (entry.permission === null) {
      // The strategy list is session-only, so the inventory reports no permission for it —
      // and that absence is the contract, not an oversight.
      assert.equal(routes.length, 1, `${entry.method} ${entry.path} must be registered`);
      assert.equal(routes[0].permission, null, `${entry.key} is session-only, as legacy's Api_strategies was`);
      continue;
    }
    const route = routes.at(-1);
    assert.ok(route, `${entry.method} ${entry.path} must be registered`);
    assert.equal(route.permission, entry.permission, `${entry.path} is declared with the wrong permission`);
    assert.equal(route.auth, true, `${entry.path} requires a session`);
  }
  // The route counts, so a paper route cannot quietly disappear: ten under /paper, two under
  // /paper/accounts/:id, and the governance writes this screen does not carry.
  const paperRoutes = inventory.filter((route) => route.path.startsWith("/api/v1/paper/"));
  assert.equal(paperRoutes.length, 11, `the paper surface is 11 routes, found ${paperRoutes.length}`);
});

// ------------------------------------------------------------------ the shaping

test("the accounts board renders the summaries the server computed, and never a zero for a gap", () => {
  const payload = {
    accounts: [
      { account: { id: 4, name: "Swing simulator", currency: "USD" }, balance: 10000, equity: 10012.5, unrealizedPnl: 12.5, dailyPnl: -3.25, openPositions: 2, valuationAvailable: true },
      { account: { id: 5, name: "Broken valuation" }, balance: null, equity: null, unrealizedPnl: null, dailyPnl: null, openPositions: null },
    ],
  };
  const rows = accountRows(payload);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { id: rows[0].id, name: rows[0].name, balance: rows[0].balance, equity: rows[0].equity, unrealized: rows[0].unrealized, unrealizedTone: rows[0].unrealizedTone, daily: rows[0].daily, dailyTone: rows[0].dailyTone, open: rows[0].open },
    { id: 4, name: "Swing simulator", balance: "10,000.00", equity: "10,012.50", unrealized: "12.50", unrealizedTone: "up", daily: "-3.25", dailyTone: "down", open: "2" },
  );
  assert.equal(rows[1].balance, "—", "a null balance prints the em dash, not a zero");
  assert.equal(rows[1].equity, "—");
  assert.equal(rows[1].unrealizedTone, "muted");
  assert.deepEqual(accountRows({}), []);
  assert.deepEqual(accountRows(null), []);
});

test("the eight statistics are legacy's, in legacy's order", () => {
  const cards = accountCards({
    balance: 9_800, equity: 9_950.5, unrealizedPnl: 150.5, dailyPnl: 0, weeklyPnl: -20,
    openPositions: 1, openRisk: 98, dailyLossPct: 0,
  });
  assert.deepEqual(cards.map((card) => card.label), [
    "Balance", "Equity", "Unrealized P&L", "Daily P&L", "Weekly P&L", "Open positions", "Open risk (Σ)", "Daily loss",
  ]);
  assert.equal(cards[0].value, "$9,800.00");
  assert.equal(cards[2].tone, "up");
  assert.equal(cards[3].tone, "muted", "a zero P&L is neither up nor down");
  assert.equal(cards[4].tone, "down");
  assert.equal(cards[6].tone, "warn", "open risk is the cell legacy painted as a warning");
  assert.equal(cards[7].value, "0.00%");
  assert.equal(cards[7].tone, "muted");
  assert.deepEqual(accountCards(null), []);
});

test("open positions carry the server's valuation, and the API's own warning when there is none", () => {
  const rows = positionRows([
    { id: 9, symbol: "BTCUSDT", direction: "LONG", units: 0.0125, entry_price: 64000, current_price: 64500.123456, stop_loss: 63000, take_profit: 67000, unrealized_pnl: 6.25, unrealized_r: 0.625, valuation_available: true },
    { id: 10, symbol: "ETHUSDT", direction: "SHORT", units: 1, entry_price: 3000, current_price: 3000, stop_loss: 3100, take_profit: 2800, unrealized_pnl: null, unrealized_r: null, valuation_available: false },
  ]);
  assert.equal(rows[0].glyph, "▲");
  assert.equal(rows[0].directionTone, "up");
  assert.equal(rows[0].units, "0.0125");
  assert.equal(rows[0].entry, "64,000.00000");
  assert.equal(rows[0].current, "64,500.12346");
  assert.equal(rows[0].pnl, "6.25");
  assert.equal(rows[0].r, "0.63");
  assert.equal(rows[1].glyph, "▼");
  assert.equal(rows[1].r, "—");
  assert.equal(rows[1].valuationAvailable, false);
  assert.equal(directionGlyph("LONG"), "▲");
  assert.equal(directionGlyph("SHORT"), "▼");
});

test("the orders table keeps the rejected ones and prints the server's reason", () => {
  const rows = orderRows([
    { id: 3, created_at: "2026-10-16T22:53:07.992Z", symbol: "BTCUSDT", side: "BUY", type: "MARKET", units: 0.0156, price: 64271.625506, fill_price: null, status: "REJECTED", reject_reason: "Kill switch is ACTIVE — all paper orders are blocked", rejectReasons: ["Kill switch is ACTIVE — all paper orders are blocked"], synthetic: true },
    { id: 2, created_at: "2026-10-16 21:00:00", symbol: "BTCUSDT", side: "SELL", units: 1, fill_price: 65000.5, status: "FILLED", reject_reason: null, reason: "take profit" },
    { id: 1, created_at: "nonsense", symbol: "BTCUSDT", side: "BUY", units: 1, price: 64000, status: "PENDING" },
  ]);
  assert.equal(rows[0].time, "10-16 22:53", "legacy printed `substr(created_at, 5, 11)` of a MySQL datetime");
  assert.equal(rows[0].price, "64,271.62551", "an unfilled order shows its requested price");
  assert.equal(rows[0].statusTone, "badge-red");
  assert.match(rows[0].reason, /^Kill switch is ACTIVE/);
  assert.equal(rows[1].time, "10-16 21:00", "the ISO separator becomes the space MySQL had");
  assert.equal(rows[1].price, "65,000.50000");
  assert.equal(rows[1].statusTone, "badge-green");
  assert.equal(rows[2].reason, "—", "an order with no reason prints the em dash; it does not invent one");
  assert.equal(rows[2].statusTone, "badge-amber");
  assert.equal(orderStatusTone("CANCELLED"), "badge-gray");
  assert.equal(orderStatusTone("SOMETHING_NEW"), "badge-gray", "an unknown status is grey, never green");
  assert.equal(orderTimeText(null), "—");
});

test("closed positions and deployments render what the API sent, including the last signal", () => {
  const closed = closedRows([
    { id: 7, symbol: "BTCUSDT", direction: "LONG", entry_price: 64000, exit_price: 65000.25, realized_pnl: 12.34, exit_reason: "TAKE_PROFIT", closed_at: "2026-10-16T22:55:00.000Z" },
    { id: 8, symbol: "ETHUSDT", direction: "SHORT", entry_price: 3000, exit_price: null, realized_pnl: null, exit_reason: null },
  ]);
  assert.equal(closed[0].exit, "65,000.25000");
  assert.equal(closed[0].pnl, "12.34");
  assert.equal(closed[0].pnlTone, "up");
  assert.equal(closed[0].exitReason, "TAKE_PROFIT");
  assert.equal(closed[0].closedAt, "10-16 22:55");
  assert.equal(closed[1].exit, "—");
  assert.equal(closed[1].pnlTone, "muted");

  const deployments = deploymentRows([
    { id: 2, strategy_id: "breakout", strategy_version: "1.0.0", symbol: "BTCUSDT", timeframe: "1h", market_class: "crypto", active: true, last_signal: "BUY" },
    { id: 3, strategy_id: "mean-reversion", strategy_version: "1.0.0", symbol: "ETHUSDT", active: false, last_signal: null },
  ]);
  assert.equal(deployments[0].status, "active");
  assert.equal(deployments[0].tone, "badge-green");
  assert.equal(deployments[0].toggleLabel, "pause");
  assert.equal(deployments[1].status, "paused");
  assert.equal(deployments[1].toggleLabel, "resume");
  assert.equal(deployments[1].lastSignal, "—");
  assert.deepEqual(deploymentRows(undefined), []);
});

test("the banners come from the governance state, in legacy's order", () => {
  const quiet = { tradingMode: "PAPER_TRADING", killSwitch: { active: false }, allowSyntheticPaperData: false };
  assert.deepEqual(banners(quiet), []);
  assert.deepEqual(banners(null), []);
  const all = banners({ tradingMode: "ANALYSIS_ONLY", killSwitch: { active: true }, allowSyntheticPaperData: true });
  assert.deepEqual(all.map((banner) => banner.key), ["synthetic", "mode", "killSwitch"]);
  assert.deepEqual(all.map((banner) => banner.tone), ["warn", "warn", "error"]);
  assert.equal(all[1].title, "Trading mode is ANALYSIS_ONLY");
  assert.equal(all[2].title, "Kill switch ACTIVE");
  // A missing switch field is NOT a released switch: only an explicit `false` is quiet.
  assert.deepEqual(banners({ tradingMode: "PAPER_TRADING", killSwitch: {}, allowSyntheticPaperData: false }).map((banner) => banner.key), []);
  assert.deepEqual(banners({ tradingMode: "PAPER_TRADING" }).map((banner) => banner.key), []);
});

test("the limits panel reads the persisted limits, percents as percents", () => {
  const rows = riskLimitRows({ riskPerTradePct: 0.01, maxOpenPositions: 10, requireStopLoss: true, blockSyntheticData: false, maxPositionNotionalUsd: 50000 });
  assert.deepEqual(rows.map((row) => row.value), ["1.00%", "10.00", "yes", "no", "50,000.00"]);
  assert.deepEqual(rows.map((row) => row.key), ["riskPerTradePct", "maxOpenPositions", "requireStopLoss", "blockSyntheticData", "maxPositionNotionalUsd"]);
  assert.deepEqual(riskLimitRows(null), []);
});

test("the outcome builders print the server's own sentences", () => {
  const rejected = orderOutcome({ filled: false, order: { status: "REJECTED", reject_reason: "first", rejectReasons: ["Kill switch is ACTIVE — all paper orders are blocked", "second"] } });
  assert.equal(rejected.tone, "error");
  assert.equal(rejected.message, "Order REJECTED: Kill switch is ACTIVE — all paper orders are blocked · second");
  const filled = orderOutcome({ filled: true, order: { status: "FILLED", side: "BUY", units: 0.0156, symbol: "BTCUSDT", fill_price: 64271.625506 } });
  assert.equal(filled.tone, "ok");
  assert.equal(filled.message, "Order FILLED: BUY 0.0156 BTCUSDT @ 64,271.62551");
  assert.equal(orderOutcome({ filled: false, order: { status: "PENDING", symbol: "BTCUSDT" } }).message, "Limit order PENDING — run a tick to fill it.");
  assert.equal(orderOutcome({}).tone, "error");
  assert.equal(orderOutcome({ filled: true, order: { status: "FILLED", side: "SELL", units: 1, symbol: "X", fill_price: null } }).message, "Order FILLED: SELL 1.0000 X @ —");

  assert.equal(closeOutcome({ position: { exit_price: 65000.25 }, netPnl: 12.3456 }).message, "Position closed @ 65,000.25000 · P&L 12.35");
  assert.equal(accountOutcome({ account: { id: 12 } }).message, "Paper account #12 created.");
  assert.equal(accountOutcome({ account: { id: 12 } }).accountId, 12);
  assert.equal(accountOutcome({}).message, "Paper account #? created.");

  const tick = tickOutcome({ actions: {
    filledOrders: [{}], closedPositions: [{}, {}],
    strategySignals: [
      { symbol: "BTCUSDT", action: "BUY", submitted: true, rejectReasons: [] },
      { symbol: "ETHUSDT", action: "SELL", submitted: false, rejectReasons: ["daily loss limit reached"] },
    ],
    skipped: [{}],
  } });
  assert.equal(tick.message, "Tick: 1 order(s) filled · 2 position(s) closed · 2 strategy signal(s) [BTCUSDT BUY submitted] [ETHUSDT SELL rejected: daily loss limit reached] · 1 skipped");
  assert.equal(tickOutcome({}).message, "Tick: 0 order(s) filled · 0 position(s) closed · 0 strategy signal(s)");
  assert.equal(deployOutcome({ strategy_id: "breakout" }).message, "Strategy breakout deployed — signals execute on each tick (risk-checked).");
  assert.equal(toggleOutcome({ id: 4, active: true }).message, "Deployment 4 resumed.");
  assert.equal(toggleOutcome({ id: 4, active: false }).message, "Deployment 4 paused.");
});

test("the forms hold the operator to the contract, and omit what was left blank", () => {
  assert.equal(validateAccountForm({ name: "  ", startingBalance: "10000" }).ok, false);
  assert.equal(validateAccountForm({ name: "x".repeat(61), startingBalance: "10000" }).ok, false);
  assert.equal(validateAccountForm({ name: "Sim", startingBalance: "0" }).errors.startingBalance, "Starting balance must be between 1 and 10,000,000.");
  assert.equal(validateAccountForm({ name: "Sim", startingBalance: "10000" }).ok, true);
  assert.deepEqual(buildAccountBody({ name: " Sim simulator ", startingBalance: "5000" }), { name: "Sim simulator", startingBalance: 5000, currency: "USD" });

  assert.equal(validateOrderForm({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", stopLoss: 1 }).errors.price, "A limit order needs a positive limit price.");
  assert.equal(validateOrderForm({ symbol: "B", side: "BUY", type: "MARKET", stopLoss: 1 }).ok, false);
  assert.equal(validateOrderForm({ symbol: "BTCUSDT", side: "HOLD", type: "MARKET", stopLoss: 1 }).ok, false);
  assert.equal(validateOrderForm({ symbol: "BTCUSDT", side: "BUY", type: "MARKET" }).errors.stopLoss, "Stops are mandatory: enter a positive stop loss.");
  assert.equal(validateOrderForm({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", stopLoss: 1, riskPct: "1" }).errors.riskPct, "Risk must be a fraction above 0 and at most 0.05 (5% of equity).");
  assert.equal(validateOrderForm({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", stopLoss: 1, confidence: "2" }).ok, false);
  assert.equal(validateOrderForm({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", stopLoss: 1 }).ok, true);
  assert.deepEqual(
    buildOrderBody({ symbol: "btcusdt", side: "BUY", type: "MARKET", price: "", stopLoss: "50000", takeProfit: "", riskPct: "", reason: "", confidence: "" }),
    { symbol: "BTCUSDT", side: "BUY", type: "MARKET", stopLoss: 50000 },
    "blank optional fields are omitted, so the server's defaults apply instead of being shadowed",
  );
  assert.deepEqual(
    buildOrderBody({ symbol: "BTCUSDT", side: "SELL", type: "LIMIT", price: "66000", stopLoss: "67000", takeProfit: "64000", riskPct: "0.01", reason: "reclaim", confidence: "0.7" }),
    { symbol: "BTCUSDT", side: "SELL", type: "LIMIT", price: 66000, stopLoss: 67000, takeProfit: 64000, riskPct: 0.01, reason: "reclaim", confidence: 0.7 },
  );
  assert.equal(validateDeployForm({ strategyId: "", symbol: "BTCUSDT", timeframe: "1h", marketClass: "crypto" }).ok, false);
  assert.equal(validateDeployForm({ strategyId: "breakout", symbol: "BTCUSDT", timeframe: "1h", marketClass: "crypto" }).ok, true);
  assert.equal(validateDeployForm({ strategyId: "breakout", symbol: "BTCUSDT", timeframe: "1m", marketClass: "crypto" }).ok, false, "1m is not a strategy timeframe");
  assert.deepEqual(buildDeployBody({ strategyId: "breakout", symbol: "btcusdt", timeframe: "1h", marketClass: "crypto" }), { strategyId: "breakout", symbol: "BTCUSDT", timeframe: "1h", marketClass: "crypto" });
  assert.deepEqual(buildDeployBody({ strategyId: "breakout", strategyVersion: "1.0.0", symbol: "BTCUSDT", timeframe: "1h", marketClass: "crypto" }).strategyVersion, "1.0.0");
});

test("the deploy form marks what cannot be deployed rather than hiding it", () => {
  const options = deployOptions({ strategies: [
    { strategyId: "breakout", latest: { version: "1.0.0", lifecycle: "RISK_REVIEWED", name: "Breakout" } },
    { strategyId: "mean-reversion", latest: { version: "2.0.0", lifecycle: "DRAFT" } },
    { strategyId: "trend", latest: { version: "0.3.0", lifecycle: "LIVE_APPROVED" } },
  ] });
  assert.deepEqual(options.map((option) => option.deployable), [true, false, true]);
  assert.deepEqual(options.map((option) => option.lifecycle), ["RISK_REVIEWED", "DRAFT", "LIVE_APPROVED"]);
  assert.equal(options[1].name, "mean-reversion", "a strategy with no name falls back to its id");
  assert.deepEqual(deployOptions(null), []);
});

// --------------------------------------------------------------------- selection

test("the account selection falls back rather than rendering an empty console", () => {
  const rows = accountRows({ accounts: [{ account: { id: 1, name: "A" } }, { account: { id: 2, name: "B" } }] });
  assert.equal(accountSelection(rows, "2").selected.id, 2);
  assert.equal(accountSelection(rows, null).selected.id, 1, "no choice shows the first account, as the board leads with it");
  assert.equal(accountSelection(rows, "99").selected.id, 1, "a stale choice falls back to the first");
  assert.equal(accountSelection([], "1").selected, null);
  assert.equal(accountSelection([], "1").rows.length, 0, "an empty host renders the board's own empty state");

  assert.equal(accountGate({ selected: null, canExecute: true }).reason, PAPER_COPY.accountsEmpty);
  const readOnly = accountGate({ selected: accountSelection(rows, null).selected, canExecute: false });
  assert.equal(readOnly.show, true, "a trading.view viewer still sees the console");
  assert.equal(readOnly.readOnly, true);
  assert.match(readOnly.reason, /trading\.execute/);
  assert.equal(accountGate({ selected: accountSelection(rows, null).selected, canExecute: true }).readOnly, false);
});

test("the formatting helpers match the PHP they replace", () => {
  assert.equal(moneyText(0), "0.00");
  assert.equal(moneyText("1234.5"), "1,234.50");
  assert.equal(moneyText(null), "—");
  assert.equal(moneyText("not a number"), "—");
  assert.equal(priceText(64271.625506), "64,271.62551");
  assert.equal(unitsText(0.0125), "0.0125");
  assert.equal(unitsText(0), "0.0000");
  assert.equal(pctText(0), "0.00%");
  assert.equal(pctText(null), "—");
  assert.equal(pnlTone(0.01), "up");
  assert.equal(pnlTone(-0.01), "down");
  assert.equal(pnlTone(0), "muted");
  assert.equal(orderTimeText("2026-10-16T22:53:07.992Z"), "10-16 22:53");
  assert.equal(orderTimeText("2026-10-16 22:53:07"), "10-16 22:53");
});

// ------------------------------------------------------------------- the wiring

test("the screen is declared where the router and the navigation will find it", () => {
  const app = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  const views = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");
  const api = readFileSync(path.join(CLIENT, "api.js"), "utf8");
  assert.match(app, /path: "\/app\/paper", view: "paper-console", requiresAuth: true, permission: "trading\.view"/);
  assert.match(app, /"paper-console": <PaperConsoleView permissions=\{permissions\} \/>/);
  assert.match(views, /export function PaperConsoleView\(\{ permissions \}\)/);
  assert.match(views, /\{ to: "\/app\/paper", label: "Paper trading", permission: PAPER_PERMISSION \}/, "the navigation entry carries the same gate the route does");
  assert.match(views, /<h1>\{PAPER_COPY\.title\}\.<\/h1>/, "the heading is the legacy page's own string, not a literal");
  assert.match(views, /id="paper-account"/, "the account console is an anchor on the same screen, as legacy linked between its pages");

  // The three governance writes are NOT carried: the screen names where they live instead.
  for (const path_ of ["/api/v1/trading/mode", "/api/v1/trading/kill-switch", "/api/v1/trading/synthetic-paper"]) {
    const call = `api("${path_}"` ;
    assert.ok(!views.includes(call), `${path_} is governed elsewhere and must not be posted from this screen`);
  }
  assert.match(views, /endpoints\.setKillSwitch|endpoints\.setTradingMode/, "the governance controls exist elsewhere in the shell");
  assert.match(views, /to="\/app\/analysis"/, "and this screen points at them");

  // Every read the console makes is a wrapper, and every wrapper is used.
  for (const name of ["paperAccounts", "paperAccount", "paperOrders", "paperPositions", "paperCreateAccount", "paperSubmitOrder", "paperClosePosition", "paperTick", "paperDeployments", "paperDeployStrategy", "paperToggleDeployment", "tradingMode", "strategies"]) {
    assert.match(api, new RegExp(`\\n  ${name}:`), `${name} is a declared endpoint`);
    assert.ok(views.includes(`endpoints.${name}(`), `${name} is used by the console`);
  }
  assert.match(views, /const canExecute = holdsPaperPermission\(permissions, PAPER_EXECUTE\);/);
  assert.match(views, /act\(PAPER_COPY\.tickLabel, async \(\) => tickOutcome/, "the tick's busy label is the tick's own label");
  assert.match(views, /disabled=\{busy \|\| !canExecute\}/);
});

test("the dashboard's paper destinations now open the console instead of excusing it", () => {
  const dashboard = readFileSync(path.join(CLIENT, "dashboard.js"), "utf8");
  assert.ok(!/no console screen in this edition/.test(dashboard), "the F-29 note for paper is stale once /app/paper exists");
  assert.match(dashboard, /\{ key: "paper", label: "Paper trading", to: "\/app\/paper"/);
  assert.match(dashboard, /to: "\/app\/paper",\n    \},\n    \{\n      key: "alerts"/, "the paper KPI card links to the console too");
  assert.match(dashboard, /The console at `\/app\/paper` reads `GET \/api\/v1\/paper\/accounts`\./);
});

// ------------------------------------------------------------------- over HTTP

test("an empty host renders the board's own empty state and reads every surface", async (t) => {
  const app = await instance(t);
  const root = await signIn(app.app);
  const accounts = await get(app.app, "/api/v1/paper/accounts", root.headers);
  assert.equal(accounts.statusCode, 200, accounts.body);
  assert.deepEqual(accounts.json().accounts, []);
  assert.deepEqual(accountRows(accounts.json()), []);
  assert.equal(accountSelection(accountRows(accounts.json()), null).selected, null);
  assert.equal(accountGate({ selected: null, canExecute: true }).reason, PAPER_COPY.accountsEmpty);

  const state = await get(app.app, "/api/v1/trading/mode", root.headers);
  assert.equal(state.statusCode, 200, state.body);
  const notices = banners(state.json());
  assert.deepEqual(notices.map((banner) => banner.key), ["mode", "killSwitch"], "a fresh host is ANALYSIS_ONLY with the switch ACTIVE");
  const limits = riskLimitRows(state.json().riskLimits);
  assert.ok(limits.length >= 16, `the persisted limits are the full vocabulary, found ${limits.length}`);
  assert.equal(limits.find((limit) => limit.key === "riskPerTradePct").value, "1.00%");
  assert.equal(limits.find((limit) => limit.key === "maxRiskPerTradePct").value, "2.00%");

  const strategies = await get(app.app, "/api/v1/strategies", root.headers);
  assert.equal(strategies.statusCode, 200, strategies.body);
  const options = deployOptions(strategies.json());
  assert.ok(options.length >= 4, `the four builtin strategies are the deploy form's list, found ${options.length}`);
  assert.ok(options.every((option) => option.lifecycle === "DRAFT"), "they start at DRAFT, which is why the form marks them undeployable");
});

test("a trading.view session reads the board and is refused every mutation — and sees no account it does not own", async (t) => {
  const app = await instance(t);
  const viewer = await sessionWithRole(app.app, app.store, "trading_viewer", "paperviewer", "Paper viewer phrase");
  assert.ok(viewer.permissions.includes(PAPER_PERMISSION));
  assert.ok(!viewer.permissions.includes(PAPER_EXECUTE), "the viewer role carries the read only");

  // The three surfaces that are not account-scoped answer the read-only session.
  for (const read of PAPER_READS.filter((entry) => !entry.path.includes(":accountId"))) {
    const response = await get(app.app, read.path, viewer.headers);
    assert.equal(response.statusCode, 200, `${read.key}: ${response.body}`);
  }

  // Legacy's `Paper::account($id)` looked an account up by id with no owner filter at all;
  // the port scopes every paper read to the owner, and answers a foreign account exactly as
  // it answers a missing one. That is a deliberate divergence, so it is asserted against
  // legacy's source rather than described: the legacy controller never mentions the column.
  assert.ok(!readFileSync(LEGACY_CONTROLLER, "utf8").includes("owner_user_id"), "legacy had no owner scoping to port");
  const root = await signIn(app.app);
  const foreign = await createAccount(app.app, root.headers, "Root's simulator", 4000);
  for (const read of PAPER_READS.filter((entry) => entry.path.includes(":accountId"))) {
    const url = read.path.replace(":accountId", String(foreign));
    const response = await get(app.app, url, viewer.headers);
    assert.equal(response.statusCode, 404, `${read.key}: ${response.body}`);
    assert.equal(response.json().error.code, "PAPER_ACCOUNT_NOT_FOUND", `${read.key} must not distinguish a foreign account from a missing one`);
  }
  assert.deepEqual(accountRows((await get(app.app, "/api/v1/paper/accounts", viewer.headers)).json()), [], "and the board a viewer sees is empty");
  // The console's own state for that session is legacy's empty state, not an error wall.
  assert.equal(accountGate({ selected: null, canExecute: false }).reason, PAPER_COPY.accountsEmpty);

  // Every mutation is refused for the missing `trading.execute`, with the API's own code.
  const create = await post(app.app, "/api/v1/paper/accounts", viewer.headers, buildAccountBody({ name: "Refused", startingBalance: 1000 }));
  assert.equal(create.statusCode, 403, create.body);
  assert.equal(create.json().error.code, "PERMISSION_DENIED");
  // Each carries the body its own contract accepts, so the refusal is the permission's and
  // not a body schema's — a 400 here would prove nothing about the guard.
  for (const [label, url, payload] of [
    ["order", `/api/v1/paper/accounts/${foreign}/orders`, buildOrderBody({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", stopLoss: "50000" })],
    ["tick", `/api/v1/paper/accounts/${foreign}/tick`, {}],
    ["deploy", `/api/v1/paper/accounts/${foreign}/deployments`, buildDeployBody({ strategyId: "breakout", symbol: "BTCUSDT", timeframe: "1h", marketClass: "crypto" })],
    ["close", `/api/v1/paper/accounts/${foreign}/positions/1/close`, {}],
    ["toggle", `/api/v1/paper/accounts/${foreign}/deployments/1/toggle`, { active: false }],
  ]) {
    const response = await post(app.app, url, viewer.headers, payload);
    assert.equal(response.statusCode, 403, `${label}: ${response.body}`);
    assert.equal(response.json().error.code, "PERMISSION_DENIED", label);
  }
  // And the gate the screen renders for that session is the one the API enforces.
  assert.match(accountGate({ selected: { id: foreign }, canExecute: false }).reason, new RegExp(PAPER_EXECUTE));
});

test("the whole flow over HTTP: refused under the switch, refused in ANALYSIS_ONLY, filled and closed after both", async (t) => {
  const app = await instance(t);
  const root = await signIn(app.app);
  const accountId = await createAccount(app.app, root.headers, "Console simulator", 10000);

  // The board reads the account the console just made.
  const listed = await get(app.app, "/api/v1/paper/accounts?limit=50", root.headers);
  const rows = accountRows(listed.json());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].balance, "10,000.00");
  assert.equal(accountSelection(rows, null).selected.id, accountId);

  // 1. The boot state: the switch is ACTIVE, and the order is stored REJECTED with the
  //    refusal the banner promised.
  const order = buildOrderBody({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", stopLoss: "50000", reason: "console test", confidence: "0.7" });
  const underSwitch = await post(app.app, `/api/v1/paper/accounts/${accountId}/orders`, root.headers, order);
  assert.equal(underSwitch.statusCode, 409, underSwitch.body);
  const rejected = orderOutcome(underSwitch.json());
  assert.equal(rejected.tone, "error");
  assert.match(rejected.message, /^Order REJECTED: Kill switch is ACTIVE — all paper orders are blocked$/);
  assert.equal(underSwitch.json().order.status, "REJECTED");
  const seen = orderRows((await get(app.app, `/api/v1/paper/accounts/${accountId}/orders?limit=200`, root.headers)).json().orders);
  assert.equal(seen.length, 1, "the rejection is a stored row the table shows, not a message that vanished");
  assert.equal(seen[0].statusTone, "badge-red");

  // 2. Release the switch: the mode still blocks it, and the API says so with its own word.
  assert.equal((await releaseKillSwitch(app.app, root.headers)).statusCode, 200);
  const inAnalysis = await post(app.app, `/api/v1/paper/accounts/${accountId}/orders`, root.headers, order);
  assert.equal(inAnalysis.statusCode, 409, inAnalysis.body);
  assert.match(orderOutcome(inAnalysis.json()).message, /ANALYSIS_ONLY/);
  assert.deepEqual(banners((await get(app.app, "/api/v1/trading/mode", root.headers)).json()).map((banner) => banner.key), ["mode"], "releasing the switch silences its own banner and no other");

  // 3. PAPER_TRADING with synthetic prices still off: the contract now admits the order and
  //    the Risk Engine refuses it on data provenance — the case the third banner explains.
  assert.equal((await setMode(app.app, root.headers, "PAPER_TRADING")).statusCode, 200);
  const syntheticOff = await post(app.app, `/api/v1/paper/accounts/${accountId}/orders`, root.headers, order);
  assert.equal(syntheticOff.statusCode, 409, syntheticOff.body);
  assert.match(orderOutcome(syntheticOff.json()).message, /SYNTHETIC/);
  assert.deepEqual(banners((await get(app.app, "/api/v1/trading/mode", root.headers)).json()).map((banner) => banner.key), [], "with the switch released and the mode PAPER_TRADING no banner is due — the refusal is the Risk Engine's sentence, rendered from the order row");

  // The synthetic-paper setting is what a sandbox fill needs, and it is a governance act
  // this screen does not carry — the test performs it the way /app/analysis does.
  assert.equal((await allowSynthetic(app.app, root.headers)).statusCode, 200);
  const state = (await get(app.app, "/api/v1/trading/mode", root.headers)).json();
  assert.deepEqual(banners(state).map((banner) => banner.key), ["synthetic"], "the sandbox's own banner is the one left standing, and it says so");

  // 4. With the governance satisfied the same body fills.
  const filledResponse = await post(app.app, `/api/v1/paper/accounts/${accountId}/orders`, root.headers, order);
  assert.equal(filledResponse.statusCode, 201, filledResponse.body);
  const filled = orderOutcome(filledResponse.json());
  assert.equal(filled.tone, "ok");
  assert.match(filled.message, /^Order FILLED: BUY /);
  assert.match(filled.message, /BTCUSDT @ /);

  // 5. A limit order pends, and a tick fills what it can — the console's own sentence.
  const limit = buildOrderBody({ symbol: "ETHUSDT", side: "BUY", type: "LIMIT", price: "100", stopLoss: "90" });
  const pending = await post(app.app, `/api/v1/paper/accounts/${accountId}/orders`, root.headers, limit);
  assert.equal(pending.statusCode, 202, pending.body);
  assert.equal(orderOutcome(pending.json()).message, "Limit order PENDING — run a tick to fill it.");
  const tickResponse = await post(app.app, `/api/v1/paper/accounts/${accountId}/tick`, root.headers, {});
  assert.equal(tickResponse.statusCode, 200, tickResponse.body);
  const tick = tickOutcome(tickResponse.json());
  assert.match(tick.message, /^Tick: \d+ order\(s\) filled · \d+ position\(s\) closed · \d+ strategy signal\(s\)/);

  // 6. Close the open position and read the closed table back.
  const summary = await summaryOf(app.app, root.headers, accountId);
  const positions = positionRows(summary.positions);
  assert.ok(positions.length >= 1, "the fill opened a position");
  assert.equal(positions[0].symbol, "BTCUSDT");
  assert.equal(positions[0].glyph, "▲");
  const closedResponse = await post(app.app, `/api/v1/paper/accounts/${accountId}/positions/${positions[0].id}/close`, root.headers, {});
  assert.equal(closedResponse.statusCode, 200, closedResponse.body);
  const closed = closeOutcome(closedResponse.json());
  assert.match(closed.message, /^Position closed @ .+ · P&L /);
  const closedRowsRead = closedRows((await get(app.app, `/api/v1/paper/accounts/${accountId}/positions?status=CLOSED&limit=25`, root.headers)).json().closed);
  assert.equal(closedRowsRead.length, 1);
  assert.equal(closedRowsRead[0].exitReason, "MANUAL");
  assert.equal(closedRowsRead[0].symbol, "BTCUSDT");
  assert.equal((await summaryOf(app.app, root.headers, accountId)).openPositions, 0);
});

test("the deploy form's own body is accepted once the strategy is deployable, and the toggle answers", async (t) => {
  const app = await instance(t);
  const root = await signIn(app.app);
  const accountId = await createAccount(app.app, root.headers, "Deployment simulator", 5000);

  // DRAFT strategies are refused — this is the gate the form's hint names.
  const draft = await post(app.app, `/api/v1/paper/accounts/${accountId}/deployments`, root.headers, buildDeployBody({ strategyId: "breakout", symbol: "BTCUSDT", timeframe: "1h", marketClass: "crypto" }));
  assert.equal(draft.statusCode, 409, draft.body);
  assert.match(draft.json().error.code, /STRATEGY|LIFECYCLE/);

  // Advance it the way the Strategy Lab console does — a backtest first, then each stage in
  // the order the registry declares (a stage may not be skipped) — and only then deploy
  // through this form's own body.
  const backtest = await post(app.app, "/api/v1/backtesting/run", root.headers, { strategyId: "breakout", strategyVersion: "1.0.0", symbol: "BTCUSDT", marketClass: "crypto", timeframe: "15m", limit: 5000 });
  assert.equal(backtest.statusCode, 200, backtest.body);
  for (const to of ["BACKTESTED", "VALIDATED", "RISK_REVIEWED"]) {
    const step = await post(app.app, "/api/v1/strategies/breakout/status", root.headers, { to, version: "1.0.0", reason: "paper console test" });
    assert.equal(step.statusCode, 200, `${to}: ${step.body}`);
    assert.equal(step.json().strategy.lifecycle, to);
  }
  assert.equal(deployOptions((await get(app.app, "/api/v1/strategies", root.headers)).json()).find((option) => option.strategyId === "breakout").deployable, true, "and the form now marks it deployable");
  const deployed = await post(app.app, `/api/v1/paper/accounts/${accountId}/deployments`, root.headers, buildDeployBody({ strategyId: "breakout", symbol: "BTCUSDT", timeframe: "1h", marketClass: "crypto" }));
  assert.equal(deployed.statusCode, 201, deployed.body);
  const rows = deploymentRows((await get(app.app, `/api/v1/paper/accounts/${accountId}/deployments`, root.headers)).json().deployments);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "active");
  assert.equal(rows[0].lastSignal, "—");
  const toggled = await post(app.app, `/api/v1/paper/accounts/${accountId}/deployments/${rows[0].id}/toggle`, root.headers, { active: false });
  assert.equal(toggled.statusCode, 200, toggled.body);
  assert.equal(toggleOutcome(toggled.json()).message, `Deployment ${rows[0].id} paused.`);
  assert.equal(deploymentRows((await get(app.app, `/api/v1/paper/accounts/${accountId}/deployments`, root.headers)).json().deployments)[0].status, "paused");
});

test("the served shell carries the screen, and the deep link answers", async (t) => {
  const app = await instance(t);
  const shell = path.resolve(CLIENT, "..", "..", "public", "app", "index.html");
  assert.ok(existsSync(shell), "the built SPA shell is required: npm run build:client");
  const html = await app.app.inject({ method: "GET", url: "/app/paper", headers: { accept: "text/html" } });
  assert.equal(html.statusCode, 200, "a bookmark, a refresh or a pasted link must reach the screen");
  assert.match(html.headers["content-type"] || "", /text\/html/);
  const assets = [...html.body.matchAll(/assets\/index-[A-Za-z0-9_-]+\.js/g)].map((match) => match[0]);
  assert.ok(assets.length >= 1, "the shell must reference the built bundle");
  const bundle = readFileSync(path.resolve(CLIENT, "..", "..", "public", "app", ...assets[0].split("/")), "utf8");
  for (const needle of ["Paper Trading", "Orders (incl. rejected — auditability)", "Run market tick", "Effective risk limits"]) {
    assert.ok(bundle.includes(needle), `the served bundle carries ${JSON.stringify(needle)}`);
  }
  assert.ok(!bundle.includes("no console screen in this edition"), "and the stale F-29 note for paper is gone from the bundle");
});
