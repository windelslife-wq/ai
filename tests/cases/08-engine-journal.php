<?php
/** Intelligence engine end-to-end (DB-backed) + journal analytics. */
use Aegis\Journal\Analytics;

test('engine: full analysis run persists + audits + risk vetoes synthetic', function () {
    $p = platform();
    $run = $p->engine->run('BTCUSDT', 'crypto', '1h');
    assert_equals('BTCUSDT', $run['symbol']);
    assert_true($run['provenance']['synthetic']); // sandbox has no egress
    assert_contains('synthetic-demo', $run['provenance']['source']);
    assert_true(in_array($run['bias'], ['BULLISH', 'BEARISH', 'NEUTRAL', 'NO_TRADE'], true));
    assert_true($run['confidence'] >= 0 && $run['confidence'] <= 1);
    assert_true(count($run['agents']) >= 3);
    $agentIds = array_map(fn($a) => $a['agent'], $run['agents']);
    assert_contains('technical', implode(',', $agentIds));
    assert_contains('crypto', implode(',', $agentIds));
    assert_false(in_array('forex', $agentIds, true));
    if ($run['tradeSetup'] !== null) {
        assert_not_null_or($run['riskDecision']);
        assert_false($run['riskDecision']['approved']); // synthetic gate vetoes
        assert_contains('SYNTHETIC', $run['riskDecision']['reasons'][0] ?? '');
    }
    // persisted + history
    assert_not_null_or($p->model->analysis->find($run['id']));
    assert_true(count(array_filter($p->model->analysis->history(5), fn($h) => $h['id'] === $run['id'])) === 1);
    // audited
    $types = array_column($p->model->audit->recent(30), 'type');
    assert_contains('TRADE_ANALYZED', implode(',', $types));
});

test('engine: consensus across symbols', function () {
    $out = platform()->engine->consensus([
        ['symbol' => 'BTCUSDT', 'marketClass' => 'crypto', 'timeframe' => '1h'],
        ['symbol' => 'EURUSD', 'marketClass' => 'forex', 'timeframe' => '1h'],
    ]);
    assert_equals(2, count($out));
    foreach ($out as $c) {
        assert_true(in_array($c['bias'], ['BULLISH', 'BEARISH', 'NEUTRAL', 'NO_TRADE'], true), 'unexpected bias ' . $c['bias']);
    }
});

test('backtest via platform: persists + journals + seeds lifecycle evidence', function () {
    $p = platform();
    $record = $p->runBacktest([
        'strategyId' => 'breakout', 'strategyVersion' => '1.0.0',
        'symbol' => 'BTCUSDT', 'marketClass' => 'crypto', 'timeframe' => '1h', 'limit' => 800,
    ]);
    assert_true($record['metrics']['trades'] >= 0);
    assert_true($record['dataProvenance']['synthetic']);
    assert_contains('SYNTHETIC', implode('|', $record['warnings']));
    assert_not_null_or($p->model->backtests->find($record['id']));
    $journal = $p->model->journal->list(['strategy' => 'breakout'], 500);
    assert_true(count($journal) >= $record['metrics']['trades']);
    foreach ($journal as $e) {
        assert_equals('strategy', $e['confidence_source']);
        assert_not_null_or($e['ai_confidence']);
    }
});

test('journal analytics: groupings + calibration verdicts', function () {
    $mk = function (float $pnl, ?float $conf, int $i): array {
        return [
            'id' => 'j-' . uniqid(), 'source' => 'backtest', 'symbol' => $i % 2 ? 'BTCUSDT' : 'ETHUSDT',
            'market' => 'crypto', 'strategy' => $i % 2 ? 'trend-following' : 'breakout', 'strategy_version' => '1.0.0',
            'direction' => 'LONG', 'entry_time' => gmdate('c', 1700000000 + $i), 'entry_price' => 100.0,
            'exit_time' => gmdate('c', 1700000100 + $i), 'exit_price' => 101.0, 'position_size' => 10.0,
            'stop_loss' => 98.0, 'take_profit' => 105.0, 'fees' => 1.0, 'slippage' => 0.5,
            'pnl' => $pnl, 'pnl_pct' => 1.0, 'r_multiple' => $pnl / 20.0, 'reason' => 't', 'ai_confidence' => $conf,
            'confidence_source' => $conf !== null ? 'strategy' : null, 'agent_consensus' => null, 'risk_score' => null,
            'execution_time' => gmdate('c', 1700000000 + $i),
        ];
    };
    $entries = [];
    for ($i = 0; $i < 20; $i++) $entries[] = $mk($i % 2 === 0 ? 15.0 : -10.0, 0.3, $i); // 50% win (low)
    for ($i = 20; $i < 40; $i++) $entries[] = $mk($i % 3 === 0 ? -10.0 : 15.0, 0.9, $i); // 2/3 win (high)

    $byStrategy = Analytics::analyze($entries, 'strategy');
    assert_equals(2, count($byStrategy['groups']));
    assert_equals(40, $byStrategy['overall']['closedTrades']);

    $cal = Analytics::calibration($entries);
    assert_true($cal['sufficientData']);
    assert_equals(2, count($cal['buckets']));
    $highWin = 0; $lowWin = 0;
    foreach ($cal['buckets'] as $b) {
        if (str_contains($b['key'], '80')) $highWin = $b['winRate'];
        if (str_contains($b['key'], '0–40')) $lowWin = $b['winRate'];
    }
    assert_true($highWin > $lowWin);
    assert_contains('directionally informative', $cal['verdict']);

    $small = Analytics::calibration(array_slice($entries, 0, 10));
    assert_false($small['sufficientData']);
    assert_contains('Sample too small', $small['verdict']);
});
