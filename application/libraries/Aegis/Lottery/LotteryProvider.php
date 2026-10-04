<?php
namespace Aegis\Lottery;

/**
 * WINDELS Lottery Intelligence — Phase 3 (spec §3): provider abstraction.
 *
 * Provider-neutral contract: additional lotteries plug in by adding a
 * provider + rules set, without touching the statistics, backtesting or
 * ticket engines. A provider returns NORMALIZED raw draws; every draw must
 * carry source attribution and a source timestamp (spec §5). AI-generated
 * or simulated data is only ever acceptable through clearly-labeled
 * sandbox providers — never as official results.
 */
interface LotteryProvider
{
    public function id(): string;
    public function name(): string;
    /** @return array{state:string,licensed:bool,synthetic:bool,message:string} */
    public function health(): array;
    /**
     * Normalized draw results (newest last is NOT guaranteed — consumers
     * order by drawDate). Shape per draw:
     *   externalId:string, drawDate:'YYYY-MM-DD', main:int[], stars:int[],
     *   jackpot:?string, rollover:bool, winners:?string,
     *   source:string, sourceTimestamp:ISO-8601
     * @return list<array<string,mixed>>
     */
    public function draws(?string $from = null, ?string $to = null, int $limit = 100): array;
    /** @return array<string,mixed>|null Official jackpot info where legally available, else null. */
    public function jackpotInfo(): ?array;
}

/** Safe default: no data is preferable to unlicensed or fabricated results. */
class UnavailableLotteryProvider implements LotteryProvider
{
    public function id(): string { return 'unconfigured'; }
    public function name(): string { return 'No lottery data provider configured'; }
    public function health(): array
    {
        return ['state' => 'UNCONFIGURED', 'licensed' => false, 'synthetic' => false,
            'message' => 'No lottery data provider configured — configure an authorized source (environment-only credentials) to enable ingestion'];
    }
    public function draws(?string $from = null, ?string $to = null, int $limit = 100): array { return []; }
    public function jackpotInfo(): ?array { return null; }
}

/**
 * Clearly-labeled SIMULATION provider for pipeline testing (the same pattern
 * as the trading SyntheticProvider and the sports sandbox provider). Draws
 * are deterministic per seed, always carry source 'sandbox-simulation', and
 * are NEVER presented as official results. Only online when
 * WINDELS_LOTTERY_SANDBOX=1.
 */
class SandboxLotteryProvider implements LotteryProvider
{
    public const SOURCE = 'sandbox-simulation';

    public function __construct(private int $seed = 42) {}

    public function id(): string { return 'sandbox-sim'; }
    public function name(): string { return 'Sandbox Simulation (clearly labeled — never official)'; }

    public function enabled(): bool { return getenv('WINDELS_LOTTERY_SANDBOX') === '1'; }

    public function health(): array
    {
        if (!$this->enabled()) {
            return ['state' => 'OFFLINE', 'licensed' => false, 'synthetic' => true,
                'message' => 'SANDBOX_NOT_ENABLED — set WINDELS_LOTTERY_SANDBOX=1 for clearly-labeled simulated draws (pipeline testing only)'];
        }
        return ['state' => 'ONLINE', 'licensed' => false, 'synthetic' => true,
            'message' => 'Simulated draws for pipeline testing only — NOT official results'];
    }

    public function draws(?string $from = null, ?string $to = null, int $limit = 100): array
    {
        if (!$this->enabled()) return [];
        $rules = new EuroMillionsRules();
        $limit = min(1000, max(1, $limit));
        $rand = \Aegis\MathUtils::seededRandom($this->seed);
        $out = [];
        $ts = (int) time();
        $n = 0;
        while ($n < $limit) {
            $ts -= 86400; // walk backwards day by day
            $dow = (int) gmdate('w', $ts);
            if (!in_array($dow, $rules->drawSchedule()['days'], true)) continue;
            $drawDate = gmdate('Y-m-d', $ts);
            if ($to !== null && $drawDate > $to) continue;
            if ($from !== null && $drawDate < $from) break;
            $main = [];
            while (count($main) < $rules->mainCount()) {
                $x = $rules->mainMin() + (int) ($rand() * $rules->mainMax());
                if (!in_array($x, $main, true)) $main[] = $x;
            }
            sort($main);
            $stars = [];
            while (count($stars) < $rules->starCount()) {
                $x = $rules->starMin() + (int) ($rand() * $rules->starMax());
                if (!in_array($x, $stars, true)) $stars[] = $x;
            }
            sort($stars);
            $out[] = [
                'externalId' => 'SIM-' . $drawDate,
                'drawDate' => $drawDate,
                'main' => $main,
                'stars' => $stars,
                'jackpot' => number_format(1000000 + (int) ($rand() * 19000000), 2, '.', ''),
                'rollover' => $rand() > 0.8,
                'winners' => null,
                'source' => self::SOURCE,
                'sourceTimestamp' => gmdate('c', $ts),
            ];
            $n++;
        }
        return $out;
    }

    public function jackpotInfo(): ?array
    {
        if (!$this->enabled()) return null;
        return ['source' => self::SOURCE, 'value' => null,
            'note' => 'Simulated environment — no real jackpot figure is available or fabricated'];
    }
}
