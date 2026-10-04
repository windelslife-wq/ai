<?php
namespace Aegis\Journal;

/**
 * Journal analytics (spec §15): groupings by strategy/market/symbol and
 * AI-confidence buckets, plus the calibration verdict with an honest
 * sample-size guard.
 */
class Analytics
{
    public const BUCKETS = [
        ['key' => '0–40% (low)', 'min' => 0.0, 'max' => 0.4],
        ['key' => '40–60% (moderate)', 'min' => 0.4, 'max' => 0.6],
        ['key' => '60–80% (high)', 'min' => 0.6, 'max' => 0.8],
        ['key' => '80–100% (very high)', 'min' => 0.8, 'max' => 1.0001],
    ];

    public static function bucketMetrics(array $entries): array
    {
        $closed = array_values(array_filter($entries, fn($e) => $e['pnl'] !== null && $e['exit_time'] !== null));
        $wins = array_values(array_filter($closed, fn($e) => $e['pnl'] > 0));
        $losses = array_values(array_filter($closed, fn($e) => $e['pnl'] <= 0));
        $grossWin = array_sum(array_map(fn($e) => $e['pnl'], $wins));
        $grossLoss = abs(array_sum(array_map(fn($e) => $e['pnl'], $losses)));
        $rEntries = array_values(array_filter($closed, fn($e) => $e['r_multiple'] !== null));
        return [
            'count' => count($closed),
            'winRate' => count($closed) ? round(count($wins) / count($closed), 4) : null,
            'profitFactor' => (count($closed) === 0 || $grossLoss == 0.0) ? null : round($grossWin / $grossLoss, 4),
            'expectancyPnl' => count($closed) ? round(($grossWin - $grossLoss) / count($closed), 2) : null,
            'avgWin' => count($wins) ? round($grossWin / count($wins), 2) : null,
            'avgLoss' => count($losses) ? round(-$grossLoss / count($losses), 2) : null,
            'totalPnl' => round($grossWin - $grossLoss, 2),
            'avgRMultiple' => count($rEntries) ? round(array_sum(array_map(fn($e) => $e['r_multiple'], $rEntries)) / count($rEntries), 4) : null,
        ];
    }

    public static function analyze(array $entries, string $groupBy): array
    {
        $overall = self::bucketMetrics($entries);
        $closed = array_values(array_filter($entries, fn($e) => $e['pnl'] !== null && $e['exit_time'] !== null));

        $chrono = $closed;
        usort($chrono, fn($a, $b) => $a['execution_time'] <=> $b['execution_time']);
        $cum = 0.0; $peak = 0.0; $maxDd = 0.0;
        foreach ($chrono as $e) {
            $cum += $e['pnl'];
            $peak = max($peak, $cum);
            $maxDd = max($maxDd, $peak - $cum);
        }

        $groups = [];
        if ($groupBy === 'confidence') {
            $withConf = array_values(array_filter($closed, fn($e) => $e['ai_confidence'] !== null));
            foreach (self::BUCKETS as $b) {
                $in = array_values(array_filter($withConf, fn($e) => $e['ai_confidence'] >= $b['min'] && $e['ai_confidence'] < $b['max']));
                $m = self::bucketMetrics($in);
                if ($m['count'] > 0) $groups[] = ['key' => $b['key'], 'metrics' => $m];
            }
        } else {
            $keys = [];
            foreach ($closed as $e) $keys[(string)($e[$groupBy] ?? '—')] = true;
            $keys = array_keys($keys);
            sort($keys);
            foreach ($keys as $k) {
                $in = array_values(array_filter($closed, fn($e) => (string)($e[$groupBy] ?? '—') === $k));
                $m = self::bucketMetrics($in);
                if ($m['count'] > 0) $groups[] = ['key' => $k, 'metrics' => $m];
            }
        }

        $note = null;
        if ($groupBy === 'confidence') {
            $none = array_filter($closed, fn($e) => $e['ai_confidence'] === null);
            if (count($none) === count($closed)) {
                $note = 'No confidence-tagged trades yet — buckets populate once entries carry aiConfidence (strategy signals tag it already; paper trades tag both).';
            }
        }

        return [
            'groupBy' => $groupBy,
            'groups' => $groups,
            'overall' => $overall + [
                'closedTrades' => count($closed),
                'openOrPending' => count($entries) - count($closed),
                'maxDrawdownAbs' => round($maxDd, 2),
            ],
            'note' => $note,
        ];
    }

    public static function calibration(array $entries): array
    {
        $closed = array_values(array_filter($entries, fn($e) => $e['pnl'] !== null && $e['exit_time'] !== null && $e['ai_confidence'] !== null));
        $buckets = [];
        foreach (self::BUCKETS as $b) {
            $in = array_values(array_filter($closed, fn($e) => $e['ai_confidence'] >= $b['min'] && $e['ai_confidence'] < $b['max']));
            if (count($in) === 0) continue;
            $wins = count(array_filter($in, fn($e) => $e['pnl'] > 0));
            $rVals = array_values(array_filter($in, fn($e) => $e['r_multiple'] !== null));
            $buckets[] = [
                'key' => $b['key'], 'count' => count($in),
                'winRate' => round($wins / count($in), 4),
                'expectancyR' => count($rVals) ? round(array_sum(array_map(fn($e) => $e['r_multiple'], $rVals)) / count($rVals), 4) : null,
            ];
        }
        if (count($closed) < 30) {
            return [
                'buckets' => $buckets, 'sufficientData' => false,
                'verdict' => 'Sample too small for a calibration verdict (' . count($closed) . ' confidence-tagged closed trades; need 30+). Collect more journal entries.',
            ];
        }
        $rates = array_map(fn($b) => $b['winRate'], array_filter($buckets, fn($b) => $b['winRate'] !== null));
        $monotonic = true;
        for ($i = 1; $i < count($rates); $i++) {
            if ($rates[$i] < $rates[$i - 1] - 0.05) $monotonic = false;
        }
        return [
            'buckets' => $buckets,
            'sufficientData' => true,
            'verdict' => $monotonic
                ? 'Win rate broadly increases with confidence — the confidence signal is directionally informative. (Not a guarantee: verify across regimes and symbols.)'
                : 'Win rate does NOT consistently increase with confidence — treat the confidence signal with skepticism and re-examine before sizing up on it.',
        ];
    }
}
