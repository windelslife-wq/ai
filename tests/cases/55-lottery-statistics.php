<?php
/**
 * WINDELS Lottery Intelligence — Phases 9–14 (spec §8–§14): statistics
 * engine. Pure functions over stored draws. Every output carries the
 * independence DISCLAIMER; there is no "due" concept anywhere — long gaps
 * are reported as observations, never as predictions.
 */
use Aegis\Lottery\LotteryStatisticsEngine;

function fx_lotto_draws(): array
{
    return [
        ['drawDate' => '2026-07-03', 'main' => [1, 7, 21, 22, 48], 'stars' => [2, 9]],
        ['drawDate' => '2026-07-07', 'main' => [5, 14, 21, 33, 49], 'stars' => [2, 5]],
        ['drawDate' => '2026-07-10', 'main' => [7, 14, 23, 24, 48], 'stars' => [5, 11]],
        ['drawDate' => '2026-07-14', 'main' => [1, 21, 22, 33, 50], 'stars' => [9, 11]],
        ['drawDate' => '2026-07-17', 'main' => [7, 15, 21, 24, 49], 'stars' => [2, 5]],
        ['drawDate' => '2026-07-21', 'main' => [3, 14, 23, 32, 48], 'stars' => [5, 12]],
        ['drawDate' => '2026-07-24', 'main' => [1, 7, 22, 33, 50], 'stars' => [9, 11]],
        ['drawDate' => '2026-07-28', 'main' => [7, 14, 21, 24, 49], 'stars' => [2, 5]],
    ];
}

test('lottery stats: number frequency, gaps and windowed recent stats', function () {
    $e = new LotteryStatisticsEngine();
    $draws = fx_lotto_draws();
    $stats = $e->numberStats($draws, 1, 50);
    assert_equals(8, $stats['totalDraws']);
    assert_equals(50, count($stats['numbers']), 'every configured number is reported, including unseen ones');

    // 7 appears at draws 1,3,5,7,8 (idx 0,2,4,6,7): gaps 2,2,2,1
    $seven = $stats['numbers'][7];
    assert_equals(5, $seven['appearances']);
    assert_close(62.5, $seven['appearancePct'], 0.01);
    assert_equals('2026-07-28', $seven['lastAppearance']);
    assert_equals(0, $seven['drawsSinceLast']);
    assert_close(1.75, $seven['avgGap'], 0.001);
    assert_equals(1, $seven['minGap']);
    assert_equals(2, $seven['maxGap']);

    // 3 appears once (idx 5): no gap history, absent for 2 draws
    $three = $stats['numbers'][3];
    assert_equals(1, $three['appearances']);
    assert_equals(2, $three['drawsSinceLast']);
    assert_null($three['avgGap']);

    // 42 never appears: honest zeros/nulls, no invented recency
    $fortyTwo = $stats['numbers'][42];
    assert_equals(0, $fortyTwo['appearances']);
    assert_equals(null, $fortyTwo['lastAppearance']);

    // windowed recent stats: last 3 draws (idx 5,6,7) contain 7 twice
    $w = $e->numberStats($draws, 1, 50, 3);
    assert_equals(3, $w['window']);
    assert_equals(2, $w['numbers'][7]['recentAppearances']);
    assert_close(66.67, $w['numbers'][7]['recentPct'], 0.01);

    assert_true(str_contains($stats['disclaimer'], 'independent'), 'independence disclaimer present');
    $json = json_encode($stats);
    assert_true(!str_contains($json, 'dueProb') && !str_contains($json, 'winChance'), 'no due-probability / win-chance output');
});

test('lottery stars: same analysis shape for Lucky Stars', function () {
    $e = new LotteryStatisticsEngine();
    $draws = fx_lotto_draws();
    $stats = $e->starStats($draws, 1, 12);
    assert_equals(12, count($stats['numbers']));
    assert_equals(4, $stats['numbers'][2]['appearances']);   // idx 0,1,4,7
    assert_equals(5, $stats['numbers'][5]['appearances']);   // idx 1,2,4,5,7
    assert_equals(3, $stats['numbers'][11]['appearances']);  // idx 2,3,6
    assert_equals(1, $stats['numbers'][12]['appearances']);  // idx 5
    assert_close(62.5, $stats['numbers'][5]['appearancePct'], 0.01);
    assert_true(str_contains($stats['disclaimer'], 'independent'));
});

