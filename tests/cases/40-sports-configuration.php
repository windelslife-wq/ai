<?php
use Aegis\Persistence\AuditRepository;
use Aegis\Sports\ConfigurationService;

function fx_config_audit(): array {
    $audit = new class implements AuditRepository { public array $events = []; public function emit(string $t, string $s, array $d = [], string $a = 'system'): void { $this->events[] = ['type' => $t, 'actor' => $a, 'detail' => $d]; } public function recent(int $l = 100): array { return []; } };
    return [new SportsRepositoryStub(), $audit, new ConfigurationService(new SportsRepositoryStub(), $audit)];
}

test('configuration returns safe defaults before any admin change', function () {
    [, , $svc] = fx_config_audit();
    $c = $svc->active();
    assert_equals('USER_APPROVAL_REQUIRED', $c['engine_mode']);
    assert_equals(75.0, (float) $c['min_confidence']);
    assert_equals('RESTITUTE_ODDS', $c['void_policy']);
});

test('configuration updates are versioned and audited with old/new values', function () {
    $repo = new SportsRepositoryStub();
    $audit = new class implements AuditRepository { public array $events = []; public function emit(string $t, string $s, array $d = [], string $a = 'system'): void { $this->events[] = ['type' => $t, 'actor' => $a, 'detail' => $d]; } public function recent(int $l = 100): array { return []; } };
    $svc = new ConfigurationService($repo, $audit);
    $r1 = $svc->update(['target_odds_min' => 6.0, 'target_odds_max' => 9.0], 'admin-1', 'tighten odds band');
    assert_true($r1['ok']);
    assert_equals(1, (int) $r1['configuration']['version']);
    $r2 = $svc->update(['min_confidence' => 80.0], 'admin-2', 'stricter');
    assert_true($r2['ok']);
    assert_equals(2, (int) $r2['configuration']['version']);
    assert_equals(6.0, (float) $r2['configuration']['target_odds_min']); // previous value preserved
    assert_equals(2, count($repo->configurations));
    $ev = end($audit->events);
    assert_equals('admin-2', $ev['actor']);
    assert_true(isset($ev['detail']['previous'], $ev['detail']['new'], $ev['detail']['reason']));
});

test('configuration validation rejects malformed values', function () {
    [, , $svc] = fx_config_audit();
    assert_false($svc->update(['target_odds_min' => 8, 'target_odds_max' => 5], 'a')['ok']);
    assert_false($svc->update(['max_selections' => 0], 'a')['ok']);
    assert_false($svc->update(['min_data_quality' => 10], 'a')['ok']);
    assert_false($svc->update(['stake_amount' => 500, 'max_exposure' => 10], 'a')['ok']);
    assert_false($svc->update(['platform_mode' => 'MOON'], 'a')['ok']);
    assert_false($svc->update(['allowed_markets' => 'TOTAL_GOALS'], 'a')['ok']);
});

test('AUTOMATED_EXECUTION is refused without explicit authorization', function () {
    [, , $svc] = fx_config_audit();
    $r = $svc->update(['engine_mode' => 'AUTOMATED_EXECUTION'], 'admin');
    assert_false($r['ok']);
    assert_contains('AUTOMATED_EXECUTION', $r['reason']);
    $ok = $svc->update(['engine_mode' => 'AUTOMATED_EXECUTION'], 'admin', 'explicit', true);
    assert_true($ok['ok']);
    assert_equals('AUTOMATED_EXECUTION', $ok['configuration']['engine_mode']);
});
