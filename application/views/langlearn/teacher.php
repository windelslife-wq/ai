<?php defined('BASEPATH') or exit('No direct script access allowed');
/**
 * WINDELS AI WORKFORCE — AI Language Teacher
 *
 * Clean two-panel learning interface:
 *   LEFT  = "Language I'm Learning"  (the language the user wants to learn)
 *   RIGHT = "My Language"            (the language the user already speaks)
 *
 * Exactly ONE learning language (left) + ONE user language (right). The main
 * learning direction flows RIGHT → LEFT (your language → the language you are
 * learning), with reverse support (type in the learning language on the left
 * and see it explained/translated into your language on the right).
 *
 * @var array $languages @var array $locales @var string $csrfToken @var array $examplePairs
 */
$langOptions = [];
foreach ($languages as $l) {
    $langOptions[$l['code']] = $l['name'] . ($l['native_name'] ? ' — ' . $l['native_name'] : '');
}
$localeMap = $locales ?? [];
$flagMap = [
    'nl' => '🇳🇱', 'es' => '🇪🇸', 'it' => '🇮🇹', 'fr' => '🇫🇷', 'de' => '🇩🇪', 'en' => '🇬🇧',
    'pt' => '🇵🇹', 'ar' => '🇸🇦', 'zh' => '🇨🇳', 'ja' => '🇯🇵', 'ko' => '🇰🇷', 'ru' => '🇷🇺',
    'hi' => '🇮🇳', 'tr' => '🇹🇷', 'sw' => '🇰🇪', 'yo' => '🇳🇬', 'ig' => '🇳🇬', 'ha' => '🇳🇬',
    'af' => '🇿🇦', 'zu' => '🇿🇦',
];
?>
<style>
/* WINDELS AI WORKFORCE — AI Language Teacher (two-panel learning interface)
   Professional, responsive, balanced spacing, no overlap. */
