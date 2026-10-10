/**
 * Technical indicator suite.
 *
 * Ported function-for-function from `application/libraries/Aegis/Indicators.php`
 * (itself a port of the tested TypeScript edition). These are pure functions:
 * no I/O, no clock, no configuration. Every series is returned at full length
 * with `null` in the positions where the indicator has not warmed up yet, which
 * is what makes "the last value" a separate operation (`last()`) rather than an
 * assumption that index 0 is meaningful.
 *
 * Two behaviours are deliberate and easy to "fix" by mistake, so they are called
 * out here:
 *  - `stochastic()` and `adx()` smooth over arrays in which the not-yet-warmed
 *    `null`s have been replaced with `0.0`, then re-mask the output. That is the
 *    legacy arithmetic; changing it changes every downstream number.
 *  - `findSwings()` disqualifies a fractal on a *tie* (`>=` / `<=`), so equal
 *    highs do not both count as swing highs.
 */

import { mean, stdev } from "./math.js";

export function sma(values, period) {
  const out = [];
  let sum = 0;
  const n = values.length;
  for (let i = 0; i < n; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

export function ema(values, period) {
  if (period <= 0) return values.map(() => null);
  const k = 2 / (period + 1);
  const out = [];
  let previous = null;
  let seed = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (i < period - 1) {
      seed += values[i];
      out.push(null);
      continue;
    }
    if (previous === null) {
      seed += values[i];
      previous = seed / period;
    } else {
      previous = values[i] * k + previous * (1 - k);
    }
    out.push(previous);
  }
  return out;
}

/** Wilder's smoothing — the RSI/ATR/ADX average, not an EMA. */
export function wilder(values, period) {
  const out = [];
  let previous = null;
  let seed = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (i < period - 1) {
      seed += values[i];
      out.push(null);
      continue;
    }
    if (previous === null) {
      seed += values[i];
      previous = seed / period;
    } else {
      previous = (previous * (period - 1) + values[i]) / period;
    }
    out.push(previous);
  }
  return out;
}

export function rsi(closes, period = 14) {
  const n = closes.length;
  const gains = [0];
  const losses = [0];
  for (let i = 1; i < n; i += 1) {
    const delta = closes[i] - closes[i - 1];
    gains.push(Math.max(0, delta));
    losses.push(Math.max(0, -delta));
  }
  const averageGain = wilder(gains.slice(1), period);
  const averageLoss = wilder(losses.slice(1), period);
  const out = [null];
  for (let i = 1; i < n; i += 1) {
    const gain = averageGain[i - 1] ?? null;
    const loss = averageLoss[i - 1] ?? null;
    if (gain === null || loss === null) {
      out.push(null);
      continue;
    }
    if (loss === 0) {
      out.push(gain === 0 ? 50 : 100);
      continue;
    }
    out.push(100 - 100 / (1 + gain / loss));
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const n = closes.length;
  const macdLine = [];
  for (let i = 0; i < n; i += 1) {
    macdLine.push(emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null);
  }
  let firstIndex = -1;
  for (let i = 0; i < macdLine.length; i += 1) {
    if (macdLine[i] !== null) {
      firstIndex = i;
      break;
    }
  }
  const signal = new Array(n).fill(null);
  if (firstIndex >= 0) {
    const defined = macdLine.slice(firstIndex).map((value) => (value === null ? 0 : value));
    const signalRaw = ema(defined, signalPeriod);
    signalRaw.forEach((value, offset) => {
      signal[firstIndex + offset] = value;
    });
  }
  const histogram = [];
  for (let i = 0; i < n; i += 1) {
    histogram.push(macdLine[i] !== null && signal[i] !== null ? macdLine[i] - signal[i] : null);
  }
  return { macd: macdLine, signal, histogram };
}

export function bollinger(closes, period = 20, multiplier = 2) {
  const mid = sma(closes, period);
  const upper = [];
  const lower = [];
  for (let i = 0; i < closes.length; i += 1) {
    if (mid[i] === null) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    const deviation = stdev(closes.slice(i - period + 1, i + 1));
    upper.push(deviation === null ? null : mid[i] + multiplier * deviation);
    lower.push(deviation === null ? null : mid[i] - multiplier * deviation);
  }
  return { upper, mid, lower };
}

export function stochastic(candles, kPeriod = 14, dPeriod = 3) {
  const k = [];
  const n = candles.length;
  for (let i = 0; i < n; i += 1) {
    if (i < kPeriod - 1) {
      k.push(null);
      continue;
    }
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j += 1) {
      highest = Math.max(highest, candles[j].high);
      lowest = Math.min(lowest, candles[j].low);
    }
    k.push(highest === lowest ? 50 : (100 * (candles[i].close - lowest)) / (highest - lowest));
  }
  const kDefined = k.map((value) => (value === null ? 0 : value));
  const dRaw = sma(kDefined, dPeriod);
  const d = k.map((value, i) => (value === null ? null : dRaw[i]));
  return { k, d };
}

