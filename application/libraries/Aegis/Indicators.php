<?php
namespace Aegis;

/**
 * Technical-analysis engine — ported 1:1 from the tested TypeScript edition.
 * Pure functions; null entries where the indicator is not yet warmed up.
 */
class Indicators
{
    public static function sma(array $values, int $period): array
    {
        $out = [];
        $sum = 0.0;
        $n = count($values);
        for ($i = 0; $i < $n; $i++) {
            $sum += $values[$i];
            if ($i >= $period) {
                $sum -= $values[$i - $period];
            }
            $out[] = $i >= $period - 1 ? $sum / $period : null;
        }
        return $out;
    }

    public static function ema(array $values, int $period): array
    {
        if ($period <= 0) {
            return array_fill(0, count($values), null);
        }
        $k = 2 / ($period + 1);
        $out = [];
        $prev = null;
        $seed = 0.0;
        $n = count($values);
        for ($i = 0; $i < $n; $i++) {
            if ($i < $period - 1) {
                $seed += $values[$i];
                $out[] = null;
                continue;
            }
            if ($prev === null) {
                $seed += $values[$i];
                $prev = $seed / $period;
            } else {
                $prev = $values[$i] * $k + $prev * (1 - $k);
            }
            $out[] = $prev;
        }
        return $out;
    }

    public static function wilder(array $values, int $period): array
    {
        $out = [];
        $prev = null;
        $seed = 0.0;
        $n = count($values);
        for ($i = 0; $i < $n; $i++) {
            if ($i < $period - 1) {
                $seed += $values[$i];
                $out[] = null;
                continue;
            }
            if ($prev === null) {
                $seed += $values[$i];
                $prev = $seed / $period;
            } else {
                $prev = ($prev * ($period - 1) + $values[$i]) / $period;
            }
            $out[] = $prev;
        }
        return $out;
    }

    public static function rsi(array $closes, int $period = 14): array
    {
        $n = count($closes);
        $gains = [0.0];
        $losses = [0.0];
        for ($i = 1; $i < $n; $i++) {
            $d = $closes[$i] - $closes[$i - 1];
            $gains[] = max(0.0, $d);
            $losses[] = max(0.0, -$d);
        }
        $avgGain = self::wilder(array_slice($gains, 1), $period);
        $avgLoss = self::wilder(array_slice($losses, 1), $period);
        $out = [null];
        for ($i = 1; $i < $n; $i++) {
            $g = $avgGain[$i - 1] ?? null;
            $l = $avgLoss[$i - 1] ?? null;
            if ($g === null || $l === null) {
                $out[] = null;
                continue;
            }
            if ($l == 0.0) {
                $out[] = $g == 0.0 ? 50.0 : 100.0;
                continue;
            }
            $out[] = 100 - 100 / (1 + $g / $l);
        }
        return $out;
    }

    public static function macd(array $closes, int $fast = 12, int $slow = 26, int $signalPeriod = 9): array
    {
        $emaFast = self::ema($closes, $fast);
        $emaSlow = self::ema($closes, $slow);
        $n = count($closes);
        $macdLine = [];
        for ($i = 0; $i < $n; $i++) {
            $macdLine[] = ($emaFast[$i] !== null && $emaSlow[$i] !== null) ? $emaFast[$i] - $emaSlow[$i] : null;
        }
        $firstIdx = -1;
        foreach ($macdLine as $i => $v) {
            if ($v !== null) { $firstIdx = $i; break; }
        }
        $signal = array_fill(0, $n, null);
        if ($firstIdx >= 0) {
            $defined = array_map(fn($v) => $v === null ? 0.0 : $v, array_slice($macdLine, $firstIdx));
            $sigRaw = self::ema($defined, $signalPeriod);
            foreach ($sigRaw as $i => $v) {
                $signal[$firstIdx + $i] = $v;
            }
        }
        $hist = [];
        for ($i = 0; $i < $n; $i++) {
            $hist[] = ($macdLine[$i] !== null && $signal[$i] !== null) ? $macdLine[$i] - $signal[$i] : null;
        }
        return ['macd' => $macdLine, 'signal' => $signal, 'histogram' => $hist];
    }

    public static function bollinger(array $closes, int $period = 20, float $mult = 2.0): array
    {
        $mid = self::sma($closes, $period);
        $upper = [];
        $lower = [];
        $n = count($closes);
        for ($i = 0; $i < $n; $i++) {
            if ($mid[$i] === null) {
                $upper[] = null;
                $lower[] = null;
                continue;
            }
            $sd = MathUtils::stdev(array_slice($closes, $i - $period + 1, $period));
            $upper[] = $sd === null ? null : $mid[$i] + $mult * $sd;
            $lower[] = $sd === null ? null : $mid[$i] - $mult * $sd;
        }
        return ['upper' => $upper, 'mid' => $mid, 'lower' => $lower];
    }

