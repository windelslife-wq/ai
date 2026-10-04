<?php defined('BASEPATH') or exit('No direct script access allowed');
$profile = $lessonView['module'] ?? null;
$langCode = $profile['language_code'] ?? 'en';
$locale = \Aegis\LangLearn\Translator::LOCALES[$langCode] ?? 'en-GB';
?>
<div class="page-head"><div><h2>Lesson</h2><p>Explanation, examples you can listen to, then practice. Completing the practice at 75% or more finishes the module.</p></div></div>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>
<?php if (!empty($lessonView)): $L = $lessonView['lesson']; ?>
  <div class="panel">
    <h3><?= e($L['title']) ?> <span class="badge b-sky"><?= e($locale) ?></span></h3>
    <div class="body" style="padding-top:12px">
      <p class="dim">Goal: <?= e($L['goal']) ?></p>
      <p><?= e($L['teach']) ?></p>
      <h4 style="margin-top:12px">Examples — listen to each</h4>
      <?php foreach ($L['examples'] as $ex): ?>
        <div style="background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px;margin:6px 0">
          <div><?= e($ex['prompt']) ?> <button class="btn small" type="button" data-lesson-listen="<?= e($ex['prompt']) ?>">🔊 Listen</button></div>
          <div class="up" style="font-weight:700;margin-top:4px"><?= e($ex['correct']) ?> <button class="btn small" type="button" data-lesson-listen="<?= e($ex['correct']) ?>">🔊 Listen</button></div>
          <div class="dim" style="font-size:11px"><?= e($ex['why']) ?></div>
        </div>
      <?php endforeach; ?>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span class="dim" style="font-size:11px">Voice:</span>
        <select class="sel" id="lesson-voice"><option>Loading…</option></select>
        <input type="range" min="0.5" max="1.5" step="0.1" value="1" id="lesson-rate" style="width:100px">
        <span id="lesson-rate-val" class="dim" style="font-size:11px">1.0×</span>
        <button class="btn small" type="button" id="lesson-stop">⏹ Stop</button>
      </div>
    </div>
  </div>
  <div class="panel" style="margin-top:14px">
    <h3>Practice (pass ≥ <?= (int) $L['passMarkPct'] ?>%)</h3>
    <div class="body" style="padding-top:12px">
      <form method="post" action="/app/languages/m/<?= e($lessonView['module']['id']) ?>/lesson/answer" style="display:grid;gap:16px">
        <?php foreach ($L['practiceItems'] as $qi => $item): ?>
          <div>
            <p style="font-weight:600"><?= (int) $qi + 1 ?>. <?= e($item['prompt']) ?> <span class="dim">(<?= e($item['skill']) ?>)</span> <button class="btn small" type="button" data-lesson-listen="<?= e($item['prompt']) ?>">🔊 Listen</button></p>
            <?php foreach ($item['options'] as $i => $opt): ?>
              <label style="display:flex;gap:8px;align-items:center;margin:4px 0;cursor:pointer">
                <input type="radio" name="answers[<?= e($item['id']) ?>]" value="<?= (int) $i ?>" required style="accent-color:#0ea5e9">
                <span><?= e($opt) ?></span> <button class="btn small" type="button" data-lesson-listen="<?= e($opt) ?>">🔊</button>
              </label>
            <?php endforeach; ?>
          </div>
        <?php endforeach; ?>
        <div><button class="btn primary">Submit lesson</button></div>
      </form>
    </div>
  </div>

<script src="/assets/js/speech-provider.js"></script>
<script>
(function(){
  var LOCALE = <?= json_encode($locale) ?>;
  var provider = window.windelsSpeech || (window.SpeechProvider ? new window.SpeechProvider() : null);
  var voiceSel = document.getElementById('lesson-voice');
  var rateSel = document.getElementById('lesson-rate');
  var rateVal = document.getElementById('lesson-rate-val');
  var stopBtn = document.getElementById('lesson-stop');

  function init(){
    if (!provider) return;
    var voices = provider.getVoicesForLocale(LOCALE);
    voiceSel.innerHTML='';
    if (!voices.length) { voiceSel.innerHTML='<option>No voice for '+LOCALE+'</option>'; voiceSel.disabled=true; return; }
    voices.forEach(function(v,i){ var o=document.createElement('option'); o.value=i; o.textContent=v.name+' ('+v.lang+')'; voiceSel.appendChild(o); });
    voiceSel._voices = voices;
    voiceSel.disabled=false;
  }

  document.addEventListener('DOMContentLoaded', function(){
    if (provider && provider.synth && provider.getSupportedVoices().length===0) {
      provider.synth.onvoiceschanged = init;
      setTimeout(init, 800);
    }
    init();
  });

  document.addEventListener('click', function(ev){
    var btn = ev.target.closest('[data-lesson-listen]');
    if (!btn || !provider) return;
    var text = btn.getAttribute('data-lesson-listen');
    var voice = null;
    if (voiceSel && voiceSel._voices) {
      var idx = parseInt(voiceSel.value,10);
      voice = voiceSel._voices[idx] || null;
    }
    var rate = rateSel ? parseFloat(rateSel.value) || 1 : 1;
    provider.textToSpeech(text, { locale: LOCALE, voice: voice, rate: rate });
  });

  if (stopBtn) stopBtn.addEventListener('click', function(){ if(provider) provider.stop(); });
  if (rateSel) rateSel.addEventListener('input', function(){ if(rateVal) rateVal.textContent = (parseFloat(rateSel.value)||1).toFixed(1)+'×'; });
})();
</script>
<?php endif; ?>
