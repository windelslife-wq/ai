<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head"><div><h2>Lesson history</h2><p>Every attempt is recorded: lessons, checkpoints, conversations, assessments and writing.</p></div></div>
<div class="panel">
  <div class="body scroll" style="padding-top:12px">
    <table class="tbl">
      <thead><tr><th>At</th><th>Kind</th><th class="num">Score</th><th class="num">Passed</th><th>Detail</th></tr></thead>
      <tbody>
        <?php foreach ($history['attempts'] as $a): ?>
          <tr>
            <td class="dim"><?= e(substr((string) $a['createdAt'], 5, 14)) ?></td>
            <td><span class="badge b-gray"><?= e($a['kind']) ?></span></td>
            <td class="num"><?= e((string) $a['scorePct']) ?>%</td>
            <td class="num"><?= $a['passed'] ? '✓' : '✗' ?></td>
            <td class="dim"><?= e(mb_substr(json_encode($a['detail'] ?? []), 0, 90)) ?>…</td>
          </tr>
        <?php endforeach; ?>
      </tbody>
    </table>
    <h4 style="margin-top:14px">Conversations</h4>
    <table class="tbl">
      <?php foreach ($history['conversations'] as $c): ?>
        <tr><td class="dim"><?= e(substr((string) $c['started_at'], 5, 14)) ?></td><td><?= e($c['scenario']) ?></td><td class="dim"><?= e($c['status']) ?></td><td class="num"><?= (int) $c['turn_count'] ?> turns</td></tr>
      <?php endforeach; ?>
    </table>
  </div>
</div>