    public static function stochastic(array $candles, int $kPeriod = 14, int $dPeriod = 3): array
    {
        $k = [];
        $n = count($candles);
        for ($i = 0; $i < $n; $i++) {
            if ($i < $kPeriod - 1) {
                $k[] = null;
                continue;
            }
            $hh = -INF;
            $ll = INF;
            for ($j = $i - $kPeriod + 1; $j <= $i; $j++) {
                $hh = max($hh, $candles[$j]['high']);
                $ll = min($ll, $candles[$j]['low']);
            }
            $k[] = $hh == $ll ? 50.0 : (100 * ($candles[$i]['close'] - $ll)) / ($hh - $ll);
        }
        $kDefined = array_map(fn($v) => $v === null ? 0.0 : $v, $k);
        $dRaw = self::sma($kDefined, $dPeriod);
        $d = [];
        foreach ($k as $i => $v) {
            $d[] = $v === null ? null : $dRaw[$i];
        }
        return ['k' => $k, 'd' => $d];
    }

    public static function trueRange(array $candles): array
    {
        $out = [];
        $n = count($candles);
        for ($i = 0; $i < $n; $i++) {
            if ($i === 0) {
                $out[] = $candles[0]['high'] - $candles[0]['low'];
                continue;
            }
            $pc = $candles[$i - 1]['close'];
            $out[] = max(
                $candles[$i]['high'] - $candles[$i]['low'],
                abs($candles[$i]['high'] - $pc),
                abs($candles[$i]['low'] - $pc),
            );
        }
        return $out;
    }

    public static function atr(array $candles, int $period = 14): array
    {
        return self::wilder(self::trueRange($candles), $period);
    }

    public static function adx(array $candles, int $period = 14): array
    {
        $n = count($candles);
        $plusDM = [0.0];
        $minusDM = [0.0];
        for ($i = 1; $i < $n; $i++) {
            $up = $candles[$i]['high'] - $candles[$i - 1]['high'];
            $down = $candles[$i - 1]['low'] - $candles[$i]['low'];
            $plusDM[] = ($up > $down && $up > 0) ? $up : 0.0;
            $minusDM[] = ($down > $up && $down > 0) ? $down : 0.0;
        }
        $tr = self::wilder(self::trueRange($candles), $period);
        $smPlus = self::wilder($plusDM, $period);
        $smMinus = self::wilder($minusDM, $period);

        $plusDi = [];
        $minusDi = [];
        $dx = [];
        for ($i = 0; $i < $n; $i++) {
            if ($tr[$i] === null || $smPlus[$i] === null || $smMinus[$i] === null || $tr[$i] == 0.0) {
                $plusDi[] = null;
                $minusDi[] = null;
                $dx[] = null;
                continue;
            }
            $p = 100 * $smPlus[$i] / $tr[$i];
            $m = 100 * $smMinus[$i] / $tr[$i];
            $plusDi[] = $p;
            $minusDi[] = $m;
            $dx[] = ($p + $m) == 0.0 ? 0.0 : 100 * abs($p - $m) / ($p + $m);
        }
        $firstIdx = -1;
        foreach ($dx as $i => $v) {
            if ($v !== null) { $firstIdx = $i; break; }
        }
        $adx = array_fill(0, $n, null);
        if ($firstIdx >= 0) {
            $dxDefined = array_map(fn($v) => $v === null ? 0.0 : $v, array_slice($dx, $firstIdx));
            $adxRaw = self::wilder($dxDefined, $period);
            foreach ($adxRaw as $i => $v) {
                $adx[$firstIdx + $i] = $v;
            }
        }
        return ['adx' => $adx, 'plusDi' => $plusDi, 'minusDi' => $minusDi];
    }

    public static function vwap(array $candles): array
    {
        $cumPV = 0.0;
        $cumV = 0.0;
        $out = [];
        foreach ($candles as $c) {
            if ($c['volume'] <= 0) {
                $out[] = null;
                continue;
            }
            $tp = ($c['high'] + $c['low'] + $c['close']) / 3;
            $cumPV += $tp * $c['volume'];
            $cumV += $c['volume'];
            $out[] = $cumV == 0.0 ? null : $cumPV / $cumV;
        }
        return $out;
    }

    public static function volumeProfile(array $candles, int $bins = 24): array
    {
        $priced = array_values(array_filter($candles, fn($c) => $c['volume'] > 0));
        if (count($priced) === 0) {
            return ['poc' => null, 'valueAreaHigh' => null, 'valueAreaLow' => null];
        }
        $lo = min(array_map(fn($c) => $c['low'], $priced));
        $hi = max(array_map(fn($c) => $c['high'], $priced));
        if (!($hi > $lo)) {
            return ['poc' => $lo, 'valueAreaHigh' => $hi, 'valueAreaLow' => $lo];
        }
        $width = ($hi - $lo) / $bins;
        $binVolumes = array_fill(0, $bins, 0.0);
        foreach ($priced as $c) {
            $tp = ($c['high'] + $c['low'] + $c['close']) / 3;
            $idx = (int)floor(($tp - $lo) / $width);
            $binVolumes[max(0, min($bins - 1, $idx))] += $c['volume'];
        }
        $total = array_sum($binVolumes);
        $pocIdx = 0;
        for ($i = 1; $i < $bins; $i++) {
            if ($binVolumes[$i] > $binVolumes[$pocIdx]) {
                $pocIdx = $i;
            }
        }
        $lowIdx = $pocIdx;
        $highIdx = $pocIdx;
        $acc = $binVolumes[$pocIdx];
        while ($acc < $total * 0.7 && ($lowIdx > 0 || $highIdx < $bins - 1)) {
            $below = $lowIdx > 0 ? $binVolumes[$lowIdx - 1] : -1.0;
            $above = $highIdx < $bins - 1 ? $binVolumes[$highIdx + 1] : -1.0;
            if ($above >= $below) {
                $highIdx++;
                $acc += max($above, 0.0);
            } else {
                $lowIdx--;
                $acc += max($below, 0.0);
            }
        }
        return [
            'poc' => $lo + ($pocIdx + 0.5) * $width,
            'valueAreaHigh' => $lo + ($highIdx + 1) * $width,
            'valueAreaLow' => $lo + $lowIdx * $width,
        ];
    }

