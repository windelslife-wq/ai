<?php
/** Research-only portfolio optimization and its long-only allocation constraints. */
use Aegis\Optimization\PortfolioOptimizer;

/** @return array<string,mixed> */
function fx_portfolio_optimizer_asset(string $symbol, array $periodReturns, int $offset = 0, string $marketClass = 'crypto'): array
{
    $price = 100.0;
    $candles = [];
    $start = 1800000000000 + $offset * 86400000;
    $candles[] = ['timestamp' => $start, 'close' => $price];
    foreach ($periodReturns as $i => $periodReturn) {
        $price *= 1.0 + $periodReturn;
        $candles[] = ['timestamp' => $start + ($i + 1) * 86400000, 'close' => $price];
    }
    return [
        'symbol' => $symbol,
        'marketClass' => $marketClass,
        'candles' => $candles,
        'provenance' => ['source' => 'fixture', 'synthetic' => false],
    ];
}

test('portfolio optimizer returns constrained research allocations and benchmark portfolios', function () {
    $lowVol = [];
    $highVol = [];
    for ($i = 0; $i < 100; $i++) {
        $direction = $i % 2 === 0 ? 1 : -1;
        $lowVol[] = 0.001 + $direction * 0.0008;
        $highVol[] = 0.001 + $direction * 0.018;
    }
    $report = PortfolioOptimizer::optimize([
        fx_portfolio_optimizer_asset('LOW', $lowVol),
        fx_portfolio_optimizer_asset('HIGH', $highVol),
    ], ['objective' => 'min_variance', 'maxWeight' => 0.75, 'periodsPerYear' => 252]);

    assert_equals('RESEARCH_ONLY', $report['status']);
    assert_equals('min_variance', $report['objective']);
    assert_equals(100, $report['window']['returnObservations']);
    assert_equals(101, $report['window']['alignedPriceObservations']);
    assert_true($report['allocations']['selected']['weights']['LOW'] > $report['allocations']['selected']['weights']['HIGH']);
    assert_true($report['allocations']['selected']['weights']['LOW'] <= 0.75 + 1.0e-9);
    assert_true($report['allocations']['selected']['weights']['HIGH'] >= -1.0e-12);
    assert_close(1.0, array_sum($report['allocations']['selected']['weights']), 1.0e-9);
    assert_true($report['allocations']['selected']['volatilityAnnualized'] <= $report['allocations']['equalWeightBenchmark']['volatilityAnnualized']);
    assert_true($report['assets'][0]['volatilityAnnualized'] < $report['assets'][1]['volatilityAnnualized']);
    assert_true(isset($report['correlations']['LOW']['HIGH']));
    assert_contains('not investment advice', $report['disclaimer']);
});

test('maximum-Sharpe allocation is no worse than equal weighting and respects the cap', function () {
    $steady = [];
    $noisy = [];
    for ($i = 0; $i < 120; $i++) {
        $steady[] = 0.0014 + ($i % 2 === 0 ? 0.0004 : -0.0004);
        $noisy[] = 0.0030 + ($i % 3 === 0 ? 0.025 : ($i % 3 === 1 ? -0.020 : 0.0));
    }
    $report = PortfolioOptimizer::optimize([
        fx_portfolio_optimizer_asset('STEADY', $steady),
        fx_portfolio_optimizer_asset('NOISY', $noisy),
        fx_portfolio_optimizer_asset('DIVERSIFIER', array_map(fn($r) => -0.0002 + $r * 0.25, $steady)),
    ], ['objective' => 'max_sharpe', 'maxWeight' => 0.6, 'periodsPerYear' => 252]);

    $selected = $report['allocations']['selected'];
    $benchmark = $report['allocations']['equalWeightBenchmark'];
    assert_true($selected['sharpeRatio'] >= $benchmark['sharpeRatio'] - 1.0e-8);
    assert_close(1.0, array_sum($selected['weights']), 1.0e-9);
    foreach ($selected['weights'] as $weight) {
        assert_true($weight >= -1.0e-12);
        assert_true($weight <= 0.6 + 1.0e-9);
    }
    assert_true($report['allocations']['minimumVariance']['volatilityAnnualized'] > 0);
});

test('portfolio optimizer aligns timestamps and discloses excluded observations', function () {
    $returnsA = array_fill(0, 90, 0.001);
    $returnsB = array_fill(0, 90, 0.0005);
    $report = PortfolioOptimizer::optimize([
        fx_portfolio_optimizer_asset('AAA', $returnsA),
        fx_portfolio_optimizer_asset('BBB', $returnsB, 10),
    ], ['objective' => 'min_variance', 'periodsPerYear' => 252]);

    assert_equals(81, $report['window']['alignedPriceObservations']);
    assert_equals(80, $report['window']['returnObservations']);
    assert_true(count(array_filter($report['warnings'], fn($warning) => str_contains($warning, 'timestamps shared'))) === 1);
});

test('portfolio optimizer rejects malformed universes, short history and impossible caps', function () {
    $returns = array_fill(0, 40, 0.001);
    $assetA = fx_portfolio_optimizer_asset('AAA', $returns);
    $assetB = fx_portfolio_optimizer_asset('BBB', $returns);

    assert_throws(InvalidArgumentException::class, fn() => PortfolioOptimizer::optimize([$assetA]));
    assert_throws(InvalidArgumentException::class, fn() => PortfolioOptimizer::optimize([$assetA, $assetA]));
    assert_throws(InvalidArgumentException::class, fn() => PortfolioOptimizer::optimize([$assetA, $assetB], ['maxWeight' => 0.49]));
    assert_throws(InvalidArgumentException::class, fn() => PortfolioOptimizer::optimize([$assetA, $assetB], ['objective' => 'max_return']));
    assert_throws(InvalidArgumentException::class, fn() => PortfolioOptimizer::optimize([
        fx_portfolio_optimizer_asset('SHORT_A', array_fill(0, 20, 0.001)),
        fx_portfolio_optimizer_asset('SHORT_B', array_fill(0, 20, 0.002)),
    ]));
});

test('portfolio optimizer API and workspace console are routed, protected and documented honestly', function () {
    require_once FCPATH . 'application/controllers/Api_portfolio.php';
    require_once FCPATH . 'application/controllers/Portfolio.php';
    $routes = file_get_contents(FCPATH . 'application/config/routes.php');
    $api = file_get_contents(FCPATH . 'application/controllers/Api_portfolio.php');
    $page = file_get_contents(FCPATH . 'application/views/portfolio/optimizer.php');
    $script = file_get_contents(FCPATH . 'assets/js/portfolio-optimizer.js');
    $featureMatrix = file_get_contents(FCPATH . 'application/controllers/Api_system.php');

    assert_contains('$route[\'api/portfolio/optimize\'] = \'api_portfolio/optimize\';', $routes);
    assert_contains('$route[\'portfolio\'] = \'portfolio/index\';', $routes);
    assert_contains("requirePermission('trading.view')", $api);
    assert_contains('data-endpoint="/api/portfolio/optimize"', $page);
    assert_contains('X-CSRF-Token', $script);
    assert_contains('allowSyntheticData', $script);
    assert_contains('Portfolio optimizer (Phase 6)', $featureMatrix);
    assert_true(method_exists(\Aegis\Platform::class, 'optimizePortfolio'));
});
