/**
 * The Broker Center console (row 13, Phase 40, extended with authenticated reads).
 *
 * Legacy has one page over this module: `Brokers::index` → `views/brokers/index.php`. The Node
 * port exposes broker status, authenticated MT5 account/quote reads and authenticated in-process
 * simulator account/quote reads. It does not expose a direct broker-order or toggle route; the
 * only order path is an approved proposal submitted through the separate simulator-only
 * Execution Supervisor route.
 *
 * Four rules, the same ones every console in this shell follows:
 *
 *  1. **The screen states what it is reading, and the API decides it.** Connector health and
 *     routing eligibility come from `GET /api/v1/brokers`; account and quote panels use the
 *     authenticated MT5 or simulator reads. The simulator's `memoryOnly` and order flags are
 *     displayed as supplied; they are not inferred from the real connector roster.
 *  2. **The demo bridge stays distinct from real connectors.** It is process-local, opt-in and
 *     unavailable after restart; its reads never make a real adapter routable. No toggle route
 *     or direct broker-order endpoint is exposed.
 *  3. **Nothing is offered that the API would refuse.** Every control on this page is a read.
 *     An order can only be submitted from an APPROVED proposal on the Execution Center, under
 *     `trading.execute`; it is not a direct Broker Center action.
 *  4. **Legacy's copy is legacy's.** Every legacy sentence remains asserted against PHP with
 *     `readFileSync`; the port-specific capability statements live in `BROKERS_PORT_COPY`.
 *
 * Every function here is pure: `views.jsx` binds them to reads, and
 * `test/client_broker_console.test.js` holds them to the legacy text and to the one route the
 * server registers.
 */

/** `GET /api/v1/brokers` requires `trading.view` — and so does this screen. */
export const BROKERS_PERMISSION = "trading.view";
/** `system.super_admin` short-circuits every permission check server-side. */
export const SUPER_ADMIN_PERMISSION = "system.super_admin";

const EM_DASH = "—";
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Whether the session holds a permission, mirroring `userHasPermission` on the server. */
export function holdsBrokersPermission(permissions, permission) {
  if (!permission) return true;
  const held = Array.isArray(permissions) ? permissions : [];
  return held.includes(permission) || held.includes(SUPER_ADMIN_PERMISSION);
}

/** A boolean rendered as legacy rendered it: `yes`/`no` or `true`/`false`. */
export function flagText(value, { trueText = "yes", falseText = "no" } = {}) {
  if (value === null || value === undefined) return EM_DASH;
  return value === true ? trueText : falseText;
}

/** A count with no formatting of its own; a gap is an em dash and a real zero stays `0`. */
export function countText(value) {
  const number = value === null || value === undefined || value === "" ? null : Number(value);
  return Number.isFinite(number) ? String(number) : EM_DASH;
}

/**
 * Money with two decimals and thousands separators — legacy's `number_format($v, 2)`.
 * A gap is an em dash, never a zero.
 */
export function moneyText(value) {
  const number = value === null || value === undefined || value === "" ? null : Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : EM_DASH;
}

/** A price at legacy's five decimals (`number_format($quote['bid'], 5)`); a gap is an em dash. */
export function priceText(value) {
  const number = value === null || value === undefined || value === "" ? null : Number(value);
  return Number.isFinite(number) ? number.toFixed(5) : EM_DASH;
}

/* ------------------------------------------------------------------------ the page's words */

/**
 * `views/brokers/index.php` and `Brokers`'s flash sentences, verbatim. The three routing
 * sentences are the view's `if/elseif/else` arms; `plain()` in the suite strips the `<b>` tags
 * around their lead-ins, so each is asserted whole.
 */
