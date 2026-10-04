<?php defined('BASEPATH') or exit('No direct script access allowed');
$langCode = $view['languageCode'] ?? 'en';
$locale = \Aegis\LangLearn\Translator::LOCALES[$langCode] ?? 'en-GB';
?>
<div class="page-head"><div><h2>Conversation — <?= e($view['scenario'] ?? '') ?></h2><p>Correction mode: <?= e(str_replace('_', ' ', $view['correctionMode'] ?? '')) ?>. Listen to any turn in <?= e($locale) ?>.</p></div></div>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>
<?php if (!empty($view['aiOpens'])): ?><div class="panel"><div class="body"><b>AI:</b> <?= e($view['aiOpens']) ?> <button class="btn small" type="button" data-conv-listen="<?= e($view['aiOpens']) ?>">🔊 Listen</button></div></div><?php endif; ?>
<?php foreach (($view['history'] ?? []) as $h): ?>
  <div class="notice <?= $h['ok'] ? 'ok' : 'warnbox' ?>" style="margin:6px 0"><b>You:</b> <?= e($h['text']) ?> <button class="btn small" type="button" data-conv-listen="<?= e($h['text']) ?>">🔊 Listen</button> <?= $h['ok'] ? '✓' : '✗' ?></div>
<?php endforeach; ?>
<?php if (($view['status'] ?? '') === 'ACTIVE' && !empty($view['turn'])): ?>
  <?php if (!empty($view['lastFeedback']) && $view['lastFeedback'] !== null): $f = $view['lastFeedback']; ?>
    <div class="notice <?= $f['ok'] ? 'ok' : 'warnbox' ?>">
      <?php if ($f['ok']): ?>Good! <?php else: ?>Not quite — expected <?= e($f['expected'] ?? 'a different phrasing') ?>.<?php endif; ?>
      <?php if (!empty($f['example'])): ?><div class="dim">Try something like: <b><?= e($f['example']) ?></b> <button class="btn small" type="button" data-conv-listen="<?= e($f['example']) ?>">🔊 Listen</button></div><?php endif; ?>
    </div>
  <?php endif; ?>
  <div class="panel">
    <div class="body" style="padding-top:12px">
      <p style="font-weight:600">Turn <?= (int) $view['turn']['index'] ?>/<?= (int) $view['turn']['total'] ?>: <?= e($view['turn']['instruction']) ?> <button class="btn small" type="button" data-conv-listen="<?= e($view['turn']['instruction']) ?>">🔊 Listen</button></p>
      <form method="post" action="/app/languages/c/<?= e($view['sessionId']) ?>/say" class="inline" style="margin-top:8px">
        <input class="sel" type="text" name="text" required placeholder="Reply in the language… (auto-detected, target stays <?= e($langCode) ?>)" autocomplete="off" style="min-width:240px">
        <button class="btn primary">Say it</button>
      </form>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select class="sel" id="conv-voice"><option>Loading voices…</option></select>
        <input type="range" min="0.5" max="1.5" step="0.1" value="1" id="conv-rate" style="width:100px">
        <span id="conv-rate-val" class="dim" style="font-size:11px">1.0×</span>
        <button class="btn small" type="button" id="conv-stop">⏹ Stop</button>
      </div>
    </div>
  </div>
<?php elseif (($view['status'] ?? '') === 'COMPLETED'): ?>
  <?php $s = $view['summary']; ?>
  <div class="panel">
    <h3>Conversation complete — <?= (int) $s['scorePct'] ?>%</h3>
    <div class="body" style="padding-top:12px">
      <p><?= (int) $s['unassisted'] ?>/<?= (int) $s['turns'] ?> turns unassisted.</p>
      <?php foreach ($s['history'] as $h): ?>
        <div class="dim" style="margin:4px 0"><b>You:</b> <?= e($h['text']) ?> <button class="btn small" type="button" data-conv-listen="<?= e($h['text']) ?>">🔊</button> <?= $h['ok'] ? '✓' : '✗' ?></div>
      <?php endforeach; ?>
      <a class="btn primary" href="/app/languages" style="margin-top:10px">Back to My Languages</a>
    </div>
  </div>
<?php endif; ?>

<script src="/assets/js/speech-provider.js"></script>
<script>
(function(){
  var LOCALE = <?= json_encode($locale) ?>;
  var provider = window.windelsSpeech || (window.SpeechProvider ? new window.SpeechProvider() : null);
  var voiceSel = document.getElementById('conv-voice');
  var rateSel = document.getElementById('conv-rate');
  var rateVal = document.getElementById('conv-rate-val');
  var stopBtn = document.getElementById('conv-stop');

  function init(){
    if (!provider || !voiceSel) return;
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
    var btn = ev.target.closest('[data-conv-listen]');
    if (!btn || !provider) return;
    var text = btn.getAttribute('data-conv-listen');
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
