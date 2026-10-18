<?php
/**
 * F-26 golden cases for the ANALYSIS module: every pure numeric policy the port
 * claims function-for-function — `Aegis\Indicators` (16 static methods), the
 * `Aegis\MathUtils` helpers the analysis layer uses, and the PHP formatting
 * verbs (`round`, `number_format`, `sprintf`) whose output strings are part of
 * the API payload.
 *
 * Required by `runtime/analysis-parity.mjs`, which runs this file in WASM PHP
 * 8.2 and writes apps/workforce-platform/test/fixtures/analysis-parity-golden.json.
 * The verifier (`test/analysis_parity.test.js`) recomputes every case with the
 * Node port and asserts agreement to the last double and the last character.
 *
 * Rules the two earlier slices set, kept here:
 *  - every input is built IN PHP by a deterministic loop and stored in the
 *    golden beside its result, so the Node side reads the input rather than
 *    re-deriving it — a dataset cannot drift between the two sides without the
 *    golden file itself changing;
 *  - the legacy tree is read, never written;
 *  - the JSON is the evidence: PHP floats are emitted at full round-trip
 *    precision, and the runner normalizes only the version banner.
 */

use Aegis\Indicators;
use Aegis\MathUtils;

$root = dirname(__DIR__, 2);
require $root . '/application/libraries/Aegis/MathUtils.php';
require $root . '/application/libraries/Aegis/Indicators.php';

$cases = [];

/**
 * One case: the name is the assertion message this file owes the reader,
 * `fn` is the verifier's dispatch key, `input` is replayed verbatim by Node,
 * and `result` is what PHP — not anyone's belief about PHP — produced.
 */
function golden(string $name, string $fn, array $input, $result): void
{
    global $cases;
    $cases[] = ['name' => $name, 'fn' => $fn, 'input' => $input, 'result' => $result];
}

/* ------------------------------------------------ series and candle builders
 *
 * The constants below are chosen to exercise the code, not to look like a
 * market: steps with non-dyadic decimal expansions (the 0.0017 family) are
 * full-precision doubles exactly where half-even vs half-up rounding disagrees,
 * and the mod-primes keep highs/lows/volumes from aligning with any period the
 * indicator uses.
 */

function series_linear(int $n, float $start, float $step): array
{
    $out = [];
    for ($i = 0; $i < $n; $i++) {
        $out[] = $start + $i * $step;
    }
    return $out;
}

/** Deterministic zigzag: period-7 walk on top of a slow drift. */
function series_zigzag(int $n, float $start): array
{
    $out = [];
    for ($i = 0; $i < $n; $i++) {
        $swings = [1.0043, -0.9971, 0.0031, 1.0009, -1.0027, 0.9993, -0.0013];
        $out[] = $start + $i * 0.0021 + $swings[$i % 7];
    }
    return $out;
}

/** A monotone sine — climbs but never walks in a straight line. */
function series_oscillating(int $n, float $base, float $amplitude, float $cycles): array
{
    $out = [];
    for ($i = 0; $i < $n; $i++) {
        $out[] = $base + $amplitude * sin(2 * M_PI * $cycles * $i / $n) + $i * 0.0004;
    }
    return $out;
}

/** Candles from a close path: volatility and volume from mod-primes, a zero-volume row every 17th. */
function candles_of(array $closes, float $spreadBasis): array
{
    $out = [];
    foreach ($closes as $i => $close) {
        $highOffset = $spreadBasis * ((($i * 7) % 13) / 13 + 0.20);
        $lowOffset = $spreadBasis * ((($i * 11) % 17) / 17 + 0.15);
        $out[] = [
            'timestamp' => 1728000000 + $i * 3600,
            'open' => $i === 0 ? $closes[0] : $closes[$i - 1],
            'high' => $close + $highOffset,
            'low' => $close - $lowOffset,
            'close' => $close,
            'volume' => $i % 17 === 0 ? 0.0 : (float) (($i * 89) % 977 + 41),
        ];
    }
    return $out;
}

