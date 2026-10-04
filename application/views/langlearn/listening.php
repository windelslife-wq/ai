<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head"><div><h2>Listening practice</h2><p>Your browser speaks the sentence when a voice exists for this language. Replay, stop and speed stay honest — nothing is faked if audio is unavailable.</p></div></div>
<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>
<div class="notice warnbox" id="tts-support" style="display:none"></div>

<?php if (empty($listening['available'])): ?>
  <div class="panel"><div class="body"><p class="dim"><?= e($listening['note'] ?? 'Not available yet.') ?></p></div></div>
<?php else: foreach ($listening['exercises'] as $ex): ?>
  <div class="panel" style="margin-bottom:12px" data-exercise>
    <h3><?= e($ex['level']) ?> listening · <?= e(str_replace('-', '-', $ex['itemId'])) ?> <span class="badge b-sky"><?= e($langCode ?? 'en') ?> → <?= e(\Aegis\LangLearn\Translator::LOCALES[$langCode ?? 'en'] ?? $langCode) ?></span></h3>
    <div class="body" style="padding-top:12px">
      <p style="font-size:15px;font-weight:600"><?= e($ex['transcript']) ?> <button class="btn small" type="button" data-listen="<?= e($ex['speakText']) ?>">🔊 Listen</button></p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="btn small primary tts-play" data-say="<?= e($ex['speakText']) ?>" data-rate="1">▶ play (normal 1x)</button>
        <button class="btn small tts-play" data-say="<?= e($ex['speakText']) ?>" data-rate="0.7">▶ slow 0.75x</button>
        <button class="btn small tts-play" data-say="<?= e($ex['speakText']) ?>" data-rate="1.25">▶ fast 1.25x</button>
        <button class="btn small" type="button" id="tts-stop-<?= e($ex['itemId']) ?>">⏹ Stop</button>
        <button class="btn small" type="button" onclick="const d=this.closest('.body').querySelector('.transcript');d.style.display=d.style.display==='none'?'block':'none'">show transcript</button>
      </div>
      <div class="transcript dim" style="display:none;margin-top:8px"><?= e($ex['transcript']) ?> — <span class="dim">Locale: <?= e(\Aegis\LangLearn\Translator::LOCALES[$langCode ?? 'en'] ?? $langCode) ?></span></div>
      <div style="margin-top:8px;font-size:11px;color:var(--dim)">Voice: <select class="sel tts-voice" data-locale="<?= e(\Aegis\LangLearn\Translator::LOCALES[$langCode ?? 'en'] ?? $langCode) ?>"><option>Loading voices…</option></select> | Speed: <input type="range" min="0.5" max="1.5" step="0.1" value="1" class="tts-rate" style="width:100px"> <span class="tts-rate-val">1.0×</span></div>

      <form method="post" action="/app/languages/l/<?= (int) $profileId ?>/attempt" style="margin-top:12px">
        <input type="hidden" name="itemId" value="<?= e($ex['itemId']) ?>">
        <input type="hidden" name="mode" value="comprehension">
        <p style="font-weight:600"><?= e($ex['comprehension']['question']) ?></p>
        <?php foreach ($ex['comprehension']['options'] as $i => $opt): ?>
          <label style="display:flex;gap:8px;align-items:center;margin:4px 0;cursor:pointer">
            <input type="radio" name="answer" value="<?= (int) $i ?>" required style="accent-color:#0ea5e9"><span><?= e($opt) ?></span>
          </label>
        <?php endforeach; ?>
        <button class="btn small primary" style="margin-top:6px">answer</button>
      </form>

      <form method="post" action="/app/languages/l/<?= (int) $profileId ?>/attempt" style="margin-top:10px">
        <input type="hidden" name="itemId" value="<?= e($ex['itemId']) ?>">
        <input type="hidden" name="mode" value="transcription">
        <div class="inline">
          <input class="sel" type="text" name="transcript" required placeholder="Write what you heard… (word accuracy graded)" autocomplete="off">
          <button class="btn small">check transcription</button>
        </div>
      </form>
    </div>
  </div>
<?php endforeach; endif; ?>

