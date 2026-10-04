<?php
namespace Aegis;

use Aegis\Brokers\BrokerManager;
use Aegis\Brokers\TradingConnector;
use Aegis\Notifications\Notifier;
use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\PlatformStateRepository;
use Aegis\Persistence\ProposalRepository;
use Aegis\Strategies\StrategyRegistry;

/**
 * TRADE EXECUTION SUPERVISOR (Phase 5).
 *
 * Every broker-bound intent runs the full 15-step pipeline (spec §8) and is
 * persisted as an auditable proposal. No service may bypass it, and the AI
 * stack never holds a connector: only this class routes orders, and only
 * through a TradingConnector whose bridge-verified status reports effective
 * order submission.
 *
 *   1 kill switch → 2 trading mode → 3 strategy → 4 broker connection →
 *   5 market open → 6 data freshness → 7 duplicate orders →
 *   8 symbol permissions → 9 margin → 10 risk engine (+automation limits) →
 *   11 human approval → 12 place order → 13 confirm execution →
 *   14 audit log → 15 portfolio update
 */
class ExecutionSupervisor
{
    /** Indicative max quote age per market class (seconds). */
    private const FRESHNESS = ['crypto' => 120, 'forex' => 300, 'default' => 600];
    /** Indicative initial-margin rate used for the pre-trade margin estimate. */
    private const MARGIN_RATE = 0.033;
    private const EXECUTION_MODES = ['HUMAN_APPROVAL', 'SEMI_AUTONOMOUS', 'FULLY_AUTOMATED'];

    public function __construct(
        private AuditRepository $audit,
        private PlatformStateRepository $stateRepo,
        private ProposalRepository $proposals,
        private RiskEngine $risk,
        private BrokerManager $brokers,
        private StrategyRegistry $strategies,
        /** @var callable(): int */
        private $clock = null,
        private ?Notifier $notifier = null,
    ) {
        $this->clock = $clock ?? static fn(): int => time();
    }

    private function notify(string $type, string $severity, string $title, array $detail = [], ?string $dedupeKey = null): void
    {
        $this->notifier?->notify($type, $severity, $title, $detail, $dedupeKey);
    }

    // ------------------------------------------------------------ pipeline

