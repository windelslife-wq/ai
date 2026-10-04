<?php
namespace Aegis\Sports;

/**
 * Transparent candidate confidence (spec §10). Never a fake single percentage
 * of the other metrics — it is a documented, reproducible blend:
 *
 *   confidence = 0.50 * dataQualityScore
 *              + 0.30 * calibrationQuality          (100 * (1 - ECE of the
 *                                                      approved calibration),
 *                                                      0 when uncalibrated)
 *              + 0.20 * probabilitySeparation       (min(100, 400*|p-0.5|))
 *
 * Capped at 95: the system never claims certainty.
 */
class ConfidenceEngine
{
    public const CAP = 95.0;

    public function assess(array $prediction, array $quality, ?array $calibration): array
    {
        if (($prediction['decision'] ?? '') !== 'PREDICTION_READY') {
            return ['confidence' => null, 'breakdown' => null, 'reason' => 'NO_PREDICTION'];
        }
        $dq = (float) ($quality['score'] ?? 0);
        $cal = 0.0;
        if ($calibration !== null && isset($calibration['ece']) && is_numeric($calibration['ece']) && (float) $calibration['samples'] >= 20) {
            $cal = 100 * max(0.0, min(1.0, 1 - (float) $calibration['ece']));
        }
        $p = (float) ($prediction['calibratedProbability'] ?? 0.5);
        $sep = min(100.0, 400.0 * abs($p - 0.5));
        $confidence = min(self::CAP, 0.5 * $dq + 0.3 * $cal + 0.2 * $sep);
        return [
            'confidence' => round($confidence, 2),
            'breakdown' => ['dataQuality' => round($dq, 2), 'calibrationQuality' => round($cal, 2), 'probabilitySeparation' => round($sep, 2)],
        ];
    }
}
