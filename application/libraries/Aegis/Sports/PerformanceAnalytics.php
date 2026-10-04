<?php
namespace Aegis\Sports;

/**
 * Performance analytics (spec §23).
 *
 * Every number is derived from STORED settled records — tickets, selections,
 * prediction outcomes — never synthesized. An empty database yields an empty
 * report with dataAvailable=false. In SANDBOX mode the report is flagged
 * DEMO/SANDBOX DATA so simulated statistics are never confused with real ones.
 */
class PerformanceAnalytics
{
    /** @deprecated use report() — kept for backward compatibility */
    public function summarize(array $tickets): array
    {
        $settled = array_values(array_filter($tickets, fn($t) => in_array($t['settlement_status'] ?? $t['status'] ?? '', ['WON', 'LOST', 'VOID', 'CANCELLED'], true)));
        $counts = ['WON' => 0, 'LOST' => 0, 'VOID' => 0, 'CANCELLED' => 0];
        $odds = [];
        foreach ($settled as $t) {
            $s = $t['settlement_status'] ?? $t['status'];
            $counts[$s]++;
            if (isset($t['total_odds']) && is_numeric($t['total_odds'])) $odds[] = (float) $t['total_odds'];
        }
        $decisive = $counts['WON'] + $counts['LOST'];
        return [
            'dataAvailable' => count($settled) > 0, 'totalTickets' => count($tickets), 'settledTickets' => count($settled),
            'won' => $counts['WON'], 'lost' => $counts['LOST'], 'void' => $counts['VOID'], 'cancelled' => $counts['CANCELLED'],
            'winRate' => $decisive ? round($counts['WON'] / $decisive, 4) : null,
            'averageOdds' => $odds ? round(array_sum($odds) / count($odds), 4) : null,
            'roi' => null, 'profitLoss' => null,
            'notes' => ['ROI and profit/loss require stored stake/accounting inputs and are intentionally unavailable'],
        ];
    }

