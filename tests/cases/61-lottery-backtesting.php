<?php
/**
 * WINDELS Lottery Intelligence — Phases 20-25 (spec §23/§24/§25/§33/§34/§30):
 * backtesting ("Strategy Lab"), random baseline, strategy comparison,
 * model versioning and the separated performance overview.
 *
 * - Strategies are replayed over stored draws WITHOUT look-ahead.
 * - The random baseline is mandatory in every comparison (spec §25).
 * - No strategy is ever declared "better" (spec §24/§34).
 * - Cost/winnings stay null while official figures are unavailable.
 * - Model versions are never deleted or replaced (spec §33).
 * - Actual ticket results / historical backtests / demo data are never
 *   mixed (spec §30).
 */
use Aegis\Lottery\CombinationAnalyzer;
use Aegis\Lottery\CombinationGenerator;
use Aegis\Lottery\EuroMillionsRules;
use Aegis\Lottery\LotteryBacktester;
use Aegis\Lottery\LotteryCronService;
use Aegis\Lottery\LotteryIntelligence;
use Aegis\Lottery\LotteryStatisticsEngine;
use Aegis\Lottery\SandboxLotteryProvider;

/** Deterministic fixture: $n valid EuroMillions draws, oldest first. */
function fx_lotto_backtest_draws(int $n): array
{
    $draws = [];
    $x = 987654321;
    $dates = [];
    $d = new DateTimeImmutable('2026-08-21');
    for ($i = 0; $i < $n; $i++) {
        $dates[] = (string) $d->format('Y-m-d');
        $d = $d->modify('-2 days');
    }
    $dates = array_reverse($dates);
    foreach ($dates as $date) {
        $mains = [];
        while (count($mains) < 5) {
            $x = ($x * 1103515245 + 12345) % 2147483648;
            $m = ($x % 50) + 1;
            if (!in_array($m, $mains, true)) $mains[] = $m;
        }
        $stars = [];
        while (count($stars) < 2) {
            $x = ($x * 1103515245 + 12345) % 2147483648;
            $s = ($x % 12) + 1;
            if (!in_array($s, $stars, true)) $stars[] = $s;
        }
        sort($mains);
        sort($stars);
        $draws[] = ['drawDate' => $date, 'main' => $mains, 'stars' => $stars];
    }
    return $draws;
}

function fx_lotto_backtester(): LotteryBacktester
{
    $rules = new EuroMillionsRules();
    $stats = new LotteryStatisticsEngine();
    $analyzer = new CombinationAnalyzer($rules, $stats);
    $generator = new CombinationGenerator($rules, $analyzer, $stats);
    return new LotteryBacktester($rules, $analyzer, $generator);
}

test('lottery backtest: deterministic replay without look-ahead (HISTORICAL SIMULATION)', function () {
    $bt = fx_lotto_backtester();
    $draws = fx_lotto_backtest_draws(30);
    $a = $bt->run($draws, 'RANDOM_BASELINE', 2);
    $b = $bt->run($draws, 'RANDOM_BASELINE', 2);
    assert_equals($a, $b, 'same inputs produce an identical report (seeded, deterministic)');

    assert_equals('HISTORICAL SIMULATION', $a['label']);
    assert_equals('EUROMILLIONS', $a['lottery']);
    assert_equals('1.0', $a['modelVersion']);
    assert_equals(20, $a['period']['drawsTested'], '30 stored draws minus 10 minimum history');
    assert_equals(10, $a['period']['minHistoryDraws']);
    assert_equals(2, $a['linesPerDraw']);
    assert_equals(40, $a['totalLines'], '20 test draws x 2 lines');
    assert_equals(40, array_sum($a['matchDistribution']['mains']), 'every line counted once in the main-match distribution');
    assert_equals(40, array_sum($a['matchDistribution']['stars']), 'every line counted once in the star-match distribution');

    // no look-ahead: test draw k was generated from exactly the first (10+k) draws
    assert_equals(20, count($a['perDraw']));
    for ($k = 0; $k < 20; $k++) {
        assert_equals(10 + $k, $a['perDraw'][$k]['historySize']);
        assert_equals($draws[10 + $k]['drawDate'], $a['perDraw'][$k]['drawDate']);
    }
    assert_equals($draws[10]['drawDate'], $a['period']['from']);
    assert_equals($draws[29]['drawDate'], $a['period']['to']);
    assert_equals(2, count($a['perDraw'][0]['lines']));
    $line = $a['perDraw'][0]['lines'][0];
    assert_equals(5, count($line['mains']));
    assert_equals(2, count($line['stars']));
    assert_true(is_string($a['strategyDescription']) && $a['strategyDescription'] !== '', 'strategy description present');
    assert_true(array_sum($a['tierCounts']) <= $a['totalLines'], 'tier counts never exceed the number of lines');

    // an explicit window only trims the test period, never the history floor
    $w = $bt->run($draws, 'RANDOM_BASELINE', 1, 3);
    assert_equals(3, $w['period']['drawsTested']);
    assert_equals($draws[27]['drawDate'], $w['period']['from']);
});

