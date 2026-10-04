<?php
namespace Aegis\Agents;

/**
 * MULTI-AGENT DEBATE (Phase 6) — a deterministic adversarial review stage in
 * front of the Trading Intelligence consensus.
 *
 * Roles (all rule-based; nothing is invented and no LLM pretends to think):
 *   - bull/bear advocates  state their strongest evidence, citing the agent
 *     report and signal each claim came from;
 *   - the skeptic          challenges the LEADING bias with explicit,
 *     verifiable objections (conflicts, regime contradiction, data quality,
 *     staleness, weak conviction);
 *   - the risk critic      challenges the concrete trade setup (risk/reward,
 *     stop width) and echoes a Risk Engine veto when one exists.
 *
 * Verdict: objections can only REDUCE a bias — never inflate it.
 *   any sustained CRITICAL objection            → NO_TRADE
 *   ≥ 2 sustained MAJOR objections              → downgrade to NEUTRAL
 *   1 sustained major                           → bias kept, confidence −0.10
 *   minors only                                 → confidence −0.02 each (cap −0.15)
 *
 * The transcript is returned with the analysis so the reasoning is auditable.
 */
class AgentDebate
{
    /**
     * @param array<int, array<string, mixed>> $reports agent reports
     * @param array $consensus TradingIntelligenceAgent::combine() output
     * @param array $regime Analysis::detectRegime() output
     * @param array|null $setup trade setup (may be null)
     * @param array $provenance series provenance {synthetic, stale}
     * @param array $riskLimits RiskEngine limits
     */
    public static function run(array $reports, array $consensus, array $regime, ?array $setup, array $provenance, array $riskLimits): array
    {
        $bias = (string) ($consensus['bias'] ?? 'NEUTRAL');
        $confidence = (float) ($consensus['confidence'] ?? 0);

        [$bullCase, $bearCase] = self::advocateCases($reports);
        $objections = self::skepticObjections($reports, $consensus, $regime, $provenance);
        $riskObjections = self::riskCriticObjections($setup, $riskLimits);

        $critical = array_filter($objections, fn($o) => $o['severity'] === 'critical' && $o['sustained']);
        $major = array_filter($objections, fn($o) => $o['severity'] === 'major' && $o['sustained']);
        $minor = array_filter($objections, fn($o) => $o['severity'] === 'minor' && $o['sustained']);

        $verdictBias = $bias;
        $adjustment = 0.0;
        $reasoning = [];
        if (count($critical) > 0) {
            $verdictBias = 'NO_TRADE';
            $adjustment = -max(0.25, $confidence * 0.5);
            $reasoning[] = 'sustained critical objection: ' . reset($critical)['grounds'];
        } elseif (count($major) >= 2) {
            $verdictBias = 'NEUTRAL';
            $adjustment = -0.15;
            $reasoning[] = sprintf('%d sustained major objections — bias downgraded to NEUTRAL', count($major));
        } elseif (count($major) === 1) {
            $adjustment = -0.10;
            $reasoning[] = 'sustained major objection: ' . reset($major)['grounds'];
        }
        if (count($minor) > 0 && $verdictBias !== 'NO_TRADE') {
            $adjustment = max($adjustment - 0.02 * count($minor), -0.15);
        }
        $adjusted = max(0.0, min($confidence, round($confidence + $adjustment, 4)));

        return [
            'motion' => sprintf('Sustain %s bias at %.2f confidence', $bias, $confidence),
            'rounds' => [
                ['role' => 'bull-advocate', 'statements' => $bullCase],
                ['role' => 'bear-advocate', 'statements' => $bearCase],
                ['role' => 'skeptic', 'objections' => array_values($objections)],
                ['role' => 'risk-critic', 'objections' => array_values($riskObjections)],
            ],
            'verdict' => [
                'bias' => $verdictBias,
                'confidence' => $adjusted,
                'confidenceAdjustment' => round($adjusted - $confidence, 4),
                'reasoning' => $reasoning ?: ['no sustained objections — bias stands as proposed'],
            ],
        ];
    }

