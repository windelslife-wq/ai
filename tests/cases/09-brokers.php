<?php
/**
 * PHASE 4 — Broker layer: MT5 bridge connector (full trading surface) and
 * the TradingConnector/BrokerManager contracts. All against a simulated
 * bridge; no real MetaTrader terminal is involved (see README honesty notes).
 */
use Aegis\Brokers\BrokerManager;
use Aegis\Brokers\Mt5BridgeConnector;

test('MT5 connector is disabled with no order capability by default', function () {
    $connector = new Mt5BridgeConnector('', false);
    $status = $connector->status();
    assert_equals('DISABLED', $status['state']);
    assert_false($connector->capabilities()['orderSubmission']);
    assert_false($status['configured']);
});

test('MT5 connector only becomes ready from a successful health probe', function () {
    $connector = new Mt5BridgeConnector('https://mt5-bridge.internal', true,
        fn(string $m, string $p, ?string $t, ?array $b) => ['ok' => true, 'version' => '1.2.3', 'tradingEnabled' => true, 'accountType' => 'demo']);
    $status = $connector->status();
    assert_equals('READY', $status['state']);
    assert_equals('1.2.3', $status['bridgeVersion']);
    assert_true($status['bridgeTradingEnabled']);
    assert_equals('demo', $status['accountType']);
    // trading env flag NOT set → effective submission stays false even though the bridge would trade
    assert_false($status['orderSubmissionEffective']);
});

test('MT5 connector rejects unsafe or malformed bridge URLs', function () {
    $connector = new Mt5BridgeConnector('ftp://user:secret@host', true);
    assert_equals('NOT_CONFIGURED', $connector->status()['state']);
});

test('MT5 account/quote/candle reads require a token and use read-only bridge paths', function () {
    $calls = [];
    $connector = new Mt5BridgeConnector('https://bridge.example', true,
        function (string $method, string $path, ?string $token, ?array $body) use (&$calls) {
            $calls[] = [$method, $path, $token];
            if ($path === '/v1/account') return ['ok' => true, 'data' => ['accountId' => '123', 'balance' => 1000.0, 'equity' => 995.0, 'currency' => 'USD']];
            if ($path === '/v1/quotes/EURUSD') return ['ok' => true, 'data' => ['symbol' => 'EURUSD', 'bid' => 1.08, 'ask' => 1.081]];
            if (str_starts_with($path, '/v1/candles/EURUSD')) return ['ok' => true, 'data' => [['t' => time() - 3600, 'o' => 1.08, 'h' => 1.085, 'l' => 1.079, 'c' => 1.083, 'v' => 100]]];
            return ['ok' => true];
        }, 'test-token');
    assert_equals(1000.0, $connector->account()['balance']);
    assert_equals('EURUSD', $connector->quote('eurusd')['symbol']);
    $candles = $connector->candles('EURUSD', '1h', 100);
    assert_equals(1, count($candles));
    assert_true($candles[0]['high'] >= $candles[0]['close']);
    assert_equals(['GET', '/v1/account', 'test-token'], $calls[0]);
    assert_equals(['GET', '/v1/quotes/EURUSD', 'test-token'], $calls[1]);
    assert_equals(['GET', '/v1/candles/EURUSD?tf=1h&limit=100', 'test-token'], $calls[2]);
});

test('broker data contracts normalize positions, pending orders and history', function () {
    $positions = \Aegis\Brokers\BrokerDataNormalizer::positions([
        ['ticket' => 1, 'symbol' => 'eurusd', 'side' => 'long', 'volume' => 0.5, 'entry' => 1.08, 'stopLoss' => 1.075, 'takeProfit' => null, 'profit' => 5.5, 'openedAt' => time() - 60],
        ['ticket' => 2, 'symbol' => 'BTCUSD', 'side' => 'SHORT', 'volume' => 0.1, 'entry' => 60000, 'stopLoss' => null, 'takeProfit' => 55000, 'profit' => -10, 'openedAt' => time() - 90],
    ], 'test');
    assert_equals('LONG', $positions[0]['side']);
    assert_equals(1.075, $positions[0]['stopLoss']);
    assert_equals(null, $positions[0]['takeProfit']);
    assert_equals(null, $positions[1]['stopLoss']);
    assert_equals(55000.0, $positions[1]['takeProfit']);

    $orders = \Aegis\Brokers\BrokerDataNormalizer::pendingOrders([
        ['ticket' => 9, 'symbol' => 'XAUUSD', 'side' => 'buy', 'type' => 'limit', 'volume' => 0.1, 'price' => 2350.0, 'stopLoss' => 2340.0, 'takeProfit' => 2400.0, 'placedAt' => time() - 30],
    ], 'test');
    assert_equals('BUY', $orders[0]['side']);
    assert_equals('LIMIT', $orders[0]['type']);

    $history = \Aegis\Brokers\BrokerDataNormalizer::history([
        ['ticket' => 3, 'symbol' => 'EURUSD', 'side' => 'long', 'volume' => 0.5, 'entry' => 1.080, 'exit' => 1.084, 'profit' => 20.0, 'openedAt' => time() - 7200, 'closedAt' => time() - 3600],
    ], 'test');
    assert_equals(20.0, $history[0]['profit']);
});

test('candle normalizer rejects impossible OHLC relationships', function () {
    assert_throws(RuntimeException::class, function () {
        \Aegis\Brokers\BrokerDataNormalizer::candles([['t' => time(), 'o' => 2, 'h' => 1, 'l' => 0.5, 'c' => 1.5, 'v' => 1]], 'test');
    });
});