<?php if (!empty($history)): ?>
  <div class="panel">
    <h3>Listening history</h3>
    <div class="body scroll" style="padding-top:12px">
      <table class="tbl">
        <thead><tr><th>At</th><th>Mode</th><th class="num">Score</th><th>Detail</th></tr></thead>
        <tbody>
          <?php foreach ($history as $h): ?>
            <tr>
              <td class="dim"><?= e(substr((string) $h['created_at'], 5, 14)) ?></td>
              <td><?= e($h['mode']) ?></td>
              <td class="num"><?= e((string) $h['score_pct']) ?>%</td>
              <td class="dim"><?= e(mb_substr(json_encode($h['detail']), 0, 80)) ?></td>
            </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>
  </div>
<?php endif; ?>

<script src="/assets/js/speech-provider.js"></script>
<script>
(function () {
  var LANG = <?= json_encode($langCode ?? 'en') ?>;
  var LOCALE = <?= json_encode(\Aegis\LangLearn\Translator::LOCALES[$langCode ?? 'en'] ?? 'en-US') ?>;
  var provider = window.windelsSpeech || (window.SpeechProvider ? new window.SpeechProvider() : null);

  function checkSupport() {
    if (!provider) return;
    var health = provider.healthCheck();
    var note = document.getElementById('tts-support');
    var voices = provider.getVoicesForLocale(LOCALE);
    document.querySelectorAll('.tts-play').forEach(function(btn){
      btn.disabled = !health.tts || voices.length === 0;
      if (!health.tts) btn.title = 'TTS unavailable';
      else if (voices.length === 0) btn.title = 'No voice for ' + LOCALE;
    });
    if (note) {
      if (!health.tts) { note.style.display='block'; note.textContent='Text-to-speech not available in this browser.'; }
      else if (voices.length===0) { note.style.display='block'; note.textContent='No voice installed for ' + LOCALE + ' in this browser — playback unavailable, exercises still work.'; }
      else note.style.display='none';
    }
    // Populate voice selectors
    document.querySelectorAll('.tts-voice').forEach(function(sel){
      var loc = sel.getAttribute('data-locale') || LOCALE;
      var vs = provider.getVoicesForLocale(loc);
      sel.innerHTML='';
      if (!vs.length) { sel.innerHTML='<option>No voice for '+loc+'</option>'; sel.disabled=true; return; }
      vs.forEach(function(v,i){ var o=document.createElement('option'); o.value=i; o.textContent=v.name+' ('+v.lang+')'; sel.appendChild(o); });
      sel._voices = vs;
      sel.disabled=false;
    });
  }

  document.addEventListener('DOMContentLoaded', function(){
    if (provider && provider.synth && provider.getSupportedVoices().length===0) {
      provider.synth.onvoiceschanged = checkSupport;
      setTimeout(checkSupport, 800);
    }
    checkSupport();
  });

  // Guard against duplicate delegation listeners: the app-shell re-runs this
  // inline script on every SPA navigation, and without a guard repeated
  // visits stack several handlers so one click triggers several TTS/STT calls.
  if (window.__windels_tt_listeners_bound) {
    // Script already bound this session; only re-initialize voice state.
    checkSupport();
    return;
  }
  window.__windels_tt_listeners_bound = true;

  document.addEventListener('click', function(ev){
    var btn = ev.target.closest('.tts-play');
    if (!btn || btn.disabled || !provider) return;
    var text = btn.getAttribute('data-say');
    var rate = parseFloat(btn.getAttribute('data-rate')) || 1;
    var panel = btn.closest('[data-exercise]');
    var voiceSel = panel ? panel.querySelector('.tts-voice') : null;
    var voice = null;
    if (voiceSel && voiceSel._voices) {
      var idx = parseInt(voiceSel.value,10);
      voice = voiceSel._voices[idx] || null;
    }
    var rateInput = panel ? panel.querySelector('.tts-rate') : null;
    if (rateInput) rate = parseFloat(rateInput.value) || rate;
    provider.textToSpeech(text, { locale: LOCALE, voice: voice, rate: rate });
  });

  document.addEventListener('click', function(ev){
    var btn = ev.target.closest('[data-listen]');
    if (!btn || !provider) return;
    provider.textToSpeech(btn.getAttribute('data-listen'), { locale: LOCALE, rate: 1 });
  });

  document.addEventListener('click', function(ev){
    if (ev.target.id && ev.target.id.startsWith('tts-stop-')) {
      if (provider) provider.stop();
    }
  });

  document.addEventListener('input', function(ev){
    if (ev.target.classList.contains('tts-rate')) {
      var val = parseFloat(ev.target.value) || 1;
      var label = ev.target.parentElement.querySelector('.tts-rate-val');
      if (label) label.textContent = val.toFixed(1)+'×';
    }
  });
})();
</script>
