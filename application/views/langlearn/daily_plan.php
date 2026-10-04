<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head"><div><h2>Today’s plan</h2><p>Built from due reviews, your current module and measured weak areas. Done markers come from today’s activity only.</p></div></div>
<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>

<?php if (!empty($plan)): ?>
  <div class="panel">
    <h3>Plan for <?= e($plan['day']) ?> <span class="dim" style="font-weight:400">· ~<?= (int) $plan['estimatedMinutes'] ?> min</span></h3>
    <div class="body" style="padding-top:12px">
      <?php if (!empty($plan['basedOn'])): ?><p class="dim" style="font-size:11px">Based on: <?= e(implode(' · ', $plan['basedOn'])) ?></p><?php endif; ?>
      <?php foreach ($plan['blocks'] as $b): ?>
        <div class="notice <?= !empty($b['done']) ? 'ok' : 'warnbox' ?>" style="margin:6px 0">
          <?= !empty($b['done']) ? '✓' : '○' ?> <b><?= e($b['title']) ?></b> <span class="dim">(<?= (int) $b['minutes'] ?> min)</span>
          <div class="dim" style="font-size:11px">why: <?= e($b['why']) ?></div>
        </div>
      <?php endforeach; ?>
      <form method="post" action="/app/languages/d/<?= (int) $profileId ?>/regenerate"><button class="btn small">regenerate from current data</button></form>
    </div>
  </div>
<?php endif; ?>

<div class="grid cols-main" style="margin-top:14px">
  <div class="panel">
    <h3>Weakness detection</h3>
    <div class="body" style="padding-top:12px">
      <p class="dim" style="font-size:11px"><?= e($weaknesses['note'] ?? '') ?></p>
      <?php foreach (($weaknesses['weaknesses'] ?? []) as $w): ?>
        <div class="notice warnbox" style="margin:6px 0">
          <b><?= e($w['area']) ?></b> <span class="badge b-gray"><?= e($w['kind']) ?></span>
          <div class="dim" style="font-size:11px">evidence: <?= e(json_encode($w['evidence'])) ?></div>
        </div>
      <?php endforeach; ?>
      <?php if (empty($weaknesses['weaknesses'])): ?><p class="dim">No weaknesses detected.</p><?php endif; ?>
      <?php foreach (($weaknesses['strengths'] ?? []) as $s): ?>
        <div class="notice ok" style="margin:6px 0"><b><?= e($s['area']) ?></b> — avg <?= e((string) $s['evidence']['averagePct']) ?>% over <?= (int) $s['evidence']['attempts'] ?> attempts</div>
      <?php endforeach; ?>
    </div>
  </div>
  <div class="panel">
    <h3>AI recommendations</h3>
    <div class="body" style="padding-top:12px">
      <?php if (empty($recommendations)): ?><p class="dim">Nothing yet — recommendations appear from real activity.</p><?php endif; ?>
      <?php foreach ($recommendations as $r): ?>
        <div class="notice warnbox" style="margin:6px 0">
          <span class="badge b-gray"><?= e($r['kind']) ?></span> <?= e($r['message']) ?>
        </div>
      <?php endforeach; ?>
    </div>
  </div>
</div>

<?php if (!empty($mastery)): ?>
  <div class="panel" style="margin-top:14px">
    <h3>Mastery tracking <span class="dim" style="font-weight:400">(from real outcomes only)</span></h3>
    <div class="body scroll" style="padding-top:12px">
      <p class="dim" style="font-size:11px"><?= e($mastery['note']) ?> · mastered <?= (int) $mastery['counts']['mastered'] ?> · learning <?= (int) $mastery['counts']['learning'] ?> · weak <?= (int) $mastery['counts']['weak'] ?> · unseen <?= (int) $mastery['counts']['unseen'] ?></p>
      <table class="tbl">
        <thead><tr><th>Item</th><th>Skill</th><th>Level</th><th class="num">Attempts</th><th class="num">Correct</th><th>Mastery</th></tr></thead>
        <tbody>
          <?php foreach ($mastery['grammarAndItems'] as $m): ?>
            <tr>
              <td><?= e(mb_substr($m['prompt'], 0, 60)) ?></td>
              <td class="dim"><?= e($m['skill']) ?></td>
              <td class="dim"><?= e($m['level']) ?></td>
              <td class="num"><?= (int) $m['attempts'] ?></td>
              <td class="num"><?= (int) $m['correct'] ?></td>
              <td><span class="badge <?= ['mastered' => 'b-green', 'learning' => 'b-sky', 'weak' => 'b-red'][$m['mastery']] ?>"><?= e($m['mastery']) ?></span></td>
            </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>
  </div>
<?php endif; ?>
