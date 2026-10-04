<?php
namespace Aegis\Lottery;

/**
 * WINDELS Lottery Intelligence — Phase 14 (spec §15/§16/§21/§26/§33):
 * AI combination generator.
 *
 * Modes:
 *  - RANDOM        uniform seeded sampling, no constraints
 *  - BALANCED      profile-filtered sampling against the historical
 *                  distribution (sum within ±1 historical std, odd/even and
 *                  low/high within ±1 of the most common historical split,
 *                  at most 1 adjacent pair)
 *  - HISTORICAL    frequency-weighted sampling (weight = 1 + appearances)
 *  - DIVERSIFIED   minimum-overlap greedy selection against context lines
 *                  (lines generated earlier in the same call, plus any
 *                  provided context lines)
 *  - ANTI-POPULAR  constrained sampling avoiding common human selection
 *                  patterns (birthday-heavy, sequences, visual patterns)
 *
 * LOCK / EXCLUDE (spec §21): every mode respects locked numbers (always
 * present) and excluded numbers (never present), validated up front.
 *
 * HONESTY CONTRACT (spec §15/§17/§41):
 *  - Every valid EuroMillions combination has the same mathematical chance
 *    of being drawn. No mode increases that chance. The report says so.
 *  - Scores are labelled STATISTICAL BALANCE SCORE — never a probability of
 *    a line being drawn.
 *  - The AI decision report (spec §26) records the ACTUAL inputs used
 *    (mode, seed, constraints, factors, model version, method) — never
 *    invented after the fact.
 *  - Reproducible: the same seed + inputs yield the same lines (seeded
 *    xorshift PRNG, see MathUtils::seededRandom).
 */
final class CombinationGenerator
{
    public const MODES = ['RANDOM', 'BALANCED', 'HISTORICAL', 'DIVERSIFIED', 'ANTI-POPULAR'];
    public const MAX_LINES = 100;

    public function __construct(
        private readonly LotteryRules $rules,
        private readonly CombinationAnalyzer $analyzer,
        private readonly LotteryStatisticsEngine $statistics = new LotteryStatisticsEngine(),
        private readonly string $modelVersion = LotteryIntelligence::MODEL_VERSION,
    ) {}