export function trueRange(candles) {
  const out = [];
  for (let i = 0; i < candles.length; i += 1) {
    if (i === 0) {
      out.push(candles[0].high - candles[0].low);
      continue;
    }
    const previousClose = candles[i - 1].close;
    out.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - previousClose),
      Math.abs(candles[i].low - previousClose),
    ));
  }
  return out;
}

export function atr(candles, period = 14) {
  return wilder(trueRange(candles), period);
}

export function adx(candles, period = 14) {
  const n = candles.length;
  const plusDm = [0];
  const minusDm = [0];
  for (let i = 1; i < n; i += 1) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  const tr = wilder(trueRange(candles), period);
  const smoothedPlus = wilder(plusDm, period);
  const smoothedMinus = wilder(minusDm, period);

  const plusDi = [];
  const minusDi = [];
  const dx = [];
  for (let i = 0; i < n; i += 1) {
    if (tr[i] === null || smoothedPlus[i] === null || smoothedMinus[i] === null || tr[i] === 0) {
      plusDi.push(null);
      minusDi.push(null);
      dx.push(null);
      continue;
    }
    const plus = (100 * smoothedPlus[i]) / tr[i];
    const minus = (100 * smoothedMinus[i]) / tr[i];
    plusDi.push(plus);
    minusDi.push(minus);
    dx.push(plus + minus === 0 ? 0 : (100 * Math.abs(plus - minus)) / (plus + minus));
  }

  let firstIndex = -1;
  for (let i = 0; i < dx.length; i += 1) {
    if (dx[i] !== null) {
      firstIndex = i;
      break;
    }
  }
  const adxLine = new Array(n).fill(null);
  if (firstIndex >= 0) {
    const dxDefined = dx.slice(firstIndex).map((value) => (value === null ? 0 : value));
    wilder(dxDefined, period).forEach((value, offset) => {
      adxLine[firstIndex + offset] = value;
    });
  }
  return { adx: adxLine, plusDi, minusDi };
}

export function vwap(candles) {
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  return candles.map((candle) => {
    if (candle.volume <= 0) return null;
    const typical = (candle.high + candle.low + candle.close) / 3;
    cumulativePriceVolume += typical * candle.volume;
    cumulativeVolume += candle.volume;
    return cumulativeVolume === 0 ? null : cumulativePriceVolume / cumulativeVolume;
  });
}

