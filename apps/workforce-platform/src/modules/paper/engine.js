/**
 * Paper trading ledger arithmetic — the pure layer.
 *
 * Ported from `application/libraries/Aegis/Paper/PaperTradingEngine.php`
 * (`submitOrder` sizing, `fillOrder`, `closeAt`, `tick` SL/TP and limit
 * evaluation, `positionView`, `accountSummary` valuation).
 *
 * Nothing here touches a repository, a provider or the clock. Every function
 * takes its inputs explicitly and returns numbers or plain objects, so the
 * arithmetic that decides what a paper account is worth can be pinned with
 * hand-computed fixtures and no database. The service layer
 * (`service.js`, next step) owns the I/O, the governance chain and the audit
 * trail; it calls into here for every number it persists.
 *
 * Simulation only. Nothing in this file can place an order anywhere — there is
 * no broker connector in the Node edition, and the legacy PHP engine is the
 * same: "no order ever leaves the process".
 *
 * Costs mirror the backtester: a half-spread and slippage are paid against the
 * trader on both legs, and commission is charged on each leg's notional.
 */

import { roundTo } from "../analysis/math.js";

/** Basis-point costs, identical to the legacy engine's class constants. */
export const PAPER_COSTS = Object.freeze({
  spreadBps: 2.0,
  slippageBps: 2.0,
  feeBps: 2.0,
});

/** Default take-profit distance when the caller supplies none: 3R. */
export const DEFAULT_TAKE_PROFIT_R = 3;

/** Legacy persistence precision: prices to 8 dp, fees and P&L to 6 dp. */
const PRICE_DP = 8;
const MONEY_DP = 6;

function halfSpread() {
  return PAPER_COSTS.spreadBps / 2 / 10_000;
}

function slippage() {
  return PAPER_COSTS.slippageBps / 10_000;
}

/** Direction of a position from the order side: BUY opens LONG, SELL opens SHORT. */
export function directionOf(side) {
  return side === "BUY" ? "LONG" : "SHORT";
}

/**
 * Price actually paid when an entry fills. A LONG buys above the reference
 * price, a SHORT sells below it, so costs always work against the trader.
 */
export function entryFillPrice(direction, rawPrice) {
  const cost = halfSpread() + slippage();
  return direction === "LONG" ? rawPrice * (1 + cost) : rawPrice * (1 - cost);
}

/** Price actually received when a position closes — the mirror of the entry. */
export function exitFillPrice(direction, rawPrice) {
  const cost = halfSpread() + slippage();
  return direction === "LONG" ? rawPrice * (1 - cost) : rawPrice * (1 + cost);
}

/** Commission on one leg: units × price × feeBps. */
export function legFee(units, price) {
  return units * price * (PAPER_COSTS.feeBps / 10_000);
}

/**
 * Validate the protective levels for a proposed order and fill in the default
 * take-profit. A stop is mandatory; both levels must sit on the correct side of
 * the entry. Returns every reason it can find, not just the first, so an
 * operator sees the full set of problems in one response.
 *
 * @returns {{ok: boolean, reasons: string[], stopLoss: number|null, takeProfit: number|null}}
 */
export function validateProtection({ direction, price, stopLoss, takeProfit }) {
  const reasons = [];
  if (!isFiniteNumber(stopLoss)) {
    reasons.push("Stop loss is mandatory for paper orders (risk engine requirement)");
    return { ok: false, reasons, stopLoss: null, takeProfit: null };
  }
  const long = direction === "LONG";
  if (long ? !(stopLoss < price) : !(stopLoss > price)) {
    reasons.push("Stop loss must sit beyond the entry price on the correct side");
  }
  let tp = null;
  if (isFiniteNumber(takeProfit)) {
    tp = takeProfit;
    if (!(long ? tp > price : tp < price)) {
      reasons.push("Take profit must sit beyond the entry price on the correct side");
    }
  } else {
    const distance = Math.abs(price - stopLoss);
    tp = long ? price + DEFAULT_TAKE_PROFIT_R * distance : price - DEFAULT_TAKE_PROFIT_R * distance;
  }
  return { ok: reasons.length === 0, reasons, stopLoss, takeProfit: tp };
}

