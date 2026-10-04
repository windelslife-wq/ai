<?php
namespace Aegis\Sports;

/**
 * Builds an attributable match snapshot. Every input keeps its source and
 * timestamp; unavailable inputs are explicitly preserved (never fabricated).
 * Context may arrive from the persisted provider payload (match['payload'])
 * or be overridden by $verifiedContext (tests / operator-supplied data).
 */
class MatchIntelligenceEngine
{
    public function __construct(private OddsFreshnessEngine $freshness = new OddsFreshnessEngine()) {}

    public function analyze(array $match, ?array $latestOdds, array $verifiedContext = [], ?int $now = null): array
    {
        $payload = is_array($match['payload'] ?? null) ? $match['payload'] : [];
        $storedContext = is_array($payload['context'] ?? null) ? $payload['context'] : [];
        $context = array_merge($storedContext, $verifiedContext);
        $odds = $this->freshness->assess($latestOdds, (int) ($context['maxOddsAgeSeconds'] ?? 900), $now);
        $fields = [
            'recentForm' => $context['recentForm'] ?? null,
            'injuries' => $context['injuries'] ?? null,
            'lineups' => $context['lineups'] ?? null,
            'historical' => $context['historical'] ?? null,
            'marketLiquidity' => $context['marketLiquidity'] ?? null,
            'restDays' => $context['restDays'] ?? null,
        ];
        $unavailable = array_keys(array_filter($fields, fn($v) => $v === null));
        $status = strtoupper((string) ($match['status'] ?? 'UNKNOWN'));
        $rejections = [];
        if (!in_array($status, ['SCHEDULED', 'LIVE'], true)) $rejections[] = 'MATCH_STATUS_INVALID';
        if ($latestOdds === null) $rejections[] = 'ODDS_UNAVAILABLE';
        elseif (!$odds['available']) $rejections[] = 'ODDS_UNAVAILABLE';
        elseif (!$odds['fresh']) $rejections[] = ($odds['reason'] ?? 'STALE_ODDS');
        if (!$fields['recentForm']) $rejections[] = 'INSUFFICIENT_DATA';
        if ($fields['marketLiquidity'] !== null && (float) $fields['marketLiquidity'] < 1) $rejections[] = 'INSUFFICIENT_LIQUIDITY';
        return [
            'match' => ['id' => $match['id'] ?? null, 'homeTeam' => $match['home_team'] ?? $match['homeTeam'] ?? null, 'awayTeam' => $match['away_team'] ?? $match['awayTeam'] ?? null, 'competition' => $match['competition'] ?? null, 'kickoff' => $match['kickoff_at'] ?? $match['kickoff'] ?? null, 'status' => $status, 'simulated' => !empty($payload['simulated'])],
            'odds' => $latestOdds, 'oddsFreshness' => $odds, 'inputs' => $fields,
            'unavailableInputs' => $unavailable, 'rejectionReasons' => array_values(array_unique($rejections)),
            'decision' => $rejections ? 'NO_QUALIFIED_TICKET' : 'INTELLIGENCE_READY',
            'generatedAt' => gmdate('c', $now ?? time()),
        ];
    }
}
