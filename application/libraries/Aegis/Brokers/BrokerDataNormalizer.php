<?php
namespace Aegis\Brokers;

/** Canonical, read-only broker data contracts used beyond individual bridges. */
class BrokerDataNormalizer
{
    public static function account(array $raw, string $broker): array
    {
        $currency = strtoupper((string) ($raw['currency'] ?? ''));
        if (!preg_match('/^[A-Z]{3}$/', $currency)) throw new \RuntimeException('broker account currency is invalid');
        $balance = self::number($raw, 'balance');
        $equity = self::number($raw, 'equity');
        $margin = self::number($raw, 'margin', 0.0);
        $freeMargin = self::number($raw, 'freeMargin', max(0.0, $equity - $margin));
        if ($balance < 0 || $equity < 0 || $margin < 0 || $freeMargin < 0) throw new \RuntimeException('broker account values cannot be negative');
        return [
            'broker' => $broker,
            'accountId' => (string) ($raw['accountId'] ?? $raw['login'] ?? ''),
            'currency' => $currency,
            'balance' => $balance,
            'equity' => $equity,
            'margin' => $margin,
            'freeMargin' => $freeMargin,
            'leverage' => self::number($raw, 'leverage', 0.0),
            'timestamp' => self::timestamp($raw['timestamp'] ?? null),
        ];
    }

    public static function quote(array $raw, string $broker): array
    {
        $symbol = strtoupper((string) ($raw['symbol'] ?? ''));
        if (!preg_match('/^[A-Z0-9._-]{1,32}$/', $symbol)) throw new \RuntimeException('broker quote symbol is invalid');
        $bid = self::number($raw, 'bid');
        $ask = self::number($raw, 'ask');
        if ($bid <= 0 || $ask <= 0 || $ask < $bid) throw new \RuntimeException('broker quote bid/ask is invalid');
        $last = isset($raw['last']) ? self::number($raw, 'last') : ($bid + $ask) / 2;
        return [
            'broker' => $broker, 'symbol' => $symbol, 'bid' => $bid, 'ask' => $ask,
            'last' => $last, 'spread' => $ask - $bid,
            'timestamp' => self::timestamp($raw['timestamp'] ?? null),
        ];
    }

    private static function number(array $raw, string $key, ?float $default = null): float
    {
        if (!array_key_exists($key, $raw)) {
            if ($default !== null) return $default;
            throw new \RuntimeException("broker response missing {$key}");
        }
        if (!is_numeric($raw[$key]) || !is_finite((float) $raw[$key])) throw new \RuntimeException("broker response {$key} is invalid");
        return (float) $raw[$key];
    }

    private static function timestamp($value): string
    {
        if ($value === null || $value === '') return gmdate('c');
        if (is_numeric($value)) return gmdate('c', (int) $value);
        try { return (new \DateTimeImmutable((string) $value))->setTimezone(new \DateTimeZone('UTC'))->format('c'); }
        catch (\Throwable $e) { throw new \RuntimeException('broker response timestamp is invalid'); }
    }

    // ---------------------------------------------------- trading contracts

    /** @param array<int, array<string, mixed>> $raw */
    public static function positions(array $raw, string $broker): array
    {
        $out = [];
        foreach ($raw as $row) {
            if (!is_array($row)) continue;
            $out[] = [
                'broker' => $broker,
                'ticket' => (int) self::number($row, 'ticket'),
                'symbol' => self::symbol($row),
                'side' => self::enum($row, 'side', ['LONG', 'SHORT']),
                'volume' => self::number($row, 'volume'),
                'entry' => self::number($row, 'entry'),
                'stopLoss' => self::optionalNumber($row, 'stopLoss'),
                'takeProfit' => self::optionalNumber($row, 'takeProfit'),
                'profit' => self::number($row, 'profit', 0.0),
                'openedAt' => self::timestamp($row['openedAt'] ?? null),
            ];
        }
        return $out;
    }

