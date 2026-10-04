<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head">
  <div>
    <h2><?= e($language['name']) ?> — AI level assessment</h2>
    <p>Adaptive assessment: difficulty follows your answers. The reported level is computed from what you actually answered.</p>
  </div>
</div>
<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>

<?php $pending = $assessment['state']['pendingItem'] ?? null; ?>
<?php if ($assessment['status'] === 'IN_PROGRESS' && $pending): ?>
  <div class="panel">
    <h3><?= e(ucfirst($pending['skill'])) ?> · <?= e($pending['level']) ?></h3>
    <div class="body" style="padding-top:12px">
      <p style="font-size:15px;font-weight:600"><?= e($pending['prompt']) ?></p>
      <form method="post" action="/app/languages/a/<?= e($assessment['id']) ?>/answer" style="display:grid;gap:8px;margin-top:10px">
        <?php foreach ($pending['options'] as $i => $opt): ?>
          <label style="display:flex;gap:10px;align-items:center;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px 12px;cursor:pointer">
            <input type="radio" name="answerIndex" value="<?= (int) $i ?>" required style="accent-color:#0ea5e9">
            <span><?= e($opt) ?></span>
          </label>
        <?php endforeach; ?>
        <div><button class="btn primary">Answer</button></div>
      </form>
    </div>
  </div>
<?php elseif ($assessment['status'] === 'COMPLETED' && $assessment['result']): ?>
  <?php $r = $assessment['result']; ?>
  <div class="panel">
    <h3>Result</h3>
    <div class="body" style="padding-top:12px">
      <div style="font-size:20px;font-weight:700;margin-bottom:8px">Overall level: <span class="badge big b-green"><?= e($r['overallLevel']) ?></span></div>
      <table class="tbl">
        <?php foreach ($r['perSkill'] as $skill => $s): ?>
          <tr><td class="dim"><?= e($skill) ?></td><td><?= e($s['level']) ?> <span class="dim">(<?= (int) $s['correct'] ?>/<?= (int) $s['total'] ?> correct)</span></td></tr>
        <?php endforeach; ?>
        <?php if ($r['strengths']): ?><tr><td class="dim">Strengths</td><td class="up"><?= e(implode(', ', $r['strengths'])) ?></td></tr><?php endif; ?>
        <?php if ($r['weaknesses']): ?><tr><td class="dim">Recommended focus</td><td class="down"><?= e(implode(', ', $r['weaknesses'])) ?></td></tr><?php endif; ?>
      </table>
      <?php if ($r['ceilingNote']): ?><p class="dim" style="font-size:11px;margin-top:8px"><?= e($r['ceilingNote']) ?></p><?php endif; ?>
      <p class="dim" style="font-size:11px"><?= e($r['notAssessedNote']) ?></p>
      <div style="margin-top:12px"><a class="btn primary" href="/app/languages/p/<?= (int) $assessment['profile_id'] ?>">Back to my <?= e($language['name']) ?></a></div>
    </div>
  </div>
<?php else: ?>
  <div class="notice warnbox">Assessment finished or in an unexpected state. <a href="/app/languages/p/<?= (int) $assessment['profile_id'] ?>">Back to profile</a></div>
<?php endif; ?>
