<?php
/**
 * AI LANGUAGE LEARNING — Phase 2 (AI Teacher): lessons, conversation drill,
 * writing correction, grammar help, lesson history.
 */

function teacher_profile(string $tag, string $lang = 'nl'): array
{
    $p = platform();
    $u = ll_user($tag);
    $profile = $p->langlearn->startLanguage($u['id'], $lang);
    return ['userId' => $u['id'], 'profile' => $profile];
}

test('lesson: teaches from the bank, then practice completes the module', function () {
    $t = platform();
    $ctx = teacher_profile('lesson');
    $t->langlearn->generatePath($ctx['userId'], (int) $ctx['profile']['id']);
    $modules = $t->langlearn->pathFor($ctx['userId'], (int) $ctx['profile']['id'])['modules'];

    $lesson = $t->langteacher->startLesson($modules[0]['id'], $ctx['userId']);
    assert_equals(2, count($lesson['lesson']['examples']), 'teaching examples from the bank');
    assert_true(count($lesson['lesson']['practiceItems']) >= 2);
    foreach ($lesson['lesson']['examples'] as $ex) {
        assert_true($ex['correct'] !== '' && $ex['why'] !== '', 'real content, not placeholders');
    }

    // wrong answers: lesson not passed, module stays open, honest feedback
    $wrong = [];
    foreach ($lesson['lesson']['practiceItems'] as $item) $wrong[$item['id']] = 99;
    $res = $t->langteacher->submitLesson($modules[0]['id'], $ctx['userId'], $wrong);
    assert_false($res['passed']);
    foreach ($res['outcomes'] as $o) assert_true($o['correct'] === false);

    // correct answers: completes the module, unlocks the next, records kind=lesson
    $lesson2 = $t->langteacher->startLesson($modules[0]['id'], $ctx['userId']);
    $good = [];
    foreach ($lesson2['lesson']['practiceItems'] as $item) $good[$item['id']] = \Aegis\LangLearn\ItemBanks::find('nl', $item['id'])['answer'];
    $res2 = $t->langteacher->submitLesson($modules[0]['id'], $ctx['userId'], $good);
    assert_true($res2['passed']);
    $after = $t->langlearn->pathFor($ctx['userId'], (int) $ctx['profile']['id'])['modules'];
    assert_equals('COMPLETED', $after[0]['status']);
    assert_equals('AVAILABLE', $after[1]['status']);
    $history = $t->langteacher->history($ctx['userId'], (int) $ctx['profile']['id']);
    $kinds = array_map(fn($a) => $a['kind'], $history['attempts']);
    assert_contains('lesson', implode(',', $kinds), 'lesson attempts recorded');
});

test('lesson: locked and completed modules refuse to start', function () {
    $t = platform();
    $ctx = teacher_profile('lesson-lock');
    $t->langlearn->generatePath($ctx['userId'], (int) $ctx['profile']['id']);
    $modules = $t->langlearn->pathFor($ctx['userId'], (int) $ctx['profile']['id'])['modules'];
    assert_throws(RuntimeException::class, fn() => $t->langteacher->startLesson($modules[1]['id'], $ctx['userId']));
});

test('conversation: structured drill with correction preferences', function () {
    $t = platform();
    $ctx = teacher_profile('conv', 'es');
    $scenarios = $t->langteacher->conversations($ctx['userId'], (int) $ctx['profile']['id']);
    assert_true(count($scenarios) >= 1);
    assert_contains('first-meeting', implode(',', array_map(fn($s) => $s['code'], $scenarios)));

    $s = $t->langteacher->startConversation($ctx['userId'], (int) $ctx['profile']['id'], 'first-meeting', 'immediate');
    assert_equals('ACTIVE', $s['status']);
    $sid = $s['sessionId'];

    // turn 1: wrong answer → immediate correction with expected element
    $r1 = $t->langteacher->conversationTurn($sid, $ctx['userId'], 'bonjour je suis ici');
    assert_false($r1['lastFeedback']['ok']);
    assert_not_null($r1['lastFeedback']['expected']);
    // one turn at a time: greet, name, well, thanks+goodbye
    $r2 = $t->langteacher->conversationTurn($sid, $ctx['userId'], '¡Buenos días!');
    assert_true($r2['lastFeedback']['ok']);
    $r3 = $t->langteacher->conversationTurn($sid, $ctx['userId'], 'Me llamo Ana');
    assert_true($r3['lastFeedback']['ok']);
    $r4 = $t->langteacher->conversationTurn($sid, $ctx['userId'], 'Estoy muy bien');
    assert_true($r4['lastFeedback']['ok']);
    $final = $t->langteacher->conversationTurn($sid, $ctx['userId'], 'Muchas gracias, adiós');
    assert_equals('COMPLETED', $final['status'], 'drill terminates');
    assert_true($final['summary']['scorePct'] >= 60);
    assert_true(count($final['summary']['history']) >= 4);

    // conversation recorded in history + study session (real activity)
    $history = $t->langteacher->history($ctx['userId'], (int) $ctx['profile']['id']);
    assert_contains('conversation', implode(',', array_map(fn($a) => $a['kind'], $history['attempts'])));

    // correction modes validated
    assert_throws(InvalidArgumentException::class, fn() => $t->langteacher->startConversation($ctx['userId'], (int) $ctx['profile']['id'], 'first-meeting', 'whenever'));
    // unsupported scenario honest refusal
    assert_throws(RuntimeException::class, fn() => $t->langteacher->startConversation($ctx['userId'], (int) $ctx['profile']['id'], 'space-station'));
});

