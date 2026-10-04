<?php
use Aegis\Agents\FundamentalsAgent;

test('fundamentals agent abstains without an attributable licensed feed', function () {
    $agent = new FundamentalsAgent();
    $report = $agent->analyze(fx_ctx(fx_series(fx_candles(80))));
    assert_equals('fundamentals', $report['agent']);
    assert_false($report['vote']['votes']);
    assert_false($report['provenance']['licensed']);
    assert_equals(0.0, $report['dataQuality']);
});
