<?php
namespace Aegis\Brokers;

/**
 * MetaTrader 5 connector via a separately deployed bridge service
 * (python-services/mt5-bridge — FastAPI + the MetaTrader5 package on a
 * Windows host with a running MT5 terminal).
 *
 * SAFETY MODEL (deliberate defaults):
 *   - Disabled entirely unless AEGIS_MT5_BRIDGE_ENABLED=1.
 *   - Reads (account/quote/candles/positions/orders/history) need a token.
 *   - ORDER SUBMISSION additionally needs AEGIS_MT5_TRADING_ENABLED=1 AND a
 *     bridge that reports tradingEnabled=true. Both gates are re-verified on
 *     every order call — flipping the env flag is not enough if the bridge
 *     itself refuses to trade.
 *   - LIVE-MONEY accounts are refused unless AEGIS_MT5_LIVE_ALLOWED=1. Demo
 *     accounts only by default (spec §10: demo first).
 *
 * Transport is injectable for tests: callable(string $method, string $path,
 * ?string $token, ?array $body): ?array — URL binding stays inside.
 */
class Mt5BridgeConnector implements TradingConnector
{
    private const HEALTH_TTL_SECONDS = 5;

    private string $url;
    private bool $enabled;
    private bool $tradingEnabled;
    private bool $liveAllowed;
    private string $token;
    /** @var callable(string, string, ?string, ?array): ?array */
    private $request;
    /** @var array{checkedAt: float, payload: array}|null */
    private ?array $healthCache = null;

    public function __construct(
        ?string $url = null,
        ?bool $enabled = null,
        ?callable $request = null,
        ?string $token = null,
        ?bool $tradingEnabled = null,
        ?bool $liveAllowed = null
    ) {
        $this->url = trim($url ?? (getenv('AEGIS_MT5_BRIDGE_URL') ?: ''));
        $this->enabled = $enabled ?? (getenv('AEGIS_MT5_BRIDGE_ENABLED') === '1');
        $this->tradingEnabled = $tradingEnabled ?? (getenv('AEGIS_MT5_TRADING_ENABLED') === '1');
        $this->liveAllowed = $liveAllowed ?? (getenv('AEGIS_MT5_LIVE_ALLOWED') === '1');
        $this->token = trim($token ?? (getenv('AEGIS_MT5_BRIDGE_TOKEN') ?: ''));
        $this->request = $request ?? [$this, 'defaultRequest'];
    }

    public function id(): string { return 'mt5-bridge'; }

    public function capabilities(): array
    {
        return [
            'accountRead' => true,
            'marketData' => true,
            'tradingRead' => true, // positions / pending orders / history
            // Config intent only — the effective gate is verified against the
            // bridge on every order call (see assertTradingAllowed).
            'orderSubmission' => $this->tradingEnabled,
            'liveTrading' => $this->liveAllowed,
            'reason' => $this->tradingEnabled
                ? 'Order submission explicitly enabled; the bridge must also report tradingEnabled=true (and a demo account unless live is explicitly allowed).'
                : 'Read-only by default. Set AEGIS_MT5_TRADING_ENABLED=1 (and deploy an authenticated bridge) to enable order submission.',
        ];
    }

    public function status(): array
    {
        if (!$this->enabled) return $this->statusPayload('DISABLED', 'Set AEGIS_MT5_BRIDGE_ENABLED=1 after deploying an authenticated bridge.');
        if (!$this->validUrl()) return $this->statusPayload('NOT_CONFIGURED', 'AEGIS_MT5_BRIDGE_URL must be an absolute http(s) URL without credentials.');
        $health = $this->health();
        if (!is_array($health) || ($health['ok'] ?? false) !== true) {
            return $this->statusPayload('DOWN', 'Bridge health check failed.');
        }
        return $this->statusPayload('READY', ($health['simulated'] ?? false) === true
            ? 'Bridge reachable — SIMULATED bridge (demo).'
            : 'Bridge reachable.', [
            'bridgeVersion' => isset($health['version']) ? (string) $health['version'] : null,
            'bridgeTradingEnabled' => ($health['tradingEnabled'] ?? false) === true,
            'accountType' => isset($health['accountType']) ? (string) $health['accountType'] : 'unknown',
            'simulated' => ($health['simulated'] ?? false) === true,
            'orderSubmissionEffective' => $this->orderSubmissionEffective($health),
        ]);
    }

