/**
 * Result verification and per-selection settlement — the port of legacy
 * `Aegis\Sports\ResultVerificationEngine` (row 14, slice 5).
 *
 * A provider REPORTS a result; nothing downstream may treat a reported score as true.
 * A result becomes usable for settlement only when it is (a) already attested
 * (`verified` truthy — the flag `verifySportsResult` writes) AND (b) internally
 * consistent: FINISHED with two non-negative integer scores, or an explicitly
 * VOID/CANCELLED terminal status with no scores to read.
 *
 * Everything here is pure. The only wall-clock read in legacy is `gmdate('c')` for
 * `verifiedAt`, which the caller passes as `now`; the differential harness holds the
 * rest to PHP's output value for value.
 *
 * Ported as written, including the narrowness: only `TOTAL_GOALS` `OVER_1_5` can
 * settle today. Any other market stays PENDING with
 * `MARKET_SETTLEMENT_RULE_UNAVAILABLE` — a refusal, not a guessed win.
 */

/** The statuses the engine reads as "the match never had a result to verify". */
const VOID_STATUSES = Object.freeze(["VOID", "CANCELLED"]);

/**
 * Verify one result candidate.
 *
 * @param {{verified?: boolean|number|null, status?: string|null, homeScore?: number|null, awayScore?: number|null}} result
 * @param {string|Date} [now] the instant stamped into the verdict, as legacy's `gmdate('c')`
 * @returns {{verified: boolean, reason?: string, terminalStatus?: string, homeScore?: number, awayScore?: number, verifiedAt?: string}}
 */
export function verifyResult(result, now = new Date()) {
  const r = result && typeof result === "object" ? result : {};
  if (!r.verified) return { verified: false, reason: "RESULT_UNVERIFIED" };
  const status = String(r.status ?? "").toUpperCase();
  if (VOID_STATUSES.includes(status)) {
    return { verified: true, terminalStatus: status, verifiedAt: stamp(now) };
  }
  if (status !== "FINISHED") return { verified: false, reason: "MATCH_NOT_FINISHED" };
  if (
    r.homeScore === undefined || r.homeScore === null
    || r.awayScore === undefined || r.awayScore === null
    || !Number.isInteger(r.homeScore) || !Number.isInteger(r.awayScore)
    || r.homeScore < 0 || r.awayScore < 0
  ) {
    return { verified: false, reason: "RESULT_INVALID" };
  }
  return {
    verified: true,
    terminalStatus: "FINISHED",
    homeScore: r.homeScore,
    awayScore: r.awayScore,
    verifiedAt: stamp(now),
  };
}

/**
 * Settle one ticket leg from a verified verdict.
 *
 * `VOID` and `CANCELLED` settle the leg to their own status. A finished score settles
 * the one market the engine knows: OVER_1_5 wins when the total exceeds 1. Every other
 * market stays PENDING — with a reason, so a reader can tell "not yet verifiable"
 * (RESULT_UNVERIFIED) from "no rule for this market" (MARKET_SETTLEMENT_RULE_UNAVAILABLE).
 *
 * @param {{market?: string, selection?: string}} selection
 * @param {{verified: boolean, reason?: string, terminalStatus?: string, homeScore?: number, awayScore?: number}} verified
 */
export function settleSelection(selection, verified) {
  const s = selection && typeof selection === "object" ? selection : {};
  const v = verified && typeof verified === "object" ? verified : {};
  if (!v.verified) return { status: "PENDING", reason: v.reason ?? "RESULT_UNVERIFIED" };
  if (v.terminalStatus === "VOID") return { status: "VOID", reason: "VERIFIED_VOID" };
  if (v.terminalStatus === "CANCELLED") return { status: "CANCELLED", reason: "VERIFIED_CANCELLATION" };
  const total = v.homeScore + v.awayScore;
  const market = s.market ?? "";
  const pick = s.selection ?? "";
  if (market === "TOTAL_GOALS" && pick === "OVER_1_5") {
    return { status: total > 1 ? "WON" : "LOST", reason: "VERIFIED_RESULT" };
  }
  return { status: "PENDING", reason: "MARKET_SETTLEMENT_RULE_UNAVAILABLE" };
}

/** `gmdate('c')` for the port: an ISO-8601 instant with an explicit UTC offset. */
function stamp(now) {
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) throw new TypeError(`verifiedAt must be a calendar instant, received ${JSON.stringify(String(now))}`);
  // Legacy emits `+00:00` offsets; these strings are only stored in verdict payloads
  // and compared by value in tests, so the canonical `Z` form is kept (divergence SP-1).
  return at.toISOString();
}
