<?php
namespace Aegis\Sports;

use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\SportsRepository;

/**
 * Model versioning + measured performance (spec §25/§26).
 *
 * Every metric here is COMPUTED from stored settled data (prediction outcomes
 * + ticket settlements). Models are compared on measured performance — the
 * newest model is never assumed to be the best. A model with no settled data
 * reports no metrics rather than an invented baseline.
 */
class ModelPerformanceService
{
    public function __construct(private SportsRepository $repo, private AuditRepository $audit) {}

    public function listModels(): array
    {
        return array_map(fn($m) => [
            'id' => (int) $m['id'], 'modelName' => $m['model_name'], 'modelVersion' => $m['model_version'],
            'featureVersion' => $m['feature_version'], 'calibrationVersion' => $m['calibration_version'] ?? null,
            'status' => $m['status'], 'createdAt' => $m['created_at'],
        ], $this->repo->listModelVersions());
    }

    /**
     * Metrics for one model version over a trailing window (live samples only).
     * @return array{samples:int, accuracy:?float, brier:?float, ece:?float, winRate:?float, roi:?float, maxDrawdown:?float, settledTickets:int, byMarket:array, byLeague:array}
     */
    public function metricsFor(int $modelVersionId, int $windowDays, ?int $now = null): array
    {
        $now ??= time();
        $since = gmdate('Y-m-d H:i:s', $now - $windowDays * 86400);
        $outcomes = array_values(array_filter($this->repo->predictionOutcomes($modelVersionId), fn($o) => ($o['created_at'] ?? '') >= $since));
        $selections = array_values(array_filter($this->repo->settledSelections(['from' => $since, 'modelVersionId' => $modelVersionId]), fn($s) => !empty($s['_settled'])));

        $metrics = ['samples' => count($outcomes), 'settledTickets' => count(array_unique(array_map(fn($s) => $s['ticket_id'], $selections)))];
        if ($outcomes) {
            $correct = 0;
            foreach ($outcomes as $o) {
                $p = (float) ($o['calibrated_probability'] ?? $o['raw_probability'] ?? 0.5);
                if ((int) round($p * 1000) >= 500 ? (int) $o['outcome'] === 1 : (int) $o['outcome'] === 0) $correct++;
            }
            $metrics['accuracy'] = round($correct / count($outcomes), 5);
            $cal = CalibrationEngine::evaluate($outcomes, fn($o) => (float) ($o['calibrated_probability'] ?? $o['raw_probability'] ?? 0.5));
            $metrics['brier'] = $cal['brier'];
            $metrics['ece'] = $cal['ece'];
        }
        if ($selections) {
            $stakeSum = 0.0; $pnlSum = 0.0;
            $hasStake = false;
            $cum = 0.0; $peak = 0.0; $maxDd = 0.0;
            $byMarket = []; $byLeague = [];
            foreach ($selections as $s) {
                $stake = $s['ticket_stake'] !== null ? (float) $s['ticket_stake'] / max(1, (int) ($this->selectionCount($s['ticket_id']))) : null;
                $ticket = $this->repo->findTicket($s['ticket_id']);
                $pnl = ($ticket['pnl'] ?? null) !== null ? (float) $ticket['pnl'] : null;
                $selStake = $stake !== null && (int) $this->selectionCount($s['ticket_id']) > 0 ? $stake : null;
                // per-selection share of ticket stake/pnl for market/league breakdowns
                $n = max(1, (int) $this->selectionCount($s['ticket_id']));
                if ($pnl !== null && $selStake !== null) {
                    $pnlSel = $pnl / $n; $stakeSel = $selStake;
                    $hasStake = true;
                    $pnlSum += $pnlSel; $stakeSum += $stakeSel;
                    $cum += $pnlSel;
                    $peak = max($peak, $cum);
                    $maxDd = max($maxDd, $peak - $cum);
                }
                $mk = $s['market'] ?? 'UNKNOWN';
                $lg = $s['competition'] ?? 'UNKNOWN';
                foreach ([['byMarket', $mk], ['byLeague', $lg]] as [$key, $label]) {
                    if (!isset($metrics[$key][$label])) $metrics[$key][$label] = ['n' => 0, 'won' => 0];
                    $metrics[$key][$label]['n']++;
                    if (($s['status'] ?? '') === 'WON') $metrics[$key][$label]['won']++;
                }
            }
            foreach (['byMarket', 'byLeague'] as $key) {
                foreach ($metrics[$key] ?? [] as $label => $b) $metrics[$key][$label]['winRate'] = round($b['won'] / $b['n'], 4);
            }
            $decisive = count(array_filter($selections, fn($s) => in_array($s['status'] ?? '', ['WON', 'LOST'], true)));
            $won = count(array_filter($selections, fn($s) => ($s['status'] ?? '') === 'WON'));
            $metrics['winRate'] = $decisive ? round($won / $decisive, 5) : null;
            $metrics['roi'] = ($hasStake && $stakeSum > 0) ? round($pnlSum / $stakeSum, 5) : null;
            $metrics['maxDrawdown'] = $hasStake ? round($maxDd, 4) : null;
        }
        $this->saveSnapshot($modelVersionId, $windowDays, $metrics);
        return $metrics;
    }

    /** Side-by-side comparison across all model versions (measured only). */
    public function compare(int $windowDays = 90): array
    {
        $out = [];
        foreach ($this->listModels() as $m) {
            $metrics = $this->metricsFor($m['id'], $windowDays);
            $out[] = array_merge($m, ['metrics' => $metrics]);
        }
        return $out;
    }

    private function selectionCount(string $ticketId): int
    {
        return count($this->repo->ticketSelections($ticketId));
    }

    private function saveSnapshot(int $modelVersionId, int $windowDays, array $metrics): void
    {
        try {
            $this->repo->saveModelMetrics([
                'model_version_id' => $modelVersionId, 'window_days' => $windowDays, 'sample_type' => 'live',
                'predictions' => (int) $metrics['samples'], 'settled' => (int) $metrics['settledTickets'],
                'accuracy' => $metrics['accuracy'] ?? null, 'brier' => $metrics['brier'] ?? null, 'ece' => $metrics['ece'] ?? null,
                'win_rate' => $metrics['winRate'] ?? null, 'roi' => $metrics['roi'] ?? null, 'max_drawdown' => $metrics['maxDrawdown'] ?? null,
                'computed_at' => gmdate('c'),
            ]);
        } catch (\Throwable $e) { /* snapshotting must never break reads */ }
    }
}
