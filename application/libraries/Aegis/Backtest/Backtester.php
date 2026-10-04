<?php
namespace Aegis\Backtest;

use Aegis\Strategies\LookAheadError;
use Aegis\Strategies\SeriesView;
use Aegis\Strategies\TradingStrategy;
use Aegis\ProviderManager;
use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\BacktestRepository;
use Aegis\Persistence\JournalRepository;

/**
 * Event-driven backtester with the same anti-bias mechanics as the TS
 * edition: next-bar-open fills, fee/spread/slippage cost model, pessimistic
 * stop-first rule, hard look-ahead guard, cost-reconciled equity curve.
 */
class Backtester
{
    public const DEFAULTS = [
        'limit' => 720, 'initialEquity' => 10000.0, 'riskPct' => 0.01, 'feeBps' => 2.0,
        'spreadBps' => 1.0, 'slippageBps' => 2.0, 'allowShorts' => false,
        'warmupBars' => 60, 'maxBarsInTrade' => 200,
    ];

    public static function simulate(TradingStrategy $strategy, array $candles, array $req, array $meta): array
    {
        $warnings = [];
        $trades = [];
        $equityCurve = [];
        $ind = SeriesView::precompute($candles);
        $warmup = min($req['warmupBars'], max(0, count($candles) - 10));

        $equity = $req['initialEquity'];
        $peak = $equity;
        $position = null;
        $pending = null;
        $barsInMarket = 0;
        $ignoredSignals = 0;

        $h = $req['spreadBps'] / 2 / 10000;
        $s = $req['slippageBps'] / 10000;
        $feeRate = $req['feeBps'] / 10000;

        $closePosition = function (array $pos, float $rawExit, string $exitTime, string $exitReason, int $exitBar) use (&$position, &$equity, &$trades, $h, $s, $feeRate) {
            $exitPrice = $pos['direction'] === 'LONG' ? $rawExit * (1 - $h - $s) : $rawExit * (1 + $h + $s);
            $grossPnl = $pos['direction'] === 'LONG'
                ? ($exitPrice - $pos['entryPrice']) * $pos['units']
                : ($pos['entryPrice'] - $exitPrice) * $pos['units'];
            $exitFee = $exitPrice * $pos['units'] * $feeRate;
            $exitSpread = $rawExit * $h * $pos['units'];
            $exitSlip = $rawExit * $s * $pos['units'];
            $equity += $grossPnl - $exitFee;
            $netPnl = $grossPnl - $pos['entryFee'] - $exitFee;
            $trades[] = [
                'direction' => $pos['direction'],
                'entryTime' => $pos['entryTime'], 'exitTime' => $exitTime,
                'entryPrice' => $pos['entryPrice'], 'exitPrice' => $exitPrice,
                'units' => $pos['units'], 'notional' => $pos['entryPrice'] * $pos['units'],
                'riskAmount' => $pos['riskAmount'], 'stopLoss' => $pos['stopLoss'], 'takeProfit' => $pos['takeProfit'],
                'fees' => [
                    'entryFee' => round($pos['entryFee'], 6), 'exitFee' => round($exitFee, 6),
                    'spreadCost' => round($pos['entrySpread'] + $exitSpread, 6),
                    'slippageCost' => round($pos['entrySlip'] + $exitSlip, 6),
                    'totalCost' => round($pos['entryFee'] + $exitFee + $pos['entrySpread'] + $exitSpread + $pos['entrySlip'] + $exitSlip, 6),
                ],
                'grossPnl' => round($grossPnl, 6), 'netPnl' => round($netPnl, 6),
                'rMultiple' => $pos['riskAmount'] > 0 ? round($netPnl / $pos['riskAmount'], 4) : 0,
                'exitReason' => $exitReason, 'barsHeld' => $exitBar - $pos['entryBar'],
                'signalReason' => $pos['signalReason'], 'confidence' => $pos['confidence'],
            ];
            $position = null;
        };

        $n = count($candles);
        for ($i = $warmup; $i < $n; $i++) {
            $bar = $candles[$i];

            // 1) intrabar stop/target (pessimistic: stop first)
            if ($position !== null) {
                $barsInMarket++;
                $stopHit = $position['direction'] === 'LONG' ? $bar['low'] <= $position['stopLoss'] : $bar['high'] >= $position['stopLoss'];
                $targetHit = $position['direction'] === 'LONG' ? $bar['high'] >= $position['takeProfit'] : $bar['low'] <= $position['takeProfit'];
                if ($stopHit) {
                    $closePosition($position, $position['stopLoss'], self::iso($bar['timestamp']), 'STOP_LOSS', $i);
                    $pending = null;
                } elseif ($targetHit) {
                    $closePosition($position, $position['takeProfit'], self::iso($bar['timestamp']), 'TAKE_PROFIT', $i);
                    $pending = null;
                } elseif ($req['maxBarsInTrade'] > 0 && $i - $position['entryBar'] >= $req['maxBarsInTrade']) {
                    $pending = ['kind' => 'EXIT', 'signal' => ['action' => 'CLOSE', 'reason' => 'time stop', 'confidence' => 0], 'exitReason' => 'TIME_STOP'];
                }
            }

            // 2) fill pending orders at this open
            if ($pending !== null) {
                if ($pending['kind'] === 'EXIT') {
                    if ($position !== null) $closePosition($position, $bar['open'], self::iso($bar['timestamp']), $pending['exitReason'] ?? 'SIGNAL', $i);
                    $pending = null;
                } elseif ($position === null) {
                    $sig = $pending['signal'];
                    $pending = null;
                    $wantsShort = $sig['action'] === 'SELL';
                    $stop = $sig['stopLoss'] ?? null;
                    if (in_array($sig['action'], ['BUY', 'SELL'], true) && $stop !== null && is_finite($stop)) {
                        $direction = $wantsShort ? 'SHORT' : 'LONG';
                        $stopOk = $direction === 'LONG' ? $stop < $bar['open'] : $stop > $bar['open'];
                        if ($wantsShort && !$req['allowShorts']) {
                            $ignoredSignals++;
                        } elseif (!$stopOk) {
                            $warnings[] = 'Skipped ' . $sig['action'] . ' at ' . self::iso($bar['timestamp']) . ': stop must sit beyond the entry fill on the correct side';
                        } else {
                            $raw = $bar['open'];
                            $fill = $wantsShort ? $raw * (1 - $h - $s) : $raw * (1 + $h + $s);
                            $stopDistance = abs($fill - $stop);
                            $riskAmount = $equity * $req['riskPct'];
                            $units = $riskAmount / $stopDistance;
                            $entryFee = $units * $fill * $feeRate;
                            $equity -= $entryFee;
                            $position = [
                                'direction' => $direction, 'entryBar' => $i,
                                'entryTime' => self::iso($bar['timestamp']),
                                'entryPrice' => $fill, 'stopLoss' => $stop,
                                'takeProfit' => (isset($sig['takeProfit']) && is_finite($sig['takeProfit']))
                                    ? $sig['takeProfit']
                                    : ($direction === 'LONG' ? $fill + 3 * $stopDistance : $fill - 3 * $stopDistance),
                                'units' => $units, 'riskAmount' => $riskAmount,
                                'entryFee' => $entryFee, 'entrySpread' => $raw * $h * $units, 'entrySlip' => $raw * $s * $units,
                                'signalReason' => $sig['reason'], 'confidence' => $sig['confidence'],
                            ];
                            $stopHitNow = $direction === 'LONG' ? $bar['low'] <= $stop : $bar['high'] >= $stop;
                            $tp = $position['takeProfit'];
                            $targetHitNow = $direction === 'LONG' ? $bar['high'] >= $tp : $bar['low'] <= $tp;
                            if ($stopHitNow) $closePosition($position, $stop, self::iso($bar['timestamp']), 'STOP_LOSS', $i);
                            elseif ($targetHitNow) $closePosition($position, $tp, self::iso($bar['timestamp']), 'TAKE_PROFIT', $i);
                        }
                    }
                } else {
                    $pending = null;
                }
            }

            // 3) evaluate on the closed bar
            $view = new SeriesView($candles, $ind, $i, $meta);
            $unrealized = $position !== null
                ? ($position['direction'] === 'LONG'
                    ? ($bar['close'] - $position['entryPrice']) * $position['units']
                    : ($position['entryPrice'] - $bar['close']) * $position['units'])
                : 0.0;
            $ctx = [
                'view' => $view,
                'position' => $position !== null ? [
                    'direction' => $position['direction'], 'entryPrice' => $position['entryPrice'],
                    'entryBar' => $position['entryBar'], 'stopLoss' => $position['stopLoss'],
                    'takeProfit' => $position['takeProfit'], 'unrealizedPnl' => $unrealized,
                ] : null,
                'equity' => $equity + $unrealized,
            ];
            try {
                $signal = $strategy->evaluate($ctx);
            } catch (LookAheadError $e) {
                throw $e; // fatal — never continue a biased run
            } catch (\Throwable $e) {
                $warnings[] = 'Strategy threw at bar ' . self::iso($bar['timestamp']) . ': ' . $e->getMessage();
                $signal = ['action' => 'HOLD', 'reason' => 'strategy error', 'confidence' => 0];
            }

            if ($signal['action'] === 'CLOSE' && $position !== null) {
                $pending = ['kind' => 'EXIT', 'signal' => $signal, 'exitReason' => 'SIGNAL'];
            } elseif (in_array($signal['action'], ['BUY', 'SELL'], true) && $position === null && $pending === null) {
                if ($signal['action'] === 'SELL' && !$req['allowShorts']) $ignoredSignals++;
                else $pending = ['kind' => 'ENTRY', 'signal' => $signal];
            }

            // 4) mark-to-market
            $marked = $equity + $unrealized;
            $peak = max($peak, $marked);
            $equityCurve[] = [
                'time' => self::iso($bar['timestamp']),
                'equity' => round($marked, 2),
                'drawdownPct' => $peak > 0 ? round(($peak - $marked) / $peak * 100, 4) : 0,
            ];
        }

        if ($position !== null) {
            $lastBar = $candles[$n - 1];
            $pos = $position;
            $closePosition($pos, $lastBar['close'], self::iso($lastBar['timestamp']), 'END_OF_DATA', $n - 1);
            if (count($equityCurve)) {
                $last = &$equityCurve[count($equityCurve) - 1];
                $last['equity'] = round($equity, 2);
                $last['drawdownPct'] = $peak > 0 ? round(($peak - $equity) / $peak * 100, 4) : 0;
                unset($last);
            }
        }
        if ($ignoredSignals > 0) $warnings[] = "{$ignoredSignals} short signals ignored (allowShorts=false)";

        return ['trades' => $trades, 'equityCurve' => $equityCurve, 'barsInMarket' => $barsInMarket, 'warnings' => $warnings, 'ignoredSignals' => $ignoredSignals];
    }

