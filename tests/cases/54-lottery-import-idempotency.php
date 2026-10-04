<?php
/**
 * WINDELS Lottery Intelligence — Phases 6/7/8/19 (spec §5/§6/§28): ingestion
 * through the historical database. Rules: never fabricate, never store
 * invalid data as official, idempotent imports, verified results never
 * silently overwritten, full source attribution on every row.
 */
use Aegis\Lottery\LotteryIntelligence;
use Aegis\Lottery\SandboxLotteryProvider;
use Aegis\Lottery\UnavailableLotteryProvider;

function fx_lotto_audit(): \Aegis\Persistence\AuditRepository
{
    return new class implements \Aegis\Persistence\AuditRepository {
        public array $events = [];
        public function emit(string $t, string $s, array $d = [], string $a = 'system'): void { $this->events[] = ['type' => $t, 'actor' => $a, 'detail' => $d]; }
        public function recent(int $l = 100): array { return []; }
    };
}

function fx_lotto_stack(): array
{
    $repo = new LotteryRepositoryStub();
    $audit = fx_lotto_audit();
    $intel = new LotteryIntelligence($repo, $audit, new UnavailableLotteryProvider());
    return [$repo, $audit, $intel];
}

test('lottery status: honest DISABLED_NO_PROVIDER without a provider', function () {
    [$repo, $audit, $intel] = fx_lotto_stack();
    $s = $intel->status();
    assert_equals('DISABLED_NO_PROVIDER', $s['engine']);
    assert_equals('UNCONFIGURED', $s['provider']['state']);
    assert_equals(0, $s['drawsTracked']);
    assert_equals('EUROMILLIONS', $s['activeLottery']);
    assert_contains('independent random events', $s['disclaimer']);
    assert_equals('1.0', $s['modelVersion'], 'WINDELS Lottery Model version is exposed');
    assert_true(count($repo->lotteries) === 1, 'lottery registry seeded exactly once');
    $intel->status();
    assert_true(count($repo->lotteries) === 1, 'ensureLottery is idempotent');
});

test('lottery import: valid draws stored VERIFIED with full source attribution', function () {
    [$repo, $audit, $intel] = fx_lotto_stack();
    $sum = $intel->importDraws([fx_valid_draw()]);
    assert_equals(1, $sum['imported']);
    $draw = $repo->findDrawByExternal('EUROMILLIONS', '2026-188');
    assert_not_null($draw);
    assert_equals('VERIFIED', $draw['verification_status']);
    assert_equals('test-official-source', $draw['source']);
    assert_equals('2026-08-21T21:15:00+00:00', $draw['source_timestamp']);
    assert_not_null($draw['retrieved_at']);
    assert_equals([4, 17, 23, 34, 48], $draw['payload']['main']);
    assert_equals(7, count($repo->listDrawNumbers((int) $draw['id'])), '5 main + 2 star normalized rows');
    $ev = array_values(array_filter($audit->events, fn($e) => $e['type'] === 'LOTTERY_DRAW_IMPORTED'));
    assert_equals(1, count($ev), 'import audited');
});

test('lottery import: re-import of identical data is a no-op (idempotent)', function () {
    [$repo, $audit, $intel] = fx_lotto_stack();
    $intel->importDraws([fx_valid_draw()]);
    $sum = $intel->importDraws([fx_valid_draw()]);
    assert_equals(0, $sum['imported']);
    assert_equals(1, $sum['unchanged']);
    assert_equals(1, $repo->countDraws('EUROMILLIONS'), 'no duplicate draw row');
    $ev = array_values(array_filter($audit->events, fn($e) => $e['type'] === 'LOTTERY_DRAW_IMPORTED'));
    assert_equals(1, count($ev), 'no duplicate import audit events');
});

