<?php
namespace Aegis\Agents;

use Aegis\MathUtils;

/**
 * TRADING INTELLIGENCE AGENT — the orchestrating mind (spec §2.1).
 * Combines agent reports into bias / confidence / confluence with
 * conflict detection and NO_TRADE gates. Never touches a broker.
 */
class TradingIntelligenceAgent
{
    public function combine(array $reports, array $input): array
    {
        $voteThreshold = 0.15;
        $biasThreshold = 0.2;

        $voting = array_values(array_filter($reports, fn($r) => !empty($r['vote']['votes'])));
        $abstaining = array_values(array_map(fn($r) => $r['agent'], array_filter($reports, fn($r) => empty($r['vote']['votes']))));

        $wsum = 0.0; $acc = 0.0;
        foreach ($voting as $r) {
            $w = $r['vote']['weight'] * max(0.05, $r['dataQuality']);
            $acc += $r['vote']['directionalScore'] * $w;
            $wsum += $w;
        }
        $netScore = $wsum > 0 ? $acc / $wsum : 0.0;

        $netSign = $netScore > 0 ? 1 : ($netScore < 0 ? -1 : 0);
        $agreeW = 0.0; $totalW = 0.0;
        $conflicts = [];
        foreach ($voting as $r) {
            $w = $r['vote']['weight'] * max(0.05, $r['dataQuality']);
            $totalW += $w;
            $rSign = $r['vote']['directionalScore'] > 0 ? 1 : ($r['vote']['directionalScore'] < 0 ? -1 : 0);
            if ($rSign === $netSign && $netSign !== 0) {
                $agreeW += $w;
            } elseif ($rSign !== 0 && $netSign !== 0) {
                $conflicts[] = ['agent' => $r['agent'], 'theirBias' => $r['vote']['signal'], 'reason' => $r['vote']['reason']];
            }
        }
        $agreement = $totalW > 0 ? $agreeW / $totalW : 0.0;
        $confluence = MathUtils::clamp($agreement * (0.5 + 0.5 * abs($netScore)), 0, 1);

        if (count($voting) === 0) {
            $bias = 'NO_TRADE';
        } elseif (abs($netScore) < $biasThreshold) {
            $bias = 'NEUTRAL';
        } else {
            $bias = $netScore > 0 ? 'BULLISH' : 'BEARISH';
        }

        $avgDataQuality = count($voting) > 0
            ? array_sum(array_map(fn($r) => $r['dataQuality'], $voting)) / count($voting)
            : $input['dataQuality'];
        $confidence = MathUtils::clamp(
            $confluence * 0.45 + abs($netScore) * 0.25 + $input['regimeClarity'] * 0.15
            + $avgDataQuality * 0.10 + $input['freshnessFactor'] * 0.05,
            0, 1,
        );

        $hardBlocks = [];
        if ($input['dataQuality'] < 0.5) $hardBlocks[] = 'data quality too low';
        if ($input['freshnessFactor'] < 0.3) $hardBlocks[] = 'data not fresh enough to act on';
        if ($hardBlocks && $bias !== 'NEUTRAL') $bias = 'NO_TRADE';

        $minConf = 0.55;
        if ($bias === 'NO_TRADE') $recommendation = 'NO_TRADE';
        elseif ($bias === 'NEUTRAL' || $confidence < $minConf) $recommendation = 'HOLD';
        else $recommendation = $bias === 'BULLISH' ? 'BUY' : 'SELL';

        $reasoning = [];
        foreach ($voting as $r) {
            $dir = $r['vote']['directionalScore'] > 0 ? 'bullish' : 'bearish';
            $reasoning[] = sprintf('%s: %s (%s) — %s', $r['title'], $dir, number_format($r['vote']['directionalScore'], 2), $r['vote']['reason']);
        }
        if (count($abstaining) > 0) $reasoning[] = 'Abstaining (no data): ' . implode(', ', $abstaining);
        if (count($conflicts) > 0) {
            $reasoning[] = 'Conflicts detected: ' . implode('; ', array_map(fn($c) => "{$c['agent']} leans {$c['theirBias']}", $conflicts));
        }
        $reasoning[] = sprintf('Confluence %s%% (agreement %s%%, net score %s)', round($confluence * 100), round($agreement * 100), number_format($netScore, 2));

        return [
            'bias' => $bias,
            'confidence' => round($confidence, 2),
            'confluenceScore' => round($confluence, 2),
            'recommendation' => $recommendation,
            'reasoning' => $reasoning,
            'consensus' => [
                'netScore' => round($netScore, 3),
                'agreement' => round($agreement, 2),
                'votingAgents' => array_map(fn($r) => $r['agent'], $voting),
                'abstainingAgents' => $abstaining,
                'conflicts' => $conflicts,
            ],
        ];
    }
}