    /**
     * @param list<array{drawDate:string,main:list<int>,stars:list<int>}> $draws oldest first (historical context)
     * @param array{
     *   mode?:string, count?:int, seed?:int,
     *   locks?:array{mains?:int[],stars?:int[]}, excludes?:array{mains?:int[],stars?:int[]},
     *   contextLines?:list<array{mains:int[],stars:int[]}>
     * } $opts
     * @return array<string,mixed> AI combination report (spec §16) + decision report (spec §26)
     */
    public function generate(array $draws, array $opts = []): array
    {
        $mode = strtoupper((string) ($opts['mode'] ?? 'RANDOM'));
        if (!in_array($mode, self::MODES, true)) {
            throw new \InvalidArgumentException('unknown generation mode: ' . $mode . ' (expected ' . implode(', ', self::MODES) . ')');
        }
        $count = min(self::MAX_LINES, max(1, (int) ($opts['count'] ?? 1)));
        $seed = isset($opts['seed']) && $opts['seed'] !== null
            ? ((int) $opts['seed']) & 0x7FFFFFFF
            : ((int) (microtime(true) * 1000000)) % 2147483647;
        if ($seed === 0) $seed = 1;
        $rand = \Aegis\MathUtils::seededRandom($seed);
        $r = $this->rules;

        // ------------------------------------------------ locks / excludes
        $locksM = $this->normalizeField($opts['locks']['mains'] ?? [], $r->mainMin(), $r->mainMax(), 'locked main');
        $locksS = $this->normalizeField($opts['locks']['stars'] ?? [], $r->starMin(), $r->starMax(), 'locked star');
        $exclM = $this->normalizeField($opts['excludes']['mains'] ?? [], $r->mainMin(), $r->mainMax(), 'excluded main');
        $exclS = $this->normalizeField($opts['excludes']['stars'] ?? [], $r->starMin(), $r->starMax(), 'excluded star');
        if (count($locksM) > $r->mainCount()) throw new \InvalidArgumentException('cannot lock more than ' . $r->mainCount() . ' main numbers');
        if (count($locksS) > $r->starCount()) throw new \InvalidArgumentException('cannot lock more than ' . $r->starCount() . ' lucky stars');
        if (array_intersect($locksM, $exclM) !== []) throw new \InvalidArgumentException('a main number is both locked and excluded');
        if (array_intersect($locksS, $exclS) !== []) throw new \InvalidArgumentException('a lucky star is both locked and excluded');
        $poolM = array_values(array_diff(range($r->mainMin(), $r->mainMax()), $exclM));
        $poolS = array_values(array_diff(range($r->starMin(), $r->starMax()), $exclS));
        foreach ($locksM as $l) if (!in_array($l, $poolM, true)) throw new \InvalidArgumentException('locked main ' . $l . ' is outside the allowed pool');
        foreach ($locksS as $l) if (!in_array($l, $poolS, true)) throw new \InvalidArgumentException('locked star ' . $l . ' is outside the allowed pool');
        if (count($poolM) < $r->mainCount()) throw new \InvalidArgumentException('not enough main numbers remain after exclusions');
        if (count($poolS) < $r->starCount()) throw new \InvalidArgumentException('not enough lucky stars remain after exclusions');

        // ------------------------------------------------ historical data
        $context = array_values($opts['contextLines'] ?? []);
        $numberStats = null;
        $starStats = null;
        if ($mode === 'HISTORICAL') {
            $numberStats = $this->statistics->numberStats($draws, $r->mainMin(), $r->mainMax());
            $starStats = $this->statistics->starStats($draws, $r->starMin(), $r->starMax());
        }
        $targets = null;
        $balBasis = null;
        if ($mode === 'BALANCED' && count($draws) > 0) {
            $sums = array_map(fn($d) => array_sum($d['main']), $draws);
            $sumAvg = (float) \Aegis\MathUtils::mean($sums);
            $sumStd = \Aegis\MathUtils::stdev($sums) ?? 0.0;
            $lowBound = (int) floor(($r->mainMin() + $r->mainMax()) / 2);
            $oddCounts = [];
            $lowCounts = [];
            foreach ($draws as $d) {
                $odd = count(array_filter($d['main'], fn($x) => $x % 2 === 1));
                $oddCounts[$odd] = ($oddCounts[$odd] ?? 0) + 1;
                $lows = count(array_filter($d['main'], fn($x) => $x <= $lowBound));
                $lowCounts[$lows] = ($lowCounts[$lows] ?? 0) + 1;
            }
            $bestOdd = $this->bestMode($oddCounts, $r->mainCount() / 2);
            $bestLow = $this->bestMode($lowCounts, $r->mainCount() / 2);
            $targets = [
                'sumRange' => [round($sumAvg - $sumStd, 1), round($sumAvg + $sumStd, 1)],
                'oddRange' => [max(0, $bestOdd - 1), min($r->mainCount(), $bestOdd + 1)],
                'lowRange' => [max(0, $bestLow - 1), min($r->mainCount(), $bestLow + 1)],
                'maxAdjacentPairs' => 1,
                'lowBound' => $lowBound,
            ];
            $balBasis = [
                'drawsUsed' => count($draws),
                'sumAvg' => round($sumAvg, 2),
                'sumStd' => round($sumStd, 2),
                'mostCommonOddEven' => $bestOdd . ' odd / ' . ($r->mainCount() - $bestOdd) . ' even',
                'mostCommonLowHigh' => $bestLow . ' low / ' . ($r->mainCount() - $bestLow) . ' high',
            ];
        }

        // ------------------------------------------------ sample the lines
        $lines = [];
        for ($i = 0; $i < $count; $i++) {
            $kMax = match ($mode) {
                'RANDOM' => 1,
                'HISTORICAL' => 1,
                'DIVERSIFIED' => 24,
                'BALANCED' => 60,
                'ANTI-POPULAR' => 80,
            };
            $passing = [];
            $all = [];
            $k = 0;
            while ($k < $kMax && (count($passing) === 0 || $mode === 'DIVERSIFIED')) {
                $k++;
                $cm = $this->sampleField($rand, $poolM, $r->mainCount() - count($locksM), $locksM, $mode, $numberStats);
                $cs = $this->sampleField($rand, $poolS, $r->starCount() - count($locksS), $locksS, $mode, $starStats);
                sort($cm);
                sort($cs);
                $all[] = [$cm, $cs];
                if ($mode === 'BALANCED' && $targets !== null && !$this->balancedOk($cm, $targets)) continue;
                if ($mode === 'ANTI-POPULAR' && !$this->antiPopularOk($cm)) continue;
                $passing[] = [$cm, $cs];
                if ($mode === 'RANDOM' || $mode === 'HISTORICAL') break;
            }
            $pool = $passing !== [] ? $passing : $all;
            if ($pool === []) throw new \RuntimeException('generation produced no candidates');
            if ($mode === 'DIVERSIFIED') {
                usort($pool, function ($a, $b) use ($context) {
                    return $this->overlapPenalty($a[0], $a[1], $context) <=> $this->overlapPenalty($b[0], $b[1], $context);
                });
            }
            [$mains, $stars] = $pool[0];

            $check = $r->validateLine($mains, $stars);
            if (!$check['valid']) throw new \RuntimeException('generator produced an invalid line: ' . implode('; ', $check['errors']));
            $profile = $this->analyzer->analyze($mains, $stars, $draws);
            $lines[] = [
                'mains' => $mains,
                'stars' => $stars,
                'score' => $profile['balanceScore'],
                'scoreLabel' => $profile['scoreLabel'],
                'profile' => [
                    'sum' => $profile['composition']['sum']['value'],
                    'spread' => $profile['composition']['spread']['value'],
                    'oddEven' => $profile['composition']['oddEven']['label'],
                    'lowHigh' => $profile['composition']['lowHigh']['label'],
                    'adjacentPairs' => $profile['composition']['consecutives']['adjacentPairs'],
                ],
            ];
            $context[] = ['mains' => $mains, 'stars' => $stars]; // within-batch diversification context
        }

        // ------------------------------------------------ report (§16/§26)
        $lastDate = $draws !== [] ? (string) end($draws)['drawDate'] : null;
        $report = [
            'model' => 'WINDELS Lottery Model v' . $this->modelVersion,
            'lottery' => $r->code(),
            'mode' => $mode,
            'lineCount' => $count,
            'lines' => $lines,
            'averageBalanceScore' => $count > 0 ? round(array_sum(array_column($lines, 'score')) / $count, 1) : 0,
            'inputs' => [
                'seed' => $seed,
                'rulesVersion' => $r->version(),
                'drawsUsed' => count($draws),
                'lastDrawDate' => $lastDate,
                'datasetVersion' => 'n=' . count($draws) . ';last=' . ($lastDate ?? 'none'),
                'locks' => ['mains' => $locksM, 'stars' => $locksS],
                'excludes' => ['mains' => $exclM, 'stars' => $exclS],
                'contextLines' => count($opts['contextLines'] ?? []),
            ],
            'factors' => $this->factors($mode, $r, $targets, $balBasis, $numberStats, $starStats, count($opts['contextLines'] ?? [])),
            'generatedAt' => gmdate('c'),
            'disclaimer' => LotteryStatisticsEngine::DISCLAIMER,
            'honestyNote' => 'Every valid EuroMillions combination has exactly the same mathematical chance of being drawn. No generation mode increases that chance; the modes only shape the statistical profile, the diversity or the pattern avoidance of the selections.',
        ];
        return $report;
    }

