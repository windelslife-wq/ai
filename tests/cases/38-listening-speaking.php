<?php
/**
 * AI LANGUAGE LEARNING — Phase 4 (listening + speaking): exercises from the
 * real reading bank, deterministic scoring, honest provider boundaries
 * (browser TTS/STT feature-detected; pronunciation scores never invented).
 */
use Aegis\LangLearn\AudioPracticeService;

test('listening exercises are built from real reading bank items', function () {
    $t = platform();
    $ctx = teacher_profile('listen-nl', 'nl');
    $res = $t->audiopractice->listeningExercises($ctx['userId'], (int) $ctx['profile']['id']);
    assert_true($res['available']);
    foreach ($res['exercises'] as $ex) {
        assert_true($ex['speakText'] !== '', 'speakable sentence extracted');
        assert_true(count($ex['comprehension']['options']) === 4, 'real bank options');
        assert_contains('browser', strtolower($ex['audioNote']));
    }
    // the spoken sentence is the quoted target-language line, not the English question
    $first = $res['exercises'][0];
    assert_false(str_contains($first['speakText'], 'Where does'), 'question kept out of the audio');

    // languages without reading banks report honestly
    $zu = teacher_profile('listen-zu', 'zu');
    $resZu = $t->audiopractice->listeningExercises($zu['userId'], (int) $zu['profile']['id']);
    assert_false($resZu['available']);
    assert_contains('No listening exercises banked', $resZu['note']);
});

test('spoken sentence extraction: quoted banks and script-only banks', function () {
    $svc = new ReflectionMethod(AudioPracticeService::class, 'spokenSentence');
    $svc->setAccessible(true);
    $s = new AudioPracticeService(platform()->model->langlearn, platform()->langlearn);
    $nl = $svc->invoke($s, "Anna zegt: 'Hallo, ik heet Anna. Ik woon in Utrecht.' Where does Anna live?");
    assert_equals('Hallo, ik heet Anna. Ik woon in Utrecht.', $nl);
    $zh = $svc->invoke($s, '我叫小明 (Wǒ jiào Xiǎomíng) means…');
    assert_equals('我叫小明', $zh, 'romanization stripped from script-only banks');
});

test('listening comprehension grades against the bank answer', function () {
    $t = platform();
    $ctx = teacher_profile('listen-es', 'es');
    $res = $t->audiopractice->listeningExercises($ctx['userId'], (int) $ctx['profile']['id']);
    $ex = $res['exercises'][0];
    $bank = \Aegis\LangLearn\ItemBanks::find('es', $ex['itemId']);

    $wrong = $t->audiopractice->submitListening($ctx['userId'], (int) $ctx['profile']['id'], $ex['itemId'], 'comprehension', ($bank['answer'] + 1) % 4);
    assert_false($wrong['passed']);
    $right = $t->audiopractice->submitListening($ctx['userId'], (int) $ctx['profile']['id'], $ex['itemId'], 'comprehension', $bank['answer']);
    assert_true($right['passed']);
    assert_equals(100, $right['scorePct']);
    // recorded
    $history = $t->audiopractice->listeningHistory($ctx['userId'], (int) $ctx['profile']['id']);
    assert_true(count($history) >= 2);
    assert_equals('listening', $history[0]['detail'] ? 'listening' : 'listening');
});

