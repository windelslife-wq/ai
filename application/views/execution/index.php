<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head">
  <div>
    <h2>Execution</h2>
    <p>Every broker-bound intent runs the 15-step supervisor. Only a connector with verified order submission can route an order.</p>
  </div>
</div>
<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>

<?php if (!empty($routable) && !empty($simBridge)): ?>
  <div class="notice warnbox"><b>SIMULATED BRIDGE ACTIVE</b> — routing will reach the in-process demo mock and fills are <b>SIMULATION</b>. No real broker, no real order.</div>
<?php endif; ?>
<?php if (!empty($status['killSwitch']['active'])): ?>
  <div class="notice err"><b>Kill switch ACTIVE</b> — every proposal is rejected at step 1 and no order can be routed.</div>
<?php endif; ?>
<?php if (!in_array($status['tradingMode'], ['HUMAN_APPROVAL', 'SEMI_AUTONOMOUS', 'FULLY_AUTOMATED'], true)): ?>
  <div class="notice warnbox"><b>Trading mode is <?= e($status['tradingMode']) ?></b> — broker execution requires HUMAN_APPROVAL, SEMI_AUTONOMOUS or FULLY_AUTOMATED (switch modes on the Dashboard).</div>
<?php endif; ?>

<div class="grid cols-main">
  <div class="panel">
    <h3>Propose a trade (steps 1–11, persisted)</h3>
    <div class="body" style="padding-top:12px">
      <form method="post" action="/execution/propose" class="mono" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">
        <input name="symbol" value="EURUSD" placeholder="SYMBOL" required>
        <select name="marketClass"><?php foreach (['forex', 'crypto', 'stock', 'etf', 'commodity', 'future', 'index', 'bond'] as $c): ?><option><?= $c ?></option><?php endforeach; ?></select>
        <select name="side"><option>BUY</option><option>SELL</option></select>
        <select name="type"><option>MARKET</option><option>LIMIT</option></select>
        <input name="volume" value="1000" placeholder="volume (units/lots)" required>
        <input name="price" placeholder="price (LIMIT only)">
        <input name="stopLoss" value="<?= e(number_format($quoteDefaults['sl'] ?? 1.0750, 5, '.', '')) ?>" placeholder="stop loss (mandatory)" required>
        <input name="takeProfit" value="<?= e(number_format($quoteDefaults['tp'] ?? 1.0900, 5, '.', '')) ?>" placeholder="take profit">
        <input name="strategyId" placeholder="strategy id (optional)" list="approved-strategies" style="grid-column:span 2">
        <datalist id="approved-strategies"><?php foreach ($strategies as $s): ?><option value="<?= e($s['strategy_id']) ?>"><?= e($s['lifecycle']) ?></option><?php endforeach; ?></datalist>
        <input name="reason" placeholder="reason" style="grid-column:span 2">
        <button class="btn primary" type="submit" style="grid-column:span 4">Run pipeline &amp; create proposal</button>
      </form>
      <p class="dim" style="margin-top:8px">Strategies must be APPROVED before they can execute; discretionary intents are HUMAN_APPROVAL only.<?= $quoteDefaults ? ' Form defaults derive from the live EURUSD quote (mid ' . e(number_format($quoteDefaults['mid'], 5)) . ').' : '' ?></p>
    </div>
  </div>

  <div class="panel">
    <h3>Automation envelope (SEMI_AUTONOMOUS / FULLY_AUTOMATED)</h3>
    <div class="body" style="padding-top:12px">
      <form method="post" action="/execution/limits" class="mono" style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px">
        <label class="dim">Max trade notional (USD)</label>
        <input name="maxTradeNotionalUsd" value="<?= e($limits['maxTradeNotionalUsd']) ?>" required>
        <label class="dim">Max daily automated trades</label>
        <input name="maxDailyTrades" value="<?= e($limits['maxDailyTrades']) ?>" required>
        <label class="dim">Max risk per trade (%)</label>
        <input name="maxRiskPerTradePct" value="<?= e($limits['maxRiskPerTradePct'] * 100) ?>" required>
        <label class="dim">Approved symbols (comma-separated)</label>
        <input name="approvedSymbols" value="<?= e(implode(', ', $limits['approvedSymbols'])) ?>" placeholder="EURUSD, BTCUSDT" required>
        <button class="btn" type="submit" style="grid-column:span 2">Update automation limits</button>
      </form>
      <p class="dim" style="margin-top:8px">Automated trades today: <?= e($automatedToday) ?>/<?= e($limits['maxDailyTrades']) ?> ·
        limits updated: <?= e($limits['updatedAt'] ?? 'never') ?></p>
      <?php if (!$gateSemi['ok']): ?><div class="notice warnbox" style="margin-top:6px">SEMI_AUTONOMOUS blocked: <?= e(implode('; ', $gateSemi['reasons'])) ?></div><?php endif; ?>
      <?php if (!$gateFully['ok']): ?><div class="notice warnbox" style="margin-top:6px">FULLY_AUTOMATED blocked: <?= e(implode('; ', $gateFully['reasons'])) ?></div><?php endif; ?>
    </div>
  </div>
</div>

