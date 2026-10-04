<?php
namespace Aegis\Strategies;

use Aegis\MathUtils;

/**
 * Strategy contract (spec §12): evaluate(context) -> signal. Strategies are
 * PROPOSALS — the backtester, paper engine and (Phase 5) execution
 * supervisor apply them through position management and the Risk Engine.
 */
interface TradingStrategy
{
    public function id(): string;
    public function version(): string;
    public function name(): string;
    public function description(): string;
    /** @return string[] */
    public function marketClasses(): array;
    /** @return string[] */
    public function timeframes(): array;
    /** @return array<string, mixed> */
    public function params(): array;
    /** Bounded parameter search space for the strategy optimizer (small by design). */
    public function paramGrid(): array;
    public function supportsShorts(): bool;
    /** @return array{action:string,reason:string,confidence:float,stopLoss?:float,takeProfit?:float} */
    public function evaluate(array $ctx): array;
}

function hold(): array
{
    return ['action' => 'HOLD', 'reason' => 'no entry condition', 'confidence' => 0.0];
}

function num(array $params, string $key, float $fallback): float
{
    $v = $params[$key] ?? null;
    return (is_numeric($v) && is_finite((float)$v)) ? (float)$v : $fallback;
}

class TrendFollowingStrategy implements TradingStrategy
{
    public function __construct(private readonly array $p = [
        'fast' => 20, 'slow' => 50, 'adxMin' => 25, 'stopAtr' => 2, 'targetR' => 3,
    ]) {}

    public function id(): string { return 'trend-following'; }
    public function version(): string { return '1.0.0'; }
    public function name(): string { return 'Trend Following (EMA cross + ADX)'; }
    public function description(): string { return 'Long when EMA20 crosses above EMA50 with ADX >= threshold; exit on opposite cross. Stops at ATR multiple, targets at R multiple.'; }
    public function marketClasses(): array { return ['forex', 'crypto', 'stock', 'etf', 'commodity', 'futures', 'indices']; }
    public function timeframes(): array { return ['5m', '15m', '1h', '4h', '1d']; }
    public function params(): array { return $this->p; }
    public function paramGrid(): array { return ['fast' => [10, 20], 'slow' => [40, 50, 60], 'adxMin' => [20, 25], 'stopAtr' => [2], 'targetR' => [2, 3]]; }
    public function supportsShorts(): bool { return true; }

    public function evaluate(array $ctx): array
    {
        $p = $this->p;
        $v = $ctx['view'];
        $i = $v->index;
        if ($i < $p['slow'] + 2) return hold();

        $fast = $v->ema20($i); $slow = $v->ema50($i);
        $fastPrev = $v->ema20($i - 1); $slowPrev = $v->ema50($i - 1);
        $adx = $v->adx14($i); $atr = $v->atr14($i);
        if ($fast === null || $slow === null || $fastPrev === null || $slowPrev === null || $adx === null || $atr === null) return hold();

        $crossedUp = $fastPrev <= $slowPrev && $fast > $slow;
        $crossedDown = $fastPrev >= $slowPrev && $fast < $slow;

        if (($ctx['position']['direction'] ?? null) === 'LONG' && $crossedDown) {
            return ['action' => 'CLOSE', 'reason' => 'EMA20 crossed below EMA50 — trend flipped', 'confidence' => 0.6];
        }
        if (($ctx['position']['direction'] ?? null) === 'SHORT' && $crossedUp) {
            return ['action' => 'CLOSE', 'reason' => 'EMA20 crossed above EMA50 — trend flipped', 'confidence' => 0.6];
        }
        if (!$ctx['position'] && $crossedUp && $adx >= $p['adxMin']) {
            $stop = $v->close($i) - $p['stopAtr'] * $atr;
            return [
                'action' => 'BUY',
                'reason' => sprintf('EMA20 crossed above EMA50 with ADX %s >= %s', number_format($adx, 1), $p['adxMin']),
                'confidence' => MathUtils::clamp($adx / 60, 0.2, 0.95),
                'stopLoss' => $stop,
                'takeProfit' => $v->close($i) + $p['targetR'] * ($v->close($i) - $stop),
            ];
        }
        if (!$ctx['position'] && $crossedDown && $adx >= $p['adxMin']) {
            $stop = $v->close($i) + $p['stopAtr'] * $atr;
            return [
                'action' => 'SELL',
                'reason' => sprintf('EMA20 crossed below EMA50 with ADX %s >= %s', number_format($adx, 1), $p['adxMin']),
                'confidence' => MathUtils::clamp($adx / 60, 0.2, 0.95),
                'stopLoss' => $stop,
                'takeProfit' => $v->close($i) - $p['targetR'] * ($stop - $v->close($i)),
            ];
        }
        return hold();
    }
}

