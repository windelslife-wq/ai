<?php
/**
 * AI LANGUAGE LEARNING — Phase 3 (vocabulary): bank, SRS schedule, daily
 * reviews, quiz determinism, flashcard self-assessment, progress reality.
 */
use Aegis\LangLearn\VocabularyBank;
use Aegis\LangLearn\VocabularyService;

test('vocabulary bank: 10 authored words per registered language', function () {
    foreach (\Aegis\LangLearn\LanguageRegistry::all() as $code => $lang) {
        if ($code === 'xx') continue;
        $items = VocabularyBank::items($code);
        assert_true(count($items) >= 10, "{$code} has >= 10 words");
        foreach ($items as $w) {
            assert_true($w['word'] !== '' && $w['translation'] !== '');
            assert_true(in_array($w['category'], ['greetings', 'courtesy', 'numbers', 'people', 'places', 'food-drink', 'everyday', 'time', 'basics'], true));
        }
    }
});

test('bank syncs into the vocabulary table; example sentences only where genuinely available', function () {
    $t = platform();
    $ctx = teacher_profile('vocab-sync', 'nl');
    $n = $t->vocabulary->syncBank('nl');
    assert_true($n >= 10);
    $catalog = $t->vocabulary->catalog($ctx['userId'], (int) $ctx['profile']['id']);
    assert_true(count($catalog) >= 10);
    $hallo = null;
    foreach ($catalog as $w) if ($w['word'] === 'hallo') $hallo = $w;
    assert_not_null($hallo);
    assert_equals('Hallo, ik heet Anna.', $hallo['example_sentence'], 'real example attached to hallo');
    assert_equals(null, $hallo['pronunciation'], 'pronunciation not invented for Latin-script Dutch');
});

test('add words (idempotent) and starter pack', function () {
    $t = platform();
    $ctx = teacher_profile('vocab-add', 'es');
    $res = $t->vocabulary->addWords($ctx['userId'], (int) $ctx['profile']['id'], [], starter: true);
    assert_equals(10, $res['added']);
    $again = $t->vocabulary->addWords($ctx['userId'], (int) $ctx['profile']['id'], [], starter: true);
    assert_equals(0, $again['added'], 'no duplicates');
    // cross-language id refused
    $nl = $t->model->langlearn->listVocabulary('nl');
    $cross = $t->vocabulary->addWords($ctx['userId'], (int) $ctx['profile']['id'], [$nl[0]['id']]);
    assert_equals(0, $cross['added'], 'cannot add a Dutch word to a Spanish profile');
});

test('SRS schedule advances and resets correctly (full flow)', function () {
    $t = platform();
    $ctx = teacher_profile('vocab-srs2', 'de');
    $t->vocabulary->addWords($ctx['userId'], (int) $ctx['profile']['id'], [], starter: true);
    $due = $t->vocabulary->due($ctx['userId'], (int) $ctx['profile']['id']);
    $first = $due[0];
    $vid = null;
    foreach ($t->model->langlearn->listVocabulary('de') as $w) if ($w['word'] === $first['word']) $vid = (int) $w['id'];
    assert_not_null($vid);

    // remember → stage 1, next in 1 day
    $r = $t->vocabulary->submitReview($ctx['userId'], (int) $ctx['profile']['id'], 'flashcard', [$vid => 'remembered']);
    assert_equals('remembered', $r['results'][0]['result']);
    assert_equals(1, $r['results'][0]['stage']);
    assert_equals(1, $r['results'][0]['intervalDays']);
    // remember again → stage 2, 3 days
    $r = $t->vocabulary->submitReview($ctx['userId'], (int) $ctx['profile']['id'], 'flashcard', [$vid => 'remembered']);
    assert_equals(2, $r['results'][0]['stage']);
    assert_equals(3, $r['results'][0]['intervalDays']);
    // forget → reset to stage 0, tomorrow, lapse counted
    $r = $t->vocabulary->submitReview($ctx['userId'], (int) $ctx['profile']['id'], 'flashcard', [$vid => 'forgot']);
    assert_equals(0, $r['results'][0]['stage']);
    assert_equals(1, $r['results'][0]['intervalDays']);
    $row = $t->model->langlearn->findUserVocabulary((int) $ctx['profile']['id'], $vid);
    assert_equals(1, (int) $row['lapse_count']);
    assert_equals(3, (int) $row['review_count']);
    // due queue: after forgot, the word is due tomorrow (not now)
    $dueNow = array_map(fn($d) => $d['word'], $t->vocabulary->due($ctx['userId'], (int) $ctx['profile']['id']));
    assert_false(in_array($first['word'], $dueNow, true), 'forgotten word scheduled for tomorrow, not immediately');
});

