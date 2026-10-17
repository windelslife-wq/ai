/**
 * The paper trading console (row 10, Phase 37).
 *
 * Legacy has two screens over one module: `Paper::index` → `views/paper/index.php` (the
 * accounts board — "Paper Trading") and `Paper::account` → `views/paper/account.php` (one
 * account's console). The port puts both on one surface at `/app/paper`, because the
 * second is the first with one account selected: the board's "open console" link becomes
 * the selection, and the account console renders underneath it. The shell's router is
 * exact-path by design (`client/src/router.jsx`: every `/app/...` path is a declared
 * surface in the parity ledger, so a parameter would let an undeclared one render), which
 * is why the account is chosen in the page and not in the URL. That is a documented
 * divergence, not an oversight — legacy's `/paper/{id}` was a full page load of the same
 * data this screen already holds.
 *
 * Three rules, the same ones every console in this shell follows:
 *
 *  1. **No number is printed that the server did not send.** A missing valuation is an em
 *     dash with the API's own warning beside it (`valuationWarnings`), never a zero; the
 *     account's risk figures come from the summary the server computed, not from
 *     re-deriving them here.
 *  2. **Nothing is offered that the API would refuse.** Every account mutation is
 *     `trading.execute` on the server; a session holding only `trading.view` sees the
 *     tables and is told which permission gates each control. The governance writes
 *     (mode, kill switch, synthetic prices) are `trading.control` and this screen does
 *     **not** carry them: legacy's page did not either — it printed a banner naming the
 *     Dashboard and the switch — so the port points at the screens that own them
 *     (`/app/analysis` renders both controls) rather than growing a second control that
 *     could drift from the first.
 *  3. **The refusals are the server's own sentences.** A rejected order prints the API's
 *     `rejectReasons` verbatim, which is what makes the kill-switch and trading-mode
 *     banners at the top verifiable: the screen states the governance and the API states
 *     the consequence, and they are the same state read twice.
 *
 * Every function here is pure: `views.jsx` binds them to reads, `test/client_paper_console.test.js`
 * holds them to the legacy text (read with `readFileSync`) and to the routes the server
 * actually registers, and the constants that mirror server values (`PAPER_COSTS`) are
 * asserted against the server module rather than trusted.
 */

import { numberText } from "./sports.js";

/** Legacy `Platform::state()`/`Api_paper` reads: the paper routes are `trading.view`. */
export const PAPER_PERMISSION = "trading.view";
/** Creating accounts, orders, closes, ticks and deployments: `trading.execute`. */
export const PAPER_EXECUTE = "trading.execute";
/** The governance writes this screen deliberately does not carry: `trading.control`. */
export const PAPER_CONTROL = "trading.control";
/** `system.super_admin` short-circuits every permission check server-side. */
export const SUPER_ADMIN_PERMISSION = "system.super_admin";

/**
 * Whether the session holds a permission, mirroring the server's rule:
 * `system.super_admin` passes every check (`identity/service.js` → `userHasPermission`,
 * exactly as `Identity::can()` did). A screen that ignored the shortcut would withhold a
 * control the API answers — the same class of error as showing one it refuses.
 */
export function holdsPaperPermission(permissions, permission) {
  if (!permission) return true;
  const held = Array.isArray(permissions) ? permissions : [];
  return held.includes(permission) || held.includes(SUPER_ADMIN_PERMISSION);
}

/**
 * The engine's own cost constants, in basis points, as `PaperTradingEngine`'s class
 * constants and `src/modules/paper/engine.js`'s `PAPER_COSTS` both define them. The
 * account lede prints them, so they are asserted against the server module in the test
 * rather than duplicated as prose that could drift from the engine.
 */
export const PAPER_COSTS = Object.freeze({ spreadBps: 2, slippageBps: 2, feeBps: 2 });

/**
 * The two pages' own words, transcribed. `index.php`'s heading and lede, its three
 * banners and its two panels; `account.php`'s heading, its account line, its eight
 * statistics, its four tables, its two forms and their two footnotes.
 */