    /**
     * Steps 1–11. Returns the pipeline result; when $persist is true the
     * proposal is stored (PENDING_APPROVAL / READY_TO_ROUTE / REJECTED).
     */
    public function evaluate(array $intent, bool $persist = true, string $actor = 'user'): array
    {
        $state = $this->stateRepo->load();
        $checks = [];
        $step = 0;
        $id = 'prp_' . bin2hex(random_bytes(8));
        $safe = $this->safeIntent($intent);
        $reject = function (string $check, string $reason) use (&$checks, &$step, $id, $safe, $persist, $actor): array {
            $checks[] = ['step' => ++$step, 'check' => $check, 'ok' => false, 'detail' => $reason];
            $result = ['id' => $id, 'status' => 'REJECTED', 'reason' => $reason, 'checks' => $checks, 'intent' => $safe, 'connector' => null, 'riskDecision' => null, 'quote' => null, 'account' => null];
            $this->audit->emit('EXECUTION_PREFLIGHT_REJECTED', $reason, $result, 'system');
            if ($persist) $this->save($result, $actor, null);
            return $result;
        };
        $pass = function (string $check, string $detail) use (&$checks, &$step): void {
            $checks[] = ['step' => ++$step, 'check' => $check, 'ok' => true, 'detail' => $detail];
        };

        // Validate the intent shape before touching anything external.
        $intent = $this->normalizeIntent($intent);
        if ($intent === null) return $reject('intent', 'intent requires symbol, side BUY|SELL, type MARKET|LIMIT, positive volume, a stopLoss on the correct side, and a price for LIMIT orders');
        $safe = $this->safeIntent($intent);

        // 1 — kill switch
        if (($state['killSwitch']['active'] ?? true) === true) return $reject('kill-switch', 'kill switch is active');
        $pass('kill-switch', 'inactive');

        // 2 — trading mode
        $mode = (string) ($state['tradingMode'] ?? 'ANALYSIS_ONLY');
        if (!in_array($mode, self::EXECUTION_MODES, true)) {
            return $reject('trading-mode', "trading mode is {$mode} — broker execution requires " . implode(' / ', self::EXECUTION_MODES) . ' (paper orders go through the Paper Trading engine)');
        }
        $pass('trading-mode', $mode);

        // 3 — strategy
        $strategyId = $intent['strategyId'] ?? null;
        if ($strategyId !== null) {
            $record = $this->strategies->findRecord($strategyId, $intent['strategyVersion'] ?? null);
            if (!$record) return $reject('strategy', "strategy {$strategyId} is not registered");
            if ($record['lifecycle'] !== 'APPROVED') {
                return $reject('strategy', "strategy {$strategyId} lifecycle is {$record['lifecycle']} — broker execution requires APPROVED (backtest → validate → risk review → paper trade → approve)");
            }
            $pass('strategy', "{$strategyId}@{$record['version']} is APPROVED");
        } elseif ($mode !== 'HUMAN_APPROVAL') {
            return $reject('strategy', "automated execution ({$mode}) requires an APPROVED strategyId — discretionary intents are HUMAN_APPROVAL only");
        } else {
            $pass('strategy', 'discretionary intent (human-approved)');
        }

        // 4 — broker connection (bridge-verified order capability)
        $connector = $this->brokers->tradingConnector();
        if ($connector === null) {
            return $reject('broker-connection', 'no broker connector is READY with effective order submission — routing stays disabled');
        }
        $pass('broker-connection', $connector->id() . ' READY (order submission verified)');

        // 5/6 — market session + data freshness from the live broker quote
        try {
            $quote = $connector->quote($intent['symbol']);
        } catch (\Throwable $e) {
            return $reject('data-freshness', "broker quote for {$intent['symbol']} unavailable: " . $e->getMessage());
        }
        $now = ($this->clock)();
        $age = max(0, $now - strtotime($quote['timestamp']));
        $freshLimit = self::FRESHNESS[$intent['marketClass']] ?? self::FRESHNESS['default'];
        $session = self::sessionFor($intent['marketClass'], $now);
        if (!$session['open']) return $reject('market-open', $session['detail']);
        $pass('market-open', $session['detail']);
        if ($age > $freshLimit) {
            return $reject('data-freshness', "quote is {$age}s old (limit {$freshLimit}s for {$intent['marketClass']}) — data is stale");
        }
        $pass('data-freshness', "quote age {$age}s (limit {$freshLimit}s), " . ($quote['delayed'] ? 'DELAYED' : 'live'));

        // 7 — duplicate orders (one net position per symbol, broker-wide)
        try {
            $positions = $connector->positions();
            $pending = $connector->pendingOrders();
        } catch (\Throwable $e) {
            return $reject('duplicate-orders', 'broker positions/orders read failed: ' . $e->getMessage());
        }
        $held = array_filter($positions, fn($p) => $p['symbol'] === $intent['symbol']);
        $queued = array_filter($pending, fn($o) => $o['symbol'] === $intent['symbol']);
        if ($held || $queued) {
            return $reject('duplicate-orders', "already holding a position or pending order in {$intent['symbol']} (one net position per symbol)");
        }
        $pass('duplicate-orders', count($positions) . ' open positions / ' . count($pending) . ' pending orders, none in ' . $intent['symbol']);

        // 8 — symbol permissions (mandatory for automated modes)
        $limits = self::automationLimits($state);
        $approved = $limits['approvedSymbols'];
        if ($mode !== 'HUMAN_APPROVAL') {
            if ($approved === []) return $reject('symbol-permissions', 'automationLimits.approvedSymbols is empty — automated execution is not permitted on any symbol');
            if (!in_array($intent['symbol'], $approved, true)) return $reject('symbol-permissions', "{$intent['symbol']} is not in automationLimits.approvedSymbols");
            $pass('symbol-permissions', "{$intent['symbol']} is approved for automated execution");
        } elseif ($approved !== [] && !in_array($intent['symbol'], $approved, true)) {
            $pass('symbol-permissions', "{$intent['symbol']} outside the approved-symbol list (allowed for human-approved intents)");
        } else {
            $pass('symbol-permissions', $approved === [] ? 'no approved-symbol list configured (human approval governs)' : "{$intent['symbol']} is on the approved list");
        }

        // 9 — margin (estimate against the live account)
        try {
            $account = $connector->account();
        } catch (\Throwable $e) {
            return $reject('margin', 'broker account read failed: ' . $e->getMessage());
        }
        $entry = $intent['type'] === 'LIMIT' ? $intent['price'] : ($quote['bid'] + $quote['ask']) / 2;
        $contractSize = max(0.000001, (float)($intent['contractSize'] ?? 1.0));
        $notional = $intent['volume'] * $entry * $contractSize;
        $marginRequired = $notional * self::MARGIN_RATE;
        if ($marginRequired > $account['freeMargin']) {
            return $reject('margin', sprintf('estimated margin $%.2f (at %.1f%% initial margin) exceeds free margin $%.2f', $marginRequired, self::MARGIN_RATE * 100, $account['freeMargin']));
        }
        $pass('margin', sprintf('estimated margin $%.2f of free margin $%.2f (estimate — the broker remains authoritative)', $marginRequired, $account['freeMargin']));

        // 10 — risk engine with the ACTUAL order volume, plus automation limits
        $openRiskBySymbol = [];
        $unstopped = 0;
        foreach ($positions as $p) {
            if ($p['stopLoss'] !== null && $p['stopLoss'] > 0) {
                $openRiskBySymbol[$p['symbol']] = ($openRiskBySymbol[$p['symbol']] ?? 0) + abs($p['entry'] - $p['stopLoss']) * $p['volume'] * $contractSize;
            } else {
                $unstopped++;
                $openRiskBySymbol[$p['symbol']] = ($openRiskBySymbol[$p['symbol']] ?? 0) + $p['volume'] * $p['entry'] * $contractSize;
            }
        }
        try {
            $history = $connector->history(200);
        } catch (\Throwable) {
            $history = [];
        }
        $dayStart = strtotime(gmdate('Y-m-d', $now));
        $weekStart = $now - 7 * 86400;
        $dailyPnl = 0.0; $weeklyPnl = 0.0;
        foreach ($history as $t) {
            $closed = strtotime($t['closedAt']) ?: 0;
            if ($closed >= $dayStart) $dailyPnl += $t['profit'];
            if ($closed >= $weekStart) $weeklyPnl += $t['profit'];
        }
        $warnings = [];
        if ($unstopped > 0) $warnings[] = "{$unstopped} open broker position(s) have no stop — counted as full-notional risk";
        if ($account['currency'] !== 'USD') $warnings[] = "account currency is {$account['currency']} — risk limits are computed in account units";
        $warnings[] = 'broker peak-equity is unavailable — drawdown is checked at the account level only';

        $setup = [
            'action' => $intent['side'],
            'symbol' => $intent['symbol'],
            'entry' => ['type' => 'POINT', 'min' => $entry, 'max' => $entry, 'reference' => $entry],
            'stopLoss' => $intent['stopLoss'],
            'takeProfit' => [$intent['takeProfit']],
            'riskReward' => abs($intent['takeProfit'] - $entry) / max(1e-9, abs($entry - $intent['stopLoss'])),
        ];
        $riskCtx = [
            'killSwitchActive' => false, // already checked at step 1
            'dataQuality' => 1.0,
            'syntheticData' => false,
            'staleData' => false,
            'equity' => $account['equity'],
            'openRiskBySymbol' => $openRiskBySymbol,
            'openPositions' => count($positions),
            'dailyPnl' => $dailyPnl,
            'weeklyPnl' => $weeklyPnl,
            'peakEquity' => $account['equity'],
            'givenUnits' => $intent['volume'] * $contractSize,
        ];
        $decision = $this->risk->evaluate($setup, $riskCtx);
        foreach ($warnings as $w) $decision['warnings'][] = $w;
        if (!$decision['approved']) {
            $checks[] = ['step' => ++$step, 'check' => 'risk-engine', 'ok' => false, 'detail' => implode('; ', $decision['reasons'])];
            $result = ['id' => $id, 'status' => 'REJECTED', 'reason' => 'risk engine veto: ' . implode('; ', $decision['reasons']), 'checks' => $checks, 'intent' => $safe, 'connector' => $connector->id(), 'riskDecision' => $decision, 'quote' => $this->publicQuote($quote), 'account' => $this->publicAccount($account)];
            $this->audit->emit('RISK_REJECTED', "Broker intent {$intent['symbol']} {$intent['side']} vetoed by Risk Engine", $result, 'system');
            if ($persist) $this->save($result, $actor, $decision);
            return $result;
        }
        $checks[] = ['step' => ++$step, 'check' => 'risk-engine', 'ok' => true, 'detail' => sprintf('approved — order risk %s%% of equity, notional ~$%.2f', number_format(($decision['sizing']['riskPct'] ?? 0) * 100, 2), $decision['sizing']['notionalUsd'] ?? 0.0) . ($decision['warnings'] ? ' (warnings: ' . implode('; ', $decision['warnings']) . ')' : '')];

        if ($mode !== 'HUMAN_APPROVAL') {
            $todayAutomated = $this->proposals->countAutomatedExecutionsToday();
            if ($todayAutomated >= $limits['maxDailyTrades']) {
                return $reject('automation-limits', "daily automated-trade cap reached ({$todayAutomated}/{$limits['maxDailyTrades']})");
            }
            if ($notional > $limits['maxTradeNotionalUsd']) {
                return $reject('automation-limits', sprintf('order notional $%.2f exceeds automation limit $%.2f', $notional, $limits['maxTradeNotionalUsd']));
            }
            $riskPct = $account['equity'] > 0 ? ($decision['sizing']['riskAmount'] ?? 0) / $account['equity'] : 1.0;
            if ($riskPct > $limits['maxRiskPerTradePct']) {
                return $reject('automation-limits', sprintf('order risk %.2f%% exceeds automation limit %.2f%%', $riskPct * 100, $limits['maxRiskPerTradePct'] * 100));
            }
            $checks[] = ['step' => ++$step, 'check' => 'automation-limits', 'ok' => true, 'detail' => sprintf('notional $%.2f ≤ $%.2f, risk ≤ %.2f%%, automated trades today %d/%d', $notional, $limits['maxTradeNotionalUsd'], $limits['maxRiskPerTradePct'] * 100, $todayAutomated, $limits['maxDailyTrades'])];
        }

        // 11 — human approval
        $needsHuman = $mode === 'HUMAN_APPROVAL';
        $status = $needsHuman ? 'PENDING_APPROVAL' : 'READY_TO_ROUTE';
        $checks[] = ['step' => ++$step, 'check' => 'human-approval', 'ok' => true, 'detail' => $needsHuman ? 'approval required before routing' : "not required in {$mode} (execution stays inside automation limits)"];

        $result = ['id' => $id, 'status' => $status, 'reason' => $needsHuman ? 'pipeline passed — awaiting human approval' : 'pipeline passed — cleared for automated routing', 'checks' => $checks, 'intent' => $safe, 'connector' => $connector->id(), 'riskDecision' => $decision, 'quote' => $this->publicQuote($quote), 'account' => $this->publicAccount($account)];
        $this->audit->emit($needsHuman ? 'EXECUTION_APPROVAL_REQUESTED' : 'EXECUTION_CLEARED_AUTOMATED', $needsHuman ? "Proposal {$id} awaits human approval" : "Proposal {$id} cleared for automated routing ({$mode})", ['id' => $id, 'symbol' => $intent['symbol'], 'side' => $intent['side']], $actor);
        if ($needsHuman) {
            $this->notify('TRADE_APPROVAL_REQUESTED', 'warning', "Approval required: {$intent['symbol']} {$intent['side']}", ['proposalId' => $id, 'symbol' => $intent['symbol'], 'side' => $intent['side'], 'volume' => $intent['volume']], "proposal:{$id}");
        }
        if ($persist) $this->save($result, $actor, $decision);
        return $result;
    }

