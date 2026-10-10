/**
 * The four builtin trading strategies, their contract, and the variant factory.
 *
 * Ported from `application/libraries/Aegis/Strategies/BuiltinStrategies.php`.
 *
 * A strategy is a **proposal generator**: `evaluate(context)` looks at one closed
 * bar through a strictly causal `SeriesView` and returns a signal. It never
 * sizes a position, never touches money and never places an order — the
 * backtester applies signals through position management and cost modelling, and
 * anything that could route an order would additionally pass the risk engine.
 * Keeping that separation is what lets the same strategy code be reused by the
 * backtester, the optimizer and (later) paper trading without any of them being
 * able to reach a broker.
 *
 * Two porting decisions worth recording:
 *
 * 1. **Parameters replace the defaults; they are not merged.** The legacy
 *    constructors take `array $p = [defaults]`, so passing a params array
 *    wholesale replaces the defaults. `builtinStrategyFactory` relies on that:
 *    the optimizer hands each candidate a complete combination produced from the
 *    strategy's own `paramGrid()`, whose keys are exactly the parameter keys.
 *    Merging would have hidden a malformed grid instead of exposing it.
 * 2. **Absent parameters coerce to zero, not `NaN`.** The legacy reads
 *    `$p['key']` directly, and PHP's `null` participates in arithmetic as `0`
 *    (`null + 2 === 2`). A naive JS port would produce `NaN` and silently change
 *    which bars are skipped. `numericParam` reproduces the PHP coercion, so the
 *    degenerate "empty params" path behaves identically on both sides. It is
 *    unreachable in practice — builtins always carry full defaults and the
 *    optimizer always supplies full grid combinations — but matching it costs
 *    nothing and removes a whole class of divergence.
 *
 * The legacy file also defines a `num()` helper that nothing calls. It is not
 * ported as a public export; `numericParam` is its working equivalent and is
 * documented here so the omission is deliberate rather than an oversight.
 */

import { clamp, numberFormat } from "../analysis/math.js";

/** The market classes every builtin declares. Mirrors the legacy arrays verbatim. */
const ALL_MARKET_CLASSES = Object.freeze([
  "forex",
  "crypto",
  "stock",
  "etf",
  "commodity",
  "futures",
  "indices",
]);

/**
 * The timeframes every builtin declares.
 *
 * Note `1m` is deliberately absent even though the market-data module serves it:
 * the legacy strategies never claimed one-minute support, and a backtest on `1m`
 * would need a cost model calibrated for that horizon.
 */
const ALL_TIMEFRAMES = Object.freeze(["5m", "15m", "1h", "4h", "1d"]);

/**
 * The neutral signal. Returned whenever no entry or exit condition holds.
 *
 * Confidence is exactly `0` — not a small positive number — so that downstream
 * consumers cannot mistake "no opinion" for "weak opinion".
 */
export function hold() {
  return { action: "HOLD", reason: "no entry condition", confidence: 0 };
}

/**
 * Read a numeric parameter with PHP's `null`-as-zero arithmetic coercion.
 *
 * @param {Record<string, unknown>} params
 * @param {string} key
 * @returns {number} the value when finite, otherwise `0`
 */
function numericParam(params, key) {
  const value = params?.[key];
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return 0;
}

/** Integer coercion for bar-count parameters, matching PHP's `(int)round(...)`. */
function intParam(params, key) {
  return Math.round(numericParam(params, key));
}

/**
 * The strategy contract (legacy `TradingStrategy`).
 *
 * Every strategy — builtin or optimizer variant — exposes exactly this surface.
 * Consumers must not reach past it: the backtester and the registry only ever
 * call these methods, which is what allows a variant to be substituted for a
 * builtin without either noticing.
 *
 * @typedef {object} TradingStrategy
 * @property {() => string} id
 * @property {() => string} version
 * @property {() => string} name
 * @property {() => string} description
 * @property {() => string[]} marketClasses
 * @property {() => string[]} timeframes
 * @property {() => Record<string, number>} params
 * @property {() => Record<string, number[]>} paramGrid bounded search space
 * @property {() => boolean} supportsShorts
 * @property {(ctx: EvaluationContext) => Signal} evaluate
 */

