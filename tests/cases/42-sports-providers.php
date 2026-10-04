<?php
use Aegis\Sports\Providers\HttpSportsProvider;
use Aegis\Sports\Providers\ProviderException;
use Aegis\Sports\Providers\SandboxSportsProvider;
use Aegis\Sports\Providers\SportsDataProvider;
use Aegis\Sports\Providers\SportsProviderManager;

function fx_http(int $status, string $body = '[]'): HttpSportsProvider
{
    $transport = fn(string $url, array $headers) => ['status' => $status, 'body' => $body];
    return new HttpSportsProvider('http-test', 'https://upstream.invalid', 'secret-token', 5, $transport);
}

test('http provider classifies failures without leaking credentials', function () {
    $p401 = fx_http(401, 'denied');
    assert_throws(ProviderException::class, fn() => $p401->fixtures(['from' => '2026-09-01', 'to' => '2026-09-01']));
    try { $p401->fixtures([]); assert_true(false); }
    catch (ProviderException $e) { assert_equals(ProviderException::AUTHENTICATION_ERROR, $e->status); assert_false(str_contains($e->getMessage(), 'secret-token')); }
    try { fx_http(429)->fixtures([]); assert_true(false); }
    catch (ProviderException $e) { assert_equals(ProviderException::RATE_LIMITED, $e->status); }
    try { fx_http(500, 'boom')->fixtures([]); assert_true(false); }
    catch (ProviderException $e) { assert_equals(ProviderException::DATA_ERROR, $e->status); }
    try { fx_http(0)->fixtures([]); assert_true(false); }
    catch (ProviderException $e) { assert_equals(ProviderException::OFFLINE, $e->status); }
});

test('http provider rejects non-JSON and non-list payloads', function () {
    assert_throws(ProviderException::class, fn() => fx_http(200, 'not-json')->fixtures([]));
    assert_throws(ProviderException::class, fn() => fx_http(200, '{"a":1}')->fixtures([]));
    $ok = fx_http(200, '[{"market":"TOTAL_GOALS","selection":"OVER_1_5","decimalOdds":1.8,"observedAt":"2026-09-01T10:00:00Z"}]');
    assert_equals(1, count($ok->odds('x')));
});

test('provider manager falls back to the next online provider', function () {
    $manager = new SportsProviderManager();
    $down = new class implements SportsDataProvider {
        public function id(): string { return 'down'; }
        public function health(): array { return ['status' => 'OFFLINE']; }
        public function fixtures(array $q): array { return []; }
        public function odds(string $e): array { return []; }
        public function results(string $e): array { return []; }
    };
    $up = new class implements SportsDataProvider {
        public function id(): string { return 'up'; }
        public function health(): array { return ['status' => 'ONLINE', 'reliability' => 0.9]; }
        public function fixtures(array $q): array { return [['externalId' => 'a']]; }
        public function odds(string $e): array { return []; }
        public function results(string $e): array { return []; }
    };
    $manager->register($down);
    $manager->register($up);
    $out = $manager->withFallback('fixtures', fn($p) => $p->fixtures([]));
    assert_true($out['ok']);
    assert_equals('up', $out['provider']);
    assert_true(isset($out['failures']['down']));
    assert_equals(1, count($out['result']));
});

test('provider manager reports structured failure when every provider fails', function () {
    $manager = new SportsProviderManager();
    $dead = new class implements SportsDataProvider {
        public function id(): string { return 'dead'; }
        public function health(): array { return ['status' => 'ONLINE']; }
        public function fixtures(array $q): array { throw new ProviderException('upstream 503', ProviderException::DATA_ERROR); }
        public function odds(string $e): array { return []; }
        public function results(string $e): array { return []; }
    };
    $manager->register($dead);
    $out = $manager->withFallback('fixtures', fn($p) => $p->fixtures([]));
    assert_false($out['ok']);
    assert_contains('DATA_ERROR', $out['failures']['dead']);
});

test('sandbox provider is offline unless explicitly enabled in SANDBOX mode', function () {
    $savedMode = getenv('WINDELS_SPORTS_MODE');
    $savedSbx = getenv('WINDELS_SPORTS_SANDBOX');
    putenv('WINDELS_SPORTS_MODE=SANDBOX');
    putenv('WINDELS_SPORTS_SANDBOX');
    $off = new SandboxSportsProvider();
    assert_equals('OFFLINE', $off->health()['status']);
    assert_throws(ProviderException::class, fn() => $off->fixtures(['from' => '2026-09-01', 'to' => '2026-09-01']));
    putenv('WINDELS_SPORTS_MODE=PAPER');
    putenv('WINDELS_SPORTS_SANDBOX=1');
    assert_equals('OFFLINE', (new SandboxSportsProvider())->health()['status']); // PAPER mode never uses sandbox data
    putenv('WINDELS_SPORTS_MODE=SANDBOX');
    putenv('WINDELS_SPORTS_SANDBOX=1');
    $on = new SandboxSportsProvider();
    assert_equals('ONLINE', $on->health()['status']);
    if ($savedMode === false) putenv('WINDELS_SPORTS_MODE'); else putenv('WINDELS_SPORTS_MODE=' . $savedMode);
    if ($savedSbx === false) putenv('WINDELS_SPORTS_SANDBOX'); else putenv('WINDELS_SPORTS_SANDBOX=' . $savedSbx);
});

test('sandbox provider is deterministic and labels every record as simulated', function () {
    putenv('WINDELS_SPORTS_MODE=SANDBOX');
    putenv('WINDELS_SPORTS_SANDBOX=1');
    try {
        $a = new SandboxSportsProvider();
        $b = new SandboxSportsProvider();
        $fa = $a->fixtures(['from' => '2026-09-01', 'to' => '2026-09-02']);
        $fb = $b->fixtures(['from' => '2026-09-01', 'to' => '2026-09-02']);
        assert_equals($fa, $fb, 'same date range must produce identical fixtures');
        assert_true(count($fa) > 0);
        foreach ($fa as $f) {
            assert_true(!empty($f['simulated']), 'every fixture must be labeled simulated');
            assert_true(isset($f['context']['recentForm']['homeGoalsPerMatch']));
        }
        $ext = $fa[0]['externalId'];
        $oa = $a->odds($ext); $ob = $b->odds($ext);
        assert_equals($oa, $ob);
        assert_true($oa[0]['decimalOdds'] > 1.0);
        assert_true(!empty($oa[0]['simulated']));
        $results = $a->results($ext);
        foreach ($results as $r) assert_true(!empty($r['simulated']));
    } finally {
        putenv('WINDELS_SPORTS_MODE');
        putenv('WINDELS_SPORTS_SANDBOX');
    }
});

test('sandbox provider never fabricates results for unfinished matches', function () {
    putenv('WINDELS_SPORTS_MODE=SANDBOX');
    putenv('WINDELS_SPORTS_SANDBOX=1');
    try {
        $p = new SandboxSportsProvider();
        $future = gmdate('Y-m-d', strtotime('+3 days'));
        $fixtures = $p->fixtures(['from' => $future, 'to' => $future]);
        assert_true(count($fixtures) > 0);
        $results = $p->results($fixtures[0]['externalId']);
        assert_equals(0, count($results), 'no results may exist before the match day');
    } finally {
        putenv('WINDELS_SPORTS_MODE');
        putenv('WINDELS_SPORTS_SANDBOX');
    }
});
