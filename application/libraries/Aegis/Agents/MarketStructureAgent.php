<?php
namespace Aegis\Agents;

use Aegis\Agents\AgentHelperTrait;
use Aegis\Indicators;
use Aegis\MathUtils;

/**
 * Market Structure Agent — swings, BOS/CHoCH (close-confirmed by default;
 * a wick alone NEVER confirms), liquidity zones, supply/demand, order
 * blocks, fair value gaps.
 */
class MarketStructureAgent
{
    use AgentHelperTrait;

    public const ID = 'market-structure';

    public const RULES = [
        'requireCloseBeyond' => true,
        'minBodyRatio' => 0.3,
        'swingStrength' => 2,
    ];

    public function applicable(array $ctx): bool { return true; }

    public function analyze(array $ctx): array
    {
        $candles = $ctx['series']['candles'] ?? [];
        if (!is_array($candles) || $candles === []) {
            throw new \RuntimeException('insufficient candles for market-structure analysis');
        }
        $k = self::RULES['swingStrength'];
        $swings = Indicators::findSwings($candles, $k);
        $atr14 = Indicators::last(Indicators::atr($candles, 14));
        $lastClose = end($candles)['close'];

        // Swing sequence HH/HL/LH/LL
        $seq = [];
        for ($i = 2, $m = count($swings); $i < $m; $i++) {
            $cur = $swings[$i];
            $prevSame = null;
            for ($j = $i - 1; $j >= 0; $j--) {
                if ($swings[$j]['type'] === $cur['type']) { $prevSame = $swings[$j]; break; }
            }
            if (!$prevSame) { continue; }
            $seq[] = $cur['type'] === 'high'
                ? ($cur['price'] > $prevSame['price'] ? 'HH' : 'LH')
                : ($cur['price'] < $prevSame['price'] ? 'LL' : 'HL');
        }
        $tail = array_slice($seq, -6);
        $counts = array_count_values($tail);
        $hhhl = ($counts['HH'] ?? 0) + ($counts['HL'] ?? 0);
        $lhll = ($counts['LH'] ?? 0) + ($counts['LL'] ?? 0);
        $trendLabel = ($hhhl >= $lhll + 2) ? 'uptrend' : (($lhll >= $hhhl + 2) ? 'downtrend' : 'range');

        $lastHigh = null; $lastLow = null;
        for ($i = count($swings) - 1; $i >= 0; $i--) {
            if ($lastHigh === null && $swings[$i]['type'] === 'high') $lastHigh = $swings[$i];
            if ($lastLow === null && $swings[$i]['type'] === 'low') $lastLow = $swings[$i];
            if ($lastHigh !== null && $lastLow !== null) break;
        }
        $bos = $this->detectBreak($candles, $lastHigh['price'] ?? null, $lastLow['price'] ?? null);
        $choch = $this->detectChoch($seq, $bos);

        $liquidity = array_map(fn($s) => [
            'type' => $s['type'] === 'high' ? 'buy-side' : 'sell-side',
            'price' => round($s['price'], 6),
            'formedAt' => $s['timestamp'],
        ], array_slice($swings, -8));

        $zones = $this->detectZones(array_slice($candles, -min(count($candles), 60)), $atr14);

        $score = 0.0;
        $reasons = [];
        if ($trendLabel === 'uptrend') { $score += 0.35; $reasons[] = 'swing sequence shows HH/HL dominance'; }
        if ($trendLabel === 'downtrend') { $score -= 0.35; $reasons[] = 'swing sequence shows LH/LL dominance'; }
        if ($bos['detected'] && $bos['direction'] === 'BUY' && $bos['confirmedBy'] === 'CLOSE') { $score += 0.3; $reasons[] = 'confirmed bullish break of structure (close beyond)'; }
        if ($bos['detected'] && $bos['direction'] === 'SELL' && $bos['confirmedBy'] === 'CLOSE') { $score -= 0.3; $reasons[] = 'confirmed bearish break of structure (close beyond)'; }
        if ($choch['detected'] && $choch['confirmedBy'] === 'CLOSE') {
            $score += $choch['direction'] === 'BUY' ? 0.25 : -0.25;
            $reasons[] = 'change of character ' . ($choch['direction'] === 'BUY' ? 'bullish' : 'bearish') . ' (close-confirmed)';
        }
        if ($bos['detected'] && $bos['confirmedBy'] === 'WICK') {
            $reasons[] = 'price wicked beyond structure but did NOT close beyond — unconfirmed';
        }
        $nearestDemand = null;
        foreach ($zones['demand'] as $z) { if ($z['max'] < $lastClose) $nearestDemand = $z; }
        $nearestSupply = null;
        foreach ($zones['supply'] as $z) { if ($z['min'] > $lastClose && $nearestSupply === null) $nearestSupply = $z; }
        if ($nearestDemand && $atr14 && ($lastClose - $nearestDemand['max']) < $atr14) { $score += 0.15; $reasons[] = 'price resting on demand zone'; }
        if ($nearestSupply && $atr14 && ($nearestSupply['min'] - $lastClose) < $atr14) { $score -= 0.15; $reasons[] = 'price pressing into supply zone'; }

        return [
            'agent' => 'market-structure',
            'title' => 'Market Structure Agent',
            'generatedAt' => $ctx['now'],
            'dataQuality' => TechnicalAgent::dataQuality($ctx['series']),
            'dataLimitations' => array_merge(
                ['Zone detection uses the last ' . min(count($candles), 60) . ' bars only'],
                count($swings) < 4 ? ['Fewer than 4 swings detected — structure mapping is weak'] : [],
            ),
            'warnings' => ($bos['detected'] && $bos['confirmedBy'] === 'WICK')
                ? ['Wick-only break NOT treated as confirmation (configured rule)'] : [],
            'vote' => $this->makeVote($score, self::WEIGHTS['market-structure'], implode('; ', array_slice($reasons, 0, 3)) ?: 'no dominant structure'),
            'swingSequence' => array_values($tail),
            'trendLabel' => $trendLabel,
            'events' => ['breakOfStructure' => $bos, 'changeOfCharacter' => $choch],
            'liquidityZones' => $liquidity,
            'supplyZones' => $zones['supply'],
            'demandZones' => $zones['demand'],
            'orderBlocks' => $zones['orderBlocks'],
            'fairValueGaps' => $zones['fvgs'],
        ];
    }

