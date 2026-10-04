<?php
use Aegis\Sports\MatchIntelligenceEngine;
use Aegis\Sports\OddsFreshnessEngine;

test('odds freshness rejects unavailable and stale odds', function () {
    $engine = new OddsFreshnessEngine();
    assert_equals('ODDS_UNAVAILABLE', $engine->assess(null)['reason']);
    $stale = $engine->assess(['observedAt' => '2026-01-01T00:00:00Z'], 900, strtotime('2026-01-01T01:00:00Z'));
    assert_false($stale['fresh']); assert_equals('STALE_ODDS', $stale['reason']);
});
test('match intelligence returns no qualified ticket when critical verified data is absent', function () {
    $intelligence = new MatchIntelligenceEngine();
    $out = $intelligence->analyze(['homeTeam' => 'Home', 'awayTeam' => 'Away', 'competition' => 'League', 'kickoff' => '2026-09-01T12:00:00Z', 'status' => 'SCHEDULED'], null, [], strtotime('2026-09-01T10:00:00Z'));
    assert_equals('NO_QUALIFIED_TICKET', $out['decision']); assert_contains('ODDS_UNAVAILABLE', implode(',', $out['rejectionReasons']));
});
test('match intelligence is ready only with fresh odds and supplied verified form', function () {
    $out = (new MatchIntelligenceEngine())->analyze(['homeTeam' => 'Home', 'awayTeam' => 'Away', 'competition' => 'League', 'kickoff' => '2026-09-01T12:00:00Z', 'status' => 'SCHEDULED'], ['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'decimalOdds' => 1.5, 'observedAt' => '2026-09-01T10:00:00Z'], ['recentForm' => ['source' => 'verified-feed']], strtotime('2026-09-01T10:01:00Z'));
    assert_equals('INTELLIGENCE_READY', $out['decision']);
});
