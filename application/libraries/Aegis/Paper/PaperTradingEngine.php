<?php
namespace Aegis\Paper;

use Aegis\Backtest\Backtester;
use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\JournalRepository;
use Aegis\Persistence\PaperRepository;
use Aegis\Persistence\PlatformStateRepository;
use Aegis\ProviderManager;
use Aegis\RiskEngine;
use Aegis\Strategies\SeriesView;
use Aegis\Strategies\StrategyRegistry;

/**
 * PHASE 3 — PAPER TRADING ENGINE.
 *
 * Simulated accounts, orders and fills against REAL market prices when
 * providers are reachable (clearly-labeled synthetic prices when they are
 * not). Every order passes the full governance chain BEFORE simulation:
 *
 *   kill switch -> trading mode (PAPER_TRADING required) -> risk engine
 *   (per-trade + portfolio limits on live account state) -> fill.
 *
 * Fills pay synthetic spread + slippage + commission like the backtester,
 * SL/TP evaluate on candle extremes with the pessimistic stop-first rule,
 * and every close lands in the trade journal (source=paper) with the
 * decision's confidence — feeding the confidence-calibration analytics.
 *
 * Paper trading is SIMULATION: no order ever leaves the process, and no
 * broker connector is involved (those arrive in Phase 4).
 */
class PaperTradingEngine
{
    public const DEFAULT_SPREAD_BPS = 2.0;
    public const DEFAULT_SLIPPAGE_BPS = 2.0;
    public const DEFAULT_FEE_BPS = 2.0;

    public function __construct(
        private readonly PaperRepository $repo,
        private readonly JournalRepository $journal,
        private readonly AuditRepository $audit,
        private readonly PlatformStateRepository $stateRepo,
        private readonly ProviderManager $providers,
        private readonly RiskEngine $risk,
        private readonly StrategyRegistry $strategies,
    ) {}

    // ------------------------------------------------------------ accounts --

    public function createAccount(string $name, float $startingBalance, string $currency = 'USD'): array
    {
        if ($startingBalance <= 0 || $startingBalance > 10_000_000) {
            throw new \InvalidArgumentException('Starting balance must be between 1 and 10,000,000');
        }
        $account = [
            'id' => null,
            'name' => mb_substr($name, 0, 60),
            'currency' => $currency,
            'starting_balance' => round($startingBalance, 2),
            'balance' => round($startingBalance, 2),
            'peak_equity' => round($startingBalance, 2),
            'created_at' => gmdate('c'),
        ];
        $account = $this->repo->saveAccount($account);
        $this->audit->emit('PAPER_ACCOUNT_CREATED', "Paper account '{$account['name']}' created with " . number_format($account['starting_balance'], 2) . " {$currency}", ['accountId' => $account['id']]);
        return $account;
    }

    public function accountSummary(int $accountId): array
    {
        $account = $this->repo->findAccount($accountId);
        if (!$account) throw new \InvalidArgumentException("Account {$accountId} not found");
        $positions = $this->repo->listOpenPositions($accountId);
        $unrealized = 0.0;
        $openRisk = [];
        foreach ($positions as $p) {
            $price = $this->priceFor($p['symbol']);
            $pnl = ($p['direction'] === 'LONG' ? $price - $p['entry_price'] : $p['entry_price'] - $price) * $p['units'];
            $unrealized += $pnl;
            $riskPerUnit = abs($p['entry_price'] - $p['stop_loss']);
            $openRisk[$p['symbol']] = ($openRisk[$p['symbol']] ?? 0) + $riskPerUnit * $p['units'];
        }
        $today = gmdate('Y-m-d');
        $dailyPnl = 0.0; $weeklyPnl = 0.0;
        foreach ($this->repo->listTrades($accountId, 1000) as $t) {
            // listTrades() is a leg ledger — only EXIT legs carry realized P&L.
            if (($t['leg'] ?? '') !== 'EXIT') continue;
            $at = (string) ($t['time'] ?? '');
            if ($at === '') continue;
            if (substr($at, 0, 10) === $today) $dailyPnl += (float) ($t['net_pnl'] ?? 0);
            if (strtotime($at) > strtotime('-7 days')) $weeklyPnl += (float) ($t['net_pnl'] ?? 0);
        }
        $equity = $account['balance'] + $unrealized;
        return [
            'account' => $account,
            'equity' => round($equity, 2),
            'balance' => round($account['balance'], 2),
            'unrealizedPnl' => round($unrealized, 2),
            'dailyPnl' => round($dailyPnl, 2),
            'weeklyPnl' => round($weeklyPnl, 2),
            'openPositions' => count($positions),
            'openRiskBySymbol' => array_map(fn($v) => round($v, 2), $openRisk),
            'positions' => array_map(fn($p) => $this->positionView($p, $this->priceFor($p['symbol'])), $positions),
            'dailyLossPct' => $equity > 0 ? round(-$dailyPnl / $equity * 100, 2) : 0,
        ];
    }