export const BROKERS_COPY = Object.freeze({
  eyebrow: "BROKERS · ROW 13",
  title: "Brokers",
  lede: "Connector health and capability. Untested integrations stay marked planned. MT5 routing needs an enabled bridge, tradingEnabled=true and a demo account unless live is explicitly allowed.",

  // The routing banner's three arms.
  routingActiveSimulated: "Order routing ACTIVE — SIMULATED BRIDGE. The connector is READY against the in-process mock (demo marker file). The Execution Supervisor can route approved proposals and receive simulated fills. No real broker is involved and no real order exists.",
  routingActive: "Order routing ACTIVE — a connector is READY with verified order submission. The Execution Supervisor may route approved proposals.",
  routingDisabled: "Order routing DISABLED — no connector is READY with verified order submission. Proposals can be evaluated and approved, but routing is audited as ROUTING_BLOCKED and no order is created.",

  simulatedTitle: "Simulated MT5 bridge",
  simulatedBadge: "DEMO · SIMULATION",
  simulationRunning: "SIMULATION RUNNING",
  stopSimulated: "Stop simulated bridge",
  startSimulated: "Start simulated bridge (demo)",
  simulatedBlocked: "This sandbox has no MetaTrader terminal and no bridge deployed, so routing is honestly blocked. To demo the full propose → approve → route → fill chain, start the in-process simulated bridge below — every fill is clearly labeled SIMULATION.",
  simulationEnabledFlash: "SIMULATED MT5 bridge enabled — it speaks the documented bridge contract with in-memory state. Everything it fills is SIMULATION. A real deployment still requires python-services/mt5-bridge on a MetaTrader host.",
  simulationDisabledFlash: "SIMULATED MT5 bridge disabled — routing is blocked again.",

  // The per-connector card's row labels, in the view's order.
  rowMessage: "message",
  rowConfigured: "configured",
  rowAccountRead: "account read",
  rowMarketData: "market data",
  rowOrderSubmission: "order submission",
  rowLiveTrading: "live trading",
  orderEnabled: "enabled",
  orderDisabled: "disabled",
  liveAllowed: "allowed",
  demoOnly: "demo only",

  accountTitle: "MT5 account (read-only)",
  accountEmpty: "No MT5 account available — deploy the authenticated bridge (python-services/mt5-bridge) and set AEGIS_MT5_BRIDGE_ENABLED=1, AEGIS_MT5_BRIDGE_URL and AEGIS_MT5_BRIDGE_TOKEN. This page can never place an order.",
  accountRows: Object.freeze(["account", "currency", "balance / equity", "free margin", "as of"]),

  quoteTitle: "MT5 quote (read-only)",
  quoteFetch: "fetch quote",
  quoteRows: Object.freeze(["symbol", "bid / ask", "spread", "timestamp"]),

  plannedTitle: "Not production-verified (PLANNED) — do not treat as working",
  plannedConnector: "Connector",
  plannedStatus: "Status",
  plannedNotes: "Notes",
});

/**
 * The sentences this port adds, kept separate from legacy's so the copy test can require every
 * string in `BROKERS_COPY` inside the PHP and every string here only in the client module.
 */
export const BROKERS_PORT_COPY = Object.freeze({
  routingSource: "Read from `GET /api/v1/brokers`: `routable` describes real connector health/capability; the isolated simulator is reported separately and never makes a real adapter routable.",
  simulatedSummary: "The optional MT5-shaped bridge is an in-process test double. `WF_SIMULATED_BROKER_ENABLED=1` enables reads; a separate `WF_SIMULATED_BROKER_ORDERS_ENABLED=1` is required before an approved proposal may submit. State is lost on restart.",
  toggleAbsent: "There is no runtime enable/toggle endpoint. The simulator is opt-in at process start so the UI cannot silently enable order writes.",
  accountAbsent: "Authenticated account reads are available at `/api/v1/brokers/mt5/account` and `/api/v1/brokers/simulation/account`; the latter is process-local demo state, not a funded or terminal account.",
  quoteAbsent: "Authenticated quote reads are available at `/api/v1/brokers/mt5/quote` and `/api/v1/brokers/simulation/quote`. Simulator quotes are synthetic and only used by the explicit simulation route.",
  oneRouteOnly: "Broker Center exposes read-only status/account/quote endpoints. No direct broker order route exists; only an approved Execution Supervisor proposal can reach the isolated simulator. Real provider-backed routing stays disabled and unverified.",
  states: "The four-state ladder is legacy's: DISABLED → NOT_CONFIGURED → DOWN → READY, with only READY carrying bridge-reported fields. `ERROR` is this port's fifth value: it means the adapter threw instead of answering, and it is never treated as READY.",
  capabilitiesNote: "`order submission` is the real connector's local intent flag. `orderSubmissionEffective` is its bridge-verified answer. The separate simulator's order flag never changes either value or the real connector routing answer.",
  realValidation: "No real MT5 terminal was contacted or verified in this repository-only change. Demo-terminal validation remains an external deployment task.",
});

/* ------------------------------------------------------------------------ the state ladder */

/**
 * Legacy's four states and its badge tones (`['READY' => 'b-green', 'DOWN' => 'b-red',
 * 'DISABLED' => 'b-gray', 'NOT_CONFIGURED' => 'b-amber']`), plus this port's `ERROR`.
 *
 * `ERROR` is not legacy's: `manager.allStatus()` catches a throwing adapter and answers
 * `state: "ERROR"`, so a screen that only knew four states would render it with the fallback
 * tone and say nothing about why. It is neutral here and its card carries the reason.
 */
