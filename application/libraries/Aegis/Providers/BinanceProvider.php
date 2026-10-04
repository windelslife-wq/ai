<?php
namespace Aegis\Providers;

use Aegis\CircuitBreaker;
use Aegis\Http;

/**
 * REAL crypto market data from Binance public REST (no key required for
 * market data). Reports DOWN and falls back when the host cannot reach
 * api.binance.com — never silently serves synthetic data.
 */
class BinanceProvider implements MarketDataProvider
{
    public const SYMBOLS = [
        'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT',
        'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'MATICUSDT', 'LTCUSDT',
    ];

    private CircuitBreaker $breaker;
    private Http $http;
    private ?string $lastError = null;

    public function __construct(?string $baseUrl = null, ?Http $http = null)
    {
        $this->baseUrl = $baseUrl ?? (getenv('BINANCE_API_BASE') ?: 'https://api.binance.com');
        $this->http = $http ?? new Http();
        $this->breaker = new CircuitBreaker('binance');
    }

    private string $baseUrl;

    public function name(): string { return 'binance'; }
    public function synthetic(): bool { return false; }
    public function priority(): int { return 10; }

    public function supportsSymbol(string $symbol): bool
    {
        return in_array(strtoupper($symbol), self::SYMBOLS, true);
    }

    public function supportsTimeframe(string $symbol, string $tf): bool
    {
        return in_array($tf, ['1m', '5m', '15m', '1h', '4h', '1d'], true);
    }

    public function getCandles(array $req): array
    {
        $symbol = strtoupper($req['symbol']);
        if (!$this->supportsSymbol($symbol)) {
            throw new \RuntimeException("Binance provider does not list {$symbol}");
        }
        $path = '/api/v3/klines?symbol=' . urlencode($symbol)
            . '&interval=' . $req['timeframe'] . '&limit=' . min(1000, max(1, $req['limit']));
        return $this->normalizeKlines($this->fetchJson($path));
    }

    public function getQuote(string $symbol): array
    {
        $symbol = strtoupper($symbol);
        if (!$this->supportsSymbol($symbol)) {
            throw new \RuntimeException("Binance provider does not list {$symbol}");
        }
        $t = $this->fetchJson('/api/v3/ticker/bookTicker?symbol=' . urlencode($symbol));
        if (!isset($t['bidPrice'], $t['askPrice']) || !is_numeric($t['bidPrice']) || !is_numeric($t['askPrice'])) {
            throw new \RuntimeException('binance ticker failed: ' . (string) ($t['msg'] ?? 'missing bid/ask'));
        }
        $bid = (float) $t['bidPrice'];
        $ask = (float) $t['askPrice'];
        if ($bid <= 0 || $ask <= 0 || $ask < $bid) {
            throw new \RuntimeException('binance ticker returned invalid prices');
        }
        return ['symbol' => $symbol, 'bid' => $bid, 'ask' => $ask, 'last' => ($bid + $ask) / 2, 'timestamp' => (int) (microtime(true) * 1000)];
    }

    public function healthCheck(): array
    {
        $started = microtime(true);
        try {
            $this->fetchJson('/api/v3/ping');
            $this->lastError = null;
            return [
                'name' => $this->name(), 'status' => 'UP', 'synthetic' => false,
                'latencyMs' => (int) ((microtime(true) - $started) * 1000), 'checkedAt' => time(),
                'circuitState' => $this->breaker->currentState(),
                'detail' => 'Public market-data REST API (no key required)',
            ];
        } catch (\Throwable $e) {
            $this->lastError = $e->getMessage();
            return [
                'name' => $this->name(), 'status' => 'DOWN', 'synthetic' => false,
                'latencyMs' => (int) ((microtime(true) - $started) * 1000), 'checkedAt' => time(),
                'lastError' => $this->lastError,
                'circuitState' => $this->breaker->currentState(),
                'detail' => 'Unreachable from this host — manager falls back and flags synthetic use.',
            ];
        }
    }

    public function capabilities(): array
    {
        return [
            'marketClasses' => ['crypto'],
            'timeframes' => ['1m', '5m', '15m', '1h', '4h', '1d'],
            'delayed' => false,
            'notes' => 'Real spot crypto klines/quotes via public REST. Trading endpoints NOT used.',
        ];
    }

    /** @return list<string> */
    private function hosts(): array
    {
        $primary = rtrim($this->baseUrl, '/');
        return array_values(array_unique(array_filter([
            $primary,
            'https://data-api.binance.vision',
            'https://api1.binance.com',
        ])));
    }

    private function fetchJson(string $path): array
    {
        if (!$this->breaker->canCall()) {
            throw new \RuntimeException('binance circuit breaker OPEN');
        }
        $last = 'binance request failed';
        foreach ($this->hosts() as $host) {
            try {
                $json = $this->http->getJson($host . $path, 1);
                if (!is_array($json)) throw new \RuntimeException('binance returned a non-object payload');
                $this->breaker->recordSuccess();
                return $json;
            } catch (\Throwable $e) {
                $last = $e->getMessage();
            }
        }
        $this->breaker->recordFailure();
        throw new \RuntimeException($last);
    }

    /** @param array<int|string, mixed> $raw */
    private function normalizeKlines(array $raw): array
    {
        if (!array_is_list($raw)) {
            $msg = is_string($raw['msg'] ?? null) ? (string) $raw['msg'] : 'unexpected klines payload';
            throw new \RuntimeException('binance klines failed: ' . $msg);
        }
        $out = [];
        foreach ($raw as $k) {
            if (!is_array($k) || count($k) < 6 || !is_numeric($k[0]) || !is_numeric($k[1]) || !is_numeric($k[2]) || !is_numeric($k[3]) || !is_numeric($k[4]) || !is_numeric($k[5])) {
                throw new \RuntimeException('binance klines row is invalid');
            }
            $out[] = [
                'timestamp' => (int) $k[0],
                'open' => (float) $k[1],
                'high' => (float) $k[2],
                'low' => (float) $k[3],
                'close' => (float) $k[4],
                'volume' => (float) $k[5],
            ];
        }
        if ($out === []) throw new \RuntimeException('binance returned no klines');
        return $out;
    }
}