/**
 * What `evaluate` receives.
 *
 * `position` is `null` when flat. `equity` includes unrealised P&L, so a
 * strategy that wanted to scale with account size could — none of the builtins
 * do, because sizing is the backtester's and the risk engine's job, not theirs.
 *
 * @typedef {object} EvaluationContext
 * @property {import("./series-view.js").SeriesView} view
 * @property {{direction:string,entryPrice:number,entryBar:number,stopLoss:number,takeProfit:number,unrealizedPnl:number}|null} position
 * @property {number} equity
 */

/**
 * What `evaluate` returns.
 *
 * `stopLoss` is mandatory for entries: the backtester refuses to open a position
 * without one, and the risk review gate rejects any strategy that does not
 * declare a stop distance parameter. A strategy that cannot say where it is
 * wrong cannot be traded.
 *
 * @typedef {object} Signal
 * @property {"BUY"|"SELL"|"CLOSE"|"HOLD"} action
 * @property {string} reason human-readable, and pinned by tests
 * @property {number} confidence 0..1
 * @property {number} [stopLoss]
 * @property {number} [takeProfit]
 */

/** Shared metadata for all four builtins. */
function commonMetadata() {
  return {
    marketClasses: () => [...ALL_MARKET_CLASSES],
    timeframes: () => [...ALL_TIMEFRAMES],
    supportsShorts: () => true,
  };
}

/** Default parameters for `trend-following`. */
export const TREND_FOLLOWING_DEFAULTS = Object.freeze({
  fast: 20,
  slow: 50,
  adxMin: 25,
  stopAtr: 2,
  targetR: 3,
});

/** Default parameters for `mean-reversion`. */
export const MEAN_REVERSION_DEFAULTS = Object.freeze({
  rsiLow: 30,
  rsiHigh: 70,
  adxMax: 30,
  stopAtr: 2.5,
});

/** Default parameters for `breakout`. */
export const BREAKOUT_DEFAULTS = Object.freeze({
  lookback: 48,
  volMult: 1.5,
  stopAtr: 1.5,
  targetR: 2.5,
});

/** Default parameters for `momentum`. */
export const MOMENTUM_DEFAULTS = Object.freeze({
  rocPeriod: 20,
  rocMinPct: 1.5,
  stopAtr: 2,
  targetR: 3,
});

/**
 * EMA cross filtered by ADX.
 *
 * Enters on a fresh cross (the previous bar had fast on the other side), which
 * matters: without the cross check the strategy would re-enter on every bar of a
 * trend and the backtester would book a new position each time the old one
 * closed. ADX keeps it out of directionless chop where an EMA cross is noise.
 *
 * Exits on the opposite cross rather than on a fixed R multiple alone, so a
 * trend that keeps running is not sold early.
 *
 * @param {Record<string, number>} [params] replaces the defaults wholesale
 * @returns {TradingStrategy}
 */
