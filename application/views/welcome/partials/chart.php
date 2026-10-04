<?php
defined('BASEPATH') or exit('No direct script access allowed');
/**
 * Server-rendered SVG candlestick chart with EMA overlays, S/R lines and
 * setup overlay. No client-side chart library — pure traditional MVC.
 * @var array $candles @var array $run
 */
$visible = array_slice($candles, -140);
$setup = $run['tradeSetup'] ?? null;
$technical = null;
foreach ($run['agents'] as $a) { if ($a['agent'] === 'technical') $technical = $a; }
$support = $technical['structure']['support'] ?? [];
$resistance = $technical['structure']['resistance'] ?? [];

// EMAs computed inline (causal, matching the agent)
$closes = array_map(fn($c) => $c['close'], $candles);
$emaSeries = function (array $values, int $period) {
    $k = 2 / ($period + 1); $out = []; $prev = null; $seed = 0.0;
    foreach ($values as $i => $v) {
        if ($i < $period - 1) { $seed += $v; $out[] = null; continue; }
        $prev = $prev === null ? ($seed + $v) / $period : $v * $k + $prev * (1 - $k);
        $out[] = $prev;
    }
    return $out;
};
$offset = count($candles) - count($visible);
$ema20 = array_slice($emaSeries($closes, 20), $offset);
$ema50 = array_slice($emaSeries($closes, 50), $offset);

