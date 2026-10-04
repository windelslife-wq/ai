<?php
namespace Aegis\Sports;

use Aegis\Backtest\Backtester;
use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\SportsRepository;

/**
 * Historical backtesting engine (spec §24).
 *
 * Strict point-in-time replay: for every finished match in the range only
 * data that EXISTED BEFORE kickoff is visible (odds with observed_at <
 * kickoff, the stored form context, the verified final result). The same
 * deterministic pipeline used live (features → prediction → calibration →
 * value → risk → gate) is re-run, so backtests measure the model, not luck.
 *
 * Honesty contract: reports are flagged simulation=true and stored with an
 * explicit warning. Backtest numbers are NEVER merged into live performance
 * statistics and are never presented as live results.
 */
class SportsBacktester
{
    public const MAX_RANGE_DAYS = 90;

    public function __construct(
        private SportsRepository $repo,
        private AuditRepository $audit,
        private PredictionPipeline $pipeline,
        private DataQualityEngine $quality,
        private ModelPerformanceService $models
    ) {}

    /**
     * @param array $params from, to (YYYY-MM-DD), league?, market?, modelVersionId?, minConfidence?, oddsMin?, oddsMax?, minDataQuality?, stake?
     */
    public function run(array $params, string $actor = 'system'): array
    {
        $from = (string) ($params['from'] ?? '');
        $to = (string) ($params['to'] ?? '');
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $from) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $to)) throw new \InvalidArgumentException('from/to must be YYYY-MM-DD');
        $fromTs = (new \DateTimeImmutable($from))->getTimestamp();
        $toTs = (new \DateTimeImmutable($to . 'T23:59:59Z'))->getTimestamp();
        if ($fromTs > $toTs) throw new \InvalidArgumentException('from must be before to');
        if (($toTs - $fromTs) > self::MAX_RANGE_DAYS * 86400) throw new \InvalidArgumentException('range must not exceed ' . self::MAX_RANGE_DAYS . ' days');

        $league = $params['league'] ?? null;
        $minConfidence = is_numeric($params['minConfidence'] ?? null) ? (float) $params['minConfidence'] : 75.0;
        $oddsMin = is_numeric($params['oddsMin'] ?? null) ? (float) $params['oddsMin'] : 0.0;
        $oddsMax = is_numeric($params['oddsMax'] ?? null) ? (float) $params['oddsMax'] : 100.0;
        $minQuality = is_numeric($params['minDataQuality'] ?? null) ? (int) $params['minDataQuality'] : 60;
        $stake = max(0.0, is_numeric($params['stake'] ?? null) ? (float) $params['stake'] : 10.0);
        $modelVersionId = is_numeric($params['modelVersionId'] ?? null) ? (int) $params['modelVersionId'] : null;

        // Kickoff timestamps carry a time-of-day component, so a bare date
        // upper bound would exclude the whole `to` day; extend to end-of-day.
        $matches = $this->repo->listMatches(['from' => $from, 'to' => $to . 'T23:59:59+00:00'], 1000);
        if ($league !== null) $matches = array_values(array_filter($matches, fn($m) => str_contains((string) ($m['competition'] ?? ''), (string) $league)));
        $matches = array_values(array_filter($matches, fn($m) => ($m['status'] ?? '') === 'FINISHED'));

        // Approved calibration (labeled as of backtest time — the replay assumes the same model stack).
        // When none is approved the replay measures the RAW model via an identity
        // mapping — this is explicit in the report and is exactly what calibration
        // is meant to improve, not a hidden assumption of accuracy.
        $model = ['modelName' => PredictionEngine::MODEL_NAME, 'modelVersion' => PredictionEngine::MODEL_VERSION, 'featureVersion' => FeatureEngineeringEngine::VERSION];
        $modelId = $this->repo->ensureModelVersion($model);
        $calibration = $this->repo->activeCalibration($modelId);
        if ($calibration !== null) {
            $calibration['calibrationVersion'] = sprintf('cal-platt-i%s-s%s-n%d', $calibration['intercept'], $calibration['slope'], (int) ($calibration['samples'] ?? 0));
            $calibrationInput = $calibration;
            $calibrationLabel = 'APPROVED_' . $calibration['calibrationVersion'];
        } else {
            $calibrationInput = ['approved' => true, 'intercept' => 0.0, 'slope' => 1.0, 'version' => 'identity-replay', 'ece' => null, 'samples' => 0, 'approvedAt' => null, 'calibrationVersion' => 'identity-replay'];
            $calibrationLabel = 'NONE — identity replay of raw model probabilities';
        }
        if ($modelVersionId !== null && $modelVersionId !== $modelId) {
            // The stored pipeline is the versioned baseline; comparing a different
            // model version is reported honestly rather than pretending to re-run it.
            $note = 'replayed model (baseline ' . PredictionEngine::MODEL_VERSION . ') differs from requested modelVersionId=' . $modelVersionId;
        } else {
            $note = null;
        }

        $rows = [];
        $evaluated = 0; $skipped = 0;
        $pnl = 0.0; $staked = 0.0;
        $evPredicted = []; $evRealized = [];
        $cum = 0.0; $peak = 0.0; $maxDd = 0.0;
        $groups = ['byMarket' => [], 'byLeague' => []];
        $overTime = [];
        $accuracyCorrect = 0; $accuracyTotal = 0;
        $calRows = [];

        foreach ($matches as $match) {
            $result = $this->repo->findResultByMatch((int) $match['id']);
            if ($result === null || !(bool) $result['verified'] || ($result['status'] ?? '') !== 'FINISHED') { $skipped++; continue; }
            $kickoffTs = $this->ts($match['kickoff_at']);
            if ($kickoffTs === null) { $skipped++; continue; }

            // Point-in-time inputs ONLY.
            $oddsRow = $this->repo->oddsBefore((int) $match['id'], gmdate('Y-m-d H:i:s', $kickoffTs));
            if ($oddsRow === null) { $skipped++; continue; }
            $odds = ['market' => $oddsRow['market'], 'selection' => $oddsRow['selection'], 'decimalOdds' => (float) $oddsRow['decimal_odds'], 'observedAt' => $oddsRow['observed_at']];
            if ($odds['decimalOdds'] < $oddsMin || $odds['decimalOdds'] > $oddsMax) { $skipped++; continue; }

            // Quality recomputed at the historical point in time.
            $payload = is_array($match['payload'] ?? null) ? $match['payload'] : [];
            $matchArr = array_merge($match, ['externalId' => $match['external_id'], 'homeTeam' => $match['home_team'], 'awayTeam' => $match['away_team'], 'kickoff' => $match['kickoff_at'], 'context' => $payload['context'] ?? null, 'sourceTimestamp' => $match['source_timestamp']]);
            $quality = $this->quality->assess($matchArr, [
                'oddsAvailable' => true, 'recentFormAvailable' => !empty($matchArr['context']['recentForm']),
                'providerReliability' => 0.9, 'dataAgeSeconds' => 0, 'maxAgeSeconds' => 3600,
            ]);
            if ($quality['score'] < $minQuality) { $skipped++; continue; }

            // Point-in-time replay shape: as of the decision moment the match
            // was still SCHEDULED and the newest odds were the ones just
            // observed — the freshness gate is evaluated against that moment,
            // never against wall-clock time or the final score.
            $pointInTime = $match;
            $pointInTime['status'] = 'SCHEDULED';
            try { $decisionNow = (new \DateTimeImmutable((string) $oddsRow['observed_at']))->getTimestamp(); }
            catch (\Throwable $e) { $decisionNow = $kickoffTs; }
            $candidate = $this->pipeline->evaluate($pointInTime, $odds, $quality, $calibrationInput, ['min_confidence' => $minConfidence, 'min_data_quality' => $minQuality, 'require_calibration' => 0, 'allowed_markets' => [], 'allowed_leagues' => []], $decisionNow);
            $evaluated++;

            $totalGoals = (int) $result['home_score'] + (int) $result['away_score'];
            $outcome = ($candidate['market'] === 'TOTAL_GOALS' && $candidate['selection'] === 'OVER_1_5') ? ($totalGoals > 1 ? 1 : 0) : null;
            if ($outcome === null) continue;

            $calRows[] = ['raw_probability' => $candidate['prediction']['rawModelProbability'] ?? null, 'calibrated_probability' => $candidate['prediction']['calibratedProbability'] ?? null, 'outcome' => $outcome];
            $accuracyTotal++;
            $pCal = (float) ($candidate['prediction']['calibratedProbability'] ?? $candidate['prediction']['rawModelProbability'] ?? 0.5);
            if (($pCal >= 0.5 ? 1 : 0) === $outcome) $accuracyCorrect++;

            if ($candidate['decision'] === 'REJECTED') continue;
            $won = $outcome === 1;
            $selPnl = $won ? $stake * ((float) $odds['decimalOdds'] - 1) : -$stake;
            $pnl += $selPnl; $staked += $stake;
            $evPredicted[] = (float) ($candidate['value']['expectedValue'] ?? 0);
            $evRealized[] = $won ? ((float) $odds['decimalOdds'] - 1) : -1.0;
            $cum += $selPnl; $peak = max($peak, $cum); $maxDd = max($maxDd, $peak - $cum);
            $groupLabels = ['byMarket' => $candidate['market'], 'byLeague' => $match['competition'] ?? 'UNKNOWN'];
            foreach ($groupLabels as $key => $label) {
                $group = &$groups[$key];
                if (!isset($group[$label])) $group[$label] = ['n' => 0, 'won' => 0, 'pnl' => 0.0];
                $group[$label]['n']++;
                if ($won) $group[$label]['won']++;
                $group[$label]['pnl'] += $selPnl;
            }
            unset($group);
            $day = substr(gmdate('Y-m-d', $kickoffTs), 0, 10);
            if (!isset($overTime[$day])) $overTime[$day] = ['n' => 0, 'pnl' => 0.0];
            $overTime[$day]['n']++;
            $overTime[$day]['pnl'] += $selPnl;

            $rows[] = [
                'matchId' => (int) $match['id'], 'match' => $match['home_team'] . ' vs ' . $match['away_team'],
                'league' => $match['competition'] ?? null, 'kickoff' => $match['kickoff_at'], 'score' => ($result['home_score'] ?? 0) . '-' . ($result['away_score'] ?? 0),
                'market' => $candidate['market'], 'selection' => $candidate['selection'], 'odds' => $odds['decimalOdds'],
                'oddsObservedAt' => $odds['observedAt'], 'calibratedProbability' => $candidate['prediction']['calibratedProbability'] ?? null,
                'confidence' => $candidate['confidence']['confidence'], 'risk' => $candidate['risk']['classification'],
                'decision' => $candidate['decision'], 'rejectionReasons' => $candidate['rejectionReasons'],
                'outcome' => $won ? 'WON' : 'LOST', 'pnl' => round($selPnl, 4),
                'model' => $candidate['prediction']['modelName'] . ' ' . $candidate['prediction']['modelVersion'],
                'calibration' => $calibrationLabel,
            ];
            if (count($rows) >= 500) break;
        }

        $decisive = count(array_filter($rows, fn($r) => in_array($r['decision'], ['QUALIFIED'], true) && in_array($r['outcome'], ['WON', 'LOST'], true)));
        $wonCount = count(array_filter($rows, fn($r) => $r['outcome'] === 'WON'));
        $calMetrics = $calRows ? CalibrationEngine::evaluate($calRows, fn($o) => (float) ($o['calibrated_probability'] ?? $o['raw_probability'] ?? 0.5)) : null;
        $report = [
            'simulation' => true,
            'warning' => 'BACKTEST SIMULATION — historical replay of stored data; NOT live results. Never mix with live performance.',
            'params' => array_filter(['from' => $from, 'to' => $to, 'league' => $league, 'modelVersionId' => $modelVersionId, 'minConfidence' => $minConfidence, 'oddsMin' => $oddsMin, 'oddsMax' => $oddsMax, 'minDataQuality' => $minQuality, 'stake' => $stake], fn($v) => $v !== null),
            'matchesFinished' => count($matches),
            'evaluated' => $evaluated,
            'skipped' => $skipped,
            'skippedReasons' => ['unverified result', 'no pre-kickoff odds', 'odds outside range', 'data quality below threshold'],
            'qualifiedSelections' => $decisive,
            'won' => $wonCount,
            'lost' => max(0, $decisive - $wonCount),
            'winRate' => $decisive > 0 ? round($wonCount / $decisive, 5) : null,
            'accuracy' => $accuracyTotal > 0 ? round($accuracyCorrect / $accuracyTotal, 5) : null,
            'roi' => $staked > 0 ? round($pnl / $staked, 5) : null,
            'yield' => $staked > 0 ? round($pnl / $staked, 5) : null,
            'profitLoss' => round($pnl, 4),
            'maxDrawdown' => round($maxDd, 4),
            'evAccuracy' => count($evPredicted) > 0 ? ['meanPredictedEV' => round(array_sum($evPredicted) / count($evPredicted), 5), 'meanRealized' => round(array_sum($evRealized) / count($evRealized), 5)] : null,
            'calibration' => $calMetrics ? ['brier' => $calMetrics['brier'], 'ece' => $calMetrics['ece'], 'bins' => $calMetrics['bins']] : null,
            'calibrationUsed' => $calibrationLabel,
            'model' => PredictionEngine::MODEL_NAME . ' ' . PredictionEngine::MODEL_VERSION,
            'modelNote' => $note,
            'byMarket' => $groups['byMarket'], 'byLeague' => $groups['byLeague'], 'overTime' => $overTime,
            'selections' => $rows,
            'generatedAt' => gmdate('c'),
        ];

        $id = 'bt_' . bin2hex(random_bytes(8));
        $this->repo->saveBacktest(['id' => $id, 'created_at' => gmdate('c'), 'created_by' => $actor, 'params' => json_encode($report['params']), 'report' => json_encode($report), 'status' => 'COMPLETED']);
        $this->audit->emit('SPORTS_BACKTEST_RUN', 'Sports backtest ' . $id . ' (' . $from . ' → ' . $to . '): ' . $report['qualifiedSelections'] . ' qualified selection(s), ROI ' . var_export($report['roi'], true), [
            'backtestId' => $id, 'simulation' => true, 'winRate' => $report['winRate'], 'roi' => $report['roi'], 'accuracy' => $report['accuracy'],
        ], $actor);
        $report['id'] = $id;
        return $report;
    }

    private function ts(?string $value): ?int
    {
        if (!$value) return null;
        try { return (new \DateTimeImmutable((string) $value))->getTimestamp(); }
        catch (\Throwable $e) { return null; }
    }
}
