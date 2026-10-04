<?php
use Aegis\Sports\CorrelationEngine;
use Aegis\Sports\RiskEngine;
use Aegis\Sports\ValueEngine;

test('sports value engine calculates implied probability and rejects negative edge', function () {
    $prediction = ['decision' => 'PREDICTION_READY', 'calibratedProbability' => .60];
    $v = (new ValueEngine())->assess($prediction, ['decimalOdds' => 1.5]);
    assert_false($v['qualified']); assert_equals('LOW_MODEL_EDGE', $v['reason']); assert_close(0.6666667, $v['impliedProbability'], .00001);
});
test('sports risk engine rejects low quality and stale candidate', function () {
    $risk = (new RiskEngine())->assess(['qualified' => true, 'expectedValue' => .1], ['score' => 50, 'eligibleForTicket' => false]);
    assert_false($risk['approved']); assert_equals('REJECTED', $risk['classification']);
});
test('sports correlation blocks selections from same match', function () {
    $out = (new CorrelationEngine())->assess(['matchId' => 1, 'competition' => 'L'], [['matchId' => 1, 'competition' => 'L']]);
    assert_equals('HIGH', $out['classification']); assert_contains('SAME_MATCH', implode(',', $out['reasons']));
});