test('lottery backtest: invalid strategy and insufficient history are rejected', function () {
    $bt = fx_lotto_backtester();
    $draws = fx_lotto_backtest_draws(30);
    assert_throws(\InvalidArgumentException::class, fn() => $bt->run($draws, 'LUCKY_CHARM'), 'unknown strategy');
    assert_throws(\InvalidArgumentException::class, fn() => $bt->run(fx_lotto_backtest_draws(10), 'RANDOM_BASELINE'), '10 draws cannot provide 10 history + 1 test draw');
    assert_throws(\InvalidArgumentException::class, fn() => $bt->compare($draws, []), 'at least one strategy required');
});

test('lottery backtest: random baseline honesty — no fabricated cost or winnings', function () {
    $bt = fx_lotto_backtester();
    $r = $bt->run(fx_lotto_backtest_draws(30), 'RANDOM_BASELINE', 3, 20);
    assert_null($r['simulatedCost'], 'official line pricing unavailable — cost stays null');
    assert_contains('no cost is fabricated', $r['costNote']);
    assert_null($r['simulatedWinnings'], 'official prize amounts unavailable — winnings stay null');
    assert_contains('no winnings figure is fabricated', $r['winningsNote']);
    assert_true(is_string($r['disclaimer']) && $r['disclaimer'] !== '', 'independence disclaimer on the report');
    $allowed = [];
    for ($i = 1; $i <= 10; $i++) $allowed[] = 'TIER_' . $i;
    foreach (array_keys($r['tierCounts']) as $tier) {
        assert_in_array($tier, $allowed, 'only official EuroMillions tier names: ' . $tier);
    }
    assert_contains('spec §25', $r['note'], 'report explains why the random baseline exists');
});

test('lottery backtest compare: same period, baseline mandatory, no "better" declared', function () {
    $bt = fx_lotto_backtester();
    $draws = fx_lotto_backtest_draws(30);
    $c = $bt->compare($draws, ['RANDOM_BASELINE', 'BALANCED_PROFILE', 'HISTORICAL_FREQ', 'ANTI_POPULAR'], 1);
    assert_equals('HISTORICAL SIMULATION — strategy comparison', $c['label']);
    assert_equals(4, count($c['strategies']));
    $names = array_map(fn($s) => $s['strategy'], $c['strategies']);
    assert_in_array('RANDOM_BASELINE', $names, 'the baseline is always part of a comparison');
    foreach ($c['strategies'] as $s) {
        assert_equals($c['period'], $s['period'], 'every strategy replayed on the SAME period');
        assert_equals($c['modelVersion'], $s['modelVersion']);
    }
    assert_contains('no strategy is declared "better"', $c['note']);
    assert_throws(\InvalidArgumentException::class, fn() => $bt->compare($draws, ['BALANCED_PROFILE']), 'comparison without the random baseline is refused');
    // lowercasing input still resolves (comparison is case-insensitive on names)
    $c2 = $bt->compare($draws, ['random_baseline'], 1);
    assert_equals(1, count($c2['strategies']));
});