class MeanReversionStrategy implements TradingStrategy
{
    public function __construct(private readonly array $p = [
        'rsiLow' => 30, 'rsiHigh' => 70, 'adxMax' => 30, 'stopAtr' => 2.5,
    ]) {}

    public function id(): string { return 'mean-reversion'; }
    public function version(): string { return '1.0.0'; }
    public function name(): string { return 'Mean Reversion (Bollinger + RSI)'; }
    public function description(): string { return 'Long when close pierces the lower Bollinger band with RSI oversold; exit at the mid band or stop. Range regime only.'; }
    public function marketClasses(): array { return ['forex', 'crypto', 'stock', 'etf', 'commodity', 'futures', 'indices']; }
    public function timeframes(): array { return ['5m', '15m', '1h', '4h', '1d']; }
    public function params(): array { return $this->p; }
    public function paramGrid(): array { return ['rsiLow' => [25, 30], 'rsiHigh' => [70, 75], 'adxMax' => [25, 30], 'stopAtr' => [2.5]]; }
    public function supportsShorts(): bool { return true; }

    public function evaluate(array $ctx): array
    {
        $p = $this->p;
        $v = $ctx['view'];
        $i = $v->index;
        if ($i < 52) return hold();

        $lower = $v->bbLower($i); $upper = $v->bbUpper($i); $mid = $v->bbMid($i);
        $rsi = $v->rsi14($i); $adx = $v->adx14($i); $atr = $v->atr14($i);
        if ($lower === null || $upper === null || $mid === null || $rsi === null || $adx === null || $atr === null) return hold();

        if (($ctx['position']['direction'] ?? null) === 'LONG' && $v->close($i) >= $mid) {
            return ['action' => 'CLOSE', 'reason' => 'price reverted to the Bollinger mid band', 'confidence' => 0.7];
        }
        if (($ctx['position']['direction'] ?? null) === 'SHORT' && $v->close($i) <= $mid) {
            return ['action' => 'CLOSE', 'reason' => 'price reverted to the Bollinger mid band', 'confidence' => 0.7];
        }
        if ($adx > $p['adxMax']) return hold(); // do not fade strong trends

        if ($v->close($i) < $lower && $rsi < $p['rsiLow']) {
            $stop = $v->close($i) - $p['stopAtr'] * $atr;
            return [
                'action' => 'BUY',
                'reason' => sprintf('close below lower band with RSI %s < %s in a range (ADX %s)', number_format($rsi, 1), $p['rsiLow'], number_format($adx, 1)),
                'confidence' => MathUtils::clamp(($p['rsiLow'] - $rsi) / 15 + 0.5, 0.2, 0.9),
                'stopLoss' => $stop,
                'takeProfit' => $mid,
            ];
        }
        if ($v->close($i) > $upper && $rsi > $p['rsiHigh']) {
            $stop = $v->close($i) + $p['stopAtr'] * $atr;
            return [
                'action' => 'SELL',
                'reason' => sprintf('close above upper band with RSI %s > %s in a range (ADX %s)', number_format($rsi, 1), $p['rsiHigh'], number_format($adx, 1)),
                'confidence' => MathUtils::clamp(($rsi - $p['rsiHigh']) / 15 + 0.5, 0.2, 0.9),
                'stopLoss' => $stop,
                'takeProfit' => $mid,
            ];
        }
        return hold();
    }
}

class BreakoutStrategy implements TradingStrategy
{
    public function __construct(private readonly array $p = [
        'lookback' => 48, 'volMult' => 1.5, 'stopAtr' => 1.5, 'targetR' => 2.5,
    ]) {}

