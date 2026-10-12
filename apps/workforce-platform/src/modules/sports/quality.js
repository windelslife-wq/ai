/**
 * Data quality and odds freshness — the ports of `Aegis\Sports\DataQualityEngine`
 * and `Aegis\Sports\OddsFreshnessEngine`.
 *
 * Legacy's own summary of the quality engine is the design in one line:
 * *"Conservative quality scoring. Missing critical inputs cap confidence and
 * reject ticket eligibility."* Both engines are pure: they take a record and
 * return a verdict, touch no I/O and hold no state, which is what makes them
 * testable exhaustively and what lets a later slice build prediction gating on
 * top of them without inheriting anything.
 *
 * The two eligibility flags are the reason this module exists. `score` alone is a
 * number an operator can argue with; `eligibleForTicket` is a decision, and it is
 * **stricter than `eligibleForPrediction`** — a fixture can be good enough to
 * predict on and still not good enough to stake on, because predicting is
 * reversible and staking is not. Both are stored per assessment (migration 011)
 * rather than recomputed on read, so a later decision can be audited against the
 * assessment that was actually in force when it was made.
 */

import { parseStrictInstant } from "../../lib/php-date.js";

/**
 * PHP's `!empty()`. `0`, `0.0`, `"0"`, `""`, `false`, `null` and `[]` are all
 * empty — which is why a required field holding the *string* `"0"` counts as
 * missing here. Preserved rather than replaced with a truthiness check, because
 * `!"0"` is `false` in JavaScript and the two would disagree on exactly the
 * payloads that matter.
 */
