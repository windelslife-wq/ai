<?php
namespace Aegis\Providers;

/**
 * Configured provider boundary for licensed stock, ETF, futures and options
 * data.
 *
 * This adapter deliberately speaks a small, provider-neutral HTTP contract:
 *
 *   GET {url}/candles?symbol=...&marketClass=...&timeframe=...&limit=...
 *       -> {"data":{"candles":[{"timestamp":...,"open":...,"high":...,"low":...,"close":...,"volume":...}]}}
 *   GET {url}/quote?symbol=...
 *       -> {"data":{"symbol":"...","last":...,"bid":...,"ask":...,"timestamp":...}}
 *   GET {healthUrl}
 *       -> {"ok":true,"version":"..."}
 *
 * An upstream-specific integration can therefore be placed behind this
 * adapter without leaking vendor payloads into AEGIS. The provider remains
 * unavailable until URL, an explicit ENABLED flag, a token (if required by
 * the licensed feed), a license identifier, and an allow-list of symbols are
 * configured. No symbol discovery or synthetic values are performed here.
 *
 * The request callable is injectable for contract tests. Its signature is
 * callable(string $url, ?string $token): mixed and must return a decoded array.
 */
final class LicensedAssetMarketDataProvider implements MarketDataProvider
{
    private const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

    private string $assetClass;
    private string $providerId;
    private string $displayName;
    private string $envPrefix;
    private string $baseUrl;
    private string $healthUrl;
    private string $token;
    private string $license;
    private bool $enabled;
    private bool $delayed;
    private int $providerPriority;
    /** @var list<string> */
    private array $symbols;
    /** @var callable(string, ?string): mixed */
    private $request;
    private ?array $healthCache = null;

    /**
     * @param list<string>|null $symbols
     * @param callable(string, ?string): mixed|null $request
     */
    public function __construct(
        string $assetClass,
        string $providerId,
        string $displayName,
        string $envPrefix,
        ?string $baseUrl = null,
        ?bool $enabled = null,
        ?string $token = null,
        ?callable $request = null,
        ?array $symbols = null,
        ?bool $delayed = null,
        ?int $priority = null,
    ) {
        $assetClass = strtolower(trim($assetClass));
        if (!in_array($assetClass, ['stock', 'etf', 'futures', 'options'], true)) {
            throw new \InvalidArgumentException('unsupported licensed asset class: ' . $assetClass);
        }
        $this->assetClass = $assetClass;
        $this->providerId = trim($providerId);
        $this->displayName = trim($displayName);
        $this->envPrefix = trim($envPrefix);
        $this->baseUrl = trim($baseUrl ?? (getenv($this->envPrefix . '_URL') ?: ''));
        $this->healthUrl = trim(getenv($this->envPrefix . '_HEALTH_URL') ?: '');
        $this->token = trim($token ?? (getenv($this->envPrefix . '_TOKEN') ?: ''));
        $this->license = trim(getenv($this->envPrefix . '_LICENSE') ?: '');
        $this->enabled = $enabled ?? (getenv($this->envPrefix . '_ENABLED') === '1');
        $this->delayed = $delayed ?? (getenv($this->envPrefix . '_DELAYED') !== '0');
        $this->providerPriority = $priority ?? 30;
        $this->symbols = $this->normalizeSymbols($symbols ?? $this->envSymbols());
        $this->request = $request ?? [$this, 'defaultRequest'];
    }

    public function name(): string { return $this->providerId; }
    public function synthetic(): bool { return false; }
    public function priority(): int { return $this->providerPriority; }
    public function marketClass(): string { return $this->assetClass; }

    /** Optional capability used by ProviderManager without changing its base interface. */
    public function supportsMarketClass(string $marketClass): bool
    {
        return strtolower($marketClass) === $this->assetClass;
    }

    public function supportsSymbol(string $symbol): bool
    {
        return $this->configured() && in_array(strtoupper(trim($symbol)), $this->symbols, true);
    }

    public function supportsTimeframe(string $symbol, string $tf): bool
    {
        return $this->supportsSymbol($symbol) && in_array($tf, self::TIMEFRAMES, true);
    }

    public function getCandles(array $req): array
    {
        $this->assertConfigured();
        $symbol = strtoupper(trim((string) ($req['symbol'] ?? '')));
        $timeframe = (string) ($req['timeframe'] ?? '');
        $limit = max(1, min(5000, (int) ($req['limit'] ?? 200)));
        if (!$this->supportsSymbol($symbol)) throw new \RuntimeException($this->name() . ' does not allow ' . $symbol);
        if (!$this->supportsTimeframe($symbol, $timeframe)) throw new \RuntimeException($this->name() . ' does not support timeframe ' . $timeframe);

        $payload = ($this->request)($this->endpoint('/candles', [
            'symbol' => $symbol, 'marketClass' => $this->assetClass,
            'timeframe' => $timeframe, 'limit' => $limit,
        ]), $this->token !== '' ? $this->token : null);
        $rows = $this->rows($payload, 'candles');
        if ($rows === []) throw new \RuntimeException($this->name() . ' returned no candles');
        return array_map(fn($row) => $this->normalizeCandle($row), $rows);
    }