    private function positionView(array $p, float $price): array
    {
        $pnl = ($p['direction'] === 'LONG' ? $price - $p['entry_price'] : $p['entry_price'] - $price) * $p['units'];
        $risk = abs($p['entry_price'] - $p['stop_loss']) * $p['units'];
        return $p + [
            'current_price' => $price,
            'unrealized_pnl' => round($pnl, 2),
            'unrealized_r' => $risk > 0 ? round($pnl / $risk, 3) : null,
        ];
    }

    // -------------------------------------------------------------- orders --

    /**
     * Submit a paper order. Full governance chain first; market orders fill
     * immediately at the current price, limit orders queue until a tick
     * crosses them.
     */
    public function submitOrder(int $accountId, array $input): array
    {
        $state = $this->stateRepo->load();
        $syntheticAllowed = !empty($state['allowSyntheticPaperData']);
        if ($state['killSwitch']['active']) {
            return $this->reject($accountId, $input, 'Kill switch is ACTIVE — all order placement is blocked');
        }
        if ($state['tradingMode'] !== 'PAPER_TRADING') {
            return $this->reject($accountId, $input, "Trading mode is {$state['tradingMode']} — switch to PAPER_TRADING to place paper orders");
        }

        $symbol = strtoupper($input['symbol'] ?? '');
        $side = strtoupper($input['side'] ?? '');
        $type = strtoupper($input['type'] ?? 'MARKET');
        $marketClass = $input['marketClass'] ?? $this->inferMarketClass($symbol);
        if (!in_array($side, ['BUY', 'SELL'], true)) throw new \InvalidArgumentException('side must be BUY or SELL');
        if (!in_array($type, ['MARKET', 'LIMIT'], true)) throw new \InvalidArgumentException('type must be MARKET or LIMIT');
        if ($symbol === '') throw new \InvalidArgumentException('symbol required');

        $existingPosition = $this->repo->findOpenPosition($accountId, $symbol);
        $existingOrder = $this->repo->findOpenOrder($accountId, $symbol);
        if ($existingPosition || $existingOrder) {
            return $this->reject($accountId, $input, "Already holding a position or pending order in {$symbol} (one net position per symbol)");
        }

        // Resolve risk sizing BEFORE building the order.
        $price = $type === 'LIMIT' ? (float)$input['price'] : $this->priceFor($symbol);
        if ($price <= 0) throw new \InvalidArgumentException('invalid price');
        $direction = $side === 'BUY' ? 'LONG' : 'SHORT';
        $stopLoss = isset($input['stopLoss']) && is_numeric($input['stopLoss']) ? (float)$input['stopLoss'] : null;
        if ($stopLoss === null) {
            return $this->reject($accountId, $input, 'Stop loss is mandatory for paper orders (risk engine requirement)');
        }
        $stopOk = $direction === 'LONG' ? $stopLoss < $price : $stopLoss > $price;
        if (!$stopOk) {
            return $this->reject($accountId, $input, 'Stop loss must sit beyond the entry price on the correct side');
        }
        $takeProfit = isset($input['takeProfit']) && is_numeric($input['takeProfit']) ? (float)$input['takeProfit'] : null;
        if ($takeProfit !== null && !($direction === 'LONG' ? $takeProfit > $price : $takeProfit < $price)) {
            return $this->reject($accountId, $input, 'Take profit must sit beyond the entry price on the correct side');
        }
        if ($takeProfit === null) {
            $dist = abs($price - $stopLoss);
            $takeProfit = $direction === 'LONG' ? $price + 3 * $dist : $price - 3 * $dist;
        }

        $summary = $this->accountSummary($accountId);
        // Sizing: riskPct of equity, capped by explicit notional if provided.
        $limits = $this->risk->getLimits();
        $riskPct = isset($input['riskPct']) && is_numeric($input['riskPct'])
            ? min((float)$input['riskPct'], $limits['maxRiskPerTradePct'])
            : $limits['riskPerTradePct'];
        $riskAmount = $summary['equity'] * $riskPct;
        $units = $riskAmount / abs($price - $stopLoss);
        $notional = $units * $price;
        if ($notional > $limits['maxPositionNotionalUsd']) {
            $units = $limits['maxPositionNotionalUsd'] / $price;
            $riskAmount = $units * abs($price - $stopLoss);
        }

        // Full Risk Engine pass on the *synthetic setup* equivalent.
        $setup = [
            'action' => $side, 'symbol' => $symbol,
            'entry' => ['type' => 'ZONE', 'min' => $price, 'max' => $price, 'reference' => $price],
            'stopLoss' => $stopLoss, 'takeProfit' => [$takeProfit],
            'riskReward' => abs($takeProfit - $price) / max(1e-9, abs($price - $stopLoss)),
        ];
        $priceIsSynthetic = $this->currentPriceIsSynthetic($symbol);
        $riskCtx = [
            'killSwitchActive' => false, // already checked — do not double-report
            'dataQuality' => 1.0,
            // When synthetic prices are explicitly allowed for paper trading,
            // the risk engine does not veto on data origin — everything stays
            // labeled SIMULATION instead (order/position/journal flags).
            'syntheticData' => $priceIsSynthetic && !$syntheticAllowed,
            'staleData' => false,
            'equity' => $summary['equity'],
            'openRiskBySymbol' => $summary['openRiskBySymbol'],
            'openPositions' => $summary['openPositions'],
            'dailyPnl' => $summary['dailyPnl'],
            'weeklyPnl' => $summary['weeklyPnl'],
            'peakEquity' => max($summary['account']['peak_equity'], $summary['equity']),
        ];
        $decision = $this->risk->evaluate($setup, $riskCtx);
        if (!$decision['approved']) {
            $order = $this->persistOrder($accountId, $symbol, $marketClass, $side, $type, $units, $price, $stopLoss, $takeProfit, 'REJECTED', $input, $riskAmount);
            $order['rejectReasons'] = $decision['reasons'];
            $this->audit->emit('RISK_REJECTED', "Paper order {$symbol} {$side} rejected by Risk Engine", ['accountId' => $accountId, 'orderId' => $order['id'], 'reasons' => $decision['reasons']]);
            return ['filled' => false, 'order' => $order, 'riskDecision' => $decision];
        }

        $order = $this->persistOrder($accountId, $symbol, $marketClass, $side, $type, $units, $type === 'LIMIT' ? (float)$input['price'] : $price, $stopLoss, $takeProfit, 'PENDING', $input, $riskAmount);
        $this->audit->emit('ORDER_SUBMITTED', "Paper {$type} order {$side} {$units} {$symbol} @ " . number_format($order['price'], 5), ['accountId' => $accountId, 'orderId' => $order['id']]);

        if ($type === 'MARKET') {
            return $this->fillOrder($order, $this->priceFor($symbol));
        }
        return ['filled' => false, 'order' => $order, 'riskDecision' => $decision];
    }

