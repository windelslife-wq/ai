<?php
namespace Aegis\Lottery;

use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\LotteryRepository;

/**
 * WINDELS Lottery Intelligence — Phase 30 (spec §40): scheduled jobs.
 *
 * Idempotent by execution key: running the same job twice never creates
 * duplicate draws or health rows. One failing job never aborts the sweep;
 * failures are audited.
 *
 *   php index.php tools lottery-cron [job]
 */
class LotteryCronService
{
    public const JOBS = ['sync', 'health', 'statistics', 'systems', 'tickets', 'backtests', 'cleanup'];

    public function __construct(
        private LotteryRepository $repo,
        private AuditRepository $audit,
        private LotteryIntelligence $lottery,
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
                $this->audit->emit('LOTTERY_JOB_FAILED', "Lottery job {$job} failed: " . $e->getMessage(), ['job' => $job]);
            }
        }
        $this->audit->emit('LOTTERY_CRON_RUN', 'Lottery scheduled jobs: ' . json_encode(array_map(fn($s) => $s['status'] ?? 'FAILED', $summary)), $summary, 'system');
        return $summary;
    }

    public function run(string $job, ?string $date = null): array
    {
        $date = $date ?? gmdate('Y-m-d');
        return match ($job) {
            'sync' => $this->jobSync($date),
            'health' => $this->jobHealth($date),
            'statistics' => $this->jobStatistics($date),
            'systems' => $this->jobSystems(),
            'tickets' => $this->jobTickets(),
            'backtests' => $this->jobBacktests($date),
            'cleanup' => $this->jobCleanup(),
            default => throw new \InvalidArgumentException('unknown lottery job: ' . $job),
        };
    }

    private function jobSync(string $date): array
    {
        // Once per day per lottery: same execution key on a second run is a no-op.
        $run = $this->repo->startJobRun([
            'id' => \Aegis\Backtest\Backtester::uuid(),
            'jobType' => 'sync',
            'executionKey' => 'sync:EUROMILLIONS:' . $date,
        ]);
        if ($run === null) {
            return ['status' => 'ALREADY_RUN', 'note' => 'sync already completed for ' . $date . ' (idempotent)'];
        }
        $result = $this->lottery->sync(100);
        $status = match ($result['status']) {
            'NO_PROVIDER' => 'SKIPPED_NO_PROVIDER',
            default => 'OK',
        };
        $this->repo->finishJobRun((string) $run['id'], [
            'status' => $status,
            'processed' => ($result['imported'] ?? 0) + ($result['unchanged'] ?? 0) + ($result['failed'] ?? 0),
            'created' => $result['imported'] ?? 0,
            'updated' => $result['corrected'] ?? 0,
            'errors' => $result['errors'] ?? [],
        ]);
        return $result + ['status' => $status];
    }

    private function jobHealth(string $date): array
    {
        $health = $this->lottery->providerHealth();
        $live = $health['live'] ?? [];
        $stale = false;
        if (!empty($health['latest']['last_success_at'])) {
            $age = (int) (time() - strtotime((string) $health['latest']['last_success_at']));
            // EuroMillions draws twice a week: 8 days without a successful sync is stale
            $stale = $age > 8 * 86400;
        }
        $status = ($live['state'] ?? 'OFFLINE') === 'ONLINE' ? ($stale ? 'DEGRADED' : 'ONLINE') : (($live['state'] ?? 'OFFLINE') === 'UNCONFIGURED' ? 'OFFLINE' : 'DEGRADED');
        return ['status' => $status, 'provider' => $health['provider'] ?? 'unconfigured', 'stale' => $stale, 'liveState' => $live['state'] ?? null];
    }

    /**
     * Data-integrity sweep: every stored draw must carry the full rule shape
     * (5 mains in range, 2 stars in range, no duplicates) and a source.
     * Returns violations (audited) — the fix path is manual correction, not
     * silent rewriting of verified data.
     */
    private function jobStatistics(string $date): array
    {
        $rules = $this->lottery->rules;
        $validator = new LotteryResultValidator($rules);
        $draws = $this->repo->listDraws(['lotteryCode' => LotteryIntelligence::LOTTERY], 100000, 'ASC');
        $violations = [];
        foreach ($draws as $d) {
            $p = is_array($d['payload'] ?? null) ? $d['payload'] : [];
            $check = $validator->validate([
                'externalId' => $d['external_id'], 'drawDate' => $d['draw_date'],
                'main' => $p['main'] ?? null, 'stars' => $p['stars'] ?? null,
                'source' => $d['source'], 'sourceTimestamp' => $d['source_timestamp'],
            ]);
            if (!$check['valid']) {
                $violations[] = ['drawId' => (int) $d['id'], 'externalId' => (string) $d['external_id'], 'errors' => $check['errors']];
            }
        }
        if ($violations !== []) {
            $this->audit->emit('LOTTERY_INTEGRITY_VIOLATIONS', count($violations) . ' stored draw(s) violate the rules — manual correction required', ['violations' => array_slice($violations, 0, 20)]);
        }
        return ['status' => 'OK', 'drawsChecked' => count($draws), 'violations' => count($violations), 'detail' => array_slice($violations, 0, 10)];
    }

    /**
     * Background system builds (spec §18): process queued `system` job runs
     * (execution-key idempotent — a pool is built at most once). Each build
     * saves one SYSTEM combination row with the full line set.
     */
    private function jobSystems(): array
    {
        $pending = array_values(array_filter(
            $this->repo->listJobRuns('system', 50),
            fn($r) => ($r['status'] ?? '') === 'RUNNING'
        ));
        $built = 0;
        $failed = 0;
        foreach ($pending as $run) {
            $payload = json_decode((string) ($run['payload'] ?? ''), true);
            if (!is_array($payload) || !is_array($payload['mains'] ?? null) || !is_array($payload['stars'] ?? null)) {
                $this->repo->finishJobRun((string) $run['id'], ['status' => 'FAILED', 'processed' => 0, 'created' => 0, 'updated' => 0, 'errors' => ['invalid system payload']]);
                $failed++;
                continue;
            }
            try {
                $mains = array_map('intval', $payload['mains']);
                $stars = array_map('intval', $payload['stars']);
                $lines = $this->lottery->systemBuilder->allLines($mains, $stars);
                if (count($lines) > SystemBuilder::MAX_BACKGROUND_LINES) {
                    $this->repo->finishJobRun((string) $run['id'], ['status' => 'FAILED', 'processed' => count($lines), 'created' => 0, 'updated' => 0, 'errors' => ['system exceeds ' . SystemBuilder::MAX_BACKGROUND_LINES . ' lines — reduce the pool']]);
                    $failed++;
                    continue;
                }
                $plan = $this->lottery->systemBuilder->plan($mains, $stars);
                $this->lottery->saveSystem($plan, $lines, 'system');
                $this->repo->finishJobRun((string) $run['id'], ['status' => 'OK', 'processed' => count($lines), 'created' => 1, 'updated' => 0, 'errors' => []]);
                $built++;
            } catch (\Throwable $e) {
                $this->repo->finishJobRun((string) $run['id'], ['status' => 'FAILED', 'processed' => 0, 'created' => 0, 'updated' => 0, 'errors' => [mb_substr($e->getMessage(), 0, 300)]]);
                $failed++;
            }
        }
        return ['status' => 'OK', 'built' => $built, 'failed' => $failed, 'pending' => count($pending)];
    }

    /**
     * Auto post-draw ticket checking (spec §29/§40): every OPEN ticket whose
     * draw date is on or before the latest stored VERIFIED draw gets
     * compared (idempotent — CHECKED tickets are never re-checked).
     */
    private function jobTickets(): array
    {
        $draws = $this->repo->listDraws(['lotteryCode' => LotteryIntelligence::LOTTERY, 'verificationStatus' => 'VERIFIED'], 1);
        if ($draws === []) {
            return ['status' => 'OK', 'attempted' => 0, 'checked' => 0, 'note' => 'no stored VERIFIED draw'];
        }
        $attempted = 0;
        $checked = 0;
        foreach ($this->repo->listAllTickets(500) as $t) {
            if (($t['status'] ?? '') !== LotteryIntelligence::STATUS_OPEN) continue;
            if (!empty($t['draw_date']) && (string) $t['draw_date'] > (string) $draws[0]['draw_date']) continue; // future-dated: wait for its draw
            $attempted++;
            $result = $this->lottery->checkTicket((int) $t['id'], null, 'system');
            if (is_array($result) && ($result['status'] ?? '') === LotteryIntelligence::STATUS_CHECKED) $checked++;
        }
        return ['status' => 'OK', 'attempted' => $attempted, 'checked' => $checked];
    }

    /**
     * Strategy performance (spec §40): one backtest per strategy per day.
     * Execution-key idempotent — re-running the same day never creates
     * duplicate backtest rows or job runs. Each run saves a HISTORICAL
     * SIMULATION report (the random baseline is included every day).
     */
    private function jobBacktests(string $date): array
    {
        $ran = 0;
        $skipped = 0;
        foreach (LotteryBacktester::STRATEGIES as $strategy) {
            $key = 'backtest:EUROMILLIONS:' . $strategy . ':' . $date;
            if ($this->repo->findJobRunByKey($key) !== null) {
                $skipped++;
                continue;
            }
            $run = $this->repo->startJobRun([
                'id' => \Aegis\Backtest\Backtester::uuid(),
                'jobType' => 'backtest',
                'payload' => json_encode(['strategy' => $strategy]),
                'executionKey' => $key,
            ]);
            if ($run === null) {
                $skipped++;
                continue;
            }
            try {
                $report = $this->lottery->backtest($strategy, 1, 0);
                $this->repo->finishJobRun((string) $run['id'], [
                    'status' => 'OK',
                    'processed' => (int) $report['period']['drawsTested'],
                    'created' => 1,
                    'updated' => 0,
                    'errors' => [],
                ]);
                $ran++;
            } catch (\Throwable $e) {
                $this->repo->finishJobRun((string) $run['id'], [
                    'status' => 'FAILED',
                    'processed' => 0,
                    'created' => 0,
                    'updated' => 0,
                    'errors' => [mb_substr($e->getMessage(), 0, 300)],
                ]);
                $this->audit->emit('LOTTERY_BACKTEST_FAILED', 'Scheduled backtest ' . $strategy . ' failed: ' . $e->getMessage(), ['strategy' => $strategy], 'system');
            }
        }
        return ['status' => 'OK', 'ran' => $ran, 'skipped' => $skipped];
    }

    private function jobCleanup(): array
    {
        $runCutoff = gmdate('Y-m-d H:i:s', time() - 90 * 86400);
        $healthCutoff = gmdate('Y-m-d H:i:s', time() - 30 * 86400);
        $this->repo->deleteOldJobRuns($runCutoff);
        $this->repo->deleteOldHealth($healthCutoff);
        return ['status' => 'OK', 'runCutoff' => $runCutoff, 'healthCutoff' => $healthCutoff];
    }
}