test('quiz review is deterministic and graded against the same options', function () {
    $t = platform();
    $ctx = teacher_profile('vocab-quiz', 'fr');
    $t->vocabulary->addWords($ctx['userId'], (int) $ctx['profile']['id'], [], starter: true);
    $session = $t->vocabulary->startReview($ctx['userId'], (int) $ctx['profile']['id'], 'quiz', 5);
    assert_equals('quiz', $session['mode']);
    assert_true(count($session['cards']) > 0 && count($session['cards']) <= 5);
    $card = $session['cards'][0];
    assert_equals(4, count($card['options']), 'four options incl. real distractors');

    // same build twice → identical options + correctIndex
    $session2 = $t->vocabulary->startReview($ctx['userId'], (int) $ctx['profile']['id'], 'quiz', 5);
    assert_equals(json_encode($card['options']), json_encode($session2['cards'][0]['options']));

    // answer correctly using the card's own correctIndex → remembered
    $r = $t->vocabulary->submitReview($ctx['userId'], (int) $ctx['profile']['id'], 'quiz', [$card['vocabularyId'] => $card['correctIndex']]);
    assert_equals(1, $r['correct']);
    assert_equals('remembered', $r['results'][0]['result']);
    // wrong index → forgot path
    $wrongIdx = ($card['correctIndex'] + 1) % 4;
    // (word now scheduled ahead — re-review via a fresh card is not due; grade anyway by direct submit)
    $r2 = $t->vocabulary->submitReview($ctx['userId'], (int) $ctx['profile']['id'], 'quiz', [$card['vocabularyId'] => $wrongIdx]);
    assert_equals(0, $r2['correct']);
    assert_equals('forgot', $r2['results'][0]['result']);
});

test('vocabulary progress derives only from real reviews; sessions recorded', function () {
    $t = platform();
    $ctx = teacher_profile('vocab-prog', 'sw');
    $before = $t->vocabulary->progress($ctx['userId'], (int) $ctx['profile']['id']);
    assert_equals(0, $before['inList']);
    assert_equals(0.0, $before['averageFamiliarity']);

    $t->vocabulary->addWords($ctx['userId'], (int) $ctx['profile']['id'], [], starter: true);
    $afterAdd = $t->vocabulary->progress($ctx['userId'], (int) $ctx['profile']['id']);
    assert_equals(10, $afterAdd['inList']);
    assert_equals(10, $afterAdd['notYetStudied'], 'nothing studied yet — no fake familiarity');
    assert_equals(0.0, $afterAdd['averageFamiliarity']);

    $due = $t->vocabulary->due($ctx['userId'], (int) $ctx['profile']['id']);
    $answers = [];
    foreach (array_slice($due, 0, 4) as $d) {
        $vid = null;
        foreach ($t->model->langlearn->listVocabulary('sw') as $w) if ($w['word'] === $d['word']) $vid = (int) $w['id'];
        $answers[$vid] = 'remembered';
    }
    $t->vocabulary->submitReview($ctx['userId'], (int) $ctx['profile']['id'], 'flashcard', $answers);

    $after = $t->vocabulary->progress($ctx['userId'], (int) $ctx['profile']['id']);
    assert_equals(4, $after['learning']);
    assert_equals(6, $after['notYetStudied']);
    assert_close(0.08, $after['averageFamiliarity'], 0.01);
    assert_equals(6, $after['dueNow'], 'unreviewed words still due now');

    // review activity contributes to the study streak
    $progress = $t->langlearn->progressFor($ctx['profile']);
    assert_equals(1, $progress['studyStreakDays']);
    // and to lesson history
    $history = $t->langteacher->history($ctx['userId'], (int) $ctx['profile']['id']);
    assert_contains('vocab_review', implode(',', array_map(fn($a) => $a['kind'], $history['attempts'])));
});

test('review guards: bad mode and empty answers rejected', function () {
    $t = platform();
    $ctx = teacher_profile('vocab-guard', 'it');
    assert_throws(InvalidArgumentException::class, fn() => $t->vocabulary->startReview($ctx['userId'], (int) $ctx['profile']['id'], 'telepathy'));
    assert_throws(InvalidArgumentException::class, fn() => $t->vocabulary->submitReview($ctx['userId'], (int) $ctx['profile']['id'], 'quiz', []));
});
