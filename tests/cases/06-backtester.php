<?php
/** Backtester: fill mechanics, cost model, pessimism, reconciliation. */
use Aegis\Backtest\Backtester;
use Aegis\Backtest\Metrics;
use Aegis\Strategies\LookAheadError;
use Aegis\Strategies\SeriesView;
use Aegis\Strategies\TradingStrategy;

class ScriptedStrategy implements TradingStrategy
{
    public array $seen = [];
    public function __construct(private array $script) {}
    public function id(): string { return 'scripted'; }
    public function version(): string { return '1.0.0'; }
    public function name(): string { return 'Scripted'; }
    public function description(): string { return 'test'; }
    public function marketClasses(): array { return ['crypto']; }
    public function timeframes(): array { return ['1h']; }
    public function params(): array { return []; }
    public function paramGrid(): array { return []; }
    public function supportsShorts(): bool { return true; }
    public function evaluate(array $ctx): array {
        $this->seen[] = $ctx['view']->index;
        return $this->script[$ctx['view']->index] ?? ['action' => 'HOLD', 'reason' => 'none', 'confidence' => 0];
    }
}

function bt_req(array $over = []): array
{
    return array_merge([
        'initialEquity' => 10000.0, 'riskPct' => 0.01, 'feeBps' => 2.0, 'spreadBps' => 2.0,
        'slippageBps' => 2.0, 'allowShorts' => false, 'warmupBars' => 10, 'maxBarsInTrade' => 0,
    ], $over);
}

function flat(int $n, float $price = 100.0): array
{
    $out = [];
    for ($i = 0; $i < $n; $i++) {
        $out[] = ['timestamp' => 1755000000000 - ($n - $i) * 3600000, 'open' => $price, 'high' => $price + 0.2, 'low' => $price - 0.2, 'close' => $price, 'volume' => 100];
    }
    return $out;
}
const BT_META = ['symbol' => 'TESTUSD', 'timeframe' => '1h', 'marketClass' => 'crypto'];

test('backtest: fills at NEXT bar open with costs (never the signal close)', function () {
    $candles = flat(80);
    $candles[30] = ['timestamp' => $candles[30]['timestamp'], 'open' => 100, 'high' => 100.2, 'low' => 99.8, 'close' => 101];
    $candles[31] = ['timestamp' => $candles[31]['timestamp'], 'open' => 102, 'high' => 102.2, 'low' => 101.8, 'close' => 102];
    $strat = new ScriptedStrategy([30 => ['action' => 'BUY', 'reason' => 'in', 'confidence' => 0.8, 'stopLoss' => 98.0, 'takeProfit' => 110.0]]);
    $res = Backtester::simulate($strat, $candles, bt_req(), BT_META);
    assert_equals(1, count($res['trades']));
    $t = $res['trades'][0];
    assert_close(102 * 1.0003, $t['entryPrice'], 1e-8); // open*(1 + halfSpread + slip)
    $stopDistance = 102 * 1.0003 - 98;
    assert_close(100 / $stopDistance, $t['units'], 1e-6); // riskAmount / stopDistance
    assert_equals('END_OF_DATA', $t['exitReason']);
    assert_close(100 * 0.9997, $t['exitPrice'], 1e-8); // final close*(1 - costs)
});

test('backtest: stop fills first when a bar touches both stop and target', function () {
    $candles = flat(80);
    $candles[31] = ['timestamp' => $candles[31]['timestamp'], 'open' => 100, 'high' => 112, 'low' => 97.5, 'close' => 100];
    $strat = new ScriptedStrategy([30 => ['action' => 'BUY', 'reason' => 'in', 'confidence' => 0.5, 'stopLoss' => 98.0, 'takeProfit' => 110.0]]);
    $res = Backtester::simulate($strat, $candles, bt_req(), BT_META);
    $t = $res['trades'][0];
    assert_equals('STOP_LOSS', $t['exitReason']);
    assert_close(98 * 0.9997, $t['exitPrice'], 1e-8);
    assert_true($t['netPnl'] < 0);
});

test('backtest: entry bar can stop out immediately', function () {
    $candles = flat(80);
    $candles[31] = ['timestamp' => $candles[31]['timestamp'], 'open' => 100, 'high' => 100.2, 'low' => 97.0, 'close' => 99];
    $strat = new ScriptedStrategy([30 => ['action' => 'BUY', 'reason' => 'in', 'confidence' => 0.5, 'stopLoss' => 98.0, 'takeProfit' => 110.0]]);
    $res = Backtester::simulate($strat, $candles, bt_req(), BT_META);
    assert_equals('STOP_LOSS', $res['trades'][0]['exitReason']);
    assert_equals(0, $res['trades'][0]['barsHeld']);
});