export function createTrendFollowingStrategy(params = TREND_FOLLOWING_DEFAULTS) {
  const p = params;
  return Object.freeze({
    id: () => "trend-following",
    version: () => "1.0.0",
    name: () => "Trend Following (EMA cross + ADX)",
    description: () =>
      "Long when EMA20 crosses above EMA50 with ADX >= threshold; exit on opposite cross. Stops at ATR multiple, targets at R multiple.",
    params: () => ({ ...p }),
    paramGrid: () => ({
      fast: [10, 20],
      slow: [40, 50, 60],
      adxMin: [20, 25],
      stopAtr: [2],
      targetR: [2, 3],
    }),
    ...commonMetadata(),
    evaluate(ctx) {
      const view = ctx.view;
      const i = view.index;
      const slow = numericParam(p, "slow");
      const adxMin = numericParam(p, "adxMin");
      const stopAtr = numericParam(p, "stopAtr");
      const targetR = numericParam(p, "targetR");
      if (i < slow + 2) return hold();

      const fast = view.ema20(i);
      const slowEma = view.ema50(i);
      const fastPrev = view.ema20(i - 1);
      const slowPrev = view.ema50(i - 1);
      const adxValue = view.adx14(i);
      const atrValue = view.atr14(i);
      if (
        fast === null ||
        slowEma === null ||
        fastPrev === null ||
        slowPrev === null ||
        adxValue === null ||
        atrValue === null
      ) {
        return hold();
      }

      const crossedUp = fastPrev <= slowPrev && fast > slowEma;
      const crossedDown = fastPrev >= slowPrev && fast < slowEma;
      const direction = ctx.position?.direction ?? null;

      if (direction === "LONG" && crossedDown) {
        return {
          action: "CLOSE",
          reason: "EMA20 crossed below EMA50 — trend flipped",
          confidence: 0.6,
        };
      }
      if (direction === "SHORT" && crossedUp) {
        return {
          action: "CLOSE",
          reason: "EMA20 crossed above EMA50 — trend flipped",
          confidence: 0.6,
        };
      }

      const close = view.close(i);
      if (!ctx.position && crossedUp && adxValue >= adxMin) {
        const stop = close - stopAtr * atrValue;
        return {
          action: "BUY",
          reason: `EMA20 crossed above EMA50 with ADX ${numberFormat(adxValue, 1)} >= ${adxMin}`,
          confidence: clamp(adxValue / 60, 0.2, 0.95),
          stopLoss: stop,
          takeProfit: close + targetR * (close - stop),
        };
      }
      if (!ctx.position && crossedDown && adxValue >= adxMin) {
        const stop = close + stopAtr * atrValue;
        return {
          action: "SELL",
          reason: `EMA20 crossed below EMA50 with ADX ${numberFormat(adxValue, 1)} >= ${adxMin}`,
          confidence: clamp(adxValue / 60, 0.2, 0.95),
          stopLoss: stop,
          takeProfit: close - targetR * (stop - close),
        };
      }
      return hold();
    },
  });
}

/**
 * Bollinger band pierce filtered by RSI, in a range only.
 *
 * The ADX ceiling is the important half of this strategy: fading a strong trend
 * is how mean-reversion systems lose money, so when ADX exceeds `adxMax` the
 * strategy refuses to look at the bands at all. Oracle case `05-strategies.php`
 * pins both halves — it must fire on an oversold pierce, and it must HOLD on a
 * trending series.
 *
 * Targets the mid band rather than a fixed R multiple, because "price returns to
 * the mean" is the actual thesis; the opposite band would be a different claim.
 *
 * @param {Record<string, number>} [params]
 * @returns {TradingStrategy}
 */
