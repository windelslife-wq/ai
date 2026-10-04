<?php
namespace Aegis\Backtest;

use Aegis\Timeframes;

/**
 * Pure performance metrics over trades + equity curve (spec §13),
 * unit-tested against hand-computed fixtures.
 */
class Metrics
{
    public static function compute(array $trades, array $equityCurve, float $initialEquity, string $timeframe, int $barsInMarket): array
    {
        $wins = array_values(array_filter($trades, fn($t) => $t['netPnl'] > 0));
        $losses = array_values(array_filter($trades, fn($t) => $t['netPnl'] <= 0));
        $grossWin = array_sum(array_map(fn($t) => $t['netPnl'], $wins));
        $grossLoss = abs(array_sum(array_map(fn($t) => $t['netPnl'], $losses)));
        $finalEquity = count($equityCurve) ? end($equityCurve)['equity'] : $initialEquity;

        $perBarReturns = [];
        if (count($equityCurve) > 1) {
            for ($i = 1; $i < count($equityCurve); $i++) {
                $prev = $equityCurve[$i - 1]['equity'];
                $perBarReturns[] = $prev > 0 ? $equityCurve[$i]['equity'] / $prev - 1 : 0.0;
            }
        }
        $barsPerYear = (365 * 24 * 3600000) / Timeframes::ms($timeframe);
        $n = count($trades);

        return [
            'totalReturnPct' => round((($finalEquity - $initialEquity) / $initialEquity) * 100, 4),
            'finalEquity' => round($finalEquity, 2),
            'trades' => $n,
            'winRate' => $n ? round(count($wins) / $n, 4) : null,
            'lossRate' => $n ? round(count($losses) / $n, 4) : null,
            'profitFactor' => ($n === 0 || $grossLoss == 0.0) ? null : round($grossWin / $grossLoss, 4),
            'expectancyR' => $n ? round(array_sum(array_map(fn($t) => $t['rMultiple'], $trades)) / $n, 4) : null,
            'expectancyPnl' => $n ? round(($grossWin - $grossLoss) / $n, 2) : null,
            'avgWin' => count($wins) ? round($grossWin / count($wins), 2) : null,
            'avgLoss' => count($losses) ? round(-$grossLoss / count($losses), 2) : null,
            'avgTrade' => $n ? round(($grossWin - $grossLoss) / $n, 2) : null,
            'sharpe' => self::sharpe($perBarReturns, $barsPerYear),
            'sortino' => self::sortino($perBarReturns, $barsPerYear),
            'maxDrawdownPct' => round(self::maxDdPct($equityCurve), 4),
            'maxDrawdownAbs' => round(self::maxDdAbs($equityCurve), 2),
            'longestWinStreak' => self::streak($trades, fn($t) => $t['netPnl'] > 0),
            'longestLossStreak' => self::streak($trades, fn($t) => $t['netPnl'] <= 0),
            'exposurePct' => count($equityCurve) > 1 ? round($barsInMarket / (count($equityCurve) - 1) * 100, 2) : 0,
            'totalFees' => round(array_sum(array_map(fn($t) => $t['fees']['totalCost'], $trades)), 2),
            'totalSlippage' => round(array_sum(array_map(fn($t) => $t['fees']['slippageCost'], $trades)), 2),
        ];
    }

    public static function sharpe(array $r, float $barsPerYear): ?float
    {
        if (count($r) < 2) return null;
        $mean = array_sum($r) / count($r);
        $var = array_sum(array_map(fn($x) => ($x - $mean) ** 2, $r)) / count($r);
        $sd = sqrt($var);
        if ($sd == 0.0 || !is_finite($sd)) return null;
        return round(($mean / $sd) * sqrt($barsPerYear), 4);
    }

    public static function sortino(array $r, float $barsPerYear): ?float
    {
        if (count($r) < 2) return null;
        $mean = array_sum($r) / count($r);
        $downside = array_filter($r, fn($x) => $x < 0);
        if (count($downside) === 0) return $mean > 0 ? null : 0.0;
        $dd = sqrt(array_sum(array_map(fn($x) => $x * $x, $downside)) / count($r));
        if ($dd == 0.0) return null;
        return round(($mean / $dd) * sqrt($barsPerYear), 4);
    }

    public static function streak(array $trades, callable $predicate): int
    {
        $best = 0; $cur = 0;
        foreach ($trades as $t) {
            if ($predicate($t)) { $cur++; $best = max($best, $cur); }
            else { $cur = 0; }
        }
        return $best;
    }

    public static function maxDdAbs(array $curve): float
    {
        $peak = -INF; $dd = 0.0;
        foreach ($curve as $p) {
            $peak = max($peak, $p['equity']);
            $dd = max($dd, $peak - $p['equity']);
        }
        return $dd;
    }

    public static function maxDdPct(array $curve): float
    {
        $peak = -INF; $dd = 0.0;
        foreach ($curve as $p) {
            $peak = max($peak, $p['equity']);
            if ($peak > 0) $dd = max($dd, ($peak - $p['equity']) / $peak * 100);
        }
        return $dd;
    }
}