export const CONNECTOR_STATES = Object.freeze({
  READY: Object.freeze({ tone: "badge-green", order: 0, note: "A bridge answered and the gates passed." }),
  DOWN: Object.freeze({ tone: "badge-red", order: 1, note: "Configured, but the adapter did not answer." }),
  ERROR: Object.freeze({ tone: "badge-gray", order: 2, note: "The adapter threw instead of answering. Not READY." }),
  NOT_CONFIGURED: Object.freeze({ tone: "badge-amber", order: 3, note: "Enabled without a URL or a token." }),
  DISABLED: Object.freeze({ tone: "badge-gray", order: 4, note: "Legacy's default for every adapter." }),
});

/** The badge class for a connector state; an unknown state is neutral, never green. */
export function stateTone(state) {
  return CONNECTOR_STATES[String(state)]?.tone ?? "badge-gray";
}

/** Separate real-connector readiness from the process-local simulator's configured flags. */
export function routingBanner(payload) {
  const routable = payload?.routable === true;
  const simulation = simulationState(payload);
  if (routable) {
    return { key: "real-connector-eligible", tone: "warn", message: "A real connector reports effective submission capability, but no real order endpoint is enabled by this port." };
  }
  if (simulation.enabled && simulation.ordersEnabled) {
    return { key: "simulator-ready", tone: "info", message: "Real broker routing is disabled. The isolated process-local simulator can accept only separately approved execution proposals; no live order exists." };
  }
  if (simulation.enabled) {
    return { key: "simulator-read-only", tone: "warn", message: "Real broker routing is disabled. The in-process simulator is available for reads, but simulator order submission is disabled." };
  }
  return { key: "disabled", tone: "warn", message: "Real broker routing is disabled. No verified provider-backed order route is available; the optional process-local simulator is disabled." };
}

/* ------------------------------------------------------------------------------ the cards */

/**
 * One entry per connector, in the API's order — legacy's registration order, because
 * `allStatus()` builds its object in roster order and a screen must not re-sort a safety list
 * into something that looks tidier. `capabilities` is attached by the manager, never by the
 * connector's own status, so an adapter that throws still gets a card with the reason.
 */
export function connectorRows(payload) {
  const brokers = isPlainObject(payload?.brokers) ? payload.brokers : {};
  return Object.entries(brokers).map(([id, status]) => {
    const entry = isPlainObject(status) ? status : {};
    const capabilities = isPlainObject(entry.capabilities) ? entry.capabilities : {};
    return {
      key: id,
      id,
      state: String(entry.state ?? "UNKNOWN"),
      tone: stateTone(entry.state),
      configured: entry.configured === true,
      message: String(entry.message ?? ""),
      simulated: entry.simulated === true,
      // Only READY carries these; a card must not print `undefined` for the other states.
      bridgeVersion: entry.bridgeVersion ?? null,
      bridgeTradingEnabled: entry.bridgeTradingEnabled ?? null,
      accountType: entry.accountType ?? null,
      orderSubmissionEffective: entry.orderSubmissionEffective ?? null,
      capabilities: {
        accountRead: capabilities.accountRead === true,
        marketData: capabilities.marketData === true,
        orderSubmission: capabilities.orderSubmission === true,
        liveTrading: capabilities.liveTrading === true,
        reason: typeof capabilities.reason === "string" ? capabilities.reason : null,
      },
      // Legacy rendered four capability rows and the bridge fields only when present.
      bridgeFields: [
        ["bridgeVersion", entry.bridgeVersion],
        ["bridgeTradingEnabled", entry.bridgeTradingEnabled],
        ["accountType", entry.accountType],
        ["orderSubmissionEffective", entry.orderSubmissionEffective],
      ].filter(([, value]) => value !== undefined && value !== null),
    };
  });
}

/** How many connectors are in each state — the page's one summary line, from the same rows. */
export function stateSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const tally = {};
  for (const row of list) tally[row.state] = (tally[row.state] ?? 0) + 1;
  return {
    total: list.length,
    ready: tally.READY ?? 0,
    configured: list.filter((row) => row.configured).length,
    tally,
  };
}

/** The PLANNED matrix, exactly as the server exports it. */
export function plannedRows(payload) {
  const planned = Array.isArray(payload?.planned) ? payload.planned : [];
  return planned.map((entry) => ({
    key: String(entry.id),
    name: String(entry.name ?? entry.id),
    status: String(entry.status ?? "PLANNED"),
    detail: String(entry.detail ?? ""),
  }));
}

