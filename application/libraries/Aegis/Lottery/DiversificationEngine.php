<?php
namespace Aegis\Lottery;

/**
 * WINDELS Lottery Intelligence — Phase 15 (spec §22): diversification
 * engine.
 *
 * Scores how different a SET of combinations is from itself:
 *  - number / pair / triplet / star overlap between every pair of lines
 *    (pair overlap of two lines = C(|A∩B|, 2); triplet overlap = C(|A∩B|, 3)
 *    — exact, without enumerating group sets)
 *  - distribution similarity (identical odd/even or low/high splits,
 *    average absolute sum difference)
 *  - duplicate lines and repeated number pairs across the set
 *  - a single DIVERSITY SCORE (0-100): higher = more different lines.
 *
 * Scales to 10/20/50+ lines (O(n^2) with small constant — the per-pair
 * work is bounded by the line size, not the number range).
 *
 * HONESTY CONTRACT (spec §22/§41): the Diversity Score measures how
 * different the combinations are from each other. It is NOT a measure of
 * the probability of any line being drawn, or of any prize chance.
 */
final class DiversificationEngine
{
    public function __construct(private readonly LotteryRules $rules) {}

    /**
     * @param list<array{mains:list<int>,stars:list<int>}> $lines
     * @return array<string,mixed>
     */
    public function score(array $lines): array
    {
        $lines = array_values($lines);
        $n = count($lines);
        if ($n === 0) throw new \InvalidArgumentException('no lines provided');
        $r = $this->rules;
        $lowBound = (int) floor(($r->mainMin() + $r->mainMax()) / 2);

        $normalized = [];
        foreach ($lines as $i => $line) {
            $mains = array_values((array) ($line['mains'] ?? []));
            $stars = array_values((array) ($line['stars'] ?? []));
            $check = $r->validateLine($mains, $stars);
            if (!$check['valid']) {
                throw new \InvalidArgumentException('line ' . ($i + 1) . ' invalid: ' . implode('; ', $check['errors']));
            }
            sort($mains);
            sort($stars);
            $normalized[] = ['mains' => $mains, 'stars' => $stars];
        }

        $pairCount = 0;
        $sumMain = 0;
        $maxMain = 0;
        $sumStar = 0;
        $maxStar = 0;
        $sumPairs = 0;
        $maxPairs = 0;
        $sumTriples = 0;
        $maxTriples = 0;
        $sameOE = 0;
        $sameLH = 0;
        $sumAbsDiff = 0;
        $identicalPairs = 0;

        for ($i = 0; $i < $n; $i++) {
            for ($j = $i + 1; $j < $n; $j++) {
                $a = $normalized[$i];
                $b = $normalized[$j];
                $sharedMain = count(array_intersect($a['mains'], $b['mains']));
                $sharedStar = count(array_intersect($a['stars'], $b['stars']));
                $sharedPairs = $this->comb2($sharedMain);
                $sharedTriples = $this->comb3($sharedMain);
                $pairCount++;
                $sumMain += $sharedMain;
                $maxMain = max($maxMain, $sharedMain);
                $sumStar += $sharedStar;
                $maxStar = max($maxStar, $sharedStar);
                $sumPairs += $sharedPairs;
                $maxPairs = max($maxPairs, $sharedPairs);
                $sumTriples += $sharedTriples;
                $maxTriples = max($maxTriples, $sharedTriples);
                $oa = count(array_filter($a['mains'], fn($x) => $x % 2 === 1));
                $ob = count(array_filter($b['mains'], fn($x) => $x % 2 === 1));
                if ($oa === $ob) $sameOE++;
                $la = count(array_filter($a['mains'], fn($x) => $x <= $lowBound));
                $lb = count(array_filter($b['mains'], fn($x) => $x <= $lowBound));
                if ($la === $lb) $sameLH++;
                $sumAbsDiff += abs(array_sum($a['mains']) - array_sum($b['mains']));
                if ($a['mains'] === $b['mains'] && $a['stars'] === $b['stars']) $identicalPairs++;
            }
        }

        // duplicates: lines that appear more than once
        $keys = [];
        foreach ($normalized as $line) {
            $keys[implode(',', $line['mains']) . '|' . implode(',', $line['stars'])] = true;
        }
        $duplicates = $n - count($keys);

        // pair reuse across the whole set
        $pairInstances = [];
        foreach ($normalized as $line) {
            foreach ($this->pairsOf($line['mains']) as $p) $pairInstances[$p] = true;
        }
        $totalPairInstances = $n * $this->comb2($r->mainCount());
        $uniquePairs = count($pairInstances);
        $reusedShare = $totalPairInstances > 0 ? round(($totalPairInstances - $uniquePairs) / $totalPairInstances * 100, 2) : 0.0;

        $avgMain = $pairCount > 0 ? round($sumMain / $pairCount, 3) : 0.0;
        $avgStar = $pairCount > 0 ? round($sumStar / $pairCount, 3) : 0.0;
        $avgPairs = $pairCount > 0 ? round($sumPairs / $pairCount, 3) : 0.0;
        $avgTriples = $pairCount > 0 ? round($sumTriples / $pairCount, 3) : 0.0;
        $sameOEPct = $pairCount > 0 ? round($sameOE / $pairCount * 100, 2) : 0.0;
        $sameLHPct = $pairCount > 0 ? round($sameLH / $pairCount * 100, 2) : 0.0;
        $avgAbsSumDiff = $pairCount > 0 ? round($sumAbsDiff / $pairCount, 2) : 0.0;

        // diversity score: 100 minus overlap/similarity penalties
        $penalty = 0.0;
        $penalty += 45 * ($avgMain / $r->mainCount());
        $penalty += 15 * ($avgStar / $r->starCount());
        $penalty += 10 * ($sameOEPct / 100);
        $penalty += 10 * ($sameLHPct / 100);
        $penalty += 5 * (1 - min(1.0, $avgAbsSumDiff / 30));
        $penalty += 30 * ($identicalPairs / max(1, $pairCount));
        $score = (int) round(\Aegis\MathUtils::clamp(100 - $penalty, 0, 100));

        return [
            'lineCount' => $n,
            'duplicates' => $duplicates,
            'overlaps' => [
                'linePairs' => $pairCount,
                'averageMain' => $avgMain,
                'maxMain' => $maxMain,
                'averageStar' => $avgStar,
                'maxStar' => $maxStar,
                'averageMainPairs' => $avgPairs,
                'maxMainPairs' => $maxPairs,
                'averageMainTriplets' => $avgTriples,
                'maxMainTriplets' => $maxTriples,
            ],
            'distributionSimilarity' => [
                'sameOddEvenPct' => $sameOEPct,
                'sameLowHighPct' => $sameLHPct,
                'avgAbsSumDiff' => $avgAbsSumDiff,
            ],
            'pairReuse' => [
                'totalPairInstances' => $totalPairInstances,
                'uniquePairs' => $uniquePairs,
                'reusedSharePct' => $reusedShare,
            ],
            'diversityScore' => $score,
            'scoreLabel' => 'DIVERSITY SCORE: ' . $score . '/100',
            'scoreMeaning' => 'How different the combinations are from each other (number, pair, triplet and star overlap plus distribution similarity). It is NOT a measure of how likely any line is to be drawn.',
            'disclaimer' => LotteryStatisticsEngine::DISCLAIMER,
        ];
    }

    /** All sorted "a-b" pair keys of a sorted line. */
    private function pairsOf(array $mains): array
    {
        $out = [];
        for ($i = 0; $i < count($mains); $i++) {
            for ($j = $i + 1; $j < count($mains); $j++) {
                $out[] = $mains[$i] . '-' . $mains[$j];
            }
        }
        return $out;
    }

    private function comb2(int $k): int
    {
        return $k < 2 ? 0 : (int) ($k * ($k - 1) / 2);
    }

    private function comb3(int $k): int
    {
        return $k < 3 ? 0 : (int) ($k * ($k - 1) * ($k - 2) / 6);
    }
}
