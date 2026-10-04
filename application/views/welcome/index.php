<?php defined('BASEPATH') or exit('No direct script access allowed');
$biasClass = static function (?string $bias): string {
    return ['BULLISH' => 'b-green', 'BEARISH' => 'b-red', 'NEUTRAL' => 'b-gray', 'NO_TRADE' => 'b-amber'][(string) $bias] ?? 'b-gray';
};
?>
<div class="page-head">
  <div>
    <h2>AI Workforce</h2>
    <p>Run multi-agent market analysis. Agents agree on a bias, the risk engine can veto a setup, and this page never places an order.</p>
  </div>
</div>

<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>
<?php if (!empty($modeError)): ?><div class="notice err"><?= e($modeError) ?></div><?php endif; ?>
<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>

<div class="feature-start">
  <div>
    <h3>Start an analysis</h3>
    <p>Choose a market and timeframe. Five agents produce a consensus, a regime read, a setup and a risk decision.</p>
    <form method="post" class="inline" action="/analysis" style="margin-top:12px">
      <label class="fld">Symbol
        <select name="symbol" class="sel">
          <?php foreach ($symbols as $group => $list): ?>
            <optgroup label="<?= e($group) ?>">
              <?php foreach ($list as $s): ?><option value="<?= $s ?>" <?= $symbol === $s ? 'selected' : '' ?>><?= $s ?></option><?php endforeach; ?>
            </optgroup>
          <?php endforeach; ?>
        </select>
      </label>
      <label class="fld">Timeframe
        <select name="timeframe" class="sel">
          <?php foreach ($timeframes as $tf): ?><option value="<?= $tf ?>" <?= $timeframe === $tf ? 'selected' : '' ?>><?= $tf ?></option><?php endforeach; ?>
        </select>
      </label>
      <button class="btn primary" type="submit">Run analysis</button>
    </form>
  </div>
  <div class="feature-start-aside">
    <?php if (!empty($status['killSwitch']['active'])): ?>
      <span class="statuspill warn"><i class="pill-dot"></i>Kill switch active</span>
    <?php else: ?>
      <span class="statuspill"><i class="pill-dot"></i>Mode <?= e($status['tradingMode']) ?></span>
    <?php endif; ?>
    <form method="post" action="/mode" class="inline">
      <select name="mode" class="sel">
        <?php foreach (['ANALYSIS_ONLY', 'PAPER_TRADING', 'HUMAN_APPROVAL', 'SEMI_AUTONOMOUS', 'FULLY_AUTOMATED'] as $m): ?>
          <option value="<?= $m ?>" <?= $status['tradingMode'] === $m ? 'selected' : '' ?>><?= $m ?></option>
        <?php endforeach; ?>
      </select>
      <button class="btn small">Set</button>
    </form>
    <?php if (!empty($status['killSwitch']['active'])): ?>
      <form method="post" action="/kill-switch"><input type="hidden" name="active" value="0"><button class="btn small danger">Release kill switch</button></form>
    <?php else: ?>
      <form method="post" action="/kill-switch"><input type="hidden" name="active" value="1"><button class="btn small danger">Activate kill switch</button></form>
    <?php endif; ?>
  </div>
</div>

<?php if (!empty($watch)): ?>
<div class="panel" style="margin-bottom:16px">
  <h3>Watchlist consensus · <?= e($timeframe) ?></h3>
  <div class="body wl-list">
    <?php foreach ($watch as $w): ?>
      <form method="post" action="/analysis">
        <input type="hidden" name="symbol" value="<?= e($w['symbol']) ?>">
        <input type="hidden" name="timeframe" value="<?= e($timeframe) ?>">
        <button class="btn wl-btn" type="submit">
          <span class="wl-row">
            <b class="mono"><?= e($w['symbol']) ?></b>
            <span class="badge <?= $biasClass($w['bias'] ?? '') ?>"><?= e(substr((string) $w['bias'], 0, 4)) ?></span>
            <?php if ($w['synthetic']): ?><span class="badge b-amber" style="padding:0 4px">SIM</span><?php endif; ?>
          </span>
          <span class="wl-meta">conf <?= round($w['confidence'] * 100) ?>% · <?= e(strtolower(str_replace('_', ' ', $w['regime']))) ?></span>
        </button>
      </form>
    <?php endforeach; ?>
  </div>
</div>
<?php endif; ?>

