<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head"><div><h2><?= e(ucfirst($review['mode'] ?? '')) ?> review</h2>
<p><?= $review['mode'] === 'flashcard' ? 'Self-assessed: reveal, then answer honestly — the schedule trusts your "forgot".' : 'Multiple choice, graded objectively against the bank.' ?></p></div></div>
<?php if (!empty($review['note'])): ?><div class="notice warnbox"><?= e($review['note']) ?></div><?php endif; ?>
<?php if (empty($review['cards'])): ?>
  <div class="panel"><div class="body"><p class="dim">Nothing to review right now.</p><a class="btn" href="/app/languages/v/<?= (int) $profileId ?>">back to vocabulary</a></div></div>
<?php else: ?>
  <form method="post" action="/app/languages/vr/<?= (int) $profileId ?>/<?= e($review['mode']) ?>/submit">
    <?php foreach ($review['cards'] as $i => $card): ?>
      <div class="panel" style="margin-bottom:10px">
        <div class="body" style="padding-top:12px">
          <div style="font-size:16px;font-weight:700"><?= e($card['word']) ?><?= $card['pronunciation'] ? ' <span class="dim" style="font-weight:400">(' . e($card['pronunciation']) . ')</span>' : '' ?></div>
          <?php if ($review['mode'] === 'quiz'): ?>
            <p class="dim" style="font-size:11px"><?= e($card['prompt'] ?? '') ?></p>
            <?php foreach (($card['options'] ?? []) as $oi => $opt): ?>
              <label style="display:flex;gap:8px;align-items:center;margin:4px 0;cursor:pointer">
                <input type="radio" name="answers[<?= (int) $card['vocabularyId'] ?>]" value="<?= (int) $oi ?>" required style="accent-color:#0ea5e9">
                <span><?= e($opt) ?></span>
              </label>
            <?php endforeach; ?>
          <?php else: ?>
            <details style="margin-top:8px"><summary style="cursor:pointer">reveal translation</summary>
              <div class="up" style="font-weight:700;margin-top:6px"><?= e($card['reveal']['translation'] ?? '') ?></div>
              <?php if (!empty($card['reveal']['example'])): ?><div class="dim"><?= e($card['reveal']['example']) ?></div><?php endif; ?>
            </details>
            <div style="margin-top:10px;display:flex;gap:8px">
              <label style="cursor:pointer"><input type="radio" name="answers[<?= (int) $card['vocabularyId'] ?>]" value="remembered" required style="accent-color:#0ea5e9"> remembered</label>
              <label style="cursor:pointer"><input type="radio" name="answers[<?= (int) $card['vocabularyId'] ?>]" value="forgot" style="accent-color:#ef4444"> forgot</label>
            </div>
          <?php endif; ?>
        </div>
      </div>
    <?php endforeach; ?>
    <button class="btn primary">Submit review</button>
  </form>
<?php endif; ?>
