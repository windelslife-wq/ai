<?php defined('BASEPATH') or exit('No direct script access allowed');
/** @var array $summary @var int $accountId @var array $orders @var array $deployments @var array $closed @var array $strategies */
$acc = $summary['account'];
?>
<div class="page-head">
  <div>
    <h2><?= e($acc['name']) ?></h2>
    <p>Paper account #<?= e($acc['id']) ?>. Simulated fills with full governance: <?= e(\Aegis\Paper\PaperTradingEngine::DEFAULT_SPREAD_BPS) ?>bps spread + <?= e(\Aegis\Paper\PaperTradingEngine::DEFAULT_SLIPPAGE_BPS) ?>bps slippage + <?= e(\Aegis\Paper\PaperTradingEngine::DEFAULT_FEE_BPS) ?>bps commission per side.</p>
  </div>
  <div>
    <a class="btn" href="/paper">← accounts</a>
    <form method="post" action="/paper/<?= e($accountId) ?>/tick" style="display:inline">
      <button class="btn primary">▶ Run market tick</button>
    </form>
  </div>
</div>
<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>

<div class="stat-grid" style="margin-bottom:12px">
  <div class="stat"><div class="k">Balance</div><div class="v">$<?= e(number_format($summary['balance'], 2)) ?></div></div>
  <div class="stat"><div class="k">Equity</div><div class="v">$<?= e(number_format($summary['equity'], 2)) ?></div></div>
  <div class="stat"><div class="k">Unrealized P&L</div><div class="v <?= $summary['unrealizedPnl'] >= 0 ? 'up' : 'down' ?>"><?= e(number_format($summary['unrealizedPnl'], 2)) ?></div></div>
  <div class="stat"><div class="k">Daily P&L</div><div class="v <?= $summary['dailyPnl'] >= 0 ? 'up' : 'down' ?>"><?= e(number_format($summary['dailyPnl'], 2)) ?></div></div>
  <div class="stat"><div class="k">Weekly P&L</div><div class="v <?= $summary['weeklyPnl'] >= 0 ? 'up' : 'down' ?>"><?= e(number_format($summary['weeklyPnl'], 2)) ?></div></div>
  <div class="stat"><div class="k">Open positions</div><div class="v"><?= e($summary['openPositions']) ?></div></div>
  <div class="stat"><div class="k">Open risk (Σ)</div><div class="v warn">$<?= e(number_format(array_sum($summary['openRiskBySymbol']), 2)) ?></div></div>
  <div class="stat"><div class="k">Daily loss</div><div class="v <?= $summary['dailyLossPct'] > 0 ? 'down' : 'dim' ?>"><?= e(number_format($summary['dailyLossPct'], 2)) ?>%</div></div>
</div>