    public function id(): string { return 'breakout'; }
    public function version(): string { return '1.0.0'; }
    public function name(): string { return 'Breakout (range break + volume expansion)'; }
    public function description(): string { return 'Long when close breaks the N-bar high with volume >= multiple of average; stop at ATR multiple, target at R multiple.'; }
    public function marketClasses(): array { return ['forex', 'crypto', 'stock', 'etf', 'commodity', 'futures', 'indices']; }
    public function timeframes(): array { return ['5m', '15m', '1h', '4h', '1d']; }
    public function params(): array { return $this->p; }
    public function paramGrid(): array { return ['lookback' => [24, 48, 72], 'volMult' => [1.2, 1.5, 2.0], 'stopAtr' => [1.5], 'targetR' => [2, 2.5]]; }
    public function supportsShorts(): bool { return true; }

    public function evaluate(array $ctx): array
    {
        $p = $this->p;
        $v = $ctx['view'];
        $i = $v->index;
        $lookback = (int)round($p['lookback']);
        if ($i < max($lookback, 20) + 2) return hold();

        $atr = $v->atr14($i);
        if ($atr === null) return hold();
        $rangeHigh = $v->highestHigh($lookback, $i);
        $rangeLow = $v->lowestLow($lookback, $i);
        $avgVol = $v->averageVolume(30, $i - 1);
        $volOk = $avgVol > 0 ? $v->volume($i) >= $p['volMult'] * $avgVol : true;
        if ($ctx['position']) return hold();

        if ($v->close($i) > $rangeHigh && $volOk) {
            $stop = $v->close($i) - $p['stopAtr'] * $atr;
            return [
                'action' => 'BUY',
                'reason' => sprintf('close %s broke the %d-bar high %s with %sx volume', number_format($v->close($i), 5), $lookback, number_format($rangeHigh, 5), number_format($v->volume($i) / max($avgVol, 1e-9), 1)),
                'confidence' => MathUtils::clamp(0.5 + min(0.4, ($v->volume($i) / max($avgVol, 1e-9) - 1) / 4), 0.3, 0.95),
                'stopLoss' => $stop,
                'takeProfit' => $v->close($i) + $p['targetR'] * ($v->close($i) - $stop),
            ];
        }
        if ($v->close($i) < $rangeLow && $volOk) {
            $stop = $v->close($i) + $p['stopAtr'] * $atr;
            return [
                'action' => 'SELL',
                'reason' => sprintf('close %s broke the %d-bar low %s with %sx volume', number_format($v->close($i), 5), $lookback, number_format($rangeLow, 5), number_format($v->volume($i) / max($avgVol, 1e-9), 1)),
                'confidence' => MathUtils::clamp(0.5 + min(0.4, ($v->volume($i) / max($avgVol, 1e-9) - 1) / 4), 0.3, 0.95),
                'stopLoss' => $stop,
                'takeProfit' => $v->close($i) - $p['targetR'] * ($stop - $v->close($i)),
            ];
        }
        return hold();
    }
}

class MomentumStrategy implements TradingStrategy
{
    public function __construct(private readonly array $p = [
        'rocPeriod' => 20, 'rocMinPct' => 1.5, 'stopAtr' => 2, 'targetR' => 3,
    ]) {}

    public function id(): string { return 'momentum'; }
    public function version(): string { return '1.0.0'; }
    public function name(): string { return 'Momentum (ROC + MACD)'; }
    public function description(): string { return 'Long when N-bar rate of change exceeds a threshold with a positive and rising MACD histogram; exit when the histogram flips.'; }
    public function marketClasses(): array { return ['forex', 'crypto', 'stock', 'etf', 'commodity', 'futures', 'indices']; }
    public function timeframes(): array { return ['5m', '15m', '1h', '4h', '1d']; }
    public function params(): array { return $this->p; }
    public function paramGrid(): array { return ['rocPeriod' => [10, 20], 'rocMinPct' => [1.0, 1.5], 'stopAtr' => [2], 'targetR' => [2, 3]]; }
    public function supportsShorts(): bool { return true; }

