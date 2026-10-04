<?php
use Aegis\Sports\CorrelationEngine;
use Aegis\Sports\PredictionPipeline;
use Aegis\Sports\RiskEngine;
use Aegis\Sports\TicketOptimizer;

function fx_gate_match(int $id = 1, array $over = []): array
{
    return array_merge([
        'id' => $id, 'provider_id' => 1, 'external_id' => 'g' . $id,
        'competition' => 'Gate League', 'home_team' => 'Home' . $id, 'away_team' => 'Away' . $id,
        'kickoff_at' => gmdate('Y-m-d\TH:i:00\+00:00', strtotime('+1 day 15:00:00')),
        'status' => 'SCHEDULED', 'source_timestamp' => gmdate('c'),
        'payload' => ['context' => ['recentForm' => ['homeGoalsPerMatch' => 1.6, 'awayGoalsPerMatch' => 1.4, 'homeConcededPerMatch' => 1.0, 'awayConcededPerMatch' => 0.9, 'source' => 'v']]],
    ], $over);
}

function fx_fresh_odds(float $decimal = 1.6, ?int $ageSeconds = null): array
{
    $observed = gmdate('c', $ageSeconds === null ? time() : time() - $ageSeconds);
    return ['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'decimal_odds' => $decimal, 'observed_at' => $observed, 'payload' => []];
}

function fx_gate_quality(int $score = 100): array
{
    return ['score' => $score, 'band' => $score >= 90 ? 'EXCELLENT' : 'GOOD', 'freshnessScore' => 100, 'providerReliabilityScore' => 90, 'eligibleForPrediction' => true, 'eligibleForTicket' => true, 'missing' => [], 'checks' => []];
}

function fx_approved_calibration(): array
{
    return ['id' => 1, 'model_version_id' => 1, 'intercept' => 0.2, 'slope' => 1.5, 'samples' => 40, 'ece' => 0.02, 'status' => 'APPROVED', 'calibrationVersion' => 'test', 'approved_at' => gmdate('c')];
}

/**
 * Gate configuration. A function (not a file-scope variable) so the value is
 * available inside test closures on every PHP runtime.
 */
function fx_gate_config(): array
{
    return ['min_confidence' => 75.0, 'min_data_quality' => 80, 'require_calibration' => 1, 'allowed_markets' => [], 'allowed_leagues' => []];
}

test('pipeline: qualified candidate carries full decision factors', function () {
    $out = (new PredictionPipeline())->evaluate(fx_gate_match(), fx_fresh_odds(1.6), fx_gate_quality(), fx_approved_calibration(), fx_gate_config());
    assert_equals('QUALIFIED', $out['decision']);
    assert_equals([], $out['rejectionReasons']);
    $f = $out['factors'];
    assert_true(isset($f['drivers']['expectedGoalsProxy']));
    assert_true(isset($f['odds']['decimal']) && $f['odds']['decimal'] > 1.0);
    assert_true(isset($f['calibration']['intercept']));
    assert_true(isset($f['gate']['passed']));
    assert_true($out['confidence']['confidence'] >= 75.0);
    assert_true($out['value']['qualified']);
    assert_true($out['value']['expectedValue'] > 0);
});

test('pipeline: stale odds → STALE_ODDS rejection', function () {
    $out = (new PredictionPipeline())->evaluate(fx_gate_match(), fx_fresh_odds(1.6, 7200), fx_gate_quality(), fx_approved_calibration(), fx_gate_config());
    assert_equals('REJECTED', $out['decision']);
    assert_contains('STALE_ODDS', implode(',', $out['rejectionReasons']));
});

test('pipeline: missing verified form → INSUFFICIENT_DATA rejection', function () {
    $match = fx_gate_match();
    $match['payload'] = ['context' => []];
    $out = (new PredictionPipeline())->evaluate($match, fx_fresh_odds(1.6), fx_gate_quality(), fx_approved_calibration(), fx_gate_config());
    assert_equals('REJECTED', $out['decision']);
    assert_contains('INSUFFICIENT_DATA', implode(',', $out['rejectionReasons']));
});

test('pipeline: unavailable odds → ODDS_UNAVAILABLE, never invented', function () {
    $out = (new PredictionPipeline())->evaluate(fx_gate_match(), null, fx_gate_quality(), fx_approved_calibration(), fx_gate_config());
    assert_equals('REJECTED', $out['decision']);
    assert_contains('ODDS_UNAVAILABLE', implode(',', $out['rejectionReasons']));
});

test('pipeline: unapproved calibration → MODEL_NOT_CALIBRATED', function () {
    $out = (new PredictionPipeline())->evaluate(fx_gate_match(), fx_fresh_odds(1.6), fx_gate_quality(), null, fx_gate_config());
    assert_equals('REJECTED', $out['decision']);
    assert_contains('MODEL_NOT_CALIBRATED', implode(',', $out['rejectionReasons']));
});

test('pipeline: market outside configured list → OUTSIDE_CONFIGURATION', function () {
    $cfg2 = array_merge(fx_gate_config(), ['allowed_markets' => ['1X2']]);
    $out = (new PredictionPipeline())->evaluate(fx_gate_match(), fx_fresh_odds(1.6), fx_gate_quality(), fx_approved_calibration(), $cfg2);
    assert_contains('OUTSIDE_CONFIGURATION', implode(',', $out['rejectionReasons']));
    $cfg3 = array_merge(fx_gate_config(), ['allowed_leagues' => ['Other League']]);
    $out3 = (new PredictionPipeline())->evaluate(fx_gate_match(), fx_fresh_odds(1.6), fx_gate_quality(), fx_approved_calibration(), $cfg3);
    assert_contains('OUTSIDE_CONFIGURATION', implode(',', $out3['rejectionReasons']));
});

test('pipeline: low data quality and low confidence are explicit rejections', function () {
    $out = (new PredictionPipeline())->evaluate(fx_gate_match(), fx_fresh_odds(1.6), fx_gate_quality(55), fx_approved_calibration(), fx_gate_config());
    assert_contains('LOW_DATA_QUALITY', implode(',', $out['rejectionReasons']));
    // force low confidence via a near-50/50 probability (weak model signal + low dq)
    $weak = fx_gate_match();
    $weak['payload'] = ['context' => ['recentForm' => ['homeGoalsPerMatch' => 0.6, 'awayGoalsPerMatch' => 0.6, 'homeConcededPerMatch' => 1.4, 'awayConcededPerMatch' => 1.4, 'source' => 'v']]];
    $out2 = (new PredictionPipeline())->evaluate($weak, fx_fresh_odds(1.01), fx_gate_quality(80), fx_approved_calibration(), fx_gate_config());
    assert_equals('REJECTED', $out2['decision']);
});

test('pipeline: suspended market is rejected', function () {
    $odds = fx_fresh_odds(1.6);
    $odds['suspended'] = true;
    $out = (new PredictionPipeline())->evaluate(fx_gate_match(), $odds, fx_gate_quality(), fx_approved_calibration(), fx_gate_config());
    assert_contains('MARKET_SUSPENDED', implode(',', $out['rejectionReasons']));
});

test('correlation: same team across different matches is HIGH', function () {
    $eng = new CorrelationEngine();
    $a = ['matchId' => 1, 'homeTeam' => 'Alpha', 'awayTeam' => 'Beta', 'competition' => 'L1'];
    $b = ['matchId' => 2, 'homeTeam' => 'Gamma', 'awayTeam' => 'Alpha', 'competition' => 'L2'];
    $out = $eng->assess($a, [$b]);
    assert_equals('HIGH', $out['classification']);
    assert_contains('SAME_TEAM', implode(',', $out['reasons']));
    $c = ['matchId' => 3, 'homeTeam' => 'Delta', 'awayTeam' => 'Eps', 'competition' => 'L3'];
    assert_equals('LOW', $eng->assess($a, [$c])['classification']);
    $sameComp = ['matchId' => 4, 'homeTeam' => 'Delta', 'awayTeam' => 'Eps', 'competition' => 'L1'];
    assert_equals('MEDIUM', $eng->assess($a, [$sameComp])['classification']);
});

test('correlation: classifySelections finds the worst pair', function () {
    $eng = new CorrelationEngine();
    $sels = [
        ['matchId' => 1, 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'L1'],
        ['matchId' => 2, 'homeTeam' => 'C', 'awayTeam' => 'D', 'competition' => 'L1'],
        ['matchId' => 3, 'homeTeam' => 'A', 'awayTeam' => 'C', 'competition' => 'L3'],
    ];
    $out = $eng->classifySelections($sels);
    assert_equals('HIGH', $out['classification']);
});

test('risk: volatile odds movement upgrades risk to HIGH', function () {
    $eng = new RiskEngine();
    $value = ['qualified' => true, 'expectedValue' => 0.2, 'odds' => 2.0];
    $quality = ['score' => 100, 'eligibleForTicket' => true];
    $calm = $eng->assess($value, $quality, ['min_data_quality' => 80], ['confidence' => 90, 'oddsMovement' => 0.1]);
    assert_equals('LOW', $calm['classification']);
    $volatile = $eng->assess($value, $quality, ['min_data_quality' => 80], ['confidence' => 90, 'oddsMovement' => 0.6]);
    assert_equals('HIGH', $volatile['classification']);
    assert_false($volatile['approved']);
    assert_contains('ODDS_VOLATILE', implode(',', $volatile['reasons']));
});

test('risk: low confidence and low liquidity are explicit rejections', function () {
    $eng = new RiskEngine();
    $value = ['qualified' => true, 'expectedValue' => 0.2, 'odds' => 2.0];
    $quality = ['score' => 100, 'eligibleForTicket' => true];
    $lowConf = $eng->assess($value, $quality, ['min_data_quality' => 80, 'min_confidence' => 80], ['confidence' => 70]);
    assert_equals('REJECTED', $lowConf['classification']);
    assert_contains('LOW_CONFIDENCE', implode(',', $lowConf['reasons']));
    $lowLiq = $eng->assess($value, $quality, ['min_data_quality' => 80, 'min_liquidity' => 10000], ['confidence' => 90, 'liquidity' => 500]);
    assert_equals('REJECTED', $lowLiq['classification']);
    assert_contains('INSUFFICIENT_LIQUIDITY', implode(',', $lowLiq['reasons']));
});

test('optimizer: configured confidence and quality floors filter the pool', function () {
    $mk = fn(int $id, float $odds, float $conf, int $dq) => [
        'matchId' => $id, 'competition' => 'PoolL', 'market' => 'TOTAL_GOALS',
        'value' => ['qualified' => true, 'odds' => $odds, 'expectedValue' => 0.1],
        'risk' => ['approved' => true, 'classification' => 'LOW'],
        'confidence' => ['confidence' => $conf],
        'quality' => ['score' => $dq],
        'match' => ['competition' => 'PoolL'],
    ];
    $opt = new TicketOptimizer();
    $cands = [$mk(1, 2.0, 90, 95), $mk(2, 2.5, 60, 95), $mk(3, 2.2, 90, 70)];
    // odds window must be reachable by the surviving single leg (2.0) —
    // floors filter candidates, they never pad a ticket to a target value
    $out = $opt->optimize($cands, ['targetOddsMin' => 1.5, 'targetOddsMax' => 9.0, 'maxSelections' => 3, 'minConfidence' => 75, 'minDataQuality' => 80]);
    assert_equals('QUALIFIED', $out['status']);
    // only candidate 1 passes both floors
    assert_equals(1, $out['selectionCount']);
    $ids = array_map(fn($s) => $s['matchId'], $out['selections']);
    assert_equals([1], $ids);
});

test('optimizer: same-team candidates cannot both enter a ticket (LOW cap)', function () {
    $mk = fn(int $id, string $h, string $a, float $odds) => [
        'matchId' => $id, 'competition' => 'SameL', 'market' => 'TOTAL_GOALS',
        'homeTeam' => $h, 'awayTeam' => $a,
        'value' => ['qualified' => true, 'odds' => $odds, 'expectedValue' => 0.1],
        'risk' => ['approved' => true, 'classification' => 'LOW'],
        'confidence' => ['confidence' => 90],
        'quality' => ['score' => 95],
        'match' => ['competition' => 'SameL'],
    ];
    $opt = new TicketOptimizer();
    $out = $opt->optimize([$mk(1, 'Alpha', 'Beta', 2.0), $mk(2, 'Alpha', 'Gamma', 2.5)], ['targetOddsMin' => 4.0, 'targetOddsMax' => 9.0, 'maxSelections' => 2, 'maxCorrelation' => 'LOW']);
    assert_equals('NO_QUALIFIED_TICKET', $out['status'], 'same-team selections exceed the LOW correlation cap');
});
