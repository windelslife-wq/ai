<?php
/**
 * WINDELS Lottery Intelligence — Phases 13/14 (spec §13–§17, §21, §26, §33):
 * combination analyzer + AI combination generator.
 *
 * Pure-engine tests on small deterministic fixtures (exact expected values),
 * plus one end-to-end persistence test through the real repository layer.
 * Honesty is pinned: scores are labelled statistical balance scores, the
 * report carries the actual inputs/factors/model, and no banned wording
 * appears anywhere in the generated report.
 */
use Aegis\Lottery\CombinationAnalyzer;
use Aegis\Lottery\CombinationGenerator;
use Aegis\Lottery\EuroMillionsRules;
use Aegis\Lottery\LotteryIntelligence;
use Aegis\Lottery\SandboxLotteryProvider;

function fx_lotto4_draws(): array
{
    return [
        ['drawDate' => '2026-07-14', 'main' => [4, 11, 23, 30, 45], 'stars' => [2, 5]],
        ['drawDate' => '2026-07-17', 'main' => [7, 14, 21, 38, 49], 'stars' => [5, 9]],
        ['drawDate' => '2026-07-21', 'main' => [3, 16, 27, 34, 42], 'stars' => [9, 11]],
        ['drawDate' => '2026-07-24', 'main' => [9, 18, 25, 36, 47], 'stars' => [11, 12]],
    ];
}

/** Number 7 appears in every draw — used to prove HISTORICAL weighting. */
function fx_lotto_hot7_draws(): array
{
    return [
        ['drawDate' => '2026-07-14', 'main' => [7, 8, 9, 10, 11], 'stars' => [1, 2]],
        ['drawDate' => '2026-07-17', 'main' => [7, 12, 13, 14, 15], 'stars' => [2, 3]],
        ['drawDate' => '2026-07-21', 'main' => [7, 16, 17, 18, 19], 'stars' => [3, 4]],
        ['drawDate' => '2026-07-24', 'main' => [7, 20, 21, 22, 23], 'stars' => [4, 5]],
    ];
}

function fx_lotto_analyzer(): CombinationAnalyzer
{
    return new CombinationAnalyzer(new EuroMillionsRules());
}

function fx_lotto_generator(): CombinationGenerator
{
    return new CombinationGenerator(new EuroMillionsRules(), fx_lotto_analyzer());
}

function fx_lotto_profile_by(array $entries, int $number): array
{
    foreach ($entries as $e) {
        if ((int) $e['number'] === $number) return $e;
    }
    throw new RuntimeException('profile entry missing for number ' . $number);
}

