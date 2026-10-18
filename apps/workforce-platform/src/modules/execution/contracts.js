/** Strict contracts for the simulation-only Execution Supervisor workflow. */

const SYMBOL = /^[A-Za-z0-9._-]{2,24}$/;
const MARKET_CLASS = /^(forex|crypto|stock|etf|commodity|futures|options|indices|bonds)$/i;
const SIDE = /^(buy|sell)$/i;
const ORDER_TYPE = /^(market|limit)$/i;
const STRATEGY_ID = /^[a-z0-9][a-z0-9_-]{0,59}$/i;
const VERSION = /^[A-Za-z0-9._-]{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PROPOSAL_PARAMS = Object.freeze({
  proposalId: Object.freeze({ type: "string", required: true, minLength: 36, maxLength: 36, pattern: UUID }),
});

export const PROPOSAL_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["accountId", "symbol", "marketClass", "side", "stopLoss"],
  properties: Object.freeze({
    accountId: Object.freeze({ type: "integer", min: 1, max: Number.MAX_SAFE_INTEGER }),
    symbol: Object.freeze({ type: "string", minLength: 2, maxLength: 24, pattern: SYMBOL, trim: true }),
    marketClass: Object.freeze({ type: "string", minLength: 3, maxLength: 9, pattern: MARKET_CLASS }),
    side: Object.freeze({ type: "string", pattern: SIDE }),
    type: Object.freeze({ type: "string", pattern: ORDER_TYPE, default: "MARKET" }),
    price: Object.freeze({ type: "number", nullable: true, min: Number.MIN_VALUE }),
    stopLoss: Object.freeze({ type: "number", min: Number.MIN_VALUE }),
    takeProfit: Object.freeze({ type: "number", nullable: true, min: Number.MIN_VALUE }),
    riskPct: Object.freeze({ type: "number", nullable: true, min: 0.000001, max: 0.05 }),
    reason: Object.freeze({ type: "string", nullable: true, maxLength: 500, trim: true }),
    confidence: Object.freeze({ type: "number", nullable: true, min: 0, max: 1 }),
    strategyId: Object.freeze({ type: "string", nullable: true, maxLength: 60, pattern: STRATEGY_ID }),
    strategyVersion: Object.freeze({ type: "string", nullable: true, maxLength: 20, pattern: VERSION }),
  }),
});

export const PROPOSALS_QUERY = Object.freeze({
  status: Object.freeze({
    type: "string",
    values: ["REJECTED", "PENDING_APPROVAL", "APPROVED", "DECLINED", "EXPIRED", "PAPER_SUBMITTING", "PAPER_EXECUTED", "PAPER_PENDING", "PAPER_REJECTED", "PAPER_FAILED", "SIMULATOR_SUBMITTING", "SIMULATOR_EXECUTED", "SIMULATOR_PENDING", "SIMULATOR_FAILED"],
  }),
  limit: Object.freeze({ type: "integer", min: 1, max: 500, default: 100 }),
});

export const DECISION_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["approve", "reason"],
  properties: Object.freeze({
    approve: Object.freeze({ type: "boolean" }),
    reason: Object.freeze({ type: "string", minLength: 10, maxLength: 1_000, trim: true }),
  }),
});

export const EXECUTION_MODE_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  properties: Object.freeze({
    mode: Object.freeze({ type: "string", values: ["HUMAN_APPROVAL", "SEMI_AUTONOMOUS", "FULLY_AUTOMATED"] }),
  }),
});

export const AUTOMATION_LIMITS_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: Object.freeze({
    maxDailyTrades: Object.freeze({ type: "integer", min: 1, max: 100 }),
    maxTradeNotionalUsd: Object.freeze({ type: "number", min: 1, max: 100_000_000 }),
    maxRiskPerTradePct: Object.freeze({ type: "number", min: 0.0001, max: 0.05 }),
    approvedSymbols: Object.freeze({
      type: "array",
      maxItems: 100,
      uniqueItems: true,
      items: Object.freeze({ type: "string", minLength: 2, maxLength: 24, pattern: SYMBOL }),
    }),
  }),
});

export const EMPTY_BODY = Object.freeze({ type: "object", additionalProperties: false, properties: Object.freeze({}) });