    private function reject(int $accountId, array $input, string $reason): array
    {
        $order = [
            'id' => null, 'account_id' => $accountId,
            'symbol' => strtoupper($input['symbol'] ?? ''), 'side' => strtoupper($input['side'] ?? ''),
            'type' => strtoupper($input['type'] ?? 'MARKET'), 'units' => 0,
            'price' => $input['price'] ?? null, 'stop_loss' => $input['stopLoss'] ?? null, 'take_profit' => $input['takeProfit'] ?? null,
            'status' => 'REJECTED', 'reject_reason' => $reason,
            'reason' => $input['reason'] ?? null, 'ai_confidence' => $input['confidence'] ?? null,
            'strategy' => $input['strategy'] ?? null, 'created_at' => gmdate('c'), 'filled_at' => null, 'fill_price' => null,
        ];
        $order = $this->repo->saveOrder($order);
        $this->audit->emit('TRADE_REJECTED', "Paper order rejected: {$reason}", ['accountId' => $accountId, 'symbol' => $order['symbol']]);
        return ['filled' => false, 'order' => $order, 'riskDecision' => null];
    }

    private function persistOrder(int $accountId, string $symbol, string $marketClass, string $side, string $type, float $units, float $price, float $stopLoss, float $takeProfit, string $status, array $input, float $riskAmount): array
    {
        $order = [
            'id' => null, 'account_id' => $accountId, 'symbol' => $symbol, 'market_class' => $marketClass,
            'side' => $side, 'type' => $type, 'units' => round($units, 6), 'price' => round($price, 8),
            'stop_loss' => round($stopLoss, 8), 'take_profit' => round($takeProfit, 8),
            'status' => $status, 'reject_reason' => null,
            'risk_amount' => round($riskAmount, 2),
            'reason' => mb_substr((string)($input['reason'] ?? ''), 0, 500),
            'ai_confidence' => isset($input['confidence']) && is_numeric($input['confidence']) ? (float)$input['confidence'] : null,
            'strategy' => $input['strategy'] ?? null,
            'created_at' => gmdate('c'), 'filled_at' => null, 'fill_price' => null,
        ];
        return $this->repo->saveOrder($order);
    }