/** Normalized account/quote payloads read from an authenticated MT5 or simulator endpoint. */
export function mt5Panels(payload) {
  return {
    account: isPlainObject(payload?.account) ? payload.account : null,
    quote: isPlainObject(payload?.quote) ? payload.quote : null,
    // The port's response carries neither key; this records that its absence is structural.
    accountAvailable: isPlainObject(payload?.account),
    quoteAvailable: isPlainObject(payload?.quote),
  };
}

/** Legacy's five account rows, from a normalized account — em dashes for anything absent. */
export function accountRows(account) {
  if (!isPlainObject(account)) return [];
  return [
    { key: "account", label: BROKERS_COPY.accountRows[0], value: String(account.accountId ?? EM_DASH) },
    { key: "currency", label: BROKERS_COPY.accountRows[1], value: String(account.currency ?? EM_DASH) },
    { key: "balance", label: BROKERS_COPY.accountRows[2], value: `${moneyText(account.balance)} / ${moneyText(account.equity)}` },
    { key: "freeMargin", label: BROKERS_COPY.accountRows[3], value: moneyText(account.freeMargin) },
    { key: "timestamp", label: BROKERS_COPY.accountRows[4], value: String(account.timestamp ?? EM_DASH) },
  ];
}

/** Legacy's four quote rows, from a normalized quote — five decimals on the prices. */
export function quoteRows(quote) {
  if (!isPlainObject(quote)) return [];
  return [
    { key: "symbol", label: BROKERS_COPY.quoteRows[0], value: String(quote.symbol ?? EM_DASH) },
    { key: "bidAsk", label: BROKERS_COPY.quoteRows[1], value: `${priceText(quote.bid)} / ${priceText(quote.ask)}` },
    { key: "spread", label: BROKERS_COPY.quoteRows[2], value: priceText(quote.spread) },
    { key: "timestamp", label: BROKERS_COPY.quoteRows[3], value: String(quote.timestamp ?? EM_DASH) },
  ];
}

/** The separate in-process simulator status block returned by `GET /api/v1/brokers`. */
export function simulationState(payload) {
  const state = isPlainObject(payload?.simulation) ? payload.simulation : {};
  return {
    enabled: state.enabled === true,
    ordersEnabled: state.ordersEnabled === true,
    memoryOnly: state.memoryOnly === true,
    liveTradingEnabled: state.liveTradingEnabled === true,
    state: String(state.state ?? "DISABLED"),
    message: String(state.message ?? ""),
    toggleAvailable: false,
  };
}

/* ------------------------------------------------------------------------------ the facts */

/** The governance sentence the strip shows, read from `GET /trading/mode`. */
export function governanceFacts(state) {
  if (!state || typeof state !== "object") return null;
  const killSwitch = state.killSwitch && typeof state.killSwitch === "object" ? state.killSwitch : {};
  return {
    mode: state.tradingMode ?? "UNKNOWN",
    executionMode: state.executionMode ?? "HUMAN_APPROVAL",
    killSwitch: killSwitch.active === true,
    synthetic: state.allowSyntheticPaperData === true,
    simulated: state.simulationOnly === true,
  };
}

/* ------------------------------------------------------------------------------ the reads */

/**
 * The one surface this console reads, with the permission the server enforces. The suite
 * asserts it against `GET /api/v1/system/routes`, so a route that moves or changes its guard
 * fails there instead of rendering an error box.
 */
export const BROKERS_READS = Object.freeze([
  { key: "brokers", method: "GET", path: "/api/v1/brokers", permission: BROKERS_PERMISSION, section: "Connector matrix" },
  { key: "mt5Account", method: "GET", path: "/api/v1/brokers/mt5/account", permission: BROKERS_PERMISSION, section: "MT5 account" },
  { key: "mt5Quote", method: "GET", path: "/api/v1/brokers/mt5/quote", permission: BROKERS_PERMISSION, section: "MT5 quote" },
  { key: "simulationAccount", method: "GET", path: "/api/v1/brokers/simulation/account", permission: BROKERS_PERMISSION, section: "Simulator account" },
  { key: "simulationQuote", method: "GET", path: "/api/v1/brokers/simulation/quote", permission: BROKERS_PERMISSION, section: "Simulator quote" },
  { key: "tradingState", method: "GET", path: "/api/v1/trading/mode", permission: BROKERS_PERMISSION, section: "Governance strip" },
]);

/** The legacy runtime toggle remains absent; the simulator is enabled only at process start. */
export const LEGACY_ROUTES_NOT_PORTED = Object.freeze([
  Object.freeze({ key: "simToggle", legacy: "POST /brokers/sim-toggle → Brokers::sim_toggle()", route: "/api/v1/brokers/sim-toggle", why: "runtime toggling is deliberately omitted; opt-in configuration is read at process start" }),
]);
