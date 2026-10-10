/**
 * Trading intelligence engine — the orchestrator.
 *
 * Ported from `application/libraries/Aegis/TradingIntelligenceEngine.php`. The
 * pipeline is fixed and runs in this order:
 *
 *   data → agents → consensus → regime → scenarios → setup → RISK ENGINE → debate
 *
 * Analysis produces *proposals* only. Nothing in this module, or anywhere in this
 * package, holds a broker handle: the execution supervisor and the broker
 * connectors are separate, unported modules, and Rule 1 of the legacy platform
 * (the AI stack never places an order) is preserved by construction rather than by
 * a flag.
 *
 * Two honesty mechanisms are wired in here rather than left to callers:
 *  - the series' own `provenance` and `validation` are carried into the persisted
 *    run, so a run built on labelled synthetic data says so forever afterwards;
 *  - the freshness factor feeds the consensus (stale 0.2, synthetic 0.5, live 1.0)
 *    and the risk context carries `syntheticData`/`staleData`, so the same fact
 *    both softens the opinion and vetoes the proposal.
 */

import { randomUUID } from "node:crypto";
import { numberFormat } from "./math.js";
import { buildScenarios, detectRegime, generateSetup, insufficientDataScenarios, regimeDirectionality } from "./regime.js";
import { createRiskEngine } from "./risk-engine.js";
import { createTechnicalAgent } from "./agents/technical.js";
import { createMarketStructureAgent } from "./agents/market-structure.js";
import { createForexAgent } from "./agents/forex.js";
import { createCryptoAgent } from "./agents/crypto.js";
import { createSentimentAgent } from "./agents/sentiment.js";
import { createFundamentalsAgent } from "./agents/fundamentals.js";
import { createTradingIntelligenceAgent } from "./agents/intelligence.js";
import { runDebate } from "./agents/debate.js";

export const CANDLE_LIMIT = 300;

/** Currency-strength references, fetched best-effort for forex and commodities. */
export const REFERENCE_SYMBOLS = Object.freeze(["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD"]);
const REFERENCE_LIMIT = 60;

/**
 * The trading state the risk engine is evaluated against.
 *
 * This is the legacy *boot default* (`platform_state`: `tradingMode`
 * `ANALYSIS_ONLY`, kill switch **active**, "orders blocked until explicitly
 * released"), and in this platform it cannot be changed yet: the kill-switch
 * control surface (`api/system/kill_switch`, permission `trading.control`) belongs
 * to the system/risk module, which is not ported. Keeping it engaged is the
 * fail-safe reading — no proposal can be approved from a platform that has no
 * execution path anyway.
 *
 * The portfolio numbers are defaults for the same reason: paper trading is not
 * ported, so there is no equity, no open position and no realised P&L to read. The
 * portfolio gates therefore cannot fire, and `riskContext.note` says so in every
 * run rather than leaving a reader to infer it from an empty object.
 */
export const DEFAULT_TRADING_STATE = Object.freeze({
  source: "platform-defaults",
  tradingMode: "ANALYSIS_ONLY",
  killSwitch: Object.freeze({
    active: true,
    activatedAt: null,
    reason: "Default state at boot — orders blocked until explicitly released",
  }),
  equity: 10_000,
  peakEquity: 10_000,
  openPositions: 0,
  openRiskBySymbol: Object.freeze({}),
  dailyPnl: 0,
  weeklyPnl: 0,
  note: "Paper trading and the kill-switch control surface are not ported yet: the kill switch stays engaged and the "
    + "portfolio gates are evaluated against an empty portfolio, so no proposal can be approved from this platform. "
    + "The synthetic-data, stale-data and data-quality vetoes are fully active.",
});

