<?php
/**
 * F-26, strategies & journal slice: golden cases for the pure numeric policies
 * of the Strategy Lab — `Aegis\Backtest\Metrics`, `Aegis\Backtest\Backtester::simulate`
 * (the whole engine through the four built-in strategies), and `Aegis\Journal\Analytics`.
 *
 * Same contract as the analysis slice: inputs built IN PHP by deterministic
 * loops and stored beside PHP's own output; the Node verifier
 * (`test/strategies_parity.test.js`) replays with the ported modules and
 * compares exactly. Known legacy defects are recorded as EVIDENCE rather than
 * expectations — see the F-48 note on `iso()` below.
 */

use Aegis\Backtest\Backtester;
use Aegis\Backtest\Metrics;
use Aegis\Journal\Analytics;
use Aegis\Strategies\BreakoutStrategy;
use Aegis\Strategies\MeanReversionStrategy;
use Aegis\Strategies\MomentumStrategy;
use Aegis\Strategies\TrendFollowingStrategy;

$root = dirname(__DIR__, 2);
require $root . '/application/libraries/Aegis/MathUtils.php';
require $root . '/application/libraries/Aegis/Indicators.php';
require $root . '/application/libraries/Aegis/Timeframes.php';
require $root . '/application/libraries/Aegis/Strategies/SeriesView.php';
require $root . '/application/libraries/Aegis/Strategies/BuiltinStrategies.php';
require $root . '/application/libraries/Aegis/Backtest/Metrics.php';
require $root . '/application/libraries/Aegis/Backtest/Backtester.php';
require $root . '/application/libraries/Aegis/Journal/Analytics.php';

$cases = [];
function golden(string $name, string $fn, array $input, $result): void
{
    global $cases;
    $cases[] = ['name' => $name, 'fn' => $fn, 'input' => $input, 'result' => $result];
}

/* --------------------------------------------------------- candle fabrication
 *
 * Each builder writes the SHAPE of market a strategy is tuned to detect, on a
 * deterministic loop — no randomness, and literals chosen off the dyadic grid
 * so float parsing stays exact: an uptrend leg for trend-following, a stubborn
 * mean-reverting channel, a momentum impulse, a breakout squeeze, and one flat
 * series that must produce no trade at all.
 */

function candle_seq(array $closes, int $baseTs = 1728000000000, array $volumes = null): array
{
    $out = [];
    foreach ($closes as $i => $close) {
        $prev = $i === 0 ? $closes[0] : $closes[$i - 1];
        $span = abs($close - $prev) / 2 + 0.0011 + ((($i * 7) % 11) / 22000);
        $out[] = [
            'timestamp' => $baseTs + $i * 3600000,
            'open' => $prev,
            'high' => max($prev, $close) + $span,
            'low' => min($prev, $close) - $span * 0.8,
            'close' => $close,
            'volume' => $volumes[$i] ?? (float)((($i * 89) % 977) + 137),
        ];
    }
    return $out;
}

/** Decline (fast EMA below slow, ADX elevated), a hard rally (the cross up fires
 *  into an already-strong trend), then a fading leg that turns it around. */
function closes_trend_leg(int $n): array
{
    $out = [];
    $level = 1.0600;
    for ($i = 0; $i < $n; $i++) {
        $drift = $i < 90 ? -0.0006 : ($i < 220 ? 0.0016 : -0.0008);
        $out[] = $level += $drift + (((($i * 13) % 7) - 3) * 0.00004);
    }
    return $out;
}

/** A channel around 1.1000 with period-23 overshoots — repeat bollinger touches. */
function closes_channel(int $n): array
{
    $out = [];
    for ($i = 0; $i < $n; $i++) {
        $out[] = 1.1000 + 0.0018 * sin(2 * M_PI * 9 * $i / $n) + 0.0004 * sin(2 * M_PI * 23 * $i / $n);
    }
    return $out;
}

/** Sideways, then an impulse up (ROC past the threshold → BUY), a plateau that
 *  lets the histogram flip (the CLOSE), then a leg DOWN so the SELL fires on a
 *  host that allows shorts — and is counted, ignored, on one that does not. */