    // ------------------------------------------------------------- factors

    /** The ACTUAL factors used by this generation (spec §26 — recorded, not invented). */
    private function factors(string $mode, LotteryRules $r, ?array $targets, ?array $balBasis, ?array $numberStats, ?array $starStats, int $contextCount): array
    {
        return match ($mode) {
            'RANDOM' => [
                'method' => 'uniform seeded sampling without replacement',
                'note' => 'No historical factors applied. A random baseline is intentionally always available (spec §25).',
            ],
            'BALANCED' => array_filter([
                'method' => 'profile-filtered sampling against the historical distribution',
                'targets' => $targets,
                'historicalBasis' => $balBasis,
                'note' => 'Targets describe the typical historical composition. Matching a typical composition does not improve the odds of any specific line.',
            ]),
            'HISTORICAL' => [
                'method' => 'frequency-weighted sampling (weight = 1 + historical appearances)',
                'topMainNumbers' => $this->topNumbers($numberStats),
                'topStars' => $this->topNumbers($starStats, 3),
                'note' => 'Historical frequency is used only as a sampling weight. It describes the past; it does not forecast future draws.',
            ],
            'DIVERSIFIED' => [
                'method' => 'minimum-overlap greedy selection (10 points per shared main, 20 per shared star)',
                'contextLines' => $contextCount,
                'note' => 'Diversification makes the lines more different from each other. It does not change the odds of any line.',
            ],
            'ANTI-POPULAR' => [
                'method' => 'constrained sampling avoiding common human selection patterns',
                'constraints' => [
                    'at least ' . ($r->mainCount() - 2) . ' of ' . $r->mainCount() . ' mains above the 1-31 birthday range',
                    'no ascending runs of 3 or more',
                    'at most 1 adjacent pair',
                    'not all mains share the same last digit',
                    'mains not confined to a single decade',
                ],
                'note' => 'Avoiding popular patterns may reduce the chance of sharing a prize if a line happens to win. It never changes the chance of winning.',
            ],
        };
    }

