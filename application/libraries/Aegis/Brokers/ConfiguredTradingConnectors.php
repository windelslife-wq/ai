<?php
namespace Aegis\Brokers;

/**
 * Generic, safety-gated trading connector for the unfinished MT4, crypto and
 * stock-broker integrations.
 *
 * The connector boundary is deliberately provider-neutral. Each upstream
 * adapter/bridge must expose the same JSON contract used by the MT5 bridge:
 * /health, /v1/account, /v1/quotes/{symbol}, /v1/candles/{symbol},
 * /v1/positions, /v1/orders and /v1/history. Vendor SDKs belong behind that
 * boundary, never in the execution supervisor or an AI agent.
 *
 * No integration is active by default. A connector requires:
 *   AEGIS_<PREFIX>_ENABLED=1, URL, TOKEN and TRADING_ENABLED=1 for writes.
 *   AEGIS_<PREFIX>_LIVE_ALLOWED=1 is additionally required for providers
 *   that do not report accountType=demo. The adapter never guesses whether
 *   an account is safe to trade.
 */
class ConfiguredTradingConnector implements TradingConnector
{
    private const HEALTH_TTL_SECONDS = 5;
    private string $connectorId;
    private string $displayName;
    private string $envPrefix;
    private string $url;
    private string $token;
    private bool $enabled;
    private bool $tradingEnabled;
    private bool $liveAllowed;
    /** @var list<string> */
    private array $marketClasses;
    /** @var callable(string, string, ?string, ?array): mixed */
    private $request;
    private ?array $healthCache = null;

    /**
     * @param list<string> $marketClasses
     * @param callable(string, string, ?string, ?array): mixed|null $request
     */
    public function __construct(
        string $connectorId,
        string $displayName,
        string $envPrefix,
        array $marketClasses,
        ?string $url = null,
        ?bool $enabled = null,
        ?callable $request = null,
        ?string $token = null,
        ?bool $tradingEnabled = null,
        ?bool $liveAllowed = null,
    ) {
        $this->connectorId = trim($connectorId);
        $this->displayName = trim($displayName);
        $this->envPrefix = trim($envPrefix);
        $this->marketClasses = array_values(array_unique(array_map('strtolower', $marketClasses)));
        $this->url = trim($url ?? (getenv($this->envPrefix . '_URL') ?: ''));
        $this->token = trim($token ?? (getenv($this->envPrefix . '_TOKEN') ?: ''));
        $this->enabled = $enabled ?? (getenv($this->envPrefix . '_ENABLED') === '1');
        $this->tradingEnabled = $tradingEnabled ?? (getenv($this->envPrefix . '_TRADING_ENABLED') === '1');
        $this->liveAllowed = $liveAllowed ?? (getenv($this->envPrefix . '_LIVE_ALLOWED') === '1');
        $this->request = $request ?? [$this, 'defaultRequest'];
    }

    public function id(): string { return $this->connectorId; }

    public function capabilities(): array
    {
        return [
            'accountRead' => true,
            'marketData' => true,
            'tradingRead' => true,
            'orderSubmission' => $this->tradingEnabled,
            'liveTrading' => $this->liveAllowed,
            'marketClasses' => $this->marketClasses,
            'requiresBridge' => true,
            'reason' => $this->tradingEnabled
                ? 'Write intent is enabled; the adapter health response and account safety gate must also pass.'
                : 'Read-only by default. Set the connector TRADING_ENABLED flag only after the provider adapter is verified.',
        ];
    }

