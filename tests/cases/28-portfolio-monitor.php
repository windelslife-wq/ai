<?php
/**
 * PHASE 5 — Portfolio Risk Monitor (spec §14) and the strategy live-approval
 * gate (spec §12 paper-trading evidence).
 */
use Aegis\Portfolio\PortfolioRiskMonitor;

function prm_monitor_with(array $withBrokers = []): PortfolioRiskMonitor
{
    $p = platform();
    $brokers = new \Aegis\Brokers\BrokerManager();
    foreach ($withBrokers as $connector) $brokers->register($connector);
    return new PortfolioRiskMonitor($p->model->paper, $p->paper, $p->risk, $brokers, $p->model->audit, $p->model->state, $p->notifications);
}

function prm_enable_paper(): void
{
    $p = platform();
    $p->setKillSwitch(false, 'tests');
    $p->setTradingMode('PAPER_TRADING');
    $state = $p->model->state->load();
    $state['allowSyntheticPaperData'] = true;
    $p->model->state->save($state);
}

function prm_price(string $symbol): float
{
    $q = platform()->providers->getQuote($symbol);
    return (float) $q['quote']['last'];
}

test('portfolio scan: healthy account raises no alerts for its own scope', function () {
    $p = platform();
    $account = $p->paper->createAccount('prm-clean-' . uniqid(), 10000);
    $report = prm_monitor_with()->scan();
    $mine = array_filter($report['alerts'], fn($a) => $a['scope'] === 'paper:' . $account['id']);
    assert_equals(0, count($mine), json_encode(array_values($mine)));
    assert_contains('static disclosed groups', $report['correlationModel']);
});

test('portfolio scan: correlated positions detected via disclosed groups', function () {
    $p = platform();
    prm_enable_paper();
    $account = $p->paper->createAccount('prm-corr-' . uniqid(), 20000);
    foreach (['BTCUSDT', 'ETHUSDT'] as $sym) {
        $price = prm_price($sym);
        $res = $p->paper->submitOrder((int) $account['id'], [
            'symbol' => $sym, 'side' => 'BUY', 'type' => 'MARKET',
            'stopLoss' => $price * 0.95, 'takeProfit' => $price * 1.10, 'riskPct' => 0.005,
        ]);
        assert_true($res['filled'], "fill failed for {$sym}: " . json_encode($res['order']));
    }
    $report = prm_monitor_with()->scan();
    $mine = array_filter($report['alerts'], fn($a) => $a['scope'] === 'paper:' . $account['id']);
    $codes = array_map(fn($a) => $a['code'], $mine);
    assert_contains('CORRELATED_POSITIONS', implode(',', $codes), json_encode(array_values($mine)));
    // the transition is audited
    $events = array_filter($p->model->audit->recent(300), fn($e) => $e['type'] === 'PORTFOLIO_RISK_ALERT' && str_contains($e['summary'], 'CORRELATED_POSITIONS'));
    assert_true(count($events) >= 1, 'alert transition audited');
    $p->setTradingMode('ANALYSIS_ONLY');
});