    public static function findSwings(array $candles, int $k = 2): array
    {
        $swings = [];
        $n = count($candles);
        for ($i = $k; $i < $n - $k; $i++) {
            $isHigh = true;
            $isLow = true;
            for ($j = $i - $k; $j <= $i + $k; $j++) {
                if ($j === $i) {
                    continue;
                }
                if ($candles[$j]['high'] >= $candles[$i]['high']) $isHigh = false;
                if ($candles[$j]['low'] <= $candles[$i]['low']) $isLow = false;
            }
            if ($isHigh) {
                $swings[] = ['index' => $i, 'timestamp' => $candles[$i]['timestamp'], 'price' => $candles[$i]['high'], 'type' => 'high'];
            }
            if ($isLow) {
                $swings[] = ['index' => $i, 'timestamp' => $candles[$i]['timestamp'], 'price' => $candles[$i]['low'], 'type' => 'low'];
            }
        }
        return $swings;
    }

    public static function supportResistance(array $candles, ?float $atrValue, float $currentPrice, int $maxLevels = 4): array
    {
        $swings = self::findSwings($candles, 2);
        if (count($swings) === 0) {
            return ['support' => [], 'resistance' => []];
        }
        $tolerance = ($atrValue !== null && $atrValue > 0) ? $atrValue * 0.5 : $currentPrice * 0.002;
        $levels = [];
        foreach ($swings as $s) {
            $merged = false;
            foreach ($levels as &$l) {
                if (abs($l['price'] - $s['price']) <= $tolerance) {
                    $l['price'] = ($l['price'] * $l['touches'] + $s['price']) / ($l['touches'] + 1);
                    $l['touches']++;
                    $merged = true;
                    break;
                }
            }
            unset($l);
            if (!$merged) {
                $levels[] = ['price' => $s['price'], 'touches' => 1];
            }
        }
        usort($levels, fn($a, $b) => $b['touches'] <=> $a['touches']);
        $chosen = array_slice($levels, 0, $maxLevels * 2);
        usort($chosen, fn($a, $b) => $a['price'] <=> $b['price']);
        $support = [];
        $resistance = [];
        foreach ($chosen as $l) {
            if ($l['price'] < $currentPrice) $support[] = $l['price'];
            else $resistance[] = $l['price'];
        }
        return [
            'support' => array_slice($support, -$maxLevels),
            'resistance' => array_slice($resistance, 0, $maxLevels),
        ];
    }

    public static function pivotPoints(?array $prev): array
    {
        $null = ['p' => null, 'r1' => null, 'r2' => null, 'r3' => null, 's1' => null, 's2' => null, 's3' => null];
        if ($prev === null) {
            return $null;
        }
        $h = $prev['high']; $l = $prev['low']; $c = $prev['close'];
        $p = ($h + $l + $c) / 3;
        return [
            'p' => $p,
            'r1' => 2 * $p - $l, 's1' => 2 * $p - $h,
            'r2' => $p + ($h - $l), 's2' => $p - ($h - $l),
            'r3' => $h + 2 * ($p - $l), 's3' => $l - 2 * ($h - $p),
        ];
    }

    public static function regressionSlopePct(array $closes, int $period = 50): ?float
    {
        $n = count($closes);
        if ($n < $period) {
            return null;
        }
        $ys = array_slice($closes, -$period);
        $m = count($ys);
        $sumX = 0.0; $sumY = 0.0; $sumXY = 0.0; $sumXX = 0.0;
        for ($i = 0; $i < $m; $i++) {
            $sumX += $i;
            $sumY += $ys[$i];
            $sumXY += $i * $ys[$i];
            $sumXX += $i * $i;
        }
        $denom = $m * $sumXX - $sumX * $sumX;
        if ($denom == 0.0) {
            return null;
        }
        $slope = ($m * $sumXY - $sumX * $sumY) / $denom;
        $mid = MathUtils::mean($ys) ?? 1.0;
        return ($slope / $mid) * 100;
    }

    public static function last(array $arr): ?float
    {
        for ($i = count($arr) - 1; $i >= 0; $i--) {
            if ($arr[$i] !== null && is_finite($arr[$i])) {
                return $arr[$i];
            }
        }
        return null;
    }
}
