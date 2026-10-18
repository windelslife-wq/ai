/**
 * Bounded, record-only stake sizing (row 14, slice 6, Phase 48) — divergence DV-27.
 *
 * Legacy has no sizing engine: `TicketGovernance::record` copies the configured fixed
 * `stake_amount` onto each ticket, verbatim. This module keeps exactly that behaviour
 * as the default method (`FLAT`) and adds one opt-in method (`CONFIDENCE_SCALED`),
 * configured through the versioned ticket-engine configuration (`staking_method`,
 * migration 022; `FLAT` fills every existing row, so a historical configuration still
 * means what it meant).
 *
 * Boundaries, deliberately tight, in one list:
 *
 *  - **Record-only.** A stake is persisted on a ticket and settlement computes P/L on
 *    it. Nothing is executed: there is no external bookmaker connector, no order path,
 *    and sizing touches no paper/risk/broker service. The daily ticket run calls this
 *    module and nothing else does.
 *  - **Bounded and monotone-down.** `CONFIDENCE_SCALED` can only size *down* from the
 *    flat stake: `stake = stake_amount × confidenceFactor × riskFactor ×
 *    correlationFactor`, every factor in (0, 1], so the sized stake can never exceed
 *    the configured `stake_amount` — which validation already caps at `max_exposure`,
 *    so the exposure cap is inherited rather than re-implemented. There is no sizing
 *    up, ever.
 *  - **Fail-conservative.** An unknown or missing risk/correlation classification maps
 *    to the `HIGH` factor (0.25), a missing confidence to the floor (0.1), an unknown
 *    method to `FLAT`. A non-numeric `stake_amount` yields a null stake — a refusal to
 *    size, not zero, and never an exception at ticket time.
 *  - **Deterministic and reconstructible.** The sized stake derives from the ticket's
 *    stored numbers (its confidence, risk and correlation) plus the versioned
 *    configuration the ticket already records, so any historical sizing can be
 *    recomputed exactly. No breakdown column exists because none is needed; the
 *    breakdown travels in the run's audit event details and in its response.
 *
 * There is deliberately still no bankroll- or edge-based sizing: no bankroll exists in
 * this deployment, because nothing is executed.
 */

import { phpRound } from "../../lib/php.js";

/** The methods a configuration may name. `FLAT` is legacy's behaviour, unchanged. */
export const STAKING_METHODS = Object.freeze(["FLAT", "CONFIDENCE_SCALED"]);

/** Every multiplicative factor's minimum: sizing down stops at a 10% participation. */
export const STAKE_FLOOR_COMPONENT = 0.1;

/** A ticket whose risk/correlation cannot be read is treated as the worst classification. */
export const RISK_FACTORS = Object.freeze({ LOW: 1, MEDIUM: 0.5, HIGH: 0.25 });
export const CORRELATION_FACTORS = Object.freeze({ LOW: 1, MEDIUM: 0.5, HIGH: 0.25 });

/**
 * Size the stake for one ticket.
 *
 * @param {Record<string, any>} config active configuration row (`staking_method`,
 *   `stake_amount`, `min_confidence`)
 * @param {object} measures the ticket's own stored measures
 * @param {number|null} measures.confidence the ticket confidence (lowest leg, rounded),
 *   or null when no leg carried one
 * @param {string} measures.risk the ticket's worst leg risk classification
 * @param {string} measures.correlation the ticket's pairwise correlation classification
 * @returns {Readonly<Record<string, unknown>>} the breakdown: the method applied, the
 *   flat stake it read, every factor, and the final stake (null when no finite stake
 *   amount exists to size)
 */
export function sizeStake(config = {}, { confidence = null, risk = null, correlation = null } = {}) {
  const method = STAKING_METHODS.includes(config?.staking_method) ? config.staking_method : "FLAT";
  const amount = Number(config?.stake_amount ?? NaN);
  const flatStake = Number.isFinite(amount) && amount > 0 ? amount : null;

  if (method === "FLAT" || flatStake === null) {
    return Object.freeze({
      method: "FLAT",
      flatStake,
      confidenceFactor: 1,
      riskFactor: 1,
      correlationFactor: 1,
      sized: false,
      stake: flatStake,
      note: "configured fixed stake, recorded exactly as legacy records it",
    });
  }

  // CONFIDENCE_SCALED. Missing inputs fail to the floor, not to zero stake or an exception.
  const minConfidence = Number.isFinite(Number(config?.min_confidence)) ? Number(config.min_confidence) : 75;
  const divisor = Math.max(1, 100 - minConfidence);
  const confidenceFactor = confidence === null
    ? STAKE_FLOOR_COMPONENT
    : Math.max(STAKE_FLOOR_COMPONENT, Math.min(1, (Number(confidence) - minConfidence) / divisor));
  const riskFactor = RISK_FACTORS[risk] ?? RISK_FACTORS.HIGH;
  const correlationFactor = CORRELATION_FACTORS[correlation] ?? CORRELATION_FACTORS.HIGH;

  // Every factor ≤ 1, so `raw <= flatStake` already; the min() is the stated contract,
  // pinned by a test, so no future factor table can size a ticket above the flat stake.
  const raw = flatStake * confidenceFactor * riskFactor * correlationFactor;
  const stake = phpRound(Math.min(raw, flatStake), 2);

  return Object.freeze({
    method: "CONFIDENCE_SCALED",
    flatStake,
    confidenceFactor: phpRound(confidenceFactor, 4),
    riskFactor: phpRound(riskFactor, 4),
    correlationFactor: phpRound(correlationFactor, 4),
    sized: true,
    stake,
    note: "bounded sizing: ≤ the configured fixed stake, derived from confidence, risk and correlation; record-only",
  });
}
