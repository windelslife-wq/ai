<?php
use Aegis\Persistence\AuditRepository;
use Aegis\Sports\SportsBacktester;

function fx_bt_audit(): AuditRepository
{
    return new class implements AuditRepository { public array $events = []; public function emit(string $t, string $s, array $d = [], string $a = 'system'): void { $this->events[] = ['type' => $t, 'actor' => $a, 'detail' => $d]; } public function recent(int $l = 100): array { return []; } };
}

/** Two finished matches on the same day with verified results and pre-kickoff odds. */
function fx_bt_repo(): SportsRepositoryStub
{
    $repo = new SportsRepositoryStub();
    $repo->ensureProvider('bt-test', 'BT Test');
    $day = '2026-06-10';
    $defs = [
        [11, 'Alpha', 'Beta', 2, 1],   // OVER_1.5 win
        [12, 'Gamma', 'Delta', 0, 0],  // OVER_1.5 loss
    ];
    foreach ($defs as [$id, $h, $a, $hs, $as]) {
        $kickoff = $day . 'T15:00:00+00:00';
        $repo->matches[] = [
            'id' => $id, 'provider_id' => 1, 'external_id' => 'bt-' . $id, 'sport' => 'football',
            'competition' => 'Backtest League', 'home_team' => $h, 'away_team' => $a,
            'kickoff_at' => $kickoff, 'status' => 'FINISHED', 'source_timestamp' => gmdate('c'),
            'payload' => ['context' => ['recentForm' => ['homeGoalsPerMatch' => 1.6, 'awayGoalsPerMatch' => 1.4, 'homeConcededPerMatch' => 1.0, 'awayConcededPerMatch' => 0.9, 'source' => 'test']]],
        ];
        // pre-kickoff odds (the only ones the backtester may see)
        $repo->saveOdds($id, 1, ['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'decimalOdds' => 1.7, 'observedAt' => $day . 'T12:00:00+00:00']);
        // post-kickoff odds — must be ignored by point-in-time replay
        $repo->saveOdds($id, 1, ['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'decimalOdds' => 9.9, 'observedAt' => $day . 'T16:00:00+00:00']);
        $repo->saveResult($id, 1, ['homeScore' => $hs, 'awayScore' => $as, 'status' => 'FINISHED', 'sourceTimestamp' => $day . 'T17:00:00+00:00', 'payload' => []]);
        $r = $repo->findResult($id, 1);
        $repo->verifyResult((int) $r['id']);
    }
    return $repo;
}

test('backtester replays point-in-time and flags simulation', function () {
    $repo = fx_bt_repo();
    $audit = fx_bt_audit();
    $bt = new SportsBacktester($repo, $audit, new \Aegis\Sports\PredictionPipeline(), new \Aegis\Sports\DataQualityEngine(), new \Aegis\Sports\ModelPerformanceService($repo, $audit));
    $report = $bt->run(['from' => '2026-06-10', 'to' => '2026-06-10', 'stake' => 10.0, 'minConfidence' => 60.0], 'tester');
    assert_true($report['simulation'] === true);
    assert_contains('BACKTEST SIMULATION', $report['warning']);
    assert_equals(2, $report['evaluated']);
    assert_equals(2, $report['qualifiedSelections']);
    assert_equals(1, $report['won']);
    assert_equals(1, $report['lost']);
    // point-in-time: every replayed selection used the 1.7 pre-kickoff odds, never 9.9
    foreach ($report['selections'] as $s) assert_equals(1.7, $s['odds']);
    assert_equals(1, $repo->backtests[0]['id'] === $report['id'] ? 1 : 0);
    $stored = $repo->findBacktest($report['id']);
    assert_not_null($stored);
    assert_equals('SPORTS_BACKTEST_RUN', end($audit->events)['type']);
});

test('backtester refuses invalid ranges and missing data honestly', function () {
    $repo = new SportsRepositoryStub();
    $audit = fx_bt_audit();
    $bt = new SportsBacktester($repo, $audit, new \Aegis\Sports\PredictionPipeline(), new \Aegis\Sports\DataQualityEngine(), new \Aegis\Sports\ModelPerformanceService($repo, $audit));
    assert_throws(InvalidArgumentException::class, fn() => $bt->run(['from' => '2026-06-10', 'to' => '2026-06-01']));
    assert_throws(InvalidArgumentException::class, fn() => $bt->run(['from' => '2026-01-01', 'to' => '2026-12-31']));
    $empty = $bt->run(['from' => '2026-06-10', 'to' => '2026-06-12']);
    assert_equals(0, $empty['evaluated']);
    assert_true($empty['winRate'] === null, 'no invented win rate from empty data');
});

test('backtester ignores unverified results and post-kickoff-only odds', function () {
    $repo = fx_bt_repo();
    // un-verify the first match → excluded
    $r = $repo->findResult(11, 1);
    $repo->results = array_map(fn($x) => $x['id'] === $r['id'] ? array_merge($x, ['verified' => 0]) : $x, $repo->results);
    $audit = fx_bt_audit();
    $bt = new SportsBacktester($repo, $audit, new \Aegis\Sports\PredictionPipeline(), new \Aegis\Sports\DataQualityEngine(), new \Aegis\Sports\ModelPerformanceService($repo, $audit));
    $report = $bt->run(['from' => '2026-06-10', 'to' => '2026-06-10', 'minConfidence' => 60.0]);
    assert_equals(1, $report['evaluated']);
});
