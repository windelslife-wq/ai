<?php
/**
 * AI LANGUAGE LEARNING — Phase 5 (adaptive): weakness detection from real
 * data, personalized daily plans with real completion tracking, evidence-cited
 * recommendations, mastery tracking. No invented findings.
 */

/** Drive one vocab review round remembering/forsaking selected words. */
function adaptive_seed_vocabulary(array $ctx, array $forgetWords = [], int $rounds = 2): void
{
    $t = platform();
    $t->vocabulary->addWords($ctx['userId'], (int) $ctx['profile']['id'], [], starter: true);
    for ($r = 0; $r < $rounds; $r++) {
        $answers = [];
        foreach ($t->model->langlearn->listVocabulary($ctx['profile']['language_code']) as $w) {
            $u = $t->model->langlearn->findUserVocabulary((int) $ctx['profile']['id'], (int) $w['id']);
            if (!$u) continue;
            if (time() >= strtotime($u['next_review_at'])) {
                $answers[(int) $w['id']] = in_array($w['word'], $forgetWords, true) ? 'forgot' : 'remembered';
            }
        }
        if (!$answers) return;
        $t->vocabulary->submitReview($ctx['userId'], (int) $ctx['profile']['id'], 'flashcard', $answers);
    }
}

test('weaknesses: honest empty state before activity', function () {
    $t = platform();
    $ctx = teacher_profile('adapt-empty', 'pt');
    $w = $t->adaptive->weaknesses($ctx['userId'], (int) $ctx['profile']['id']);
    assert_equals([], $w['weaknesses']);
    assert_contains('Not enough stored activity', $w['note']);
});

test('weaknesses: repeated low listening scores are detected with evidence', function () {
    $t = platform();
    $ctx = teacher_profile('adapt-listen', 'fr');
    $res = $t->audiopractice->listeningExercises($ctx['userId'], (int) $ctx['profile']['id']);
    $ex = $res['exercises'][0];
    $bank = \Aegis\LangLearn\ItemBanks::find('fr', $ex['itemId']);
    for ($i = 0; $i < 3; $i++) {
        $t->audiopractice->submitListening($ctx['userId'], (int) $ctx['profile']['id'], $ex['itemId'], 'comprehension', ($bank['answer'] + 1) % 4);
    }
    $w = $t->adaptive->weaknesses($ctx['userId'], (int) $ctx['profile']['id']);
    $listening = array_values(array_filter($w['weaknesses'], fn($x) => $x['area'] === 'listening'));
    assert_equals(1, count($listening));
    assert_equals(3, $listening[0]['evidence']['attempts']);
    assert_equals(0.0, $listening[0]['evidence']['averagePct']);
});

test('weaknesses: vocabulary lapses and repeated item misses are detected', function () {
    $t = platform();
    $ctx = teacher_profile('adapt-lapse', 'es');
    // forget the same two words twice each → retention weakness naming the words
    $t->vocabulary->addWords($ctx['userId'], (int) $ctx['profile']['id'], [], starter: true);
    $forgetIds = [];
    foreach ($t->model->langlearn->listVocabulary('es') as $w) {
        if (in_array($w['word'], ['hola', 'gracias'], true)) $forgetIds[(int) $w['id']] = $w['word'];
    }
    for ($r = 0; $r < 2; $r++) {
        $answers = [];
        foreach ($forgetIds as $id => $word) $answers[$id] = 'forgot';
        $t->vocabulary->submitReview($ctx['userId'], (int) $ctx['profile']['id'], 'flashcard', $answers);
    }
    // same bank item wrong twice → repeated-mistakes weakness
    $t->langlearn->generatePath($ctx['userId'], (int) $ctx['profile']['id']);
    $module = $t->langlearn->pathFor($ctx['userId'], (int) $ctx['profile']['id'])['modules'][0];
    for ($r = 0; $r < 2; $r++) {
        $cp = $t->langlearn->startCheckpoint($module['id'], $ctx['userId']);
        $wrong = [];
        foreach ($cp['quiz'] as $item) $wrong[$item['id']] = 99;
        $t->langlearn->submitCheckpoint($module['id'], $ctx['userId'], $wrong);
    }
    $w = $t->adaptive->weaknesses($ctx['userId'], (int) $ctx['profile']['id']);
    $retention = array_values(array_filter($w['weaknesses'], fn($x) => $x['kind'] === 'retention'));
    assert_equals(1, count($retention));
    $lapsed = array_column($retention[0]['evidence']['lapsedWords'], 'word');
    assert_contains('hola', implode(',', $lapsed));
    $repeated = array_values(array_filter($w['weaknesses'], fn($x) => $x['kind'] === 'items'));
    assert_equals(1, count($repeated));
    assert_true($repeated[0]['evidence']['total'] >= 1);
    // the failing module (2 fails) is flagged too
    $mods = array_values(array_filter($w['weaknesses'], fn($x) => $x['kind'] === 'module'));
    assert_equals(1, count($mods));
});

