/**
 * The Execution Center console (row 2, Phase 39, extended with the simulation-only route).
 *
 * Legacy has one page over this module: `Execution::index` → `views/execution/index.php`,
 * drawn over `Aegis\ExecutionSupervisor`'s fifteen-step pipeline. The port is
 * `/app/execution`: human-approved proposals can submit to Paper Trading or the separately
 * gated, in-process simulated MT5 bridge. The full 15 checks run for that simulator route;
 * no live connector is routed. SEMI_AUTONOMOUS and FULLY_AUTOMATED remain request-based
 * Paper Trading modes.
 *
 * Four rules, the same ones every console in this shell follows:
 *
 *  1. **The screen states what it is reading, and the API decides it.** The proposal list is
 *     `GET /execution/proposals` (owner-scoped), the governance strip is `GET /trading/mode`,
 *     and the module's own scope is `GET /execution/status`. Nothing on the page is computed
 *     from a figure the server did not send.
 *  2. **The port's scope is stated, not papered over.** `brokerConnectorAvailable` remains
 *     false because no real adapter is verified. The distinct simulator route rechecks all
 *     fifteen supervisor steps through the process-local demo bridge after human approval.
 *     Automated modes are supported only as request-based Paper Trading submissions, never
 *     as unattended strategy loops or simulated-broker routing.
 *  3. **Nothing is offered that the API would refuse.** Proposing needs `trading.execute`;
 *     the decision needs `trading.control` **and** a written reason of 10–1000 characters;
 *     submitting to Paper Trading or the simulator needs `trading.execute` and an APPROVED
 *     proposal; the simulator also requires enabled process-local bridge/order flags and
 *     current governance. A session without permission never sees an actionable control.
 *  4. **Legacy's copy is legacy's.** Every heading, note, label, empty state and flash
 *     sentence is asserted against `views/execution/index.php` and `controllers/Execution.php`
 *     with `readFileSync`. Where this port departs, the departure is named in the suite: the
 *     account selector, the missing volume field, the decision reason, and the paper-submit
 *     outcome that replaces legacy's "broker order created".
 *
 * Every function here is pure: `views.jsx` binds them to reads, and
 * `test/client_execution_console.test.js` holds them to the legacy text and to the routes
 * the server actually registers.
 */

/** Legacy `Execution::base()` ran under `App_Controller`; every execution read is `trading.view`. */
export const EXECUTION_PERMISSION = "trading.view";
/** `POST /execution/proposals` and `…/paper-submit`: `trading.execute`. */
export const EXECUTION_EXECUTE = "trading.execute";
/** `…/decision`: `trading.control` — approval is a governance action in the port, not the proposer's. */
export const EXECUTION_CONTROL = "trading.control";
/** `system.super_admin` short-circuits every permission check server-side. */
export const SUPER_ADMIN_PERMISSION = "system.super_admin";

const EM_DASH = "—";
const finite = (value) => (value === null || value === undefined || value === "" ? null : Number(value));
const isFiniteNumber = (value) => Number.isFinite(value);
const blank = (value) => value === null || value === undefined || String(value).trim() === "";

/** Whether the session holds a permission, mirroring `userHasPermission` on the server. */
export function holdsExecutionPermission(permissions, permission) {
  if (!permission) return true;
  const held = Array.isArray(permissions) ? permissions : [];
  return held.includes(permission) || held.includes(SUPER_ADMIN_PERMISSION);
}

/** Money with two decimals and thousands separators; a gap is an em dash. */
export function moneyText(value) {
  const number = finite(value);
  return isFiniteNumber(number)
    ? number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : EM_DASH;
}