    /** Effective (bridge-verified) order capability — the only one the supervisor trusts. */
    public function orderSubmissionEffective(?array $health = null): bool
    {
        $health = $health ?? ($this->enabled && $this->validUrl() ? $this->health() : null);
        if (!is_array($health) || ($health['ok'] ?? false) !== true) return false;
        if (!$this->tradingEnabled || ($health['tradingEnabled'] ?? false) !== true) return false;
        $accountType = (string) ($health['accountType'] ?? 'unknown');
        return $this->liveAllowed || $accountType === 'demo';
    }

    public function account(): array
    {
        return BrokerDataNormalizer::account($this->read('GET', '/v1/account', 'account'), $this->id());
    }

    public function quote(string $symbol): array
    {
        $symbol = strtoupper(trim($symbol));
        if (!preg_match('/^[A-Z0-9._-]{1,32}$/', $symbol)) throw new \InvalidArgumentException('invalid MT5 symbol');
        return BrokerDataNormalizer::quote($this->read('GET', '/v1/quotes/' . rawurlencode($symbol), 'quote'), $this->id());
    }

    public function candles(string $symbol, string $timeframe = '1h', int $limit = 500): array
    {
        $symbol = strtoupper(trim($symbol));
        if (!preg_match('/^[A-Z0-9._-]{1,32}$/', $symbol)) throw new \InvalidArgumentException('invalid MT5 symbol');
        $limit = max(10, min(1000, $limit));
        $tf = rawurlencode(substr($timeframe, 0, 8));
        $data = $this->read('GET', "/v1/candles/{$symbol}?tf={$tf}&limit={$limit}", 'candles');
        return BrokerDataNormalizer::candles($data, $this->id());
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
        $limit = max(1, min(500, $limit));
        return BrokerDataNormalizer::history($this->read('GET', '/v1/history?limit=' . $limit, 'history'), $this->id());
    }

    public function placeOrder(array $order): array
    {
        $this->assertTradingAllowed();
        $symbol = strtoupper(trim((string) ($order['symbol'] ?? '')));
        $side = strtoupper((string) ($order['side'] ?? ''));
        $type = strtoupper((string) ($order['type'] ?? 'MARKET'));
        $volume = (float) ($order['volume'] ?? 0);
        $stopLoss = isset($order['stopLoss']) && is_numeric($order['stopLoss']) ? (float) $order['stopLoss'] : null;
        $takeProfit = isset($order['takeProfit']) && is_numeric($order['takeProfit']) ? (float) $order['takeProfit'] : null;
        $price = isset($order['price']) && is_numeric($order['price']) ? (float) $order['price'] : null;
        if (!preg_match('/^[A-Z0-9._-]{1,32}$/', $symbol)) throw new \InvalidArgumentException('invalid MT5 symbol');
        if (!in_array($side, ['BUY', 'SELL'], true)) throw new \InvalidArgumentException('side must be BUY or SELL');
        if (!in_array($type, ['MARKET', 'LIMIT'], true)) throw new \InvalidArgumentException('type must be MARKET or LIMIT');
        if ($type === 'LIMIT' && ($price === null || $price <= 0)) throw new \InvalidArgumentException('LIMIT orders require a price');
        if ($volume <= 0 || !is_finite($volume)) throw new \InvalidArgumentException('volume must be positive');
        $body = ['action' => $side, 'type' => $type, 'symbol' => $symbol, 'volume' => $volume];
        if ($price !== null) $body['price'] = $price;
        if ($stopLoss !== null) $body['stopLoss'] = $stopLoss;
        if ($takeProfit !== null) $body['takeProfit'] = $takeProfit;
        return BrokerDataNormalizer::orderResult($this->read('POST', '/v1/orders', 'order placement', $body), $this->id());
    }

    public function modifyOrder(int $ticket, array $changes): array
    {
        $this->assertTradingAllowed();
        $body = [];
        foreach (['stopLoss', 'takeProfit', 'price'] as $field) {
            if (isset($changes[$field]) && is_numeric($changes[$field])) $body[$field] = (float) $changes[$field];
        }
        if ($body === []) throw new \InvalidArgumentException('nothing to modify');
        return BrokerDataNormalizer::ticketResult($this->read('POST', "/v1/orders/{$ticket}/modify", 'order modify', $body), $this->id());
    }

    public function cancelOrder(int $ticket): array
    {
        $this->assertTradingAllowed();
        return BrokerDataNormalizer::ticketResult($this->read('POST', "/v1/orders/{$ticket}/cancel", 'order cancel'), $this->id());
    }

