/**
 * Owner-scoped, human-reviewed execution proposals. Approved proposals can use
 * the simulation-only Paper Trading service or, when explicitly configured,
 * the process-local simulated MT5 bridge behind the full 15-step supervisor
 * pipeline. No real broker connector is routable from this module.
 *
 * SEMI_AUTONOMOUS and FULLY_AUTOMATED remain request-based Paper Trading modes;
 * they are not unattended strategy loops and never submit to the broker simulator.
 */

import { randomUUID } from "node:crypto";
import { AppError } from "../../http/errors.js";
import { createRiskEngine } from "../analysis/risk-engine.js";
import { MARKET_CLASSES } from "../market-data/timeframes.js";
import { EXECUTION_MODES, normalizeTradingState } from "../paper/service.js";

const MAX_PROPOSAL_AGE_MS = 4 * 60 * 60_000;
/** Legacy swept a fixed 200 pending proposals per cron minute (`ExecutionSupervisor.php:372`). */
const STALE_SWEEP_LIMIT = 200;
const PROPOSAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYMBOL = /^[A-Z0-9._-]{2,24}$/;
const STRATEGY_ID = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const VERSION = /^[A-Za-z0-9._-]{1,20}$/;
const SIMULATOR_PIPELINE_STEPS = Object.freeze({
  "kill-switch": 1,
  "trading-mode": 2,
  strategy: 3,
  "broker-connection": 4,
  "market-open": 5,
  "data-freshness": 6,
  "duplicate-orders": 7,
  "symbol-permissions": 8,
  margin: 9,
  "risk-engine": 10,
  "human-approval": 11,
  "order-placement": 12,
  "execution-confirmation": 13,
  "audit-log": 14,
  "portfolio-update": 15,
});

