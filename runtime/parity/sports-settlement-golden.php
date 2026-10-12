<?php
/**
 * Slice 5 golden cases: result verification, ticket settlement, performance analytics,
 * model drift monitoring, model metrics and the point-in-time backtester (row 14,
 * slice 5). Included by `sports-golden.php`, which has already defined `outcome()`,
 * `strip_clock()` and the `$sports` path. This file returns the cases; it writes
 * nothing, and the legacy tree is only ever read (`require_once` by path).
 *
 * The slice-3 and slice-4 generators could confine themselves to pure engines. Slice
 * 5's engines are repository-bound, so each group drives the REAL legacy class over a
 * scripted fake repository — an array-backed implementation of the real
 * `Aegis\Persistence\SportsRepository` and `AuditRepository` interfaces that records
 * every write. The fake is the same technique the Node tests use against the MySQL
 * adapter, and it is what makes the settlement arithmetic (effective odds, P/L, the
 * void policy) and the drift reason strings comparable at all: they live inside
 * private methods behind repository calls on both sides.
 *
 * Two legacy behaviours are captured as **evidence** rather than as expectations, both
 * inherited from `CalibrationEngine::evaluate` (finding F-36, already evidenced in
 * slice 3): PHP casts each squared error to int before summing, so PHP's Brier score
 * is always 0.0 while the port computes the real one. That surfaces in the drift
 * windows, the performance report's calibration block and the backtest report. The
 * Node test asserts the golden value IS 0.0 and that its own value is the real score —
 * a comparison that pretended the two agreed would be worse than no comparison.
 *
 * Clock handling: `ResultVerificationEngine::verify()` stamps `verifiedAt` from
 * `gmdate('c')` with no injectable clock, so the generator unsets it; the Node test
 * passes a fixed instant and unsets its own stamp. The backtest report's
 * `generatedAt` and random `id` are sentinelized the same way.
 */

use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\SportsRepository;
use Aegis\Sports\DataQualityEngine;
use Aegis\Sports\ModelDriftMonitor;
use Aegis\Sports\ModelPerformanceService;
use Aegis\Sports\PerformanceAnalytics;
use Aegis\Sports\PredictionPipeline;
use Aegis\Sports\ResultVerificationEngine;
use Aegis\Sports\SportsBacktester;
use Aegis\Sports\TicketSettlementService;

require_once $root . '/application/libraries/Aegis/Persistence/Repositories.php';
require_once $sports . '/ResultVerificationEngine.php';
require_once $sports . '/TicketSettlementService.php';
require_once $sports . '/PerformanceAnalytics.php';
require_once $sports . '/ModelDriftMonitor.php';
require_once $sports . '/CalibrationEngine.php';
require_once $sports . '/ModelPerformanceService.php';
// The backtester composes the live pipeline; these are already loaded when slice 3
// ran first, and `require_once` makes the order irrelevant.
require_once $sports . '/FeatureEngineeringEngine.php';
require_once $sports . '/MatchIntelligenceEngine.php';
require_once $sports . '/PredictionEngine.php';
require_once $sports . '/ValueEngine.php';
require_once $sports . '/ConfidenceEngine.php';
require_once $sports . '/RiskEngine.php';
require_once $sports . '/CorrelationEngine.php';
require_once $sports . '/PredictionPipeline.php';
require_once $sports . '/SportsBacktester.php';