<?php if (!empty($run)): ?>
  <?php $p = $run['provenance']; ?>
  <div class="notice <?= $p['synthetic'] ? 'warnbox' : ($p['stale'] ? 'err' : 'ok') ?>">
    <?php if ($p['synthetic']): ?><b>⚠ SIMULATION / SYNTHETIC DATA</b> — real providers unreachable from this host; the labeled demo provider serves this analysis. The Risk Engine vetoes trades on synthetic data.<?php endif; ?>
    <?php if ($p['stale'] && !$p['synthetic']): ?><b>DATA STALE</b><?php endif; ?>
    <div style="margin-top:4px">
      Source: <b class="mono"><?= e($p['source']) ?></b> · data time <b class="mono"><?= e(date('Y-m-d H:i:s', (int)($p['dataTimestamp'] / 1000))) ?>Z</b> ·
      age <b><?= e(rtrim(number_format($p['dataAgeMs'] / 60000, 1), '0.')) ?>m</b> ·
      <?= $p['synthetic'] ? '' : ($p['delayed'] ? 'DELAYED' : 'LIVE') ?>
      <?php if ($p['fallbackChain']): ?> · fallback: <?= e(implode(' → ', $p['fallbackChain'])) ?> → <?= e($p['source']) ?><?php endif; ?>
    </div>
  </div>

  <div class="grid cols-main">
    <div class="grid">
      <div class="panel">
        <h3>Trading Intelligence Consensus</h3>
        <div class="body">
          <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-bottom:10px">
            <span class="badge big <?= ['BULLISH' => 'b-green', 'BEARISH' => 'b-red', 'NEUTRAL' => 'b-gray', 'NO_TRADE' => 'b-amber'][$run['bias']] ?>"><?= e($run['bias']) ?></span>
            <div style="font-size:12px">
              Recommendation <b class="<?= $run['recommendation'] === 'BUY' ? 'up' : ($run['recommendation'] === 'SELL' ? 'down' : '') ?>"><?= e($run['recommendation']) ?></b> ·
              Regime <b class="mono"><?= e($run['marketRegime']) ?></b> · ADX <?= e($run['regimeAssessment']['adx'] ?? '—') ?> ·
              <?php if ($run['quote']): ?>last <b class="mono"><?= e(number_format($run['quote']['last'], $run['quote']['last'] >= 10 ? 2 : 5)) ?></b><?php endif; ?>
            </div>
          </div>
          <?php
          $meters = [
            ['Confidence', $run['confidence'], '#38bdf8'],
            ['Confluence', $run['confluence'], '#a78bfa'],
            ['Agent agreement', $run['consensus']['agreement'], '#34d399'],
          ];
          foreach ($meters as [$label, $v, $color]): ?>
            <div class="meter">
              <div class="row"><span><?= e($label) ?></span><span class="mono"><?= round($v * 100) ?>%</span></div>
              <div class="bar"><div style="width:<?= round($v * 100) ?>%;background:<?= $color ?>"></div></div>
            </div>
          <?php endforeach; ?>
          <div class="dim" style="font-size:11px">net score <?= e(number_format($run['consensus']['netScore'], 2)) ?> · voting: <?= e(implode(', ', $run['consensus']['votingAgents'])) ?> · abstaining: <?= e(implode(', ', $run['consensus']['abstainingAgents']) ?: 'none') ?></div>
          <?php if (!empty($run['debate'])): $dv = $run['debate']['verdict']; ?>
            <div class="notice <?= $dv['bias'] === 'NO_TRADE' ? 'err' : ($dv['confidenceAdjustment'] < 0 ? 'warnbox' : 'ok') ?>" style="margin:10px 0 0">
              <b>Agent debate verdict: <?= e($dv['bias']) ?></b><?php if ($dv['confidenceAdjustment'] < 0): ?> (confidence <?= e($dv['confidenceAdjustment']) ?>)<?php endif; ?>
              — <?= e(implode('; ', $dv['reasoning'])) ?>
              <details style="margin-top:6px"><summary style="cursor:pointer;font-size:11px">debate transcript</summary>
                <?php foreach ($run['debate']['rounds'] as $round): ?>
                  <div style="font-size:11px;margin-top:4px"><b><?= e(str_replace('-', ' ', $round['role'])) ?></b>
                    <?php foreach (($round['statements'] ?? $round['objections'] ?? []) as $item): ?>
                      <div class="dim">• <?= e($item['claim'] ?? ($item['grounds'] ?? '')) ?><?= isset($item['evidence']) ? ' <span class="mono">[' . e($item['evidence']) . ']</span>' : '' ?><?= isset($item['severity']) ? ' <span class="badge b-gray">' . e($item['severity']) . '</span>' : '' ?></div>
                    <?php endforeach; ?>
                  </div>
                <?php endforeach; ?>
              </details>
            </div>
          <?php endif; ?>
          <?php if ($run['conflicts']): ?>
            <div class="notice warnbox" style="margin:10px 0 0">
              <b>Signal conflicts:</b>
              <?php foreach ($run['conflicts'] as $c): ?><div>• <?= e($c['agent']) ?> leans <?= e($c['theirBias']) ?> — <?= e($c['reason']) ?></div><?php endforeach; ?>
            </div>
          <?php endif; ?>
          <details class="raw" style="margin-top:10px"><summary>regime evidence &amp; reasoning</summary>
            <ul style="font-size:11px;color:var(--muted)">
              <?php foreach ($run['regimeAssessment']['evidence'] as $ev): ?><li>▸ <?= e($ev) ?></li><?php endforeach; ?>
              <?php foreach (array_slice($run['reasoning'], 0, 6) as $r): ?><li>· <?= e($r) ?></li><?php endforeach; ?>
            </ul>
          </details>
        </div>
      </div>

      <?php if (!empty($candles)) include __DIR__ . '/partials/chart.php'; ?>

      <div class="panel">
        <h3>Technical signals</h3>
        <div class="body scroll">
          <table class="tbl">
            <thead><tr><th>Indicator</th><th class="num">Value</th><th class="num">Signal</th></tr></thead>
            <tbody>
              <?php foreach ($run['signals'] as $s): ?>
                <tr>
                  <td><?= e($s['name']) ?> <span class="dim" style="font-size:10px"><?= e($s['detail']) ?></span></td>
                  <td class="num mono"><?= $s['value'] !== null ? e(number_format($s['value'], 2)) : '—' ?></td>
                  <td class="num"><span class="badge <?= $s['signal'] === 'BUY' ? 'b-green' : ($s['signal'] === 'SELL' ? 'b-red' : 'b-gray') ?>" style="padding:0 6px"><?= e($s['signal']) ?></span></td>
                </tr>
              <?php endforeach; ?>
            </tbody>
          </table>
        </div>
      </div>

      <?php foreach ($run['agents'] as $a): ?>
        <div class="panel">
          <h3><?= e($a['title']) ?></h3>
          <div class="body">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
              <span class="badge <?= $a['vote']['votes'] ? ($a['vote']['directionalScore'] > 0 ? 'b-green' : 'b-red') : 'b-gray' ?>">
                <?= $a['vote']['votes'] ? ($a['vote']['signal'] === 'BUY' ? '▲ BULL' : '▼ BEAR') : 'ABSTAIN' ?>
              </span>
              <span class="dim" style="font-size:11px">data quality <?= round($a['dataQuality'] * 100) ?>%</span>
              <span style="font-size:11px;color:var(--muted)"><?= e($a['vote']['reason']) ?></span>
            </div>
            <?php if ($a['agent'] === 'forex' && !empty($a['currencyStrength']['scores'])): ?>
              <div style="display:flex;flex-wrap:wrap;gap:4px;margin:6px 0">
                <?php foreach (array_slice($a['currencyStrength']['scores'], 0, 8) as $cs): ?>
                  <span class="badge <?= $cs['score'] >= 0 ? 'b-green' : 'b-red' ?>" style="padding:1px 6px"><?= e($cs['currency'] . ' ' . ($cs['score'] >= 0 ? '+' : '') . number_format($cs['score'] * 100, 2) . '%') ?></span>
                <?php endforeach; ?>
              </div>
            <?php endif; ?>
            <?php if (!empty($a['warnings']) || !empty($a['dataLimitations'])): ?>
              <div class="dim" style="font-size:10px;border-top:1px solid var(--line);padding-top:6px;margin-top:6px">
                <?php foreach (array_slice(array_merge($a['warnings'], $a['dataLimitations']), 0, 4) as $lim): ?>· <?= e($lim) ?><br><?php endforeach; ?>
              </div>
            <?php endif; ?>
            <details class="raw"><summary>raw agent JSON</summary>
              <pre class="raw"><?= e(json_encode($a, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) ?></pre>
            </details>
          </div>
        </div>
      <?php endforeach; ?>
    </div>

    <div class="grid">
      <div class="panel">
        <h3>Trade proposal + Risk Engine</h3>
        <div class="body">
          <?php if (empty($run['tradeSetup'])): ?>
            <p class="dim" style="font-size:12px">No tradeable setup — consensus lacked sufficient evidence. <b>NO_TRADE is a deliberate outcome.</b></p>
          <?php else:
            $setup = $run['tradeSetup']; $rd = $run['riskDecision']; ?>
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
              <span class="badge big <?= $setup['action'] === 'BUY' ? 'b-green' : 'b-red' ?>"><?= e($setup['action']) ?></span>
              <div style="font-size:12px">
                <b class="mono"><?= e($setup['symbol']) ?></b> · <?= e($setup['timeframe']) ?><br>
                R:R <b><?= e($setup['riskReward']) ?></b> · conf <b><?= round($setup['confidence'] * 100) ?>%</b>
              </div>
            </div>
            <table class="tbl mono">
              <tr><td>Entry zone</td><td class="num"><?= e(number_format($setup['entry']['min'], 5)) ?> – <?= e(number_format($setup['entry']['max'], 5)) ?></td></tr>
              <tr><td class="down">Stop loss</td><td class="num down"><?= e(number_format($setup['stopLoss'], 5)) ?></td></tr>
              <?php foreach ($setup['takeProfit'] as $i => $tp): ?>
                <tr><td class="up">Target <?= $i + 1 ?></td><td class="num up"><?= e(number_format($tp, 5)) ?></td></tr>
              <?php endforeach; ?>
              <tr><td>Expires</td><td class="num"><?= e(substr($setup['expiration'], 0, 16)) ?>Z</td></tr>
            </table>
            <?php if ($rd): ?>
              <div style="margin-top:8px">
                <span class="badge <?= $rd['approved'] ? 'b-green' : 'b-red' ?>">RISK: <?= $rd['approved'] ? 'APPROVED' : 'VETOED' ?></span>
                <?php foreach ($rd['reasons'] as $r): ?><div class="down" style="font-size:11px;margin-top:3px">✕ <?= e($r) ?></div><?php endforeach; ?>
              </div>
            <?php endif; ?>
            <p class="dim" style="font-size:10px;margin-top:8px">Proposals are analysis output. Execute manually, or switch to PAPER_TRADING and submit through the Paper Trading console — where every order re-passes the full governance chain.</p>
          <?php endif; ?>
        </div>
      </div>

      <div class="panel">
        <h3>Recent analysis runs</h3>
        <div class="body">
          <table class="tbl">
            <?php foreach ($history as $h): ?>
              <tr>
                <td class="mono" style="font-weight:700"><?= e($h['symbol']) ?></td>
                <td class="dim"><?= e($h['timeframe']) ?></td>
                <td><span class="badge <?= $biasClass($h['bias'] ?? '') ?>" style="padding:0 6px"><?= e(substr((string) $h['bias'], 0, 4)) ?></span></td>
                <td class="num mono dim"><?= round($h['confidence'] * 100) ?>%</td>
                <td class="num dim mono"><?= e(substr($h['completed_at'], 11, 8)) ?></td>
              </tr>
            <?php endforeach; ?>
          </table>
        </div>
      </div>

      <div class="panel">
        <h3>Audit trail</h3>
        <div class="body" style="max-height:300px;overflow-y:auto">
          <?php foreach ($events as $ev): ?>
            <div style="font-size:11px;display:flex;gap:6px;padding:1px 0">
              <span class="dim mono"><?= e(substr($ev['at'], 11, 8)) ?></span>
              <span style="color:var(--sky);font-weight:600"><?= e($ev['type']) ?></span>
              <span class="dim"><?= e($ev['summary']) ?></span>
            </div>
          <?php endforeach; ?>
        </div>
      </div>
    </div>
  </div>
<?php else: ?>
  <div class="panel">
    <div class="empty-state">
      <p>Choose a symbol above and start using AI. Consensus, regime, signals and a risk-reviewed proposal will appear here.</p>
    </div>
  </div>
<?php endif; ?>
