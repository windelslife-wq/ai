<?php
use Aegis\Persistence\AuditRepository;
use Aegis\Sports\FeatureEngineeringEngine;
use Aegis\Sports\PredictionEngine;
use Aegis\Sports\SportsIntelligence;

function fx_ui_audit(): AuditRepository
{
    return new class implements AuditRepository { public array $events = []; public function emit(string $t, string $s, array $d = [], string $a = 'system'): void { $this->events[] = ['type' => $t, 'actor' => $a, 'detail' => $d]; } public function recent(int $l = 100): array { return []; } };
}

/** Render console views (header + page + footer) and return the HTML. */
function fx_render_sports(string $page, array $extra): string
{
    $ci = ci();
    $data = array_merge([
        'title' => 'Sports Intelligence', 'active' => 'sports',
        'status' => ['tradingMode' => 'ANALYSIS_ONLY', 'killSwitch' => ['active' => false], 'providers' => []],
        'notice' => null, 'error' => null,
    ], $extra);
    ob_start();
    $ci->load->view('layout/header', $data);
    $ci->load->view('sports/' . $page, $data);
    $ci->load->view('layout/footer');
    return (string) ob_get_clean();
}

/** Seed a complete "today" state: provider, fixture, approved calibration, pending ticket. */
function fx_ui_today(SportsRepositoryStub $repo): string
{
    $repo->ensureProvider('ui-test', 'UI Test');
    $repo->saveHealth(1, ['status' => 'ONLINE', 'reliability' => 0.9]);
    $modelId = $repo->ensureModelVersion(['modelName' => PredictionEngine::MODEL_NAME, 'modelVersion' => PredictionEngine::MODEL_VERSION, 'featureVersion' => FeatureEngineeringEngine::VERSION]);
    $repo->saveCalibration(['model_version_id' => $modelId, 'method' => 'platt', 'intercept' => 0.2, 'slope' => 1.5, 'samples' => 40, 'ece' => 0.02, 'status' => 'APPROVED', 'created_by' => 'admin', 'created_at' => gmdate('c')]);

    // kickoff TODAY at 15:00 UTC — inside dashboard()'s [todayT00:00:00, todayT23:59:59] window
    // regardless of the run time. Double quotes so \T stays a literal T (gmdate's T = tz abbreviation).
    $kickoff = gmdate("Y-m-d\TH:i:00+00:00", strtotime('today 15:00:00'));
    $repo->matches[] = ['id' => 9001, 'provider_id' => 1, 'external_id' => 'ui-1', 'sport' => 'football', 'competition' => 'UI League', 'home_team' => 'HomeA', 'away_team' => 'AwayA', 'kickoff_at' => $kickoff, 'status' => 'SCHEDULED', 'source_timestamp' => gmdate('c'), 'payload' => ['context' => ['recentForm' => ['homeGoalsPerMatch' => 1.6, 'awayGoalsPerMatch' => 1.4, 'homeConcededPerMatch' => 1.0, 'awayConcededPerMatch' => 0.9, 'source' => 'test'], 'marketLiquidity' => 50000]]];

    $ticketId = 'tkt_ui_0001';
    $repo->saveTicket(['id' => $ticketId, 'created_at' => gmdate('c'), 'model_version_id' => $modelId, 'configuration_version' => '0', 'total_odds' => 6.4, 'selection_count' => 2, 'combined_probability' => 0.15, 'confidence' => 88.0, 'risk' => 'LOW', 'correlation' => 'LOW', 'data_quality_score' => 100, 'status' => 'PENDING', 'approval_status' => 'PENDING_USER_APPROVAL', 'settlement_status' => 'PENDING', 'stake' => 10.0, 'pnl' => null]);
    $repo->saveTicketSelection(['ticket_id' => $ticketId, 'prediction_id' => 'prd_ui_1', 'match_id' => 9001, 'market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'odds' => 2.0, 'odds_timestamp' => gmdate('c'), 'model_probability' => 0.7, 'calibrated_probability' => 0.75, 'expected_value' => 0.5, 'risk' => 'LOW', 'result' => null, 'status' => 'PENDING']);
    $repo->savePrediction(['id' => 'prd_ui_1', 'match_id' => 9001, 'model_version_id' => $modelId, 'market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'raw_probability' => 0.7, 'calibrated_probability' => 0.75, 'expected_value' => 0.5, 'confidence' => 88.0, 'risk' => 'LOW', 'correlation' => 'LOW', 'data_quality_score' => 100, 'decision' => 'PREDICTION_READY', 'rejection_reasons' => '[]', 'factors' => json_encode(['gate' => ['passed' => []], 'drivers' => ['expectedGoalsProxy' => 2.45]]), 'input_version' => FeatureEngineeringEngine::VERSION, 'odds' => 2.0, 'odds_timestamp' => gmdate('c'), 'created_at' => gmdate('c')]);
    $repo->saveDailyTicket(['date' => gmdate('Y-m-d'), 'ticket_id' => $ticketId, 'status' => 'PENDING_USER_APPROVAL', 'configuration_version' => 0, 'candidates_evaluated' => 1, 'predictions_recorded' => 1, 'rejections' => 0, 'rejection_summary' => json_encode([]), 'message' => 'ticket generated; awaiting user approval', 'provider' => 'ui-test', 'run_id' => 'run_ui', 'created_at' => gmdate('c'), 'updated_at' => gmdate('c')]);
    return $ticketId;
}

test('sports UI: console routes and controller are wired', function () {
    $routes = file_get_contents(FCPATH . 'application/config/routes.php');
    assert_contains('$route[\'sports\'] = \'sports\';', $routes);
    assert_contains('$route[\'sports/tickets\'] = \'sports/tickets\';', $routes);
    assert_contains('$route[\'sports/(:any)/decide\'] = \'sports/decide/$1\';', $routes);
    assert_contains('$route[\'sports/(:any)/settle\'] = \'sports/settle/$1\';', $routes);
    $controller = file_get_contents(FCPATH . 'application/controllers/Sports.php');
    foreach (['public function index()', 'public function tickets()', 'public function decide(string $id)', 'public function settle(string $id)'] as $m) assert_contains($m, $controller);
    // mutations must enforce the sports RBAC matrix
    assert_contains("requireSportsPermission('sports.approve'", $controller);
    assert_contains("requireSportsPermission('sports.settle'", $controller);
});

test('sports UI: console header links the Sports page', function () {
    $header = file_get_contents(FCPATH . 'application/views/layout/header.php');
    assert_contains('href="/sports"', $header);
    assert_contains("=== 'sports'", $header);
});

test('sports UI: dashboard renders the honest DISABLED_NO_PROVIDER state', function () {
    $repo = new SportsRepositoryStub();
    $intel = new SportsIntelligence($repo, fx_ui_audit());
    $dash = $intel->dashboard();
    assert_equals('DISABLED_NO_PROVIDER', $dash['systemStatus']['ticketEngine']);
    $html = fx_render_sports('index', ['dashboard' => $dash]);
    assert_contains('Sports Intelligence — daily ticket engine', $html);
    assert_contains('DISABLED_NO_PROVIDER', $html);
    assert_contains('No providers registered', $html);
    assert_contains('</html>', $html);
});

test('sports UI: dashboard renders today ticket with gated actions', function () {
    $repo = new SportsRepositoryStub();
    $ticketId = fx_ui_today($repo);
    $intel = new SportsIntelligence($repo, fx_ui_audit());
    $dash = $intel->dashboard();
    assert_equals(1, $dash['todayIntelligence']['upcomingCount']);
    assert_equals(1, $dash['todayIntelligence']['qualifiedPredictions']);
    $html = fx_render_sports('index', ['dashboard' => $dash]);
    assert_contains($ticketId, $html);
    assert_contains('PENDING_USER_APPROVAL', $html);
    assert_contains('HomeA vs AwayA', $html);
    // the approval forms post to the routed decide endpoint
    assert_contains('/sports/' . $ticketId . '/decide', $html);
    assert_contains('sports.approve', $html);
    assert_contains('sports.settle', $html);
    assert_contains('UI League', $html);
});

test('sports UI: tickets console renders tickets, runs and performance', function () {
    $repo = new SportsRepositoryStub();
    $ticketId = fx_ui_today($repo);
    $intel = new SportsIntelligence($repo, fx_ui_audit());
    $html = fx_render_sports('tickets', [
        'tickets' => $repo->listTickets([], 100),
        'dailyRuns' => $repo->listDailyTickets(30),
        'performance' => $intel->performanceReport([]),
    ]);
    assert_contains($ticketId, $html);
    assert_contains('PENDING_USER_APPROVAL', $html);
    assert_contains('awaiting user approval', $html);
    assert_contains('/sports/' . $ticketId . '/settle', $html);
    assert_contains('DEMO / SANDBOX DATA', $html, 'sandbox statistics are clearly labeled');
    assert_true(!str_contains($html, 'No tickets generated yet'), 'seeded ticket must be listed, not the empty state');
});
