<?php
namespace Aegis;

/**
 * RISK ENGINE — independent veto authority (Rule 6). Receives a proposal
 * plus portfolio state and returns an explicit auditable decision. Nothing
 * may bypass it; the AI stack never holds a broker handle.
 */
class RiskEngine
{
    public const DEFAULT_LIMITS = [
        'riskPerTradePct' => 0.01,
        'maxRiskPerTradePct' => 0.02,
        'minRiskReward' => 1.5,
        'requireStopLoss' => true,
        'maxPositionNotionalUsd' => 50000,
        'maxLeverage' => 5,
        'maxOpenPositions' => 10,
        'maxDailyLossPct' => 0.03,
        'maxWeeklyLossPct' => 0.06,
        'maxDrawdownPct' => 0.10,
        // Exposure = CAPITAL AT RISK (stop-distance basis), not notional.
        'maxSymbolExposurePct' => 0.05,
        'maxPortfolioExposurePct' => 0.15,
        'maxCorrelatedPositions' => 3,
        'minDataQuality' => 0.5,
        'blockSyntheticData' => true,
        'blockStaleData' => true,
    ];

    private array $limits;

    public function __construct(?array $limits = null)
    {
        $this->limits = array_merge(self::DEFAULT_LIMITS, $limits ?? []);
    }

    public function getLimits(): array { return $this->limits; }

    public function updateLimits(array $patch): array
    {
        $this->limits = array_merge($this->limits, $patch);
        $this->limits['riskPerTradePct'] = min($this->limits['riskPerTradePct'], $this->limits['maxRiskPerTradePct']);
        return $this->limits;
    }

    public function evaluate(array $setup, array $ctx): array
    {
        $reasons = [];
        $warnings = [];
        $L = $this->limits;
        $equity = $ctx['equity'];

        if (!empty($ctx['killSwitchActive'])) $reasons[] = 'Kill switch is ACTIVE — all trade proposals are vetoed';
        if (!empty($ctx['syntheticData']) && $L['blockSyntheticData']) $reasons[] = 'Setup is built on SYNTHETIC data — live risk decisions require real market data';
        if (!empty($ctx['staleData']) && $L['blockStaleData']) $reasons[] = 'Market data is stale beyond the freshness threshold';
        if (($ctx['dataQuality'] ?? 1) < $L['minDataQuality']) $reasons[] = sprintf('Data quality %s below minimum %s', number_format($ctx['dataQuality'], 2), $L['minDataQuality']);

        if ($L['requireStopLoss'] && !is_finite((float)($setup['stopLoss'] ?? NAN))) $reasons[] = 'Stop loss is required';
        if ($L['riskPerTradePct'] > $L['maxRiskPerTradePct']) $reasons[] = sprintf('Configured risk per trade %s%% exceeds hard cap %s%%', $L['riskPerTradePct'] * 100, $L['maxRiskPerTradePct'] * 100);
        if (($setup['riskReward'] ?? 0) < $L['minRiskReward']) $reasons[] = sprintf('Risk/reward %s below minimum %s', number_format($setup['riskReward'] ?? 0, 2), $L['minRiskReward']);

        $sizing = null;
        if (is_finite((float)($setup['stopLoss'] ?? NAN))) {
            $entry = $setup['entry']['reference'];
            $stopDistance = abs($entry - $setup['stopLoss']);
            if ($stopDistance > 0) {
                // Broker execution passes the ACTUAL order volume (givenUnits),
                // so sizing/notional/leverage checks apply to the real order
                // instead of a derived position.
                $givenUnits = $ctx['givenUnits'] ?? null;
                if (is_numeric($givenUnits) && (float)$givenUnits > 0) {
                    $units = (float)$givenUnits;
                    $riskAmount = $units * $stopDistance;
                    $riskPct = $equity > 0 ? $riskAmount / $equity : 1.0;
                } else {
                    $riskPct = min($L['riskPerTradePct'], $L['maxRiskPerTradePct']);
                    $riskAmount = $equity * $riskPct;
                    $units = $riskAmount / $stopDistance;
                }
                $notional = $units * $entry;
                $leverage = $equity > 0 ? $notional / $equity : null;
                if ($notional > $L['maxPositionNotionalUsd']) $reasons[] = sprintf('Position notional $%s exceeds limit $%s', number_format($notional, 0), number_format($L['maxPositionNotionalUsd'], 0));
                if ($leverage !== null && $leverage > $L['maxLeverage']) $reasons[] = sprintf('Implied leverage %sx exceeds limit %sx', number_format($leverage, 1), $L['maxLeverage']);
                if (is_numeric($givenUnits) && $riskPct > $L['maxRiskPerTradePct']) {
                    $reasons[] = sprintf('Order risk %s%% of equity exceeds hard cap %s%%', number_format($riskPct * 100, 2), $L['maxRiskPerTradePct'] * 100);
                }
                $sizing = [
                    'equity' => round($equity, 2),
                    'riskAmount' => round($riskAmount, 2),
                    'riskPct' => round($riskPct, 4),
                    'entryReference' => $entry,
                    'stopDistance' => $stopDistance,
                    'units' => round($units, 2),
                    'notionalUsd' => round($notional, 2),
                    'impliedLeverage' => $leverage !== null ? round($leverage, 2) : null,
                ];
            }
        }

        // Portfolio (capital-at-risk basis)
        $openRisk = array_sum($ctx['openRiskBySymbol'] ?? []);
        $thisTradeRisk = $sizing !== null ? $sizing['riskAmount'] : 0.0;
        if ($equity > 0 && ($openRisk + $thisTradeRisk) / $equity > $L['maxPortfolioExposurePct']) {
            $reasons[] = sprintf('Total open risk %s%% would exceed limit %s%%', number_format(($openRisk + $thisTradeRisk) / $equity * 100, 1), $L['maxPortfolioExposurePct'] * 100);
        }
        $symbolRisk = ($ctx['openRiskBySymbol'][$setup['symbol']] ?? 0) + $thisTradeRisk;
        if ($equity > 0 && $symbolRisk / $equity > $L['maxSymbolExposurePct']) {
            $reasons[] = sprintf('Risk concentration in %s would exceed %s%% of equity', $setup['symbol'], $L['maxSymbolExposurePct'] * 100);
        }
        if (($ctx['openPositions'] ?? 0) + 1 > $L['maxOpenPositions']) $reasons[] = 'Open position count would exceed limit ' . $L['maxOpenPositions'];
        if ($equity > 0) {
            if (-($ctx['dailyPnl'] ?? 0) / $equity > $L['maxDailyLossPct']) $reasons[] = 'Daily loss limit exceeded';
            if (-($ctx['weeklyPnl'] ?? 0) / $equity > $L['maxWeeklyLossPct']) $reasons[] = 'Weekly loss limit exceeded';
            $peak = $ctx['peakEquity'] ?? $equity;
            $dd = $peak > 0 ? ($peak - $equity) / $peak : 0;
            if ($dd > $L['maxDrawdownPct']) $reasons[] = sprintf('Maximum drawdown %s%% exceeds limit %s%%', number_format($dd * 100, 1), $L['maxDrawdownPct'] * 100);
        }
        if (($setup['entry']['min'] ?? 0) >= ($setup['entry']['max'] ?? 1)) $warnings[] = 'Entry zone is degenerate';

        return [
            'approved' => count($reasons) === 0,
            'checkedAt' => gmdate('c'),
            'reasons' => $reasons,
            'warnings' => $warnings,
            'sizing' => $sizing,
        ];
    }
}
