<?php
namespace Aegis;

use Aegis\Agents\TechnicalAgent;
use Aegis\Indicators;

/**
 * Regime detection + trade setup generation + scenarios.
 */
class Analysis
{
    public static function detectRegime(array $series): array
    {
        $candles = $series['candles'];
        $closes = array_map(fn($c) => $c['close'], $candles);
        $evidence = [];

        if (count($candles) < 60) {
            return ['regime' => 'UNKNOWN', 'confidence' => 0.2, 'evidence' => ['insufficient candles (<60) for regime classification'], 'volatilityPct' => null, 'adx' => null];
        }

        $adxRes = Indicators::adx($candles, 14);
        $adx14 = Indicators::last($adxRes['adx']);
        $plusDi = Indicators::last($adxRes['plusDi']);
        $minusDi = Indicators::last($adxRes['minusDi']);
        $atr14 = Indicators::last(Indicators::atr($candles, 14));
        $price = end($closes);
        $atrPct = $atr14 !== null ? ($atr14 / $price) * 100 : null;

        // Volatility percentile over the series' own history.
        $atrHist = [];
        for ($i = 60, $n = count($candles); $i < $n; $i++) {
            $a = Indicators::last(array_slice(Indicators::atr(array_slice($candles, 0, $i + 1), 14), -1));
            if ($a !== null) $atrHist[] = $a / $closes[$i] * 100;
        }
        $volPctile = null;
        if ($atrPct !== null && count($atrHist) > 20) {
            $below = count(array_filter($atrHist, fn($v) => $v <= $atrPct));
            $volPctile = $below / count($atrHist);
        }

        $ema20 = Indicators::last(Indicators::ema($closes, 20));
        $ema50 = Indicators::last(Indicators::ema($closes, 50));
        $bb = Indicators::bollinger($closes, 20, 2);
        $bbUpper = Indicators::last($bb['upper']);
        $bbLower = Indicators::last($bb['lower']);
        $bbMid = Indicators::last($bb['mid']);
        $bandwidthPct = ($bbUpper !== null && $bbLower !== null && $bbMid) ? (($bbUpper - $bbLower) / $bbMid) * 100 : null;

        // Breakout vs 48-bar range excluding the last 2 bars, with volume expansion.
        $lookback = array_slice($candles, -50, -2);
        if (count($lookback) < 40) $lookback = array_slice($candles, 0, max(1, count($candles) - 2));
        $rangeHigh = max(array_map(fn($c) => $c['high'], $lookback));
        $rangeLow = min(array_map(fn($c) => $c['low'], $lookback));
        $volAvg = array_sum(array_map(fn($c) => $c['volume'], $lookback)) / max(1, count($lookback));
        $lastCandle = end($candles);
        $volumeExpansion = $volAvg > 0 ? $lastCandle['volume'] / $volAvg : null;
        $isBreakUp = $price > $rangeHigh && ($volumeExpansion === null || $volumeExpansion > 1.2);
        $isBreakDown = $price < $rangeLow && ($volumeExpansion === null || $volumeExpansion > 1.2);

        // DI-separation guard keeps degenerate series (+DI ~ -DI ~ 0) from
        // saturating DX and faking a trend.
        $diSep = ($plusDi !== null && $minusDi !== null) ? abs($plusDi - $minusDi) : null;
        $trendUp = $adx14 !== null && $adx14 >= 25 && $ema20 !== null && $ema50 !== null && $ema20 > $ema50
            && $diSep !== null && $diSep >= 3 && $plusDi > $minusDi;
        $trendDown = $adx14 !== null && $adx14 >= 25 && $ema20 !== null && $ema50 !== null && $ema20 < $ema50
            && $diSep !== null && $diSep >= 3 && $minusDi > $plusDi;

        $regime = 'UNKNOWN';
        $confidence = 0.4;

        if ($isBreakUp || $isBreakDown) {
            $regime = 'BREAKOUT';
            $confidence = 0.7;
            $evidence[] = 'close beyond ' . ($isBreakUp ? '48-bar high' : '48-bar low') . ' (' . number_format($isBreakUp ? $rangeHigh : $rangeLow, 5) . ')';
            if ($volumeExpansion !== null) $evidence[] = sprintf('volume %sx average on the break', number_format($volumeExpansion, 1));
        } elseif ($trendUp || $trendDown) {
            $regime = $trendUp ? 'TRENDING_UP' : 'TRENDING_DOWN';
            $confidence = min(0.9, 0.5 + $adx14 / 100);
            $evidence[] = sprintf('ADX %s with %s', number_format($adx14, 1), $trendUp ? '+DI above -DI and EMA20 > EMA50' : '-DI above +DI and EMA20 < EMA50');
            if ($volPctile !== null && $volPctile >= 0.85) $evidence[] = 'note: ATR% is elevated (' . round($volPctile * 100) . 'th percentile) despite the trend';
        } elseif ($volPctile !== null && $volPctile >= 0.9) {
            $regime = 'HIGH_VOLATILITY';
            $confidence = 0.6;
            $evidence[] = 'ATR% at the ' . round($volPctile * 100) . 'th percentile of its own history with no directional trend';
        } elseif ($volPctile !== null && $volPctile <= 0.1) {
            $regime = 'LOW_VOLATILITY';
            $confidence = 0.55;
            $evidence[] = 'ATR% at the ' . round($volPctile * 100) . 'th percentile of its own history';
        }

        if ($regime === 'UNKNOWN' && $adx14 !== null && $adx14 < 20) {
            $regime = 'RANGING';
            $confidence = 0.5;
            $evidence[] = sprintf('ADX %s below 20 — no directional trend', number_format($adx14, 1));
            if ($bandwidthPct !== null) $evidence[] = sprintf('Bollinger bandwidth %s%%', number_format($bandwidthPct, 2));
        }
        if ($regime === 'UNKNOWN') {
            $evidence[] = 'mixed evidence — trend, volatility and breakout tests disagree';
        }

        return [
            'regime' => $regime,
            'confidence' => round($confidence, 2),
            'evidence' => $evidence,
            'volatilityPct' => $atrPct !== null ? round($atrPct, 3) : null,
            'adx' => $adx14 !== null ? round($adx14, 1) : null,
        ];
    }