    public function evaluate(array $ctx): array
    {
        $p = $this->p;
        $v = $ctx['view'];
        $i = $v->index;
        $rocPeriod = (int)round($p['rocPeriod']);
        if ($i < max($rocPeriod, 52) + 2) return hold();

        $hist = $v->macdHistogram($i);
        $histPrev = $v->macdHistogram($i - 1);
        $atr = $v->atr14($i);
        if ($hist === null || $histPrev === null || $atr === null) return hold();

        $past = $v->close($i - $rocPeriod);
        $roc = $past > 0 ? (($v->close($i) - $past) / $past) * 100 : 0.0;

        if (($ctx['position']['direction'] ?? null) === 'LONG' && $hist < 0) {
            return ['action' => 'CLOSE', 'reason' => 'MACD histogram turned negative — momentum faded', 'confidence' => 0.6];
        }
        if (($ctx['position']['direction'] ?? null) === 'SHORT' && $hist > 0) {
            return ['action' => 'CLOSE', 'reason' => 'MACD histogram turned positive — momentum faded', 'confidence' => 0.6];
        }
        if (!$ctx['position'] && $roc > $p['rocMinPct'] && $hist > 0 && $hist > $histPrev) {
            $stop = $v->close($i) - $p['stopAtr'] * $atr;
            return [
                'action' => 'BUY',
                'reason' => sprintf('ROC%d %s%% > %s%% with rising positive MACD histogram', $rocPeriod, number_format($roc, 2), $p['rocMinPct']),
                'confidence' => MathUtils::clamp(0.4 + min(0.5, $roc / ($p['rocMinPct'] * 6)), 0.3, 0.95),
                'stopLoss' => $stop,
                'takeProfit' => $v->close($i) + $p['targetR'] * ($v->close($i) - $stop),
            ];
        }
        if (!$ctx['position'] && $roc < -$p['rocMinPct'] && $hist < 0 && $hist < $histPrev) {
            $stop = $v->close($i) + $p['stopAtr'] * $atr;
            return [
                'action' => 'SELL',
                'reason' => sprintf('ROC%d %s%% < -%s%% with falling negative MACD histogram', $rocPeriod, number_format($roc, 2), $p['rocMinPct']),
                'confidence' => MathUtils::clamp(0.4 + min(0.5, -$roc / ($p['rocMinPct'] * 6)), 0.3, 0.95),
                'stopLoss' => $stop,
                'takeProfit' => $v->close($i) - $p['targetR'] * ($stop - $v->close($i)),
            ];
        }
        return hold();
    }
}


/** Parameter-aware factory for the builtin strategies (used by the optimizer). */
function builtinStrategyFactory(string $id): ?callable
{
    $classes = [
        'trend-following' => TrendFollowingStrategy::class,
        'mean-reversion' => MeanReversionStrategy::class,
        'breakout' => BreakoutStrategy::class,
        'momentum' => MomentumStrategy::class,
    ];
    if (!isset($classes[$id])) return null;
    $class = $classes[$id];
    return static fn(array $params): TradingStrategy => new $class($params);
}

/**
 * A registered variant of an existing strategy under a NEW version with new
 * params. Delegates evaluation to the inner implementation; the variant is
 * stored with source 'ai' so the lifecycle gates require human sign-off
 * before paper/live stages (existing rule, unchanged).
 */
class VersionedStrategyDecorator implements TradingStrategy
{
    public function __construct(
        private readonly TradingStrategy $inner,
        private readonly string $version,
        private readonly array $params,
    ) {}

    public function id(): string { return $this->inner->id(); }
    public function version(): string { return $this->version; }
    public function name(): string { return $this->inner->name() . " (optimized {$this->version})"; }
    public function description(): string { return $this->inner->description(); }
    public function marketClasses(): array { return $this->inner->marketClasses(); }
    public function timeframes(): array { return $this->inner->timeframes(); }
    public function params(): array { return $this->params; }
    public function paramGrid(): array { return $this->inner->paramGrid(); }
    public function supportsShorts(): bool { return $this->inner->supportsShorts(); }
    public function evaluate(array $ctx): array { return $this->inner->evaluate($ctx); }
}
