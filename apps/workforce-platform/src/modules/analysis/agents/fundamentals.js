/**
 * Fundamentals Intelligence Agent — abstains until a licensed feed exists.
 *
 * Ported from `application/libraries/Aegis/Agents/FundamentalsAgent.php`.
 *
 * There is no fundamentals provider in this platform, and none is faked: earnings,
 * the macro calendar and issuer valuation are each reported as
 * `available: false` with the specific missing feed named. The agent votes
 * `votes: false`, so it is excluded from the consensus panel rather than counted
 * as a neutral vote, and its `dataQuality` is 0 — which also keeps it out of the
 * averaged data-quality figure the engine feeds to the risk gate.
 *
 * The one thing it does emit is the feed's own snapshot and provenance, so a
 * future licensed feed appears in the response without a shape change.
 */

import { unavailableFundamentalsFeed } from "../feeds.js";
import { AGENT_WEIGHTS } from "./helper.js";

export const FUNDAMENTALS_AGENT_ID = "fundamentals";

export function createFundamentalsAgent({ feed = unavailableFundamentalsFeed() } = {}) {
  function applicable() {
    return true;
  }

  function analyze(context) {
    const snapshot = feed.snapshot(context.series?.symbol);
    return {
      agent: FUNDAMENTALS_AGENT_ID,
      title: "Fundamentals Intelligence Agent",
      generatedAt: context.now,
      dataQuality: 0,
      dataLimitations: ["No licensed fundamentals provider configured"],
      warnings: ["Fundamentals unavailable — this agent abstains and cannot affect consensus"],
      vote: {
        directionalScore: 0,
        signal: "NEUTRAL",
        // Deliberately the low sentiment weight: an abstaining agent must not be
        // able to outweigh a price-derived one if it ever starts voting.
        weight: AGENT_WEIGHTS.sentiment,
        votes: false,
        reason: "No attributable fundamentals feed configured — abstaining",
      },
      earnings: { available: false, reason: "No earnings/calendar feed configured" },
      macro: { available: false, reason: "No macroeconomic release feed configured" },
      valuation: { available: false, reason: "No issuer fundamentals feed configured" },
      snapshot,
      provenance: {
        source: snapshot?.source ?? null,
        licensed: Boolean(snapshot?.licensed),
        feed: feed.id(),
      },
    };
  }

  return { id: FUNDAMENTALS_AGENT_ID, applicable, analyze };
}