test('lottery analyzer: full profile of a known line against a known fixture', function () {
    $a = fx_lotto_analyzer();
    $p = $a->analyze([10, 20, 30, 40, 50], [2, 9], fx_lotto4_draws());

    assert_equals([10, 20, 30, 40, 50], $p['mains']);
    assert_equals([2, 9], $p['stars']);
    assert_equals('0 odd / 5 even', $p['composition']['oddEven']['label']);
    assert_equals('2 low / 3 high', $p['composition']['lowHigh']['label']);
    assert_equals(25, $p['composition']['lowHigh']['lowBound']);
    assert_equals(150, $p['composition']['sum']['value']);
    assert_close(124.75, (float) $p['composition']['sum']['historical']['avg'], 0.001, 'historical sum avg');
    assert_equals(100.0, $p['composition']['sum']['historical']['percentile']);
    assert_equals(40, $p['composition']['spread']['value']);
    assert_close(40.0, (float) $p['composition']['spread']['historical']['avg'], 0.001, 'historical spread avg');
    assert_equals(50.0, $p['composition']['spread']['historical']['percentile']);
    assert_equals(0, $p['composition']['consecutives']['adjacentPairs']);
    assert_equals(1, $p['composition']['consecutives']['longestRun']);

    assert_true($p['patternCharacteristics']['allSameLastDigit'], '10/20/30/40/50 all end in 0');
    assert_false($p['patternCharacteristics']['withinSingleDecade']);
    assert_equals(3, $p['patternCharacteristics']['birthdayCount'], '10, 20 and 30 all fall in 1-31');
    assert_equals(5, $p['patternCharacteristics']['multiplesOf5']);

    $n10 = fx_lotto_profile_by($p['numberProfile'], 10);
    assert_equals(0, $n10['appearances']);
    assert_null($n10['lastAppearance']);
    assert_null($n10['avgGap']);
    $n30 = fx_lotto_profile_by($p['numberProfile'], 30);
    assert_equals(1, $n30['appearances']);
    assert_equals('2026-07-14', $n30['lastAppearance']);
    assert_equals(3, $n30['drawsSinceLast']);
    assert_null($n30['avgGap'], 'a single appearance has no gap');
    $s9 = fx_lotto_profile_by($p['starProfile'], 9);
    assert_equals(2, $s9['appearances']);
    assert_equals(1, $s9['drawsSinceLast']);

    assert_equals(1, $p['historicalSimilarity']['bestNumberOverlap']);
    assert_equals('2026-07-14', $p['historicalSimilarity']['bestMatch']['drawDate']);
    assert_equals(0, $p['historicalSimilarity']['sameOddEvenDraws']);
    assert_equals(0, $p['historicalSimilarity']['sumWithin10']['draws']);

    assert_equals(54, $p['balanceScore'], 'exact score from documented weights');
    assert_equals('STATISTICAL BALANCE SCORE: 54/100', $p['scoreLabel']);
    assert_true(array_key_exists('sumFit', $p['scoreBreakdown']));
    assert_true(str_contains($p['disclaimer'], 'independent'));
    assert_false(str_contains($p['scoreMeaning'], 'probability of winning'), 'score meaning avoids probability wording');
});

test('lottery analyzer: rejects invalid lines', function () {
    $a = fx_lotto_analyzer();
    assert_throws(InvalidArgumentException::class, fn () => $a->analyze([1, 2, 3, 4, 51], [2, 5], []), '51 out of range');
    assert_throws(InvalidArgumentException::class, fn () => $a->analyze([1, 2, 3, 4], [2, 5], []), '4 mains');
    assert_throws(InvalidArgumentException::class, fn () => $a->analyze([1, 1, 2, 3, 4], [2, 5], []), 'duplicate mains');
    assert_throws(InvalidArgumentException::class, fn () => $a->analyze([1, 2, 3, 4, 5], [1, 13], []), 'star 13 out of range');
});

test('lottery generator: RANDOM is deterministic, valid and self-describing', function () {
    $g = fx_lotto_generator();
    $r1 = $g->generate(fx_lotto4_draws(), ['mode' => 'RANDOM', 'count' => 3, 'seed' => 42]);
    $r2 = $g->generate(fx_lotto4_draws(), ['mode' => 'RANDOM', 'count' => 3, 'seed' => 42]);
    $r3 = $g->generate(fx_lotto4_draws(), ['mode' => 'RANDOM', 'count' => 3, 'seed' => 43]);

    assert_equals('WINDELS Lottery Model v1.0', $r1['model']);
    assert_equals('RANDOM', $r1['mode']);
    assert_equals(3, $r1['lineCount']);
    assert_equals(42, $r1['inputs']['seed']);
    assert_equals(4, $r1['inputs']['drawsUsed']);
    assert_equals('2026-07-24', $r1['inputs']['lastDrawDate']);
    assert_equals('n=4;last=2026-07-24', $r1['inputs']['datasetVersion']);
    assert_equals('1.0', $r1['inputs']['rulesVersion']);
    assert_true(!empty($r1['factors']['method']), 'actual method recorded');
    assert_true(str_contains($r1['disclaimer'], 'independent'));
    assert_true(str_contains($r1['honestyNote'], 'same mathematical chance'));

    assert_equals($r1['lines'], $r2['lines'], 'same seed reproduces the same lines');
    assert_true($r1['lines'] !== $r3['lines'], 'different seed changes the lines');

    $rules = new EuroMillionsRules();
    foreach ($r1['lines'] as $line) {
        assert_true($rules->validateLine($line['mains'], $line['stars'])['valid'], 'line validates against the rules');
        $sorted = $line['mains'];
        sort($sorted);
        assert_equals($sorted, $line['mains'], 'mains stored sorted');
        assert_is_int_score($line['score']);
        assert_true((bool) preg_match('/^STATISTICAL BALANCE SCORE: (100|[0-9]{1,2})\/100$/', $line['scoreLabel']), 'label format');
        assert_not_null($line['profile']['sum']);
    }
});

