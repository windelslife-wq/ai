<?php
namespace Aegis\Sports;

/**
 * Provider Health Monitor (spec §6).
 *
 * Derives the provider status from OBSERVED data only — health observations,
 * sync-run history, and recency — and computes a 0..1 reliability score used
 * by the Data Quality Engine. Never invents a status: with no observations
 * the status is UNKNOWN.
 *
 * Statuses: ONLINE | DEGRADED | OFFLINE | RATE_LIMITED | AUTHENTICATION_ERROR | DATA_ERROR
 */
class ProviderHealthMonitor
{
    public const STALE_AFTER_SECONDS = 6 * 3600;
    public const DEGRADED_ERROR_RATE = 0.5;

    /**
     * @param array  $provider   sports_data_sources row
     * @param array  $health     newest-first sports_provider_health rows
     * @param array  $jobRuns    newest-first sports_sync_runs rows for this provider
     * @param int|null $now
     * @return array{status:string, reliability:float, detail:string, checkedAt:string}
     */
    public function assess(array $provider, array $health, array $jobRuns, ?int $now = null): array
    {
        $now ??= time();
        if (!$health && !$jobRuns) return ['status' => 'UNKNOWN', 'reliability' => 0.0, 'detail' => 'no observations yet', 'checkedAt' => gmdate('c', $now)];

        $latest = $health[0] ?? null;
        $lastFailure = null;
        foreach ($health as $h) {
            $at = $this->ts($h['observed_at'] ?? null);
            if ($at !== null && $at <= $now && in_array($h['status'], ['OFFLINE', 'DATA_ERROR', 'RATE_LIMITED', 'AUTHENTICATION_ERROR', 'DEGRADED'], true)) { $lastFailure = ['at' => $at, 'status' => $h['status']]; break; }
        }

        // Terminal statuses from the provider's own last report win (e.g. auth problems are not retryable by fallback alone).
        if ($latest !== null && in_array($latest['status'], ['AUTHENTICATION_ERROR', 'RATE_LIMITED'], true) && $this->recent($latest['observed_at'], $now, 1800)) {
            return ['status' => $latest['status'], 'reliability' => $this->reliability($jobRuns), 'detail' => 'last provider report: ' . $latest['status'], 'checkedAt' => gmdate('c', $now)];
        }

        $successRuns = 0; $failRuns = 0; $lastSync = null;
        foreach ($jobRuns as $r) {
            $at = $this->ts($r['started_at'] ?? null);
            if ($at !== null && $at <= $now && $lastSync === null) $lastSync = $at;
            if (($r['status'] ?? '') === 'COMPLETED') $successRuns++;
            elseif (($r['status'] ?? '') === 'FAILED') $failRuns++;
        }
        $total = $successRuns + $failRuns;
        $errorRate = $total > 0 ? $failRuns / $total : null;

        if ($lastFailure !== null && ($now - $lastFailure['at']) <= 300) {
            $status = in_array($lastFailure['status'], ['RATE_LIMITED', 'AUTHENTICATION_ERROR'], true) ? $lastFailure['status'] : 'DEGRADED';
            return ['status' => $status, 'reliability' => $this->reliability($jobRuns), 'detail' => 'failing since ' . gmdate('c', $lastFailure['at']) . ' (' . $lastFailure['status'] . ')', 'checkedAt' => gmdate('c', $now)];
        }
        if ($latest !== null && ($now - $this->ts($latest['observed_at']) > self::STALE_AFTER_SECONDS || $this->ts($latest['observed_at']) === null) && ($lastSync === null || ($now - $lastSync) > self::STALE_AFTER_SECONDS)) {
            return ['status' => 'OFFLINE', 'reliability' => $this->reliability($jobRuns), 'detail' => 'no successful observation within ' . self::STALE_AFTER_SECONDS . 's', 'checkedAt' => gmdate('c', $now)];
        }
        if ($errorRate !== null && $errorRate >= self::DEGRADED_ERROR_RATE) {
            return ['status' => 'DEGRADED', 'reliability' => $this->reliability($jobRuns), 'detail' => sprintf('error rate %.0f%% over %d runs', $errorRate * 100, $total), 'checkedAt' => gmdate('c', $now)];
        }
        if ($latest !== null && ($latest['status'] ?? '') === 'ONLINE') {
            return ['status' => 'ONLINE', 'reliability' => $this->reliability($jobRuns, true), 'detail' => 'last observation ONLINE', 'checkedAt' => gmdate('c', $now)];
        }
        return ['status' => 'DEGRADED', 'reliability' => $this->reliability($jobRuns), 'detail' => 'no recent ONLINE observation', 'checkedAt' => gmdate('c', $now)];
    }

    /** 0..1 reliability from run history (with a recency boost for fresh success). */
    private function reliability(array $jobRuns, bool $boost = false): float
    {
        $success = 0; $total = 0;
        foreach ($jobRuns as $r) {
            if (($r['status'] ?? '') === 'COMPLETED') { $success++; $total++; }
            elseif (($r['status'] ?? '') === 'FAILED') $total++;
        }
        if ($total === 0) return $boost ? 0.5 : 0.0;
        return round(min(1.0, ($success / $total) * ($boost ? 1.0 : 0.95)), 4);
    }

    private function ts(?string $value): ?int
    {
        if (!$value) return null;
        try { return (new \DateTimeImmutable((string) $value))->getTimestamp(); }
        catch (\Throwable $e) { return null; }
    }

    private function recent(?string $value, int $now, int $window): bool
    {
        $at = $this->ts($value);
        return $at !== null && ($now - $at) <= $window;
    }
}
