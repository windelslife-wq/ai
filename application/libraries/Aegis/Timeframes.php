<?php
namespace Aegis;

class Timeframes
{
    public const ALL = ['1m', '5m', '15m', '1h', '4h', '1d'];

    public static function ms(string $tf): int
    {
        return [
            '1m' => 60000,
            '5m' => 300000,
            '15m' => 900000,
            '1h' => 3600000,
            '4h' => 14400000,
            '1d' => 86400000,
        ][$tf] ?? 3600000;
    }

    /** Staleness thresholds per timeframe (matches the TS edition). */
    public static function staleMs(string $tf): int
    {
        return [
            '1m' => 5 * 60000,
            '5m' => 15 * 60000,
            '15m' => 45 * 60000,
            '1h' => 3 * 3600000,
            '4h' => 12 * 3600000,
            '1d' => 4 * 86400000,
        ][$tf] ?? 3 * 3600000;
    }
}
