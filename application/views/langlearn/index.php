<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head">
  <div>
    <h2>Language Learning</h2>
    <p>The AI teacher translates, listens and coaches from authored banks. Levels come from your answers — never invented scores.</p>
  </div>
  <div class="page-actions">
    <a class="btn primary" href="/app/languages/teacher">Start learning</a>
  </div>
</div>
<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>

<?php if (empty($user)): ?>
  <div class="panel">
    <h3>Sign in to keep progress</h3>
    <div class="body">
      <p class="dim">Language learning is per-user. Sign in to keep a separate path for every language you study.</p>
      <form method="post" action="/app/languages/login" class="inline" style="margin-top:12px">
        <label class="fld">Email <input class="sel" type="email" name="email" required placeholder="you@example.com"></label>
        <label class="fld">Password <input class="sel" type="password" name="password" required></label>
        <button class="btn primary">Sign in</button>
      </form>
    </div>
  </div>
<?php else: ?>
  <div class="panel">
    <h3>My languages</h3>
    <div class="body">
      <?php if (empty($myProfiles)): ?>
        <div class="empty-state">
          <p>You are not learning a language yet. Pick one from the catalog below.</p>
        </div>
      <?php else: ?>
        <table class="tbl">
          <thead><tr><th>Language</th><th>Level</th><th>Path</th><th>Streak</th><th class="num"></th></tr></thead>
          <tbody>
            <?php foreach ($myProfiles as $p): $pr = $p['progress']; ?>
              <tr>
                <td style="font-weight:700"><?= e(($p['language']['name'] ?? $p['language_code'])) ?> <span class="dim"><?= e($p['language']['native_name'] ?? '') ?></span></td>
                <td><span class="badge b-sky"><?= e($pr['level']) ?></span> <span class="dim" style="font-size:11px"><?= e($pr['levelSource']) ?></span></td>
                <td class="num"><?= $pr['pathCompletionPct'] !== null ? e(rtrim(rtrim(number_format($pr['pathCompletionPct'], 1), '0'), '.')) . '%' : '—' ?></td>
                <td class="num"><?= (int) $pr['studyStreakDays'] ?>d</td>
                <td class="num"><a class="btn small primary" href="/app/languages/p/<?= (int) $p['id'] ?>">Continue</a></td>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      <?php endif; ?>
    </div>
  </div>
<?php endif; ?>

<div class="panel" style="margin-top:16px">
  <h3>Language catalog</h3>
  <div class="body scroll">
    <table class="tbl">
      <thead><tr><th>Language</th><th>Native</th><th>ISO</th><th>Script</th><th>Dir</th><th>Assessment</th><th class="num"></th></tr></thead>
      <tbody>
        <?php foreach ($languages as $l): $feat = $l['features']; ?>
          <tr>
            <td style="font-weight:700"><?= e($l['name']) ?></td>
            <td><?= e($l['native_name']) ?></td>
            <td class="mono dim"><?= e($l['iso_code']) ?></td>
            <td class="dim"><?= e($l['writing_system']) ?></td>
            <td class="dim"><?= e(strtoupper($l['direction'])) ?></td>
            <td>
              <?php if (!empty($feat['adaptive_assessment'])): ?>
                <span class="badge b-green">adaptive · ceiling <?= e((string) ($feat['assessment_ceiling'] ?? 'A1')) ?></span>
              <?php else: ?>
                <span class="badge b-gray">registered — bank pending</span>
              <?php endif; ?>
            </td>
            <td class="num">
              <?php if (!empty($user)): ?>
                <form method="post" action="/app/languages/start" style="display:inline">
                  <input type="hidden" name="code" value="<?= e($l['code']) ?>">
                  <button class="btn small">Learn</button>
                </form>
              <?php endif; ?>
            </td>
          </tr>
        <?php endforeach; ?>
      </tbody>
    </table>
    <p class="dim" style="font-size:12px;margin-top:12px">Assessment levels stop at each language’s verified bank ceiling. Listening, speaking and writing are not assessed in this build and are never faked.</p>
  </div>
</div>