<div class="grid cols-main">
  <div class="grid">
    <div class="panel">
      <h3>Open positions</h3>
      <div class="body scroll" style="padding-top:12px">
        <?php if (empty($summary['positions'])): ?>
          <p class="dim">No open positions.</p>
        <?php else: ?>
          <table class="tbl mono">
            <thead><tr><th>#</th><th>Sym</th><th>Dir</th><th class="num">Units</th><th class="num">Entry</th><th class="num">Price</th><th class="num">SL</th><th class="num">TP</th><th class="num">P&L</th><th class="num">R</th><th></th></tr></thead>
            <tbody>
              <?php foreach ($summary['positions'] as $p): ?>
                <tr>
                  <td class="dim"><?= e($p['id']) ?></td>
                  <td style="font-weight:700"><?= e($p['symbol']) ?></td>
                  <td class="<?= $p['direction'] === 'LONG' ? 'up' : 'down' ?>"><?= $p['direction'] === 'LONG' ? '▲' : '▼' ?></td>
                  <td class="num"><?= e(number_format($p['units'], 4)) ?></td>
                  <td class="num"><?= e(number_format($p['entry_price'], 5)) ?></td>
                  <td class="num"><?= e(number_format($p['current_price'], 5)) ?></td>
                  <td class="num down"><?= e(number_format($p['stop_loss'], 5)) ?></td>
                  <td class="num up"><?= e(number_format($p['take_profit'], 5)) ?></td>
                  <td class="num <?= $p['unrealized_pnl'] >= 0 ? 'up' : 'down' ?>"><?= e(number_format($p['unrealized_pnl'], 2)) ?></td>
                  <td class="num dim"><?= $p['unrealized_r'] !== null ? e(number_format($p['unrealized_r'], 2)) : '—' ?></td>
                  <td class="num"><form method="post" action="/paper/<?= e($accountId) ?>/positions/<?= e($p['id']) ?>/close"><button class="btn small danger">close</button></form></td>
                </tr>
              <?php endforeach; ?>
            </tbody>
          </table>
        <?php endif; ?>
      </div>
    </div>

    <div class="panel">
      <h3>Orders (incl. rejected — auditability)</h3>
      <div class="body scroll" style="max-height:320px;overflow-y:auto;padding-top:12px">
        <?php if (empty($orders)): ?><p class="dim">No orders yet.</p><?php else: ?>
          <table class="tbl mono">
            <thead><tr><th>#</th><th>Time</th><th>Sym</th><th>Side</th><th class="num">Units</th><th class="num">Price/Fill</th><th>Status</th><th>Reason</th></tr></thead>
            <tbody>
              <?php foreach (array_slice($orders, 0, 25) as $o): ?>
                <tr>
                  <td class="dim"><?= e($o['id']) ?></td>
                  <td class="dim"><?= e(substr($o['created_at'], 5, 11)) ?></td>
                  <td><?= e($o['symbol']) ?></td>
                  <td class="<?= $o['side'] === 'BUY' ? 'up' : 'down' ?>"><?= e($o['side']) ?></td>
                  <td class="num"><?= e(number_format($o['units'], 4)) ?></td>
                  <td class="num"><?= e(number_format($o['fill_price'] ?? $o['price'] ?? 0, 5)) ?></td>
                  <td><span class="badge <?= ['FILLED' => 'b-green', 'PENDING' => 'b-amber', 'REJECTED' => 'b-red', 'CANCELLED' => 'b-gray'][$o['status']] ?? 'b-gray' ?>" style="padding:0 6px"><?= e($o['status']) ?></span></td>
                  <td class="dim" style="font-size:10px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><?= e($o['reject_reason'] ?: ($o['reason'] ?: '—')) ?></td>
                </tr>
              <?php endforeach; ?>
            </tbody>
          </table>
        <?php endif; ?>
      </div>
    </div>

    <div class="panel">
      <h3>Closed positions (journaled automatically)</h3>
      <div class="body scroll" style="max-height:280px;overflow-y:auto;padding-top:12px">
        <?php if (empty($closed)): ?><p class="dim">No closed positions yet.</p><?php else: ?>
          <table class="tbl mono">
            <thead><tr><th>#</th><th>Sym</th><th>Dir</th><th class="num">Entry</th><th class="num">Exit</th><th class="num">P&L</th><th>Exit reason</th></tr></thead>
            <tbody>
              <?php foreach ($closed as $c): ?>
                <tr>
                  <td class="dim"><?= e($c['id']) ?></td>
                  <td><?= e($c['symbol']) ?></td>
                  <td class="<?= $c['direction'] === 'LONG' ? 'up' : 'down' ?>"><?= $c['direction'] === 'LONG' ? '▲' : '▼' ?></td>
                  <td class="num"><?= e(number_format($c['entry_price'], 5)) ?></td>
                  <td class="num"><?= e(number_format((float)$c['exit_price'], 5)) ?></td>
                  <td class="num <?= (float)$c['realized_pnl'] >= 0 ? 'up' : 'down' ?>"><?= e(number_format((float)$c['realized_pnl'], 2)) ?></td>
                  <td class="dim"><?= e($c['exit_reason']) ?></td>
                </tr>
              <?php endforeach; ?>
            </tbody>
          </table>
        <?php endif; ?>
      </div>
    </div>
  </div>

  <div class="grid">
    <div class="panel">
      <h3>Place a paper order</h3>
      <div class="body" style="padding-top:12px">
        <form method="post" action="/paper/<?= e($accountId) ?>/order">
          <div class="inline" style="margin-bottom:8px">
            <label class="fld">Symbol <input class="sel" name="symbol" placeholder="BTCUSDT" value="BTCUSDT" required></label>
            <label class="fld">Side <select class="sel" name="side"><option>BUY</option><option>SELL</option></select></label>
            <label class="fld">Type <select class="sel" name="type"><option>MARKET</option><option>LIMIT</option></select></label>
            <label class="fld">Limit price <input class="sel" type="number" step="any" name="price" placeholder="optional"></label>
          </div>
          <div class="inline" style="margin-bottom:8px">
            <label class="fld">Stop loss * <input class="sel" type="number" step="any" name="stopLoss" required></label>
            <label class="fld">Take profit <input class="sel" type="number" step="any" name="takeProfit" placeholder="3R default"></label>
            <label class="fld">Risk % <input class="sel" type="number" step="0.01" min="0.1" max="2" name="riskPct" placeholder="1.0"></label>
          </div>
          <div class="inline" style="margin-bottom:8px">
            <label class="fld" style="flex:1">Reason (journaled) <input class="sel" name="reason" style="width:100%" placeholder="e.g. demand zone reclaim"></label>
            <label class="fld">Confidence 0–1 <input class="sel" type="number" step="0.01" min="0" max="1" name="confidence" placeholder="0.7"></label>
          </div>
          <button class="btn primary" style="width:100%">Submit paper order (risk-checked)</button>
        </form>
        <p class="dim" style="font-size:10px;margin-top:8px">* Stops are mandatory. Sizing = risk% × equity ÷ stop distance (capped by notional limits). Limit orders fill on the next tick; SL/TP evaluate on candle extremes with the stop-first rule.</p>
      </div>
    </div>

    <div class="panel">
      <h3>Deploy a strategy (auto-trading, simulated)</h3>
      <div class="body" style="padding-top:12px">
        <form method="post" action="/paper/<?= e($accountId) ?>/deploy">
          <div class="inline" style="margin-bottom:8px">
            <label class="fld">Strategy <select class="sel" name="strategyId">
              <?php foreach ($strategies as $s): ?><option value="<?= e($s['strategy_id']) ?>" data-v="<?= e($s['version']) ?>"><?= e($s['strategy_id']) ?> (<?= e($s['lifecycle']) ?>)</option><?php endforeach; ?>
            </select></label>
            <input type="hidden" name="version" value="<?= e($strategies[0]['version'] ?? '') ?>">
            <label class="fld">Symbol <input class="sel" name="symbol" value="BTCUSDT"></label>
            <label class="fld">TF <select class="sel" name="timeframe"><option>1h</option><option>15m</option><option>4h</option><option>1d</option></select></label>
            <input type="hidden" name="marketClass" value="crypto">
          </div>
          <button class="btn" style="width:100%">Deploy to paper account</button>
        </form>
        <p class="dim" style="font-size:10px;margin-top:8px">Gate: strategy must be RISK_REVIEWED or beyond (AI-source strategies blocked without human sign-off). Deploying advances the lifecycle to PAPER_TRADING. Signals fire on ticks.</p>
        <?php if (!empty($deployments)): ?>
          <table class="tbl" style="margin-top:10px">
            <thead><tr><th>Strategy</th><th>Sym</th><th>Last signal</th><th>Status</th><th></th></tr></thead>
            <tbody>
              <?php foreach ($deployments as $d): ?>
                <tr>
                  <td class="mono"><?= e($d['strategy_id']) ?></td>
                  <td class="mono"><?= e($d['symbol']) ?></td>
                  <td class="dim mono"><?= e($d['last_signal'] ?? '—') ?></td>
                  <td><span class="badge <?= $d['active'] ? 'b-green' : 'b-gray' ?>" style="padding:0 6px"><?= $d['active'] ? 'active' : 'paused' ?></span></td>
                  <td>
                    <form method="post" action="/paper/<?= e($accountId) ?>/deployments/<?= e($d['id']) ?>/toggle">
                      <input type="hidden" name="active" value="<?= $d['active'] ? '0' : '1' ?>">
                      <button class="btn small"><?= $d['active'] ? 'pause' : 'resume' ?></button>
                    </form>
                  </td>
                </tr>
              <?php endforeach; ?>
            </tbody>
          </table>
        <?php endif; ?>
      </div>
    </div>
  </div>
</div>
