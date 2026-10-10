/**
 * Strictly causal window over a candle series, plus the look-ahead guard.
 *
 * Ported from `application/libraries/Aegis/Strategies/SeriesView.php`.
 *
 * A strategy is handed one of these per bar and may only ever read bars at or
 * before the current index. Indicators are precomputed once over the whole
 * series, which is safe *because* every indicator here is a prefix function —
 * `ema(closes)[i]` depends on `closes[0..i]` and nothing later — so the value
 * at `i` in the full-series computation equals the value at the last position
 * of a computation over the prefix `closes[0..i]`. Oracle case
 * `05-strategies.php` pins exactly that equivalence ("series view indicators
 * are causal"), and `test/strategies.test.js` re-pins it on the Node side.
 *
 * Look-ahead is treated as a bug, not a warning: reading a future bar throws
 * `LookAheadError`, and the backtester lets that exception escape and fails the
 * whole run rather than recording a biased result. That is deliberate — a
 * backtest that peeked is worse than no backtest, because it looks like
 * evidence.
 */

import {
  adx as adxSeries,
  atr as atrSeries,
  bollinger,
  ema,
  macd,
  rsi,
  sma,
  stochastic,
  vwap,
} from "../analysis/indicators.js";

/**
 * Thrown when a strategy reads a bar beyond the current evaluation point.
 * Named for parity with the legacy `Aegis\Strategies\LookAheadError`; the
 * backtester matches on this class to decide "fatal" versus "warn and carry on".
 */
export class LookAheadError extends Error {
  constructor(message) {
    super(message);
    this.name = "LookAheadError";
    this.code = "LOOK_AHEAD";
  }
}

/**
 * Precompute every indicator a builtin strategy may ask for, once per series.
 *
 * Mirrors `SeriesView::precompute`. The keys are part of the module's internal
 * contract — `seriesView.indicator()` looks them up by name — and they match the
 * legacy accessor names one for one.
 *
 * @param {Array<{open:number,high:number,low:number,close:number,volume:number}>} candles
 * @returns {Record<string, Array<number|null>>}
 */
export function precomputeIndicators(candles) {
  const closes = candles.map((candle) => candle.close);
  const macdResult = macd(closes);
  const bands = bollinger(closes, 20, 2);
  const adxResult = adxSeries(candles, 14);
  const stochResult = stochastic(candles, 14, 3);
  return {
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    sma50: sma(closes, 50),
    rsi14: rsi(closes, 14),
    macdHist: macdResult.histogram,
    adx14: adxResult.adx,
    plusDi: adxResult.plusDi,
    minusDi: adxResult.minusDi,
    atr14: atrSeries(candles, 14),
    bbUpper: bands.upper,
    bbMid: bands.mid,
    bbLower: bands.lower,
    stochK: stochResult.k,
    stochD: stochResult.d,
    vwap: vwap(candles),
  };
}

/** The indicator keys `precomputeIndicators` produces, for tests and diagnostics. */
export const INDICATOR_KEYS = Object.freeze([
  "ema20",
  "ema50",
  "sma50",
  "rsi14",
  "macdHist",
  "adx14",
  "plusDi",
  "minusDi",
  "atr14",
  "bbUpper",
  "bbMid",
  "bbLower",
  "stochK",
  "stochD",
  "vwap",
]);

/**
 * Resolve the "default to the current bar" convention.
 *
 * Every accessor takes an optional index where a negative or omitted value
 * means "the current bar", exactly as the legacy `-1` sentinel does. Callers
 * inside the strategies pass an explicit index; only convenience calls rely on
 * the default.
 *
 * @param {number|undefined|null} requested
 * @param {number} current
 * @returns {number}
 */
function resolveIndex(requested, current) {
  return requested === undefined || requested === null || requested < 0 ? current : requested;
}

/**
 * A causal view over `candles` positioned at `index`.
 *
 * Instances are created fresh per bar by the backtester. They are cheap: the
 * indicator arrays are computed once and shared by reference.
 */
export class SeriesView {
  /**
   * @param {Array<object>} candles the full series (all bars, including future ones)
   * @param {Record<string, Array<number|null>>} indicators from `precomputeIndicators`
   * @param {number} index the current bar; nothing at a higher index is readable
   * @param {{symbol?: string, timeframe?: string, marketClass?: string}} meta
   */
  constructor(candles, indicators, index, meta = {}) {
    this.candles = candles;
    this.indicators = indicators;
    this.index = index;
    this.symbol = meta.symbol ?? "";
    this.timeframe = meta.timeframe ?? "";
    this.marketClass = meta.marketClass ?? "";
  }

  /**
   * Enforce causality. Throws rather than clamping: silently clamping a future
   * read to the current bar would hide the bug and produce plausible-looking
   * numbers from a strategy that is cheating.
   *
   * @param {number} i
   */
  check(i) {
    if (i > this.index || i < 0) {
      throw new LookAheadError(
        `Look-ahead access denied: strategy requested bar ${i} but current bar is ${this.index}`,
      );
    }
  }

