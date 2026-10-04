<?php
namespace Aegis\Sports\Providers;

/** Provider-neutral boundary. No application layer may consume raw provider payloads. */
interface SportsDataProvider
{
    public function id(): string;
    /** ONLINE | DEGRADED | OFFLINE | RATE_LIMITED | AUTHENTICATION_ERROR | DATA_ERROR */
    public function health(): array;
    /** @return array<int,array<string,mixed>> normalized only by SportsDataNormalizer */
    public function fixtures(array $query): array;
    public function odds(string $fixtureExternalId): array;
    public function results(string $fixtureExternalId): array;
}

/**
 * Provider registry with a graceful fallback chain (spec §5/§6).
 *
 * `withFallback()` runs an operation against the first provider that is
 * ONLINE and succeeds; failures are classified (ProviderException status),
 * reported through the health observer, and the next provider is tried. If no
 * provider can serve the request the caller receives a structured failure —
 * the pipeline then degrades safely (no fabricated data, no forced tickets).
 */
class SportsProviderManager
{
    /** @var array<string,SportsDataProvider> */
    private array $providers = [];
    /** @var array<string,int> registration order */
    private array $order = [];
    /** @var (callable(SportsDataProvider, string, \Throwable|null, array): void)|null */
    private $observer = null;

    public function register(SportsDataProvider $provider): void
    {
        $this->providers[$provider->id()] = $provider;
        $this->order[] = $provider->id();
    }

    /** Observe every provider outcome for the health monitor. */
    public function setHealthObserver(callable $observer): void
    {
        $this->observer = $observer; // fn(provider, operation, error|null, payload)
    }

    public function provider(string $id): ?SportsDataProvider
    {
        return $this->providers[$id] ?? null;
    }

    /** @return array<string,SportsDataProvider> in registration order */
    public function all(): array
    {
        $out = [];
        foreach ($this->order as $id) if (isset($this->providers[$id])) $out[$id] = $this->providers[$id];
        return $out;
    }

    public function health(): array
    {
        $out = [];
        foreach ($this->all() as $id => $provider) $out[$id] = array_merge(['id' => $id], $provider->health());
        return $out;
    }

    public function configured(): bool { return count($this->providers) > 0; }

    /**
     * Run `$fn(provider)` with provider fallback.
     *
     * @param string $operation fixtures|odds|results
     * @param callable(SportsDataProvider): array $fn
     * @return array{ok:bool, provider?:string, result?:array, failures:array<string,string>}
     */
    public function withFallback(string $operation, callable $fn, ?string $preferredId = null): array
    {
        $failures = [];
        $ids = $this->order;
        if ($preferredId !== null && in_array($preferredId, $ids, true)) {
            $ids = array_merge([$preferredId], array_values(array_diff($ids, [$preferredId])));
        }
        foreach ($ids as $id) {
            $provider = $this->providers[$id];
            try {
                $health = $provider->health();
                if (($health['status'] ?? 'OFFLINE') !== 'ONLINE') {
                    $failures[$id] = 'provider status ' . ($health['status'] ?? 'UNKNOWN') . ($health['detail'] ?? '');
                    $this->notify($provider, $operation, null, ['skipped' => $health['status'] ?? null]);
                    continue;
                }
                $result = $fn($provider);
                $this->notify($provider, $operation, null, ['ok' => true]);
                return ['ok' => true, 'provider' => $id, 'result' => $result, 'failures' => $failures];
            } catch (ProviderException $e) {
                $failures[$id] = $e->status . ': ' . $e->getMessage();
                $this->notify($provider, $operation, $e, []);
            } catch (\Throwable $e) {
                $failures[$id] = 'DATA_ERROR: ' . $e->getMessage();
                $this->notify($provider, $operation, new ProviderException($e->getMessage(), ProviderException::DATA_ERROR, $e), []);
            }
        }
        return ['ok' => false, 'failures' => $failures];
    }

    private function notify(SportsDataProvider $provider, string $operation, ?\Throwable $error, array $payload): void
    {
        if ($this->observer !== null) {
            try { ($this->observer)($provider, $operation, $error, $payload); }
            catch (\Throwable $e) { /* health observation must never break sync */ }
        }
    }
}
