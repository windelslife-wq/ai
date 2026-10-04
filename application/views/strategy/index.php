<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head">
  <div>
    <h2>Strategy Lab</h2>
    <p>Versioned strategies, an evidence-gated lifecycle and realistic backtests. Deploy to paper from the Paper Trading console.</p>
  </div>
</div>
<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>

<div class="grid cols-main">
  <div class="grid">
    <?php if (!empty($detail)): $d = $detail; ?>
      <div class="panel">
        <h3>Backtest runner — <?= e($d['strategy_id']) ?>@<?= e($d['version']) ?></h3>
        <div class="body" style="padding-top:12px">
          <form method="post" action="/strategy/backtest" class="inline">
            <input type="hidden" name="strategyId" value="<?= e($d['strategy_id']) ?>">
            <label class="fld">Symbol <select name="symbol" class="sel">
              <?php foreach (['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'EURUSD', 'GBPUSD', 'XAUUSD'] as $s): ?>
                <option><?= $s ?></option>
              <?php endforeach; ?>
            </select></label>
            <label class="fld">Timeframe <select name="timeframe" class="sel">
              <?php foreach (['15m', '1h', '4h', '1d'] as $tf): ?><option <?= $tf === '1h' ? 'selected' : '' ?>><?= $tf ?></option><?php endforeach; ?>
            </select></label>
            <label class="fld">Bars <input class="sel" type="number" name="limit" value="1500" min="200" max="5000" step="100"></label>
            <label class="fld" style="flex-direction:row;align-items:center;gap:6px;padding-top:14px">
              <input type="checkbox" name="allowShorts" value="1" style="accent-color:#0ea5e9"> allow shorts
            </label>
            <button class="btn primary">▶ Run backtest</button>
          </form>
          <p class="dim" style="font-size:10px;margin:8px 0 0">Fills at the NEXT bar open after a signal, half-spread + slippage + commission per side, stop-before-target when a bar touches both, hard look-ahead guard.</p>
        </div>
      </div>

      <div class="panel">
        <h3>Optimizer — walk-forward parameter search</h3>
        <div class="body" style="padding-top:12px">
          <form method="post" action="/strategy/optimize" class="inline">
            <input type="hidden" name="strategyId" value="<?= e($d['strategy_id']) ?>">
            <label class="fld">Symbol <select name="symbol" class="sel">
              <?php foreach (['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'EURUSD', 'GBPUSD', 'XAUUSD'] as $s): ?>
                <option><?= $s ?></option>
              <?php endforeach; ?>
            </select></label>
            <label class="fld">Timeframe <select name="timeframe" class="sel">
              <?php foreach (['15m', '1h', '4h', '1d'] as $tf): ?><option <?= $tf === '1h' ? 'selected' : '' ?>><?= $tf ?></option><?php endforeach; ?>
            </select></label>
            <label class="fld">Bars <input class="sel" type="number" name="limit" value="1000" min="420" max="2000" step="20"></label>
            <label class="fld" style="flex-direction:row;align-items:center;gap:6px;padding-top:14px">
              <input type="checkbox" name="register" value="1" style="accent-color:#0ea5e9"> register variant
            </label>
            <button class="btn">⚙ Optimize</button>
          </form>
          <p class="dim" style="font-size:10px;margin:8px 0 0">Grid search on the first 70% (in-sample), verification on the last 30% (out-of-sample). A candidate is recommended ONLY if it survives out-of-sample and beats the baseline there; in-sample-only performance is never adopted. Registered variants are source <b>ai</b> — DRAFT lifecycle, human sign-off required.</p>
        </div>
      </div>
    <?php endif; ?>

    <?php if (!empty($results)): ?>
      <div class="panel">
        <h3>Backtest history — <?= e($detail['strategy_id']) ?></h3>
        <div class="body scroll">
          <table class="tbl mono">
            <thead><tr><th>Date</th><th>Sym</th><th>TF</th><th class="num">Trades</th><th class="num">Return</th><th class="num">Win%</th><th class="num">PF</th><th class="num">Sharpe</th><th class="num">MaxDD</th><th>Data</th></tr></thead>
            <tbody>
              <?php foreach ($results as $r): $m = $r['metrics']; ?>
                <tr>
                  <td class="dim"><?= e(substr($r['created_at'], 0, 16)) ?></td>
                  <td><?= e($r['request']['symbol']) ?></td>
                  <td class="dim"><?= e($r['request']['timeframe']) ?></td>
                  <td class="num"><?= e($m['trades']) ?></td>
                  <td class="num <?= $m['totalReturnPct'] >= 0 ? 'up' : 'down' ?>"><?= e(number_format($m['totalReturnPct'], 2)) ?>%</td>
                  <td class="num"><?= $m['winRate'] !== null ? e(number_format($m['winRate'] * 100, 0)) . '%' : '—' ?></td>
                  <td class="num"><?= $m['profitFactor'] !== null ? e(number_format($m['profitFactor'], 2)) : '—' ?></td>
                  <td class="num"><?= $m['sharpe'] !== null ? e(number_format($m['sharpe'], 2)) : '—' ?></td>
                  <td class="num warn"><?= e(number_format($m['maxDrawdownPct'], 1)) ?>%</td>
                  <td><?= $r['dataProvenance']['synthetic'] ? '<span class="badge b-amber" style="padding:0 5px">SIM</span>' : '<span class="badge b-green" style="padding:0 5px">LIVE</span>' ?></td>
                </tr>
              <?php endforeach; ?>
            </tbody>
          </table>
        </div>
      </div>
    <?php endif; ?>
  </div>

  <div class="grid">
    <?php foreach ($strategies as $s): $isSel = $detail && $s['strategy_id'] === $detail['strategy_id']; ?>
      <div class="panel" style="<?= $isSel ? 'border-color:#0ea5e988' : '' ?>">
        <div class="body" style="padding-top:12px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <b class="mono" style="color:#fff"><?= e($s['strategy_id']) ?></b>
            <span class="dim mono" style="font-size:10px">v<?= e($s['version']) ?></span>
            <span class="badge <?= ['DRAFT' => 'b-gray', 'BACKTESTED' => 'b-sky', 'VALIDATED' => 'b-sky', 'RISK_REVIEWED' => 'b-violet', 'PAPER_TRADING' => 'b-violet', 'APPROVED' => 'b-green', 'RETIRED' => 'b-red'][$s['lifecycle']] ?? 'b-gray' ?>" style="margin-left:auto"><?= e($s['lifecycle']) ?></span>
          </div>
          <div class="dim" style="font-size:11px;margin-top:4px"><?= e($s['name']) ?></div>
          <?php if ($isSel): ?>
            <ol class="stages" style="margin-top:10px">
              <?php $order = ['DRAFT', 'BACKTESTED', 'VALIDATED', 'RISK_REVIEWED', 'PAPER_TRADING', 'APPROVED'];
              $curIdx = array_search($s['lifecycle'], $order, true);
              foreach ($order as $i => $st): $label = $st === 'PAPER_TRADING' ? 'Paper trading (deploy)' : $st; ?>
                <li class="<?= $i === $curIdx ? 'cur' : ($i < $curIdx ? '' : 'pend') ?>">
                  <span class="n <?= $i <= $curIdx ? 'done' : '' ?>"><?= $i <= $curIdx ? '✓' : $i + 1 ?></span>
                  <?= e($label) ?>
                  <?php if ($i === $curIdx): ?><span class="badge b-sky" style="padding:0 5px;margin-left:4px">current</span><?php endif; ?>
                </li>
              <?php endforeach; ?>
            </ol>
            <?php if ($s['nextStage']): ?>
              <form method="post" action="/strategy/advance" style="margin-top:10px">
                <input type="hidden" name="strategyId" value="<?= e($s['strategy_id']) ?>">
                <input type="hidden" name="version" value="<?= e($s['version']) ?>">
                <input type="hidden" name="to" value="<?= e($s['nextStage']) ?>">
                <button class="btn small" style="width:100%">Request advance → <?= e($s['nextStage']) ?></button>
              </form>
            <?php endif; ?>
            <div class="dim" style="font-size:10px;margin-top:8px;border-top:1px solid var(--line);padding-top:8px">
              params: <?= e(implode(', ', array_map(fn($k, $v) => "$k=$v", array_keys($s['params']), $s['params']))) ?>
            </div>
          <?php else: ?>
            <div style="margin-top:8px"><a class="btn small" href="/strategy?strategy=<?= e($s['strategy_id']) ?>">select</a></div>
          <?php endif; ?>
        </div>
      </div>
    <?php endforeach; ?>
  </div>
</div>
