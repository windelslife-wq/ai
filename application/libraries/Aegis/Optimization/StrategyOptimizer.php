<?php
namespace Aegis\Optimization;

use Aegis\Backtest\Backtester;
use Aegis\Backtest\Metrics;
use Aegis\Strategies\TradingStrategy;

/**
 * STRATEGY OPTIMIZER (Phase 6) — parameter grid search with walk-forward
 * verification. Deterministic and deliberately unglamorous:
 *
 *   1. Split the series: in-sample (first 70%) / out-of-sample (last 30%).
 *   2. Run every parameter combination on the IN-SAMPLE segment only.
 *   3. Rank by validation criteria; carry the top-K (+ the current params as
 *      baseline) to the OUT-OF-SAMPLE segment.
 *   4. Recommend adoption ONLY when the candidate survives out-of-sample
 *      (PF > 1, positive expectancy, enough trades) AND beats the baseline
 *      there. Otherwise: keep the current parameters.
 *
 * Anti-overfitting stance: out-of-sample degradation is reported explicitly,
 * in-sample-only results are never recommended, and the search space is the
 * strategy's small declared paramGrid() — no curve-fitting at scale.
 */
class StrategyOptimizer
{
    public const DEFAULTS = [
        'split' => 0.7,        // in-sample fraction
        'topK' => 3,           // candidates carried to out-of-sample
        'minTrades' => 8,      // in-sample validity
        'oosMinTrades' => 5,   // out-of-sample validity
        'maxCombinations' => 81,
        'minCandles' => 420,   // keeps both segments meaningful (>= 120 bars)
    ];

