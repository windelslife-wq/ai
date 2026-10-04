<?php
/** Strategies + SeriesView look-ahead protection. */
use Aegis\Strategies\BreakoutStrategy;
use Aegis\Strategies\LookAheadError;
use Aegis\Strategies\MeanReversionStrategy;
use Aegis\Strategies\MomentumStrategy;
use Aegis\Strategies\SeriesView;
use Aegis\Strategies\TrendFollowingStrategy;

test('series view throws on future access', function () {
    $view = new SeriesView(fx_candles(100), SeriesView::precompute(fx_candles(100)), 60, ['symbol' => 'T', 'timeframe' => '1h', 'marketClass' => 'crypto']);
    assert_equals(fx_candles(100)[61]['close'] ?? null === null ? true : true, true); // sanity
    assert_throws(LookAheadError::class, fn () => $view->close(61));
    assert_throws(LookAheadError::class, fn () => $view->ema20(99));
    assert_throws(LookAheadError::class, fn () => $view->highestHigh(10, 70));
});

test('series view indicators are causal (equal to fresh prefix computation)', function () {
    $candles = fx_candles(120);
    $view = new SeriesView($candles, SeriesView::precompute($candles), 100, ['symbol' => 'T', 'timeframe' => '1h', 'marketClass' => 'crypto']);
    $fresh = \Aegis\Indicators::ema(array_map(fn($c) => $c['close'], array_slice($candles, 0, 101)), 20);
    assert_close($fresh[100], $view->ema20(100), 1e-9);
});

test('trend strategy fires BUY on a fresh EMA cross-up', function () {
    $candles = array_merge(
        array_map(fn($c) => $c + ['timestamp' => 0], array_slice(fx_candles(120, -0.2, 99), 0, 60)),
        array_map(fn($c) => $c + ['timestamp' => 0], fx_candles(140, 0.45, 42))
    );
    foreach ($candles as $i => $c) { $candles[$i]['timestamp'] = 1755000000000 - (count($candles) - $i) * 3600000; }
    $strat = new TrendFollowingStrategy();
    $ind = SeriesView::precompute($candles);
    $buys = 0;
    for ($i = 55; $i < count($candles); $i++) {
        $view = new SeriesView($candles, $ind, $i, ['symbol' => 'T', 'timeframe' => '1h', 'marketClass' => 'crypto']);
        $sig = $strat->evaluate(['view' => $view, 'position' => null, 'equity' => 10000]);
        if ($sig['action'] === 'BUY') {
            $buys++;
            assert_true($sig['stopLoss'] < $view->close());
            assert_true($sig['takeProfit'] > $view->close());
        }
    }
    assert_true($buys >= 1, "expected at least one BUY, got {$buys}");
});

test('mean reversion fires on band pierce with oversold RSI, and refuses in trends', function () {
    $candles = fx_noise_range(200);
    $last = end($candles);
    $candles[] = ['timestamp' => $last['timestamp'] + 3600000, 'open' => $last['close'], 'high' => $last['close'], 'low' => $last['close'] - 3.2, 'close' => $last['close'] - 3.0, 'volume' => 300];
    $ind = SeriesView::precompute($candles);
    $view = new SeriesView($candles, $ind, count($candles) - 1, ['symbol' => 'T', 'timeframe' => '1h', 'marketClass' => 'crypto']);
    $sig = (new MeanReversionStrategy())->evaluate(['view' => $view, 'position' => null, 'equity' => 10000]);
    assert_equals('BUY', $sig['action']);
    assert_contains('lower band', $sig['reason']);

    // strong trend -> ADX filter refuses to fade
    $trend = fx_candles(160, 0.5, 5, 0.2);
    $indT = SeriesView::precompute($trend);
    $viewT = new SeriesView($trend, $indT, count($trend) - 1, ['symbol' => 'T', 'timeframe' => '1h', 'marketClass' => 'crypto']);
    assert_equals('HOLD', (new MeanReversionStrategy())->evaluate(['view' => $viewT, 'position' => null, 'equity' => 10000])['action']);
});

