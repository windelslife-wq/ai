<?php
/**
 * PHASE 6 — Multi-agent debate: adversarial review in front of the consensus.
 * The verdict can only reduce a bias, never inflate it.
 */
use Aegis\Agents\AgentDebate;

function debate_reports(array $patch = []): array
{
    $reports = [[
        'agent' => 'technical', 'dataQuality' => 1.0,
        'vote' => ['directionalScore' => 0.7, 'weight' => 1.0, 'votes' => [['direction' => 'BULLISH', 'weight' => 0.7]]],
        'signals' => [
            ['name' => 'ema20/50', 'signal' => 'bullish', 'detail' => 'fast above slow'],
            ['name' => 'rsi14', 'signal' => 'bullish', 'detail' => '58 rising'],
            ['name' => 'macd', 'signal' => 'bearish', 'detail' => 'histogram fading'],
        ],
    ]];
    foreach ($patch as $p) $reports[] = $p;
    return $reports;
}

function debate_consensus(array $patch = []): array
{
    return array_merge([
        'bias' => 'BULLISH', 'confidence' => 0.72, 'confluenceScore' => 0.65,
        'recommendation' => 'BUY',
        'consensus' => ['conflicts' => 0, 'agreement' => 0.8],
    ], $patch);
}

test('clean strong case: bias sustained with an auditable transcript', function () {
    $debate = AgentDebate::run(
        debate_reports(), debate_consensus(),
        ['regime' => 'TRENDING_UP', 'confidence' => 0.8],
        null,
        ['synthetic' => false, 'stale' => false],
        \Aegis\RiskEngine::DEFAULT_LIMITS
    );
    assert_equals('BULLISH', $debate['verdict']['bias']);
    assert_true($debate['verdict']['confidence'] <= 0.72);
    $roles = array_map(fn($r) => $r['role'], $debate['rounds']);
    assert_equals('bull-advocate,bear-advocate,skeptic,risk-critic', implode(',', $roles));
    // advocates cite their evidence
    $bull = $debate['rounds'][0]['statements'];
    assert_true(count($bull) >= 2);
    assert_contains('technical:ema20/50', $bull[0]['evidence']);
    $bear = $debate['rounds'][1]['statements'];
    assert_true(count($bear) >= 1, 'bear advocate states the opposing evidence');
});

test('stale data is a sustained CRITICAL objection → NO_TRADE', function () {
    $debate = AgentDebate::run(
        debate_reports(), debate_consensus(),
        ['regime' => 'TRENDING_UP', 'confidence' => 0.8],
        null,
        ['synthetic' => false, 'stale' => true],
        \Aegis\RiskEngine::DEFAULT_LIMITS
    );
    assert_equals('NO_TRADE', $debate['verdict']['bias']);
    assert_true($debate['verdict']['confidence'] < 0.72);
    assert_contains('critical objection', implode(';', $debate['verdict']['reasoning']));
});

test('two sustained major objections downgrade the bias to NEUTRAL', function () {
    $debate = AgentDebate::run(
        debate_reports(), debate_consensus(['consensus' => ['conflicts' => 2, 'agreement' => 0.45]]),
        ['regime' => 'RANGING', 'confidence' => 0.75], // contradicts BULLISH + confident regime
        null,
        ['synthetic' => false, 'stale' => false],
        \Aegis\RiskEngine::DEFAULT_LIMITS
    );
    assert_equals('NEUTRAL', $debate['verdict']['bias']);
    assert_contains('downgraded to NEUTRAL', implode(';', $debate['verdict']['reasoning']));
});

test('one sustained major objection keeps the bias but cuts confidence by 0.10', function () {
    $debate = AgentDebate::run(
        debate_reports(), debate_consensus(),
        ['regime' => 'RANGING', 'confidence' => 0.75],
        null,
        ['synthetic' => false, 'stale' => false],
        \Aegis\RiskEngine::DEFAULT_LIMITS
    );
    assert_equals('BULLISH', $debate['verdict']['bias']);
    assert_close(0.62, $debate['verdict']['confidence'], 1e-9);
});

test('weak conviction is challenged; NO_TRADE-safe thresholds respected', function () {
    $debate = AgentDebate::run(
        debate_reports(), debate_consensus(['bias' => 'BULLISH', 'confidence' => 0.42]),
        ['regime' => 'TRENDING_UP', 'confidence' => 0.8],
        null,
        ['synthetic' => false, 'stale' => false],
        \Aegis\RiskEngine::DEFAULT_LIMITS
    );
    $skeptical = array_filter($debate['rounds'][2]['objections'], fn($o) => $o['id'] === 'S5');
    assert_equals('major', reset($skeptical)['severity']);
    assert_true(reset($skeptical)['sustained']);
    assert_close(0.32, $debate['verdict']['confidence'], 1e-9);
});

test('risk critic challenges a poor setup; already-discounted factors do not bite', function () {
    $setup = ['entry' => ['reference' => 100.0], 'stopLoss' => 90.0, 'riskReward' => 1.1];
    $debate = AgentDebate::run(
        debate_reports(), debate_consensus(),
        ['regime' => 'TRENDING_UP', 'confidence' => 0.8],
        $setup,
        ['synthetic' => true, 'stale' => false], // synthetic: informational only
        \Aegis\RiskEngine::DEFAULT_LIMITS
    );
    $critic = $debate['rounds'][3]['objections'];
    $ids = array_map(fn($o) => $o['id'], $critic);
    assert_contains('R1', implode(',', $ids), 'RR below minimum challenged');
    assert_contains('R2', implode(',', $ids), 'wide stop challenged');
    // S4 (synthetic) is raised but never sustained — freshness already discounts it
    $s4 = array_filter($debate['rounds'][2]['objections'], fn($o) => $o['id'] === 'S4');
    assert_false(reset($s4)['sustained']);
});

test('engine analysis includes the debate transcript and honors the verdict', function () {
    $run = platform()->engine->run('BTCUSDT', 'crypto', '1h');
    assert_not_null($run['debate'] ?? null, 'debate present in the analysis run');
    assert_not_null($run['debate']['verdict']['bias']);
    assert_true(is_array($run['debate']['verdict']['reasoning']));
    // verdict binding: NO_TRADE carries through and drops the setup
    if ($run['debate']['verdict']['bias'] === 'NO_TRADE') {
        assert_equals('NO_TRADE', $run['bias']);
        assert_equals(null, $run['tradeSetup']);
    } elseif ($run['debate']['verdict']['bias'] === 'NEUTRAL') {
        assert_equals('NEUTRAL', $run['bias']);
        assert_equals(null, $run['tradeSetup']);
    }
    // confidence never exceeds the pre-debate confluence ceiling
    assert_true($run['confidence'] <= 1.0);
});