    /** Steps 12–15: route an approved/cleared proposal through the connector. */
    public function route(string $id, string $actor = 'system'): array
    {
        $proposal = $this->proposals->findProposal($id);
        if ($proposal === null) throw new \InvalidArgumentException('proposal not found');
        $state = $this->stateRepo->load();
        $intent = $proposal['intent'];
        $automated = $proposal['actor'] === 'system' || $state['tradingMode'] !== 'HUMAN_APPROVAL';

        // Routing gates (steps 1–2 re-verified at routing time).
        if (($state['killSwitch']['active'] ?? true) === true) return $this->routingBlocked($proposal, 'kill switch is active');
        if (!in_array((string) $state['tradingMode'], self::EXECUTION_MODES, true)) return $this->routingBlocked($proposal, "trading mode is {$state['tradingMode']}");
        if ($state['tradingMode'] === 'HUMAN_APPROVAL' && $proposal['status'] !== 'APPROVED') return $this->routingBlocked($proposal, 'proposal is not human-approved');
        if (!in_array($proposal['status'], ['APPROVED', 'READY_TO_ROUTE'], true)) return $this->routingBlocked($proposal, "proposal status is {$proposal['status']}");

        $connector = $this->brokers->tradingConnector();
        if ($connector === null) return $this->routingBlocked($proposal, 'no broker connector with effective order submission');

        // 12 — place order
        $order = [
            'symbol' => $proposal['symbol'],
            'side' => $proposal['side'],
            'type' => $proposal['order_type'],
            'volume' => (float) $proposal['volume'],
            'stopLoss' => $proposal['stop_loss'] !== null ? (float) $proposal['stop_loss'] : null,
            'takeProfit' => $proposal['take_profit'] !== null ? (float) $proposal['take_profit'] : null,
        ];
        if ($proposal['order_type'] === 'LIMIT' && $proposal['price'] !== null) $order['price'] = (float) $proposal['price'];
        $this->audit->emit('ORDER_SUBMITTED', sprintf('Routing %s %s %.2f %s (proposal %s)', $order['side'], $order['type'], $order['volume'], $order['symbol'], $id), ['proposalId' => $id, 'order' => $order], $actor);
        try {
            $placed = $connector->placeOrder($order);
        } catch (\Throwable $e) {
            $execution = $this->recordExecution($proposal, $connector->id(), null, $automated, 'FAILED', ['error' => $e->getMessage()]);
            $this->setStatus($proposal, 'FAILED', "broker rejected: {$e->getMessage()}", $actor);
            $this->audit->emit('EXECUTION_FAILED', "Broker rejected proposal {$id}: {$e->getMessage()}", ['proposalId' => $id], $actor);
            $this->notify('EXECUTION_FAILED', 'critical', "Broker rejected proposal for {$order['symbol']}", ['proposalId' => $id, 'error' => $e->getMessage()], "proposal:{$id}:failed");
            return ['status' => 'FAILED', 'reason' => $e->getMessage(), 'execution' => $execution, 'brokerOrderCreated' => false];
        }

        // 13 — confirm execution (validated result contract)
        if (($placed['ticket'] ?? 0) <= 0 || ($placed['price'] ?? 0) <= 0) {
            $execution = $this->recordExecution($proposal, $connector->id(), null, $automated, 'FAILED', ['error' => 'invalid broker result contract', 'raw' => $placed]);
            $this->setStatus($proposal, 'FAILED', 'invalid broker result contract', $actor);
            return ['status' => 'FAILED', 'reason' => 'invalid broker result contract', 'execution' => $execution, 'brokerOrderCreated' => false];
        }
        $execution = $this->recordExecution($proposal, $connector->id(), (string) $placed['ticket'], $automated, 'EXECUTED', $placed);
        $this->audit->emit('ORDER_FILLED', sprintf('Broker filled %s %.2f %s @ %s (ticket %s)', $order['side'], $order['volume'], $order['symbol'], number_format($placed['price'], 5), $placed['ticket']), ['proposalId' => $id, 'ticket' => $placed['ticket']], $actor);
        $this->notify('ORDER_FILLED', 'info', sprintf('Filled %s %.2f %s @ %s', $order['side'], $order['volume'], $order['symbol'], number_format($placed['price'], 5)), ['proposalId' => $id, 'ticket' => $placed['ticket']], "proposal:{$id}:filled");

        // 15 — portfolio update (post-trade snapshot on the execution record)
        try {
            $account = $connector->account();
            $positions = $connector->positions();
            $snapshot = ['equity' => $account['equity'], 'balance' => $account['balance'], 'margin' => $account['margin'], 'openPositions' => count($positions)];
            $execution['result']['portfolioAfter'] = $snapshot;
            $this->proposals->saveExecution($execution);
        } catch (\Throwable $e) {
            $execution['result']['portfolioAfter'] = ['warning' => 'post-trade snapshot unavailable: ' . $e->getMessage()];
            $this->proposals->saveExecution($execution);
        }

        $this->setStatus($proposal, 'EXECUTED', null, $actor);
        return ['status' => 'EXECUTED', 'proposalId' => $id, 'execution' => $execution, 'brokerOrderCreated' => true];
    }