function phpNotEmpty(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "" && value !== "0";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/**
 * PHP's `PHP_INT_MAX`, used as the "no observation" sentinel for a data age. An
 * absent age must fail the freshness check, and the largest safe integer does that
 * without needing a branch.
 */
const NO_OBSERVATION = Number.MAX_SAFE_INTEGER;

/** The weighted checks, in legacy's order. The order is observable: `missing` and `checks` are both derived from it. */
const REQUIRED_FIXTURE_FIELDS = Object.freeze(["externalId", "homeTeam", "awayTeam", "competition", "kickoff"]);

/** Total weight across all checks: 5 × 12 + 18 + 12 + 10 + 8. */
const TOTAL_WEIGHT = 108;

/**
 * Score a fixture's data quality (legacy `DataQualityEngine::assess`).
 *
 * Nine weighted checks — the five required fixture fields at 12 each, then odds
 * availability (18), recent form (12), provider reliability (10) and freshness
 * (8). Odds carry the single heaviest weight because a fixture with no price has
 * no value to find, and the weights are what make the score conservative: missing
 * odds alone drops a fixture from `EXCELLENT` to `LIMITED`.
 *
 * @param {Record<string, unknown>} fixture a normalized fixture
 * @param {Record<string, unknown>} [context] availability flags plus
 *   `providerReliability` (0–1), `dataAgeSeconds` and `maxAgeSeconds`
 * @returns {{score: number, band: string, freshnessScore: number,
 *   providerReliabilityScore: number, eligibleForPrediction: boolean,
 *   eligibleForTicket: boolean, missing: string[],
 *   checks: Array<{field: string, ok: boolean, weight: number}>}}
 */
export function assessQuality(fixture, context = {}) {
  const source = fixture && typeof fixture === "object" ? fixture : {};
  const ctx = context && typeof context === "object" ? context : {};

  const checks = [];
  for (const field of REQUIRED_FIXTURE_FIELDS) {
    checks.push({ field, ok: phpNotEmpty(source[field]), weight: 12 });
  }
  checks.push({ field: "odds", ok: phpNotEmpty(ctx.oddsAvailable), weight: 18 });
  checks.push({ field: "recentForm", ok: phpNotEmpty(ctx.recentFormAvailable), weight: 12 });

  const reliability = Number(ctx.providerReliability ?? 0);
  checks.push({ field: "providerReliability", ok: Number.isFinite(reliability) && reliability >= 0.75, weight: 10 });

  const ageSeconds = Number.isFinite(Number(ctx.dataAgeSeconds)) && ctx.dataAgeSeconds !== null && ctx.dataAgeSeconds !== undefined
    ? Number(ctx.dataAgeSeconds)
    : NO_OBSERVATION;
  const maxAgeSeconds = Number.isFinite(Number(ctx.maxAgeSeconds)) && ctx.maxAgeSeconds !== null && ctx.maxAgeSeconds !== undefined
    ? Number(ctx.maxAgeSeconds)
    : 3600;
  const fresh = ageSeconds <= maxAgeSeconds;
  checks.push({ field: "freshness", ok: fresh, weight: 8 });

  const earned = checks.reduce((total, check) => total + (check.ok ? check.weight : 0), 0);
  const score = Math.round((100 * earned) / TOTAL_WEIGHT);
  const freshnessScore = fresh ? 100 : 0;
  // Clamped before scaling, so a provider reporting a reliability above 1 or below
  // 0 cannot produce a score outside 0–100.
  const clamped = Math.min(1, Math.max(0, Number.isFinite(reliability) ? reliability : 0));
  const providerReliabilityScore = Math.round(100 * clamped);

  const missing = checks.filter((check) => !check.ok).map((check) => check.field);
  const band = score >= 90 ? "EXCELLENT" : score >= 75 ? "GOOD" : score >= 60 ? "LIMITED" : "REJECT";

  return {
    score,
    band,
    freshnessScore,
    providerReliabilityScore,
    eligibleForPrediction: score >= 60,
    // Stricter than predicting on purpose, and gated on freshness *as well as* on
    // the score: a stale-but-otherwise-perfect fixture may still be predicted on
    // but may not be staked on.
    eligibleForTicket: score >= 75 && freshnessScore > 0,
    missing,
    checks,
  };
}

/** The freshness verdict reasons, exactly as legacy names them. */
export const FRESHNESS_REASONS = Object.freeze({
  UNAVAILABLE: "ODDS_UNAVAILABLE",
  TIMESTAMP_INVALID: "ODDS_TIMESTAMP_INVALID",
  STALE: "STALE_ODDS",
});

/**
 * Score how recently an odds observation was made (legacy
 * `OddsFreshnessEngine::assess`).
 *
 * Three outcomes, and the distinction between the first two is the point:
 * `ODDS_UNAVAILABLE` means there is no observation at all, while
 * `ODDS_TIMESTAMP_INVALID` means there **is** one and it cannot be dated. The
 * second is worse in practice — a provider that sends prices without usable
 * timestamps looks like a provider that sends prices — and the sync service says
 * so explicitly when a provider returns no odds at all, because an odds-dependent
 * ticket must not be generated from nothing.
 *
 * Accepts both key shapes legacy accepts, `observedAt` (a normalized record) and
 * `observed_at` (a repository row), so the same assessment works on a payload
 * straight from a provider and on one read back out of the database. An empty
 * timestamp is **never** fresh.
 *
 * @param {Record<string, unknown>|null|undefined} odds
 * @param {number} [maxAgeSeconds] default 900 — 15 minutes, an order of magnitude
 *   tighter than the quality engine's 3600 because a price moves faster than a fixture
 * @param {number|null} [now] epoch seconds, injectable for tests
 * @returns {{available: boolean, fresh: boolean, ageSeconds: number|null,
 *   score: number, reason: string|null}}
 */
export function assessOddsFreshness(odds, maxAgeSeconds = 900, now = null) {
  if (odds === null || odds === undefined || typeof odds !== "object") {
    return { available: false, fresh: false, ageSeconds: null, score: 0, reason: FRESHNESS_REASONS.UNAVAILABLE };
  }

  const rawAt = odds.observedAt ?? odds.observed_at ?? "";
  const at = parseStrictInstant(typeof rawAt === "string" ? rawAt.trim() : rawAt);
  if (at === null) {
    return { available: true, fresh: false, ageSeconds: null, score: 0, reason: FRESHNESS_REASONS.TIMESTAMP_INVALID };
  }

  const clock = now === null || now === undefined ? Math.floor(Date.now() / 1000) : Number(now);
  const observedSeconds = Math.floor(at.getTime() / 1000);
  // Clamped at zero: a provider whose clock is ahead of ours reports a negative
  // age, and a negative age must not score *better* than a fresh one.
  const age = Math.max(0, clock - observedSeconds);
  const fresh = age <= maxAgeSeconds;
  const score = fresh ? Math.round(100 * (1 - age / Math.max(1, maxAgeSeconds))) : 0;

  return { available: true, fresh, ageSeconds: age, score, reason: fresh ? null : FRESHNESS_REASONS.STALE };
}