    public function status(): array
    {
        $base = ['state' => 'DISABLED', 'message' => '', 'configured' => $this->validUrl(), 'connector' => $this->connectorId];
        if (!$this->enabled) return array_merge($base, ['message' => 'Connector disabled by default. Set ' . $this->envPrefix . '_ENABLED=1 after its adapter is verified.']);
        if (!$this->validUrl() || $this->token === '') return array_merge($base, ['state' => 'NOT_CONFIGURED', 'message' => $this->envPrefix . '_URL and ' . $this->envPrefix . '_TOKEN are required.']);
        $health = $this->health();
        if (!is_array($health) || ($health['ok'] ?? false) !== true) return array_merge($base, ['state' => 'DOWN', 'message' => $this->displayName . ' adapter health check failed.']);
        return array_merge($base, [
            'state' => 'READY',
            'message' => ($health['simulated'] ?? false) === true ? 'Adapter reachable — SIMULATION only.' : 'Adapter reachable; provider-specific verification is still required.',
            'bridgeVersion' => isset($health['version']) ? (string) $health['version'] : null,
            'bridgeTradingEnabled' => ($health['tradingEnabled'] ?? false) === true,
            'accountType' => isset($health['accountType']) ? (string) $health['accountType'] : 'unknown',
            'simulated' => ($health['simulated'] ?? false) === true,
            'orderSubmissionEffective' => $this->orderSubmissionEffective($health),
        ]);
    }

    public function orderSubmissionEffective(?array $health = null): bool
    {
        $health = $health ?? ($this->enabled && $this->validUrl() && $this->token !== '' ? $this->health() : null);
        if (!is_array($health) || ($health['ok'] ?? false) !== true) return false;
        if (!$this->tradingEnabled || ($health['tradingEnabled'] ?? false) !== true) return false;
        $accountType = strtolower((string) ($health['accountType'] ?? 'unknown'));
        // Demo is the safe default. Non-demo accounts require a separate,
        // connector-specific explicit opt-in; no provider is silently live.
        return $accountType === 'demo' || $this->liveAllowed;
    }

    public function account(): array
    {
        return BrokerDataNormalizer::account($this->read('GET', '/v1/account', 'account'), $this->id());
    }

    public function quote(string $symbol): array
    {
        $symbol = $this->symbol($symbol);
        return BrokerDataNormalizer::quote($this->read('GET', '/v1/quotes/' . rawurlencode($symbol), 'quote'), $this->id());
    }

    /** @return array<int,array<string,mixed>> */
    public function candles(string $symbol, string $timeframe = '1h', int $limit = 500): array
    {
        $symbol = $this->symbol($symbol);
        if (!preg_match('/^(1m|5m|15m|1h|4h|1d)$/', $timeframe)) throw new \InvalidArgumentException('invalid timeframe');
        $limit = max(10, min(1000, $limit));
        return BrokerDataNormalizer::candles($this->read('GET', '/v1/candles/' . rawurlencode($symbol) . '?tf=' . rawurlencode($timeframe) . '&limit=' . $limit, 'candles'), $this->id());
    }

    public function positions(): array
    {
        return BrokerDataNormalizer::positions($this->read('GET', '/v1/positions', 'positions'), $this->id());
    }

    public function pendingOrders(): array
    {
        return BrokerDataNormalizer::pendingOrders($this->read('GET', '/v1/orders', 'pending orders'), $this->id());
    }

    public function history(int $limit = 100): array
    {
        return BrokerDataNormalizer::history($this->read('GET', '/v1/history?limit=' . max(1, min(500, $limit)), 'history'), $this->id());
    }

    public function placeOrder(array $order): array
    {
        $this->assertTradingAllowed();
        $symbol = $this->symbol((string) ($order['symbol'] ?? ''));
        $side = strtoupper((string) ($order['side'] ?? ''));
        $type = strtoupper((string) ($order['type'] ?? 'MARKET'));
        $volume = (float) ($order['volume'] ?? 0);
        if (!in_array($side, ['BUY', 'SELL'], true)) throw new \InvalidArgumentException('side must be BUY or SELL');
        if (!in_array($type, ['MARKET', 'LIMIT'], true)) throw new \InvalidArgumentException('type must be MARKET or LIMIT');
        if ($volume <= 0 || !is_finite($volume)) throw new \InvalidArgumentException('volume must be positive');
        $body = ['action' => $side, 'type' => $type, 'symbol' => $symbol, 'volume' => $volume];
        foreach (['price', 'stopLoss', 'takeProfit'] as $field) {
            if (isset($order[$field])) {
                if (!is_numeric($order[$field]) || (float) $order[$field] <= 0) throw new \InvalidArgumentException($field . ' must be positive');
                $body[$field] = (float) $order[$field];
            }
        }
        if ($type === 'LIMIT' && !isset($body['price'])) throw new \InvalidArgumentException('LIMIT orders require a price');
        return BrokerDataNormalizer::orderResult($this->read('POST', '/v1/orders', 'order placement', $body), $this->id());
    }