function closes_impulse(int $n): array
{
    $out = [];
    $level = 750.0;
    for ($i = 0; $i < $n; $i++) {
        if ($i < 90) $step = 0.02;
        elseif ($i < 135) $step = 2.9;
        elseif ($i < 160) $step = -0.15;
        elseif ($i < 210) $step = -3.0;
        else $step = 0.35;
        $out[] = $level += $step + (((($i * 17) % 5) - 2) * 0.03);
    }
    return $out;
}

/** A long squeeze that finally spikes — the breakout engine's whole reason. */
function closes_breakout(int $n): array
{
    $out = [];
    $level = 95.0;
    for ($i = 0; $i < $n; $i++) {
        if ($i < 130) $step = 0.002;
        elseif ($i < 150) $step = 0.55;
        else $step = 0.012;
        $out[] = $level += $step + (((($i * 11) % 3) - 1) * 0.004);
    }
    return $out;
}

function closes_flat(int $n): array
{
    return array_fill(0, $n, 100.0);
}

$REQ = [
    'warmupBars' => 80, 'initialEquity' => 10000.0, 'spreadBps' => 2.0,
    'slippageBps' => 1.0, 'feeBps' => 5.0, 'riskPct' => 0.01,
    'maxBarsInTrade' => 90, 'allowShorts' => true,
];
$META = ['symbol' => 'TESTUSD', 'timeframe' => '1h'];

/* -------------------------------------------------------- Backtester::simulate
 *
 * The entire engine: SeriesView look-ahead-proof windows, next-open fills,
 * pessimistic intrabar stop/target order, fees/spread/slippage accrual, mark-
 * to-market equity, end-of-data flat — with PHP's own `iso()` timestamps left
 * stranded in the output as F-48 evidence (double-Z: `…T00:00:00Z.250Z`).
 */

golden('simulate a trend following leg through the momentum shift', 'backtestSimulate',
    ['strategy' => 'trend-following', 'candles' => candle_seq(closes_trend_leg(280)), 'req' => $REQ, 'meta' => $META],
    Backtester::simulate(new TrendFollowingStrategy(), candle_seq(closes_trend_leg(280)), $REQ, $META));

golden('simulate re-version of the same leg with customized fast/slow', 'backtestSimulate',
    ['strategy' => 'trend-following', 'params' => ['fast' => 10, 'slow' => 40, 'adxMin' => 20, 'stopAtr' => 2, 'targetR' => 2], 'candles' => candle_seq(closes_channel(260)), 'req' => $REQ, 'meta' => ['symbol' => 'EURUSD', 'timeframe' => '15m']],
    Backtester::simulate(new TrendFollowingStrategy(['fast' => 10, 'slow' => 40, 'adxMin' => 20, 'stopAtr' => 2, 'targetR' => 2]), candle_seq(closes_channel(260)), $REQ, ['symbol' => 'EURUSD', 'timeframe' => '15m']));

golden('simulate mean reversion in its channel, shorts allowed', 'backtestSimulate',
    ['strategy' => 'mean-reversion', 'candles' => candle_seq(closes_channel(300)), 'req' => $REQ, 'meta' => $META],
    Backtester::simulate(new MeanReversionStrategy(), candle_seq(closes_channel(300)), $REQ, $META));

golden('simulate a momentum impulse with shorts refused — the ignoredSignals path', 'backtestSimulate',
    ['strategy' => 'momentum', 'candles' => candle_seq(closes_impulse(260)), 'req' => ['warmupBars' => 80, 'initialEquity' => 25000.0, 'spreadBps' => 3.0, 'slippageBps' => 2.0, 'feeBps' => 7.0, 'riskPct' => 0.005, 'maxBarsInTrade' => 40, 'allowShorts' => false], 'meta' => ['symbol' => 'BTCUSD', 'timeframe' => '4h']],
    Backtester::simulate(new MomentumStrategy(), candle_seq(closes_impulse(260)), ['warmupBars' => 80, 'initialEquity' => 25000.0, 'spreadBps' => 3.0, 'slippageBps' => 2.0, 'feeBps' => 7.0, 'riskPct' => 0.005, 'maxBarsInTrade' => 40, 'allowShorts' => false], ['symbol' => 'BTCUSD', 'timeframe' => '4h']));

