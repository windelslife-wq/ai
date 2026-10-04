<?php
namespace Aegis\Sports;

/**
 * Per-match intelligence pipeline (spec §8–§15):
 *
 *   match + odds → match intelligence → data quality → features → prediction
 *   → calibration → value → confidence → risk → gate (do-not-predict)
 *
 * Every stage's actual inputs are captured in `factors` so the final decision
 * can be reconstructed later (spec §28/§29). Rejected candidates keep their
 * explicit rejection reasons — the engine never forces a prediction.
 */
class PredictionPipeline
{
    private MatchIntelligenceEngine $intelligence;
    private FeatureEngineeringEngine $features;
    private PredictionEngine $prediction;
    private ValueEngine $value;
    private RiskEngine $risk;
    private CorrelationEngine $correlation;
    private ConfidenceEngine $confidence;

    public function __construct(
        ?MatchIntelligenceEngine $intelligence = null,
        ?FeatureEngineeringEngine $features = null,
        ?PredictionEngine $prediction = null,
        ?ValueEngine $value = null,
        ?RiskEngine $risk = null,
        ?CorrelationEngine $correlation = null,
        ?ConfidenceEngine $confidence = null
    ) {
        $this->intelligence = $intelligence ?? new MatchIntelligenceEngine();
        $this->features = $features ?? new FeatureEngineeringEngine();
        $this->prediction = $prediction ?? new PredictionEngine();
        $this->value = $value ?? new ValueEngine();
        $this->risk = $risk ?? new RiskEngine();
        $this->correlation = $correlation ?? new CorrelationEngine();
        $this->confidence = $confidence ?? new ConfidenceEngine();
    }

    /**
     * @param array  $match    repository match row (payload holds provider context)
     * @param array  $odds     latest odds row or null
     * @param array  $quality  DataQualityEngine assessment
     * @param array  $calibration approved calibration row (with intercept/slope) or null
     * @param array  $config   active configuration
     * @param int|null $now
     */
    public function evaluate(array $match, ?array $odds, array $quality, ?array $calibration, array $config = [], ?int $now = null): array
    {
        $intel = $this->intelligence->analyze($match, $odds, [], $now);
        $factors = [
            'drivers' => [],
            'odds' => $odds ? ['decimal' => (float) ($odds['decimalOdds'] ?? $odds['decimal_odds'] ?? 0), 'observedAt' => $odds['observedAt'] ?? $odds['observed_at'] ?? null, 'ageSeconds' => $intel['oddsFreshness']['ageSeconds'] ?? null] : null,
            'calibration' => null,
            'quality' => ['score' => $quality['score'] ?? 0, 'band' => $quality['band'] ?? 'UNKNOWN', 'missing' => $quality['missing'] ?? []],
            'inputsUnavailable' => $intel['unavailableInputs'] ?? [],
            'simulated' => !empty($intel['match']['simulated']),
            'gate' => ['passed' => [], 'failed' => []],
        ];

        $candidate = [
            'matchId' => $match['id'] ?? null,
            'match' => $intel['match'],
            'market' => 'TOTAL_GOALS',
            'selection' => 'OVER_1_5',
            'odds' => $odds ? (float) ($odds['decimalOdds'] ?? $odds['decimal_odds'] ?? 0) : null,
            'oddsTimestamp' => $odds ? ($odds['observedAt'] ?? $odds['observed_at'] ?? null) : null,
            'intelligence' => $intel,
            'quality' => $quality,
        ];

        if (($intel['decision'] ?? '') !== 'INTELLIGENCE_READY') {
            return $this->finalize($candidate, $factors, null, null, null, null, 'REJECTED', $intel['rejectionReasons'] ?? ['INSUFFICIENT_DATA'], 'NO_PREDICTION', $quality);
        }

        // Features (versioned)
        $fs = $this->features->build($intel);
        if (!empty($fs['features'])) $factors['drivers'] = $fs['features'];
        $factors['featureVersion'] = $fs['version'] ?? null;

        // Prediction (raw + calibrated, versioned)
        $calibrationInput = ($calibration !== null)
            ? ['approved' => true, 'intercept' => (float) $calibration['intercept'], 'slope' => (float) $calibration['slope'], 'version' => $calibration['calibrationVersion'] ?? $calibration['version'] ?? null, 'ece' => $calibration['ece'] ?? null, 'samples' => $calibration['samples'] ?? 0, 'approvedAt' => $calibration['approved_at'] ?? null]
            : null;
        if ($calibrationInput !== null) {
            $factors['calibration'] = ['version' => $calibrationInput['version'], 'intercept' => $calibrationInput['intercept'], 'slope' => $calibrationInput['slope'], 'ece' => $calibrationInput['ece'], 'samples' => $calibrationInput['samples'], 'approvedAt' => $calibrationInput['approvedAt']];
        }
        $prediction = $this->prediction->predictOver15($fs, $calibrationInput ?? []);
        if (!empty($prediction['market'])) { $candidate['market'] = $prediction['market']; $candidate['selection'] = $prediction['selection']; }

        // Value
        $value = $this->value->assess($prediction, $odds !== null ? ['decimalOdds' => (float) ($odds['decimalOdds'] ?? $odds['decimal_odds'] ?? 0)] : ['decimalOdds' => 0]);

        // Confidence
        $conf = $this->confidence->assess($prediction, $quality, $calibrationInput);
        $factors['confidence'] = $conf['breakdown'] ?? null;

        // Risk (with market context)
        $riskContext = [
            'confidence' => $conf['confidence'],
            'liquidity' => $intel['inputs']['marketLiquidity'] ?? null,
            'marketSuspended' => !empty($odds['suspended']) || ($match['status'] ?? '') === 'SUSPENDED',
            'oddsMovement' => $this->oddsMovement($odds),
        ];
        $risk = $this->risk->assess($value, $quality, $config, $riskContext);

        $candidate = array_merge($candidate, ['features' => $fs, 'prediction' => $prediction, 'value' => $value, 'confidence' => $conf, 'risk' => $risk, 'correlation' => ['classification' => 'LOW', 'reasons' => []]]);

        // Gate: do-not-predict engine (spec §15)
        $failed = [];
        if (($prediction['decision'] ?? '') !== 'PREDICTION_READY') $failed[] = $prediction['reason'] ?? 'NO_PREDICTION';
        if (($config['require_calibration'] ?? 1) && $calibrationInput === null) $failed[] = 'MODEL_NOT_CALIBRATED';
        if ($risk['classification'] === 'REJECTED') $failed = array_merge($failed, $risk['reasons'] ?? ['HIGH_RISK']);
        elseif ($risk['classification'] === 'HIGH') $failed[] = 'HIGH_RISK';
        if (!empty($value['reason']) && ($prediction['decision'] ?? '') === 'PREDICTION_READY' && !empty($value['qualified']) === false) $failed[] = $value['reason'];
        if (($conf['confidence'] ?? 0) !== null && (float) $conf['confidence'] < (float) ($config['min_confidence'] ?? 0)) $failed[] = 'LOW_CONFIDENCE';
        $allowedMarkets = $config['allowed_markets'] ?? [];
        if (is_array($allowedMarkets) && count($allowedMarkets) > 0 && !in_array($candidate['market'], $allowedMarkets, true)) $failed[] = 'OUTSIDE_CONFIGURATION';
        $allowedLeagues = $config['allowed_leagues'] ?? [];
        if (is_array($allowedLeagues) && count($allowedLeagues) > 0 && !in_array($candidate['match']['competition'] ?? null, $allowedLeagues, true)) $failed[] = 'OUTSIDE_CONFIGURATION';
        $failed = array_values(array_unique($failed));
        $factors['gate']['failed'] = $failed;
        $factors['gate']['passed'] = $failed ? [] : ['INTELLIGENCE_READY', 'PREDICTION_READY', 'POSITIVE_VALUE', 'RISK_APPROVED', 'CONFIDENCE_OK', 'WITHIN_CONFIGURATION'];

        $decision = $failed ? 'REJECTED' : 'QUALIFIED';
        $predictionDecision = $failed ? 'NO_PREDICTION' : 'PREDICTION_READY';
        return $this->finalize($candidate, $factors, $value, $conf, $risk, $prediction, $decision, $failed, $predictionDecision, $quality);
    }

