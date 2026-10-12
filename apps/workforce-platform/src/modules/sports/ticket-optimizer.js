/**
 * Ticket optimizer (row 14, slice 4). Legacy `Aegis\Sports\TicketOptimizer::optimize`,
 * ported exactly, including its search order and its tie-break.
 *
 * The search is exhaustive over combinations drawn from the pool, in candidate order.
 * A combination is a ticket when its total odds fall inside the target window. The best
 * ticket is the one with the highest summed expected value. Ties keep the earlier one,
 * because only a strict improvement replaces the best. The optimizer never pads a ticket
 * to reach the maximum number of selections.
 *
 * DV-20 (simulated candidates are refused) is applied by the caller before the pool is
 * built, not here. This function remains a faithful port, so its golden cases match legacy.
 *
 * The ticket id is not generated here. Legacy used `random_bytes`, which would make the
 * output nondeterministic, so the caller supplies it.
 */
import { phpEmpty, phpFloat, phpInt, phpIsNumeric, phpIsset, phpRound } from "../../lib/php.js";
import { assessCorrelation } from "./correlation.js";

const CORRELATION_ORDER = Object.freeze({ LOW: 0, MEDIUM: 1, HIGH: 2 });

function inList(value, list) {
  return list.some((item) => item === value);
}

/** `(float)` for the optional floor: null unless the config holds a numeric value. */
function optionalFloat(config, key) {
  return phpIsset(config[key]) && phpIsNumeric(config[key]) ? phpFloat(config[key]) : null;
}

function optionalInt(config, key) {
  return phpIsset(config[key]) && phpIsNumeric(config[key]) ? phpInt(config[key]) : null;
}

/**
 * Keep only candidates that clear every configured floor. Legacy's order of checks is
 * kept, because the first failing check decides which filter a candidate is counted under.
 */
export function ticketPool(candidates, config = {}) {
  const minConfidence = optionalFloat(config, "minConfidence");
  const minQuality = optionalInt(config, "minDataQuality");
  const allowedMarkets = Array.isArray(config.allowedMarkets) ? config.allowedMarkets : [];
  const allowedLeagues = Array.isArray(config.allowedLeagues) ? config.allowedLeagues : [];
  const pool = [];
  for (const candidate of candidates) {
    if (phpEmpty(candidate?.risk?.approved) || (candidate?.risk?.classification ?? "") === "HIGH") continue;
    if (phpEmpty(candidate?.value?.qualified)) continue;
    const confidence = candidate?.confidence?.confidence ?? null;
    if (minConfidence !== null && !phpIsNumeric(confidence)) continue;
    if (minConfidence !== null && phpFloat(confidence) < minConfidence) continue;
    if (minQuality !== null && phpInt(candidate?.quality?.score ?? 0) < minQuality) continue;
    if (allowedMarkets.length > 0 && !inList(candidate?.market ?? null, allowedMarkets)) continue;
    const league = candidate?.match?.competition ?? candidate?.competition ?? null;
    if (allowedLeagues.length > 0 && !inList(league, allowedLeagues)) continue;
    pool.push(candidate);
  }
  return pool;
}

/**
 * @param {Array<Record<string, any>>} candidates evaluated selections, already filtered to the non-REJECTED ones
 * @param {Record<string, any>} [config] the window, limit and floors, under legacy's camelCase keys
 * @param {{ ticketId?: string|null }} [options]
 */
export function optimizeTicket(candidates, config = {}, { ticketId = null } = {}) {
  const min = phpFloat(config.targetOddsMin ?? 5.0);
  const max = phpFloat(config.targetOddsMax ?? 8.0);
  const limit = phpInt(config.maxSelections ?? 5);
  const maxCorrelation = String(config.maxCorrelation ?? "MEDIUM").toUpperCase();
  const pool = ticketPool(candidates, config);

  // 'MEDIUM' permits LOW and MEDIUM pairs. Anything else (including 'HIGH') permits LOW only.
  const correlationLimit = maxCorrelation === "LOW" ? "LOW" : "MEDIUM";
  let best = null;

  const search = (chosen, start, odds) => {
    if (chosen.length > 0 && odds >= min && odds <= max) {
      const score = chosen.reduce((sum, candidate) => sum + phpFloat(candidate?.value?.expectedValue ?? 0), 0);
      if (best === null || score > best.score) best = { score, selections: chosen, totalOdds: odds };
    }
    if (chosen.length >= limit || odds >= max) return;
    for (let i = start; i < pool.length; i += 1) {
      const candidate = pool[i];
      const correlation = assessCorrelation(candidate, chosen);
      if (CORRELATION_ORDER[correlation.classification] > CORRELATION_ORDER[correlationLimit]) continue;
      const next = odds * phpFloat(candidate?.value?.odds ?? 0);
      if (next > max) continue;
      search([...chosen, candidate], i + 1, next);
    }
  };
  search([], 0, 1.0);

  if (best === null) {
    return {
      status: "NO_QUALIFIED_TICKET",
      reason: "No candidate combination satisfies odds, risk, value, correlation and configuration constraints",
      poolSize: pool.length,
      config,
    };
  }
  return {
    status: "QUALIFIED",
    ticketId,
    totalOdds: phpRound(best.totalOdds, 4),
    selectionCount: best.selections.length,
    selections: best.selections,
    optimizationScore: phpRound(best.score, 6),
    poolSize: pool.length,
    config,
  };
}