golden('simulate the same momentum impulse with shorts allowed — the SELL executes', 'backtestSimulate',
    ['strategy' => 'momentum', 'candles' => candle_seq(closes_impulse(260)), 'req' => ['warmupBars' => 80, 'initialEquity' => 25000.0, 'spreadBps' => 3.0, 'slippageBps' => 2.0, 'feeBps' => 7.0, 'riskPct' => 0.005, 'maxBarsInTrade' => 40, 'allowShorts' => true], 'meta' => ['symbol' => 'BTCUSD', 'timeframe' => '4h']],
    Backtester::simulate(new MomentumStrategy(), candle_seq(closes_impulse(260)), ['warmupBars' => 80, 'initialEquity' => 25000.0, 'spreadBps' => 3.0, 'slippageBps' => 2.0, 'feeBps' => 7.0, 'riskPct' => 0.005, 'maxBarsInTrade' => 40, 'allowShorts' => true], ['symbol' => 'BTCUSD', 'timeframe' => '4h']));

golden('simulate a squeeze that finally breaks out', 'backtestSimulate',
    ['strategy' => 'breakout', 'candles' => candle_seq(closes_breakout(240)), 'req' => $REQ, 'meta' => ['symbol' => 'AAPL', 'timeframe' => '1d']],
    Backtester::simulate(new BreakoutStrategy(), candle_seq(closes_breakout(240)), $REQ, ['symbol' => 'AAPL', 'timeframe' => '1d']));

golden('a flat series is the no-trade case — empty arrays, not errors', 'backtestSimulate',
    ['strategy' => 'trend-following', 'candles' => candle_seq(closes_flat(200)), 'req' => $REQ, 'meta' => $META],
    Backtester::simulate(new TrendFollowingStrategy(), candle_seq(closes_flat(200)), $REQ, $META));

/* ---------------------------------------------------------------- Metrics */

function trades_of(array $pnls, array $rms = null): array
{
    $out = [];
    foreach ($pnls as $i => $pnl) {
        $out[] = [
            'netPnl' => $pnl,
            'rMultiple' => $rms[$i] ?? ($pnl >= 0 ? 1.0 : -0.5),
            'fees' => ['totalCost' => abs($pnl) * 0.02 + 0.0613, 'slippageCost' => abs($pnl) * 0.007 + 0.0211],
        ];
    }
    return $out;
}

function curve_of(float $start, array $pnls): array
{
    $out = [];
    $eq = $start;
    foreach ($pnls as $i => $pnl) {
        $eq += $pnl;
        $out[] = ['time' => '2026-01-01T' . sprintf('%02d', $i % 24) . ':00:00.000Z', 'equity' => $eq];
    };
    return $out;
}

golden('metrics across a mixed six-trade book, hourly', 'computeMetrics',
    ['trades' => trades_of([120.75, -85.4043, 240.1111, -95.5555, 30.25, -10.1], [1.6, -1.2, 2.1, -1.0, 0.3, -0.05]), 'equityCurve' => curve_of(10000.0, [120.75, -85.4043, 240.1111, -95.5555, 30.25, -10.1, 0, 0]), 'initialEquity' => 10000.0, 'timeframe' => '1h', 'barsInMarket' => 14],
    Metrics::compute(trades_of([120.75, -85.4043, 240.1111, -95.5555, 30.25, -10.1], [1.6, -1.2, 2.1, -1.0, 0.3, -0.05]), curve_of(10000.0, [120.75, -85.4043, 240.1111, -95.5555, 30.25, -10.1, 0, 0]), 10000.0, '1h', 14));

golden('metrics of an all-win book — profitFactor and avgLoss stay null', 'computeMetrics',
    ['trades' => trades_of([50.5, 75.25, 25.125]), 'equityCurve' => curve_of(5000.0, [50.5, 75.25, 25.125, 10.5]), 'initialEquity' => 5000.0, 'timeframe' => '15m', 'barsInMarket' => 3],
    Metrics::compute(trades_of([50.5, 75.25, 25.125]), curve_of(5000.0, [50.5, 75.25, 25.125, 10.5]), 5000.0, '15m', 3));