    /** @return array{0: array<int, array<string,string>>, 1: array<int, array<string,string>>}} */
    private static function advocateCases(array $reports): array
    {
        $bull = []; $bear = [];
        foreach ($reports as $r) {
            $agent = (string) ($r['agent'] ?? '?');
            foreach (($r['signals'] ?? []) as $sig) {
                $dir = strtolower((string) ($sig['signal'] ?? ''));
                if (!in_array($dir, ['bullish', 'bearish'], true)) continue;
                $entry = [
                    'claim' => sprintf('%s is %s (%s)', $sig['name'] ?? 'indicator', $dir, $sig['detail'] ?? ''),
                    'evidence' => "{$agent}:" . ($sig['name'] ?? 'signal'),
                ];
                if ($dir === 'bullish') { $bull[] = $entry; } else { $bear[] = $entry; }
            }
            $score = (float) ($r['vote']['directionalScore'] ?? 0);
            if (abs($score) >= 0.25) {
                $entry = [
                    'claim' => sprintf('%s agent directional score %+.2f', $agent, $score),
                    'evidence' => "{$agent}:vote",
                ];
                if ($score > 0) { $bull[] = $entry; } else { $bear[] = $entry; }
            }
        }
        return [array_slice($bull, 0, 6), array_slice($bear, 0, 6)];
    }

    /** @return array<int, array<string, mixed>> */
    private static function skepticObjections(array $reports, array $consensus, array $regime, array $provenance): array
    {
        $out = [];
        $add = function (string $id, string $severity, string $grounds, bool $sustained) use (&$out): void {
            $out[] = ['id' => $id, 'severity' => $severity, 'grounds' => $grounds, 'sustained' => $sustained];
        };

        $conflicts = (int) ($consensus['consensus']['conflicts'] ?? 0);
        // 1 conflict is already priced into confluence; >= 2 is a real split panel
        $add('S1', $conflicts >= 2 ? 'major' : 'minor',
            sprintf('%d conflicting agent signal(s) across the panel', $conflicts), $conflicts >= 2);

        $bias = (string) ($consensus['bias'] ?? 'NEUTRAL');
        $regimeName = (string) ($regime['regime'] ?? 'UNKNOWN');
        $regimeConf = (float) ($regime['confidence'] ?? 0);
        $contradicts = ($bias === 'BULLISH' && in_array($regimeName, ['TRENDING_DOWN', 'RANGING'], true))
            || ($bias === 'BEARISH' && in_array($regimeName, ['TRENDING_UP', 'RANGING'], true));
        $add('S2', 'major', sprintf('bias %s contradicts %s regime (confidence %.2f)', $bias, $regimeName, $regimeConf),
            $contradicts && $regimeConf >= 0.5);

        $add('S3', 'critical', 'market data is stale beyond the freshness threshold', !empty($provenance['stale']));
        // informational: synthetic origin already discounts the freshness factor
        $add('S4', 'minor', 'analysis is built on clearly-labeled synthetic data', false);

        $confidence = (float) ($consensus['confidence'] ?? 0);
        $add('S5', 'major', sprintf('conviction %.2f is below the 0.50 action threshold', $confidence),
            in_array($bias, ['BULLISH', 'BEARISH'], true) && $confidence < 0.50);

        $voting = array_filter($reports, fn($r) => !empty($r['vote']['votes']));
        $abstained = count($reports) - count($voting);
        // informational: abstentions already reduce the voting base
        $add('S6', 'minor', sprintf('%d of %d agent(s) abstained for lack of data', $abstained, count($reports)), false);

        return $out;
    }

    /** @return array<int, array<string, mixed>> */
    private static function riskCriticObjections(?array $setup, array $riskLimits): array
    {
        if ($setup === null) {
            return [['id' => 'R0', 'severity' => 'minor', 'grounds' => 'no concrete trade setup to challenge', 'sustained' => false]];
        }
        $out = [];
        $rr = (float) ($setup['riskReward'] ?? 0);
        if ($rr < (float) ($riskLimits['minRiskReward'] ?? 1.5)) {
            $out[] = ['id' => 'R1', 'severity' => 'major', 'grounds' => sprintf('setup risk/reward %.2f below the %.2f minimum', $rr, $riskLimits['minRiskReward'] ?? 1.5), 'sustained' => true];
        }
        $stopPct = isset($setup['entry']['reference'], $setup['stopLoss']) && $setup['entry']['reference'] > 0
            ? abs($setup['entry']['reference'] - $setup['stopLoss']) / $setup['entry']['reference']
            : 0.0;
        if ($stopPct > 0.05) {
            $out[] = ['id' => 'R2', 'severity' => 'minor', 'grounds' => sprintf('stop is %.1f%% away — very wide for one position', $stopPct * 100), 'sustained' => true];
        }
        return $out;
    }
}
