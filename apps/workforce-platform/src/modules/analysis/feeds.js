/**
 * The licensed-feed boundary: sentiment and fundamentals.
 *
 * Ported from `application/libraries/Aegis/Providers/SentimentFeed.php` and
 * `FundamentalsFeed.php`. Both interfaces have exactly one implementation in the
 * legacy tree — the *unavailable* one — and that is the point: the platform ships
 * an honest abstention instead of a proxy. Price and volume behaviour is analysed
 * by the technical and crypto agents; it is never relabelled as news sentiment,
 * and an earnings guess is never presented as a fundamental.
 *
 * `createSentimentSnapshotValidator` is the gate that keeps a *future* licensed
 * feed honest: a snapshot votes only when it is available, licensed, attributable
 * to a named source, and carries at least two observations that are individually
 * attributable, in range and fresh. Every rejection returns the reason string that
 * ends up in the agent report, so abstention is always explained rather than
 * silent.
 */

export const SENTIMENT_MAX_AGE_SECONDS = 3_600; // sentiment decays fast — one-hour horizon
export const SENTIMENT_MIN_VALID_OBSERVATIONS = 2; // one data point is not a sentiment view
const CLOCK_SKEW_SECONDS = 60; // tolerate slight feed clock drift into the future
const SENTIMENT_CHANNELS = Object.freeze(["news", "social"]);

export function unavailableSentimentFeed() {
  return {
    id: () => "unconfigured",
    health: () => ({ state: "UNCONFIGURED", licensed: false, message: "No licensed sentiment feed configured" }),
    snapshot: (symbol) => ({
      available: false,
      symbol: String(symbol).toUpperCase(),
      source: null,
      observedAt: null,
      licensed: false,
      reason: "No licensed sentiment feed configured",
    }),
  };
}

export function unavailableFundamentalsFeed() {
  return {
    id: () => "unconfigured",
    health: () => ({ state: "UNCONFIGURED", licensed: false, message: "No licensed fundamentals feed configured" }),
    snapshot: (symbol) => ({
      available: false,
      symbol: String(symbol).toUpperCase(),
      source: null,
      observedAt: null,
      licensed: false,
      reason: "No licensed fundamentals feed configured",
    }),
  };
}

function reject(reason) {
  return { ok: false, reason, score: null, observations: [], rejectedCount: null, provenance: null };
}

export function createSentimentSnapshotValidator(maxAgeSeconds = SENTIMENT_MAX_AGE_SECONDS) {
  /**
   * @param {object} snapshot feed output
   * @param {number|null} nowSeconds wall clock in Unix seconds (the feed's own unit)
   */
  function validate(snapshot, nowSeconds = null) {
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    if (!snapshot?.available) return reject(String(snapshot?.reason || "SNAPSHOT_UNAVAILABLE"));
    if (!snapshot.licensed) return reject("UNLICENSED — sentiment data without a license cannot be used");

    const source = String(snapshot.source ?? "").trim();
    if (source === "") return reject("NO_SOURCE — snapshot has no attributable source");

    const raw = Array.isArray(snapshot.observations) ? snapshot.observations : [];
    const valid = [];
    let rejectedCount = 0;
    for (const observation of raw) {
      if (typeof observation !== "object" || observation === null || Array.isArray(observation)) {
        rejectedCount += 1;
        continue;
      }
      const observationSource = String(observation.source ?? "").trim();
      const observedAt = observation.observedAt ?? null;
      const score = observation.score ?? null;
      const sampleSize = Number.parseInt(observation.sampleSize ?? 0, 10) || 0;
      const scoreIsNumber = typeof score === "number" && Number.isFinite(score);
      if (
        observationSource === ""
        || !Number.isInteger(observedAt)
        || observedAt < now - maxAgeSeconds
        || observedAt > now + CLOCK_SKEW_SECONDS
        || !scoreIsNumber
        || score < -1
        || score > 1
        || sampleSize < 1
      ) {
        rejectedCount += 1;
        continue;
      }
      valid.push({
        channel: SENTIMENT_CHANNELS.includes(observation.channel) ? observation.channel : "news",
        source: observationSource,
        observedAt,
        score: Math.round(score * 10_000) / 10_000,
        sampleSize,
        headline: typeof observation.headline === "string" ? observation.headline : null,
      });
    }

    if (valid.length < SENTIMENT_MIN_VALID_OBSERVATIONS) {
      return reject(
        `STALE_OR_INCOMPLETE — only ${valid.length} of ${valid.length + rejectedCount} observation(s) attributable and within ${maxAgeSeconds}s (need >= ${SENTIMENT_MIN_VALID_OBSERVATIONS})`,
      );
    }

    const score = valid.reduce((sum, observation) => sum + observation.score, 0) / valid.length;
    const timestamps = valid.map((observation) => observation.observedAt);
    return {
      ok: true,
      reason: null,
      score: Math.round(score * 10_000) / 10_000,
      observations: valid,
      rejectedCount,
      provenance: {
        source,
        licensed: true,
        observedAt: Math.max(...timestamps),
        observedAtRange: [Math.min(...timestamps), Math.max(...timestamps)],
      },
    };
  }

  return { validate, maxAgeSeconds: () => maxAgeSeconds };
}