golden('metrics of an empty book', 'computeMetrics',
    ['trades' => [], 'equityCurve' => [['time' => '2026-01-01T00:00:00.000Z', 'equity' => 10000.0], ['time' => '2026-01-01T01:00:00.000Z', 'equity' => 10000.0]], 'initialEquity' => 10000.0, 'timeframe' => '1h', 'barsInMarket' => 0],
    Metrics::compute([], [['time' => '2026-01-01T00:00:00.000Z', 'equity' => 10000.0], ['time' => '2026-01-01T01:00:00.000Z', 'equity' => 10000.0]], 10000.0, '1h', 0));

golden('metrics of one losing trade on a daily clock', 'computeMetrics',
    ['trades' => trades_of([-120.4043], [-0.8]), 'equityCurve' => curve_of(8000.0, [-120.4043]), 'initialEquity' => 8000.0, 'timeframe' => '1d', 'barsInMarket' => 1],
    Metrics::compute(trades_of([-120.4043], [-0.8]), curve_of(8000.0, [-120.4043]), 8000.0, '1d', 1));

golden('sharpe of a constant return series is null — zero stdev', 'sharpe',
    ['r' => [0.0011, 0.0011, 0.0011, 0.0011], 'barsPerYear' => 8760.0],
    Metrics::sharpe([0.0011, 0.0011, 0.0011, 0.0011], 8760.0));
golden('sharpe of one return is null', 'sharpe',
    ['r' => [0.01], 'barsPerYear' => 8760.0],
    Metrics::sharpe([0.01], 8760.0));
golden('sharpe across a mixed return series at the daily factor', 'sharpe',
    ['r' => [0.012, -0.008, 0.0031, -0.0027, 0.0111, 0.0, -0.0044], 'barsPerYear' => 365.0],
    Metrics::sharpe([0.012, -0.008, 0.0031, -0.0027, 0.0111, 0.0, -0.0044], 365.0));
golden('sortino across a mixed return series', 'sortino',
    ['r' => [0.012, -0.008, 0.0031, -0.0027, 0.0111, 0.0, -0.0044], 'barsPerYear' => 365.0],
    Metrics::sortino([0.012, -0.008, 0.0031, -0.0027, 0.0111, 0.0, -0.0044], 365.0));
golden('sortino with no downside is null on positive mean', 'sortino',
    ['r' => [0.01, 0.02, 0.005], 'barsPerYear' => 365.0],
    Metrics::sortino([0.01, 0.02, 0.005], 365.0));
golden('sortino of constant zeros is 0.0, not null — the legacy branch', 'sortino',
    ['r' => [0.0, 0.0, 0.0], 'barsPerYear' => 365.0],
    Metrics::sortino([0.0, 0.0, 0.0], 365.0));
golden('sortino of a single value is null', 'sortino',
    ['r' => [-0.02], 'barsPerYear' => 365.0],
    Metrics::sortino([-0.02], 365.0));

/* ---------------------------------------------------------------- Journal analytics */

