<?php
namespace Aegis\Lottery;

/**
 * WINDELS Lottery Intelligence — Phases 20/21/22 (spec §23/§24/§25/§34):
 * backtesting engine ("Strategy Lab").
 *
 * A STRATEGY is a deterministic line-generation rule replayed against
 * historical draws WITHOUT look-ahead: for test draw i the strategy only
 * sees draws 1..i-1. Every line is compared with draw i (main/star
 * matches + official prize tier).
 *
 * Built-in strategies (all seeded, deterministic per strategy+draw+model):
 *  - RANDOM_BASELINE   spec §25: always available — prevents ordinary
 *                      random variation from being read as strategy value
 *  - BALANCED_PROFILE  BALANCED-mode generation against pre-draw history
 *  - HISTORICAL_FREQ   HISTORICAL-mode (frequency-weighted) generation
 *  - ANTI_POPULAR      ANTI-POPULAR-mode generation
 *
 * HONESTY CONTRACT (spec §23/§24/§25/§34):
 *  - Reports are labelled HISTORICAL SIMULATION.
 *  - Simulated cost/winnings stay NULL while official line pricing and
 *    prize amounts are unavailable — nothing is fabricated. Only tier
 *    counts are reported (the official tier structure is stable).
 *  - Strategies are compared on the SAME period; no strategy is declared
 *    "better" — differences in historical tier counts are descriptive,
 *    and the random baseline is always reported alongside.
 */
final class LotteryBacktester
{
    public const STRATEGIES = ['RANDOM_BASELINE', 'BALANCED_PROFILE', 'HISTORICAL_FREQ', 'ANTI_POPULAR'];
    /** Minimum pre-draw history before the first test draw. */
    public const MIN_HISTORY = 10;
    /** Maximum test-draws per run (spec §23: "e.g. the last 100"). */
    public const MAX_WINDOW = 100;
    public const MAX_LINES = 10;

    public function __construct(
        private readonly LotteryRules $rules,
        private readonly CombinationAnalyzer $analyzer,
        private readonly CombinationGenerator $generator,
        private readonly string $modelVersion = LotteryIntelligence::MODEL_VERSION,
    ) {}

    public const DESCRIPTIONS = [
        'RANDOM_BASELINE' => 'Uniform random lines (seeded per draw). The mandatory baseline — it shows how often each outcome happens by chance alone.',
        'BALANCED_PROFILE' => 'BALANCED-mode lines: profile-filtered against the pre-draw historical distribution.',
        'HISTORICAL_FREQ' => 'HISTORICAL-mode lines: frequency-weighted sampling from the pre-draw history.',
        'ANTI_POPULAR' => 'ANTI-POPULAR-mode lines: avoids common human selection patterns.',
    ];

    /**
     * @param list<array{drawDate:string,main:list<int>,stars:list<int>}> $draws oldest first (full stored history)
     * @return array<string,mixed> HISTORICAL SIMULATION report
     */
    public function run(array $draws, string $strategy, int $lines = 1, int $window = 0): array
    {
        if (!in_array($strategy, self::STRATEGIES, true)) {
            throw new \InvalidArgumentException('unknown strategy: ' . $strategy . ' (expected ' . implode(', ', self::STRATEGIES) . ')');
        }
        $lines = min(self::MAX_LINES, max(1, $lines));
        $total = count($draws);
        if ($total < self::MIN_HISTORY + 1) {
            throw new \InvalidArgumentException('backtesting needs at least ' . (self::MIN_HISTORY + 1) . ' stored draws (got ' . $total . ')');
        }
        $window = min(self::MAX_WINDOW, $window > 0 ? $window : self::MAX_WINDOW);
        $startIdx = max(self::MIN_HISTORY, $total - $window);

        $perDraw = [];
        $mainDist = [0 => 0, 1 => 0, 2 => 0, 3 => 0, 4 => 0, 5 => 0];
        $starDist = [0 => 0, 1 => 0, 2 => 0];
        $tierCounts = [];
        $best = null;
        $bestRank = 11; // TIER_1 is rank 1 (best)

        for ($i = $startIdx; $i < $total; $i++) {
            $history = array_slice($draws, 0, $i); // NO look-ahead: draw i excluded
            $generated = $this->strategyLines($strategy, $history, $i, $lines);
            $draw = $draws[$i];
            $drawMains = array_flip(array_map('intval', $draw['main']));
            $drawStars = array_flip(array_map('intval', $draw['stars']));
            $lineResults = [];
            foreach ($generated as $line) {
                $mainMatches = count(array_intersect_key(array_flip($line['mains']), $drawMains));
                $starMatches = count(array_intersect_key(array_flip($line['stars']), $drawStars));
                $tier = LotteryIntelligence::prizeTier($mainMatches, $starMatches);
                $mainDist[$mainMatches]++;
                $starDist[$starMatches]++;
                if ($tier !== null) $tierCounts[$tier] = ($tierCounts[$tier] ?? 0) + 1;
                $lineResults[] = [
                    'mains' => $line['mains'],
                    'stars' => $line['stars'],
                    'mainMatches' => $mainMatches,
                    'starMatches' => $starMatches,
                    'prizeTier' => $tier,
                ];
                if ($tier !== null) {
                    $rank = (int) substr($tier, 5, 1); // 'TIER_n'
                    if ($rank < $bestRank) {
                        $bestRank = $rank;
                        $best = ['drawDate' => (string) $draw['drawDate'], 'line' => $lineResults[count($lineResults) - 1]];
                    }
                }
            }
            $perDraw[] = [
                'drawDate' => (string) $draw['drawDate'],
                'historySize' => $i,
                'lines' => $lineResults,
            ];
        }
        ksort($tierCounts);

        return [
            'label' => 'HISTORICAL SIMULATION',
            'strategy' => $strategy,
            'strategyDescription' => self::DESCRIPTIONS[$strategy],
            'modelVersion' => $this->modelVersion,
            'lottery' => $this->rules->code(),
            'period' => [
                'from' => (string) $draws[$startIdx]['drawDate'],
                'to' => (string) $draws[$total - 1]['drawDate'],
                'drawsTested' => $total - $startIdx,
                'minHistoryDraws' => $startIdx,
                'windowCap' => self::MAX_WINDOW,
            ],
            'linesPerDraw' => $lines,
            'totalLines' => ($total - $startIdx) * $lines,
            'matchDistribution' => ['mains' => $mainDist, 'stars' => $starDist],
            'tierCounts' => $tierCounts,
            'bestLine' => $best,
            'simulatedCost' => null,
            'costNote' => 'Official line pricing is not available in this environment — no cost is fabricated.',
            'simulatedWinnings' => null,
            'winningsNote' => 'Official prize amounts vary per draw and are unavailable — only tier counts are reported; no winnings figure is fabricated.',
            'perDraw' => $perDraw,
            'disclaimer' => LotteryStatisticsEngine::DISCLAIMER,
            'note' => 'Historical simulation: the strategy was replayed against past draws without look-ahead. Past tier counts are descriptive — they do not improve future results. The random baseline exists so ordinary random variation is never mistaken for strategy value (spec §25).',
        ];
    }