test('lottery stats: hot/cold are windowed HISTORICAL labels with observation wording', function () {
    $e = new LotteryStatisticsEngine();
    $draws = fx_lotto_draws();
    $hc = $e->hotCold($draws, 'main', 1, 50, 8);
    assert_equals(8, $hc['window']);
    assert_equals(5, $hc['hot'][7], '7 is the hottest number over the window');
    assert_true(str_contains($hc['observation'], 'does NOT predict'), 'hot/cold explicitly labeled non-predictive');
    assert_true(str_contains($hc['disclaimer'], 'independent'));
    $hc3 = $e->hotCold($draws, 'main', 1, 50, 3);
    assert_equals(3, $hc3['window']);
    assert_equals(2, $hc3['hot'][7], 'window respected');
});

test('lottery stats: distribution (odd/even, low/high, sum, spread, consecutive)', function () {
    $e = new LotteryStatisticsEngine();
    $draws = fx_lotto_draws();
    $d = $e->distribution($draws, 1, 50, 5);
    assert_equals(8, $d['totalDraws']);
    // 3 odd / 2 even: idx0, idx3, idx6, idx7 → 4
    assert_equals(4, $d['oddEven']['3 odd / 2 even']);
    // 4 low / 1 high (low <= 25): idx0, idx2, idx4, idx7 → 4
    assert_equals(4, $d['lowHigh']['4 low / 1 high']);
    assert_equals(99, $d['sum']['min'], 'idx0 sum 1+7+21+22+48');
    assert_equals(127, $d['sum']['max'], 'idx3 sum 1+21+22+33+50');
    assert_close(116.0, $d['sum']['avg'], 0.01);
    assert_close(116.0, (float) $d['sum']['median'], 0.001);
    assert_equals(49, $d['spread']['max'], 'idx3/idx6 spread 50-1');
    assert_equals(41, $d['spread']['min'], 'idx2 spread 48-7');
    assert_equals(3, $d['consecutive']['drawsWithConsecutive'], 'idx0 (21,22), idx2 (23,24), idx3 (21,22)');
    assert_close(37.5, $d['consecutive']['pct'], 0.01);
    assert_equals(2, $d['consecutive']['longestRun']);
    assert_equals([2 => 3], $d['consecutive']['runLengthDistribution']);
    assert_true(str_contains($d['disclaimer'], 'independent'));
});

test('lottery stats: pair and star-pair co-occurrence with gaps', function () {
    $e = new LotteryStatisticsEngine();
    $draws = fx_lotto_draws();
    $pairs = $e->groupStats($draws, 'main', 1, 50, 2);
    assert_equals(8, $pairs['totalDraws']);
    assert_equals(2, $pairs['groups']['7-14']['count'], 'pair 07+14 in idx2 and idx7');
    assert_equals('2026-07-28', $pairs['groups']['7-14']['lastSeen']);
    assert_equals([7, 14], $pairs['groups']['7-14']['members']);
    assert_equals(2, $pairs['groups']['21-22']['count']);
    assert_equals(2, $pairs['groups']['14-21']['count'], 'pair 14+21 in idx1 and idx7');
    // every draw contributes exactly C(5,2)=10 pairs
    $totalPairs = 0;
    foreach ($pairs['groups'] as $g) $totalPairs += $g['count'];
    assert_equals(80, $totalPairs);
    assert_true(count($pairs['top']) <= 20, 'top-N bounded');

    $stars = $e->groupStats($draws, 'stars', 1, 12, 2);
    assert_equals(3, $stars['groups']['2-5']['count'], 'star pair 2+5 in idx1, idx4, idx7');
    assert_equals(2, $stars['groups']['9-11']['count']);

    $triplets = $e->groupStats($draws, 'main', 1, 50, 3);
    assert_equals(3, $triplets['k']);
    $totalTriplets = 0;
    foreach ($triplets['groups'] as $g) $totalTriplets += $g['count'];
    assert_equals(80, $totalTriplets, 'C(5,3)=10 triplets per draw');
    assert_true(str_contains($pairs['disclaimer'], 'independent'));
});
