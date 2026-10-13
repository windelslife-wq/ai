/**
 * Ticket settlement and result verification services — the ports of legacy
 * `Aegis\Sports\TicketSettlementService` and `Aegis\Sports\PersistedResultVerifier`
 * (row 14, slice 5).
 *
 * Settlement settles ONLY from verified persisted provider results. A result a
 * provider reported is a claim; the verify step attests to it (`verifySportsResult`
 * sets the flag and stamps the time, with `sports.settle` permission and an audit
 * event naming the actor); settlement then reads only attested rows.
 *
 * VOID handling is configurable through the active configuration's `void_policy`,
 * exactly as legacy reads it at finalize time:
 *
 *  - `RESTITUTE_ODDS` (default): a VOID/CANCELLED leg is refunded — its odds count as
 *    1.0 in the effective product. The ticket wins at the reduced effective odds when
 *    every non-void leg wins; an all-void ticket is VOID.
 *  - `ALL_VOID_ONLY`: the void leg's odds still count (the ticket is VOID only when
 *    every leg is void). Ported as written, including this asymmetry: the policy
 *    changes only whether void legs' odds are skipped in the effective product.
 *
 * P/L accounting is stake-based and PAPER ONLY: WON → +stake×(effectiveOdds−1),
 * LOST → −stake, VOID/CANCELLED → 0. It is evidence about the model, computed on the
 * configured fixed stake. No stake is sized, no account is debited, nothing is
 * executed, and no paper, execution or broker row is touched.
 *
 * One legacy behaviour is ported as written and is worth naming: `finalizeTicket`
 * overwrites the ticket's `reason` — with `waiting on unverified results` while any
 * leg is undecided, then with NULL once settled. A settled ticket therefore loses the
 * decision reason it was recorded with. The decision itself remains in the audit trail
 * (`sports.ticket.approved` / `sports.ticket.rejected`), which is why the overwrite is
 * survivable; it is recorded as a preserved quirk (Q-4), not an improvement to make.
 */

import { AppError } from "../../http/errors.js";
import { assertTicketId } from "../../persistence/sports-rows.js";
import { verifyResult, settleSelection } from "./result-verification.js";
import { VOID_POLICY_DEFAULT } from "../../persistence/sports-rows.js";

/** The statuses whose tickets `settlePending` reports as already decided. */
const FINAL_STATUSES = ["WON", "LOST", "VOID", "CANCELLED"];