/** A fraction as a percentage (`0.01` → `1.00%`); a gap is an em dash. */
export function percentText(value, digits = 2) {
  const number = finite(value);
  if (!isFiniteNumber(number)) return EM_DASH;
  return `${(number * 100).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

/** A plain count; a gap is an em dash and a real zero stays `0`. */
export function countText(value) {
  const number = finite(value);
  return isFiniteNumber(number) ? String(number) : EM_DASH;
}

/**
 * Legacy rendered `substr($pr['created_at'], 5, 11)` — `MM-DD HH:MM` of a MySQL datetime.
 * The port stores canonical ISO-8601 (`…Z`), so the same five-to-sixteen slice of the
 * normalised string is `MM-DD HH:MM` for both.
 */
export function executionTimeText(value) {
  const text = String(value ?? "");
  if (!text) return EM_DASH;
  const normalized = text.replace("T", " ");
  return normalized.length >= 16 ? normalized.slice(5, 16) : normalized;
}

/* ------------------------------------------------------------------------ the page's words */

/**
 * `views/execution/index.php` and `Execution`'s flash sentences, verbatim — with one key
 * exception per group, named here because the suite asserts it as a departure:
 *
 *  - `route` ("route order") is legacy's button. The port's action after approval is
 *    `submitPaper` ("Submit to paper"), because the only place an approved proposal can go
 *    in this port is the paper ledger. The legacy label stays in this object as vocabulary
 *    — the screen never renders it as a control.
 *  - the port's own sentences live in `EXECUTION_PORT_COPY` below, so no reader has to guess
 *    which strings are legacy's.
 */
export const EXECUTION_COPY = Object.freeze({
  eyebrow: "EXECUTION · ROW 2",
  title: "Execution",
  lede: "Every broker-bound intent runs the 15-step supervisor. Only a connector with verified order submission can route an order.",

  killSwitchTitle: "Kill switch ACTIVE",
  killSwitchNote: "every proposal is rejected at step 1 and no order can be routed.",
  modeBlockedPrefix: "Trading mode is ",
  modeBlockedSuffix: " — broker execution requires HUMAN_APPROVAL, SEMI_AUTONOMOUS or FULLY_AUTOMATED (switch modes on the Dashboard).",

  proposeTitle: "Propose a trade (steps 1–11, persisted)",
  proposeSubmit: "Run pipeline & create proposal",
  proposeNote: "Strategies must be APPROVED before they can execute; discretionary intents are HUMAN_APPROVAL only.",

  envelopeTitle: "Automation envelope (SEMI_AUTONOMOUS / FULLY_AUTOMATED)",
  envelopeNotional: "Max trade notional (USD)",
  envelopeDaily: "Max daily automated trades",
  envelopeRisk: "Max risk per trade (%)",
  envelopeSymbols: "Approved symbols (comma-separated)",
  envelopeSubmit: "Update automation limits",

  proposalsTitle: "Proposals (",
  noProposals: "No proposals yet.",
  colCreated: "Created",
  colSymbol: "Symbol",
  colIntent: "Intent",
  colBroker: "Broker",
  colPipelineStatus: "Status",
  colPipeline: "Pipeline (15 steps)",
  colActions: "Actions",
  checksSuffix: " checks",
  approve: "approve",
  reject: "reject",
  route: "route order",

  executionsTitle: "Broker executions",
  noExecutions: "No orders routed yet. Without a configured, order-capable bridge every routing attempt is audited as ROUTING_BLOCKED and no order exists.",
});

/**
 * The sentences this port adds, kept separate from legacy's so the copy test can require
 * every string in `EXECUTION_COPY` in the PHP and every string here in the client module —
 * a legacy sentence may not quietly become the port's own claim.
 */
export const EXECUTION_PORT_COPY = Object.freeze({
  pageLede: "Human-reviewed, owner-scoped proposals can go to Paper Trading or the explicitly enabled process-local simulated MT5 bridge. No real broker or live-money route is available.",
  paperOnlyTitle: "Simulation-only execution",
  paperOnly: "Paper Trading and the separately gated simulated MT5 bridge are available for approved proposals. The 15-step supervisor runs against the process-local simulator; no real provider-verified broker is routable.",
  accountLabel: "Paper account",
  accountNote: "Proposals remain owner- and account-scoped. The paper account owns approval and audit history; simulated MT5 positions live in a separate process-local demo account.",
  volumeNote: "The intent has no volume field — the Risk Engine sizes from simulator equity, the stop distance and risk fraction, then the broker simulator independently checks margin and risk.",
  riskLabel: "Risk fraction (0.000001–0.05, optional)",
  decisionReason: "A decision needs a written reason of 10–1000 characters. The server stores it in the audit trail.",
  submitPaper: "Submit to paper",
  submitSimulator: "Submit to simulated MT5",
  submitNote: "Paper submission re-runs the Paper Trading Risk Engine. Simulator submission is a different route: it requires an approved proposal, PAPER_TRADING + HUMAN_APPROVAL, enabled simulator/order flags, current quote/session, duplicate, margin and risk checks. Both are simulation-only.",
  simulatorNote: "Simulator tickets and positions are process-local and reset when the application restarts. This is not MT5 terminal or live-broker verification.",
  pipelineTitle: "The complete fifteen-step supervisor (simulator only)",
  pipelineNote: "The simulator route rechecks steps 1–10 against current governance and demo-broker state, verifies the persisted human decision at step 11, then places, confirms, audits and snapshots the simulated order in steps 12–15. No real broker connector is used.",
  envelopeTitle: "Persisted automation envelope",
  envelopeNote: "Automation limits are stored in trading governance and can be reviewed or updated here. SEMI_AUTONOMOUS and FULLY_AUTOMATED are request-based Paper Trading submissions, not unattended strategy loops and not simulator routing.",
  modeEnum: "The execution mode is HUMAN_APPROVAL by default. SEMI_AUTONOMOUS and FULLY_AUTOMATED require PAPER_TRADING, released kill switch, configured limits and approved symbols/strategy; each still needs an explicit request and remains simulation-only.",
  executionsAbsent: "This port has no separate broker-executions feed. Successful simulator orders appear on the proposal with a SIMULATOR_EXECUTED or SIMULATOR_PENDING status and a confirmed simulated ticket; real broker executions remain unavailable.",
  realBrokerAbsent: "Real broker connectors remain disabled/unverified by default. Simulator order submission never makes a real connector routable; live trading remains disabled.",
  statusVocabulary: "Alongside proposal and Paper Trading states, the simulator path records SIMULATOR_SUBMITTING · SIMULATOR_EXECUTED · SIMULATOR_PENDING · SIMULATOR_FAILED. Its ticket is stored in the simulation-only result, not in the Paper Trading order column.",
  decisionOutcome: "The decision is recorded under `trading.control` and audited as `execution.proposal.approved` or `execution.proposal.declined`.",
  expiredNotice: "A PENDING_APPROVAL proposal older than the expiry window is expired by the read that finds it — the port's own sweep, not a hidden write.",
});

/* ---------------------------------------------------------------------------- the pipeline */

/**
 * `ExecutionSupervisor`'s fifteen steps, in its own order (`ExecutionSupervisor.php`'s
 * docblock). `stage` says who performs a step in **this port**:
 *
 *  - `port` — the paper-only supervisor runs it (`kill-switch`, `trading-mode`, `strategy`)
 *    or records it (`audit-log`).
 *  - `decision` — the separate `trading.control` call (`human-approval`).
 *  - `simulator` — runs against the explicitly enabled, process-local demo bridge; it is not
 *    a real connector or terminal verification.
 *
 * The suite compares the labels and order against the PHP docblock, so a step cannot be
 * added, dropped or renamed on the screen without the legacy file saying so.
 */
export const EXECUTION_PIPELINE = Object.freeze([
  Object.freeze({ step: 1, key: "kill-switch", label: "kill switch", stage: "port" }),
  Object.freeze({ step: 2, key: "trading-mode", label: "trading mode", stage: "port" }),
  Object.freeze({ step: 3, key: "strategy", label: "strategy", stage: "port" }),
  Object.freeze({ step: 4, key: "broker-connection", label: "broker connection", stage: "simulator" }),
  Object.freeze({ step: 5, key: "market-open", label: "market open", stage: "simulator" }),
  Object.freeze({ step: 6, key: "data-freshness", label: "data freshness", stage: "simulator" }),
  Object.freeze({ step: 7, key: "duplicate-orders", label: "duplicate orders", stage: "simulator" }),
  Object.freeze({ step: 8, key: "symbol-permissions", label: "symbol permissions", stage: "simulator" }),
  Object.freeze({ step: 9, key: "margin", label: "margin", stage: "simulator" }),
  Object.freeze({ step: 10, key: "risk-engine", label: "risk engine (+automation limits)", stage: "simulator" }),
  Object.freeze({ step: 11, key: "human-approval", label: "human approval", stage: "decision" }),
  Object.freeze({ step: 12, key: "place-order", label: "place order", stage: "simulator" }),
  Object.freeze({ step: 13, key: "confirm-execution", label: "confirm execution", stage: "simulator" }),
  Object.freeze({ step: 14, key: "audit-log", label: "audit log", stage: "port" }),
  Object.freeze({ step: 15, key: "portfolio-update", label: "portfolio update", stage: "simulator" }),
]);

/** The checks `propose()` actually writes into a proposal — steps 1–3, in its own order. */
export const PORT_CHECKS = Object.freeze(["kill-switch", "trading-mode", "strategy"]);

/** The three stages, with the badge and sentence the pipeline panel renders. */
export const PIPELINE_STAGES = Object.freeze({
  port: Object.freeze({ label: "this port", tone: "badge-green", note: "runs on create or records the transition" }),
  decision: Object.freeze({ label: "human decision", tone: "badge-amber", note: "separate `trading.control` call" }),
  simulator: Object.freeze({ label: "process-local simulator", tone: "badge-sky", note: "simulation-only; no real provider or terminal" }),
});

/* ---------------------------------------------------------------------------- the vocabulary */

/** Legacy's proposal statuses, from `ExecutionSupervisor::save()` and `views/execution/index.php`. */
export const LEGACY_PROPOSAL_STATUSES = Object.freeze([
  "PENDING_APPROVAL", "APPROVED", "EXECUTED", "REJECTED", "FAILED", "READY_TO_ROUTE",
]);

/**
 * The statuses this port can persist — `PROPOSALS_QUERY`'s enum in
 * `src/modules/execution/contracts.js`, asserted against it in the suite. Legacy's generic
 * `READY_TO_ROUTE`/`EXECUTED`/`FAILED` are not used; paper and simulator submissions each
 * have explicit, distinct outcome states.
 */
export const PORT_PROPOSAL_STATUSES = Object.freeze([
  "REJECTED", "PENDING_APPROVAL", "APPROVED", "DECLINED", "EXPIRED",
  "PAPER_SUBMITTING", "PAPER_EXECUTED", "PAPER_PENDING", "PAPER_REJECTED", "PAPER_FAILED",
  "SIMULATOR_SUBMITTING", "SIMULATOR_EXECUTED", "SIMULATOR_PENDING", "SIMULATOR_FAILED",
]);

/** The badge tones legacy's view chose, extended over this port's vocabulary. */
const STATUS_TONES = Object.freeze({
  PENDING_APPROVAL: "badge-amber",
  APPROVED: "badge-sky",
  READY_TO_ROUTE: "badge-sky",
  PAPER_SUBMITTING: "badge-sky",
  PAPER_PENDING: "badge-sky",
  SIMULATOR_SUBMITTING: "badge-sky",
  SIMULATOR_PENDING: "badge-sky",
  EXECUTED: "badge-green",
  PAPER_EXECUTED: "badge-green",
  SIMULATOR_EXECUTED: "badge-green",
  REJECTED: "badge-red",
  DECLINED: "badge-red",
  FAILED: "badge-red",
  PAPER_REJECTED: "badge-red",
  PAPER_FAILED: "badge-red",
  SIMULATOR_FAILED: "badge-red",
  EXPIRED: "badge-gray",
});

/** The badge class for a status, legacy's mapping extended; an unknown status is neutral. */
export function statusTone(status) {
  return STATUS_TONES[String(status)] ?? "badge-gray";
}

/* --------------------------------------------------------------------------- the market classes */

/**
 * `PROPOSAL_BODY.marketClass`'s accepted values (`MARKET_CLASSES` in
 * `src/modules/market-data/timeframes.js`), asserted against the server's list in the suite.
 *
 * Legacy's form offered `forex, crypto, stock, etf, commodity, future, index, bond` — three
 * singular spellings the port's contract does not accept. The form must use the port's
 * vocabulary or every proposal in those classes would 400, so the departure is stated here
 * rather than discovered by an operator.
 */
export const EXECUTION_MARKET_CLASSES = Object.freeze([
  "forex", "crypto", "stock", "etf", "commodity", "futures", "options", "indices", "bonds",
]);

/** Legacy's eight option labels, kept for the boundary panel's comparison. */
export const LEGACY_MARKET_CLASSES = Object.freeze([
  "forex", "crypto", "stock", "etf", "commodity", "future", "index", "bond",
]);

export const ORDER_SIDES = Object.freeze(["BUY", "SELL"]);
export const ORDER_TYPES = Object.freeze(["MARKET", "LIMIT"]);

/* ------------------------------------------------------------------------------- the windows */

/**
 * Legacy read `proposals(null, 40)` and `executions(20)`. The proposal window is the one the
 * port has a route for; it is also the contract's default ceiling below its 500 cap.
 */
export const EXECUTION_WINDOWS = Object.freeze({ proposals: 40, executions: 20 });

/* ------------------------------------------------------------------------------- the form */

const SYMBOL_PATTERN = /^[A-Za-z0-9._-]{2,24}$/;
const STRATEGY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,59}$/i;
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,20}$/;

/**
 * The form starts on nothing but the account the API listed: legacy pre-filled its stop and
 * target from a live quote when one was reachable and from the constants 1.0750 / 1.0900
 * when it was not. The port has no broker quote, so a pre-filled stop would be a price
 * suggestion this platform cannot price. The legacy fallbacks render as placeholders only.
 */
export const LEGACY_PRICE_FALLBACKS = Object.freeze({ stopLoss: "1.0750", takeProfit: "1.0900" });

export function proposalFormState(accounts = []) {
  const first = Array.isArray(accounts) && accounts.length > 0 ? accounts[0] : null;
  const accountId = first?.account?.id ?? first?.id ?? "";
  return {
    accountId: accountId === "" ? "" : String(accountId),
    symbol: "EURUSD",
    marketClass: "forex",
    side: "BUY",
    type: "MARKET",
    price: "",
    stopLoss: "",
    takeProfit: "",
    riskPct: "",
    strategyId: "",
    strategyVersion: "",
    reason: "",
  };
}

/**
 * The form validated against `PROPOSAL_BODY`, in the operator's own units.
 *
 * `price` is required for LIMIT and optional for MARKET, exactly as `normalizeIntent` reads
 * it; `strategyId` and `strategyVersion` are supplied together or not at all, which is the
 * contract's `STRATEGY_VERSION_REQUIRED` rule expressed before the request.
 */
export function validateProposalForm(form = {}) {
  const errors = {};
  const accountId = Number(form.accountId);
  if (blank(form.accountId) || !Number.isSafeInteger(accountId) || accountId <= 0) {
    errors.accountId = "Choose a paper account.";
  }
  const symbol = String(form.symbol ?? "").trim();
  if (!SYMBOL_PATTERN.test(symbol)) errors.symbol = "Symbol must be 2–24 characters (letters, digits, . _ -).";
  if (!EXECUTION_MARKET_CLASSES.includes(String(form.marketClass))) errors.marketClass = "Choose a market class.";
  if (!ORDER_SIDES.includes(String(form.side))) errors.side = "Side must be BUY or SELL.";
  if (!ORDER_TYPES.includes(String(form.type))) errors.type = "Type must be MARKET or LIMIT.";
  const type = String(form.type ?? "MARKET");
  if (type === "LIMIT" && (blank(form.price) || !(Number(form.price) > 0))) {
    errors.price = "A limit proposal needs a positive price.";
  }
  if (type === "MARKET" && !blank(form.price) && !(Number(form.price) > 0)) {
    errors.price = "Price must be positive when supplied.";
  }
  if (blank(form.stopLoss) || !(Number(form.stopLoss) > 0)) {
    errors.stopLoss = "Stops are mandatory: enter a positive stop loss.";
  }
  if (!blank(form.takeProfit) && !(Number(form.takeProfit) > 0)) {
    errors.takeProfit = "Take profit must be positive when supplied.";
  }
  if (!blank(form.riskPct)) {
    const risk = Number(form.riskPct);
    if (!Number.isFinite(risk) || risk < 0.000001 || risk > 0.05) {
      errors.riskPct = "Risk is a fraction between 0.000001 and 0.05 (the Risk Engine's cap).";
    }
  }
  const strategyId = blank(form.strategyId) ? "" : String(form.strategyId).trim();
  const strategyVersion = blank(form.strategyVersion) ? "" : String(form.strategyVersion).trim();
  if (strategyId && !STRATEGY_PATTERN.test(strategyId)) errors.strategyId = "Strategy id is invalid.";
  if (strategyVersion && !VERSION_PATTERN.test(strategyVersion)) errors.strategyVersion = "Version must be 1–20 characters.";
  if (Boolean(strategyId) !== Boolean(strategyVersion)) {
    errors.strategyVersion = "Strategy id and version must be supplied together.";
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * The request body, shaped to `PROPOSAL_BODY`: blank optionals are omitted, `symbol` is
 * upper-cased the way `normalizeIntent` would, and **there is no `volume` key** — the
 * contract has none, and `additionalProperties: false` would answer `UNKNOWN_PROPERTY`.
 * The suite asserts every key emitted here exists in the contract's properties.
 */
export function buildProposalBody(form = {}) {
  const body = {
    accountId: Number(form.accountId),
    symbol: String(form.symbol ?? "").trim().toUpperCase(),
    marketClass: String(form.marketClass ?? "").trim().toLowerCase(),
    side: String(form.side ?? "").toUpperCase(),
    type: String(form.type || "MARKET").toUpperCase(),
    stopLoss: Number(form.stopLoss),
  };
  if (!blank(form.price)) body.price = Number(form.price);
  if (!blank(form.takeProfit)) body.takeProfit = Number(form.takeProfit);
  if (!blank(form.riskPct)) body.riskPct = Number(form.riskPct);
  if (!blank(form.reason)) body.reason = String(form.reason).trim().slice(0, 500);
  if (!blank(form.strategyId)) body.strategyId = String(form.strategyId).trim().toLowerCase();
  if (!blank(form.strategyVersion)) body.strategyVersion = String(form.strategyVersion).trim();
  return body;
}

/**
 * `DECISION_BODY`: `approve` plus a reason of 10–1000 characters. Legacy's `decide()` took a
 * bare `approve=1|0`; the port requires the sentence, and the form says so before the 400.
 */
export function validateDecision(reason) {
  const text = String(reason ?? "").trim().replace(/\s+/g, " ");
  if (text.length < 10) return { ok: false, error: "A decision needs a written reason of at least 10 characters." };
  if (text.length > 1_000) return { ok: false, error: "The reason must be at most 1000 characters." };
  return { ok: true, error: null };
}

export function buildDecisionBody(approve, reason) {
  return { approve: Boolean(approve), reason: String(reason ?? "").trim().replace(/\s+/g, " ") };
}

/* --------------------------------------------------------------------------- the outcomes */

/**
 * The flash after a proposal attempt.
 *
 * Legacy's controller built `REJECTED at step N (check): reason` from the pipeline's last
 * check, and `STATUS: reason (proposal id)` otherwise. The port's `proposalView` carries no
 * `reason` field, so the accepted sentence states the status and the id and stops there — a
 * shape change named in the suite rather than a value invented to fit the old template.
 */
export function proposalOutcome(proposal) {
  if (!proposal || typeof proposal !== "object") {
    return { tone: "error", message: "The proposal response was empty." };
  }
  const checks = Array.isArray(proposal.checks) ? proposal.checks : [];
  const failed = checks.find((check) => check && check.ok === false) ?? null;
  if (String(proposal.status) === "REJECTED" && failed) {
    return {
      tone: "error",
      message: `REJECTED at step ${failed.step ?? EM_DASH} (${failed.check ?? "check"}): ${failed.detail ?? "no detail"}`,
    };
  }
  return {
    tone: "ok",
    message: `${proposal.status ?? "UNKNOWN"} — proposal ${proposal.id ?? EM_DASH} awaits a person.`,
  };
}

/** The flash after a decision: legacy's two sentences, with the reason named as required. */
export function decisionOutcome(proposal, approve) {
  const status = String(proposal?.status ?? (approve ? "APPROVED" : "DECLINED"));
  if (approve) {
    return { tone: "ok", message: `${status} — ${EXECUTION_PORT_COPY.submitNote}` };
  }
  return { tone: "ok", message: `${status} — the proposal cannot be submitted.` };
}

/**
 * The flash after a paper submission.
 *
 * Legacy's route answered `EXECUTED — broker order created (proposal …)` or
 * `STATUS: reason — no order was created.` The port creates a **paper** order or none, and
 * says which: a 201/202 returns `paper.order`, a blocked 409 returns an error code. The
 * message must never borrow the word "broker".
 */
export function paperSubmitOutcome(result) {
  const proposal = result?.proposal ?? null;
  const paper = result?.paper ?? null;
  const order = paper?.order ?? null;
  const id = proposal?.id ?? EM_DASH;
  if (proposal && order && (paper.filled === true || String(proposal.status).startsWith("PAPER_"))) {
    const verb = paper.filled === true ? `paper order #${order.id} filled` : `paper order #${order.id ?? EM_DASH} pending`;
    return { tone: "ok", message: `${proposal.status} — ${verb} (proposal ${id}).` };
  }
  return { tone: "ok", message: `${proposal?.status ?? "SUBMITTED"} — no paper order was created (proposal ${id}).` };
}

