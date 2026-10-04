<?php
/** Agents: honesty rules, structure confirmation, consensus. */
use Aegis\Agents\CryptoAgent;
use Aegis\Agents\ForexAgent;
use Aegis\Agents\MarketStructureAgent;
use Aegis\Agents\SentimentAgent;
use Aegis\Agents\TechnicalAgent;
use Aegis\Agents\TradingIntelligenceAgent;
use Aegis\Providers\SyntheticProvider;

test('technical agent returns the full structured report', function () {
    $series = fx_series(SyntheticProvider::generate('EURUSD', '1h', 300, 1755000000000));
    $report = (new TechnicalAgent())->analyze(fx_ctx($series));
    assert_equals('technical', $report['agent']);
    assert_not_null_or($report['indicators']['rsi14']);
    assert_true(count($report['signals']) >= 7);
    assert_true(abs($report['vote']['directionalScore']) <= 1);
    assert_true($report['dataQuality'] > 0);
});

function assert_not_null_or($v): void { assert_true($v !== null, 'expected non-null'); }

test('technical agent refuses empty candle series', function () {
    assert_throws(RuntimeException::class, fn () => (new TechnicalAgent())->analyze(fx_ctx(fx_series([]))));
});

test('market structure agent refuses empty candle series', function () {
    assert_throws(RuntimeException::class, fn () => (new MarketStructureAgent())->analyze(fx_ctx(fx_series([]))));
});

test('market structure: wick beyond a swing NEVER confirms (close rule)', function () {
    $candles = [];
    $rand = \Aegis\MathUtils::seededRandom(3);
    for ($i = 0; $i < 60; $i++) {
        $close = 100 + 1.5 * sin($i / 3) + ($rand() - 0.5) * 0.1;
        $prev = $i > 0 ? 100 + 1.5 * sin(($i - 1) / 3) : $close;
        $candles[] = [
            'timestamp' => 1755000000000 - (61 - $i) * 3600000,
            'open' => $prev,
            'high' => max($prev, $close) + 0.05 + 0.04 * sin($i * 1.3),
            'low' => min($prev, $close) - 0.05 - 0.04 * cos($i * 1.3),
            'close' => $close, 'volume' => 50,
        ];
    }
    $swingHigh = max(array_map(fn($c) => $c['high'], $candles));
    $last = end($candles);
    $candles[] = ['timestamp' => $last['timestamp'] + 3600000, 'open' => 100.1, 'high' => $swingHigh + 0.5, 'low' => 100.0, 'close' => 100.1, 'volume' => 80];
    $report = (new MarketStructureAgent())->analyze(fx_ctx(fx_series($candles)));
    assert_true($report['events']['breakOfStructure']['detected']);
    assert_equals('WICK', $report['events']['breakOfStructure']['confirmedBy']);
    assert_true(count(array_filter($report['warnings'], fn($w) => stripos($w, 'wick') !== false)) > 0);

    // closing beyond with a real body confirms
    $candles[count($candles) - 1] = ['timestamp' => $last['timestamp'] + 3600000, 'open' => 100.8, 'high' => $swingHigh + 0.5, 'low' => 100.6, 'close' => $swingHigh + 0.3, 'volume' => 120];
    $report2 = (new MarketStructureAgent())->analyze(fx_ctx(fx_series($candles)));
    assert_equals('CLOSE', $report2['events']['breakOfStructure']['confirmedBy']);
});

test('forex agent: macro unavailable + price-momentum strength', function () {
    $series = fx_series(SyntheticProvider::generate('EURUSD', '1h', 200, 1755000000000), 'EURUSD', 'forex');
    $report = (new ForexAgent())->analyze(fx_ctx($series));
    assert_false($report['macro']['available']);
    assert_contains('No economic-calendar', $report['macro']['reason']);
    assert_equals('price-momentum', $report['currencyStrength']['derivedFrom']);
    assert_equals('major', $report['pair']['classification']);
});

test('crypto agent: on-chain/derivatives/dominance honestly unavailable', function () {
    $series = fx_series(SyntheticProvider::generate('BTCUSDT', '1h', 200, 1755000000000), 'BTCUSDT', 'crypto');
    $report = (new CryptoAgent())->analyze(fx_ctx($series));
    assert_equals(['dataAvailable' => false, 'warning' => 'On-chain provider not configured'], $report['onChain']);
    assert_false($report['derivatives']['dataAvailable']);
    assert_false($report['marketDominance']['dataAvailable']);
    assert_not_null_or($report['priceAction']['changePct24h']);
});

test('sentiment agent abstains without providers', function () {
    $report = (new SentimentAgent())->analyze(fx_ctx(fx_series(fx_candles(100))));
    assert_false($report['vote']['votes']);
    assert_false($report['news']['available']);
    assert_false($report['social']['available']);
});

test('intelligence consensus: agreement, conflicts and NO_TRADE gates', function () {
    $mk = fn(float $score, float $dq, bool $votes = true) => [
        'agent' => 'a' . uniqid(), 'title' => 'A', 'dataQuality' => $dq,
        'dataLimitations' => [], 'warnings' => [],
        'vote' => ['directionalScore' => $score, 'signal' => $score > 0.15 ? 'BUY' : ($score < -0.15 ? 'SELL' : 'NEUTRAL'), 'weight' => 1, 'votes' => $votes, 'reason' => 'r'],
    ];
    $strong = (new TradingIntelligenceAgent())->combine([$mk(0.6, 0.9), $mk(0.5, 0.9), $mk(0.4, 0.9), $mk(-0.2, 0.9)], ['dataQuality' => 0.9, 'regimeClarity' => 0.7, 'freshnessFactor' => 1.0]);
    assert_equals('BULLISH', $strong['bias']);
    assert_true($strong['confidence'] > 0.5);
    assert_true(count($strong['consensus']['conflicts']) === 1);

    $mixed = (new TradingIntelligenceAgent())->combine([$mk(0.05, 0.9), $mk(-0.05, 0.9)], ['dataQuality' => 0.9, 'regimeClarity' => 0.5, 'freshnessFactor' => 1.0]);
    assert_equals('NEUTRAL', $mixed['bias']);
    assert_equals('HOLD', $mixed['recommendation']);

    $gated = (new TradingIntelligenceAgent())->combine([$mk(0.8, 0.9)], ['dataQuality' => 0.3, 'regimeClarity' => 0.5, 'freshnessFactor' => 1.0]);
    assert_equals('NO_TRADE', $gated['bias']);
});