/** Flat candles: high == low == close so stochastic's hh == ll guard and ADX's tr==0 guard run. */
function candles_flat(int $n, float $price): array
{
    $out = [];
    for ($i = 0; $i < $n; $i++) {
        $out[] = [
            'timestamp' => 1728100000 + $i * 3600,
            'open' => $price, 'high' => $price, 'low' => $price, 'close' => $price,
            'volume' => (float) (($i * 31) % 211 + 7),
        ];
    }
    return $out;
}

/* -------------------------------------------------------------- the datasets */

$trendUp       = series_linear(120, 1.1013, 0.0017);
$trendDown     = series_linear(90, 1.4401, -0.0019);
$zigzag        = series_zigzag(140, 96.25);
$zigzagShort   = series_zigzag(40, 0.6212);
$oscillating   = series_oscillating(120, 1.3202, 0.008, 9.0);
$flat          = array_fill(0, 40, 1.2345);
$micro         = [1.1013, 1.1001, 1.1009];

$candlesZigzag     = candles_of($zigzag, 0.002);
$candlesSmall      = candles_of($zigzagShort, 0.0011);
$candlesTrend      = candles_of(series_linear(120, 100.5, 0.35), 0.9);
$candlesFlat       = candles_flat(50, 1.7777);
$candlesWiggly     = candles_of(series_zigzag(90, 1.3111), 0.0016);

/* ----------------------------------------------------------------- indicator cases */

golden('sma over a trending series', 'sma', ['values' => $trendUp, 'period' => 10], Indicators::sma($trendUp, 10));
golden('sma over the zigzag at its own period', 'sma', ['values' => $zigzag, 'period' => 20], Indicators::sma($zigzag, 20));
golden('sma on a series shorter than its period is all null', 'sma', ['values' => $micro, 'period' => 5], Indicators::sma($micro, 5));
golden('sma period 1 is the identity', 'sma', ['values' => $micro, 'period' => 1], Indicators::sma($micro, 1));

golden('ema over a trending series', 'ema', ['values' => $trendUp, 'period' => 10], Indicators::ema($trendUp, 10));
golden('ema over the zigzag at the slow MACD period', 'ema', ['values' => $zigzag, 'period' => 26], Indicators::ema($zigzag, 26));
golden('ema period 1 seeds immediately at index 0', 'ema', ['values' => $zigzagShort, 'period' => 1], Indicators::ema($zigzagShort, 1));
golden('ema period 0 is all null, by the legacy guard', 'ema', ['values' => $micro, 'period' => 0], Indicators::ema($micro, 0));

golden('wilder smoothing over a trending series', 'wilder', ['values' => $trendUp, 'period' => 14], Indicators::wilder($trendUp, 14));
golden('wilder smoothing over the zigzag at period 5', 'wilder', ['values' => $zigzagShort, 'period' => 5], Indicators::wilder($zigzagShort, 5));

golden('rsi of a pure uptrend', 'rsi', ['closes' => $trendUp], Indicators::rsi($trendUp));
golden('rsi of a pure downtrend', 'rsi', ['closes' => $trendDown], Indicators::rsi($trendDown));
golden('rsi of the oscillating series', 'rsi', ['closes' => $oscillating], Indicators::rsi($oscillating));
golden('rsi of a flat series is 50 once defined — gain and loss both zero', 'rsi', ['closes' => $flat], Indicators::rsi($flat));
golden('rsi at period 21 over the zigzag', 'rsi', ['closes' => $zigzag, 'period' => 21], Indicators::rsi($zigzag, 21));
golden('rsi on a micro series is mostly null', 'rsi', ['closes' => $micro], Indicators::rsi($micro));