.tt-header { display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px }
.tt-learn-banner { display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;background:var(--panel2);border:1px solid var(--line2);font-size:13px;flex-wrap:wrap }
.tt-learn-banner b { color:#fff }
.tt-learn-banner .badge { margin-left:6px }
.tt-modes { display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px }
.tt-mode { padding:6px 12px;border-radius:999px;border:1px solid var(--line2);background:var(--panel2);color:var(--muted);font-size:12px;font-weight:600;cursor:pointer;transition:border-color .15s,color .15s,background .15s }
.tt-mode:hover { border-color:var(--brand);color:#fff }
.tt-mode.active { background:var(--brand);border-color:var(--brand);color:#fff }

/* One learning language (left) + one user language (right) */
.tt-swapbar { display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; align-items: end; margin-bottom: 14px; }
.tt-side { display: grid; gap: 6px; min-width: 0; }
.tt-side > span { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); font-weight: 800; }
.tt-side select { width: 100%; font-weight: 700; }
.tt-side-learn { }
.tt-side-mine { }
.tt-swap-wrap { display: flex; flex-direction: column; align-items: center; gap: 5px; padding-bottom: 2px; }
.tt-swap { width: 42px; height: 42px; display: grid; place-items: center; border: 1px solid var(--line2); border-radius: var(--radius-sm); background: var(--panel2); color: var(--muted); cursor: pointer; transition: color .15s, border-color .15s, transform .2s; }
.tt-swap:hover { color: #fff; border-color: var(--brand); background: var(--brand-soft); }
.tt-swap:active { transform: rotate(180deg); }
.tt-swap svg { width: 18px; height: 18px; }
.tt-swap-label { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); font-weight: 700; }

.tt-panes { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
.tt-pane { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel2); padding: 14px; min-width: 0; display: grid; gap: 12px; }
.tt-pane-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 22px; }
.tt-pane-label { font-size: 12px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.tt-pane-label .tt-flag { font-size: 16px; margin-right: 4px; vertical-align: -2px; }
.tt-pane-sub { font-size: 11px; color: var(--dim); font-weight: 600; }

.tt-direction-hint { font-size: 11.5px; color: var(--sky); font-weight: 600; padding: 6px 10px; border: 1px dashed var(--line2); border-radius: 8px; background: var(--brand-soft); }
.tt-input { width: 100%; min-height: 96px; resize: vertical; background: #0b1119; color: var(--text); border: 1px solid var(--line2); border-radius: var(--radius-sm); padding: 10px 12px; font: inherit; font-size: 14px; line-height: 1.5; outline: none; }
.tt-input:focus { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
.tt-input.rtl { direction: rtl; text-align: right; }
.tt-input-label { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.tt-input-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; }
.tt-count { font-size: 11px; color: var(--dim); }

.tt-translation { font-size: clamp(18px, 2.6vw, 24px); font-weight: 700; color: #fff; line-height: 1.35; margin: 4px 0 2px; word-break: break-word; }
.tt-translation.rtl { direction: rtl; text-align: right; }
.tt-original { font-size: 12.5px; color: var(--muted); margin-top: 8px; word-break: break-word; }
.tt-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.tt-placeholder { color: var(--dim); font-size: 13px; padding: 22px 0; text-align: center; }
.tt-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
.tt-voices { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; margin-top: 10px; font-size: 12px; color: var(--muted); }
.tt-voices select, .tt-voices input[type=range] { background: var(--panel2); color: var(--text); border: 1px solid var(--line2); border-radius: 6px; }
.tt-voices select { padding: 4px 6px; }
.tt-rate { display: flex; align-items: center; gap: 6px; }
.tt-examples { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; align-items: center; }
.tt-examples > span { font-size: 11px; color: var(--dim); font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
.tt-example { border: 1px solid var(--line2); background: var(--panel2); color: var(--muted); border-radius: 999px; padding: 4px 11px; font-size: 11.5px; cursor: pointer; }
.tt-example:hover { border-color: var(--brand); color: #fff; text-decoration: none; }
.tt-practice { border-top: 1px solid var(--line); margin-top: 14px; padding-top: 12px; }
.tt-practice-head { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
.tt-fb { margin-top: 12px; padding: 12px; border-radius: 10px; border: 1px solid var(--line2); background: var(--panel2); font-size: 13px; }
.tt-fb.good { border-color: #34d39955; background: #34d39914; }
.tt-fb.warn { border-color: #fbbf2455; background: #fbbf2414; }
.tt-history { display: flex; flex-direction: column; gap: 6px; }
.tt-history .row { display: flex; justify-content: space-between; gap: 10px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel2); font-size: 12px; cursor: pointer; }
.tt-history .row:hover { border-color: var(--sky); }
.tt-loading { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--line2); border-top-color: var(--sky); border-radius: 50%; animation: ttspin .7s linear infinite; vertical-align: -2px; }
@keyframes ttspin { to { transform: rotate(360deg); } }
.tt-lesson { border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);padding:16px;margin-bottom:14px }
.tt-lesson h3 { margin:0 0 6px;font-size:13px }
.tt-lesson p { margin:0;color:var(--muted);font-size:12.5px }
.tt-explain { margin-top:10px;padding:10px 12px;border-radius:10px;background:var(--panel2);border:1px solid var(--line2);font-size:12.5px;color:var(--muted) }
.tt-explain b { color:var(--text) }
@media (max-width: 860px) { .tt-panes { grid-template-columns: 1fr; } }
@media (max-width: 600px) { .tt-swapbar { grid-template-columns: 1fr auto 1fr; gap: 6px; } .tt-side select { font-size: 12px; } }
</style>

<div class="page-head">
  <div>
    <h2>AI Language Teacher</h2>
    <p>One language you're learning on the left, your own language on the right. Type a sentence, hear the correct pronunciation, and keep going.</p>
  </div>
  <div class="page-actions">
    <a class="btn" href="/app/languages">My languages</a>
  </div>
</div>

<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>
<div class="notice warnbox" id="tts-note" style="display:none"></div>

<section class="panel">
  <h3>Session</h3>
  <div class="body">
    <div class="tt-header">
      <div class="tt-learn-banner" id="learn-banner">
        <span class="tt-flag" id="learn-banner-flag">🇳🇱</span>
        <span>Learning:</span> <b id="learn-banner-name">Dutch</b> <span class="badge b-sky" id="learn-banner-locale">nl-NL</span>
        <span style="margin-left:6px">←</span>
        <span>Your language:</span> <b id="mine-banner-name">English</b> <span class="badge b-violet" id="mine-banner-locale">en-GB</span>
      </div>
      <div class="page-actions">
        <button class="btn small" type="button" data-quick="nl">Dutch</button>
        <button class="btn small" type="button" data-quick="es">Spanish</button>
        <button class="btn small" type="button" data-quick="it">Italian</button>
        <button class="btn small" type="button" data-quick="ja">Japanese</button>
        <button class="btn small" type="button" data-quick="fr">French</button>
        <button class="btn small" type="button" data-quick="de">German</button>
      </div>
    </div>
    <div class="tt-modes" id="mode-selector" style="margin:12px 0 0">
      <button class="tt-mode active" data-mode="conversation">Conversation</button>
      <button class="tt-mode" data-mode="translation">Translation</button>
      <button class="tt-mode" data-mode="learning">Learning</button>
      <button class="tt-mode" data-mode="correction">Correction</button>
      <button class="tt-mode" data-mode="vocabulary">Vocabulary</button>
      <button class="tt-mode" data-mode="grammar">Grammar</button>
    </div>
    <div id="mode-desc" class="tt-explain">Conversation: type naturally in the language you're learning. If you type in your own language, you get a translation and an explanation — the language you're learning stays put.</div>
    <div class="tt-lesson" id="lesson-example" style="margin:12px 0 0;padding:12px">
      <h3 style="margin:0 0 6px;font-size:13px">Try this in <span id="lesson-target">Dutch</span></h3>
      <p style="margin:0">AI: <b id="lesson-ai">Hallo! Hoe gaat het met je?</b> <button class="btn small" type="button" id="lesson-listen">Listen</button></p>
      <div class="tt-explain" id="lesson-explain" style="margin-top:8px">Type in your language (right side) and the teacher translates it into the language you're learning (left side) — without switching it.</div>
    </div>
  </div>
</section>

<section class="panel" style="margin-top:16px">
  <h3>Translate &amp; learn</h3>
  <div class="body">

    <!-- Two-sided language selection:
         LEFT = language you're learning, RIGHT = your language (one each) -->
    <div class="tt-swapbar">
      <label class="tt-side tt-side-learn">
        <span>Language I'm Learning</span>
        <select id="tt-target" class="sel" aria-label="Language I'm Learning">
          <?php foreach ($langOptions as $code => $label): ?>
            <option value="<?= e($code) ?>" <?= $code === 'nl' ? 'selected' : '' ?>><?= e($flagMap[$code] ?? '') ?> <?= e($label) ?></option>
          <?php endforeach; ?>
        </select>
      </label>
      <div class="tt-swap-wrap">
        <button type="button" class="tt-swap" id="tt-swap" title="Swap languages" aria-label="Swap learning language with my language">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4 3 8l4 4"/><path d="M3 8h13a4 4 0 0 1 4 4"/><path d="m17 20 4-4-4-4"/><path d="M21 16H8a4 4 0 0 1-4-4"/></svg>
        </button>
        <span class="tt-swap-label">Swap</span>
      </div>
      <label class="tt-side tt-side-mine">
        <span>My Language</span>
        <select id="tt-source" class="sel" aria-label="My language">
          <?php foreach ($langOptions as $code => $label): ?>
            <option value="<?= e($code) ?>" <?= $code === 'en' ? 'selected' : '' ?>><?= e($flagMap[$code] ?? '') ?> <?= e($label) ?></option>
          <?php endforeach; ?>
        </select>
      </label>
    </div>

    <div class="tt-panes">
      <!-- ===== LEFT PANE — Language I'm Learning ===== -->
      <div class="tt-pane tt-pane-learn">
        <div class="tt-pane-head">
          <span class="tt-pane-label"><span class="tt-flag" id="tt-target-flag">🇳🇱</span> Language I'm Learning</span>
          <span class="badge b-sky" id="tt-target-pane-code">Dutch</span>
        </div>

        <div class="tt-direction-hint" id="tt-learn-hint">
          Your learning result appears here — in <b id="tt-learn-hint-lang">Dutch</b>. 🔊 Listen plays the correct pronunciation.
        </div>

        <!-- Learning result (produced from typing in your language on the right) -->
        <div id="tt-learn-result">
          <div id="tt-learn-placeholder" class="tt-placeholder">Translation / learning result — type in your language on the right.</div>
          <div id="tt-learn-result-body" hidden>
            <div class="tt-meta">
              <span class="badge b-violet" id="tt-mine-badge">From: —</span>
              <span class="badge b-sky" id="tt-learn-badge">To: —</span>
              <span class="badge b-gray" id="tt-learn-detect-badge">Detected: —</span>
              <span class="badge b-gray" id="tt-learn-method-badge" hidden></span>
            </div>
            <div class="tt-translation" id="tt-learn-translation" lang="" dir="ltr"></div>
            <div class="tt-original" id="tt-learn-original"></div>
            <div id="tt-learn-note" class="dim" style="margin-top:8px;font-size:12px"></div>

            <div class="tt-actions">
              <button class="btn primary" type="button" id="tt-play">🔊 Listen</button>
              <button class="btn" type="button" id="tt-stop" disabled>⏹ Stop</button>
              <button class="btn" type="button" id="tt-replay">↻ Replay</button>
            </div>
            <div class="tt-voices">
              <label style="display:flex;align-items:center;gap:6px">Voice
                <select id="tt-voice" disabled></select>
              </label>
              <label class="tt-rate">Speed
                <input id="tt-rate" type="range" min="0.5" max="1.5" step="0.1" value="1">
                <span id="tt-rate-val" style="width:28px">1.0×</span>
              </label>
              <span class="dim" style="font-size:11px">Locale: <b id="voice-locale">nl-NL</b> — learning language</span>
            </div>
            <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn small" type="button" data-speed="0.75">0.75x</button>
              <button class="btn small primary" type="button" data-speed="1">1x</button>
              <button class="btn small" type="button" data-speed="1.25">1.25x</button>
            </div>

            <div class="tt-practice">
              <div class="tt-practice-head">Practice speaking — real STT</div>
              <p class="dim" style="font-size:12px;margin:0 0 10px">Say the learning-language sentence aloud. Word accuracy only, never invented pronunciation scores.</p>
              <div class="notice warnbox" id="stt-note" style="display:none"></div>
              <div class="inline" style="flex-wrap:wrap;align-items:center">
                <button class="btn primary" type="button" id="tt-mic" disabled>🎤 Speak now</button>
                <input id="tt-transcript" class="sel" type="text" readonly placeholder="Transcript from your speech engine…" style="min-width:200px;flex:1">
                <button class="btn" type="button" id="tt-check" disabled>Check</button>
                <button class="btn" type="button" id="tt-retry" hidden>Try again</button>
              </div>
              <p class="dim" id="tt-mic-status" style="font-size:11px;margin:6px 0 0"></p>
              <div id="tt-feedback" class="tt-fb" hidden></div>
            </div>
          </div>
        </div>

        <!-- Reverse: type in the language you're learning (optional) -->
        <div class="tt-pane-input" id="tt-reverse-block">
          <span class="tt-input-label">Type in <b id="tt-target-rev-label">Dutch</b> (reverse)</span>
          <textarea id="tt-target-input" class="tt-input" maxlength="500" autocomplete="off" spellcheck="false" placeholder="e.g. Goedemorgen, hoe gaat het?"></textarea>
          <div class="tt-input-row">
            <span class="tt-count" id="tt-target-count">0 / 500</span>
            <button class="btn" type="button" id="tt-target-submit">Translate to my language</button>
          </div>
        </div>
      </div>

      <!-- ===== RIGHT PANE — My Language ===== -->
      <div class="tt-pane tt-pane-mine">
        <div class="tt-pane-head">
          <span class="tt-pane-label"><span class="tt-flag" id="tt-source-flag">🇬🇧</span> My Language</span>
          <span class="badge b-violet" id="tt-source-pane-code">English</span>
        </div>

        <div class="tt-direction-hint" id="tt-mine-hint">
          Type a sentence in <b id="tt-mine-hint-lang">English</b> and the learning language appears on the left.
        </div>

        <!-- Main input: your language -->
        <div class="tt-pane-input">
          <span class="tt-input-label">Type your sentence in <b id="tt-source-input-label">English</b></span>
          <textarea id="tt-input" class="tt-input" maxlength="500" autocomplete="off" spellcheck="false" placeholder="e.g. Good morning, how are you?"></textarea>
          <div class="tt-input-row">
            <span class="tt-count" id="tt-count">0 / 500</span>
            <button class="btn primary" type="button" id="tt-submit">Translate &amp; Learn</button>
          </div>
        </div>

        <!-- Reverse result: translation into your language (from left input) -->
        <div id="tt-my-result">
          <div id="tt-my-placeholder" class="tt-placeholder">Your translation into your language appears here.</div>
          <div id="tt-my-result-body" hidden>
            <div class="tt-meta">
              <span class="badge b-sky" id="tt-rev-source-badge">From: —</span>
              <span class="badge b-violet" id="tt-rev-target-badge">To: —</span>
              <span class="badge b-gray" id="tt-rev-method-badge" hidden></span>
            </div>
            <div class="tt-translation" id="tt-my-translation" lang="" dir="ltr"></div>
            <div class="tt-original" id="tt-my-original"></div>
            <div id="tt-my-note" class="dim" style="margin-top:8px;font-size:12px"></div>
            <div class="tt-actions">
              <button class="btn primary" type="button" id="tt-my-play">🔊 Listen</button>
              <button class="btn" type="button" id="tt-my-stop" disabled>⏹ Stop</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="tt-examples">
      <span>Try</span>
      <?php foreach ($examplePairs as $ex): ?>
        <button type="button" class="tt-example"
                data-text="<?= e($ex['text']) ?>"
                data-src="<?= e($ex['source'] ?? 'auto') ?>"
                data-target="<?= e($ex['target']) ?>"><?= e($ex['text']) ?></button>
      <?php endforeach; ?>
    </div>
  </div>
</section>

<section class="panel" id="tt-history-panel" hidden style="margin-top:16px">
  <h3>This session</h3>
  <div class="body scroll">
    <div class="tt-history" id="tt-history"></div>
    <p class="dim" style="font-size:12px;margin-top:10px">Tap a row to reload it. The learning language stays until you change it.</p>
  </div>
</section>

<section class="panel" style="margin-top:16px">
  <h3>Continue studying</h3>
  <div class="body">
    <?php $studyProfiles = $myProfiles ?? []; ?>
    <?php if (empty($studyProfiles)): ?>
      <p class="dim" style="font-size:13.5px;margin-bottom:12px">Structured practice lives on your language profile. Pick a language below to set up lessons, conversation, listening, speaking and vocabulary.</p>
      <div class="page-actions">
        <a class="btn primary" href="/app/languages">Choose a language to learn</a>
        <a class="btn" href="/app/languages/teacher">Back to the teacher</a>
      </div>
    <?php else: $sp = $studyProfiles[0]; $spId = (int) $sp['id']; ?>
      <p class="dim" style="font-size:13.5px;margin-bottom:12px">Continue with <b><?= e($sp['language']['name'] ?? $sp['language_code']) ?></b> — structured practice lives on your language profile.</p>
      <div class="page-actions">
        <a class="btn" href="/app/languages/p/<?= $spId ?>">My profile</a>
        <a class="btn" href="/app/languages/l/<?= $spId ?>">Listening</a>
        <a class="btn" href="/app/languages/s/<?= $spId ?>">Speaking</a>
        <a class="btn" href="/app/languages/v/<?= $spId ?>">Vocabulary</a>
        <a class="btn" href="/app/languages/conv/<?= $spId ?>">Conversation</a>
      </div>
    <?php endif; ?>
  </div>
</section>

<script src="/assets/js/speech-provider.js"></script>
<script>
(function () {
  'use strict';
  var CSRF = <?= json_encode((string) ($csrfToken ?? '')) ?>;
  var ENDPOINT = '/api/v1/language-learning/translate';
  var DETECT_ENDPOINT = '/api/v1/language-learning/detect';
  var LANG_NAMES = <?= json_encode(array_map(fn($l) => $l['name'], array_combine(array_column($languages, 'code'), $languages))) ?>;
  var LOCALES = <?= json_encode($localeMap) ?>;
  var RTL_LANGS = { ar: 1, he: 1, fa: 1, ur: 1 };
  var STORE_SRC = 'wl_lang_source';
  var STORE_TARGET = 'wl_lang_target';
  var STORE_MODE = 'wl_lang_mode';

  var input = document.getElementById('tt-input');            // my language (right)
  var targetInput = document.getElementById('tt-target-input'); // learning language (left)
  var sourceSel = document.getElementById('tt-source');       // my language select (right)
  var targetSel = document.getElementById('tt-target');       // learning select (left)
  var swapBtn = document.getElementById('tt-swap');
  var submitBtn = document.getElementById('tt-submit');
  var targetSubmitBtn = document.getElementById('tt-target-submit');
  var countEl = document.getElementById('tt-count');
  var targetCountEl = document.getElementById('tt-target-count');

  // Learning (left) result elements
  var learnPlaceholder = document.getElementById('tt-learn-placeholder');
  var learnBody = document.getElementById('tt-learn-result-body');
  var learnTransEl = document.getElementById('tt-learn-translation');
  var learnOrigEl = document.getElementById('tt-learn-original');
  var learnNoteEl = document.getElementById('tt-learn-note');

  // My-language (right) result elements
  var myPlaceholder = document.getElementById('tt-my-placeholder');
  var myBody = document.getElementById('tt-my-result-body');
  var myTransEl = document.getElementById('tt-my-translation');
  var myOrigEl = document.getElementById('tt-my-original');
  var myNoteEl = document.getElementById('tt-my-note');

  // Chrome labels
  var learnBannerName = document.getElementById('learn-banner-name');
  var learnBannerLocale = document.getElementById('learn-banner-locale');
  var learnBannerFlag = document.getElementById('learn-banner-flag');
  var mineBannerName = document.getElementById('mine-banner-name');
  var mineBannerLocale = document.getElementById('mine-banner-locale');
  var lessonTarget = document.getElementById('lesson-target');
  var lessonAi = document.getElementById('lesson-ai');
  var voiceLocaleEl = document.getElementById('voice-locale');
  var ttLearnFlag = document.getElementById('tt-target-flag');
  var ttSourceFlag = document.getElementById('tt-source-flag');
  var ttTargetPaneCode = document.getElementById('tt-target-pane-code');
  var ttSourcePaneCode = document.getElementById('tt-source-pane-code');
  var ttSourceInputLabel = document.getElementById('tt-source-input-label');
  var ttTargetRevLabel = document.getElementById('tt-target-rev-label');
  var ttLearnHintLang = document.getElementById('tt-learn-hint-lang');
  var ttMineHintLang = document.getElementById('tt-mine-hint-lang');

  var FLAGS = <?= json_encode($flagMap) ?>;

  var currentLearn = null; // translation into the learning language
  var currentMy = null;    // translation into my language
  var lastDetected = '';

  function flagFor(code) { return FLAGS[code] || '🌐'; }
  function langName(code) { return LANG_NAMES[code] || (code === 'auto' ? 'Auto-detect' : String(code).toUpperCase()); }
  function localeFor(code) { return LOCALES[code] || (code + '-' + code.toUpperCase()); }

  function remember() {
    try {
      sessionStorage.setItem(STORE_SRC, sourceSel.value);
      sessionStorage.setItem(STORE_TARGET, targetSel.value);
    } catch (e) {}
  }
  function recall() {
    try {
      var s = sessionStorage.getItem(STORE_SRC);
      var t = sessionStorage.getItem(STORE_TARGET);
      if (s !== null && sourceSel.querySelector('option[value="' + s + '"]')) sourceSel.value = s;
      if (t !== null && targetSel.querySelector('option[value="' + t + '"]')) targetSel.value = t;
    } catch (e) {}
  }

  function refreshChrome() {
    var learn = targetSel.value; // learning language
    var mine = sourceSel.value;  // my language
    learnBannerName.textContent = langName(learn);
    learnBannerLocale.textContent = localeFor(learn);
    learnBannerFlag.textContent = flagFor(learn);
    mineBannerName.textContent = langName(mine);
    mineBannerLocale.textContent = localeFor(mine);
    ttLearnFlag.textContent = flagFor(learn);
    ttSourceFlag.textContent = flagFor(mine);
    ttTargetPaneCode.textContent = langName(learn);
    ttSourcePaneCode.textContent = langName(mine);
    ttSourceInputLabel.textContent = langName(mine);
    ttTargetRevLabel.textContent = langName(learn);
    ttLearnHintLang.textContent = langName(learn);
    ttMineHintLang.textContent = langName(mine);
    lessonTarget.textContent = langName(learn);
    voiceLocaleEl.textContent = localeFor(learn);
    var examples = {
      nl: 'Hallo! Hoe gaat het met je?',
      es: '¡Hola! ¿Cómo estás?',
      it: 'Ciao! Come stai?',
      fr: 'Bonjour! Comment allez-vous?',
      de: 'Hallo! Wie geht es dir?',
      ja: 'こんにちは！お元気ですか？',
      en: 'Hello! How are you?'
    };
    lessonAi.textContent = examples[learn] || examples['nl'];
    var rtl = !!RTL_LANGS[mine];
    input.classList.toggle('rtl', rtl);
    input.dir = rtl ? 'rtl' : 'ltr';
    var rtl2 = !!RTL_LANGS[learn];
    targetInput.classList.toggle('rtl', rtl2);
    targetInput.dir = rtl2 ? 'rtl' : 'ltr';
    remember();
    if (window.windelsSpeech) populateVoices(localeFor(learn));
  }
  sourceSel.addEventListener('change', refreshChrome);
  targetSel.addEventListener('change', refreshChrome);

  // Quick switch buttons — set the LEARNING language only
  document.querySelectorAll('[data-quick]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var code = btn.getAttribute('data-quick');
      targetSel.value = code;
      refreshChrome();
    });
  });

  // Mode selector
  var modeDesc = document.getElementById('mode-desc');
  var modeMap = {
    conversation: 'Conversation Mode: Type naturally in the language you\'re learning. If you type in your own language, the AI translates it to the language you\'re learning + explains.',
    translation: 'Translation Mode: Type a sentence in your language, get the learning-language translation with Listen, explanation, and voice.',
    learning: 'Learning Mode: Structured lesson — teach → examples from verified bank → practice → grade → completion.',
    correction: 'Correction Mode: AI corrects your learning-language input, shows corrected version with explanation.',
    vocabulary: 'Vocabulary Mode: 10-word authored bank per language, SRS schedule 1→3→7→14→30→90 days, quizzes deterministic.',
    grammar: 'Grammar Mode: Grammar rules with on-demand simpler explanations.'
  };
  document.querySelectorAll('.tt-mode').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.querySelectorAll('.tt-mode').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      var mode = btn.getAttribute('data-mode');
      modeDesc.textContent = modeMap[mode] || '';
      try { sessionStorage.setItem(STORE_MODE, mode); } catch(e){}
    });
  });
  try {
    var savedMode = sessionStorage.getItem(STORE_MODE);
    if (savedMode && modeMap[savedMode]) {
      document.querySelectorAll('.tt-mode').forEach(b=>b.classList.remove('active'));
      var active = document.querySelector('.tt-mode[data-mode="' + savedMode + '"]');
      if (active) { active.classList.add('active'); modeDesc.textContent = modeMap[savedMode]; }
    }
  } catch(e){}

  // Swap learning <-> my language
  swapBtn.addEventListener('click', function () {
    var oldLearn = targetSel.value;
    var newLearn = sourceSel.value;
    var newMine = oldLearn;
    if (newLearn === newMine) newLearn = newLearn === 'en' ? 'nl' : 'en';
    targetSel.value = newLearn;
    sourceSel.value = newMine;
    refreshChrome();
    // Swap the two input texts so the flow stays intuitive
    var t = input.value; input.value = targetInput.value; targetInput.value = t;
    countEl.textContent = input.value.length + ' / 500';
    targetCountEl.textContent = targetInput.value.length + ' / 500';
    // Re-run the appropriate direction
    if (input.value.trim()) runMyToLearn(input.value.trim());
    else if (targetInput.value.trim()) runLearnToMy(targetInput.value.trim());
  });

  input.addEventListener('input', function () {
    countEl.textContent = input.value.length + ' / 500';
  });
  targetInput.addEventListener('input', function () {
    targetCountEl.textContent = targetInput.value.length + ' / 500';
  });

  submitBtn.addEventListener('click', function (ev) {
    ev.preventDefault();
    var text = input.value.trim();
    if (!text) { input.focus(); return; }
    runMyToLearn(text);
  });
  targetSubmitBtn.addEventListener('click', function (ev) {
    ev.preventDefault();
    var text = targetInput.value.trim();
    if (!text) { targetInput.focus(); return; }
    runLearnToMy(text);
  });
  input.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); submitBtn.click(); }
  });
  targetInput.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); targetSubmitBtn.click(); }
  });

  // ---------- SpeechProvider integration ----------
  var provider = window.windelsSpeech || (window.SpeechProvider ? new window.SpeechProvider() : null);
  var ttsNote = document.getElementById('tts-note');
  var playBtn = document.getElementById('tt-play');
  var stopBtn = document.getElementById('tt-stop');
  var replayBtn = document.getElementById('tt-replay');
  var myPlayBtn = document.getElementById('tt-my-play');
  var myStopBtn = document.getElementById('tt-my-stop');
  var voiceSel = document.getElementById('tt-voice');
  var rateSel = document.getElementById('tt-rate');
  var rateVal = document.getElementById('tt-rate-val');
  var lessonListen = document.getElementById('lesson-listen');

  function populateVoices(locale) {
    if (!provider) return false;
    var matches = provider.getVoicesForLocale(locale);
    voiceSel.innerHTML = '';
    if (!matches.length) {
      voiceSel.disabled = true;
      voiceSel.innerHTML = '<option>No voice for this language</option>';
      return false;
    }
    voiceSel.disabled = false;
    matches.forEach(function (v, i) {
      var o = document.createElement('option');
      o.value = i;
      o.textContent = v.name + ' (' + v.lang + ')';
      voiceSel.appendChild(o);
    });
    voiceSel._matches = matches;
    return true;
  }

  function speak(text, locale) {
    if (!provider || !text) return;
    var rate = parseFloat(rateSel.value) || 1;
    var voiceIdx = parseInt(voiceSel.value, 10);
    var voice = voiceSel._matches && voiceSel._matches[voiceIdx] ? voiceSel._matches[voiceIdx] : null;
    provider.textToSpeech(text, {
      locale: locale,
      voice: voice,
      rate: rate,
      onEnd: function() { playBtn.disabled = false; stopBtn.disabled = true; myStopBtn.disabled = true; },
      onError: function() { playBtn.disabled = false; stopBtn.disabled = true; myStopBtn.disabled = true; }
    });
    playBtn.disabled = true;
    stopBtn.disabled = false;
    myStopBtn.disabled = false;
  }

  if (provider) {
    var health = provider.healthCheck();
    if (!health.tts) {
      ttsNote.style.display = 'block';
      ttsNote.textContent = 'Text-to-speech not available in this browser. Translation still works — nothing is faked.';
      [playBtn, stopBtn, replayBtn, lessonListen, myPlayBtn, myStopBtn].forEach(function(b){ if(b) b.disabled = true; });
    } else {
      setTimeout(function(){ populateVoices(localeFor(targetSel.value)); }, 500);
      if (provider.synth) {
        provider.synth.onvoiceschanged = function(){ populateVoices(localeFor(targetSel.value)); };
      }
      playBtn.addEventListener('click', function () {
        if (currentLearn && currentLearn.translation) speak(currentLearn.translation, currentLearn.targetLocale || localeFor(targetSel.value));
      });
      replayBtn.addEventListener('click', function () {
        if (currentLearn && currentLearn.translation) speak(currentLearn.translation, currentLearn.targetLocale || localeFor(targetSel.value));
      });
      myPlayBtn.addEventListener('click', function () {
        if (currentMy && currentMy.translation) speak(currentMy.translation, currentMy.targetLocale || localeFor(sourceSel.value));
      });
      stopBtn.addEventListener('click', function () { provider.stop(); playBtn.disabled = false; stopBtn.disabled = true; myStopBtn.disabled = true; });
      myStopBtn.addEventListener('click', function () { provider.stop(); playBtn.disabled = false; stopBtn.disabled = true; myStopBtn.disabled = true; });
      if (lessonListen) {
        lessonListen.addEventListener('click', function(){ speak(lessonAi.textContent, localeFor(targetSel.value)); });
      }
      rateSel.addEventListener('input', function () { rateVal.textContent = (parseFloat(rateSel.value) || 1).toFixed(1) + '×'; });
      document.querySelectorAll('[data-speed]').forEach(function(btn){
        btn.addEventListener('click', function(){
          var sp = btn.getAttribute('data-speed');
          rateSel.value = sp;
          rateVal.textContent = parseFloat(sp).toFixed(1) + '×';
          document.querySelectorAll('[data-speed]').forEach(b=>b.classList.remove('primary'));
          btn.classList.add('primary');
        });
      });
    }
  }

  // STT via SpeechProvider (learning-language speaking practice)
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var sttNote = document.getElementById('stt-note');
  var micBtn = document.getElementById('tt-mic');
  var transcriptInput = document.getElementById('tt-transcript');
  var checkBtn = document.getElementById('tt-check');
  var retryBtn = document.getElementById('tt-retry');
  var micStatus = document.getElementById('tt-mic-status');
  var feedback = document.getElementById('tt-feedback');

  function syncMicState() {
    var canMic = !!(provider && provider.healthCheck().stt && currentLearn && currentLearn.translation);
    micBtn.disabled = !canMic;
    checkBtn.disabled = !(canMic && transcriptInput.value.trim());
  }

  if (!provider || !provider.healthCheck().stt) {
    sttNote.style.display = 'block';
    sttNote.textContent = 'Your browser does not expose speech recognition, so the microphone cannot capture your voice here. You can still Listen to the correct pronunciation and type the translation to self-check.';
  }

  micBtn.addEventListener('click', function () {
    if (!provider || !currentLearn || !currentLearn.translation) return;
    transcriptInput.value = '';
    micStatus.textContent = 'Listening… say the translation aloud.';
    provider.speechToText({
      locale: currentLearn.targetLocale || localeFor(targetSel.value),
      onResult: function(transcript){
        transcriptInput.value = transcript;
        micStatus.textContent = 'Transcript captured — review and Check.';
        syncMicState();
      },
      onError: function(ev){
        var msg = ev.error || ev.message || 'unknown';
        micStatus.textContent = 'Speech engine error: ' + msg + ' — nothing was recorded.';
      },
      onEnd: function(){
        if (micStatus.textContent === 'Listening… say the translation aloud.') micStatus.textContent = 'Nothing captured — try again.';
      }
    });
  });

  checkBtn.addEventListener('click', function () { grade(transcriptInput.value); });
  retryBtn.addEventListener('click', function () {
    transcriptInput.value = ''; feedback.hidden = true; retryBtn.hidden = true; micStatus.textContent = ''; syncMicState();
  });

  function grade(spoken) {
    if (!currentLearn || !currentLearn.translation) return;
    var expected = normalize(currentLearn.translation);
    var given = normalize(spoken || '');
    if (!given) { feedback.hidden = false; feedback.className = 'tt-fb warn'; feedback.textContent = 'Nothing to compare yet — speak or type first.'; return; }
    var expWords = expected.split(/\s+/).filter(Boolean);
    var gotWords = given.split(/\s+/).filter(Boolean);
    var matched = 0; var seen = expWords.slice();
    gotWords.forEach(function (w) { var i = seen.indexOf(w); if (i >= 0) { matched++; seen.splice(i, 1); } });
    var pct = expWords.length ? Math.round((matched / expWords.length) * 100) : 0;
    var exact = expected === given;
    feedback.hidden = false;
    feedback.className = 'tt-fb ' + (pct >= 80 ? 'good' : 'warn');
    feedback.innerHTML =
      '<b>Word accuracy: ' + pct + '%</b>' + (exact ? ' · exact match ✓' : ' · ' + matched + '/' + expWords.length + ' words matched') +
      '<div class="dim" style="margin-top:6px">Target: ' + escapeHtml(currentLearn.translation) + '</div>' +
      '<div class="dim">You said: ' + escapeHtml(spoken || '') + '</div>' +
      '<div class="dim" style="margin-top:6px;font-size:11px">Word accuracy compares the real speech-to-text transcript with the target. It is not a pronunciation or fluency score — those need a pronunciation-assessment provider that is not configured, and are never invented.</div>';
    retryBtn.hidden = false;
  }
  function normalize(s) { return (s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim(); }
  function escapeHtml(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  document.querySelectorAll('.tt-example').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var src = btn.getAttribute('data-src');
      var tgt = btn.getAttribute('data-target');
      sourceSel.value = src;
      targetSel.value = tgt;
      refreshChrome();
      input.value = btn.getAttribute('data-text');
      countEl.textContent = input.value.length + ' / 500';
      runMyToLearn(input.value);
    });
  });

  // Main direction: my language (right) -> learning language (left)
  function runMyToLearn(text) {
    lastOriginal = text;
    var payload = { text: text, target: targetSel.value };
    if (sourceSel.value !== 'auto') payload.source = sourceSel.value;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="tt-loading"></span> Translating…';
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().then(function (body) { if (!r.ok) throw new Error(body.error || 'Translation failed'); return body; });
    }).then(function (body) {
      renderLearn(body.translation, text);
    }).catch(function (err) {
      showError(err.message || 'The translator is unavailable.');
    }).finally(function () {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Translate & Learn';
    });
  }

  // Reverse direction: learning language (left) -> my language (right)
  function runLearnToMy(text) {
    var payload = { text: text, target: sourceSel.value, source: targetSel.value };
    targetSubmitBtn.disabled = true;
    targetSubmitBtn.innerHTML = '<span class="tt-loading"></span> Translating…';
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().then(function (body) { if (!r.ok) throw new Error(body.error || 'Translation failed'); return body; });
    }).then(function (body) {
      renderMy(body.translation, text);
    }).catch(function (err) {
      showError(err.message || 'The translator is unavailable.');
    }).finally(function () {
      targetSubmitBtn.disabled = false;
      targetSubmitBtn.textContent = 'Translate to my language';
    });
  }

  function renderLearn(t, originalText) {
    if (!t) { showError('The translator returned no result.'); return; }
    currentLearn = t;
    lastDetected = (t.detected && t.detected.code) ? t.detected.code : (t.source || lastDetected);
    learnPlaceholder.hidden = true;
    learnBody.hidden = false;

    document.getElementById('tt-mine-badge').textContent = 'From: ' + langName(t.source) + ' (your language)';
    document.getElementById('tt-learn-badge').textContent = 'To: ' + t.targetName + ' (learning)';
    document.getElementById('tt-learn-detect-badge').textContent = 'Detected: ' + (t.detected && t.detected.name ? t.detected.name + ' ' + Math.round(t.detected.confidence*100) + '%' : langName(t.source));
    var mBadge = document.getElementById('tt-learn-method-badge');
    if (t.method && t.method !== 'none' && t.method !== 'same-language') { mBadge.hidden = false; mBadge.textContent = t.method; } else { mBadge.hidden = true; }

    learnTransEl.textContent = t.translation || '(no fluent translation available)';
    var dir = RTL_LANGS[t.target] ? 'rtl' : 'ltr';
    learnTransEl.dir = dir; learnTransEl.lang = t.targetLocale || t.target;
    learnTransEl.classList.toggle('rtl', dir === 'rtl');

    learnOrigEl.innerHTML = '<b>You typed (your language):</b> ' + escapeHtml(originalText) +
      '<br><b>System:</b> Detected ' + escapeHtml(t.detected && t.detected.name ? t.detected.name : t.sourceName) +
      ' → Learning language: ' + escapeHtml(t.targetName);
    learnNoteEl.textContent = t.note || '';

    if (provider) {
      var ok = populateVoices(t.targetLocale || t.target);
      if (!ok) {
        ttsNote.style.display = 'block';
        ttsNote.textContent = 'No text-to-speech voice is installed for ' + t.targetName + ' in this browser, so playback is unavailable. The translation and grading still work — nothing is faked.';
        playBtn.disabled = true;
      } else {
        ttsNote.style.display = 'none';
        playBtn.disabled = false;
      }
      stopBtn.disabled = true;
    }

    transcriptInput.value = ''; feedback.hidden = true; retryBtn.hidden = true; micStatus.textContent = '';
    syncMicState();
    pushHistory(t, originalText, 'my');
  }

  function renderMy(t, originalText) {
    if (!t) { showError('The translator returned no result.'); return; }
    currentMy = t;
    myPlaceholder.hidden = true;
    myBody.hidden = false;

    document.getElementById('tt-rev-source-badge').textContent = 'From: ' + t.sourceName + ' (learning)';
    document.getElementById('tt-rev-target-badge').textContent = 'To: ' + t.targetName + ' (your language)';
    var mBadge = document.getElementById('tt-rev-method-badge');
    if (t.method && t.method !== 'none' && t.method !== 'same-language') { mBadge.hidden = false; mBadge.textContent = t.method; } else { mBadge.hidden = true; }

    myTransEl.textContent = t.translation || '(no fluent translation available)';
    var dir = RTL_LANGS[t.target] ? 'rtl' : 'ltr';
    myTransEl.dir = dir; myTransEl.lang = t.targetLocale || t.target;
    myTransEl.classList.toggle('rtl', dir === 'rtl');

    myOrigEl.innerHTML = '<b>You typed (learning language):</b> ' + escapeHtml(originalText) +
      '<br><b>System:</b> Detected ' + escapeHtml(t.detected && t.detected.name ? t.detected.name : t.sourceName) +
      ' → Your language: ' + escapeHtml(t.targetName);
    myNoteEl.textContent = t.note || '';
    pushHistory(t, originalText, 'learn');
  }

  function showError(msg) {
    ttsNote.style.display = 'block';
    ttsNote.className = 'notice warnbox';
    ttsNote.textContent = msg;
    ttsNote.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  var historyPanel = document.getElementById('tt-history-panel');
  var historyBox = document.getElementById('tt-history');
  function pushHistory(t, originalText, dir) {
    historyPanel.hidden = false;
    var row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<span><b>' + escapeHtml(originalText) + '</b> <span class="dim">→ ' + escapeHtml(t.translation || '—') + '</span></span><span class="dim">' + escapeHtml(t.targetName) + '</span>';
    row.addEventListener('click', function () {
      if (dir === 'my') {
        input.value = originalText;
        countEl.textContent = originalText.length + ' / 500';
        renderLearn(t, originalText);
      } else {
        targetInput.value = originalText;
        targetCountEl.textContent = originalText.length + ' / 500';
        renderMy(t, originalText);
      }
    });
    historyBox.prepend(row);
  }

  recall();
  refreshChrome();
  input.focus();
})();
</script>
