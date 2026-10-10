/**
 * Paper trading — the pure ledger arithmetic (`src/modules/paper/engine.js`).
 *
 * Ported from `application/libraries/Aegis/Paper/PaperTradingEngine.php`, with
 * the oracle `tests/cases/07-paper-trading.php` as the reference. Every
 * expected value below is computed by hand from the cost constants, not read
 * back from the code under test. The legacy oracle's paper cases are largely
 * conditional (`if (quote.synthetic) { ... }`) and can pass without asserting
 * anything; these fixtures take the price as an input so every branch runs.
 *
 * The governance chain (kill switch, trading mode, risk engine gate), the
 * repository and the HTTP surface are covered by later tests once they exist.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_TAKE_PROFIT_R,
  PAPER_COSTS,
  dailyLossPct,
  directionOf,
  entryFillPrice,
  exitFillPrice,
  fillEntry,
  legFee,
  limitTouched,
  positionValuation,
  protectionHit,
  settleClose,
  sizeOrder,
  valueAccount,
  validateProtection,
} from "../src/modules/paper/engine.js";

const LIMITS = Object.freeze({
  riskPerTradePct: 0.01,
  maxRiskPerTradePct: 0.02,
  maxPositionNotionalUsd: 50_000,
});

const HALF_SPREAD = 0.0001; // 2 bps / 2
const SLIPPAGE = 0.0002; // 2 bps
const FEE = 0.0002; // 2 bps

describe("legacy: costs and fills", () => {
  test("the cost constants are the legacy values", () => {
    assert.deepEqual(PAPER_COSTS, { spreadBps: 2, slippageBps: 2, feeBps: 2 });
    assert.equal(DEFAULT_TAKE_PROFIT_R, 3);
  });

  test("entry fills pay half-spread and slippage against the trader on both sides", () => {
    assert.ok(Math.abs(entryFillPrice("LONG", 100) - 100 * (1 + HALF_SPREAD + SLIPPAGE)) < 1e-12);
    assert.ok(Math.abs(entryFillPrice("LONG", 100) - 100.03) < 1e-12);
    assert.ok(Math.abs(entryFillPrice("SHORT", 100) - 99.97) < 1e-12);
  });

  test("exit fills mirror the entry: a LONG sells below, a SHORT buys back above", () => {
    assert.ok(Math.abs(exitFillPrice("LONG", 110) - 110 * (1 - HALF_SPREAD - SLIPPAGE)) < 1e-12);
    assert.ok(Math.abs(exitFillPrice("SHORT", 90) - 90 * (1 + HALF_SPREAD + SLIPPAGE)) < 1e-12);
  });

  test("commission is units × price × feeBps on each leg", () => {
    assert.ok(Math.abs(legFee(10, 100) - 10 * 100 * FEE) < 1e-12);
    assert.ok(Math.abs(legFee(10, 100) - 0.2) < 1e-12);
  });

  test("direction follows the order side", () => {
    assert.equal(directionOf("BUY"), "LONG");
    assert.equal(directionOf("SELL"), "SHORT");
  });
});

describe("legacy: sizing and protective levels", () => {
  test("size = equity × risk fraction ÷ stop distance (equity 10 000, 1 %, stop 2 away)", () => {
    const s = sizeOrder({ equity: 10_000, price: 100, stopLoss: 98, limits: LIMITS });
    assert.equal(s.units, 50);
    assert.equal(s.riskAmount, 100);
    assert.equal(s.notional, 5_000);
    assert.equal(s.capped, false);
    assert.equal(s.riskPct, 0.01);
  });

  test("a requested risk above the hard cap is clamped to the cap, not refused", () => {
    const s = sizeOrder({ equity: 10_000, price: 100, stopLoss: 98, requestedRiskPct: 0.05, limits: LIMITS });
    assert.equal(s.riskPct, 0.02);
    assert.equal(s.riskAmount, 200);
    assert.equal(s.units, 100);
  });

  test("the notional cap binds on a tight stop and reduces the risk actually taken", () => {
    const s = sizeOrder({ equity: 10_000, price: 100, stopLoss: 99.9, limits: LIMITS });
    assert.equal(s.capped, true);
    assert.equal(s.units, 500); // 50 000 / 100
    assert.ok(Math.abs(s.riskAmount - 50) < 1e-9); // 500 × 0.10
    assert.ok(Math.abs(s.notional - 50_000) < 1e-9);
  });

  test("a stop is mandatory", () => {
    const v = validateProtection({ direction: "LONG", price: 100, stopLoss: null, takeProfit: null });
    assert.equal(v.ok, false);
    assert.match(v.reasons[0], /Stop loss is mandatory/);
  });

  test("the stop must sit beyond the entry on the correct side", () => {
    const long = validateProtection({ direction: "LONG", price: 100, stopLoss: 101 });
    assert.equal(long.ok, false);
    assert.match(long.reasons[0], /Stop loss must sit beyond/);
    const short = validateProtection({ direction: "SHORT", price: 100, stopLoss: 99 });
    assert.equal(short.ok, false);
    assert.match(short.reasons[0], /Stop loss must sit beyond/);
  });

  test("with no take-profit supplied the target is 3R on the stop distance", () => {
    const long = validateProtection({ direction: "LONG", price: 100, stopLoss: 98 });
    assert.equal(long.ok, true);
    assert.ok(Math.abs(long.takeProfit - 106) < 1e-12);
    const short = validateProtection({ direction: "SHORT", price: 100, stopLoss: 102 });
    assert.ok(Math.abs(short.takeProfit - 94) < 1e-12);
  });

  test("an explicit take-profit on the wrong side is refused", () => {
    const v = validateProtection({ direction: "LONG", price: 100, stopLoss: 98, takeProfit: 99 });
    assert.equal(v.ok, false);
    assert.match(v.reasons[0], /Take profit must sit beyond/);
  });

  test("every protection problem is reported at once, not just the first", () => {
    const v = validateProtection({ direction: "LONG", price: 100, stopLoss: 101, takeProfit: 99 });
    assert.equal(v.reasons.length, 2);
  });
});

describe("legacy: stop, target and limit evaluation on a bar", () => {
  const long = { direction: "LONG", stopLoss: 98, takeProfit: 105 };
  const short = { direction: "SHORT", stopLoss: 102, takeProfit: 95 };

  test("a bar touching both stop and target resolves to the stop (pessimistic)", () => {
    assert.equal(protectionHit(long, { low: 97, high: 106 }), "STOP_LOSS");
  });

  test("LONG: stop on the low, target on the high, otherwise nothing", () => {
    assert.equal(protectionHit(long, { low: 97, high: 104 }), "STOP_LOSS");
    assert.equal(protectionHit(long, { low: 99, high: 106 }), "TAKE_PROFIT");
    assert.equal(protectionHit(long, { low: 99, high: 101 }), null);
  });

  test("SHORT: stop on the high, target on the low, otherwise nothing", () => {
    assert.equal(protectionHit(short, { low: 94, high: 103 }), "STOP_LOSS");
    assert.equal(protectionHit(short, { low: 94, high: 101 }), "TAKE_PROFIT");
    assert.equal(protectionHit(short, { low: 96, high: 101 }), null);
  });

  test("a BUY limit fills when the bar's low reaches it; a SELL limit when the high does", () => {
    assert.equal(limitTouched({ side: "BUY", price: 100 }, { low: 99.5, high: 101 }), true);
    assert.equal(limitTouched({ side: "BUY", price: 100 }, { low: 100.5, high: 101 }), false);
    assert.equal(limitTouched({ side: "SELL", price: 100 }, { low: 99, high: 100.5 }), true);
    assert.equal(limitTouched({ side: "SELL", price: 100 }, { low: 99, high: 99.5 }), false);
  });
});

describe("legacy: fills, closes and the balance identity", () => {
  const order = {
    id: "o-1", side: "BUY", symbol: "BTCUSDT", units: 10, stopLoss: 98, takeProfit: 106,
    riskAmount: 20, reason: "fixture", aiConfidence: 0.6, strategy: "trend-following",
  };
  const NOW = "2026-10-10T10:00:00.000Z";

  test("a fill produces the order, the position, the entry leg and the balance movement", () => {
    const f = fillEntry({ order, rawPrice: 100, accountId: 7, marketClass: "crypto", nowIso: NOW, synthetic: true });
    assert.equal(f.order.status, "FILLED");
    assert.equal(f.position.direction, "LONG");
    assert.equal(f.position.entryPrice, 100.03);
    assert.equal(f.position.entryFee, 0.20006);
    assert.equal(f.entryTrade.leg, "ENTRY");
    assert.equal(f.entryTrade.synthetic, true);
    assert.ok(Math.abs(f.balanceDelta + 0.20006) < 1e-9);
  });

  test("a close settles P&L, costs and balance so that balance moves by netPnl + entry fee", () => {
    const f = fillEntry({ order, rawPrice: 100, accountId: 7, marketClass: "crypto", nowIso: NOW, synthetic: false });
    const c = settleClose({ position: f.position, rawExit: 110, exitReason: "MANUAL" });
    assert.equal(c.exitPrice, 109.967);
    const exitFee = 10 * 109.967 * FEE;
    const gross = (109.967 - 100.03) * 10;
    assert.ok(Math.abs(c.grossPnl - gross) < 1e-9);
    assert.ok(Math.abs(c.exitFee - exitFee) < 1e-6);
    assert.ok(Math.abs(c.netPnl - (gross - 0.20006 - exitFee)) < 1e-5);
    // The oracle identity: the account moves by netPnl + the entry commission already taken at fill.
    assert.ok(Math.abs(c.balanceDelta - (c.netPnl + 0.20006)) < 1e-5);
    assert.equal(c.closedPosition.status, "CLOSED");
    assert.equal(c.exitTrade.leg, "EXIT");
  });

  test("R-multiple is net P&L over the risk taken at entry (|entry − stop| × units)", () => {
    const f = fillEntry({ order, rawPrice: 100, accountId: 7, marketClass: "crypto", nowIso: NOW, synthetic: false });
    const c = settleClose({ position: f.position, rawExit: 110, exitReason: "TAKE_PROFIT" });
    const risk = Math.abs(100.03 - 98) * 10;
    assert.equal(c.rMultiple, Math.round((c.netPnl / risk) * 1e4) / 1e4);
  });

  test("a SHORT mirrors the LONG: exit above the reference and P&L from entry down", () => {
    const shortOrder = { ...order, side: "SELL", stopLoss: 102, takeProfit: 94 };
    const f = fillEntry({ order: shortOrder, rawPrice: 100, accountId: 7, marketClass: "crypto", nowIso: NOW, synthetic: false });
    assert.equal(f.position.direction, "SHORT");
    assert.equal(f.position.entryPrice, 99.97);
    const c = settleClose({ position: f.position, rawExit: 90, exitReason: "TAKE_PROFIT" });
    assert.ok(Math.abs(c.exitPrice - 90.027) < 1e-9);
    assert.ok(c.grossPnl > 0);
  });

  test("a round trip at an unchanged price loses exactly the spread, slippage and commission", () => {
    const f = fillEntry({ order, rawPrice: 100, accountId: 7, marketClass: "crypto", nowIso: NOW, synthetic: false });
    const c = settleClose({ position: f.position, rawExit: 100, exitReason: "MANUAL" });
    assert.ok(Math.abs(c.grossPnl - (99.97 - 100.03) * 10) < 1e-9); // −0.60 from the cost of crossing twice
    assert.ok(c.netPnl < 0);
  });
});

describe("legacy: marking, account valuation and daily loss", () => {
  test("LONG and SHORT mark-to-market; unrealised R is P&L over initial risk", () => {
    const pos = { direction: "LONG", units: 10, entryPrice: 100, stopLoss: 98 };
    const v = positionValuation(pos, 105);
    assert.equal(v.unrealizedPnl, 50);
    assert.equal(v.unrealizedR, 2.5); // 50 ÷ (2 × 10)
    // A SHORT loses when the price rises: (entry − mark) × units = (100 − 102) × 5
    const sv = positionValuation({ direction: "SHORT", units: 5, entryPrice: 100, stopLoss: 103 }, 102);
    assert.equal(sv.unrealizedPnl, -10);
  });

  test("account valuation: equity = balance + unrealised, open risk summed per symbol", () => {
    const account = { balance: 5_000 };
    const openPositions = [
      { symbol: "BTCUSDT", direction: "LONG", units: 10, entryPrice: 100, stopLoss: 98 },
      { symbol: "BTCUSDT", direction: "SHORT", units: 5, entryPrice: 100, stopLoss: 103 },
      { symbol: "ETHUSDT", direction: "LONG", units: 2, entryPrice: 50, stopLoss: 49 },
    ];
    const prices = { BTCUSDT: 105, ETHUSDT: 48 };
    const v = valueAccount({ account, openPositions, priceFor: (s) => prices[s] });
    // BTC LONG +50, BTC SHORT (100-105)*5 = -25, ETH LONG (48-50)*2 = -4
    assert.equal(v.unrealizedPnl, 21);
    assert.equal(v.equity, 5_021);
    assert.equal(v.openPositions, 3);
    assert.equal(v.openRiskBySymbol.BTCUSDT, 20 + 15); // 2×10 + 3×5
    assert.equal(v.openRiskBySymbol.ETHUSDT, 2);
    assert.ok(!("rawPnl" in v.positions[0]) && !("openRisk" in v.positions[0]));
  });

  test("daily loss is a positive percentage of equity when losing, and never divides by a non-positive equity", () => {
    assert.equal(dailyLossPct({ dailyPnl: -50, equity: 5_000 }), 1);
    assert.equal(dailyLossPct({ dailyPnl: 100, equity: 5_000 }), -2);
    assert.equal(dailyLossPct({ dailyPnl: -50, equity: 0 }), 0);
  });
});
