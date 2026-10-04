<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head"><div><h2>Vocabulary</h2><p>Spaced repetition from a real word bank. Remembered words walk 1 → 3 → 7 → 14 → 30 → 90 days. Forgotten words return tomorrow.</p></div></div>
<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>

<?php if (!empty($progress)): ?>
  <div class="grid cols-main">
    <div class="panel">
      <h3>My vocabulary</h3>
      <div class="body" style="padding-top:12px">
        <table class="tbl">
          <tr><td class="dim">In list / bank</td><td><?= (int) $progress['inList'] ?> / <?= (int) $progress['bankSize'] ?></td></tr>
          <tr><td class="dim">Learned (stage ≥ 4)</td><td class="up"><?= (int) $progress['learned'] ?></td></tr>
          <tr><td class="dim">Learning</td><td><?= (int) $progress['learning'] ?></td></tr>
          <tr><td class="dim">Not yet studied</td><td><?= (int) $progress['notYetStudied'] ?></td></tr>
          <tr><td class="dim">Due now</td><td><b><?= (int) $progress['dueNow'] ?></b></td></tr>
          <tr><td class="dim">Average familiarity</td><td><?= e((string) $progress['averageFamiliarity']) ?> / 1.0</td></tr>
          <tr><td class="dim">Mastery</td><td><?= e((string) $progress['masteryPct']) ?>%</td></tr>
        </table>
      </div>
    </div>
    <div class="panel">
      <h3>Daily review</h3>
      <div class="body" style="padding-top:12px">
        <p><b><?= (int) $dueCount ?></b> word(s) due now.</p>
        <a class="btn primary" href="/app/languages/vr/<?= (int) $profileId ?>/quiz">Quiz review</a>
        <a class="btn" href="/app/languages/vr/<?= (int) $profileId ?>/flashcard">Flashcards</a>
        <p class="dim" style="font-size:10px;margin-top:8px">Word audio uses your browser's own speech synthesis when a voice exists for the language — no fake audio otherwise.</p>
      </div>
    </div>
  </div>
<?php endif; ?>

<div class="panel" style="margin-top:14px">
  <h3>Word bank — with voice <span class="badge b-sky"><?= e($locale ?? 'en-GB') ?></span></h3>
  <div class="body" style="padding-top:12px">
    <div class="notice warnbox" id="vocab-tts-note" style="display:none"></div>
    <form method="post" action="/app/languages/v/<?= (int) $profileId ?>/add" style="margin-bottom:10px">
      <input type="hidden" name="starter" value="1">
      <button class="btn small">add the starter pack (first 10 words)</button>
    </form>
    <form method="post" action="/app/languages/v/<?= (int) $profileId ?>/add">
      <table class="tbl">
        <thead><tr><th></th><th>Word</th><th>Translation</th><th>Pronunciation</th><th>Listen</th><th>Category</th><th>Level</th><th>Stage</th><th>Next review</th></tr></thead>
        <tbody>
          <?php foreach ($catalog as $w): ?>
            <tr>
              <td><input type="checkbox" name="vocabularyIds[]" value="<?= (int) $w['id'] ?>" <?= $w['inList'] ? 'disabled checked' : '' ?> style="accent-color:#0ea5e9"></td>
              <td style="font-weight:700"><?= e($w['word']) ?></td>
              <td><?= e($w['translation']) ?></td>
              <td class="dim"><?= e($w['pronunciation'] ?? '—') ?></td>
              <td><button class="btn small" type="button" data-vocab-listen="<?= e($w['word']) ?>">🔊 Listen</button></td>
              <td class="dim"><?= e($w['category']) ?></td>
              <td class="dim"><?= e($w['level']) ?></td>
              <td><?= $w['stage'] !== null ? (int) $w['stage'] : '—' ?></td>
              <td class="dim"><?= $w['nextReviewAt'] ? e(substr((string) $w['nextReviewAt'], 0, 10)) : '—' ?></td>
            </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
      <button class="btn small primary" style="margin-top:8px">add selected words</button>
    </form>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <span class="dim" style="font-size:11px">Voice controls:</span>
      <select class="sel" id="vocab-voice" style="min-width:180px"><option>Loading voices…</option></select>
      <input type="range" min="0.5" max="1.5" step="0.1" value="1" id="vocab-rate" style="width:100px">
      <span id="vocab-rate-val" class="dim" style="font-size:11px">1.0×</span>
      <button class="btn small" type="button" id="vocab-stop">⏹ Stop</button>
    </div>
  </div>
</div>

<script src="/assets/js/speech-provider.js"></script>
<script>
(function(){
  var LOCALE = <?= json_encode($locale ?? 'en-GB') ?>;
  var provider = window.windelsSpeech || (window.SpeechProvider ? new window.SpeechProvider() : null);
  var voiceSel = document.getElementById('vocab-voice');
  var rateSel = document.getElementById('vocab-rate');
  var rateVal = document.getElementById('vocab-rate-val');
  var stopBtn = document.getElementById('vocab-stop');
  var note = document.getElementById('vocab-tts-note');

  function init() {
    if (!provider) return;
    var health = provider.healthCheck();
    var voices = provider.getVoicesForLocale(LOCALE);
    if (!health.tts) { note.style.display='block'; note.textContent='TTS not available.'; return; }
    if (voices.length===0) { note.style.display='block'; note.textContent='No voice for '+LOCALE+' — playback unavailable.'; voiceSel.innerHTML='<option>No voice for '+LOCALE+'</option>'; voiceSel.disabled=true; return; }
    note.style.display='none';
    voiceSel.innerHTML='';
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
    var btn = ev.target.closest('[data-vocab-listen]');
    if (!btn || !provider) return;
    var text = btn.getAttribute('data-vocab-listen');
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
