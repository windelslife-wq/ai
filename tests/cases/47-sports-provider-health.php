<?php
use Aegis\Sports\ProviderHealthMonitor;

function fx_provider(): array
{
    return ['id' => 1, 'provider_code' => 'p1', 'display_name' => 'P1', 'enabled' => 1];
}

test('provider health is UNKNOWN without observations (never invented)', function () {
    $m = new ProviderHealthMonitor();
    $out = $m->assess(fx_provider(), [], []);
    assert_equals('UNKNOWN', $out['status']);
});

test('provider health ONLINE with recent success', function () {
    $m = new ProviderHealthMonitor();
    $now = time();
    $health = [['provider_id' => 1, 'status' => 'ONLINE', 'observed_at' => gmdate('c', $now - 60)]];
    $runs = [['job_type' => 'FIXTURES', 'status' => 'COMPLETED', 'started_at' => gmdate('c', $now - 120), 'provider' => 'p1']];
    $out = $m->assess(fx_provider(), $health, $runs, $now);
    assert_equals('ONLINE', $out['status']);
    assert_true($out['reliability'] > 0.5);
});

test('provider health DEGRADED after a recent failure', function () {
    $m = new ProviderHealthMonitor();
    $now = time();
    $health = [
        ['provider_id' => 1, 'status' => 'DATA_ERROR', 'observed_at' => gmdate('c', $now - 120)],
        ['provider_id' => 1, 'status' => 'ONLINE', 'observed_at' => gmdate('c', $now - 7200)],
    ];
    $runs = [['job_type' => 'ODDS', 'status' => 'FAILED', 'started_at' => gmdate('c', $now - 120), 'provider' => 'p1']];
    $out = $m->assess(fx_provider(), $health, $runs, $now);
    assert_equals('DEGRADED', $out['status']);
});

test('provider health honors provider-reported auth and rate-limit states', function () {
    $m = new ProviderHealthMonitor();
    $now = time();
    $health = [['provider_id' => 1, 'status' => 'AUTHENTICATION_ERROR', 'observed_at' => gmdate('c', $now - 60)]];
    assert_equals('AUTHENTICATION_ERROR', $m->assess(fx_provider(), $health, [], $now)['status']);
    $health2 = [['provider_id' => 1, 'status' => 'RATE_LIMITED', 'observed_at' => gmdate('c', $now - 60)]];
    assert_equals('RATE_LIMITED', $m->assess(fx_provider(), $health2, [], $now)['status']);
});

test('provider health OFFLINE when stale beyond the window', function () {
    $m = new ProviderHealthMonitor();
    $now = time();
    $health = [['provider_id' => 1, 'status' => 'ONLINE', 'observed_at' => gmdate('c', $now - 48 * 3600)]];
    $runs = [['job_type' => 'FIXTURES', 'status' => 'COMPLETED', 'started_at' => gmdate('c', $now - 48 * 3600), 'provider' => 'p1']];
    $out = $m->assess(fx_provider(), $health, $runs, $now);
    assert_equals('OFFLINE', $out['status']);
});

test('provider health DEGRADED on a high recent error rate', function () {
    $m = new ProviderHealthMonitor();
    $now = time();
    $health = [['provider_id' => 1, 'status' => 'ONLINE', 'observed_at' => gmdate('c', $now - 60)]];
    $runs = array_map(fn($i, $failed) => ['job_type' => 'ODDS', 'status' => $failed ? 'FAILED' : 'COMPLETED', 'started_at' => gmdate('c', $now - $i * 60), 'provider' => 'p1'], range(0, 7), [1, 1, 1, 0, 1, 1, 0, 1]);
    $out = $m->assess(fx_provider(), $health, $runs, $now);
    assert_equals('DEGRADED', $out['status']);
});
