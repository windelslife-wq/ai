<?php
/**
 * WINDELS Lottery Intelligence — Phase 15 (spec §22) + wiring:
 * diversification engine (exact overlap math, duplicate detection, scale)
 * and the new API surface (routes, permissions, honest feature matrix).
 */
use Aegis\Lottery\CombinationGenerator;
use Aegis\Lottery\DiversificationEngine;
use Aegis\Lottery\EuroMillionsRules;

function fx_lotto_div_engine(): DiversificationEngine
{
    return new DiversificationEngine(new EuroMillionsRules());
}

/** Lines A/B sharing exactly mains {3,4,5} and star {5}. */
function fx_lotto_two_lines(): array
{
    return [
        ['mains' => [1, 2, 3, 4, 5], 'stars' => [2, 5]],
        ['mains' => [3, 4, 5, 6, 7], 'stars' => [5, 9]],
    ];
}

function fx_lotto4b_draws(): array
{
    return [
        ['drawDate' => '2026-07-14', 'main' => [4, 11, 23, 30, 45], 'stars' => [2, 5]],
        ['drawDate' => '2026-07-17', 'main' => [7, 14, 21, 38, 49], 'stars' => [5, 9]],
        ['drawDate' => '2026-07-21', 'main' => [3, 16, 27, 34, 42], 'stars' => [9, 11]],
        ['drawDate' => '2026-07-24', 'main' => [9, 18, 25, 36, 47], 'stars' => [11, 12]],
    ];
}

test('lottery diversification: exact overlap math on two known lines', function () {
    $d = fx_lotto_div_engine();
    $r = $d->score(fx_lotto_two_lines());

    assert_equals(2, $r['lineCount']);
    assert_equals(0, $r['duplicates']);
    assert_equals(1, $r['overlaps']['linePairs']);
    assert_equals(3.0, $r['overlaps']['averageMain']);
    assert_equals(3, $r['overlaps']['maxMain']);
    assert_equals(3.0, $r['overlaps']['averageMainPairs'], 'pair overlap = C(3,2)');
    assert_equals(3, $r['overlaps']['maxMainPairs']);
    assert_equals(1.0, $r['overlaps']['averageMainTriplets'], 'triplet overlap = C(3,3)');
    assert_equals(1, $r['overlaps']['maxMainTriplets']);
    assert_equals(1.0, $r['overlaps']['averageStar']);
    assert_equals(1, $r['overlaps']['maxStar']);

    assert_equals(100.0, $r['distributionSimilarity']['sameOddEvenPct'], 'both lines 3 odd / 2 even');
    assert_equals(100.0, $r['distributionSimilarity']['sameLowHighPct'], 'all numbers <= 25');
    assert_equals(10.0, $r['distributionSimilarity']['avgAbsSumDiff'], 'sums 15 vs 25');

    assert_equals(20, $r['pairReuse']['totalPairInstances']);
    assert_equals(17, $r['pairReuse']['uniquePairs'], '10 + 10 - 3 shared pairs');
    assert_equals(15.0, $r['pairReuse']['reusedSharePct']);

    assert_equals(42, $r['diversityScore'], 'exact score from documented penalties');
    assert_equals('DIVERSITY SCORE: 42/100', $r['scoreLabel']);
});

test('lottery diversification: identical lines collapse the score', function () {
    $d = fx_lotto_div_engine();
    $r = $d->score([
        ['mains' => [1, 2, 3, 4, 5], 'stars' => [1, 2]],
        ['mains' => [5, 4, 3, 2, 1], 'stars' => [2, 1]],
    ]);
    assert_equals(1, $r['duplicates'], 'same numbers in different order count as one line');
    assert_equals(5, $r['overlaps']['maxMain']);
    assert_equals(2, $r['overlaps']['maxStar']);
    assert_equals(0, $r['diversityScore'], 'identical lines: zero diversity');
});

test('lottery diversification: disjoint lines score high', function () {
    $d = fx_lotto_div_engine();
    $r = $d->score([
        ['mains' => [1, 2, 3, 4, 5], 'stars' => [1, 2]],
        ['mains' => [10, 12, 14, 16, 18], 'stars' => [11, 12]],
    ]);
    assert_equals(0.0, $r['overlaps']['averageMain']);
    assert_equals(0, $r['overlaps']['maxStar']);
    assert_equals(0.0, $r['distributionSimilarity']['sameOddEvenPct'], '3 odd vs 0 odd');
    assert_equals(90, $r['diversityScore'], 'only the shared low/high split is penalised');
});

test('lottery diversification: DIVERSIFIED generator output stays diverse at 50 lines', function () {
    $g = new CombinationGenerator(new EuroMillionsRules(), new \Aegis\Lottery\CombinationAnalyzer(new EuroMillionsRules()));
    $report = $g->generate(fx_lotto4b_draws(), ['mode' => 'DIVERSIFIED', 'count' => 50, 'seed' => 5]);
    $d = fx_lotto_div_engine();
    $r = $d->score($report['lines']);

    assert_equals(50, $r['lineCount']);
    assert_equals(0, $r['duplicates'], 'no identical lines');
    assert_true($r['overlaps']['maxMain'] <= 3, 'pair overlap bounded (max ' . $r['overlaps']['maxMain'] . ')');
    assert_true($r['overlaps']['averageMain'] < 1.5, 'low average overlap (' . $r['overlaps']['averageMain'] . ')');
    assert_true($r['diversityScore'] >= 30, 'healthy diversity score (' . $r['diversityScore'] . ')');
    assert_true((bool) preg_match('/^DIVERSITY SCORE: (100|[0-9]{1,2})\/100$/', $r['scoreLabel']), 'label format');
});