    /**
     * Strategy comparison on the SAME period (spec §24): every strategy is
     * replayed over identical draws, so differences are comparable — but
     * none is declared "better" (spec §34).
     * @param list<string> $strategies must include RANDOM_BASELINE
     */
    public function compare(array $draws, array $strategies, int $lines = 1, int $window = 0): array
    {
        $strategies = array_values(array_unique(array_map('strtoupper', $strategies)));
        if ($strategies === []) throw new \InvalidArgumentException('at least one strategy is required');
        if (!in_array('RANDOM_BASELINE', $strategies, true)) {
            throw new \InvalidArgumentException('the random baseline must be part of every comparison (spec §25)');
        }
        foreach ($strategies as $s) {
            if (!in_array($s, self::STRATEGIES, true)) throw new \InvalidArgumentException('unknown strategy: ' . $s);
        }
        $reports = [];
        $period = null;
        foreach ($strategies as $s) {
            $r = $this->run($draws, $s, $lines, $window);
            $reports[] = $r;
            $period = $r['period'];
        }
        return [
            'label' => 'HISTORICAL SIMULATION — strategy comparison',
            'lottery' => $this->rules->code(),
            'modelVersion' => $this->modelVersion,
            'period' => $period,
            'linesPerDraw' => $lines,
            'strategies' => $reports,
            'note' => 'All strategies are replayed on the SAME period, including the mandatory random baseline. Differences in tier counts are descriptive only; with no official prize amounts and independent random draws, no strategy is declared "better" (spec §24/§34).',
            'disclaimer' => LotteryStatisticsEngine::DISCLAIMER,
        ];
    }

    /**
     * Deterministic lines for strategy + test-draw index: seed derived from
     * strategy name + index + model version (documented, reproducible).
     * @return list<array{mains:list<int>,stars:list<int>}>
     */
    private function strategyLines(string $strategy, array $history, int $drawIndex, int $lines): array
    {
        $seed = (crc32($strategy) & 0x7FFFFFFF) ^ (($drawIndex * 2654435761) & 0x7FFFFFFF) ^ (crc32('WINDELS-Lottery-Model-v' . $this->modelVersion) & 0x7FFFFFFF);
        if ($seed === 0) $seed = 1;
        return match ($strategy) {
            'RANDOM_BASELINE' => $this->generator->generate($history, ['mode' => 'RANDOM', 'count' => $lines, 'seed' => $seed])['lines'],
            'BALANCED_PROFILE' => $this->generator->generate($history, ['mode' => 'BALANCED', 'count' => $lines, 'seed' => $seed])['lines'],
            'HISTORICAL_FREQ' => $this->generator->generate($history, ['mode' => 'HISTORICAL', 'count' => $lines, 'seed' => $seed])['lines'],
            'ANTI_POPULAR' => $this->generator->generate($history, ['mode' => 'ANTI-POPULAR', 'count' => $lines, 'seed' => $seed])['lines'],
        };
    }
}
