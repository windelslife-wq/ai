<?php
/**
 * Slice 4 golden cases: pairwise correlation, the classification of a selection set, and
 * the ticket optimizer. Included by `sports-golden.php`, which has already defined
 * `$sports` and owns the `require`s for these classes. This file returns the cases and
 * writes nothing.
 *
 * Every input is a literal, so the Node side reads the input from the golden file rather
 * than re-deriving it. A dataset cannot drift between the two sides without the golden
 * file itself changing.
 *
 * Two shapes of candidate appear, and the difference is the finding (F-39):
 *
 *  - **pipeline** shape is what legacy's `PredictionPipeline` actually produces. The teams
 *    and competition sit under `match` only. Legacy's correlation checks read them at the
 *    top level, so they never fire, and only SAME_MATCH can.
 *  - **port** shape carries `homeTeam`, `awayTeam` and `competition` at the top level as
 *    well. This is what the Node candidate builder supplies, and it is the input the
 *    documented checks were written for.
 *
 * The cases record what legacy computes for both shapes, so F-39 is evidence, not an
 * inference. The ticket id is random in legacy (`random_bytes`), so it is removed from the
 * output and replaced with a shape check.
 */

use Aegis\Sports\CorrelationEngine;
use Aegis\Sports\TicketOptimizer;

require_once $sports . '/CorrelationEngine.php';
require_once $sports . '/TicketOptimizer.php';

$correlation = new CorrelationEngine();
$optimizer = new TicketOptimizer();

/** Legacy PredictionPipeline shape: teams and competition under `match` only (F-39). */
$pipeline = function (int $matchId, string $home, string $away, string $competition, array $over = []): array {
    return array_replace_recursive([
        'matchId' => $matchId,
        'match' => ['id' => $matchId, 'homeTeam' => $home, 'awayTeam' => $away, 'competition' => $competition],
        'market' => 'TOTAL_GOALS',
        'selection' => 'OVER_1_5',
        'risk' => ['classification' => 'LOW', 'approved' => true],
        'value' => ['qualified' => true, 'odds' => 1.9, 'expectedValue' => 0.1],
        'confidence' => ['confidence' => 70.0],
        'quality' => ['score' => 80],
        'prediction' => ['calibratedProbability' => 0.6, 'rawModelProbability' => 0.58],
        'predictionId' => 'prd_' . str_pad((string) $matchId, 24, '0', STR_PAD_LEFT),
    ], $over);
};

/** Port shape: the pipeline shape plus the top-level team and competition fields. */
$port = function (int $matchId, string $home, string $away, string $competition, array $over = []) use ($pipeline): array {
    return array_replace_recursive($pipeline($matchId, $home, $away, $competition), array_merge([
        'homeTeam' => $home,
        'awayTeam' => $away,
        'competition' => $competition,
    ], $over));
};

/** A pool of four distinct fixtures, each a different competition and two different teams. */
$poolA = function () use ($port): array {
    return [
        $port(1, 'Alpha 1', 'Bravo 1', 'League 1', ['value' => ['odds' => 1.5, 'expectedValue' => 0.05]]),
        $port(2, 'Alpha 2', 'Bravo 2', 'League 2', ['value' => ['odds' => 2.0, 'expectedValue' => 0.08]]),
        $port(3, 'Alpha 3', 'Bravo 3', 'League 3', ['value' => ['odds' => 2.5, 'expectedValue' => 0.02]]),
        $port(4, 'Alpha 4', 'Bravo 4', 'League 4', ['value' => ['odds' => 3.0, 'expectedValue' => 0.10]]),
    ];
};

$defaults = [
    'targetOddsMin' => 5.0,
    'targetOddsMax' => 8.0,
    'maxSelections' => 5,
    'minConfidence' => 0.0,
    'minDataQuality' => 0,
    'maxCorrelation' => 'MEDIUM',
    'allowedMarkets' => [],
    'allowedLeagues' => [],
];
$with = fn(array $overrides): array => array_merge($defaults, $overrides);