function riskContextFrom(state) {
  return {
    killSwitchActive: Boolean(state.killSwitch?.active),
    equity: state.equity,
    peakEquity: state.peakEquity ?? state.equity,
    openPositions: state.openPositions ?? 0,
    openRiskBySymbol: state.openRiskBySymbol ?? {},
    dailyPnl: state.dailyPnl ?? 0,
    weeklyPnl: state.weeklyPnl ?? 0,
  };
}

export function createAnalysisEngine({
  marketData,
  store = null,
  log = null,
  risk = null,
  now = () => Date.now(),
  tradingState = DEFAULT_TRADING_STATE,
  sentimentFeed = null,
  fundamentalsFeed = null,
  agents = null,
} = {}) {
  if (!marketData) throw new Error("the analysis engine requires a market-data service");

  const riskEngine = risk || createRiskEngine();
  const intelligence = createTradingIntelligenceAgent();
  /**
   * The feed agents judge freshness against a clock of their own by default. They
   * must use the engine's clock instead, or an injected `now` would leave the
   * candle timestamps and the feed observations disagreeing about what "fresh"
   * means — and a test that pins one would silently depend on the wall clock.
   */
  const nowSeconds = () => Math.floor(now() / 1000);
  const panel = agents || [
    createTechnicalAgent(),
    createMarketStructureAgent(),
    createForexAgent(),
    createCryptoAgent(),
    createSentimentAgent({ nowSeconds, ...(sentimentFeed ? { feed: sentimentFeed } : {}) }),
    // Fundamentals has no freshness check of its own, so it needs no clock.
    createFundamentalsAgent(fundamentalsFeed ? { feed: fundamentalsFeed } : {}),
  ];

  async function audit(event, actorId = null) {
    if (!store) return;
    try {
      await store.recordAudit({ actorId, ...event });
    } catch (error) {
      // An audit failure must never turn a completed analysis into a 500.
      if (log) log.warn({ err: error }, "analysis audit write failed");
    }
  }

  async function referenceSeriesFor(marketClass, timeframe) {
    if (!["forex", "commodity"].includes(marketClass)) return [];
    const collected = [];
    for (const symbol of REFERENCE_SYMBOLS) {
      try {
        const series = await marketData.candles({ symbol, marketClass: "forex", timeframe, limit: REFERENCE_LIMIT });
        collected.push({ symbol, series });
      } catch {
        // Best effort: a missing reference leg weakens the strength table, it does
        // not invalidate the run.
      }
    }
    return collected;
  }

  /**
   * @param {string} symbol
   * @param {string} marketClass one of the platform's market classes
   * @param {string} timeframe one of 1m,5m,15m,1h,4h,1d
   * @param {{actorId?: number|null}} [options]
   */
  async function run(symbol, marketClass, timeframe, { actorId = null } = {}) {
    const startedAt = new Date().toISOString();
    const upper = String(symbol).trim().toUpperCase();

    const series = await marketData.candles({ symbol: upper, marketClass, timeframe, limit: CANDLE_LIMIT });
    const referenceSeries = await referenceSeriesFor(marketClass, timeframe);
    const context = { series, now: now(), referenceSeries };

    const reports = [];
    for (const agent of panel) {
      if (!agent.applicable(context)) continue;
      try {
        reports.push(agent.analyze(context));
      } catch (error) {
        await audit({
          action: "analysis.agent.failed",
          entityType: "analysis_run",
          entityId: upper,
          details: {
            legacyAction: "TRADE_REJECTED",
            message: `Agent ${agent.id} failed`,
            agent: agent.id,
            symbol: upper,
            error: String(error?.message || error).slice(0, 240),
          },
        }, actorId);
      }
    }

    const regime = detectRegime(series);
    const freshness = series.provenance?.stale ? 0.2 : (series.provenance?.synthetic ? 0.5 : 1);
    const withData = reports.filter((report) => report.dataQuality > 0);
    const dataQuality = withData.length
      ? withData.reduce((sum, report) => sum + report.dataQuality, 0) / withData.length
      : 0.5;

    const consensus = intelligence.combine(reports, {
      dataQuality,
      regimeClarity: regime.confidence * regimeDirectionality(regime.regime),
      freshnessFactor: freshness,
    });

    const technicalReport = reports.find((report) => report.agent === "technical") ?? null;
    const structureReport = reports.find((report) => report.agent === "market-structure") ?? null;
    const candles = series.candles ?? [];
    const price = candles.length ? candles[candles.length - 1].close : 0;

    const scenarios = technicalReport
      ? buildScenarios(series, technicalReport, consensus.bias, price)
      : insufficientDataScenarios();

    let setup = null;
    if (technicalReport && structureReport && ["BULLISH", "BEARISH"].includes(consensus.bias)) {
      setup = generateSetup(series, technicalReport, structureReport, consensus.bias, consensus.confidence);
    }

    const riskContext = {
      ...riskContextFrom(tradingState),
      dataQuality,
      syntheticData: Boolean(series.provenance?.synthetic),
      staleData: Boolean(series.provenance?.stale),
    };
    let riskDecision = setup !== null ? riskEngine.evaluate(setup, riskContext) : null;

    // Adversarial review. The verdict can only reduce a bias or drop the setup —
    // it can never manufacture conviction.
    const debate = runDebate(reports, consensus, regime, setup, series.provenance ?? {}, riskEngine.getLimits());
    if (debate.verdict.bias === "NO_TRADE") {
      consensus.bias = "NO_TRADE";
      consensus.recommendation = "NO_TRADE";
      consensus.confidence = debate.verdict.confidence;
      setup = null;
      riskDecision = null;
    } else if (debate.verdict.bias === "NEUTRAL" && ["BULLISH", "BEARISH"].includes(consensus.bias)) {
      consensus.bias = "NEUTRAL";
      consensus.recommendation = "HOLD";
      consensus.confidence = debate.verdict.confidence;
      setup = null;
      riskDecision = null;
    } else {
      consensus.confidence = debate.verdict.confidence;
    }

    const runRecord = {
      id: randomUUID(),
      request: { symbol: upper, marketClass, timeframe },
      startedAt,
      completedAt: new Date().toISOString(),
      symbol: upper,
      marketClass,
      timeframe,
      marketRegime: regime.regime,
      regimeAssessment: regime,
      bias: consensus.bias,
      confidence: consensus.confidence,
      confluence: consensus.confluenceScore,
      recommendation: consensus.recommendation,
      reasoning: consensus.reasoning,
      conflicts: consensus.consensus.conflicts,
      consensus: consensus.consensus,
      gates: consensus.gates,
      debate,
      signals: technicalReport?.signals ?? [],
      scenarios,
      tradeSetup: setup,
      riskDecision,
      // Where the risk numbers came from, so a reader can see that the portfolio
      // gates are vacuous on this platform rather than satisfied.
      riskContext: { ...tradingState, dataQuality, syntheticData: riskContext.syntheticData, staleData: riskContext.staleData },
      agents: reports,
      provenance: series.provenance,
      validation: series.validation,
      quote: null,
    };

    try {
      const quoted = await marketData.quote({ symbol: upper });
      runRecord.quote = quoted.quote;
    } catch {
      // The quote is optional decoration on a candle-based analysis.
    }

    if (store) {
      await store.saveAnalysisRun({
        id: runRecord.id,
        symbol: runRecord.symbol,
        timeframe: runRecord.timeframe,
        bias: runRecord.bias,
        confidence: runRecord.confidence,
        regime: runRecord.marketRegime,
        recommendation: runRecord.recommendation,
        synthetic: Boolean(runRecord.provenance?.synthetic),
        source: String(runRecord.provenance?.source ?? "unknown"),
        completedAt: runRecord.completedAt,
        payload: runRecord,
      });
    }

    await audit({
      action: "analysis.run.completed",
      entityType: "analysis_run",
      entityId: runRecord.id,
      details: {
        legacyAction: "TRADE_ANALYZED",
        message: `${upper} ${timeframe}: ${runRecord.bias} @ ${numberFormat(runRecord.confidence, 2)} confidence`,
        runId: runRecord.id,
        symbol: upper,
        timeframe,
        marketClass,
        regime: runRecord.marketRegime,
        bias: runRecord.bias,
        confidence: runRecord.confidence,
        recommendation: runRecord.recommendation,
        source: runRecord.provenance?.source ?? null,
        synthetic: Boolean(runRecord.provenance?.synthetic),
        stale: Boolean(runRecord.provenance?.stale),
      },
    }, actorId);

    if (setup !== null) {
      await audit({
        action: "analysis.signal.proposed",
        entityType: "analysis_run",
        entityId: runRecord.id,
        details: {
          legacyAction: "SIGNAL_GENERATED",
          message: `${upper} ${setup.action} setup proposed (R:R ${setup.riskReward})`,
          runId: runRecord.id,
          symbol: upper,
          action: setup.action,
          entry: setup.entry,
          stopLoss: setup.stopLoss,
          takeProfit: setup.takeProfit,
          riskReward: setup.riskReward,
        },
      }, actorId);
      if (riskDecision !== null) {
        await audit({
          action: riskDecision.approved ? "risk.decision.approved" : "risk.decision.rejected",
          entityType: "analysis_run",
          entityId: runRecord.id,
          details: {
            legacyAction: riskDecision.approved ? "RISK_APPROVED" : "RISK_REJECTED",
            message: `${upper} setup ${riskDecision.approved ? "approved" : "rejected"} by Risk Engine`,
            runId: runRecord.id,
            approved: riskDecision.approved,
            reasons: riskDecision.reasons,
            warnings: riskDecision.warnings,
          },
        }, actorId);
      }
    } else {
      await audit({
        action: "analysis.signal.none",
        entityType: "analysis_run",
        entityId: runRecord.id,
        details: {
          legacyAction: "NO_SIGNAL",
          message: `${upper} ${timeframe}: no tradeable setup`,
          runId: runRecord.id,
          symbol: upper,
          timeframe,
          bias: runRecord.bias,
        },
      }, actorId);
    }

    return runRecord;
  }

  /**
   * Runs the full pipeline for each request and returns a one-line summary per
   * symbol. A symbol that cannot be analysed is reported as `NO_TRADE` with the
   * provider's error in `source` — the legacy behaviour, and the honest one: a
   * missing symbol must not disappear from a watchlist scan.
   */
  async function consensus(requests, { actorId = null } = {}) {
    const out = [];
    for (const request of requests) {
      const symbol = String(request.symbol).trim().toUpperCase();
      try {
        const runRecord = await run(symbol, request.marketClass, request.timeframe, { actorId });
        out.push({
          symbol: runRecord.symbol,
          marketClass: request.marketClass,
          timeframe: runRecord.timeframe,
          bias: runRecord.bias,
          recommendation: runRecord.recommendation,
          confidence: runRecord.confidence,
          confluence: runRecord.confluence,
          regime: runRecord.marketRegime,
          synthetic: Boolean(runRecord.provenance?.synthetic),
          stale: Boolean(runRecord.provenance?.stale),
          source: runRecord.provenance?.source ?? null,
          runId: runRecord.id,
        });
      } catch (error) {
        out.push({
          symbol,
          marketClass: request.marketClass,
          timeframe: request.timeframe,
          bias: "NO_TRADE",
          recommendation: "NO_TRADE",
          confidence: 0,
          confluence: 0,
          regime: "UNKNOWN",
          synthetic: false,
          stale: false,
          source: `error: ${String(error?.message || error).slice(0, 200)}`,
          runId: null,
        });
      }
    }
    return out;
  }

  return { run, consensus, riskEngine, agents: panel, tradingState };
}