export function volumeProfile(candles, bins = 24) {
  const priced = candles.filter((candle) => candle.volume > 0);
  if (priced.length === 0) return { poc: null, valueAreaHigh: null, valueAreaLow: null };

  const low = Math.min(...priced.map((candle) => candle.low));
  const high = Math.max(...priced.map((candle) => candle.high));
  if (!(high > low)) return { poc: low, valueAreaHigh: high, valueAreaLow: low };

  const width = (high - low) / bins;
  const binVolumes = new Array(bins).fill(0);
  for (const candle of priced) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    const index = Math.floor((typical - low) / width);
    binVolumes[Math.max(0, Math.min(bins - 1, index))] += candle.volume;
  }
  const total = binVolumes.reduce((sum, value) => sum + value, 0);

  let pocIndex = 0;
  for (let i = 1; i < bins; i += 1) {
    if (binVolumes[i] > binVolumes[pocIndex]) pocIndex = i;
  }

  // Value area: expand from the point of control until 70% of volume is covered,
  // always taking the heavier neighbour.
  let lowIndex = pocIndex;
  let highIndex = pocIndex;
  let accumulated = binVolumes[pocIndex];
  while (accumulated < total * 0.7 && (lowIndex > 0 || highIndex < bins - 1)) {
    const below = lowIndex > 0 ? binVolumes[lowIndex - 1] : -1;
    const above = highIndex < bins - 1 ? binVolumes[highIndex + 1] : -1;
    if (above >= below) {
      highIndex += 1;
      accumulated += Math.max(above, 0);
    } else {
      lowIndex -= 1;
      accumulated += Math.max(below, 0);
    }
  }

  return {
    poc: low + (pocIndex + 0.5) * width,
    valueAreaHigh: low + (highIndex + 1) * width,
    valueAreaLow: low + lowIndex * width,
  };
}

export function findSwings(candles, k = 2) {
  const swings = [];
  const n = candles.length;
  for (let i = k; i < n - k; i += 1) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j += 1) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) {
      swings.push({ index: i, timestamp: candles[i].timestamp, price: candles[i].high, type: "high" });
    }
    if (isLow) {
      swings.push({ index: i, timestamp: candles[i].timestamp, price: candles[i].low, type: "low" });
    }
  }
  return swings;
}

export function supportResistance(candles, atrValue, currentPrice, maxLevels = 4) {
  const swings = findSwings(candles, 2);
  if (swings.length === 0) return { support: [], resistance: [] };

  const tolerance = atrValue !== null && atrValue > 0 ? atrValue * 0.5 : currentPrice * 0.002;
  const levels = [];
  for (const swing of swings) {
    const existing = levels.find((level) => Math.abs(level.price - swing.price) <= tolerance);
    if (existing) {
      existing.price = (existing.price * existing.touches + swing.price) / (existing.touches + 1);
      existing.touches += 1;
    } else {
      levels.push({ price: swing.price, touches: 1 });
    }
  }

  levels.sort((a, b) => b.touches - a.touches);
  const chosen = levels.slice(0, maxLevels * 2);
  chosen.sort((a, b) => a.price - b.price);

  const support = [];
  const resistance = [];
  for (const level of chosen) {
    if (level.price < currentPrice) support.push(level.price);
    else resistance.push(level.price);
  }
  return { support: support.slice(-maxLevels), resistance: resistance.slice(0, maxLevels) };
}

const NULL_PIVOTS = Object.freeze({ p: null, r1: null, r2: null, r3: null, s1: null, s2: null, s3: null });

export function pivotPoints(previous) {
  if (!previous) return { ...NULL_PIVOTS };
  const { high, low, close } = previous;
  const p = (high + low + close) / 3;
  return {
    p,
    r1: 2 * p - low,
    s1: 2 * p - high,
    r2: p + (high - low),
    s2: p - (high - low),
    r3: high + 2 * (p - low),
    s3: low - 2 * (high - p),
  };
}

export function regressionSlopePct(closes, period = 50) {
  const n = closes.length;
  if (n < period) return null;
  const ys = closes.slice(-period);
  const m = ys.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < m; i += 1) {
    sumX += i;
    sumY += ys[i];
    sumXY += i * ys[i];
    sumXX += i * i;
  }
  const denominator = m * sumXX - sumX * sumX;
  if (denominator === 0) return null;
  const slope = (m * sumXY - sumX * sumY) / denominator;
  const mid = mean(ys) ?? 1;
  return (slope / mid) * 100;
}

/** The most recent usable value of an indicator series (`null`s are skipped). */
export function last(series) {
  if (!Array.isArray(series)) return null;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i] !== null && Number.isFinite(series[i])) return series[i];
  }
  return null;
}