// ── pairwise correlation: assess(candidate, selected) ─────────────────────────────────

$correlationCases = [
    'same match is HIGH (SAME_MATCH) on the pipeline shape' => [
        'candidate' => $pipeline(1, 'Team X', 'Away 1', 'League Z'),
        'selected' => [$pipeline(1, 'Team Q', 'Away Q', 'League Y')],
    ],
    'a shared team is HIGH on the port shape' => [
        'candidate' => $port(1, 'Team X', 'Away 1', 'League Z'),
        'selected' => [$port(2, 'Team X', 'Away 2', 'League Q')],
    ],
    'two shared teams join with plus, in the candidate order' => [
        'candidate' => $port(1, 'Alpha', 'Bravo', 'League L'),
        'selected' => [$port(2, 'Bravo', 'Alpha', 'League M')],
    ],
    'a shared competition alone is MEDIUM on the port shape' => [
        'candidate' => $port(1, 'A1', 'B1', 'League L'),
        'selected' => [$port(2, 'A2', 'B2', 'League L')],
    ],
    'F-39: a shared team is invisible on the pipeline shape, so the pair is LOW' => [
        'candidate' => $pipeline(1, 'Team X', 'Away 1', 'League Z'),
        'selected' => [$pipeline(2, 'Team X', 'Away 2', 'League Z')],
    ],
    'an unrelated pair is LOW with no reasons' => [
        'candidate' => $port(1, 'A1', 'B1', 'L1'),
        'selected' => [$port(2, 'A2', 'B2', 'L2')],
    ],
    'reasons accumulate across selections and are de-duplicated in order' => [
        'candidate' => $port(1, 'A', 'B', 'L'),
        'selected' => [$port(2, 'A', 'C', 'M'), $port(3, 'D', 'B', 'L')],
    ],
    'an empty selection set is LOW' => [
        'candidate' => $port(1, 'A', 'B', 'L'),
        'selected' => [],
    ],
];

$correlationResults = [];
foreach ($correlationCases as $name => $case) {
    $correlationResults[$name] = [
        'input' => $case,
        'result' => $correlation->assess($case['candidate'], $case['selected']),
    ];
}

// ── the worst pairwise class across a set: classifySelections(selections) ──────────────

$setCases = [
    'the worst pair sets the class, and only HIGH and MEDIUM pairs contribute reasons' => [
        $port(1, 'A', 'B', 'L'), $port(2, 'C', 'D', 'L'), $port(3, 'E', 'F', 'M'),
    ],
    'one shared team makes the whole set HIGH' => [
        $port(1, 'A', 'B', 'L'), $port(2, 'A', 'D', 'M'),
    ],
    'a single selection is LOW' => [
        $port(1, 'A', 'B', 'L'),
    ],
    'F-39: a pipeline-shaped set that shares a team is LOW' => [
        $pipeline(1, 'Team X', 'Away 1', 'League Z'), $pipeline(2, 'Team X', 'Away 2', 'League Z'),
    ],
];

$setResults = [];
foreach ($setCases as $name => $selections) {
    $setResults[$name] = [
        'input' => $selections,
        'result' => $correlation->classifySelections($selections),
    ];
}

// ── the optimizer: optimize(pool, config) ─────────────────────────────────────────────