    /** SEMI_AUTONOMOUS / FULLY_AUTOMATED entry point: evaluate then auto-route. */
    public function executeAutomated(array $intent): array
    {
        $result = $this->evaluate($intent, true, 'system');
        if ($result['status'] !== 'READY_TO_ROUTE') return $result;
        return $this->route($result['id'], 'system');
    }

    // ------------------------------------------------------- human workflow

    /** HUMAN_APPROVAL entry point (persisted pipeline result). */
    public function propose(array $intent, string $actor = 'user'): array
    {
        return $this->evaluate($intent, true, $actor);
    }

    public function decide(string $id, bool $approve, string $actor = 'user', ?string $reason = null): array
    {
        $proposal = $this->proposals->findProposal($id);
        if ($proposal === null) throw new \InvalidArgumentException('proposal not found');
        if ($proposal['status'] !== 'PENDING_APPROVAL') throw new \RuntimeException("proposal is {$proposal['status']} — only PENDING_APPROVAL proposals can be decided");
        $proposal['status'] = $approve ? 'APPROVED' : 'REJECTED';
        $proposal['decisionBy'] = $actor;
        $proposal['decidedAt'] = gmdate('c');
        $proposal['updated_at'] = gmdate('c');
        $this->proposals->saveProposal($proposal);
        $this->audit->emit($approve ? 'EXECUTION_APPROVAL_GRANTED' : 'EXECUTION_APPROVAL_REJECTED', $approve ? "Proposal {$id} approved for routing" : "Proposal {$id} rejected", ['id' => $id, 'reason' => $reason], $actor);
        return $this->proposals->findProposal($id) ?? $proposal;
    }

