<?php
namespace Aegis;

class CircuitBreaker
{
    private array $failures = [];
    private string $state = 'CLOSED';
    private int $openedAt = 0;

    public function __construct(
        public readonly string $name,
        private readonly int $threshold = 5,
        private readonly int $windowMs = 60000,
        private readonly int $cooldownMs = 30000,
    ) {}

    public function currentState(): string
    {
        if ($this->state === 'OPEN' && (int)((int)(microtime(true) * 1000) - $this->openedAt) >= $this->cooldownMs) {
            $this->state = 'HALF_OPEN';
        }
        return $this->state;
    }

    public function canCall(): bool
    {
        $s = $this->currentState();
        return $s === 'CLOSED' || $s === 'HALF_OPEN';
    }

    public function recordSuccess(): void
    {
        $this->failures = [];
        $this->state = 'CLOSED';
    }

    public function recordFailure(): void
    {
        $now = (int)(microtime(true) * 1000);
        $this->failures[] = $now;
        $this->failures = array_values(array_filter($this->failures, fn($t) => $now - $t <= $this->windowMs));
        if ($this->state === 'HALF_OPEN' || count($this->failures) >= $this->threshold) {
            $this->state = 'OPEN';
            $this->openedAt = $now;
        }
    }
}
