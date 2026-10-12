<?php
/**
 * The lottery parity golden — PHP's OWN output, captured by `node runtime/lottery-parity.mjs`
 * into `apps/workforce-platform/test/fixtures/lottery-parity-golden.json`.
 *
 * The Node port is compared against this file case by case in
 * `apps/workforce-platform/test/lottery_parity.test.js`. Nothing in this script is a
 * transcription of what PHP was believed to do; everything under `cases` is what PHP
 * actually did, to the last double and the last character of every error string.
 *
 * The classes compared here are the foundation slice of row 15: the rules engine,
 * the draw validator, the statistics engine, the PRNG and the provider boundary —
 * all pure or scripted: no database, no network, and no clock reads that survive the
 * harness (the sandbox provider's date walk is clock-derived, so the draw list is
 * compared with `drawDate`, `externalId` and `sourceTimestamp` stripped — the NUMBER
 * content is what the seed decides, and that is compared exactly, jackpot strings
 * and rollover flags included).
 *
 * The legacy tree is read, never written.
 */

require_once __DIR__ . '/../../application/libraries/Aegis/MathUtils.php';
require_once __DIR__ . '/../../application/libraries/Aegis/Lottery/LotteryRules.php';
require_once __DIR__ . '/../../application/libraries/Aegis/Lottery/LotteryProvider.php';
require_once __DIR__ . '/../../application/libraries/Aegis/Lottery/LotteryResultValidator.php';
require_once __DIR__ . '/../../application/libraries/Aegis/Lottery/LotteryStatisticsEngine.php';
require_once __DIR__ . '/../../application/libraries/Aegis/Lottery/OfficialLotteryProvider.php';

use Aegis\Lottery\EuroMillionsRules;
use Aegis\Lottery\LotteryResultValidator;
use Aegis\Lottery\LotteryStatisticsEngine;
use Aegis\Lottery\OfficialLotteryProvider;
use Aegis\Lottery\SandboxLotteryProvider;
use Aegis\Lottery\UnavailableLotteryProvider;

const SENTINEL = '<NOW>';

/** Replace clock-derived fields with a sentinel so the committed golden does not change on every regeneration. */
function strip_clock($value, array $stripKeys = ['drawDate', 'externalId', 'sourceTimestamp'])
{
    if (is_array($value)) {
        $out = [];
        foreach ($value as $k => $v) {
            if (is_string($k) && in_array($k, $stripKeys, true)) { $out[$k] = SENTINEL; continue; }
            $out[$k] = strip_clock($v, $stripKeys);
        }
        return $out;
    }
    return $value;
}

/** Capture PHP's outcome for one callable: the value, or the exception message. */
function outcome(callable $fn)
{
    try {
        return ['ok' => true, 'value' => $fn()];
    } catch (Throwable $e) {
        return ['ok' => false, 'error' => $e->getMessage()];
    }
}

$rules = new EuroMillionsRules();
$validator = new LotteryResultValidator($rules);
$stats = new LotteryStatisticsEngine();

// ── the rules engine ──────────────────────────────────────────────────────────
//
// The line validator is the gate every stored number passes; each error string is
// the parity surface. `fromArray` over a stored row is the admin-update path.

$validateCases = [
    'a valid line' => [[5, 12, 23, 34, 49], [3, 11]],
    'unordered mains are the callers problem' => [[49, 34, 23, 12, 5], [3, 11]],
    'a duplicate main' => [[5, 5, 23, 34, 49], [3, 11]],
    'a duplicate star' => [[5, 12, 23, 34, 49], [3, 3]],
    'four mains' => [[5, 12, 23, 34], [3, 11]],
    'six mains' => [[1, 2, 3, 4, 5, 6], [3, 11]],
    'one star' => [[5, 12, 23, 34, 49], [3]],
    'main above the range' => [[5, 12, 23, 34, 51], [3, 11]],
    'main below the range' => [[0, 12, 23, 34, 49], [3, 11]],
    'star above the range' => [[5, 12, 23, 34, 49], [3, 13]],
    'a string main is a scalar and is named' => [['12', 12, 23, 34, 49], [3, 11]],
    'a float main is not is_int' => [[12.5, 12, 23, 34, 49], [3, 11]],
    'a null main is invalid, not a string' => [[null, 12, 23, 34, 49], [3, 11]],
    'an array where a number belongs' => [[[1], 12, 23, 34, 49], [3, 11]],
];