test('backtest: shorts mirror longs when allowed; ignored otherwise', function () {
    $candles = flat(80);
    $candles[32] = ['timestamp' => $candles[32]['timestamp'], 'open' => 99, 'high' => 99.2, 'low' => 98.5, 'close' => 98.8];
    $candles[33] = ['timestamp' => $candles[33]['timestamp'], 'open' => 98.5, 'high' => 98.6, 'low' => 94.5, 'close' => 96.0];
    $sig = [30 => ['action' => 'SELL', 'reason' => 'short', 'confidence' => 0.6, 'stopLoss' => 102.0, 'takeProfit' => 95.0]];
    $allowed = Backtester::simulate(new ScriptedStrategy($sig), $candles, bt_req(['allowShorts' => true]), BT_META);
    $t = $allowed['trades'][0];
    assert_equals('SHORT', $t['direction']);
    assert_close(100 * 0.9997, $t['entryPrice'], 1e-8);
    assert_equals('TAKE_PROFIT', $t['exitReason']);
    assert_close(95 * 1.0003, $t['exitPrice'], 1e-8);
    assert_true($t['netPnl'] > 0);

    $blocked = Backtester::simulate(new ScriptedStrategy($sig), $candles, bt_req(['allowShorts' => false]), BT_META);
    assert_equals(0, count($blocked['trades']));
    assert_equals(1, $blocked['ignoredSignals']);
});

test('backtest: cost decomposition reconciles with the equity curve', function () {
    $candles = flat(80);
    $candles[40] = ['timestamp' => $candles[40]['timestamp'], 'open' => 100, 'high' => 106, 'low' => 99.8, 'close' => 105];
    $strat = new ScriptedStrategy([30 => ['action' => 'BUY', 'reason' => 'in', 'confidence' => 0.5, 'stopLoss' => 98.0, 'takeProfit' => 105.0]]);
    $req = bt_req();
    $res = Backtester::simulate($strat, $candles, $req, BT_META);
    $t = $res['trades'][0];
    $h = 0.0001; $s = 0.0002; $fee = 0.0002;
    $fillEntry = 100 * (1 + $h + $s);
    $fillExit = 105 * (1 - $h - $s);
    $units = 100 / ($fillEntry - 98);
    $entryFee = $units * $fillEntry * $fee;
    $exitFee = $units * $fillExit * $fee;
    assert_close($entryFee, $t['fees']['entryFee'], 1e-4);
    assert_close($exitFee, $t['fees']['exitFee'], 1e-4);
    assert_close((($fillExit - $fillEntry) * $units) - $entryFee - $exitFee, $t['netPnl'], 1e-4);
    // raw-to-raw P&L minus all costs = net
    $rawPnl = (105 - 100) * $units;
    assert_close($rawPnl - $t['fees']['totalCost'], $t['netPnl'], 1e-4);
    // final equity reconciliation
    assert_close(10000 - $entryFee + (($fillExit - $fillEntry) * $units - $exitFee), end($res['equityCurve'])['equity'], 0.02);
});

test('backtest: look-ahead access kills the run', function () {
    $cheater = new class implements TradingStrategy {
        public function id(): string { return 'cheater'; }
        public function version(): string { return '1.0.0'; }
        public function name(): string { return 'cheater'; }
        public function description(): string { return 'reads ahead'; }
        public function marketClasses(): array { return ['crypto']; }
        public function timeframes(): array { return ['1h']; }
        public function params(): array { return []; }
    public function paramGrid(): array { return []; }
        public function supportsShorts(): bool { return false; }
        public function evaluate(array $ctx): array {
            $ctx['view']->close($ctx['view']->index + 1);
            return ['action' => 'HOLD', 'reason' => 'x', 'confidence' => 0];
        }
    };
    assert_throws(LookAheadError::class, fn () => Backtester::simulate($cheater, flat(80), bt_req(), BT_META));
});

test('metrics: sharpe/sortino/streaks hand fixtures', function () {
    $barsPerYear = 8760.0;
    assert_equals(null, Metrics::sharpe([0.01, 0.01, 0.01], $barsPerYear));
    assert_close((1 / 3) * sqrt($barsPerYear), Metrics::sharpe([0.1, -0.05, 0.1, -0.05], $barsPerYear), 1e-3);
    $dd = sqrt(0.05 ** 2 * 2 / 4);
    assert_close((0.025 / $dd) * sqrt($barsPerYear), Metrics::sortino([0.1, -0.05, 0.1, -0.05], $barsPerYear), 1e-3);
    $t = fn($pnl) => ['netPnl' => $pnl];
    assert_equals(3, Metrics::streak(array_map($t, [10, 5, -3, 8, 7, 6, -2, 2]), fn($x) => $x['netPnl'] > 0));
    $curve = [['equity' => 100.0], ['equity' => 120.0], ['equity' => 90.0], ['equity' => 110.0], ['equity' => 95.0]];
    assert_close(30.0, Metrics::maxDdAbs($curve), 1e-9);
});
