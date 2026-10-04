<?php
namespace Aegis\Sports;

use Aegis\Backtest\Backtester;
use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\SportsRepository;
use Aegis\Sports\Providers\SportsProviderManager;

/**
 * AI Ticket Engine (spec §16/§17/§19) — the daily end-to-end pipeline:
 *
 *   fixtures sync → odds sync → data quality → match intelligence → features
 *   → prediction → calibration → value → confidence → risk → correlation
 *   → ticket optimization → governance (user approval by default)
 *
 * Idempotent per (date, configuration version): running the same job twice
 * never creates duplicate tickets. When nothing qualifies the engine stores
 * NO_QUALIFIED_TICKET with the exact rejection summary — an expected,
 * first-class outcome (spec §3).
 */
class DailyTicketService
{
    public function __construct(
        private SportsRepository $repo,
        private AuditRepository $audit,
        private SportsProviderManager $providers,
        private ConfigurationService $config,
        private DataQualityEngine $quality,
        private PredictionPipeline $pipeline,
        private TicketOptimizer $optimizer,
        private TicketGovernance $governance,
        private DecisionRecorder $decisions
    ) {}

    public function runDaily(?string $date = null, ?string $executionKey = null): array
    {
        $date = $date ?? gmdate('Y-m-d');
        $config = $this->config->active();
        $key = $executionKey ?? 'daily-ticket:' . $date . ':v' . $config['version'];
        $run = $this->repo->startJobRun(['id' => Backtester::uuid(), 'jobType' => 'DAILY_TICKET', 'executionKey' => $key]);
        if ($run === null) return ['status' => 'DUPLICATE_SKIPPED', 'executionKey' => $key];

        $errors = [];
        $status = 'NO_QUALIFIED_TICKET';
        $message = '';
        $ticketId = null;
        $evaluated = 0;
        $recorded = 0;
        $rejections = 0;
        $rejectionSummary = [];
        $provider = null;
        $modelVersionId = null;

        try {
            if (!(bool) $config['module_enabled']) {
                $message = 'Sports Intelligence module is disabled';
            } elseif (!(bool) $config['ticket_engine_enabled']) {
                $message = 'AI Ticket Engine is disabled';
            } elseif (!in_array($config['engine_mode'], ['AI_TICKET_GENERATION', 'USER_APPROVAL_REQUIRED', 'AUTOMATED_EXECUTION'], true)) {
                $message = 'engine mode ' . $config['engine_mode'] . ' does not generate tickets';
            } elseif (!$this->providers->configured()) {
                $message = 'no sports provider configured (DISABLED_NO_PROVIDER) — nothing is fabricated';
            } else {
                $attempt = $this->providers->withFallback('fixtures', fn($p) => $p->fixtures(['from' => $date, 'to' => $date]));
                if (!$attempt['ok']) {
                    $message = 'provider failure: ' . json_encode($attempt['failures']);
                    $errors[] = $message;
                } else {
                    $provider = $attempt['provider'];
                    $providerId = (int) $this->repo->ensureProvider($provider, $provider)['id'];
                    $candidates = [];
                    foreach ($attempt['result'] as $rawFixture) {
                        try {
                            $match = SportsDataNormalizer::fixture($rawFixture, $provider);
                            $saved = $this->repo->saveMatch($providerId, $match);
                        } catch (\Throwable $e) {
                            $errors[] = 'fixture rejected: ' . mb_substr($e->getMessage(), 0, 200);
                            continue;
                        }
                        $evaluated++;
                        $matchRow = $this->repo->findMatchById((int) $saved['id']);
                        if ($matchRow === null) continue;

                        $oddsRow = $this->repo->latestOdds((int) $saved['id'], 'TOTAL_GOALS', 'OVER_1_5');
                        if ($oddsRow === null) {
                            $oddsAttempt = $this->providers->withFallback('odds', fn($p) => $p->odds($match['externalId']), $provider);
                            if ($oddsAttempt['ok'] && is_array($oddsAttempt['result'] ?? null)) {
                                foreach ($oddsAttempt['result'] as $rawOdds) {
                                    try {
                                        $this->repo->saveOdds((int) $saved['id'], $providerId, SportsDataNormalizer::odds($rawOdds, $provider));
                                    } catch (\Throwable $e) {
                                        $errors[] = 'odds rejected: ' . mb_substr($e->getMessage(), 0, 200);
                                    }
                                }
                                $oddsRow = $this->repo->latestOdds((int) $saved['id'], 'TOTAL_GOALS', 'OVER_1_5');
                            }
                        }
                        $odds = $oddsRow ? ['market' => $oddsRow['market'], 'selection' => $oddsRow['selection'], 'decimalOdds' => (float) $oddsRow['decimal_odds'], 'observedAt' => $oddsRow['observed_at']] : null;

                        $health = $this->providers->provider($provider)?->health() ?? [];
                        $quality = $this->quality->assess($match, $this->qualityContext($match, $odds, (float) ($health['reliability'] ?? 0)));
                        $this->repo->saveQuality((int) $saved['id'], $quality);

                        $calibration = $this->calibrationFor($matchRow);
                        $candidate = $this->pipeline->evaluate($matchRow, $odds, $quality, $calibration, $config);

                        $factors = array_merge(['market' => $candidate['market'], 'selection' => $candidate['selection']], $candidate['factors']);
                        $predictionId = $this->decisions->recordPrediction(
                            (int) $saved['id'],
                            $candidate['prediction'] + ['market' => $candidate['market'], 'selection' => $candidate['selection']],
                            $candidate['value'],
                            $candidate['risk'],
                            $quality,
                            $factors,
                            is_numeric($candidate['confidence']['confidence'] ?? null) ? (float) $candidate['confidence']['confidence'] : null,
                            $candidate['odds'],
                            $candidate['oddsTimestamp'],
                            'LOW'
                        );
                        $candidate['predictionId'] = $predictionId;
                        $recorded++;
                        if ($modelVersionId === null) $modelVersionId = $this->modelVersionIdFor($candidate['prediction']);

                        if ($candidate['decision'] === 'REJECTED') {
                            $rejections++;
                            foreach ($candidate['rejectionReasons'] as $r) $rejectionSummary[$r] = ($rejectionSummary[$r] ?? 0) + 1;
                        } else {
                            $candidates[] = $candidate;
                        }
                    }

                    if (count($candidates) > 0) {
                        $optimized = $this->optimizer->optimize($candidates, [
                            'targetOddsMin' => (float) $config['target_odds_min'],
                            'targetOddsMax' => (float) $config['target_odds_max'],
                            'maxSelections' => (int) $config['max_selections'],
                            'minConfidence' => (float) $config['min_confidence'],
                            'minDataQuality' => (int) $config['min_data_quality'],
                            'maxCorrelation' => $config['max_correlation'],
                            'allowedMarkets' => $config['allowed_markets'],
                            'allowedLeagues' => $config['allowed_leagues'],
                        ]);
                        if ($optimized['status'] === 'QUALIFIED') {
                            $rec = $this->governance->record($optimized, (string) $config['version'], $modelVersionId, $config);
                            if (($rec['status'] ?? '') !== 'NO_QUALIFIED_TICKET') {
                                $status = $rec['status'] === 'APPROVED_NOT_EXECUTED' ? 'APPROVED' : 'PENDING_USER_APPROVAL';
                                $ticketId = $rec['ticketId'];
                                $message = $status === 'APPROVED' ? 'ticket generated and auto-approved (AUTOMATED_EXECUTION); no external execution' : 'ticket generated; awaiting user approval';
                            }
                        } else {
                            $message = $optimized['reason'] ?? 'no compliant combination';
                        }
                    } else {
                        $message = $evaluated === 0 ? 'no fixtures received for ' . $date : 'no candidate passed the risk/value/calibration gates';
                    }
                }
            }
        } catch (\Throwable $e) {
            $message = 'unexpected failure: ' . $e->getMessage();
            $errors[] = $message;
        }

        $this->repo->saveDailyTicket([
            'date' => $date, 'ticket_id' => $ticketId, 'status' => $status,
            'configuration_version' => (int) $config['version'],
            'candidates_evaluated' => $evaluated, 'predictions_recorded' => $recorded,
            'rejections' => $rejections, 'rejection_summary' => json_encode($rejectionSummary),
            'message' => mb_substr($message, 0, 500), 'provider' => $provider, 'run_id' => $run['id'],
            'created_at' => gmdate('c'), 'updated_at' => gmdate('c'),
        ]);
        $this->repo->finishJobRun($run['id'], ['status' => 'COMPLETED', 'processed' => $evaluated, 'created' => $recorded, 'updated' => 0, 'errors' => $errors]);
        $this->audit->emit('SPORTS_DAILY_TICKET_RUN', 'Daily ticket run ' . $date . ' → ' . $status, [
            'date' => $date, 'status' => $status, 'ticketId' => $ticketId, 'evaluated' => $evaluated,
            'rejections' => $rejections, 'rejectionSummary' => $rejectionSummary, 'message' => $message, 'provider' => $provider, 'errors' => $errors,
        ]);
        return ['status' => $status, 'ticketId' => $ticketId, 'date' => $date, 'message' => $message, 'evaluated' => $evaluated, 'predictionsRecorded' => $recorded, 'rejections' => $rejections, 'rejectionSummary' => $rejectionSummary, 'provider' => $provider, 'runId' => $run['id'], 'errors' => $errors];
    }