$rulesCases = [];
foreach ($validateCases as $name => [$main, $stars]) {
    $rulesCases[$name] = $rules->validateLine($main, $stars);
}
$rulesCases['stored rules rebuild the format'] = (function () use ($rules) {
    $rebuilt = EuroMillionsRules::fromArray('EUROMILLIONS', 'EuroMillions', [
        'version' => '1.1', 'main_count' => 6, 'main_min' => 1, 'main_max' => 60,
        'star_count' => 3, 'star_min' => 1, 'star_max' => 16,
        'schedule' => json_encode(['days' => [3, 6], 'time' => '20:00', 'timezone' => 'UTC']),
    ]);
    return [
        'version' => $rebuilt->version(), 'mainCount' => $rebuilt->mainCount(),
        'starCount' => $rebuilt->starCount(), 'schedule' => $rebuilt->drawSchedule(),
        'validSixThree' => $rebuilt->validateLine([1, 2, 3, 4, 5, 60], [1, 2, 16]),
    ];
})();
$rulesCases['an unparseable stored schedule falls back to the default'] = (function () {
    $rebuilt = EuroMillionsRules::fromArray('EUROMILLIONS', 'EuroMillions', [
        'version' => '1.0', 'main_count' => 5, 'main_min' => 1, 'main_max' => 50,
        'star_count' => 2, 'star_min' => 1, 'star_max' => 12, 'schedule' => 'not json',
    ]);
    return ['schedule' => $rebuilt->drawSchedule()];
})();
$rulesCases['a stored schedule without days falls back to the default'] = (function () {
    $rebuilt = EuroMillionsRules::fromArray('EUROMILLIONS', 'EuroMillions', [
        'version' => '1.0', 'main_count' => 5, 'main_min' => 1, 'main_max' => 50,
        'star_count' => 2, 'star_min' => 1, 'star_max' => 12, 'schedule' => json_encode(['time' => '21:00']),
    ]);
    return ['schedule' => $rebuilt->drawSchedule()];
})();

// ── the draw validator ────────────────────────────────────────────────────────

$draw = [
    'externalId' => 'SIM-2026-10-09', 'drawDate' => '2026-10-09',
    'main' => [1, 6, 34, 43, 44], 'stars' => [5, 11],
    'source' => 'sandbox-simulation', 'sourceTimestamp' => '2026-10-09T21:00:00+00:00',
];

$validatorCases = [
    'a valid draw' => $draw,
    'a missing external id' => array_diff_key($draw, ['externalId' => 1]),
    'an empty external id' => array_merge($draw, ['externalId' => '']),
    'a missing draw date' => array_diff_key($draw, ['drawDate' => 1]),
    'an impossible calendar day' => array_merge($draw, ['drawDate' => '2026-02-30']),
    'a non-leap february 29' => array_merge($draw, ['drawDate' => '2027-02-29']),
    'a leap february 29 is real' => array_merge($draw, ['drawDate' => '2028-02-29']),
    'a malformed draw date' => array_merge($draw, ['drawDate' => '09/10/2026']),
    'a missing source' => array_diff_key($draw, ['source' => 1]),
    'an empty source' => array_merge($draw, ['source' => '']),
    'a missing source timestamp' => array_diff_key($draw, ['sourceTimestamp' => 1]),
    'numeric-string numbers are coerced' => array_merge($draw, ['main' => ['1', 6, 34, 43, 44]]),
    'a non-numeric entry becomes -1 and reports the range' => array_merge($draw, ['main' => [1, 'x', 34, 43, 44]]),
    'a float number is truncated then judged' => array_merge($draw, ['main' => [1.9, 6, 34, 43, 44]]),
    'a non-array main is an empty list' => array_merge($draw, ['main' => 7]),
    'a null main is an empty list' => array_merge($draw, ['main' => null]),
    'a wrong count via coercion' => array_merge($draw, ['stars' => [5, 11, 99]]),
];
$validatorOut = [];
foreach ($validatorCases as $name => $case) {
    $validatorOut[$name] = $validator->validate($case);
}