function assert_is_int_score($score): void
{
    assert_true(is_int($score) && $score >= 0 && $score <= 100, 'score is an int 0..100 (got ' . var_export($score, true) . ')');
}

test('lottery generator: locks and excludes are respected by every mode path', function () {
    $g = fx_lotto_generator();
    $opts = [
        'mode' => 'RANDOM', 'count' => 6, 'seed' => 9,
        'locks' => ['mains' => [7, 14], 'stars' => [5]],
        'excludes' => ['mains' => [1, 50], 'stars' => [12]],
    ];
    $r = $g->generate(fx_lotto4_draws(), $opts);
    assert_equals([7, 14], $r['inputs']['locks']['mains']);
    assert_equals([1, 50], $r['inputs']['excludes']['mains']);
    foreach ($r['lines'] as $line) {
        assert_in_array(7, $line['mains'], 'locked main 7 present');
        assert_in_array(14, $line['mains'], 'locked main 14 present');
        assert_in_array(5, $line['stars'], 'locked star 5 present');
        assert_true(!in_array(1, $line['mains'], true), 'excluded main 1 absent');
        assert_true(!in_array(50, $line['mains'], true), 'excluded main 50 absent');
        assert_true(!in_array(12, $line['stars'], true), 'excluded star 12 absent');
    }

    // a BALANCED line must also honour locks/excludes
    $rb = $g->generate(fx_lotto4_draws(), ['mode' => 'BALANCED', 'count' => 3, 'seed' => 9, 'locks' => ['mains' => [45]], 'excludes' => ['mains' => [4]]]);
    foreach ($rb['lines'] as $line) {
        assert_in_array(45, $line['mains']);
        assert_true(!in_array(4, $line['mains'], true));
    }
});

test('lottery generator: constraint validation fails fast', function () {
    $g = fx_lotto_generator();
    $d = fx_lotto4_draws();
    assert_throws(InvalidArgumentException::class, fn () => $g->generate($d, ['mode' => 'RANDOM', 'count' => 1, 'locks' => ['mains' => [1, 2, 3, 4, 5, 6]]]), '6 locked mains');
    assert_throws(InvalidArgumentException::class, fn () => $g->generate($d, ['mode' => 'RANDOM', 'count' => 1, 'locks' => ['mains' => [55]]]), 'lock out of range');
    assert_throws(InvalidArgumentException::class, fn () => $g->generate($d, ['mode' => 'RANDOM', 'count' => 1, 'locks' => ['mains' => [7]], 'excludes' => ['mains' => [7]]]), 'lock and exclude the same number');
    assert_throws(InvalidArgumentException::class, fn () => $g->generate($d, ['mode' => 'RANDOM', 'count' => 1, 'excludes' => ['mains' => range(1, 46)]]), 'only 4 mains left');
    assert_throws(InvalidArgumentException::class, fn () => $g->generate($d, ['mode' => 'RANDOM', 'count' => 1, 'locks' => ['stars' => [1, 2, 3]]]), '3 locked stars');
    assert_throws(InvalidArgumentException::class, fn () => $g->generate($d, ['mode' => 'LUCKY', 'count' => 1]), 'unknown mode');
});