    public function modifyOrder(int $ticket, array $changes): array
    {
        $this->assertTradingAllowed();
        $body = [];
        foreach (['stopLoss', 'takeProfit', 'price'] as $field) if (isset($changes[$field])) {
            if (!is_numeric($changes[$field]) || (float) $changes[$field] <= 0) throw new \InvalidArgumentException($field . ' must be positive');
            $body[$field] = (float) $changes[$field];
        }
        if ($body === []) throw new \InvalidArgumentException('nothing to modify');
        return BrokerDataNormalizer::ticketResult($this->read('POST', '/v1/orders/' . $ticket . '/modify', 'order modify', $body), $this->id());
    }

    public function cancelOrder(int $ticket): array
    {
        $this->assertTradingAllowed();
        return BrokerDataNormalizer::ticketResult($this->read('POST', '/v1/orders/' . $ticket . '/cancel', 'order cancel'), $this->id());
    }

    public function closePosition(int $ticket): array
    {
        $this->assertTradingAllowed();
        return BrokerDataNormalizer::closeResult($this->read('POST', '/v1/positions/' . $ticket . '/close', 'position close'), $this->id());
    }

    private function assertTradingAllowed(): void
    {
        if (!$this->enabled || !$this->validUrl() || $this->token === '') throw new \RuntimeException($this->displayName . ' is not enabled and configured');
        if (!$this->tradingEnabled) throw new \RuntimeException($this->displayName . ' order submission is disabled');
        $health = $this->health(true);
        if (!$this->orderSubmissionEffective($health)) throw new \RuntimeException($this->displayName . ' safety gates failed — order refused');
    }

    private function read(string $method, string $path, string $kind, ?array $body = null): array
    {
        if (!$this->enabled || !$this->validUrl() || $this->token === '') throw new \RuntimeException($this->displayName . ' is not enabled and configured');
        try {
            $payload = ($this->request)($method, $path, $this->token, $body);
        } catch (\Throwable $e) {
            throw new \RuntimeException($this->displayName . ' ' . $kind . ' request failed');
        }
        if (!is_array($payload) || ($payload['ok'] ?? true) === false) {
            $message = is_array($payload) && is_string($payload['error'] ?? null) ? substr((string) $payload['error'], 0, 200) : $this->displayName . ' ' . $kind . ' request failed';
            throw new \RuntimeException($message);
        }
        $data = $payload['data'] ?? null;
        if (!is_array($data)) throw new \RuntimeException($this->displayName . ' ' . $kind . ' response is invalid');
        return $data;
    }

    private function health(bool $force = false): ?array
    {
        $now = microtime(true);
        if (!$force && $this->healthCache !== null && $now - $this->healthCache['checkedAt'] < self::HEALTH_TTL_SECONDS) return $this->healthCache['payload'];
        try { $payload = ($this->request)('GET', '/health', $this->token !== '' ? $this->token : null, null); }
        catch (\Throwable) { $payload = null; }
        $this->healthCache = ['checkedAt' => $now, 'payload' => is_array($payload) ? $payload : null];
        return $this->healthCache['payload'];
    }

    private function symbol(string $symbol): string
    {
        $symbol = strtoupper(trim($symbol));
        if (!preg_match('/^[A-Z0-9._:-]{1,64}$/', $symbol)) throw new \InvalidArgumentException('invalid broker symbol');
        return $symbol;
    }

    private function validUrl(): bool
    {
        $parts = parse_url($this->url);
        return is_array($parts) && in_array(strtolower((string) ($parts['scheme'] ?? '')), ['https', 'http'], true)
            && !empty($parts['host']) && empty($parts['user']) && empty($parts['pass']);
    }

