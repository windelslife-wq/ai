<?php
use Aegis\Persistence\AuditRepository;
use Aegis\Sports\ConfidenceEngine;
use Aegis\Sports\ConfigurationService;
use Aegis\Sports\CorrelationEngine;
use Aegis\Sports\DailyTicketService;
use Aegis\Sports\DataQualityEngine;
use Aegis\Sports\DecisionRecorder;
use Aegis\Sports\FeatureEngineeringEngine;
use Aegis\Sports\MatchIntelligenceEngine;
use Aegis\Sports\OddsFreshnessEngine;
use Aegis\Sports\PredictionEngine;
use Aegis\Sports\PredictionPipeline;
use Aegis\Sports\Providers\SportsDataProvider;
use Aegis\Sports\Providers\SportsProviderManager;
use Aegis\Sports\RiskEngine;
use Aegis\Sports\TicketGovernance;
use Aegis\Sports\TicketOptimizer;
use Aegis\Sports\ValueEngine;

function fx_daily_audit(): AuditRepository
{
    return new class implements AuditRepository { public array $events = []; public function emit(string $t, string $s, array $d = [], string $a = 'system'): void { $this->events[] = ['type' => $t, 'actor' => $a, 'detail' => $d]; } public function recent(int $l = 100): array { return []; } };
}

/** Deterministic test provider: 5 upcoming fixtures with verified form context + fresh OVER_1.5 odds. */
function fx_daily_provider(array $oddsByExt): SportsDataProvider
{
    $fixtures = [];
    $odds = $oddsByExt;
    for ($i = 0; $i < 5; $i++) {
        $fixtures[] = [
            'externalId' => 'f' . $i,
            'homeTeam' => 'Home' . $i, 'awayTeam' => 'Away' . $i,
            'competition' => 'Test League',
            'kickoff' => gmdate('Y-m-d\TH:i:00\+00:00', strtotime('+1 day ' . (10 + $i) . ':00:00')),
            'status' => 'SCHEDULED',
            'context' => [
                'recentForm' => [
                    'homeGoalsPerMatch' => 1.6, 'awayGoalsPerMatch' => 1.4,
                    'homeConcededPerMatch' => 1.0, 'awayConcededPerMatch' => 0.9,
                    'source' => 'test-verified', 'timestamp' => gmdate('c'),
                ],
                'marketLiquidity' => 50000,
            ],
        ];
    }
    return new class($fixtures, $odds) implements SportsDataProvider {
        public function __construct(private array $fixtures, private array $odds) {}
        public function id(): string { return 'daily-test'; }
        public function health(): array { return ['status' => 'ONLINE', 'reliability' => 0.9]; }
        public function fixtures(array $q): array { return $this->fixtures; }
        public function odds(string $e): array { return $this->odds[$e] ?? []; }
        public function results(string $e): array { return []; }
    };
}

