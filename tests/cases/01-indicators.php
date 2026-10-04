<?php
/** Indicator math — ported fixtures (hand-computed values). */
use Aegis\Indicators;

test('sma computes windowed means with leading nulls', function () {
    assert_equals([null, null, 2.0, 3.0, 4.0], Indicators::sma([1, 2, 3, 4, 5], 3));
});

test('ema seeds with SMA then applies the multiplier', function () {
    $out = Indicators::ema([1, 2, 3, 4, 5], 3);
    assert_equals([null, null, 2.0, 3.0, 4.0], $out);
});

test('rsi: 100 on pure gains, 0 on pure losses, bounded oscillation on alternation', function () {
    $up = Indicators::rsi(range(100, 130), 14);
    for ($i = 15; $i < count($up); $i++) assert_close(100, $up[$i], 1e-9);
    $down = Indicators::rsi(range(130, 100), 14);
    for ($i = 15; $i < count($down); $i++) assert_close(0, $down[$i], 1e-9);
    $alt = [];
    for ($i = 0; $i < 31; $i++) $alt[] = $i % 2 === 0 ? 100.0 : 101.0;
    $r = Indicators::rsi($alt, 14);
    for ($i = 15; $i < 31; $i++) assert_true(abs($r[$i] - 50) < 5, "RSI should oscillate near 50, got {$r[$i]}");
});

test('macd histogram = macd - signal, positive in an exponential uptrend', function () {
    $closes = [];
    for ($i = 0; $i < 80; $i++) $closes[] = 100 * pow(1.01, $i);
    $m = Indicators::macd($closes);
    $last = 79;
    assert_close($m['macd'][$last] - $m['signal'][$last], $m['histogram'][$last], 1e-6);
    assert_true($m['macd'][$last] > $m['signal'][$last]);
});

test('bollinger matches hand-computed SMA ± 2σ', function () {
    $closes = range(1.0, 20.0);
    $bb = Indicators::bollinger($closes, 20, 2);
    $mean = 10.5; $sd = sqrt(33.25);
    assert_close(10.5, $bb['mid'][19], 1e-9);
    assert_close($mean + 2 * $sd, $bb['upper'][19], 1e-6);
    assert_close($mean - 2 * $sd, $bb['lower'][19], 1e-6);
});

test('atr equals constant range with no gaps', function () {
    $candles = [];
    for ($i = 0; $i < 30; $i++) {
        $candles[] = ['timestamp' => $i * 3600000, 'open' => 101, 'high' => 102, 'low' => 100, 'close' => 101, 'volume' => 1];
    }
    assert_close(2.0, Indicators::last(Indicators::atr($candles, 14)), 1e-9);
});

test('adx bounded and +DI dominates in an uptrend', function () {
    $candles = [];
    for ($i = 0; $i < 80; $i++) {
        $open = 100 + $i * 0.7; $close = $open + 0.6;
        $candles[] = ['timestamp' => $i * 3600000, 'open' => $open, 'high' => $close + 0.2, 'low' => $open - 0.2, 'close' => $close, 'volume' => 1];
    }
    $adx = Indicators::adx($candles, 14);
    $last = 79;
    assert_true($adx['adx'][$last] > 0 && $adx['adx'][$last] <= 100);
    assert_true($adx['plusDi'][$last] > $adx['minusDi'][$last]);
});

test('vwap cumulative typical-price average; null on zero volume', function () {
    $c1 = ['timestamp' => 0, 'open' => 10, 'high' => 10, 'low' => 9, 'close' => 9.5, 'volume' => 100];
    $c2 = ['timestamp' => 1, 'open' => 10.5, 'high' => 11, 'low' => 10, 'close' => 10.5, 'volume' => 100];
    $v = Indicators::vwap([$c1, $c2]);
    assert_close(9.5, $v[0], 1e-9);
    assert_close(10.0, $v[1], 1e-9);
    assert_equals([null], Indicators::vwap([['timestamp' => 0, 'open' => 1, 'high' => 2, 'low' => 0.5, 'close' => 1.5, 'volume' => 0]]));
});

test('classic floor-trader pivots', function () {
    $p = Indicators::pivotPoints(['high' => 10, 'low' => 8, 'close' => 9]);
    assert_close(9, $p['p'], 1e-9);
    assert_close(10, $p['r1'], 1e-9);
    assert_close(8, $p['s1'], 1e-9);
    assert_close(11, $p['r2'], 1e-9);
    assert_close(7, $p['s2'], 1e-9);
    assert_close(12, $p['r3'], 1e-9);
    assert_close(6, $p['s3'], 1e-9);
});

test('fractal swing detection finds the peak', function () {
    $highs = [10, 11, 11.5, 11.8, 12, 11.5, 11, 10.5, 10, 9.5, 9, 8, 8.5, 9, 9.5, 10];
    $candles = [];
    foreach ($highs as $i => $h) {
        $candles[] = ['timestamp' => $i * 3600000, 'open' => $h - 0.5, 'high' => $h, 'low' => $h - 1.5, 'close' => $h - 0.6, 'volume' => 1];
    }
    $swings = Indicators::findSwings($candles, 2);
    $high = null;
    foreach ($swings as $s) if ($s['type'] === 'high') $high = $s;
    assert_equals(4, $high['index']);
    assert_close(12.0, (float)$high['price'], 1e-9);
});

test('regression slope normalized by price level', function () {
    $closes = [];
    for ($i = 0; $i < 60; $i++) $closes[] = 100 + $i; // slope 1/bar
    assert_close(100 / 134.5, Indicators::regressionSlopePct($closes, 50), 1e-9);
});
