<?php
namespace Aegis;

class MathUtils
{
    public static function clamp(float $v, float $min, float $max): float
    {
        return max($min, min($max, $v));
    }

    public static function mean(array $xs): ?float
    {
        $n = count($xs);
        if ($n === 0) {
            return null;
        }
        return array_sum($xs) / $n;
    }

    public static function stdev(array $xs): ?float
    {
        $n = count($xs);
        if ($n < 2) {
            return null;
        }
        $m = self::mean($xs);
        $acc = 0.0;
        foreach ($xs as $x) {
            $acc += ($x - $m) ** 2;
        }
        return sqrt($acc / $n);
    }

    public static function hashString(string $s): int
    {
        $h = 2166136261;
        $len = strlen($s);
        for ($i = 0; $i < $len; $i++) {
            $h ^= ord($s[$i]);
            $h = ($h * 16777619) & 0xFFFFFFFF;
            if ($h & 0x80000000) { // emulate 32-bit overflow of int32 multiply
                $h = ($h & 0x7FFFFFFF) | ((~($h ^ 0x7FFFFFFF)) & 0x80000000);
            }
        }
        return $h | 0; // signed like the TS version
    }

    /**
     * Deterministic xorshift PRNG (matches the TS implementation's sequence
     * semantics: unsigned 32-bit state, output / 2^32).
     */
    public static function seededRandom(int $seed): \Closure
    {
        $s = $seed !== 0 ? ($seed & 0xFFFFFFFF) : 1;
        return function () use (&$s): float {
            $s ^= ($s << 13) & 0xFFFFFFFF; $s &= 0xFFFFFFFF;
            $s ^= $s >> 17;
            $s ^= ($s << 5) & 0xFFFFFFFF;  $s &= 0xFFFFFFFF;
            return $s / 4294967296.0;
        };
    }

    public static function gaussian(\Closure $rand): float
    {
        $u = max($rand(), 1e-12);
        $v = $rand();
        return sqrt(-2 * log($u)) * cos(2 * M_PI * $v);
    }
}
