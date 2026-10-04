<?php
/**
 * PHASE 5 — Trade Execution Supervisor: the 15-step pipeline, durable
 * proposals, human approval, automated execution inside limits, and the
 * routing gates. A simulated MT5 connector stands in for a real bridge.
 */
use Aegis\Brokers\BrokerConnector;
use Aegis\Brokers\BrokerManager;
use Aegis\Brokers\TradingConnector;
use Aegis\ExecutionSupervisor;

/** Deterministic Monday 12:00 UTC so session/freshness checks are stable on any host. */
function es_now(): int
{
    static $t = null;
    $t ??= strtotime('monday this week 12:00');
    return $t;
}

/** Simulated order-capable connector with configurable state. */
class FakeTradingConnector implements TradingConnector
{
    public array $placed = [];
    public bool $ready = true;
    public bool $trading = true;
    public string $accountType = 'demo';
    public float $freeMargin = 100000.0;
    public float $equity = 50000.0;
    public int $quoteAgeSeconds = 5;
    public int $now;
    public function __construct() { $this->now = es_now(); }
    public array $positions = [];
    public array $pending = [];
    public array $history = [];
    public bool $failOrder = false;

    public function id(): string { return 'fake-bridge'; }
    public function capabilities(): array { return ['accountRead' => true, 'marketData' => true, 'orderSubmission' => $this->trading]; }
    public function status(): array {
        if (!$this->ready) return ['state' => 'DOWN', 'message' => 'simulated outage', 'configured' => true];
        return ['state' => 'READY', 'message' => 'ok', 'configured' => true,
            'orderSubmissionEffective' => $this->trading && $this->accountType === 'demo'];
    }
    public function account(): array {
        return ['broker' => $this->id(), 'accountId' => '77', 'currency' => 'USD', 'balance' => $this->equity,
            'equity' => $this->equity, 'margin' => 0.0, 'freeMargin' => $this->freeMargin, 'leverage' => 30, 'timestamp' => gmdate('c')];
    }
    public function quote(string $symbol): array {
        [$bid, $ask] = str_starts_with(strtoupper($symbol), 'BTC') ? [59980.0, 60020.0] : [1.0800, 1.0802];
        return ['broker' => $this->id(), 'symbol' => strtoupper($symbol), 'bid' => $bid, 'ask' => $ask,
            'last' => ($bid + $ask) / 2, 'spread' => $ask - $bid, 'timestamp' => gmdate('c', $this->now - $this->quoteAgeSeconds)];
    }
    public function positions(): array { return $this->positions; }
    public function pendingOrders(): array { return $this->pending; }
    public function history(int $limit = 100): array { return $this->history; }
    public function candles(string $symbol, string $timeframe = '1h', int $limit = 500): array { return []; }
    public function placeOrder(array $order): array {
        if ($this->failOrder) throw new RuntimeException('simulated broker rejection');
        $this->placed[] = $order;
        return ['broker' => $this->id(), 'ticket' => 9001, 'price' => 1.0802, 'placedAt' => gmdate('c')];
    }
    public function modifyOrder(int $ticket, array $changes): array { return ['broker' => $this->id(), 'ticket' => $ticket, 'confirmed' => true]; }
    public function cancelOrder(int $ticket): array { return ['broker' => $this->id(), 'ticket' => $ticket, 'confirmed' => true]; }
    public function closePosition(int $ticket): array { return ['broker' => $this->id(), 'ticket' => $ticket, 'price' => 1.0801, 'profit' => 0.0]; }
}

function es_supervisor(FakeTradingConnector $connector, ?int $now = null): ExecutionSupervisor
{
    $p = platform();
    $brokers = new BrokerManager();
    $brokers->register($connector);
    return new ExecutionSupervisor($p->model->audit, $p->model->state, $p->model->proposals, $p->risk, $brokers, $p->strategies,
        fn(): int => $now ?? es_now(), $p->notifications);
}