    public static function regimeDirectionality(string $regime): float
    {
        return match ($regime) {
            'TRENDING_UP', 'TRENDING_DOWN' => 1.0,
            'BREAKOUT' => 0.8,
            'LOW_VOLATILITY' => 0.5,
            'RANGING' => 0.4,
            'HIGH_VOLATILITY' => 0.3,
            default => 0.2,
        };
    }

    public static function generateSetup(array $series, array $technical, array $structure, string $bias, float $confidence): ?array
    {
        if (!in_array($bias, ['BULLISH', 'BEARISH'], true) || $confidence < 0.55) {
            return null;
        }
        $candles = $series['candles'];
        $price = end($candles)['close'];
        $atr14 = Indicators::last(Indicators::atr($candles, 14)) ?? $price * 0.005;
        $action = $bias === 'BULLISH' ? 'BUY' : 'SELL';
        $supports = $technical['structure']['support'];
        $resistances = $technical['structure']['resistance'];

        if ($action === 'BUY') {
            $nearestSupport = count($supports) ? end($supports) : $price - 0.5 * $atr14;
            $entryMax = $price + 0.1 * $atr14;
            $entryMin = max($nearestSupport, $price - 0.75 * $atr14);
            if ($entryMax - $entryMin < 0.2 * $atr14) $entryMin = $entryMax - 0.3 * $atr14;
        } else {
            $nearestResistance = count($resistances) ? $resistances[0] : $price + 0.5 * $atr14;
            $entryMin = $price - 0.1 * $atr14;
            $entryMax = min($nearestResistance, $price + 0.75 * $atr14);
            if ($entryMax - $entryMin < 0.2 * $atr14) $entryMax = $entryMin + 0.3 * $atr14;
        }
        $entryRef = ($entryMin + $entryMax) / 2;

        $invalidation = [];
        if ($action === 'BUY') {
            $below = count($supports) ? min($supports) : $entryMin - $atr14;
            $stop = min($entryMin - 0.4 * $atr14, $below - 0.2 * $atr14);
            if ($entryRef - $stop > 2 * $atr14) $stop = $entryRef - 2 * $atr14;
            $invalidation[] = 'close below the structural support invalidates the long thesis';
            if (!empty($structure['events']['changeOfCharacter']['detected']) && $structure['events']['changeOfCharacter']['direction'] === 'SELL') {
                $invalidation[] = 'bearish change of character would flip the structure';
            }
        } else {
            $above = count($resistances) ? max($resistances) : $entryMax + $atr14;
            $stop = max($entryMax + 0.4 * $atr14, $above + 0.2 * $atr14);
            if ($stop - $entryRef > 2 * $atr14) $stop = $entryRef + 2 * $atr14;
            $invalidation[] = 'close above the structural resistance invalidates the short thesis';
            if (!empty($structure['events']['changeOfCharacter']['detected']) && $structure['events']['changeOfCharacter']['direction'] === 'BUY') {
                $invalidation[] = 'bullish change of character would flip the structure';
            }
        }
        $stopDistance = abs($entryRef - $stop);
        if ($stopDistance <= 0) return null;

        $targets = [];
        foreach ([1.5, 2.5, 3.5] as $rm) {
            $targets[] = $action === 'BUY' ? $entryRef + $rm * $stopDistance : $entryRef - $rm * $stopDistance;
        }
        $levels = $action === 'BUY' ? $resistances : array_reverse($supports);
        $snapped = [];
        foreach ($targets as $t) {
            $use = $t;
            foreach ($levels as $lvl) {
                if (abs($lvl - $t) < 0.35 * $stopDistance) { $use = $lvl; break; }
            }
            $snapped[] = $use;
        }
        for ($i = 1; $i < 3; $i++) {
            $gap = 0.5 * $stopDistance;
            if ($action === 'BUY' && $snapped[$i] <= $snapped[$i - 1] + $gap) $snapped[$i] = $snapped[$i - 1] + $gap;
            if ($action === 'SELL' && $snapped[$i] >= $snapped[$i - 1] - $gap) $snapped[$i] = $snapped[$i - 1] - $gap;
        }
        $riskReward = abs($snapped[0] - $entryRef) / $stopDistance;

        $digits = $price >= 100 ? 2 : ($price >= 10 ? 3 : ($price >= 1 ? 5 : 6));
        $r = fn($v) => round($v, $digits + 1);

        return [
            'action' => $action,
            'symbol' => $series['symbol'],
            'marketClass' => $series['marketClass'],
            'timeframe' => $series['timeframe'],
            'entry' => ['type' => 'ZONE', 'min' => $r(min($entryMin, $entryMax)), 'max' => $r(max($entryMin, $entryMax)), 'reference' => $r($entryRef)],
            'stopLoss' => $r($stop),
            'takeProfit' => array_map($r, $snapped),
            'riskReward' => round($riskReward, 2),
            'confidence' => round($confidence, 2),
            'expiration' => gmdate('c', (int)(microtime(true) + 24 * Timeframes::ms($series['timeframe']) / 1000)),
            'invalidationReasons' => $invalidation,
            'rationale' => [
                sprintf('%s aligned with %s confluence at %s confidence', $action, strtolower($bias), number_format($confidence, 2)),
                sprintf('entry zone anchored to %s structure, stop padded by 0.4 ATR', $action === 'BUY' ? 'support' : 'resistance'),
                sprintf('targets ladder at 1.5R/2.5R/3.5R snapped to %s levels', $action === 'BUY' ? 'resistance' : 'support'),
                'setup expires after 24 bars (' . $series['timeframe'] . ')',
            ],
        ];
    }