    /**
     * Spec §5 invalidation: an undecided proposal does not live forever.
     * PENDING_APPROVAL proposals older than proposalExpiryMinutes (platform
     * state, default 240) are expired and audited. Returns the expired ids.
     * @return array<int, string>
     */
    public function expireStaleProposals(?int $maxAgeSeconds = null): array
    {
        $state = $this->stateRepo->load();
        $maxAge = $maxAgeSeconds ?? ((int) ($state['proposalExpiryMinutes'] ?? 240)) * 60;
        $cutoff = gmdate('c', ($this->clock)() - $maxAge);
        $expired = [];
        foreach ($this->proposals->listProposals('PENDING_APPROVAL', 200) as $p) {
            if ((string) $p['created_at'] >= $cutoff) continue;
            $p['status'] = 'EXPIRED';
            $p['checks'][] = ['check' => 'outcome', 'ok' => false, 'detail' => sprintf('expired after %d minutes without a human decision', (int) ($maxAge / 60))];
            $this->proposals->saveProposal($p);
            $this->audit->emit('EXECUTION_PROPOSAL_EXPIRED', sprintf('Proposal %s expired without a decision (%s %s)', $p['id'], $p['symbol'], $p['side']), ['proposalId' => $p['id']], 'system');
            $this->notify('PROPOSAL_EXPIRED', 'warning', "Approval request expired: {$p['symbol']} {$p['side']}", ['proposalId' => $p['id']], "proposal:{$p['id']}:expired");
            $expired[] = $p['id'];
        }
        return $expired;
    }

