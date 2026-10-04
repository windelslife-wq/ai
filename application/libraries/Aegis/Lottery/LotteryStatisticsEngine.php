<?php
namespace Aegis\Lottery;

/**
 * WINDELS Lottery Intelligence — Phases 9–14 (spec §8–§14): statistical
 * engine. Pure functions over stored draws — no I/O, fully testable.
 *
 * HONESTY CONTRACT (spec §8/§17/§41):
 *  - Every output carries DISCLAIMER: draws are independent random events.
 *  - "frequency", "gap" and "hot/cold" are HISTORICAL OBSERVATIONS, labeled
 *    as such. No output may be read as a prediction or a changed probability.
 *  - The engine deliberately has NO "due" concept: a long gap is reported as
 *    "absent for X draws" — never as "likely to appear next".
 */
final class LotteryStatisticsEngine
{
    public const DISCLAIMER = 'Lottery draws are independent random events. Historical frequency, gaps and patterns are statistical observations only — they do not change the probability of future draws and are not forecasts of future results.';

    /**
     * Per-number statistics for main numbers (spec §8/§10/§11).
     * Draws must be sorted ASC by draw date (oldest first).
     *
     * @param list<array{drawDate:string,main:list<int>,stars:list<int>}> $draws
     * @param int $window 0 = all history, else the last N draws for "recent" stats
     * @return array{disclaimer:string,totalDraws:int,window:int,numbers:array<int,array<string,mixed>>}
     */
    public function numberStats(array $draws, int $min, int $max, int $window = 0): array
    {
        return $this->fieldStats($draws, 'main', $min, $max, $window);
    }

    /** Per-number statistics for Lucky Stars (spec §9). */
    public function starStats(array $draws, int $min, int $max, int $window = 0): array
    {
        return $this->fieldStats($draws, 'stars', $min, $max, $window);
    }

    private function fieldStats(array $draws, string $field, int $min, int $max, int $window): array
    {
        $total = count($draws);
        $numbers = [];
        for ($n = $min; $n <= $max; $n++) {
            $appearances = 0;
            $recent = 0;
            $lastSeen = null;
            $gaps = [];
            for ($i = 0; $i < $total; $i++) {
                if (!in_array($n, $draws[$i][$field], true)) continue;
                $appearances++;
                if ($lastSeen !== null) $gaps[] = $i - $lastSeen;
                $lastSeen = $i;
                if ($window > 0 && ($total - $i) <= $window) $recent++;
            }
            $drawsSinceLast = $lastSeen === null ? null : ($total - 1 - $lastSeen);
            $windowSize = $window > 0 ? min($window, $total) : $total;
            $numbers[$n] = [
                'number' => $n,
                'appearances' => $appearances,
                'appearancePct' => $total > 0 ? round($appearances / $total * 100, 2) : 0.0,
                'lastAppearance' => $lastSeen !== null ? $draws[$lastSeen]['drawDate'] : null,
                'drawsSinceLast' => $drawsSinceLast,
                'currentGap' => $drawsSinceLast,
                'avgGap' => $gaps !== [] ? round(array_sum($gaps) / count($gaps), 2) : null,
                'minGap' => $gaps !== [] ? min($gaps) : null,
                'maxGap' => $gaps !== [] ? max($gaps) : null,
                'recentAppearances' => $recent,
                'recentPct' => $windowSize > 0 ? round($recent / $windowSize * 100, 2) : 0.0,
                // trend = recent share minus overall share; an OBSERVATION label, not a forecast
                'trend' => $window > 0 ? round($recent / max(1, $windowSize) * 100 - ($total > 0 ? $appearances / $total * 100 : 0), 2) : 0.0,
            ];
        }
        return [
            'field' => $field,
            'disclaimer' => self::DISCLAIMER,
            'totalDraws' => $total,
            'window' => $window > 0 ? min($window, $total) : $total,
            'numbers' => $numbers,
        ];
    }