golden('macd of the long zigzag, legacy defaults', 'macd', ['closes' => $zigzag], Indicators::macd($zigzag));
golden('macd of a pure uptrend, legacy defaults', 'macd', ['closes' => $trendUp], Indicators::macd($trendUp));
golden('macd with a custom triple over the small series', 'macd', ['closes' => $zigzagShort, 'fast' => 5, 'slow' => 13, 'signal' => 5], Indicators::macd($zigzagShort, 5, 13, 5));
golden('macd shorter than the slow period is all null', 'macd', ['closes' => array_slice($trendUp, 0, 20)], Indicators::macd(array_slice($trendUp, 0, 20)));

golden('bollinger bands of the zigzag, legacy defaults', 'bollinger', ['closes' => $zigzag], Indicators::bollinger($zigzag));
golden('bollinger bands tight at period 3 and multiplier 0.5', 'bollinger', ['closes' => $trendDown, 'period' => 3, 'mult' => 0.5], Indicators::bollinger($trendDown, 3, 0.5));

golden('stochastic of the zigzag candles, legacy defaults', 'stochastic', ['candles' => $candlesZigzag], Indicators::stochastic($candlesZigzag));
golden('stochastic of flat candles is 50 — the hh == ll guard', 'stochastic', ['candles' => $candlesFlat], Indicators::stochastic($candlesFlat));
golden('stochastic at a custom (k, d) pair', 'stochastic', ['candles' => $candlesSmall, 'kPeriod' => 5, 'dPeriod' => 3], Indicators::stochastic($candlesSmall, 5, 3));

golden('true range of the zigzag candles', 'trueRange', ['candles' => $candlesZigzag], Indicators::trueRange($candlesZigzag));
golden('true range of a single candle is high minus low', 'trueRange', ['candles' => array_slice($candlesTrend, 0, 1)], Indicators::trueRange(array_slice($candlesTrend, 0, 1)));

golden('atr of the zigzag candles, legacy default', 'atr', ['candles' => $candlesZigzag], Indicators::atr($candlesZigzag));
golden('atr of the trending candles at period 7', 'atr', ['candles' => $candlesTrend, 'period' => 7], Indicators::atr($candlesTrend, 7));

golden('adx of the trending candles, legacy default', 'adx', ['candles' => $candlesTrend], Indicators::adx($candlesTrend));
golden('adx of the zigzag candles, legacy default', 'adx', ['candles' => $candlesZigzag], Indicators::adx($candlesZigzag));
golden('adx of flat candles is all null — the tr == 0 guard', 'adx', ['candles' => $candlesFlat], Indicators::adx($candlesFlat));

golden('vwap of the zigzag candles, including zero-volume rows', 'vwap', ['candles' => $candlesZigzag], Indicators::vwap($candlesZigzag));

golden('volume profile of the zigzag candles, legacy bins', 'volumeProfile', ['candles' => $candlesZigzag], Indicators::volumeProfile($candlesZigzag));
golden('volume profile at 5 bins', 'volumeProfile', ['candles' => $candlesSmall, 'bins' => 5], Indicators::volumeProfile($candlesSmall, 5));
golden('volume profile of flat candles — the hi !> lo branch', 'volumeProfile', ['candles' => $candlesFlat], Indicators::volumeProfile($candlesFlat));
$candlesNoVolume = array_map(
    fn($c) => ['timestamp' => $c['timestamp'], 'open' => $c['open'], 'high' => $c['high'], 'low' => $c['low'], 'close' => $c['close'], 'volume' => 0.0],
    $candlesSmall,
);
golden('volume profile with no priced candles is the empty shape', 'volumeProfile', ['candles' => $candlesNoVolume], Indicators::volumeProfile($candlesNoVolume));

golden('swing points of the wiggly candles at k = 2', 'findSwings', ['candles' => $candlesWiggly, 'k' => 2], Indicators::findSwings($candlesWiggly, 2));
golden('a monotone series has no swings', 'findSwings', ['candles' => $candlesTrend, 'k' => 2], Indicators::findSwings($candlesTrend, 2));
golden('swing points of the wiggly candles at k = 3 are stricter', 'findSwings', ['candles' => $candlesWiggly, 'k' => 3], Indicators::findSwings($candlesWiggly, 3));