    private function topNumbers(?array $stats, int $n = 5): array
    {
        if ($stats === null || empty($stats['numbers'])) return [];
        $nums = $stats['numbers'];
        uasort($nums, fn($a, $b) => $b['appearances'] <=> $a['appearances'] ?: $a['number'] <=> $b['number']);
        $out = [];
        foreach (array_slice($nums, 0, $n, true) as $num => $s) {
            $out[] = ['number' => $num, 'appearances' => $s['appearances']];
        }
        return $out;
    }

    // ------------------------------------------------------------- sampling

    /** @return list<int> */
    private function sampleField(\Closure $rand, array $pool, int $need, array $locks, string $mode, ?array $stats): array
    {
        if ($need <= 0) return $locks;
        $remaining = array_values(array_diff($pool, $locks));
        if (count($remaining) < $need) throw new \RuntimeException('not enough numbers remain in the pool');
        if ($mode === 'HISTORICAL' && $stats !== null) {
            $weights = [];
            foreach ($remaining as $n) $weights[] = 1 + (int) ($stats['numbers'][$n]['appearances'] ?? 0);
            $picks = $this->weightedSample($rand, $remaining, $weights, $need);
        } else {
            $picks = $this->uniformSample($rand, $remaining, $need);
        }
        return array_values(array_unique(array_merge($locks, $picks)));
    }

    /** Uniform sample without replacement (seeded Fisher-Yates prefix). @return list<int> */
    private function uniformSample(\Closure $rand, array $pool, int $need): array
    {
        $pool = array_values($pool);
        $n = count($pool);
        for ($i = 0; $i < $need && $i < $n - 1; $i++) {
            $j = $i + (int) floor($rand() * ($n - $i));
            $tmp = $pool[$i]; $pool[$i] = $pool[$j]; $pool[$j] = $tmp;
        }
        return array_slice($pool, 0, $need);
    }

