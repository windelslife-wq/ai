/**
 * Strict HTTP contracts for paper trading and its governance controls.
 *
 * Unsafe account operations are additionally guarded by the authenticated
 * user's `trading.execute` permission. Governance writes require
 * `trading.control`; reads require `trading.view`.
 */

import { MARKET_CLASSES } from "../market-data/timeframes.js";
import { STRATEGY_TIMEFRAMES } from "../strategies/contracts.js";

const SYMBOL = /^[A-Za-z0-9._-]{2,24}$/;
const STRATEGY_ID = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const VERSION = /^[A-Za-z0-9._-]{1,20}$/;

export const ACCOUNT_PARAMS = Object.freeze({
  accountId: { type: "integer", required: true, min: 1, max: Number.MAX_SAFE_INTEGER },
});

export const POSITION_PARAMS = Object.freeze({
  ...ACCOUNT_PARAMS,
  positionId: { type: "integer", required: true, min: 1, max: Number.MAX_SAFE_INTEGER },
});

export const DEPLOYMENT_PARAMS = Object.freeze({
  ...ACCOUNT_PARAMS,
  deploymentId: { type: "integer", required: true, min: 1, max: Number.MAX_SAFE_INTEGER },
});

export const ACCOUNT_CREATE_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["name", "startingBalance"],
  properties: Object.freeze({
    name: Object.freeze({ type: "string", minLength: 1, maxLength: 60, trim: true }),
    startingBalance: Object.freeze({ type: "number", min: 1, max: 10_000_000 }),
    currency: Object.freeze({ type: "string", minLength: 3, maxLength: 3, pattern: /^[A-Z]{3}$/i, default: "USD", trim: true }),
  }),
});

export const ORDER_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["symbol", "side"],
  properties: Object.freeze({
    symbol: Object.freeze({ type: "string", minLength: 2, maxLength: 24, pattern: SYMBOL, trim: true }),
    marketClass: Object.freeze({ type: "string", nullable: true, values: [...MARKET_CLASSES] }),
    side: Object.freeze({ type: "string", values: ["BUY", "SELL"] }),
    type: Object.freeze({ type: "string", values: ["MARKET", "LIMIT"], default: "MARKET" }),
    price: Object.freeze({ type: "number", nullable: true, min: Number.MIN_VALUE }),
    stopLoss: Object.freeze({ type: "number", nullable: true, min: Number.MIN_VALUE }),
    takeProfit: Object.freeze({ type: "number", nullable: true, min: Number.MIN_VALUE }),
    riskPct: Object.freeze({ type: "number", nullable: true, min: 0.000001, max: 0.05 }),
    reason: Object.freeze({ type: "string", nullable: true, maxLength: 500, trim: true }),
    confidence: Object.freeze({ type: "number", nullable: true, min: 0, max: 1 }),
    strategy: Object.freeze({ type: "string", nullable: true, maxLength: 60, pattern: STRATEGY_ID }),
    strategyVersion: Object.freeze({ type: "string", nullable: true, maxLength: 20, pattern: VERSION }),
  }),
});

export const ORDERS_QUERY = Object.freeze({
  status: { type: "string", values: ["PENDING", "FILLED", "REJECTED", "CANCELLED"] },
  limit: { type: "integer", min: 1, max: 2_000, default: 200 },
});

export const POSITIONS_QUERY = Object.freeze({
  status: { type: "string", values: ["OPEN", "CLOSED"] },
  limit: { type: "integer", min: 1, max: 2_000, default: 200 },
});

export const DEPLOYMENT_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["strategyId", "symbol", "timeframe", "marketClass"],
  properties: Object.freeze({
    strategyId: Object.freeze({ type: "string", minLength: 1, maxLength: 60, pattern: STRATEGY_ID }),
    strategyVersion: Object.freeze({ type: "string", nullable: true, maxLength: 20, pattern: VERSION }),
    symbol: Object.freeze({ type: "string", minLength: 2, maxLength: 24, pattern: SYMBOL, trim: true }),
    timeframe: Object.freeze({ type: "string", values: [...STRATEGY_TIMEFRAMES] }),
    marketClass: Object.freeze({ type: "string", values: [...MARKET_CLASSES] }),
  }),
});

export const DEPLOYMENT_TOGGLE_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["active"],
  properties: Object.freeze({ active: Object.freeze({ type: "boolean" }) }),
});

export const RISK_LIMITS_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: Object.freeze({
    riskPerTradePct: Object.freeze({ type: "number", min: 0.0001, max: 0.05 }),
    maxRiskPerTradePct: Object.freeze({ type: "number", min: 0.0001, max: 0.1 }),
    minRiskReward: Object.freeze({ type: "number", min: 0, max: 100 }),
    maxPositionNotionalUsd: Object.freeze({ type: "number", min: 1, max: 100_000_000 }),
    maxLeverage: Object.freeze({ type: "number", min: 1, max: 100 }),
    maxOpenPositions: Object.freeze({ type: "integer", min: 1, max: 100 }),
    maxDailyLossPct: Object.freeze({ type: "number", min: 0, max: 1 }),
    maxWeeklyLossPct: Object.freeze({ type: "number", min: 0, max: 1 }),
    maxDrawdownPct: Object.freeze({ type: "number", min: 0, max: 1 }),
    maxSymbolExposurePct: Object.freeze({ type: "number", min: 0, max: 1 }),
    maxPortfolioExposurePct: Object.freeze({ type: "number", min: 0, max: 1 }),
    maxCorrelatedPositions: Object.freeze({ type: "integer", min: 1, max: 100 }),
    minDataQuality: Object.freeze({ type: "number", min: 0, max: 1 }),
    blockSyntheticData: Object.freeze({ type: "boolean" }),
    blockStaleData: Object.freeze({ type: "boolean" }),
  }),
});

export const KILL_SWITCH_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["active"],
  properties: Object.freeze({
    active: Object.freeze({ type: "boolean" }),
    reason: Object.freeze({ type: "string", nullable: true, maxLength: 500, trim: true }),
  }),
});

export const TRADING_MODE_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  properties: Object.freeze({
    mode: Object.freeze({ type: "string", values: ["ANALYSIS_ONLY", "PAPER_TRADING"] }),
  }),
});

export const SYNTHETIC_PAPER_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["allow"],
  properties: Object.freeze({ allow: Object.freeze({ type: "boolean" }) }),
});

export const PORTFOLIO_QUERY = Object.freeze({
  limit: { type: "integer", min: 1, max: 100, default: 50 },
});

export const ROUTE_MESSAGES = Object.freeze({
  ACCOUNT_NOT_FOUND: "Paper account not found",
  ORDER_NOT_FOUND: "Paper order not found on this account",
  POSITION_NOT_FOUND: "Paper position not found or is already closed",
  DEPLOYMENT_NOT_FOUND: "Paper deployment not found on this account",
  TRADING_STATE_UNAVAILABLE: "Persisted trading governance is unavailable",
});
