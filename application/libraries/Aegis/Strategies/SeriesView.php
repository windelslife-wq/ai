<?php
namespace Aegis\Strategies;

use Aegis\Indicators;

/**
 * Thrown when a strategy reads a bar beyond the current evaluation point.
 * Look-ahead bias is a bug, not a warning — the backtester fails the run.
 */
class LookAheadError extends \RuntimeException
{
}

/**
 * Strictly causal window over a candle series with precomputed indicators
 * (identical to prefix computation — indicators depend on past bars only).
 * Every accessor enforces i <= current.
 */
class SeriesView
{
    public readonly int $index;
    public readonly string $symbol;
    public readonly string $timeframe;
    private array $ind;

    public function __construct(
        private readonly array $candles,
        array $indicators,
        int $current,
        array $meta,
    ) {
        $this->index = $current;
        $this->symbol = $meta['symbol'];
        $this->timeframe = $meta['timeframe'];
        $this->ind = $indicators;
    }

    private function check(int $i): void
    {
        if ($i > $this->index || $i < 0) {
            throw new LookAheadError("Look-ahead access denied: strategy requested bar {$i} but current bar is {$this->index}");
        }
    }

    public function barsVisible(): int { return $this->index + 1; }

    public function open(int $i = -1): float { $i = $i < 0 ? $this->index : $i; $this->check($i); return $this->candles[$i]['open']; }
    public function high(int $i = -1): float { $i = $i < 0 ? $this->index : $i; $this->check($i); return $this->candles[$i]['high']; }
    public function low(int $i = -1): float { $i = $i < 0 ? $this->index : $i; $this->check($i); return $this->candles[$i]['low']; }
    public function close(int $i = -1): float { $i = $i < 0 ? $this->index : $i; $this->check($i); return $this->candles[$i]['close']; }
    public function volume(int $i = -1): float { $i = $i < 0 ? $this->index : $i; $this->check($i); return $this->candles[$i]['volume']; }
    public function time(int $i = -1): int { $i = $i < 0 ? $this->index : $i; $this->check($i); return $this->candles[$i]['timestamp']; }

    public function highestHigh(int $n, int $before = -1): float
    {
        $before = $before < 0 ? $this->index : $before;
        $this->check($before);
        $hi = -INF;
        for ($i = max(0, $before - $n); $i < $before; $i++) $hi = max($hi, $this->candles[$i]['high']);
        return $hi;
    }

    public function lowestLow(int $n, int $before = -1): float
    {
        $before = $before < 0 ? $this->index : $before;
        $this->check($before);
        $lo = INF;
        for ($i = max(0, $before - $n); $i < $before; $i++) $lo = min($lo, $this->candles[$i]['low']);
        return $lo;
    }

    public function averageVolume(int $n, int $upTo = -1): float
    {
        $upTo = $upTo < 0 ? $this->index : $upTo;
        $this->check($upTo);
        $from = max(0, $upTo - $n + 1);
        $sum = 0.0;
        for ($i = $from; $i <= $upTo; $i++) $sum += $this->candles[$i]['volume'];
        return $sum / max(1, $upTo - $from + 1);
    }

    private function ind(string $key, int $i): ?float
    {
        $i = $i < 0 ? $this->index : $i;
        $this->check($i);
        $v = $this->ind[$key][$i] ?? null;
        return $v;
    }

    public function ema20(int $i = -1): ?float { return $this->ind('ema20', $i); }
    public function ema50(int $i = -1): ?float { return $this->ind('ema50', $i); }
    public function sma50(int $i = -1): ?float { return $this->ind('sma50', $i); }
    public function rsi14(int $i = -1): ?float { return $this->ind('rsi14', $i); }
    public function macdHistogram(int $i = -1): ?float { return $this->ind('macdHist', $i); }
    public function adx14(int $i = -1): ?float { return $this->ind('adx14', $i); }
    public function plusDi(int $i = -1): ?float { return $this->ind('plusDi', $i); }
    public function minusDi(int $i = -1): ?float { return $this->ind('minusDi', $i); }
    public function atr14(int $i = -1): ?float { return $this->ind('atr14', $i); }
    public function bbUpper(int $i = -1): ?float { return $this->ind('bbUpper', $i); }
    public function bbMid(int $i = -1): ?float { return $this->ind('bbMid', $i); }
    public function bbLower(int $i = -1): ?float { return $this->ind('bbLower', $i); }
    public function stochK(int $i = -1): ?float { return $this->ind('stochK', $i); }
    public function stochD(int $i = -1): ?float { return $this->ind('stochD', $i); }
    public function vwap(int $i = -1): ?float { return $this->ind('vwap', $i); }

    public static function precompute(array $candles): array
    {
        $closes = array_map(fn($c) => $c['close'], $candles);
        $macd = Indicators::macd($closes);
        $bb = Indicators::bollinger($closes, 20, 2);
        $adx = Indicators::adx($candles, 14);
        $stoch = Indicators::stochastic($candles, 14, 3);
        return [
            'ema20' => Indicators::ema($closes, 20),
            'ema50' => Indicators::ema($closes, 50),
            'sma50' => Indicators::sma($closes, 50),
            'rsi14' => Indicators::rsi($closes, 14),
            'macdHist' => $macd['histogram'],
            'adx14' => $adx['adx'],
            'plusDi' => $adx['plusDi'],
            'minusDi' => $adx['minusDi'],
            'atr14' => Indicators::atr($candles, 14),
            'bbUpper' => $bb['upper'],
            'bbMid' => $bb['mid'],
            'bbLower' => $bb['lower'],
            'stochK' => $stoch['k'],
            'stochD' => $stoch['d'],
            'vwap' => Indicators::vwap($candles),
        ];
    }
}