// ── the statistics engine ─────────────────────────────────────────────────────
//
// Seven crafted draws, oldest first, chosen so the counts at every sliced boundary
// are distinct (PHP's sorts are unstable for ties; a tie at a boundary would make
// the golden record PHP's arbitrary order — divergence LT-3 pins tie-free cases).

$draws = [
    ['drawDate' => '2026-09-22', 'main' => [1, 2, 3, 4, 5], 'stars' => [1, 2]],
    ['drawDate' => '2026-09-25', 'main' => [5, 10, 15, 20, 25], 'stars' => [2, 3]],
    ['drawDate' => '2026-09-29', 'main' => [1, 5, 10, 20, 25], 'stars' => [1, 3]],
    ['drawDate' => '2026-10-02', 'main' => [7, 14, 21, 28, 35], 'stars' => [4, 5]],
    ['drawDate' => '2026-10-06', 'main' => [1, 5, 7, 14, 35], 'stars' => [1, 4]],
    ['drawDate' => '2026-10-09', 'main' => [2, 3, 7, 21, 28], 'stars' => [2, 5]],
    ['drawDate' => '2026-10-12', 'main' => [7, 14, 21, 28, 35], 'stars' => [4, 5]],
];

$statistics = [
    'numbers' => $stats->numberStats($draws, 1, 50, 4),
    'stars' => $stats->starStats($draws, 1, 12, 0),
    'hot-cold' => $stats->hotCold($draws, 'main', 1, 50, 3, 3),
    'hot-cold default window' => $stats->hotCold($draws, 'main', 1, 50),
    'distribution' => $stats->distribution($draws, 1, 50, 5),
    'pairs' => $stats->groupStats($draws, 'main', 1, 50, 2, 8),
    'triplets' => $stats->groupStats($draws, 'main', 1, 50, 3, 8),
    'star-pairs' => $stats->groupStats($draws, 'stars', 1, 12, 2, 5),
    'empty history' => [
        'numbers' => $stats->numberStats([], 1, 50, 4),
        'hot-cold' => $stats->hotCold([], 'main', 1, 50),
        'distribution' => $stats->distribution([], 1, 50, 5),
    ],
];

// ── the PRNG ──────────────────────────────────────────────────────────────────
//
// Compared directly rather than only through its downstream effects: a one-bit
// difference in the xorshift would produce a different but equally plausible draw
// universe (the same failure mode as finding F-34).

$prng = [
    'seed42-first10' => (function () {
        $r = Aegis\MathUtils::seededRandom(42);
        $out = [];
        for ($i = 0; $i < 10; $i++) { $out[] = $r(); }
        return $out;
    })(),
    'seed1-first5' => (function () {
        $r = Aegis\MathUtils::seededRandom(1);
        $out = [];
        for ($i = 0; $i < 5; $i++) { $out[] = $r(); }
        return $out;
    })(),
    'seed0-is-seed1' => (function () {
        $a = Aegis\MathUtils::seededRandom(0);
        $b = Aegis\MathUtils::seededRandom(1);
        return [$a(), $b()];
    })(),
    'seed-negative-masks-like-php' => (function () {
        $a = Aegis\MathUtils::seededRandom(-42);
        return [$a()];
    })(),
];

// ── the sandbox provider ──────────────────────────────────────────────────────
//
// putenv is read per call in legacy, so the opt-in is set for the online cases and
// withdrawn for the refusal cases. The draw list is compared with the clock-derived
// fields stripped: what the seed decides (mains, stars, jackpot, rollover) is exact.

putenv('WINDELS_LOTTERY_SANDBOX=1');
$sandbox = new SandboxLotteryProvider(42);
// Every enabled-state observation happens BEFORE the withdrawal below: enabled()
// reads the environment per call, so a case that runs after putenv would capture
// the refusal path while claiming to be the online one.
$sandboxDraws = $sandbox->draws(null, null, 6);
$sandboxBounded = $sandbox->draws('2026-10-07', null, 100);
$sandboxCases = [
    'health online' => $sandbox->health(),
    'jackpot info while enabled states the simulation' => $sandbox->jackpotInfo(),
    'draw-count-6' => count($sandboxDraws),
    'draws stripped of clock fields' => array_map(fn ($d) => strip_clock($d), $sandboxDraws),
    'a from-bound stops the walk' => [count($sandboxBounded), array_map(fn ($d) => strip_clock($d), $sandboxBounded)],
    'limit is capped at 1000' => count($sandbox->draws(null, null, 5000)) === 1000 ? 'capped' : 'not capped',
];

