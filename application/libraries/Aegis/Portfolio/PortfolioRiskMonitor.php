<?php
namespace Aegis\Portfolio;

use Aegis\Brokers\BrokerManager;
use Aegis\Notifications\Notifier;
use Aegis\Paper\PaperTradingEngine;
use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\PaperRepository;
use Aegis\Persistence\PlatformStateRepository;
use Aegis\RiskEngine;

/**
 * PORTFOLIO RISK MONITOR (Phase 5 continuous monitoring, spec §14).
 *
 * Scans every paper portfolio (and every registered broker connector for
 * connectivity) and raises the spec's alert codes:
 *   HIGH_EXPOSURE, EXCESSIVE_LEVERAGE, CORRELATED_POSITIONS,
 *   MAX_DRAWDOWN_WARNING, DAILY_LOSS_WARNING, BROKER_DISCONNECTED.
 *
 * Alerts are re-evaluated on every scan; only CHANGES are audited so a long
 * day does not spam the trail. Correlation uses static, disclosed groups
 * (v1 heuristic) — it is NOT a statistical correlation model and says so.
 */
class PortfolioRiskMonitor
{
    /** Disclosed static correlation groups (v1 heuristic, not statistical). */
    public const CORRELATION_GROUPS = [
        'CRYPTO_MAJORS' => ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT'],
        'USD_MAJORS' => ['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD'],
        'USD_COUNTER' => ['USDJPY', 'USDCAD', 'USDCHF'],
        'METALS' => ['XAUUSD', 'XAGUSD', 'XAUEUR'],
        'ENERGY' => ['USOIL', 'UKOIL', 'WTIUSD', 'NATGAS', 'NGUSD'],
        'US_EQUITY_INDEX' => ['US30', 'US500', 'SPX500', 'NAS100', 'US100'],
    ];

    public function __construct(
        private PaperRepository $paperRepo,
        private PaperTradingEngine $paper,
        private RiskEngine $risk,
        private BrokerManager $brokers,
        private AuditRepository $audit,
        private PlatformStateRepository $stateRepo,
        private ?Notifier $notifier = null,
    ) {}

    /** Run a scan; returns the full report and audits alert transitions. */
    public function scan(): array
    {
        $limits = $this->risk->getLimits();
        $alerts = [];

        foreach ($this->paperRepo->listAccounts() as $account) {
            try {
                $summary = $this->paper->accountSummary((int) $account['id']);
            } catch (\Throwable $e) {
                $alerts[] = self::alert('SCAN_FAILED', 'warning', 'paper:' . $account['id'], "account summary unavailable: {$e->getMessage()}");
                continue;
            }
            $this->paperAccountAlerts($summary, $limits, $alerts);
        }

        $this->brokerAlerts($alerts);

        usort($alerts, fn($a, $b) => [$a['severity'], $a['code']] <=> [$b['severity'], $b['code']]);
        $report = [
            'scannedAt' => gmdate('c'),
            'accountsScanned' => count($this->paperRepo->listAccounts()),
            'alerts' => $alerts,
            'correlationModel' => 'static disclosed groups (v1 heuristic, not statistical)',
        ];
        $this->recordTransitions($alerts);
        return $report;
    }

    /** Latest stored report (without rescanning). */
    public function lastReport(): ?array
    {
        $state = $this->stateRepo->load();
        return $state['portfolioRisk']['lastReport'] ?? null;
    }

    // ------------------------------------------------------------- checks