function journal_pool(): array
{
    // 14 closed+open entries across two strategies, two markets, three symbols:
    // the groupBy branches, open-pending exclusion, null r_multiple handling and
    // the TEXT drawdown order all need a pool this shape to be visible.
    $rows = [
        ['id' => 'e01', 'strategy' => 'trend-following', 'market' => 'forex', 'symbol' => 'EURUSD', 'source' => 'backtest', 'direction' => 'LONG', 'pnl' => 155.25, 'r_multiple' => 1.9, 'ai_confidence' => 0.35, 'execution_time' => '2026-09-01T09:00:00.000Z', 'exit_time' => '2026-09-01T15:00:00.000Z'],
        ['id' => 'e02', 'strategy' => 'trend-following', 'market' => 'forex', 'symbol' => 'EURUSD', 'source' => 'backtest', 'direction' => 'LONG', 'pnl' => -80.4043, 'r_multiple' => -1.1, 'ai_confidence' => 0.55, 'execution_time' => '2026-09-02T09:00:00.000Z', 'exit_time' => '2026-09-02T15:00:00.000Z'],
        ['id' => 'e03', 'strategy' => 'mean-reversion', 'market' => 'forex', 'symbol' => 'EURUSD', 'source' => 'backtest', 'direction' => 'SHORT', 'pnl' => 40.5, 'r_multiple' => 0.6, 'ai_confidence' => 0.75, 'execution_time' => '2026-09-03T09:00:00.000Z', 'exit_time' => '2026-09-03T15:00:00.000Z'],
        ['id' => 'e04', 'strategy' => 'mean-reversion', 'market' => 'forex', 'symbol' => 'EURUSD', 'source' => 'backtest', 'direction' => 'SHORT', 'pnl' => -20.2, 'r_multiple' => -0.4, 'ai_confidence' => 0.85, 'execution_time' => '2026-09-04T09:00:00.000Z', 'exit_time' => '2026-09-04T15:00:00.000Z'],
        ['id' => 'e05', 'strategy' => 'momentum', 'market' => 'crypto', 'symbol' => 'BTCUSD', 'source' => 'paper', 'direction' => 'LONG', 'pnl' => 260.75, 'r_multiple' => 2.2, 'ai_confidence' => 0.9, 'execution_time' => '2026-09-05T09:00:00.000Z', 'exit_time' => '2026-09-05T15:00:00.000Z'],
        ['id' => 'e06', 'strategy' => 'momentum', 'market' => 'crypto', 'symbol' => 'BTCUSD', 'source' => 'paper', 'direction' => 'LONG', 'pnl' => -150.5555, 'r_multiple' => null, 'ai_confidence' => 0.95, 'execution_time' => '2026-09-06T09:00:00.000Z', 'exit_time' => '2026-09-06T15:00:00.000Z'],
        ['id' => 'e07', 'strategy' => 'trend-following', 'market' => 'stock', 'symbol' => 'AAPL', 'source' => 'paper', 'direction' => 'LONG', 'pnl' => 10.1, 'r_multiple' => 0.1, 'ai_confidence' => null, 'execution_time' => '2026-09-07T09:00:00.000Z', 'exit_time' => '2026-09-07T15:00:00.000Z'],
        ['id' => 'e08', 'strategy' => 'breakout', 'market' => 'stock', 'symbol' => 'AAPL', 'source' => 'backtest', 'direction' => 'LONG', 'pnl' => 90.6667, 'r_multiple' => 1.5, 'ai_confidence' => 0.62, 'execution_time' => '2026-09-08T09:00:00.000Z', 'exit_time' => '2026-09-08T15:00:00.000Z'],
        ['id' => 'e09', 'strategy' => 'breakout', 'market' => 'stock', 'symbol' => 'AAPL', 'source' => 'backtest', 'direction' => 'LONG', 'pnl' => null, 'r_multiple' => null, 'ai_confidence' => 0.48, 'execution_time' => '2026-09-09T09:00:00.000Z', 'exit_time' => null],
        ['id' => 'e10', 'strategy' => 'trend-following', 'market' => 'forex', 'symbol' => 'GBPUSD', 'source' => 'backtest', 'direction' => 'LONG', 'pnl' => -30.3030, 'r_multiple' => -0.5, 'ai_confidence' => 0.42, 'execution_time' => '2026-09-10T09:00:00.000Z', 'exit_time' => '2026-09-10T15:00:00.000Z'],
        ['id' => 'e11', 'strategy' => 'mean-reversion', 'market' => 'forex', 'symbol' => 'GBPUSD', 'source' => 'paper', 'direction' => 'SHORT', 'pnl' => 120.1212, 'r_multiple' => 1.3, 'ai_confidence' => 0.78, 'execution_time' => '2026-09-11T09:00:00.000Z', 'exit_time' => '2026-09-11T15:00:00.000Z'],
        ['id' => 'e12', 'strategy' => 'momentum', 'market' => 'crypto', 'symbol' => 'BTCUSD', 'source' => 'paper', 'direction' => 'LONG', 'pnl' => null, 'r_multiple' => null, 'ai_confidence' => null, 'execution_time' => '2026-09-12T09:00:00.000Z', 'exit_time' => null],
        ['id' => 'e13', 'strategy' => 'breakout', 'market' => 'stock', 'symbol' => 'AAPL', 'source' => 'paper', 'direction' => 'SHORT', 'pnl' => -5.0505, 'r_multiple' => -0.1, 'ai_confidence' => 0.3, 'execution_time' => '2026-09-13T09:00:00.000Z', 'exit_time' => '2026-09-13T15:00:00.000Z'],
        ['id' => 'e14', 'strategy' => 'trend-following', 'market' => 'forex', 'symbol' => 'EURUSD', 'source' => 'paper', 'direction' => 'SHORT', 'pnl' => 60.6111, 'r_multiple' => 0.8, 'ai_confidence' => 0.92, 'execution_time' => '2026-09-14T09:00:00.000Z', 'exit_time' => '2026-09-14T15:00:00.000Z'],
    ];
    return $rows;
}

