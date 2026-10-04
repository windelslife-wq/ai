<?php defined('BASEPATH') or exit('No direct script access allowed');
/** @var array $user @var array $status @var array $inbox @var array $history @var int $paperAccounts @var int $languageProfiles @var bool $admin */
$first = explode(' ', trim((string)($user['display_name'] ?? 'Member')))[0];
$unread = (int)($inbox['unread'] ?? 0);
$notes = $inbox['notifications'] ?? [];
$ic = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">';
$ks = $status['killSwitch'] ?? null;
$mode = $status['tradingMode'] ?? null;
?>
<div class="dash-hero">
  <div class="dash-hero-copy">
    <p class="eyebrow">WINDELS AI WORKFORCE</p>
    <h2>Welcome back, <?= e($first) ?></h2>
    <p>Here is the current state of your workspace. Pick a main action below, or continue from a recent activity.</p>
    <div class="dash-status">
      <?php if (!empty($ks['active'])): ?><span class="statuspill warn"><i class="pill-dot"></i>Kill switch active</span>
      <?php else: ?><span class="statuspill"><i class="pill-dot"></i>Mode <?= e($mode) ?></span><?php endif; ?>
      <span class="statuspill"><i class="pill-dot"></i><?= (int)$paperAccounts ?> paper account<?= $paperAccounts === 1 ? '' : 's' ?></span>
      <span class="statuspill"><i class="pill-dot"></i><?= (int)$languageProfiles ?> language profile<?= $languageProfiles === 1 ? '' : 's' ?></span>
    </div>
  </div>
  <div class="dash-hero-actions">
    <a class="btn primary" href="/analysis" data-dashboard-link><?= $ic ?><rect x="4" y="6" width="16" height="13" rx="2"/><path d="M9 12h.01M15 12h.01M9 16h6"/></svg> Run AI analysis</a>
    <a class="btn" href="/app/languages/teacher" data-dashboard-link><?= $ic ?><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/></svg> Learn a language</a>
    <a class="btn" href="/paper" data-dashboard-link><?= $ic ?><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h5"/></svg> Paper trading</a>
  </div>
</div>
<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>

<h2 class="section-title">Workspace summary</h2>
<div class="grid four">
  <a class="kp-card" href="/analysis">
    <div class="kp-top"><div class="k">AI workforce runs</div><div class="kp-ic"><?= $ic ?><rect x="4" y="6" width="16" height="13" rx="2"/><path d="M9 12h.01M15 12h.01M9 16h6"/></svg></div></div>
    <div class="v"><?= count($history) ?></div>
    <div class="trend">Recent analyses stored</div>
  </a>
  <a class="kp-card" href="/app/languages">
    <div class="kp-top"><div class="k">Language profiles</div><div class="kp-ic"><?= $ic ?><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/></svg></div></div>
    <div class="v"><?= (int)$languageProfiles ?></div>
    <div class="trend">Active learning paths</div>
  </a>
  <a class="kp-card" href="/paper">
    <div class="kp-top"><div class="k">Paper accounts</div><div class="kp-ic"><?= $ic ?><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h5"/></svg></div></div>
    <div class="v"><?= (int)$paperAccounts ?></div>
    <div class="trend">Simulation accounts</div>
  </a>
  <a class="kp-card" href="/notifications">
    <div class="kp-top"><div class="k">Unread alerts</div><div class="kp-ic"><?= $ic ?><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 19a2 2 0 0 0 4 0"/></svg></div></div>
    <div class="v"><?= $unread ?></div>
    <div class="trend">Awaiting your review</div>
  </a>
</div>

<h2 class="section-title">Recent activity &amp; alerts</h2>
<div class="grid cols-main">
  <section class="panel">
    <h3><?= $ic ?><path d="M3 3v18h18"/><path d="m7 14 3-3 3 2 5-6"/></svg> Recent activity</h3>
    <div class="body">
      <?php if (!$history): ?>
        <div class="empty-state">
          <?= $ic ?><rect x="4" y="6" width="16" height="13" rx="2"/><path d="M12 2v4"/></svg>
          <p>No analysis runs stored yet.</p>
          <p style="margin-top:12px"><a class="btn primary" href="/analysis">Run your first analysis</a></p>
        </div>
      <?php else: ?>
        <table class="tbl">
          <thead><tr><th>Symbol</th><th>Timeframe</th><th>Bias</th><th class="num">Completed</th></tr></thead>
          <tbody>
            <?php foreach ($history as $h): ?>
              <tr>
                <td class="mono"><?= e($h['symbol']) ?></td>
                <td class="dim"><?= e($h['timeframe']) ?></td>
                <td><?= e($h['bias']) ?></td>
                <td class="num dim"><?= e(substr((string)$h['completed_at'], 0, 16)) ?></td>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      <?php endif; ?>
    </div>
    <a class="panel-foot-link" href="/journal">View analytics →</a>
  </section>

  <section class="panel">
    <h3><?= $ic ?><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 19a2 2 0 0 0 4 0"/></svg> Notifications</h3>
    <div class="body">
      <?php if (!$notes): ?>
        <div class="empty-state" style="padding:20px">
          <p>Nothing in your inbox yet.</p>
        </div>
      <?php else: ?>
        <div class="feed">
          <?php foreach (array_slice($notes, 0, 6) as $n): ?>
            <div class="row">
              <span class="t"><?= e($n['title'] ?? $n['type'] ?? 'Notice') ?></span>
              <span class="d"><?= e(substr((string)($n['created_at'] ?? ''), 0, 16)) ?></span>
            </div>
          <?php endforeach; ?>
        </div>
      <?php endif; ?>
    </div>
    <a class="panel-foot-link" href="/notifications">Open all alerts →</a>
  </section>
</div>