    private function fillOrder(array $order, float $rawPrice): array
    {
        $h = self::DEFAULT_SPREAD_BPS / 2 / 10000;
        $s = self::DEFAULT_SLIPPAGE_BPS / 10000;
        $long = $order['side'] === 'BUY';
        $fillPrice = $long ? $rawPrice * (1 + $h + $s) : $rawPrice * (1 - $h - $s);
        $feeRate = self::DEFAULT_FEE_BPS / 10000;
        $entryFee = $order['units'] * $fillPrice * $feeRate;

        $account = $this->repo->findAccount($order['account_id']);
        $account['balance'] -= $entryFee;

        $position = [
            'id' => null, 'account_id' => $order['account_id'], 'symbol' => $order['symbol'],
            'market_class' => $order['market_class'] ?? 'crypto',
            'direction' => $long ? 'LONG' : 'SHORT',
            'units' => $order['units'], 'entry_price' => round($fillPrice, 8),
            'stop_loss' => $order['stop_loss'], 'take_profit' => $order['take_profit'],
            'entry_fee' => round($entryFee, 6), 'risk_amount' => $order['risk_amount'],
            'strategy' => $order['strategy'], 'reason' => $order['reason'],
            'ai_confidence' => $order['ai_confidence'],
            'opened_at' => gmdate('c'), 'status' => 'OPEN', 'closed_at' => null, 'exit_price' => null,
            'realized_pnl' => null, 'exit_reason' => null,
        ];
        $position = $this->repo->savePosition($position);

        $order['status'] = 'FILLED';
        $order['filled_at'] = gmdate('c');
        $order['fill_price'] = round($fillPrice, 8);
        $order = $this->repo->saveOrder($order);
        $this->repo->saveAccount($account);

        $this->repo->saveTrade([
            'id' => null, 'account_id' => $order['account_id'], 'order_id' => $order['id'], 'position_id' => $position['id'],
            'leg' => 'ENTRY', 'symbol' => $order['symbol'], 'price' => round($fillPrice, 8),
            'units' => $order['units'], 'fee' => round($entryFee, 6), 'time' => gmdate('c'), 'synthetic' => $this->currentPriceIsSynthetic($order['symbol']),
        ]);
        $this->audit->emit('ORDER_FILLED', sprintf('Paper order filled: %s %s %s @ %s', $long ? 'BUY' : 'SELL', $order['units'], $order['symbol'], number_format($fillPrice, 5)), ['accountId' => $order['account_id'], 'orderId' => $order['id'], 'positionId' => $position['id']]);
        $this->audit->emit('POSITION_OPENED', "Paper position opened in {$order['symbol']} (#{$position['id']})", ['accountId' => $order['account_id'], 'positionId' => $position['id']]);

        return ['filled' => true, 'order' => $order, 'position' => $position];
    }

    public function closePosition(int $accountId, int $positionId, string $reason = 'MANUAL'): array
    {
        $position = $this->repo->findPosition($positionId);
        if (!$position || $position['account_id'] !== $accountId || $position['status'] !== 'OPEN') {
            throw new \InvalidArgumentException("Position {$positionId} not open on account {$accountId}");
        }
        return $this->closeAt($position, $this->priceFor($position['symbol']), $reason);
    }

