<?php
namespace Aegis\Providers;

use Aegis\MathUtils;
use Aegis\Timeframes;

/**
 * SYNTHETIC DEMO PROVIDER — deterministic, reproducible market data.
 * Every candle it serves is flagged via synthetic=true and the provider
 * manager stamps provenance.synthetic so the UI can show the mandatory
 * "SIMULATION / SYNTHETIC DATA" banner (Rule 2). Registered LAST; only
 * serves when every real provider has failed.
 */
class SyntheticProvider implements MarketDataProvider
{
    public const BASE_PRICES = [
        'EURUSD' => 1.085, 'GBPUSD' => 1.27, 'USDJPY' => 151.5, 'AUDUSD' => 0.66,
        'USDCAD' => 1.36, 'USDCHF' => 0.895, 'NZDUSD' => 0.61, 'XAUUSD' => 2320,
        'BTCUSDT' => 64000, 'ETHUSDT' => 3300, 'SOLUSDT' => 148, 'BNBUSDT' => 590, 'XRPUSDT' => 0.62,
    ];

    public function name(): string { return 'synthetic-demo'; }
    public function synthetic(): bool { return true; }
    public function priority(): int { return 999; }
    public function supportsSymbol(string $symbol): bool { return true; }
    public function supportsTimeframe(string $symbol, string $tf): bool { return true; }

    public function getCandles(array $req): array
    {
        return self::generate($req['symbol'], $req['timeframe'], $req['limit']);
    }

    public static function generate(string $symbol, string $timeframe, int $limit, ?int $now = null): array
    {
        $rand = MathUtils::seededRandom(MathUtils::hashString("aegis:{$symbol}:{$timeframe}"));
        $interval = Timeframes::ms($timeframe);
        $now = $now ?? (int)(microtime(true) * 1000);
        $lastOpen = (int)(floor($now / $interval) * $interval) - $interval;

        $price = self::BASE_PRICES[$symbol] ?? (10 + (MathUtils::hashString($symbol) % 5000) / 10);
        $fx = !str_contains($symbol, 'BTC') && !str_contains($symbol, 'ETH') && !str_contains($symbol, 'SOL');
        $volScale = $fx || str_starts_with($symbol, 'XAU') ? 0.0012 : 0.004;

        $candles = [];
        for ($i = 0; $i < $limit; $i++) {
            $ts = $lastOpen - ($limit - 1 - $i) * $interval;
            $phase = intdiv($i, 40) % 4;
            $drift = 0.0;
            $vol = $volScale;
            if ($phase === 0) { $drift = 0.0018; }
            elseif ($phase === 1) { $drift = 0.0; $vol = $volScale * 0.7; }
            elseif ($phase === 2) { $drift = -0.0015; $vol = $volScale * 1.4; }
            else { $drift = 0.0004; $vol = $volScale * 1.1; }

            $ret = $drift + MathUtils::gaussian($rand) * $vol;
            $open = $price;
            $close = $open * (1 + $ret);
            $wick = abs(MathUtils::gaussian($rand)) * $vol * $open * 0.8;
            $high = max($open, $close) + $wick * $rand();
            $low = min($open, $close) - $wick * $rand();
            $baseVolume = str_starts_with($symbol, 'BTC') || str_starts_with($symbol, 'ETH') ? 800 : 1000000;
            $volume = (int)round($baseVolume * (0.5 + $rand() * 1.5) * (1 + abs($ret) * 40));

            $candles[] = [
                'timestamp' => $ts,
                'open' => round($open, 6),
                'high' => round($high, 6),
                'low' => round($low, 6),
                'close' => round($close, 6),
                'volume' => max(1, $volume),
            ];
            $price = $close;
        }
        return $candles;
    }

    public function getQuote(string $symbol): array
    {
        $candles = self::generate($symbol, '1m', 2);
        $last = end($candles);
        $spread = $last['close'] * 0.0002;
        return [
            'symbol' => $symbol,
            'bid' => round($last['close'] - $spread / 2, 6),
            'ask' => round($last['close'] + $spread / 2, 6),
            'last' => $last['close'],
            'timestamp' => $last['timestamp'],
        ];
    }

    public function healthCheck(): array
    {
        return [
            'name' => $this->name(),
            'status' => 'UP',
            'synthetic' => true,
            'latencyMs' => 0,
            'checkedAt' => time(),
            'detail' => 'Deterministic synthetic generator (SIMULATION ONLY — not market data)',
            'circuitState' => 'CLOSED',
        ];
    }

    public function capabilities(): array
    {
        return [
            'marketClasses' => ['forex', 'crypto', 'stock', 'etf', 'commodity', 'futures', 'indices', 'bonds'],
            'timeframes' => Timeframes::ALL,
            'delayed' => false,
            'notes' => 'SYNTHETIC DATA — deterministic simulation for offline development/testing.',
        ];
    }
}