    public function closePosition(int $ticket): array
    {
        $this->assertTradingAllowed();
        return BrokerDataNormalizer::closeResult($this->read('POST', "/v1/positions/{$ticket}/close", 'position close'), $this->id());
    }

    // ------------------------------------------------------------------ gates

    private function assertTradingAllowed(): void
    {
        if (!$this->enabled || !$this->validUrl()) throw new \RuntimeException('MT5 bridge is not enabled and configured');
        if ($this->token === '') throw new \RuntimeException('MT5 bridge token is not configured');
        $health = $this->health(force: true);
        if (!is_array($health) || ($health['ok'] ?? false) !== true) throw new \RuntimeException('MT5 bridge health check failed — order refused');
        if (!$this->tradingEnabled) throw new \RuntimeException('MT5 order submission is disabled (AEGIS_MT5_TRADING_ENABLED)');
        if (($health['tradingEnabled'] ?? false) !== true) throw new \RuntimeException('MT5 bridge reports tradingEnabled=false — order refused');
        $accountType = (string) ($health['accountType'] ?? 'unknown');
        if (!$this->liveAllowed && $accountType !== 'demo') {
            throw new \RuntimeException("MT5 bridge is on a '{$accountType}' account — demo accounts only unless AEGIS_MT5_LIVE_ALLOWED=1");
        }
    }

    /** @return array|null decoded bridge payload (short cache to keep probes cheap) */
    private function health(bool $force = false): ?array
    {
        $now = microtime(true);
        if (!$force && $this->healthCache !== null && $now - $this->healthCache['checkedAt'] < self::HEALTH_TTL_SECONDS) {
            return $this->healthCache['payload'];
        }
        try {
            $payload = ($this->request)('GET', '/health', null, null);
        } catch (\Throwable) {
            $payload = null;
        }
        $this->healthCache = ['checkedAt' => $now, 'payload' => is_array($payload) ? $payload : null];
        return $this->healthCache['payload'];
    }

    /** @return array<string, mixed> the bridge `data` object for a read/write call */
    private function read(string $method, string $path, string $kind, ?array $body = null): array
    {
        if (!$this->enabled || !$this->validUrl()) throw new \RuntimeException('MT5 bridge is not enabled and configured');
        if ($this->token === '') throw new \RuntimeException('MT5 bridge token is not configured');
        try {
            $payload = ($this->request)($method, $path, $this->token, $body);
        } catch (\Throwable) {
            throw new \RuntimeException("MT5 {$kind} request failed");
        }
        if (!is_array($payload) || ($payload['ok'] ?? true) === false) {
            $message = is_array($payload) && is_string($payload['error'] ?? null) ? substr((string) $payload['error'], 0, 200) : "MT5 {$kind} request failed";
            throw new \RuntimeException($message);
        }
        $data = $payload['data'] ?? null;
        if (!is_array($data)) throw new \RuntimeException("MT5 {$kind} response is invalid");
        return $data;
    }

    private function statusPayload(string $state, string $message, array $extra = []): array
    {
        // Never return URL query strings or any environment secrets.
        return array_merge(['state' => $state, 'message' => $message, 'configured' => $this->validUrl()], $extra);
    }

    private function validUrl(): bool
    {
        $parts = parse_url($this->url);
        return is_array($parts) && in_array($parts['scheme'] ?? '', ['http', 'https'], true)
            && !empty($parts['host']) && empty($parts['user']) && empty($parts['pass']);
    }

    private function defaultRequest(string $method, string $path, ?string $token, ?array $body): ?array
    {
        $endpoint = rtrim($this->url, '/') . $path;
        $headers = "Accept: application/json\r\nContent-Type: application/json\r\n";
        if ($token !== null) $headers .= "Authorization: Bearer {$token}\r\n";
        $ctx = stream_context_create(['http' => [
            'method' => $method,
            'timeout' => 5,
            'header' => $headers,
            'ignore_errors' => true,
            'content' => $body === null ? '' : json_encode($body, JSON_THROW_ON_ERROR),
        ], 'ssl' => ['verify_peer' => true, 'verify_peer_name' => true]]);
        $raw = @file_get_contents($endpoint, false, $ctx);
        $decoded = $raw === false ? null : json_decode($raw, true);
        return is_array($decoded) ? $decoded : null;
    }
}
