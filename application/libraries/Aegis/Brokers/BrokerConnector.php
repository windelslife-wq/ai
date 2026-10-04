<?php
namespace Aegis\Brokers;

/**
 * Boundary for a broker integration. Connectors may report capability and
 * health, but they never receive strategy/agent objects. Order execution is
 * intentionally reserved for the Phase 5 execution supervisor.
 */
interface BrokerConnector
{
    public function id(): string;
    public function status(): array;
    public function capabilities(): array;
}

/** Collects registered connectors without exposing broker credentials. */
class BrokerManager
{
    /** @var array<string,BrokerConnector> */
    private array $connectors = [];

    public function register(BrokerConnector $connector): void
    {
        $this->connectors[$connector->id()] = $connector;
    }

    public function get(string $id): ?BrokerConnector
    {
        return $this->connectors[$id] ?? null;
    }

    /**
     * First connector that is BOTH order-capable (TradingConnector) and whose
     * bridge-verified status actually reports effective order submission.
     * Returns null when no connector may route orders — the supervisor must
     * then keep routing disabled.
     */
    public function tradingConnector(): ?TradingConnector
    {
        foreach ($this->connectors as $connector) {
            if (!$connector instanceof TradingConnector) continue;
            $status = $connector->status();
            if (($status['state'] ?? '') === 'READY' && ($status['orderSubmissionEffective'] ?? false) === true) {
                return $connector;
            }
        }
        return null;
    }

    public function allStatus(): array
    {
        $out = [];
        foreach ($this->connectors as $id => $connector) {
            $out[$id] = array_merge($connector->status(), [
                'id' => $id,
                'capabilities' => $connector->capabilities(),
            ]);
        }
        return $out;
    }
}
