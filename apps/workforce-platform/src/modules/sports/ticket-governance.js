/**
 * Ticket governance (row 14, slice 4): how an optimized ticket is recorded, and how a
 * person decides it. Legacy `Aegis\Sports\TicketGovernance`.
 *
 * This module builds the rows and checks the transitions. It does not write them, so the
 * same rules are used by both repository adapters, and the tests can exercise them
 * without a store.
 *
 * Two places where the port does not follow legacy, and why:
 *
 *  - **DV-22: no automated approval.** Legacy sets `status = APPROVED` and
 *    `approval_status = APPROVED_NOT_EXECUTED` when the engine mode is
 *    `AUTOMATED_EXECUTION`, with no person involved. Node always records a ticket as
 *    `PENDING_USER_APPROVAL`. The configuration already refuses `AUTOMATED_EXECUTION`
 *    (DV-14), so the legacy branch is not reachable from this host, and it is not ported.
 *    A ticket here is approved only by a named person, through `decideTicket`.
 *
 *  - **Legacy's `array_filter` quirk.** `array_filter($confidences)` drops every falsy
 *    value, which includes a confidence of exactly 0.0, not only null. The port keeps that
 *    behaviour, because the stored `confidence` must match what legacy would have stored.
 *
 *  - **DV-27: the stake is sized where legacy only copied it.** Legacy records
 *    `stake_amount` verbatim. The port records exactly the same value under the default
 *    `staking_method: "FLAT"` and adds the opt-in bounded `CONFIDENCE_SCALED` method
 *    (`stake-sizing.js`): `buildTicket` returns the sizing breakdown as a third key,
 *    which the repositories ignore and the service carries to the audit trail and the
 *    response. Nothing is executed either way.
 *
 * Nothing in this module reaches an execution, paper or broker path. A decision is a
 * record. `externalExecution` is always false.
 */
import { AppError } from "../../http/errors.js";
import { phpRound } from "../../lib/php.js";
import { classifySelections } from "./correlation.js";
import { sizeStake } from "./stake-sizing.js";

export const RISK_ORDER = Object.freeze({ LOW: 0, MEDIUM: 1, HIGH: 2 });
export const TICKET_APPROVAL_PENDING = "PENDING_USER_APPROVAL";
export const TICKET_APPROVED = "APPROVED_NOT_EXECUTED";
export const TICKET_REJECTED = "REJECTED";

/**
 * The ticket and its selections, as the storage layer receives them (camelCase, mapped to
 * columns by `sports-rows.js`). `optimized` is the output of `optimizeTicket` with a
 * ticket id already supplied.
 */
export function buildTicket(optimized, { configurationVersion, modelVersionId = null, config = {}, createdAt }) {
  const selections = optimized.selections;
  const confidences = selections.map((selection) => {
    const value = selection?.confidence?.confidence ?? null;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  });
  // array_filter drops falsy values, which includes 0.0 (see the module docblock).
  const usable = confidences.filter((value) => value !== null && value !== 0);

  let combined = 1.0;
  for (const selection of selections) {
    combined *= Number(selection?.prediction?.calibratedProbability ?? 0.5);
  }

  let risk = "LOW";
  for (const selection of selections) {
    const classification = selection?.risk?.classification ?? "HIGH";
    if (Object.hasOwn(RISK_ORDER, classification) && RISK_ORDER[classification] > RISK_ORDER[risk]) {
      risk = classification;
    }
  }

  const correlation = classifySelections(selections);
  const qualities = selections.map((selection) => Math.trunc(Number(selection?.quality?.score ?? 0)));
  const confidence = usable.length > 0 ? phpRound(Math.min(...usable), 2) : null;

  // DV-27 (Phase 48): the stake is sized by the configuration's `staking_method`, from
  // the same numbers this ticket stores (`confidence`, `risk`, `correlation`), so the
  // sizing is reconstructible from the ticket and its configuration version alone.
  // `FLAT` — the default — is exactly what legacy recorded here.
  const sizing = sizeStake(config, { confidence, risk, correlation: correlation.classification });

  return {
    sizing,
    ticket: {
      id: optimized.ticketId,
      createdAt,
      modelVersionId,
      configurationVersion,
      totalOdds: optimized.totalOdds,
      selectionCount: selections.length,
      combinedProbability: phpRound(combined, 8),
      confidence,
      risk,
      correlation: correlation.classification,
      dataQualityScore: Math.min(...qualities),
      status: "PENDING",
      approvalStatus: TICKET_APPROVAL_PENDING,
      settlementStatus: "PENDING",
      stake: sizing.stake,
      reason: null,
      optimizationScore: optimized.optimizationScore,
      poolSize: optimized.poolSize,
      decidedBy: null,
      decidedAt: null,
    },
    selections: selections.map((selection) => ({
      predictionId: selection.predictionId ?? "unlinked",
      matchId: Math.trunc(Number(selection.matchId)),
      market: selection.market ?? "UNSPECIFIED",
      selection: selection.selection ?? "UNSPECIFIED",
      odds: selection.value.odds,
      oddsTimestamp: selection.oddsTimestamp ?? createdAt,
      modelProbability: selection.prediction?.rawModelProbability ?? null,
      calibratedProbability: selection.prediction?.calibratedProbability ?? null,
      expectedValue: selection.value.expectedValue,
      risk: selection.risk.classification,
      result: null,
      status: "PENDING",
      correlationReasons: correlation.reasons,
    })),
  };
}

/**
 * The state a ticket moves to on a decision. Only a ticket still awaiting approval can be
 * decided, and it moves exactly once.
 */
export function decisionFor(ticket, { approve, actorId, reason = "", decidedAt }) {
  if (!ticket) throw AppError.notFound("No sports ticket with that id");
  if (ticket.approval_status !== TICKET_APPROVAL_PENDING) {
    throw new AppError(409, "SPORTS_TICKET_ALREADY_DECIDED",
      `This ticket is already ${ticket.approval_status}`);
  }
  return {
    approvalStatus: approve ? TICKET_APPROVED : TICKET_REJECTED,
    status: approve ? "APPROVED" : "CANCELLED",
    reason,
    decidedBy: actorId,
    decidedAt,
    externalExecution: false,
  };
}