function es_state(array $patch = []): array
{
    $p = platform();
    $state = $p->model->state->load();
    $state['tradingMode'] = 'HUMAN_APPROVAL';
    $state['killSwitch'] = ['active' => false, 'activatedAt' => null, 'reason' => 'test'];
    $state['automationLimits'] = array_merge(
        \Aegis\ExecutionSupervisor::automationLimits($state),
        ['maxTradeNotionalUsd' => 5000.0, 'maxDailyTrades' => 2, 'maxRiskPerTradePct' => 0.01,
         'approvedSymbols' => ['EURUSD', 'BTCUSDT'], 'updatedAt' => gmdate('c')]
    );
    foreach ($patch as $k => $v) $state[$k] = $v;
    $p->model->state->save($state);
    return $state;
}

function es_intent(array $patch = []): array
{
    return array_merge([
        'symbol' => 'EURUSD', 'marketClass' => 'forex', 'side' => 'BUY', 'type' => 'MARKET',
        'volume' => 1000, 'stopLoss' => 1.075, 'takeProfit' => 1.090, 'reason' => 'supervisor test',
    ], $patch);
}

test('pipeline rejects at step 1 when the kill switch is active', function () {
    es_state(['killSwitch' => ['active' => true, 'activatedAt' => gmdate('c'), 'reason' => 'test']]);
    $connector = new FakeTradingConnector();
    $result = es_supervisor($connector)->evaluate(es_intent(), false);
    assert_equals('REJECTED', $result['status']);
    assert_contains('kill switch', $result['reason']);
    assert_equals('kill-switch', $result['checks'][0]['check']);
    assert_equals([], $connector->placed);
});

test('pipeline rejects non-execution trading modes at step 2', function () {
    es_state(['tradingMode' => 'PAPER_TRADING']);
    $result = es_supervisor(new FakeTradingConnector())->evaluate(es_intent(), false);
    assert_equals('REJECTED', $result['status']);
    assert_contains('trading mode is PAPER_TRADING', $result['reason']);
});

test('automated modes require an APPROVED strategy at step 3', function () {
    es_state(['tradingMode' => 'SEMI_AUTONOMOUS']);
    $result = es_supervisor(new FakeTradingConnector())->evaluate(es_intent(), false);
    assert_equals('REJECTED', $result['status']);
    assert_contains('requires an APPROVED strategyId', $result['reason']);

    // registered but not approved
    $result2 = es_supervisor(new FakeTradingConnector())->evaluate(es_intent(['strategyId' => 'trend-following']), false);
    assert_equals('REJECTED', $result2['status']);
    assert_contains('lifecycle is DRAFT', $result2['reason']);
});

test('pipeline rejects when no connector is READY with effective order submission (step 4)', function () {
    es_state();
    $down = new FakeTradingConnector();
    $down->ready = false;
    $result = es_supervisor($down)->evaluate(es_intent(), false);
    assert_equals('REJECTED', $result['status']);
    assert_contains('no broker connector is READY', $result['reason']);
});

test('market session model blocks forex on the weekend (step 5)', function () {
    es_state();
    $p = platform();
    $connector = new FakeTradingConnector();
    $sup = es_supervisor($connector, (int) (strtotime('saturday this week 12:00') ?: (es_now() + 86400)));
    $result = $sup->evaluate(es_intent(), false);
    assert_equals('REJECTED', $result['status']);
    assert_contains('session closed', $result['reason']);

    // crypto is 24/7 and passes the session check
    $resultCrypto = $sup->evaluate(es_intent(['symbol' => 'BTCUSDT', 'marketClass' => 'crypto', 'volume' => 0.01, 'stopLoss' => 55000, 'takeProfit' => 70000]), false);
    assert_contains('crypto trades 24/7', $resultCrypto['checks'][4]['detail']);
});

test('stale quotes are rejected at step 6', function () {
    es_state();
    $connector = new FakeTradingConnector();
    $connector->quoteAgeSeconds = 4000;
    $result = es_supervisor($connector)->evaluate(es_intent(), false);
    assert_equals('REJECTED', $result['status']);
    assert_contains('stale', $result['reason']);
});

test('duplicate symbol exposure is rejected at step 7', function () {
    es_state();
    $connector = new FakeTradingConnector();
    $connector->positions = [['broker' => 'x', 'ticket' => 1, 'symbol' => 'EURUSD', 'side' => 'LONG', 'volume' => 1, 'entry' => 1.08, 'stopLoss' => 1.07, 'takeProfit' => null, 'profit' => 0, 'openedAt' => gmdate('c')]];
    $result = es_supervisor($connector)->evaluate(es_intent(), false);
    assert_equals('REJECTED', $result['status']);
    assert_contains('one net position per symbol', $result['reason']);
});