    /** Sequential weighted sampling without replacement. @return list<int> */
    private function weightedSample(\Closure $rand, array $pool, array $weights, int $need): array
    {
        $idx = range(0, count($pool) - 1);
        $picks = [];
        for ($k = 0; $k < $need; $k++) {
            $total = 0.0;
            foreach ($idx as $i) $total += $weights[$i];
            $x = $rand() * $total;
            $acc = 0.0;
            $chosen = end($idx);
            foreach ($idx as $i) {
                $acc += $weights[$i];
                if ($x < $acc) { $chosen = $i; break; }
            }
            $picks[] = $pool[$chosen];
            $idx = array_values(array_diff($idx, [$chosen]));
        }
        return $picks;
    }

    private function balancedOk(array $mains, array $targets): bool
    {
        $sum = array_sum($mains);
        if ($sum < $targets['sumRange'][0] || $sum > $targets['sumRange'][1]) return false;
        $odd = count(array_filter($mains, fn($x) => $x % 2 === 1));
        if ($odd < $targets['oddRange'][0] || $odd > $targets['oddRange'][1]) return false;
        $low = count(array_filter($mains, fn($x) => $x <= $targets['lowBound']));
        if ($low < $targets['lowRange'][0] || $low > $targets['lowRange'][1]) return false;
        return $this->adjacentPairs($mains) <= $targets['maxAdjacentPairs'];
    }

    private function antiPopularOk(array $mains): bool
    {
        sort($mains);
        $birthday = count(array_filter($mains, fn($x) => $x <= 31));
        if ($birthday > 2) return false; // at least 3 mains above the birthday range
        if ($this->adjacentPairs($mains) > 1) return false;
        $run = 1;
        for ($i = 1; $i < count($mains); $i++) {
            if ($mains[$i] === $mains[$i - 1] + 1) {
                $run++;
                if ($run >= 3) return false;
            } else {
                $run = 1;
            }
        }
        $digits = array_unique(array_map(fn($x) => $x % 10, $mains));
        if (count($digits) === 1) return false;
        if (max($mains) - min($mains) < 10) return false;
        return true;
    }

    /** DIVERSIFIED overlap penalty against context lines. */
    private function overlapPenalty(array $mains, array $stars, array $contextLines): int
    {
        if ($contextLines === []) return 0;
        $ms = array_flip($mains);
        $ss = array_flip($stars);
        $pen = 0;
        foreach ($contextLines as $c) {
            $pen += count(array_intersect_key($ms, array_flip((array) ($c['mains'] ?? [])))) * 10;
            $pen += count(array_intersect_key($ss, array_flip((array) ($c['stars'] ?? [])))) * 20;
        }
        return $pen;
    }

    private function adjacentPairs(array $sortedMains): int
    {
        $pairs = 0;
        for ($i = 1; $i < count($sortedMains); $i++) {
            if ($sortedMains[$i] === $sortedMains[$i - 1] + 1) $pairs++;
        }
        return $pairs;
    }

    private function normalizeField($values, int $min, int $max, string $label): array
    {
        $out = [];
        foreach ((array) $values as $v) {
            if (!is_int($v) || $v < $min || $v > $max) {
                throw new \InvalidArgumentException($label . ' out of range ' . $min . '-' . $max . ': ' . (is_scalar($v) ? (string) $v : 'invalid'));
            }
            if (in_array($v, $out, true)) throw new \InvalidArgumentException('duplicate ' . $label . ': ' . $v);
            $out[] = $v;
        }
        sort($out);
        return $out;
    }

    private function bestMode(array $counts, float $ideal): int
    {
        $best = null;
        foreach ($counts as $k => $v) {
            if ($best === null) { $best = (int) $k; continue; }
            $cmp = (int) $v <=> (int) $counts[$best];
            if ($cmp > 0) { $best = (int) $k; }
            elseif ($cmp === 0) {
                if (abs($k - $ideal) < abs($best - $ideal)) $best = (int) $k;
                elseif (abs($k - $ideal) === abs($best - $ideal) && $k < $best) $best = (int) $k;
            }
        }
        return (int) $best;
    }
}
