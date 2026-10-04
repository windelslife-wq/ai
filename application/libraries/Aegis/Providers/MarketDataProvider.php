<?php
namespace Aegis\Providers;

/**
 * Universal market-data abstraction (spec §4). The rest of the system
 * depends on this interface only — never on a concrete provider.
 */
interface MarketDataProvider
{
    public function name(): string;
    public function synthetic(): bool;
    public function priority(): int; // lower = preferred
    public function supportsSymbol(string $symbol): bool;
    public function supportsTimeframe(string $symbol, string $tf): bool;
    /** @return array<int, array{timestamp:int,open:float,high:float,low:float,close:float,volume:float}> */
    public function getCandles(array $req): array;
    /** @return array{symbol:string,bid?:float,ask?:float,last:float,timestamp:int} */
    public function getQuote(string $symbol): array;
    /** @return array{name:string,status:string,synthetic:bool,latencyMs?:int,checkedAt:int,lastError?:string,detail?:string,circuitState?:string} */
    public function healthCheck(): array;
    /** @return array{marketClasses:string[],timeframes:string[],delayed:bool,notes:string} */
    public function capabilities(): array;
}
