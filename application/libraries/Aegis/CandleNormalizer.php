<?php
namespace Aegis;

class CandleNormalizer
{
    /**
     * Normalize + validate candles: drop invalid rows, repair high/low
     * envelopes, sort chronologically, de-duplicate, count gaps.
     */
    public static function normalize(array $raw, string $timeframe): array
    {
        $issues = [];
        $clean = [];
        $dropped = 0;

        foreach ($raw as $c) {
            if (!is_array($c)) { $dropped++; continue; }
            $vals = [$c['open'] ?? NAN, $c['high'] ?? NAN, $c['low'] ?? NAN, $c['close'] ?? NAN];
            $valid = true;
            foreach ($vals as $v) {
                if (!is_numeric($v) || !is_finite((float)$v) || (float)$v <= 0) { $valid = false; break; }
            }
            $vol = $c['volume'] ?? NAN;
            if (!$valid || !is_numeric($vol) || (float)$vol < 0 || !isset($c['timestamp']) || !is_numeric($c['timestamp']) || (int)$c['timestamp'] <= 0) {
                $dropped++;
                continue;
            }
            $high = (float)$c['high'];
            $low = (float)$c['low'];
            $bodyMax = max((float)$c['open'], (float)$c['close']);
            $bodyMin = min((float)$c['open'], (float)$c['close']);
            if ($high < $bodyMax) {
                $high = $bodyMax;
                $issues[] = 'high clamped below close/open body';
            }
            if ($low > $bodyMin) {
                $low = $bodyMin;
                $issues[] = 'low clamped above close/open body';
            }
            $clean[] = [
                'timestamp' => (int)$c['timestamp'],
                'open' => (float)$c['open'],
                'high' => $high,
                'low' => $low,
                'close' => (float)$c['close'],
                'volume' => (float)$vol,
            ];
        }

        usort($clean, fn($a, $b) => $a['timestamp'] <=> $b['timestamp']);

        $deduped = [];
        foreach ($clean as $c) {
            $n = count($deduped);
            if ($n > 0 && $deduped[$n - 1]['timestamp'] === $c['timestamp']) {
                $issues[] = 'duplicate candle dropped';
                continue;
            }
            $deduped[] = $c;
        }

        $interval = Timeframes::ms($timeframe);
        $gaps = 0;
        for ($i = 1, $n = count($deduped); $i < $n; $i++) {
            if ($deduped[$i]['timestamp'] - $deduped[$i - 1]['timestamp'] > $interval * 1.5) {
                $gaps++;
            }
        }

        $ok = count($deduped) >= 30 && $gaps <= max(2, floor(count($deduped) * 0.1));

        return [
            'candles' => $deduped,
            'validation' => [
                'ok' => $ok,
                'droppedCount' => count($raw) - count($deduped),
                'gapCount' => $gaps,
                'expectedIntervalMs' => $interval,
                'coveredIntervalMs' => count($deduped) > 1 ? end($deduped)['timestamp'] - $deduped[0]['timestamp'] : 0,
                'minTimestamp' => count($deduped) ? $deduped[0]['timestamp'] : 0,
                'maxTimestamp' => count($deduped) ? end($deduped)['timestamp'] : 0,
                'issues' => array_slice($issues, 0, 20),
            ],
        ];
    }
}
