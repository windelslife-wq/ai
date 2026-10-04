<?php
namespace Aegis\Lottery;

/**
 * WINDELS Lottery Intelligence — Phase 4 (spec §4): rule engine.
 *
 * Rules are DATA, not code assumptions: every engine (validation,
 * statistics, combination generation, system builder, backtesting) reads
 * counts and ranges from a LotteryRules instance, so a rule change or a new
 * lottery is a configuration change, not a rebuild. The active rules can be
 * stored in the database (lottery_rules table); when no stored version
 * exists the code default below is authoritative.
 */
interface LotteryRules
{
    public function code(): string;
    public function name(): string;
    public function version(): string;
    public function mainCount(): int;
    public function mainMin(): int;
    public function mainMax(): int;
    public function starCount(): int;
    public function starMin(): int;
    public function starMax(): int;
    /** @return array{days:int[],time:string,timezone:string} (days: 0=Sun..6=Sat, UTC) */
    public function drawSchedule(): array;
    /**
     * Validate one combination line against the configured rules.
     * @return array{valid:bool,errors:list<string>}
     */
    public function validateLine(array $main, array $stars): array;
    /** Rebuild a rules object from a stored lottery_rules row (admin-updatable). */
    public static function fromArray(string $code, string $name, array $row): self;
}

/**
 * EuroMillions (current official format): 5 main numbers from 1–50,
 * 2 Lucky Stars from 1–12, drawn Tuesdays and Fridays (21:00 UTC).
 */
class EuroMillionsRules implements LotteryRules
{
    private string $code;
    private string $name;
    private string $version;
    private int $mainCount;
    private int $mainMin;
    private int $mainMax;
    private int $starCount;
    private int $starMin;
    private int $starMax;
    private array $schedule;

    public function __construct(
        string $code = 'EUROMILLIONS',
        string $name = 'EuroMillions',
        string $version = '1.0',
        int $mainCount = 5,
        int $mainMin = 1,
        int $mainMax = 50,
        int $starCount = 2,
        int $starMin = 1,
        int $starMax = 12,
        ?array $schedule = null,
    ) {
        $this->code = $code;
        $this->name = $name;
        $this->version = $version;
        $this->mainCount = $mainCount;
        $this->mainMin = $mainMin;
        $this->mainMax = $mainMax;
        $this->starCount = $starCount;
        $this->starMin = $starMin;
        $this->starMax = $starMax;
        $this->schedule = $schedule ?? ['days' => [2, 5], 'time' => '21:00', 'timezone' => 'UTC'];
    }

    public function code(): string { return $this->code; }
    public function name(): string { return $this->name; }
    public function version(): string { return $this->version; }
    public function mainCount(): int { return $this->mainCount; }
    public function mainMin(): int { return $this->mainMin; }
    public function mainMax(): int { return $this->mainMax; }
    public function starCount(): int { return $this->starCount; }
    public function starMin(): int { return $this->starMin; }
    public function starMax(): int { return $this->starMax; }
    public function drawSchedule(): array { return $this->schedule; }

    public function validateLine(array $main, array $stars): array
    {
        $errors = [];
        $errors = array_merge($errors, $this->validateField($main, 'main', $this->mainCount, $this->mainMin, $this->mainMax));
        $errors = array_merge($errors, $this->validateField($stars, 'Lucky Star', $this->starCount, $this->starMin, $this->starMax));
        return ['valid' => $errors === [], 'errors' => $errors];
    }

    private function validateField(array $values, string $label, int $count, int $min, int $max): array
    {
        $errors = [];
        if (count($values) !== $count) {
            $errors[] = "line must contain {$count} {$label} numbers (got " . count($values) . ')';
        }
        foreach ($values as $v) {
            if (!is_int($v) || $v < $min || $v > $max) {
                $errors[] = "{$label} number out of range {$min}-{$max}: " . (is_scalar($v) ? (string) $v : 'invalid');
            }
        }
        $ints = array_values(array_filter($values, 'is_int'));
        if (count($ints) !== count(array_unique($ints))) {
            $errors[] = "duplicate {$label} numbers";
        }
        return $errors;
    }

    public static function fromArray(string $code, string $name, array $row): self
    {
        $schedule = json_decode((string) ($row['schedule'] ?: ''), true);
        return new self(
            $code,
            $name,
            (string) ($row['version'] ?? '1.0'),
            (int) ($row['main_count'] ?? 5),
            (int) ($row['main_min'] ?? 1),
            (int) ($row['main_max'] ?? 50),
            (int) ($row['star_count'] ?? 2),
            (int) ($row['star_min'] ?? 1),
            (int) ($row['star_max'] ?? 12),
            is_array($schedule) && !empty($schedule['days']) ? $schedule : null,
        );
    }
}