    /** @param array<int, array<string, mixed>> $raw */
    public static function pendingOrders(array $raw, string $broker): array
    {
        $out = [];
        foreach ($raw as $row) {
            if (!is_array($row)) continue;
            $out[] = [
                'broker' => $broker,
                'ticket' => (int) self::number($row, 'ticket'),
                'symbol' => self::symbol($row),
                'side' => self::enum($row, 'side', ['BUY', 'SELL']),
                'type' => self::enum($row, 'type', ['LIMIT', 'STOP']),
                'volume' => self::number($row, 'volume'),
                'price' => self::number($row, 'price'),
                'stopLoss' => self::optionalNumber($row, 'stopLoss'),
                'takeProfit' => self::optionalNumber($row, 'takeProfit'),
                'placedAt' => self::timestamp($row['placedAt'] ?? null),
            ];
        }
        return $out;
    }

    /** @param array<int, array<string, mixed>> $raw */
    public static function history(array $raw, string $broker): array
    {
        $out = [];
        foreach ($raw as $row) {
            if (!is_array($row)) continue;
            $out[] = [
                'broker' => $broker,
                'ticket' => (int) self::number($row, 'ticket'),
                'symbol' => self::symbol($row),
                'side' => self::enum($row, 'side', ['LONG', 'SHORT']),
                'volume' => self::number($row, 'volume'),
                'entry' => self::number($row, 'entry'),
                'exit' => self::number($row, 'exit'),
                'profit' => self::number($row, 'profit', 0.0),
                'openedAt' => self::timestamp($row['openedAt'] ?? null),
                'closedAt' => self::timestamp($row['closedAt'] ?? null),
            ];
        }
        return $out;
    }

    /** @param array<int, array<string, mixed>> $raw normalized OHLCV candles */
    public static function candles(array $raw, string $broker): array
    {
        $out = [];
        foreach ($raw as $row) {
            if (!is_array($row)) continue;
            $open = self::number($row, 'o');
            $close = self::number($row, 'c');
            $high = self::number($row, 'h');
            $low = self::number($row, 'l');
            if ($high < $low || $high < $open || $high < $close || $low > $open || $low > $close) {
                throw new \RuntimeException('broker candle OHLC relationship is invalid');
            }
            $out[] = [
                'broker' => $broker,
                'time' => self::timestamp($row['t'] ?? null),
                'open' => $open, 'high' => $high, 'low' => $low, 'close' => $close,
                'volume' => self::number($row, 'v', 0.0),
            ];
        }
        return $out;
    }

    public static function orderResult(array $raw, string $broker): array
    {
        return [
            'broker' => $broker,
            'ticket' => (int) self::number($raw, 'ticket'),
            'price' => self::number($raw, 'price'),
            'placedAt' => self::timestamp($raw['placedAt'] ?? null),
        ];
    }

    public static function ticketResult(array $raw, string $broker): array
    {
        return ['broker' => $broker, 'ticket' => (int) self::number($raw, 'ticket'), 'confirmed' => true];
    }

    public static function closeResult(array $raw, string $broker): array
    {
        return [
            'broker' => $broker,
            'ticket' => (int) self::number($raw, 'ticket'),
            'price' => self::number($raw, 'price'),
            'profit' => self::number($raw, 'profit', 0.0),
        ];
    }

    private static function symbol(array $raw): string
    {
        $symbol = strtoupper((string) ($raw['symbol'] ?? ''));
        if (!preg_match('/^[A-Z0-9._-]{1,32}$/', $symbol)) throw new \RuntimeException('broker symbol is invalid');
        return $symbol;
    }

    private static function enum(array $raw, string $key, array $allowed): string
    {
        $value = strtoupper((string) ($raw[$key] ?? ''));
        if (!in_array($value, $allowed, true)) throw new \RuntimeException("broker response {$key} is invalid");
        return $value;
    }

    private static function optionalNumber(array $raw, string $key): ?float
    {
        if (!array_key_exists($key, $raw) || $raw[$key] === null || $raw[$key] === '') return null;
        return self::number($raw, $key);
    }
}