    private function detectBreak(array $candles, ?float $swingHigh, ?float $swingLow): array
    {
        $result = ['detected' => false, 'direction' => 'NEUTRAL', 'level' => null, 'confirmedBy' => 'NONE', 'barsAgo' => null];
        if ($swingHigh === null && $swingLow === null) { return $result; }
        $scan = min(count($candles), 10);
        for ($i = count($candles) - $scan; $i < count($candles); $i++) {
            if ($i < 0) { continue; }
            $c = $candles[$i];
            $bodyRatio = ($c['high'] - $c['low']) > 0 ? abs($c['close'] - $c['open']) / ($c['high'] - $c['low']) : 0;
            $bodyOk = $bodyRatio >= self::RULES['minBodyRatio'];
            if ($swingHigh !== null && ($c['high'] > $swingHigh || $c['close'] > $swingHigh)) {
                $result['detected'] = true; $result['direction'] = 'BUY'; $result['level'] = $swingHigh;
                $result['barsAgo'] = count($candles) - 1 - $i;
                if ($c['close'] > $swingHigh && ($bodyOk || !self::RULES['requireCloseBeyond'])) $result['confirmedBy'] = 'CLOSE';
                elseif ($c['high'] > $swingHigh) $result['confirmedBy'] = 'WICK';
                if ($result['confirmedBy'] === 'CLOSE') break;
            }
            if ($swingLow !== null && ($c['low'] < $swingLow || $c['close'] < $swingLow)) {
                $result['detected'] = true; $result['direction'] = 'SELL'; $result['level'] = $swingLow;
                $result['barsAgo'] = count($candles) - 1 - $i;
                if ($c['close'] < $swingLow && ($bodyOk || !self::RULES['requireCloseBeyond'])) $result['confirmedBy'] = 'CLOSE';
                elseif ($c['low'] < $swingLow) $result['confirmedBy'] = 'WICK';
                if ($result['confirmedBy'] === 'CLOSE') break;
            }
        }
        return $result;
    }