    /**
     * Hot / cold by selected analysis window (spec §10). HOT/COLD are
     * HISTORICAL FREQUENCY labels for the window — explicitly not forecasts.
     * @return array{disclaimer:string,window:int,hot:array<int,int>,cold:array<int,int>,observation:string}
     */
    public function hotCold(array $draws, string $field, int $min, int $max, int $window = 50, int $top = 5): array
    {
        $total = count($draws);
        $window = $total === 0 ? 0 : min(max(1, $window), $total);
        $counts = [];
        for ($n = $min; $n <= $max; $n++) $counts[$n] = 0;
        for ($i = $total - $window; $i < $total; $i++) {
            foreach ($draws[$i][$field] as $x) {
                if (isset($counts[$x])) $counts[$x]++;
            }
        }
        $byCountDesc = $counts;
        arsort($byCountDesc);
        $byCountAsc = $counts;
        asort($byCountAsc);
        return [
            'field' => $field,
            'disclaimer' => self::DISCLAIMER,
            'window' => $window,
            'hot' => array_slice($byCountDesc, 0, $top, true),
            'cold' => array_slice($byCountAsc, 0, $top, true),
            'observation' => 'Historical frequency within the last ' . $window . ' draw(s) only. This does NOT predict future draws — every number keeps its exact probability each draw.',
        ];
    }

    /**
     * Distribution analysis over all draws (spec §12): odd/even, low/high,
     * sum, spread, consecutive numbers.
     * @return array{disclaimer:string,totalDraws:int,oddEven:array<string,int>,oddEvenPct:array<string,float>,lowHigh:array<string,int>,sum:array<string,float>,spread:array<string,float>,consecutive:array<string,mixed>}
     */
    public function distribution(array $draws, int $min, int $max, int $mainCount): array
    {
        $total = count($draws);
        $oddEven = [];
        $lowHigh = [];
        $sums = [];
        $spreads = [];
        $consecDraws = 0;
        $longestRun = 0;
        $runLengths = [];
        $mid = (int) floor(($min + $max) / 2);

        for ($i = 0; $i < $total; $i++) {
            $mains = $draws[$i]['main'];
            $odds = 0;
            $lows = 0;
            $sum = 0;
            foreach ($mains as $x) {
                if ($x % 2 === 1) $odds++;
                if ($x <= $mid) $lows++;
                $sum += $x;
            }
            $even = count($mains) - $odds;
            $key = $odds . ' odd / ' . $even . ' even';
            $oddEven[$key] = ($oddEven[$key] ?? 0) + 1;
            $lkey = $lows . ' low / ' . (count($mains) - $lows) . ' high';
            $lowHigh[$lkey] = ($lowHigh[$lkey] ?? 0) + 1;
            $sums[] = $sum;
            $spreads[] = max($mains) - min($mains);

            $sorted = $mains;
            sort($sorted);
            $run = 1;
            $drawHasRun = false;
            for ($j = 1; $j < count($sorted); $j++) {
                if ($sorted[$j] === $sorted[$j - 1] + 1) {
                    $run++;
                    $drawHasRun = true;
                } else {
                    $run = 1;
                }
                if ($run > $longestRun) $longestRun = $run;
            }
            if ($drawHasRun) {
                $consecDraws++;
                // longest run in THIS draw
                $r = 1; $best = 1;
                for ($j = 1; $j < count($sorted); $j++) {
                    $r = $sorted[$j] === $sorted[$j - 1] + 1 ? $r + 1 : 1;
                    if ($r > $best) $best = $r;
                }
                $runLengths[$best] = ($runLengths[$best] ?? 0) + 1;
            }
        }
        $sumsArr = $sums;
        $spreadsArr = $spreads;
        sort($sumsArr);
        sort($spreadsArr);
        ksort($runLengths);

        return [
            'disclaimer' => self::DISCLAIMER,
            'totalDraws' => $total,
            'oddEven' => $oddEven,
            'oddEvenPct' => $this->pct($oddEven, $total),
            'lowHigh' => $lowHigh,
            'lowHighPct' => $this->pct($lowHigh, $total),
            'lowBound' => $mid,
            'sum' => [
                'min' => $sumsArr !== [] ? min($sumsArr) : null,
                'max' => $sumsArr !== [] ? max($sumsArr) : null,
                'avg' => $total > 0 ? round(array_sum($sums) / $total, 2) : null,
                'median' => $sumsArr !== [] ? $this->median($sumsArr) : null,
            ],
            'spread' => [
                'min' => $spreadsArr !== [] ? min($spreadsArr) : null,
                'max' => $spreadsArr !== [] ? max($spreadsArr) : null,
                'avg' => $total > 0 ? round(array_sum($spreads) / $total, 2) : null,
            ],
            'consecutive' => [
                'drawsWithConsecutive' => $consecDraws,
                'pct' => $total > 0 ? round($consecDraws / $total * 100, 2) : 0.0,
                'longestRun' => $longestRun,
                'runLengthDistribution' => $runLengths,
            ],
        ];
    }

