/**
 * Shared agent helpers.
 *
 * Ported from `application/libraries/Aegis/Agents/AgentHelper.php` (a PHP trait)
 * plus `TechnicalAgent::dataQuality()`, which every other agent reuses to score
 * the series it was handed.
 *
 * Two constants here shape the whole consensus and are therefore fixed data, not
 * tuning knobs:
 *  - `AGENT_WEIGHTS` — sentiment carries half the weight of a price-derived agent
 *    and cannot outweigh one;
 *  - the ±0.15 vote threshold — inside it an agent abstains (`votes: false`) and
 *    contributes nothing to the panel, which is how "no edge" stays distinguishable
 *    from "a small edge".
 */

import { clamp, roundTo } from "../math.js";

export const AGENT_WEIGHTS = Object.freeze({
  technical: 1.0,
  "market-structure": 0.9,
  forex: 0.9,
  crypto: 0.9,
  sentiment: 0.5,
});

export const VOTE_THRESHOLD = 0.15;

export function makeVote(score, weight, reason) {
  const clamped = clamp(score, -1, 1);
  return {
    directionalScore: roundTo(clamped, 4),
    signal: clamped > VOTE_THRESHOLD ? "BUY" : (clamped < -VOTE_THRESHOLD ? "SELL" : "NEUTRAL"),
    weight,
    votes: Math.abs(clamped) > VOTE_THRESHOLD,
    reason,
  };
}

/**
 * Series quality in [0, 1]. Every penalty is multiplicative and each one names a
 * concrete deficiency: too few candles, synthetic origin, staleness, or gaps.
 * A run built on labelled synthetic data can never score above 0.6 — which is what
 * keeps it below the risk engine's `minDataQuality` gate on a short series.
 */
export function dataQuality(series) {
  let quality = 1;
  const count = series.candles?.length ?? 0;
  if (count < 60) quality *= 0.5;
  else if (count < 120) quality *= 0.8;
  if (series.provenance?.synthetic) quality *= 0.6;
  if (series.provenance?.stale) quality *= 0.7;
  if ((series.validation?.gapCount ?? 0) > count * 0.1) quality *= 0.8;
  return roundTo(quality, 3);
}