// Closure scope: this file's variables must not collide with the generator's.
return (function () use ($sports, $root) {

    /**
     * An array-backed `SportsRepository` that serves only the rows it was given and
     * records every write. Every method not needed by a group throws — a call the
     * scenario did not script is a bug in the scenario, not an empty answer.
     */
    final class ScriptedSportsRepository implements SportsRepository
    {
        public array $ticketPatches = [];
        public array $selectionPatches = [];
        public array $recordedOutcomes = [];
        public array $savedBacktests = [];
        public array $savedMetrics = [];
        public array $verifiedResults = [];
        public int $ensureModelVersionCalls = 0;

        public function __construct(private array $rows = []) {}

        private function need(string $key)
        {
            return $this->rows[$key] ?? throw new \LogicException("scenario did not script $key");
        }

        // ── the methods the slice-5 services actually call ──────────────────────
        public function findResult(int $matchId, int $providerId): ?array { return $this->need('results')["$matchId:$providerId"] ?? null; }
        public function findResultByMatch(int $matchId): ?array { return $this->need('resultByMatch')[$matchId] ?? null; }
        public function findTicket(string $id): ?array { return $this->need('tickets')[$id] ?? null; }
        public function ticketSelections(string $ticketId): array { return $this->need('selections')[$ticketId] ?? []; }
        public function activeConfiguration(): ?array { return $this->rows['configuration'] ?? null; }
        public function updateTicketSelection(int $id, array $patch): void { $this->selectionPatches[] = ['id' => $id, 'patch' => $patch]; }
        public function updateTicket(string $id, array $patch): void { $this->ticketPatches[] = ['id' => $id, 'patch' => $patch]; }
        public function recordTicketOutcome(string $ticketId, float $pnl): void { $this->recordedOutcomes[] = ['ticketId' => $ticketId, 'pnl' => $pnl]; }
        public function listModelVersions(): array { return $this->rows['models'] ?? []; }
        public function predictionOutcomes(?int $modelVersionId = null): array { return $this->rows['outcomes'] ?? []; }
        public function settledSelections(array $filter = []): array { return $this->rows['settledSelections'] ?? []; }
        public function saveModelMetrics(array $m): void { $this->savedMetrics[] = $m; }
        public function listMatches(array $filter = [], int $limit = 200): array { return $this->rows['matches'] ?? []; }
        public function oddsBefore(int $matchId, string $timestamp): ?array { return $this->need('oddsBefore')[$matchId] ?? null; }
        public function ensureModelVersion(array $model): int { $this->ensureModelVersionCalls++; return $this->rows['modelId'] ?? 7; }
        public function activeCalibration(int $modelVersionId): ?array { return $this->rows['calibration'] ?? null; }
        public function saveBacktest(array $b): void { $this->savedBacktests[] = $b; }

        // ── interface completeness: nothing else may be called ─────────────────
        public function ensureProvider(string $code, string $name): array { throw new \LogicException('not scripted'); }
        public function listProviders(bool $enabledOnly = false): array { throw new \LogicException('not scripted'); }
        public function setProviderEnabled(int $id, bool $enabled): void { throw new \LogicException('not scripted'); }
        public function listHealth(int $providerId, int $limit = 20): array { throw new \LogicException('not scripted'); }
        public function latestHealth(int $providerId): ?array { throw new \LogicException('not scripted'); }
        public function findMatchById(int $id): ?array { throw new \LogicException('not scripted'); }
        public function latestOdds(int $matchId, ?string $market = null, ?string $selection = null): ?array { throw new \LogicException('not scripted'); }
        public function listOdds(int $matchId, int $limit = 50): array { throw new \LogicException('not scripted'); }
        public function latestQuality(int $matchId): ?array { throw new \LogicException('not scripted'); }
        public function saveCalibration(array $c): int { throw new \LogicException('not scripted'); }
        public function findCalibration(int $id): ?array { throw new \LogicException('not scripted'); }
        public function listCalibrations(?int $modelVersionId = null, ?string $status = null, int $limit = 50): array { throw new \LogicException('not scripted'); }
        public function updateCalibrationStatus(int $id, string $status, ?string $actor = null): void { throw new \LogicException('not scripted'); }
        public function findModelVersion(int $id): ?array { throw new \LogicException('not scripted'); }
        public function listPredictions(array $filter = [], int $limit = 200): array { throw new \LogicException('not scripted'); }
        public function findPrediction(string $id): ?array { throw new \LogicException('not scripted'); }
        public function listConfigurations(int $limit = 20): array { throw new \LogicException('not scripted'); }
        public function saveConfiguration(array $c): int { throw new \LogicException('not scripted'); }
        public function findConfiguration(int $id): ?array { throw new \LogicException('not scripted'); }
        public function deleteOldJobRuns(string $cutoff): void { throw new \LogicException('not scripted'); }
        public function deleteOldHealth(string $cutoff): void { throw new \LogicException('not scripted'); }
        public function startJobRun(array $run): ?array { throw new \LogicException('not scripted'); }
        public function finishJobRun(string $id, array $result): void { throw new \LogicException('not scripted'); }
        public function listJobRuns(?string $jobType = null, int $limit = 50): array { throw new \LogicException('not scripted'); }
        public function findBacktest(string $id): ?array { throw new \LogicException('not scripted'); }
        public function listBacktests(int $limit = 20): array { throw new \LogicException('not scripted'); }
        public function listModelMetrics(?int $modelVersionId = null, ?int $windowDays = null, ?string $sampleType = null, int $limit = 200): array { throw new \LogicException('not scripted'); }
        public function findDailyTicket(string $date): ?array { throw new \LogicException('not scripted'); }
        public function saveDailyTicket(array $d): void { throw new \LogicException('not scripted'); }
        public function updateDailyTicket(string $date, array $patch): void { throw new \LogicException('not scripted'); }
        public function listDailyTickets(int $limit = 60): array { throw new \LogicException('not scripted'); }
        public function savePerformanceSnapshot(string $asOf, string $window, array $payload): void { throw new \LogicException('not scripted'); }
        public function performanceSnapshots(string $window, int $limit = 30): array { throw new \LogicException('not scripted'); }
        public function saveHealth(int $providerId, array $health): void { throw new \LogicException('not scripted'); }
        public function saveMatch(int $providerId, array $match): array { throw new \LogicException('not scripted'); }
        public function findMatch(int $providerId, string $externalId): ?array { throw new \LogicException('not scripted'); }
        public function saveOdds(int $matchId, int $providerId, array $odds): void { throw new \LogicException('not scripted'); }
        public function saveResult(int $matchId, int $providerId, array $result): void { throw new \LogicException('not scripted'); }
        public function verifyResult(int $id): void { $this->verifiedResults[] = $id; }
        public function saveQuality(int $matchId, array $assessment): void { throw new \LogicException('not scripted'); }
        public function startSync(array $run): ?array { throw new \LogicException('not scripted'); }
        public function finishSync(string $id, array $result): void { throw new \LogicException('not scripted'); }
        public function savePrediction(array $prediction): void { throw new \LogicException('not scripted'); }
        public function saveTicket(array $ticket): void { throw new \LogicException('not scripted'); }
        public function saveTicketSelection(array $selection): void { throw new \LogicException('not scripted'); }
        public function listTickets(array $filter = [], int $limit = 500): array { throw new \LogicException('not scripted'); }
    }

    /** A no-op audit sink that remembers what was emitted (kept out of the comparisons). */
    final class SilentAuditRepository implements AuditRepository
    {
        public array $emitted = [];
        public function emit(string $type, string $summary, array $detail = [], string $actor = 'system'): void { $this->emitted[] = ['type' => $type]; }
        public function recent(int $limit = 100): array { return $this->emitted; }
    }

    // ── verify: ResultVerificationEngine::verify(result) ─────────────────────────
    // `verifiedAt` is stamped from the wall clock with no injectable `now`, so it is
    // unset here and the Node test unsets its own stamp.

    $verifyCases = [
        'an unverified row is refused with RESULT_UNVERIFIED' => ['verified' => false, 'status' => 'FINISHED', 'homeScore' => 2, 'awayScore' => 1],
        'a missing verified flag is refused like a false one' => ['status' => 'FINISHED', 'homeScore' => 2, 'awayScore' => 1],
        'a VOID status verifies to a terminal void' => ['verified' => true, 'status' => 'VOID', 'homeScore' => null, 'awayScore' => null],
        'a CANCELLED status verifies to a terminal cancellation' => ['verified' => true, 'status' => 'CANCELLED', 'homeScore' => null, 'awayScore' => null],
        'a lower-case void status is upper-cased first' => ['verified' => true, 'status' => 'void', 'homeScore' => null, 'awayScore' => null],
        'a live match is refused with MATCH_NOT_FINISHED' => ['verified' => true, 'status' => 'LIVE', 'homeScore' => 1, 'awayScore' => 0],
        'a missing status is refused with MATCH_NOT_FINISHED' => ['verified' => true, 'homeScore' => 1, 'awayScore' => 0],
        'a negative home score is refused with RESULT_INVALID' => ['verified' => true, 'status' => 'FINISHED', 'homeScore' => -1, 'awayScore' => 0],
        'a negative away score is refused with RESULT_INVALID' => ['verified' => true, 'status' => 'FINISHED', 'homeScore' => 2, 'awayScore' => -2],
        'a missing away score is refused with RESULT_INVALID' => ['verified' => true, 'status' => 'FINISHED', 'homeScore' => 2],
        'a string score is refused because is_int fails' => ['verified' => true, 'status' => 'FINISHED', 'homeScore' => '2', 'awayScore' => 1],
        'a float score is refused because is_int fails' => ['verified' => true, 'status' => 'FINISHED', 'homeScore' => 2.0, 'awayScore' => 1],
        'a valid finished score verifies with its scores carried through' => ['verified' => true, 'status' => 'FINISHED', 'homeScore' => 3, 'awayScore' => 0],
        'a valid nil-nil verifies' => ['verified' => true, 'status' => 'FINISHED', 'homeScore' => 0, 'awayScore' => 0],
    ];
    $verify = [];
    foreach ($verifyCases as $name => $input) {
        $result = outcome(fn() => (new ResultVerificationEngine())->verify($input));
        if ($result['ok'] && is_array($result['value'])) unset($result['value']['verifiedAt']);
        $verify[$name] = ['input' => $input, 'result' => $result];
    }

    // ── settleSelection: the one market rule the engine knows ───────────────────

    $finished = fn(int $h, int $a): array => ['verified' => true, 'terminalStatus' => 'FINISHED', 'homeScore' => $h, 'awayScore' => $a];
    $settleSelectionCases = [
        'an unverified verdict keeps the leg pending with the verdict reason' => [
            ['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5'],
            ['verified' => false, 'reason' => 'RESULT_UNVERIFIED'],
        ],
        'an unverified verdict with no reason defaults the reason' => [
            ['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5'],
            ['verified' => false],
        ],
        'a verified void voids the leg' => [['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5'], ['verified' => true, 'terminalStatus' => 'VOID']],
        'a verified cancellation cancels the leg' => [['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5'], ['verified' => true, 'terminalStatus' => 'CANCELLED']],
        'two goals win OVER_1_5' => [['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5'], $finished(1, 1)],
        'one goal exactly loses OVER_1_5' => [['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5'], $finished(1, 0)],
        'five goals win OVER_1_5' => [['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5'], $finished(4, 1)],
        'a market the engine does not know stays pending with a reason' => [['market' => 'MATCH_ODDS', 'selection' => 'HOME'], $finished(2, 0)],
        'a missing market stays pending' => [['selection' => 'OVER_1_5'], $finished(2, 0)],
        'a missing selection stays pending' => [['market' => 'TOTAL_GOALS'], $finished(2, 0)],
        'an empty selection stays pending' => [[], $finished(2, 0)],
    ];
    $settleSelection = [];
    foreach ($settleSelectionCases as $name => [$selection, $verified]) {
        $settleSelection[$name] = [
            'input' => ['selection' => $selection, 'verified' => $verified],
            'result' => outcome(fn() => (new ResultVerificationEngine())->settleSelection($selection, $verified)),
        ];
    }

    // ── settlement: TicketSettlementService over the scripted repository ─────────

    $leg = fn(int $id, int $matchId, string $status, float $odds, string $market = 'TOTAL_GOALS', string $selection = 'OVER_1_5'): array => [
        'id' => $id, 'ticket_id' => 'tkt_0000000000000001', 'match_id' => $matchId,
        'market' => $market, 'selection' => $selection, 'odds' => $odds, 'status' => $status,
    ];
    $ticket = fn(?float $stake, float $totalOdds = 3.8, string $settlementStatus = 'PENDING'): array => [
        'id' => 'tkt_0000000000000001', 'stake' => $stake, 'total_odds' => $totalOdds,
        'settlement_status' => $settlementStatus, 'status' => $settlementStatus,
    ];

    /**
     * Run one settlement scenario: a scripted repository, a list of service calls, and
     * everything the service wrote back. The inputs are stored beside the results so
     * the Node side drives its port over the identical script.
     */
    $runSettlement = function (array $repoRows, array $calls): array {
        $repo = new ScriptedSportsRepository($repoRows);
        $audit = new SilentAuditRepository();
        $service = new TicketSettlementService($repo, new ResultVerificationEngine(), $audit);
        $returns = [];
        foreach ($calls as $call) {
            $method = $call[0];
            $args = array_slice($call, 1);
            $returns[] = outcome(fn() => $service->{$method}(...$args));
        }
        return [
            'input' => ['repo' => $repoRows, 'calls' => $calls],
            'returns' => $returns,
            'ticketPatches' => $repo->ticketPatches,
            'selectionPatches' => $repo->selectionPatches,
            'recordedOutcomes' => $repo->recordedOutcomes,
        ];
    };

    $won2Legs = [$leg(1, 5, 'WON', 1.9), $leg(2, 6, 'WON', 2.0)];
    $baseRepo = fn(array $over = []): array => array_merge([
        'tickets' => ['tkt_0000000000000001' => $ticket(10.0)],
        'selections' => ['tkt_0000000000000001' => $won2Legs],
        'configuration' => null,
        'results' => [],
        'resultByMatch' => [],
        'oddsBefore' => [],
        'matches' => [],
        'outcomes' => [],
        'settledSelections' => [],
        'models' => [],
        'calibration' => null,
        'modelId' => 7,
    ], $over);

    $settlementScenarios = [
        'a won double pays stake times (effective odds minus one)' => $runSettlement($baseRepo(), [
            ['settlePending', 'tkt_0000000000000001'],
        ]),
        'a void leg is refunded under the default RESTITUTE_ODDS policy' => $runSettlement($baseRepo([
            'selections' => ['tkt_0000000000000001' => [$leg(1, 5, 'WON', 1.9), $leg(2, 6, 'VOID', 2.5)]],
        ]), [['settlePending', 'tkt_0000000000000001']]),
        'the same void leg counts its odds under ALL_VOID_ONLY' => $runSettlement($baseRepo([
            'selections' => ['tkt_0000000000000001' => [$leg(1, 5, 'WON', 1.9), $leg(2, 6, 'VOID', 2.5)]],
            'configuration' => ['void_policy' => 'ALL_VOID_ONLY'],
        ]), [['settlePending', 'tkt_0000000000000001']]),
        'a cancelled leg behaves like a void one under the default policy' => $runSettlement($baseRepo([
            'selections' => ['tkt_0000000000000001' => [$leg(1, 5, 'WON', 1.9), $leg(2, 6, 'CANCELLED', 2.5)]],
        ]), [['settlePending', 'tkt_0000000000000001']]),
        'an all-void ticket is VOID with no profit and no loss' => $runSettlement($baseRepo([
            'selections' => ['tkt_0000000000000001' => [$leg(1, 5, 'VOID', 2.5), $leg(2, 6, 'CANCELLED', 1.8)]],
        ]), [['settlePending', 'tkt_0000000000000001']]),
        'a lost leg loses the whole stake regardless of the other legs' => $runSettlement($baseRepo([
            'selections' => ['tkt_0000000000000001' => [$leg(1, 5, 'WON', 1.9), $leg(2, 6, 'LOST', 2.0)]],
        ]), [['settlePending', 'tkt_0000000000000001']]),
        'a pending leg keeps the ticket pending and the stored total odds untouched' => $runSettlement($baseRepo([
            'selections' => ['tkt_0000000000000001' => [$leg(1, 5, 'WON', 1.9), $leg(2, 6, 'PENDING', 2.0)]],
            'tickets' => ['tkt_0000000000000001' => $ticket(10.0, 12.34)],
        ]), [['settlePending', 'tkt_0000000000000001']]),
        'a ticket with no stake records no P/L' => $runSettlement($baseRepo([
            'tickets' => ['tkt_0000000000000001' => $ticket(null)],
        ]), [['settlePending', 'tkt_0000000000000001']]),
        'applyVerifiedResult settles the matching pending leg and finalizes' => $runSettlement($baseRepo([
            'selections' => ['tkt_0000000000000001' => [$leg(1, 5, 'PENDING', 1.9), $leg(2, 6, 'WON', 2.0)]],
        ]), [
            ['applyVerifiedResult', 'tkt_0000000000000001', 5, ['verified' => true, 'status' => 'FINISHED', 'homeScore' => 3, 'awayScore' => 0]],
        ]),
        'a void verdict voids the matching leg' => $runSettlement($baseRepo([
            'selections' => ['tkt_0000000000000001' => [$leg(1, 5, 'PENDING', 1.9), $leg(2, 6, 'WON', 2.0)]],
        ]), [
            ['applyVerifiedResult', 'tkt_0000000000000001', 5, ['verified' => true, 'status' => 'VOID', 'homeScore' => null, 'awayScore' => null]],
        ]),
        'an unverified result is refused and nothing is written' => $runSettlement($baseRepo([
            'selections' => ['tkt_0000000000000001' => [$leg(1, 5, 'PENDING', 1.9)]],
        ]), [
            ['applyVerifiedResult', 'tkt_0000000000000001', 5, ['verified' => false, 'status' => 'FINISHED', 'homeScore' => 3, 'awayScore' => 0]],
        ]),
        'a market the engine cannot settle leaves the leg and the ticket pending' => $runSettlement($baseRepo([
            'selections' => ['tkt_0000000000000001' => [$leg(1, 5, 'PENDING', 1.9, 'MATCH_ODDS', 'HOME')]],
        ]), [
            ['applyVerifiedResult', 'tkt_0000000000000001', 5, ['verified' => true, 'status' => 'FINISHED', 'homeScore' => 3, 'awayScore' => 0]],
        ]),
        'settlePending sweeps every leg a stored verified result exists for' => $runSettlement($baseRepo([
            'selections' => ['tkt_0000000000000001' => [$leg(1, 5, 'PENDING', 1.9), $leg(2, 6, 'PENDING', 2.0), $leg(3, 7, 'PENDING', 1.5)]],
            'resultByMatch' => [
                5 => ['verified' => 1, 'status' => 'FINISHED', 'home_score' => '2', 'away_score' => '1'],
                7 => ['verified' => 0, 'status' => 'FINISHED', 'home_score' => '1', 'away_score' => '0'],
            ],
        ]), [['settlePending', 'tkt_0000000000000001']]),
        'settlePending is idempotent on an already-final ticket' => $runSettlement($baseRepo([
            'tickets' => ['tkt_0000000000000001' => $ticket(10.0, 3.8, 'WON')],
        ]), [['settlePending', 'tkt_0000000000000001']]),
        'applyStoredResult applies the stored attestation, which may be false' => $runSettlement($baseRepo([
            'selections' => ['tkt_0000000000000001' => [$leg(1, 5, 'PENDING', 1.9)]],
            'results' => ['5:2' => ['id' => 41, 'verified' => 0, 'status' => 'FINISHED', 'home_score' => '3', 'away_score' => '0']],
        ]), [
            ['applyStoredResult', 'tkt_0000000000000001', 5, 2],
        ]),
        'applyStoredResult settles from a verified stored row' => $runSettlement($baseRepo([
            'selections' => ['tkt_0000000000000001' => [$leg(1, 5, 'PENDING', 1.9)]],
            'results' => ['5:2' => ['id' => 41, 'verified' => 1, 'status' => 'FINISHED', 'home_score' => '3', 'away_score' => '0']],
        ]), [
            ['applyStoredResult', 'tkt_0000000000000001', 5, 2],
        ]),
        'a missing stored result is refused' => $runSettlement($baseRepo(), [
            ['applyStoredResult', 'tkt_0000000000000001', 99, 2],
        ]),
        'an unknown ticket is refused' => $runSettlement($baseRepo([
            'tickets' => [],
            'selections' => [],
        ]), [['settlePending', 'tkt_9999999999999999']]),
    ];

    // ── performance: PerformanceAnalytics::report / summarize — pure ─────────────

    $pticket = fn(string $status, float $odds, ?float $stake, ?float $pnl, string $createdAt, array $over = []): array => array_merge([
        'settlement_status' => $status, 'total_odds' => $odds, 'stake' => $stake, 'pnl' => $pnl,
        'created_at' => $createdAt, 'confidence' => 78.5, 'combined_probability' => 0.61,
    ], $over);
    $pselection = fn(string $status, float $odds, string $market, string $competition, string $model, string $version, ?float $ev): array => [
        'status' => $status, 'odds' => $odds, 'market' => $market, 'competition' => $competition,
        'model_name' => $model, 'model_version' => $version, 'expected_value' => $ev,
    ];
    $poutcome = fn(float $raw, int $outcome): array => ['raw_probability' => $raw, 'calibrated_probability' => $raw, 'outcome' => $outcome];

    $perfTickets = [
        $pticket('WON', 3.8, 10.0, 28.0, '2026-02-10T18:00:00+00:00'),
        $pticket('LOST', 2.4, 10.0, -10.0, '2026-02-11T18:00:00+00:00'),
        $pticket('WON', 1.9, 5.0, 4.5, '2026-02-11T20:00:00+00:00'),
        $pticket('VOID', 3.8, 10.0, 0.0, '2026-02-12T18:00:00+00:00'),
        $pticket('PENDING', 2.0, 10.0, null, '2026-02-12T19:00:00+00:00'),
    ];
    $perfSelections = [
        $pselection('WON', 1.9, 'TOTAL_GOALS', 'League One', 'WINDELS Sports Baseline', '1.0.0', 0.12),
        $pselection('LOST', 2.1, 'TOTAL_GOALS', 'League One', 'WINDELS Sports Baseline', '1.0.0', 0.05),
        $pselection('WON', 2.4, 'TOTAL_GOALS', 'League Two', 'WINDELS Sports Baseline', '1.0.0', 0.0),
        $pselection('VOID', 1.8, 'MATCH_ODDS', 'League Two', 'WINDELS Sports Baseline', '1.0.0', null),
        $pselection('WON', 2.0, 'TOTAL_GOALS', 'League One', 'WINDELS Sports Baseline', '1.1.0', 0.3),
    ];
    $perfOutcomes = [$poutcome(0.7, 1), $poutcome(0.65, 1), $poutcome(0.8, 0), $poutcome(0.55, 1), $poutcome(0.4, 0), $poutcome(0.3, 0)];

    $performanceCases = [
        'a mixed history measures tickets, selections, calibration and breakdowns' => [
            'tickets' => $perfTickets, 'selections' => $perfSelections, 'outcomes' => $perfOutcomes,
            'context' => ['mode' => 'SANDBOX', 'totalPredictions' => 12],
        ],
        'a production mode drops the demo banner' => [
            'tickets' => $perfTickets, 'selections' => $perfSelections, 'outcomes' => $perfOutcomes,
            'context' => ['mode' => 'PRODUCTION', 'totalPredictions' => 12],
        ],
        'an empty history is an honest null-metric report' => [
            'tickets' => [], 'selections' => [], 'outcomes' => [],
            'context' => ['mode' => 'SANDBOX', 'totalPredictions' => 0],
        ],
        'tickets without stakes measure win rates but no money' => [
            'tickets' => [$pticket('WON', 1.9, null, null, '2026-02-10T18:00:00+00:00'), $pticket('LOST', 2.4, null, null, '2026-02-11T18:00:00+00:00')],
            'selections' => [], 'outcomes' => [],
            'context' => ['mode' => 'PRODUCTION', 'totalPredictions' => 2],
        ],
        'an expected value of exactly zero is dropped from the mean, as array_filter drops it' => [
            'tickets' => [], 'selections' => [$pselection('WON', 1.9, 'TOTAL_GOALS', 'L', 'M', '1', 0.0), $pselection('LOST', 2.0, 'TOTAL_GOALS', 'L', 'M', '1', 0.1)],
            'outcomes' => [], 'context' => ['mode' => 'PRODUCTION', 'totalPredictions' => 2],
        ],
        'drawdown is measured over the cumulative settled P/L in ticket order' => [
            'tickets' => [$pticket('WON', 2.0, 10.0, 10.0, '2026-02-01T12:00:00+00:00'), $pticket('LOST', 2.0, 10.0, -10.0, '2026-02-02T12:00:00+00:00'), $pticket('LOST', 2.0, 10.0, -10.0, '2026-02-03T12:00:00+00:00'), $pticket('WON', 3.0, 10.0, 20.0, '2026-02-04T12:00:00+00:00')],
            'selections' => [], 'outcomes' => [],
            'context' => ['mode' => 'PRODUCTION', 'totalPredictions' => 4],
        ],
    ];
    $analytics = new PerformanceAnalytics();
    $performance = [];
    foreach ($performanceCases as $name => $case) {
        $performance[$name] = [
            'input' => $case,
            'report' => outcome(fn() => $analytics->report($case['tickets'], $case['selections'], $case['outcomes'], $case['context'])),
            'summarize' => outcome(fn() => $analytics->summarize($case['tickets'])),
        ];
    }

    // ── drift: ModelDriftMonitor::monitor(now) over the scripted repository ──────
    //
    // Windows: RECENT = the trailing 14 days, BASELINE = the 28 before that. Rows are
    // dated days away from every boundary, so PHP's string comparison of a
    // `Y-m-d H:i:s` bound against ISO rows and the port's instant comparison place
    // every row on the same side (the divergence SP-34 records is not exercised).

    $now = strtotime('2026-03-01T12:00:00Z');

    /** Rows dated spread across [startDaysAgo, endDaysAgo], all safely inside. */
    $rowsIn = function (int $count, int $startDaysAgo, int $endDaysAgo, float $p, callable $outcomeAt) use ($now): array {
        $rows = [];
        $span = $startDaysAgo - $endDaysAgo;
        for ($i = 0; $i < $count; $i++) {
            $daysAgo = $startDaysAgo - (int) floor($span * $i / max(1, $count - 1));
            $ts = $now - $daysAgo * 86400 - 3600 * ($i % 5);
            $rows[] = [
                'created_at' => gmdate('Y-m-d\TH:i:s', $ts) . '.000Z',
                'raw_probability' => $p, 'calibrated_probability' => $p,
                'outcome' => $outcomeAt($i),
            ];
        }
        return $rows;
    };
    $allOnes = fn(int $mod): callable => fn(int $i): int => ($i % $mod) === 0 ? 0 : 1;
    $balanced = fn(int $i): int => $i % 2; // half the rows outcome 1

    $modelRow = ['id' => 7, 'model_name' => 'WINDELS Sports Baseline', 'model_version' => '1.0.0', 'feature_version' => 'sports-features-v1', 'calibration_version' => null, 'status' => 'ACTIVE', 'created_at' => '2026-01-01T00:00:00.000Z'];

    $driftScenarios = [
        'a healthy model with calibrated probabilities is STABLE' => [
            // p=0.7 with 70% ones in BOTH windows: no accuracy drop, no Brier rise,
            // and an ECE of 0 (the observed frequency matches the probability), so no
            // reason fires at all — the STABLE path, not an untriggered warning.
            'outcomes' => array_merge(
                $rowsIn(20, 40, 16, 0.7, fn($i) => ($i % 10 < 3) ? 0 : 1),
                $rowsIn(20, 13, 1, 0.7, fn($i) => ($i % 10 < 3) ? 0 : 1),
            ),
        ],
        'fewer than twenty recent samples is INSUFFICIENT_RECENT_DATA' => [
            'outcomes' => array_merge(
                $rowsIn(24, 40, 16, 0.7, $balanced),
                $rowsIn(10, 13, 1, 0.7, $balanced),
            ),
        ],
        'no outcomes at all is INSUFFICIENT_RECENT_DATA with an empty window' => ['outcomes' => []],
        'an accuracy drop at or beyond eight points raises the warning' => [
            // Baseline 90% ones at p=0.7; recent 60% ones. Accuracy drops 30 points.
            // F-36 evidence: PHP's Brier is 0.0 in both windows, so PHP sees no Brier
            // rise; the port's real Brier rises well past the threshold and adds the
            // reason legacy could never produce.
            'outcomes' => array_merge(
                $rowsIn(20, 40, 16, 0.7, fn($i) => ($i % 10 === 9) ? 0 : 1),
                $rowsIn(20, 13, 1, 0.7, fn($i) => ($i % 10 < 8) ? 1 : 0),
            ),
        ],
        'a degraded ECE raises the warning without an accuracy drop' => [
            // p=0.8 with 60% ones both windows: accuracy 0.6 in both, ECE 0.2 in both,
            // identical Brier in both. Only the ECE reason fires — in BOTH sides.
            'outcomes' => array_merge(
                $rowsIn(25, 40, 16, 0.8, fn($i) => ($i % 10 < 6) ? 1 : 0),
                $rowsIn(22, 13, 1, 0.8, fn($i) => ($i % 10 < 6) ? 1 : 0),
            ),
        ],
    ];
    $monitor = new ModelDriftMonitor(new ScriptedSportsRepository(['modelId' => 7]), new SilentAuditRepository(), null);
    $drift = ['now' => $now, 'scenarios' => []];
    foreach ($driftScenarios as $name => $scenario) {
        $repo = new ScriptedSportsRepository([
            'models' => [$modelRow],
            'outcomes' => $scenario['outcomes'],
            'modelId' => 7,
        ]);
        $driftMonitor = new ModelDriftMonitor($repo, new SilentAuditRepository(), null);
        $result = outcome(fn() => $driftMonitor->monitor($now));
        $drift['scenarios'][$name] = [
            'input' => ['models' => [$modelRow], 'outcomes' => $scenario['outcomes']],
            'result' => $result,
        ];
    }
    // The monitor's declared constants, so the port's are pinned to legacy's.
    $drift['constants'] = [
        'RECENT_DAYS' => ModelDriftMonitor::RECENT_DAYS,
        'BASELINE_DAYS' => ModelDriftMonitor::BASELINE_DAYS,
        'MIN_RECENT_SAMPLES' => ModelDriftMonitor::MIN_RECENT_SAMPLES,
        'ACCURACY_DROP_THRESHOLD' => ModelDriftMonitor::ACCURACY_DROP_THRESHOLD,
        'BRIER_RISE_THRESHOLD' => ModelDriftMonitor::BRIER_RISE_THRESHOLD,
        'ECE_THRESHOLD' => ModelDriftMonitor::ECE_THRESHOLD,
    ];

    // ── metricsFor: ModelPerformanceService::metricsFor over the scripted repo ───
    //
    // Legacy's metric core for one model window: accuracy over outcomes (left-associative
    // ternary on round(p*1000)), and ticket metrics over settled selections with the
    // stake and P/L of each ticket shared equally across ALL its legs. The port runs the
    // same core inside `modelPerformance().comparison[]`.

    $metricOutcome = function (int $i) use ($now): array {
        $p = [0.7, 0.55, 0.8, 0.35, 0.6][$i % 5];
        return [
            'created_at' => gmdate('Y-m-d\TH:i:s', $now - (2 + $i) * 86400) . '.000Z',
            'raw_probability' => $p, 'calibrated_probability' => $p, 'outcome' => ($i % 3 === 0) ? 0 : 1,
        ];
    };
    $selRow = function (int $i, string $ticketId, int $legs, string $status, float $stake, float $pnl): array {
        return [
            'ticket_id' => $ticketId, 'match_id' => 100 + $i, 'market' => ($i % 2 === 0) ? 'TOTAL_GOALS' : 'MATCH_ODDS',
            'selection' => 'OVER_1_5', 'status' => $status, '_settled' => 1,
            'ticket_stake' => $stake, 'ticket_pnl' => $pnl, 'ticket_odds' => 3.8,
            'ticket_status' => 'WON', 'competition' => ($i % 2 === 0) ? 'League One' : 'League Two',
            'kickoff_at' => gmdate('Y-m-d\TH:i:s', $now - (2 + $i) * 86400) . '.000Z',
            'model_name' => 'WINDELS Sports Baseline', 'model_version' => '1.0.0',
            'legCount' => $legs,
        ];
    };
    $metricsForScenario = [
        'input' => [
            'windowDays' => 30,
            'outcomes' => array_map($metricOutcome, range(0, 11)),
            // Two tickets: one WON with three legs, one LOST with two legs.
            'selections' => [
                $selRow(0, 'tkt_aaaaaaaaaaaaaaaa', 3, 'WON', 30.0, 28.0),
                $selRow(1, 'tkt_aaaaaaaaaaaaaaaa', 3, 'LOST', 30.0, 28.0),
                $selRow(2, 'tkt_bbbbbbbbbbbbbbbb', 2, 'WON', 20.0, -20.0),
                $selRow(3, 'tkt_bbbbbbbbbbbbbbbb', 2, 'LOST', 20.0, -20.0),
                // A leg of the first ticket that never settled: it still counts in the
                // denominator of the stake share, which is the allocation legacy makes.
                array_merge($selRow(9, 'tkt_aaaaaaaaaaaaaaaa', 3, 'PENDING', 30.0, 28.0), ['status' => 'PENDING', '_settled' => 0]),
            ],
            'tickets' => [
                'tkt_aaaaaaaaaaaaaaaa' => ['id' => 'tkt_aaaaaaaaaaaaaaaa', 'pnl' => 28.0],
                'tkt_bbbbbbbbbbbbbbbb' => ['id' => 'tkt_bbbbbbbbbbbbbbbb', 'pnl' => -20.0],
            ],
            'legCounts' => ['tkt_aaaaaaaaaaaaaaaa' => 3, 'tkt_bbbbbbbbbbbbbbbb' => 2],
            'models' => [$modelRow],
        ],
        'now' => $now,
    ];
    // The per-ticket leg lists the service counts with ticketSelections().
    $metricsRepoSelections = [];
    foreach ($metricsForScenario['input']['legCounts'] as $tid => $n) {
        $metricsRepoSelections[$tid] = array_fill(0, $n, ['id' => 0, 'ticket_id' => $tid]);
    }
    $metricsRepo = new ScriptedSportsRepository([
        'models' => $metricsForScenario['input']['models'],
        'outcomes' => $metricsForScenario['input']['outcomes'],
        'settledSelections' => $metricsForScenario['input']['selections'],
        'tickets' => $metricsForScenario['input']['tickets'],
        'selections' => $metricsRepoSelections,
        'modelId' => 7,
    ]);
    $metricsResult = outcome(fn() => (new ModelPerformanceService($metricsRepo, new SilentAuditRepository()))
        ->metricsFor(7, $metricsForScenario['input']['windowDays'], $metricsForScenario['now']));
    // The snapshot legacy wrote as a side effect, with its clock field sentinelized.
    $metricsSnapshot = $metricsRepo->savedMetrics;
    foreach ($metricsSnapshot as &$snapshot) {
        $snapshot['computed_at'] = SENTINEL;
    }
    $metricsForCase = [
        'input' => $metricsForScenario['input'],
        'result' => $metricsResult,
        'snapshot' => $metricsSnapshot,
    ];

    // ── backtest: refusals first, then one full identity replay ──────────────────

    $backtestRepo = new ScriptedSportsRepository([]); // refusals must never touch it
    $backtester = new SportsBacktester(
        $backtestRepo,
        new SilentAuditRepository(),
        new PredictionPipeline(),
        new DataQualityEngine(),
        new ModelPerformanceService($backtestRepo, new SilentAuditRepository()),
    );
    $backtestRefusalCases = [
        'a missing from is refused' => ['to' => '2026-02-12'],
        'a missing to is refused' => ['from' => '2026-02-09'],
        'a malformed date is refused' => ['from' => '09-02-2026', 'to' => '2026-02-12'],
        'a calendar-impossible date is refused' => ['from' => '2026-02-30', 'to' => '2026-02-28'],
        'an inverted range is refused' => ['from' => '2026-02-12', 'to' => '2026-02-09'],
        'a range beyond ninety days is refused' => ['from' => '2025-12-01', 'to' => '2026-03-15'],
    ];
    $backtestRefusals = [];
    foreach ($backtestRefusalCases as $name => $params) {
        $backtestRefusals[$name] = [
            'input' => $params,
            'result' => outcome(fn() => $backtester->run($params, 'parity')),
        ];
    }

    // The full replay: five finished matches — two scoreable with pre-kickoff odds,
    // one whose result is unverified, one whose odds fall outside the window, one with
    // a data-quality-refusing liquidity. No approved calibration, so both sides replay
    // the RAW model through the identity mapping: legacy's linear form and the port's
    // logistic map are the SAME function at intercept 0 / slope 1, so DV-12 does not
    // bite here and the reports can be compared whole.
    $btMatch = fn(int $id, string $home, string $away, string $kickoff, array $context): array => [
        'id' => $id, 'external_id' => "BT-{$id}", 'home_team' => $home, 'away_team' => $away,
        'competition' => 'Parity League', 'status' => 'FINISHED', 'kickoff_at' => $kickoff,
        'source_timestamp' => null, 'payload' => ['context' => $context],
    ];
    $goodContext = ['recentForm' => ['homeGoalsPerMatch' => 1.6, 'awayGoalsPerMatch' => 1.1, 'homeConcededPerMatch' => 1.0, 'awayConcededPerMatch' => 1.4, 'source' => 'feed'], 'marketLiquidity' => 500];
    $btMatches = [
        $btMatch(1, 'Alpha United', 'Bolt City', '2026-02-10T18:00:00+00:00', $goodContext),
        $btMatch(2, 'Comet Rangers', 'Delta Athletic', '2026-02-11T18:00:00+00:00', $goodContext),
        $btMatch(3, 'Echo FC', 'Foxtrot SC', '2026-02-11T19:00:00+00:00', $goodContext),
        $btMatch(4, 'Golf XI', 'Hotel United', '2026-02-11T20:00:00+00:00', $goodContext),
        $btMatch(5, 'India FC', 'Juliet SC', '2026-02-11T20:30:00+00:00', ['recentForm' => null, 'marketLiquidity' => 0.5]),
    ];
    $btResults = [
        1 => ['verified' => 1, 'status' => 'FINISHED', 'home_score' => '2', 'away_score' => '1'],
        2 => ['verified' => 1, 'status' => 'FINISHED', 'home_score' => '0', 'away_score' => '0'],
        3 => ['verified' => 0, 'status' => 'FINISHED', 'home_score' => '4', 'away_score' => '0'],
        4 => ['verified' => 1, 'status' => 'FINISHED', 'home_score' => '2', 'away_score' => '2'],
    ];
    $btOdds = [
        1 => ['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'decimal_odds' => '1.90', 'observed_at' => '2026-02-10T17:00:00+00:00'],
        2 => ['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'decimal_odds' => '2.10', 'observed_at' => '2026-02-11T17:00:00+00:00'],
        3 => ['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'decimal_odds' => '1.95', 'observed_at' => '2026-02-11T18:00:00+00:00'],
        4 => ['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'decimal_odds' => '1.05', 'observed_at' => '2026-02-11T19:00:00+00:00'],
        5 => ['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'decimal_odds' => '1.90', 'observed_at' => '2026-02-11T19:30:00+00:00'],
    ];
    $btParams = ['from' => '2026-02-09', 'to' => '2026-02-12', 'modelVersionId' => 999, 'minConfidence' => 60.0, 'oddsMin' => 1.2, 'oddsMax' => 10.0, 'minDataQuality' => 60, 'stake' => 10.0];

    $btRepo = new ScriptedSportsRepository([
        'matches' => $btMatches,
        'resultByMatch' => $btResults,
        'oddsBefore' => $btOdds,
        'calibration' => null,
        'modelId' => 7,
    ]);
    $btBacktester = new SportsBacktester($btRepo, new SilentAuditRepository(), new PredictionPipeline(), new DataQualityEngine(), new ModelPerformanceService($btRepo, new SilentAuditRepository()));
    $btRun = outcome(fn() => $btBacktester->run($btParams, 'parity'));
    // The id is random and generatedAt is the wall clock; both are removed and the
    // Node side applies the identical removal.
    if ($btRun['ok'] && is_array($btRun['value'])) {
        unset($btRun['value']['id'], $btRun['value']['generatedAt']);
    }
    $backtestRun = [
        'input' => ['params' => $btParams, 'matches' => $btMatches, 'results' => $btResults, 'oddsBefore' => $btOdds, 'modelId' => 7],
        'result' => $btRun,
        'saved' => (function () use ($btRepo) {
            $out = [];
            foreach ($btRepo->savedBacktests as $saved) {
                // PHP stores the report as a JSON STRING (json_encode at the save), so
                // the clock fields survive inside it. Decode, strip the random id and
                // the wall clock, re-encode — the Node test compares the decoded form,
                // and the committed golden must not change every regeneration.
                $report = json_decode($saved['report'], true);
                unset($report['id'], $report['generatedAt']);
                $saved['report'] = json_encode($report, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
                unset($saved['id'], $saved['created_at']);
                $out[] = $saved;
            }
            return $out;
        })(),
    ];

    return [
        'verify' => $verify,
        'settleSelection' => $settleSelection,
        'settlement' => $settlementScenarios,
        'performance' => $performance,
        'drift' => $drift,
        'metricsFor' => $metricsForCase,
        'backtestRefusals' => $backtestRefusals,
        'backtestRun' => $backtestRun,
    ];
})();