test('lottery generator: BALANCED lines hit the historical profile targets', function () {
    $g = fx_lotto_generator();
    $r = $g->generate(fx_lotto4_draws(), ['mode' => 'BALANCED', 'count' => 8, 'seed' => 7]);

    // fixture sums 113/129/122/135 -> avg 124.75, std 8.1968 -> range [116.6, 132.9]
    assert_close(116.6, (float) $r['factors']['targets']['sumRange'][0], 0.01, 'sum target low');
    assert_close(132.9, (float) $r['factors']['targets']['sumRange'][1], 0.01, 'sum target high');
    assert_equals([2, 4], $r['factors']['targets']['oddRange']);
    assert_equals([2, 4], $r['factors']['targets']['lowRange']);
    assert_equals('3 odd / 2 even', $r['factors']['historicalBasis']['mostCommonOddEven']);
    assert_equals('3 low / 2 high', $r['factors']['historicalBasis']['mostCommonLowHigh']);

    foreach ($r['lines'] as $line) {
        $m = $line['mains'];
        assert_true($line['profile']['sum'] >= 116.6 && $line['profile']['sum'] <= 132.9, 'sum inside target range');
        $odd = count(array_filter($m, fn ($x) => $x % 2 === 1));
        assert_true($odd >= 2 && $odd <= 4, 'odd count inside target range');
        $low = count(array_filter($m, fn ($x) => $x <= 25));
        assert_true($low >= 2 && $low <= 4, 'low count inside target range');
        assert_true($line['profile']['adjacentPairs'] <= 1, 'at most one adjacent pair');
    }
});

test('lottery generator: HISTORICAL weighting favours frequently-drawn numbers', function () {
    $g = fx_lotto_generator();
    $r = $g->generate(fx_lotto_hot7_draws(), ['mode' => 'HISTORICAL', 'count' => 30, 'seed' => 11]);

    assert_equals('frequency-weighted sampling (weight = 1 + historical appearances)', $r['factors']['method']);
    assert_equals(7, $r['factors']['topMainNumbers'][0]['number'], 'number 7 (in every draw) is the top-weighted number');
    assert_equals(4, $r['factors']['topMainNumbers'][0]['appearances']);

    $hot = 0;
    $cold = 0;
    foreach ($r['lines'] as $line) {
        if (in_array(7, $line['mains'], true)) $hot++;
        if (in_array(50, $line['mains'], true)) $cold++;
    }
    assert_true($hot >= 7, 'hot number 7 well represented (got ' . $hot . ' of 30)');
    assert_true($cold <= 8, 'never-drawn 50 stays rare (got ' . $cold . ' of 30)');
    assert_true($hot > $cold, 'hot > cold under frequency weighting');
});

test('lottery generator: ANTI-POPULAR avoids common human patterns', function () {
    $g = fx_lotto_generator();
    $r = $g->generate(fx_lotto4_draws(), ['mode' => 'ANTI-POPULAR', 'count' => 10, 'seed' => 3]);
    assert_equals('constrained sampling avoiding common human selection patterns', $r['factors']['method']);
    foreach ($r['lines'] as $line) {
        $m = $line['mains'];
        $birthday = count(array_filter($m, fn ($x) => $x <= 31));
        assert_true($birthday <= 2, 'at most 2 birthday-range mains (got ' . $birthday . ')');
        assert_true($line['profile']['adjacentPairs'] <= 1, 'at most one adjacent pair');
        $run = 1;
        for ($i = 1; $i < 5; $i++) {
            $run = ($m[$i] === $m[$i - 1] + 1) ? $run + 1 : 1;
            assert_true($run < 3, 'no ascending runs of 3 or more');
        }
        $digits = array_unique(array_map(fn ($x) => $x % 10, $m));
        assert_true(count($digits) > 1, 'not all same last digit');
        assert_true(max($m) - min($m) >= 10, 'not confined to one decade');
    }
});