export function createMeanReversionStrategy(params = MEAN_REVERSION_DEFAULTS) {
  const p = params;
  return Object.freeze({
    id: () => "mean-reversion",
    version: () => "1.0.0",
    name: () => "Mean Reversion (Bollinger + RSI)",
    description: () =>
      "Long when close pierces the lower Bollinger band with RSI oversold; exit at the mid band or stop. Range regime only.",
    params: () => ({ ...p }),
    paramGrid: () => ({
      rsiLow: [25, 30],
      rsiHigh: [70, 75],
      adxMax: [25, 30],
      stopAtr: [2.5],
    }),
    ...commonMetadata(),
    evaluate(ctx) {
      const view = ctx.view;
      const i = view.index;
      // 52 bars: enough for the 50-period SMA inside the Bollinger band to warm up.
      if (i < 52) return hold();

      const rsiLow = numericParam(p, "rsiLow");
      const rsiHigh = numericParam(p, "rsiHigh");
      const adxMax = numericParam(p, "adxMax");
      const stopAtr = numericParam(p, "stopAtr");

      const lower = view.bbLower(i);
      const upper = view.bbUpper(i);
      const mid = view.bbMid(i);
      const rsiValue = view.rsi14(i);
      const adxValue = view.adx14(i);
      const atrValue = view.atr14(i);
      if (
        lower === null ||
        upper === null ||
        mid === null ||
        rsiValue === null ||
        adxValue === null ||
        atrValue === null
      ) {
        return hold();
      }

      const close = view.close(i);
      const direction = ctx.position?.direction ?? null;
      if (direction === "LONG" && close >= mid) {
        return {
          action: "CLOSE",
          reason: "price reverted to the Bollinger mid band",
          confidence: 0.7,
        };
      }
      if (direction === "SHORT" && close <= mid) {
        return {
          action: "CLOSE",
          reason: "price reverted to the Bollinger mid band",
          confidence: 0.7,
        };
      }
      // Do not fade strong trends.
      if (adxValue > adxMax) return hold();

      if (close < lower && rsiValue < rsiLow) {
        const stop = close - stopAtr * atrValue;
        return {
          action: "BUY",
          reason: `close below lower band with RSI ${numberFormat(rsiValue, 1)} < ${rsiLow} in a range (ADX ${numberFormat(adxValue, 1)})`,
          confidence: clamp((rsiLow - rsiValue) / 15 + 0.5, 0.2, 0.9),
          stopLoss: stop,
          takeProfit: mid,
        };
      }
      if (close > upper && rsiValue > rsiHigh) {
        const stop = close + stopAtr * atrValue;
        return {
          action: "SELL",
          reason: `close above upper band with RSI ${numberFormat(rsiValue, 1)} > ${rsiHigh} in a range (ADX ${numberFormat(adxValue, 1)})`,
          confidence: clamp((rsiValue - rsiHigh) / 15 + 0.5, 0.2, 0.9),
          stopLoss: stop,
          takeProfit: mid,
        };
      }
      return hold();
    },
  });
}

/**
 * Range break confirmed by volume expansion.
 *
 * Two details carry the logic. The range window excludes the current bar
 * (`highestHigh(lookback, i)` looks strictly before `i`), otherwise the breaking
 * bar would define its own range and every bar would "break out". And the volume
 * baseline is measured up to `i - 1`, so the confirmation compares this bar's
 * volume against a prior average that does not include itself.
 *
 * When average volume is zero — a series with no volume data at all — the volume
 * test passes rather than blocks. That is the legacy behaviour and it is the
 * permissive choice: refusing would silently disable the strategy on any symbol
 * whose feed omits volume, and the run's warnings already carry the data quality
 * signal.
 *
 * This strategy only opens positions; it never emits CLOSE. Exits come from the
 * stop, the target, or the backtester's time stop.
 *
 * @param {Record<string, number>} [params]
 * @returns {TradingStrategy}
 */