export const PAPER_COPY = Object.freeze({
  eyebrow: "PAPER TRADING · ROW 10",
  title: "Paper Trading",
  lede: "Simulated accounts and fills. Every order still passes the kill switch, trading mode and Risk Engine. No order leaves this process.",

  // index.php — the accounts board.
  accountsTitle: "Accounts",
  accountsEmpty: "No paper accounts yet — create one on the right to begin.",
  accountsNote: "Owner-scoped: these are your simulation accounts, not the table's rows.",
  createTitle: "Create a paper account",
  nameLabel: "Name",
  namePlaceholder: "Swing simulator",
  balanceLabel: "Starting balance (USD)",
  createLabel: "Create account",
  createNote: "Risk limits apply per order: 1% risk default, mandatory stops, exposure/drawdown gates — the same Risk Engine that governs every other layer.",
  openLabel: "open console",
  openAllLabel: "all accounts",

  // index.php — the three banners.
  syntheticBanner: "SIMULATION PRICES — synthetic-paper mode is ON for this offline demo: fills use clearly-labeled synthetic quotes (no market egress here). Production keeps this OFF; the Risk Engine then vetoes any synthetic-data trade.",
  modeBanner: (mode) => `Trading mode is ${mode} — paper orders are blocked until you switch to PAPER_TRADING on the Dashboard. The kill switch must also be released.`,
  killSwitchBanner: "Kill switch ACTIVE — all order placement (paper included) is vetoed.",

  // account.php — the account head.
  accountTitle: "Paper account",
  backLabel: "← accounts",
  tickLabel: "▶ Run market tick",
  fillsNote: `Simulated fills with full governance: ${PAPER_COSTS.spreadBps}bps spread + ${PAPER_COSTS.slippageBps}bps slippage + ${PAPER_COSTS.feeBps}bps commission per side.`,

  // account.php — the panels.
  positionsTitle: "Open positions",
  positionsEmpty: "No open positions.",
  ordersTitle: "Orders (incl. rejected — auditability)",
  ordersEmpty: "No orders yet.",
  closedTitle: "Closed positions (journaled automatically)",
  closedEmpty: "No closed positions yet.",
  orderTitle: "Place a paper order",
  orderSubmit: "Submit paper order (risk-checked)",
  orderNote: "* Stops are mandatory. Sizing = risk% × equity ÷ stop distance (capped by notional limits). Limit orders fill on the next tick; SL/TP evaluate on candle extremes with the stop-first rule.",
  deployTitle: "Deploy a strategy (auto-trading, simulated)",
  deploySubmit: "Deploy to paper account",
  deployNote: "Gate: strategy must be RISK_REVIEWED or beyond (AI-source strategies blocked without human sign-off). Deploying advances the lifecycle to PAPER_TRADING. Signals fire on ticks.",
  deploymentsEmpty: "No strategy is deployed on this account.",

  // The one panel legacy did not have, because it printed the note as prose: the limits
  // the same engine enforces, read from `GET /trading/mode` rather than restated.
  limitsTitle: "Effective risk limits",
  limitsNote: "Read from `GET /api/v1/trading/mode`; changed under `trading.control` on the paper governance routes, not from this screen.",

  // What the screen does not do — the same statement the module's ledger row makes.
  boundaryTitle: "What this screen does not do",
  tickNote: "A tick is an operator's action, not a schedule: it requests the last candles, fills the pending limit orders it finds, evaluates deployments and writes the result.",
});

/**
 * What the screen says about itself in the boundary panel. The module's ledger row is
 * `ported`, so this is not a not-ported matrix — it is the paper module's actual design,
 * stated where a reader looks for the catch.
 */
export const PAPER_BOUNDARY = Object.freeze([
  "Nothing is routed. There is no broker connector and no order path in this edition, and the API answers `simulationOnly: true` / `liveTradingEnabled: false` on every read that carries them.",
  "A tick is an operator's action (`POST /paper/accounts/:id/tick`, `trading.execute`): the operations cron does not tick accounts, so no position closes or fills on a schedule here.",
  "Trading mode, the kill switch and synthetic-paper prices are governed on `/app/analysis` under `trading.control` — legacy's page named the Dashboard for the same reason this screen has no switch of its own.",
]);

/** The window sizes the screens read. Legacy sliced orders to 25 rows; the rest are ours. */
export const PAPER_WINDOWS = Object.freeze({
  accounts: 50,
  orders: 200,
  listedOrders: 25,
  closed: 25,
  deployments: 500,
  limits: 16,
});

/* ------------------------------------------------------------------ formatting */

