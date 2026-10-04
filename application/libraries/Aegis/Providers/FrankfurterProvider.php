<?php
namespace Aegis\Providers;

use Aegis\CircuitBreaker;
use Aegis\Http;

/**
 * REAL forex reference rates from Frankfurter (ECB data, public, no key).
 * Honest capability: the ECB publishes DAILY rates only — this provider
 * serves exactly the 1d timeframe and refuses intraday requests instead of
 * inventing data. Metals (XAUUSD) are not covered.
 */
class FrankfurterProvider implements MarketDataProvider
{
    public const ECB_CURRENCIES = [
        'AUD','BGN','BRL','CAD','CHF','CNY','CZK','DKK','EUR','GBP','HKD','HUF',
        'IDR','ILS','INR','ISK','JPY','KRW','MXN','MYR','NOK','NZD','PHP','PLN',
        'RON','SEK','SGD','THB','TRY','USD','ZAR',
    ];

    private CircuitBreaker $breaker;
    private Http $http;

    public function __construct(?string $baseUrl = null, ?Http $http = null)
    {
        $this->baseUrl = $baseUrl ?? (getenv('FRANKFURTER_API_BASE') ?: 'https://api.frankfurter.dev');
        $this->http = $http ?? new Http();
        $this->breaker = new CircuitBreaker('frankfurter');
    }

    private string $baseUrl;

    public function name(): string { return 'frankfurter-ecb'; }
    public function synthetic(): bool { return false; }
    public function priority(): int { return 20; }

    public static function splitPair(string $symbol): array
    {
        $s = strtoupper($symbol);
        return [substr($s, 0, 3), substr($s, 3, 3)];
    }

    public function supportsSymbol(string $symbol): bool
    {
        [$base, $quote] = self::splitPair($symbol);
        return in_array($base, self::ECB_CURRENCIES, true)
            && in_array($quote, self::ECB_CURRENCIES, true)
            && $base !== $quote;
    }

    public function supportsTimeframe(string $symbol, string $tf): bool
    {
        return $tf === '1d'; // ECB publishes daily reference rates only.
    }

    public function getCandles(array $req): array
    {
        if ($req['timeframe'] !== '1d') {
            throw new \RuntimeException('frankfurter-ecb serves daily (1d) data only');
        }
        if (!$this->supportsSymbol($req['symbol'])) {
            throw new \RuntimeException('frankfurter-ecb does not cover ' . $req['symbol']);
        }
        [$base, $quote] = self::splitPair($req['symbol']);
        $days = (int)ceil($req['limit'] * 1.5) + 10;
        $start = gmdate('Y-m-d', time() - $days * 86400);
        $url = "{$this->baseUrl}/v1/{$start}..?base={$base}&symbols={$quote}";
        $data = $this->guarded(fn () => $this->http->getJson($url));
        // Frankfurter time series is date-keyed: {"rates":{"2026-08-21":{"USD":1.17}}}
        $rows = $data['rates'] ?? [];
        if (!is_array($rows) || $rows === []) {
            throw new \RuntimeException('frankfurter-ecb returned no series');
        }
        ksort($rows);
        $candles = [];
        $prev = null;
        foreach ($rows as $date => $row) {
            $rate = is_array($row) ? ($row[$quote] ?? null) : $row;
            if (!is_numeric($rate)) {
                continue;
            }
            $open = $prev ?? (float)$rate;
            $close = (float)$rate;
            $candles[] = [
                'timestamp' => strtotime($date . 'T00:00:00Z') * 1000,
                'open' => $open,
                'high' => max($open, $close),
                'low' => min($open, $close),
                'close' => $close,
                'volume' => 0.0, // reference rates carry no volume — honest
            ];
            $prev = $close;
        }
        if ($candles === []) {
            throw new \RuntimeException('frankfurter-ecb returned no series');
        }
        return array_slice($candles, -$req['limit']);
    }

    public function getQuote(string $symbol): array
    {
        if (!$this->supportsSymbol($symbol)) {
            throw new \RuntimeException('frankfurter-ecb does not cover ' . $symbol);
        }
        [$base, $quote] = self::splitPair($symbol);
        $url = "{$this->baseUrl}/v1/latest?base={$base}&symbols={$quote}";
        $data = $this->guarded(fn () => $this->http->getJson($url));
        $rate = $data['rates'][$quote] ?? null;
        if (!is_numeric($rate)) {
            throw new \RuntimeException('frankfurter-ecb returned no rate');
        }
        return [
            'symbol' => strtoupper($symbol),
            'last' => (float)$rate,
            'timestamp' => strtotime(($data['date'] ?? gmdate('Y-m-d')) . 'T16:00:00Z') * 1000,
        ];
    }

    public function healthCheck(): array
    {
        $started = microtime(true);
        try {
            $this->guarded(fn () => $this->http->getJson($this->baseUrl . '/v1/latest?base=EUR&symbols=USD', 1));
            return [
                'name' => $this->name(), 'status' => 'UP', 'synthetic' => false,
                'latencyMs' => (int)((microtime(true) - $started) * 1000), 'checkedAt' => time(),
                'circuitState' => $this->breaker->currentState(),
                'detail' => 'ECB daily reference rates via Frankfurter (daily timeframe only, no volume)',
            ];
        } catch (\Throwable $e) {
            return [
                'name' => $this->name(), 'status' => 'DOWN', 'synthetic' => false,
                'latencyMs' => (int)((microtime(true) - $started) * 1000), 'checkedAt' => time(),
                'lastError' => $e->getMessage(),
                'circuitState' => $this->breaker->currentState(),
                'detail' => 'Unreachable from this host — manager falls back and flags synthetic use.',
            ];
        }
    }

    public function capabilities(): array
    {
        return [
            'marketClasses' => ['forex'],
            'timeframes' => ['1d'],
            'delayed' => true, // ECB reference rates publish once per business day.
            'notes' => 'Real ECB daily FX reference rates. Intraday forex and metals are NOT available from this source.',
        ];
    }

    private function guarded(callable $fn)
    {
        if (!$this->breaker->canCall()) {
            throw new \RuntimeException('frankfurter circuit breaker OPEN');
        }
        try {
            $out = $fn();
            $this->breaker->recordSuccess();
            return $out;
        } catch (\Throwable $e) {
            $this->breaker->recordFailure();
            throw $e;
        }
    }
}
