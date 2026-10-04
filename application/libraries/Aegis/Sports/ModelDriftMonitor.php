<?php
namespace Aegis\Sports;

use Aegis\Notifications\Notifier;
use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\SportsRepository;

/**
 * Model drift monitoring (spec §27).
 *
 * Compares a trailing RECENT window against the preceding BASELINE window for
 * each model version with enough settled samples and raises
 * MODEL PERFORMANCE WARNING alerts (operator notification + audit) when the
 * configured deterioration thresholds are exceeded. Administrator review is
 * required — the monitor alerts, it never rewrites a model.
 */
class ModelDriftMonitor
{
    public const RECENT_DAYS = 14;
    public const BASELINE_DAYS = 28;
    public const MIN_RECENT_SAMPLES = 20;
    public const ACCURACY_DROP_THRESHOLD = 0.08;   // 8 percentage points
    public const BRIER_RISE_THRESHOLD = 0.03;
    public const ECE_THRESHOLD = 0.08;

    public function __construct(private SportsRepository $repo, private AuditRepository $audit, private ?Notifier $notifications = null) {}

    /** @return array{models: array<int,array>, warnings: int} */
    public function monitor(?int $now = null): array
    {
        $now ??= time();
        $reports = [];
        $warnings = 0;
        foreach ($this->repo->listModelVersions() as $model) {
            $id = (int) $model['id'];
            $recent = $this->windowMetrics($id, self::RECENT_DAYS, $now, 0);
            if ($recent['samples'] < self::MIN_RECENT_SAMPLES) {
                $reports[] = ['model' => $model, 'status' => 'INSUFFICIENT_RECENT_DATA', 'recent' => $recent, 'baseline' => null, 'reasons' => []];
                continue;
            }
            $baseline = $this->windowMetrics($id, self::BASELINE_DAYS, $now, self::RECENT_DAYS);
            $reasons = [];
            if ($baseline['accuracy'] !== null && $recent['accuracy'] !== null && ($baseline['accuracy'] - $recent['accuracy']) >= self::ACCURACY_DROP_THRESHOLD) {
                $reasons[] = sprintf('accuracy dropped %.1fpp (%.1f%% → %.1f%%)', ($baseline['accuracy'] - $recent['accuracy']) * 100, $baseline['accuracy'] * 100, $recent['accuracy'] * 100);
            }
            if ($baseline['brier'] !== null && $recent['brier'] !== null && ($recent['brier'] - $baseline['brier']) >= self::BRIER_RISE_THRESHOLD) {
                $reasons[] = sprintf('Brier error rose %.4f (%.4f → %.4f)', $recent['brier'] - $baseline['brier'], $baseline['brier'], $recent['brier']);
            }
            if ($recent['ece'] !== null && $recent['ece'] >= self::ECE_THRESHOLD) {
                $reasons[] = sprintf('calibration degraded (ECE %.3f ≥ %.2f)', $recent['ece'], self::ECE_THRESHOLD);
            }
            $warning = count($reasons) > 0;
            $reports[] = ['model' => $model, 'status' => $warning ? 'DRIFT_WARNING' : 'STABLE', 'recent' => $recent, 'baseline' => $baseline, 'reasons' => $reasons];
            if ($warning) {
                $warnings++;
                $label = $model['model_name'] . ' v' . $model['model_version'];
                $this->audit->emit('SPORTS_MODEL_DRIFT_WARNING', "MODEL PERFORMANCE WARNING: {$label} deteriorated over the last " . self::RECENT_DAYS . ' days', ['modelId' => $id, 'reasons' => $reasons, 'recent' => $recent, 'baseline' => $baseline]);
                $this->repo->saveModelMetrics([
                    'model_version_id' => $id, 'window_days' => self::RECENT_DAYS, 'sample_type' => 'drift',
                    'predictions' => (int) $recent['samples'], 'settled' => (int) $recent['samples'],
                    'accuracy' => $recent['accuracy'], 'brier' => $recent['brier'], 'ece' => $recent['ece'],
                    'win_rate' => null, 'roi' => null, 'max_drawdown' => null, 'computed_at' => gmdate('c'),
                ]);
                if ($this->notifications !== null) {
                    $this->notifications->notify('SPORTS_MODEL_DRIFT', 'warning', "MODEL PERFORMANCE WARNING: {$label}", [
                        'modelId' => $id, 'reasons' => $reasons, 'recent' => $recent, 'baseline' => $baseline,
                        'note' => 'Administrator review required — the monitor never rewrites models.',
                    ], 'sports-drift:' . $id . ':' . gmdate('Y-m-d'));
                }
            }
        }
        $this->audit->emit('SPORTS_MODEL_DRIFT_MONITOR_RUN', 'Model drift monitor run: ' . $warnings . ' warning(s)', ['models' => count($reports), 'warnings' => $warnings]);
        return ['models' => $reports, 'warnings' => $warnings];
    }

    private function windowMetrics(int $modelVersionId, int $days, int $now, int $offsetDays): array
    {
        $end = $now - $offsetDays * 86400;
        $sinceTs = $end - $days * 86400;
        $since = gmdate('Y-m-d H:i:s', $sinceTs);
        $until = gmdate('Y-m-d H:i:s', $end);
        $outcomes = array_values(array_filter($this->repo->predictionOutcomes($modelVersionId), fn($o) => ($o['created_at'] ?? '') >= $since && ($o['created_at'] ?? '') <= $until));
        if (!$outcomes) return ['samples' => 0, 'accuracy' => null, 'brier' => null, 'ece' => null];
        $correct = 0;
        foreach ($outcomes as $o) {
            $p = (float) ($o['calibrated_probability'] ?? $o['raw_probability'] ?? 0.5);
            if (($p >= 0.5 ? 1 : 0) === (int) $o['outcome']) $correct++;
        }
        $cal = CalibrationEngine::evaluate($outcomes, fn($o) => (float) ($o['calibrated_probability'] ?? $o['raw_probability'] ?? 0.5));
        return ['samples' => count($outcomes), 'accuracy' => round($correct / count($outcomes), 5), 'brier' => $cal['brier'], 'ece' => $cal['ece']];
    }
}