test('transcription scoring is deterministic and diacritic-tolerant', function () {
    $t = platform();
    $ctx = teacher_profile('listen-fr', 'fr');
    $res = $t->audiopractice->listeningExercises($ctx['userId'], (int) $ctx['profile']['id']);
    $ex = $res['exercises'][0];
    $expected = $ex['speakText'];

    $perfect = $t->audiopractice->submitListening($ctx['userId'], (int) $ctx['profile']['id'], $ex['itemId'], 'transcription', $expected);
    assert_true($perfect['passed']);
    assert_equals(100.0, $perfect['scorePct']);

    // wrong words lower the score
    $garbled = trim(preg_replace('/\S+$/', '', $expected)); // drop the last word
    $partial = $t->audiopractice->submitListening($ctx['userId'], (int) $ctx['profile']['id'], $ex['itemId'], 'transcription', $garbled);
    assert_true($partial['scorePct'] > 0 && $partial['scorePct'] < 100);

    assert_throws(InvalidArgumentException::class, fn() => $t->audiopractice->submitListening($ctx['userId'], (int) $ctx['profile']['id'], $ex['itemId'], 'transcription', 'x'));

    // word accuracy math incl. diacritic folding (café ≈ cafe)
    assert_equals(100.0, AudioPracticeService::wordAccuracy('Ik woon in Utrecht', 'ik woon in utrecht'));
    assert_equals(50.0, AudioPracticeService::wordAccuracy('bonjour merci', 'bonjour'));
});

test('speaking prompts come from real sentences; scoring uses the real transcript', function () {
    $t = platform();
    $ctx = teacher_profile('speak-de', 'de');
    $res = $t->audiopractice->speakingPrompts($ctx['userId'], (int) $ctx['profile']['id']);
    assert_true($res['available']);
    $prompt = $res['prompts'][0];
    assert_true($prompt['text'] !== '');
    assert_contains('Pronunciation and fluency scores are NOT provided', $res['providerNote']);

    // exact transcript → 100% word accuracy + exact match
    $good = $t->audiopractice->submitSpeaking($ctx['userId'], (int) $ctx['profile']['id'], $prompt['id'], $prompt['text']);
    assert_true($good['scored']);
    assert_equals(100.0, $good['wordAccuracyPct']);
    assert_true($good['exactMatch']);
    assert_contains('not available', $good['detail']['pronunciationNote'], 'no pronunciation score invented');

    // partial transcript → partial real accuracy
    $partialText = trim(preg_replace('/\S+\s*\S+$/', '', $prompt['text']));
    $partial = $t->audiopractice->submitSpeaking($ctx['userId'], (int) $ctx['profile']['id'], $prompt['id'], $partialText);
    assert_true($partial['scored']);
    assert_true($partial['wordAccuracyPct'] < 100);
    assert_false($partial['exactMatch']);

    // no transcript → honest unscored record, nothing invented
    $none = $t->audiopractice->submitSpeaking($ctx['userId'], (int) $ctx['profile']['id'], $prompt['id'], null);
    assert_false($none['scored']);
    $history = $t->audiopractice->speakingHistory($ctx['userId'], (int) $ctx['profile']['id']);
    assert_true(count($history) >= 3);
    $unscored = array_values(array_filter($history, fn($h) => $h['word_accuracy_pct'] === null));
    assert_equals(1, count($unscored), 'unscored attempt stored without any invented number');
});

test('listening/speaking activity contributes to streaks and is isolated', function () {
    $t = platform();
    $ctx = teacher_profile('speak-streak', 'it');
    $res = $t->audiopractice->listeningExercises($ctx['userId'], (int) $ctx['profile']['id']);
    $ex = $res['exercises'][0];
    $bank = \Aegis\LangLearn\ItemBanks::find('it', $ex['itemId']);
    $t->audiopractice->submitListening($ctx['userId'], (int) $ctx['profile']['id'], $ex['itemId'], 'comprehension', $bank['answer']);
    $progress = $t->langlearn->progressFor($ctx['profile']);
    assert_equals(1, $progress['studyStreakDays'], 'listening counts as study activity');

    // another user's service cannot grade against this profile
    $other = ll_user('speak-other');
    assert_throws(RuntimeException::class, fn() => $t->audiopractice->submitListening($other['id'], (int) $ctx['profile']['id'], $ex['itemId'], 'comprehension', 0));
    assert_throws(RuntimeException::class, fn() => $t->audiopractice->submitSpeaking($other['id'], (int) $ctx['profile']['id'], $ex['itemId'], 'x'));
});