  /** How many bars this view can see, i.e. `index + 1`. */
  barsVisible() {
    return this.index + 1;
  }

  /**
   * Read a precomputed indicator at a bar.
   *
   * Returns `null` when the indicator has not warmed up yet at that bar, which
   * is why every strategy null-checks before comparing — an RSI of `null` at
   * bar 5 must not be read as "not oversold".
   *
   * @param {string} key one of `INDICATOR_KEYS`
   * @param {number} [i]
   * @returns {number|null}
   */
  indicator(key, i = -1) {
    const at = resolveIndex(i, this.index);
    this.check(at);
    const series = this.indicators[key];
    if (!series) return null;
    const value = series[at];
    return value === undefined ? null : value;
  }

  // ---- raw OHLCV accessors (legacy names kept verbatim) -------------------

  open(i = -1) {
    const at = resolveIndex(i, this.index);
    this.check(at);
    return this.candles[at].open;
  }

  high(i = -1) {
    const at = resolveIndex(i, this.index);
    this.check(at);
    return this.candles[at].high;
  }

  low(i = -1) {
    const at = resolveIndex(i, this.index);
    this.check(at);
    return this.candles[at].low;
  }

  close(i = -1) {
    const at = resolveIndex(i, this.index);
    this.check(at);
    return this.candles[at].close;
  }

  volume(i = -1) {
    const at = resolveIndex(i, this.index);
    this.check(at);
    return this.candles[at].volume;
  }

  time(i = -1) {
    const at = resolveIndex(i, this.index);
    this.check(at);
    return this.candles[at].timestamp;
  }

  // ---- windowed helpers ---------------------------------------------------

  /**
   * Highest high over the `n` bars strictly *before* `before`.
   *
   * The exclusion of `before` itself is what makes a breakout meaningful: the
   * bar that breaks the range must not be part of the range it breaks.
   *
   * @param {number} n
   * @param {number} [before]
   * @returns {number} `-Infinity` when the window is empty
   */
  highestHigh(n, before = -1) {
    const end = resolveIndex(before, this.index);
    this.check(end);
    let highest = -Infinity;
    for (let i = Math.max(0, end - n); i < end; i += 1) {
      highest = Math.max(highest, this.candles[i].high);
    }
    return highest;
  }

  /**
   * Lowest low over the `n` bars strictly before `before`.
   *
   * @param {number} n
   * @param {number} [before]
   * @returns {number} `Infinity` when the window is empty
   */
  lowestLow(n, before = -1) {
    const end = resolveIndex(before, this.index);
    this.check(end);
    let lowest = Infinity;
    for (let i = Math.max(0, end - n); i < end; i += 1) {
      lowest = Math.min(lowest, this.candles[i].low);
    }
    return lowest;
  }

  /**
   * Average volume over the `n` bars up to and including `upTo`.
   *
   * Unlike the high/low windows this one *includes* its end bar, matching the
   * legacy loop. Breakout calls it with `index - 1` so the current bar's volume
   * is compared against a baseline that excludes itself.
   *
   * @param {number} n
   * @param {number} [upTo]
   * @returns {number}
   */
  averageVolume(n, upTo = -1) {
    const end = resolveIndex(upTo, this.index);
    this.check(end);
    const from = Math.max(0, end - n + 1);
    let sum = 0;
    for (let i = from; i <= end; i += 1) sum += this.candles[i].volume;
    return sum / Math.max(1, end - from + 1);
  }

  // ---- indicator accessors (legacy names kept verbatim) -------------------

  ema20(i = -1) {
    return this.indicator("ema20", i);
  }

  ema50(i = -1) {
    return this.indicator("ema50", i);
  }

  sma50(i = -1) {
    return this.indicator("sma50", i);
  }

  rsi14(i = -1) {
    return this.indicator("rsi14", i);
  }

  macdHistogram(i = -1) {
    return this.indicator("macdHist", i);
  }

  adx14(i = -1) {
    return this.indicator("adx14", i);
  }

  plusDi(i = -1) {
    return this.indicator("plusDi", i);
  }

  minusDi(i = -1) {
    return this.indicator("minusDi", i);
  }

  atr14(i = -1) {
    return this.indicator("atr14", i);
  }

  bbUpper(i = -1) {
    return this.indicator("bbUpper", i);
  }

  bbMid(i = -1) {
    return this.indicator("bbMid", i);
  }

  bbLower(i = -1) {
    return this.indicator("bbLower", i);
  }

  stochK(i = -1) {
    return this.indicator("stochK", i);
  }

  stochD(i = -1) {
    return this.indicator("stochD", i);
  }

  vwap(i = -1) {
    return this.indicator("vwap", i);
  }
}