/** The separately gated, process-local simulator outcome — never described as a real fill. */
export function simulatorSubmitOutcome(result) {
  const proposal = result?.proposal ?? null;
  const execution = result?.execution ?? null;
  const id = proposal?.id ?? EM_DASH;
  const ticket = execution?.ticket ?? EM_DASH;
  if (proposal && execution?.confirmed === true && execution?.simulationOnly === true) {
    const verb = proposal.status === "SIMULATOR_PENDING" ? "pending order accepted" : "simulated order confirmed";
    return { tone: "ok", message: `${proposal.status} — ${verb}, ticket #${ticket} (process-local simulator; proposal ${id}).` };
  }
  return { tone: "error", message: `${proposal?.status ?? "SIMULATOR_SUBMISSION_FAILED"} — no confirmed simulated order (proposal ${id}).` };
}

/* --------------------------------------------------------------------------- the proposals */

/**
 * One table row per stored proposal, in the order the API returned them (the repository
 * lists newest first, which is legacy's `created_at DESC`).
 *
 * The intent line is the port's, because the intent is: `BUY MARKET · risk 1.00%`. Legacy's
 * line carried a volume (`BUY MARKET 1000`); the port has no volume to carry, and printing
 * legacy's `volume` field from an object that has none would render a fabricated `—`.
 */
