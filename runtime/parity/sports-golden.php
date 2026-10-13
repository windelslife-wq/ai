<?php
/**
 * Golden-output generator for the PHP↔Node differential harness (finding F-26).
 *
 * This script is **not part of the PHP application** and must not be moved into
 * `application/`: it lives under `runtime/` precisely so that generating parity
 * evidence never touches the authoritative legacy tree. It `require`s six legacy
 * class files by path and changes nothing else — no database, no CodeIgniter
 * bootstrap, no environment other than the two variables the sandbox provider
 * reads.
 *
 * Those six classes are the whole reason F-26 is finally closeable. They are pure:
 * no I/O, no global state, no clock reads beyond `gmdate()`, and their error
 * messages are already byte-identical between the PHP and Node implementations
 * because the Node port deliberately preserved them. A differential harness needs
 * exactly that — a function of its arguments and nothing else — and every earlier
 * candidate (the risk engine, the optimizer, the supervisor) either touched the
 * database or diverged numerically on purpose.
 *
 * Output is deterministic by construction:
 *
 *  - The sandbox provider is asked only for dates **entirely in the past**, so
 *    every fixture is FINISHED and every `observedAt` resolves to
 *    `kickoff - 7200` rather than to "now".
 *  - The three fields that genuinely are "now" (`sourceTimestamp`,
 *    `context.recentForm.timestamp`, `health.lastSuccessAt`) are replaced with the
 *    sentinel `<NOW>` **here**, so the committed golden file does not change every
 *    time it is regenerated. The Node test applies the identical substitution.
 *
 * Regenerate with: `node runtime/sports-parity.mjs`
 */

// Two levels up: this file lives in runtime/parity/, and the legacy classes live
// under the repository root's application/.
$root = realpath(__DIR__ . '/../../');
$sports = $root . '/application/libraries/Aegis/Sports';

require $sports . '/Providers/ProviderException.php';
require $sports . '/Providers/SportsDataProvider.php';
require $sports . '/Providers/SandboxSportsProvider.php';
require $sports . '/SportsDataNormalizer.php';
require $sports . '/DataQualityEngine.php';
require $sports . '/OddsFreshnessEngine.php';
// Slice 2 adds the two classes whose inputs are repository rows, which is why they
// could not be captured in slice 1: migration 011 did not exist yet, so there was no
// defined row shape to synthesize. There is now, and the shapes below are the columns
// that migration creates.
require $sports . '/SportsResultNormalizer.php';
require $sports . '/ProviderHealthMonitor.php';

use Aegis\Sports\DataQualityEngine;
use Aegis\Sports\OddsFreshnessEngine;
use Aegis\Sports\Providers\SandboxSportsProvider;
use Aegis\Sports\SportsDataNormalizer;
use Aegis\Sports\SportsResultNormalizer;
use Aegis\Sports\ProviderHealthMonitor;

// The sandbox provider's double opt-in. Without both it reports OFFLINE and
// refuses every call, which is itself one of the cases captured below.
putenv('WINDELS_SPORTS_MODE=SANDBOX');
putenv('WINDELS_SPORTS_SANDBOX=1');

const SENTINEL = '<NOW>';

/**
 * Replace the fields that are genuinely "now" with a sentinel, recursively.
 *
 * `$keep` names keys to leave alone, and it exists because the sentinel is only correct
 * for a field the class DERIVES from the clock. `SportsDataNormalizer::fixture()`
 * re-derives `sourceTimestamp`; `SportsResultNormalizer::normalize()` merely casts the
 * caller's `sourceTimestamp` to a string and returns it. Sentinelizing the second would
 * blank a deterministic value both sides can compare — and the comparison would still
 * PASS, because the Node test applies the identical substitution, so the field would
 * look covered while being ignored. That is the failure mode a differential harness
 * exists to avoid, in the harness itself.
 */
function strip_clock($value, array $keep = [])
{
    if (!is_array($value)) return $value;
    $out = [];
    foreach ($value as $k => $v) {
        if (in_array($k, ['sourceTimestamp', 'lastSuccessAt'], true) && is_string($v) && !in_array($k, $keep, true)) { $out[$k] = SENTINEL; continue; }
        if ($k === 'timestamp' && is_string($v) && !in_array($k, $keep, true)) { $out[$k] = SENTINEL; continue; }
        $out[$k] = strip_clock($v, $keep);
    }
    return $out;
}

