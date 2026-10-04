<?php
defined('BASEPATH') or exit('No direct script access allowed');

/**
 * Sports Intelligence JSON API (spec §25/§26/§34).
 *
 * Authorization follows the existing WINDELS RBAC:
 *   - status                      public (no secrets, no PII)
 *   - read endpoints              sports.view
 *   - configuration / jobs /
 *     calibrations / backtests /  sports.manage  (+ native session + CSRF)
 *     provider toggles
 *   - ticket decide               sports.approve
 *   - results verify / settle     sports.settle
 */
class Api_sports extends Api_controller
{
    // ---------------------------------------------------------------- public
    public function status()
    {
        $this->json($this->platform->sports->status());
    }

    // ------------------------------------------------------------- read-only
    public function dashboard()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $this->json($this->platform->sports->dashboard());
    }

    public function performance()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $allowed = ['from', 'to', 'status', 'modelVersionId'];
        $filter = array_intersect_key($this->input->get(NULL, true) ?: [], array_flip($allowed));
        $this->json($this->platform->sports->performanceReport($filter));
    }

    public function matches()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $g = $this->input->get(NULL, true) ?: [];
        $filter = array_intersect_key($g, array_flip(['status', 'from', 'to', 'competition', 'providerId']));
        $rows = $this->Aegis_model->sports->listMatches($filter, (int) ($g['limit'] ?: 200));
        foreach ($rows as &$row) {
            $row['latestOdds'] = $this->Aegis_model->sports->latestOdds((int) $row['id'], 'TOTAL_GOALS', 'OVER_1_5');
            $row['latestQuality'] = $this->Aegis_model->sports->latestQuality((int) $row['id']);
        }
        $this->json(['matches' => $rows]);
    }

    /** Match intelligence snapshot (spec §8/§28). */
    public function show_match(string $id)
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $match = $this->Aegis_model->sports->findMatchById((int) $id);
        if (!$match) return $this->jsonError('match not found', 404);
        $odds = $this->Aegis_model->sports->latestOdds((int) $id, 'TOTAL_GOALS', 'OVER_1_5');
        $oddsArr = $odds ? ['market' => $odds['market'], 'selection' => $odds['selection'], 'decimalOdds' => (float) $odds['decimal_odds'], 'observedAt' => $odds['observed_at']] : null;
        $intel = $this->platform->sports->matchIntelligence->analyze($match, $oddsArr);
        $preds = $this->Aegis_model->sports->listPredictions(['matchId' => (int) $id], 50);
        $this->json(['match' => $match, 'intelligence' => $intel, 'odds' => $odds, 'predictions' => $preds, 'quality' => $this->Aegis_model->sports->latestQuality((int) $id)]);
    }

    public function odds()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $g = $this->input->get(NULL, true) ?: [];
        if (empty($g['matchId'])) return $this->jsonError('matchId is required');
        $rows = $this->Aegis_model->sports->listOdds((int) $g['matchId'], (int) ($g['limit'] ?: 50));
        $this->json(['odds' => $rows]);
    }

    public function predictions()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $g = $this->input->get(NULL, true) ?: [];
        $filter = array_intersect_key($g, array_flip(['matchId', 'modelVersionId', 'decision', 'market', 'from', 'to']));
        $this->json(['predictions' => $this->Aegis_model->sports->listPredictions($filter, (int) ($g['limit'] ?: 200))]);
    }

    /** AI decision report: why the AI selected/rejected this (spec §28/§29). */
    public function decision_report(string $id)
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $p = $this->Aegis_model->sports->findPrediction($id);
        if (!$p) return $this->jsonError('prediction not found', 404);
        $match = $this->Aegis_model->sports->findMatchById((int) $p['match_id']);
        $model = $this->Aegis_model->sports->findModelVersion((int) $p['model_version_id']);
        $quality = $this->Aegis_model->sports->latestQuality((int) $p['match_id']);
        $factors = is_array($p['factors']) ? $p['factors'] : [];
        $selection = null;
        foreach ($this->Aegis_model->sports->settledSelections() as $s) {
            if (($s['prediction_id'] ?? '') === $id) { $selection = $s; break; }
        }
        $this->json([
            'predictionId' => $p['id'],
            'match' => $match ? ['homeTeam' => $match['home_team'], 'awayTeam' => $match['away_team'], 'competition' => $match['competition'], 'kickoff' => $match['kickoff_at'], 'status' => $match['status']] : null,
            'market' => $p['market'], 'selection' => $p['selection'],
            'oddsAtPrediction' => $p['odds'] ?? null, 'oddsTimestamp' => $p['odds_timestamp'] ?? null,
            'model' => $model,
            'rawModelProbability' => $p['raw_probability'] ?? null,
            'calibratedProbability' => $p['calibrated_probability'] ?? null,
            'impliedProbability' => $p['implied_probability'] ?? null,
            'expectedValue' => $p['expected_value'] ?? null,
            'confidence' => $p['confidence'] ?? null,
            'risk' => $p['risk'], 'correlation' => $p['correlation'],
            'dataQuality' => $quality ? ['score' => $quality['score'], 'band' => $quality['band'], 'missing' => $quality['missing_fields']] : null,
            'decision' => $p['decision'],
            'rejectionReasons' => $p['rejection_reasons'] ?? [],
            'factors' => $factors,
            'whySelected' => ($p['decision'] ?? '') === 'PREDICTION_READY'
                ? 'Positive expected value between calibrated model probability and market-implied probability, with risk, confidence, data-quality and correlation gates all passed.'
                : 'See rejectionReasons — the engine declined rather than forcing a prediction.',
            'finalResult' => $selection ? ['status' => $selection['status'], 'ticketId' => $selection['ticket_id']] : null,
            'createdAt' => $p['created_at'],
        ]);
    }

    public function tickets()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $g = $this->input->get(NULL, true) ?: [];
        $filter = array_intersect_key($g, array_flip(['from', 'to', 'status', 'modelVersionId']));
        $tickets = $this->Aegis_model->sports->listTickets($filter, (int) ($g['limit'] ?: 200));
        foreach ($tickets as &$t) $t['selections'] = $this->Aegis_model->sports->ticketSelections((string) $t['id']);
        $this->json(['tickets' => $tickets]);
    }

    public function show_ticket(string $id)
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $t = $this->Aegis_model->sports->findTicket($id);
        if (!$t) return $this->jsonError('ticket not found', 404);
        $selections = $this->Aegis_model->sports->ticketSelections($id);
        foreach ($selections as &$s) {
            $match = $this->Aegis_model->sports->findMatchById((int) $s['match_id']);
            $s['match'] = $match ? ['homeTeam' => $match['home_team'], 'awayTeam' => $match['away_team'], 'competition' => $match['competition'], 'kickoff' => $match['kickoff_at']] : null;
        }
        $this->json(['ticket' => $t, 'selections' => $selections]);
    }

    public function daily_tickets()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $this->json(['dailyTickets' => $this->Aegis_model->sports->listDailyTickets((int) ($this->input->get('limit') ?: 60))]);
    }

    public function results()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $g = $this->input->get(NULL, true) ?: [];
        $limit = (int) ($g['limit'] ?: 200);
        $rows = $this->Aegis_model->sports->listMatches(['from' => $g['from'] ?? null, 'to' => $g['to'] ?? null, 'status' => 'FINISHED'], min(500, max(1, $limit)));
        $out = [];
        foreach ($rows as $m) {
            $r = $this->Aegis_model->sports->findResultByMatch((int) $m['id']);
            $out[] = ['match' => ['id' => (int) $m['id'], 'homeTeam' => $m['home_team'], 'awayTeam' => $m['away_team'], 'competition' => $m['competition'], 'kickoff' => $m['kickoff_at']],
                'result' => $r ? ['homeScore' => $r['home_score'], 'awayScore' => $r['away_score'], 'status' => $r['status'], 'verified' => (bool) $r['verified'], 'verifiedAt' => $r['verified_at'], 'sourceTimestamp' => $r['source_timestamp']] : null];
        }
        $this->json(['results' => $out]);
    }

    public function providers()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $this->json(['providers' => $this->platform->sports->status()['providers'], 'liveHealth' => $this->platform->sports->providers->health()]);
    }

    public function models()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $svc = $this->platform->sports->modelPerformance;
        $calibrations = $this->Aegis_model->sports->listCalibrations(null, null, 50);
        $this->json(['models' => $svc->listModels(), 'calibrations' => $calibrations, 'metrics' => $this->Aegis_model->sports->listModelMetrics(null, null, null, 100)]);
    }

    public function model_performance()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $window = (int) ($this->input->get('window') ?: 90);
        $this->json(['window' => $window, 'comparison' => $this->platform->sports->modelPerformance->compare($window)]);
    }

    public function calibrations()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $g = $this->input->get(NULL, true) ?: [];
        $this->json(['calibrations' => $this->Aegis_model->sports->listCalibrations(!empty($g['modelVersionId']) ? (int) $g['modelVersionId'] : null, $g['status'] ?? null, 50)]);
    }

    public function backtests()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $this->json(['backtests' => $this->Aegis_model->sports->listBacktests((int) ($this->input->get('limit') ?: 20))]);
    }

    public function show_backtest(string $id)
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $bt = $this->Aegis_model->sports->findBacktest($id);
        if (!$bt) return $this->jsonError('backtest not found', 404);
        $this->json(['backtest' => $bt]);
    }

    public function audit()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $g = $this->input->get(NULL, true) ?: [];
        $events = $this->Aegis_model->audit->recent((int) ($g['limit'] ?: 200));
        if (!empty($g['type'])) $events = array_values(array_filter($events, fn($e) => str_contains((string) $e['type'], (string) $g['type'])));
        $this->json(['events' => $events]);
    }

    public function jobs()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $g = $this->input->get(NULL, true) ?: [];
        $this->json(['jobs' => $this->Aegis_model->sports->listJobRuns(!empty($g['jobType']) ? (string) $g['jobType'] : null, (int) ($g['limit'] ?: 50))]);
    }

    public function configuration()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $this->json(['active' => $this->platform->sports->configuration->active(), 'history' => $this->Aegis_model->sports->listConfigurations(20)]);
    }

    public function risk_monitor()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $g = $this->input->get(NULL, true) ?: [];
        $since = gmdate('Y-m-d H:i:s', time() - (int) ($g['hours'] ?: 72) * 3600);
        $preds = $this->Aegis_model->sports->listPredictions(['from' => $since], 1000);
        $byRisk = ['LOW' => 0, 'MEDIUM' => 0, 'HIGH' => 0, 'REJECTED' => 0];
        $reasons = [];
        $recent = [];
        foreach ($preds as $p) {
            $r = $p['risk'] ?? 'REJECTED';
            $byRisk[$r] = ($byRisk[$r] ?? 0) + 1;
            if (($p['decision'] ?? '') !== 'PREDICTION_READY') {
                foreach ((array) ($p['rejection_reasons'] ?? []) as $reason) {
                    if (is_string($reason)) $reasons[$reason] = ($reasons[$reason] ?? 0) + 1;
                }
            }
            if (count($recent) < 50) $recent[] = ['predictionId' => $p['id'], 'market' => $p['market'], 'selection' => $p['selection'], 'risk' => $p['risk'], 'decision' => $p['decision'], 'rejectionReasons' => $p['rejection_reasons'] ?? [], 'confidence' => $p['confidence'], 'dataQuality' => $p['data_quality_score'], 'createdAt' => $p['created_at']];
        }
        arsort($reasons);
        $this->json(['byRisk' => $byRisk, 'rejectionReasons' => $reasons, 'recent' => $recent, 'windowHours' => (int) ($g['hours'] ?: 72)]);
    }

    public function correlation_monitor()
    {
        if (!$this->requirePermission('sports.view', false)) return;
        $eng = $this->platform->sports->correlation;
        $tickets = $this->Aegis_model->sports->listTickets([], 100);
        $alerts = [];
        foreach ($tickets as $t) {
            $sels = $this->Aegis_model->sports->ticketSelections((string) $t['id']);
            if (count($sels) < 2) continue;
            $rows = array_map(function ($s) use ($eng) {
                $m = $this->Aegis_model->sports->findMatchById((int) $s['match_id']);
                return ['matchId' => (int) $s['match_id'], 'competition' => $m['competition'] ?? null, 'homeTeam' => $m['home_team'] ?? null, 'awayTeam' => $m['away_team'] ?? null];
            }, $sels);
            $pairwise = $eng->classifySelections($rows);
            if ($pairwise['classification'] !== 'LOW') {
                $alerts[] = ['ticketId' => $t['id'], 'classification' => $pairwise['classification'], 'reasons' => $pairwise['reasons'], 'selectionCount' => count($sels), 'status' => $t['settlement_status']];
            }
        }
        $this->json(['alerts' => $alerts, 'note' => 'Tickets are optimized to stay under the configured correlation cap; these rows document measured pairwise classes.']);
    }

    // ------------------------------------------------------------------ admin
    public function update_configuration()
    {
        $user = $this->requirePermission('sports.manage');
        if (!$user) return;
        $body = $this->jsonBody();
        if (empty($body['reason']) || !is_string($body['reason']) || trim($body['reason']) === '') return $this->jsonError('reason is required for configuration changes');
        $patch = array_diff_key($body, array_flip(['reason', 'allowAutomatedExecution']));
        $result = $this->platform->sports->configuration->update($patch, (string) $user['id'], (string) $body['reason'], !empty($body['allowAutomatedExecution']));
        if (!$result['ok']) return $this->jsonError($result['reason'], 422);
        $this->json(['configuration' => $result['configuration']]);
    }

    /** Triggers the daily ticket run for the given (or current) UTC date. */
    public function run_ticket_engine()
    {
        $user = $this->requirePermission('sports.manage');
        if (!$user) return;
        $body = $this->jsonBody();
        $date = isset($body['date']) && preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $body['date']) ? (string) $body['date'] : gmdate('Y-m-d');
        $result = $this->platform->sports->dailyTickets->runDaily($date);
        $this->json($result, $result['status'] === 'NO_QUALIFIED_TICKET' ? 200 : 200);
    }

    /** Fits a new calibration version from stored settled predictions. */
    public function fit_calibration()
    {
        $user = $this->requirePermission('sports.manage');
        if (!$user) return;
        try {
            $svc = $this->platform->sports;
            $outcomes = $this->Aegis_model->sports->predictionOutcomes();
            $fit = $svc->calibration->fit($outcomes);
            if (empty($fit['ok'])) return $this->jsonError('calibration cannot be fitted: ' . ($fit['reason'] ?? 'unknown') . ' (samples: ' . ($fit['samples'] ?? 0) . ')', 422);
            $modelId = $this->Aegis_model->sports->ensureModelVersion(['modelName' => \Aegis\Sports\PredictionEngine::MODEL_NAME, 'modelVersion' => \Aegis\Sports\PredictionEngine::MODEL_VERSION, 'featureVersion' => \Aegis\Sports\FeatureEngineeringEngine::VERSION]);
            $id = $this->Aegis_model->sports->saveCalibration([
                'model_version_id' => $modelId, 'method' => 'platt',
                'intercept' => $fit['fit']['intercept'], 'slope' => $fit['fit']['slope'],
                'brier' => $fit['metrics']['brier'], 'ece' => $fit['metrics']['ece'],
                'samples' => $fit['fit']['samples'], 'bins' => json_encode($fit['bins']),
                'status' => 'PENDING', 'created_by' => (string) $user['id'], 'created_at' => gmdate('c'),
            ]);
            $this->Aegis_model->audit->emit('SPORTS_CALIBRATION_FITTED', 'New calibration version fitted (pending approval)', ['calibrationId' => $id, 'samples' => $fit['fit']['samples'], 'ece' => $fit['metrics']['ece'], 'brier' => $fit['metrics']['brier']], (string) $user['id']);
            $this->json(['calibration' => $this->Aegis_model->sports->findCalibration($id)]);
        } catch (\Throwable $e) {
            $this->jsonError($e->getMessage(), 409);
        }
    }

    public function approve_calibration(string $id)
    {
        $this->decide_calibration($id, 'APPROVED');
    }

    public function reject_calibration(string $id)
    {
        $this->decide_calibration($id, 'REJECTED');
    }

    private function decide_calibration(string $id, string $status)
    {
        $user = $this->requirePermission('sports.manage');
        if (!$user) return;
        $cal = $this->Aegis_model->sports->findCalibration((int) $id);
        if (!$cal) { $this->jsonError('calibration not found', 404); return; }
        if (($cal['status'] ?? '') !== 'PENDING') { $this->jsonError('calibration already decided', 409); return; }
        $this->Aegis_model->sports->updateCalibrationStatus((int) $id, $status, (string) $user['id']);
        $this->Aegis_model->audit->emit('SPORTS_CALIBRATION_' . $status, 'Calibration ' . $status . ' by ' . $user['id'], ['calibrationId' => (int) $id, 'intercept' => $cal['intercept'], 'slope' => $cal['slope'], 'samples' => $cal['samples']], (string) $user['id']);
        $this->json(['calibration' => $this->Aegis_model->sports->findCalibration((int) $id)]);
    }

    public function run_backtest()
    {
        $user = $this->requirePermission('sports.manage');
        if (!$user) return;
        $body = $this->jsonBody();
        if (empty($body['from']) || empty($body['to'])) return $this->jsonError('from and to (YYYY-MM-DD) are required');
        try {
            $report = $this->platform->sports->backtester->run($body, (string) $user['id']);
            $this->json(['backtest' => $report]);
        } catch (\InvalidArgumentException $e) {
            $this->jsonError($e->getMessage(), 422);
        } catch (\Throwable $e) {
            $this->jsonError($e->getMessage(), 409);
        }
    }

    public function run_job(string $job)
    {
        $user = $this->requirePermission('sports.manage');
        if (!$user) return;
        if (!in_array($job, \Aegis\Sports\SportsCronService::JOBS, true)) return $this->jsonError('unknown job. Valid: ' . implode(', ', \Aegis\Sports\SportsCronService::JOBS), 422);
        $service = new \Aegis\Sports\SportsCronService($this->Aegis_model->sports, $this->Aegis_model->audit, $this->platform->sports);
        $this->json(['result' => $service->run($job)], 200);
    }

    public function toggle_provider(string $id)
    {
        $user = $this->requirePermission('sports.manage');
        if (!$user) return;
        $body = $this->jsonBody();
        if (!isset($body['enabled']) || !is_bool($body['enabled'])) return $this->jsonError('body must include enabled: boolean');
        $providers = $this->Aegis_model->sports->listProviders();
        $target = null;
        foreach ($providers as $p) if ((int) $p['id'] === (int) $id) { $target = $p; break; }
        if (!$target) return $this->jsonError('provider not found', 404);
        $this->Aegis_model->sports->setProviderEnabled((int) $id, (bool) $body['enabled']);
        $this->Aegis_model->audit->emit('SPORTS_PROVIDER_TOGGLED', 'Provider ' . $target['provider_code'] . ' ' . ((bool) $body['enabled'] ? 'enabled' : 'disabled'), ['provider' => $target['provider_code'], 'enabled' => (bool) $body['enabled']], (string) $user['id']);
        $this->json(['provider' => $this->Aegis_model->sports->listProviders(true)]);
    }

    // ------------------------------------------------------------ governance
    /** Human decision only. Requires the native session, CSRF token and sports.approve. */
    public function decide_ticket(string $id)
    {
        $user = $this->requirePermission('sports.approve');
        if (!$user) return;
        if (!empty($this->platform->state()['killSwitch']['active'] ?? null)) {
            return $this->jsonError('kill switch is ACTIVE — approving new tickets is blocked until it is released (settlement remains available)', 409);
        }
        $body = $this->jsonBody();
        if (!isset($body['approve']) || !is_bool($body['approve'])) return $this->jsonError('body must include approve: boolean');
        try {
            $this->json(['ticket' => $this->platform->sports->governance->decide($id, $body['approve'], (string) $user['id'], (string) ($body['reason'] ?? ''))]);
        } catch (\InvalidArgumentException $e) { $this->jsonError($e->getMessage(), 404); }
        catch (\Throwable $e) { $this->jsonError($e->getMessage(), 409); }
    }

    /** Promotes a persisted provider result only after validation. */
    public function verify_result()
    {
        $user = $this->requirePermission('sports.settle');
        if (!$user) return;
        $body = $this->jsonBody();
        if (!isset($body['matchId'], $body['providerId']) || !is_numeric($body['matchId']) || !is_numeric($body['providerId'])) return $this->jsonError('body must include numeric matchId and providerId');
        try { $this->json(['result' => $this->platform->sports->resultVerifier->verify((int) $body['matchId'], (int) $body['providerId'], (string) $user['id'])]); }
        catch (\InvalidArgumentException $e) { $this->jsonError($e->getMessage(), 404); }
        catch (\Throwable $e) { $this->jsonError($e->getMessage(), 409); }
    }

    /** Settles only from an already verified persisted provider result. */
    public function settle_ticket(string $id)
    {
        if (!$this->requirePermission('sports.settle')) return;
        $body = $this->jsonBody();
        try {
            if (isset($body['matchId'], $body['providerId']) && is_numeric($body['matchId']) && is_numeric($body['providerId'])) {
                $this->json(['settlement' => $this->platform->sports->settlement->applyStoredResult($id, (int) $body['matchId'], (int) $body['providerId'])]);
            } else {
                $this->json(['settlement' => $this->platform->sports->settlement->settlePending($id)]);
            }
        } catch (\InvalidArgumentException $e) { $this->jsonError($e->getMessage(), 404); }
        catch (\Throwable $e) { $this->jsonError($e->getMessage(), 409); }
    }
}
