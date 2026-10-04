<?php
namespace Aegis\Lottery;

/**
 * WINDELS Lottery Intelligence — Phase 13 (spec §13): combination analyzer.
 *
 * Full statistical profile of one complete line (5 mains + 2 stars) against
 * stored historical draws: composition (odd/even, low/high), sum and spread
 * with historical context, consecutive patterns, per-number historical
 * profile, star profile, historical similarity, pattern characteristics and
 * a clearly-labelled STATISTICAL BALANCE SCORE.
 *
 * HONESTY CONTRACT (spec §16/§17/§41):
 *  - Every field is a HISTORICAL OBSERVATION about past draws.
 *  - The score is labelled "STATISTICAL BALANCE SCORE: N/100". It measures
 *    how closely the line's composition matches typical historical draws.
 *    It is NOT a probability and it never uses win-chance wording.
 *  - No "due" concept: a number absent for X draws is only reported as
 *    absent for X draws (see numberProfile.drawsSinceLast).
 */
final class CombinationAnalyzer
{
    /** Documented score-component weights (sum to 1.0). */
    public const WEIGHTS = ['sum' => 0.30, 'oddEven' => 0.20, 'lowHigh' => 0.20, 'spread' => 0.15, 'consecutives' => 0.15];

    public function __construct(
        private readonly LotteryRules $rules,
        private readonly LotteryStatisticsEngine $statistics = new LotteryStatisticsEngine(),
    ) {}