$W = 1000; $H = 380; $PADL = 6; $PADR = 74; $PADT = 10; $VOLH = 56;
$priceH = $H - $PADT - $VOLH - 16;
$lo = min(array_map(fn($c) => $c['low'], $visible));
$hi = max(array_map(fn($c) => $c['high'], $visible));
foreach (array_merge($support, $resistance) as $l) { if ($l > $lo * 0.9 && $l < $hi * 1.1) { $lo = min($lo, $l); $hi = max($hi, $l); } }
if ($setup) { $lo = min($lo, $setup['stopLoss'], $setup['entry']['min']); $hi = max($hi, $setup['stopLoss'], $setup['takeProfit'][0]); }
$pad = ($hi - $lo) * 0.04 ?: 1; $lo -= $pad; $hi += $pad;
$n = count($visible); $step = ($W - $PADL - $PADR) / max(1, $n);
$x = fn($i) => $PADL + $i * $step + $step / 2;
$y = fn($p) => $PADT + $priceH - (($p - $lo) / max(1e-9, $hi - $lo)) * $priceH;
$vy = fn($v) => $H - 10 - ($v / max(1, max(array_map(fn($c) => $c['volume'], $visible)))) * $VOLH;
$f = fn($p) => number_format($p, $p >= 100 ? 1 : ($p >= 10 ? 3 : 5));
$line = function (array $series) use ($x, $y, $offset, $n) {
    $pts = [];
    foreach ($series as $i => $v) { if ($v !== null) $pts[] = sprintf('%.1f,%.1f', $x($i), $y($v)); }
    return implode(' ', $pts);
};
?>
<div class="panel" style="margin-bottom:12px">
  <h3><?= e($run['symbol']) ?> · <?= e($run['timeframe']) ?> — candles · EMA · structure · setup</h3>
  <div class="body scroll" style="padding-top:12px">
    <svg viewBox="0 0 <?= $W ?> <?= $H ?>" style="min-width:760px;width:100%" role="img" aria-label="candlestick chart">
      <?php for ($g = 0; $g <= 4; $g++): $gp = $lo + ($hi - $lo) * $g / 4; ?>
        <line x1="<?= $PADL ?>" x2="<?= $W - $PADR ?>" y1="<?= $y($gp) ?>" y2="<?= $y($gp) ?>" stroke="#141926"/>
        <text x="<?= $W - $PADR + 6 ?>" y="<?= $y($gp) + 3 ?>" font-size="10" fill="#5b6478" font-family="monospace"><?= $f($gp) ?></text>
      <?php endfor; ?>
      <?php foreach ($resistance as $r): ?>
        <line x1="<?= $PADL ?>" x2="<?= $W - $PADR ?>" y1="<?= $y($r) ?>" y2="<?= $y($r) ?>" stroke="#f87171" stroke-dasharray="2 5" opacity="0.5"><title>Resistance <?= $f($r) ?></title></line>
      <?php endforeach; ?>
      <?php foreach ($support as $s): ?>
        <line x1="<?= $PADL ?>" x2="<?= $W - $PADR ?>" y1="<?= $y($s) ?>" y2="<?= $y($s) ?>" stroke="#38bdf8" stroke-dasharray="2 5" opacity="0.5"><title>Support <?= $f($s) ?></title></line>
      <?php endforeach; ?>
      <?php if ($setup): ?>
        <rect x="<?= $PADL ?>" y="<?= $y($setup['entry']['max']) ?>" width="<?= $W - $PADL - $PADR ?>" height="<?= max(2, $y($setup['entry']['min']) - $y($setup['entry']['max'])) ?>" fill="<?= $setup['action'] === 'BUY' ? '#22c55e' : '#ef4444' ?>" opacity="0.12"/>
        <line x1="<?= $PADL ?>" x2="<?= $W - $PADR ?>" y1="<?= $y($setup['stopLoss']) ?>" y2="<?= $y($setup['stopLoss']) ?>" stroke="#ef4444" stroke-width="1.4" stroke-dasharray="6 3"/>
        <text x="<?= $PADL + 4 ?>" y="<?= $y($setup['stopLoss']) - 3 ?>" font-size="10" fill="#f87171" font-family="monospace">SL <?= $f($setup['stopLoss']) ?></text>
        <?php foreach ($setup['takeProfit'] as $i => $tp): ?>
          <line x1="<?= $PADL ?>" x2="<?= $W - $PADR ?>" y1="<?= $y($tp) ?>" y2="<?= $y($tp) ?>" stroke="#22c55e" stroke-dasharray="6 3" opacity="<?= 0.9 - $i * 0.25 ?>"/>
          <text x="<?= $PADL + 4 ?>" y="<?= $y($tp) - 3 ?>" font-size="10" fill="#4ade80" font-family="monospace">TP<?= $i + 1 ?> <?= $f($tp) ?></text>
        <?php endforeach; ?>
      <?php endif; ?>
      <?php foreach ($visible as $i => $c): ?>
        <rect x="<?= $x($i) - $step * 0.32 ?>" y="<?= $vy($c['volume']) ?>" width="<?= max(1, $step * 0.64) ?>" height="<?= $H - 10 - $vy($c['volume']) ?>" fill="<?= $c['close'] >= $c['open'] ? '#134e4a' : '#4c1d24' ?>"/><title>vol <?= number_format($c['volume']) ?></title></rect>
      <?php endforeach; ?>
      <?php foreach ($visible as $i => $c): $up = $c['close'] >= $c['open']; $col = $up ? '#26a69a' : '#ef5350'; ?>
        <g><title><?= e(date('Y-m-d H:i', (int)($c['timestamp'] / 1000))) ?>Z · O <?= $f($c['open']) ?> H <?= $f($c['high']) ?> L <?= $f($c['low']) ?> C <?= $f($c['close']) ?></title>
          <line x1="<?= $x($i) ?>" x2="<?= $x($i) ?>" y1="<?= $y($c['high']) ?>" y2="<?= $y($c['low']) ?>" stroke="<?= $col ?>"/>
          <rect x="<?= $x($i) - max(1, $step * 0.3) ?>" y="<?= min($y($c['open']), $y($c['close'])) ?>" width="<?= max(1.5, $step * 0.6) ?>" height="<?= max(1, abs($y($c['close']) - $y($c['open']))) ?>" fill="<?= $col ?>"/>
        </g>
      <?php endforeach; ?>
      <polyline points="<?= $line($ema20) ?>" fill="none" stroke="#fbbf24" stroke-width="1.3" opacity="0.9"><title>EMA20</title></polyline>
      <polyline points="<?= $line($ema50) ?>" fill="none" stroke="#a78bfa" stroke-width="1.3" opacity="0.9"><title>EMA50</title></polyline>
    </svg>
    <div class="dim" style="font-size:10px;display:flex;gap:14px">
      <span>— EMA20</span><span>— EMA50</span><span>— support/resistance (dashed)</span><?php if ($setup): ?><span>entry zone · SL · TP ladder</span><?php endif; ?>
      <span style="margin-left:auto"><?= count($visible) ?> of <?= count($candles) ?> bars · source: <?= e($run['provenance']['source']) ?><?= $run['provenance']['synthetic'] ? ' (SYNTHETIC)' : '' ?></span>
    </div>
  </div>
</div>