test('lottery backtest E2E: persistence, model versioning, performance separation', function () {
    $model = platform()->model;
    putenv('WINDELS_LOTTERY_SANDBOX=1');
    try {
        $intel = new LotteryIntelligence($model->lottery, $model->audit, new SandboxLotteryProvider(42));
        $sum = $intel->sync(100);
        assert_equals('OK', $sum['status']);
        assert_true($intel->drawCount() >= 11, 'enough stored draws to backtest');

        $before = count($model->lottery->listBacktests(500));
        $report = $intel->backtest('RANDOM_BASELINE', 1);
        assert_equals('HISTORICAL SIMULATION', $report['label']);
        assert_true(isset($report['saved']['backtestId']) && $report['saved']['backtestId'] > 0);
        assert_equals($before + 1, count($model->lottery->listBacktests(500)), 'exactly one backtest row saved');

        $row = $intel->backtestDetail((int) $report['saved']['backtestId']);
        assert_not_null($row);
        assert_true(is_array($row['report']), 'report JSON decoded on read');
        assert_equals('HISTORICAL SIMULATION', $row['report']['label']);
        assert_equals('RANDOM_BASELINE', $row['strategy']);
        assert_equals('1.0', $row['model_version'], 'backtest stamped with the model version that generated it');
        assert_contains('n=', (string) $row['dataset_version'], 'dataset version stamped');

        // model versioning: exactly one v1.0 row, idempotent, config complete
        $versions = $intel->modelVersions();
        assert_equals(1, count($versions));
        assert_equals('WINDELS Lottery Model', $versions[0]['model_name']);
        assert_equals('1.0', $versions[0]['model_version']);
        $cfg = $versions[0]['config'];
        assert_true(is_array($cfg) && isset($cfg['scoreWeights']), 'config stores the statistical configuration');
        assert_close(0.30, (float) $cfg['scoreWeights']['sum'], 0.0001, 'score weights recorded');
        assert_equals(CombinationGenerator::MODES, $cfg['generatorModes']);
        assert_equals(LotteryBacktester::STRATEGIES, $cfg['backtesterStrategies']);
        $again = $intel->ensureModelVersion();
        assert_equals((int) $versions[0]['id'], (int) $again['id'], 'ensure is idempotent — the same row is returned, never replaced');
        assert_equals(1, count($intel->modelVersions()), 'still exactly one version');

        // a comparison is persisted like any other backtest row
        $cmp = $intel->backtestCompare(['RANDOM_BASELINE', 'BALANCED_PROFILE']);
        assert_equals('COMPARISON', $intel->backtestDetail((int) $cmp['saved']['backtestId'])['strategy']);

        // performance overview: three separated sections (spec §30)
        $perf = $intel->performance();
        assert_equals('ACTUAL TICKET RESULTS', $perf['actualTicketResults']['section']);
        assert_equals('HISTORICAL BACKTEST RESULTS', $perf['historicalBacktestResults']['section']);
        assert_equals('DEMO / SANDBOX DATA', $perf['demoSandboxData']['section']);
        assert_true($perf['historicalBacktestResults']['count'] >= 2);
        $strategiesRecent = array_map(fn($x) => $x['strategy'], $perf['historicalBacktestResults']['recent']);
        assert_in_array('RANDOM_BASELINE', $strategiesRecent);
        assert_true($perf['demoSandboxData']['synthetic'] === true, 'sandbox data explicitly labeled synthetic');
        assert_contains('never mixed', $perf['separationNote']);
        assert_true($perf['actualTicketResults']['ticketsChecked'] <= $perf['actualTicketResults']['ticketsTotal']);
        assert_true(is_string($perf['disclaimer']) && $perf['disclaimer'] !== '');

        // every run audited
        $ev = array_values(array_filter($model->audit->recent(200), fn($e) => ($e['type'] ?? '') === 'LOTTERY_BACKTEST_RUN'));
        assert_true(count($ev) >= 2, 'backtest runs are audited');
    } finally {
        putenv('WINDELS_LOTTERY_SANDBOX');
    }
});