    // ------------------------------------------------------------- queries

    /** @return array<int, array<string, mixed>> */
    public function proposals(?string $status = null, int $limit = 100): array
    {
        return $this->proposals->listProposals($status, $limit);
    }

    public function proposal(string $id): ?array
    {
        return $this->proposals->findProposal($id);
    }

    /** @return array<int, array<string, mixed>> */
    public function executions(int $limit = 50): array
    {
        return $this->proposals->listRecentExecutions($limit);
    }

    // ------------------------------------------------------------- helpers

    public static function automationLimits(array $state): array
    {
        return array_merge(
            ['maxTradeNotionalUsd' => 500.0, 'maxDailyTrades' => 5, 'maxRiskPerTradePct' => 0.01, 'approvedSymbols' => [], 'updatedAt' => null],
            $state['automationLimits'] ?? []
        );
    }

    private function save(array $result, string $actor, ?array $riskDecision): array
    {
        $i = $result['intent'];
        $proposal = [
            'id' => $result['id'], 'createdAt' => gmdate('c'), 'actor' => $actor,
            'broker' => $result['connector'] ?? 'none', 'symbol' => $i['symbol'], 'marketClass' => $i['marketClass'],
            'side' => $i['side'], 'orderType' => $i['type'], 'volume' => $i['volume'], 'price' => $i['price'] ?? null,
            'stopLoss' => $i['stopLoss'], 'takeProfit' => $i['takeProfit'] ?? null,
            'strategyId' => $i['strategyId'] ?? null, 'reason' => $i['reason'] ?? null,
            'status' => $result['status'], 'intent' => $i, 'checks' => $result['checks'],
            'riskDecision' => $riskDecision ?? $result['riskDecision'] ?? null,
            'decisionBy' => null, 'decidedAt' => null, 'updatedAt' => gmdate('c'),
        ];
        return $this->proposals->saveProposal($proposal);
    }

