/**
 * Sentiment Analysis Agent — the licensed-feed boundary.
 *
 * Ported from the `SentimentAgent` class in
 * `application/libraries/Aegis/Agents/ForexCryptoSentimentAgents.php`.
 *
 * This agent abstains by default, and abstention is a computed outcome rather than
 * a stub: the feed snapshot goes through `createSentimentSnapshotValidator`, which
 * requires the data to be available, licensed, attributable to a named source and
 * backed by at least two individually attributable, in-range, fresh observations.
 * Any failure becomes the `reason` string in the report, so a consumer can see
 * exactly why sentiment contributed nothing.
 *
 * Two rules are load-bearing and are kept verbatim:
 *  - an abstaining agent sets `votes: false`, which removes it from the consensus
 *    panel entirely — it cannot dilute a directional vote by voting neutral;
 *  - price and volume behaviour is never relabelled as sentiment. That work
 *    belongs to the technical and crypto agents, and the report says so.
 */

import { roundTo, signedFormat } from "../math.js";
import { unavailableSentimentFeed, createSentimentSnapshotValidator } from "../feeds.js";
import { makeVote, AGENT_WEIGHTS } from "./helper.js";

export const SENTIMENT_AGENT_ID = "sentiment";
const MAX_OBSERVATIONS_REPORTED = 10;

export function createSentimentAgent({
  feed = unavailableSentimentFeed(),
  validator = createSentimentSnapshotValidator(),
  nowSeconds = () => Math.floor(Date.now() / 1000),
} = {}) {
  function applicable() {
    return true;
  }

  function analyze(context) {
    const symbol = context.series?.symbol;
    const snapshot = feed.snapshot(symbol);
    const check = validator.validate(snapshot, nowSeconds());

    const provenance = {
      source: check.provenance?.source ?? snapshot?.source ?? null,
      licensed: Boolean(snapshot?.licensed ?? false),
      feed: feed.id(),
    };

    if (!check.ok) {
      return {
        agent: SENTIMENT_AGENT_ID,
        title: "Sentiment Analysis Agent",
        generatedAt: context.now,
        dataQuality: 0,
        dataLimitations: [check.reason],
        warnings: [`Sentiment unavailable (${check.reason}) — consensus is computed without any sentiment input`],
        vote: {
          directionalScore: 0,
          signal: "NEUTRAL",
          weight: AGENT_WEIGHTS[SENTIMENT_AGENT_ID],
          votes: false,
          reason: `${check.reason} — abstaining`,
        },
        news: { available: false, reason: check.reason },
        social: { available: false, reason: check.reason },
        note: "Price/volume proxies are handled by the Technical Agent and are deliberately NOT presented as sentiment.",
        provenance,
      };
    }

    const observations = check.observations;
    const news = observations.filter((observation) => observation.channel === "news");
    const social = observations.filter((observation) => observation.channel === "social");
    const score = Number(check.score);

    let reason = `${observations.length} attributable observation(s) within ${validator.maxAgeSeconds()}s `
      + `(news ${news.length}, social ${social.length}), mean score ${signedFormat(score, 2)}`;
    if (check.rejectedCount) {
      reason += ` (${check.rejectedCount} observation(s) excluded as stale or unattributable)`;
    }

    return {
      agent: SENTIMENT_AGENT_ID,
      title: "Sentiment Analysis Agent",
      generatedAt: context.now,
      // Documented bounded quality: floor 0.4, +0.1 per valid observation,
      // +0.05 per covered channel, capped at 1.0. Sentiment can inform; it cannot
      // carry a decision on its own.
      dataQuality: roundTo(Math.min(1, 0.4 + 0.1 * observations.length + 0.05 * news.length + 0.05 * social.length), 3),
      dataLimitations: [
        "Sentiment is a bounded, low-weight input (weight 0.5) — it can never override the risk engine or a NO_TRADE gate",
      ],
      warnings: [],
      vote: makeVote(score, AGENT_WEIGHTS[SENTIMENT_AGENT_ID], reason),
      news: { available: news.length > 0, observations: news.slice(0, MAX_OBSERVATIONS_REPORTED) },
      social: { available: social.length > 0, observations: social.slice(0, MAX_OBSERVATIONS_REPORTED) },
      note: `Licensed ${feed.id()} feed; every observation carries its own source and timestamp.`,
      provenance: {
        ...provenance,
        observedAt: check.provenance.observedAt,
        observedAtRange: check.provenance.observedAtRange,
      },
    };
  }

  return { id: SENTIMENT_AGENT_ID, applicable, analyze };
}
