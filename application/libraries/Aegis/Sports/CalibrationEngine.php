<?php
namespace Aegis\Sports;

/**
 * Probability calibration layer (spec §11).
 *
 * Platt-style affine rescaling P = 1/(1 + exp(-(intercept + slope * raw)))
 * fitted by deterministic grid search on stored settled predictions (never on
 * invented outcomes). A calibration is only USABLE after an administrator
 * approves it (status APPROVED) — until then ticket-grade decisions report
 * MODEL_NOT_CALIBRATED rather than pretending accuracy.
 *
 * Reliability tracking: ECE (expected calibration error, 10 bins) and Brier
 * score measured on the same settled sample, so "claimed 80%" can be checked
 * against what actually happened at 80%.
 */
class CalibrationEngine
{
    public const MIN_SAMPLES = 20;
    public const MIN_CLASS_MINIMUM = 3;

    /** @return array{ok:bool, reason?:string, fit?:array, metrics?:array, bins?:array} */
    public static function fit(array $outcomes): array
    {
        $rows = array_values(array_filter($outcomes, fn($o) => isset($o['raw_probability'], $o['outcome']) && is_numeric($o['raw_probability']) && in_array($o['outcome'], [0, 1], true)));
        $n = count($rows);
        if ($n < self::MIN_SAMPLES) return ['ok' => false, 'reason' => 'INSUFFICIENT_SETTLED_SAMPLE', 'samples' => $n];
        $ones = count(array_filter($rows, fn($o) => (int) $o['outcome'] === 1));
        if ($ones < self::MIN_CLASS_MINIMUM || ($n - $ones) < self::MIN_CLASS_MINIMUM) return ['ok' => false, 'reason' => 'INSUFFICIENT_CLASS_COVERAGE', 'samples' => $n];

        $best = null;
        // Slope is capped at 3.0: beyond that the grid overfits small settled
        // samples (calibrated ECE worsens instead of improving).
        for ($slope = 0.5; $slope <= 3.01; $slope += 0.25) {
            for ($intercept = -8.0; $intercept <= 8.01; $intercept += 0.5) {
                $ll = 0.0;
                foreach ($rows as $o) {
                    $x = (float) $o['raw_probability'];
                    $z = $intercept + $slope * $x;
                    $pz = 1 / (1 + exp(-$z));
                    $pz = min(0.999999, max(0.000001, $pz));
                    $ll += ((int) $o['outcome'] === 1) ? log($pz) : log(1 - $pz);
                }
                if ($best === null || $ll > $best['logloss']) $best = ['logloss' => $ll, 'intercept' => round($intercept, 6), 'slope' => round($slope, 6)];
            }
        }
        // Guard against a degenerate fit that pushes everything to one class.
        $predOnes = 0;
        foreach ($rows as $o) {
            $p = self::apply($best['intercept'], $best['slope'], (float) $o['raw_probability']);
            if ($p >= 0.5) $predOnes++;
        }
        if ($predOnes === 0 || $predOnes === $n) {
            $best = ['logloss' => $best['logloss'], 'intercept' => 0.0, 'slope' => 1.0]; // fall back to identity
        }
        $metrics = self::evaluate($rows, fn($o) => self::apply($best['intercept'], $best['slope'], (float) $o['raw_probability']));
        $metrics['identityBrier'] = self::evaluate($rows, fn($o) => (float) $o['raw_probability'])['brier'];
        return [
            'ok' => true,
            'fit' => ['method' => 'platt', 'intercept' => $best['intercept'], 'slope' => $best['slope'], 'samples' => $n, 'positives' => $ones],
            'metrics' => $metrics,
            'bins' => $metrics['bins'],
        ];
    }

    public static function apply(float $intercept, float $slope, float $raw): float
    {
        $z = $intercept + $slope * $raw;
        $p = 1 / (1 + exp(-$z));
        return min(0.99, max(0.01, $p));
    }

    /** Brier + 10-bin ECE + reliability bins for a probability function. */
    public static function evaluate(array $rows, callable $probOf): array
    {
        $brier = 0.0;
        $bins = [];
        foreach ($rows as $i => $o) {
            $p = min(0.999, max(0.001, (float) $probOf($o)));
            $brier += (int) (($p - (float) $o['outcome']) ** 2);
            $idx = min(9, (int) floor($p * 10));
            if (!isset($bins[$idx])) $bins[$idx] = ['n' => 0, 'sumP' => 0.0, 'hits' => 0];
            $bins[$idx]['n']++;
            $bins[$idx]['sumP'] += $p;
            $bins[$idx]['hits'] += (int) $o['outcome'];
        }
        $ece = 0.0;
        $outBins = [];
        foreach (range(0, 9) as $idx) {
            $b = $bins[$idx] ?? null;
            if ($b === null) continue;
            $meanP = $b['sumP'] / $b['n'];
            $freq = $b['hits'] / $b['n'];
            $ece += ($b['n'] / max(1, count($rows))) * abs($meanP - $freq);
            $outBins[] = ['bin' => $idx, 'label' => sprintf('%d-%d', $idx * 10, $idx * 10 + 9), 'n' => $b['n'], 'meanCalibrated' => round($meanP, 4), 'observedFrequency' => round($freq, 4), 'gap' => round($meanP - $freq, 4)];
        }
        return ['brier' => round($brier / max(1, count($rows)), 6), 'ece' => round($ece, 6), 'bins' => $outBins];
    }

    /** Version string is deterministic in the fitted sample → reproducible. */
    public static function version(array $fit): string
    {
        return sprintf('cal-platt-i%s-s%s-n%d', (string) $fit['intercept'], (string) $fit['slope'], (int) $fit['samples']);
    }
}
