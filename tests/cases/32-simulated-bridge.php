<?php
/**
 * SIMULATED MT5 bridge (offline demo): marker configuration contract, the
 * connector's simulated flag, and the honesty rules around it. The mock
 * bridge itself lives in runtime/server.mjs (dev only) and speaks the same
 * contract as python-services/mt5-bridge (tested in 09 via transport fakes).
 */
use Aegis\Brokers\DemoBridgeConfig;
use Aegis\Brokers\Mt5BridgeConnector;

function sb_marker(): string
{
    return sys_get_temp_dir() . '/aegis-mt5-demo-' . uniqid() . '.json';
}

test('demo marker enable/disable round trip', function () {
    $path = sb_marker();
    $marker = DemoBridgeConfig::enable($path, 8791);
    assert_true($marker['enabled']);
    assert_true(strlen($marker['token']) >= 16);
    $desc = DemoBridgeConfig::describe($path);
    assert_equals(8791, $desc['port']);
    assert_true($desc['simulated']);

    DemoBridgeConfig::disable($path);
    $desc = DemoBridgeConfig::describe($path);
    assert_equals(null, $desc, 'disabled marker is inactive');
    @unlink($path);
});

test('applyEnv configures loopback bridge env from an enabled marker', function () {
    $path = sb_marker();
    DemoBridgeConfig::enable($path, 8791);
    // ensure no explicit real bridge is configured
    putenv('AEGIS_MT5_BRIDGE_URL');
    $desc = DemoBridgeConfig::applyEnv($path);
    assert_not_null($desc);
    assert_equals('http://127.0.0.1:8791', getenv('AEGIS_MT5_BRIDGE_URL'));
    assert_equals('1', getenv('AEGIS_MT5_BRIDGE_ENABLED'));
    assert_equals('1', getenv('AEGIS_MT5_TRADING_ENABLED'));
    assert_equals('0', getenv('AEGIS_MT5_LIVE_ALLOWED'), 'a simulated bridge can never be live');
    assert_true(strlen((string) getenv('AEGIS_MT5_BRIDGE_TOKEN')) >= 16);
    DemoBridgeConfig::disable($path);
    @unlink($path);
    putenv('AEGIS_MT5_BRIDGE_URL');
    putenv('AEGIS_MT5_BRIDGE_TOKEN');
    putenv('AEGIS_MT5_BRIDGE_ENABLED');
    putenv('AEGIS_MT5_TRADING_ENABLED');
    putenv('AEGIS_MT5_LIVE_ALLOWED');
});

test('applyEnv never overrides an explicitly configured real bridge', function () {
    $path = sb_marker();
    DemoBridgeConfig::enable($path, 8791);
    putenv('AEGIS_MT5_BRIDGE_URL=https://real-bridge.internal:8787');
    assert_equals(null, DemoBridgeConfig::applyEnv($path), 'explicit real bridge wins');
    assert_equals('https://real-bridge.internal:8787', getenv('AEGIS_MT5_BRIDGE_URL'));
    @unlink($path);
    putenv('AEGIS_MT5_BRIDGE_URL');
});

test('applyEnv ignores missing or malformed markers', function () {
    $missing = sb_marker() . '-absent';
    assert_equals(null, DemoBridgeConfig::applyEnv($missing));

    $bad = sb_marker();
    file_put_contents($bad, json_encode(['enabled' => true, 'token' => 'short', 'port' => 8791]));
    assert_equals(null, DemoBridgeConfig::applyEnv($bad), 'token too short');
    @unlink($bad);
});

test('connector surfaces the bridge-reported simulated flag', function () {
    $simulated = new Mt5BridgeConnector('https://bridge.example', true,
        fn(string $m, string $p, ?string $t, ?array $b) => ['ok' => true, 'version' => 'sim-1.0.0', 'tradingEnabled' => true, 'accountType' => 'demo', 'simulated' => true],
        'tok', true);
    $status = $simulated->status();
    assert_equals('READY', $status['state']);
    assert_true($status['simulated']);
    assert_true($status['orderSubmissionEffective']);
    assert_contains('SIMULATED', $status['message']);

    $real = new Mt5BridgeConnector('https://bridge.example', true,
        fn(string $m, string $p, ?string $t, ?array $b) => ['ok' => true, 'version' => '1.2.3', 'tradingEnabled' => true, 'accountType' => 'demo'],
        'tok', true);
    $realStatus = $real->status();
    assert_false($realStatus['simulated']);
    assert_equals('Bridge reachable.', $realStatus['message']);
});

test('a simulated bridge is still bound by the connector gates (demo account check)', function () {
    // a "live" simulated bridge must still be refused
    $liveSim = new Mt5BridgeConnector('https://bridge.example', true,
        fn(string $m, string $p, ?string $t, ?array $b) => $p === '/health'
            ? ['ok' => true, 'version' => 'sim-1.0.0', 'tradingEnabled' => true, 'accountType' => 'live', 'simulated' => true]
            : ['ok' => true, 'data' => ['ticket' => 1, 'price' => 1.08, 'placedAt' => time()]],
        'tok', true);
    assert_false($liveSim->status()['orderSubmissionEffective']);
    assert_throws(RuntimeException::class, fn() => $liveSim->placeOrder(['symbol' => 'EURUSD', 'side' => 'BUY', 'type' => 'MARKET', 'volume' => 0.1, 'stopLoss' => 1.07]));
});
