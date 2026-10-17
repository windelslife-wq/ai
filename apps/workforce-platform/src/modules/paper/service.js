/**
 * Paper trading and persisted governance service.
 *
 * This layer performs simulation-only order handling against the shared
 * market-data provider chain. It never has a broker dependency. Every mutation
 * that touches an account is executed through the adapter's paper transaction;
 * on MySQL that is a pinned InnoDB transaction and on the file adapter it is a
 * serialized single-process WAL batch.
 */

import { randomUUID } from "node:crypto";
import { AppError } from "../../http/errors.js";
import { marketDataFailure, isProviderFailure } from "../market-data/errors.js";
import { MARKET_CLASSES } from "../market-data/timeframes.js";
import {
  CORRELATION_GROUPS,
  CORRELATION_MODEL_DESCRIPTION,
  DEFAULT_RISK_LIMITS,
  EARLY_WARNING_RATIOS,
  createRiskEngine,
  findCorrelatedGroupOverlaps,
} from "../analysis/risk-engine.js";
import {
  fillEntry,
  limitTouched,
  protectionHit,
  settleClose,
  sizeOrder,
  valueAccount,
  validateProtection,
} from "./engine.js";
import { SeriesView, precomputeIndicators } from "../strategies/series-view.js";
import { nextStage } from "../strategies/registry.js";

export const DEFAULT_PAPER_TRADING_STATE = Object.freeze({
  tradingMode: "ANALYSIS_ONLY",
  killSwitch: Object.freeze({
    active: true,
    activatedAt: null,
    reason: "Default state at boot — orders blocked until explicitly released",
  }),
  allowSyntheticPaperData: false,
  riskLimits: DEFAULT_RISK_LIMITS,
});

const QUOTE_STALE_MS = 5 * 60_000;
const MAX_OPEN_ROWS = 2_000;
const MAX_TRADE_ROWS = 5_000;
const KNOWN_MARKET_CLASSES = Object.freeze({
  EURUSD: "forex", GBPUSD: "forex", USDJPY: "forex", AUDUSD: "forex",
  USDCAD: "forex", USDCHF: "forex", NZDUSD: "forex", XAUUSD: "commodity",
});

const RISK_LIMIT_RULES = Object.freeze({
  riskPerTradePct: { min: 0.0001, max: 0.05 },
  maxRiskPerTradePct: { min: 0.0001, max: 0.1 },
  minRiskReward: { min: 0, max: 100 },
  maxPositionNotionalUsd: { min: 1, max: 100_000_000 },
  maxLeverage: { min: 1, max: 100 },
  maxOpenPositions: { min: 1, max: 100, integer: true },
  maxDailyLossPct: { min: 0, max: 1 },
  maxWeeklyLossPct: { min: 0, max: 1 },
  maxDrawdownPct: { min: 0, max: 1 },
  maxSymbolExposurePct: { min: 0, max: 1 },
  maxPortfolioExposurePct: { min: 0, max: 1 },
  maxCorrelatedPositions: { min: 1, max: 100, integer: true },
  minDataQuality: { min: 0, max: 1 },
  blockSyntheticData: { type: "boolean" },
  blockStaleData: { type: "boolean" },
});

function isoNow(now) {
  return new Date(now()).toISOString();
}

function numeric(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function nullableNumeric(value) {
  return value === null || value === undefined ? null : numeric(value, null);
}

function roundTo(value, places) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(places)) : number;
}

