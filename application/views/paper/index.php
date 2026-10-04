<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head">
  <div>
    <h2>Paper Trading</h2>
    <p>Simulated accounts and fills. Every order still passes the kill switch, trading mode and Risk Engine. No order leaves this process.</p>
  </div>
</div>
<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>
<?php if (!empty(Aegis_PlatformStateHelper::current()['allowSyntheticPaperData'])): ?>
  <div class="notice warnbox"><b>SIMULATION PRICES</b> — synthetic-paper mode is ON for this offline demo: fills use clearly-labeled synthetic quotes (no market egress here). Production keeps this OFF; the Risk Engine then vetoes any synthetic-data trade.</div>
<?php endif; ?>

<?php if ($status['tradingMode'] !== 'PAPER_TRADING'): ?>
  <div class="notice warnbox"><b>Trading mode is <?= e($status['tradingMode']) ?></b> — paper orders are blocked until you switch to PAPER_TRADING on the Dashboard. The kill switch must also be released.</div>
<?php endif; ?>
<?php if (!empty($status['killSwitch']['active'])): ?>
  <div class="notice err"><b>Kill switch ACTIVE</b> — all order placement (paper included) is vetoed.</div>
<?php endif; ?>

<div class="grid cols-main">
  <div class="panel">
    <h3>Accounts</h3>
    <div class="body scroll" style="padding-top:12px">
      <?php if (empty($accounts)): ?>
        <p class="dim">No paper accounts yet — create one on the right to begin.</p>
      <?php else: ?>
        <table class="tbl mono">
          <thead><tr><th>#</th><th>Name</th><th class="num">Balance</th><th class="num">Equity</th><th class="num">Unrealized</th><th class="num">Daily P&L</th><th class="num">Open</th><th></th></tr></thead>
          <tbody>
            <?php foreach ($accounts as $s): ?>
              <tr>
                <td class="dim"><?= e($s['account']['id']) ?></td>
                <td style="font-weight:700"><?= e($s['account']['name']) ?></td>
                <td class="num"><?= e(number_format($s['balance'], 2)) ?></td>
                <td class="num" style="font-weight:700"><?= e(number_format($s['equity'], 2)) ?></td>
                <td class="num <?= $s['unrealizedPnl'] >= 0 ? 'up' : 'down' ?>"><?= e(number_format($s['unrealizedPnl'], 2)) ?></td>
                <td class="num <?= $s['dailyPnl'] >= 0 ? 'up' : 'down' ?>"><?= e(number_format($s['dailyPnl'], 2)) ?></td>
                <td class="num"><?= e($s['openPositions']) ?></td>
                <td class="num"><a class="btn small" href="/paper/<?= e($s['account']['id']) ?>">open console</a></td>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      <?php endif; ?>
    </div>
  </div>

  <div class="panel">
    <h3>Create a paper account</h3>
    <div class="body" style="padding-top:12px">
      <form method="post" action="/paper/create" class="inline">
        <label class="fld">Name <input class="sel" name="name" placeholder="Swing simulator" required></label>
        <label class="fld">Starting balance (USD) <input class="sel" type="number" step="0.01" min="100" max="10000000" name="startingBalance" value="10000" required></label>
        <button class="btn primary">Create account</button>
      </form>
      <p class="dim" style="font-size:10px;margin-top:10px">Risk limits apply per order: 1% risk default, mandatory stops, exposure/drawdown gates — the same Risk Engine that governs every other layer.</p>
    </div>
  </div>
</div>