    /**
     * @param list<int> $mains
     * @param list<int> $stars
     * @param list<array{drawDate:string,main:list<int>,stars:list<int>}> $draws oldest first
     * @return array<string,mixed>
     */
    public function analyze(array $mains, array $stars, array $draws): array
    {
        $check = $this->rules->validateLine(array_values($mains), array_values($stars));
        if (!$check['valid']) {
            throw new \InvalidArgumentException('invalid line: ' . implode('; ', $check['errors']));
        }
        $mains = array_values($mains);
        sort($mains);
        $stars = array_values($stars);
        sort($stars);
        $r = $this->rules;
        $total = count($draws);
        $lowBound = (int) floor(($r->mainMin() + $r->mainMax()) / 2);

        // ---------------------------------------------------- composition
        $odd = count(array_filter($mains, fn($x) => $x % 2 === 1));
        $even = count($mains) - $odd;
        $low = count(array_filter($mains, fn($x) => $x <= $lowBound));
        $high = count($mains) - $low;
        $sum = array_sum($mains);
        $spread = max($mains) - min($mains);

        $adjacentPairs = 0;
        $longestRun = 1;
        $runs3plus = 0;
        $run = 1;
        for ($i = 1; $i < count($mains); $i++) {
            if ($mains[$i] === $mains[$i - 1] + 1) {
                $adjacentPairs++;
                $run++;
                if ($run > $longestRun) $longestRun = $run;
            } else {
                if ($run >= 3) $runs3plus++;
                $run = 1;
            }
        }
        if ($run >= 3) $runs3plus++;

        // ------------------------------------------------ pattern traits
        $lastDigits = array_unique(array_map(fn($x) => $x % 10, $mains));
        $birthdayCount = count(array_filter($mains, fn($x) => $x >= 1 && $x <= 31));
        $multiplesOf5 = count(array_filter($mains, fn($x) => $x % 5 === 0));

        // ------------------------------------------- historical context
        $histSums = [];
        $histSpreads = [];
        $oddCounts = [];
        $lowCounts = [];
        $lineFlip = array_flip($mains);
        $bestMatch = null;
        $share3plus = 0;
        $sameOE = 0;
        $sumWithin10 = 0;
        foreach ($draws as $d) {
            $m = array_values($d['main']);
            sort($m);
            $dSum = array_sum($m);
            $dSpread = max($m) - min($m);
            $dOdd = count(array_filter($m, fn($x) => $x % 2 === 1));
            $dLow = count(array_filter($m, fn($x) => $x <= $lowBound));
            $histSums[] = $dSum;
            $histSpreads[] = $dSpread;
            $oddCounts[$dOdd] = ($oddCounts[$dOdd] ?? 0) + 1;
            $lowCounts[$dLow] = ($lowCounts[$dLow] ?? 0) + 1;
            $overlap = count(array_intersect_key($lineFlip, array_flip($m)));
            if ($overlap >= 3) $share3plus++;
            if ($dOdd === $odd) $sameOE++;
            if (abs($dSum - $sum) <= 10) $sumWithin10++;
            if ($bestMatch === null || $overlap > $bestMatch['overlap']) {
                $bestMatch = ['drawDate' => (string) $d['drawDate'], 'overlap' => $overlap];
            }
        }
        $sumAvg = \Aegis\MathUtils::mean($histSums);
        $sumStd = \Aegis\MathUtils::stdev($histSums) ?? 0.0;
        $spreadAvg = \Aegis\MathUtils::mean($histSpreads);
        $bestOdd = $total > 0 ? $this->bestMode($oddCounts, count($mains) / 2) : (int) round(count($mains) / 2);
        $bestLow = $total > 0 ? $this->bestMode($lowCounts, count($mains) / 2) : (int) round(count($mains) / 2);
        $sumPct = $total > 0 ? round(count(array_filter($histSums, fn($s) => $s <= $sum)) / $total * 100, 2) : null;
        $spreadPct = $total > 0 ? round(count(array_filter($histSpreads, fn($s) => $s <= $spread)) / $total * 100, 2) : null;

        // ------------------------------------------------ balance score
        if ($total === 0) {
            $score = 50;
            $breakdown = ['note' => 'no historical data — neutral score'];
        } else {
            $sumFit = $sumStd > 0
                ? max(0.0, 100 * (1 - abs($sum - (float) $sumAvg) / (2 * $sumStd)))
                : ($sum === (int) $sumAvg ? 100.0 : 50.0);
            $oddEvenFit = (float) max(0, 100 - 20 * abs($odd - $bestOdd));
            $lowHighFit = (float) max(0, 100 - 20 * abs($low - $bestLow));
            $spreadFit = $spreadAvg > 0
                ? max(0.0, 100 * (1 - abs($spread - (float) $spreadAvg) / (float) $spreadAvg))
                : 100.0;
            $consecFit = (float) max(0, 100 - 25 * $adjacentPairs);
            $w = self::WEIGHTS;
            $score = (int) round(
                $w['sum'] * $sumFit
                + $w['oddEven'] * $oddEvenFit
                + $w['lowHigh'] * $lowHighFit
                + $w['spread'] * $spreadFit
                + $w['consecutives'] * $consecFit
            );
            $breakdown = [
                'sumFit' => round($sumFit, 1),
                'oddEvenFit' => $oddEvenFit,
                'lowHighFit' => $lowHighFit,
                'spreadFit' => round($spreadFit, 1),
                'consecutivesFit' => $consecFit,
            ];
        }

        // ------------------------------------------- number/star profiles
        $numberStats = $this->statistics->numberStats($draws, $r->mainMin(), $r->mainMax());
        $starStats = $this->statistics->starStats($draws, $r->starMin(), $r->starMax());
        $numberProfile = [];
        foreach ($mains as $n) $numberProfile[] = $numberStats['numbers'][$n];
        $starProfile = [];
        foreach ($stars as $n) $starProfile[] = $starStats['numbers'][$n];

        return [
            'mains' => $mains,
            'stars' => $stars,
            'composition' => [
                'oddEven' => ['odd' => $odd, 'even' => $even, 'label' => $odd . ' odd / ' . $even . ' even'],
                'lowHigh' => ['low' => $low, 'high' => $high, 'lowBound' => $lowBound, 'label' => $low . ' low / ' . $high . ' high'],
                'sum' => ['value' => $sum, 'historical' => [
                    'min' => $total > 0 ? min($histSums) : null,
                    'max' => $total > 0 ? max($histSums) : null,
                    'avg' => $sumAvg !== null ? round($sumAvg, 2) : null,
                    'percentile' => $sumPct,
                ]],
                'spread' => ['value' => $spread, 'historical' => [
                    'min' => $total > 0 ? min($histSpreads) : null,
                    'max' => $total > 0 ? max($histSpreads) : null,
                    'avg' => $spreadAvg !== null ? round($spreadAvg, 2) : null,
                    'percentile' => $spreadPct,
                ]],
                'consecutives' => ['adjacentPairs' => $adjacentPairs, 'longestRun' => $longestRun, 'runsOf3Plus' => $runs3plus],
            ],
            'patternCharacteristics' => [
                'allSameLastDigit' => count($lastDigits) === 1,
                'withinSingleDecade' => (max($mains) - min($mains)) < 10,
                'birthdayCount' => $birthdayCount,
                'birthdayNote' => $birthdayCount . ' of ' . count($mains) . ' mains fall in the 1-31 birthday range',
                'multiplesOf5' => $multiplesOf5,
                'note' => 'Pattern traits describe how selections with these characteristics appear in historical draws. They do not change the odds of this line being drawn.',
            ],
            'numberProfile' => $numberProfile,
            'starProfile' => $starProfile,
            'historicalSimilarity' => [
                'bestNumberOverlap' => $bestMatch !== null ? $bestMatch['overlap'] : 0,
                'bestMatch' => $bestMatch,
                'drawsSharing3PlusNumbers' => $share3plus,
                'sameOddEvenDraws' => $sameOE,
                'sameOddEvenPct' => $total > 0 ? round($sameOE / $total * 100, 2) : 0.0,
                'sumWithin10' => ['draws' => $sumWithin10, 'pct' => $total > 0 ? round($sumWithin10 / $total * 100, 2) : 0.0],
                'note' => 'Similarity with past draws is a historical observation only — past draws do not influence future draws.',
            ],
            'balanceScore' => $score,
            'scoreBreakdown' => $breakdown,
            'scoreLabel' => 'STATISTICAL BALANCE SCORE: ' . $score . '/100',
            'scoreMeaning' => 'How closely this line matches typical historical draw composition (sum, odd/even, low/high, spread, consecutive patterns). It is NOT a probability and it does not indicate how likely the line is to be drawn.',
            'disclaimer' => LotteryStatisticsEngine::DISCLAIMER,
        ];
    }

    /** Mode of a count distribution; ties resolve toward the value nearest $ideal, then the smaller. */
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
