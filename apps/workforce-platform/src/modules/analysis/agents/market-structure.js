/**
 * Market Structure Agent — swings, break of structure, change of character,
 * liquidity, supply/demand zones, order blocks and fair value gaps.
 *
 * Ported from `application/libraries/Aegis/Agents/MarketStructureAgent.php`.
 *
 * The rule that matters most here is confirmation: a break of structure counts
 * only when a candle *closes* beyond the level with a real body
 * (`minBodyRatio` 0.3). A wick that pierces a swing high and closes back inside is
 * recorded as `WICK`, scored as nothing, and surfaced as a warning — a liquidity
 * grab is not a breakout, and treating one as a breakout is how a structure agent
 * invents trends.
 *
 * The change-of-character test additionally requires three of the previous five
 * swing steps to have been on the other side, so a "reversal" needs a sequence to
 * reverse.
 */

import { roundTo } from "../math.js";
import { atr, findSwings, last } from "../indicators.js";
import { dataQuality, makeVote, AGENT_WEIGHTS } from "./helper.js";

export const MARKET_STRUCTURE_AGENT_ID = "market-structure";

export const STRUCTURE_RULES = Object.freeze({
  requireCloseBeyond: true,
  minBodyRatio: 0.3,
  swingStrength: 2,
});

const ZONE_WINDOW = 60;
const BREAK_SCAN_BARS = 10;
const LIQUIDITY_SWINGS = 8;
const MAX_ZONES = 4;

function countIn(sequence, labels) {
  return sequence.filter((step) => labels.includes(step)).length;
}

function detectBreak(candles, swingHigh, swingLow) {
  const result = { detected: false, direction: "NEUTRAL", level: null, confirmedBy: "NONE", barsAgo: null };
  if (swingHigh === null && swingLow === null) return result;

  const n = candles.length;
  const scan = Math.min(n, BREAK_SCAN_BARS);
  for (let i = n - scan; i < n; i += 1) {
    if (i < 0) continue;
    const candle = candles[i];
    const bodyRatio = candle.high - candle.low > 0
      ? Math.abs(candle.close - candle.open) / (candle.high - candle.low)
      : 0;
    const bodyOk = bodyRatio >= STRUCTURE_RULES.minBodyRatio;

    if (swingHigh !== null && (candle.high > swingHigh || candle.close > swingHigh)) {
      result.detected = true;
      result.direction = "BUY";
      result.level = swingHigh;
      result.barsAgo = n - 1 - i;
      if (candle.close > swingHigh && (bodyOk || !STRUCTURE_RULES.requireCloseBeyond)) result.confirmedBy = "CLOSE";
      else if (candle.high > swingHigh) result.confirmedBy = "WICK";
      if (result.confirmedBy === "CLOSE") break;
    }
    if (swingLow !== null && (candle.low < swingLow || candle.close < swingLow)) {
      result.detected = true;
      result.direction = "SELL";
      result.level = swingLow;
      result.barsAgo = n - 1 - i;
      if (candle.close < swingLow && (bodyOk || !STRUCTURE_RULES.requireCloseBeyond)) result.confirmedBy = "CLOSE";
      else if (candle.low < swingLow) result.confirmedBy = "WICK";
      if (result.confirmedBy === "CLOSE") break;
    }
  }
  return result;
}

function detectChangeOfCharacter(sequence, breakOfStructure) {
  const tail = sequence.slice(-6);
  const before = tail.slice(0, -1);
  const bullishBefore = countIn(before, ["HH", "HL"]) >= 3;
  const bearishBefore = countIn(before, ["LH", "LL"]) >= 3;
  const none = { detected: false, direction: "NEUTRAL", level: null, confirmedBy: "NONE" };
  if (!breakOfStructure.detected || breakOfStructure.confirmedBy !== "CLOSE") return none;
  if (breakOfStructure.direction === "SELL" && bullishBefore) {
    return { detected: true, direction: "SELL", level: breakOfStructure.level, confirmedBy: "CLOSE" };
  }
  if (breakOfStructure.direction === "BUY" && bearishBefore) {
    return { detected: true, direction: "BUY", level: breakOfStructure.level, confirmedBy: "CLOSE" };
  }
  return none;
}

