<?php
namespace Aegis\Agents;

use Aegis\Indicators;
use Aegis\MathUtils;

/**
 * Technical Analysis Agent — pure quant. Computes the indicator suite,
 * emits individual signals plus a weighted aggregate vote in [-1, 1].
 */
class TechnicalAgent
{
    public const ID = 'technical';

    public function applicable(array $ctx): bool { return true; }

    public function analyze(array $ctx): array
    {
        $candles = $ctx['series']['candles'] ?? [];
        if (!is_array($candles) || count($candles) < 20) {
            throw new \RuntimeException('insufficient candles for technical analysis');
        }
        $closes = array_map(fn($c) => $c['close'], $candles);
        $n = count($candles);
        $last = $candles[$n - 1];
        $price = $last['close'];

        $sma20 = Indicators::last(Indicators::sma($closes, 20));
        $sma50 = Indicators::last(Indicators::sma($closes, 50));
        $sma200 = Indicators::last(Indicators::sma($closes, 200));
        $ema20 = Indicators::last(Indicators::ema($closes, 20));
        $ema50 = Indicators::last(Indicators::ema($closes, 50));
        $rsi14 = Indicators::last(Indicators::rsi($closes, 14));
        $macd = Indicators::macd($closes);
        $macdLast = Indicators::last($macd['macd']);
        $macdSignal = Indicators::last($macd['signal']);
        $macdHist = Indicators::last($macd['histogram']);
        $bb = Indicators::bollinger($closes, 20, 2);
        $bbUpper = Indicators::last($bb['upper']);
        $bbMid = Indicators::last($bb['mid']);
        $bbLower = Indicators::last($bb['lower']);
        $atr14 = Indicators::last(Indicators::atr($candles, 14));
        $atrPct = $atr14 !== null ? ($atr14 / $price) * 100 : null;
        $adxRes = Indicators::adx($candles, 14);
        $adx14 = Indicators::last($adxRes['adx']);
        $plusDi = Indicators::last($adxRes['plusDi']);
        $minusDi = Indicators::last($adxRes['minusDi']);
        $vwapLast = Indicators::last(Indicators::vwap($candles));
        $stoch = Indicators::stochastic($candles, 14, 3);
        $stochK = Indicators::last($stoch['k']);
        $stochD = Indicators::last($stoch['d']);
        $slopePct = Indicators::regressionSlopePct($closes, 50);
        $sr = Indicators::supportResistance($candles, $atr14, $price);
        $pivots = Indicators::pivotPoints($candles[$n - 2] ?? null);
        $vp = Indicators::volumeProfile($candles, 24);

        $signals = [];
        $push = function (string $name, $value, string $signal, string $detail) use (&$signals) {
            $signals[] = ['name' => $name, 'value' => $value, 'signal' => $signal, 'detail' => $detail];
        };
        $f5 = fn($v) => number_format((float)$v, 5, '.', '');

        if ($ema20 !== null && $ema50 !== null) {
            $push('EMA20 vs EMA50', null, $ema20 > $ema50 ? 'BUY' : 'SELL',
                "EMA20 {$f5($ema20)} " . ($ema20 > $ema50 ? '>' : '<') . " EMA50 {$f5($ema50)}");
        }
        if ($sma50 !== null) {
            $push('Price vs SMA50', null, $price > $sma50 ? 'BUY' : 'SELL', "close {$f5($price)} vs SMA50 {$f5($sma50)}");
        }
        if ($slopePct !== null) {
            $push('Trend slope (50-bar regression)', round($slopePct, 4), $slopePct > 0.01 ? 'BUY' : ($slopePct < -0.01 ? 'SELL' : 'NEUTRAL'), sprintf('%s%%/bar', number_format($slopePct, 3)));
        }
        if ($rsi14 !== null) {
            $sig = $rsi14 > 60 ? 'BUY' : ($rsi14 < 40 ? 'SELL' : 'NEUTRAL');
            $detail = $rsi14 > 70 ? 'overbought — treat longs with caution' : ($rsi14 < 30 ? 'oversold — treat shorts with caution' : 'mid-range');
            $push('RSI(14)', round($rsi14, 2), $sig, $detail);
        }
        if ($macdHist !== null && $macdLast !== null && $macdSignal !== null) {
            $push('MACD(12,26,9) histogram', round($macdHist, 8), $macdHist > 0 ? 'BUY' : 'SELL',
                "macd {$f5($macdLast)} vs signal {$f5($macdSignal)}");
        }
        if ($stochK !== null && $stochD !== null) {
            $sig = $stochK > 80 ? ($stochK < $stochD ? 'SELL' : 'NEUTRAL')
                : ($stochK < 20 ? ($stochK > $stochD ? 'BUY' : 'NEUTRAL')
                : ($stochK > $stochD ? 'BUY' : 'SELL'));
            $push('Stochastic(14,3)', round($stochK, 1), $sig, "%K " . number_format($stochK, 1) . ' / %D ' . number_format($stochD, 1));
        }
        if ($bbUpper !== null && $bbLower !== null && $bbMid !== null) {
            $width = $bbUpper - $bbLower;
            $pos = $width > 0 ? ($price - $bbLower) / $width : 0.5;
            $push('Bollinger position', round($pos, 3), $pos > 0.95 ? 'SELL' : ($pos < 0.05 ? 'BUY' : 'NEUTRAL'),
                'price at ' . round($pos * 100) . '% of band');
        }
        if ($vwapLast !== null) {
            $push('VWAP', round($vwapLast, 6), $price > $vwapLast ? 'BUY' : 'SELL', "close {$f5($price)} vs VWAP {$f5($vwapLast)}");
        }
        if ($adx14 !== null && $plusDi !== null && $minusDi !== null) {
            $trending = $adx14 >= 25;
            $sig = !$trending ? 'NEUTRAL' : ($plusDi > $minusDi ? 'BUY' : 'SELL');
            $push('ADX(14) / DI', round($adx14, 2), $sig,
                sprintf('ADX %s (%s), +DI %s / -DI %s', number_format($adx14, 1), $trending ? 'trending' : 'weak trend',
                    number_format($plusDi, 1), number_format($minusDi, 1)));
        }

        $weights = [
            'EMA20 vs EMA50' => 1.2, 'Price vs SMA50' => 1.0, 'Trend slope (50-bar regression)' => 1.0,
            'RSI(14)' => 0.8, 'MACD(12,26,9) histogram' => 1.0, 'Stochastic(14,3)' => 0.6,
            'Bollinger position' => 0.4, 'VWAP' => 0.6, 'ADX(14) / DI' => 0.8,
        ];
        $acc = 0.0; $wsum = 0.0;
        foreach ($signals as $s) {
            $w = $weights[$s['name']] ?? 0.5;
            $acc += ($s['signal'] === 'BUY' ? 1 : ($s['signal'] === 'SELL' ? -1 : 0)) * $w;
            $wsum += $w;
        }
        $aggregate = $wsum == 0.0 ? 0.0 : $acc / $wsum;

        $trendStrength = $adx14 !== null ? MathUtils::clamp($adx14 / 50, 0, 1) : 0.3;
        $trend = ($ema20 !== null && $ema50 !== null && $trendStrength > 0.4)
            ? ($ema20 > $ema50 ? 'up' : 'down') : 'sideways';

        $buys = count(array_filter($signals, fn($s) => $s['signal'] === 'BUY'));
        $sells = count(array_filter($signals, fn($s) => $s['signal'] === 'SELL'));

        return [
            'agent' => 'technical',
            'title' => 'Technical Analysis Agent',
            'generatedAt' => $ctx['now'],
            'dataQuality' => self::dataQuality($ctx['series']),
            'dataLimitations' => $n < 200 ? ['Fewer than 200 candles — SMA200 not available'] : [],
            'warnings' => ($rsi14 !== null && ($rsi14 > 70 || $rsi14 < 30))
                ? [sprintf('RSI %s is %s — counter-trend entries penalized', number_format($rsi14, 1), $rsi14 > 70 ? 'overbought' : 'oversold')]
                : [],
            'vote' => $this->vote($aggregate, 1.0, "{$buys} bullish / {$sells} bearish of " . count($signals) . ' indicators'),
            'indicators' => [
                'sma20' => $sma20, 'sma50' => $sma50, 'sma200' => $sma200, 'ema20' => $ema20, 'ema50' => $ema50,
                'rsi14' => $rsi14 !== null ? round($rsi14, 2) : null,
                'macd' => ['macd' => $macdLast, 'signal' => $macdSignal, 'histogram' => $macdHist],
                'macdBias' => $macdHist !== null ? ($macdHist > 0 ? 'BUY' : 'SELL') : 'NEUTRAL',
                'bollinger' => [
                    'upper' => $bbUpper, 'mid' => $bbMid, 'lower' => $bbLower,
                    'bandwidthPct' => ($bbUpper !== null && $bbLower !== null && $bbMid) ? round((($bbUpper - $bbLower) / $bbMid) * 100, 3) : null,
                ],
                'atr14' => $atr14, 'atrPct' => $atrPct !== null ? round($atrPct, 3) : null,
                'adx14' => ['adx' => $adx14 !== null ? round($adx14, 2) : null, 'plusDi' => $plusDi !== null ? round($plusDi, 2) : null, 'minusDi' => $minusDi !== null ? round($minusDi, 2) : null],
                'vwap' => $vwapLast,
                'stochastic' => ['k' => $stochK !== null ? round($stochK, 1) : null, 'd' => $stochD !== null ? round($stochD, 1) : null],
            ],
            'structure' => [
                'trend' => $trend,
                'trendStrength' => round($trendStrength, 3),
                'momentum' => $macdHist !== null ? ($macdHist > 0 ? 'BUY' : 'SELL') : 'NEUTRAL',
                'support' => array_map(fn($v) => round($v, 6), $sr['support']),
                'resistance' => array_map(fn($v) => round($v, 6), $sr['resistance']),
                'pivots' => $pivots,
                'volumeProfile' => $vp,
            ],
            'signals' => $signals,
            'aggregateScore' => round($aggregate, 4),
        ];
    }

    public static function dataQuality(array $series): float
    {
        $q = 1.0;
        $n = count($series['candles']);
        if ($n < 60) $q *= 0.5;
        elseif ($n < 120) $q *= 0.8;
        if (!empty($series['provenance']['synthetic'])) $q *= 0.6;
        if (!empty($series['provenance']['stale'])) $q *= 0.7;
        if ($series['validation']['gapCount'] > $n * 0.1) $q *= 0.8;
        return round($q, 3);
    }

    private function vote(float $score, float $weight, string $reason): array
    {
        $clamped = MathUtils::clamp($score, -1, 1);
        return [
            'directionalScore' => round($clamped, 4),
            'signal' => $clamped > 0.15 ? 'BUY' : ($clamped < -0.15 ? 'SELL' : 'NEUTRAL'),
            'weight' => $weight,
            'votes' => abs($clamped) > 0.15,
            'reason' => $reason,
        ];
    }
}
