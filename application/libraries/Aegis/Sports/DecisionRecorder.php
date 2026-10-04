<?php
namespace Aegis\Sports;

use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\SportsRepository;

/**
 * Writes immutable decision records (spec §28/§29) for EVERY evaluated
 * candidate — qualified or rejected — so six months later an administrator
 * can reconstruct exactly why WINDELS decided what it did: odds at decision
 * time with timestamp, input/feature/model/calibration versions, raw and
 * calibrated probabilities, confidence, EV, risk, correlation, data quality,
 * decision factors, and (later) the final result.
 */
class DecisionRecorder
{
    public function __construct(private SportsRepository $repo, private AuditRepository $audit) {}

    /**
     * @param int    $matchId
     * @param array  $prediction  PredictionEngine output (or NO_PREDICTION)
     * @param array  $value       ValueEngine output
     * @param array  $risk        RiskEngine output
     * @param array  $quality     DataQualityEngine assessment
     * @param array  $factors     decision factors (drivers, calibration, gate…)
     * @param float|null $confidence
     * @param float|null $odds      decimal odds at decision time
     * @param string|null $oddsTimestamp
     * @param string|null $correlation class at decision time
     */
    public function recordPrediction(int $matchId, array $prediction, array $value, array $risk, array $quality, array $factors, ?float $confidence = null, ?float $odds = null, ?string $oddsTimestamp = null, ?string $correlation = null): string
    {
        $modelId = $this->repo->ensureModelVersion([
            'modelName' => $prediction['modelName'] ?? PredictionEngine::MODEL_NAME,
            'modelVersion' => $prediction['modelVersion'] ?? PredictionEngine::MODEL_VERSION,
            'featureVersion' => $prediction['featureVersion'] ?? FeatureEngineeringEngine::VERSION,
            'calibrationVersion' => $prediction['calibrationVersion'] ?? null,
        ]);
        $id = 'prd_' . bin2hex(random_bytes(12));
        $rejectionReasons = $risk['reasons'] ?? ($prediction['reason'] ?? null);
        $this->repo->savePrediction([
            'id' => $id, 'match_id' => $matchId, 'model_version_id' => $modelId,
            'market' => $prediction['market'] ?? ($factors['market'] ?? 'UNSPECIFIED'),
            'selection' => $prediction['selection'] ?? ($factors['selection'] ?? 'UNSPECIFIED'),
            'raw_probability' => $prediction['rawModelProbability'] ?? null,
            'calibrated_probability' => $prediction['calibratedProbability'] ?? null,
            'implied_probability' => $value['impliedProbability'] ?? null,
            'expected_value' => $value['expectedValue'] ?? null,
            'confidence' => $confidence,
            'risk' => $risk['classification'] ?? 'REJECTED',
            'correlation' => $correlation ?? ($factors['correlation'] ?? 'UNKNOWN'),
            'data_quality_score' => $quality['score'] ?? 0,
            'decision' => $prediction['decision'] ?? 'NO_PREDICTION',
            'rejection_reasons' => json_encode(is_array($rejectionReasons) ? array_values($rejectionReasons) : [$rejectionReasons]),
            'factors' => json_encode($factors),
            'input_version' => $prediction['featureVersion'] ?? 'unknown',
            'odds' => $odds,
            'odds_timestamp' => $oddsTimestamp,
            'created_at' => gmdate('c'),
        ]);
        $this->audit->emit('SPORTS_DECISION_RECORDED', 'Sports prediction decision recorded', [
            'predictionId' => $id, 'matchId' => $matchId, 'decision' => $prediction['decision'] ?? 'NO_PREDICTION',
            'rejectionReasons' => is_array($rejectionReasons) ? array_values($rejectionReasons) : [$rejectionReasons],
        ]);
        return $id;
    }
}