export function proposalRows(payload) {
  const proposals = Array.isArray(payload?.proposals) ? payload.proposals : [];
  return proposals.map(proposalRow);
}

export function proposalRow(proposal) {
  if (!proposal || typeof proposal !== "object") return null;
  const intent = proposal.intent && typeof proposal.intent === "object" ? proposal.intent : {};
  const resultChecks = Array.isArray(proposal.result?.checks) && proposal.result.checks.length ? proposal.result.checks : null;
  const rawChecks = resultChecks ?? (Array.isArray(proposal.checks) ? proposal.checks : []);
  const checks = rawChecks.map((check, index) => ({
    key: `${index}:${check?.check ?? "check"}`,
    step: check?.step ?? index + 1,
    check: String(check?.check ?? "check"),
    ok: check?.ok === true,
    tone: check?.ok === true ? "up" : "down",
    detail: String(check?.detail ?? ""),
  }));
  const status = String(proposal.status ?? "UNKNOWN");
  const broker = proposal.result?.broker === "simulated-mt5" ? "simulated MT5"
    : proposal.paperOrderId === null || proposal.paperOrderId === undefined ? "none" : "paper";
  const risk = finite(intent.riskPct);
  const strategy = intent.strategyId
    ? `${intent.strategyId}${intent.strategyVersion ? `@${intent.strategyVersion}` : ""}`
    : null;
  return {
    key: String(proposal.id ?? `${status}-${proposal.createdAt}`),
    id: String(proposal.id ?? ""),
    shortId: String(proposal.id ?? "").slice(0, 8),
    created: executionTimeText(proposal.createdAt),
    symbol: String(intent.symbol ?? EM_DASH),
    side: String(intent.side ?? EM_DASH),
    type: String(intent.type ?? EM_DASH),
    price: isFiniteNumber(finite(intent.price)) ? String(finite(intent.price)) : null,
    stopLoss: isFiniteNumber(finite(intent.stopLoss)) ? String(finite(intent.stopLoss)) : null,
    takeProfit: isFiniteNumber(finite(intent.takeProfit)) ? String(finite(intent.takeProfit)) : null,
    risk: isFiniteNumber(risk) ? percentText(risk) : null,
    strategy,
    intentText: [String(intent.side ?? ""), String(intent.type ?? "")].filter(Boolean).join(" ")
      + (isFiniteNumber(risk) ? ` · risk ${percentText(risk)}` : "")
      + (strategy ? ` · ${strategy}` : ""),
    // The explicit simulator path stores its connector label in the result; Paper Trading
    // remains separately identified by its own order id.
    broker,
    status,
    tone: statusTone(status),
    decisionReason: proposal.decisionReason ?? null,
    decidedAt: proposal.decidedAt ?? null,
    paperOrderId: proposal.paperOrderId ?? null,
    simulatorTicket: proposal.result?.broker === "simulated-mt5" ? proposal.result.ticket ?? null : null,
    checks,
    checkCount: checks.length,
    canDecide: status === "PENDING_APPROVAL",
    canSubmitPaper: status === "APPROVED",
    canSubmitSimulator: status === "APPROVED",
  };
}