    private function detectChoch(array $seq, array $bos): array
    {
        $tail = array_slice($seq, -6);
        $before = array_slice($tail, 0, -1);
        $bullBefore = count(array_filter($before, fn($s) => $s === 'HH' || $s === 'HL')) >= 3;
        $bearBefore = count(array_filter($before, fn($s) => $s === 'LH' || $s === 'LL')) >= 3;
        if ($bos['detected'] && $bos['confirmedBy'] === 'CLOSE') {
            if ($bos['direction'] === 'SELL' && $bullBefore) {
                return ['detected' => true, 'direction' => 'SELL', 'level' => $bos['level'], 'confirmedBy' => 'CLOSE'];
            }
            if ($bos['direction'] === 'BUY' && $bearBefore) {
                return ['detected' => true, 'direction' => 'BUY', 'level' => $bos['level'], 'confirmedBy' => 'CLOSE'];
            }
        }
        return ['detected' => false, 'direction' => 'NEUTRAL', 'level' => null, 'confirmedBy' => 'NONE'];
    }

    private function detectZones(array $window, ?float $atrValue): array
    {
        $supply = []; $demand = []; $orderBlocks = []; $fvgs = [];
        for ($i = 2, $n = count($window); $i < $n - 1; $i++) {
            $c0 = $window[$i - 2]; $c1 = $window[$i - 1]; $c2 = $window[$i];
            $range = fn(array $c) => $c['high'] - $c['low'];
            $bearImpulse = $c1['close'] < $c1['open'] && $range($c1) > 1.2 * ($atrValue ?? $range($c1));
            if ($bearImpulse && $c0['close'] > $c0['open']) {
                $supply[] = ['min' => round($c0['low'], 6), 'max' => round($c0['high'], 6), 'formedAt' => $c0['timestamp']];
                $orderBlocks[] = ['side' => 'bearish', 'min' => round($c0['low'], 6), 'max' => round($c0['high'], 6), 'formedAt' => $c0['timestamp']];
            }
            $bullImpulse = $c1['close'] > $c1['open'] && $range($c1) > 1.2 * ($atrValue ?? $range($c1));
            if ($bullImpulse && $c0['close'] < $c0['open']) {
                $demand[] = ['min' => round($c0['low'], 6), 'max' => round($c0['high'], 6), 'formedAt' => $c0['timestamp']];
                $orderBlocks[] = ['side' => 'bullish', 'min' => round($c0['low'], 6), 'max' => round($c0['high'], 6), 'formedAt' => $c0['timestamp']];
            }
            if ($c0['high'] < $c2['low']) {
                $fvgs[] = ['direction' => 'bullish', 'min' => round($c0['high'], 6), 'max' => round($c2['low'], 6), 'formedAt' => $c1['timestamp']];
            }
            if ($c0['low'] > $c2['high']) {
                $fvgs[] = ['direction' => 'bearish', 'min' => round($c2['high'], 6), 'max' => round($c0['low'], 6), 'formedAt' => $c1['timestamp']];
            }
        }
        return [
            'supply' => array_slice($supply, -4),
            'demand' => array_slice($demand, -4),
            'orderBlocks' => array_slice($orderBlocks, -4),
            'fvgs' => array_slice($fvgs, -4),
        ];
    }
}