    private function closeAt(array $position, float $rawExit, string $exitReason): array
    {
        $h = self::DEFAULT_SPREAD_BPS / 2 / 10000;
        $s = self::DEFAULT_SLIPPAGE_BPS / 10000;
        $long = $position['direction'] === 'LONG';
        $exitPrice = $long ? $rawExit * (1 - $h - $s) : $rawExit * (1 + $h + $s);
        $feeRate = self::DEFAULT_FEE_BPS / 10000;
        $exitFee = $position['units'] * $exitPrice * $feeRate;
        $grossPnl = $long ? ($exitPrice - $position['entry_price']) * $position['units']
            : ($position['entry_price'] - $exitPrice) * $position['units'];
        $netPnl = $grossPnl - $position['entry_fee'] - $exitFee;

        $account = $this->repo->findAccount($position['account_id']);
        $account['balance'] += $grossPnl - $exitFee;

        $position['status'] = 'CLOSED';
        $position['closed_at'] = gmdate('c');
        $position['exit_price'] = round($exitPrice, 8);
        $position['realized_pnl'] = round($netPnl, 6);
        $position['exit_reason'] = $exitReason;
        $position = $this->repo->savePosition($position);
        $this->repo->saveAccount($account);

        $this->repo->saveTrade([
            'id' => null, 'account_id' => $position['account_id'], 'order_id' => null, 'position_id' => $position['id'],
            'leg' => 'EXIT', 'symbol' => $position['symbol'], 'price' => round($exitPrice, 8),
            'units' => $position['units'], 'fee' => round($exitFee, 6), 'time' => gmdate('c'),
            'synthetic' => $this->currentPriceIsSynthetic($position['symbol']),
        ]);

        // Journal the closed paper trade (spec §15).
        $risk = abs($position['entry_price'] - $position['stop_loss']) * $position['units'];
        $this->journal->save([
            'id' => Backtester::uuid(), 'source' => 'paper', 'symbol' => $position['symbol'],
            'market' => $position['market_class'] ?? 'crypto',
            'strategy' => $position['strategy'], 'strategy_version' => null,
            'direction' => $position['direction'],
            'entry_time' => $position['opened_at'], 'entry_price' => $position['entry_price'],
            'exit_time' => $position['closed_at'], 'exit_price' => $exitPrice,
            'position_size' => $position['units'], 'stop_loss' => $position['stop_loss'], 'take_profit' => $position['take_profit'],
            'fees' => round($position['entry_fee'] + $exitFee, 6), 'slippage' => 0,
            'pnl' => round($netPnl, 6),
            'pnl_pct' => $position['units'] * $position['entry_price'] > 0 ? ($netPnl / ($position['units'] * $position['entry_price'])) * 100 : null,
            'r_multiple' => $risk > 0 ? round($netPnl / $risk, 4) : null,
            'reason' => $position['reason'] ?: ('paper exit: ' . $exitReason),
            'ai_confidence' => $position['ai_confidence'],
            'confidence_source' => $position['ai_confidence'] !== null ? 'strategy' : null,
            'agent_consensus' => null, 'risk_score' => null,
            'execution_time' => $position['opened_at'], 'paper_position_id' => $position['id'],
        ]);

        $this->audit->emit($exitReason === 'STOP_LOSS' ? 'STOP_LOSS_TRIGGERED' : ($exitReason === 'TAKE_PROFIT_TRIGGERED' ? 'TAKE_PROFIT_TRIGGERED' : 'POSITION_CLOSED'), sprintf('Paper position #%d %s %s closed @ %s (%s)', $position['id'], $position['direction'], $position['symbol'], number_format($exitPrice, 5), number_format($netPnl, 2) . ' P&L'), ['accountId' => $position['account_id'], 'positionId' => $position['id'], 'exitReason' => $exitReason]);

        return ['position' => $position, 'netPnl' => round($netPnl, 6)];
    }

    // ---------------------------------------------------------------- tick --

