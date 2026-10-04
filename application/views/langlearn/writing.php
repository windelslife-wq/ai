<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head"><div><h2>Writing practice</h2><p>Guided tasks with real element checks. Your original text is always stored unchanged next to the feedback.</p></div></div>
<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>
<?php foreach ($tasks as $t): ?>
  <div class="panel" style="margin-bottom:12px">
    <h3><?= e($t['title']) ?></h3>
    <div class="body" style="padding-top:12px">
      <p><?= e($t['instruction']) ?></p>
      <form method="post" action="/app/languages/w/<?= (int) $profileId ?>/submit">
        <input type="hidden" name="taskCode" value="<?= e($t['code']) ?>">
        <textarea name="text" rows="3" required style="width:100%;background:var(--panel2);color:inherit;border:1px solid var(--line);border-radius:8px;padding:10px" placeholder="Write in the language you are learning…"></textarea>
        <button class="btn primary" style="margin-top:8px">Check my writing</button>
      </form>
      <p class="dim" style="font-size:10px;margin-top:6px"><?= e($t['checkedNote']) ?></p>
    </div>
  </div>
<?php endforeach; ?>
<?php if (!empty($history)): ?>
  <div class="panel">
    <h3>My writing + feedback (originals kept)</h3>
    <div class="body scroll" style="padding-top:12px">
      <table class="tbl">
        <thead><tr><th>At</th><th>Task</th><th>Original</th><th>Feedback</th><th class="num">Score</th></tr></thead>
        <tbody>
          <?php foreach ($history as $w): $f = $w['feedback']; ?>
            <tr>
              <td class="dim"><?= e(substr((string) $w['created_at'], 5, 11)) ?></td>
              <td><?= e($f['task'] ?? $w['task_code']) ?></td>
              <td><?= e(mb_substr((string) $w['original_text'], 0, 80)) ?></td>
              <td class="dim"><?php foreach (($f['elements'] ?? []) as $el): ?><?= e($el['element']) ?> <?= $el['met'] ? '✓' : '✗' ?> · <?php endforeach; ?></td>
              <td class="num"><?= e((string) ($f['scorePct'] ?? $w['score_pct'])) ?>%</td>
            </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>
  </div>
<?php endif; ?>
