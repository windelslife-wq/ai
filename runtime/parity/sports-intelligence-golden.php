<?php
/**
 * Slice 3 golden cases: the per-match decision chain, calibration, configuration
 * validation and PHP `round()`. Included by `sports-golden.php`, which has already
 * defined `outcome()`, `strip_clock()` and the `$sports` path, and which owns the
 * `require`s for these classes. This file returns the cases; it writes nothing.
 *
 * Every input here is a literal or a deterministic loop, and the input is stored
 * beside the result, so the Node side reads the input from the golden file rather
 * than re-deriving it. A dataset cannot drift between the two sides without the
 * golden file itself changing.
 *
 * Two legacy behaviours are captured as **evidence** rather than as expectations:
 *
 *  - CalibrationEngine::evaluate's Brier score is always 0.0 (F-36). The Node test
 *    asserts that the golden value IS zero, and then asserts that Node's value is the
 *    real one. A test that compared the two directly would fail for the right reason
 *    and tell nobody why.
 *  - PredictionEngine's calibrated probability is linear (F-37). The golden records
 *    what PHP computed, and the Node test asserts the logistic value that DV-12 chose.
 */

use Aegis\Sports\CalibrationEngine;
use Aegis\Sports\ConfidenceEngine;
use Aegis\Sports\ConfigurationService;
use Aegis\Sports\CorrelationEngine;
use Aegis\Sports\FeatureEngineeringEngine;
use Aegis\Sports\MatchIntelligenceEngine;
use Aegis\Sports\PredictionEngine;
use Aegis\Sports\PredictionPipeline;
use Aegis\Sports\RiskEngine;
use Aegis\Sports\ValueEngine;

require $sports . '/CalibrationEngine.php';
require $sports . '/MatchIntelligenceEngine.php';
require $sports . '/FeatureEngineeringEngine.php';
require $sports . '/PredictionEngine.php';
require $sports . '/ValueEngine.php';
require $sports . '/ConfidenceEngine.php';
require $sports . '/RiskEngine.php';
require $sports . '/CorrelationEngine.php';
require $sports . '/PredictionPipeline.php';
require $sports . '/ConfigurationService.php';

/**
 * The corrected-oracle for DV-12. It is the legacy PredictionEngine with exactly one
 * line changed: the calibrated probability is the logistic map that CalibrationEngine
 * fitted under, instead of the linear expression legacy uses (finding F-37). Every
 * other line is inherited, so a case recorded with this engine differs from legacy only
 * by that one formula, and the Node port is held to it exactly.
 */
final class LogisticPredictionEngine extends PredictionEngine
{
    public function predictOver15(array $featureSet, array $calibration): array
    {
        $out = parent::predictOver15($featureSet, $calibration);
        if (($out['decision'] ?? '') !== 'PREDICTION_READY') return $out;
        $raw = 1 / (1 + exp(-($featureSet['features']['expectedGoalsProxy'] - 1.5)));
        $out['calibratedProbability'] = round(CalibrationEngine::apply((float) $calibration['intercept'], (float) $calibration['slope'], $raw), 6);
        return $out;
    }
}