    /**
     * Process one market tick for an account:
     *  1) fill pending LIMIT orders whose price was crossed,
     *  2) evaluate SL/TP on the latest candle (pessimistic stop-first),
     *  3) run deployed strategies on the latest closed bar and submit
     *     risk-checked paper orders for their signals.
     */
    public function tick(int $accountId): array
    {
        $actions = ['filledOrders' => [], 'closedPositions' => [], 'strategySignals' => [], 'skipped' => []];

        // 1) pending limit orders
        foreach ($this->repo->listOrders($accountId, 'PENDING') as $order) {
            if ($order['type'] !== 'LIMIT') continue;
            $candle = $this->lastCandle($order['symbol']);
            if ($candle === null) { $actions['skipped'][] = "no data for {$order['symbol']}"; continue; }
            $buy = $order['side'] === 'BUY';
            $touched = $buy ? $candle['low'] <= $order['price'] : $candle['high'] >= $order['price'];
            if ($touched) {
                $actions['filledOrders'][] = $this->fillOrder($order, $order['price'])['order'];
            }
        }

        // 2) SL/TP on open positions (pessimistic: stop first)
        foreach ($this->repo->listOpenPositions($accountId) as $position) {
            $candle = $this->lastCandle($position['symbol']);
            if ($candle === null) continue;
            $long = $position['direction'] === 'LONG';
            $stopHit = $long ? $candle['low'] <= $position['stop_loss'] : $candle['high'] >= $position['stop_loss'];
            $tpHit = $long ? $candle['high'] >= $position['take_profit'] : $candle['low'] <= $position['take_profit'];
            if ($stopHit) {
                $actions['closedPositions'][] = $this->closeAt($position, $position['stop_loss'], 'STOP_LOSS');
            } elseif ($tpHit) {
                $actions['closedPositions'][] = $this->closeAt($position, $position['take_profit'], 'TAKE_PROFIT');
            }
        }

        // 3) deployed strategies
        foreach ($this->repo->listDeployments($accountId, true) as $dep) {
            $signalInfo = $this->runDeployment($dep);
            if ($signalInfo !== null) $actions['strategySignals'][] = $signalInfo;
        }

        return ['actions' => $actions, 'summary' => $this->accountSummary($accountId)];
    }

    private function runDeployment(array $dep): ?array
    {
        $strategy = $this->strategies->implementation($dep['strategy_id'], $dep['strategy_version']);
        if (!$strategy) return null;
        $series = $this->providers->getCandleSeries($dep['symbol'], $dep['market_class'], $dep['timeframe'], 300);
        $candles = $series['candles'];
        if (count($candles) < 80) return null;
        $ind = SeriesView::precompute($candles);
        $i = count($candles) - 1;
        $position = $this->repo->findOpenPosition($dep['account_id'], $dep['symbol']);
        $posView = null;
        if ($position) {
            $price = end($candles)['close'];
            $posView = [
                'direction' => $position['direction'], 'entryPrice' => $position['entry_price'],
                'entryBar' => $i - 5, 'stopLoss' => $position['stop_loss'], 'takeProfit' => $position['take_profit'],
                'unrealizedPnl' => ($position['direction'] === 'LONG' ? $price - $position['entry_price'] : $position['entry_price'] - $price) * $position['units'],
            ];
        }
        $view = new SeriesView($candles, $ind, $i, ['symbol' => $dep['symbol'], 'timeframe' => $dep['timeframe'], 'marketClass' => $dep['market_class']]);
        $signal = $strategy->evaluate(['view' => $view, 'position' => $posView, 'equity' => 10000]);

        // record evaluation heartbeat
        $dep['last_evaluated_at'] = gmdate('c');
        $dep['last_signal'] = $signal['action'];
        $dep = $this->repo->saveDeployment($dep);

        if ($signal['action'] === 'CLOSE' && $position) {
            $res = $this->closePosition($dep['account_id'], $position['id'], 'SIGNAL');
            return ['deployment' => $dep['id'], 'symbol' => $dep['symbol'], 'action' => 'CLOSE', 'result' => $res['netPnl']];
        }
        if (in_array($signal['action'], ['BUY', 'SELL'], true) && !$position) {
            if ($signal['action'] === 'SELL' && !$strategy->supportsShorts()) {
                return null;
            }
            $res = $this->submitOrder($dep['account_id'], [
                'symbol' => $dep['symbol'], 'marketClass' => $dep['market_class'],
                'side' => $signal['action'], 'type' => 'MARKET',
                'stopLoss' => $signal['stopLoss'] ?? null, 'takeProfit' => $signal['takeProfit'] ?? null,
                'reason' => "[{$dep['strategy_id']}] " . $signal['reason'],
                'confidence' => $signal['confidence'], 'strategy' => $dep['strategy_id'],
            ]);
            $ok = $res['filled'] ?? false;
            return ['deployment' => $dep['id'], 'symbol' => $dep['symbol'], 'action' => $signal['action'], 'submitted' => $ok, 'rejectReasons' => $res['order']['reject_reason'] ?? ($res['order']['rejectReasons'] ?? null)];
        }
        return null;
    }