/**
 * Risk-based position size, capped by the notional limit. The per-trade risk
 * fraction is the caller's request clamped to the hard cap, or the configured
 * default when no request is given.
 *
 * @param {{equity:number, price:number, stopLoss:number, requestedRiskPct?:number|null, limits:{riskPerTradePct:number, maxRiskPerTradePct:number, maxPositionNotionalUsd:number}}} input
 * @returns {{units:number, riskAmount:number, riskPct:number, notional:number, capped:boolean}}
 */
export function sizeOrder({ equity, price, stopLoss, requestedRiskPct = null, limits }) {
  const riskPct = isFiniteNumber(requestedRiskPct)
    ? Math.min(requestedRiskPct, limits.maxRiskPerTradePct)
    : limits.riskPerTradePct;
  const perUnitRisk = Math.abs(price - stopLoss);
  let riskAmount = equity * riskPct;
  let units = riskAmount / perUnitRisk;
  let capped = false;
  if (units * price > limits.maxPositionNotionalUsd) {
    units = limits.maxPositionNotionalUsd / price;
    riskAmount = units * perUnitRisk;
    capped = true;
  }
  return {
    units,
    riskAmount,
    riskPct,
    notional: units * price,
    capped,
  };
}

/**
 * The order record a fill produces, plus the position it opens and the
 * balance movement it causes. The entry commission is taken from the balance
 * at the moment of the fill, exactly as the legacy engine does.
 */
export function fillEntry({ order, rawPrice, accountId, marketClass, nowIso, synthetic }) {
  const direction = directionOf(order.side);
  const fillPrice = entryFillPrice(direction, rawPrice);
  const entryFee = legFee(order.units, fillPrice);
  const filledOrder = {
    ...order,
    status: "FILLED",
    filledAt: nowIso,
    fillPrice: roundTo(fillPrice, PRICE_DP),
  };
  const position = {
    accountId,
    symbol: order.symbol,
    marketClass,
    direction,
    units: order.units,
    entryPrice: roundTo(fillPrice, PRICE_DP),
    stopLoss: order.stopLoss,
    takeProfit: order.takeProfit,
    entryFee: roundTo(entryFee, MONEY_DP),
    riskAmount: order.riskAmount,
    strategy: order.strategy ?? null,
    reason: order.reason ?? null,
    aiConfidence: order.aiConfidence ?? null,
    openedAt: nowIso,
    status: "OPEN",
    closedAt: null,
    exitPrice: null,
    realizedPnl: null,
    exitReason: null,
  };
  const entryTrade = {
    accountId,
    orderId: order.id ?? null,
    leg: "ENTRY",
    symbol: order.symbol,
    price: roundTo(fillPrice, PRICE_DP),
    units: order.units,
    fee: roundTo(entryFee, MONEY_DP),
    time: nowIso,
    synthetic: Boolean(synthetic),
  };
  return {
    order: filledOrder,
    position,
    entryTrade,
    balanceDelta: -entryFee,
  };
}

/**
 * Settle a close at a raw (pre-cost) exit price. Returns the realised numbers,
 * the balance movement and the journal fields. `balanceDelta` is gross P&L less
 * the exit commission: the entry commission was already deducted at the fill,
 * so the account moves by `netPnl + entryFee` in total — the identity the
 * legacy oracle asserts.
 */