function detectZones(window, atrValue) {
  const supply = [];
  const demand = [];
  const orderBlocks = [];
  const fairValueGaps = [];

  for (let i = 2; i < window.length - 1; i += 1) {
    const first = window[i - 2];
    const impulse = window[i - 1];
    const third = window[i];
    const rangeOf = (candle) => candle.high - candle.low;
    // With no ATR the comparison degenerates to `range > 1.2 * range`, which is
    // never true — the legacy behaviour, and the safe one: no volatility measure,
    // no impulse claim.
    const reference = atrValue ?? rangeOf(impulse);

    const bearImpulse = impulse.close < impulse.open && rangeOf(impulse) > 1.2 * reference;
    if (bearImpulse && first.close > first.open) {
      supply.push({ min: roundTo(first.low, 6), max: roundTo(first.high, 6), formedAt: first.timestamp });
      orderBlocks.push({ side: "bearish", min: roundTo(first.low, 6), max: roundTo(first.high, 6), formedAt: first.timestamp });
    }
    const bullImpulse = impulse.close > impulse.open && rangeOf(impulse) > 1.2 * reference;
    if (bullImpulse && first.close < first.open) {
      demand.push({ min: roundTo(first.low, 6), max: roundTo(first.high, 6), formedAt: first.timestamp });
      orderBlocks.push({ side: "bullish", min: roundTo(first.low, 6), max: roundTo(first.high, 6), formedAt: first.timestamp });
    }
    if (first.high < third.low) {
      fairValueGaps.push({ direction: "bullish", min: roundTo(first.high, 6), max: roundTo(third.low, 6), formedAt: impulse.timestamp });
    }
    if (first.low > third.high) {
      fairValueGaps.push({ direction: "bearish", min: roundTo(third.high, 6), max: roundTo(first.low, 6), formedAt: impulse.timestamp });
    }
  }

  return {
    supply: supply.slice(-MAX_ZONES),
    demand: demand.slice(-MAX_ZONES),
    orderBlocks: orderBlocks.slice(-MAX_ZONES),
    fvgs: fairValueGaps.slice(-MAX_ZONES),
  };
}

