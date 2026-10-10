/**
 * Request contracts, the agent catalogue and the watchlist for the analysis API.
 *
 * The vocabulary mirrors `application/controllers/Api_analysis.php`: the same
 * market classes, the same six timeframes, the same 1–10 symbol bound on a
 * consensus scan and the same default watchlist, so an existing client keeps
 * working after cutover.
 *
 * Three divergences from the legacy controller, all recorded in
 * `docs/migration/PHASE5_ANALYSIS.md`:
 *  - an out-of-vocabulary `timeframe` on a consensus scan is **rejected** (400)
 *    instead of being silently replaced with `1h`. A caller asking for a 5-minute
 *    consensus deserves to be told it is unsupported, not handed an hourly one.
 *  - `symbol` gains the platform's 24-character ceiling (the legacy controller had
 *    a minimum but no maximum).
 *  - `GET /analysis/history` accepts a bounded `limit` (1–100, default 20). The
 *    legacy route was hard-coded to 20 rows with no way to ask for more.
 */

import { MARKET_CLASSES, TIMEFRAMES } from "../market-data/timeframes.js";

export { MARKET_CLASSES, TIMEFRAMES };

/** Timeframes a consensus scan may use — the legacy list, narrower than the six. */
export const CONSENSUS_TIMEFRAMES = Object.freeze(["15m", "1h", "4h", "1d"]);

/** Legacy default watchlist for a consensus scan with no symbols supplied. */
export const DEFAULT_WATCHLIST = Object.freeze(["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "BTCUSDT", "ETHUSDT", "SOLUSDT"]);

export const MAX_CONSENSUS_SYMBOLS = 10;

/**
 * Body schemas use the object dialect (`type`/`properties`/`required`), unlike the
 * flat field-map dialect used for query and path parameters. The distinction
 * matters: with `additionalProperties: false` an undeclared key is rejected with
 * UNKNOWN_PROPERTY, so a caller cannot smuggle an unvalidated field into a run.
 */
export const RUN_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["symbol", "marketClass"],
  properties: Object.freeze({
    symbol: Object.freeze({ type: "string", minLength: 2, maxLength: 24 }),
    marketClass: Object.freeze({ type: "string", values: [...MARKET_CLASSES] }),
    timeframe: Object.freeze({ type: "string", values: [...TIMEFRAMES], default: "1h" }),
  }),
});

export const CONSENSUS_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: Object.freeze({
    timeframe: Object.freeze({ type: "string", values: [...CONSENSUS_TIMEFRAMES], default: "1h" }),
    symbols: Object.freeze({
      type: "array",
      nullable: true,
      minItems: 1,
      maxItems: MAX_CONSENSUS_SYMBOLS,
      unique: true,
      items: Object.freeze({ type: "string", minLength: 2, maxLength: 24 }),
    }),
  }),
});

export const HISTORY_QUERY = Object.freeze({
  limit: { type: "integer", min: 1, max: 100, default: 20 },
});

export const RUN_PARAMS = Object.freeze({
  runId: { type: "string", required: true, minLength: 1, maxLength: 64, pattern: /^[A-Za-z0-9_-]+$/ },
});

/**
 * The static agent catalogue served by `GET /analysis/agents`.
 *
 * Ported verbatim from `Api_analysis::agents()`, including the two descriptions
 * that advertise what is *not* available ("macro unavailable (no provider)",
 * "on-chain/derivatives/dominance honestly unavailable", "Abstains until real
 * news/social providers are configured"). A catalogue that described only
 * capabilities would misrepresent the platform.
 *
 * The legacy list has six entries and omits the fundamentals agent, which the
 * engine does run. It is included here as a seventh entry — additive, and the
 * alternative is an endpoint that hides a panel member.
 */
export const AGENT_CATALOGUE = Object.freeze([
  {
    id: "technical",
    title: "Technical Analysis Agent",
    description: "SMA/EMA/RSI/MACD/BB/ATR/ADX/VWAP/Stochastic/S-R/pivots/volume profile",
  },
  {
    id: "market-structure",
    title: "Market Structure Agent",
    description: "Swings, BOS/CHoCH with close-confirmation, liquidity, S/D zones, order blocks, FVGs",
  },
  {
    id: "forex",
    title: "Forex Analysis Agent",
    description: "Classification, volatility, sessions, price-momentum currency strength; macro unavailable (no provider)",
  },
  {
    id: "crypto",
    title: "Cryptocurrency Intelligence Agent",
    description: "Price/volume/volatility from candles; on-chain/derivatives/dominance honestly unavailable",
  },
  {
    id: "sentiment",
    title: "Sentiment Analysis Agent",
    description: "Abstains until real news/social providers are configured",
  },
  {
    id: "fundamentals",
    title: "Fundamentals Intelligence Agent",
    description: "Abstains until a licensed, attributable fundamentals feed is configured (not in the legacy catalogue)",
  },
  {
    id: "intelligence",
    title: "Trading Intelligence Agent",
    description: "Consensus: confluence, confidence, conflicts, BUY/SELL/HOLD/NO_TRADE",
  },
]);

export const messages = Object.freeze({
  RUN_NOT_FOUND: "That analysis run does not exist on this platform.",
  SYMBOLS_REQUIRED: `symbols must be an array of 1–${MAX_CONSENSUS_SYMBOLS} symbols`,
});

/**
 * Legacy `PaperTradingEngine::inferMarketClass()`, reproduced here because the
 * consensus route needs it and the paper module is not ported. It differs from the
 * market-data module's `inferMarketClass` in one respect that matters: the legacy
 * mapping knows the seven USD pairs and treats `XAUUSD` as a commodity, so gold is
 * analysed by the forex agent (which accepts `forex` and `commodity`) instead of
 * being labelled forex by accident.
 */
const KNOWN_CLASSES = Object.freeze({
  EURUSD: "forex",
  GBPUSD: "forex",
  USDJPY: "forex",
  AUDUSD: "forex",
  USDCAD: "forex",
  USDCHF: "forex",
  NZDUSD: "forex",
  XAUUSD: "commodity",
});

export function inferMarketClass(symbol) {
  const upper = String(symbol).trim().toUpperCase();
  if (Object.hasOwn(KNOWN_CLASSES, upper)) return KNOWN_CLASSES[upper];
  if (upper.endsWith("USDT")) return "crypto";
  return "forex";
}