function fx_daily_stack(): array
{
    $repo = new SportsRepositoryStub();
    $audit = fx_daily_audit();
    $providers = new SportsProviderManager();
    $providers->register(fx_daily_provider([
        'f0' => [['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'decimalOdds' => 1.55, 'observedAt' => gmdate('c')]],
        'f1' => [['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'decimalOdds' => 1.75, 'observedAt' => gmdate('c')]],
        'f2' => [['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'decimalOdds' => 1.9, 'observedAt' => gmdate('c')]],
        'f3' => [['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'decimalOdds' => 2.1, 'observedAt' => gmdate('c')]],
        'f4' => [['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'decimalOdds' => 2.3, 'observedAt' => gmdate('c')]],
    ]));
    $config = new ConfigurationService($repo, $audit);
    $quality = new DataQualityEngine();
    $pipeline = new PredictionPipeline(new MatchIntelligenceEngine(new OddsFreshnessEngine()), new FeatureEngineeringEngine(), new PredictionEngine(), new ValueEngine(), new RiskEngine(), new CorrelationEngine(), new ConfidenceEngine());
    $governance = new TicketGovernance($repo, $audit, new CorrelationEngine());
    $service = new DailyTicketService($repo, $audit, $providers, $config, $quality, $pipeline, new TicketOptimizer(new CorrelationEngine()), $governance, new DecisionRecorder($repo, $audit));
    return [$repo, $audit, $service, $providers];
}

function fx_approve_calibration(SportsRepositoryStub $repo): void
{
    $modelId = $repo->ensureModelVersion(['modelName' => PredictionEngine::MODEL_NAME, 'modelVersion' => PredictionEngine::MODEL_VERSION, 'featureVersion' => FeatureEngineeringEngine::VERSION]);
    $repo->saveCalibration(['model_version_id' => $modelId, 'method' => 'platt', 'intercept' => 0.2, 'slope' => 1.5, 'samples' => 40, 'ece' => 0.02, 'status' => 'APPROVED', 'created_by' => 'admin', 'created_at' => gmdate('c')]);
}

test('daily ticket E2E: qualified ticket awaits user approval', function () {
    [$repo, $audit, $service] = fx_daily_stack();
    fx_approve_calibration($repo);
    $date = gmdate('Y-m-d', strtotime('+1 day'));
    $run = $service->runDaily($date);
    assert_equals('PENDING_USER_APPROVAL', $run['status']);
    assert_not_null($run['ticketId']);
    assert_equals(5, $run['evaluated']);
    assert_equals(5, $run['predictionsRecorded']);
    $ticket = $repo->findTicket($run['ticketId']);
    assert_equals('PENDING_USER_APPROVAL', $ticket['approval_status']);
    assert_true($ticket['total_odds'] >= 5.0 && $ticket['total_odds'] <= 8.0, 'odds inside configured range');
    assert_true($ticket['selection_count'] >= 1 && $ticket['selection_count'] <= 5);
    assert_true($ticket['confidence'] >= 75.0, 'min confidence enforced');
    assert_equals(10.0, (float) $ticket['stake']);
    $daily = $repo->findDailyTicket($date);
    assert_equals('PENDING_USER_APPROVAL', $daily['status']);
    assert_equals($run['ticketId'], $daily['ticket_id']);
    // decisions stored for every evaluated match with full factors
    $preds = $repo->listPredictions([], 100);
    assert_equals(5, count($preds));
    $p = $preds[0];
    assert_not_null($p['odds']);
    assert_true(isset($p['factors']['drivers'], $p['factors']['gate'], $p['factors']['calibration']));
    // idempotency: same date + config version never creates a second ticket
    $again = $service->runDaily($date);
    assert_equals('DUPLICATE_SKIPPED', $again['status']);
    assert_equals(1, count($repo->tickets));
});

test('daily ticket E2E: approval flow with audit attribution', function () {
    [$repo, $audit, $service, $providers] = fx_daily_stack();
    fx_approve_calibration($repo);
    $date = gmdate('Y-m-d', strtotime('+1 day'));
    $run = $service->runDaily($date);
    $governance = new TicketGovernance($repo, $audit, new CorrelationEngine());
    $decision = $governance->decide($run['ticketId'], true, 'admin-9', 'looks right');
    assert_equals('APPROVED_NOT_EXECUTED', $decision['approvalStatus']);
    assert_false($decision['externalExecution']);
    $ticket = $repo->findTicket($run['ticketId']);
    assert_equals('APPROVED', $ticket['status']);
    $ev = array_values(array_filter($audit->events, fn($e) => $e['type'] === 'SPORTS_TICKET_APPROVED'));
    assert_equals(1, count($ev));
    assert_equals('admin-9', $ev[0]['actor']);
    assert_throws(RuntimeException::class, fn() => $governance->decide($run['ticketId'], false, 'admin-9'));
});

test('daily ticket E2E: without approved calibration nothing is predicted', function () {
    [$repo, $audit, $service] = fx_daily_stack();
    $date = gmdate('Y-m-d', strtotime('+1 day'));
    $run = $service->runDaily($date);
    assert_equals('NO_QUALIFIED_TICKET', $run['status']);
    assert_equals(0, count($repo->tickets));
    $daily = $repo->findDailyTicket($date);
    assert_equals('NO_QUALIFIED_TICKET', $daily['status']);
    assert_true(isset($daily['rejection_summary']['MODEL_NOT_CALIBRATED']), 'rejection reasons are stored');
    $preds = $repo->listPredictions([], 100);
    assert_equals(5, count($preds), 'decisions are still recorded for rejected candidates');
    foreach ($preds as $p) assert_equals('NO_PREDICTION', $p['decision']);
});

test('daily ticket E2E: no provider configured → DISABLED_NO_PROVIDER, nothing fabricated', function () {
    $repo = new SportsRepositoryStub();
    $audit = fx_daily_audit();
    $providers = new SportsProviderManager();
    $service = new DailyTicketService($repo, $audit, $providers, new ConfigurationService($repo, $audit), new DataQualityEngine(), new PredictionPipeline(), new TicketOptimizer(), new TicketGovernance($repo, $audit), new DecisionRecorder($repo, $audit));
    $run = $service->runDaily(gmdate('Y-m-d'));
    assert_equals('NO_QUALIFIED_TICKET', $run['status']);
    assert_contains('DISABLED_NO_PROVIDER', $run['message']);
    assert_equals(0, count($repo->matches));
    assert_equals(0, count($repo->tickets));
});

test('daily ticket E2E: provider failure is graceful and reported', function () {
    $repo = new SportsRepositoryStub();
    $audit = fx_daily_audit();
    $providers = new SportsProviderManager();
    $broken = new class implements SportsDataProvider {
        public function id(): string { return 'broken'; }
        public function health(): array { return ['status' => 'ONLINE']; }
        public function fixtures(array $q): array { throw new \Aegis\Sports\Providers\ProviderException('upstream down', \Aegis\Sports\Providers\ProviderException::OFFLINE); }
        public function odds(string $e): array { return []; }
        public function results(string $e): array { return []; }
    };
    $providers->register($broken);
    $service = new DailyTicketService($repo, $audit, $providers, new ConfigurationService($repo, $audit), new DataQualityEngine(), new PredictionPipeline(), new TicketOptimizer(), new TicketGovernance($repo, $audit), new DecisionRecorder($repo, $audit));
    $run = $service->runDaily(gmdate('Y-m-d'));
    assert_equals('NO_QUALIFIED_TICKET', $run['status']);
    assert_contains('provider failure', $run['message']);
    assert_equals(0, count($repo->tickets));
});

test('daily ticket E2E: engine mode VIEW_ONLY never generates tickets', function () {
    [$repo, $audit, $service] = fx_daily_stack();
    (new ConfigurationService($repo, $audit))->update(['engine_mode' => 'VIEW_ONLY'], 'admin', 'view only');
    $run = $service->runDaily(gmdate('Y-m-d', strtotime('+1 day')));
    assert_equals('NO_QUALIFIED_TICKET', $run['status']);
    assert_contains('VIEW_ONLY', $run['message']);
    assert_equals(0, count($repo->tickets));
});