    /**
     * @param callable(array<string,mixed>): TradingStrategy $make params -> strategy instance
     * @param array $grid param => [values] (from TradingStrategy::paramGrid())
     * @param array $reqOverrides backtest request overrides (riskPct, feeBps, ...)
     * @return array{report: mixed, ...} the full optimization report
     */
    public static function optimize(callable $make, array $baselineParams, array $grid, array $candles, array $reqOverrides = []): array
    {
        $cfg = self::DEFAULTS;
        if (count($candles) < $cfg['minCandles']) {
            throw new \InvalidArgumentException(sprintf('optimization needs at least %d candles, got %d — load more history', $cfg['minCandles'], count($candles)));
        }
        $reqBase = array_merge(Backtester::DEFAULTS, $reqOverrides);
        $splitAt = (int) floor(count($candles) * $cfg['split']);
        $inSample = array_slice($candles, 0, $splitAt);
        $outSample = array_slice($candles, $splitAt);

        $combinations = self::cartesian($grid, $cfg['maxCombinations']);
        $results = [];
        foreach ($combinations as $params) {
            $r = self::runSegment($make($params), $inSample, $reqBase);
            if ($r === null) continue;
            $r['params'] = $params;
            $results[] = $r;
        }
        usort($results, fn($a, $b) => [$b['metrics']['expectancyR'] ?? -99, $b['metrics']['profitFactor'] ?? -99] <=> [$a['metrics']['expectancyR'] ?? -99, $a['metrics']['profitFactor'] ?? -99]);

        $baseline = self::runSegment($make($baselineParams), $inSample, $reqBase);
        $baselineOos = self::runSegment($make($baselineParams), $outSample, $reqBase);

        $carried = array_slice(array_values(array_filter($results, fn($r) => ($r['metrics']['trades'] ?? 0) >= $cfg['minTrades'])), 0, $cfg['topK']);
        $finalists = [];
        foreach ($carried as $candidate) {
            $oos = self::runSegment($make($candidate['params']), $outSample, $reqBase);
            $finalists[] = [
                'params' => $candidate['params'],
                'inSample' => $candidate['metrics'],
                'outOfSample' => $oos !== null ? $oos['metrics'] : null,
                'survives' => $oos !== null
                    && ($oos['metrics']['trades'] ?? 0) >= $cfg['oosMinTrades']
                    && ($oos['metrics']['profitFactor'] ?? 0) > 1.0
                    && ($oos['metrics']['expectancyR'] ?? 0) > 0,
            ];
        }

        $adopt = null;
        foreach ($finalists as $f) {
            if (!$f['survives']) continue;
            $baselineExp = $baselineOos['metrics']['expectancyR'] ?? -99;
            $candidateExp = $f['outOfSample']['expectancyR'] ?? -99;
            if ($candidateExp > max(0, $baselineExp) + 1e-9) { $adopt = $f; break; }
        }

        $overfitWarnings = [];
        foreach ($finalists as $f) {
            $is = $f['inSample']['profitFactor'] ?? null;
            $os = $f['outOfSample']['profitFactor'] ?? null;
            if ($is !== null && $os !== null && $is > 1 && $os <= 1) {
                $overfitWarnings[] = sprintf('params %s: in-sample PF %.2f collapsed to %.2f out-of-sample — classic overfit', self::shortParams($f['params']), $is, $os);
            }
        }
        if ($adopt === null && $finalists !== []) {
            $overfitWarnings[] = 'no candidate survived out-of-sample verification — keeping current parameters';
        }

        return [
            'ranAt' => gmdate('c'),
            'split' => ['inSampleBars' => count($inSample), 'outOfSampleBars' => count($outSample)],
            'searchSpace' => ['combinationsEvaluated' => count($results) + ($baseline !== null ? 0 : 0), 'gridSize' => count($combinations), 'grid' => $grid],
            'baseline' => [
                'params' => $baselineParams,
                'inSample' => $baseline !== null ? $baseline['metrics'] : null,
                'outOfSample' => $baselineOos !== null ? $baselineOos['metrics'] : null,
            ],
            'finalists' => $finalists,
            'recommendation' => [
                'adopt' => $adopt !== null,
                'params' => $adopt['params'] ?? null,
                'reason' => $adopt !== null
                    ? 'candidate survived out-of-sample verification and beat the baseline there'
                    : 'keep current parameters — no candidate beat the baseline out-of-sample',
            ],
            'overfitWarnings' => $overfitWarnings,
            'methodNote' => 'in-sample grid search on the first 70% of the series, out-of-sample verification on the last 30%; in-sample-only performance is never recommended',
        ];
    }

    /** @return array{trades: array, metrics: array}|null */
    private static function runSegment(TradingStrategy $strategy, array $candles, array $req): ?array
    {
        if (count($candles) < 120) return null;
        $result = Backtester::simulate($strategy, $candles, $req, ['symbol' => 'OPTIMIZER', 'timeframe' => '1h', 'marketClass' => 'optimizer']);
        $metrics = Metrics::compute($result['trades'], $result['equityCurve'], $req['initialEquity'], '1h', $result['barsInMarket']);
        return ['trades' => count($result['trades']), 'metrics' => $metrics];
    }

    /** @return array<int, array<string, mixed>> capped cartesian product */
    private static function cartesian(array $grid, int $cap): array
    {
        $combos = [[]];
        foreach ($grid as $key => $values) {
            if (!is_array($values) || $values === []) continue;
            $next = [];
            foreach ($combos as $combo) {
                foreach ($values as $v) $next[] = $combo + [$key => $v];
            }
            $combos = $next;
        }
        if (count($combos) > $cap) {
            // deterministic stride sample — grids are small by design, this is
            // just a hard safety valve against accidental blow-ups
            $stride = (int) ceil(count($combos) / $cap);
            $combos = array_values(array_intersect_key($combos, array_flip(range(0, count($combos) - 1, $stride))));
        }
        return $combos;
    }

    private static function shortParams(array $params): string
    {
        $parts = [];
        foreach ($params as $k => $v) $parts[] = "{$k}=" . (is_float($v) ? round($v, 2) : $v);
        return implode(',', $parts);
    }
}
