<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head">
  <div><h2>Module checkpoint</h2><p>Real questions from this module's level — complete it to unlock the next module. Pass mark: 75%.</p></div>
</div>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>

<?php if (!empty($checkpoint)): $m = $checkpoint['module']; ?>
  <div class="panel">
    <h3><?= e($m['title']) ?> <span class="dim">(focus: <?= e($m['focus_skill']) ?> · <?= e($m['level']) ?>)</span></h3>
    <div class="body" style="padding-top:12px">
      <form method="post" action="/app/languages/m/<?= e($m['id']) ?>/checkpoint/answer" style="display:grid;gap:16px">
        <?php foreach ($checkpoint['quiz'] as $qi => $item): ?>
          <div>
            <p style="font-weight:600"><?= (int) $qi + 1 ?>. <?= e($item['prompt']) ?> <span class="dim">(<?= e($item['skill']) ?>)</span></p>
            <?php foreach ($item['options'] as $i => $opt): ?>
              <label style="display:flex;gap:8px;align-items:center;margin:4px 0;cursor:pointer">
                <input type="radio" name="answers[<?= e($item['id']) ?>]" value="<?= (int) $i ?>" required style="accent-color:#0ea5e9">
                <span><?= e($opt) ?></span>
              </label>
            <?php endforeach; ?>
          </div>
        <?php endforeach; ?>
        <div><button class="btn primary">Submit checkpoint</button></div>
      </form>
    </div>
  </div>
<?php endif; ?>
