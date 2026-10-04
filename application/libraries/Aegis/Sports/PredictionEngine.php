<?php
namespace Aegis\Sports;

/** Versioned deterministic baseline; not an AI claim and never predicts without calibration approval. */
class PredictionEngine
{
    public const MODEL_NAME = 'WINDELS Sports Baseline';
    public const MODEL_VERSION = '1.0.0';
    public function predictOver15(array $featureSet, array $calibration): array
    {
        if (empty($featureSet['ok'])) return $this->reject($featureSet['reason'] ?? 'INSUFFICIENT_DATA', $featureSet);
        if (empty($calibration['approved']) || !isset($calibration['intercept'], $calibration['slope'])) return $this->reject('MODEL_NOT_CALIBRATED', $featureSet);
        $xg = $featureSet['features']['expectedGoalsProxy'];
        // Logistic baseline from a verified feature; model details/version are stored with output.
        $raw = 1 / (1 + exp(-($xg - 1.5)));
        $calibrated = min(0.99, max(0.01, (float)$calibration['intercept'] + (float)$calibration['slope'] * $raw));
        return ['decision' => 'PREDICTION_READY', 'market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'rawModelProbability' => round($raw, 6), 'calibratedProbability' => round($calibrated, 6), 'modelName' => self::MODEL_NAME, 'modelVersion' => self::MODEL_VERSION, 'featureVersion' => $featureSet['version'], 'calibrationVersion' => (string)($calibration['version'] ?? 'unspecified'), 'inputSources' => $featureSet['inputSources']];
    }
    private function reject(string $reason, array $featureSet): array { return ['decision' => 'NO_PREDICTION', 'reason' => $reason, 'modelName' => self::MODEL_NAME, 'modelVersion' => self::MODEL_VERSION, 'featureVersion' => $featureSet['version'] ?? FeatureEngineeringEngine::VERSION]; }
}