test('lottery cron backtests: one run per strategy per day, idempotent', function () {
    $model = platform()->model;
    putenv('WINDELS_LOTTERY_SANDBOX=1');
    try {
        $intel = new LotteryIntelligence($model->lottery, $model->audit, new SandboxLotteryProvider(42));
        $cron = new LotteryCronService($model->lottery, $model->audit, $intel);
        $date = '2026-08-23';
        $before = count($model->lottery->listBacktests(500));
        $out = $cron->run('backtests', $date);
        assert_equals('OK', $out['status']);
        assert_equals(4, $out['ran'], 'one backtest per strategy on the first run of the day');
        assert_equals(0, $out['skipped']);
        $after = count($model->lottery->listBacktests(500));
        assert_equals($before + 4, $after, 'four rows — one per strategy');
        foreach (LotteryBacktester::STRATEGIES as $s) {
            $run = $model->lottery->findJobRunByKey('backtest:EUROMILLIONS:' . $s . ':' . $date);
            assert_not_null($run, 'job run row exists for ' . $s);
            assert_equals('backtest', (string) $run['job_type']);
            assert_equals('OK', (string) $run['status']);
        }
        // same day again: execution keys make it a no-op
        $out2 = $cron->run('backtests', $date);
        assert_equals(0, $out2['ran'], 're-run on the same day creates nothing');
        assert_equals(4, $out2['skipped']);
        assert_equals($after, count($model->lottery->listBacktests(500)), 'no duplicate backtest rows');
    } finally {
        putenv('WINDELS_LOTTERY_SANDBOX');
    }
});

test('lottery backtesting: routes, RBAC, feature matrix, honesty scan', function () {
    $routes = file_get_contents(FCPATH . 'application/config/routes.php');
    assert_contains("\$route['api/lottery/backtests'] = 'api_lottery/backtests';", $routes);
    assert_contains("\$route['api/lottery/backtests/(:num)'] = 'api_lottery/show_backtest/\$1';", $routes);
    assert_contains("\$route['api/lottery/backtest'] = 'api_lottery/backtest';", $routes);
    assert_contains("\$route['api/lottery/backtest-compare'] = 'api_lottery/backtest_compare';", $routes);
    assert_contains("\$route['api/lottery/models'] = 'api_lottery/models';", $routes);
    assert_contains("\$route['api/lottery/performance'] = 'api_lottery/performance';", $routes);

    $c = file_get_contents(FCPATH . 'application/controllers/Api_lottery.php');
    assert_true(substr_count($c, "requirePermission('lottery.view')") >= 4, 'backtest mutations use lottery.view + session CSRF');
    assert_true(substr_count($c, "requirePermission('lottery.view', false)") >= 11, 'backtest reads use lottery.view without CSRF');

    require_once FCPATH . 'application/controllers/Api_system.php';
    $rows = array_filter(Api_system::FEATURES, fn($x) => str_contains($x['name'], 'Lottery Backtesting'));
    assert_equals(1, count($rows));
    assert_equals('IMPLEMENTED', array_values($rows)[0]['status']);

    // honesty scan of the files in this increment
    foreach ([
        'application/libraries/Aegis/Lottery/LotteryBacktester.php',
        'application/libraries/Aegis/Lottery/LotteryCronService.php',
        'application/controllers/Api_lottery.php',
    ] as $file) {
        $src = strtolower(file_get_contents(FCPATH . $file));
        foreach (['guarantee', 'win chance', 'win probability', 'winning numbers', 'certain win', 'secret formula', 'sure win', 'jackpot prediction', '90% chance', 'ai knows the next draw', 'predict'] as $banned) {
            assert_false(str_contains($src, $banned), $file . ' contains banned wording: ' . $banned);
        }
    }
});