function actorIdOf(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw AppError.unauthorized("An authenticated user is required", { code: "AUTH_REQUIRED" });
  }
  return id;
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`, { code: "INVALID_ID" });
  }
  return id;
}

function isoNow(now) {
  return new Date(now()).toISOString();
}

function normalizeIntent(input = {}) {
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  const marketClass = String(input.marketClass ?? "").trim().toLowerCase();
  const side = String(input.side ?? "").trim().toUpperCase();
  const type = String(input.type ?? "MARKET").trim().toUpperCase();
  const price = input.price === null || input.price === undefined ? null : Number(input.price);
  const stopLoss = Number(input.stopLoss);
  const takeProfit = input.takeProfit === null || input.takeProfit === undefined ? null : Number(input.takeProfit);
  const riskPct = input.riskPct === null || input.riskPct === undefined ? null : Number(input.riskPct);
  const confidence = input.confidence === null || input.confidence === undefined ? null : Number(input.confidence);
  const strategyId = input.strategyId === null || input.strategyId === undefined || input.strategyId === ""
    ? null
    : String(input.strategyId).trim().toLowerCase();
  const strategyVersion = input.strategyVersion === null || input.strategyVersion === undefined || input.strategyVersion === ""
    ? null
    : String(input.strategyVersion).trim();

  if (!SYMBOL.test(symbol)) throw AppError.badRequest("symbol must contain 2–24 letters, digits, dots, underscores or hyphens", { code: "INVALID_SYMBOL" });
  if (!MARKET_CLASSES.includes(marketClass)) throw AppError.badRequest(`marketClass must be one of: ${MARKET_CLASSES.join(", ")}`, { code: "INVALID_MARKET_CLASS" });
  if (!["BUY", "SELL"].includes(side)) throw AppError.badRequest("side must be BUY or SELL", { code: "INVALID_ORDER_SIDE" });
  if (!["MARKET", "LIMIT"].includes(type)) throw AppError.badRequest("type must be MARKET or LIMIT", { code: "INVALID_ORDER_TYPE" });
  if (!Number.isFinite(stopLoss) || stopLoss <= 0) throw AppError.badRequest("A positive stop loss is required", { code: "INVALID_STOP_LOSS" });
  if (type === "LIMIT" && (!Number.isFinite(price) || price <= 0)) throw AppError.badRequest("A positive price is required for a LIMIT proposal", { code: "INVALID_ORDER_PRICE" });
  if (type === "MARKET" && price !== null && (!Number.isFinite(price) || price <= 0)) throw AppError.badRequest("price must be positive when supplied", { code: "INVALID_ORDER_PRICE" });
  if (takeProfit !== null && (!Number.isFinite(takeProfit) || takeProfit <= 0)) throw AppError.badRequest("takeProfit must be positive when supplied", { code: "INVALID_TAKE_PROFIT" });
  if (riskPct !== null && (!Number.isFinite(riskPct) || riskPct < 0.000001 || riskPct > 0.05)) throw AppError.badRequest("riskPct must be between 0.000001 and 0.05", { code: "INVALID_RISK_PCT" });
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw AppError.badRequest("confidence must be between 0 and 1", { code: "INVALID_CONFIDENCE" });
  if (strategyId !== null && !STRATEGY_ID.test(strategyId)) throw AppError.badRequest("strategyId is invalid", { code: "INVALID_STRATEGY_ID" });
  if (strategyVersion !== null && !VERSION.test(strategyVersion)) throw AppError.badRequest("strategyVersion is invalid", { code: "INVALID_STRATEGY_VERSION" });
  if ((strategyId === null) !== (strategyVersion === null)) {
    throw AppError.badRequest("strategyId and strategyVersion must be supplied together", { code: "STRATEGY_VERSION_REQUIRED" });
  }

  return {
    symbol,
    marketClass,
    side,
    type,
    price,
    stopLoss,
    takeProfit,
    riskPct,
    reason: typeof input.reason === "string" ? input.reason.trim().replace(/\s+/g, " ").slice(0, 500) || null : null,
    confidence,
    strategyId,
    strategyVersion,
  };
}

function normalizeAutomationPatch(patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw AppError.badRequest("Automation limits must be supplied as an object", { code: "INVALID_AUTOMATION_LIMITS" });
  }
  const allowed = new Set(["maxDailyTrades", "maxTradeNotionalUsd", "maxRiskPerTradePct", "approvedSymbols"]);
  const keys = Object.keys(patch);
  if (!keys.length) throw AppError.badRequest("At least one automation limit must be supplied", { code: "NO_AUTOMATION_LIMITS" });
  for (const key of keys) {
    if (!allowed.has(key)) throw AppError.badRequest(`Unknown automation limit: ${key}`, { code: "INVALID_AUTOMATION_LIMIT" });
  }
  const normalized = {};
  if (Object.hasOwn(patch, "maxDailyTrades")) {
    const value = patch.maxDailyTrades;
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
      throw AppError.badRequest("maxDailyTrades must be an integer from 1 to 100", { code: "INVALID_AUTOMATION_LIMIT" });
    }
    normalized.maxDailyTrades = value;
  }
  if (Object.hasOwn(patch, "maxTradeNotionalUsd")) {
    const value = patch.maxTradeNotionalUsd;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 100_000_000) {
      throw AppError.badRequest("maxTradeNotionalUsd must be between 1 and 100000000", { code: "INVALID_AUTOMATION_LIMIT" });
    }
    normalized.maxTradeNotionalUsd = value;
  }
  if (Object.hasOwn(patch, "maxRiskPerTradePct")) {
    const value = patch.maxRiskPerTradePct;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0.0001 || value > 0.05) {
      throw AppError.badRequest("maxRiskPerTradePct must be between 0.0001 and 0.05", { code: "INVALID_AUTOMATION_LIMIT" });
    }
    normalized.maxRiskPerTradePct = value;
  }
  if (Object.hasOwn(patch, "approvedSymbols")) {
    const symbols = patch.approvedSymbols;
    if (!Array.isArray(symbols) || symbols.length > 100
      || symbols.some((symbol) => typeof symbol !== "string" || !/^[A-Z0-9._-]{2,24}$/.test(symbol.trim().toUpperCase()))) {
      throw AppError.badRequest("approvedSymbols must be an array of at most 100 valid symbols", { code: "INVALID_AUTOMATION_LIMIT" });
    }
    normalized.approvedSymbols = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))];
  }
  return normalized;
}

function utcDayBounds(now) {
  const current = new Date(now());
  const start = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate()));
  const end = new Date(start.getTime() + 86_400_000 - 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function simulatedMarketSessionOpen(marketClass, timestamp) {
  if (marketClass === "crypto") return true;
  if (!["forex", "commodity"].includes(marketClass)) return false;
  const date = new Date(timestamp);
  const day = date.getUTCDay();
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (day === 6) return false;
  if (day === 0) return minutes >= 21 * 60;
  if (day === 5) return minutes < 21 * 60;
  return true;
}

function roundVolume(value) {
  return Math.floor(Number(value) * 1_000_000) / 1_000_000;
}

function proposalView(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    accountId: Number(row.account_id),
    status: String(row.status),
    intent: structuredClone(row.intent),
    checks: structuredClone(row.checks),
    result: row.result === null || row.result === undefined ? null : structuredClone(row.result),
    decisionByUserId: row.decision_by_user_id === null || row.decision_by_user_id === undefined ? null : Number(row.decision_by_user_id),
    decisionReason: row.decision_reason ?? null,
    decidedAt: row.decided_at ?? null,
    paperOrderId: row.paper_order_id === null || row.paper_order_id === undefined ? null : Number(row.paper_order_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    simulationOnly: true,
    liveTradingEnabled: false,
  };
}

function safePaperResult(result) {
  const order = result?.order ?? null;
  return {
    filled: Boolean(result?.filled),
    order: order ? {
      id: Number(order.id),
      status: order.status,
      synthetic: Boolean(order.synthetic),
      rejectReasons: order.rejectReasons ?? (order.reject_reason ? [order.reject_reason] : []),
    } : null,
    position: result?.position ? { id: Number(result.position.id), status: result.position.status, synthetic: Boolean(result.position.synthetic) } : null,
    riskDecision: result?.riskDecision ? {
      approved: Boolean(result.riskDecision.approved),
      reasons: result.riskDecision.reasons ?? [],
      warnings: result.riskDecision.warnings ?? [],
    } : null,
    simulationOnly: true,
    liveTradingEnabled: false,
  };
}

function safeFailure(error) {
  return {
    code: String(error?.code ?? "PAPER_SUBMISSION_FAILED").slice(0, 80),
    message: Number(error?.statusCode) >= 500
      ? "Paper submission was unavailable; no live route was attempted"
      : String(error?.message ?? "Paper submission was refused").slice(0, 500),
  };
}

export function createExecutionService({ store = null, paper = null, strategies = null, notifications = null, brokers = null, log = null, now = () => Date.now() } = {}) {
  function requireStore() {
    if (!store || typeof store.withPaperTransaction !== "function" || typeof store.findExecutionProposal !== "function") {
      throw AppError.unavailable("Execution proposals require a configured persistence adapter", { code: "EXECUTION_STORE_UNAVAILABLE", retryAfter: 30 });
    }
  }

  function requirePaperService() {
    if (!paper || typeof paper.submitOrder !== "function") {
      throw AppError.unavailable("The paper-order service is unavailable; execution is disabled", { code: "PAPER_SERVICE_UNAVAILABLE", retryAfter: 30 });
    }
  }

  /**
   * Publish the operator alerts the legacy `ExecutionSupervisor` published, with
   * its dedupe keys, at the points where this paper-only workflow reaches the same
   * state.
   *
   * **Never call this inside `store.withPaperTransaction`.** The file adapter
   * serializes every mutation through one queue and holds it for the whole
   * transaction, so a notification write from inside a transaction waits on the
   * transaction that is waiting on it — a deadlock, not a slow write. Every call
   * site here collects a pending alert inside the transaction and publishes it
   * afterwards through `publishPending`.
   *
   * Best-effort by design: `wf_audit_events` is the evidence, the notification is
   * the nudge. A host without migration 009, or an adapter with no notification
   * surface, must still be able to approve and submit a proposal, so a failure
   * here is logged and never propagated — otherwise an alerting outage would look
   * like a trading outage.
   */
  async function publish(type, severity, title, detail = {}, dedupeKey = null, userId = null) {
    if (!notifications || typeof notifications.notify !== "function") return null;
    try {
      const result = await notifications.notify(type, severity, title, detail, dedupeKey, userId);
      return result?.notification ?? null;
    } catch (error) {
      log?.warn?.({ err: error, notificationType: type }, "Operator notification could not be published");
      return null;
    }
  }

  /**
   * The submission refusals that leave evidence, and what each one records.
   *
   * Legacy routed every refusal in `ExecutionSupervisor::route()` through one
   * `routingBlocked()` helper which audited `EXECUTION_ROUTING_BLOCKED` as `'system'`
   * and published a `ROUTING_BLOCKED` notification deduped to **one per UTC day**
   * (`routing-blocked:` . `gmdate('Ymd')`). Until now this port threw a bare 409 for
   * all three, so an attempt to submit an order while the kill switch was active left
   * **no trace at all** — and "who tried to route while the platform was stopped, and
   * when" is the first question a governance review asks.
   *
   * The audit event is per attempt for all three, because each is a distinct event
   * worth reconstructing. The notification is limited to the governance refusal, and
   * keeps legacy's daily dedupe: `ROUTING_BLOCKED` means "routing is unavailable
   * today", which is a platform condition. Broadcasting it for a caller who submitted
   * a proposal that was simply not approved yet would say the platform is down when it
   * is not — a misleading alert is worse than no alert.
   *
   * The proposal's status is deliberately **not** changed, exactly as legacy left it:
   * a blocked attempt is retryable, and consuming the proposal would punish an
   * operator for the platform's own state.
   */
  const SUBMISSION_REFUSALS = Object.freeze({
    EXECUTION_GOVERNANCE_BLOCKED: {
      reason: "trading governance blocks submission (kill switch active, or the mode is not PAPER_TRADING)",
      notify: true,
    },
    PAPER_SUBMISSION_NOT_APPROVED: {
      reason: "the proposal has not been human-approved",
      notify: false,
    },
    PAPER_SUBMISSION_ALREADY_CLAIMED: {
      reason: "the proposal was already claimed for submission",
      notify: false,
    },
  });

  /**
   * Record an audit event **outside** any transaction.
   *
   * Every other audit write in this service goes through `tx.recordAudit`, which is
   * right for events describing a transition that committed. This one describes a
   * transition that was *refused* and whose transaction therefore rolled back — writing
   * it inside that transaction would roll the evidence back with it, which is the
   * silent-failure shape this recorder exists to avoid.
   *
   * Best-effort, like `publish`: the refusal itself must reach the caller even when the
   * evidence write fails.
   */
  async function auditOutsideTransaction(event) {
    if (!store || typeof store.recordAudit !== "function") return;
    try {
      await store.recordAudit(event);
    } catch (error) {
      log?.warn?.({ err: error, action: event.action }, "refused-submission audit event could not be recorded");
    }
  }

  /** The UTC `YYYYMMDD` legacy's `gmdate('Ymd')` produced, for the daily dedupe key. */
  /** Probe-free count of configured broker connectors; 0 when the registry is absent. */
function configuredConnectorCount(brokers) {
  if (!brokers || typeof brokers.configuredCount !== "function") return 0;
  try {
    const total = Number(brokers.configuredCount());
    return Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  } catch {
    return 0;
  }
}

function utcDayStamp() {
    return isoNow(now).slice(0, 10).replaceAll("-", "");
  }

  /**
   * Record evidence of a refused submission, then let the refusal propagate.
   *
   * Called **outside** the transaction that threw, because that transaction rolled
   * back: an audit event written inside it would have been rolled back with it, and
   * the evidence would silently not exist. Legacy's `audit->emit` was likewise a
   * separate write, not part of the proposal transaction.
   *
   * Best-effort by construction. The refusal must reach the caller even if the audit
   * or notification write fails, so nothing here throws.
   */
  async function recordSubmissionRefusal(owner, proposal, error) {
    const code = error?.code;
    const refusal = SUBMISSION_REFUSALS[code];
    if (!refusal) return;
    const proposalId = String(proposal?.id ?? "unknown");
    const details = {
      legacyAction: "EXECUTION_ROUTING_BLOCKED",
      code,
      reason: refusal.reason,
      proposalStatus: proposal?.status ?? null,
      // Legacy answered 200 with `{status: "ROUTING_BLOCKED", brokerOrderCreated:
      // false}`; this port answers 409 with the same meaning, so the record says
      // plainly that no order exists.
      orderCreated: false,
      retryable: true,
      summary: `Paper submission refused: ${refusal.reason}`,
    };
    await auditOutsideTransaction({
      actorId: owner,
      action: "execution.paper-submission.blocked",
      entityType: "execution_proposal",
      entityId: proposalId,
      details,
    });
    if (refusal.notify) {
      await publish(
        "ROUTING_BLOCKED",
        "warning",
        `Routing blocked: ${refusal.reason}`,
        { proposalId, code, reason: refusal.reason, proposalStatus: proposal?.status ?? null, orderCreated: false },
        `routing-blocked:${utcDayStamp()}`,
        null,
      );
    }
  }

  /** Publishes an alert queued by a committed transaction. `null` is a no-op. */
  async function publishPending(pending) {
    if (!pending) return null;
    return publish(pending.type, pending.severity, pending.title, pending.detail, pending.dedupeKey, pending.userId ?? null);
  }

  function requireProposalId(value) {
    const id = String(value ?? "");
    if (!PROPOSAL_ID.test(id)) throw AppError.badRequest("proposalId must be a valid UUID", { code: "INVALID_PROPOSAL_ID" });
    return id;
  }

  function requireStrategyRegistry() {
    const registry = strategies?.registry ?? strategies;
    if (!registry || typeof registry.implementation !== "function") {
      throw AppError.unavailable("The Strategy Lab is unavailable", { code: "STRATEGY_REGISTRY_UNAVAILABLE", retryAfter: 30 });
    }
    return registry;
  }

  function isProposalStale(proposal) {
    if (!proposal || proposal.status !== "PENDING_APPROVAL") return false;
    const created = Date.parse(proposal.created_at);
    return !Number.isFinite(created) || now() - created > MAX_PROPOSAL_AGE_MS;
  }

  /**
   * Expire one stale proposal inside an open paper transaction.
   *
   * `actorId` defaults to the owner, which is correct for the HTTP path: there an
   * operator's own read or decision found the lapsed window, and the trail should say
   * so. The scheduled sweep passes `null` instead, because legacy audited
   * `EXECUTION_PROPOSAL_EXPIRED` with actor `'system'` and the operator did nothing —
   * the clock did. Phase 10 renders a null actor as `kind: "system"`, so an operator
   * filtering the audit trail by their own id does not see expiries the platform
   * performed attributed to themselves.
   *
   * @returns {Promise<boolean>} whether THIS call made the transition
   */
  async function expireInTransaction(tx, owner, proposal, pendingNotifications = [], { actorId = owner } = {}) {
    const current = await tx.findExecutionProposal(proposal.id, owner);
    if (!current || current.status !== "PENDING_APPROVAL" || !isProposalStale(current)) return false;
    const account = await tx.findPaperAccount(current.account_id, owner);
    if (!account) return false;
    const updatedAt = isoNow(now);
    const expired = await tx.expireExecutionProposal(current.id, owner, updatedAt);
    if (!expired) return false;
    await tx.recordAudit({
      actorId,
      action: "execution.proposal.expired",
      entityType: "execution_proposal",
      entityId: current.id,
      details: { accountId: Number(current.account_id), summary: "Paper execution approval expired after four hours" },
    });
    pendingNotifications.push({
      type: "PROPOSAL_EXPIRED",
      severity: "warning",
      title: `Approval request expired: ${current.intent?.symbol ?? "proposal"} ${current.intent?.side ?? ""}`.trim(),
      detail: { proposalId: current.id, accountId: Number(current.account_id), expiredAt: updatedAt },
      dedupeKey: `proposal:${current.id}:expired`,
    });
    return true;
  }

  async function expireIfStale(ownerUserId, proposal) {
    if (!isProposalStale(proposal)) return proposal;
    const owner = actorIdOf(ownerUserId);
    const pending = [];
    await store.withPaperTransaction((tx) => expireInTransaction(tx, owner, proposal, pending));
    for (const alert of pending) await publishPending(alert);
    return store.findExecutionProposal(proposal.id, owner);
  }

  /**
   * The scheduled cross-owner expiry sweep — legacy
   * `ExecutionSupervisor::expireStaleProposals()` (`ExecutionSupervisor.php:366`),
   * which `Tools::cron()` ran every minute.
   *
   * **CLI-only. There is deliberately no HTTP route for this.** It writes across
   * every operator's proposals, so exposing it to a session would hand any caller a
   * platform-wide mutation; the owner-bound routes above remain the only way to
   * reach a proposal over HTTP. A test asserts no route can invoke it.
   *
   * Expiry itself is *not* re-implemented here. Each stale proposal goes through
   * the same owner-bound `expireInTransaction` the HTTP path uses, with the owner
   * read off the listed row. That is what preserves the account-revision invariant,
   * the `execution.proposal.expired` audit event and the `PROPOSAL_EXPIRED`
   * notification (dedupe key `proposal:<id>:expired`) — the legacy sweep emitted all
   * three, and a cron job that silently skipped the notification would stop
   * operators hearing about approvals that lapsed overnight.
   *
   * Divergences from the legacy sweep, all recorded in
   * `docs/migration/PHASE12_SCHEDULED_JOBS.md`:
   *  - **SJ-1** per-proposal failure isolation. Legacy had none: one bad row threw
   *    out of the whole `foreach`, so a deterministic failure on proposal 3 of 200
   *    left the other 197 pending forever. Failures are collected and reported, and
   *    the sweep continues.
   *  - **SJ-2** staleness uses this module's `isProposalStale` (a `Date.parse`
   *    comparison) rather than legacy's `created_at >= gmdate('c')` string compare.
   *    `gmdate('c')` emits a `+00:00` offset while this platform stores canonical
   *    `…Z`, and those two forms do not sort consistently against each other — the
   *    same hazard as divergence AV-2. Keeping the existing predicate means the
   *    sweep and the HTTP path can never disagree about what "stale" means.
   *  - **SJ-3** the sweep reports `scanned`, `staleFound`, `expiredIds`,
   *    `alreadyExpired` and `failures` instead of legacy's bare array of ids, and a
   *    bounded batch reports `exhausted` so a partial run is visible rather than
   *    silent (the row 19 CLI pattern).
   *
   * **Dry run.** With `dryRun` the sweep lists and classifies but writes nothing —
   * no transaction, no audit event, no notification. That is what makes the row 19
   * CLI safe to schedule as a default: `tools/scheduled-jobs.mjs` measures on every
   * invocation and only expires with `--apply`. A dry run reports *candidates*
   * (`wouldExpireIds`), never outcomes: only attempting the transition can say
   * whether another run already made it, so `alreadyExpired` is necessarily 0 and the
   * two fields are named differently rather than one standing in for the other.
   *
   * @param {{limit?: number, dryRun?: boolean}} [options] batch ceiling (legacy was
   *   fixed at 200) and whether to measure without writing
   * @returns {Promise<{scanned:number, staleFound:number, expiredIds:string[], wouldExpireIds?:string[], alreadyExpired:number, failures:Array<{proposalId:string,reason:string}>, exhausted:boolean, dryRun:boolean}>}
   */
  async function expireStaleProposals({ limit = STALE_SWEEP_LIMIT, dryRun = false } = {}) {
    requireStore();
    if (typeof store.listExecutionProposalsAllOwners !== "function") {
      throw AppError.unavailable(
        "The scheduled expiry sweep requires a store that can list proposals across owners",
        { code: "EXECUTION_STORE_UNAVAILABLE", retryAfter: 30 },
      );
    }
    const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || STALE_SWEEP_LIMIT, 1), 500);
    // Oldest first, so a bounded batch drains the backlog in the order it accrued:
    // newest-first would leave the oldest proposals pending forever once the limit
    // was reached.
    const pending = await store.listExecutionProposalsAllOwners({ status: "PENDING_APPROVAL", limit: bounded });
    const stale = pending.filter(isProposalStale);

    if (dryRun) {
      const wouldExpireIds = [];
      const unusable = [];
      for (const proposal of stale) {
        const owner = Number(proposal.owner_user_id);
        if (Number.isSafeInteger(owner) && owner > 0) wouldExpireIds.push(String(proposal.id));
        else unusable.push({
          proposalId: String(proposal.id),
          reason: "the proposal has no usable owner, so the owner-bound expiry path cannot run",
        });
      }
      return {
        scanned: pending.length,
        staleFound: stale.length,
        expiredIds: [],
        wouldExpireIds,
        alreadyExpired: 0,
        failures: unusable,
        exhausted: pending.length < bounded,
        dryRun: true,
      };
    }

    const expiredIds = [];
    const failures = [];
    let alreadyExpired = 0;

    for (const proposal of stale) {
      // The owner comes off the row, and `actorIdOf` throws on anything unusable, so
      // validate here instead: a row with no owner is a failure to report, not a
      // reason to abandon the remaining 199.
      const owner = Number(proposal.owner_user_id);
      if (!Number.isSafeInteger(owner) || owner <= 0) {
        failures.push({
          proposalId: String(proposal.id),
          reason: "the proposal has no usable owner, so the owner-bound expiry path cannot run",
        });
        continue;
      }
      try {
        const notifications = [];
        // `expireInTransaction` returns whether THIS call made the transition, so a
        // proposal another run already expired is counted as `alreadyExpired` rather
        // than claimed. Reading the row back afterwards could not tell the two
        // apart — both end in status EXPIRED.
        const transitioned = await store.withPaperTransaction(
          // `actorId: null` — the system expired this, not its owner. See
          // `expireInTransaction`.
          (tx) => expireInTransaction(tx, owner, proposal, notifications, { actorId: null }),
        );
        // Published AFTER the commit, never inside: the file adapter holds its
        // mutation queue for the whole transaction, so notifying from inside
        // deadlocks. See `publishPending`.
        for (const alert of notifications) await publishPending(alert);
        if (transitioned) expiredIds.push(String(proposal.id));
        else alreadyExpired += 1;
      } catch (error) {
        failures.push({ proposalId: String(proposal.id), reason: String(error?.message || error).slice(0, 240) });
        if (log) log.warn({ err: error, proposalId: proposal.id }, "scheduled proposal expiry failed for one proposal");
      }
    }

    return {
      scanned: pending.length,
      staleFound: stale.length,
      expiredIds,
      alreadyExpired,
      failures,
      // `exhausted` false means the batch ceiling was reached and there may be more
      // to do — the remedy is to re-run, and the CLI says so rather than implying
      // the backlog is clear.
      exhausted: pending.length < bounded,
      dryRun: false,
    };
  }

  async function propose(ownerUserId, input = {}) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    const accountId = positiveId(input.accountId, "accountId");
    const id = randomUUID();
    const createdAt = isoNow(now);

    const pending = [];
    const view = await store.withPaperTransaction(async (tx) => {
      // Owner check is first: no strategy lookup, provider call or proposal write
      // occurs for a guessed/foreign account id.
      const account = await tx.findPaperAccount(accountId, owner);
      if (!account) throw AppError.notFound("Paper account not found", { code: "PAPER_ACCOUNT_NOT_FOUND" });

      let intent;
      try {
        intent = normalizeIntent(input);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw AppError.badRequest("The execution intent is invalid", { code: "INVALID_EXECUTION_INTENT" });
      }

      const checks = [];
      const addCheck = (check, ok, detail) => checks.push({ step: checks.length + 1, check, ok, detail });
      const state = normalizeTradingState(await tx.loadTradingState());
      if (state.killSwitch.active) addCheck("kill-switch", false, "kill switch is active");
      else addCheck("kill-switch", true, "inactive");
      if (!state.killSwitch.active) {
        if (state.tradingMode !== "PAPER_TRADING") addCheck("trading-mode", false, `mode is ${state.tradingMode}; only PAPER_TRADING proposals are available`);
        else addCheck("trading-mode", true, "PAPER_TRADING (simulation-only)");
      }

      if (!checks.some((check) => !check.ok) && intent.strategyId) {
        const record = await tx.findStrategy(intent.strategyId, intent.strategyVersion);
        if (!record) addCheck("strategy", false, `strategy ${intent.strategyId}@${intent.strategyVersion} was not found`);
        else if (!requireStrategyRegistry().implementation(intent.strategyId, intent.strategyVersion)) {
          addCheck("strategy", false, "the exact strategy version has no executable implementation");
        } else if (record.lifecycle !== "APPROVED") {
          addCheck("strategy", false, `strategy lifecycle is ${record.lifecycle}; execution proposals require APPROVED`);
        } else if (record.source === "ai" && !record.human_signoff) {
          addCheck("strategy", false, "AI strategy is missing its persisted human risk sign-off");
        } else {
          addCheck("strategy", true, `${intent.strategyId}@${intent.strategyVersion} is APPROVED`);
        }
      } else if (!checks.some((check) => !check.ok)) {
        addCheck("strategy", true, "discretionary proposal; a separate human decision is required");
      }

      const rejected = checks.some((check) => !check.ok);
      const proposal = {
        id,
        owner_user_id: owner,
        account_id: accountId,
        status: rejected ? "REJECTED" : "PENDING_APPROVAL",
        intent,
        checks,
        result: null,
        decision_by_user_id: null,
        decision_reason: null,
        decided_at: null,
        paper_order_id: null,
        created_at: createdAt,
        updated_at: createdAt,
      };
      await tx.createExecutionProposal(proposal);
      await tx.recordAudit({
        actorId: owner,
        action: rejected ? "execution.proposal.rejected" : "execution.proposal.created",
        entityType: "execution_proposal",
        entityId: id,
        details: {
          accountId,
          symbol: intent.symbol,
          side: intent.side,
          status: proposal.status,
          summary: rejected ? checks.find((check) => !check.ok)?.detail : "Paper proposal awaits a separately permissioned human decision",
        },
      });
      // Legacy `ExecutionSupervisor` raised TRADE_APPROVAL_REQUESTED as a
      // broadcast warning keyed on the proposal id. A proposal rejected by its own
      // pre-checks raises nothing: it never reached the approval queue, so there
      // is no decision for an operator to make.
      // The alert is a side effect only: `propose()` keeps returning exactly the
      // proposal view it returned before this module existed, so no existing
      // caller or test observes a shape change. A proposal rejected by its own
      // pre-checks raises nothing — it never reached the approval queue.
      if (!rejected) {
        pending.push({
          type: "TRADE_APPROVAL_REQUESTED",
          severity: "warning",
          title: `Approval required: ${intent.symbol} ${intent.side}`,
          detail: { proposalId: id, accountId, symbol: intent.symbol, side: intent.side, type: intent.type, price: intent.price, expiresAt: new Date(now() + MAX_PROPOSAL_AGE_MS).toISOString() },
          dedupeKey: `proposal:${id}`,
        });
      }
      return proposalView(proposal);
    });
    await publishPending(pending[0] ?? null);
    return view;
  }

  async function list(ownerUserId, { status = null, limit = 100 } = {}) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    const bounded = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const current = await store.listExecutionProposals(owner, { status, limit: bounded });
    if (current.some(isProposalStale)) {
      // Expire a stale page in one transaction rather than opening one SQL
      // connection per row when an owner has accumulated many old proposals.
      const pending = [];
      await store.withPaperTransaction(async (tx) => {
        for (const proposal of current) {
          if (isProposalStale(proposal)) await expireInTransaction(tx, owner, proposal, pending);
        }
      });
      for (const alert of pending) await publishPending(alert);
    }
    const proposals = await store.listExecutionProposals(owner, { status, limit: bounded });
    return { proposals: proposals.map(proposalView), simulationOnly: true, liveTradingEnabled: false };
  }

  async function find(ownerUserId, proposalId) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    const id = requireProposalId(proposalId);
    let proposal = await store.findExecutionProposal(id, owner);
    if (!proposal) throw AppError.notFound("Execution proposal not found", { code: "EXECUTION_PROPOSAL_NOT_FOUND" });
    const account = await store.findPaperAccount(proposal.account_id, owner);
    if (!account) throw AppError.notFound("Execution proposal not found", { code: "EXECUTION_PROPOSAL_NOT_FOUND" });
    proposal = await expireIfStale(owner, proposal);
    return { proposal: proposalView(proposal) };
  }

  async function decide(ownerUserId, proposalId, { approve, reason } = {}) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    const id = requireProposalId(proposalId);
    if (typeof approve !== "boolean") throw AppError.badRequest("approve must be a boolean", { code: "INVALID_PROPOSAL_DECISION" });
    const normalizedReason = typeof reason === "string" ? reason.trim().replace(/\s+/g, " ") : "";
    if (normalizedReason.length < 10 || normalizedReason.length > 1_000) {
      throw AppError.badRequest("Decision reason must be between 10 and 1000 characters", { code: "INVALID_DECISION_REASON" });
    }
    const existing = await store.findExecutionProposal(id, owner);
    if (!existing) throw AppError.notFound("Execution proposal not found", { code: "EXECUTION_PROPOSAL_NOT_FOUND" });
    await expireIfStale(owner, existing);

    return store.withPaperTransaction(async (tx) => {
      const proposal = await tx.findExecutionProposal(id, owner);
      if (!proposal) throw AppError.notFound("Execution proposal not found", { code: "EXECUTION_PROPOSAL_NOT_FOUND" });
      const account = await tx.findPaperAccount(proposal.account_id, owner);
      if (!account) throw AppError.notFound("Execution proposal not found", { code: "EXECUTION_PROPOSAL_NOT_FOUND" });
      if (proposal.status !== "PENDING_APPROVAL") {
        throw AppError.conflict(`Proposal is ${proposal.status}; only PENDING_APPROVAL proposals can be decided`, { code: "EXECUTION_DECISION_CLOSED" });
      }
      if (approve) {
        const state = normalizeTradingState(await tx.loadTradingState());
        if (state.killSwitch.active || state.tradingMode !== "PAPER_TRADING") {
          throw AppError.conflict("Governance changed; the kill switch must be released and PAPER_TRADING mode active before approval", { code: "EXECUTION_GOVERNANCE_BLOCKED" });
        }
      }
      const decidedAt = isoNow(now);
      const changed = await tx.decideExecutionProposal(id, owner, {
        status: approve ? "APPROVED" : "DECLINED",
        decisionByUserId: owner,
        reason: normalizedReason,
        decidedAt,
        updatedAt: decidedAt,
      });
      if (!changed) throw AppError.conflict("Proposal changed before the decision was recorded", { code: "EXECUTION_CONCURRENT_DECISION" });
      await tx.recordAudit({
        actorId: owner,
        action: approve ? "execution.proposal.approved" : "execution.proposal.declined",
        entityType: "execution_proposal",
        entityId: id,
        details: { accountId: Number(proposal.account_id), reason: normalizedReason, summary: approve ? "Paper submission approved; risk will be rechecked at submit time" : "Paper submission declined" },
      });
      return { proposal: proposalView(await tx.findExecutionProposal(id, owner)) };
    });
  }

  async function submitToPaper(ownerUserId, proposalId) {
    requireStore();
    requirePaperService();
    const owner = actorIdOf(ownerUserId);
    const id = requireProposalId(proposalId);
    const existing = await store.findExecutionProposal(id, owner);
    if (!existing) throw AppError.notFound("Execution proposal not found", { code: "EXECUTION_PROPOSAL_NOT_FOUND" });
    await expireIfStale(owner, existing);

    const claimed = await store.withPaperTransaction(async (tx) => {
      const proposal = await tx.findExecutionProposal(id, owner);
      if (!proposal) throw AppError.notFound("Execution proposal not found", { code: "EXECUTION_PROPOSAL_NOT_FOUND" });
      const account = await tx.findPaperAccount(proposal.account_id, owner);
      if (!account) throw AppError.notFound("Execution proposal not found", { code: "EXECUTION_PROPOSAL_NOT_FOUND" });
      if (proposal.status !== "APPROVED") {
        throw AppError.conflict(`Proposal is ${proposal.status}; only APPROVED proposals can be submitted to paper trading`, { code: "PAPER_SUBMISSION_NOT_APPROVED" });
      }
      const state = normalizeTradingState(await tx.loadTradingState());
      if (state.killSwitch.active || state.tradingMode !== "PAPER_TRADING") {
        throw AppError.conflict("Paper submission is blocked by current trading governance", { code: "EXECUTION_GOVERNANCE_BLOCKED" });
      }
      const updatedAt = isoNow(now);
      const claimedRow = await tx.claimExecutionProposal(id, owner, updatedAt);
      if (!claimedRow) throw AppError.conflict("Proposal is already being submitted or has changed state", { code: "PAPER_SUBMISSION_ALREADY_CLAIMED" });
      await tx.recordAudit({
        actorId: owner,
        action: "execution.paper-submission.started",
        entityType: "execution_proposal",
        entityId: id,
        details: { accountId: Number(proposal.account_id), summary: "Approved proposal claimed for one simulation-only paper submission" },
      });
      return proposal;
    }).catch(async (error) => {
      // Recorded OUTSIDE the transaction that just rolled back — see
      // `auditOutsideTransaction`. Legacy audited every routing refusal and published
      // a daily-deduped `ROUTING_BLOCKED` alert; a bare 409 leaves no evidence that
      // anyone tried to submit an order while the platform was stopped.
      await recordSubmissionRefusal(owner, existing, error);
      throw error;
    });

    let paperResult;
    try {
      const intent = claimed.intent;
      paperResult = await paper.submitOrder(owner, claimed.account_id, {
        symbol: intent.symbol,
        marketClass: intent.marketClass,
        side: intent.side,
        type: intent.type,
        price: intent.price,
        stopLoss: intent.stopLoss,
        takeProfit: intent.takeProfit,
        riskPct: intent.riskPct,
        reason: intent.reason ?? `approved execution proposal ${id}`,
        confidence: intent.confidence,
        strategy: intent.strategyId,
        strategyVersion: intent.strategyVersion,
      }, { actorId: owner });
    } catch (error) {
      const failure = safeFailure(error);
      const pending = [];
      await store.withPaperTransaction(async (tx) => {
        const proposal = await tx.findExecutionProposal(id, owner);
        if (!proposal) return;
        const updatedAt = isoNow(now);
        const completed = await tx.completeExecutionProposal(id, owner, {
          status: "PAPER_FAILED",
          paperOrderId: null,
          result: failure,
          updatedAt,
        });
        if (completed) {
          await tx.recordAudit({
            actorId: owner,
            action: "execution.paper-submission.failed",
            entityType: "execution_proposal",
            entityId: id,
            details: { accountId: Number(proposal.account_id), errorCode: failure.code, summary: failure.message },
          });
          // Legacy wording named the broker; this workflow has no broker, so the
          // alert says what actually refused it. `safeFailure` has already
          // replaced a 5xx message with a non-leaking one.
          pending.push({
            type: "EXECUTION_FAILED",
            severity: "critical",
            title: `Paper submission failed for ${claimed.intent?.symbol ?? id}`,
            detail: { proposalId: id, accountId: Number(proposal.account_id), errorCode: failure.code, error: failure.message },
            dedupeKey: `proposal:${id}:failed`,
          });
        }
      });
      // Published before the throw so the operator is told why the request failed;
      // `publishPending` cannot itself throw.
      await publishPending(pending[0] ?? null);
      throw error instanceof AppError ? error : AppError.internal("Paper submission failed", { cause: error });
    }

    const safe = safePaperResult(paperResult);
    const orderId = paperResult?.order?.id === null || paperResult?.order?.id === undefined ? null : Number(paperResult.order.id);
    const status = paperResult?.order?.status === "REJECTED"
      ? "PAPER_REJECTED"
      : paperResult?.filled ? "PAPER_EXECUTED" : "PAPER_PENDING";
    const pending = [];
    const completed = await store.withPaperTransaction(async (tx) => {
      const proposal = await tx.findExecutionProposal(id, owner);
      if (!proposal) throw AppError.notFound("Execution proposal not found", { code: "EXECUTION_PROPOSAL_NOT_FOUND" });
      const updatedAt = isoNow(now);
      const row = await tx.completeExecutionProposal(id, owner, { status, paperOrderId: orderId, result: safe, updatedAt });
      if (!row) throw AppError.conflict("Paper submission result could not be attached to its proposal", { code: "PAPER_SUBMISSION_STATE_CHANGED" });
      await tx.recordAudit({
        actorId: owner,
        action: status === "PAPER_REJECTED" ? "execution.paper-submission.rejected" : "execution.paper-submission.completed",
        entityType: "execution_proposal",
        entityId: id,
        details: { accountId: Number(proposal.account_id), paperOrderId: orderId, paperStatus: paperResult?.order?.status ?? null, summary: `Paper-only proposal submission finished as ${status}` },
      });
      const intent = proposal.intent ?? {};
      if (status === "PAPER_REJECTED") {
        pending.push({
          type: "EXECUTION_FAILED",
          severity: "critical",
          title: `Paper risk/governance rejected ${intent.symbol ?? id}`,
          detail: {
            proposalId: id,
            accountId: Number(proposal.account_id),
            paperOrderId: orderId,
            rejectReasons: safe.order?.rejectReasons ?? [],
            riskReasons: safe.riskDecision?.reasons ?? [],
          },
          dedupeKey: `proposal:${id}:rejected`,
        });
      } else if (status === "PAPER_EXECUTED") {
        pending.push({
          type: "ORDER_FILLED",
          severity: "info",
          title: `Filled ${intent.side ?? ""} ${intent.symbol ?? id} (paper)`.trim(),
          detail: { proposalId: id, accountId: Number(proposal.account_id), paperOrderId: orderId, simulationOnly: true },
          dedupeKey: `proposal:${id}:filled`,
        });
      } else {
        pending.push({
          type: "ORDER_FILLED",
          severity: "info",
          title: `Paper order accepted and pending: ${intent.symbol ?? id}`,
          detail: { proposalId: id, accountId: Number(proposal.account_id), paperOrderId: orderId, status: "PAPER_PENDING", simulationOnly: true },
          dedupeKey: `proposal:${id}:pending`,
        });
      }
      return row;
    });
    await publishPending(pending[0] ?? null);
    return { proposal: proposalView(completed), paper: safe };
  }

  async function simulatorPreflight(owner, proposal) {
    const intent = proposal.intent ?? {};
    const checks = [];
    const addSimulatorCheck = (check, ok, detail) => checks.push({ step: SIMULATOR_PIPELINE_STEPS[check] ?? 10, check, ok, detail });
    const fail = (check, detail, code) => {
      addSimulatorCheck(check, false, detail);
      throw AppError.conflict(detail, { code, details: { checks: structuredClone(checks) } });
    };
    if (!brokers || typeof brokers.simulationConnector !== "function") {
      throw AppError.unavailable("The in-process broker simulator is unavailable", { code: "SIMULATOR_DISABLED", retryAfter: 30 });
    }
    const connector = brokers.simulationConnector();
    if (!connector) throw AppError.unavailable("The in-process broker simulator is disabled", { code: "SIMULATOR_DISABLED", retryAfter: 30 });
    if (typeof store.loadTradingState !== "function") {
      throw AppError.unavailable("Persisted trading governance is unavailable", { code: "TRADING_STATE_UNAVAILABLE", retryAfter: 30 });
    }
    const state = normalizeTradingState(await store.loadTradingState());
    const killSwitchClear = state.killSwitch.active === false;
    addSimulatorCheck("kill-switch", killSwitchClear, killSwitchClear ? "kill switch is released" : "kill switch is active");
    if (!killSwitchClear) fail("kill-switch", "The kill switch must be released", "EXECUTION_GOVERNANCE_BLOCKED");

    const modeAllowed = state.tradingMode === "PAPER_TRADING" && state.executionMode === "HUMAN_APPROVAL";
    addSimulatorCheck("trading-mode", modeAllowed, modeAllowed
      ? "PAPER_TRADING and HUMAN_APPROVAL are active"
      : "the simulator proposal route requires PAPER_TRADING and HUMAN_APPROVAL; automated modes remain Paper Trading requests only");
    if (!modeAllowed) fail("trading-mode", "The simulated broker requires PAPER_TRADING and HUMAN_APPROVAL mode", "EXECUTION_GOVERNANCE_BLOCKED");

    let strategyDetail = "discretionary intent; strategy approval is not required, but human approval is";
    if (intent.strategyId) {
      const strategy = await store.findStrategy(intent.strategyId, intent.strategyVersion);
      const implementation = requireStrategyRegistry().implementation(intent.strategyId, intent.strategyVersion);
      const strategyAllowed = strategy && implementation && strategy.lifecycle === "APPROVED"
        && (strategy.source !== "ai" || strategy.human_signoff === true);
      strategyDetail = strategyAllowed
        ? `${intent.strategyId}@${intent.strategyVersion} remains executable and APPROVED`
        : `${intent.strategyId}@${intent.strategyVersion} is not an executable approved strategy version`;
      addSimulatorCheck("strategy", Boolean(strategyAllowed), strategyDetail);
      if (!strategyAllowed) fail("strategy", strategyDetail, "SIMULATOR_STRATEGY_NOT_APPROVED");
    } else {
      addSimulatorCheck("strategy", true, strategyDetail);
    }

    const paperAccount = await store.findPaperAccount(proposal.account_id, owner);
    if (!paperAccount) throw AppError.notFound("Execution proposal not found", { code: "EXECUTION_PROPOSAL_NOT_FOUND" });

    let status;
    let account;
    let quote;
    let positions;
    let pendingOrders;
    let history;
    try {
      status = await connector.status();
      account = await connector.account();
      quote = await connector.quote(intent.symbol);
      positions = await connector.positions();
      pendingOrders = await connector.pendingOrders();
      history = await connector.history(500);
    } catch {
      throw AppError.unavailable("The in-process broker simulator could not complete its read checks", { code: "SIMULATOR_READ_FAILED", retryAfter: 5 });
    }
    const bridgeReady = status?.state === "READY" && status?.simulated === true && status?.orderSubmissionEffective === true;
    addSimulatorCheck("broker-connection", bridgeReady, bridgeReady
      ? "simulated demo bridge is READY and order submission is enabled"
      : "simulator must be READY with its separate order-submission flag enabled");
    if (!bridgeReady) fail("broker-connection", "The simulated broker is not ready for order submission", "SIMULATOR_ORDERING_DISABLED");

    const at = now();
    const marketOpen = simulatedMarketSessionOpen(intent.marketClass, at);
    addSimulatorCheck("market-open", marketOpen, marketOpen ? `${intent.marketClass} simulator session is open` : `${intent.marketClass} market session is closed or unsupported by the simulator`);
    if (!marketOpen) fail("market-open", "The simulated market session is closed", "SIMULATOR_MARKET_CLOSED");

    const quoteAt = Date.parse(quote.timestamp);
    const freshnessLimit = intent.marketClass === "crypto" ? 120_000 : intent.marketClass === "forex" ? 300_000 : 600_000;
    const fresh = Number.isFinite(quoteAt) && quoteAt <= at + 30_000 && at - quoteAt <= freshnessLimit;
    addSimulatorCheck("data-freshness", fresh, fresh
      ? `simulated quote is within the ${Math.floor(freshnessLimit / 1000)}-second ${intent.marketClass} freshness window`
      : `simulated quote is stale or has an invalid timestamp (limit ${Math.floor(freshnessLimit / 1000)} seconds)`);
    if (!fresh) fail("data-freshness", "The simulated quote is stale or invalid", "SIMULATOR_QUOTE_STALE");

    const duplicate = positions.some((row) => row.symbol === intent.symbol) || pendingOrders.some((row) => row.symbol === intent.symbol);
    addSimulatorCheck("duplicate-orders", !duplicate, duplicate ? `a position or pending order already exists for ${intent.symbol}` : "no simulated position or pending order exists for this symbol");
    if (duplicate) fail("duplicate-orders", `A simulated position or pending order already exists for ${intent.symbol}`, "SIMULATOR_DUPLICATE_SYMBOL");

    const symbolIsProvided = quote.symbol === intent.symbol && ["forex", "crypto", "commodity"].includes(intent.marketClass);
    const approvedSymbols = state.automationLimits.approvedSymbols;
    const symbolOnAutomationList = approvedSymbols.includes(intent.symbol);
    const symbolAllowed = symbolIsProvided;
    const permissionDetail = !symbolAllowed
      ? `${intent.symbol} is not enabled for this simulator market class`
      : approvedSymbols.length === 0
        ? `${intent.symbol} is simulator-supported; no automation allowlist is configured and human approval governs`
        : symbolOnAutomationList
          ? `${intent.symbol} is simulator-supported and appears on the automation allowlist`
          : `${intent.symbol} is simulator-supported; the human-approved proposal allows a symbol outside the automation allowlist`;
    addSimulatorCheck("symbol-permissions", symbolAllowed, permissionDetail);
    if (!symbolAllowed) fail("symbol-permissions", permissionDetail, "SIMULATOR_SYMBOL_NOT_ALLOWED");

    const entry = intent.type === "LIMIT" ? Number(intent.price) : (intent.side === "BUY" ? quote.ask : quote.bid);
    const stopLoss = Number(intent.stopLoss);
    const stopDistance = Math.abs(entry - stopLoss);
    const targetPrice = intent.takeProfit === null || intent.takeProfit === undefined
      ? (intent.side === "BUY" ? entry + stopDistance * 2 : entry - stopDistance * 2)
      : Number(intent.takeProfit);
    const protectionValid = Number.isFinite(entry) && entry > 0 && Number.isFinite(stopDistance) && stopDistance > 0
      && Number.isFinite(targetPrice) && targetPrice > 0
      && (intent.side === "BUY" ? stopLoss < entry && targetPrice > entry : stopLoss > entry && targetPrice < entry);
    if (!protectionValid) fail("risk-engine", "Stop loss and take profit must protect the selected simulated entry", "SIMULATOR_INVALID_PROTECTION");

    const riskCap = state.riskLimits.maxRiskPerTradePct;
    const requestedRiskPct = intent.riskPct === null || intent.riskPct === undefined ? state.riskLimits.riskPerTradePct : intent.riskPct;
    // A small headroom accounts for the simulator/paper stores' six-decimal unit
    // precision so independent risk checking cannot fail from a rounding sliver.
    const effectiveRiskPct = Math.min(requestedRiskPct, riskCap) * 0.99;
    const maxNotional = state.riskLimits.maxPositionNotionalUsd;
    let volume = roundVolume(Math.min(account.equity * effectiveRiskPct / stopDistance, maxNotional / entry));
    if (!Number.isFinite(volume) || volume <= 0) fail("risk-engine", "Risk sizing did not produce a positive simulated order volume", "SIMULATOR_INVALID_SIZE");
    const notional = volume * entry;
    const leverage = Number(account.leverage);
    const requiredMargin = leverage > 0 ? notional / leverage : notional * 0.033;
    const marginAvailable = Number.isFinite(account.freeMargin) && requiredMargin <= account.freeMargin;
    addSimulatorCheck("margin", marginAvailable, marginAvailable
      ? `required simulated margin ${requiredMargin.toFixed(2)} is within free margin ${Number(account.freeMargin).toFixed(2)}`
      : `required simulated margin ${requiredMargin.toFixed(2)} exceeds free margin ${Number(account.freeMargin).toFixed(2)}`);
    if (!marginAvailable) fail("margin", "The simulated order exceeds free margin", "SIMULATOR_MARGIN_EXCEEDED");

    const openRiskBySymbol = {};
    for (const row of positions) {
      if (Number.isFinite(Number(row.stopLoss))) {
        openRiskBySymbol[row.symbol] = (openRiskBySymbol[row.symbol] ?? 0)
          + Math.abs(Number(row.entry) - Number(row.stopLoss)) * Number(row.volume);
      }
    }
    const today = new Date(at).toISOString().slice(0, 10);
    const weekCutoff = at - 7 * 86_400_000;
    let dailyPnl = 0;
    let weeklyPnl = 0;
    for (const row of history) {
      const closedAt = Date.parse(row.closedAt);
      if (!Number.isFinite(closedAt)) continue;
      if (new Date(closedAt).toISOString().slice(0, 10) === today) dailyPnl += Number(row.profit || 0);
      if (closedAt >= weekCutoff) weeklyPnl += Number(row.profit || 0);
    }
    const allowSynthetic = state.allowSyntheticPaperData && state.riskLimits.blockSyntheticData === false;
    const riskDecision = createRiskEngine(state.riskLimits).evaluate({
      symbol: intent.symbol,
      action: intent.side,
      entry: { reference: entry, min: quote.bid, max: quote.ask },
      stopLoss,
      takeProfit: targetPrice,
      riskReward: Math.abs(targetPrice - entry) / stopDistance,
      marketClass: intent.marketClass,
    }, {
      killSwitchActive: state.killSwitch.active,
      syntheticData: true,
      staleData: !fresh,
      dataQuality: 1,
      equity: account.equity,
      givenUnits: volume,
      openRiskBySymbol,
      openPositions: positions.length,
      openSymbols: positions.map((row) => row.symbol),
      dailyPnl,
      weeklyPnl,
      peakEquity: account.equity,
    });
    const approved = allowSynthetic && riskDecision.approved;
    addSimulatorCheck("risk-engine", approved, allowSynthetic
      ? (riskDecision.approved ? "Risk Engine approved the simulated order" : riskDecision.reasons.join("; "))
      : "synthetic broker data requires synthetic-paper permission and blockSyntheticData=false");
    if (!approved) {
      throw AppError.conflict("The simulated order was refused by Paper Trading governance or the Risk Engine", {
        code: "SIMULATOR_RISK_REJECTED",
        details: { checks: structuredClone(checks), reasons: riskDecision.reasons },
      });
    }

    return {
      connector,
      state,
      account,
      quote,
      positions,
      pendingOrders,
      intent: { ...intent, takeProfit: targetPrice },
      entry,
      volume,
      effectiveRiskPct,
      requiredMargin,
      riskDecision,
      checks,
    };
  }

  async function submitToSimulator(ownerUserId, proposalId) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    const id = requireProposalId(proposalId);
    if (!store || typeof store.acquireJobLock !== "function" || typeof store.releaseJobLock !== "function") {
      throw AppError.unavailable("The simulated broker route requires persisted execution locking", { code: "SIMULATOR_LOCK_UNAVAILABLE", retryAfter: 30 });
    }
    const existing = await store.findExecutionProposal(id, owner);
    if (!existing || !(await store.findPaperAccount(existing.account_id, owner))) {
      throw AppError.notFound("Execution proposal not found", { code: "EXECUTION_PROPOSAL_NOT_FOUND" });
    }
    if (existing.status !== "APPROVED") {
      throw AppError.conflict(`Proposal is ${existing.status}; only APPROVED proposals can be sent to the simulator`, { code: "SIMULATOR_SUBMISSION_NOT_APPROVED" });
    }

    const lockName = "execution-simulated-broker";
    const holder = `${process.pid}@simulator#${randomUUID()}`;
    const acquiredAt = isoNow(now);
    const lock = await store.acquireJobLock(lockName, {
      holder,
      nowIso: acquiredAt,
      expiresAt: new Date(now() + 5 * 60_000).toISOString(),
    });
    if (!lock?.acquired) {
      throw AppError.conflict("Another simulated broker order is currently being processed", {
        code: "SIMULATOR_BUSY",
        details: { reason: lock?.reason ?? "lock held" },
      });
    }

    const submittingStatus = "SIMULATOR_SUBMITTING";
    let claimed = null;
    let orderWasSubmitted = false;
    let preflight = null;
    try {
      preflight = await simulatorPreflight(owner, existing);
      claimed = await store.withPaperTransaction(async (tx) => {
        const proposal = await tx.findExecutionProposal(id, owner);
        if (!proposal || proposal.status !== "APPROVED") {
          throw AppError.conflict("Proposal changed before simulator submission", { code: "SIMULATOR_SUBMISSION_STATE_CHANGED" });
        }
        const account = await tx.findPaperAccount(proposal.account_id, owner);
        if (!account) throw AppError.notFound("Execution proposal not found", { code: "EXECUTION_PROPOSAL_NOT_FOUND" });
        const current = normalizeTradingState(await tx.loadTradingState());
        if (current.killSwitch.active || current.tradingMode !== "PAPER_TRADING" || current.executionMode !== "HUMAN_APPROVAL") {
          throw AppError.conflict("Simulator submission is blocked by current trading governance", { code: "EXECUTION_GOVERNANCE_BLOCKED" });
        }
        const humanApproved = proposal.status === "APPROVED"
          && proposal.decision_by_user_id !== null && proposal.decision_by_user_id !== undefined
          && String(proposal.decision_reason ?? "").trim().length >= 10;
        preflight.checks.push({
          step: SIMULATOR_PIPELINE_STEPS["human-approval"],
          check: "human-approval",
          ok: humanApproved,
          detail: humanApproved ? `approved by user ${proposal.decision_by_user_id}: ${proposal.decision_reason}` : "a persisted human decision and approval reason are required",
        });
        if (!humanApproved) {
          throw AppError.conflict("Simulator routing requires a separately persisted human approval", {
            code: "SIMULATOR_HUMAN_APPROVAL_REQUIRED",
            details: { checks: structuredClone(preflight.checks) },
          });
        }
        const updatedAt = isoNow(now);
        const row = await tx.claimExecutionProposal(id, owner, updatedAt, { submittingStatus });
        if (!row) throw AppError.conflict("Proposal is already being submitted or has changed state", { code: "SIMULATOR_SUBMISSION_ALREADY_CLAIMED" });
        await tx.recordAudit({
          actorId: owner,
          action: "execution.simulated-broker.started",
          entityType: "execution_proposal",
          entityId: id,
          details: { accountId: Number(proposal.account_id), symbol: preflight.intent.symbol, broker: "simulated-mt5", simulationOnly: true, summary: "Approved proposal claimed for one in-process simulated broker submission" },
        });
        return proposal;
      });

      let order;
      try {
        order = await preflight.connector.placeOrder({
          symbol: preflight.intent.symbol,
          side: preflight.intent.side,
          type: preflight.intent.type,
          price: preflight.intent.type === "LIMIT" ? preflight.entry : null,
          volume: preflight.volume,
          stopLoss: preflight.intent.stopLoss,
          takeProfit: preflight.intent.takeProfit,
        });
      } catch (error) {
        preflight.checks.push({ step: SIMULATOR_PIPELINE_STEPS["order-placement"], check: "order-placement", ok: false, detail: String(error?.message ?? "simulator refused order").slice(0, 240) });
        throw error;
      }
      orderWasSubmitted = true;
      preflight.checks.push({ step: SIMULATOR_PIPELINE_STEPS["order-placement"], check: "order-placement", ok: true, detail: `simulated broker accepted order ticket ${order.ticket}` });

      const observed = preflight.intent.type === "LIMIT"
        ? await preflight.connector.pendingOrders()
        : await preflight.connector.positions();
      const confirmed = observed.find((row) => Number(row.ticket) === Number(order.ticket));
      preflight.checks.push({
        step: SIMULATOR_PIPELINE_STEPS["execution-confirmation"],
        check: "execution-confirmation",
        ok: Boolean(confirmed),
        detail: confirmed ? `ticket ${order.ticket} is visible in simulated ${preflight.intent.type === "LIMIT" ? "pending orders" : "positions"}` : `ticket ${order.ticket} was not found in simulated account state`,
      });
      if (!confirmed) {
        throw AppError.conflict("Simulator acknowledged the order but did not confirm it in its account state", {
          code: "SIMULATOR_CONFIRMATION_FAILED",
          details: { checks: structuredClone(preflight.checks) },
        });
      }

      await store.withPaperTransaction(async (tx) => {
        await tx.recordAudit({
          actorId: owner,
          action: "execution.simulated-broker.order-confirmed",
          entityType: "execution_proposal",
          entityId: id,
          details: { ticket: Number(order.ticket), symbol: preflight.intent.symbol, side: preflight.intent.side, simulationOnly: true, summary: "In-process simulator order was placed and confirmed" },
        });
      });
      preflight.checks.push({ step: SIMULATOR_PIPELINE_STEPS["audit-log"], check: "audit-log", ok: true, detail: "simulator order placement and confirmation were durably audited" });

      let portfolioAfter;
      try {
        const [accountAfter, positionsAfter, pendingAfter] = await Promise.all([
          preflight.connector.account(),
          preflight.connector.positions(),
          preflight.connector.pendingOrders(),
        ]);
        portfolioAfter = {
          accountId: accountAfter.accountId,
          balance: accountAfter.balance,
          equity: accountAfter.equity,
          margin: accountAfter.margin,
          freeMargin: accountAfter.freeMargin,
          openPositions: positionsAfter.length,
          pendingOrders: pendingAfter.length,
        };
        preflight.checks.push({ step: SIMULATOR_PIPELINE_STEPS["portfolio-update"], check: "portfolio-update", ok: true, detail: "post-order simulated account and portfolio counts were refreshed" });
      } catch (error) {
        portfolioAfter = { warning: "simulated order is confirmed; post-trade portfolio snapshot is unavailable" };
        preflight.checks.push({ step: SIMULATOR_PIPELINE_STEPS["portfolio-update"], check: "portfolio-update", ok: false, detail: String(error?.message ?? "post-trade snapshot unavailable").slice(0, 240) });
      }

      const completedAt = isoNow(now);
      const status = preflight.intent.type === "LIMIT" ? "SIMULATOR_PENDING" : "SIMULATOR_EXECUTED";
      const result = {
        broker: "simulated-mt5",
        ticket: Number(order.ticket),
        volume: preflight.volume,
        price: Number(order.price),
        type: preflight.intent.type,
        side: preflight.intent.side,
        symbol: preflight.intent.symbol,
        confirmed: true,
        simulationOnly: true,
        liveTradingEnabled: false,
        effectiveRiskPct: preflight.effectiveRiskPct,
        requiredMargin: preflight.requiredMargin,
        checks: preflight.checks,
        riskDecision: {
          approved: preflight.riskDecision.approved,
          reasons: preflight.riskDecision.reasons,
          warnings: preflight.riskDecision.warnings,
        },
        portfolioAfter,
        executedAt: completedAt,
      };
      const completed = await store.withPaperTransaction(async (tx) => {
        const row = await tx.completeExecutionProposal(id, owner, {
          status,
          paperOrderId: null,
          result,
          updatedAt: completedAt,
          submittingStatus,
        });
        if (!row) throw AppError.conflict("Simulator result could not be attached to its proposal", { code: "SIMULATOR_SUBMISSION_STATE_CHANGED" });
        await tx.recordAudit({
          actorId: owner,
          action: "execution.simulated-broker.completed",
          entityType: "execution_proposal",
          entityId: id,
          details: { accountId: Number(row.account_id), symbol: result.symbol, side: result.side, ticket: result.ticket, volume: result.volume, status, simulationOnly: true, summary: `In-process simulated order confirmed as ${status}` },
        });
        return row;
      });
      return { proposal: proposalView(completed), execution: result, simulationOnly: true, liveTradingEnabled: false };
    } catch (error) {
      const failure = {
        code: String(error?.code ?? "SIMULATOR_SUBMISSION_FAILED").slice(0, 80),
        message: String(error?.message ?? "Simulator submission failed").slice(0, 300),
        checks: structuredClone(preflight?.checks ?? error?.details?.checks ?? []),
        simulationOnly: true,
        liveTradingEnabled: false,
      };
      if (claimed) {
        try {
          await store.withPaperTransaction(async (tx) => {
            const row = await tx.completeExecutionProposal(id, owner, {
              status: "SIMULATOR_FAILED",
              paperOrderId: null,
              result: { ...failure, orderCreated: orderWasSubmitted },
              updatedAt: isoNow(now),
              submittingStatus,
            });
            if (row) await tx.recordAudit({
              actorId: owner,
              action: "execution.simulated-broker.failed",
              entityType: "execution_proposal",
              entityId: id,
              details: { accountId: Number(row.account_id), code: failure.code, summary: failure.message, simulationOnly: true },
            });
          });
        } catch (stateError) {
          log?.error?.({ err: stateError, proposalId: id }, "failed to persist simulated broker failure");
        }
      } else {
        await auditOutsideTransaction({
          actorId: owner,
          action: "execution.simulated-broker.blocked",
          entityType: "execution_proposal",
          entityId: id,
          details: { accountId: Number(existing.account_id), code: failure.code, symbol: existing.intent?.symbol ?? null, summary: failure.message, orderCreated: false, simulationOnly: true },
        });
      }
      throw error;
    } finally {
      try {
        const released = await store.releaseJobLock(lockName, holder);
        if (!released) log?.warn?.({ lockName }, "simulated broker lock was no longer owned at release");
      } catch (error) {
        log?.warn?.({ err: error, lockName }, "simulated broker lock could not be released");
      }
    }
  }

  async function automationConfig(ownerUserId) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    if (typeof store.loadTradingState !== "function") {
      throw AppError.unavailable("Persisted execution governance is unavailable", { code: "TRADING_STATE_UNAVAILABLE", retryAfter: 30 });
    }
    const state = normalizeTradingState(await store.loadTradingState());
    return {
      executionMode: state.executionMode,
      automationLimits: {
        ...state.automationLimits,
        approvedSymbols: [...state.automationLimits.approvedSymbols],
      },
      availableModes: [...EXECUTION_MODES],
      simulationOnly: true,
      liveTradingEnabled: false,
      actorUserId: owner,
    };
  }

  async function updateAutomationLimits(ownerUserId, patch = {}) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    const normalizedPatch = normalizeAutomationPatch(patch);
    const result = await store.withPaperTransaction(async (tx) => {
      const current = normalizeTradingState(await tx.loadTradingState());
      const limits = { ...current.automationLimits, ...normalizedPatch };
      if (limits.maxTradeNotionalUsd > current.riskLimits.maxPositionNotionalUsd) {
        throw AppError.conflict("maxTradeNotionalUsd cannot exceed the global paper maxPositionNotionalUsd", { code: "AUTOMATION_LIMIT_EXCEEDS_GOVERNANCE" });
      }
      if (limits.maxRiskPerTradePct > current.riskLimits.maxRiskPerTradePct) {
        throw AppError.conflict("maxRiskPerTradePct cannot exceed the global maxRiskPerTradePct", { code: "AUTOMATION_LIMIT_EXCEEDS_GOVERNANCE" });
      }
      const updatedAt = isoNow(now);
      const saved = await tx.saveTradingState({ ...current, automationLimits: { ...limits, updatedAt } }, { updatedByUserId: owner, updatedAt });
      const applied = normalizeTradingState(saved);
      await tx.recordAudit({
        actorId: owner,
        action: "governance.automation-limits.updated",
        entityType: "trading_governance",
        entityId: "global",
        details: { changed: Object.keys(normalizedPatch), automationLimits: applied.automationLimits },
      });
      return {
        automationLimits: { ...applied.automationLimits, approvedSymbols: [...applied.automationLimits.approvedSymbols] },
        updatedAt,
        simulationOnly: true,
        liveTradingEnabled: false,
      };
    });
    return result;
  }

  async function setExecutionMode(ownerUserId, mode) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    if (!EXECUTION_MODES.includes(mode)) {
      throw AppError.badRequest(`mode must be one of: ${EXECUTION_MODES.join(", ")}`, { code: "INVALID_EXECUTION_MODE" });
    }
    if (mode !== "HUMAN_APPROVAL") requirePaperService();
    return store.withPaperTransaction(async (tx) => {
      const current = normalizeTradingState(await tx.loadTradingState());
      if (mode !== "HUMAN_APPROVAL") {
        if (current.killSwitch.active || current.tradingMode !== "PAPER_TRADING") {
          throw AppError.conflict("Automated execution requires the kill switch released and PAPER_TRADING mode active", { code: "EXECUTION_AUTOMATION_GOVERNANCE_BLOCKED" });
        }
        if (current.automationLimits.approvedSymbols.length === 0 || !current.automationLimits.updatedAt) {
          throw AppError.conflict("Configure automation limits and at least one approved symbol before enabling an automated mode", { code: "EXECUTION_AUTOMATION_NOT_CONFIGURED" });
        }
      }
      const changed = current.executionMode !== mode;
      const updatedAt = isoNow(now);
      const saved = await tx.saveTradingState({ ...current, executionMode: mode }, { updatedByUserId: owner, updatedAt });
      const applied = normalizeTradingState(saved);
      await tx.recordAudit({
        actorId: owner,
        action: "governance.execution-mode.changed",
        entityType: "trading_governance",
        entityId: "global",
        details: { previous: current.executionMode, mode: applied.executionMode, changed, simulationOnly: true },
      });
      return {
        executionMode: applied.executionMode,
        changed,
        updatedAt,
        automationLimits: { ...applied.automationLimits, approvedSymbols: [...applied.automationLimits.approvedSymbols] },
        simulationOnly: true,
        liveTradingEnabled: false,
      };
    });
  }

  async function executeAutomated(ownerUserId, input = {}) {
    requireStore();
    requirePaperService();
    const owner = actorIdOf(ownerUserId);
    const accountId = positiveId(input.accountId, "accountId");
    const intent = normalizeIntent(input);
    if (!intent.strategyId || !intent.strategyVersion) {
      throw AppError.badRequest("Automated execution requires an exact strategy id and version", { code: "EXECUTION_STRATEGY_REQUIRED" });
    }
    if (typeof store.loadTradingState !== "function" || typeof store.listAuditEvents !== "function"
      || typeof store.acquireJobLock !== "function" || typeof store.releaseJobLock !== "function") {
      throw AppError.unavailable("Automated execution requires persisted governance, audit and lock support", { code: "EXECUTION_AUTOMATION_STORE_UNAVAILABLE", retryAfter: 30 });
    }

    const lockName = `execution-automation-${owner}`;
    const holder = `${process.pid}@execution#${randomUUID()}`;
    const acquiredAt = isoNow(now);
    const lock = await store.acquireJobLock(lockName, {
      holder,
      nowIso: acquiredAt,
      expiresAt: new Date(now() + 5 * 60_000).toISOString(),
    });
    if (!lock?.acquired) {
      throw AppError.conflict("Another automated execution is already in progress for this user", {
        code: "EXECUTION_AUTOMATION_BUSY",
        details: { reason: lock?.reason ?? "lock held" },
      });
    }

    try {
      const state = normalizeTradingState(await store.loadTradingState());
      if (state.executionMode === "HUMAN_APPROVAL") {
        throw AppError.conflict("Automated execution is disabled while HUMAN_APPROVAL mode is active", { code: "EXECUTION_AUTOMATION_DISABLED" });
      }
      if (state.killSwitch.active || state.tradingMode !== "PAPER_TRADING") {
        throw AppError.conflict("Automated execution is blocked by current trading governance", { code: "EXECUTION_AUTOMATION_GOVERNANCE_BLOCKED" });
      }
      const limits = state.automationLimits;
      if (!limits.updatedAt || limits.approvedSymbols.length === 0) {
        throw AppError.conflict("Automation limits and approved symbols are not configured", { code: "EXECUTION_AUTOMATION_NOT_CONFIGURED" });
      }
      if (!limits.approvedSymbols.includes(intent.symbol)) {
        throw AppError.conflict(`${intent.symbol} is not on the automation approved-symbol list`, { code: "EXECUTION_SYMBOL_NOT_APPROVED" });
      }
      const account = await store.findPaperAccount(accountId, owner);
      if (!account) throw AppError.notFound("Paper account not found", { code: "PAPER_ACCOUNT_NOT_FOUND" });
      const strategy = await store.findStrategy(intent.strategyId, intent.strategyVersion);
      const implementation = requireStrategyRegistry().implementation(intent.strategyId, intent.strategyVersion);
      if (!strategy || !implementation || strategy.lifecycle !== "APPROVED" || (strategy.source === "ai" && !strategy.human_signoff)) {
        throw AppError.conflict("Automated execution requires an executable, approved strategy version with any required human sign-off", { code: "EXECUTION_STRATEGY_NOT_APPROVED" });
      }

      const { from, to } = utcDayBounds(now);
      const daily = await store.listAuditEvents({
        userId: owner,
        action: "execution.automation.completed",
        from,
        to,
        limit: 1,
      });
      if (Number(daily?.total ?? 0) >= limits.maxDailyTrades) {
        throw AppError.conflict("The configured maximum number of automated paper orders for today has been reached", { code: "EXECUTION_DAILY_LIMIT_REACHED" });
      }

      const hardRiskCap = Math.min(limits.maxRiskPerTradePct, state.riskLimits.maxRiskPerTradePct);
      // Paper sizing rounds volume to six decimals and risk to cents. Leave a
      // small headroom so that rounding cannot turn a mathematically-at-cap order
      // into one that exceeds the independent RiskEngine veto by a fraction.
      const effectiveRiskPct = Math.min(intent.riskPct ?? hardRiskCap, hardRiskCap) * 0.99;
      const paperResult = await paper.submitOrder(owner, accountId, {
        symbol: intent.symbol,
        marketClass: intent.marketClass,
        side: intent.side,
        type: intent.type,
        price: intent.price,
        stopLoss: intent.stopLoss,
        takeProfit: intent.takeProfit,
        riskPct: effectiveRiskPct,
        reason: intent.reason ?? `automated ${state.executionMode.toLowerCase()} strategy ${intent.strategyId}@${intent.strategyVersion}`,
        confidence: intent.confidence,
        strategy: intent.strategyId,
        strategyVersion: intent.strategyVersion,
      }, {
        actorId: owner,
        constraints: {
          maxTradeNotionalUsd: limits.maxTradeNotionalUsd,
          maxRiskPerTradePct: effectiveRiskPct,
          automation: {
            executionMode: state.executionMode,
            automationLimitsUpdatedAt: limits.updatedAt,
            strategyId: intent.strategyId,
            strategyVersion: intent.strategyVersion,
          },
        },
      });
      const safe = safePaperResult(paperResult);
      const status = paperResult?.order?.status === "REJECTED" ? "REJECTED"
        : paperResult?.filled ? "PAPER_EXECUTED" : "PAPER_PENDING";
      return {
        status,
        executionMode: state.executionMode,
        accountId,
        symbol: intent.symbol,
        strategyId: intent.strategyId,
        strategyVersion: intent.strategyVersion,
        effectiveRiskPct,
        automationLimits: {
          maxDailyTrades: limits.maxDailyTrades,
          maxTradeNotionalUsd: limits.maxTradeNotionalUsd,
          maxRiskPerTradePct: limits.maxRiskPerTradePct,
          approvedSymbols: [...limits.approvedSymbols],
        },
        paper: safe,
        simulationOnly: true,
        liveTradingEnabled: false,
      };
    } catch (error) {
      await auditOutsideTransaction({
        actorId: owner,
        action: "execution.automation.blocked",
        entityType: "trading_governance",
        entityId: "global",
        details: {
          code: String(error?.code ?? "EXECUTION_AUTOMATION_FAILED").slice(0, 80),
          symbol: intent.symbol,
          strategyId: intent.strategyId,
          strategyVersion: intent.strategyVersion,
          summary: String(error?.message ?? "Automated paper execution was blocked").slice(0, 240),
          orderCreated: false,
          simulationOnly: true,
        },
      });
      throw error;
    } finally {
      try {
        const released = await store.releaseJobLock(lockName, holder);
        if (!released) log?.warn?.({ lockName }, "automated execution lock was no longer owned at release");
      } catch (error) {
        log?.warn?.({ err: error, lockName }, "automated execution lock could not be released");
      }
    }
  }

  function statusSnapshot() {
    return {
      enabled: Boolean(store && typeof store.findExecutionProposal === "function" && typeof store.withPaperTransaction === "function"),
      scope: "human-reviewed proposals through Paper Trading or the explicit in-process broker simulator; request-based governed automation through Paper Trading only",
      simulationOnly: true,
      paperSubmissionAvailable: Boolean(paper && typeof paper.submitOrder === "function"),
      liveTradingEnabled: false,
      // This means a real provider-verified broker connector, not the isolated
      // process-local simulator. Keep it false here: the authoritative real-bridge
      // health answer is `routable` on the authenticated Broker Center surface.
      brokerConnectorAvailable: false,
      brokerConnectorsConfigured: configuredConnectorCount(brokers),
      simulatedBrokerAvailable: typeof brokers?.simulationStatus === "function" && brokers.simulationStatus().enabled === true,
      simulatedOrderRoutingEnabled: typeof brokers?.simulationStatus === "function" && brokers.simulationStatus().ordersEnabled === true,
      automatedModesAvailable: Boolean(paper && typeof paper.submitOrder === "function" && store && typeof store.withPaperTransaction === "function"),
      availableModes: [...EXECUTION_MODES],
      automationScope: "request-based Paper Trading only; no unattended strategy loop and no live-money route",
      simulatorSubmissionScope: "separate human-approved proposals only; process-local simulated MT5 bridge; no live broker routing",
      approvalRequired: true,
      proposalExpiryMinutes: MAX_PROPOSAL_AGE_MS / 60_000,
    };
  }

  return {
    propose,
    list,
    find,
    decide,
    submitToPaper,
    submitToSimulator,
    automationConfig,
    updateAutomationLimits,
    setExecutionMode,
    executeAutomated,
    expireStaleProposals,
    statusSnapshot,
  };
}