putenv('WINDELS_LOTTERY_SANDBOX=');
$disabled = new SandboxLotteryProvider(42);
// After the withdrawal: the SAME $sandbox instance goes dark (per-call env read),
// and a freshly constructed one refuses identically.
$sandboxCases += [
    'disabled health' => $disabled->health(),
    'disabled draws are empty' => $disabled->draws(null, null, 10),
    'disabled jackpot is null' => $disabled->jackpotInfo(),
    'jackpot info after the withdrawal is null (the env is read per call)' => $sandbox->jackpotInfo(),
];

// ── the official provider ─────────────────────────────────────────────────────
//
// Health states over a scripted transport, plus normalizeDraw's vendor-alias map.
// Safety defaults are the parity surface: disabled, insecure URL, missing metadata.

$officialCases = [
    'disabled by default' => (new OfficialLotteryProvider())->health(),
    'an explicit url does not enable the feed' => (new OfficialLotteryProvider('https://feed.example/v1'))->health(),
    'missing license is unconfigured' => (new OfficialLotteryProvider('https://feed.example/v1', true))->health(),
    'an insecure url is unconfigured' => (new OfficialLotteryProvider('http://feed.example/v1', true, null, 'LIC', 'src'))->health(),
    'credentials in the url are unsafe' => (new OfficialLotteryProvider('https://user:pass@feed.example/v1', true, null, 'LIC', 'src'))->health(),
    'an empty url is unconfigured' => (new OfficialLotteryProvider('', true, null, 'LIC', 'src'))->health(),
    'a health endpoint that reports failure is offline' => (function () {
        $p = new OfficialLotteryProvider('https://feed.example/v1', true, null, 'LIC', 'src', fn () => ['ok' => false]);
        return $p->health();
    })(),
    'an unreachable feed is offline with the reason truncated' => (function () {
        $p = new OfficialLotteryProvider('https://feed.example/v1', true, null, 'LIC', 'src', function () { throw new RuntimeException('connection refused ' . str_repeat('x', 200)); });
        return $p->health();
    })(),
    'an online feed reports its version and source' => (function () {
        $p = new OfficialLotteryProvider('https://feed.example/v1', true, 'secret-token', 'LIC-2026', 'licensed-source', fn () => ['ok' => true, 'version' => 9]);
        return $p->health();
    })(),
    'a non-scalar version is null' => (function () {
        $p = new OfficialLotteryProvider('https://feed.example/v1', true, null, 'LIC', 'src', fn () => ['ok' => true, 'version' => ['9']]);
        return $p->health();
    })(),
    'the url and token travel to the transport' => (function () {
        $seen = [];
        $p = new OfficialLotteryProvider('https://feed.example/v1', true, 'secret-token', 'LIC', 'src', function ($url, $token) use (&$seen) { $seen[] = ['url' => $url, 'token' => $token]; return ['ok' => true]; });
        $p->health();
        return $seen;
    })(),
    'draws map the vendor aliases' => (function () {
        $p = new OfficialLotteryProvider('https://feed.example/v1', true, null, 'LIC', 'licensed-source', fn () => [
            'data' => ['draws' => [[
                'drawId' => 'D9', 'date' => '2026-10-09',
                'winningNumbers' => [1, 2, 3, 4, 5], 'luckyStars' => [2, 5],
                'updatedAt' => '2026-10-09T21:00:00Z', 'jackpot' => 17000000, 'rollover' => 1, 'winners' => 3,
            ]]],
        ]);
        return $p->draws(null, null, 10);
    })(),
    'snake_case aliases map too' => (function () {
        $p = new OfficialLotteryProvider('https://feed.example/v1', true, null, 'LIC', 'src', fn () => [
            'draws' => [['external_id' => 'D10', 'draw_date' => '2026-10-06', 'main' => [13, 23, 35, 36, 40], 'stars' => [2, 4], 'source_timestamp' => '2026-10-06T21:00:00Z', 'rollover' => 0]],
        ]);
        return $p->draws(null, null, 10);
    })(),
    'nested main and stars objects unwrap one level' => (function () {
        $p = new OfficialLotteryProvider('https://feed.example/v1', true, null, 'LIC', 'src', fn () => [
            'draws' => [['externalId' => 'N1', 'drawDate' => '2026-10-09', 'main' => ['main' => [1, 2, 3, 4, 5]], 'stars' => ['stars' => [2, 5]], 'sourceTimestamp' => '2026-10-09T21:00:00Z']],
        ]);
        return $p->draws(null, null, 10);
    })(),
    'missing fields stay missing so the validator can reject them' => (function () {
        $p = new OfficialLotteryProvider('https://feed.example/v1', true, null, 'LIC', 'src', fn () => ['draws' => [['externalId' => 'H1']]]);
        return $p->draws(null, null, 10);
    })(),
    'rollover follows PHP truthiness, not JS truthiness' => (function () {
        $p = new OfficialLotteryProvider('https://feed.example/v1', true, null, 'LIC', 'src', fn () => [
            'draws' => [
                ['externalId' => 'R0', 'rollover' => '0'],
                ['externalId' => 'R1', 'rollover' => '0.0'],
                ['externalId' => 'R2', 'rollover' => []],
                ['externalId' => 'R3', 'rollover' => true],
            ],
        ]);
        return array_map(fn ($d) => $d['rollover'], $p->draws(null, null, 10));
    })(),
    'the endpoint query carries limit first, then from and to, RFC3986-encoded' => (function () {
        $seen = [];
        $p = new OfficialLotteryProvider('https://feed.example/v1/', true, null, 'LIC', 'src', function ($url) use (&$seen) { $seen[] = $url; return ['draws' => []]; });
        $p->draws(null, null, 5000);
        $p->draws('2026-10-01', '2026-10-09', 5);
        return $seen;
    })(),
    'an empty draw list is an empty list, not an error' => (function () {
        $p = new OfficialLotteryProvider('https://feed.example/v1', true, null, 'LIC', 'src', fn () => ['draws' => []]);
        return $p->draws(null, null, 10);
    })(),
    'a non-list payload is refused' => outcome(function () {
        $p = new OfficialLotteryProvider('https://feed.example/v1', true, null, 'LIC', 'src', fn () => ['draws' => ['not' => 'a list']]);
        return $p->draws(null, null, 10);
    }),
    'invalid json is refused' => outcome(function () {
        $p = new OfficialLotteryProvider('https://feed.example/v1', true, null, 'LIC', 'src', fn () => 'nope');
        return $p->draws(null, null, 10);
    }),
    'unconfigured draws are empty, not an error' => (new OfficialLotteryProvider())->draws(null, null, 10),
    'jackpot info without a jackpot url is null' => (function () {
        $p = new OfficialLotteryProvider('https://feed.example/v1', true, null, 'LIC', 'src', fn () => ['ok' => true]);
        return $p->jackpotInfo();
    })(),
    'unconfigured jackpot info is null' => (new OfficialLotteryProvider())->jackpotInfo(),
];

// ── the unavailable provider ──────────────────────────────────────────────────

$unavailable = new UnavailableLotteryProvider();
$unavailableCases = [
    'health' => $unavailable->health(),
    'draws' => $unavailable->draws(null, null, 10),
    'jackpot' => $unavailable->jackpotInfo(),
];

// ── emit ──────────────────────────────────────────────────────────────────────

echo json_encode([
    'generator' => 'runtime/parity/lottery-golden.php',
    'php' => ['version' => PHP_VERSION, 'sapi' => PHP_SAPI],
    'cases' => [
        'rules' => $rulesCases,
        'validator' => $validatorOut,
        'statistics' => $statistics,
        'prng' => $prng,
        'sandbox' => $sandboxCases,
        'official' => $officialCases,
        'unavailable' => $unavailableCases,
    ],
], JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION), PHP_EOL;
