/**
 * Analysis service: the seam between the HTTP layer and the engine.
 *
 * It owns the three things a route should not have to know:
 *  - how a consensus request is turned into per-symbol engine runs (including the
 *    legacy market-class inference, so `XAUUSD` is scanned as a commodity and
 *    analysed by the forex agent);
 *  - how a stored run is read back (history rows are summaries; a single run is the
 *    full persisted payload, exactly as the legacy repository split them);
 *  - what the platform says about itself on the public status surface, which is a
 *    static description of the panel plus the trading state — never a probe and
 *    never a computation over market data.
 */

import { AppError } from "../../http/errors.js";
import { AGENT_CATALOGUE, DEFAULT_WATCHLIST, inferMarketClass } from "./contracts.js";
import { createAnalysisEngine, CANDLE_LIMIT, DEFAULT_TRADING_STATE, REFERENCE_SYMBOLS } from "./engine.js";

export function createAnalysisService({
  store = null,
  marketData = null,
  log = null,
  now = () => Date.now(),
  engine = null,
  tradingState = DEFAULT_TRADING_STATE,
} = {}) {
  /**
   * The store is optional, exactly as it is for the market-data service: the app
   * must still boot and serve static documents on a host with no persistence
   * adapter at all. With no store an analysis can still be computed and returned
   * — it simply is not recorded — and the two read endpoints say so instead of
   * answering with an empty list that would look like "no runs yet".
   */
  const analysisEngine = engine || createAnalysisEngine({ marketData, store, log, now, tradingState });

  function requireStore() {
    if (!store) {
      throw AppError.unavailable("Analysis history requires a persistence adapter, and none is configured on this host", {
        code: "ANALYSIS_STORE_UNAVAILABLE",
        retryAfter: 30,
      });
    }
  }

  /**
   * @param {{symbol: string, marketClass: string, timeframe: string}} body already validated
   * @param {{actorId?: number|null}} options
   */
  async function run(body, { actorId = null } = {}) {
    return analysisEngine.run(body.symbol, body.marketClass, body.timeframe, { actorId });
  }

  /** Summary rows, newest first — no payloads, so a history call stays cheap. */
  async function history({ limit = 20 } = {}) {
    requireStore();
    const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
    return { runs: await store.listAnalysisRuns({ limit: bounded }) };
  }

  /** The full persisted run, or `null` (the route turns that into a 404). */
  async function find(runId) {
    requireStore();
    return store.findAnalysisRun(String(runId));
  }

  function agents() {
    return { agents: AGENT_CATALOGUE.map((agent) => ({ ...agent })) };
  }

  /**
   * Scans a watchlist. Symbols are upper-cased and deduplicated by the contract;
   * the market class is inferred per symbol with the legacy mapping.
   */
  async function consensus({ timeframe = "1h", symbols = null } = {}, { actorId = null } = {}) {
    const requested = Array.isArray(symbols) && symbols.length ? symbols : [...DEFAULT_WATCHLIST];
    const requests = requested.map((symbol) => {
      const upper = String(symbol).trim().toUpperCase();
      return { symbol: upper, marketClass: inferMarketClass(upper), timeframe };
    });
    return {
      generatedAt: new Date(now()).toISOString(),
      timeframe,
      consensus: await analysisEngine.consensus(requests, { actorId }),
    };
  }

  /**
   * Static description for `/system/status`. It reports what the panel is and what
   * the trading state is; it never fetches candles, so an unauthenticated caller
   * cannot use it to make this server do work.
   */
  function statusSnapshot() {
    return {
      agents: analysisEngine.agents.map((agent) => agent.id),
      candleLimit: CANDLE_LIMIT,
      referenceSymbols: [...REFERENCE_SYMBOLS],
      tradingMode: analysisEngine.tradingState.tradingMode,
      killSwitchActive: Boolean(analysisEngine.tradingState.killSwitch?.active),
      proposalsOnly: true,
      canPlaceOrders: false,
      note: analysisEngine.tradingState.note,
    };
  }

  return { run, history, find, agents, consensus, statusSnapshot, engine: analysisEngine };
}
