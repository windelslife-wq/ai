<?php
namespace Aegis\Agents;

use Aegis\MathUtils;

trait AgentHelperTrait
{
    private function makeVote(float $score, float $weight, string $reason): array
    {
        $clamped = MathUtils::clamp($score, -1, 1);
        return [
            'directionalScore' => round($clamped, 4),
            'signal' => $clamped > 0.15 ? 'BUY' : ($clamped < -0.15 ? 'SELL' : 'NEUTRAL'),
            'weight' => $weight,
            'votes' => abs($clamped) > 0.15,
            'reason' => $reason,
        ];
    }

    public const WEIGHTS = [
        'technical' => 1.0,
        'market-structure' => 0.9,
        'forex' => 0.9,
        'crypto' => 0.9,
        'sentiment' => 0.5,
    ];
}