test('insufficient free margin is rejected at step 9', function () {
    es_state();
    $connector = new FakeTradingConnector();
    $connector->freeMargin = 1.0;
    $result = es_supervisor($connector)->evaluate(es_intent(), false);
    assert_equals('REJECTED', $result['status']);
    assert_contains('free margin', $result['reason']);
});

test('risk engine vetoes oversized real orders at step 10 (actual volume basis)', function () {
    es_state();
    $connector = new FakeTradingConnector();
    // 100000 units at ~1.08 with a 50-pip stop ⇒ risk $500 on $50k equity = 1% (ok);
    // double it to breach the 2% hard cap and notional limits.
    $result = es_supervisor($connector)->evaluate(es_intent(['volume' => 1000000]), false);
    assert_equals('REJECTED', $result['status']);
    assert_contains('risk engine veto', $result['reason']);
});

test('HUMAN_APPROVAL: full pass persists a PENDING proposal, approval then routes it end to end', function () {
    es_state();
    $connector = new FakeTradingConnector();
    $sup = es_supervisor($connector);
    $result = $sup->propose(es_intent(), 'user');
    assert_equals('PENDING_APPROVAL', $result['status']);
    $names = array_map(fn($c) => $c['check'], $result['checks']);
    assert_contains('kill-switch', implode(',', $names));
    assert_contains('risk-engine', implode(',', $names));
    assert_contains('human-approval', implode(',', $names));
    // persisted + readable
    $stored = $sup->proposal($result['id']);
    assert_not_null($stored, 'proposal persisted');
    assert_equals('PENDING_APPROVAL', $stored['status']);
    // routing before approval is blocked, no order exists
    $blocked = $sup->route($result['id'], 'user');
    assert_equals('ROUTING_BLOCKED', $blocked['status']);
    assert_false($blocked['brokerOrderCreated']);
    // approve → route → executed
    $sup->decide($result['id'], true, 'user', 'test approve');
    $routed = $sup->route($result['id'], 'user');
    assert_equals('EXECUTED', $routed['status']);
    assert_true($routed['brokerOrderCreated']);
    assert_equals(1, count($connector->placed));
    assert_equals('EURUSD', $connector->placed[0]['symbol']);
    assert_equals(1.075, $connector->placed[0]['stopLoss']);
    $final = $sup->proposal($result['id']);
    assert_equals('EXECUTED', $final['status']);
    $executions = platform()->model->proposals->listExecutions($result['id']);
    assert_equals(1, count($executions));
    assert_equals('EXECUTED', $executions[0]['status']);
    assert_equals('9001', (string) $executions[0]['broker_order_id']);
    assert_contains('portfolioAfter', json_encode($executions[0]['result']));
    // decision is one-shot
    assert_throws(RuntimeException::class, fn() => $sup->decide($result['id'], false, 'user', 'x'));
});

test('kill switch re-engaged between approval and routing blocks the order', function () {
    es_state();
    $connector = new FakeTradingConnector();
    $sup = es_supervisor($connector);
    $result = $sup->propose(es_intent());
    $sup->decide($result['id'], true, 'user');
    platform()->setKillSwitch(true, 'emergency before routing');
    $blocked = $sup->route($result['id'], 'user');
    assert_equals('ROUTING_BLOCKED', $blocked['status']);
    assert_equals([], $connector->placed);
});

test('broker failure at routing marks the proposal FAILED without inventing an execution', function () {
    es_state();
    $connector = new FakeTradingConnector();
    $connector->failOrder = true;
    $sup = es_supervisor($connector);
    $result = $sup->propose(es_intent());
    $sup->decide($result['id'], true, 'user');
    $failed = $sup->route($result['id'], 'user');
    assert_equals('FAILED', $failed['status']);
    assert_false($failed['brokerOrderCreated']);
    assert_equals('FAILED', $sup->proposal($result['id'])['status']);
});