test('order submission is refused unless BOTH env gate and bridge gate pass', function () {
    $bridgeTrading = function (string $method, string $path, ?string $token, ?array $body) {
        if ($path === '/health') return ['ok' => true, 'version' => '1.0.0', 'tradingEnabled' => true, 'accountType' => 'demo'];
        if ($path === '/v1/orders') return ['ok' => true, 'data' => ['ticket' => 5001, 'price' => 1.0812, 'placedAt' => time()]];
        return ['ok' => true, 'data' => []];
    };
    // env trading flag off → refuse
    $off = new Mt5BridgeConnector('https://bridge.example', true, $bridgeTrading, 'tok', false);
    assert_false($off->capabilities()['orderSubmission']);
    assert_throws(RuntimeException::class, fn() => $off->placeOrder(['symbol' => 'EURUSD', 'side' => 'BUY', 'type' => 'MARKET', 'volume' => 0.1, 'stopLoss' => 1.075]));

    // env flag on but bridge reports a LIVE account → refuse (demo-only default)
    $live = function (string $method, string $path, ?string $token, ?array $body) use ($bridgeTrading) {
        if ($path === '/health') return ['ok' => true, 'version' => '1.0.0', 'tradingEnabled' => true, 'accountType' => 'live'];
        return $bridgeTrading($method, $path, $token, $body);
    };
    $liveConnector = new Mt5BridgeConnector('https://bridge.example', true, $live, 'tok', true);
    assert_throws(RuntimeException::class, fn() => $liveConnector->placeOrder(['symbol' => 'EURUSD', 'side' => 'BUY', 'type' => 'MARKET', 'volume' => 0.1, 'stopLoss' => 1.075]));

    // demo + both gates → order flows through with the documented body
    $bodies = [];
    $okBridge = function (string $method, string $path, ?string $token, ?array $body) use (&$bodies) {
        if ($path === '/health') return ['ok' => true, 'version' => '1.0.0', 'tradingEnabled' => true, 'accountType' => 'demo'];
        if ($path === '/v1/orders') { $bodies[] = [$method, $path, $token, $body]; return ['ok' => true, 'data' => ['ticket' => 5002, 'price' => 1.0812, 'placedAt' => time()]]; }
        return ['ok' => true, 'data' => []];
    };
    $ok = new Mt5BridgeConnector('https://bridge.example', true, $okBridge, 'tok', true);
    assert_true($ok->capabilities()['orderSubmission']);
    assert_true($ok->status()['orderSubmissionEffective']);
    $result = $ok->placeOrder(['symbol' => 'EURUSD', 'side' => 'BUY', 'type' => 'MARKET', 'volume' => 0.1, 'stopLoss' => 1.075, 'takeProfit' => 1.09]);
    assert_equals(5002, $result['ticket']);
    assert_equals('POST', $bodies[0][0]);
    assert_equals(['action' => 'BUY', 'type' => 'MARKET', 'symbol' => 'EURUSD', 'volume' => 0.1, 'stopLoss' => 1.075, 'takeProfit' => 1.09], $bodies[0][3]);
});

test('order surface validates input and supports modify/cancel/close', function () {
    $calls = [];
    $connector = new Mt5BridgeConnector('https://bridge.example', true,
        function (string $method, string $path, ?string $token, ?array $body) use (&$calls) {
            if ($path === '/health') return ['ok' => true, 'version' => '1.0.0', 'tradingEnabled' => true, 'accountType' => 'demo'];
            $calls[] = [$method, $path, $body];
            return ['ok' => true, 'data' => ['ticket' => (int) substr($path, strrpos($path, '/') + 1) ?: 77, 'price' => 1.0805, 'profit' => 3.2]];
        }, 'tok', true);

    assert_throws(InvalidArgumentException::class, fn() => $connector->placeOrder(['symbol' => 'EURUSD', 'side' => 'LONG', 'type' => 'MARKET', 'volume' => 0.1, 'stopLoss' => 1.07]));
    assert_throws(InvalidArgumentException::class, fn() => $connector->placeOrder(['symbol' => 'EURUSD', 'side' => 'BUY', 'type' => 'LIMIT', 'volume' => 0.1, 'stopLoss' => 1.07]));
    assert_throws(InvalidArgumentException::class, fn() => $connector->modifyOrder(5001, []));

    $connector->modifyOrder(5001, ['stopLoss' => 1.070]);
    $connector->cancelOrder(6001);
    $closed = $connector->closePosition(5001);
    assert_equals(['POST', '/v1/orders/5001/modify', ['stopLoss' => 1.07]], $calls[0]);
    assert_equals(['POST', '/v1/orders/6001/cancel', null], $calls[1]);
    assert_equals(3.2, $closed['profit']);
});

test('broker manager reports connector health and only surfaces verified trading connectors', function () {
    $down = new BrokerManager();
    $down->register(new Mt5BridgeConnector('https://bridge.example', true, fn(string $m, string $p, ?string $t, ?array $b) => ['ok' => false]));
    $all = $down->allStatus();
    assert_equals('DOWN', $all['mt5-bridge']['state']);
    assert_false($all['mt5-bridge']['capabilities']['orderSubmission']);
    assert_equals(null, $down->tradingConnector()); // not READY → nothing routable

    $ready = new BrokerManager();
    $ready->register(new Mt5BridgeConnector('https://bridge.example', true,
        fn(string $m, string $p, ?string $t, ?array $b) => $p === '/health'
            ? ['ok' => true, 'version' => '1.0.0', 'tradingEnabled' => true, 'accountType' => 'demo']
            : ['ok' => true, 'data' => []],
        'tok', true));
    $trading = $ready->tradingConnector();
    assert_not_null($trading);
    assert_equals('mt5-bridge', $trading->id());
});