/** How many of a proposal's checks passed — the pipeline cell's summary line. */
export function passedChecks(row) {
  const checks = Array.isArray(row?.checks) ? row.checks : [];
  return { passed: checks.filter((check) => check.ok).length, total: checks.length };
}

/* --------------------------------------------------------------- the automation envelope */

/**
 * `ExecutionSupervisor::automationLimits()`'s defaults, exactly as the PHP merges them under
 * `$state['automationLimits']`. Kept for the parity test; the UI itself displays the values
 * returned by the persisted Node `/execution/automation` endpoint. The suite asserts these
 * defaults against the PHP literal.
 */
export const LEGACY_AUTOMATION_LIMITS = Object.freeze({
  maxTradeNotionalUsd: 500,
  maxDailyTrades: 5,
  maxRiskPerTradePct: 0.01,
  approvedSymbols: Object.freeze([]),
  updatedAt: null,
});

/** The four rows legacy drew, with the legacy default and the absence stated on each. */
export function automationRows(limits = LEGACY_AUTOMATION_LIMITS) {
  const source = limits && typeof limits === "object" ? limits : {};
  const symbols = Array.isArray(source.approvedSymbols) ? source.approvedSymbols : [];
  const note = source.updatedAt ? "persisted" : "default (not explicitly configured)";
  return [
    { key: "maxTradeNotionalUsd", label: EXECUTION_COPY.envelopeNotional, value: moneyText(source.maxTradeNotionalUsd), note },
    { key: "maxDailyTrades", label: EXECUTION_COPY.envelopeDaily, value: countText(source.maxDailyTrades), note },
    { key: "maxRiskPerTradePct", label: EXECUTION_COPY.envelopeRisk, value: percentText(source.maxRiskPerTradePct), note },
    { key: "approvedSymbols", label: EXECUTION_COPY.envelopeSymbols, value: symbols.length ? symbols.join(", ") : EM_DASH, note },
  ];
}