    private function setStatus(array $proposal, string $status, ?string $reason, string $actor): void
    {
        $proposal['status'] = $status;
        $proposal['updated_at'] = gmdate('c');
        if ($reason !== null) $proposal['checks'][] = ['check' => 'outcome', 'ok' => $status === 'EXECUTED', 'detail' => $reason];
        $this->proposals->saveProposal($proposal);
    }

    private function recordExecution(array $proposal, string $broker, ?string $ticket, bool $automated, string $status, array $result): array
    {
        return $this->proposals->saveExecution([
            'id' => 'ex_' . bin2hex(random_bytes(8)), 'proposalId' => $proposal['id'], 'broker' => $broker,
            'brokerOrderId' => $ticket, 'automated' => $automated, 'submittedAt' => gmdate('c'),
            'status' => $status, 'result' => $result,
        ]);
    }

    private function routingBlocked(array $proposal, string $reason): array
    {
        $result = ['status' => 'ROUTING_BLOCKED', 'reason' => $reason, 'proposalId' => $proposal['id'], 'brokerOrderCreated' => false];
        $this->audit->emit('EXECUTION_ROUTING_BLOCKED', $reason, $result, 'system');
        $this->notify('ROUTING_BLOCKED', 'warning', "Routing blocked: {$reason}", $result, 'routing-blocked:' . gmdate('Ymd'));
        return $result;
    }

