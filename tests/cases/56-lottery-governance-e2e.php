<?php
/**
 * WINDELS Lottery Intelligence — Phases 2/5/26/28/31/33: governance and
 * end-to-end wiring. Routes + RBAC + honest feature matrix, real
 * persistence round trip, idempotent cron, provider health.
 */
use Aegis\Lottery\LotteryCronService;
use Aegis\Lottery\LotteryIntelligence;
use Aegis\Lottery\SandboxLotteryProvider;

test('lottery api: routes, RBAC matrix and honest feature matrix', function () {
    $routes = file_get_contents(FCPATH . 'application/config/routes.php');
    assert_contains("\$route['api/lottery/status'] = 'api_lottery/status';", $routes);
    assert_contains("\$route['api/lottery/draws/(:num)'] = 'api_lottery/show_draw/\$1';", $routes);
    assert_contains("\$route['api/lottery/statistics/(:any)'] = 'api_lottery/statistics/\$1';", $routes);
    assert_contains("\$route['api/lottery/sync'] = 'api_lottery/sync';", $routes);

    $c = file_get_contents(FCPATH . 'application/controllers/Api_lottery.php');
    assert_contains("requirePermission('lottery.view', false)", $c, 'reads require lottery.view');
    assert_contains("requirePermission('lottery.manage')", $c, 'sync requires lottery.manage + CSRF (csrf default true)');
    assert_true(!str_contains($c, 'WIN CHANCE') && !str_contains($c, 'predict'), 'API exposes no prediction claims');

    $rbac = file_get_contents(FCPATH . 'tools/rbac.php');
    assert_contains("'lottery.view' => 'View lottery intelligence", $rbac);
    assert_contains("'lottery.manage' => 'Manage lottery providers", $rbac);
    assert_contains("'lottery_admin' => ['lottery.view', 'lottery.manage']", $rbac);
    assert_contains("'lottery_viewer' => ['lottery.view']", $rbac);

    require_once FCPATH . 'application/controllers/Api_system.php';
    $names = array_map(fn($x) => $x['name'], Api_system::FEATURES);
    assert_true(in_array('Lottery Intelligence — EuroMillions foundation', $names, true), 'foundation row present');
    $live = array_filter(Api_system::FEATURES, fn($x) => str_contains($x['name'], 'Lottery data providers') && $x['status'] === 'IMPLEMENTED');
    assert_equals(0, count($live), 'no live official lottery provider is claimed');
});

test('lottery db: end-to-end import, stats and idempotent cron through real persistence', function () {
    $p = platform();
    $model = $p->model;
    $intel = new LotteryIntelligence($model->lottery, $model->audit, new SandboxLotteryProvider(11));
    putenv('WINDELS_LOTTERY_SANDBOX=1');
    try {
        $before = $model->lottery->countDraws('EUROMILLIONS');
        $sum = $intel->sync(8);
        assert_equals('OK', $sum['status']);
        assert_true($sum['imported'] > 0);
        assert_equals($before + $sum['imported'], $model->lottery->countDraws('EUROMILLIONS'));

        // statistics through the real DB round trip
        $stats = $intel->statistics('numbers', 0);
        assert_equals($before + $sum['imported'], $stats['totalDraws']);
        assert_true(str_contains($stats['disclaimer'], 'independent'));
        $dist = $intel->statistics('distribution');
        assert_equals($before + $sum['imported'], $dist['totalDraws']);
        $pairs = $intel->statistics('pairs');
        assert_true(count($pairs['top']) > 0);

        // draw detail round trips with normalized numbers
        $rows = $intel->listDraws(1);
        assert_equals(1, count($rows));
        $detail = $intel->drawDetail((int) $rows[0]['id']);
        assert_not_null($detail);
        assert_equals(7, count($detail['numbers']));
        assert_equals('VERIFIED', $detail['verification_status']);
        assert_equals('sandbox-simulation', $detail['source']);

        // idempotent cron: same execution key on the second run is a no-op
        $cron = new LotteryCronService($model->lottery, $model->audit, $intel);
        $first = $cron->run('sync');
        assert_true($first['status'] !== 'FAILED', 'first cron sync completed: ' . ($first['status'] ?? ''));
        $second = $cron->run('sync');
        assert_equals('ALREADY_RUN', $second['status'], 'second sync run is a no-op (idempotent execution key)');
        $runs = $model->lottery->listJobRuns('sync', 10);
        assert_equals(1, count($runs), 'exactly one job run row per execution key');

        // health job reports on the labeled sandbox
        $h = $cron->run('health');
        assert_in_array($h['status'], ['ONLINE', 'DEGRADED']);
        assert_equals('sandbox-sim', $h['provider']);

        // integrity sweep: every stored draw passes the rules
        $integrity = $cron->run('statistics');
        assert_equals(0, $integrity['violations']);

        // status reflects the live module state
        $s = $intel->status();
        assert_equals('ACTIVE', $s['engine']);
        assert_equals('ONLINE', $s['provider']['state']);
        assert_true($s['provider']['synthetic'], 'sandbox clearly labeled synthetic in status');
        assert_equals($model->lottery->countDraws('EUROMILLIONS'), $s['drawsTracked']);
    } finally {
        putenv('WINDELS_LOTTERY_SANDBOX');
    }
});

test('lottery cron: cleanup prunes old runs and health rows', function () {
    $p = platform();
    $model = $p->model;
    $intel = new LotteryIntelligence($model->lottery, $model->audit, new \Aegis\Lottery\UnavailableLotteryProvider());
    $cron = new LotteryCronService($model->lottery, $model->audit, $intel);
    $out = $cron->run('cleanup');
    assert_equals('OK', $out['status']);
    assert_true(str_contains($out['runCutoff'], '-'), 'cutoff is a date');
});