function actorIdOf(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw AppError.unauthorized("An authenticated user is required", { code: "AUTH_REQUIRED" });
  }
  return id;
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`, { code: "INVALID_ID" });
  }
  return id;
}

function normalizeSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9._-]{2,24}$/.test(symbol)) {
    throw AppError.badRequest("symbol must contain 2–24 letters, digits, dots, underscores or hyphens", { code: "INVALID_SYMBOL" });
  }
  return symbol;
}

export function inferPaperMarketClass(symbol) {
  const upper = String(symbol ?? "").trim().toUpperCase();
  return KNOWN_MARKET_CLASSES[upper] ?? (upper.endsWith("USDT") ? "crypto" : "forex");
}

function normalizeMarketClass(value, symbol) {
  const marketClass = String(value || inferPaperMarketClass(symbol)).toLowerCase();
  if (!MARKET_CLASSES.includes(marketClass)) {
    throw AppError.badRequest(`marketClass must be one of: ${MARKET_CLASSES.join(", ")}`, { code: "INVALID_MARKET_CLASS" });
  }
  return marketClass;
}

function normalizeRiskLimits(value) {
  const limits = { ...DEFAULT_RISK_LIMITS };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, rule] of Object.entries(RISK_LIMIT_RULES)) {
      const candidate = value[key];
      if (rule.type === "boolean") {
        if (typeof candidate === "boolean") limits[key] = candidate;
        continue;
      }
      if (typeof candidate !== "number" || !Number.isFinite(candidate)) continue;
      if (candidate < rule.min || candidate > rule.max || (rule.integer && !Number.isSafeInteger(candidate))) continue;
      limits[key] = candidate;
    }
  }
  // A corrupted or older state cannot disable the paper-order stop requirement.
  limits.requireStopLoss = true;
  limits.riskPerTradePct = Math.min(limits.riskPerTradePct, limits.maxRiskPerTradePct);
  return limits;
}

export function normalizeTradingState(stored) {
  const source = stored && typeof stored === "object" ? stored : {};
  const killSwitch = source.killSwitch && typeof source.killSwitch === "object" && !Array.isArray(source.killSwitch)
    ? source.killSwitch
    : {};
  const mode = source.tradingMode;
  return {
    tradingMode: mode === "PAPER_TRADING" ? mode : "ANALYSIS_ONLY",
    killSwitch: {
      // Only the exact persisted boolean `false` releases the switch. Strings,
      // numbers, missing fields and malformed state all fail closed.
      active: killSwitch.active !== false,
      activatedAt: typeof killSwitch.activatedAt === "string" ? killSwitch.activatedAt : null,
      reason: typeof killSwitch.reason === "string" ? killSwitch.reason : null,
    },
    allowSyntheticPaperData: source.allowSyntheticPaperData === true,
    riskLimits: normalizeRiskLimits(source.riskLimits),
    updatedByUserId: source.updatedByUserId ?? null,
    updatedAt: source.updatedAt ?? null,
  };
}

function publicTradingState(state) {
  const normalized = normalizeTradingState(state);
  return {
    tradingMode: normalized.tradingMode,
    killSwitch: { ...normalized.killSwitch },
    allowSyntheticPaperData: normalized.allowSyntheticPaperData,
    riskLimits: { ...normalized.riskLimits },
    updatedByUserId: normalized.updatedByUserId,
    updatedAt: normalized.updatedAt,
    simulationOnly: true,
    liveTradingEnabled: false,
  };
}

function positionDomain(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    symbol: String(row.symbol),
    marketClass: String(row.market_class || "forex"),
    direction: String(row.direction),
    units: numeric(row.units),
    entryPrice: numeric(row.entry_price),
    stopLoss: numeric(row.stop_loss),
    takeProfit: numeric(row.take_profit),
    entryFee: numeric(row.entry_fee),
    riskAmount: nullableNumeric(row.risk_amount),
    strategy: row.strategy ?? null,
    strategyVersion: row.strategy_version ?? null,
    reason: row.reason ?? null,
    aiConfidence: nullableNumeric(row.ai_confidence),
    synthetic: Boolean(row.synthetic),
    openedAt: String(row.opened_at),
    status: String(row.status),
    closedAt: row.closed_at ?? null,
    exitPrice: nullableNumeric(row.exit_price),
    realizedPnl: nullableNumeric(row.realized_pnl),
    exitReason: row.exit_reason ?? null,
  };
}

function positionRecord(position) {
  const row = {
    account_id: Number(position.accountId),
    symbol: String(position.symbol),
    market_class: String(position.marketClass || "forex"),
    direction: String(position.direction),
    units: Number(position.units),
    entry_price: Number(position.entryPrice),
    stop_loss: Number(position.stopLoss),
    take_profit: Number(position.takeProfit),
    entry_fee: Number(position.entryFee ?? 0),
    risk_amount: nullableNumeric(position.riskAmount),
    strategy: position.strategy ?? null,
    strategy_version: position.strategyVersion ?? null,
    reason: position.reason ?? null,
    ai_confidence: nullableNumeric(position.aiConfidence),
    synthetic: Boolean(position.synthetic),
    opened_at: String(position.openedAt),
    status: String(position.status || "OPEN"),
    closed_at: position.closedAt ?? null,
    exit_price: nullableNumeric(position.exitPrice),
    realized_pnl: nullableNumeric(position.realizedPnl),
    exit_reason: position.exitReason ?? null,
  };
  if (position.id !== null && position.id !== undefined) row.id = Number(position.id);
  return row;
}

function publicPositionView(position, valuation = {}) {
  return {
    ...positionRecord(position),
    current_price: valuation.currentPrice ?? position.entryPrice,
    unrealized_pnl: valuation.unrealizedPnl ?? 0,
    unrealized_r: valuation.unrealizedR ?? null,
    valuation_available: valuation.valuationAvailable !== false,
    valuation_source: valuation.source ?? null,
    valuation_synthetic: Boolean(valuation.synthetic),
    valuation_stale: Boolean(valuation.stale),
  };
}

function quoteInfoFromCandleSeries(series, now) {
  const candles = Array.isArray(series?.candles) ? series.candles : [];
  const last = candles[candles.length - 1] ?? null;
  if (!last || !Number.isFinite(Number(last.close)) || Number(last.close) <= 0) return null;
  const provenance = series.provenance ?? {};
  const dataTimestamp = Number(provenance.dataTimestamp ?? last.timestamp);
  return {
    price: Number(last.close),
    synthetic: Boolean(provenance.synthetic),
    stale: Boolean(provenance.stale) || !Number.isFinite(dataTimestamp) || now() - dataTimestamp > QUOTE_STALE_MS,
    source: provenance.source ?? null,
    timestamp: Number.isFinite(dataTimestamp) ? dataTimestamp : null,
    provenance,
  };
}

export function createPaperService({ store = null, marketData = null, strategies = null, notifications = null, log = null, now = () => Date.now() } = {}) {
  function requireStore() {
    if (!store || typeof store.withPaperTransaction !== "function") {
      throw AppError.unavailable("Paper trading requires a configured persistence adapter", { code: "PAPER_STORE_UNAVAILABLE", retryAfter: 30 });
    }
  }

  function requireStrategyRegistry() {
    const registry = strategies?.registry ?? strategies;
    if (!registry || typeof registry.findRecordForPaper !== "function") {
      throw AppError.unavailable("The Strategy Lab is not available for paper deployments", { code: "STRATEGY_REGISTRY_UNAVAILABLE", retryAfter: 30 });
    }
    return registry;
  }

  /**
   * Publish an operator alert about a governance transition that has ALREADY
   * committed.
   *
   * Deliberately best-effort and deliberately outside the transaction: the audit
   * row written inside `withPaperTransaction` is the authoritative record, and a
   * notification is a convenience layered on top of it. If the alert cannot be
   * stored — a host without migration 009, an adapter with no notification
   * surface — the kill switch or trading mode still moved, so failing here would
   * report a governance change as broken when it succeeded. The reverse ordering
   * (notify first, commit second) would be worse: an alert about a change that
   * then rolled back.
   */
  async function publish(type, severity, title, detail = {}, dedupeKey = null) {
    if (!notifications || typeof notifications.notify !== "function") return null;
    try {
      const result = await notifications.notify(type, severity, title, detail, dedupeKey, null);
      return result?.notification ?? null;
    } catch (error) {
      log?.warn?.({ err: error, notificationType: type }, "Operator notification could not be published");
      return null;
    }
  }

  /**
   * Publishes an alert that a committed transaction queued. `null` is a no-op.
   *
   * **Never publish from inside `withPaperTransaction`.** The file adapter holds
   * its single mutation queue for the whole transaction, so a notification write
   * from inside it waits on the transaction that is waiting on it. Every caller
   * here returns the alert as data and publishes it afterwards.
   */
  async function publishPending(alert) {
    if (!alert) return null;
    return publish(alert.type, alert.severity, alert.title, alert.detail, alert.dedupeKey);
  }

  async function loadState(executor = store) {
    const stored = typeof executor?.loadTradingState === "function" ? await executor.loadTradingState() : null;
    return normalizeTradingState(stored);
  }

  async function fetchQuote(symbol) {
    if (!marketData || typeof marketData.quote !== "function") {
      throw AppError.unavailable("Market data is not configured for paper trading", { code: "PAPER_MARKET_DATA_UNAVAILABLE", retryAfter: 30 });
    }
    try {
      const result = await marketData.quote({ symbol });
      const price = Number(result?.quote?.last);
      if (!Number.isFinite(price) || price <= 0) {
        throw AppError.unavailable(`No valid quote is available for ${symbol}`, { code: "PAPER_QUOTE_INVALID", retryAfter: 5 });
      }
      const timestamp = Number(result?.quote?.timestamp ?? result?.fetchedAt);
      return {
        price,
        synthetic: Boolean(result.synthetic),
        stale: !Number.isFinite(timestamp) || now() - timestamp > QUOTE_STALE_MS,
        source: result.source ?? null,
        timestamp: Number.isFinite(timestamp) ? timestamp : null,
        provenance: result,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (Number.isFinite(error?.statusCode)) {
        if (error.statusCode === 400) throw AppError.badRequest(String(error.message ?? "Invalid market-data request"), { code: error.code ?? "INVALID_MARKET_DATA_REQUEST" });
        if (error.statusCode === 503 || isProviderFailure(error)) throw marketDataFailure(error);
      }
      if (isProviderFailure(error)) throw marketDataFailure(error);
      throw error;
    }
  }

  async function fetchCandleSeries({ symbol, marketClass, timeframe = "1m", limit = 2 }) {
    if (!marketData || typeof marketData.candles !== "function") {
      throw AppError.unavailable("Market data is not configured for paper trading", { code: "PAPER_MARKET_DATA_UNAVAILABLE", retryAfter: 30 });
    }
    try {
      return await marketData.candles({ symbol, marketClass, timeframe, limit });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (Number.isFinite(error?.statusCode) && error.statusCode === 400) {
        throw AppError.badRequest(String(error.message ?? "Invalid market-data request"), { code: error.code ?? "INVALID_MARKET_DATA_REQUEST" });
      }
      if (isProviderFailure(error)) throw marketDataFailure(error);
      throw error;
    }
  }

  async function requireAccount(executor, accountId, ownerUserId) {
    const account = await executor.findPaperAccount(accountId, ownerUserId);
    if (!account) throw AppError.notFound("Paper account not found", { code: "PAPER_ACCOUNT_NOT_FOUND" });
    return account;
  }

  async function audit(executor, actorId, action, summary, details) {
    if (typeof executor.recordAudit !== "function") throw new Error("paper transaction has no audit writer");
    await executor.recordAudit({
      actorId: actorId === null || actorId === undefined ? null : Number(actorId),
      action,
      entityType: "paper_trading",
      entityId: details?.accountId ?? null,
      details: { summary, ...details },
    });
  }

  async function markPrices(openPositions, { strict = false, priceOverrides = new Map() } = {}) {
    const symbols = [...new Set(openPositions.map((position) => String(position.symbol)))];
    const marks = new Map();
    const unavailable = [];
    await Promise.all(symbols.map(async (symbol) => {
      const override = priceOverrides.get(symbol);
      if (override && Number.isFinite(Number(override.price)) && Number(override.price) > 0) {
        marks.set(symbol, override);
        return;
      }
      try {
        marks.set(symbol, await fetchQuote(symbol));
      } catch (error) {
        unavailable.push({ symbol, reason: String(error.message ?? error).slice(0, 160) });
        if (!strict) {
          const position = openPositions.find((row) => String(row.symbol) === symbol);
          marks.set(symbol, { price: numeric(position?.entry_price), synthetic: Boolean(position?.synthetic), stale: true, source: "entry-price-fallback", timestamp: null });
        }
      }
    }));
    if (strict && unavailable.length) {
      throw AppError.unavailable("Current portfolio marks are unavailable; risk-sensitive order processing was refused", {
        code: "PORTFOLIO_VALUATION_UNAVAILABLE",
        retryAfter: 5,
        details: { unavailable },
      });
    }
    return { marks, unavailable };
  }

  async function accountSummaryInTransaction(executor, account, ownerUserId, { strictValuation = false, priceOverrides = new Map() } = {}) {
    const openRows = await executor.listPaperPositions({ accountId: account.id, ownerUserId, status: "OPEN", limit: MAX_OPEN_ROWS });
    const domainPositions = openRows.map(positionDomain);
    const { marks, unavailable } = await markPrices(openRows, { strict: strictValuation, priceOverrides });
    const valuation = valueAccount({
      account: { balance: numeric(account.balance) },
      openPositions: domainPositions,
      priceFor: (symbol) => marks.get(String(symbol))?.price ?? 0,
    });
    const tradeRows = await executor.listPaperTrades({ accountId: account.id, ownerUserId, limit: MAX_TRADE_ROWS });
    const today = new Date(now()).toISOString().slice(0, 10);
    const weekCutoff = now() - 7 * 24 * 60 * 60_000;
    let dailyPnl = 0;
    let weeklyPnl = 0;
    for (const trade of tradeRows) {
      if (trade.leg !== "EXIT" || trade.net_pnl === null || trade.net_pnl === undefined) continue;
      const time = String(trade.time ?? "");
      const pnl = numeric(trade.net_pnl);
      if (time.slice(0, 10) === today) dailyPnl += pnl;
      const at = Date.parse(time);
      if (Number.isFinite(at) && at >= weekCutoff) weeklyPnl += pnl;
    }

    let latestAccount = account;
    const highWater = Math.max(numeric(account.peak_equity), valuation.rawEquity);
    if (Number.isFinite(highWater) && highWater > numeric(account.peak_equity)) {
      latestAccount = await executor.markPaperAccountPeak(account.id, ownerUserId, highWater) ?? { ...account, peak_equity: highWater };
    }
    const peakEquity = Math.max(numeric(latestAccount.peak_equity), highWater);
    const positions = valuation.positions.map((position) => {
      const mark = marks.get(position.symbol) ?? {};
      return publicPositionView(position, {
        currentPrice: position.currentPrice,
        unrealizedPnl: position.unrealizedPnl,
        unrealizedR: position.unrealizedR,
        valuationAvailable: !unavailable.some((item) => item.symbol === position.symbol),
        source: mark.source,
        synthetic: mark.synthetic,
        stale: mark.stale,
      });
    });
    return {
      account: { ...latestAccount, peak_equity: peakEquity },
      equity: valuation.equity,
      balance: valuation.balance,
      unrealizedPnl: valuation.unrealizedPnl,
      dailyPnl: Math.round(dailyPnl * 100) / 100,
      weeklyPnl: Math.round(weeklyPnl * 100) / 100,
      openPositions: valuation.openPositions,
      openRiskBySymbol: valuation.openRiskBySymbol,
      openRisk: Math.round(Object.values(valuation.openRiskBySymbol).reduce((sum, value) => sum + numeric(value), 0) * 100) / 100,
      peakEquity,
      drawdownPct: peakEquity > 0 ? Math.max(0, (peakEquity - valuation.equity) / peakEquity) : 0,
      dailyLossPct: valuation.equity > 0 ? Math.round((-dailyPnl / valuation.equity) * 10000) / 100 : 0,
      positions,
      valuationAvailable: unavailable.length === 0,
      valuationWarnings: unavailable,
      simulationOnly: true,
      liveTradingEnabled: false,
    };
  }

  function rejectedOrderRecord(accountId, input, { symbol, marketClass, side, type, price = null, stopLoss = null, takeProfit = null, units = 0, riskAmount = null, synthetic = false, reason, nowIso: createdAt }) {
    return {
      account_id: Number(accountId),
      symbol,
      market_class: marketClass,
      side,
      type,
      units: numeric(units),
      price: nullableNumeric(price),
      stop_loss: nullableNumeric(stopLoss),
      take_profit: nullableNumeric(takeProfit),
      status: "REJECTED",
      reject_reason: String(reason).slice(0, 1_000),
      risk_amount: nullableNumeric(riskAmount),
      reason: String(input.reason ?? "").slice(0, 500) || null,
      ai_confidence: nullableNumeric(input.confidence),
      strategy: input.strategy ?? null,
      strategy_version: input.strategyVersion ?? null,
      synthetic: Boolean(synthetic),
      created_at: createdAt,
      filled_at: null,
      fill_price: null,
    };
  }

  async function rejectOrder(executor, account, input, context, reason, actorId, riskDecision = null) {
    const record = rejectedOrderRecord(account.id, input, { ...context, reason, nowIso: isoNow(now) });
    const order = await executor.savePaperOrder(record);
    await audit(executor, actorId, riskDecision ? "paper.order.risk-rejected" : "paper.order.rejected", `Paper order ${context.symbol} ${context.side} rejected`, {
      accountId: account.id,
      orderId: order.id,
      symbol: context.symbol,
      reason,
      reasons: riskDecision?.reasons ?? [reason],
      synthetic: Boolean(context.synthetic),
    });
    return { filled: false, order: { ...order, rejectReasons: riskDecision?.reasons ?? [reason] }, riskDecision };
  }

  async function evaluatePaperRisk({ state, summary, symbol, side, price, stopLoss, takeProfit, units, synthetic, stale }) {
    const riskReward = Math.abs(takeProfit - price) / Math.max(Number.EPSILON, Math.abs(price - stopLoss));
    const setup = {
      action: side,
      symbol,
      entry: { type: "ZONE", min: price, max: price, reference: price },
      stopLoss,
      takeProfit: [takeProfit],
      riskReward,
    };
    const risk = createRiskEngine(state.riskLimits);
    const decision = risk.evaluate(setup, {
      killSwitchActive: false,
      dataQuality: 1,
      syntheticData: Boolean(synthetic && !state.allowSyntheticPaperData),
      staleData: Boolean(stale),
      equity: summary.equity,
      peakEquity: Math.max(summary.peakEquity, summary.equity),
      openPositions: summary.openPositions,
      openSymbols: (summary.positions || []).map((position) => position.symbol),
      openRiskBySymbol: summary.openRiskBySymbol,
      dailyPnl: summary.dailyPnl,
      weeklyPnl: summary.weeklyPnl,
      givenUnits: units,
    });
    // The persisted paper-data switch is an independent hard gate: changing a
    // general analysis risk limit must never silently permit synthetic fills.
    if (synthetic && !state.allowSyntheticPaperData && !decision.reasons.some((reason) => /SYNTHETIC/i.test(reason))) {
      return {
        ...decision,
        approved: false,
        reasons: ["SYNTHETIC paper data is disabled by governance", ...decision.reasons],
      };
    }
    return decision;
  }

  async function fillOrderInTransaction(executor, order, account, rawPrice, provenance, actorId) {
    const openedAt = isoNow(now);
    const fillProvenance = provenance ?? { synthetic: Boolean(order.synthetic), stale: false, source: null };
    const fill = fillEntry({
      order: {
        id: Number(order.id),
        side: order.side,
        symbol: order.symbol,
        units: numeric(order.units),
        stopLoss: numeric(order.stop_loss),
        takeProfit: numeric(order.take_profit),
        riskAmount: nullableNumeric(order.risk_amount),
        strategy: order.strategy ?? null,
        reason: order.reason ?? null,
        aiConfidence: nullableNumeric(order.ai_confidence),
      },
      rawPrice,
      accountId: Number(order.account_id),
      marketClass: order.market_class,
      nowIso: openedAt,
      synthetic: Boolean(order.synthetic || fillProvenance.synthetic),
    });
    const position = await executor.savePaperPosition(positionRecord({
      ...fill.position,
      accountId: Number(order.account_id),
      marketClass: order.market_class,
      strategyVersion: order.strategy_version ?? null,
      synthetic: Boolean(order.synthetic || fillProvenance.synthetic),
    }));
    const updatedOrder = await executor.savePaperOrder({
      ...order,
      status: "FILLED",
      synthetic: Boolean(order.synthetic || fillProvenance.synthetic),
      filled_at: openedAt,
      fill_price: fill.order.fillPrice,
      reject_reason: null,
    });
    await executor.savePaperAccount({
      ...account,
      balance: roundTo(numeric(account.balance) + fill.balanceDelta, 2),
      revision: numeric(account.revision) + 1,
    });
    await executor.savePaperTrade({
      account_id: Number(order.account_id),
      order_id: Number(order.id),
      position_id: Number(position.id),
      leg: "ENTRY",
      symbol: order.symbol,
      price: fill.entryTrade.price,
      units: fill.entryTrade.units,
      fee: fill.entryTrade.fee,
      time: openedAt,
      synthetic: Boolean(order.synthetic || fillProvenance.synthetic),
    });
    await audit(executor, actorId, "paper.order.filled", `Paper order ${order.id} filled`, {
      accountId: Number(order.account_id),
      orderId: Number(order.id),
      positionId: Number(position.id),
      symbol: order.symbol,
      side: order.side,
      fillPrice: fill.order.fillPrice,
      synthetic: Boolean(order.synthetic || fillProvenance.synthetic),
      source: fillProvenance.source ?? null,
    });
    await audit(executor, actorId, "paper.position.opened", `Paper position ${position.id} opened in ${position.symbol}`, {
      accountId: Number(order.account_id),
      positionId: Number(position.id),
      symbol: position.symbol,
    });
    return { filled: true, order: updatedOrder, position };
  }

  async function submitOrderInTransaction(executor, account, ownerUserId, state, input, quote, actorId, { priceOverrides = new Map() } = {}) {
    const symbol = normalizeSymbol(input.symbol);
    const side = String(input.side ?? "").trim().toUpperCase();
    const type = String(input.type ?? "MARKET").trim().toUpperCase();
    const marketClass = normalizeMarketClass(input.marketClass, symbol);
    if (!["BUY", "SELL"].includes(side)) throw AppError.badRequest("side must be BUY or SELL", { code: "INVALID_ORDER_SIDE" });
    if (!["MARKET", "LIMIT"].includes(type)) throw AppError.badRequest("type must be MARKET or LIMIT", { code: "INVALID_ORDER_TYPE" });
    if (type === "LIMIT" && !(Number.isFinite(Number(input.price)) && Number(input.price) > 0)) {
      throw AppError.badRequest("A positive price is required for a LIMIT order", { code: "INVALID_ORDER_PRICE" });
    }

    const context = {
      symbol,
      marketClass,
      side,
      type,
      price: roundTo(type === "LIMIT" ? Number(input.price) : Number(quote.price), 8),
      stopLoss: nullableNumeric(input.stopLoss),
      takeProfit: nullableNumeric(input.takeProfit),
      synthetic: Boolean(quote.synthetic),
    };
    if (context.stopLoss !== null) context.stopLoss = roundTo(context.stopLoss, 8);
    if (context.takeProfit !== null) context.takeProfit = roundTo(context.takeProfit, 8);
    if (!Number.isFinite(context.price) || context.price <= 0) throw AppError.badRequest("Order price must be positive", { code: "INVALID_ORDER_PRICE" });

    if (state.killSwitch.active) {
      return rejectOrder(executor, account, input, context, "Kill switch is ACTIVE — all paper orders are blocked", actorId);
    }
    if (state.tradingMode !== "PAPER_TRADING") {
      return rejectOrder(executor, account, input, context, `Trading mode is ${state.tradingMode} — switch to PAPER_TRADING to place paper orders`, actorId);
    }
    const existingPosition = await executor.findOpenPaperPosition(account.id, symbol);
    const existingOrder = await executor.findOpenPaperOrder(account.id, symbol);
    if (existingPosition || existingOrder) {
      return rejectOrder(executor, account, input, context, `Already holding a position or pending order in ${symbol} (one net position per symbol)`, actorId);
    }

    const direction = side === "BUY" ? "LONG" : "SHORT";
    const protection = validateProtection({
      direction,
      price: context.price,
      stopLoss: context.stopLoss,
      takeProfit: context.takeProfit,
    });
    if (!protection.ok) {
      return rejectOrder(executor, account, input, { ...context, stopLoss: protection.stopLoss, takeProfit: protection.takeProfit }, protection.reasons.join("; "), actorId);
    }
    context.stopLoss = roundTo(protection.stopLoss, 8);
    context.takeProfit = roundTo(protection.takeProfit, 8);
    const roundedProtection = validateProtection({
      direction,
      price: context.price,
      stopLoss: context.stopLoss,
      takeProfit: context.takeProfit,
    });
    if (!roundedProtection.ok) {
      return rejectOrder(executor, account, input, context, roundedProtection.reasons.join("; "), actorId);
    }

    if (input.riskPct !== null && input.riskPct !== undefined && (!Number.isFinite(Number(input.riskPct)) || Number(input.riskPct) <= 0)) {
      return rejectOrder(executor, account, input, context, "riskPct must be a positive fraction", actorId);
    }
    const summary = await accountSummaryInTransaction(executor, account, ownerUserId, { strictValuation: true, priceOverrides });
    const sizing = sizeOrder({
      equity: summary.equity,
      price: context.price,
      stopLoss: context.stopLoss,
      requestedRiskPct: input.riskPct === null || input.riskPct === undefined ? null : Number(input.riskPct),
      limits: state.riskLimits,
    });
    const orderUnits = roundTo(sizing.units, 6);
    const riskAmount = roundTo(orderUnits * Math.abs(context.price - context.stopLoss), 2);
    if (!Number.isFinite(orderUnits) || orderUnits <= 0 || !Number.isFinite(riskAmount)) {
      return rejectOrder(executor, account, input, context, "Risk sizing did not produce a positive finite position", actorId);
    }

    const riskDecision = await evaluatePaperRisk({
      state,
      summary,
      symbol,
      side,
      price: context.price,
      stopLoss: context.stopLoss,
      takeProfit: context.takeProfit,
      units: orderUnits,
      synthetic: quote.synthetic,
      stale: quote.stale,
    });
    if (!riskDecision.approved) {
      return rejectOrder(executor, account, input, {
        ...context,
        units: orderUnits,
        riskAmount,
      }, riskDecision.reasons.join("; "), actorId, riskDecision);
    }

    const createdAt = isoNow(now);
    const order = await executor.savePaperOrder({
      account_id: Number(account.id),
      symbol,
      market_class: marketClass,
      side,
      type,
      units: orderUnits,
      price: context.price,
      stop_loss: context.stopLoss,
      take_profit: context.takeProfit,
      status: "PENDING",
      reject_reason: null,
      risk_amount: riskAmount,
      reason: String(input.reason ?? "").slice(0, 500) || null,
      ai_confidence: nullableNumeric(input.confidence),
      strategy: input.strategy ?? null,
      strategy_version: input.strategyVersion ?? null,
      synthetic: Boolean(quote.synthetic),
      created_at: createdAt,
      filled_at: null,
      fill_price: null,
    });
    await audit(executor, actorId, "paper.order.submitted", `Paper ${type} order ${side} ${symbol} submitted`, {
      accountId: Number(account.id),
      orderId: Number(order.id),
      symbol,
      side,
      type,
      units: orderUnits,
      riskAmount,
      synthetic: Boolean(quote.synthetic),
      source: quote.source ?? null,
      riskDecision,
    });
    if (type === "MARKET") {
      const filled = await fillOrderInTransaction(executor, order, account, quote.price, quote, actorId);
      return { ...filled, riskDecision };
    }
    return { filled: false, order, riskDecision };
  }

  async function closePositionInTransaction(executor, account, positionRow, rawExit, exitReason, provenance, actorId) {
    const position = positionDomain(positionRow);
    const close = settleClose({ position, rawExit, exitReason });
    const closedAt = isoNow(now);
    const closedPosition = {
      ...close.closedPosition,
      accountId: Number(position.accountId),
      marketClass: position.marketClass,
      strategyVersion: position.strategyVersion,
      synthetic: Boolean(position.synthetic || provenance?.synthetic),
      closedAt,
    };
    const latestAccount = await executor.findPaperAccount(position.accountId, account.owner_user_id ?? null);
    if (!latestAccount) throw AppError.notFound("Paper account not found", { code: "PAPER_ACCOUNT_NOT_FOUND" });
    const savedPosition = await executor.savePaperPosition(positionRecord(closedPosition));
    await executor.savePaperAccount({
      ...latestAccount,
      balance: roundTo(numeric(latestAccount.balance) + close.balanceDelta, 2),
      revision: numeric(latestAccount.revision) + 1,
    });
    const syntheticTrade = Boolean(position.synthetic || provenance?.synthetic);
    await executor.savePaperTrade({
      account_id: Number(position.accountId),
      order_id: null,
      position_id: Number(position.id),
      leg: "EXIT",
      symbol: position.symbol,
      price: close.exitPrice,
      units: position.units,
      fee: close.exitFee,
      time: closedAt,
      synthetic: syntheticTrade,
    });
    const notional = position.units * position.entryPrice;
    const risk = Math.abs(position.entryPrice - position.stopLoss) * position.units;
    const journal = {
      id: randomUUID(),
      source: "paper",
      synthetic: syntheticTrade,
      symbol: position.symbol,
      market: position.marketClass,
      strategy: position.strategy,
      strategy_version: position.strategyVersion,
      direction: position.direction,
      entry_time: position.openedAt,
      entry_price: position.entryPrice,
      exit_time: closedAt,
      exit_price: close.exitPrice,
      position_size: position.units,
      stop_loss: position.stopLoss,
      take_profit: position.takeProfit,
      fees: Math.round((position.entryFee + close.exitFee) * 1_000_000) / 1_000_000,
      slippage: 0,
      pnl: close.netPnl,
      pnl_pct: notional > 0 ? (close.netPnl / notional) * 100 : null,
      r_multiple: risk > 0 ? close.rMultiple : null,
      reason: position.reason || `paper exit: ${exitReason}`,
      ai_confidence: position.aiConfidence,
      confidence_source: position.aiConfidence !== null ? "strategy" : null,
      agent_consensus: null,
      risk_score: null,
      execution_time: position.openedAt,
      paper_position_id: Number(position.id),
    };
    await executor.saveJournalEntry(journal);
    const auditAction = exitReason === "STOP_LOSS"
      ? "paper.stop-loss.triggered"
      : exitReason === "TAKE_PROFIT" ? "paper.take-profit.triggered" : "paper.position.closed";
    await audit(executor, actorId, auditAction, `Paper position ${position.id} closed (${exitReason})`, {
      accountId: Number(position.accountId),
      positionId: Number(position.id),
      symbol: position.symbol,
      exitReason,
      netPnl: close.netPnl,
      synthetic: syntheticTrade,
      source: provenance?.source ?? null,
    });
    return { position: savedPosition, netPnl: close.netPnl };
  }

  async function createAccount(ownerUserId, { name, startingBalance, currency = "USD" } = {}, { actorId = ownerUserId } = {}) {
    requireStore();
    const ownerId = actorIdOf(ownerUserId);
    const actor = actorIdOf(actorId);
    const balance = Number(startingBalance);
    if (!Number.isFinite(balance) || balance < 1 || balance > 10_000_000) {
      throw AppError.badRequest("Starting balance must be between 1 and 10,000,000", { code: "INVALID_STARTING_BALANCE" });
    }
    const accountName = String(name ?? "").trim().slice(0, 60);
    if (!accountName) throw AppError.badRequest("Account name is required", { code: "INVALID_ACCOUNT_NAME" });
    const normalizedCurrency = String(currency ?? "USD").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalizedCurrency)) throw AppError.badRequest("currency must be a three-letter code", { code: "INVALID_CURRENCY" });
    const createdAt = isoNow(now);
    const account = await store.withPaperTransaction(async (tx) => {
      const created = await tx.createPaperAccount({
        owner_user_id: ownerId,
        name: accountName,
        currency: normalizedCurrency,
        starting_balance: Math.round(balance * 100) / 100,
        balance: Math.round(balance * 100) / 100,
        peak_equity: Math.round(balance * 100) / 100,
        revision: 0,
        created_at: createdAt,
      });
      await audit(tx, actor, "paper.account.created", `Paper account ${created.id} created`, {
        accountId: Number(created.id),
        name: accountName,
        startingBalance: created.starting_balance,
        currency: normalizedCurrency,
      });
      return created;
    });
    return accountSummary(ownerId, account.id);
  }

  async function listAccounts(ownerUserId, { limit = 50 } = {}) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    const accounts = await store.listPaperAccounts(owner, Math.min(Math.max(Number(limit) || 50, 1), 100));
    const summaries = await Promise.all(accounts.map((account) => accountSummary(owner, account.id)));
    return { accounts: summaries, tradingMode: (await loadState()).tradingMode, simulationOnly: true };
  }

  async function accountSummary(ownerUserId, accountId) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    const id = positiveId(accountId, "accountId");
    return store.withPaperTransaction(async (tx) => {
      const account = await requireAccount(tx, id, owner);
      return accountSummaryInTransaction(tx, account, owner);
    });
  }

  async function listOrders(ownerUserId, accountId, { status = null, limit = 200 } = {}) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    const id = positiveId(accountId, "accountId");
    const account = await store.findPaperAccount(id, owner);
    if (!account) throw AppError.notFound("Paper account not found", { code: "PAPER_ACCOUNT_NOT_FOUND" });
    return { orders: await store.listPaperOrders({ accountId: id, ownerUserId: owner, status, limit }) };
  }

  async function submitOrder(ownerUserId, accountId, input = {}, { actorId = ownerUserId } = {}) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    const actor = actorIdOf(actorId);
    const id = positiveId(accountId, "accountId");
    // Do not even call the provider for a guessed account ID. The check is
    // repeated under the transaction lock below to close the ownership race.
    const ownedAccount = await store.findPaperAccount(id, owner);
    if (!ownedAccount) throw AppError.notFound("Paper account not found", { code: "PAPER_ACCOUNT_NOT_FOUND" });
    const symbol = normalizeSymbol(input.symbol);
    const quote = await fetchQuote(symbol);
    return store.withPaperTransaction(async (tx) => {
      const state = normalizeTradingState(await tx.loadTradingState());
      const account = await requireAccount(tx, id, owner);
      return submitOrderInTransaction(tx, account, owner, state, input, quote, actor);
    });
  }

  async function positions(ownerUserId, accountId, { status = null, limit = 200 } = {}) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    const id = positiveId(accountId, "accountId");
    const account = await store.findPaperAccount(id, owner);
    if (!account) throw AppError.notFound("Paper account not found", { code: "PAPER_ACCOUNT_NOT_FOUND" });
    const rows = await store.listPaperPositions({ accountId: id, ownerUserId: owner, status, limit });
    return {
      positions: rows.filter((row) => row.status === "OPEN"),
      closed: rows.filter((row) => row.status === "CLOSED"),
    };
  }

  async function closePosition(ownerUserId, accountId, positionId, { reason = "MANUAL", actorId = ownerUserId } = {}) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    const actor = actorIdOf(actorId);
    const account = positiveId(accountId, "accountId");
    const position = positiveId(positionId, "positionId");
    const storedPosition = await store.findPaperPosition(account, position, owner);
    if (!storedPosition || storedPosition.status !== "OPEN") {
      throw AppError.notFound("Paper position not found or is already closed", { code: "PAPER_POSITION_NOT_FOUND" });
    }
    const quote = await fetchQuote(storedPosition.symbol);
    return store.withPaperTransaction(async (tx) => {
      const accountRow = await requireAccount(tx, account, owner);
      const current = await tx.findPaperPosition(account, position, owner);
      if (!current || current.status !== "OPEN") throw AppError.notFound("Paper position not found or is already closed", { code: "PAPER_POSITION_NOT_FOUND" });
      return closePositionInTransaction(tx, accountRow, current, quote.price, String(reason || "MANUAL").toUpperCase(), quote, actor);
    });
  }

  function candleKey(symbol, marketClass, timeframe) {
    return `${String(symbol).toUpperCase()}|${marketClass}|${timeframe}`;
  }

  async function deploymentRows(owner, accountId) {
    const account = await store.findPaperAccount(accountId, owner);
    if (!account) throw AppError.notFound("Paper account not found", { code: "PAPER_ACCOUNT_NOT_FOUND" });
    return store.listPaperDeployments({ accountId, ownerUserId: owner, limit: 500 });
  }

  async function tick(ownerUserId, accountId, { actorId = ownerUserId } = {}) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    const actor = actorIdOf(actorId);
    const id = positiveId(accountId, "accountId");
    const account = await store.findPaperAccount(id, owner);
    if (!account) throw AppError.notFound("Paper account not found", { code: "PAPER_ACCOUNT_NOT_FOUND" });
    const [pendingOrders, openPositions, deployments] = await Promise.all([
      store.listPaperOrders({ accountId: id, ownerUserId: owner, status: "PENDING", limit: MAX_OPEN_ROWS }),
      store.listPaperPositions({ accountId: id, ownerUserId: owner, status: "OPEN", limit: MAX_OPEN_ROWS }),
      store.listPaperDeployments({ accountId: id, ownerUserId: owner, active: true, limit: 500 }),
    ]);
    const requests = new Map();
    for (const row of [...pendingOrders, ...openPositions]) {
      if (row.type && row.type !== "LIMIT") continue;
      const timeframe = "1m";
      const key = candleKey(row.symbol, row.market_class, timeframe);
      requests.set(key, { symbol: row.symbol, marketClass: row.market_class, timeframe, limit: 2 });
    }
    for (const deployment of deployments) {
      const key = candleKey(deployment.symbol, deployment.market_class, deployment.timeframe);
      requests.set(key, { symbol: deployment.symbol, marketClass: deployment.market_class, timeframe: deployment.timeframe, limit: 300 });
    }
    const candleData = new Map();
    await Promise.all([...requests.entries()].map(async ([key, request]) => {
      try {
        const series = await fetchCandleSeries(request);
        const quote = quoteInfoFromCandleSeries(series, now);
        candleData.set(key, quote ? { series, quote } : { error: `no candles returned for ${request.symbol}` });
      } catch (error) {
        candleData.set(key, { error: String(error.message ?? error).slice(0, 200) });
      }
    }));
    const priceOverrides = new Map();
    for (const row of [...pendingOrders, ...openPositions]) {
      const key = candleKey(row.symbol, row.market_class, "1m");
      const value = candleData.get(key)?.quote;
      if (value) priceOverrides.set(String(row.symbol), value);
    }

    const actions = { filledOrders: [], closedPositions: [], strategySignals: [], skipped: [] };
    const result = await store.withPaperTransaction(async (tx) => {
      const state = normalizeTradingState(await tx.loadTradingState());
      let accountRow = await requireAccount(tx, id, owner);
      const pending = await tx.listPaperOrders({ accountId: id, ownerUserId: owner, status: "PENDING", limit: MAX_OPEN_ROWS });
      for (const order of pending) {
        if (order.type !== "LIMIT") continue;
        const key = candleKey(order.symbol, order.market_class, "1m");
        const data = candleData.get(key);
        const candle = data?.series?.candles?.at(-1);
        if (!candle) {
          actions.skipped.push(data?.error ? `no data for ${order.symbol}: ${data.error}` : `no data for ${order.symbol}`);
          continue;
        }
        if (!limitTouched({ side: order.side, price: numeric(order.price) }, candle)) continue;
        if (state.killSwitch.active || state.tradingMode !== "PAPER_TRADING") {
          const cancelled = await tx.savePaperOrder({
            ...order,
            status: "CANCELLED",
            reject_reason: `Governance blocked limit fill (mode ${state.tradingMode}, kill switch ${state.killSwitch.active ? "ACTIVE" : "off"})`,
          });
          await audit(tx, actor, "paper.order.cancelled", `Pending paper limit order ${order.id} was not filled by governance`, {
            accountId: id,
            orderId: Number(order.id),
            reason: cancelled.reject_reason,
          });
          continue;
        }
        const currentAccount = await requireAccount(tx, id, owner);
        const summary = await accountSummaryInTransaction(tx, currentAccount, owner, { strictValuation: true, priceOverrides });
        const quote = data.quote;
        const direction = order.side === "BUY" ? "LONG" : "SHORT";
        const validation = validateProtection({
          direction,
          price: numeric(order.price),
          stopLoss: numeric(order.stop_loss),
          takeProfit: numeric(order.take_profit),
        });
        if (!validation.ok) {
          const rejected = await tx.savePaperOrder({ ...order, status: "REJECTED", reject_reason: validation.reasons.join("; ") });
          await audit(tx, actor, "paper.order.risk-rejected", `Pending paper order ${order.id} failed risk checks at fill time`, {
            accountId: id,
            orderId: Number(order.id),
            reasons: validation.reasons,
          });
          actions.skipped.push(`limit order ${order.id} rejected at fill: ${rejected.reject_reason}`);
          continue;
        }
        const riskDecision = await evaluatePaperRisk({
          state,
          summary,
          symbol: order.symbol,
          side: order.side,
          price: numeric(order.price),
          stopLoss: numeric(order.stop_loss),
          takeProfit: numeric(order.take_profit),
          units: numeric(order.units),
          synthetic: Boolean(order.synthetic || quote.synthetic),
          stale: quote.stale,
        });
        if (!riskDecision.approved) {
          const rejected = await tx.savePaperOrder({ ...order, status: "REJECTED", reject_reason: riskDecision.reasons.join("; ") });
          await audit(tx, actor, "paper.order.risk-rejected", `Pending paper order ${order.id} was vetoed at fill time`, {
            accountId: id,
            orderId: Number(order.id),
            reasons: riskDecision.reasons,
            riskDecision,
          });
          actions.skipped.push(`limit order ${order.id} rejected at fill: ${rejected.reject_reason}`);
          continue;
        }
        const filled = await fillOrderInTransaction(tx, order, currentAccount, numeric(order.price), quote, actor);
        actions.filledOrders.push(filled.order);
      }

      const currentPositions = await tx.listPaperPositions({ accountId: id, ownerUserId: owner, status: "OPEN", limit: MAX_OPEN_ROWS });
      for (const row of currentPositions) {
        const key = candleKey(row.symbol, row.market_class, "1m");
        const data = candleData.get(key);
        const candle = data?.series?.candles?.at(-1);
        if (!candle) continue;
        const position = positionDomain(row);
        const hit = protectionHit({ direction: position.direction, stopLoss: position.stopLoss, takeProfit: position.takeProfit }, candle);
        if (!hit) continue;
        const rawExit = hit === "STOP_LOSS" ? position.stopLoss : position.takeProfit;
        const closed = await closePositionInTransaction(tx, accountRow, row, rawExit, hit, data.quote, actor);
        accountRow = await requireAccount(tx, id, owner);
        actions.closedPositions.push(closed);
      }

      const activeDeployments = await tx.listPaperDeployments({ accountId: id, ownerUserId: owner, active: true, limit: 500 });
      const registry = activeDeployments.length ? requireStrategyRegistry() : null;
      for (const deployment of activeDeployments) {
        const key = candleKey(deployment.symbol, deployment.market_class, deployment.timeframe);
        const data = candleData.get(key);
        const candles = data?.series?.candles;
        if (!data?.quote || !Array.isArray(candles) || candles.length < 80) {
          actions.skipped.push(`strategy deployment ${deployment.id} has insufficient or unavailable data`);
          continue;
        }
        const strategy = registry.implementation(deployment.strategy_id, deployment.strategy_version);
        const record = await registry.findRecordForPaper(deployment.strategy_id, deployment.strategy_version);
        if (!strategy || !record || record.lifecycle === "RETIRED") {
          if (record?.lifecycle === "RETIRED") {
            await tx.savePaperDeployment({ ...deployment, active: false });
            await audit(tx, actor, "paper.strategy.deployment-paused", `Deployment ${deployment.id} paused because its strategy is retired`, {
              accountId: id,
              deploymentId: Number(deployment.id),
              strategyId: deployment.strategy_id,
              version: deployment.strategy_version,
            });
          }
          actions.skipped.push(`strategy deployment ${deployment.id} has no active implementation`);
          continue;
        }
        const lastIndex = candles.length - 1;
        const indicators = precomputeIndicators(candles);
        const view = new SeriesView(candles, indicators, lastIndex, {
          symbol: deployment.symbol,
          timeframe: deployment.timeframe,
          marketClass: deployment.market_class,
        });
        const currentPosition = await tx.findOpenPaperPosition(id, deployment.symbol);
        const summary = await accountSummaryInTransaction(tx, await requireAccount(tx, id, owner), owner, {
          strictValuation: true,
          priceOverrides,
        });
        const position = currentPosition ? positionDomain(currentPosition) : null;
        const positionView = position ? {
          direction: position.direction,
          entryPrice: position.entryPrice,
          entryBar: lastIndex - 5,
          stopLoss: position.stopLoss,
          takeProfit: position.takeProfit,
          unrealizedPnl: (position.direction === "LONG" ? candles[lastIndex].close - position.entryPrice : position.entryPrice - candles[lastIndex].close) * position.units,
        } : null;
        let signal;
        try {
          signal = strategy.evaluate({ view, position: positionView, equity: summary.equity });
        } catch (error) {
          await tx.savePaperDeployment({ ...deployment, last_evaluated_at: isoNow(now), last_signal: "ERROR" });
          actions.skipped.push(`strategy deployment ${deployment.id} failed: ${String(error.message ?? error).slice(0, 160)}`);
          log?.warn?.({ err: error, deploymentId: deployment.id }, "paper strategy evaluation failed");
          continue;
        }
        const lastSignal = String(signal?.action ?? "HOLD").toUpperCase();
        const updatedDeployment = await tx.savePaperDeployment({
          ...deployment,
          last_evaluated_at: isoNow(now),
          last_signal: lastSignal.slice(0, 8),
        });
        if (lastSignal === "CLOSE" && currentPosition) {
          const closed = await closePositionInTransaction(tx, await requireAccount(tx, id, owner), currentPosition, candles[lastIndex].close, "SIGNAL", data.quote, actor);
          actions.closedPositions.push(closed);
          actions.strategySignals.push({ deployment: Number(updatedDeployment.id), symbol: deployment.symbol, action: "CLOSE", result: closed.netPnl });
          continue;
        }
        if (["BUY", "SELL"].includes(lastSignal) && !currentPosition) {
          if (lastSignal === "SELL" && !strategy.supportsShorts()) {
            actions.strategySignals.push({ deployment: Number(updatedDeployment.id), symbol: deployment.symbol, action: lastSignal, submitted: false, rejectReasons: ["Strategy does not support short selling"] });
            continue;
          }
          const submitted = await submitOrderInTransaction(
            tx,
            await requireAccount(tx, id, owner),
            owner,
            state,
            {
              symbol: deployment.symbol,
              marketClass: deployment.market_class,
              side: lastSignal,
              type: "MARKET",
              stopLoss: signal.stopLoss ?? null,
              takeProfit: signal.takeProfit ?? null,
              reason: `[${deployment.strategy_id}] ${String(signal.reason ?? "")}`.slice(0, 500),
              confidence: signal.confidence ?? null,
              strategy: deployment.strategy_id,
              strategyVersion: deployment.strategy_version,
            },
            data.quote,
            actor,
            { priceOverrides },
          );
          actions.strategySignals.push({
            deployment: Number(updatedDeployment.id),
            symbol: deployment.symbol,
            action: lastSignal,
            submitted: Boolean(submitted.filled),
            rejectReasons: submitted.order?.rejectReasons ?? (submitted.order?.reject_reason ? [submitted.order.reject_reason] : []),
          });
        }
      }

      accountRow = await requireAccount(tx, id, owner);
      const summary = await accountSummaryInTransaction(tx, accountRow, owner, { priceOverrides });
      await audit(tx, actor, "paper.account.ticked", `Paper account ${id} tick completed`, {
        accountId: id,
        filledOrders: actions.filledOrders.length,
        closedPositions: actions.closedPositions.length,
        strategySignals: actions.strategySignals.length,
        skipped: actions.skipped.length,
      });
      return { actions, summary };
    });
    return result;
  }

  async function listDeployments(ownerUserId, accountId) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    const id = positiveId(accountId, "accountId");
    return { deployments: await deploymentRows(owner, id) };
  }

  async function deployStrategy(ownerUserId, accountId, input = {}, { actorId = ownerUserId } = {}) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    const actor = actorIdOf(actorId);
    const id = positiveId(accountId, "accountId");
    // Keep strategy lookup and executable resolution behind the owner boundary;
    // the transaction repeats this check before persisting the deployment.
    const ownedAccount = await store.findPaperAccount(id, owner);
    if (!ownedAccount) throw AppError.notFound("Paper account not found", { code: "PAPER_ACCOUNT_NOT_FOUND" });
    const registry = requireStrategyRegistry();
    const strategyId = String(input.strategyId ?? "");
    const record = input.strategyVersion
      ? await registry.findRecordForPaper(strategyId, String(input.strategyVersion))
      : await registry.findRecord(strategyId, "");
    if (!record) throw AppError.notFound(`Strategy ${strategyId} was not found`, { code: "STRATEGY_NOT_FOUND" });
    const strategyVersion = String(record.version);
    const strategy = registry.implementation(strategyId, strategyVersion);
    if (!strategy) throw AppError.conflict(`Strategy ${strategyId}@${strategyVersion} has no executable implementation`, { code: "STRATEGY_NOT_EXECUTABLE" });
    const gate = registry.canDeployToPaper(record);
    if (!gate.ok) throw AppError.conflict("Strategy is not eligible for paper deployment", { code: "STRATEGY_DEPLOYMENT_REJECTED", details: { reasons: gate.reasons } });

    const symbol = normalizeSymbol(input.symbol);
    const marketClass = normalizeMarketClass(input.marketClass, symbol);
    const timeframe = String(input.timeframe ?? "");
    if (!strategy.marketClasses().includes(marketClass)) {
      throw AppError.badRequest(`Strategy ${strategyId}@${strategyVersion} does not support ${marketClass}`, { code: "STRATEGY_MARKET_CLASS_UNSUPPORTED" });
    }
    if (!strategy.timeframes().includes(timeframe)) {
      throw AppError.badRequest(`Strategy ${strategyId}@${strategyVersion} does not support ${timeframe}`, { code: "STRATEGY_TIMEFRAME_UNSUPPORTED" });
    }
    const deployedAt = isoNow(now);
    return store.withPaperTransaction(async (tx) => {
      const account = await requireAccount(tx, id, owner);
      const lockedRecord = await tx.findStrategy(strategyId, strategyVersion);
      if (!lockedRecord) throw AppError.notFound(`Strategy ${strategyId}@${strategyVersion} was not found`, { code: "STRATEGY_NOT_FOUND" });
      const lockedGate = registry.canDeployToPaper(lockedRecord);
      if (!lockedGate.ok) throw AppError.conflict("Strategy is not eligible for paper deployment", { code: "STRATEGY_DEPLOYMENT_REJECTED", details: { reasons: lockedGate.reasons } });
      const existing = await tx.listPaperDeployments({ accountId: id, ownerUserId: owner, active: true, limit: 5_000 });
      if (existing.some((dep) => dep.strategy_id === strategyId && dep.strategy_version === strategyVersion && dep.symbol === symbol)) {
        throw AppError.conflict("This strategy is already active on the account and symbol", { code: "PAPER_DEPLOYMENT_EXISTS" });
      }
      const deployment = await tx.savePaperDeployment({
        account_id: id,
        strategy_id: strategyId,
        strategy_version: strategyVersion,
        symbol,
        market_class: marketClass,
        timeframe,
        active: true,
        deployed_at: deployedAt,
        last_evaluated_at: null,
        last_signal: null,
      });
      if (lockedRecord.lifecycle === "RISK_REVIEWED") {
        const to = nextStage(lockedRecord.lifecycle);
        if (to !== "PAPER_TRADING") throw new Error("paper lifecycle ordering is inconsistent");
        const updated = {
          ...lockedRecord,
          lifecycle: to,
          updated_at: deployedAt,
          lifecycle_history: [
            ...(Array.isArray(lockedRecord.lifecycle_history) ? lockedRecord.lifecycle_history : []),
            { from: lockedRecord.lifecycle, to, at: deployedAt, reason: `deployed to paper account #${id}` },
          ],
        };
        await tx.saveStrategy(updated);
        await tx.recordAudit({
          actorId: actor,
          action: "strategies.status-changed",
          entityType: "strategy",
          entityId: strategyId,
          details: { strategyId, version: strategyVersion, from: lockedRecord.lifecycle, to, summary: `Strategy ${strategyId}@${strategyVersion}: RISK_REVIEWED -> PAPER_TRADING` },
        });
      }
      await audit(tx, actor, "paper.strategy.deployed", `Strategy ${strategyId}@${strategyVersion} deployed to paper account ${id}`, {
        accountId: id,
        deploymentId: Number(deployment.id),
        strategyId,
        version: strategyVersion,
        symbol,
        timeframe,
      });
      return deployment;
    });
  }

  async function toggleDeployment(ownerUserId, accountId, deploymentId, active, { actorId = ownerUserId } = {}) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    const actor = actorIdOf(actorId);
    const accountIdValue = positiveId(accountId, "accountId");
    const deploymentIdValue = positiveId(deploymentId, "deploymentId");
    if (typeof active !== "boolean") throw AppError.badRequest("active must be a boolean", { code: "INVALID_DEPLOYMENT_STATE" });
    return store.withPaperTransaction(async (tx) => {
      await requireAccount(tx, accountIdValue, owner);
      const deployment = await tx.findPaperDeployment(deploymentIdValue, owner);
      if (!deployment || Number(deployment.account_id) !== accountIdValue) {
        throw AppError.notFound("Paper deployment not found on this account", { code: "PAPER_DEPLOYMENT_NOT_FOUND" });
      }
      const updated = await tx.savePaperDeployment({ ...deployment, active, account_id: accountIdValue });
      await audit(tx, actor, "paper.strategy.deployment-toggled", `Paper deployment ${deploymentIdValue} ${active ? "resumed" : "paused"}`, {
        accountId: accountIdValue,
        deploymentId: deploymentIdValue,
        active,
        strategyId: deployment.strategy_id,
        version: deployment.strategy_version,
      });
      return updated;
    });
  }

  async function tradingState() {
    requireStore();
    return publicTradingState(await loadState());
  }

  async function riskLimits() {
    const state = await tradingState();
    return { limits: state.riskLimits, updatedAt: state.updatedAt };
  }

  async function updateRiskLimits(patch = {}, { actorId } = {}) {
    requireStore();
    const actor = actorIdOf(actorId);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw AppError.badRequest("Risk limits must be supplied as an object", { code: "INVALID_RISK_LIMITS" });
    }
    const keys = Object.keys(patch);
    if (!keys.length) throw AppError.badRequest("At least one risk limit must be supplied", { code: "NO_RISK_LIMITS" });
    for (const [key, value] of Object.entries(patch)) {
      const rule = RISK_LIMIT_RULES[key];
      if (!rule) throw AppError.badRequest(`Unknown or immutable risk limit: ${key}`, { code: "INVALID_RISK_LIMIT" });
      if (rule.type === "boolean") {
        if (typeof value !== "boolean") throw AppError.badRequest(`${key} must be a boolean`, { code: "INVALID_RISK_LIMIT" });
        continue;
      }
      if (typeof value !== "number" || !Number.isFinite(value)
        || value < rule.min || value > rule.max || (rule.integer && !Number.isSafeInteger(value))) {
        throw AppError.badRequest(`${key} is outside its allowed range`, { code: "INVALID_RISK_LIMIT" });
      }
    }
    return store.withPaperTransaction(async (tx) => {
      const state = normalizeTradingState(await tx.loadTradingState());
      const limits = normalizeRiskLimits({ ...state.riskLimits, ...patch });
      const updatedAt = isoNow(now);
      const saved = await tx.saveTradingState({ ...state, riskLimits: limits }, { updatedByUserId: actor, updatedAt });
      await audit(tx, actor, "governance.risk-limits.updated", "Paper risk limits updated", { changed: keys, limits });
      const normalized = normalizeTradingState(saved);
      return { limits: normalized.riskLimits, updatedAt };
    });
  }

  async function setTradingMode(mode, { actorId } = {}) {
    requireStore();
    const actor = actorIdOf(actorId);
    if (!["ANALYSIS_ONLY", "PAPER_TRADING"].includes(mode)) {
      throw AppError.conflict("Only ANALYSIS_ONLY and PAPER_TRADING modes are available in the simulation-only Node edition", { code: "TRADING_MODE_UNSUPPORTED" });
    }
    const result = await store.withPaperTransaction(async (tx) => {
      const current = normalizeTradingState(await tx.loadTradingState());
      const updatedAt = isoNow(now);
      const saved = await tx.saveTradingState({ ...current, tradingMode: mode }, { updatedByUserId: actor, updatedAt });
      await audit(tx, actor, "governance.trading-mode.changed", `Trading mode ${current.tradingMode} -> ${mode}`, {
        previous: current.tradingMode,
        mode,
      });
      const applied = normalizeTradingState(saved);
      const changed = applied.tradingMode !== current.tradingMode;
      return {
        tradingMode: applied.tradingMode,
        message: `Trading mode set to ${mode}`,
        updatedAt,
        changed,
        notification: null,
        // A no-op change queues nothing, so the inbox is not filled by an
        // operator re-selecting the mode they are already in.
        alert: changed ? {
          type: "TRADING_MODE_CHANGED",
          severity: mode === "PAPER_TRADING" ? "info" : "warning",
          title: `Trading mode ${current.tradingMode} -> ${applied.tradingMode}`,
          detail: { previous: current.tradingMode, mode: applied.tradingMode, actorId: actor },
          dedupeKey: `trading-mode:${applied.tradingMode}`,
        } : null,
      };
    });
    // Published strictly after commit. Publishing inside the transaction would
    // deadlock the file adapter, whose single mutation queue is held for the whole
    // transaction — see `publish` below.
    result.notification = await publishPending(result.alert);
    delete result.alert;
    return result;
  }

  async function setKillSwitch(active, reason = null, { actorId } = {}) {
    requireStore();
    const actor = actorIdOf(actorId);
    if (typeof active !== "boolean") throw AppError.badRequest("active must be a boolean", { code: "INVALID_KILL_SWITCH" });
    const normalizedReason = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
    const result = await store.withPaperTransaction(async (tx) => {
      const current = normalizeTradingState(await tx.loadTradingState());
      const updatedAt = isoNow(now);
      // The stored reason explains why the switch is ENGAGED and is cleared on
      // release, and `activatedAt` is null while it is not engaged. Legacy kept both
      // in the released state too (`$reason ?? ($active ? 'engaged' : 'released')`,
      // plus a fresh `activatedAt` on every call), which describes a switch that is
      // off and on at once. Nothing is lost: a release's own reason is the audit
      // row's detail, and the alert carries the engaged reason with it.
      const killSwitch = {
        active,
        activatedAt: active ? updatedAt : null,
        reason: active ? normalizedReason || "Activated by operator" : null,
      };
      const saved = await tx.saveTradingState({ ...current, killSwitch }, { updatedByUserId: actor, updatedAt });
      await audit(tx, actor, active ? "governance.kill-switch.activated" : "governance.kill-switch.released", `Kill switch ${active ? "activated" : "released"}`, { killSwitch });
      const changed = current.killSwitch.active !== active;
      return {
        killSwitch: normalizeTradingState(saved).killSwitch,
        updatedAt,
        changed,
        notification: null,
        // The legacy platform published exactly this alert with exactly this
        // dedupe key (`Aegis/Platform.php`: `KILL_SWITCH` / `kill-switch:active`),
        // so one unread critical badge exists while the switch is engaged rather
        // than one per activation attempt. The release uses a separate key so
        // acknowledging the activation does not suppress the recovery notice.
        alert: changed ? {
          type: "KILL_SWITCH",
          severity: active ? "critical" : "info",
          title: active
            ? "KILL SWITCH ACTIVATED — all order placement blocked"
            : "Kill switch released — paper order placement permitted again",
          detail: { reason: killSwitch.reason, activatedAt: killSwitch.activatedAt, actorId: actor },
          dedupeKey: active ? "kill-switch:active" : "kill-switch:released",
        } : null,
      };
    });
    result.notification = await publishPending(result.alert);
    delete result.alert;
    return result;
  }

  async function setSyntheticPaperData(allow, { actorId } = {}) {
    requireStore();
    const actor = actorIdOf(actorId);
    if (typeof allow !== "boolean") throw AppError.badRequest("allow must be a boolean", { code: "INVALID_SYNTHETIC_SETTING" });
    return store.withPaperTransaction(async (tx) => {
      const current = normalizeTradingState(await tx.loadTradingState());
      const updatedAt = isoNow(now);
      const saved = await tx.saveTradingState({ ...current, allowSyntheticPaperData: allow }, { updatedByUserId: actor, updatedAt });
      await audit(tx, actor, "governance.synthetic-paper.changed", `Synthetic paper data ${allow ? "allowed" : "blocked"}`, { allow });
      return { allowSyntheticPaperData: normalizeTradingState(saved).allowSyntheticPaperData, updatedAt };
    });
  }

  async function portfolioRiskScan(ownerUserId, { limit = 50 } = {}) {
    requireStore();
    const owner = actorIdOf(ownerUserId);
    const state = await loadState();
    const accounts = await store.listPaperAccounts(owner, Math.min(Math.max(Number(limit) || 50, 1), 100));
    const scanned = [];
    for (const account of accounts) {
      const summary = await accountSummary(owner, account.id);
      const breaches = [];
      if (summary.equity <= 0) breaches.push({ code: "NON_POSITIVE_EQUITY", message: "Equity is not positive; portfolio risk cannot be measured" });
      if (!summary.valuationAvailable) breaches.push({ code: "VALUATION_UNAVAILABLE", message: "One or more open positions could not be marked with current market data" });
      if (summary.openPositions > state.riskLimits.maxOpenPositions) breaches.push({ code: "OPEN_POSITION_LIMIT", message: `Open positions ${summary.openPositions} exceed limit ${state.riskLimits.maxOpenPositions}` });
      if (summary.equity > 0 && summary.dailyPnl < 0) {
        const dailyLossRatio = -summary.dailyPnl / summary.equity;
        if (dailyLossRatio > state.riskLimits.maxDailyLossPct) {
          breaches.push({ code: "DAILY_LOSS_LIMIT", message: "Daily loss limit exceeded" });
        } else if (dailyLossRatio > state.riskLimits.maxDailyLossPct * EARLY_WARNING_RATIOS.dailyLoss) {
          breaches.push({
            code: "DAILY_LOSS_APPROACHING",
            message: `Daily loss ${(dailyLossRatio * 100).toFixed(1)}% is approaching the ${(state.riskLimits.maxDailyLossPct * 100).toFixed(1)}% limit`,
          });
        }
      }
      if (summary.equity > 0 && summary.weeklyPnl < 0 && -summary.weeklyPnl / summary.equity > state.riskLimits.maxWeeklyLossPct) {
        breaches.push({ code: "WEEKLY_LOSS_LIMIT", message: "Weekly loss limit exceeded" });
      }
      if (summary.peakEquity > 0) {
        const drawdownRatio = (summary.peakEquity - summary.equity) / summary.peakEquity;
        if (drawdownRatio > state.riskLimits.maxDrawdownPct) {
          breaches.push({ code: "DRAWDOWN_LIMIT", message: "Maximum drawdown limit exceeded" });
        } else if (drawdownRatio > state.riskLimits.maxDrawdownPct * EARLY_WARNING_RATIOS.drawdown) {
          breaches.push({
            code: "DRAWDOWN_APPROACHING",
            message: `Drawdown ${(drawdownRatio * 100).toFixed(1)}% is approaching the ${(state.riskLimits.maxDrawdownPct * 100).toFixed(1)}% limit`,
          });
        }
      }
      if (summary.equity > 0) {
        const openRiskRatio = summary.openRisk / summary.equity;
        if (openRiskRatio > state.riskLimits.maxPortfolioExposurePct) {
          breaches.push({ code: "PORTFOLIO_EXPOSURE_LIMIT", message: "Open risk exceeds the portfolio exposure limit" });
        } else if (openRiskRatio > state.riskLimits.maxPortfolioExposurePct * EARLY_WARNING_RATIOS.portfolioExposure) {
          breaches.push({
            code: "PORTFOLIO_EXPOSURE_APPROACHING",
            message: `Open risk ${(openRiskRatio * 100).toFixed(1)}% of equity is approaching the ${(state.riskLimits.maxPortfolioExposurePct * 100).toFixed(1)}% limit`,
          });
        }
      }
      const grossNotional = summary.positions.reduce(
        (sum, position) => sum + numeric(position.units) * numeric(position.current_price ?? position.entry_price),
        0,
      );
      const rawLeverage = summary.equity > 0 ? grossNotional / summary.equity : 0;
      const leverage = Math.round(rawLeverage * 10_000) / 10_000;
      if (summary.equity > 0) {
        if (rawLeverage > state.riskLimits.maxLeverage) {
          breaches.push({
            code: "LEVERAGE_LIMIT",
            message: `Gross notional ${rawLeverage.toFixed(2)}x equity exceeds the ${Number(state.riskLimits.maxLeverage).toFixed(1)}x limit`,
          });
        } else if (rawLeverage > state.riskLimits.maxLeverage * EARLY_WARNING_RATIOS.leverage) {
          breaches.push({
            code: "LEVERAGE_APPROACHING",
            message: `Gross notional ${rawLeverage.toFixed(2)}x equity is approaching the ${Number(state.riskLimits.maxLeverage).toFixed(1)}x limit`,
          });
        }
      }
      for (const [symbol, risk] of Object.entries(summary.openRiskBySymbol)) {
        if (summary.equity > 0 && numeric(risk) / summary.equity > state.riskLimits.maxSymbolExposurePct) {
          breaches.push({ code: "SYMBOL_EXPOSURE_LIMIT", symbol, message: `Open risk in ${symbol} exceeds the symbol exposure limit` });
        }
      }
      const correlatedGroups = findCorrelatedGroupOverlaps(summary.positions.map((position) => position.symbol));
      for (const overlap of correlatedGroups) {
        if (overlap.count > state.riskLimits.maxCorrelatedPositions) {
          breaches.push({
            code: "CORRELATED_POSITION_LIMIT",
            symbol: overlap.group,
            message: `${overlap.count} positions in correlated group ${overlap.group} (${overlap.symbols.join(", ")}) exceed limit ${state.riskLimits.maxCorrelatedPositions} — ${CORRELATION_MODEL_DESCRIPTION}`,
          });
        } else if (overlap.count >= 2) {
          breaches.push({
            code: "CORRELATED_GROUP_EXPOSURE",
            symbol: overlap.group,
            message: `${overlap.count} positions in correlated group ${overlap.group} (${overlap.symbols.join(", ")}) — ${CORRELATION_MODEL_DESCRIPTION}`,
          });
        }
      }
      const syntheticPositions = summary.positions.filter((position) => position.synthetic);
      if (!state.allowSyntheticPaperData && syntheticPositions.length) {
        breaches.push({ code: "SYNTHETIC_EXPOSURE", message: `${syntheticPositions.length} open position(s) were opened with synthetic data while synthetic paper data is blocked` });
      }
      scanned.push({
        accountId: Number(account.id),
        accountName: account.name,
        equity: summary.equity,
        balance: summary.balance,
        unrealizedPnl: summary.unrealizedPnl,
        dailyPnl: summary.dailyPnl,
        weeklyPnl: summary.weeklyPnl,
        dailyLossPct: summary.dailyLossPct,
        openPositions: summary.openPositions,
        openRisk: summary.openRisk,
        openRiskBySymbol: summary.openRiskBySymbol,
        grossNotional: Math.round(grossNotional * 100) / 100,
        leverage,
        peakEquity: summary.peakEquity,
        drawdownPct: summary.drawdownPct,
        valuationAvailable: summary.valuationAvailable,
        valuationWarnings: summary.valuationWarnings,
        syntheticPositions: syntheticPositions.length,
        status: breaches.length ? "BREACH" : "HEALTHY",
        breaches,
      });
    }
    return {
      generatedAt: isoNow(now),
      tradingMode: state.tradingMode,
      killSwitch: state.killSwitch,
      allowSyntheticPaperData: state.allowSyntheticPaperData,
      limits: state.riskLimits,
      correlationModel: CORRELATION_MODEL_DESCRIPTION,
      correlationGroups: CORRELATION_GROUPS,
      simulationOnly: true,
      accounts: scanned,
      totals: {
        accounts: scanned.length,
        breachedAccounts: scanned.filter((entry) => entry.status === "BREACH").length,
        equity: Math.round(scanned.reduce((sum, entry) => sum + numeric(entry.equity), 0) * 100) / 100,
        openPositions: scanned.reduce((sum, entry) => sum + entry.openPositions, 0),
      },
    };
  }

  function statusSnapshot() {
    return {
      enabled: true,
      simulationOnly: true,
      liveTradingEnabled: false,
      ownerScopedAccounts: true,
      persistedGovernance: true,
      transactionAdapter: store?.capabilities?.adapter ?? store?.adapter ?? "unknown",
    };
  }

  return {
    createAccount,
    listAccounts,
    accountSummary,
    listOrders,
    submitOrder,
    positions,
    closePosition,
    tick,
    listDeployments,
    deployStrategy,
    toggleDeployment,
    tradingState,
    riskLimits,
    updateRiskLimits,
    setTradingMode,
    setKillSwitch,
    setSyntheticPaperData,
    portfolioRiskScan,
    statusSnapshot,
  };
}