    // --------------------------------------------------------- deployments --

    public function deployStrategy(int $accountId, string $strategyId, string $version, string $symbol, string $timeframe, string $marketClass): array
    {
        if ($this->strategies->implementation($strategyId, $version) === null) {
            throw new \InvalidArgumentException("Strategy {$strategyId}@{$version} is not registered");
        }
        $record = $this->strategies->findRecordForPaper($strategyId, $version);
        if ($record === null) {
            throw new \InvalidArgumentException("Strategy record {$strategyId}@{$version} not found");
        }
        $gate = $this->strategies->canDeployToPaper($record);
        if (!$gate['ok']) {
            throw new \RuntimeException(implode('; ', $gate['reasons']));
        }
        $dep = [
            'id' => null, 'account_id' => $accountId, 'strategy_id' => $strategyId, 'strategy_version' => $version,
            'symbol' => strtoupper($symbol), 'market_class' => $marketClass, 'timeframe' => $timeframe,
            'active' => 1, 'deployed_at' => gmdate('c'), 'last_evaluated_at' => null, 'last_signal' => null,
        ];
        $dep = $this->repo->saveDeployment($dep);
        $this->audit->emit('STRATEGY_DEPLOYED_PAPER', "Strategy {$strategyId}@{$version} deployed to paper account #{$accountId} on {$dep['symbol']} {$timeframe}", ['accountId' => $accountId, 'deploymentId' => $dep['id']]);
        // Deploying to paper IS the PAPER_TRADING lifecycle stage (Phase 3).
        if ($record['lifecycle'] === 'RISK_REVIEWED') {
            $this->strategies->transition($strategyId, $version, 'PAPER_TRADING', "deployed to paper account #{$accountId}");
        }
        return $dep;
    }

    public function pauseDeployment(int $deploymentId, bool $active): array
    {
        $dep = $this->repo->findDeployment($deploymentId);
        if (!$dep) throw new \InvalidArgumentException("Deployment {$deploymentId} not found");
        $dep['active'] = $active ? 1 : 0;
        return $this->repo->saveDeployment($dep);
        $this->audit->emit('STRATEGY_DEPLOYMENT_TOGGLED', 'Paper deployment #' . $deploymentId . ($active ? ' resumed' : ' paused'), ['deploymentId' => $deploymentId]);
        return $dep;
    }

    // ------------------------------------------------------------- helpers --

    private function lastCandle(string $symbol): ?array
    {
        try {
            $series = $this->providers->getCandleSeries($symbol, $this->inferMarketClass($symbol), '1m', 2);
            return count($series['candles']) ? end($series['candles']) : null;
        } catch (\Throwable $e) {
            return null;
        }
    }

    private function priceFor(string $symbol): float
    {
        $q = $this->providers->getQuote($symbol);
        return (float)$q['quote']['last'];
    }

    private function currentPriceIsSynthetic(string $symbol): bool
    {
        try {
            $q = $this->providers->getQuote($symbol);
            return !empty($q['synthetic']);
        } catch (\Throwable $e) {
            return false;
        }
    }

    public function inferMarketClass(string $symbol): string
    {
        $s = strtoupper($symbol);
        $known = ['EURUSD' => 'forex', 'GBPUSD' => 'forex', 'USDJPY' => 'forex', 'AUDUSD' => 'forex',
            'USDCAD' => 'forex', 'USDCHF' => 'forex', 'NZDUSD' => 'forex', 'XAUUSD' => 'commodity'];
        if (isset($known[$s])) return $known[$s];
        if (str_ends_with($s, 'USDT')) return 'crypto';
        return 'forex';
    }
}