golden('journal bucket metrics over the mixed pool', 'bucketMetrics',
    ['entries' => journal_pool()],
    Analytics::bucketMetrics(journal_pool()));
golden('journal bucket metrics of a wins-only list — profitFactor and avgLoss null, totalPnl numeric', 'bucketMetrics',
    ['entries' => [journal_pool()[0], journal_pool()[4]]],
    Analytics::bucketMetrics([journal_pool()[0], journal_pool()[4]]));
golden('journal bucket metrics of an empty list — totalPnl is 0, the legacy asymmetry', 'bucketMetrics',
    ['entries' => []],
    Analytics::bucketMetrics([]));

golden('analyze grouped by strategy', 'analyze',
    ['entries' => journal_pool(), 'groupBy' => 'strategy'],
    Analytics::analyze(journal_pool(), 'strategy'));
golden('analyze grouped by confidence — buckets carry the en dash, the note fires when untagged', 'analyze',
    ['entries' => [journal_pool()[6], journal_pool()[11]], 'groupBy' => 'confidence'],
    Analytics::analyze([journal_pool()[6], journal_pool()[11]], 'confidence'));
golden('analyze grouped by confidence with tagged entries in all four buckets', 'analyze',
    ['entries' => [journal_pool()[0], journal_pool()[1], journal_pool()[2], journal_pool()[4], journal_pool()[12]], 'groupBy' => 'confidence'],
    Analytics::analyze([journal_pool()[0], journal_pool()[1], journal_pool()[2], journal_pool()[4], journal_pool()[12]], 'confidence'));
golden('analyze grouped by source', 'analyze',
    ['entries' => journal_pool(), 'groupBy' => 'source'],
    Analytics::analyze(journal_pool(), 'source'));

golden('calibration below the 30-trade bar is never a verdict', 'calibration',
    ['entries' => journal_pool()],
    Analytics::calibration(journal_pool()));

// A sufficient, deliberately NON-monotonic pool: high-confidence losers at the top
// bucket drag its win rate below the moderate one, tripping legacy's verdict.
function calibration_pool(): array
{
    $rows = [];
    for ($i = 0; $i < 40; $i++) {
        $conf = [0.35, 0.5, 0.7, 0.92][$i % 4];
        $win = ($i % 4 === 0 && $i % 8 === 0) || ($i % 4 !== 0 && $i % 5 !== 0);
        $rows[] = [
            'id' => sprintf('c%02d', $i),
            'pnl' => $win ? 100.0 + $i : -50.0 - $i,
            'r_multiple' => $win ? 1.0 : -0.5,
            'ai_confidence' => $conf,
            'execution_time' => '2026-09-01T00:00:00.000Z',
            'exit_time' => '2026-09-02T00:00:00.000Z',
        ];
    }
    return $rows;
}
golden('calibration on 40 trades with a non-monotonic ladder — the skeptic verdict', 'calibration',
    ['entries' => calibration_pool()],
    Analytics::calibration(calibration_pool()));

/* -------------------------------------------------------------------- payload */

echo json_encode([
    'php' => ['version' => phpversion(), 'sapi' => PHP_SAPI],
    'cases' => $cases,
], JSON_PRESERVE_ZERO_FRACTION);
