<?php
use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\SportsRepository;
use Aegis\Sports\DataQualityEngine;
use Aegis\Sports\Providers\SportsDataProvider;
use Aegis\Sports\SportsSyncService;

function fx_sports_sync(): array {
    $repo = new SportsRepositoryStub();
    $audit = new class implements AuditRepository { public array $events = []; public function emit(string $type, string $summary, array $detail = [], string $actor = 'system'): void { $this->events[] = $type; } public function recent(int $limit = 100): array { return []; } };
    return [new SportsSyncService($repo, $audit, new DataQualityEngine()), $repo, $audit];
}
function fx_sports_provider(array $fixtures, string $status = 'ONLINE'): SportsDataProvider { return new class($fixtures, $status) implements SportsDataProvider { public function __construct(private array $items, private string $state) {} public function id(): string { return 'test-sports'; } public function health(): array { return ['status' => $this->state, 'reliability' => .9]; } public function fixtures(array $query): array { return $this->items; } public function odds(string $fixtureExternalId): array { return []; } public function results(string $fixtureExternalId): array { return []; } }; }
test('sports fixture sync is idempotent and audits completion', function () {
    [$sync, $repo, $audit] = fx_sports_sync(); $p = fx_sports_provider([['externalId' => 'x', 'homeTeam' => 'H', 'awayTeam' => 'A', 'competition' => 'L', 'kickoff' => '2026-09-01T12:00:00Z']]);
    $first = $sync->syncFixtures($p, [], 'key-1'); assert_equals('COMPLETED', $first['status']); assert_equals(1, count($repo->matches)); assert_equals('SPORTS_FIXTURE_SYNC_COMPLETED', $audit->events[0]);
    assert_equals('DUPLICATE_SKIPPED', $sync->syncFixtures($p, [], 'key-1')['status']);
});
test('sports fixture sync counts invalid records rather than persisting them', function () {
    [$sync, $repo] = fx_sports_sync(); $result = $sync->syncFixtures(fx_sports_provider([['externalId' => 'bad']]), [], 'key-2');
    assert_equals('COMPLETED', $result['status']); assert_equals(1, count($result['errors'])); assert_equals(0, count($repo->matches));
});