/** Run a callable, capturing either its return value or the message it threw. */
function outcome(callable $fn, array $keep = [])
{
    try { return ['ok' => true, 'value' => strip_clock($fn(), $keep)]; }
    catch (Throwable $e) { return ['ok' => false, 'error' => $e->getMessage(), 'class' => get_class($e)]; }
}

// A fixed provider label. The normalizer stamps whatever it is given, so parity
// here proves the stamping, not the value.
const P = 'parity-provider';

$fixtureCases = [
    'minimal valid' => ['externalId' => 'FX-1', 'homeTeam' => 'Alpha United', 'awayTeam' => 'Bolt City', 'competition' => 'Premier Simulation League', 'kickoff' => '2020-01-04T14:00:00Z'],
    'full valid with offset kickoff' => ['externalId' => 'FX-2', 'homeTeam' => ' Comet Rangers ', 'awayTeam' => 'Delta Athletic', 'competition' => '  Continental Simulation Cup  ', 'kickoff' => '2020-01-04T15:00:00+01:00', 'status' => 'live', 'sport' => 'FOOTBALL', 'sourceTimestamp' => '2020-01-04T10:00:00Z', 'simulated' => true, 'context' => ['recentForm' => ['homeGoalsPerMatch' => 1.5, 'awayGoalsPerMatch' => '1.25', 'homeConcededPerMatch' => 0, 'awayConcededPerMatch' => 2, 'source' => 'parity'], 'marketLiquidity' => 50000, 'restDays' => 3]],
    'unknown status is refused' => ['externalId' => 'FX-3', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z', 'status' => 'ABANDONED'],
    'lowercase status is accepted and uppercased' => ['externalId' => 'FX-4', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z', 'status' => 'postponed'],
    'missing externalId' => ['homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z'],
    'blank homeTeam' => ['externalId' => 'FX-5', 'homeTeam' => '   ', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z'],
    'null competition is treated as absent' => ['externalId' => 'FX-6', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => null, 'kickoff' => '2020-01-04T14:00:00Z'],
    'unparseable kickoff' => ['externalId' => 'FX-7', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => 'not-a-date'],
    'numeric-string kickoff is not an epoch' => ['externalId' => 'FX-8', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '1700000000'],
    'bare zero kickoff' => ['externalId' => 'FX-9', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '0'],
    'bare year-like kickoff' => ['externalId' => 'FX-10', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '12345'],
    'unparseable sourceTimestamp' => ['externalId' => 'FX-11', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z', 'sourceTimestamp' => 'whenever'],
    'incomplete recentForm is dropped entirely' => ['externalId' => 'FX-12', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z', 'context' => ['recentForm' => ['homeGoalsPerMatch' => 1.5, 'awayGoalsPerMatch' => 1.2, 'homeConcededPerMatch' => 0.9]]],
    'negative form value drops the whole block' => ['externalId' => 'FX-13', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z', 'context' => ['recentForm' => ['homeGoalsPerMatch' => 1.5, 'awayGoalsPerMatch' => 1.2, 'homeConcededPerMatch' => -0.4, 'awayConcededPerMatch' => 1.1]]],
    'non-numeric form value drops the whole block' => ['externalId' => 'FX-14', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z', 'context' => ['recentForm' => ['homeGoalsPerMatch' => true, 'awayGoalsPerMatch' => 1.2, 'homeConcededPerMatch' => 0.9, 'awayConcededPerMatch' => 1.1]]],
    'form source must be a string or becomes null' => ['externalId' => 'FX-15', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z', 'context' => ['recentForm' => ['homeGoalsPerMatch' => 1.5, 'awayGoalsPerMatch' => 1.2, 'homeConcededPerMatch' => 0.9, 'awayConcededPerMatch' => 1.1, 'source' => 42]]],
    'negative marketLiquidity is dropped but restDays survives' => ['externalId' => 'FX-16', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z', 'context' => ['marketLiquidity' => -5, 'restDays' => 2]],
    'empty context becomes null' => ['externalId' => 'FX-17', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z', 'context' => []],
    'non-array context becomes null' => ['externalId' => 'FX-18', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z', 'context' => 'nonsense'],
    'zero restDays is kept' => ['externalId' => 'FX-19', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z', 'context' => ['restDays' => 0]],
    'simulated flag is truthiness not presence' => ['externalId' => 'FX-20', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z', 'simulated' => '0'],
    'simulated flag accepts a non-empty string' => ['externalId' => 'FX-21', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z', 'simulated' => 'yes'],
    'extra fields are preserved in fieldsPresent only' => ['externalId' => 'FX-22', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z', 'referee' => 'Someone', 'venue' => 'Somewhere'],
    'date-only kickoff' => ['externalId' => 'FX-23', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04'],
];

$oddsCases = [
    'valid' => ['market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'decimalOdds' => 2.36, 'observedAt' => '2020-01-04T12:00:00Z'],
    'numeric string odds' => ['market' => 'MATCH_ODDS', 'selection' => 'HOME', 'decimalOdds' => '1.85', 'observedAt' => '2020-01-04T12:00:00Z'],
    'odds of exactly 1.0 are refused' => ['market' => 'MATCH_ODDS', 'selection' => 'HOME', 'decimalOdds' => 1.0, 'observedAt' => '2020-01-04T12:00:00Z'],
    'odds just above 1.0 are accepted' => ['market' => 'MATCH_ODDS', 'selection' => 'HOME', 'decimalOdds' => 1.0000001, 'observedAt' => '2020-01-04T12:00:00Z'],
    'zero odds are refused' => ['market' => 'MATCH_ODDS', 'selection' => 'HOME', 'decimalOdds' => 0, 'observedAt' => '2020-01-04T12:00:00Z'],
    'negative odds are refused' => ['market' => 'MATCH_ODDS', 'selection' => 'HOME', 'decimalOdds' => -2.0, 'observedAt' => '2020-01-04T12:00:00Z'],
    'non-numeric odds are refused' => ['market' => 'MATCH_ODDS', 'selection' => 'HOME', 'decimalOdds' => 'evens', 'observedAt' => '2020-01-04T12:00:00Z'],
    'boolean odds are refused because is_numeric(true) is false' => ['market' => 'MATCH_ODDS', 'selection' => 'HOME', 'decimalOdds' => true, 'observedAt' => '2020-01-04T12:00:00Z'],
    'missing observedAt' => ['market' => 'MATCH_ODDS', 'selection' => 'HOME', 'decimalOdds' => 1.9],
    'empty market string' => ['market' => '', 'selection' => 'HOME', 'decimalOdds' => 1.9, 'observedAt' => '2020-01-04T12:00:00Z'],
    'whitespace market passes presence and is trimmed' => ['market' => '  MATCH_ODDS  ', 'selection' => 'HOME', 'decimalOdds' => 1.9, 'observedAt' => '2020-01-04T12:00:00Z'],
    'unparseable observedAt' => ['market' => 'MATCH_ODDS', 'selection' => 'HOME', 'decimalOdds' => 1.9, 'observedAt' => 'later'],
    'high precision odds survive' => ['market' => 'MATCH_ODDS', 'selection' => 'HOME', 'decimalOdds' => 1.234567891, 'observedAt' => '2020-01-04T12:00:00Z'],
];

$quality = new DataQualityEngine();
$fixtureForQuality = ['externalId' => 'FX-1', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z'];
$qualityCases = [
    'everything present and fresh' => [$fixtureForQuality, ['oddsAvailable' => true, 'recentFormAvailable' => true, 'providerReliability' => 0.95, 'dataAgeSeconds' => 30, 'maxAgeSeconds' => 3600]],
    'no context at all' => [$fixtureForQuality, []],
    'odds missing only' => [$fixtureForQuality, ['oddsAvailable' => false, 'recentFormAvailable' => true, 'providerReliability' => 0.95, 'dataAgeSeconds' => 30]],
    'reliability just below the threshold' => [$fixtureForQuality, ['oddsAvailable' => true, 'recentFormAvailable' => true, 'providerReliability' => 0.7499, 'dataAgeSeconds' => 30]],
    'reliability exactly at the threshold' => [$fixtureForQuality, ['oddsAvailable' => true, 'recentFormAvailable' => true, 'providerReliability' => 0.75, 'dataAgeSeconds' => 30]],
    'reliability above one is clamped' => [$fixtureForQuality, ['oddsAvailable' => true, 'recentFormAvailable' => true, 'providerReliability' => 1.7, 'dataAgeSeconds' => 30]],
    'negative reliability is clamped' => [$fixtureForQuality, ['oddsAvailable' => true, 'recentFormAvailable' => true, 'providerReliability' => -0.4, 'dataAgeSeconds' => 30]],
    'stale beyond maxAge' => [$fixtureForQuality, ['oddsAvailable' => true, 'recentFormAvailable' => true, 'providerReliability' => 0.95, 'dataAgeSeconds' => 3601, 'maxAgeSeconds' => 3600]],
    'exactly at maxAge is still fresh' => [$fixtureForQuality, ['oddsAvailable' => true, 'recentFormAvailable' => true, 'providerReliability' => 0.95, 'dataAgeSeconds' => 3600, 'maxAgeSeconds' => 3600]],
    'a required field of the string zero counts as missing' => [['externalId' => '0', 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z'], []],
    'a required field of integer zero counts as missing' => [['externalId' => 0, 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z'], []],
    'a required empty array counts as missing' => [['externalId' => [], 'homeTeam' => 'A', 'awayTeam' => 'B', 'competition' => 'C', 'kickoff' => '2020-01-04T14:00:00Z'], []],
    'ticket eligibility needs score and freshness together' => [$fixtureForQuality, ['oddsAvailable' => true, 'recentFormAvailable' => true, 'providerReliability' => 0.95, 'dataAgeSeconds' => 99999]],
    'prediction eligibility is looser than ticket eligibility' => [$fixtureForQuality, ['oddsAvailable' => false, 'recentFormAvailable' => false, 'providerReliability' => 0.95, 'dataAgeSeconds' => 30]],
];

$freshness = new OddsFreshnessEngine();
$fixedNow = 1577880000; // 2020-01-01T12:00:00Z
$freshnessCases = [
    'no odds at all' => [null, 900, $fixedNow],
    'fresh odds' => [['observedAt' => '2020-01-01T11:55:00Z'], 900, $fixedNow],
    'exactly at the limit is fresh' => [['observedAt' => '2020-01-01T11:45:00Z'], 900, $fixedNow],
    'one second past the limit is stale' => [['observedAt' => '2020-01-01T11:44:59Z'], 900, $fixedNow],
    'snake_case repository row' => [['observed_at' => '2020-01-01T11:55:00Z'], 900, $fixedNow],
    'empty timestamp is available but never fresh' => [['observedAt' => ''], 900, $fixedNow],
    'unparseable timestamp' => [['observedAt' => 'recently'], 900, $fixedNow],
    'numeric timestamp' => [['observedAt' => 1577879700], 900, $fixedNow],
    'observation in the future clamps age to zero' => [['observedAt' => '2020-01-01T13:00:00Z'], 900, $fixedNow],
    'a tighter window' => [['observedAt' => '2020-01-01T11:55:00Z'], 60, $fixedNow],
    'a looser window' => [['observedAt' => '2020-01-01T09:00:00Z'], 14400, $fixedNow],
    'legacy-shaped offset timestamp' => [['observedAt' => '2020-01-01T11:55:00+00:00'], 900, $fixedNow],
];

// ---- sandbox provider ------------------------------------------------------
// A date range entirely in the past, so every fixture is FINISHED and no field
// depends on when this script runs.
$range = ['from' => '2020-01-04', 'to' => '2020-01-05'];
$sandbox = new SandboxSportsProvider();
$fixtures = $sandbox->fixtures($range);
$sampleIds = array_map(fn($f) => $f['externalId'], array_slice($fixtures, 0, 4));

$disabled = null;
{
    // A second instance built while the opt-in is withdrawn, to capture the
    // refusal path. The environment is restored immediately afterwards.
    putenv('WINDELS_SPORTS_SANDBOX=0');
    $off = new SandboxSportsProvider();
    $disabled = ['health' => $off->health()];
    foreach (['fixtures', 'odds', 'results'] as $op) {
        try {
            $off->{$op}($op === 'fixtures' ? $range : 'sim-bc27c7-2020-01-04-0');
            $disabled[$op] = ['ok' => true];
        } catch (Throwable $e) {
            $disabled[$op] = ['ok' => false, 'error' => $e->getMessage(), 'status' => $e->status ?? null];
        }
    }
    putenv('WINDELS_SPORTS_SANDBOX=1');
}

// ── SportsResultNormalizer cases ──────────────────────────────────────────────
//
// Scores are the interesting ones. `filter_var(..., FILTER_VALIDATE_INT)` is not
// `is_int` and not `is_numeric`: a quoted integer passes, a float fails, a whole float
// stringifies to an integer and passes, and a boolean is stringified first — so `true`
// passes as 1 and `false` fails as "". Those are the exact edges a JavaScript port
// guesses at, which is why they are captured rather than reasoned about.
$resultCases = [
    'a finished result with integer scores' => [['externalId' => 'e1', 'status' => 'FINISHED', 'homeScore' => 2, 'awayScore' => 1, 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'a finished result with quoted scores' => [['externalId' => 'e1', 'status' => 'FINISHED', 'homeScore' => '2', 'awayScore' => '0', 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'a finished nil-nil draw' => [['externalId' => 'e1', 'status' => 'FINISHED', 'homeScore' => 0, 'awayScore' => 0, 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'status is upper-cased' => [['externalId' => 'e1', 'status' => 'finished', 'homeScore' => 1, 'awayScore' => 1, 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'a fractional score is refused' => [['externalId' => 'e1', 'status' => 'FINISHED', 'homeScore' => 2.5, 'awayScore' => 1, 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'a fractional score as text is refused' => [['externalId' => 'e1', 'status' => 'FINISHED', 'homeScore' => '2.5', 'awayScore' => '1', 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'a whole float is accepted because PHP stringifies it' => [['externalId' => 'e1', 'status' => 'FINISHED', 'homeScore' => 2.0, 'awayScore' => 1.0, 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'a negative score is refused' => [['externalId' => 'e1', 'status' => 'FINISHED', 'homeScore' => -1, 'awayScore' => 0, 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'true stringifies to 1 and passes' => [['externalId' => 'e1', 'status' => 'FINISHED', 'homeScore' => true, 'awayScore' => true, 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'false stringifies to empty and is refused' => [['externalId' => 'e1', 'status' => 'FINISHED', 'homeScore' => false, 'awayScore' => 1, 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'a finished result missing a score is refused' => [['externalId' => 'e1', 'status' => 'FINISHED', 'homeScore' => 2, 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'a postponed result needs no scores and stores none' => [['externalId' => 'e1', 'status' => 'POSTPONED', 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'a postponed result discards scores it was given' => [['externalId' => 'e1', 'status' => 'POSTPONED', 'homeScore' => 3, 'awayScore' => 0, 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'a void result' => [['externalId' => 'e1', 'status' => 'VOID', 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'a cancelled result' => [['externalId' => 'e1', 'status' => 'CANCELLED', 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'a suspended result' => [['externalId' => 'e1', 'status' => 'SUSPENDED', 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'an unlisted status is refused' => [['externalId' => 'e1', 'status' => 'ABANDONED', 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'SCHEDULED is a fixture status, not a result' => [['externalId' => 'e1', 'status' => 'SCHEDULED', 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'LIVE is a fixture status, not a result' => [['externalId' => 'e1', 'status' => 'LIVE', 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'a missing external id is refused' => [['status' => 'FINISHED', 'homeScore' => 1, 'awayScore' => 0, 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'an empty external id is refused' => [['externalId' => '', 'status' => 'FINISHED', 'homeScore' => 1, 'awayScore' => 0, 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'a missing source timestamp is refused' => [['externalId' => 'e1', 'status' => 'FINISHED', 'homeScore' => 1, 'awayScore' => 0], 'P'],
    'a missing status is refused' => [['externalId' => 'e1', 'homeScore' => 1, 'awayScore' => 0, 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'an empty status is refused' => [['externalId' => 'e1', 'status' => '', 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'the provider is stamped on as provenance' => [['externalId' => 'e1', 'status' => 'VOID', 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'sandbox-sim'],
    'a score of the string zero is a real score' => [['externalId' => 'e1', 'status' => 'FINISHED', 'homeScore' => '0', 'awayScore' => '0', 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'a padded score is accepted' => [['externalId' => 'e1', 'status' => 'FINISHED', 'homeScore' => ' 2 ', 'awayScore' => '1', 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'a hexadecimal score is refused' => [['externalId' => 'e1', 'status' => 'FINISHED', 'homeScore' => '0x2', 'awayScore' => '1', 'sourceTimestamp' => '2020-01-04T16:00:00Z'], 'P'],
    'the raw payload is returned whole' => [['externalId' => 'e1', 'status' => 'VOID', 'sourceTimestamp' => '2020-01-04T16:00:00Z', 'note' => 'kept'], 'P'],
];

// ── ProviderHealthMonitor cases ───────────────────────────────────────────────
//
// Seven rules in a fixed precedence order, plus the reliability helper. Every case
// pins an explicit `$now`, so `checkedAt` is deterministic and needs no sentinel.
//
// Note that `assess()`'s first parameter is documented as the `sports_data_sources`
// row and is never read by the implementation. Captured anyway: a parameter a port
// assumes is meaningful and then wires up is a divergence nobody would notice.
$NOW = 1772701200; // 2026-03-05T09:00:00+00:00
$at = fn(int $secondsAgo) => gmdate('c', $NOW - $secondsAgo);
$providerRow = ['id' => 1, 'provider_code' => 'sandbox-sim', 'display_name' => 'sandbox-sim', 'enabled' => 1];
$run = fn(string $status, int $secondsAgo) => ['status' => $status, 'started_at' => $at($secondsAgo)];
$obs = fn(string $status, int $secondsAgo) => ['status' => $status, 'observed_at' => $at($secondsAgo)];

$healthCases = [
    'rule 1 nothing observed at all' => [$providerRow, [], [], $NOW],
    'rule 2 a recent authentication error wins over everything' => [$providerRow, [$obs('AUTHENTICATION_ERROR', 60)], [$run('COMPLETED', 30)], $NOW],
    'rule 2 a recent rate limit is terminal too' => [$providerRow, [$obs('RATE_LIMITED', 60)], [$run('FAILED', 30)], $NOW],
    'rule 2 a terminal report older than thirty minutes no longer wins' => [$providerRow, [$obs('AUTHENTICATION_ERROR', 1801)], [$run('COMPLETED', 60)], $NOW],
    'rule 2 exactly at the thirty minute boundary still wins' => [$providerRow, [$obs('RATE_LIMITED', 1800)], [$run('COMPLETED', 60)], $NOW],
    'rule 3 a failure within five minutes degrades' => [$providerRow, [$obs('OFFLINE', 60)], [$run('COMPLETED', 30)], $NOW],
    'rule 3 a recent rate-limited failure keeps its own status' => [$providerRow, [$obs('RATE_LIMITED', 400)], [$run('COMPLETED', 30)], $NOW],
    'rule 3 a DATA_ERROR within five minutes' => [$providerRow, [$obs('DATA_ERROR', 299)], [$run('COMPLETED', 30)], $NOW],
    'rule 3 a degraded observation within five minutes is still a failure' => [$providerRow, [$obs('DEGRADED', 60)], [$run('COMPLETED', 30)], $NOW],
    'rule 4 both channels stale beyond six hours is offline' => [$providerRow, [$obs('ONLINE', 21601)], [$run('COMPLETED', 21601)], $NOW],
    'rule 4 health stale but a recent sync is not offline' => [$providerRow, [$obs('ONLINE', 21601)], [$run('COMPLETED', 60)], $NOW],
    'rule 4 a sync stale but recent health is not offline' => [$providerRow, [$obs('DEGRADED', 600)], [$run('COMPLETED', 21601)], $NOW],
    'rule 4 no runs at all with stale health is offline' => [$providerRow, [$obs('ONLINE', 21601)], [], $NOW],
    'rule 5 a fifty percent run error rate is degraded' => [$providerRow, [$obs('ONLINE', 60)], [$run('COMPLETED', 30), $run('FAILED', 90)], $NOW],
    'rule 5 fires before rule 6 at exactly the threshold' => [$providerRow, [$obs('ONLINE', 60)], [$run('FAILED', 30), $run('COMPLETED', 60)], $NOW],
    'rule 5 a third of runs failing is not degraded' => [$providerRow, [$obs('ONLINE', 60)], [$run('COMPLETED', 30), $run('COMPLETED', 60), $run('FAILED', 90)], $NOW],
    'rule 6 a healthy provider with successful runs is online and boosted' => [$providerRow, [$obs('ONLINE', 60)], [$run('COMPLETED', 30), $run('COMPLETED', 90)], $NOW],
    'rule 6 online with no runs at all earns half reliability' => [$providerRow, [$obs('ONLINE', 60)], [], $NOW],
    'rule 7 an older degraded report falls through to degraded' => [$providerRow, [$obs('DEGRADED', 400)], [$run('COMPLETED', 60)], $NOW],
    'rule 7 an unknown status falls through to degraded' => [$providerRow, [$obs('SOMETHING_NEW', 60)], [$run('COMPLETED', 30)], $NOW],
    'reliability with no runs and no boost is zero' => [$providerRow, [$obs('DEGRADED', 60)], [], $NOW],
    'reliability is capped at one' => [$providerRow, [$obs('ONLINE', 60)], [$run('COMPLETED', 10), $run('COMPLETED', 20), $run('COMPLETED', 30)], $NOW],
    'the newest observation is the first element, not the newest timestamp' => [$providerRow, [$obs('ONLINE', 600), $obs('OFFLINE', 60)], [$run('COMPLETED', 30)], $NOW],
    'an observation with no timestamp is skipped in the failure scan' => [$providerRow, [['status' => 'OFFLINE'], $obs('ONLINE', 60)], [$run('COMPLETED', 30)], $NOW],
    'an unparseable observation timestamp is skipped' => [$providerRow, [['status' => 'OFFLINE', 'observed_at' => 'not-a-date'], $obs('ONLINE', 60)], [$run('COMPLETED', 30)], $NOW],
    'the string zero as a timestamp is no timestamp at all' => [$providerRow, [['status' => 'OFFLINE', 'observed_at' => '0'], $obs('ONLINE', 60)], [$run('COMPLETED', 30)], $NOW],
    'SP-11 a future observation is skipped in the scan but is still the latest' => [$providerRow, [$obs('OFFLINE', -600), $obs('ONLINE', 60)], [$run('COMPLETED', 30)], $NOW],
    'SP-11 a future terminal report still wins, because recent() does not bound above' => [$providerRow, [$obs('AUTHENTICATION_ERROR', -600)], [$run('COMPLETED', 30)], $NOW],
    'a run with no status counts as neither success nor failure' => [$providerRow, [$obs('ONLINE', 60)], [['started_at' => $at(30)]], $NOW],
    'a run with an unparseable started_at still counts towards the error rate' => [$providerRow, [$obs('ONLINE', 60)], [$run('COMPLETED', 30), ['status' => 'FAILED', 'started_at' => 'not-a-date']], $NOW],
    'a missing fields list is carried through untouched' => [$providerRow, [array_merge($obs('DEGRADED', 60), ['missing_fields' => ['kickoff']])], [$run('COMPLETED', 30)], $NOW],
    'an empty provider row changes nothing, because it is never read' => [[], [$obs('ONLINE', 60)], [$run('COMPLETED', 30)], $NOW],
];

// Slice 3: the decision chain, calibration, configuration and PHP round(). See the
// included file for the cases and for why two of them are recorded as evidence.
$slice3 = require __DIR__ . '/sports-intelligence-golden.php';

// Slice 4: correlation, the class of a selection set, and the ticket optimizer.
$slice4 = require __DIR__ . '/sports-tickets-golden.php';

// Slice 5: verification, settlement, analytics, drift, model metrics, backtests.
$slice5 = require __DIR__ . '/sports-settlement-golden.php';

$payload = [
    'generator' => 'runtime/parity/sports-golden.php',
    'php' => ['version' => PHP_VERSION, 'sapi' => PHP_SAPI],
    'cases' => [
        'fixture' => (function () use ($fixtureCases) {
            $out = [];
            foreach ($fixtureCases as $name => $input) $out[$name] = ['input' => $input, 'result' => outcome(fn() => SportsDataNormalizer::fixture($input, P))];
            return $out;
        })(),
        'odds' => (function () use ($oddsCases) {
            $out = [];
            foreach ($oddsCases as $name => $input) $out[$name] = ['input' => $input, 'result' => outcome(fn() => SportsDataNormalizer::odds($input, P))];
            return $out;
        })(),
        'quality' => (function () use ($quality, $qualityCases) {
            $out = [];
            foreach ($qualityCases as $name => [$fixture, $context]) $out[$name] = ['fixture' => $fixture, 'context' => $context, 'result' => outcome(fn() => $quality->assess($fixture, $context))];
            return $out;
        })(),
        'result' => (function () use ($resultCases) {
            $out = [];
            foreach ($resultCases as $name => [$input, $provider]) $out[$name] = ['input' => $input, 'provider' => $provider, 'result' => outcome(fn() => SportsResultNormalizer::normalize($input, $provider), ['sourceTimestamp'])];
            return $out;
        })(),
        'health' => (function () use ($healthCases) {
            $monitor = new ProviderHealthMonitor();
            $out = ['constants' => ['STALE_AFTER_SECONDS' => ProviderHealthMonitor::STALE_AFTER_SECONDS, 'DEGRADED_ERROR_RATE' => ProviderHealthMonitor::DEGRADED_ERROR_RATE]];
            foreach ($healthCases as $name => [$provider, $observations, $runs, $now]) $out[$name] = ['provider' => $provider, 'health' => $observations, 'jobRuns' => $runs, 'now' => $now, 'result' => outcome(fn() => $monitor->assess($provider, $observations, $runs, $now))];
            return $out;
        })(),
        'freshness' => (function () use ($freshness, $freshnessCases) {
            $out = [];
            foreach ($freshnessCases as $name => [$odds, $maxAge, $now]) $out[$name] = ['odds' => $odds, 'maxAgeSeconds' => $maxAge, 'now' => $now, 'result' => outcome(fn() => $freshness->assess($odds, $maxAge, $now))];
            return $out;
        })(),
        'slice3' => $slice3,
        'slice4' => $slice4,
        'slice5' => $slice5,
        'sandbox' => [
            'health' => strip_clock($sandbox->health()),
            'fixtureCount' => count($fixtures),
            'fixtures' => strip_clock($fixtures),
            'sampleIds' => $sampleIds,
            'odds' => (function () use ($sandbox, $sampleIds) {
                $out = [];
                foreach ($sampleIds as $id) $out[$id] = outcome(fn() => $sandbox->odds($id));
                return $out;
            })(),
            'results' => (function () use ($sandbox, $sampleIds) {
                $out = [];
                foreach ($sampleIds as $id) $out[$id] = outcome(fn() => $sandbox->results($id));
                return $out;
            })(),
            'unknownExternalId' => ['odds' => outcome(fn() => $sandbox->odds('not-a-sandbox-id')), 'results' => outcome(fn() => $sandbox->results('not-a-sandbox-id'))],
            'disabled' => $disabled,
            // The PRNG internals, exposed through reflection so the CRC-32 and
            // SHA-256 derivations are compared directly rather than only through
            // their downstream effects. A one-bit difference in either would be
            // invisible in a fixture count and obvious here.
            'internals' => (function () use ($sandbox) {
                $ref = new ReflectionClass($sandbox);
                $call = function (string $method, array $args) use ($ref, $sandbox) {
                    $m = $ref->getMethod($method);
                    $m->setAccessible(true);
                    return $m->invokeArgs($sandbox, $args);
                };
                $teams = ['Alpha United', 'Bolt City', 'Apex FC', 'Horizon FC', 'Zzz Unknown'];
                $out = ['strength' => [], 'form' => [], 'externalId' => [], 'pairing' => [], 'kickoffTs' => [], 'randValue' => [], 'randInt' => [], 'poisson' => [], 'parseExternalId' => []];
                foreach ($teams as $t) $out['strength'][$t] = $call('strength', [$t]);
                foreach ($teams as $t) $out['form'][$t] = $call('form', ['Premier Simulation League', $t, 'Bolt City']);
                foreach (['Premier Simulation League', 'Continental Simulation Cup'] as $league) {
                    foreach ([0, 1, 2] as $slot) $out['externalId']["$league/$slot"] = $call('externalId', [$league, '2020-01-04', $slot]);
                }
                foreach ([0, 1, 2, 3, 7] as $slot) $out['pairing']["2020-01-04/$slot"] = $call('pairing', ['Premier Simulation League', '2020-01-04', $slot]);
                foreach ([0, 1, 2, 3, 4] as $slot) $out['kickoffTs'][(string) $slot] = $call('kickoffTs', ['2020-01-04', $slot]);
                foreach (['a', 'b', 'off:Premier Simulation League:2020-01-04', 'liq:sim-x'] as $key) $out['randValue'][$key] = $call('randValue', [$key, 0.0, 1.0]);
                foreach ([['off:x', 0, 7], ['liq:y', 0, 80000], ['rest:z', 0, 2]] as $i => [$key, $min, $max]) $out['randInt']["$key/$min/$max"] = $call('randInt', [$key, $min, $max]);
                foreach ([0.5, 1.0, 1.282, 2.5, 0.0, -1.0] as $lambda) $out['poisson'][(string) $lambda] = $call('poisson', [$lambda, 'parity-key']);
                foreach (['sim-bc27c7-2020-01-04-0', 'sim-000000-2020-01-04-0', 'sim-bc27c7-2020-13-04-0', 'nonsense', ''] as $id) $out['parseExternalId'][$id === '' ? '(empty)' : $id] = $call('parseExternalId', [$id]);
                return $out;
            })(),
        ],
    ],
];

echo json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION), "\n";