test('lottery generator: report honesty — no banned wording, actual inputs recorded', function () {
    $g = fx_lotto_generator();
    $r = $g->generate(fx_lotto4_draws(), ['mode' => 'DIVERSIFIED', 'count' => 5, 'seed' => 5]);
    $json = strtolower(json_encode($r));
    foreach (['guarantee', 'win chance', 'win probability', 'winning numbers', 'certain win', 'secret formula', 'sure win', 'jackpot prediction', '90% chance', 'ai knows the next draw', 'predict'] as $banned) {
        assert_false(str_contains($json, $banned), 'report contains banned wording: ' . $banned);
    }
    assert_equals('DIVERSIFIED', $r['mode']);
    assert_equals('minimum-overlap greedy selection (10 points per shared main, 20 per shared star)', $r['factors']['method']);
    assert_true(is_int($r['averageBalanceScore']) || is_float($r['averageBalanceScore']), 'average score present');
    assert_true(str_contains($r['generatedAt'], 'T'), 'UTC timestamp recorded');
});

test('lottery generator: persistence e2e — combination + AI decision + audit through the real DB', function () {
    $p = platform();
    $model = $p->model;
    $intel = new LotteryIntelligence($model->lottery, $model->audit, new SandboxLotteryProvider(11));
    putenv('WINDELS_LOTTERY_SANDBOX=1');
    try {
        $sum = $intel->sync(8); // idempotent if case 56 already imported
        assert_true($sum['status'] === 'OK', 'sandbox sync ok');
        $before = count($intel->listCombinations(200));

        $report = $intel->generate(['mode' => 'BALANCED', 'count' => 3, 'seed' => 123, 'locks' => ['mains' => [7]], 'excludes' => ['mains' => [50]]]);
        assert_equals(3, count($report['lines']));
        $saved = $intel->saveGeneration($report, '1');
        assert_true($saved['combinationId'] > 0);
        assert_true($saved['decisionId'] > 0);

        $found = $model->lottery->findCombination($saved['combinationId']);
        assert_not_null($found);
        assert_equals('BALANCED', $found['mode']);
        assert_equals('WINDELS Lottery Model v1.0', $found['model_version'], 'results stay connected to the model that produced them');
        assert_equals('123', $found['seed']);
        assert_equals(3, $found['line_count']);
        assert_equals(3, count($found['lines']), 'lines JSON round-trips decoded');
        foreach ($found['lines'] as $line) {
            assert_in_array(7, $line['mains'], 'locked main persisted');
            assert_true(!in_array(50, $line['mains'], true), 'excluded main persisted');
        }
        assert_equals([7], $found['constraints']['locks']['mains']);
        assert_equals([50], $found['constraints']['excludes']['mains']);
        assert_equals(1, (int) $found['created_by']);

        $decision = $model->lottery->findAiDecision($saved['decisionId']);
        assert_not_null($decision);
        assert_equals($saved['combinationId'], (int) $decision['combination_id']);
        assert_equals('BALANCED', $decision['decision']['mode'], 'decision JSON round-trips decoded');
        assert_equals(123, $decision['decision']['inputs']['seed']);
        assert_equals('WINDELS Lottery Model v1.0', $decision['decision']['model']);

        assert_true(count($intel->listCombinations(200)) === $before + 1, 'exactly one combination row added');
        $byComb = $model->lottery->listAiDecisions($saved['combinationId'], 10);
        assert_equals(1, count($byComb));

        // audit trail
        $recent = array_column($model->audit->recent(20), 'type');
        assert_in_array('LOTTERY_COMBINATION_GENERATED', $recent, 'generation audited');
    } finally {
        putenv('WINDELS_LOTTERY_SANDBOX');
    }
});