test('breakout needs volume confirmation', function () {
    $candles = fx_noise_range(120);
    $ind0 = SeriesView::precompute($candles);
    $v0 = new SeriesView($candles, $ind0, count($candles) - 1, ['symbol' => 'T', 'timeframe' => '1h', 'marketClass' => 'crypto']);
    $rangeHigh = $v0->highestHigh(48, count($candles) - 1);
    $last = end($candles);
    $withVolume = array_merge($candles, [[
        'timestamp' => $last['timestamp'] + 3600000, 'open' => $last['close'],
        'high' => $rangeHigh + 1.5, 'low' => $last['close'] + 0.1, 'close' => $rangeHigh + 1.2, 'volume' => 600,
    ]]);
    $noVolume = array_merge($candles, [[
        'timestamp' => $last['timestamp'] + 3600000, 'open' => $last['close'],
        'high' => $rangeHigh + 1.5, 'low' => $last['close'] + 0.1, 'close' => $rangeHigh + 1.2, 'volume' => 10,
    ]]);
    $mkView = fn($cs) => new SeriesView($cs, SeriesView::precompute($cs), count($cs) - 1, ['symbol' => 'T', 'timeframe' => '1h', 'marketClass' => 'crypto']);
    assert_equals('BUY', (new BreakoutStrategy())->evaluate(['view' => $mkView($withVolume), 'position' => null, 'equity' => 10000])['action']);
    assert_equals('HOLD', (new BreakoutStrategy())->evaluate(['view' => $mkView($noVolume), 'position' => null, 'equity' => 10000])['action']);
});

test('momentum fires on strong ROC + rising MACD histogram, closes on flip', function () {
    $candles = fx_candles(180, 0.45, 11);
    $strat = new MomentumStrategy();
    $ind = SeriesView::precompute($candles);
    $buys = 0;
    for ($i = 60; $i < count($candles); $i++) {
        $view = new SeriesView($candles, $ind, $i, ['symbol' => 'T', 'timeframe' => '1h', 'marketClass' => 'crypto']);
        $sig = $strat->evaluate(['view' => $view, 'position' => null, 'equity' => 10000]);
        if ($sig['action'] === 'BUY') $buys++;
    }
    assert_true($buys >= 1);

    // CLOSE when histogram flips against an open long
    $mixed = array_merge(array_slice(fx_candles(80, 0.35, 21), 0, 80), fx_candles(120, -0.25, 33));
    foreach ($mixed as $i => $c) { $mixed[$i]['timestamp'] = 1755000000000 - (200 - $i) * 3600000; }
    $indM = SeriesView::precompute($mixed);
    $closed = false;
    for ($i = 60; $i < count($mixed) && !$closed; $i++) {
        $view = new SeriesView($mixed, $indM, $i, ['symbol' => 'T', 'timeframe' => '1h', 'marketClass' => 'crypto']);
        if (($view->macdHistogram($i) ?? 0) < 0) {
            $sig = $strat->evaluate(['view' => $view, 'position' => ['direction' => 'LONG', 'entryPrice' => $mixed[$i]['close'], 'entryBar' => $i - 10, 'stopLoss' => 0, 'takeProfit' => 0, 'unrealizedPnl' => 0], 'equity' => 10000]);
            if ($sig['action'] === 'CLOSE') $closed = true;
        }
    }
    assert_true($closed);
});

test('registry lifecycle gates', function () {
    $p = platform();
    $repo = $p->model->strategies;
    // no backtest -> BACKTESTED rejected
    $draft = $repo->find('trend-following', '1.0.0');
    assert_equals('DRAFT', $draft['lifecycle']);
    $r = $p->strategies->transition('trend-following', '1.0.0', 'VALIDATED');
    assert_false($r['ok']);
    assert_contains('Invalid transition', $r['reasons'][0]);
});
