<?php
use Aegis\Notifications\Notifier;
use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\NotificationRepository;
use Aegis\Sports\ModelDriftMonitor;
use Aegis\Sports\ModelPerformanceService;

function fx_model_audit(): AuditRepository
{
    return new class implements AuditRepository { public array $events = []; public function emit(string $t, string $s, array $d = [], string $a = 'system'): void { $this->events[] = ['type' => $t, 'detail' => $d]; } public function recent(int $l = 100): array { return []; } };
}

function fx_notif(): array
{
    $repo = new class implements NotificationRepository {
        public array $rows = [];
        public function save(array $n): array { $n['id'] = 'n' . (count($this->rows) + 1); $this->rows[] = $n; return $n; }
        public function list(?int $u = null, bool $r = false, int $l = 50): array { return $this->rows; }
        public function markRead(string $id, ?int $u = null): bool { return true; }
        public function markAllRead(?int $u = null): int { return 0; }
        public function unreadCount(?int $u = null): int { return count($this->rows); }
        public function hasUnreadDedupe(string $k): bool { foreach ($this->rows as $r) if (($r['dedupeKey'] ?? null) === $k) return true; return false; }
    };
    return [$repo, new Notifier($repo)];
}

/** Seed a model version with settled prediction outcomes across two windows. */
function fx_model_history(SportsRepositoryStub $repo, int $modelId, int $recentAccuracyPct, int $baselineAccuracyPct): void
{
    // recent window: last 14 days; baseline: 14..42 days ago.
    // The stored model probability is FIXED (0.7, no approved calibration in
    // this fixture) — it must not depend on the outcome, or measured accuracy
    // is leaked to 100%. Measured accuracy = the model's win rate.
    // Match ids are unique per model version: shared ids would let a later
    // seed overwrite an earlier model's stored results (same match+provider).
    $recentBase = 4000 + $modelId * 1000;
    $baselineBase = 5000 + $modelId * 1000;
    for ($i = 0; $i < 25; $i++) {
        $recentWin = ($i * 100 / 25) < $recentAccuracyPct;
        $baselineWin = ($i * 100 / 25) < $baselineAccuracyPct;
        $repo->predictions[] = [
            'id' => 'prd_r' . $i, 'match_id' => $recentBase + $i, 'model_version_id' => $modelId,
            'market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5',
            'raw_probability' => 0.7, 'calibrated_probability' => null,
            'created_at' => gmdate('Y-m-d H:i:s', strtotime('-' . (1 + $i % 12) . ' days')),
        ];
        $repo->predictions[] = [
            'id' => 'prd_b' . $i, 'match_id' => $baselineBase + $i, 'model_version_id' => $modelId,
            'market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5',
            'raw_probability' => 0.7, 'calibrated_probability' => null,
            'created_at' => gmdate('Y-m-d H:i:s', strtotime('-' . (20 + $i % 18) . ' days')),
        ];
        foreach ([['r', $recentBase + $i, $recentWin], ['b', $baselineBase + $i, $baselineWin]] as [$tag, $mid, $win]) {
            $repo->matches[] = ['id' => $mid, 'provider_id' => 1, 'external_id' => 'm' . $mid, 'competition' => 'L', 'home_team' => 'H', 'away_team' => 'A', 'kickoff_at' => gmdate('c'), 'status' => 'FINISHED', 'source_timestamp' => gmdate('c'), 'payload' => []];
            $repo->saveResult($mid, 1, ['homeScore' => $win ? 2 : 0, 'awayScore' => 0, 'status' => 'FINISHED', 'sourceTimestamp' => gmdate('c'), 'payload' => []]);
            $r = $repo->findResult($mid, 1);
            $repo->verifyResult((int) $r['id']);
        }
    }
}

test('model performance metrics are computed from stored outcomes only', function () {
    $repo = new SportsRepositoryStub();
    $audit = fx_model_audit();
    $svc = new ModelPerformanceService($repo, $audit);
    $modelId = $repo->ensureModelVersion(['modelName' => 'M', 'modelVersion' => '1', 'featureVersion' => 'f']);
    // nothing settled yet → no invented metrics
    $m = $svc->metricsFor($modelId, 30);
    assert_equals(0, $m['samples']);
    assert_true($m['accuracy'] === null);
    fx_model_history($repo, $modelId, 80, 70);
    $m = $svc->metricsFor($modelId, 90);
    assert_true($m['samples'] >= 50);
    assert_true($m['accuracy'] > 0.6 && $m['accuracy'] < 1.0);
    assert_not_null($m['brier']);
    assert_not_null($m['ece']);
    assert_true(count($repo->modelMetrics) >= 1, 'metric snapshot stored');
});

test('model comparison reports every version with measured metrics', function () {
    $repo = new SportsRepositoryStub();
    $audit = fx_model_audit();
    $svc = new ModelPerformanceService($repo, $audit);
    $v1 = $repo->ensureModelVersion(['modelName' => 'M', 'modelVersion' => '1.0', 'featureVersion' => 'f']);
    $v2 = $repo->ensureModelVersion(['modelName' => 'M', 'modelVersion' => '1.1', 'featureVersion' => 'f']);
    fx_model_history($repo, $v1, 85, 80);
    fx_model_history($repo, $v2, 60, 55);
    $compare = $svc->compare(90);
    assert_equals(2, count($compare));
    $byVersion = [];
    foreach ($compare as $row) $byVersion[$row['modelVersion']] = $row['metrics']['accuracy'];
    assert_true($byVersion['1.0'] > $byVersion['1.1'], 'measured comparison, not newest-wins');
});

test('drift monitor warns on accuracy deterioration and notifies once', function () {
    $repo = new SportsRepositoryStub();
    $audit = fx_model_audit();
    [$notifRepo, $notifier] = fx_notif();
    $monitor = new ModelDriftMonitor($repo, $audit, $notifier);
    $modelId = $repo->ensureModelVersion(['modelName' => 'Drift Model', 'modelVersion' => '1.2', 'featureVersion' => 'f']);
    fx_model_history($repo, $modelId, 30, 75); // recent much worse than baseline
    $report = $monitor->monitor();
    assert_equals(1, $report['warnings']);
    $entry = $report['models'][0];
    assert_equals('DRIFT_WARNING', $entry['status']);
    assert_true(count($entry['reasons']) >= 1);
    $driftEvents = array_values(array_filter($audit->events, fn($e) => $e['type'] === 'SPORTS_MODEL_DRIFT_WARNING'));
    assert_equals(1, count($driftEvents));
    assert_contains('accuracy dropped', implode(' | ', $driftEvents[0]['detail']['reasons']));
    assert_true(count($notifRepo->rows) >= 1, 'operator notification raised');
    assert_contains('MODEL PERFORMANCE WARNING', $notifRepo->rows[0]['title']);
    // second run the same day is deduped (unread key) — audit still records the run
    $monitor->monitor();
    assert_equals(1, count($notifRepo->rows), 'notification deduped while unread');
});

test('drift monitor reports insufficient data instead of guessing', function () {
    $repo = new SportsRepositoryStub();
    $audit = fx_model_audit();
    $monitor = new ModelDriftMonitor($repo, $audit);
    $modelId = $repo->ensureModelVersion(['modelName' => 'New', 'modelVersion' => '2.0', 'featureVersion' => 'f']);
    $report = $monitor->monitor();
    assert_equals(0, $report['warnings']);
    assert_equals('INSUFFICIENT_RECENT_DATA', $report['models'][0]['status']);
});