test('lottery api: new routes, permissions and honest feature matrix', function () {
    $routes = file_get_contents(FCPATH . 'application/config/routes.php');
    assert_contains("\$route['api/lottery/analyze'] = 'api_lottery/analyze';", $routes);
    assert_contains("\$route['api/lottery/generate'] = 'api_lottery/generate';", $routes);
    assert_contains("\$route['api/lottery/diversity'] = 'api_lottery/diversity';", $routes);
    assert_contains("\$route['api/lottery/combinations'] = 'api_lottery/combinations';", $routes);
    assert_contains("\$route['api/lottery/combinations/(:num)'] = 'api_lottery/show_combination/\$1';", $routes);

    $c = file_get_contents(FCPATH . 'application/controllers/Api_lottery.php');
    // generate/diversity are mutations: requirePermission without the `false` arg = session CSRF enforced
    assert_true(substr_count($c, "requirePermission('lottery.view')") >= 2, 'mutations use lottery.view + CSRF');
    assert_true(substr_count($c, "requirePermission('lottery.view', false)") >= 7, 'reads use lottery.view without CSRF');
    assert_contains('$this->platform->lottery->saveGeneration($report, (string) $user[\'id\'])', $c, 'generations attributed to the signed-in user');

    // honesty scan of every new/modified lottery file
    foreach ([
        'application/libraries/Aegis/Lottery/CombinationAnalyzer.php',
        'application/libraries/Aegis/Lottery/CombinationGenerator.php',
        'application/libraries/Aegis/Lottery/DiversificationEngine.php',
        'application/controllers/Api_lottery.php',
    ] as $file) {
        $src = strtolower(file_get_contents(FCPATH . $file));
        foreach (['guarantee', 'win chance', 'win probability', 'winning numbers', 'certain win', 'secret formula', 'sure win', 'jackpot prediction', '90% chance', 'ai knows the next draw', 'predict'] as $banned) {
            assert_false(str_contains($src, $banned), $file . ' contains banned wording: ' . $banned);
        }
    }

    require_once FCPATH . 'application/controllers/Api_system.php';
    $rows = array_filter(Api_system::FEATURES, fn($x) => str_contains($x['name'], 'Lottery Combination Intelligence'));
    assert_equals(1, count($rows), 'feature matrix row present');
    foreach ($rows as $row) assert_equals('IMPLEMENTED', $row['status']);
});

test('lottery schema: combinations + ai_decisions tables exist and are verified by the installer', function () {
    $sqlite = file_get_contents(FCPATH . 'application/database/lottery.sqlite.sql');
    assert_contains('CREATE TABLE IF NOT EXISTS lottery_combinations', $sqlite);
    assert_contains('CREATE TABLE IF NOT EXISTS lottery_ai_decisions', $sqlite);
    assert_contains('idx_lottery_ai_decisions_comb ON lottery_ai_decisions(combination_id)', $sqlite);
    assert_contains('CREATE TABLE IF NOT EXISTS lottery_backtests', $sqlite);
    assert_contains('CREATE TABLE IF NOT EXISTS lottery_model_versions', $sqlite);
    $mysql = file_get_contents(FCPATH . 'application/database/lottery.mysql.sql');
    assert_contains('CREATE TABLE IF NOT EXISTS lottery_combinations', $mysql);
    assert_contains('CREATE TABLE IF NOT EXISTS lottery_ai_decisions', $mysql);
    assert_contains('CREATE TABLE IF NOT EXISTS lottery_backtests', $mysql);
    assert_contains('CREATE TABLE IF NOT EXISTS lottery_model_versions', $mysql);

    $installer = file_get_contents(FCPATH . 'tools/install.php');
    assert_contains("'lottery_combinations', 'lottery_ai_decisions', 'lottery_tickets', 'lottery_ticket_lines',", $installer, 'installer verifies the combination/ticket tables');
    assert_contains("'lottery_backtests', 'lottery_model_versions']", $installer, 'installer verifies the backtest + model-version tables');

    // the live test database has the columns usable by the repository layer
    $p = platform();
    $intel = new \Aegis\Lottery\LotteryIntelligence($p->model->lottery, $p->model->audit, new \Aegis\Lottery\UnavailableLotteryProvider());
    $report = $intel->generate(['mode' => 'RANDOM', 'count' => 2, 'seed' => 777]);
    $saved = $intel->saveGeneration($report, 'system');
    assert_true($saved['combinationId'] > 0, 'real DB round trip');
    $detail = $intel->combinationDetail($saved['combinationId']);
    assert_not_null($detail);
    assert_equals(2, count($detail['lines']));
    assert_equals(1, count($detail['decisions']), 'detail carries its AI decision');
    assert_equals('WINDELS Lottery Model v1.0', $detail['model_version']);
});
