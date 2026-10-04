<?php
/** Risk engine vetoes + sizing math. */
use Aegis\RiskEngine;

test('risk: clean setup approved with exact sizing', function () {
    $d = (new RiskEngine())->evaluate(fx_setup(), fx_risk_ctx());
    assert_true($d['approved'], implode('; ', $d['reasons']));
    assert_close(100.0, $d['sizing']['riskAmount'], 1e-6);
    assert_close(0.0030, $d['sizing']['stopDistance'], 1e-9);
    assert_close(100 / 0.0030, $d['sizing']['units'], 0.01);
});

test('risk: veto below minimum R:R', function () {
    $d = (new RiskEngine())->evaluate(fx_setup(['riskReward' => 1.0]), fx_risk_ctx());
    assert_false($d['approved']);
    assert_true(count(array_filter($d['reasons'], fn($r) => str_contains($r, 'Risk/reward'))) === 1);
});

test('risk: veto when stop missing', function () {
    $d = (new RiskEngine())->evaluate(fx_setup(['stopLoss' => NAN]), fx_risk_ctx());
    assert_false($d['approved']);
    assert_true(count(array_filter($d['reasons'], fn($r) => str_contains($r, 'Stop loss is required'))) === 1);
});

test('risk: kill switch veto (Rule 7)', function () {
    $d = (new RiskEngine())->evaluate(fx_setup(), fx_risk_ctx(['killSwitchActive' => true]));
    assert_false($d['approved']);
    assert_contains('Kill switch is ACTIVE', $d['reasons'][0]);
});

test('risk: synthetic + stale data vetoes (Rule 2)', function () {
    $e = new RiskEngine();
    $synth = $e->evaluate(fx_setup(), fx_risk_ctx(['syntheticData' => true]));
    assert_false($synth['approved']);
    assert_contains('SYNTHETIC', $synth['reasons'][0]);
    $stale = $e->evaluate(fx_setup(), fx_risk_ctx(['staleData' => true]));
    assert_false($stale['approved']);
});

test('risk: portfolio gates — daily loss, drawdown, symbol concentration', function () {
    $e = new RiskEngine();
    $daily = $e->evaluate(fx_setup(), fx_risk_ctx(['dailyPnl' => -500]));
    assert_true(in_array('Daily loss limit exceeded', $daily['reasons']));
    $dd = $e->evaluate(fx_setup(), fx_risk_ctx(['equity' => 8500, 'peakEquity' => 10000]));
    assert_true(count(array_filter($dd['reasons'], fn($r) => stripos($r, 'drawdown') !== false)) === 1);
    $conc = $e->evaluate(fx_setup(), fx_risk_ctx(['openRiskBySymbol' => ['EURUSD' => 450]]));
    assert_true(count(array_filter($conc['reasons'], fn($r) => str_contains($r, 'concentration'))) === 1);
});

test('risk: tight stop hits notional + leverage caps', function () {
    $e = new RiskEngine();
    $d = $e->evaluate(fx_setup(['entry' => ['type' => 'ZONE', 'min' => 1.0819, 'max' => 1.0820, 'reference' => 1.08195], 'stopLoss' => 1.0819]), fx_risk_ctx());
    assert_false($d['approved']);
    assert_true(count(array_filter($d['reasons'], fn($r) => stripos($r, 'notional') !== false)) === 1);
});

test('risk: updateLimits clamps risk to hard cap', function () {
    $e = new RiskEngine();
    $limits = $e->updateLimits(['riskPerTradePct' => 0.5]);
    assert_equals($limits['maxRiskPerTradePct'], $limits['riskPerTradePct']);
});
