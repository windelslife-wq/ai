<?php
namespace Aegis\Sports;

/**
 * Ticket optimization (spec §16/§17).
 *
 * Candidate pool → remove invalid/low-quality/stale/high-risk candidates →
 * evaluate EV and probability → bounded exhaustive combination search under
 * the configured constraints (odds range, max selections, correlation cap,
 * min confidence, min data quality, allowed markets/leagues) → best
 * qualifying combination by summed expected value, or
 * NO_QUALIFIED_TICKET. Selections are never padded or forced to reach a
 * target odds value.
 */
class TicketOptimizer
{
    public function __construct(private CorrelationEngine $correlation = new CorrelationEngine()) {}

    public function optimize(array $candidates, array $config = []): array
    {
        $min = (float) ($config['targetOddsMin'] ?? 5.0);
        $max = (float) ($config['targetOddsMax'] ?? 8.0);
        $limit = (int) ($config['maxSelections'] ?? 5);
        $minConfidence = isset($config['minConfidence']) && is_numeric($config['minConfidence']) ? (float) $config['minConfidence'] : null;
        $minQuality = isset($config['minDataQuality']) && is_numeric($config['minDataQuality']) ? (int) $config['minDataQuality'] : null;
        $maxCorrelation = strtoupper((string) ($config['maxCorrelation'] ?? 'MEDIUM'));
        $allowedMarkets = (array) ($config['allowedMarkets'] ?? []);
        $allowedLeagues = (array) ($config['allowedLeagues'] ?? []);

        $pool = [];
        foreach ($candidates as $c) {
            if (empty($c['risk']['approved']) || ($c['risk']['classification'] ?? '') === 'HIGH') continue; // risk rejected
            if (empty($c['value']['qualified'])) continue; // no positive value
            if ($minConfidence !== null && !is_numeric($c['confidence']['confidence'] ?? null)) continue; // unmeasured confidence fails a configured floor
            if ($minConfidence !== null && (float) $c['confidence']['confidence'] < $minConfidence) continue;
            if ($minQuality !== null && (int) ($c['quality']['score'] ?? 0) < $minQuality) continue;
            if (count($allowedMarkets) > 0 && !in_array($c['market'] ?? null, $allowedMarkets, true)) continue;
            if (count($allowedLeagues) > 0 && !in_array($c['match']['competition'] ?? $c['competition'] ?? null, $allowedLeagues, true)) continue;
            $pool[] = $c;
        }

        $best = null;
        $corrLimit = $maxCorrelation === 'LOW' ? 'LOW' : 'MEDIUM'; // 'MEDIUM' permits LOW+MEDIUM pairs
        $order = ['LOW' => 0, 'MEDIUM' => 1, 'HIGH' => 2];
        $search = function (array $chosen, int $start, float $odds) use (&$search, &$best, $pool, $min, $max, $limit, $corrLimit, $order) {
            if ($chosen && $odds >= $min && $odds <= $max) {
                $score = array_sum(array_map(fn($c) => (float) ($c['value']['expectedValue'] ?? 0), $chosen));
                if ($best === null || $score > $best['score']) $best = ['score' => $score, 'selections' => $chosen, 'totalOdds' => $odds];
            }
            if (count($chosen) >= $limit || $odds >= $max) return;
            for ($i = $start; $i < count($pool); $i++) {
                $candidate = $pool[$i];
                $corr = $this->correlation->assess($candidate, $chosen);
                if ($order[$corr['classification']] > $order[$corrLimit]) continue; // correlation exceeds configured threshold → reject/replace
                $next = $odds * (float) ($candidate['value']['odds'] ?? 0);
                if ($next > $max) continue;
                $search(array_merge($chosen, [$candidate]), $i + 1, $next);
            }
        };
        $search([], 0, 1.0);

        if ($best === null) {
            return ['status' => 'NO_QUALIFIED_TICKET', 'reason' => 'No candidate combination satisfies odds, risk, value, correlation and configuration constraints', 'poolSize' => count($pool), 'config' => $config];
        }
        return ['status' => 'QUALIFIED', 'ticketId' => 'tkt_' . bin2hex(random_bytes(8)), 'totalOdds' => round($best['totalOdds'], 4), 'selectionCount' => count($best['selections']), 'selections' => $best['selections'], 'optimizationScore' => round($best['score'], 6), 'poolSize' => count($pool), 'config' => $config];
    }
}