const EM_DASH = "—";

export function emDash() {
  return EM_DASH;
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Money, `number_format($x, 2)`'s answer: grouped, two decimals, an em dash for nothing. */
export function moneyText(value, digits = 2) {
  return numberText(finite(value), digits);
}

/** Prices print to five decimals, as the account page printed them. */
export function priceText(value) {
  return numberText(finite(value), 5);
}

/** Units print to four decimals, as the positions table printed them. */
export function unitsText(value) {
  return numberText(finite(value), 4);
}

/** A percentage with its sign: legacy printed `number_format($x, 2) . '%'`. */
export function pctText(value, digits = 2) {
  const number = finite(value);
  return number === null ? EM_DASH : `${numberText(number, digits)}%`;
}

/**
 * A stored timestamp in the order table's format.
 *
 * Legacy printed `substr($o['created_at'], 5, 11)` — from MySQL's `2026-10-16 22:53:07`
 * that is `10-16 22:53`. The Node API returns ISO-8601 (`2026-10-16T22:53:07.992Z`), so
 * slicing `5, 11` here would print `10-16T22:53` and the console would render a different
 * string from the page it ports. The port reproduces the legacy rendering: the ISO
 * separator becomes the space MySQL had.
 */
export function orderTimeText(value) {
  const text = typeof value === "string" ? value : "";
  const match = text.match(/^\d{4}-(\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]}` : EM_DASH;
}

/** Legacy's glyphs: a long is `▲`, a short is `▼`. */
export function directionGlyph(direction) {
  return String(direction).toUpperCase() === "LONG" ? "▲" : "▼";
}

/* ---------------------------------------------------------------------- tones */

/** Legacy's badge map: FILLED green, PENDING amber, REJECTED red, anything else gray. */
export function orderStatusTone(status) {
  return ({ FILLED: "badge-green", PENDING: "badge-amber", REJECTED: "badge-red", CANCELLED: "badge-gray" })[String(status)] || "badge-gray";
}

/** Legacy painted the side green for a buy and red for a sell. */
export function sideTone(side) {
  return String(side).toUpperCase() === "BUY" ? "up" : "down";
}

/** Legacy painted positive P&L `up` and negative `down`; zero is neither. */
export function pnlTone(value) {
  const number = finite(value);
  if (number === null) return "muted";
  if (number > 0) return "up";
  if (number < 0) return "down";
  return "muted";
}

export function deploymentTone(active) {
  return active ? "badge-green" : "badge-gray";
}

/* ------------------------------------------------------------------- shaping */

/**
 * The accounts board: one row per account summary, with the colour each P&L cell needs.
 * `GET /paper/accounts` answers `{accounts: [summary…], tradingMode, simulationOnly}`.
 */
export function accountRows(payload) {
  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  return accounts.map((summary) => ({
    key: String(summary?.account?.id ?? ""),
    id: summary?.account?.id ?? null,
    name: summary?.account?.name ?? "",
    currency: summary?.account?.currency ?? null,
    balance: moneyText(summary?.balance),
    equity: moneyText(summary?.equity),
    unrealized: moneyText(summary?.unrealizedPnl),
    unrealizedTone: pnlTone(summary?.unrealizedPnl),
    daily: moneyText(summary?.dailyPnl),
    dailyTone: pnlTone(summary?.dailyPnl),
    open: numberText(finite(summary?.openPositions) ?? 0, 0),
    openCount: finite(summary?.openPositions) ?? 0,
    valuationAvailable: summary?.valuationAvailable !== false,
  }));
}

/** The account console's eight statistics, legacy's order and legacy's labels. */
export function accountCards(summary) {
  if (!summary) return [];
  const openRisk = finite(summary.openRisk);
  return [
    { key: "balance", label: "Balance", value: `$${moneyText(summary.balance)}`, tone: "" },
    { key: "equity", label: "Equity", value: `$${moneyText(summary.equity)}`, tone: "" },
    { key: "unrealized", label: "Unrealized P&L", value: moneyText(summary.unrealizedPnl), tone: pnlTone(summary.unrealizedPnl) },
    { key: "daily", label: "Daily P&L", value: moneyText(summary.dailyPnl), tone: pnlTone(summary.dailyPnl) },
    { key: "weekly", label: "Weekly P&L", value: moneyText(summary.weeklyPnl), tone: pnlTone(summary.weeklyPnl) },
    { key: "open", label: "Open positions", value: numberText(finite(summary.openPositions) ?? 0, 0), tone: "" },
    { key: "openRisk", label: "Open risk (Σ)", value: `$${moneyText(openRisk)}`, tone: openRisk > 0 ? "warn" : "" },
    { key: "dailyLoss", label: "Daily loss", value: pctText(summary.dailyLossPct), tone: (finite(summary.dailyLossPct) ?? 0) > 0 ? "down" : "muted" },
  ];
}

/**
 * Open positions, from the summary (`publicPositionView` rows: snake_case plus the
 * valuation fields). The `positions` endpoint answers raw rows without a valuation, so
 * the summary is what these columns need — current price, unrealized P&L and R.
 */
export function positionRows(positions) {
  const rows = Array.isArray(positions) ? positions : [];
  return rows.map((position) => ({
    key: String(position.id),
    id: position.id,
    symbol: position.symbol,
    direction: position.direction,
    glyph: directionGlyph(position.direction),
    directionTone: String(position.direction).toUpperCase() === "LONG" ? "up" : "down",
    units: unitsText(position.units),
    entry: priceText(position.entry_price),
    current: priceText(position.current_price),
    stopLoss: priceText(position.stop_loss),
    takeProfit: priceText(position.take_profit),
    pnl: moneyText(position.unrealized_pnl),
    pnlTone: pnlTone(position.unrealized_pnl),
    r: position.unrealized_r === null || position.unrealized_r === undefined ? EM_DASH : numberText(finite(position.unrealized_r), 2),
    valuationAvailable: position.valuation_available !== false,
    synthetic: Boolean(position.valuation_synthetic),
  }));
}

/** The orders table, including the rejected ones — legacy's auditability rule. */
export function orderRows(orders) {
  const rows = Array.isArray(orders) ? orders : [];
  return rows.map((order) => {
    const reasons = Array.isArray(order.rejectReasons) ? order.rejectReasons : [];
    const reason = order.reject_reason || order.reason || reasons.join(" · ") || EM_DASH;
    const price = order.fill_price ?? order.price ?? null;
    return {
      key: String(order.id),
      id: order.id,
      time: orderTimeText(order.created_at),
      symbol: order.symbol,
      side: order.side,
      sideTone: sideTone(order.side),
      units: unitsText(order.units),
      price: priceText(price),
      status: order.status,
      statusTone: orderStatusTone(order.status),
      reason: reason || EM_DASH,
      synthetic: Boolean(order.synthetic),
    };
  });
}

/** Closed positions: the raw rows the `positions` endpoint returns for `status=CLOSED`. */
export function closedRows(positions) {
  const rows = Array.isArray(positions) ? positions : [];
  return rows.map((position) => ({
    key: String(position.id),
    id: position.id,
    symbol: position.symbol,
    direction: position.direction,
    glyph: directionGlyph(position.direction),
    directionTone: String(position.direction).toUpperCase() === "LONG" ? "up" : "down",
    entry: priceText(position.entry_price),
    exit: priceText(position.exit_price),
    pnl: moneyText(position.realized_pnl),
    pnlTone: pnlTone(position.realized_pnl),
    exitReason: position.exit_reason || EM_DASH,
    closedAt: orderTimeText(position.closed_at),
  }));
}

/** Deployments: strategy, symbol, the last signal, and the active/paused badge. */
export function deploymentRows(deployments) {
  const rows = Array.isArray(deployments) ? deployments : [];
  return rows.map((deployment) => ({
    key: String(deployment.id),
    id: deployment.id,
    strategy: deployment.strategy_id,
    version: deployment.strategy_version ?? null,
    symbol: deployment.symbol,
    timeframe: deployment.timeframe ?? null,
    marketClass: deployment.market_class ?? null,
    lastSignal: deployment.last_signal || EM_DASH,
    active: Boolean(deployment.active),
    status: deployment.active ? "active" : "paused",
    tone: deploymentTone(Boolean(deployment.active)),
    toggleLabel: deployment.active ? "pause" : "resume",
  }));
}

/** The persisted limits, in a stable order with legacy's own names where it had them. */
export function riskLimitRows(limits) {
  if (!limits || typeof limits !== "object") return [];
  const percentKeys = new Set([
    "riskPerTradePct", "maxRiskPerTradePct", "maxDailyLossPct", "maxWeeklyLossPct",
    "maxDrawdownPct", "maxSymbolExposurePct", "maxPortfolioExposurePct", "minDataQuality",
  ]);
  return Object.entries(limits).map(([key, value]) => ({
    key,
    label: key.replace(/([A-Z])/g, " $1").replace(/^./, (first) => first.toUpperCase()),
    value: typeof value === "boolean" ? (value ? "yes" : "no") : percentKeys.has(key) ? pctText(Number(value) * 100) : numberText(finite(value), 2),
  }));
}

/**
 * The banners, in legacy's order: the synthetic-prices notice, then the trading mode,
 * then the kill switch. Each is a fact read from `GET /trading/mode`; the state is not
 * guessed from a refused order.
 */
export function banners(state) {
  if (!state) return [];
  const list = [];
  if (state.allowSyntheticPaperData === true) {
    list.push({ key: "synthetic", tone: "warn", title: "SIMULATION PRICES", text: PAPER_COPY.syntheticBanner });
  }
  if (state.tradingMode && state.tradingMode !== "PAPER_TRADING") {
    list.push({ key: "mode", tone: "warn", title: `Trading mode is ${state.tradingMode}`, text: PAPER_COPY.modeBanner(state.tradingMode) });
  }
  if (state.killSwitch?.active === true) {
    list.push({ key: "killSwitch", tone: "error", title: "Kill switch ACTIVE", text: PAPER_COPY.killSwitchBanner });
  }
  return list;
}

/* ------------------------------------------------------------------ outcomes */

/**
 * Legacy's own flash for a submitted order, keyed on the order's status: the rejected
 * sentence with every reason the risk engine returned, the filled sentence with the
 * side, units, symbol and fill price, and the pending sentence.
 */
export function orderOutcome(result) {
  const order = result?.order;
  if (!order) return { tone: "error", message: "The order was not recorded." };
  if (order.status === "REJECTED") {
    const reasons = Array.isArray(order.rejectReasons) && order.rejectReasons.length
      ? order.rejectReasons
      : [order.reject_reason || "rejected"];
    return { tone: "error", message: `Order REJECTED: ${reasons.join(" · ")}` };
  }
  if (result.filled) {
    return { tone: "ok", message: `Order FILLED: ${order.side} ${numberText(finite(order.units), 4)} ${order.symbol} @ ${priceText(order.fill_price)}` };
  }
  return { tone: "ok", message: "Limit order PENDING — run a tick to fill it." };
}

/** `Paper::close`'s sentence: the exit price and the net P&L. */
export function closeOutcome(payload) {
  return { tone: "ok", message: `Position closed @ ${priceText(payload?.position?.exit_price)} · P&L ${moneyText(payload?.netPnl)}` };
}

/** `Paper::create`'s sentence, and the account it made. */
export function accountOutcome(summary) {
  const id = summary?.account?.id;
  return { tone: "ok", message: `Paper account #${id ?? "?"} created.`, accountId: id ?? null };
}

/**
 * `Paper::tick`'s sentence: the counts, then one clause per strategy signal — what was
 * submitted, or why it was refused.
 */
export function tickOutcome(payload) {
  const actions = payload?.actions ?? {};
  const filled = (actions.filledOrders ?? []).length;
  const closed = (actions.closedPositions ?? []).length;
  const signals = actions.strategySignals ?? [];
  let message = `Tick: ${filled} order(s) filled · ${closed} position(s) closed · ${signals.length} strategy signal(s)`;
  for (const signal of signals) {
    if (signal.submitted) message += ` [${signal.symbol} ${signal.action} submitted]`;
    if (Array.isArray(signal.rejectReasons) && signal.rejectReasons.length) {
      message += ` [${signal.symbol} ${signal.action} rejected: ${signal.rejectReasons.join("; ")}]`;
    }
  }
  const skipped = (actions.skipped ?? []).length;
  if (skipped) message += ` · ${skipped} skipped`;
  return { tone: "ok", message };
}

/** The deployment actions' sentences. */
export function deployOutcome(deployment) {
  return { tone: "ok", message: `Strategy ${deployment?.strategy_id ?? "?"} deployed — signals execute on each tick (risk-checked).` };
}

export function toggleOutcome(deployment) {
  return {
    tone: "ok",
    message: `Deployment ${deployment?.id ?? "?"} ${deployment?.active ? "resumed" : "paused"}.`,
  };
}

/**
 * Every surface this screen reads, with the permission the server enforces on it. The
 * suite asserts each entry against `GET /api/v1/system/routes`, so a route that moves,
 * disappears or changes its guard fails here instead of rendering an error box.
 *
 * `tradingState` is the governance read behind the banners and the limits panel, and
 * `strategies` is the deploy form's list — session-only, exactly as the Strategy Lab's own
 * routes are (legacy's `Api_strategies` required a session and nothing else).
 */
export const PAPER_READS = Object.freeze([
  { key: "tradingState", method: "GET", path: "/api/v1/trading/mode", permission: PAPER_PERMISSION, section: "Banners and limits" },
  { key: "accounts", method: "GET", path: "/api/v1/paper/accounts", permission: PAPER_PERMISSION, section: "Accounts" },
  { key: "account", method: "GET", path: "/api/v1/paper/accounts/:accountId", permission: PAPER_PERMISSION, section: "Account console" },
  { key: "orders", method: "GET", path: "/api/v1/paper/accounts/:accountId/orders", permission: PAPER_PERMISSION, section: "Orders" },
  { key: "positions", method: "GET", path: "/api/v1/paper/accounts/:accountId/positions", permission: PAPER_PERMISSION, section: "Closed positions" },
  { key: "deployments", method: "GET", path: "/api/v1/paper/accounts/:accountId/deployments", permission: PAPER_PERMISSION, section: "Deployments" },
  { key: "strategies", method: "GET", path: "/api/v1/strategies", permission: null, section: "Deploy form" },
]);

/**
 * The mutations the screen offers, and the three governance writes it deliberately does
 * **not** (`carried: false`): trading mode, the kill switch and synthetic-paper prices are
 * `trading.control` acts that live on `/app/analysis`, which is where the port renders those
 * controls. The suite asserts that the view never calls the uncarried ones.
 */
export const PAPER_WRITES = Object.freeze([
  { key: "createAccount", method: "POST", path: "/api/v1/paper/accounts", permission: PAPER_EXECUTE, label: "Create account", legacy: "Paper::create → paper->createAccount()", carried: true },
  { key: "submitOrder", method: "POST", path: "/api/v1/paper/accounts/:accountId/orders", permission: PAPER_EXECUTE, label: "Submit paper order", legacy: "Paper::order → paper->submitOrder()", carried: true },
  { key: "closePosition", method: "POST", path: "/api/v1/paper/accounts/:accountId/positions/:positionId/close", permission: PAPER_EXECUTE, label: "Close position", legacy: "Paper::close → paper->closePosition()", carried: true },
  { key: "tick", method: "POST", path: "/api/v1/paper/accounts/:accountId/tick", permission: PAPER_EXECUTE, label: "Run market tick", legacy: "Paper::tick → paper->tick()", carried: true },
  { key: "deploy", method: "POST", path: "/api/v1/paper/accounts/:accountId/deployments", permission: PAPER_EXECUTE, label: "Deploy strategy", legacy: "Paper::deploy → paper->deployStrategy()", carried: true },
  { key: "toggleDeployment", method: "POST", path: "/api/v1/paper/accounts/:accountId/deployments/:deploymentId/toggle", permission: PAPER_EXECUTE, label: "Pause / resume", legacy: "Paper::toggle → paper->pauseDeployment()", carried: true },
  { key: "tradingMode", method: "POST", path: "/api/v1/trading/mode", permission: PAPER_CONTROL, label: "Trading mode", legacy: "Platform::setTradingMode()", carried: false },
  { key: "killSwitch", method: "POST", path: "/api/v1/trading/kill-switch", permission: PAPER_CONTROL, label: "Kill switch", legacy: "Platform::setKillSwitch()", carried: false },
  { key: "syntheticPaper", method: "POST", path: "/api/v1/trading/synthetic-paper", permission: PAPER_CONTROL, label: "Synthetic-paper prices", legacy: "Platform::setSyntheticPaperData()", carried: false },
]);

/* ------------------------------------------------------------------- forms */

/**
 * The vocabularies the order and deployment forms offer. Both are the server's own lists
 * (`src/modules/market-data/timeframes.js` → `MARKET_CLASSES`, `src/modules/strategies/contracts.js`
 * → `STRATEGY_TIMEFRAMES`); `test/client_paper_console.test.js` asserts them against those
 * modules rather than trusting these copies.
 */
export const PAPER_MARKET_CLASSES = Object.freeze([
  "forex", "crypto", "stock", "etf", "commodity", "futures", "options", "indices", "bonds",
]);
export const PAPER_TIMEFRAMES = Object.freeze(["15m", "1h", "4h", "1d"]);
export const ORDER_SIDES = Object.freeze(["BUY", "SELL"]);
export const ORDER_TYPES = Object.freeze(["MARKET", "LIMIT"]);

const SYMBOL_PATTERN = /^[A-Za-z0-9._-]{2,24}$/;
const STRATEGY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,20}$/;