    private function qualityContext(array $match, ?array $odds, float $reliability): array
    {
        $maxAge = 3600;
        $age = null;
        if ($odds !== null && !empty($odds['observedAt'])) {
            try { $age = max(0, time() - (int) (new \DateTimeImmutable((string) $odds['observedAt']))->getTimestamp()); }
            catch (\Throwable $e) { $age = PHP_INT_MAX; }
        } elseif (!empty($match['sourceTimestamp'])) {
            try { $age = max(0, time() - (int) (new \DateTimeImmutable((string) $match['sourceTimestamp']))->getTimestamp()); }
            catch (\Throwable $e) { $age = PHP_INT_MAX; }
        }
        return [
            'oddsAvailable' => $odds !== null,
            'recentFormAvailable' => !empty($match['context']['recentForm']),
            'providerReliability' => $reliability,
            'dataAgeSeconds' => $age ?? PHP_INT_MAX,
            'maxAgeSeconds' => $maxAge,
        ];
    }

    /** Approved calibration for the candidate's model version, or null (never invented). */
    private function calibrationFor(array $matchRow): ?array
    {
        $model = ['modelName' => PredictionEngine::MODEL_NAME, 'modelVersion' => PredictionEngine::MODEL_VERSION, 'featureVersion' => FeatureEngineeringEngine::VERSION];
        $modelId = $this->repo->ensureModelVersion($model);
        $cal = $this->repo->activeCalibration($modelId);
        if ($cal === null) return null;
        $cal['calibrationVersion'] = $this->calibrationVersionLabel($cal);
        return $cal;
    }

    private function calibrationVersionLabel(array $cal): string
    {
        return sprintf('cal-platt-i%s-s%s-n%d', $cal['intercept'] ?? '?', $cal['slope'] ?? '?', (int) ($cal['samples'] ?? 0));
    }

    private function modelVersionIdFor(array $prediction): ?int
    {
        $model = ['modelName' => $prediction['modelName'] ?? PredictionEngine::MODEL_NAME, 'modelVersion' => $prediction['modelVersion'] ?? PredictionEngine::MODEL_VERSION, 'featureVersion' => $prediction['featureVersion'] ?? FeatureEngineeringEngine::VERSION, 'calibrationVersion' => $prediction['calibrationVersion'] ?? null];
        return $this->repo->ensureModelVersion($model);
    }
}