/* ------------------------------------------------------------------------------ the facts */

/**
 * The module's own scope, read from `GET /execution/status`. Every boolean is the server's;
 * the screen adds no inference, and `brokerConnectorAvailable`/`automatedModesAvailable`
 * are the two facts that make the broker-bound remainder visible.
 */
export function executionStatusFacts(status) {
  if (!status || typeof status !== "object") return null;
  return {
    enabled: status.enabled === true,
    paperSubmissionAvailable: status.paperSubmissionAvailable === true,
    brokerConnectorAvailable: status.brokerConnectorAvailable === true,
    brokerConnectorsConfigured: Number(status.brokerConnectorsConfigured ?? 0) || 0,
    simulatedBrokerAvailable: status.simulatedBrokerAvailable === true,
    simulatedOrderRoutingEnabled: status.simulatedOrderRoutingEnabled === true,
    automatedModesAvailable: status.automatedModesAvailable === true,
    approvalRequired: status.approvalRequired === true,
    expiryMinutes: Number(status.proposalExpiryMinutes ?? 0) || null,
    scope: status.scope ?? null,
    automationScope: status.automationScope ?? null,
    simulatorSubmissionScope: status.simulatorSubmissionScope ?? null,
  };
}

/** The governance sentence the strip shows, read from `GET /trading/mode`. */
export function governanceFacts(state) {
  if (!state || typeof state !== "object") return null;
  const killSwitch = state.killSwitch && typeof state.killSwitch === "object" ? state.killSwitch : {};
  return {
    mode: state.tradingMode ?? "UNKNOWN",
    tradingMode: state.tradingMode ?? "UNKNOWN",
    executionMode: state.executionMode ?? "HUMAN_APPROVAL",
    automationLimits: state.automationLimits && typeof state.automationLimits === "object" ? state.automationLimits : null,
    killSwitch: killSwitch.active === true,
    synthetic: state.allowSyntheticPaperData === true,
    simulated: state.simulationOnly === true,
  };
}