function blank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

/**
 * `Paper::create`'s form, held to `ACCOUNT_CREATE_BODY`: a name of 1–60 characters and a
 * balance between 1 and 10,000,000. The legacy form bounded the balance at 100 with a
 * `min="100"` attribute while the engine accepted anything above zero; the port follows
 * the engine's contract, which is both implementations' rule, and the balance the form
 * starts at is legacy's 10000.
 */
export function validateAccountForm({ name, startingBalance } = {}) {
  const errors = {};
  const trimmed = String(name ?? "").trim();
  if (!trimmed) errors.name = "Name is required.";
  else if (trimmed.length > 60) errors.name = "Name must be 60 characters or fewer.";
  const balance = Number(startingBalance);
  if (blank(startingBalance)) errors.startingBalance = "Starting balance is required.";
  else if (!Number.isFinite(balance)) errors.startingBalance = "Starting balance must be a number.";
  else if (balance < 1 || balance > 10_000_000) errors.startingBalance = "Starting balance must be between 1 and 10,000,000.";
  return { ok: Object.keys(errors).length === 0, errors };
}

export function buildAccountBody({ name, startingBalance, currency = "USD" } = {}) {
  return { name: String(name ?? "").trim(), startingBalance: Number(startingBalance), currency: String(currency || "USD").toUpperCase() };
}