    public static function run(
        TradingStrategy $strategy,
        array $input,
        ProviderManager $pm,
        BacktestRepository $backtests,
        JournalRepository $journal,
        AuditRepository $audit,
    ): array {
        $req = array_merge(self::DEFAULTS, [
            'strategyId' => $input['strategyId'], 'strategyVersion' => $input['strategyVersion'],
            'symbol' => strtoupper($input['symbol']), 'marketClass' => $input['marketClass'],
            'timeframe' => $input['timeframe'],
        ], array_intersect_key($input, self::DEFAULTS));
        $req['limit'] = min(max(60, (int)$req['limit']), 5000);
        if ($req['initialEquity'] <= 0) throw new \InvalidArgumentException('initialEquity must be positive');
        if ($req['riskPct'] <= 0 || $req['riskPct'] > 0.05) throw new \InvalidArgumentException('riskPct must be in (0, 5%]');

        $audit->emit('BACKTEST_STARTED', "Backtest {$req['strategyId']}@{$req['strategyVersion']} on {$req['symbol']} {$req['timeframe']}", [
            'strategyId' => $req['strategyId'], 'symbol' => $req['symbol'], 'timeframe' => $req['timeframe'],
        ]);

        $series = $pm->getCandleSeries($req['symbol'], $req['marketClass'], $req['timeframe'], $req['limit']);
        $candles = $series['candles'];
        if (!empty($input['from'])) {
            $fromMs = strtotime($input['from'] . 'Z') * 1000;
            if ($fromMs) $candles = array_values(array_filter($candles, fn($c) => $c['timestamp'] >= $fromMs));
        }
        if (!empty($input['to'])) {
            $toMs = strtotime($input['to'] . 'Z') * 1000 + 86400000;
            if ($toMs) $candles = array_values(array_filter($candles, fn($c) => $c['timestamp'] < $toMs));
        }
        if (count($candles) < 120) {
            throw new \InvalidArgumentException('Only ' . count($candles) . " candles in range — need at least 120 for a meaningful backtest");
        }

        $result = self::simulate($strategy, $candles, $req, [
            'symbol' => $req['symbol'], 'timeframe' => $req['timeframe'], 'marketClass' => $req['marketClass'],
        ]);
        $metrics = Metrics::compute($result['trades'], $result['equityCurve'], $req['initialEquity'], $req['timeframe'], $result['barsInMarket']);

        $record = [
            'id' => self::uuid(), 'created_at' => gmdate('c'),
            'request' => [
                'strategyId' => $req['strategyId'], 'strategyVersion' => $req['strategyVersion'],
                'symbol' => $req['symbol'], 'marketClass' => $req['marketClass'], 'timeframe' => $req['timeframe'],
                'from' => $input['from'] ?? null, 'to' => $input['to'] ?? null,
                'initialEquity' => $req['initialEquity'], 'riskPct' => $req['riskPct'],
                'feeBps' => $req['feeBps'], 'spreadBps' => $req['spreadBps'], 'slippageBps' => $req['slippageBps'],
                'allowShorts' => $req['allowShorts'],
            ],
            'dataProvenance' => [
                'source' => $series['provenance']['source'], 'synthetic' => $series['provenance']['synthetic'],
                'candles' => count($candles),
                'from' => count($candles) ? self::iso($candles[0]['timestamp']) : '',
                'to' => count($candles) ? self::iso(end($candles)['timestamp']) : '',
            ],
            'metrics' => $metrics,
            'equityCurve' => $result['equityCurve'],
            'trades' => $result['trades'],
            'warnings' => array_merge($result['warnings'], $series['provenance']['synthetic']
                ? ['Candles are SYNTHETIC — results are a simulation of the strategy logic, not market performance'] : []),
        ];
        $backtests->save($record);

        foreach ($record['trades'] as $t) {
            $journal->save([
                'id' => self::uuid(), 'source' => 'backtest', 'symbol' => $req['symbol'], 'market' => $req['marketClass'],
                'strategy' => $req['strategyId'], 'strategy_version' => $req['strategyVersion'],
                'direction' => $t['direction'],
                'entry_time' => $t['entryTime'], 'entry_price' => $t['entryPrice'],
                'exit_time' => $t['exitTime'], 'exit_price' => $t['exitPrice'],
                'position_size' => $t['units'], 'stop_loss' => $t['stopLoss'], 'take_profit' => $t['takeProfit'],
                'fees' => $t['fees']['totalCost'], 'slippage' => $t['fees']['slippageCost'],
                'pnl' => $t['netPnl'],
                'pnl_pct' => $t['units'] * $t['entryPrice'] > 0 ? ($t['netPnl'] / ($t['units'] * $t['entryPrice'])) * 100 : null,
                'r_multiple' => $t['rMultiple'], 'reason' => $t['signalReason'],
                'ai_confidence' => $t['confidence'], 'confidence_source' => 'strategy',
                'agent_consensus' => null, 'risk_score' => $req['riskPct'],
                'execution_time' => $t['entryTime'], 'backtest_id' => $record['id'],
            ]);
        }

        $audit->emit('BACKTEST_COMPLETED', sprintf('Backtest %s@%s on %s: %d trades, return %s%%', $req['strategyId'], $req['strategyVersion'], $req['symbol'], $metrics['trades'], number_format($metrics['totalReturnPct'], 2)), [
            'backtestId' => $record['id'], 'strategyId' => $req['strategyId'], 'symbol' => $req['symbol'],
            'trades' => $metrics['trades'], 'synthetic' => $record['dataProvenance']['synthetic'],
        ]);

        return $record;
    }

    public static function iso(int $ms): string
    {
        return gmdate('Y-m-d\TH:i:s\Z', (int)floor($ms / 1000)) . '.' . sprintf('%03d', $ms % 1000) . 'Z';
    }

    public static function uuid(): string
    {
        $d = random_bytes(16);
        $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
        $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}
