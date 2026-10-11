/**
 * Phase 8A: owner-scoped, human-reviewed execution proposals that can submit
 * only through the simulation-only Paper Trading service.
 *
 * This is intentionally not a port of the broader legacy broker supervisor. Market data,
 * account valuation, sizing and the complete RiskEngine decision are rerun by
 * `paper.submitOrder()` after approval. There is no broker dependency, live route,
 * automated mode or generic `/route` method in this module.
 */

import { randomUUID } from "node:crypto";
import { AppError } from "../../http/errors.js";
import { MARKET_CLASSES } from "../market-data/timeframes.js";
import { normalizeTradingState } from "../paper/service.js";

const MAX_PROPOSAL_AGE_MS = 4 * 60 * 60_000;
const PROPOSAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYMBOL = /^[A-Z0-9._-]{2,24}$/;
const STRATEGY_ID = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const VERSION = /^[A-Za-z0-9._-]{1,20}$/;

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

export function createExecutionService({ store = null, paper = null, strategies = null, notifications = null, log = null, now = () => Date.now() } = {}) {
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

  async function expireInTransaction(tx, owner, proposal, pendingNotifications = []) {
    const current = await tx.findExecutionProposal(proposal.id, owner);
    if (!current || current.status !== "PENDING_APPROVAL" || !isProposalStale(current)) return false;
    const account = await tx.findPaperAccount(current.account_id, owner);
    if (!account) return false;
    const updatedAt = isoNow(now);
    const expired = await tx.expireExecutionProposal(current.id, owner, updatedAt);
    if (!expired) return false;
    await tx.recordAudit({
      actorId: owner,
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

  function statusSnapshot() {
    return {
      enabled: Boolean(store && typeof store.findExecutionProposal === "function" && typeof store.withPaperTransaction === "function"),
      scope: "human-reviewed paper proposals only",
      simulationOnly: true,
      paperSubmissionAvailable: Boolean(paper && typeof paper.submitOrder === "function"),
      liveTradingEnabled: false,
      brokerConnectorAvailable: false,
      automatedModesAvailable: false,
      approvalRequired: true,
      proposalExpiryMinutes: MAX_PROPOSAL_AGE_MS / 60_000,
    };
  }

  return { propose, list, find, decide, submitToPaper, statusSnapshot };
}
