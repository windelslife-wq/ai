<?php
/** Lottery provider health, AI decision reporting and console governance. */
use Aegis\Lottery\LotteryIntelligence;
use Aegis\Lottery\SandboxLotteryProvider;
use Aegis\Lottery\UnavailableLotteryProvider;

/** Render the Lottery page using the real dashboard shell and supplied fixtures. */
function fx_render_lottery_console(array $extra = []): string
{
    $ci = ci();
    $data = array_merge([
        'title' => 'Lottery Operations',
        'active' => 'lottery',
        'csrfToken' => 'test-csrf-token',
        'canView' => true,
        'canManage' => false,
        'status' => ['tradingMode' => 'ANALYSIS_ONLY', 'killSwitch' => ['active' => false], 'providers' => []],
        'lotteryStatus' => [
            'activeLottery' => 'EUROMILLIONS', 'engine' => LotteryIntelligence::ENGINE_DISABLED,
            'drawsTracked' => 0, 'lastDraw' => null, 'modelVersion' => LotteryIntelligence::MODEL_VERSION,
            'rules' => ['version' => '1.0', 'main' => ['count' => 5, 'min' => 1, 'max' => 50], 'stars' => ['count' => 2, 'min' => 1, 'max' => 12]],
            'disclaimer' => 'Every draw is an independent random event.',
        ],
        'providerHealth' => [
            'provider' => 'unconfigured',
            'live' => ['state' => 'UNCONFIGURED', 'licensed' => false, 'synthetic' => false, 'message' => 'No provider configured.'],
            'latest' => null,
            'history' => [],
        ],
        'providers' => [],
        'decisions' => [],
        'notice' => null,
        'error' => null,
    ], $extra);
    ob_start();
    $ci->load->view('layout/header', $data);
    $ci->load->view('lottery/index', $data);
    $ci->load->view('layout/footer');
    return (string) ob_get_clean();
}

test('lottery health probe records the live state, provider history and acting administrator', function () {
    $repo = new LotteryRepositoryStub();
    $audit = fx_lotto_audit();
    $intel = new LotteryIntelligence($repo, $audit, new UnavailableLotteryProvider());

    // Passive health reads do not create provider registry rows or history.
    $passive = $intel->providerHealth();
    assert_equals('UNCONFIGURED', $passive['live']['state']);
    assert_equals(0, count($repo->providers));
    assert_equals([], $passive['history']);

    $source = $repo->ensureProvider('unconfigured', 'No lottery data provider configured');
    $repo->saveHealth((int) $source['id'], ['status' => 'ONLINE', 'last_draw_retrieved' => '2026-09-25']);
    $probe = $intel->probeProvider('operator-7');
    assert_equals('UNCONFIGURED', $probe['live']['state']);
    assert_true($probe['persisted']);
    assert_equals('UNCONFIGURED', $probe['latest']['status']);
    assert_equals(2, count($probe['history']));
    assert_equals('unconfigured', $repo->providers[0]['provider_code']);
    assert_equals('2026-09-25', $probe['latest']['last_draw_retrieved'], 'health probes preserve the last retrieved-draw marker');
    $stored = $intel->providerHealth();
    assert_equals('UNCONFIGURED', $stored['latest']['status']);
    $event = end($audit->events);
    assert_equals('LOTTERY_PROVIDER_HEALTH_PROBED', $event['type']);
    assert_equals('operator-7', $event['actor']);
    assert_false((bool) $event['detail']['synthetic']);
});

test('lottery health probe labels sandbox data and never changes provider enablement', function () {
    $repo = new LotteryRepositoryStub();
    $audit = fx_lotto_audit();
    $intel = new LotteryIntelligence($repo, $audit, new SandboxLotteryProvider(12));
    $before = getenv('WINDELS_LOTTERY_SANDBOX');
    putenv('WINDELS_LOTTERY_SANDBOX=1');
    try {
        $probe = $intel->probeProvider('operator-8');
        assert_equals('ONLINE', $probe['live']['state']);
        assert_true($probe['live']['synthetic']);
        assert_equals(1, (int) $probe['latest']['synthetic']);
        assert_equals(0, (int) $repo->providers[0]['enabled'], 'a health probe is not a provider-activation control');
        assert_true(str_contains($probe['live']['message'], 'NOT official'));
    } finally {
        $before === false ? putenv('WINDELS_LOTTERY_SANDBOX') : putenv('WINDELS_LOTTERY_SANDBOX=' . $before);
    }
});

test('AI decision report list and detail return the exact persisted generation report', function () {
    $repo = new LotteryRepositoryStub();
    $audit = fx_lotto_audit();
    $intel = new LotteryIntelligence($repo, $audit, new UnavailableLotteryProvider());
    $report = $intel->generate(['mode' => 'RANDOM', 'count' => 2, 'seed' => 991]);
    $saved = $intel->saveGeneration($report, '19');

    $list = $intel->listDecisions(null, 999);
    assert_equals(1, count($list), 'list is bounded and returns the stored report');
    assert_equals($saved['decisionId'], (int) $list[0]['id']);
    assert_equals($saved['combinationId'], (int) $list[0]['combination_id']);
    assert_equals(991, $list[0]['decision']['inputs']['seed']);
    assert_equals($report['factors'], $list[0]['decision']['factors']);
    assert_equals(1, count($intel->listDecisions($saved['combinationId'], 5)));
    assert_equals($list[0], $intel->decisionDetail($saved['decisionId']));
    assert_null($intel->decisionDetail(999999));
});