/**
 * `Paper::order`'s form, held to `ORDER_BODY`. Blank optional fields are **omitted** rather
 * than sent as nulls or empties, so the request carries exactly what the operator typed and
 * the server's defaults apply to the rest.
 *
 * `riskPct` is a **fraction** of equity on both sides of the port (`PaperTradingEngine`:
 * `$riskAmount = $summary['equity'] * $riskPct`, and the limits it caps against are
 * fractions too — `maxRiskPerTradePct` is 0.02). Legacy's form labelled the field `Risk %`
 * and bounded it `min="0.1" max="2"`, which would have read "1" as 100% of equity and been
 * capped to the 2% limit — a label bug, not a rule: both engines agree the value is a
 * fraction. The port labels it as the fraction it is, and says so in the field hint.
 */
export function validateOrderForm(form = {}) {
  const errors = {};
  const symbol = String(form.symbol ?? "").trim();
  if (!SYMBOL_PATTERN.test(symbol)) errors.symbol = "Symbol must be 2–24 characters (letters, digits, . _ -).";
  if (!ORDER_SIDES.includes(String(form.side))) errors.side = "Side must be BUY or SELL.";
  if (!ORDER_TYPES.includes(String(form.type))) errors.type = "Type must be MARKET or LIMIT.";
  if (String(form.type) === "LIMIT" && (blank(form.price) || !(Number(form.price) > 0))) {
    errors.price = "A limit order needs a positive limit price.";
  }
  if (blank(form.stopLoss) || !(Number(form.stopLoss) > 0)) errors.stopLoss = "Stops are mandatory: enter a positive stop loss.";
  if (!blank(form.takeProfit) && !(Number(form.takeProfit) > 0)) errors.takeProfit = "Take profit must be positive when supplied.";
  if (!blank(form.riskPct)) {
    const risk = Number(form.riskPct);
    if (!Number.isFinite(risk) || risk <= 0 || risk > 0.05) errors.riskPct = "Risk must be a fraction above 0 and at most 0.05 (5% of equity).";
  }
  if (!blank(form.confidence) && (!Number.isFinite(Number(form.confidence)) || Number(form.confidence) < 0 || Number(form.confidence) > 1)) {
    errors.confidence = "Confidence is a 0–1 number.";
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

export function buildOrderBody(form = {}) {
  const body = { symbol: String(form.symbol ?? "").trim().toUpperCase(), side: String(form.side), type: String(form.type || "MARKET") };
  if (!blank(form.price)) body.price = Number(form.price);
  if (!blank(form.stopLoss)) body.stopLoss = Number(form.stopLoss);
  if (!blank(form.takeProfit)) body.takeProfit = Number(form.takeProfit);
  if (!blank(form.riskPct)) body.riskPct = Number(form.riskPct);
  if (!blank(form.reason)) body.reason = String(form.reason).slice(0, 500);
  if (!blank(form.confidence)) body.confidence = Number(form.confidence);
  return body;
}

/** `Paper::deploy`'s form, held to `DEPLOYMENT_BODY`. */
export function validateDeployForm(form = {}) {
  const errors = {};
  if (!STRATEGY_PATTERN.test(String(form.strategyId ?? ""))) errors.strategyId = "Choose a strategy.";
  if (!blank(form.strategyVersion) && !VERSION_PATTERN.test(String(form.strategyVersion))) errors.strategyVersion = "Version must be 1–20 characters.";
  if (!SYMBOL_PATTERN.test(String(form.symbol ?? "").trim())) errors.symbol = "Symbol must be 2–24 characters (letters, digits, . _ -).";
  if (!PAPER_TIMEFRAMES.includes(String(form.timeframe))) errors.timeframe = "Choose a timeframe.";
  if (!PAPER_MARKET_CLASSES.includes(String(form.marketClass))) errors.marketClass = "Choose a market class.";
  return { ok: Object.keys(errors).length === 0, errors };
}

export function buildDeployBody(form = {}) {
  const body = {
    strategyId: String(form.strategyId ?? ""),
    symbol: String(form.symbol ?? "").trim().toUpperCase(),
    timeframe: String(form.timeframe ?? ""),
    marketClass: String(form.marketClass ?? ""),
  };
  if (!blank(form.strategyVersion)) body.strategyVersion = String(form.strategyVersion);
  return body;
}

/**
 * The deployable strategies from `GET /strategies`: legacy's list only offered strategies
 * whose lifecycle reached `RISK_REVIEWED` or beyond, because `Paper::deploy` refused the
 * rest. The option list is every strategy with its lifecycle named, and the ones the
 * server would refuse are marked rather than hidden — a hidden strategy cannot be told
 * apart from a missing one.
 */
export function deployOptions(payload) {
  const strategies = Array.isArray(payload?.strategies) ? payload.strategies : [];
  const deployable = new Set(["RISK_REVIEWED", "PAPER_TRADING", "LIVE_APPROVED"]);
  return strategies.map((entry) => {
    const latest = entry?.latest ?? {};
    return {
      key: entry?.strategyId ?? "",
      strategyId: entry?.strategyId ?? "",
      version: latest.version ?? null,
      lifecycle: latest.lifecycle ?? "UNKNOWN",
      name: latest.name ?? entry?.strategyId ?? "",
      deployable: deployable.has(String(latest.lifecycle)),
    };
  });
}

/* ------------------------------------------------------------------ selection */

/**
 * Which account the console is showing: the selected one when it still exists, otherwise
 * the first. Legacy's `/paper` board made the choice by navigating; this screen makes it
 * by state, and a deleted or foreign id must fall back rather than render an empty page.
 */
export function accountSelection(rows, selectedId = null) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { selected: null, rows: list };
  const wanted = selectedId === null || selectedId === undefined ? null : String(selectedId);
  const selected = list.find((row) => row.key === wanted) ?? list[0];
  return { selected, rows: list };
}

/** Whether the account console may be shown at all, and why not when it may not. */
export function accountGate({ selected, canExecute }) {
  if (!selected) return { show: false, reason: PAPER_COPY.accountsEmpty };
  if (!canExecute) {
    return { show: true, readOnly: true, reason: `Submitting orders, closing positions, running ticks and deploying strategies need ${PAPER_EXECUTE}, which this session does not hold. The tables and the summaries are readable under ${PAPER_PERMISSION}.` };
  }
  return { show: true, readOnly: false, reason: null };
}