export function createBreakoutStrategy(params = BREAKOUT_DEFAULTS) {
  const p = params;
  return Object.freeze({
    id: () => "breakout",
    version: () => "1.0.0",
    name: () => "Breakout (range break + volume expansion)",
    description: () =>
      "Long when close breaks the N-bar high with volume >= multiple of average; stop at ATR multiple, target at R multiple.",
    params: () => ({ ...p }),
    paramGrid: () => ({
      lookback: [24, 48, 72],
      volMult: [1.2, 1.5, 2.0],
      stopAtr: [1.5],
      targetR: [2, 2.5],
    }),
    ...commonMetadata(),
    evaluate(ctx) {
      const view = ctx.view;
      const i = view.index;
      const lookback = intParam(p, "lookback");
      const volMult = numericParam(p, "volMult");
      const stopAtr = numericParam(p, "stopAtr");
      const targetR = numericParam(p, "targetR");
      if (i < Math.max(lookback, 20) + 2) return hold();

      const atrValue = view.atr14(i);
      if (atrValue === null) return hold();
      const rangeHigh = view.highestHigh(lookback, i);
      const rangeLow = view.lowestLow(lookback, i);
      const avgVol = view.averageVolume(30, i - 1);
      const volume = view.volume(i);
      const volOk = avgVol > 0 ? volume >= volMult * avgVol : true;
      if (ctx.position) return hold();

      const close = view.close(i);
      const volRatio = volume / Math.max(avgVol, 1e-9);
      if (close > rangeHigh && volOk) {
        const stop = close - stopAtr * atrValue;
        return {
          action: "BUY",
          reason: `close ${numberFormat(close, 5)} broke the ${lookback}-bar high ${numberFormat(rangeHigh, 5)} with ${numberFormat(volRatio, 1)}x volume`,
          confidence: clamp(0.5 + Math.min(0.4, (volRatio - 1) / 4), 0.3, 0.95),
          stopLoss: stop,
          takeProfit: close + targetR * (close - stop),
        };
      }
      if (close < rangeLow && volOk) {
        const stop = close + stopAtr * atrValue;
        return {
          action: "SELL",
          reason: `close ${numberFormat(close, 5)} broke the ${lookback}-bar low ${numberFormat(rangeLow, 5)} with ${numberFormat(volRatio, 1)}x volume`,
          confidence: clamp(0.5 + Math.min(0.4, (volRatio - 1) / 4), 0.3, 0.95),
          stopLoss: stop,
          takeProfit: close - targetR * (stop - close),
        };
      }
      return hold();
    },
  });
}

/**
 * Rate of change confirmed by a rising MACD histogram.
 *
 * Requiring the histogram to be positive *and* rising is what separates this
 * from a naive momentum chase: ROC alone fires at the top of a move, while a
 * rising histogram says the move is still accelerating. Exits when the histogram
 * flips sign, i.e. when acceleration is gone, rather than waiting for ROC to
 * decay — by then the trade has usually given back most of its gain.
 *
 * @param {Record<string, number>} [params]
 * @returns {TradingStrategy}
 */
export function createMomentumStrategy(params = MOMENTUM_DEFAULTS) {
  const p = params;
  return Object.freeze({
    id: () => "momentum",
    version: () => "1.0.0",
    name: () => "Momentum (ROC + MACD)",
    description: () =>
      "Long when N-bar rate of change exceeds a threshold with a positive and rising MACD histogram; exit when the histogram flips.",
    params: () => ({ ...p }),
    paramGrid: () => ({
      rocPeriod: [10, 20],
      rocMinPct: [1.0, 1.5],
      stopAtr: [2],
      targetR: [2, 3],
    }),
    ...commonMetadata(),
    evaluate(ctx) {
      const view = ctx.view;
      const i = view.index;
      const rocPeriod = intParam(p, "rocPeriod");
      const rocMinPct = numericParam(p, "rocMinPct");
      const stopAtr = numericParam(p, "stopAtr");
      const targetR = numericParam(p, "targetR");
      if (i < Math.max(rocPeriod, 52) + 2) return hold();

      const hist = view.macdHistogram(i);
      const histPrev = view.macdHistogram(i - 1);
      const atrValue = view.atr14(i);
      if (hist === null || histPrev === null || atrValue === null) return hold();

      const close = view.close(i);
      const past = view.close(i - rocPeriod);
      const roc = past > 0 ? ((close - past) / past) * 100 : 0;
      const direction = ctx.position?.direction ?? null;

      if (direction === "LONG" && hist < 0) {
        return {
          action: "CLOSE",
          reason: "MACD histogram turned negative — momentum faded",
          confidence: 0.6,
        };
      }
      if (direction === "SHORT" && hist > 0) {
        return {
          action: "CLOSE",
          reason: "MACD histogram turned positive — momentum faded",
          confidence: 0.6,
        };
      }
      if (!ctx.position && roc > rocMinPct && hist > 0 && hist > histPrev) {
        const stop = close - stopAtr * atrValue;
        return {
          action: "BUY",
          reason: `ROC${rocPeriod} ${numberFormat(roc, 2)}% > ${rocMinPct}% with rising positive MACD histogram`,
          confidence: clamp(0.4 + Math.min(0.5, roc / (rocMinPct * 6)), 0.3, 0.95),
          stopLoss: stop,
          takeProfit: close + targetR * (close - stop),
        };
      }
      if (!ctx.position && roc < -rocMinPct && hist < 0 && hist < histPrev) {
        const stop = close + stopAtr * atrValue;
        return {
          action: "SELL",
          reason: `ROC${rocPeriod} ${numberFormat(roc, 2)}% < -${rocMinPct}% with falling negative MACD histogram`,
          confidence: clamp(0.4 + Math.min(0.5, -roc / (rocMinPct * 6)), 0.3, 0.95),
          stopLoss: stop,
          takeProfit: close - targetR * (stop - close),
        };
      }
      return hold();
    },
  });
}