    private function finalize(array $candidate, array $factors, ?array $value, ?array $conf, ?array $risk, ?array $prediction, string $decision, array $rejectionReasons, string $predictionDecision, array $quality): array
    {
        $candidate['value'] = $value ?? ['qualified' => false, 'reason' => $rejectionReasons[0] ?? 'NO_PREDICTION'];
        $candidate['confidence'] = $conf ?? ['confidence' => null, 'breakdown' => null];
        $candidate['risk'] = $risk ?? ['classification' => 'REJECTED', 'approved' => false, 'reasons' => $rejectionReasons];
        $candidate['prediction'] = $prediction ?? ['decision' => $predictionDecision, 'reason' => $rejectionReasons[0] ?? 'NO_PREDICTION', 'modelName' => PredictionEngine::MODEL_NAME, 'modelVersion' => PredictionEngine::MODEL_VERSION, 'featureVersion' => $factors['featureVersion'] ?? FeatureEngineeringEngine::VERSION];
        $candidate['decision'] = $decision;
        $candidate['rejectionReasons'] = array_values(array_unique($rejectionReasons));
        $candidate['factors'] = $factors;
        return $candidate;
    }

    private function oddsMovement(?array $odds): ?float
    {
        if ($odds === null) return null;
        $payload = is_array($odds['payload'] ?? null) ? $odds['payload'] : [];
        $opening = $payload['openingDecimalOdds'] ?? $odds['openingDecimalOdds'] ?? null;
        $current = (float) ($odds['decimalOdds'] ?? $odds['decimal_odds'] ?? 0);
        if (!is_numeric($opening) || (float) $opening <= 0) return null;
        return $current - (float) $opening;
    }
}
