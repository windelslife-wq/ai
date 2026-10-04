<?php
namespace Aegis\Sports;

use Aegis\Backtest\Backtester;
use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\SportsRepository;

/**
 * Idempotent scheduled jobs (spec §31).
 *
 * Every job is guarded by an execution key: running the same job twice never
 * creates duplicates. Every run records start/end, status, records
 * processed/created/updated, errors, and provider. Jobs fail gracefully —
 * one failing job never aborts the sweep, and failures are audited.
 *
 *   php index.php tools sports-cron [job]
 */
class SportsCronService
{
    public const JOBS = ['fixtures', 'odds', 'results', 'quality', 'ticket', 'settlement', 'performance', 'monitoring', 'cleanup'];

    public function __construct(
        private SportsRepository $repo,
        private AuditRepository $audit,
        private SportsIntelligence $sports
    ) {}

    public function runAll(?string $date = null): array
    {
        $date = $date ?? gmdate('Y-m-d');
        $summary = [];
        foreach (self::JOBS as $job) {
            try {
                $summary[$job] = $this->run($job, $date);
            } catch (\Throwable $e) {
                $summary[$job] = ['status' => 'FAILED', 'error' => mb_substr($e->getMessage(), 0, 300)];
                $this->audit->emit('SPORTS_JOB_FAILED', "Sports job {$job} failed: " . $e->getMessage(), ['job' => $job]);
            }
        }
        $this->audit->emit('SPORTS_CRON_RUN', 'Sports scheduled jobs: ' . json_encode(array_map(fn($s) => $s['status'] ?? 'FAILED', $summary)), $summary, 'system');
        return $summary;
    }

    public function run(string $job, ?string $date = null): array
    {
        $date = $date ?? gmdate('Y-m-d');
        return match ($job) {
            'fixtures' => $this->jobFixtures($date),
            'odds' => $this->jobOdds($date),
            'results' => $this->jobResults($date),
            'quality' => $this->jobQuality($date),
            'ticket' => $this->jobTicket($date),
            'settlement' => $this->jobSettlement($date),
            'performance' => $this->jobPerformance($date),
            'monitoring' => $this->jobMonitoring($date),
            default => throw new \InvalidArgumentException('unknown sports job: ' . $job),
        };
    }

    private function jobFixtures(string $date): array
    {
        $from = $date;
        $to = gmdate('Y-m-d', strtotime($date . ' +13 days'));
        $out = [];
        foreach ($this->sports->providers->all() as $provider) {
            $key = 'fixtures:' . $from . ':' . $to . ':' . $provider->id();
            $result = $this->sports->sync->syncFixtures($provider, ['from' => $from, 'to' => $to], $key);
            $out[$provider->id()] = $result;
        }
        return $this->combine('FIXTURES_SYNC', $out, 'no providers configured; nothing synchronized (nothing fabricated)');
    }

    private function jobOdds(string $date): array
    {
        $end = gmdate('Y-m-d', strtotime($date . ' +1 day')) . 'T00:00:00+00:00';
        $matches = $this->repo->listMatches(['from' => $date . 'T00:00:00+00:00', 'to' => $end, 'status' => 'SCHEDULED'], 500);
        $matches = array_merge($matches, $this->repo->listMatches(['status' => 'LIVE'], 200));
        $out = []; $processed = 0; $created = 0; $errors = [];
        foreach ($matches as $match) {
            $providerId = (int) $match['provider_id'];
            $provider = $this->providerById($this->repo->listProviders(), $providerId);
            if ($provider === null) continue;
            $key = 'odds:' . (int) $match['id'] . ':' . $date . ':' . $provider->id();
            $result = $this->sports->sync->syncOdds($provider, (string) $match['external_id'], $key);
            $out[(string) $match['id']] = $result['status'];
            $processed++;
            if (($result['status'] ?? '') === 'COMPLETED') $created += (int) ($result['created'] ?? 0);
            if (($result['status'] ?? '') === 'FAILED') $errors[] = implode('; ', $result['errors'] ?? []);
        }
        return $this->combine('ODDS_SYNC', $out, count($out) . ' match(es) synced', $processed, $created, $errors);
    }

    private function jobResults(string $date): array
    {
        $since = gmdate('Y-m-d', strtotime($date . ' -2 days')) . 'T00:00:00+00:00';
        $matches = $this->repo->listMatches(['from' => $since, 'to' => $date . 'T23:59:59+00:00'], 500);
        $out = []; $processed = 0; $errors = [];
        foreach ($matches as $match) {
            if ($this->repo->findResultByMatch((int) $match['id']) !== null) continue;
            $provider = $this->providerById($this->repo->listProviders(), (int) $match['provider_id']);
            if ($provider === null) continue;
            $key = 'results:' . (int) $match['id'] . ':' . $date . ':' . $provider->id();
            $result = $this->sports->sync->syncResults($provider, (string) $match['external_id'], $key);
            $out[(string) $match['id']] = $result['status'];
            $processed++;
            if (($result['status'] ?? '') === 'FAILED') $errors[] = implode('; ', $result['errors'] ?? []);
        }
        return $this->combine('RESULTS_SYNC', $out, count($out) . ' match(es) checked', $processed, $processed, $errors);
    }

