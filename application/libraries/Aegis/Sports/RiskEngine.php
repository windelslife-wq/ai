<?php
namespace Aegis\Sports;

/**
 * Risk Engine (spec §13). Rejected candidates can never enter a ticket.
 *
 * $context (optional, forward compatible) may carry:
 *   confidence (float), marketSuspended (bool), liquidity (float),
 *   oddsMovement (float, absolute change from opening odds)
 */
class RiskEngine
{
    public const MAX_ODDS_MOVEMENT = 0.5; // 50% odds drift is treated as volatile

    public function assess(array $value, array $quality, array $config = [], array $context = []): array
    {
        $minQuality = (int) ($config['min_data_quality'] ?? $config['minDataQuality'] ?? 75);
        $minEv = (float) ($config['min_expected_value'] ?? $config['minExpectedValue'] ?? 0.02);
        $minConfidence = $config['min_confidence'] ?? $config['minConfidence'] ?? null;
        $minLiquidity = $config['min_liquidity'] ?? $config['minLiquidity'] ?? null;
        $reasons = [];
        if (!empty($context['marketSuspended'])) $reasons[] = 'MARKET_SUSPENDED';
        if (empty($value['qualified'])) $reasons[] = $value['reason'] ?? 'NO_PREDICTION';
        if (($quality['score'] ?? 0) < $minQuality) $reasons[] = 'LOW_DATA_QUALITY';
        if (empty($quality['eligibleForTicket'])) $reasons[] = 'STALE_OR_INCOMPLETE_DATA';
        if (($value['expectedValue'] ?? -1) < $minEv) $reasons[] = 'LOW_MODEL_EDGE';
        if ($minConfidence !== null && isset($context['confidence']) && is_numeric($context['confidence']) && (float) $context['confidence'] < (float) $minConfidence) $reasons[] = 'LOW_CONFIDENCE';
        if ($minLiquidity !== null && isset($context['liquidity']) && is_numeric($context['liquidity']) && (float) $context['liquidity'] < (float) $minLiquidity) $reasons[] = 'INSUFFICIENT_LIQUIDITY';
        if ($reasons) return ['classification' => 'REJECTED', 'approved' => false, 'reasons' => array_values(array_unique($reasons))];
        $risk = ($quality['score'] >= 90 && ($value['expectedValue'] ?? 0) >= .08) ? 'LOW' : (($quality['score'] >= 80) ? 'MEDIUM' : 'HIGH');
        // Volatile market movement upgrades MEDIUM to HIGH (never downgrades).
        $order = ['LOW' => 0, 'MEDIUM' => 1, 'HIGH' => 2];
        if (isset($context['oddsMovement']) && is_numeric($context['oddsMovement']) && abs((float) $context['oddsMovement']) > self::MAX_ODDS_MOVEMENT) {
            if ($order[$risk] < $order['HIGH']) $risk = 'HIGH';
            $reasons[] = 'ODDS_VOLATILE';
        }
        return ['classification' => $risk, 'approved' => $risk !== 'HIGH', 'reasons' => array_values(array_unique($reasons))];
    }
}