$optimizeCases = [
    'the best in-window combination by summed expected value' => [
        'pool' => $poolA(),
        'config' => $defaults,
    ],
    'a tie keeps the first combination found, because only a strict improvement replaces it' => [
        'pool' => [
            $port(1, 'A1', 'B1', 'L1', ['value' => ['odds' => 2.5, 'expectedValue' => 0.1]]),
            $port(2, 'A2', 'B2', 'L2', ['value' => ['odds' => 2.0, 'expectedValue' => 0.1]]),
            $port(3, 'A3', 'B3', 'L3', ['value' => ['odds' => 2.5, 'expectedValue' => 0.1]]),
            $port(4, 'A4', 'B4', 'L4', ['value' => ['odds' => 2.0, 'expectedValue' => 0.1]]),
        ],
        'config' => $defaults,
    ],
    'no combination reaches the window, so there is no ticket and the pool size is reported' => [
        'pool' => [
            $port(1, 'A1', 'B1', 'L1', ['value' => ['odds' => 1.1]]),
            $port(2, 'A2', 'B2', 'L2', ['value' => ['odds' => 1.2]]),
        ],
        'config' => $defaults,
    ],
    'a HIGH risk classification is excluded from the pool' => [
        'pool' => array_merge(array_slice($poolA(), 0, 3), [
            $port(4, 'Alpha 4', 'Bravo 4', 'League 4', ['value' => ['odds' => 3.0, 'expectedValue' => 0.10], 'risk' => ['classification' => 'HIGH', 'approved' => true]]),
        ]),
        'config' => $defaults,
    ],
    'a risk that is not approved is excluded even when it is not HIGH' => [
        'pool' => array_merge(array_slice($poolA(), 0, 1), [
            $port(2, 'Alpha 2', 'Bravo 2', 'League 2', ['value' => ['odds' => 2.0, 'expectedValue' => 0.08], 'risk' => ['classification' => 'LOW', 'approved' => false]]),
            $port(3, 'Alpha 3', 'Bravo 3', 'League 3', ['value' => ['odds' => 2.5, 'expectedValue' => 0.02]]),
            $port(4, 'Alpha 4', 'Bravo 4', 'League 4', ['value' => ['odds' => 3.0, 'expectedValue' => 0.10]]),
        ]),
        'config' => $defaults,
    ],
    'a candidate whose value is not qualified is excluded' => [
        'pool' => array_merge(array_slice($poolA(), 0, 1), [
            $port(2, 'Alpha 2', 'Bravo 2', 'League 2', ['value' => ['odds' => 2.0, 'expectedValue' => 0.08, 'qualified' => false]]),
            $port(3, 'Alpha 3', 'Bravo 3', 'League 3', ['value' => ['odds' => 2.5, 'expectedValue' => 0.02]]),
            $port(4, 'Alpha 4', 'Bravo 4', 'League 4', ['value' => ['odds' => 3.0, 'expectedValue' => 0.10]]),
        ]),
        'config' => $defaults,
    ],
    'an unmeasured confidence fails a configured floor' => [
        'pool' => [
            $port(1, 'A1', 'B1', 'L1', ['value' => ['odds' => 2.5, 'expectedValue' => 0.1], 'confidence' => ['confidence' => null]]),
            $port(2, 'A2', 'B2', 'L2', ['value' => ['odds' => 2.0, 'expectedValue' => 0.1]]),
            $port(3, 'A3', 'B3', 'L3', ['value' => ['odds' => 2.5, 'expectedValue' => 0.1]]),
        ],
        'config' => $with(['minConfidence' => 60.0]),
    ],
    'a confidence just under the floor is excluded, and one at the floor is kept' => [
        'pool' => [
            $port(1, 'A1', 'B1', 'L1', ['value' => ['odds' => 2.5, 'expectedValue' => 0.1], 'confidence' => ['confidence' => 64.9]]),
            $port(2, 'A2', 'B2', 'L2', ['value' => ['odds' => 2.0, 'expectedValue' => 0.1], 'confidence' => ['confidence' => 65.0]]),
            $port(3, 'A3', 'B3', 'L3', ['value' => ['odds' => 2.5, 'expectedValue' => 0.1], 'confidence' => ['confidence' => 90.0]]),
        ],
        'config' => $with(['minConfidence' => 65.0]),
    ],
    'the quality floor excludes a candidate scored below it' => [
        'pool' => [
            $port(1, 'A1', 'B1', 'L1', ['value' => ['odds' => 2.5, 'expectedValue' => 0.1], 'quality' => ['score' => 80]]),
            $port(2, 'A2', 'B2', 'L2', ['value' => ['odds' => 2.0, 'expectedValue' => 0.1], 'quality' => ['score' => 65]]),
            $port(3, 'A3', 'B3', 'L3', ['value' => ['odds' => 2.5, 'expectedValue' => 0.1], 'quality' => ['score' => 90]]),
        ],
        'config' => $with(['minDataQuality' => 70]),
    ],
    'an allowed-market list that names no candidate leaves an empty pool' => [
        'pool' => $poolA(),
        'config' => $with(['allowedMarkets' => ['OTHER_MARKET']]),
    ],
    'an allowed-league list keeps only the named competitions' => [
        'pool' => $poolA(),
        'config' => $with(['allowedLeagues' => ['League 2', 'League 4']]),
    ],
    'maxSelections caps the ticket, and the best pair is taken' => [
        'pool' => $poolA(),
        'config' => $with(['maxSelections' => 2]),
    ],
    'a same-match pair cannot share a ticket' => [
        'pool' => [
            $port(1, 'A1', 'B1', 'L1', ['value' => ['odds' => 2.5, 'expectedValue' => 0.1]]),
            $port(1, 'A1', 'B1', 'L1', ['value' => ['odds' => 2.0, 'expectedValue' => 0.1]]),
        ],
        'config' => $defaults,
    ],
    'maxCorrelation LOW refuses a same-competition pair, which MEDIUM allows' => [
        'pool' => [
            $port(1, 'A1', 'B1', 'League L', ['value' => ['odds' => 2.5, 'expectedValue' => 0.1]]),
            $port(2, 'A2', 'B2', 'League L', ['value' => ['odds' => 2.0, 'expectedValue' => 0.1]]),
        ],
        'config' => $with(['maxCorrelation' => 'LOW']),
    ],
    'maxCorrelation MEDIUM allows the same-competition pair' => [
        'pool' => [
            $port(1, 'A1', 'B1', 'League L', ['value' => ['odds' => 2.5, 'expectedValue' => 0.1]]),
            $port(2, 'A2', 'B2', 'League L', ['value' => ['odds' => 2.0, 'expectedValue' => 0.1]]),
        ],
        'config' => $defaults,
    ],
    'a port-shaped shared team is HIGH, so it is refused even at MEDIUM' => [
        'pool' => [
            $port(1, 'Team X', 'Away 1', 'League Z', ['value' => ['odds' => 2.5, 'expectedValue' => 0.1]]),
            $port(2, 'Team X', 'Away 2', 'League Q', ['value' => ['odds' => 2.0, 'expectedValue' => 0.1]]),
        ],
        'config' => $defaults,
    ],
    'F-39: a pipeline-shaped shared team is LOW, so legacy lets the pair onto a LOW-only ticket' => [
        'pool' => [
            $pipeline(1, 'Team X', 'Away 1', 'League Z', ['value' => ['odds' => 2.5, 'expectedValue' => 0.1]]),
            $pipeline(2, 'Team X', 'Away 2', 'League Z', ['value' => ['odds' => 2.0, 'expectedValue' => 0.1]]),
        ],
        'config' => $with(['maxCorrelation' => 'LOW']),
    ],
];

$optimizeResults = [];
foreach ($optimizeCases as $name => $case) {
    $result = $optimizer->optimize($case['pool'], $case['config']);
    // The ticket id is random by design. Record only that it has the legacy shape, and
    // remove it from the value the Node side must reproduce exactly.
    $hasTicketId = array_key_exists('ticketId', $result);
    $ticketIdShape = $hasTicketId ? (bool) preg_match('/^tkt_[0-9a-f]{16}$/', (string) $result['ticketId']) : null;
    unset($result['ticketId']);
    $optimizeResults[$name] = [
        'input' => $case,
        'hasTicketId' => $hasTicketId,
        'ticketIdShape' => $ticketIdShape,
        'result' => $result,
    ];
}

return [
    'correlation' => $correlationResults,
    'classifySelections' => $setResults,
    'optimize' => $optimizeResults,
    'constants' => [
        'correlationScore' => ['HIGH' => 1.0, 'MEDIUM' => 0.5, 'LOW' => 0.0],
        'defaults' => $defaults,
    ],
];