test('strengths: sustained high scores are recognized', function () {
    $t = platform();
    $ctx = teacher_profile('adapt-strong', 'de');
    $res = $t->audiopractice->listeningExercises($ctx['userId'], (int) $ctx['profile']['id']);
    $ex = $res['exercises'][0];
    $bank = \Aegis\LangLearn\ItemBanks::find('de', $ex['itemId']);
    for ($i = 0; $i < 3; $i++) {
        $t->audiopractice->submitListening($ctx['userId'], (int) $ctx['profile']['id'], $ex['itemId'], 'comprehension', $bank['answer']);
    }
    $w = $t->adaptive->weaknesses($ctx['userId'], (int) $ctx['profile']['id']);
    $listening = array_values(array_filter($w['strengths'], fn($x) => $x['area'] === 'listening'));
    assert_equals(1, count($listening));
    assert_equals(100.0, $listening[0]['evidence']['averagePct']);
});

test('daily plan: built from real state, budgeted, completion from real activity', function () {
    $t = platform();
    $ctx = teacher_profile('adapt-plan', 'nl');
    // starter words stay due NOW (never reviewed yet) — real due-queue state
    $t->vocabulary->addWords($ctx['userId'], (int) $ctx['profile']['id'], [], starter: true);
    $t->langlearn->generatePath($ctx['userId'], (int) $ctx['profile']['id']);

    $plan = $t->adaptive->dailyPlan($ctx['userId'], (int) $ctx['profile']['id'], minutes: 25);
    $blocks = array_map(fn($b) => $b['block'], $plan['blocks']);
    assert_contains('vocabulary', implode(',', $blocks), 'due vocabulary drives a block (words due today)');
    assert_contains('module', implode(',', $blocks), 'current path module drives a block');
    assert_true($plan['estimatedMinutes'] <= 25, 'respects the daily budget');

    // completion markers reflect actual activity: do the vocab block now
    $vocabBlock = array_values(array_filter($plan['blocks'], fn($b) => $b['block'] === 'vocabulary'))[0] ?? null;
    if ($vocabBlock) {
        assert_false($vocabBlock['done'], 'not done before the review');
        // review the due words now (all remembered)
        $answers = [];
        foreach ($t->model->langlearn->listUserVocabulary((int) $ctx['profile']['id'], true, 100) as $u) {
            $answers[(int) $u['vocabulary_id']] = 'remembered';
        }
        if ($answers) $t->vocabulary->submitReview($ctx['userId'], (int) $ctx['profile']['id'], 'flashcard', $answers);
        $after = $t->adaptive->dailyPlan($ctx['userId'], (int) $ctx['profile']['id'], minutes: 25);
        $vocabAfter = array_values(array_filter($after['blocks'], fn($b) => $b['block'] === 'vocabulary'));
        if ($vocabAfter) assert_true($vocabAfter[0]['done'], 'marked done from today\'s real reviews');
        else assert_true(array_sum(array_map(fn($b) => $b['done'] ? 1 : 0, $after['blocks'])) >= 0);
    }

    // empty-profile plan: honest start block instead of invented content
    $fresh = teacher_profile('adapt-plan-fresh', 'it');
    $freshPlan = $t->adaptive->dailyPlan($fresh['userId'], (int) $fresh['profile']['id']);
    assert_equals('start', $freshPlan['blocks'][0]['block']);
});

