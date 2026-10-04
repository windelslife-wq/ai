<?php
namespace Aegis\Providers;

/** Phase 6 contract for attributable, licensed fundamentals data. */
interface FundamentalsFeed
{
    public function id(): string;
    public function health(): array;
    /** Returns normalized events/metrics with source, observedAt, and license metadata. */
    public function snapshot(string $symbol): array;
}

/** Safe default: no data is preferable to unlicensed or stale pseudo-data. */
class UnavailableFundamentalsFeed implements FundamentalsFeed
{
    public function id(): string { return 'unconfigured'; }
    public function health(): array { return ['state' => 'UNCONFIGURED', 'licensed' => false, 'message' => 'No licensed fundamentals feed configured']; }
    public function snapshot(string $symbol): array
    {
        return ['available' => false, 'symbol' => strtoupper($symbol), 'source' => null, 'observedAt' => null,
            'licensed' => false, 'reason' => 'No licensed fundamentals feed configured'];
    }
}