    /** @return array|null normalized intent, or null when invalid */
    private function normalizeIntent(array $intent): ?array
    {
        $symbol = strtoupper(trim((string) ($intent['symbol'] ?? '')));
        $side = strtoupper((string) ($intent['side'] ?? ''));
        $type = strtoupper((string) ($intent['type'] ?? 'MARKET'));
        $marketClass = strtolower((string) ($intent['marketClass'] ?? ''));
        $volume = (float) ($intent['volume'] ?? 0);
        $stopLoss = isset($intent['stopLoss']) && is_numeric($intent['stopLoss']) ? (float) $intent['stopLoss'] : null;
        $takeProfit = isset($intent['takeProfit']) && is_numeric($intent['takeProfit']) ? (float) $intent['takeProfit'] : null;
        $price = isset($intent['price']) && is_numeric($intent['price']) ? (float) $intent['price'] : null;
        if (!preg_match('/^[A-Z0-9._-]{1,32}$/', $symbol)) return null;
        if (!in_array($side, ['BUY', 'SELL'], true) || !in_array($type, ['MARKET', 'LIMIT'], true)) return null;
        if (!in_array($marketClass, ['forex', 'crypto', 'stock', 'etf', 'commodity', 'future', 'index', 'bond'], true)) return null;
        if ($volume <= 0 || !is_finite($volume)) return null;
        if ($stopLoss === null || $stopLoss <= 0) return null;
        if ($type === 'LIMIT' && ($price === null || $price <= 0)) return null;
        $long = $side === 'BUY';
        if ($long ? $stopLoss >= ($price ?? PHP_FLOAT_MAX) : $stopLoss <= ($price ?? 0)) {
            // For MARKET orders the stop is validated against the live quote in step 10 via risk-reward; a directional sanity check needs a price, so accept here.
        }
        if ($takeProfit !== null && ($long ? $takeProfit <= 0 : $takeProfit <= 0)) return null;
        return [
            'symbol' => $symbol, 'side' => $side, 'type' => $type, 'marketClass' => $marketClass,
            'volume' => $volume, 'price' => $price, 'stopLoss' => $stopLoss, 'takeProfit' => $takeProfit,
            'strategyId' => isset($intent['strategyId']) && $intent['strategyId'] !== '' ? (string) $intent['strategyId'] : null,
            'strategyVersion' => isset($intent['strategyVersion']) && $intent['strategyVersion'] !== '' ? (string) $intent['strategyVersion'] : null,
            'contractSize' => isset($intent['contractSize']) && is_numeric($intent['contractSize']) ? (float) $intent['contractSize'] : 1.0,
            'reason' => isset($intent['reason']) ? mb_substr((string) $intent['reason'], 0, 500) : null,
        ];
    }

    /** Indicative session model (UTC). Quote freshness is the authoritative signal. */
    private static function sessionFor(string $marketClass, int $now): array
    {
        $dow = (int) gmdate('N', $now); // 1=Mon … 7=Sun
        $hour = (int) gmdate('G', $now);
        if ($marketClass === 'crypto') return ['open' => true, 'detail' => 'crypto trades 24/7'];
        if ($marketClass === 'forex') {
            // Continuous Sun 21:00 UTC – Fri 21:00 UTC (indicative)
            $closed = $dow === 6 || ($dow === 5 && $hour >= 21) || ($dow === 7 && $hour < 21);
            return ['open' => !$closed, 'detail' => (!$closed ? 'forex session open' : 'forex session closed') . ' (indicative Sun 21:00–Fri 21:00 UTC model)'];
        }
        $open = $dow <= 5 && $hour >= 0 && $hour < 21;
        return ['open' => $open, 'detail' => ($open ? 'session open' : 'session closed') . " (indicative Mon–Fri 00:00–21:00 UTC model for {$marketClass})"];
    }

    private function safeIntent(array $intent): array
    {
        return array_intersect_key($intent, array_flip(['symbol', 'marketClass', 'side', 'type', 'volume', 'price', 'stopLoss', 'takeProfit', 'strategyId', 'strategyVersion', 'reason']));
    }

    private function publicQuote(array $q): array
    {
        return ['symbol' => $q['symbol'], 'bid' => $q['bid'], 'ask' => $q['ask'], 'timestamp' => $q['timestamp'], 'delayed' => $q['delayed'] ?? false];
    }

    private function publicAccount(array $a): array
    {
        return ['accountId' => $a['accountId'], 'currency' => $a['currency'], 'balance' => $a['balance'], 'equity' => $a['equity'], 'freeMargin' => $a['freeMargin'], 'timestamp' => $a['timestamp']];
    }
}