    public static function buildScenarios(array $series, array $technical, string $bias, float $price): array
    {
        $support = $technical['structure']['support'];
        $resistance = $technical['structure']['resistance'];
        $nearestRes = count($resistance) ? $resistance[0] : $price * 1.01;
        $nearestSup = count($support) ? end($support) : $price * 0.99;
        $f = fn($v) => number_format($v, 5);
        return [
            'bullish' => [
                'summary' => 'Bulls take control — break and hold above nearby resistance',
                'triggers' => ["close above {$f($nearestRes)}", 'MACD histogram expanding positive'],
                'targets' => array_slice($resistance, 0, 3) ?: [$price * 1.02],
                'invalidation' => "close below {$f($nearestSup)}",
                'probabilityHint' => $bias === 'BULLISH' ? 'primary' : 'alternate',
            ],
            'bearish' => [
                'summary' => 'Bears press the break — lose support and extend lower',
                'triggers' => ["close below {$f($nearestSup)}", 'MACD histogram expanding negative'],
                'targets' => array_reverse(array_slice($support, 0, 3)) ?: [$price * 0.98],
                'invalidation' => "close above {$f($nearestRes)}",
                'probabilityHint' => $bias === 'BEARISH' ? 'primary' : 'alternate',
            ],
            'neutral' => [
                'summary' => 'Rotation continues between support and resistance',
                'triggers' => ['volume contraction inside the range', 'no confirmed break of structure'],
                'targets' => [$nearestRes, $nearestSup],
                'invalidation' => "decisive close beyond {$f($nearestSup)} or {$f($nearestRes)}",
                'probabilityHint' => ($bias === 'NEUTRAL' || $bias === 'NO_TRADE') ? 'base' : 'alternate',
            ],
        ];
    }
}
