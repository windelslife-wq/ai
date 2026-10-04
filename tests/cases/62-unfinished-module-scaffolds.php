<?php
/** Contract tests for the disabled-by-default unfinished-module scaffolds. */
use Aegis\Brokers\BinanceTradingConnector;
use Aegis\Brokers\Mt4BridgeConnector;
use Aegis\Lottery\OfficialLotteryProvider;
use Aegis\Providers\LicensedAssetMarketDataProvider;
use Aegis\ProviderManager;

function fx_scaffold_env(string $key, $value): void
{
    putenv($key . '=' . $value);
}

test('licensed asset providers stay disabled and cannot claim symbols by default', function () {
    $provider = new LicensedAssetMarketDataProvider('stock', 'stock-test', 'Test stocks', 'AEGIS_TEST_STOCK_DATA');
    assert_equals('DISABLED', $provider->healthCheck()['status']);
    assert_false($provider->supportsSymbol('AAPL'));
    assert_false($provider->capabilities()['licenseConfigured']);
});

test('licensed asset provider requires explicit license, symbols and enabled flag', function () {
    fx_scaffold_env('AEGIS_TEST_STOCK_DATA_LICENSE', 'contract-123');
    fx_scaffold_env('AEGIS_TEST_STOCK_DATA_SYMBOLS', 'AAPL, MSFT');
    try {
        $calls = [];
        $provider = new LicensedAssetMarketDataProvider(
            'stock', 'stock-test', 'Test stocks', 'AEGIS_TEST_STOCK_DATA',
            'https://feed.example/v1', true,
            'token-1',
            function (string $url, ?string $token) use (&$calls) {
                $calls[] = [$url, $token];
                if (str_ends_with($url, '/health')) return ['ok' => true, 'version' => 'feed-1'];
                if (str_contains($url, '/candles?')) return ['data' => ['candles' => [
                    ['timestamp' => 1700000000, 'open' => 100, 'high' => 105, 'low' => 99, 'close' => 104, 'volume' => 5000],
                ]]];
                return ['data' => ['symbol' => 'AAPL', 'last' => 104, 'bid' => 103.9, 'ask' => 104.1, 'timestamp' => 1700000000]];
            },
        );
        assert_true($provider->configured());
        assert_true($provider->supportsSymbol('aapl'));
        assert_false($provider->supportsSymbol('TSLA'));
        assert_equals('UP', $provider->healthCheck()['status']);
        assert_equals(104.0, $provider->getQuote('AAPL')['last']);
        assert_equals(1, count($provider->getCandles(['symbol' => 'AAPL', 'timeframe' => '1h', 'limit' => 10])));
        assert_equals('token-1', $calls[0][1]);
    } finally {
        putenv('AEGIS_TEST_STOCK_DATA_LICENSE');
        putenv('AEGIS_TEST_STOCK_DATA_SYMBOLS');
    }
});

test('provider manager routes market-class requests only to matching licensed adapters', function () {
    fx_scaffold_env('AEGIS_TEST_STOCK_DATA_LICENSE', 'contract-123');
    fx_scaffold_env('AEGIS_TEST_STOCK_DATA_SYMBOLS', 'AAPL');
    try {
        $stock = new LicensedAssetMarketDataProvider('stock', 'stock-test', 'Test stocks', 'AEGIS_TEST_STOCK_DATA', 'https://feed.example/v1', true, 'token', function (string $url, ?string $token) {
            $candles = [];
            $base = 1700000000000;
            for ($i = 0; $i < 35; $i++) {
                $candles[] = ['timestamp' => $base - (35 - $i) * 3600000, 'open' => 100 + $i * 0.1, 'high' => 101 + $i * 0.1, 'low' => 99 + $i * 0.1, 'close' => 100.5 + $i * 0.1, 'volume' => 10 + $i];
            }
            return ['data' => ['candles' => $candles]];
        });
        $pm = new ProviderManager();
        $pm->register($stock);
        assert_equals([], $pm->candidatesFor('AAPL', '1h', 'crypto'));
        assert_equals(1, count($pm->candidatesFor('AAPL', '1h', 'stock')));
        $series = $pm->getCandleSeries('AAPL', 'stock', '1h', 10);
        assert_equals('stock-test', $series['provenance']['source']);
        assert_false($series['provenance']['synthetic']);
    } finally {
        putenv('AEGIS_TEST_STOCK_DATA_LICENSE');
        putenv('AEGIS_TEST_STOCK_DATA_SYMBOLS');
    }
});

test('official lottery provider requires HTTPS authorization metadata and preserves source attribution', function () {
    $provider = new OfficialLotteryProvider('http://not-safe.example', true, 'token', 'license', 'official', fn(string $url, ?string $token) => ['ok' => true]);
    assert_equals('UNCONFIGURED', $provider->health()['state']);

    $calls = [];
    $provider = new OfficialLotteryProvider(
        'https://lottery.example/v1', true, 'token', 'license-1', 'official-euromillions',
        function (string $url, ?string $token) use (&$calls) {
            $calls[] = [$url, $token];
            if (str_ends_with($url, '/health')) return ['ok' => true, 'version' => '2'];
            return ['data' => ['draws' => [[
                'id' => 'draw-1', 'date' => '2026-08-21',
                'main' => [4, 17, 23, 34, 48], 'stars' => [7, 11],
                'sourceTimestamp' => '2026-08-21T21:15:00+00:00',
            ]]]];
        },
    );
    assert_equals('ONLINE', $provider->health()['state']);
    $draws = $provider->draws('2026-08-01', '2026-08-31', 10);
    assert_equals(1, count($draws));
    assert_equals('draw-1', $draws[0]['externalId']);
    assert_equals('official-euromillions', $draws[0]['source']);
    assert_equals('token', $calls[0][1]);
});

test('unfinished broker connectors are safe, testable and use normalized order contracts', function () {
    $disabled = new Mt4BridgeConnector('', false);
    assert_equals('DISABLED', $disabled->status()['state']);
    assert_false($disabled->capabilities()['orderSubmission']);

    $connector = new BinanceTradingConnector(
        'https://exchange-adapter.example', true,
        function (string $method, string $path, ?string $token, ?array $body) {
            if ($path === '/health') return ['ok' => true, 'version' => 'adapter-1', 'tradingEnabled' => true, 'accountType' => 'demo'];
            if ($path === '/v1/orders') return ['ok' => true, 'data' => ['ticket' => 42, 'price' => 100.5, 'placedAt' => 1700000000]];
            return ['ok' => true, 'data' => []];
        },
        'token', true, false,
    );
    $status = $connector->status();
    assert_equals('READY', $status['state']);
    assert_true($status['orderSubmissionEffective']);
    $result = $connector->placeOrder(['symbol' => 'BTCUSDT', 'side' => 'BUY', 'type' => 'MARKET', 'volume' => 0.01, 'stopLoss' => 90]);
    assert_equals(42, $result['ticket']);
    assert_equals('binance', $result['broker']);
});
