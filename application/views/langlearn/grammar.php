<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head"><div><h2>Grammar</h2><p>Rules from this language's verified bank, each with the correct form. Ask for a simpler explanation any time.</p></div></div>
<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>
<div class="panel">
  <div class="body scroll" style="padding-top:12px">
    <?php if (empty($rules)): ?><p class="dim">No grammar rules banked for this language yet.</p><?php endif; ?>
    <?php foreach ($rules as $r): ?>
      <div style="border:1px solid var(--line);border-radius:8px;padding:12px;margin:8px 0">
        <div><span class="badge b-sky"><?= e($r['level']) ?></span> <b><?= e($r['question']) ?></b></div>
        <div class="up" style="margin-top:6px">✓ <?= e($r['correctForm']) ?></div>
        <div class="dim" style="font-size:11px;margin-top:4px"><?= e($r['rule']) ?></div>
        <form method="post" action="/app/languages/g/<?= (int) $profileId ?>/<?= e($r['id']) ?>/simple" style="margin-top:8px">
          <button class="btn small">explain it more simply</button>
        </form>
      </div>
    <?php endforeach; ?>
  </div>
</div>