test('portfolio scan: daily loss and drawdown warnings fire from realized trades', function () {
    $p = platform();
    $account = $p->paper->createAccount('prm-loss-' . uniqid(), 1000);
    // a closed losing position with an EXIT leg today → -6% daily (limit 3%)
    $position = $p->model->paper->savePosition([
        'account_id' => $account['id'], 'symbol' => 'EURUSD', 'market_class' => 'forex', 'direction' => 'LONG',
        'units' => 20000, 'entry_price' => 1.0800, 'stop_loss' => 1.0760, 'take_profit' => 1.0900, 'entry_fee' => 0,
        'opened_at' => gmdate('c', time() - 7200), 'status' => 'CLOSED', 'closed_at' => gmdate('c'),
        'exit_price' => 1.0770, 'realized_pnl' => -60.0, 'exit_reason' => 'STOP_LOSS',
    ]);
    $p->model->paper->saveTrade([
        'account_id' => $account['id'], 'order_id' => null, 'position_id' => $position['id'], 'leg' => 'EXIT',
        'symbol' => 'EURUSD', 'price' => 1.0770, 'units' => 20000, 'fee' => 0, 'time' => gmdate('c'), 'synthetic' => 0,
    ]);
    // and a peak equity far above the current balance → drawdown
    $acct = $p->model->paper->findAccount((int) $account['id']);
    $acct['peak_equity'] = 1200;
    $p->model->paper->saveAccount($acct);

    $summary = $p->paper->accountSummary((int) $account['id']);
    assert_close(-60.0, $summary['dailyPnl'], 1e-6);
    $report = prm_monitor_with()->scan();
    $mine = array_filter($report['alerts'], fn($a) => $a['scope'] === 'paper:' . $account['id']);
    $codes = array_map(fn($a) => $a['code'], $mine);
    assert_contains('DAILY_LOSS_WARNING', implode(',', $codes), json_encode(array_values($mine)));
    assert_contains('MAX_DRAWDOWN_WARNING', implode(',', $codes));
});

test('portfolio scan: excessive leverage warning', function () {
    $p = platform();
    prm_enable_paper();
    $account = $p->paper->createAccount('prm-lev-' . uniqid(), 1000);
    $price = prm_price('BTCUSDT');
    // 0.2% stop distance at 0.9% risk ⇒ notional ≈ 4.5x equity (warning band 4x–5x, veto at >5x)
    $res = $p->paper->submitOrder((int) $account['id'], [
        'symbol' => 'BTCUSDT', 'side' => 'BUY', 'type' => 'MARKET',
        'stopLoss' => $price * 0.998, 'takeProfit' => $price * 1.006, 'riskPct' => 0.009,
    ]);
    assert_true($res['filled'], json_encode($res['order']));
    $report = prm_monitor_with()->scan();
    $mine = array_filter($report['alerts'], fn($a) => $a['scope'] === 'paper:' . $account['id']);
    $codes = array_map(fn($a) => $a['code'], $mine);
    assert_contains('EXCESSIVE_LEVERAGE', implode(',', $codes), json_encode(array_values($mine)));
    $p->setTradingMode('ANALYSIS_ONLY');
});

test('portfolio scan: BROKER_DISCONNECTED fires only on a READY→DOWN transition', function () {
    $p = platform();
    $connector = new FakeTradingConnector();
    $monitor = prm_monitor_with([$connector]);
    // first scan records READY, no alert
    $first = $monitor->scan();
    assert_equals(0, count(array_filter($first['alerts'], fn($a) => $a['code'] === 'BROKER_DISCONNECTED')));
    // outage → alert appears once
    $connector->ready = false;
    $second = $monitor->scan();
    $codes = array_map(fn($a) => $a['code'], $second['alerts']);
    assert_contains('BROKER_DISCONNECTED', implode(',', $codes));
    // still down → no duplicate transition alert
    $third = $monitor->scan();
    assert_equals(0, count(array_filter($third['alerts'], fn($a) => $a['code'] === 'BROKER_DISCONNECTED')), 'no duplicate alerts');
    $disconnected = array_filter($p->model->audit->recent(300), fn($e) => $e['type'] === 'BROKER_DISCONNECTED');
    assert_equals(1, count($disconnected), 'exactly one BROKER_DISCONNECTED audit event');
    // recovery → BROKER_CONNECTED
    $connector->ready = true;
    $fourth = $monitor->scan();
    $connected = array_filter($p->model->audit->recent(300), fn($e) => $e['type'] === 'BROKER_CONNECTED');
    assert_equals(1, count($connected), 'exactly one BROKER_CONNECTED audit event');
});