/**
 * The builtin strategies with their default parameters.
 *
 * Seeded into the store on first boot (see `registry.js`) so the Strategy Lab
 * is never empty, and so `BACKTESTED` has something to test.
 *
 * @returns {TradingStrategy[]}
 */
export function builtinStrategies() {
  return [
    createTrendFollowingStrategy(),
    createMeanReversionStrategy(),
    createBreakoutStrategy(),
    createMomentumStrategy(),
  ];
}

/**
 * Parameter-aware factory for a builtin, used by the optimizer.
 *
 * Returns `null` for anything that is not a builtin: optimization is only
 * meaningful where a declared `paramGrid()` bounds the search, and a stored
 * variant has no grid of its own beyond the one it inherited.
 *
 * @param {string} id
 * @returns {((params: Record<string, number>) => TradingStrategy)|null}
 */
export function builtinStrategyFactory(id) {
  const factories = {
    "trend-following": createTrendFollowingStrategy,
    "mean-reversion": createMeanReversionStrategy,
    breakout: createBreakoutStrategy,
    momentum: createMomentumStrategy,
  };
  const factory = factories[id];
  if (!factory) return null;
  return (params) => factory(params);
}

/** The builtin ids, in seeding order. */
export const BUILTIN_STRATEGY_IDS = Object.freeze([
  "trend-following",
  "mean-reversion",
  "breakout",
  "momentum",
]);

/**
 * A registered variant of an existing strategy under a new version and new
 * parameters.
 *
 * Evaluation delegates to the inner implementation: a variant is the same
 * strategy logic with different numbers, so duplicating `evaluate` would create
 * two code paths that could drift. The variant is stored with `source: "ai"`,
 * which is what makes the lifecycle gates demand human sign-off before paper or
 * live stages — the decorator itself enforces nothing, the registry does.
 *
 * @param {TradingStrategy} inner
 * @param {string} version
 * @param {Record<string, number>} params
 * @returns {TradingStrategy}
 */
export function createVersionedStrategy(inner, version, params) {
  return Object.freeze({
    id: () => inner.id(),
    version: () => version,
    name: () => `${inner.name()} (optimized ${version})`,
    description: () => inner.description(),
    marketClasses: () => inner.marketClasses(),
    timeframes: () => inner.timeframes(),
    params: () => ({ ...params }),
    paramGrid: () => inner.paramGrid(),
    supportsShorts: () => inner.supportsShorts(),
    evaluate: (ctx) => inner.evaluate(ctx),
    /** Marks this as a variant; the registry stores `source: "ai"` for it. */
    isVariant: true,
    inner,
  });
}
