<?php
/**
 * PHASE 6 — Strategy Optimizer: grid search with walk-forward verification
 * (in-sample 70% / out-of-sample 30%) and variant registration governance.
 */
use Aegis\Optimization\StrategyOptimizer;
use Aegis\Strategies\VersionedStrategyDecorator;
use function Aegis\Strategies\builtinStrategyFactory;

/** Deterministic candle fixture: trend slope + sine wiggle + tiny noise. */
function opt_series(int $n, float $slope, float $wiggle, int $seed = 7): array
{
    $rand = \Aegis\MathUtils::seededRandom($seed);
    $candles = [];
    $price = 100.0;
    for ($i = 0; $i < $n; $i++) {
        $close = $price + $slope + $wiggle * sin($i / 6) + ($rand() - 0.5) * 0.05;
        $open = $price;
        $high = max($open, $close) + 0.15 + $rand() * 0.1;
        $low = min($open, $close) - 0.15 - $rand() * 0.1;
        $candles[] = [
            'timestamp' => 1755000000000 + $i * 3600000,
            'open' => $open, 'high' => $high, 'low' => $low, 'close' => $close, 'volume' => 100 + $rand() * 50,
        ];
        $price = $close;
    }
    return $candles;
}

test('optimizer runs the declared grid and reports the walk-forward split', function () {
    $factory = builtinStrategyFactory('trend-following');
    assert_not_null($factory);
    $report = StrategyOptimizer::optimize(
        $factory,
        ['fast' => 20, 'slow' => 50, 'adxMin' => 25, 'stopAtr' => 2, 'targetR' => 3],
        $factory(['fast' => 20, 'slow' => 50, 'adxMin' => 25, 'stopAtr' => 2, 'targetR' => 3])->paramGrid(),
        opt_series(600, 0.08, 0.4)
    );
    // trend grid: 2 fast × 3 slow × 2 adx × 1 stop × 2 target = 24 combinations
    assert_equals(24, $report['searchSpace']['gridSize']);
    assert_equals(420 + 180, $report['split']['inSampleBars'] + $report['split']['outOfSampleBars']);
    assert_not_null($report['baseline']['inSample']);
    assert_not_null($report['baseline']['outOfSample']);
    assert_true(count($report['finalists']) <= 3);
    foreach ($report['finalists'] as $f) {
        assert_not_null($f['inSample']);
        assert_not_null($f['outOfSample']);
        if ($f['survives']) {
            assert_true($f['outOfSample']['trades'] >= 5);
            assert_true($f['outOfSample']['profitFactor'] > 1);
            assert_true($f['outOfSample']['expectancyR'] > 0);
        }
    }
    // adoption REQUIRES out-of-sample survival
    if ($report['recommendation']['adopt']) {
        $adopted = null;
        foreach ($report['finalists'] as $f) {
            if ($f['params'] === $report['recommendation']['params']) $adopted = $f;
        }
        assert_not_null($adopted);
        assert_true($adopted['survives']);
    }
    assert_contains('never recommended', $report['methodNote']);
});

test('optimizer is deterministic for identical inputs', function () {
    $factory = builtinStrategyFactory('trend-following');
    $grid = $factory([])->paramGrid();
    $a = StrategyOptimizer::optimize($factory, ['fast' => 20, 'slow' => 50, 'adxMin' => 25, 'stopAtr' => 2, 'targetR' => 3], $grid, opt_series(500, 0.1, 0.5));
    $b = StrategyOptimizer::optimize($factory, ['fast' => 20, 'slow' => 50, 'adxMin' => 25, 'stopAtr' => 2, 'targetR' => 3], $grid, opt_series(500, 0.1, 0.5));
    assert_equals(json_encode($a['recommendation']), json_encode($b['recommendation']));
    assert_equals($a['baseline']['inSample']['totalReturnPct'], $b['baseline']['inSample']['totalReturnPct']);
});

test('optimizer refuses short histories instead of overfitting a sliver', function () {
    $factory = builtinStrategyFactory('momentum');
    assert_throws(InvalidArgumentException::class, function () use ($factory) {
        StrategyOptimizer::optimize($factory, [], $factory([])->paramGrid(), opt_series(300, 0.1, 0.3));
    });
});

test('overfit collapse is flagged when in-sample profit dies out-of-sample', function () {
    $factory = builtinStrategyFactory('trend-following');
    // strong trend for the first 70%, flat chop afterwards: whatever wins
    // in-sample must prove itself on the flat tail
    $trend = opt_series(420, 0.15, 0.25);
    $flat = opt_series(180, 0.0, 0.9, seed: 11);
    $report = StrategyOptimizer::optimize($factory, ['fast' => 20, 'slow' => 50, 'adxMin' => 25, 'stopAtr' => 2, 'targetR' => 3],
        $factory([])->paramGrid(), array_merge($trend, $flat));
    foreach ($report['finalists'] as $f) {
        if (($f['inSample']['profitFactor'] ?? 0) > 1 && ($f['outOfSample']['profitFactor'] ?? 0) <= 1) {
            assert_true(count($report['overfitWarnings']) >= 1);
            return;
        }
    }
    // nothing collapsed → adoption must still have survived verification
    assert_true($report['recommendation']['adopt'] === false || count(array_filter($report['finalists'], fn($f) => $f['survives'])) > 0);
});

test('platform registers an adopted variant with the ai-source governance', function () {
    $p = platform();
    $report = $p->optimizeStrategy([
        'strategyId' => 'trend-following', 'symbol' => 'BTCUSDT', 'marketClass' => 'crypto',
        'timeframe' => '1h', 'limit' => 600, 'register' => true,
    ]);
    assert_not_null($report['recommendation'] ?? null);
    if ($report['recommendation']['adopt'] && !empty($report['registeredVariant'])) {
        $v = $report['registeredVariant'];
        $record = $p->model->strategies->find('trend-following', $v['version']);
        assert_not_null($record, 'variant persisted');
        assert_equals('ai', $record['source']);
        assert_equals('DRAFT', $record['lifecycle']);
        // AI-source rule: paper stage blocked without human sign-off
        $record['lifecycle'] = 'RISK_REVIEWED'; // seed the stage directly to reach the paper gate
        $record['updated_at'] = gmdate('c');
        $p->model->strategies->save($record);
        $gate = $p->strategies->transition('trend-following', $v['version'], 'PAPER_TRADING');
        assert_false($gate['ok']);
        assert_contains('AI-generated strategies require manual human risk sign-off', implode(';', $gate['reasons']));
        // and the variant is executable through the registry
        $impl = $p->strategies->implementation('trend-following', $v['version']);
        assert_not_null($impl);
        assert_true($impl instanceof VersionedStrategyDecorator);
        assert_equals($report['recommendation']['params']['fast'] ?? $impl->params()['fast'], $impl->params()['fast']);
    } else {
        // honest path: nothing beat the baseline out-of-sample — no variant
        assert_equals(null, $report['registeredVariant'] ?? null);
        assert_contains('keep current parameters', $report['recommendation']['reason']);
    }
});