<?php if (in_array($status['tradingMode'], ['SEMI_AUTONOMOUS', 'FULLY_AUTOMATED'], true)): ?>
<div class="panel" style="margin-top:14px">
  <h3>Automated execution (<?= e($status['tradingMode']) ?>)</h3>
  <div class="body" style="padding-top:12px">
    <form method="post" action="/execution/execute" class="mono" style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px">
      <input name="symbol" value="EURUSD" required>
      <select name="marketClass"><?php foreach (['forex', 'crypto'] as $c): ?><option><?= $c ?></option><?php endforeach; ?></select>
      <select name="side"><option>BUY</option><option>SELL</option></select>
      <input name="volume" value="1000" required>
      <input name="stopLoss" value="<?= e(number_format($quoteDefaults['sl'] ?? 1.0750, 5, '.', '')) ?>" required>
      <input name="takeProfit" value="<?= e(number_format($quoteDefaults['tp'] ?? 1.0900, 5, '.', '')) ?>">
      <input name="strategyId" placeholder="APPROVED strategy id (mandatory)" list="approved-strategies" style="grid-column:span 4">
      <button class="btn primary" type="submit" style="grid-column:span 2">Execute inside limits</button>
    </form>
  </div>
</div>
<?php endif; ?>

<div class="panel" style="margin-top:14px">
  <h3>Proposals (<?= count($proposals) ?>)</h3>
  <div class="body scroll" style="padding-top:12px">
    <?php if (empty($proposals)): ?>
      <p class="dim">No proposals yet.</p>
    <?php else: ?>
      <table class="tbl mono">
        <thead><tr><th>Created</th><th>Symbol</th><th>Intent</th><th>Broker</th><th>Status</th><th>Pipeline (15 steps)</th><th class="num">Actions</th></tr></thead>
        <tbody>
          <?php foreach ($proposals as $pr): ?>
            <tr>
              <td class="dim"><?= e(substr((string) $pr['created_at'], 5, 11)) ?></td>
              <td style="font-weight:700"><?= e($pr['symbol']) ?></td>
              <td><?= e($pr['side']) ?> <?= e($pr['order_type']) ?> <?= e(rtrim(rtrim(number_format((float) $pr['volume'], 4, '.', ''), '0'), '.')) ?><?= $pr['strategy_id'] ? ' <span class="dim">[' . e($pr['strategy_id']) . ']</span>' : '' ?></td>
              <td class="dim"><?= e($pr['broker']) ?></td>
              <td>
                <?php $tone = ['PENDING_APPROVAL' => 'b-amber', 'APPROVED' => 'b-sky', 'EXECUTED' => 'b-green', 'REJECTED' => 'b-red', 'FAILED' => 'b-red', 'READY_TO_ROUTE' => 'b-sky'][$pr['status']] ?? 'b-gray'; ?>
                <span class="badge <?= $tone ?>"><?= e($pr['status']) ?></span>
              </td>
              <td>
                <details>
                  <summary class="dim" style="cursor:pointer"><?= e(count($pr['checks'])) ?> checks</summary>
                  <ul style="margin:6px 0 0 14px;font-size:11px">
                    <?php foreach ($pr['checks'] as $c): ?>
                      <li class="<?= $c['ok'] ? 'up' : 'down' ?>"><?= e(($c['step'] ?? '·') . ' ' . $c['check'] . ' — ' . $c['detail']) ?></li>
                    <?php endforeach; ?>
                  </ul>
                </details>
              </td>
              <td class="num" style="white-space:nowrap">
                <?php if ($pr['status'] === 'PENDING_APPROVAL'): ?>
                  <form method="post" action="/execution/<?= e($pr['id']) ?>/decide" style="display:inline"><input type="hidden" name="approve" value="1"><button class="btn small primary">approve</button></form>
                  <form method="post" action="/execution/<?= e($pr['id']) ?>/decide" style="display:inline"><input type="hidden" name="approve" value="0"><button class="btn small danger">reject</button></form>
                <?php elseif ($pr['status'] === 'APPROVED' || $pr['status'] === 'READY_TO_ROUTE'): ?>
                  <form method="post" action="/execution/<?= e($pr['id']) ?>/route" style="display:inline"><button class="btn small">route order</button></form>
                <?php endif; ?>
              </td>
            </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    <?php endif; ?>
  </div>
</div>

<div class="panel" style="margin-top:14px">
  <h3>Broker executions (<?= count($executions) ?>)</h3>
  <div class="body scroll" style="padding-top:12px">
    <?php if (empty($executions)): ?>
      <p class="dim">No orders routed yet. Without a configured, order-capable bridge every routing attempt is audited as ROUTING_BLOCKED and no order exists.</p>
    <?php else: ?>
      <table class="tbl mono">
        <thead><tr><th>Submitted</th><th>Proposal</th><th>Broker</th><th>Ticket</th><th>Automated</th><th>Status</th><th>Result</th></tr></thead>
        <tbody>
          <?php foreach ($executions as $ex): ?>
            <tr>
              <td class="dim"><?= e(substr((string) $ex['submitted_at'], 5, 11)) ?></td>
              <td class="dim"><?= e(substr((string) $ex['proposal_id'], 0, 12)) ?>…</td>
              <td><?= e($ex['broker']) ?></td>
              <td><?= e($ex['broker_order_id'] ?? '—') ?></td>
              <td><?= $ex['automated'] ? 'yes' : 'no' ?></td>
              <td><span class="badge <?= $ex['status'] === 'EXECUTED' ? 'b-green' : 'b-red' ?>"><?= e($ex['status']) ?></span></td>
              <td class="dim"><details><summary style="cursor:pointer">result</summary><pre style="font-size:10px;white-space:pre-wrap"><?= e(json_encode($ex['result'], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) ?></pre></details></td>
            </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    <?php endif; ?>
  </div>
</div>