export function settleClose({ position, rawExit, exitReason }) {
  const direction = position.direction;
  const exitPrice = exitFillPrice(direction, rawExit);
  const exitFee = legFee(position.units, exitPrice);
  const grossPnl =
    direction === "LONG"
      ? (exitPrice - position.entryPrice) * position.units
      : (position.entryPrice - exitPrice) * position.units;
  const netPnl = grossPnl - position.entryFee - exitFee;
  const risk = Math.abs(position.entryPrice - position.stopLoss) * position.units;
  const notional = position.units * position.entryPrice;
  return {
    exitPrice: roundTo(exitPrice, PRICE_DP),
    exitFee: roundTo(exitFee, MONEY_DP),
    grossPnl,
    netPnl: roundTo(netPnl, MONEY_DP),
    balanceDelta: grossPnl - exitFee,
    rMultiple: risk > 0 ? roundTo(netPnl / risk, 4) : null,
    pnlPct: notional > 0 ? (netPnl / notional) * 100 : null,
    exitReason,
    closedPosition: {
      ...position,
      status: "CLOSED",
      exitPrice: roundTo(exitPrice, PRICE_DP),
      realizedPnl: roundTo(netPnl, MONEY_DP),
      exitReason,
    },
    exitTrade: {
      accountId: position.accountId,
      orderId: null,
      leg: "EXIT",
      symbol: position.symbol,
      price: roundTo(exitPrice, PRICE_DP),
      units: position.units,
      fee: roundTo(exitFee, MONEY_DP),
    },
  };
}

/**
 * Stop and target evaluation for one bar. The stop is checked first: when a
 * single candle touches both, the pessimistic assumption is that the stop
 * filled, because the candle does not say which extreme came first.
 *
 * @returns {'STOP_LOSS'|'TAKE_PROFIT'|null}
 */
export function protectionHit(position, candle) {
  const long = position.direction === "LONG";
  const stopHit = long ? candle.low <= position.stopLoss : candle.high >= position.stopLoss;
  if (stopHit) return "STOP_LOSS";
  const targetHit = long ? candle.high >= position.takeProfit : candle.low <= position.takeProfit;
  if (targetHit) return "TAKE_PROFIT";
  return null;
}

/** Whether a pending LIMIT order's price was crossed by the latest bar. */
export function limitTouched(order, candle) {
  return order.side === "BUY" ? candle.low <= order.price : candle.high >= order.price;
}

/** Mark-to-market for one open position at a given price. */
export function positionValuation(position, price) {
  const pnl =
    (position.direction === "LONG" ? price - position.entryPrice : position.entryPrice - price) *
    position.units;
  const risk = Math.abs(position.entryPrice - position.stopLoss) * position.units;
  return {
    currentPrice: price,
    unrealizedPnl: roundTo(pnl, 2),
    unrealizedR: risk > 0 ? roundTo(pnl / risk, 3) : null,
    openRisk: Math.abs(position.entryPrice - position.stopLoss) * position.units,
    rawPnl: pnl,
  };
}

/**
 * Account-level valuation over every open position. `priceFor` is injected so
 * the caller decides where prices come from (the market-data service in
 * production, a fixed map in tests).
 */
export function valueAccount({ account, openPositions, priceFor }) {
  let unrealized = 0;
  const openRiskBySymbol = {};
  const views = openPositions.map((position) => {
    const { rawPnl, openRisk, ...view } = positionValuation(position, priceFor(position.symbol));
    unrealized += rawPnl;
    openRiskBySymbol[position.symbol] = (openRiskBySymbol[position.symbol] ?? 0) + openRisk;
    return { ...position, ...view };
  });
  const equity = account.balance + unrealized;
  return {
    equity: roundTo(equity, 2),
    balance: roundTo(account.balance, 2),
    unrealizedPnl: roundTo(unrealized, 2),
    openPositions: openPositions.length,
    openRiskBySymbol: Object.fromEntries(
      Object.entries(openRiskBySymbol).map(([symbol, value]) => [symbol, roundTo(value, 2)]),
    ),
    positions: views,
    rawEquity: equity,
  };
}

/**
 * Daily loss as a percentage of equity, positive when losing. Matches the
 * legacy `dailyLossPct` field; zero when equity is not positive, so a broken
 * account cannot divide by zero into a misleading number.
 */
export function dailyLossPct({ dailyPnl, equity }) {
  return equity > 0 ? roundTo((-dailyPnl / equity) * 100, 2) : 0;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