test('SEMI_AUTONOMOUS executes inside limits and enforces every automation cap', function () {
    es_state(['tradingMode' => 'SEMI_AUTONOMOUS']);
    $connector = new FakeTradingConnector();
    $sup = es_supervisor($connector);
    $p = platform();

    // seed an APPROVED strategy record directly (lifecycle gates are covered in 05/28)
    $record = $p->model->strategies->find('trend-following', '1.0.0');
    $record['lifecycle'] = 'APPROVED';
    $record['updated_at'] = gmdate('c');
    $p->model->strategies->save($record);

    $ok = $sup->executeAutomated(es_intent(['strategyId' => 'trend-following']));
    assert_equals('EXECUTED', $ok['status'], 'should auto-route inside limits: ' . json_encode($ok['checks'] ?? $ok));
    assert_equals(1, count($connector->placed));

    // daily cap = 2 → second trade allowed, third blocked
    $ok2 = $sup->executeAutomated(es_intent(['symbol' => 'BTCUSDT', 'marketClass' => 'crypto', 'volume' => 0.01, 'stopLoss' => 55000, 'takeProfit' => 70000, 'strategyId' => 'trend-following']));
    assert_equals('EXECUTED', $ok2['status'], json_encode($ok2));
    $capped = $sup->executeAutomated(es_intent(['strategyId' => 'trend-following']));
    assert_equals('REJECTED', $capped['status']);
    assert_contains('daily automated-trade cap', $capped['reason']);

    // notional cap: $30k order is inside the risk-engine cap ($50k) but above the $5k automation cap
    $p->updateAutomationLimits(['maxDailyTrades' => 50]); // daily cap already proven above
    $connector->freeMargin = 10000000.0;
    $big = $sup->evaluate(es_intent(['symbol' => 'BTCUSDT', 'marketClass' => 'crypto', 'volume' => 0.5, 'stopLoss' => 59500, 'takeProfit' => 61500, 'strategyId' => 'trend-following']), false);
    assert_contains('exceeds automation limit', $big['reason']);

    // symbol not on the approved list
    $off = $sup->evaluate(es_intent(['symbol' => 'USDJPY', 'stopLoss' => 150, 'takeProfit' => 160, 'strategyId' => 'trend-following']), false);
    assert_contains('not in automationLimits.approvedSymbols', $off['reason']);
});

test('automated execution is refused when approved symbols were never configured', function () {
    es_state(['tradingMode' => 'SEMI_AUTONOMOUS', 'automationLimits' => ['maxTradeNotionalUsd' => 500.0, 'maxDailyTrades' => 5, 'maxRiskPerTradePct' => 0.01, 'approvedSymbols' => [], 'updatedAt' => gmdate('c')]]);
    $result = es_supervisor(new FakeTradingConnector())->evaluate(es_intent(['strategyId' => 'trend-following']), false);
    assert_equals('REJECTED', $result['status']);
    assert_contains('approvedSymbols is empty', $result['reason']);
});

test('mode governance: SEMI_AUTONOMOUS and FULLY_AUTOMATED require preconditions', function () {
    $p = platform();
    // wipe limits + engage the kill switch → both automated modes are refused with every reason
    $state = $p->model->state->load();
    unset($state['automationLimits']);
    $p->model->state->save($state);
    $p->setKillSwitch(true, 'mode gate test');
    $r1 = $p->setTradingMode('SEMI_AUTONOMOUS');
    assert_false($r1['ok']);
    assert_contains('approvedSymbols is empty', $r1['message']);
    $r2 = $p->setTradingMode('FULLY_AUTOMATED');
    assert_false($r2['ok']);
    assert_contains('no broker connector is READY', $r2['message']);
    assert_contains('kill switch is ACTIVE', $r2['message']);

    // configured limits + kill switch off → SEMI allowed, FULLY still needs a connector
    $p->setKillSwitch(false, 'tests');
    $p->updateAutomationLimits(['approvedSymbols' => ['EURUSD'], 'maxTradeNotionalUsd' => 500]);
    $r3 = $p->setTradingMode('SEMI_AUTONOMOUS');
    assert_true($r3['ok'], $r3['message']);
    $r4 = $p->setTradingMode('FULLY_AUTOMATED');
    assert_false($r4['ok']);
    assert_contains('no broker connector is READY', $r4['message']);
    // platform's own MT5 connector (env-disabled) never counts as routable
    assert_equals(null, $p->brokers->tradingConnector());
    $p->setTradingMode('ANALYSIS_ONLY');
});