    public function getQuote(string $symbol): array
    {
        $this->assertConfigured();
        $symbol = strtoupper(trim($symbol));
        if (!$this->supportsSymbol($symbol)) throw new \RuntimeException($this->name() . ' does not allow ' . $symbol);
        $payload = ($this->request)($this->endpoint('/quote', ['symbol' => $symbol, 'marketClass' => $this->assetClass]), $this->token !== '' ? $this->token : null);
        $row = $this->object($payload, 'quote');
        $last = $this->number($row, 'last', true);
        $out = ['symbol' => $symbol, 'last' => $last, 'timestamp' => $this->timestamp($row['timestamp'] ?? null)];
        foreach (['bid', 'ask'] as $field) {
            if (array_key_exists($field, $row) && $row[$field] !== null) $out[$field] = $this->number($row, $field, false);
        }
        if (isset($out['bid'], $out['ask']) && ($out['bid'] <= 0 || $out['ask'] <= 0 || $out['ask'] < $out['bid'])) {
            throw new \RuntimeException($this->name() . ' returned an invalid bid/ask quote');
        }
        return $out;
    }

    public function healthCheck(): array
    {
        $base = ['name' => $this->name(), 'synthetic' => false, 'checkedAt' => time()];
        if (!$this->enabled) return $base + ['status' => 'DISABLED', 'detail' => 'Set ' . $this->envPrefix . '_ENABLED=1 after the licensed feed is approved.'];
        if (!$this->validUrl() || $this->license === '' || $this->symbols === []) {
            return $base + ['status' => 'NOT_CONFIGURED', 'detail' => 'Requires a safe HTTPS URL, license metadata, and an explicit symbol allow-list.'];
        }
        $started = microtime(true);
        try {
            $health = ($this->request)($this->healthUrl !== '' ? $this->healthUrl : $this->endpoint('/health'), $this->token !== '' ? $this->token : null);
            if (!is_array($health) || ($health['ok'] ?? true) === false) throw new \RuntimeException('health endpoint reported failure');
            $out = $base + [
                'status' => 'UP',
                'latencyMs' => (int) round((microtime(true) - $started) * 1000),
                'detail' => $this->displayName . ' reachable; licensed source metadata is configured.',
                'licenseConfigured' => true,
                'marketClass' => $this->assetClass,
                'delayed' => $this->delayed,
            ];
            if (isset($health['version']) && is_scalar($health['version'])) $out['providerVersion'] = (string) $health['version'];
            $this->healthCache = $out;
            return $out;
        } catch (\Throwable $e) {
            $out = $base + [
                'status' => 'DOWN',
                'latencyMs' => (int) round((microtime(true) - $started) * 1000),
                'lastError' => substr($e->getMessage(), 0, 240),
                'detail' => 'Licensed feed is configured but unreachable; synthetic fallback remains explicit.',
                'marketClass' => $this->assetClass,
            ];
            $this->healthCache = $out;
            return $out;
        }
    }

    public function capabilities(): array
    {
        return [
            'marketClasses' => [$this->assetClass],
            'timeframes' => self::TIMEFRAMES,
            'delayed' => $this->delayed,
            'notes' => $this->displayName . ' adapter. Upstream license and schema must be verified before production use; no provider is claimed by this scaffold.',
            'configuredSymbols' => count($this->symbols),
            'licenseConfigured' => $this->license !== '',
        ];
    }

    public function configured(): bool
    {
        return $this->enabled && $this->validUrl() && $this->license !== '' && $this->symbols !== [];
    }

    private function assertConfigured(): void
    {
        if (!$this->configured()) throw new \RuntimeException($this->name() . ' is not configured: enable it only after URL, license metadata and symbols are supplied');
    }

    /** @return list<array<string,mixed>> */
    private function rows($payload, string $key): array
    {
        if (!is_array($payload)) throw new \RuntimeException($this->name() . ' returned an invalid JSON object');
        $rows = $payload[$key] ?? (($payload['data'][$key] ?? null));
        if (!is_array($rows)) $rows = $payload['data'] ?? $payload;
        if (!is_array($rows) || !$this->isList($rows)) throw new \RuntimeException($this->name() . ' response has no ' . $key . ' list');
        return array_values(array_filter($rows, 'is_array'));
    }