export function createSettlementService({ store = null, now = () => Date.now() } = {}) {
  const requireStore = () => {
    if (!store) {
      throw new AppError(503, "SPORTS_PERSISTENCE_UNAVAILABLE",
        "This host has no sports repository, so results cannot be verified or tickets settled");
    }
    return store;
  };
  const nowIso = () => new Date(now()).toISOString();
  const nowDate = () => new Date(now());

  /** Parse a caller's ticket id, or report it as not found. A malformed id cannot exist. */
  function ticketIdOrNotFound(id) {
    try {
      return assertTicketId(id);
    } catch {
      throw AppError.notFound("No sports ticket with that id");
    }
  }

  /**
   * The PersistedResultVerifier port: attest to one stored provider result.
   *
   * The verdict is computed from the stored row FORCED to `verified: true` — this is
   * the step that SETS the flag, so the engine is asked "would this be a valid final
   * result if attested?". A row that fails the shape check (not FINISHED, or scores
   * missing/negative) is refused with 409 and the attestation is not written.
   *
   * @param {{matchId: number, providerId: number, actorId: string|null}} input
   */
  async function verifyStoredResult({ matchId, providerId, actorId = null }) {
    const repository = requireStore();
    const stored = await repository.findSportsResult(matchId, providerId).catch(() => null);
    if (!stored) throw AppError.notFound("provider result not found");
    const candidate = {
      // The attestation is the act: the caller vouches for the report's truth, and
      // this method checks only that the report is well-formed enough to vouch for.
      verified: true,
      status: stored.status,
      homeScore: stored.home_score === null || stored.home_score === undefined ? null : Number(stored.home_score),
      awayScore: stored.away_score === null || stored.away_score === undefined ? null : Number(stored.away_score),
    };
    const verdict = verifyResult(candidate, nowDate());
    if (!verdict.verified) {
      throw new AppError(409, "RESULT_NOT_VERIFIABLE", verdict.reason ?? "RESULT_UNVERIFIED");
    }
    const verifiedRow = await repository.verifySportsResult(stored.id, nowIso());
    await repository.recordAudit({
      actorId,
      action: "sports.result.verified",
      entityType: "sports_result",
      entityId: String(stored.id),
      details: {
        resultId: stored.id,
        matchId: Number(matchId),
        providerId: Number(providerId),
        terminalStatus: verdict.terminalStatus,
        homeScore: verdict.homeScore ?? null,
        awayScore: verdict.awayScore ?? null,
      },
    });
    return { result: verifiedRow, verdict };
  }

  /**
   * Settle one selection's match from the stored (and separately verified) provider
   * result. Legacy's `applyStoredResult`: reads the (match, provider) row and applies
   * it with its stored attestation — which may be false, in which case the legs stay
   * PENDING and the reason says why.
   */
  async function applyStoredResult(ticketId, matchId, providerId) {
    const repository = requireStore();
    ticketIdOrNotFound(ticketId);
    const stored = await repository.findSportsResult(matchId, providerId).catch(() => null);
    if (!stored) throw AppError.notFound("verified provider result not found");
    return applyVerifiedResult(ticketId, matchId, {
      verified: stored.verified === true || stored.verified === 1,
      status: stored.status,
      homeScore: stored.home_score === null || stored.home_score === undefined ? null : Number(stored.home_score),
      awayScore: stored.away_score === null || stored.away_score === undefined ? null : Number(stored.away_score),
    });
  }

  /**
   * Apply one verified verdict to every PENDING leg of the ticket that names the
   * match, then finalize. Legacy's `applyVerifiedResult`.
   */
  async function applyVerifiedResult(ticketId, matchId, result) {
    const repository = requireStore();
    ticketIdOrNotFound(ticketId);
    const verified = verifyResult(result, nowDate());
    if (!verified.verified) {
      // Legacy returns the bare pair, so parity on this path is exact rather than a
      // superset — the route wraps the settlement with the ticket it settled.
      return { status: "PENDING", reason: verified.reason };
    }
    const ticket = await repository.findSportsTicket(ticketId);
    if (!ticket) throw AppError.notFound("ticket not found");
    for (const selection of await repository.listSportsTicketSelections(ticketId)) {
      if (Number(selection.match_id) === Number(matchId) && selection.status === "PENDING") {
        const out = settleSelection({ market: selection.market, selection: selection.selection }, verified);
        if (out.status !== "PENDING") {
          // Legacy writes the settled status into both columns; the port keeps that.
          await repository.updateSportsTicketSelection(selection.id, { status: out.status, result: out.status });
        }
      }
    }
    return finalizeTicket(ticketId);
  }

  /**
   * Sweep: settle every PENDING leg of a ticket for which a stored result exists (any
   * provider's best row), then finalize. Safe to run repeatedly — that is what the
   * settlement sweep of a future cron will do, and what the route does per call.
   */
  async function settlePending(ticketId) {
    const repository = requireStore();
    ticketIdOrNotFound(ticketId);
    const ticket = await repository.findSportsTicket(ticketId);
    if (!ticket) throw AppError.notFound("ticket not found");
    const selections = await repository.listSportsTicketSelections(ticketId);
    if (FINAL_STATUSES.includes(String(ticket.settlement_status ?? "")) && selections.every((s) => s.status !== "PENDING")) {
      return { ticketId, status: ticket.settlement_status, unchanged: true };
    }
    for (const selection of selections) {
      if (selection.status !== "PENDING") continue;
      const stored = await repository.findSportsResultByMatch(selection.match_id).catch(() => null);
      // No stored result → the leg stays PENDING. Nothing is invented.
      if (stored === null) continue;
      await applyVerifiedResult(ticketId, selection.match_id, {
        verified: stored.verified === true || stored.verified === 1,
        status: stored.status,
        homeScore: stored.home_score === null || stored.home_score === undefined ? null : Number(stored.home_score),
        awayScore: stored.away_score === null || stored.away_score === undefined ? null : Number(stored.away_score),
      });
    }
    return finalizeTicket(ticketId);
  }

  /**
   * Recompute the ticket's outcome from its legs. Every settlement path ends here, so
   * a ticket's status is always a function of its stored legs and the void policy —
   * never of the path that touched it last.
   */
  async function finalizeTicket(ticketId) {
    const repository = requireStore();
    ticketIdOrNotFound(ticketId);
    const all = await repository.listSportsTicketSelections(ticketId);
    const states = all.map((s) => String(s.status));
    const voidCount = states.filter((s) => s === "VOID" || s === "CANCELLED").length;
    const lostCount = states.filter((s) => s === "LOST").length;
    const pendingCount = states.filter((s) => s === "PENDING").length;
    const config = (await repository.activeSportsConfiguration()) ?? null;
    const voidPolicy = String(config?.void_policy ?? VOID_POLICY_DEFAULT);

    let status;
    if (pendingCount > 0) status = "PENDING";
    else if (lostCount > 0) status = "LOST";
    // Ported as written: with zero legs this branch is true and the ticket is VOID —
    // unreachable in practice, because a ticket is written with its legs (slice 4).
    else if (voidCount === all.length) status = "VOID";
    else status = "WON";

    // Effective odds under the configured void policy. A void leg's odds count as 1.0
    // (skipped) under RESTITUTE_ODDS and are multiplied in under every other policy —
    // ported as written, asymmetry included.
    let effectiveOdds = 1.0;
    for (const s of all) {
      const legStatus = String(s.status);
      if ((legStatus === "VOID" || legStatus === "CANCELLED") && voidPolicy === VOID_POLICY_DEFAULT) continue;
      effectiveOdds *= Number(s.odds);
    }
    const ticket = await repository.findSportsTicket(ticketId);
    const stake = ticket?.stake !== null && ticket?.stake !== undefined ? Number(ticket.stake) : null;
    let pnl = null;
    if (stake !== null) {
      if (status === "WON") pnl = round4(stake * (effectiveOdds - 1));
      else if (status === "LOST") pnl = round4(-stake);
      else pnl = 0.0;
    }
    await repository.updateSportsTicket(ticketId, {
      settlementStatus: status,
      status,
      totalOdds: status === "PENDING" ? ticket.total_odds : round6(effectiveOdds),
      // Q-4, preserved: a PENDING ticket says why it is waiting; a decided ticket's
      // reason is NULL. The decision reason stays in the audit trail.
      reason: status === "PENDING" ? "waiting on unverified results" : null,
    });
    if (pnl !== null) await repository.recordSportsTicketOutcome(ticketId, pnl);
    await repository.recordAudit({
      actorId: null,
      action: "sports.ticket.settled",
      entityType: "sports_ticket",
      entityId: ticketId,
      details: {
        ticketId,
        status,
        effectiveOdds: Number(effectiveOdds.toFixed(4)),
        voidPolicy,
        pnl,
      },
    });
    return {
      ticketId,
      status,
      effectiveOdds: Number(effectiveOdds.toFixed(4)),
      pnl,
      selections: states.reduce((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {}),
    };
  }

  return Object.freeze({
    verifyStoredResult,
    applyStoredResult,
    applyVerifiedResult,
    settlePending,
  });
}

/** PHP `round($x, 4)`. */
function round4(value) {
  return Math.round(Number(value) * 10 ** 4) / 10 ** 4;
}

/** PHP `round($x, 6)`. */
function round6(value) {
  return Math.round(Number(value) * 10 ** 6) / 10 ** 6;
}
