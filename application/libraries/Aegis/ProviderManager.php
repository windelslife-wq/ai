<?php
namespace Aegis;

use Aegis\Providers\MarketDataProvider;

/**
 * Resolves market data through the provider chain with caching,
 * circuit-breaker gating, priority order and explicit fallback tracking.
 * When the synthetic provider ends up serving, provenance.synthetic=true
 * flows downstream so every layer can label and gate on it.
 */
class ProviderManager
{
    /** @var MarketDataProvider[] */
    private array $providers = [];
    private array $candleCache = [];
    private array $quoteCache = [];
    private array $healthCache = [];
    private array $failureLog = [];
    /** @var callable|null */
    private $onFallback;

    public function register(MarketDataProvider $p): void
    {
        $this->providers[] = $p;
        usort($this->providers, fn($a, $b) => $a->priority() <=> $b->priority());
    }

    public function setFallbackHandler(callable $fn): void
    {
        $this->onFallback = $fn;
    }

    /** @return MarketDataProvider[] */
    public function listProviders(): array
    {
        return $this->providers;
    }

    public function candidatesFor(string $symbol, string $timeframe, ?string $marketClass = null): array
    {
        $cands = array_values(array_filter($this->providers, function ($p) use ($symbol, $marketClass) {
            if (!$p->supportsSymbol($symbol)) return false;
            // New asset-class providers expose this optional method. Keeping
            // it optional preserves compatibility with existing providers and
            // third-party test doubles implementing the original interface.
            if ($marketClass !== null) {
                if (method_exists($p, 'supportsMarketClass')) {
                    if (!$p->supportsMarketClass($marketClass)) return false;
                } else {
                    $classes = $p->capabilities()['marketClasses'] ?? [];
                    if (is_array($classes) && $classes !== [] && !in_array(strtolower($marketClass), array_map('strtolower', $classes), true)) return false;
                }
            }
            return true;
        }));
        usort($cands, function ($a, $b) use ($symbol, $timeframe) {
            $ta = $a->supportsTimeframe($symbol, $timeframe) ? 1 : 0;
            $tb = $b->supportsTimeframe($symbol, $timeframe) ? 1 : 0;
            return $tb <=> $ta // timeframe-capable first
                ?: $a->priority() <=> $b->priority();
        });
        return $cands;
    }

    public function getCandleSeries(string $symbol, string $marketClass, string $timeframe, int $limit): array
    {
        $fetchedAt = (int)(microtime(true) * 1000);
        [$candles, $provider, $failed] = $this->fetchCandles($symbol, $marketClass, $timeframe, $limit);
        $norm = CandleNormalizer::normalize($candles, $timeframe);
        $candles = $norm['candles'];
        $validation = $norm['validation'];

        $dataTimestamp = count($candles) ? end($candles)['timestamp'] : 0;
        $staleThreshold = Timeframes::staleMs($timeframe);
        $dataAgeMs = max(0, $fetchedAt - $dataTimestamp);

        $provenance = [
            'source' => $provider->name(),
            'synthetic' => $provider->synthetic(),
            'live' => !$provider->synthetic(),
            'delayed' => $provider->capabilities()['delayed'],
            'fetchedAt' => $fetchedAt,
            'dataTimestamp' => $dataTimestamp,
            'dataAgeMs' => $dataAgeMs,
            'stale' => $dataTimestamp === 0 || $dataAgeMs > $staleThreshold,
            'fallbackChain' => $failed,
        ];

        return [
            'symbol' => strtoupper($symbol),
            'marketClass' => $marketClass,
            'timeframe' => $timeframe,
            'candles' => $candles,
            'provenance' => $provenance,
            'validation' => $validation,
        ];
    }

    public function getQuote(string $symbol): array
    {
        $key = 'q:' . strtoupper($symbol);
        if (isset($this->quoteCache[$key]) && $this->quoteCache[$key]['expires'] > microtime(true)) {
            return $this->quoteCache[$key]['payload'];
        }
        $cands = array_values(array_filter($this->providers, fn($p) => $p->supportsSymbol($symbol)));
        usort($cands, fn($a, $b) => $a->priority() <=> $b->priority());
        $failed = [];
        foreach ($cands as $provider) {
            try {
                $quote = $provider->getQuote($symbol);
                $payload = ['quote' => $quote, 'source' => $provider->name(), 'synthetic' => $provider->synthetic(), 'fallbackChain' => $failed];
                $this->quoteCache[$key] = ['expires' => microtime(true) + 15, 'payload' => $payload];
                return $payload;
            } catch (\Throwable $e) {
                $this->failureLog[$provider->name()] = $e->getMessage();
                $failed[] = $provider->name();
            }
        }
        throw new \RuntimeException('No provider could serve a quote for ' . $symbol);
    }

    public function getAllHealth(bool $force = false): array
    {
        $out = [];
        foreach ($this->providers as $p) {
            $key = 'h:' . $p->name();
            if (!$force && isset($this->healthCache[$key]) && $this->healthCache[$key]['expires'] > microtime(true)) {
                $out[] = $this->healthCache[$key]['payload'];
                continue;
            }
            try {
                $h = $p->healthCheck();
            } catch (\Throwable $e) {
                $h = ['name' => $p->name(), 'status' => 'DOWN', 'synthetic' => $p->synthetic(), 'checkedAt' => time(), 'lastError' => $e->getMessage()];
            }
            if (!empty($this->failureLog[$p->name()]) && ($h['status'] ?? '') === 'UP') {
                $h['status'] = 'DEGRADED';
            }
            $this->healthCache[$key] = ['expires' => microtime(true) + 10, 'payload' => $h];
            $out[] = $h;
        }
        return $out;
    }

    private function fetchCandles(string $symbol, string $marketClass, string $timeframe, int $limit): array
    {
        $key = 'c:' . strtolower($marketClass) . ':' . strtoupper($symbol) . ':' . $timeframe . ':' . $limit;
        if (isset($this->candleCache[$key]) && $this->candleCache[$key]['expires'] > microtime(true)) {
            $e = $this->candleCache[$key];
            return [$e['candles'], $e['provider'], []];
        }
        $failed = [];
        foreach ($this->candidatesFor($symbol, $timeframe, $marketClass) as $provider) {
            try {
                $candles = $provider->getCandles(['symbol' => $symbol, 'timeframe' => $timeframe, 'limit' => $limit]);
                if (!is_array($candles) || count($candles) === 0) {
                    throw new \RuntimeException('empty candle response');
                }
                $preview = CandleNormalizer::normalize($candles, $timeframe);
                if (count($preview['candles']) < 30) {
                    throw new \RuntimeException($provider->name() . ' returned too few valid candles (' . count($preview['candles']) . ')');
                }
                $ttl = max(15, Timeframes::ms($timeframe) * 0.25);
                $this->candleCache[$key] = ['expires' => microtime(true) + $ttl / 1000, 'candles' => $candles, 'provider' => $provider];
                if (count($failed) > 0 && $this->onFallback) {
                    ($this->onFallback)(['symbol' => $symbol, 'failed' => $failed, 'used' => $provider->name()]);
                }
                return [$candles, $provider, $failed];
            } catch (\Throwable $e) {
                $this->failureLog[$provider->name()] = $e->getMessage();
                $failed[] = $provider->name();
                usleep(50000);
            }
        }
        throw new \RuntimeException('No provider could serve candles for ' . $symbol . ' ' . $timeframe . '. Failed: ' . implode(', ', $failed));
    }
}
