/**
 * Trading Intelligence Agent — the consensus combiner.
 *
 * Ported from `application/libraries/Aegis/Agents/TradingIntelligenceAgent.php`.
 * It turns a panel of agent reports into one bias, one confidence, one
 * recommendation and an auditable reasoning list. It never touches a broker and it
 * never sees an order.
 *
 * The arithmetic is worth stating plainly, because it is the whole of the
 * platform's "AI" claim:
 *  - only agents whose own score cleared ±0.15 vote; the rest are listed as
 *    abstaining and contribute nothing (an abstention is not a neutral vote);
 *  - each vote is weighted by `agent weight × max(0.05, dataQuality)`, so a
 *    low-quality series cannot speak at full volume;
 *  - confluence is agreement × (0.5 + 0.5·|net score|) — a unanimous panel with a
 *    tiny net score is not confluent;
 *  - confidence is a fixed blend: 45% confluence, 25% |net score|, 15% regime
 *    clarity, 10% data quality, 5% freshness;
 *  - two hard gates force NO_TRADE regardless of the vote: data quality below 0.5
 *    and a freshness factor below 0.3 (which is what stale data maps to);
 *  - a directional recommendation additionally needs confidence ≥ 0.55, otherwise
 *    the answer is HOLD.
 *
 * One additive field over the legacy payload: `gates.hardBlocks`. The legacy code
 * computed those blocks, used them to force NO_TRADE, and then discarded them, so a
 * caller could see `NO_TRADE` without being told why. The reasoning strings are
 * unchanged.
 */

import { clamp, numberFormat, roundTo } from "../math.js";

const BIAS_THRESHOLD = 0.2;
const MINIMUM_CONFIDENCE_TO_ACT = 0.55;
const MINIMUM_DATA_QUALITY = 0.5;
const MINIMUM_FRESHNESS = 0.3;
const DATA_QUALITY_FLOOR = 0.05;

export function createTradingIntelligenceAgent() {
  /**
   * @param {Array<object>} reports agent reports, each with `vote` and `dataQuality`
   * @param {{dataQuality: number, regimeClarity: number, freshnessFactor: number}} input
   */
  function combine(reports, input) {
    const voting = reports.filter((report) => Boolean(report.vote?.votes));
    const abstaining = reports.filter((report) => !report.vote?.votes).map((report) => report.agent);

    const weightOf = (report) => report.vote.weight * Math.max(DATA_QUALITY_FLOOR, report.dataQuality ?? 0);

    let weightSum = 0;
    let accumulator = 0;
    for (const report of voting) {
      const weight = weightOf(report);
      accumulator += report.vote.directionalScore * weight;
      weightSum += weight;
    }
    const netScore = weightSum > 0 ? accumulator / weightSum : 0;

    const netSign = netScore > 0 ? 1 : (netScore < 0 ? -1 : 0);
    let agreeingWeight = 0;
    let totalWeight = 0;
    const conflicts = [];
    for (const report of voting) {
      const weight = weightOf(report);
      totalWeight += weight;
      const theirSign = report.vote.directionalScore > 0 ? 1 : (report.vote.directionalScore < 0 ? -1 : 0);
      if (theirSign === netSign && netSign !== 0) agreeingWeight += weight;
      else if (theirSign !== 0 && netSign !== 0) {
        conflicts.push({ agent: report.agent, theirBias: report.vote.signal, reason: report.vote.reason });
      }
    }
    const agreement = totalWeight > 0 ? agreeingWeight / totalWeight : 0;
    const confluence = clamp(agreement * (0.5 + 0.5 * Math.abs(netScore)), 0, 1);

    let bias;
    if (voting.length === 0) bias = "NO_TRADE";
    else if (Math.abs(netScore) < BIAS_THRESHOLD) bias = "NEUTRAL";
    else bias = netScore > 0 ? "BULLISH" : "BEARISH";

    const averageDataQuality = voting.length > 0
      ? voting.reduce((sum, report) => sum + (report.dataQuality ?? 0), 0) / voting.length
      : input.dataQuality;
    const confidence = clamp(
      confluence * 0.45
      + Math.abs(netScore) * 0.25
      + (input.regimeClarity ?? 0) * 0.15
      + averageDataQuality * 0.1
      + (input.freshnessFactor ?? 0) * 0.05,
      0,
      1,
    );

    const hardBlocks = [];
    if ((input.dataQuality ?? 0) < MINIMUM_DATA_QUALITY) hardBlocks.push("data quality too low");
    if ((input.freshnessFactor ?? 0) < MINIMUM_FRESHNESS) hardBlocks.push("data not fresh enough to act on");
    if (hardBlocks.length > 0 && bias !== "NEUTRAL") bias = "NO_TRADE";

    let recommendation;
    if (bias === "NO_TRADE") recommendation = "NO_TRADE";
    else if (bias === "NEUTRAL" || confidence < MINIMUM_CONFIDENCE_TO_ACT) recommendation = "HOLD";
    else recommendation = bias === "BULLISH" ? "BUY" : "SELL";

    const reasoning = voting.map((report) => `${report.title}: ${report.vote.directionalScore > 0 ? "bullish" : "bearish"} `
      + `(${numberFormat(report.vote.directionalScore, 2)}) — ${report.vote.reason}`);
    if (abstaining.length > 0) reasoning.push(`Abstaining (no data): ${abstaining.join(", ")}`);
    if (conflicts.length > 0) {
      reasoning.push(`Conflicts detected: ${conflicts.map((conflict) => `${conflict.agent} leans ${conflict.theirBias}`).join("; ")}`);
    }
    reasoning.push(`Confluence ${roundTo(confluence * 100, 0)}% (agreement ${roundTo(agreement * 100, 0)}%, net score ${numberFormat(netScore, 2)})`);

    return {
      bias,
      confidence: roundTo(confidence, 2),
      confluenceScore: roundTo(confluence, 2),
      recommendation,
      reasoning,
      gates: { hardBlocks },
      consensus: {
        netScore: roundTo(netScore, 3),
        agreement: roundTo(agreement, 2),
        votingAgents: voting.map((report) => report.agent),
        abstainingAgents: abstaining,
        conflicts,
      },
    };
  }

  return { combine };
}