    /**
     * Full performance report from stored data.
     * @param array $tickets    sports_tickets rows
     * @param array $selections sports_ticket_selections joined with match competition
     * @param array $outcomes   predictionOutcomes rows (for calibration)
     * @param array $context    ['mode' => string, 'totalPredictions' => int]
     */
    public function report(array $tickets, array $selections, array $outcomes, array $context = []): array
    {
        $settledTickets = array_values(array_filter($tickets, fn($t) => in_array($t['settlement_status'] ?? '', ['WON', 'LOST', 'VOID', 'CANCELLED'], true)));
        $counts = ['WON' => 0, 'LOST' => 0, 'VOID' => 0, 'CANCELLED' => 0];
        $odds = []; $confidences = []; $probs = [];
        $stakeSum = 0.0; $pnlSum = 0.0; $hasStake = false;
        $cum = 0.0; $peak = 0.0; $maxDd = 0.0;
        $groupTotals = ['byMarket' => [], 'byLeague' => [], 'byModel' => []];
        $byDate = [];

        foreach ($settledTickets as $t) {
            $s = $t['settlement_status'] ?? $t['status'];
            $counts[$s]++;
            if (isset($t['total_odds']) && is_numeric($t['total_odds'])) $odds[] = (float) $t['total_odds'];
            if (isset($t['confidence']) && is_numeric($t['confidence'])) $confidences[] = (float) $t['confidence'];
            if (isset($t['combined_probability']) && is_numeric($t['combined_probability'])) $probs[] = (float) $t['combined_probability'];
            $pnl = isset($t['pnl']) && $t['pnl'] !== null ? (float) $t['pnl'] : null;
            $stake = isset($t['stake']) && $t['stake'] !== null ? (float) $t['stake'] : null;
            if ($pnl !== null && $stake !== null && $stake > 0) {
                $hasStake = true;
                $pnlSum += $pnl;
                $stakeSum += $stake;
                $cum += $pnl;
                $peak = max($peak, $cum);
                $maxDd = max($maxDd, $peak - $cum);
            }
            $date = substr((string) ($t['created_at'] ?? ''), 0, 10);
            if (!isset($byDate[$date])) $byDate[$date] = ['n' => 0, 'won' => 0, 'pnl' => 0.0];
            $byDate[$date]['n']++;
            if ($s === 'WON') $byDate[$date]['won']++;
            if ($pnl !== null) $byDate[$date]['pnl'] += $pnl;
        }

        $settledSelections = array_values(array_filter($selections, fn($s) => in_array($s['status'] ?? '', ['WON', 'LOST', 'VOID', 'CANCELLED'], true)));
        $selCounts = ['WON' => 0, 'LOST' => 0, 'VOID' => 0, 'CANCELLED' => 0];
        $selOdds = [];
        foreach ($settledSelections as $s) {
            $st = $s['status'];
            $selCounts[$st]++;
            $selOdds[] = (float) $s['odds'];
            $buckets = [
                'byMarket' => $s['market'] ?? 'UNKNOWN',
                'byLeague' => $s['competition'] ?? 'UNKNOWN',
                'byModel' => ($s['model_name'] ?? 'unknown') . ' v' . ($s['model_version'] ?? '?'),
            ];
            foreach ($buckets as $key => $label) {
                $all = &$groupTotals[$key];
                if (!isset($all[$label])) $all[$label] = ['n' => 0, 'won' => 0];
                $all[$label]['n']++;
                if ($st === 'WON') $all[$label]['won']++;
            }
        }
        foreach ($groupTotals as $key => &$group) {
            foreach ($group as $label => $b) $group[$label]['winRate'] = round($b['won'] / $b['n'], 4);
        }
        $byMarket = $groupTotals['byMarket'];
        $byLeague = $groupTotals['byLeague'];
        $byModel = $groupTotals['byModel'];
        $selDecisive = $selCounts['WON'] + $selCounts['LOST'];

        $calibration = null;
        if ($outcomes) {
            $cal = CalibrationEngine::evaluate($outcomes, fn($o) => (float) ($o['calibrated_probability'] ?? $o['raw_probability'] ?? 0.5));
            $correct = 0;
            foreach ($outcomes as $o) {
                $p = (float) ($o['calibrated_probability'] ?? $o['raw_probability'] ?? 0.5);
                if (($p >= 0.5 ? 1 : 0) === (int) $o['outcome']) $correct++;
            }
            $calibration = ['samples' => count($outcomes), 'accuracy' => round($correct / count($outcomes), 5), 'brier' => $cal['brier'], 'ece' => $cal['ece'], 'bins' => $cal['bins']];
        }

        $mode = (string) ($context['mode'] ?? 'SANDBOX');
        $report = [
            'dataAvailable' => count($settledTickets) > 0 || count($settledSelections) > 0,
            'mode' => $mode,
            'isDemoData' => $mode === 'SANDBOX',
            'demoBanner' => $mode === 'SANDBOX' ? 'DEMO / SANDBOX DATA — simulated statistics, not real-world performance' : null,
            'totalPredictions' => (int) ($context['totalPredictions'] ?? 0),
            'totalTickets' => count($tickets),
            'settledTickets' => count($settledTickets),
            'won' => $counts['WON'], 'lost' => $counts['LOST'], 'void' => $counts['VOID'], 'cancelled' => $counts['CANCELLED'],
            'winRate' => ($counts['WON'] + $counts['LOST']) > 0 ? round($counts['WON'] / ($counts['WON'] + $counts['LOST']), 5) : null,
            'selections' => ['settled' => count($settledSelections), 'won' => $selCounts['WON'], 'lost' => $selCounts['LOST'], 'void' => $selCounts['VOID'], 'cancelled' => $selCounts['CANCELLED'], 'winRate' => $selDecisive > 0 ? round($selCounts['WON'] / $selDecisive, 5) : null, 'averageOdds' => $selOdds ? round(array_sum($selOdds) / count($selOdds), 4) : null],
            'averageOdds' => $odds ? round(array_sum($odds) / count($odds), 4) : null,
            'averageConfidence' => $confidences ? round(array_sum($confidences) / count($confidences), 2) : null,
            'averageProbability' => $probs ? round(array_sum($probs) / count($probs), 5) : null,
            'profitLoss' => $hasStake ? round($pnlSum, 4) : null,
            'roi' => ($hasStake && $stakeSum > 0) ? round($pnlSum / $stakeSum, 5) : null,
            'maxDrawdown' => $hasStake ? round($maxDd, 4) : null,
            'expectedValue' => $this->meanEv($settledSelections),
            'calibration' => $calibration,
            'modelAccuracy' => $calibration['accuracy'] ?? null,
            'byMarket' => $byMarket, 'byLeague' => $byLeague, 'byModel' => $byModel, 'byDate' => $byDate,
        ];
        return $report;
    }

    private function meanEv(array $selections): ?float
    {
        $evs = array_values(array_map(fn($s) => is_numeric($s['expected_value'] ?? null) ? (float) $s['expected_value'] : null, $selections));
        $evs = array_values(array_filter($evs));
        return $evs ? round(array_sum($evs) / count($evs), 5) : null;
    }
}