test('lottery import: invalid draws are never stored and are audited', function () {
    [$repo, $audit, $intel] = fx_lotto_stack();
    $sum = $intel->importDraws([
        fx_valid_draw(['main' => [1, 1, 2, 3, 4]]),
        fx_valid_draw(['externalId' => 'X-1', 'drawDate' => 'bad']),
    ]);
    assert_equals(0, $sum['imported']);
    assert_equals(2, $sum['failed']);
    assert_equals(0, $repo->countDraws('EUROMILLIONS'), 'failed draws never reach the database');
    $ev = array_values(array_filter($audit->events, fn($e) => $e['type'] === 'LOTTERY_DRAW_VALIDATION_FAILED'));
    assert_equals(2, count($ev), 'each rejection audited with its errors');
});

test('lottery import: verified results are never silently overwritten', function () {
    [$repo, $audit, $intel] = fx_lotto_stack();
    $intel->importDraws([fx_valid_draw()]);
    $sum = $intel->importDraws([fx_valid_draw(['main' => [9, 10, 11, 12, 13]])]);
    assert_equals(0, $sum['imported']);
    assert_equals(1, $sum['conflicts']);
    $draw = $repo->findDrawByExternal('EUROMILLIONS', '2026-188');
    assert_equals([4, 17, 23, 34, 48], $draw['payload']['main'], 'original verified numbers untouched');
    $ev = array_values(array_filter($audit->events, fn($e) => $e['type'] === 'LOTTERY_RESULT_CONFLICT'));
    assert_equals(1, count($ev), 'conflict audited — manual correction required');
});

test('lottery sync: provider health recorded; sandbox draws are labeled synthetic', function () {
    $repo = new LotteryRepositoryStub();
    $audit = fx_lotto_audit();
    $intel = new LotteryIntelligence($repo, $audit, new SandboxLotteryProvider());
    putenv('WINDELS_LOTTERY_SANDBOX=1');
    try {
        $sum = $intel->sync(10);
        assert_equals('OK', $sum['status']);
        assert_true($sum['imported'] > 0, 'sandbox draws imported');
        assert_equals(0, $sum['failed'], 'sandbox draws always pass validation');
        $h = $intel->providerHealth();
        assert_not_null($h['latest']);
        assert_equals('ONLINE', $h['latest']['status']);
        assert_equals(1, (int) $h['latest']['synthetic'], 'sandbox health explicitly labeled synthetic');
        foreach ($repo->draws as $d) {
            assert_equals(SandboxLotteryProvider::SOURCE, $d['source'], 'every stored row carries the simulation label');
        }
    } finally {
        putenv('WINDELS_LOTTERY_SANDBOX');
    }
});

test('lottery sandbox: offline without the env flag, deterministic when enabled', function () {
    putenv('WINDELS_LOTTERY_SANDBOX');
    $off = new SandboxLotteryProvider();
    assert_equals('OFFLINE', $off->health()['state']);
    assert_equals(0, count($off->draws(null, null, 10)), 'no draws without the flag — never silent simulation');
    assert_null($off->jackpotInfo(), 'no fabricated jackpot figures');

    putenv('WINDELS_LOTTERY_SANDBOX=1');
    try {
        $a = (new SandboxLotteryProvider(7))->draws(null, null, 12);
        $b = (new SandboxLotteryProvider(7))->draws(null, null, 12);
        assert_equals(12, count($a));
        assert_equals($a, $b, 'deterministic per seed');
        $validator = new \Aegis\Lottery\LotteryResultValidator(new \Aegis\Lottery\EuroMillionsRules());
        foreach ($a as $d) {
            assert_true($validator->validate($d)['valid'], 'every sandbox draw obeys the official rules');
        }
        $ji = (new SandboxLotteryProvider())->jackpotInfo();
        assert_equals(SandboxLotteryProvider::SOURCE, $ji['source']);
        assert_contains('Simulated', $ji['note'], 'sandbox jackpot info is clearly simulated');
    } finally {
        putenv('WINDELS_LOTTERY_SANDBOX');
    }
});
