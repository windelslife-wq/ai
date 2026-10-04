<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head">
  <div>
    <h2>AI Conversations</h2>
    <p>Structured drills in the language you are learning. Each turn expects a real reply. Free-form chat is not simulated.</p>
  </div>
</div>
<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>
<div class="panel">
  <h3>Start a conversation</h3>
  <div class="body">
    <?php if (empty($scenarios)): ?>
      <p class="dim">No conversation scenarios are available for this language yet.</p>
    <?php else: foreach ($scenarios as $s): ?>
      <form method="post" action="/app/languages/conv/<?= (int) $profileId ?>/start" class="inline" style="margin:10px 0;padding:12px 0;border-bottom:1px solid var(--line);width:100%">
        <input type="hidden" name="scenario" value="<?= e($s['code']) ?>">
        <label class="fld" style="flex:1;min-width:220px"><?= e($s['title']) ?> · <?= (int) $s['turns'] ?> turns
          <select name="correction" class="sel">
            <option value="important">Correct only important mistakes</option>
            <option value="immediate">Correct me immediately</option>
            <option value="after">Correct me after I finish</option>
            <option value="conversation_only">Conversation only</option>
          </select>
        </label>
        <button class="btn primary">Start conversation</button>
      </form>
    <?php endforeach; endif; ?>
  </div>
</div>