    private function paperAccountAlerts(array $s, array $L, array &$alerts): void
    {
        $scope = 'paper:' . $s['account']['id'];
        $equity = max(1e-9, (float) $s['equity']);
        $name = $s['account']['name'] ?? ('#' . $s['account']['id']);

        // Capital at risk (stop-distance basis) vs equity
        $openRiskPct = array_sum($s['openRiskBySymbol']) / $equity;
        if ($openRiskPct > $L['maxPortfolioExposurePct']) {
            $alerts[] = self::alert('HIGH_EXPOSURE', 'critical', $scope, sprintf("%s: open risk %.1f%% of equity exceeds the %.1f%% limit", $name, $openRiskPct * 100, $L['maxPortfolioExposurePct'] * 100));
        } elseif ($openRiskPct > $L['maxPortfolioExposurePct'] * 0.8) {
            $alerts[] = self::alert('HIGH_EXPOSURE', 'warning', $scope, sprintf('%s: open risk %.1f%% of equity is approaching the %.1f%% limit', $name, $openRiskPct * 100, $L['maxPortfolioExposurePct'] * 100));
        }

        // Notional leverage vs equity
        $notional = 0.0;
        foreach ($s['positions'] as $p) $notional += (float) $p['units'] * (float) $p['current_price'];
        $leverage = $notional / $equity;
        if ($leverage > $L['maxLeverage']) {
            $alerts[] = self::alert('EXCESSIVE_LEVERAGE', 'critical', $scope, sprintf('%s: gross notional %.2fx equity exceeds the %.1fx limit', $name, $leverage, $L['maxLeverage']));
        } elseif ($leverage > $L['maxLeverage'] * 0.8) {
            $alerts[] = self::alert('EXCESSIVE_LEVERAGE', 'warning', $scope, sprintf('%s: gross notional %.2fx equity is approaching the %.1fx limit', $name, $leverage, $L['maxLeverage']));
        }

        // Drawdown from peak equity
        $peak = max((float) $s['account']['peak_equity'], $equity);
        if ($peak > 0) {
            $dd = ($peak - $equity) / $peak;
            if ($dd > $L['maxDrawdownPct']) {
                $alerts[] = self::alert('MAX_DRAWDOWN_WARNING', 'critical', $scope, sprintf('%s: drawdown %.1f%% exceeds the %.1f%% limit (risk engine will veto new trades)', $name, $dd * 100, $L['maxDrawdownPct'] * 100));
            } elseif ($dd > $L['maxDrawdownPct'] * 0.7) {
                $alerts[] = self::alert('MAX_DRAWDOWN_WARNING', 'warning', $scope, sprintf('%s: drawdown %.1f%% approaching the %.1f%% limit', $name, $dd * 100, $L['maxDrawdownPct'] * 100));
            }
        }

        // Daily loss
        $dailyLossPct = -$s['dailyPnl'] / $equity;
        if ($dailyLossPct > $L['maxDailyLossPct']) {
            $alerts[] = self::alert('DAILY_LOSS_WARNING', 'critical', $scope, sprintf('%s: daily loss %.1f%% exceeds the %.1f%% limit', $name, $dailyLossPct * 100, $L['maxDailyLossPct'] * 100));
        } elseif ($dailyLossPct > $L['maxDailyLossPct'] * 0.6) {
            $alerts[] = self::alert('DAILY_LOSS_WARNING', 'warning', $scope, sprintf('%s: daily loss %.1f%% approaching the %.1f%% limit', $name, $dailyLossPct * 100, $L['maxDailyLossPct'] * 100));
        }

        // Correlated positions (static disclosed groups)
        $open = array_map(fn($p) => strtoupper((string) $p['symbol']), $s['positions']);
        foreach (self::CORRELATION_GROUPS as $group => $members) {
            $overlap = array_values(array_intersect($open, $members));
            if (count($overlap) >= 2) {
                $alerts[] = self::alert('CORRELATED_POSITIONS', 'warning', $scope, sprintf('%s: %d positions in correlated group %s (%s) — static heuristic, not statistical', $name, count($overlap), $group, implode(', ', $overlap)));
            }
        }
    }

    /** BROKER_DISCONNECTED / BROKER_CONNECTED on state transitions (DISABLED never counted). */
    private function brokerAlerts(array &$alerts): void
    {
        $state = $this->stateRepo->load();
        $previous = $state['portfolioRisk']['brokerStates'] ?? [];
        foreach ($this->brokers->allStatus() as $id => $status) {
            $current = (string) $status['state'];
            $was = isset($previous[$id]) ? (string) $previous[$id] : null;
            if ($was === 'READY' && $current === 'DOWN') {
                $alerts[] = self::alert('BROKER_DISCONNECTED', 'critical', 'broker:' . $id, "connector {$id} was READY and is now DOWN");
                $this->audit->emit('BROKER_DISCONNECTED', "Connector {$id} was READY and is now DOWN", ['broker' => $id, 'from' => 'READY', 'to' => 'DOWN']);
                $this->notifier?->notify('BROKER_DISCONNECTED', 'critical', "Broker disconnected: {$id}", ['broker' => $id], "broker:{$id}:disconnected");
            }
            if ($was === 'DOWN' && $current === 'READY') {
                $this->audit->emit('BROKER_CONNECTED', "Connector {$id} reconnected (DOWN -> READY)", ['broker' => $id, 'from' => 'DOWN', 'to' => 'READY']);
                $this->notifier?->notify('BROKER_CONNECTED', 'info', "Broker reconnected: {$id}", ['broker' => $id], "broker:{$id}:connected");
            }
        }
    }

    /** Audit only transitions (new / cleared) and persist the last report. */
    private function recordTransitions(array $alerts): void
    {
        $state = $this->stateRepo->load();
        $prev = $state['portfolioRisk']['alertKeys'] ?? [];
        $current = [];
        foreach ($alerts as $a) $current[$a['key']] = true;
        foreach ($alerts as $a) {
            if (!isset($prev[$a['key']])) {
                $this->audit->emit('PORTFOLIO_RISK_ALERT', "{$a['code']} ({$a['severity']}) — {$a['detail']}", $a);
                $this->notifier?->notify('PORTFOLIO_RISK', $a['severity'], "{$a['code']}: " . explode(':', $a['scope'])[0] . " risk alert", $a, $a['key']);
            }
        }
        foreach (array_keys($prev) as $key) {
            if (!isset($current[$key])) {
                $this->audit->emit('PORTFOLIO_RISK_CLEARED', "alert cleared: {$key}", ['key' => $key]);
            }
        }
        $brokerStates = [];
        foreach ($this->brokers->allStatus() as $id => $status) $brokerStates[$id] = (string) $status['state'];
        $state['portfolioRisk'] = [
            'lastScanAt' => gmdate('c'),
            'alertKeys' => $current,
            'brokerStates' => $brokerStates,
            'lastReport' => [
                'scannedAt' => gmdate('c'),
                'alerts' => array_map(fn($a) => array_diff_key($a, ['key' => true]), $alerts),
            ],
        ];
        $this->stateRepo->save($state);
    }

    private static function alert(string $code, string $severity, string $scope, string $detail): array
    {
        return ['code' => $code, 'severity' => $severity, 'scope' => $scope, 'detail' => $detail, 'observedAt' => gmdate('c'), 'key' => "{$scope}:{$code}"];
    }
}
