<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head">
  <div>
    <h2>Alerts</h2>
    <p><?= (int) $inbox['unread'] ?> unread. Risk transitions, approvals, executions, broker disconnects and kill-switch events — one unread item per active issue.</p>
  </div>
</div>

<div class="panel">
  <h3>Inbox</h3>
  <div class="body scroll" style="padding-top:12px">
    <?php if (empty($inbox['notifications'])): ?>
      <p class="dim">Nothing yet — run a portfolio scan (Risk Center) or create an execution proposal.</p>
    <?php else: ?>
      <div style="margin-bottom:8px">
        <form method="post" action="/notifications/read-all"><button class="btn small">Mark all read</button></form>
      </div>
      <table class="tbl mono">
        <thead><tr><th>At</th><th>Severity</th><th>Type</th><th>Title</th><th>Detail</th><th class="num"></th></tr></thead>
        <tbody>
          <?php foreach ($inbox['notifications'] as $n): ?>
            <tr style="<?= $n['read_at'] ? 'opacity:.55' : 'font-weight:600' ?>">
              <td class="dim"><?= e(substr((string) $n['created_at'], 5, 14)) ?></td>
              <td>
                <?php $tone = ['critical' => 'b-red', 'warning' => 'b-amber', 'info' => 'b-sky'][$n['severity']] ?? 'b-gray'; ?>
                <span class="badge <?= $tone ?>"><?= e($n['severity']) ?></span>
              </td>
              <td><?= e($n['type']) ?></td>
              <td><?= e($n['title']) ?><?= $n['user_id'] === null ? ' <span class="dim">(broadcast)</span>' : '' ?></td>
              <td class="dim"><details><summary style="cursor:pointer">detail</summary><pre style="font-size:10px;white-space:pre-wrap"><?= e(json_encode($n['detail'], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) ?></pre></details></td>
              <td class="num">
                <?php if ($n['read_at'] === null): ?>
                  <form method="post" action="/notifications/<?= e($n['id']) ?>/read"><button class="btn small">mark read</button></form>
                <?php endif; ?>
              </td>
            </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    <?php endif; ?>
  </div>
</div>