    private function jobQuality(string $date): array
    {
        $hour = gmdate('H');
        $key = 'quality:' . $date . ':' . $hour;
        $run = $this->repo->startJobRun(['id' => Backtester::uuid(), 'jobType' => 'QUALITY_RECALC', 'executionKey' => $key]);
        if ($run === null) return ['status' => 'DUPLICATE_SKIPPED', 'executionKey' => $key];
        $end = gmdate('Y-m-d', strtotime($date . ' +1 day')) . 'T00:00:00+00:00';
        $matches = array_merge($this->repo->listMatches(['from' => $date . 'T00:00:00+00:00', 'to' => $end, 'status' => 'SCHEDULED'], 500), $this->repo->listMatches(['status' => 'LIVE'], 200));
        $updated = 0; $errors = [];
        foreach ($matches as $match) {
            try {
                $payload = is_array($match['payload'] ?? null) ? $match['payload'] : [];
                $matchArr = array_merge($match, ['externalId' => $match['external_id'], 'homeTeam' => $match['home_team'], 'awayTeam' => $match['away_team'], 'kickoff' => $match['kickoff_at'], 'context' => $payload['context'] ?? null, 'sourceTimestamp' => $match['source_timestamp']]);
                $odds = $this->repo->latestOdds((int) $match['id'], 'TOTAL_GOALS', 'OVER_1_5');
                $provider = $this->providerById($this->repo->listProviders(), (int) $match['provider_id']);
                $reliability = 0.0;
                if ($provider !== null) {
                    $health = $provider->health();
                    $reliability = (float) ($health['reliability'] ?? 0);
                }
                $quality = $this->sports->quality->assess($matchArr, [
                    'oddsAvailable' => $odds !== null,
                    'recentFormAvailable' => !empty($matchArr['context']['recentForm']),
                    'providerReliability' => $reliability,
                    'dataAgeSeconds' => $odds ? $this->ageOf($odds['observed_at']) : $this->ageOf($match['source_timestamp']),
                    'maxAgeSeconds' => 3600,
                ]);
                $this->repo->saveQuality((int) $match['id'], $quality);
                $updated++;
            } catch (\Throwable $e) {
                $errors[] = mb_substr($e->getMessage(), 0, 200);
            }
        }
        $this->repo->finishJobRun($run['id'], ['status' => 'COMPLETED', 'processed' => count($matches), 'created' => 0, 'updated' => $updated, 'errors' => $errors]);
        $this->audit->emit('SPORTS_QUALITY_RECALC', 'Data quality recalculated for ' . $updated . ' active match(es)', ['matches' => count($matches), 'errors' => $errors]);
        return ['status' => 'COMPLETED', 'matches' => count($matches), 'updated' => $updated, 'errors' => $errors];
    }

    private function jobTicket(string $date): array
    {
        $result = $this->sports->dailyTickets->runDaily($date);
        return ['status' => $result['status'], 'ticketId' => $result['ticketId'], 'message' => $result['message'], 'errors' => $result['errors']];
    }

    private function jobSettlement(string $date): array
    {
        $hour = gmdate('H');
        $key = 'settlement:' . $date . ':' . $hour;
        $run = $this->repo->startJobRun(['id' => Backtester::uuid(), 'jobType' => 'SETTLEMENT_SWEEP', 'executionKey' => $key]);
        if ($run === null) return ['status' => 'DUPLICATE_SKIPPED', 'executionKey' => $key];
        $settled = 0; $stillPending = 0; $errors = [];
        foreach ($this->repo->listTickets(['status' => 'PENDING'], 200) as $ticket) {
            try {
                $res = $this->sports->settlement->settlePending((string) $ticket['id']);
                if (($res['status'] ?? 'PENDING') !== 'PENDING') $settled++;
                else $stillPending++;
            } catch (\Throwable $e) {
                $errors[] = mb_substr($e->getMessage(), 0, 200);
            }
        }
        $this->repo->finishJobRun($run['id'], ['status' => 'COMPLETED', 'processed' => $settled + $stillPending, 'created' => 0, 'updated' => $settled, 'errors' => $errors]);
        $this->audit->emit('SPORTS_SETTLEMENT_SWEEP', 'Settlement sweep: ' . $settled . ' ticket(s) finalized, ' . $stillPending . ' still pending verified results', ['settled' => $settled, 'pending' => $stillPending, 'errors' => $errors]);
        return ['status' => 'COMPLETED', 'settled' => $settled, 'pending' => $stillPending, 'errors' => $errors];
    }

