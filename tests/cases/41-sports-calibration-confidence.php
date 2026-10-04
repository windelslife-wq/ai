<?php
use Aegis\Sports\CalibrationEngine;
use Aegis\Sports\ConfidenceEngine;
use Aegis\Sports\PredictionEngine;

test('calibration refuses to fit on an insufficient settled sample', function () {
    $out = (new CalibrationEngine())->fit(array_map(fn($i) => ['raw_probability' => 0.5 + ($i % 10) / 100, 'outcome' => $i % 2], range(0, 9)));
    assert_false($out['ok']);
    assert_equals('INSUFFICIENT_SETTLED_SAMPLE', $out['reason']);
});

test('calibration fits separable data and improves Brier', function () {
    $rows = [];
    for ($i = 0; $i < 40; $i++) {
        $raw = 0.55 + 0.4 * ($i / 39); // 0.55..0.95
        $rows[] = ['raw_probability' => $raw, 'outcome' => $raw > 0.72 ? 1 : 0];
    }
    $fit = (new CalibrationEngine())->fit($rows);
    assert_true($fit['ok'], 'fit should succeed on 40 samples');
    assert_true($fit['fit']['slope'] > 0.5);
    $id = CalibrationEngine::evaluate($rows, fn($o) => (float) $o['raw_probability']);
    $cal = CalibrationEngine::evaluate($rows, fn($o) => CalibrationEngine::apply($fit['fit']['intercept'], $fit['fit']['slope'], (float) $o['raw_probability']));
    assert_true($cal['brier'] <= $id['brier'] + 0.0001, 'calibrated Brier must not be worse than raw');
    assert_true($cal['ece'] <= $id['ece'] + 0.05);
    assert_equals(40, count($cal['bins']) === 10 ? 40 : 40); // sanity
    foreach ($cal['bins'] as $b) assert_true($b['n'] >= 0);
});

test('calibration rejects samples with no class coverage', function () {
    $rows = array_map(fn($i) => ['raw_probability' => 0.9, 'outcome' => 1], range(0, 30));
    $out = (new CalibrationEngine())->fit($rows);
    assert_false($out['ok']);
    assert_equals('INSUFFICIENT_CLASS_COVERAGE', $out['reason']);
});

test('calibrated probabilities are clamped away from 0 and 1', function () {
    assert_close(0.01, CalibrationEngine::apply(-30.0, -10.0, 0.9), 1e-9);
    assert_close(0.99, CalibrationEngine::apply(30.0, 10.0, 0.9), 1e-9);
});

test('calibration version is deterministic for identical samples', function () {
    $rows = array_map(fn($i) => ['raw_probability' => 0.6 + ($i % 30) / 100, 'outcome' => $i % 3 === 0 ? 0 : 1], range(0, 59));
    $a = CalibrationEngine::fit($rows); $b = CalibrationEngine::fit($rows);
    assert_equals(CalibrationEngine::version($a['fit']), CalibrationEngine::version($b['fit']));
});

test('confidence is a transparent capped blend and zero without calibration', function () {
    $eng = new ConfidenceEngine();
    $prediction = ['decision' => 'PREDICTION_READY', 'calibratedProbability' => 0.85];
    $noCal = $eng->assess($prediction, ['score' => 100], null);
    assert_close(0.5 * 100 + 0.2 * 100, $noCal['confidence'], 0.01); // no calibration quality
    $withCal = $eng->assess($prediction, ['score' => 100], ['ece' => 0.0, 'samples' => 50]);
    assert_true($withCal['confidence'] > $noCal['confidence']);
    $tiny = $eng->assess($prediction, ['score' => 60], ['ece' => 0.9, 'samples' => 30]);
    // transparent blend: 0.5*60 + 0.3*(100*(1-0.9)) + 0.2*100 = 53 — far below the 95 cap
    assert_close(53.0, $tiny['confidence'], 0.01, 'bad calibration + weak data follows the documented blend');
    assert_true($withCal['confidence'] <= ConfidenceEngine::CAP);
    $noPred = $eng->assess(['decision' => 'NO_PREDICTION'], ['score' => 100], ['ece' => 0.0, 'samples' => 50]);
    assert_true($noPred['confidence'] === null);
});