    private function defaultRequest(string $method, string $path, ?string $token, ?array $body): ?array
    {
        $endpoint = rtrim($this->url, '/') . $path;
        $headers = "Accept: application/json\r\nContent-Type: application/json\r\n";
        if ($token !== null && $token !== '') $headers .= 'Authorization: Bearer ' . $token . "\r\n";
        $context = stream_context_create([
            'http' => [
                'method' => $method, 'timeout' => 8, 'ignore_errors' => true,
                'header' => $headers,
                'content' => $body === null ? '' : json_encode($body, JSON_THROW_ON_ERROR),
            ],
            'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
        ]);
        $raw = @file_get_contents($endpoint, false, $context);
        $decoded = $raw === false ? null : json_decode($raw, true);
        return is_array($decoded) ? $decoded : null;
    }
}

/** MetaTrader 4 bridge contract (disabled until an MT4 adapter is deployed). */
final class Mt4BridgeConnector extends ConfiguredTradingConnector
{
    public function __construct(?string $url = null, ?bool $enabled = null, ?callable $request = null, ?string $token = null, ?bool $tradingEnabled = null, ?bool $liveAllowed = null)
    {
        parent::__construct('mt4-bridge', 'MetaTrader 4', 'AEGIS_MT4_BRIDGE', ['forex'], $url, $enabled, $request, $token, $tradingEnabled, $liveAllowed);
    }
}

/** Generic exchange adapter for a crypto exchange exposing the canonical bridge contract. */
class CryptoExchangeConnector extends ConfiguredTradingConnector
{
    public function __construct(string $id, string $displayName, string $envPrefix, ?string $url = null, ?bool $enabled = null, ?callable $request = null, ?string $token = null, ?bool $tradingEnabled = null, ?bool $liveAllowed = null)
    {
        parent::__construct($id, $displayName, $envPrefix, ['crypto'], $url, $enabled, $request, $token, $tradingEnabled, $liveAllowed);
    }
}

final class BinanceTradingConnector extends CryptoExchangeConnector
{
    public function __construct(...$args) { parent::__construct('binance', 'Binance exchange', 'AEGIS_BINANCE_CONNECTOR', ...$args); }
}
final class BybitTradingConnector extends CryptoExchangeConnector
{
    public function __construct(...$args) { parent::__construct('bybit', 'Bybit exchange', 'AEGIS_BYBIT_CONNECTOR', ...$args); }
}
final class OkxTradingConnector extends CryptoExchangeConnector
{
    public function __construct(...$args) { parent::__construct('okx', 'OKX exchange', 'AEGIS_OKX_CONNECTOR', ...$args); }
}
final class CoinbaseTradingConnector extends CryptoExchangeConnector
{
    public function __construct(...$args) { parent::__construct('coinbase', 'Coinbase exchange', 'AEGIS_COINBASE_CONNECTOR', ...$args); }
}
final class KrakenTradingConnector extends CryptoExchangeConnector
{
    public function __construct(...$args) { parent::__construct('kraken', 'Kraken exchange', 'AEGIS_KRAKEN_CONNECTOR', ...$args); }
}

/** Generic stock/forex broker adapter exposing the canonical bridge contract. */
class StockBrokerConnector extends ConfiguredTradingConnector
{
    public function __construct(string $id, string $displayName, string $envPrefix, array $classes = ['stock', 'etf', 'options'], ?string $url = null, ?bool $enabled = null, ?callable $request = null, ?string $token = null, ?bool $tradingEnabled = null, ?bool $liveAllowed = null)
    {
        parent::__construct($id, $displayName, $envPrefix, $classes, $url, $enabled, $request, $token, $tradingEnabled, $liveAllowed);
    }
}
final class InteractiveBrokersConnector extends StockBrokerConnector
{
    public function __construct(...$args) { parent::__construct('ib', 'Interactive Brokers', 'AEGIS_IB_CONNECTOR', ['stock', 'etf', 'futures', 'options'], ...$args); }
}
final class AlpacaConnector extends StockBrokerConnector
{
    public function __construct(...$args) { parent::__construct('alpaca', 'Alpaca', 'AEGIS_ALPACA_CONNECTOR', ['stock', 'etf', 'crypto'], ...$args); }
}
final class OandaConnector extends StockBrokerConnector
{
    public function __construct(...$args) { parent::__construct('oanda', 'OANDA', 'AEGIS_OANDA_CONNECTOR', ['forex'], ...$args); }
}