golden('support/resistance above and below price with a real ATR', 'supportResistance', ['candles' => $candlesWiggly, 'atrValue' => 0.0042, 'currentPrice' => 1.3111 + 45 * 0.0021], Indicators::supportResistance($candlesWiggly, 0.0042, 1.3111 + 45 * 0.0021));
golden('support/resistance with a null ATR uses the price-fraction tolerance', 'supportResistance', ['candles' => $candlesWiggly, 'atrValue' => null, 'currentPrice' => 1.5], Indicators::supportResistance($candlesWiggly, null, 1.5));
golden('support/resistance with a zero ATR also falls back to the fraction', 'supportResistance', ['candles' => $candlesWiggly, 'atrValue' => 0.0, 'currentPrice' => 1.2], Indicators::supportResistance($candlesWiggly, 0.0, 1.2));
golden('support/resistance with no swings is the empty shape', 'supportResistance', ['candles' => array_slice($candlesTrend, 0, 4), 'atrValue' => 1.0, 'currentPrice' => 101.0], Indicators::supportResistance(array_slice($candlesTrend, 0, 4), 1.0, 101.0));

golden('pivot points from a previous candle', 'pivotPoints', ['prev' => ['high' => 1.3111 + 0.0031, 'low' => 1.3111 - 0.0027, 'close' => 1.3111 + 0.0004]], Indicators::pivotPoints(['high' => 1.3111 + 0.0031, 'low' => 1.3111 - 0.0027, 'close' => 1.3111 + 0.0004]));
golden('pivot points with no previous candle are the null shape', 'pivotPoints', ['prev' => null], Indicators::pivotPoints(null));

golden('regression slope percent over a full window of the uptrend', 'regressionSlopePct', ['closes' => array_slice($trendUp, 0, 60), 'period' => 50], Indicators::regressionSlopePct(array_slice($trendUp, 0, 60), 50));
golden('regression slope uses only the trailing window', 'regressionSlopePct', ['closes' => $trendUp, 'period' => 50], Indicators::regressionSlopePct($trendUp, 50));
golden('regression slope is null below the period', 'regressionSlopePct', ['closes' => array_slice($trendDown, 0, 49), 'period' => 50], Indicators::regressionSlopePct(array_slice($trendDown, 0, 49), 50));
golden('regression slope of a flat window is zero — the slope, not a guard', 'regressionSlopePct', ['closes' => $flat, 'period' => 30], Indicators::regressionSlopePct($flat, 30));

golden('last() skips trailing nulls', 'last', ['arr' => [1.1111, 2.2222, null, null]], Indicators::last([1.1111, 2.2222, null, null]));
golden('last() of an all-null series is null', 'last', ['arr' => [null, null, null]], Indicators::last([null, null, null]));
golden('last() of one finite value is the value', 'last', ['arr' => [1.5]], Indicators::last([1.5]));

/* ------------------------------------------------------------- MathUtils (the analysis-layer half) */

golden('clamp inside the band', 'clamp', ['v' => 0.45, 'min' => -1.0, 'max' => 1.0], MathUtils::clamp(0.45, -1.0, 1.0));
golden('clamp below the floor', 'clamp', ['v' => -1.0001, 'min' => -0.15, 'max' => 1.0], MathUtils::clamp(-1.0001, -0.15, 1.0));
golden('clamp above the ceiling', 'clamp', ['v' => 10.25, 'min' => -0.15, 'max' => 1.0], MathUtils::clamp(10.25, -0.15, 1.0));
golden('clamp at exactly the boundary', 'clamp', ['v' => 0.75, 'min' => 0.75, 'max' => 0.75], MathUtils::clamp(0.75, 0.75, 0.75));