    /** @return array<string,mixed> */
    private function object($payload, string $key): array
    {
        if (!is_array($payload)) throw new \RuntimeException($this->name() . ' returned an invalid ' . $key . ' object');
        $row = $payload[$key] ?? ($payload['data'][$key] ?? ($payload['data'] ?? $payload));
        if (!is_array($row) || $this->isList($row)) throw new \RuntimeException($this->name() . ' response has no ' . $key . ' object');
        return $row;
    }

    /** @return array<string,mixed> */
    private function normalizeCandle(array $row): array
    {
        $timestamp = $row['timestamp'] ?? ($row['time'] ?? ($row['t'] ?? null));
        $out = [
            'timestamp' => $this->timestamp($timestamp),
            'open' => $this->numberAny($row, ['open', 'o']),
            'high' => $this->numberAny($row, ['high', 'h']),
            'low' => $this->numberAny($row, ['low', 'l']),
            'close' => $this->numberAny($row, ['close', 'c']),
            'volume' => $this->numberAny($row, ['volume', 'v'], 0.0),
        ];
        if ($out['open'] <= 0 || $out['high'] <= 0 || $out['low'] <= 0 || $out['close'] <= 0
            || $out['high'] < max($out['open'], $out['close']) || $out['low'] > min($out['open'], $out['close'])
            || $out['volume'] < 0) {
            throw new \RuntimeException($this->name() . ' returned invalid OHLCV data');
        }
        return $out;
    }

    private function numberAny(array $row, array $keys, ?float $default = null): float
    {
        foreach ($keys as $key) if (array_key_exists($key, $row)) return $this->number($row, $key, false);
        if ($default !== null) return $default;
        throw new \RuntimeException($this->name() . ' response is missing ' . $keys[0]);
    }

    private function number(array $row, string $key, bool $required): float
    {
        if (!array_key_exists($key, $row)) {
            if (!$required) return 0.0;
            throw new \RuntimeException($this->name() . ' response is missing ' . $key);
        }
        if (!is_numeric($row[$key]) || !is_finite((float) $row[$key])) throw new \RuntimeException($this->name() . ' response ' . $key . ' is invalid');
        return (float) $row[$key];
    }

    private function timestamp($value): int
    {
        if (is_numeric($value)) {
            $value = (int) $value;
            return $value > 100000000000 ? $value : $value * 1000;
        }
        if (is_string($value) && trim($value) !== '') {
            $parsed = strtotime($value);
            if ($parsed !== false) return $parsed * 1000;
        }
        throw new \RuntimeException($this->name() . ' response timestamp is invalid');
    }

    private function endpoint(string $path, array $query = []): string
    {
        $url = rtrim($this->baseUrl, '/') . '/' . ltrim($path, '/');
        return $query === [] ? $url : $url . '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
    }

    private function validUrl(): bool
    {
        $parts = parse_url($this->baseUrl);
        return is_array($parts) && in_array(strtolower((string) ($parts['scheme'] ?? '')), ['https', 'http'], true)
            && !empty($parts['host']) && empty($parts['user']) && empty($parts['pass']);
    }

    /** @return list<string> */
    private function envSymbols(): array
    {
        $raw = getenv($this->envPrefix . '_SYMBOLS');
        return $raw === false ? [] : preg_split('/[\s,]+/', strtoupper(trim($raw)), -1, PREG_SPLIT_NO_EMPTY);
    }

    /** @param array<int,mixed> $symbols @return list<string> */
    private function normalizeSymbols(array $symbols): array
    {
        $out = [];
        foreach ($symbols as $symbol) {
            $symbol = strtoupper(trim((string) $symbol));
            if ($symbol !== '' && preg_match('/^[A-Z0-9._:-]{1,64}$/', $symbol)) $out[$symbol] = true;
        }
        return array_keys($out);
    }

    private function isList(array $value): bool
    {
        $i = 0;
        foreach (array_keys($value) as $key) if ($key !== $i++) return false;
        return true;
    }

    /** @return array<string,mixed>|null */
    private function defaultRequest(string $url, ?string $token): ?array
    {
        $headers = "Accept: application/json\r\nUser-Agent: AEGIS-Licensed-Market-Data/1.0\r\n";
        if ($token !== null && $token !== '') $headers .= 'Authorization: Bearer ' . $token . "\r\n";
        $context = stream_context_create([
            'http' => ['method' => 'GET', 'timeout' => 8, 'ignore_errors' => true, 'header' => $headers],
            'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
        ]);
        $raw = @file_get_contents($url, false, $context);
        $decoded = $raw === false ? null : json_decode($raw, true);
        return is_array($decoded) ? $decoded : null;
    }
}