export function createMarketStructureAgent() {
  function applicable() {
    return true;
  }

  function analyze(context) {
    const candles = context.series?.candles ?? [];
    if (!Array.isArray(candles) || candles.length === 0) {
      throw new Error("insufficient candles for market-structure analysis");
    }

    const swings = findSwings(candles, STRUCTURE_RULES.swingStrength);
    const atr14 = last(atr(candles, 14));
    const lastClose = candles[candles.length - 1].close;

    // Swing sequence: each swing compared with the previous swing of its own type.
    const sequence = [];
    for (let i = 2; i < swings.length; i += 1) {
      const current = swings[i];
      let previousSame = null;
      for (let j = i - 1; j >= 0; j -= 1) {
        if (swings[j].type === current.type) {
          previousSame = swings[j];
          break;
        }
      }
      if (!previousSame) continue;
      if (current.type === "high") sequence.push(current.price > previousSame.price ? "HH" : "LH");
      else sequence.push(current.price < previousSame.price ? "LL" : "HL");
    }

    const tail = sequence.slice(-6);
    const higherCount = countIn(tail, ["HH", "HL"]);
    const lowerCount = countIn(tail, ["LH", "LL"]);
    const trendLabel = higherCount >= lowerCount + 2
      ? "uptrend"
      : (lowerCount >= higherCount + 2 ? "downtrend" : "range");

    let lastHigh = null;
    let lastLow = null;
    for (let i = swings.length - 1; i >= 0; i -= 1) {
      if (lastHigh === null && swings[i].type === "high") lastHigh = swings[i];
      if (lastLow === null && swings[i].type === "low") lastLow = swings[i];
      if (lastHigh !== null && lastLow !== null) break;
    }

    const breakOfStructure = detectBreak(candles, lastHigh?.price ?? null, lastLow?.price ?? null);
    const changeOfCharacter = detectChangeOfCharacter(sequence, breakOfStructure);

    const liquidity = swings.slice(-LIQUIDITY_SWINGS).map((swing) => ({
      type: swing.type === "high" ? "buy-side" : "sell-side",
      price: roundTo(swing.price, 6),
      formedAt: swing.timestamp,
    }));

    const zones = detectZones(candles.slice(-Math.min(candles.length, ZONE_WINDOW)), atr14);

    let score = 0;
    const reasons = [];
    if (trendLabel === "uptrend") {
      score += 0.35;
      reasons.push("swing sequence shows HH/HL dominance");
    }
    if (trendLabel === "downtrend") {
      score -= 0.35;
      reasons.push("swing sequence shows LH/LL dominance");
    }
    if (breakOfStructure.detected && breakOfStructure.direction === "BUY" && breakOfStructure.confirmedBy === "CLOSE") {
      score += 0.3;
      reasons.push("confirmed bullish break of structure (close beyond)");
    }
    if (breakOfStructure.detected && breakOfStructure.direction === "SELL" && breakOfStructure.confirmedBy === "CLOSE") {
      score -= 0.3;
      reasons.push("confirmed bearish break of structure (close beyond)");
    }
    if (changeOfCharacter.detected && changeOfCharacter.confirmedBy === "CLOSE") {
      score += changeOfCharacter.direction === "BUY" ? 0.25 : -0.25;
      reasons.push(`change of character ${changeOfCharacter.direction === "BUY" ? "bullish" : "bearish"} (close-confirmed)`);
    }
    if (breakOfStructure.detected && breakOfStructure.confirmedBy === "WICK") {
      reasons.push("price wicked beyond structure but did NOT close beyond — unconfirmed");
    }

    // The nearest demand zone *below* price is the last one that qualifies; the
    // nearest supply zone *above* price is the first one that does.
    let nearestDemand = null;
    for (const zone of zones.demand) {
      if (zone.max < lastClose) nearestDemand = zone;
    }
    let nearestSupply = null;
    for (const zone of zones.supply) {
      if (zone.min > lastClose && nearestSupply === null) nearestSupply = zone;
    }
    if (nearestDemand && atr14 && lastClose - nearestDemand.max < atr14) {
      score += 0.15;
      reasons.push("price resting on demand zone");
    }
    if (nearestSupply && atr14 && nearestSupply.min - lastClose < atr14) {
      score -= 0.15;
      reasons.push("price pressing into supply zone");
    }

    const zoneBars = Math.min(candles.length, ZONE_WINDOW);
    return {
      agent: MARKET_STRUCTURE_AGENT_ID,
      title: "Market Structure Agent",
      generatedAt: context.now,
      dataQuality: dataQuality(context.series),
      dataLimitations: [
        `Zone detection uses the last ${zoneBars} bars only`,
        ...(swings.length < 4 ? ["Fewer than 4 swings detected — structure mapping is weak"] : []),
      ],
      warnings: breakOfStructure.detected && breakOfStructure.confirmedBy === "WICK"
        ? ["Wick-only break NOT treated as confirmation (configured rule)"]
        : [],
      vote: makeVote(score, AGENT_WEIGHTS[MARKET_STRUCTURE_AGENT_ID], reasons.slice(0, 3).join("; ") || "no dominant structure"),
      swingSequence: tail,
      trendLabel,
      events: { breakOfStructure, changeOfCharacter },
      liquidityZones: liquidity,
      supplyZones: zones.supply,
      demandZones: zones.demand,
      orderBlocks: zones.orderBlocks,
      fairValueGaps: zones.fvgs,
    };
  }

  return { id: MARKET_STRUCTURE_AGENT_ID, applicable, analyze };
}