golden('mean of an empty array is null', 'mean', ['xs' => []], MathUtils::mean([]));
golden('mean of the zigzag head', 'mean', ['xs' => array_slice($zigzag, 0, 25)], MathUtils::mean(array_slice($zigzag, 0, 25)));
golden('mean of a negative-positive pair', 'mean', ['xs' => [-0.1, 0.1]], MathUtils::mean([-0.1, 0.1]));

golden('stdev of fewer than two values is null', 'stdev', ['xs' => [1.0]], MathUtils::stdev([1.0]));
golden('population stdev of the zigzag head', 'stdev', ['xs' => array_slice($zigzag, 0, 25)], MathUtils::stdev(array_slice($zigzag, 0, 25)));
golden('stdev of an identical triple is zero', 'stdev', ['xs' => [5.0, 5.0, 5.0]], MathUtils::stdev([5.0, 5.0, 5.0]));

golden('hashString of the empty string', 'hashString', ['s' => ''], MathUtils::hashString(''));
golden('hashString of a symbol', 'hashString', ['s' => 'EURUSD'], MathUtils::hashString('EURUSD'));
golden('hashString of a full synthetic-candle key', 'hashString', ['s' => 'synthetic-candles:EURUSD:1h'], MathUtils::hashString('synthetic-candles:EURUSD:1h'));
golden('hashString of a long parameter string', 'hashString', ['s' => 'a_very/long:Detailed:String:01'], MathUtils::hashString('a_very/long:Detailed:String:01'));

foreach ([0, 1, 42, 123456789] as $seed) {
    $rand = MathUtils::seededRandom($seed);
    $outputs = [];
    for ($i = 0; $i < 5; $i++) {
        $outputs[] = $rand();
    }
    golden("seededRandom({$seed}) produces the xorshift sequence", 'seededRandom', ['seed' => $seed, 'draws' => 5], $outputs);
}
foreach ([7, 99] as $seed) {
    $rand = MathUtils::seededRandom($seed);
    $outputs = [];
    for ($i = 0; $i < 4; $i++) {
        $outputs[] = MathUtils::gaussian($rand);
    }
    golden("gaussian over seeded sequence {$seed} preserves the Box-Muller formula", 'gaussian', ['seed' => $seed, 'draws' => 4], $outputs);
}

/* ------------------------------------------- the formatting verbs the payloads embed */

foreach ([
    [0.5, 0], [-0.5, 0], [2.5, 0], [-2.5, 0], [1.005, 2], [0.055, 2], [-1.005, 2], [1234.5678, 3], [499999.9999999999, 2],
] as [$value, $digits]) {
    golden("PHP round({$value}, {$digits}) — half away from zero on doubles", 'round', ['value' => $value, 'digits' => $digits], round($value, $digits));
}
foreach ([
    [64000.0, 5], [1234.5, 2], [0.0, 2], [-987654.321, 3], [999.999, 2],
] as [$value, $digits]) {
    golden("number_format of {$value} to {$digits} places", 'numberFormat', ['value' => $value, 'digits' => $digits], number_format($value, $digits));
}
foreach ([[1.234, 2], [-0.5, 4], [0.0, 2]] as [$value, $digits]) {
    golden("sprintf always-signed of {$value}", 'signedFormat', ['value' => $value, 'digits' => $digits], sprintf('%+.' . $digits . 'f', $value));
}
foreach ([[1.5, 2], [-0.0, 2], [987654.3125, 4]] as [$value, $digits]) {
    golden("sprintf fixed of {$value}", 'fixedFormat', ['value' => $value, 'digits' => $digits], sprintf('%.' . $digits . 'f', $value));
}

/* -------------------------------------------------------------------- payload */

echo json_encode([
    'php' => ['version' => phpversion(), 'sapi' => PHP_SAPI],
    'cases' => $cases,
], JSON_PRESERVE_ZERO_FRACTION);
