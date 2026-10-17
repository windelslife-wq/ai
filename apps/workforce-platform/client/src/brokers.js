/**
 * The Broker Center console (row 13, Phase 40).
 *
 * Legacy has one page over this module: `Brokers::index` → `views/brokers/index.php`. It drew
 * the routing banner, a simulated-bridge switch, one capability card per connector, the two
 * read-only MT5 panels and the PLANNED matrix. The port registers **one** route —
 * `GET /api/v1/brokers` — and this screen is that route rendered honestly, plus the panels the
 * port deliberately does not have.
 *
 * Four rules, the same ones every console in this shell follows:
 *
 *  1. **The screen states what it is reading, and the API decides it.** `routable`, every
 *     connector state, every capability flag and the PLANNED matrix all come from the one
 *     response. `notice` is the server's sentence and is shown as the server's.
 *  2. **The absences are the page's, not the reader's.** Two of legacy's panels cannot be drawn
 *     here: the simulated-bridge switch (the marker-file mock `DemoBridgeConfig` writes has no
 *     equivalent in this platform, and porting the switch without the bridge would advertise a
 *     capability that does not exist) and the MT5 account/quote reads (the port registers no
 *     such route, because a route that can only answer 503 on a host with no bridge is worse
 *     than no route — and legacy's were unauthenticated, F-32). Both are stated with legacy's
 *     own words before the reason.
 *  3. **Nothing is offered that the API would refuse.** Every control on this page is a read.
 *     There is no enable, no toggle and no order button, because there is no such route — and
 *     the screen says so rather than rendering disabled buttons that imply one exists.
 *  4. **Legacy's copy is legacy's.** Every heading, note, label, empty state and flash sentence
 *     is asserted against the PHP with `readFileSync`; the sentences this port adds live in
 *     `BROKERS_PORT_COPY`.
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
  routingSource: "Read from `GET /api/v1/brokers`: `routable` is the server's answer, not this page's inference.",
  simulatedAbsent: "This port has no simulated-bridge switch. Legacy's `Brokers::sim_toggle()` wrote a marker file its dev front controller turned into environment variables; this platform has no equivalent in-process mock, so the toggle is not ported — a switch that turns on nothing would advertise a capability that does not exist.",
  accountAbsent: "This port registers no MT5 account read. Legacy's `Api_system::mt5_account()` returned the broker login, currency, balance and equity with no permission check at all (F-32); the port answers with a single broker route that is gated, and a read that can only answer 503 on a host with no bridge is worse than no route.",
  quoteAbsent: "This port registers no MT5 quote read, for the same reason: `Api_system::mt5_quote()` was unauthenticated and can only answer 503 without a deployed bridge (F-32).",
  oneRouteOnly: "The Broker Center is one read and nothing else: no enable, no toggle, no order. Routing lives exclusively in the Execution Supervisor, and it stays unavailable until an adapter is verified against its provider.",
  states: "The four-state ladder is legacy's: DISABLED → NOT_CONFIGURED → DOWN → READY, with only READY carrying bridge-reported fields. `ERROR` is this port's fifth value: it means the adapter threw instead of answering, and it is never treated as READY.",
  capabilitiesNote: "`order submission` is the local intent flag. `orderSubmissionEffective` is the bridge-verified answer, and it is the only one the supervisor trusts — the two disagreeing is the normal state of a scaffolded adapter.",
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

/** The three routing banners, chosen from the API's `routable` and the MT5 adapter's own flag. */
export function routingBanner(payload) {
  const routable = payload?.routable === true;
  const simulated = payload?.brokers?.["mt5-bridge"]?.simulated === true;
  if (routable && simulated) {
    return { key: "simulated", tone: "ok", message: BROKERS_COPY.routingActiveSimulated };
  }
  if (routable) return { key: "active", tone: "ok", message: BROKERS_COPY.routingActive };
  return { key: "disabled", tone: "warn", message: BROKERS_COPY.routingDisabled };
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

/**
 * The MT5 panels' payloads. Neither has a route in this port, so both are `null` and the
 * screen renders legacy's sentences plus the reason — never an empty table that looks like a
 * successful read with no data.
 */
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

/** The simulated bridge's state, from the MT5 adapter's own `simulated` flag. */
export function simulationState(payload) {
  const mt5 = payload?.brokers?.["mt5-bridge"];
  return {
    enabled: mt5?.simulated === true,
    port: null,
    // The port has no marker file, so there is no port to show and no control to offer.
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
  { key: "tradingState", method: "GET", path: "/api/v1/trading/mode", permission: "trading.view", section: "Governance strip" },
]);

/**
 * Legacy's two panels and one switch that this port deliberately does not register, each with
 * the reason. The suite asserts every one of these paths is **absent** from the route
 * inventory — a docblock that says "not ported" while a route answers is the failure mode this
 * list exists to catch.
 */
export const LEGACY_ROUTES_NOT_PORTED = Object.freeze([
  Object.freeze({ key: "simToggle", legacy: "POST /brokers/sim-toggle → Brokers::sim_toggle()", route: "/api/v1/brokers/sim-toggle", why: "no in-process mock bridge exists in this platform" }),
  Object.freeze({ key: "mt5Account", legacy: "GET /api/system/mt5-account → Api_system::mt5_account()", route: "/api/v1/brokers/mt5/account", why: "unauthenticated in legacy (F-32); a read that can only answer 503 is worse than no route" }),
  Object.freeze({ key: "mt5Quote", legacy: "GET /api/system/mt5-quote → Api_system::mt5_quote()", route: "/api/v1/brokers/mt5/quote", why: "unauthenticated in legacy (F-32); same 503-without-a-bridge problem" }),
]);