/**
 * Legacy's two page banners as booleans. The mode warning is true on every host this port
 * can have — `TRADING_MODE_BODY` accepts only ANALYSIS_ONLY and PAPER_TRADING — and that is
 * the honest state, not a bug to hide.
 */
export function banners(state, status) {
  const governance = governanceFacts(state);
  const facts = executionStatusFacts(status);
  return {
    killSwitch: governance?.killSwitch === true,
    modeBlocked: governance ? governance.tradingMode !== "PAPER_TRADING" : false,
    noBroker: facts ? !facts.brokerConnectorAvailable : true,
    noSimulator: facts ? !facts.simulatedOrderRoutingEnabled : true,
    noAutomation: facts ? !facts.automatedModesAvailable : true,
  };
}

/* ------------------------------------------------------------------------------ the reads */

/**
 * Every surface the console reads, with the permission the server enforces. The suite
 * asserts each against `GET /api/v1/system/routes`, so a route that moves, disappears or
 * changes its guard fails there instead of rendering an error box.
 *
 * `strategies` is session-only on the server (`Api_strategies` guarded it with authentication
 * alone), so its declared permission is `null` and the screen uses it for the datalist of
 * APPROVED strategies legacy's form also offered.
 */
export const EXECUTION_READS = Object.freeze([
  { key: "status", method: "GET", path: "/api/v1/execution/status", permission: EXECUTION_PERMISSION, section: "Module scope" },
  { key: "automation", method: "GET", path: "/api/v1/execution/automation", permission: EXECUTION_PERMISSION, section: "Automation envelope" },
  { key: "proposals", method: "GET", path: "/api/v1/execution/proposals", permission: EXECUTION_PERMISSION, section: "Proposals" },
  { key: "tradingState", method: "GET", path: "/api/v1/trading/mode", permission: EXECUTION_PERMISSION, section: "Governance strip" },
  { key: "accounts", method: "GET", path: "/api/v1/paper/accounts", permission: EXECUTION_PERMISSION, section: "Propose form" },
  { key: "strategies", method: "GET", path: "/api/v1/strategies", permission: null, section: "Propose form" },
]);