    private function jobPerformance(string $date): array
    {
        $hour = gmdate('H');
        $key = 'performance:' . $date . ':' . $hour;
        $run = $this->repo->startJobRun(['id' => Backtester::uuid(), 'jobType' => 'PERFORMANCE_SNAPSHOT', 'executionKey' => $key]);
        if ($run === null) return ['status' => 'DUPLICATE_SKIPPED', 'executionKey' => $key];
        $asOf = gmdate('c', strtotime(gmdate('Y-m-d H') . ':00:00'));
        $snapshots = 0; $errors = [];
        foreach (['7' => '7', '30' => '30', '90' => '90', 'ALL' => 'ALL'] as $window => $label) {
            try {
                $filter = $window === 'ALL' ? [] : ['from' => gmdate('Y-m-d', strtotime($date . ' -' . ($window === '7' ? 6 : $window) . ' days')) . 'T00:00:00+00:00', 'to' => $date . 'T23:59:59+00:00'];
                $this->repo->savePerformanceSnapshot($asOf, $window, $this->sports->performanceReport($filter));
                $snapshots++;
            } catch (\Throwable $e) {
                $errors[] = mb_substr($e->getMessage(), 0, 200);
            }
        }
        $this->repo->finishJobRun($run['id'], ['status' => 'COMPLETED', 'processed' => 4, 'created' => $snapshots, 'updated' => 0, 'errors' => $errors]);
        return ['status' => 'COMPLETED', 'snapshots' => $snapshots, 'errors' => $errors];
    }

    private function jobMonitoring(string $date): array
    {
        $hour = gmdate('H');
        $key = 'monitoring:' . $date . ':' . $hour;
        $run = $this->repo->startJobRun(['id' => Backtester::uuid(), 'jobType' => 'MONITORING', 'executionKey' => $key]);
        if ($run === null) return ['status' => 'DUPLICATE_SKIPPED', 'executionKey' => $key];
        $healthReports = [];
        foreach ($this->repo->listProviders() as $p) {
            $report = $this->sports->providerHealth->assess($p, $this->repo->listHealth((int) $p['id'], 20), array_filter($this->repo->listJobRuns(null, 100), fn($r) => ($r['provider'] ?? null) === ($p['provider_code'] ?? null)));
            $healthReports[$p['provider_code'] ?? (string) $p['id']] = $report;
        }
        $drift = $this->sports->driftMonitor->monitor();
        $this->repo->finishJobRun($run['id'], ['status' => 'COMPLETED', 'processed' => count($healthReports) + 1, 'created' => 0, 'updated' => 0, 'errors' => []]);
        $this->audit->emit('SPORTS_MONITORING', 'Provider health + model drift monitoring: ' . $drift['warnings'] . ' drift warning(s)', ['providers' => $healthReports, 'driftWarnings' => $drift['warnings']]);
        return ['status' => 'COMPLETED', 'providers' => $healthReports, 'driftWarnings' => $drift['warnings']];
    }

    private function jobCleanup(string $date): array
    {
        $key = 'cleanup:' . $date;
        $run = $this->repo->startJobRun(['id' => Backtester::uuid(), 'jobType' => 'DATA_CLEANUP', 'executionKey' => $key]);
        if ($run === null) return ['status' => 'DUPLICATE_SKIPPED', 'executionKey' => $key];
        $cutoff = gmdate('Y-m-d H:i:s', strtotime('-90 days'));
        // Retention: old job-run and health-observation rows are operational history,
        // never decision inputs — predictions/tickets/results are kept forever.
        $this->repo->deleteOldJobRuns($cutoff);
        $this->repo->deleteOldHealth($cutoff);
        $this->repo->finishJobRun($run['id'], ['status' => 'COMPLETED', 'processed' => 0, 'created' => 0, 'updated' => 0, 'errors' => []]);
        $this->audit->emit('SPORTS_DATA_CLEANUP', 'Retention cleanup applied (90-day operational history)', ['cutoff' => $cutoff]);
        return ['status' => 'COMPLETED', 'cutoff' => $cutoff];
    }

    private function providerById(array $providers, int $id): ?\Aegis\Sports\Providers\SportsDataProvider
    {
        $code = null;
        foreach ($providers as $p) if ((int) $p['id'] === $id) { $code = $p['provider_code']; break; }
        if ($code === null) return null;
        return $this->sports->providers->provider($code);
    }

    private function ageOf(?string $value): int
    {
        if (!$value) return PHP_INT_MAX;
        try { return max(0, time() - (new \DateTimeImmutable((string) $value))->getTimestamp()); }
        catch (\Throwable $e) { return PHP_INT_MAX; }
    }

    private function combine(string $label, array $results, string $summary, int $processed = 0, int $created = 0, array $errors = []): array
    {
        $status = 'COMPLETED';
        if (!$results) {
            $status = 'SKIPPED';
        } elseif (array_filter($results, fn($r) => $r === 'FAILED')) {
            $status = 'PARTIAL';
        }
        $this->audit->emit('SPORTS_' . $label, 'Sports ' . strtolower(str_replace('_', ' ', $label)) . ': ' . $summary, ['results' => $results, 'errors' => $errors]);
        return ['status' => $status, 'results' => $results, 'summary' => $summary, 'processed' => $processed, 'created' => $created, 'errors' => $errors];
    }
}
