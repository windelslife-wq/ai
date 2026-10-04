<?php
namespace Aegis\Agents;

use Aegis\Providers\FundamentalsFeed;
use Aegis\Providers\UnavailableFundamentalsFeed;

/**
 * Phase 6 fundamentals boundary. It abstains until a licensed, attributable
 * fundamentals feed is configured; price action is never relabelled as a
 * fundamental signal.
 */
class FundamentalsAgent
{
    use AgentHelperTrait;
    public const ID = 'fundamentals';
    public function __construct(private FundamentalsFeed $feed = new UnavailableFundamentalsFeed()) {}
    public function applicable(array $ctx): bool { return true; }
    public function analyze(array $ctx): array
    {
        $snapshot = $this->feed->snapshot($ctx['series']['symbol']);
        return [
            'agent' => self::ID, 'title' => 'Fundamentals Intelligence Agent',
            'generatedAt' => $ctx['now'], 'dataQuality' => 0.0,
            'dataLimitations' => ['No licensed fundamentals provider configured'],
            'warnings' => ['Fundamentals unavailable — this agent abstains and cannot affect consensus'],
            'vote' => ['directionalScore' => 0.0, 'signal' => 'NEUTRAL', 'weight' => self::WEIGHTS['sentiment'], 'votes' => false, 'reason' => 'No attributable fundamentals feed configured — abstaining'],
            'earnings' => ['available' => false, 'reason' => 'No earnings/calendar feed configured'],
            'macro' => ['available' => false, 'reason' => 'No macroeconomic release feed configured'],
            'valuation' => ['available' => false, 'reason' => 'No issuer fundamentals feed configured'],
            'snapshot' => $snapshot,
            'provenance' => ['source' => $snapshot['source'], 'licensed' => (bool) $snapshot['licensed'], 'feed' => $this->feed->id()],
        ];
    }
}