/** The registered writes the screen offers, each with its actual permission gate. */
export const EXECUTION_WRITES = Object.freeze([
  Object.freeze({ key: "propose", method: "POST", path: "/api/v1/execution/proposals", permission: EXECUTION_EXECUTE, label: "Run pipeline & create proposal", legacy: "Execution::propose → ExecutionSupervisor::propose()" }),
  Object.freeze({ key: "decide", method: "POST", path: "/api/v1/execution/proposals/:proposalId/decision", permission: EXECUTION_CONTROL, label: "approve / reject", legacy: "Execution::decide → ExecutionSupervisor::decide()" }),
  Object.freeze({ key: "paperSubmit", method: "POST", path: "/api/v1/execution/proposals/:proposalId/paper-submit", permission: EXECUTION_EXECUTE, label: "Submit to paper", legacy: "Paper Trading simulation path" }),
  Object.freeze({ key: "simulatorSubmit", method: "POST", path: "/api/v1/execution/proposals/:proposalId/simulator-submit", permission: EXECUTION_EXECUTE, label: "Submit to simulated MT5", legacy: "Distinct process-local demo route; never a real broker" }),
  Object.freeze({ key: "automationLimits", method: "PATCH", path: "/api/v1/execution/automation-limits", permission: EXECUTION_CONTROL, label: "Update automation limits", legacy: "platform->updateAutomationLimits()" }),
  Object.freeze({ key: "executionMode", method: "POST", path: "/api/v1/execution/mode", permission: EXECUTION_CONTROL, label: "Set execution mode", legacy: "SEMI_AUTONOMOUS / FULLY_AUTOMATED governance" }),
  Object.freeze({ key: "automatedPaper", method: "POST", path: "/api/v1/execution/automated-paper", permission: EXECUTION_EXECUTE, label: "Run governed Paper Trading request", legacy: "ExecutionSupervisor::executeAutomated()" }),
]);

/** Boundaries that remain intentionally unported after the simulation-only path. */
export const LEGACY_WRITES_NOT_PORTED = Object.freeze([
  Object.freeze({ key: "liveRoute", legacy: "POST /execution/:id/route → real TradingConnector", why: "live/provider-backed routing remains disabled and unverified; only the separate in-process simulation route exists" }),
  Object.freeze({ key: "unattendedLoop", legacy: "unattended strategy evaluation loop", why: "automated modes are request-based Paper Trading operations, not a background strategy loop" }),
]);