test('Lottery APIs, controls and page are routed with view/manage permission and CSRF guards', function () {
    require_once FCPATH . 'application/controllers/Api_lottery.php';
    require_once FCPATH . 'application/controllers/Lottery.php';
    $routes = file_get_contents(FCPATH . 'application/config/routes.php');
    $api = file_get_contents(FCPATH . 'application/controllers/Api_lottery.php');
    $page = file_get_contents(FCPATH . 'application/controllers/Lottery.php');
    $view = file_get_contents(FCPATH . 'application/views/lottery/index.php');
    $script = file_get_contents(FCPATH . 'assets/js/lottery-console.js');
    $header = file_get_contents(FCPATH . 'application/views/layout/header.php');

    assert_contains("\$route['lottery'] = 'lottery/index';", $routes);
    assert_contains("\$route['api/lottery/ai-decisions'] = 'api_lottery/ai_decisions';", $routes);
    assert_contains("\$route['api/lottery/ai-decisions/(:num)'] = 'api_lottery/show_ai_decision/\$1';", $routes);
    assert_contains("\$route['api/lottery/providers/check'] = 'api_lottery/provider_check';", $routes);
    assert_contains("requirePermission('lottery.view', false)", $api);
    assert_contains("requirePostPermission('lottery.manage')", $api, 'admin mutations require an explicit POST and CSRF');
    assert_contains("!== 'POST'", $api, 'GET cannot trigger an administrative action');
    assert_contains('can($this->identity, \'lottery.view\')', $page);
    assert_contains('LOTTERY_ADMIN_SYNC', $api);
    assert_contains('LOTTERY_PROVIDER_HEALTH_PROBED', file_get_contents(FCPATH . 'application/libraries/Aegis/Lottery/LotteryIntelligence.php'));
    assert_contains('data-endpoint="/api/lottery/providers/check"', $view);
    assert_contains('data-endpoint="/api/lottery/sync"', $view);
    assert_contains('X-CSRF-Token', $script);
    assert_contains('href="/lottery"', $header);
    assert_contains('Lottery Console', $header);
});

test('Lottery console renders health and full AI reports safely on desktop and mobile layouts', function () {
    $report = [
        'model' => 'WINDELS Lottery Model v1.0',
        'mode' => 'RANDOM',
        'inputs' => ['seed' => 812, 'rulesVersion' => '1.0', 'datasetVersion' => 'n=0;last=none'],
        'factors' => ['method' => 'uniform seeded sampling without replacement'],
        'lines' => [['mains' => [1, 2, 3, 4, 5], 'stars' => [6, 7]]],
        'hostileText' => '<script>alert(1)</script>',
        'disclaimer' => 'Every draw is independent.',
    ];
    $html = fx_render_lottery_console([
        'canManage' => true,
        'providerHealth' => [
            'provider' => 'sandbox-sim',
            'live' => ['state' => 'ONLINE', 'licensed' => false, 'synthetic' => true, 'message' => 'Simulated draws only.'],
            'latest' => ['status' => 'ONLINE', 'response_ms' => 3, 'observed_at' => '2026-10-05T12:00:00+00:00', 'synthetic' => 1],
            'history' => [['status' => 'ONLINE', 'response_ms' => 3, 'observed_at' => '2026-10-05T12:00:00+00:00', 'records_received' => 0, 'invalid_records' => 0, 'synthetic' => 1]],
        ],
        'decisions' => [[
            'id' => 4, 'combination_id' => 3, 'model_version' => 'WINDELS Lottery Model v1.0',
            'mode' => 'RANDOM', 'created_at' => '2026-10-05T12:00:00+00:00', 'decision' => $report,
        ]],
    ]);
    assert_contains('Provider health', $html);
    assert_contains('AI decision reports', $html);
    assert_contains('Simulated draws only.', $html);
    assert_contains('SYNTHETIC', $html);
    assert_contains('uniform seeded sampling without replacement', $html);
    assert_contains('1 · 2 · 3 · 4 · 5', $html);
    assert_contains('&lt;script&gt;alert(1)&lt;/script&gt;', $html, 'JSON report data is escaped in HTML');
    assert_false(str_contains($html, '<script>alert(1)</script>'), 'report payload cannot inject markup');

    $css = file_get_contents(FCPATH . 'assets/css/aegis.css');
    assert_contains('@media (max-width: 680px)', $css, 'console grids and actions adapt to phone widths');
    assert_contains('.lottery-decision-table { min-width:', $css, 'tables remain horizontally scrollable on narrow screens');
});