test('conversation: two misses reveal the target and advance (assisted)', function () {
    $t = platform();
    $ctx = teacher_profile('conv-assist', 'de');
    $s = $t->langteacher->startConversation($ctx['userId'], (int) $ctx['profile']['id'], 'first-meeting', 'important');
    $sid = $s['sessionId'];
    $t->langteacher->conversationTurn($sid, $ctx['userId'], 'xyz');
    $r = $t->langteacher->conversationTurn($sid, $ctx['userId'], 'zyx');
    assert_true($r['assistedAdvance'], 'advances with the revealed example after two misses');
    assert_true($r['turn']['index'] === 2, 'moved to the next turn');
});

test('conversation: conversation_only mode never shows corrections', function () {
    $t = platform();
    $ctx = teacher_profile('conv-only', 'fr');
    $s = $t->langteacher->startConversation($ctx['userId'], (int) $ctx['profile']['id'], 'first-meeting', 'conversation_only');
    $sid = $s['sessionId'];
    $r = $t->langteacher->conversationTurn($sid, $ctx['userId'], 'je ne sais pas');
    assert_equals(null, $r['lastFeedback'], 'no corrections in conversation_only mode');
});

test('writing: element checks with the original text preserved', function () {
    $t = platform();
    $ctx = teacher_profile('writing', 'nl');
    $tasks = $t->langteacher->writingTasks($ctx['userId'], (int) $ctx['profile']['id']);
    assert_true(count($tasks) >= 2);

    // missing the name element → 50%, honest feedback, target patterns shown
    $res = $t->langteacher->submitWriting($ctx['userId'], (int) $ctx['profile']['id'], 'self-introduction', 'Hallo!');
    assert_equals(50, $res['attempt']['feedback']['scorePct']);
    $elements = $res['attempt']['feedback']['elements'];
    assert_false($elements[1]['met']);
    assert_true(count($elements[1]['targetPatterns']) > 0, 'shows what to aim for');

    // full attempt → 100% + bonus detection
    $res2 = $t->langteacher->submitWriting($ctx['userId'], (int) $ctx['profile']['id'], 'self-introduction', 'Goedemorgen! Ik heet Fatima. Ik kom uit Nigeria.');
    assert_equals(100, $res2['attempt']['feedback']['scorePct']);
    assert_contains('from', implode(',', $res2['attempt']['feedback']['bonusMet']) === '' ? 'Nigeria' : implode(',', $res2['attempt']['feedback']['bonusMet']), 'bonus element detected');

    // original text ALWAYS preserved verbatim
    $history = $t->langteacher->writingHistory($ctx['userId'], (int) $ctx['profile']['id']);
    $originals = array_map(fn($w) => $w['original_text'], $history);
    assert_contains('Hallo!', implode('||', $originals), 'first original stored unchanged');
    assert_contains('Goedemorgen! Ik heet Fatima. Ik kom uit Nigeria.', implode('||', $originals), 'second original stored unchanged');

    // guardrails
    assert_throws(InvalidArgumentException::class, fn() => $t->langteacher->submitWriting($ctx['userId'], (int) $ctx['profile']['id'], 'self-introduction', 'hi'));
    assert_throws(RuntimeException::class, fn() => $t->langteacher->submitWriting($ctx['userId'], (int) $ctx['profile']['id'], 'haiku-about-rain', 'Hallo!'));
});

test('grammar: rules from the bank + deterministic simpler explanation', function () {
    $t = platform();
    $ctx = teacher_profile('grammar', 'pt');
    $rules = $t->langteacher->grammarRules($ctx['userId'], (int) $ctx['profile']['id']);
    assert_true(count($rules) >= 3);
    foreach ($rules as $r) {
        assert_true($r['correctForm'] !== '', 'each rule shows the correct form');
    }
    $first = $rules[0];
    $simple = $t->langteacher->explainSimply($ctx['userId'], (int) $ctx['profile']['id'], $first['id']);
    assert_contains('Remember:', $simple['simple']['rule']);
    assert_contains('→', $simple['simple']['correctExample']);
    // non-grammar id refused
    $vocab = \Aegis\LangLearn\ItemBanks::items('pt');
    $vocabId = null;
    foreach ($vocab as $i) if ($i['skill'] === 'vocabulary') $vocabId = $i['id'];
    assert_throws(RuntimeException::class, fn() => $t->langteacher->explainSimply($ctx['userId'], (int) $ctx['profile']['id'], $vocabId));
});

test('every language with a bank gets teacher features or an honest refusal', function () {
    $t = platform();
    foreach (\Aegis\LangLearn\LanguageRegistry::all() as $code => $lang) {
        if ($code === 'xx') continue; // test-registered language
        $tasks = \Aegis\LangLearn\TeacherContent::writingTasks($code);
        $convos = \Aegis\LangLearn\TeacherContent::conversations($code);
        assert_true(count($tasks) >= 2, "{$code} has writing tasks");
        assert_true(count($convos) >= 1, "{$code} has at least the first-meeting drill");
        assert_true(count($lang['features'] ?? []) > 0);
    }
});
