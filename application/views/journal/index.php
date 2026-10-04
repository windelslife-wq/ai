<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head">
  <div>
    <h2>Analytics</h2>
    <p>Every backtest and paper trade is journaled with fees, reason and confidence so you can see whether high-confidence decisions actually perform better.</p>
  </div>
  <div class="inline">
    <?php foreach (['strategy' => 'By strategy', 'symbol' => 'By symbol', 'market' => 'By market', 'source' => 'By source', 'confidence' => 'By confidence'] as $k => $label): ?>
      <a class="btn small <?= $groupBy === $k ? 'primary' : '' ?>" href="/journal?groupBy=<?= $k ?>"><?= $label ?></a>
    <?php endforeach; ?>
  </div>
</div>

<div class="grid cols-main">
  <div class="grid">
    <div class="panel">
      <h3>Overall (<?= e($summary['overall']['closedTrades']) ?> closed trades)</h3>
      <div class="body" style="padding-top:12px">
        <div class="stat-grid">
          <div class="stat"><div class="k">Win rate</div><div class="v"><?= $summary['overall']['winRate'] !== null ? e(number_format($summary['overall']['winRate'] * 100, 1)) . '%' : '—' ?></div></div>
          <div class="stat"><div class="k">Profit factor</div><div class="v"><?= $summary['overall']['profitFactor'] !== null ? e(number_format($summary['overall']['profitFactor'], 2)) : '—' ?></div></div>
          <div class="stat"><div class="k">Total P&L</div><div class="v <?= $summary['overall']['totalPnl'] >= 0 ? 'up' : 'down' ?>"><?= e(number_format($summary['overall']['totalPnl'], 0)) ?></div></div>
          <div class="stat"><div class="k">Avg R</div><div class="v"><?= $summary['overall']['avgRMultiple'] !== null ? e(number_format($summary['overall']['avgRMultiple'], 2)) : '—' ?></div></div>
          <div class="stat"><div class="k">Expectancy</div><div class="v"><?= $summary['overall']['expectancyPnl'] !== null ? e(number_format($summary['overall']['expectancyPnl'], 1)) : '—' ?></div></div>
          <div class="stat"><div class="k">Max DD ($)</div><div class="v warn"><?= e(number_format($summary['overall']['maxDrawdownAbs'], 0)) ?></div></div>
        </div>
        <?php if (!empty($summary['groups'])): ?>
          <table class="tbl mono" style="margin-top:12px">
            <thead><tr><th><?= e($groupBy) ?></th><th class="num">Trades</th><th class="num">Win%</th><th class="num">PF</th><th class="num">E[P&L]</th><th class="num">Total P&L</th></tr></thead>
            <tbody>
              <?php foreach ($summary['groups'] as $g): $m = $g['metrics']; ?>
                <tr>
                  <td style="font-weight:700"><?= e($g['key']) ?></td>
                  <td class="num dim"><?= e($m['count']) ?></td>
                  <td class="num"><?= $m['winRate'] !== null ? e(number_format($m['winRate'] * 100, 0)) . '%' : '—' ?></td>
                  <td class="num"><?= $m['profitFactor'] !== null ? e(number_format($m['profitFactor'], 2)) : '—' ?></td>
                  <td class="num <?= ($m['expectancyPnl'] ?? 0) >= 0 ? 'up' : 'down' ?>"><?= $m['expectancyPnl'] !== null ? e(number_format($m['expectancyPnl'], 1)) : '—' ?></td>
                  <td class="num <?= $m['totalPnl'] >= 0 ? 'up' : 'down' ?>"><?= e(number_format($m['totalPnl'], 0)) ?></td>
                </tr>
              <?php endforeach; ?>
            </tbody>
          </table>
        <?php endif; ?>
        <?php if (!empty($summary['note'])): ?><p class="warn" style="font-size:11px"><?= e($summary['note']) ?></p><?php endif; ?>
      </div>
    </div>

    <div class="panel">
      <h3>Journal entries (latest 200)</h3>
      <div class="body scroll" style="max-height:520px;overflow-y:auto;padding-top:12px">
        <?php if (empty($entries)): ?><p class="dim">No entries yet — run a backtest or paper trade.</p><?php else: ?>
          <table class="tbl mono">
            <thead><tr><th>Time</th><th>Src</th><th>Sym</th><th>Dir</th><th>Strategy</th><th class="num">Entry</th><th class="num">Exit</th><th class="num">P&L</th><th class="num">R</th><th class="num">Conf</th><th>Reason</th></tr></thead>
            <tbody>
              <?php foreach ($entries as $en): ?>
                <tr>
                  <td class="dim"><?= e(substr($en['entry_time'], 0, 16)) ?></td>
                  <td><span class="badge <?= ['backtest' => 'b-sky', 'paper' => 'b-violet', 'manual' => 'b-gray', 'live' => 'b-red'][$en['source']] ?? 'b-gray' ?>" style="padding:0 5px"><?= e($en['source']) ?></span></td>
                  <td style="font-weight:700"><?= e($en['symbol']) ?></td>
                  <td class="<?= $en['direction'] === 'LONG' ? 'up' : 'down' ?>"><?= $en['direction'] === 'LONG' ? '▲' : '▼' ?></td>
                  <td class="dim"><?= e($en['strategy'] ?? '—') ?></td>
                  <td class="num"><?= e(number_format($en['entry_price'], 5)) ?></td>
                  <td class="num"><?= $en['exit_price'] !== null ? e(number_format($en['exit_price'], 5)) : 'open' ?></td>
                  <td class="num <?= ($en['pnl'] ?? 0) >= 0 ? 'up' : 'down' ?>"><?= $en['pnl'] !== null ? e(number_format($en['pnl'], 1)) : '—' ?></td>
                  <td class="num dim"><?= $en['r_multiple'] !== null ? e(number_format($en['r_multiple'], 2)) : '—' ?></td>
                  <td class="num dim"><?= $en['ai_confidence'] !== null ? e(number_format($en['ai_confidence'] * 100, 0)) . '%' : '—' ?></td>
                  <td class="dim" style="font-size:10px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="<?= e($en['reason'] ?? '') ?>"><?= e($en['reason'] ?? '') ?></td>
                </tr>
              <?php endforeach; ?>
            </tbody>
          </table>
        <?php endif; ?>
      </div>
    </div>
  </div>

  <div class="panel" style="align-self:start">
    <h3>Confidence calibration</h3>
    <div class="body" style="padding-top:12px">
      <div class="notice <?= $calibration['sufficientData'] ? 'ok' : 'warnbox' ?>"><?= e($calibration['verdict']) ?></div>
      <?php if (!empty($calibration['buckets'])): ?>
        <?php foreach ($calibration['buckets'] as $b): ?>
          <div class="meter">
            <div class="row">
              <span><?= e($b['key']) ?></span>
              <span class="mono dim"><?= e($b['count']) ?> trades · win <?= $b['winRate'] !== null ? e(number_format($b['winRate'] * 100, 0)) . '%' : '—' ?> · E[R] <?= $b['expectancyR'] !== null ? e(number_format($b['expectancyR'], 2)) : '—' ?></span>
            </div>
            <div class="bar"><div style="width:<?= round(($b['winRate'] ?? 0) * 100) ?>%;background:<?= ($b['winRate'] ?? 0) >= 0.5 ? '#34d399' : '#fb7185' ?>"></div></div>
          </div>
        <?php endforeach; ?>
      <?php else: ?>
        <p class="dim">No confidence-tagged closed trades yet.</p>
      <?php endif; ?>
    </div>
  </div>
</div>