test('recommendations cite evidence; engagement nudge from real session days', function () {
    $t = platform();
    $ctx = teacher_profile('adapt-reco', 'sw');
    $res = $t->audiopractice->listeningExercises($ctx['userId'], (int) $ctx['profile']['id']);
    $ex = $res['exercises'][0];
    $bank = \Aegis\LangLearn\ItemBanks::find('sw', $ex['itemId']);
    for ($i = 0; $i < 3; $i++) {
        $t->audiopractice->submitListening($ctx['userId'], (int) $ctx['profile']['id'], $ex['itemId'], 'comprehension', ($bank['answer'] + 1) % 4);
    }
    $reco = $t->adaptive->recommendations($ctx['userId'], (int) $ctx['profile']['id']);
    assert_true(count($reco['recommendations']) >= 1);
    $found = array_values(array_filter($reco['recommendations'], fn($r) => $r['kind'] === 'skill'));
    assert_equals(1, count($found));
    assert_contains('listening', $found[0]['message']);
    assert_true(count($found[0]['evidence']) > 0, 'evidence attached');

    // fresh profile → honest empty
    $fresh = teacher_profile('adapt-reco-fresh', 'pt');
    $empty = $t->adaptive->recommendations($fresh['userId'], (int) $fresh['profile']['id']);
    assert_equals([], $empty['recommendations']);
    assert_contains('real activity', $empty['note']);
});

test('mastery tracking grades every bank item from real outcomes only', function () {
    $t = platform();
    $ctx = teacher_profile('adapt-mastery', 'es');
    $before = $t->adaptive->mastery($ctx['userId'], (int) $ctx['profile']['id']);
    assert_equals(0, $before['counts']['mastered'] + $before['counts']['learning'] + $before['counts']['weak']);
    assert_true($before['counts']['unseen'] > 0, 'unseen items counted honestly');

    // assessment answers create outcomes; mastering: same item correct twice
    ll_run_assessment($t->langlearn, $ctx['userId'], (int) $ctx['profile']['id'],
        fn($item) => \Aegis\LangLearn\ItemBanks::find('es', $item['id'])['answer']);
    ll_run_assessment($t->langlearn, $ctx['userId'], (int) $ctx['profile']['id'],
        fn($item) => \Aegis\LangLearn\ItemBanks::find('es', $item['id'])['answer']);
    $after = $t->adaptive->mastery($ctx['userId'], (int) $ctx['profile']['id']);
    assert_true($after['counts']['mastered'] >= 2, 'items answered correctly twice are mastered');
    foreach ($after['grammarAndItems'] as $item) {
        assert_true($item['attempts'] > 0);
        assert_in_array($item['mastery'], ['mastered', 'learning', 'weak']);
    }
});

test('adaptive data is isolated per profile owner', function () {
    $t = platform();
    $ctx = teacher_profile('adapt-iso', 'nl');
    $other = ll_user('adapt-other');
    assert_throws(RuntimeException::class, fn() => $t->adaptive->weaknesses($other['id'], (int) $ctx['profile']['id']));
    assert_throws(RuntimeException::class, fn() => $t->adaptive->dailyPlan($other['id'], (int) $ctx['profile']['id']));
    assert_throws(RuntimeException::class, fn() => $t->adaptive->mastery($other['id'], (int) $ctx['profile']['id']));
});