    /**
     * Pair / triplet / group co-occurrence (spec §14).
     * @return array{disclaimer:string,totalDraws:int,k:int,groups:array<string,array<string,mixed>>,top:array<int,array<string,mixed>>}
     */
    public function groupStats(array $draws, string $field, int $min, int $max, int $k = 2, int $topN = 20): array
    {
        $total = count($draws);
        $k = min(5, max(2, $k));
        $groups = []; // key "a-b-c" (sorted) => ['count'=>, 'lastDraw'=>, 'gaps'=>[]]
        for ($i = 0; $i < $total; $i++) {
            $nums = $draws[$i][$field];
            foreach ($this->combinations($nums, $k) as $combo) {
                sort($combo);
                $key = implode('-', $combo);
                if (!isset($groups[$key])) $groups[$key] = ['count' => 0, 'lastDraw' => null, 'gaps' => [], 'lastIndex' => null];
                $groups[$key]['count']++;
                if ($groups[$key]['lastIndex'] !== null) $groups[$key]['gaps'][] = $i - $groups[$key]['lastIndex'];
                $groups[$key]['lastIndex'] = $i;
                $groups[$key]['lastDraw'] = $draws[$i]['drawDate'];
            }
        }
        $out = [];
        foreach ($groups as $key => $g) {
            $out[$key] = [
                'members' => array_map('intval', explode('-', $key)),
                'count' => $g['count'],
                'lastSeen' => $g['lastDraw'],
                'avgGap' => $g['gaps'] !== [] ? round(array_sum($g['gaps']) / count($g['gaps']), 2) : null,
                'maxGap' => $g['gaps'] !== [] ? max($g['gaps']) : null,
            ];
        }
        uasort($out, fn($a, $b) => $b['count'] <=> $a['count'] ?: $a['members'][0] <=> $b['members'][0]);
        return [
            'field' => $field,
            'disclaimer' => self::DISCLAIMER,
            'totalDraws' => $total,
            'k' => $k,
            'groups' => $out,
            'top' => array_slice($out, 0, $topN, true),
        ];
    }

    /** All k-combinations of a list (k<=5, small n — exhaustive). */
    private function combinations(array $values, int $k): array
    {
        return $this->combinationsRecursive(array_values($values), $k);
    }

    private function combinationsRecursive(array $values, int $k, int $start = 0, array $acc = []): array
    {
        if (count($acc) === $k) return [$acc];
        $out = [];
        $n = count($values);
        for ($i = $start; $i <= $n - ($k - count($acc)); $i++) {
            foreach ($this->combinationsRecursive($values, $k, $i + 1, array_merge($acc, [$values[$i]])) as $c) {
                $out[] = $c;
            }
        }
        return $out;
    }

    private function pct(array $counts, int $total): array
    {
        $out = [];
        foreach ($counts as $k => $v) $out[$k] = $total > 0 ? round($v / $total * 100, 2) : 0.0;
        return $out;
    }

    private function median(array $sorted): float|int
    {
        $n = count($sorted);
        if ($n === 0) return null;
        return $n % 2 === 1 ? $sorted[($n - 1) / 2] : ($sorted[$n / 2 - 1] + $sorted[$n / 2]) / 2;
    }
}