test('strategy live approval requires paper evidence (≥10 trades, PF > 1, positive expectancy)', function () {
    $p = platform();
    $sid = 'trend-following';
    // advance to PAPER_TRADING through the real gates would need backtests; seed the stage directly
    $record = $p->model->strategies->find($sid, '1.0.0');
    $record['lifecycle'] = 'PAPER_TRADING';
    $record['updated_at'] = gmdate('c');
    $p->model->strategies->save($record);

    // no evidence yet → refused
    $r0 = $p->strategies->transition($sid, '1.0.0', 'APPROVED');
    assert_false($r0['ok']);
    assert_contains('Paper-trading evidence too thin', implode(';', $r0['reasons']));

    // 10 winning + 2 losing paper trades ⇒ PF ≈ 3.3, positive expectancy
    for ($i = 0; $i < 12; $i++) {
        $win = $i % 4 !== 3; // 9 wins, 3 losses
        $pnl = $win ? 50.0 : -30.0;
        $p->model->journal->save([
            'id' => Aegis\Backtest\Backtester::uuid(), 'source' => 'paper', 'symbol' => 'EURUSD', 'market' => 'forex',
            'strategy' => $sid, 'direction' => 'LONG', 'entry_time' => gmdate('c', time() - 86400 - $i * 60),
            'entry_price' => 1.08, 'exit_time' => gmdate('c', time() - 3600 - $i * 30), 'exit_price' => 1.081,
            'position_size' => 10000, 'stop_loss' => 1.075, 'take_profit' => 1.09, 'fees' => 1, 'slippage' => 0.2,
            'pnl' => $pnl, 'pnl_pct' => 0.005, 'r_multiple' => $win ? 1 : -0.6, 'reason' => 'paper run', 'execution_time' => gmdate('c'),
        ]);
    }
    $r1 = $p->strategies->transition($sid, '1.0.0', 'APPROVED');
    assert_true($r1['ok'], implode(';', $r1['reasons']));
    assert_equals('APPROVED', $r1['strategy']['lifecycle']);
    assert_equals(12, $r1['evidence']['paperTrades']);
    assert_true($r1['evidence']['profitFactor'] > 1);

    // reset for other suites
    $record = $p->model->strategies->find($sid, '1.0.0');
    $record['lifecycle'] = 'DRAFT';
    $record['updated_at'] = gmdate('c');
    $p->model->strategies->save($record);
});

test('strategy approval refuses losing paper evidence', function () {
    $p = platform();
    $sid = 'momentum';
    $record = $p->model->strategies->find($sid, '1.0.0');
    $record['lifecycle'] = 'PAPER_TRADING';
    $record['updated_at'] = gmdate('c');
    $p->model->strategies->save($record);
    for ($i = 0; $i < 12; $i++) {
        $p->model->journal->save([
            'id' => Aegis\Backtest\Backtester::uuid(), 'source' => 'paper', 'symbol' => 'BTCUSDT', 'market' => 'crypto',
            'strategy' => $sid, 'direction' => 'LONG', 'entry_time' => gmdate('c', time() - 86400), 'entry_price' => 60000,
            'exit_time' => gmdate('c'), 'exit_price' => 59000, 'position_size' => 0.1, 'stop_loss' => 58000,
            'take_profit' => 64000, 'fees' => 2, 'slippage' => 1, 'pnl' => -40.0, 'pnl_pct' => -0.007, 'r_multiple' => -1,
            'reason' => 'paper run', 'execution_time' => gmdate('c'),
        ]);
    }
    $r = $p->strategies->transition($sid, '1.0.0', 'APPROVED');
    assert_false($r['ok']);
    assert_true(str_contains(implode(';', $r['reasons']), 'profit factor') || str_contains(implode(';', $r['reasons']), 'expectancy'));
    $record = $p->model->strategies->find($sid, '1.0.0');
    $record['lifecycle'] = 'DRAFT';
    $record['updated_at'] = gmdate('c');
    $p->model->strategies->save($record);
});
