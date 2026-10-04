<?php
namespace Aegis\Sports;
class ValueEngine
{
    public function assess(array $prediction, array $odds): array
    {
        if (($prediction['decision'] ?? '') !== 'PREDICTION_READY') return ['qualified' => false, 'reason' => $prediction['reason'] ?? 'NO_PREDICTION'];
        $decimal = (float) ($odds['decimalOdds'] ?? 0);
        if ($decimal <= 1) return ['qualified' => false, 'reason' => 'ODDS_UNAVAILABLE'];
        $implied = 1 / $decimal; $calibrated = (float) $prediction['calibratedProbability']; $ev = $calibrated * $decimal - 1;
        return ['qualified' => $ev > 0, 'reason' => $ev > 0 ? null : 'LOW_MODEL_EDGE', 'odds' => $decimal, 'impliedProbability' => round($implied, 6), 'calibratedProbability' => $calibrated, 'expectedValue' => round($ev, 6)];
    }
}