// Closure scope: this file's variables must not collide with the generator's.
return (function () use ($sports) {


$now = strtotime('2026-10-12T18:00:00Z');


// ── deterministic datasets ───────────────────────────────────────────────────
$dataset = function (int $n, int $shift = 0): array {
    $rows = [];
    for ($i = 0; $i < $n; $i++) {
        $k = ($i * 37 + $shift) % 60;
        $raw = round(0.2 + $k / 100, 4);
        $outcome = (($k / 100) + (($i * 13) % 7) / 20 > 0.6) ? 1 : 0;
        $rows[] = ['raw_probability' => $raw, 'outcome' => $outcome];
    }
    return $rows;
};

$calibrationCases = [
    'fewer than twenty settled rows is refused' => $dataset(5),
    'every outcome on one side is refused for class coverage' => array_map(fn($r) => ['raw_probability' => $r['raw_probability'], 'outcome' => 0], $dataset(25)),
    'a typical sample fits a sloped calibration' => $dataset(60),
    'a larger sample fits deterministically' => $dataset(200, 11),
    // Strong separation: the outcome is a threshold on the same variable, so the grid
    // finds a genuinely sloped fit rather than the flat one that triggers the identity
    // fallback. Without this case the normal fitted path would not be parity-tested.
    'a strongly separable sample fits a steep calibration' => array_map(
        fn($i) => ['raw_probability' => round(0.2 + (($i * 37) % 60) / 100, 4), 'outcome' => (($i * 37) % 60) >= 30 ? 1 : 0],
        range(0, 59),
    ),
    'rows with non-numeric or non-integer outcomes are filtered before counting' => array_merge($dataset(30), [
        ['raw_probability' => 0.7, 'outcome' => '1'],
        ['raw_probability' => null, 'outcome' => 1],
        ['raw_probability' => 'abc', 'outcome' => 0],
        ['raw_probability' => 0.4, 'outcome' => 2],
    ]),
    'a constant raw probability cannot separate classes, so the identity fallback applies' => array_map(
        fn($i) => ['raw_probability' => 0.5, 'outcome' => $i % 2],
        range(0, 29),
    ),
];

$calibration = [];
foreach ($calibrationCases as $name => $rows) {
    $fit = CalibrationEngine::fit($rows);
    $version = !empty($fit['ok']) ? CalibrationEngine::version($fit['fit']) : null;
    $calibration[$name] = [
        'rows' => $rows,
        'result' => outcome(fn() => CalibrationEngine::fit($rows)),
        'version' => $version,
    ];
}

$applyCases = [];
foreach ([[-8.0, 0.5, 0.0], [8.0, 3.0, 1.0], [0.0, 1.0, 0.5], [-1.5, 3.0, 0.9], [0.25, 0.75, 0.333333], [-0.5, 1.2, 0.6]] as $triple) {
    [$i, $s, $r] = $triple;
    $applyCases["$i,$s,$r"] = ['input' => $triple, 'result' => outcome(fn() => CalibrationEngine::apply($i, $s, $r))];
}

$evaluateRows = $dataset(40, 3);
$evaluateCase = [
    'rows' => $evaluateRows,
    'result' => outcome(fn() => CalibrationEngine::evaluate($evaluateRows, fn($o) => (float) $o['raw_probability'])),
];

// ── calibration round-trip: the defaults the rest of the chain uses ─────────
$defaultsCase = ConfigurationService::defaults();

// ── intelligence: match + odds + context + clock ─────────────────────────────
$baseMatch = [
    'id' => 7, 'home_team' => 'Alpha FC', 'away_team' => 'Bolt City', 'competition' => 'League One',
    'status' => 'scheduled', 'kickoff_at' => '2026-10-12T18:00:00+00:00',
    'payload' => [
        'simulated' => false,
        'context' => [
            'recentForm' => ['homeGoalsPerMatch' => 1.6, 'awayGoalsPerMatch' => 1.1, 'homeConcededPerMatch' => 1.0, 'awayConcededPerMatch' => 1.4, 'source' => 'feed'],
            'marketLiquidity' => 500,
        ],
    ],
];
$freshOdds = ['decimalOdds' => 1.9, 'observedAt' => '2026-10-12T17:55:00+00:00', 'payload' => ['openingDecimalOdds' => 1.85]];
$noForm = array_replace_recursive($baseMatch, ['payload' => ['context' => ['recentForm' => null]]]);

$intelligenceInputs = [
    'ready: fresh odds, complete form, liquid market' => [$baseMatch, $freshOdds, [], $now],
    'stale odds are rejected with STALE_ODDS' => [$baseMatch, array_merge($freshOdds, ['observedAt' => '2026-10-12T15:00:00+00:00']), [], $now],
    'no odds at all is ODDS_UNAVAILABLE' => [$baseMatch, null, [], $now],
    'an unparseable timestamp is ODDS_TIMESTAMP_INVALID' => [$baseMatch, array_merge($freshOdds, ['observedAt' => 'not-a-date']), [], $now],
    'an empty timestamp is never fresh' => [$baseMatch, array_merge($freshOdds, ['observedAt' => '']), [], $now],
    'a finished match is MATCH_STATUS_INVALID' => [array_merge($baseMatch, ['status' => 'FINISHED']), $freshOdds, [], $now],
    'a lower-case live status is accepted after upper-casing' => [array_merge($baseMatch, ['status' => 'live']), $freshOdds, [], $now],
    'missing recent form is INSUFFICIENT_DATA' => [$noForm, $freshOdds, [], $now],
    'liquidity below one is INSUFFICIENT_LIQUIDITY' => [array_replace_recursive($baseMatch, ['payload' => ['context' => ['marketLiquidity' => 0.5]]]), $freshOdds, [], $now],
    'verified context overrides the stored freshness window' => [$baseMatch, $freshOdds, ['maxOddsAgeSeconds' => 60], $now],
    'a simulated match is flagged' => [array_replace_recursive($baseMatch, ['payload' => ['simulated' => true]]), $freshOdds, [], $now],
    'camelCase match keys are read when snake_case is absent' => [['id' => 9, 'homeTeam' => 'X', 'awayTeam' => 'Y', 'competition' => 'Z', 'status' => 'SCHEDULED', 'kickoff' => '2026-10-12T19:00:00+00:00', 'payload' => ['context' => ['recentForm' => ['x' => 1]]]], $freshOdds, [], $now],
    'a missing status is UNKNOWN and rejected' => [array_diff_key($baseMatch, ['status' => 1]), $freshOdds, [], $now],
];

$intelligence = [];
foreach ($intelligenceInputs as $name => [$match, $odds, $verified, $clock]) {
    $intelligence[$name] = [
        'input' => ['match' => $match, 'odds' => $odds, 'verifiedContext' => $verified, 'now' => $clock],
        'result' => outcome(fn() => (new MatchIntelligenceEngine())->analyze($match, $odds, $verified, $clock), ['generatedAt']),
    ];
}

// ── features: built from the intelligence outputs above and from edge inputs ─
$featureInputs = [
    'complete numeric form builds version sports-features-v1' => (new MatchIntelligenceEngine())->analyze($baseMatch, $freshOdds, [], $now),
    'numeric strings are accepted as is_numeric' => (new MatchIntelligenceEngine())->analyze(array_replace_recursive($baseMatch, ['payload' => ['context' => ['recentForm' => ['homeGoalsPerMatch' => '1.5', 'awayGoalsPerMatch' => ' 2 ', 'homeConcededPerMatch' => '1e0', 'awayConcededPerMatch' => 0.5, 'source' => 'x']]]]), $freshOdds, [], $now),
    'a non-numeric form value is INSUFFICIENT_DATA' => (new MatchIntelligenceEngine())->analyze(array_replace_recursive($baseMatch, ['payload' => ['context' => ['recentForm' => ['homeGoalsPerMatch' => 'x', 'awayGoalsPerMatch' => 1, 'homeConcededPerMatch' => 1, 'awayConcededPerMatch' => 1]]]]), $freshOdds, [], $now),
    'a rejected intelligence never builds features' => (new MatchIntelligenceEngine())->analyze($baseMatch, null, [], $now),
];
$features = [];
foreach ($featureInputs as $name => $intel) {
    $features[$name] = ['input' => $intel, 'result' => outcome(fn() => (new FeatureEngineeringEngine())->build($intel))];
}

// ── prediction ───────────────────────────────────────────────────────────────
$okFeatures = (new FeatureEngineeringEngine())->build((new MatchIntelligenceEngine())->analyze($baseMatch, $freshOdds, [], $now));
$badFeatures = ['ok' => false, 'reason' => 'INSUFFICIENT_DATA', 'version' => FeatureEngineeringEngine::VERSION, 'features' => []];
$approved = ['approved' => true, 'intercept' => -0.5, 'slope' => 1.2, 'version' => 'cal-platt-i-0.5-s1.2-n120'];
$predictionInputs = [
    'an approved calibration produces a prediction' => [$okFeatures, $approved],
    'no calibration input is MODEL_NOT_CALIBRATED' => [$okFeatures, []],
    'an unapproved calibration is MODEL_NOT_CALIBRATED' => [$okFeatures, array_merge($approved, ['approved' => false])],
    'a missing calibration version is labelled unspecified' => [$okFeatures, ['approved' => true, 'intercept' => 0.0, 'slope' => 1.0]],
    'a rejected feature set carries its reason through' => [$badFeatures, $approved],
    'an identity calibration reproduces the raw probability before clamping' => [$okFeatures, ['approved' => true, 'intercept' => 0.0, 'slope' => 1.0, 'version' => 'id']],
    'a steep calibration is clamped to 0.99' => [$okFeatures, ['approved' => true, 'intercept' => 20.0, 'slope' => 3.0, 'version' => 'steep']],
];
$prediction = [];
foreach ($predictionInputs as $name => [$fs, $cal]) {
    $prediction[$name] = [
        'input' => ['featureSet' => $fs, 'calibration' => $cal],
        'result' => outcome(fn() => (new PredictionEngine())->predictOver15($fs, $cal)),
        'resultLogistic' => outcome(fn() => (new LogisticPredictionEngine())->predictOver15($fs, $cal)),
    ];
}

// ── value, confidence, risk: synthetic, so each is judged on its own ─────────
$readyPrediction = ['decision' => 'PREDICTION_READY', 'market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'calibratedProbability' => 0.6, 'reason' => null];
$valueInputs = [
    'a positive edge qualifies' => [$readyPrediction, ['decimalOdds' => 1.9]],
    'a negative edge is LOW_MODEL_EDGE' => [array_merge($readyPrediction, ['calibratedProbability' => 0.5]), ['decimalOdds' => 1.9]],
    'decimal odds of one or less are ODDS_UNAVAILABLE' => [$readyPrediction, ['decimalOdds' => 1.0]],
    'absent odds are ODDS_UNAVAILABLE' => [$readyPrediction, ['decimalOdds' => 0]],
    'a rejected prediction keeps its reason' => [['decision' => 'NO_PREDICTION', 'reason' => 'INSUFFICIENT_DATA'], ['decimalOdds' => 2.0]],
];
$value = [];
foreach ($valueInputs as $name => [$pred, $odds]) {
    $value[$name] = ['input' => ['prediction' => $pred, 'odds' => $odds], 'result' => outcome(fn() => (new ValueEngine())->assess($pred, $odds))];
}

$confidenceInputs = [
    'quality, calibration and separation combine' => [$readyPrediction, ['score' => 95], ['ece' => 0.05, 'samples' => 120]],
    'an uncalibrated prediction gets no calibration credit' => [$readyPrediction, ['score' => 80], null],
    'a calibration with too few samples gets no credit' => [$readyPrediction, ['score' => 80], ['ece' => 0.01, 'samples' => 19]],
    'confidence is capped at 95' => [array_merge($readyPrediction, ['calibratedProbability' => 0.99]), ['score' => 100], ['ece' => 0.0, 'samples' => 500]],
    'a null ECE gets no calibration credit' => [$readyPrediction, ['score' => 70], ['ece' => null, 'samples' => 50]],
    'a rejected prediction has no confidence' => [['decision' => 'NO_PREDICTION'], ['score' => 90], null],
];
$confidence = [];
foreach ($confidenceInputs as $name => [$pred, $quality, $cal]) {
    $confidence[$name] = ['input' => ['prediction' => $pred, 'quality' => $quality, 'calibration' => $cal], 'result' => outcome(fn() => (new ConfidenceEngine())->assess($pred, $quality, $cal))];
}

$goodValue = ['qualified' => true, 'reason' => null, 'expectedValue' => 0.13];
$riskInputs = [
    'a high score and strong edge is LOW risk' => [['qualified' => true, 'expectedValue' => 0.1], ['score' => 92, 'eligibleForTicket' => true], [], []],
    'a score of 85 is MEDIUM risk' => [$goodValue, ['score' => 85, 'eligibleForTicket' => true], [], []],
    'a score of 70 is HIGH risk and therefore not approved' => [$goodValue, ['score' => 70, 'eligibleForTicket' => true], ['min_data_quality' => 60], []],
    'a large odds movement upgrades MEDIUM to HIGH' => [$goodValue, ['score' => 85, 'eligibleForTicket' => true], [], ['oddsMovement' => 0.6]],
    'a small odds movement changes nothing' => [$goodValue, ['score' => 85, 'eligibleForTicket' => true], [], ['oddsMovement' => 0.4]],
    'a suspended market is rejected' => [$goodValue, ['score' => 95, 'eligibleForTicket' => true], [], ['marketSuspended' => true]],
    'a disqualified value carries its reason' => [['qualified' => false, 'reason' => 'LOW_MODEL_EDGE', 'expectedValue' => -0.1], ['score' => 95, 'eligibleForTicket' => true], [], []],
    'quality below the configured floor is rejected' => [$goodValue, ['score' => 70, 'eligibleForTicket' => true], ['min_data_quality' => 75], []],
    'an ineligible ticket is STALE_OR_INCOMPLETE_DATA' => [$goodValue, ['score' => 95, 'eligibleForTicket' => false], [], []],
    'confidence below the minimum is LOW_CONFIDENCE' => [$goodValue, ['score' => 95, 'eligibleForTicket' => true], ['min_confidence' => 80], ['confidence' => 70]],
    'liquidity below the minimum is rejected' => [$goodValue, ['score' => 95, 'eligibleForTicket' => true], ['min_liquidity' => 100], ['liquidity' => 50]],
    'camelCase configuration keys are read' => [$goodValue, ['score' => 70, 'eligibleForTicket' => true], ['minDataQuality' => 60, 'minExpectedValue' => 0.5], []],
];
$risk = [];
foreach ($riskInputs as $name => [$val, $quality, $config, $context]) {
    $risk[$name] = ['input' => ['value' => $val, 'quality' => $quality, 'config' => $config, 'context' => $context], 'result' => outcome(fn() => (new RiskEngine())->assess($val, $quality, $config, $context))];
}

// ── pipeline: the whole chain, with every stage recorded ─────────────────────
$pipelineBase = ['min_confidence' => 50, 'min_data_quality' => 75, 'min_expected_value' => 0.02];
$goodQuality = ['score' => 95, 'band' => 'EXCELLENT', 'missing' => [], 'eligibleForTicket' => true, 'eligibleForPrediction' => true, 'freshnessScore' => 100, 'providerReliabilityScore' => 100];
$pipelineInputs = [
    'a fully qualified decision' => [$baseMatch, $freshOdds, $goodQuality, $approved, $pipelineBase],
    'no calibration is rejected by the gate' => [$baseMatch, $freshOdds, $goodQuality, null, $pipelineBase],
    'stale odds short-circuit before any prediction' => [$baseMatch, array_merge($freshOdds, ['observedAt' => '2026-10-12T15:00:00+00:00']), $goodQuality, $approved, $pipelineBase],
    'a missing price is refused before prediction' => [$baseMatch, null, $goodQuality, $approved, $pipelineBase],
    'min_confidence above zero adds LOW_CONFIDENCE on the NO_PREDICTION path (quirk Q-2)' => [$baseMatch, null, $goodQuality, null, ['min_confidence' => 60]],
    'an allowed-market list that excludes the market is OUTSIDE_CONFIGURATION' => [$baseMatch, $freshOdds, $goodQuality, $approved, $pipelineBase + ['allowed_markets' => ['OVER_2_5']]],
    'an allowed-league list that excludes the competition is OUTSIDE_CONFIGURATION' => [$baseMatch, $freshOdds, $goodQuality, $approved, $pipelineBase + ['allowed_leagues' => ['Other League']]],
    'a suspended market is rejected' => [$baseMatch, array_merge($freshOdds, ['suspended' => true]), $goodQuality, $approved, $pipelineBase],
    'a large opening-to-current move is volatile, hence HIGH risk' => [$baseMatch, array_merge($freshOdds, ['payload' => ['openingDecimalOdds' => 1.0]]), $goodQuality, $approved, $pipelineBase],
    'a price with no edge is LOW_MODEL_EDGE' => [$baseMatch, array_merge($freshOdds, ['decimalOdds' => 1.2]), $goodQuality, $approved, $pipelineBase],
    'a rejected intelligence reports its reasons and no prediction' => [array_merge($baseMatch, ['status' => 'FINISHED']), $freshOdds, $goodQuality, $approved, $pipelineBase],
];
$pipeline = [];
foreach ($pipelineInputs as $name => [$match, $odds, $quality, $cal, $config]) {
    $pipeline[$name] = [
        'input' => ['match' => $match, 'odds' => $odds, 'quality' => $quality, 'calibration' => $cal, 'config' => $config, 'now' => $now],
        'result' => outcome(fn() => (new PredictionPipeline())->evaluate($match, $odds, $quality, $cal, $config, $now)),
        'resultLogistic' => outcome(fn() => (new PredictionPipeline(null, null, new LogisticPredictionEngine()))->evaluate($match, $odds, $quality, $cal, $config, $now)),
    ];
}

// ── configuration validation: the private validate(), via reflection ─────────
$configRef = new ReflectionClass(ConfigurationService::class);
$validator = $configRef->getMethod('validate');
$validator->setAccessible(true);
$validate = function (array $config, bool $allow = false) use ($configRef, $validator) {
    $instance = $configRef->newInstanceWithoutConstructor();
    return $validator->invoke($instance, $config, $allow);
};

$base = ConfigurationService::defaults();
$configInputs = [
    'the built-in defaults are valid' => [$base, false],
    'an unknown platform mode is refused' => [array_merge($base, ['platform_mode' => 'LIVE']), false],
    'an unknown engine mode is refused' => [array_merge($base, ['engine_mode' => 'SUPER']), false],
    'automated execution needs the override' => [array_merge($base, ['engine_mode' => 'AUTOMATED_EXECUTION']), false],
    'automated execution with the override passes validation' => [array_merge($base, ['engine_mode' => 'AUTOMATED_EXECUTION']), true],
    'an unknown risk level is refused' => [array_merge($base, ['risk_level' => 'RECKLESS']), false],
    'max correlation other than LOW or MEDIUM is refused' => [array_merge($base, ['max_correlation' => 'HIGH']), false],
    'an unknown void policy is refused' => [array_merge($base, ['void_policy' => 'REFUND']), false],
    'odds at or below 1.0 are refused' => [array_merge($base, ['target_odds_min' => 1.0]), false],
    'a maximum below the minimum is refused' => [array_merge($base, ['target_odds_max' => 4.0]), false],
    'max selections of zero is refused' => [array_merge($base, ['max_selections' => 0]), false],
    'max selections of thirteen is refused' => [array_merge($base, ['max_selections' => 13]), false],
    'min confidence of 49 is refused' => [array_merge($base, ['min_confidence' => 49.0]), false],
    'a negative expected value is refused' => [array_merge($base, ['min_expected_value' => -0.01]), false],
    'min data quality of 59 is refused' => [array_merge($base, ['min_data_quality' => 59]), false],
    'zero max exposure is refused' => [array_merge($base, ['max_exposure' => 0.0]), false],
    'a zero stake is refused' => [array_merge($base, ['stake_amount' => 0.0]), false],
    'a stake above max exposure is refused' => [array_merge($base, ['stake_amount' => 200.0]), false],
    'a negative minimum liquidity is refused' => [array_merge($base, ['min_liquidity' => -1.0]), false],
    'a null minimum liquidity is valid' => [array_merge($base, ['min_liquidity' => null]), false],
    'allowed markets must be a list of non-empty strings' => [array_merge($base, ['allowed_markets' => ['OVER_1_5', '  ']]), false],
    'allowed leagues must be an array' => [array_merge($base, ['allowed_leagues' => 'Premier']), false],
];
$configuration = [];
foreach ($configInputs as $name => [$config, $allow]) {
    $configuration[$name] = ['input' => ['config' => $config, 'allowAutomatedExecution' => $allow], 'result' => outcome(fn() => $validate($config, $allow))];
}

// ── PHP round(), which the Node port reproduces with pre-rounding ────────────
$roundInputs = [
    [1.005, 2], [2.5, 0], [-2.5, 0], [1.955, 2], [5.045, 2], [5.055, 2], [0.285, 2],
    [1.4999999999999, 0], [0.1 + 0.2, 2], [123456.785, 2], [0.000123456, 6], [99.995, 2],
    [0.5, 0], [1e20, 2], [74.5, 0], [0.745 * 100, 0], [1.23456789, 4], [-0.0000005, 6],
    [2.675, 2], [1.0049999999999999, 2], [0.0, 3], [-7.125, 2], [33.333333, 4],
];
$round = [];
foreach ($roundInputs as [$v, $p]) {
    $round["round($v, $p)"] = ['input' => [$v, $p], 'result' => round($v, $p)];
}

return [
    'phpRound' => $round,
    'calibration' => $calibration,
    'calibrationApply' => $applyCases,
    'calibrationEvaluate' => $evaluateCase,
    'configurationDefaults' => $defaultsCase,
    'configuration' => $configuration,
    'intelligence' => $intelligence,
    'features' => $features,
    'prediction' => $prediction,
    'value' => $value,
    'confidence' => $confidence,
    'risk' => $risk,
    'pipeline' => $pipeline,
];
})();
