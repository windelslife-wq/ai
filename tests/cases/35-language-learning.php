<?php
/**
 * AI LANGUAGE LEARNING — Phase 1: registry, profiles, adaptive assessment,
 * level detection, learning paths and real progress storage.
 */
use Aegis\LangLearn\LangLearnService;
use Aegis\LangLearn\LanguageRegistry;

function ll_user(string $tag): array
{
    $p = platform();
    $email = "ll-{$tag}-" . uniqid() . '@example.com';
    $now = gmdate('c');
    $user = $p->model->identity->createUser(['email' => $email, 'password_hash' => password_hash('long-password-123456', PASSWORD_DEFAULT), 'display_name' => "LL {$tag}", 'active' => 1, 'created_at' => $now, 'updated_at' => $now]);
    return ['id' => (int) $user['id'], 'email' => $email];
}

/** Drive an assessment to completion: pickOption($item) returns the answer index. */
function ll_run_assessment(LangLearnService $svc, int $userId, int $profileId, callable $pickOption): array
{
    $res = $svc->startAssessment($userId, $profileId);
    $guard = 0;
    while (($res['status'] ?? '') === 'IN_PROGRESS' && $guard++ < 60) {
        $item = $res['item'];
        $res = $svc->answerAssessment($res['assessmentId'], $userId, $pickOption($item));
    }
    assert_equals('COMPLETED', $res['status'], 'assessment must terminate');
    return $res['result'];
}

test('registry: 20 languages with metadata, no hard-coding needed elsewhere', function () {
    $all = LanguageRegistry::all();
    foreach (['nl', 'es', 'it', 'fr', 'de', 'en', 'pt', 'ar', 'zh', 'ja', 'ko', 'ru', 'hi', 'tr', 'sw', 'yo', 'ig', 'ha', 'af', 'zu'] as $code) {
        assert_true(isset($all[$code]), "registry contains {$code}");
    }
    assert_equals('Arabic', $all['ar']['name']);
    assert_equals('rtl', $all['ar']['direction']);
    assert_equals('ltr', $all['zu']['direction']);
    assert_equals('Yorùbá', $all['yo']['native_name']);
    // expandable at runtime
    LanguageRegistry::register(['code' => 'xx', 'name' => 'Test Language', 'native_name' => 'Test', 'iso_code' => 'xx', 'writing_system' => 'latin', 'direction' => 'ltr']);
    assert_not_null(LanguageRegistry::get('xx'));
    // every registered language exposes an honest feature table
    foreach (LanguageRegistry::all() as $lang) {
        assert_true(is_array($lang['features']));
        assert_false($lang['features']['listening'], 'no language may claim listening in Phase 1');
        assert_false($lang['features']['speaking'], 'no language may claim speaking in Phase 1');
    }
});

test('registry syncs into the languages table (idempotent)', function () {
    $svc = platform()->langlearn;
    $svc->syncRegistry();
    $rows = $svc->languages();
    assert_true(count($rows) >= 20);
    $svc->syncRegistry(); // idempotent
    assert_true(count($svc->languages()) === count($rows));
    foreach ($rows as $row) {
        assert_true(is_array($row['features']), 'features decoded for the API/UI');
    }
});

test('profiles: one per language per user, independent, isolated between users', function () {
    $svc = platform()->langlearn;
    $a = ll_user('iso-a');
    $b = ll_user('iso-b');
    $nl = $svc->startLanguage($a['id'], 'nl', 'Daily conversation in Amsterdam');
    $es = $svc->startLanguage($a['id'], 'es');
    $sw = $svc->startLanguage($a['id'], 'sw');
    assert_true($nl['id'] > 0 && $es['id'] > 0 && $sw['id'] > 0);
    assert_equals(3, count($svc->profiles($a['id'])));
    // duplicate start returns the same profile
    $again = $svc->startLanguage($a['id'], 'nl');
    assert_equals($nl['id'], $again['id']);
    // isolation: user B cannot read or use user A's profile
    $foreign = $svc->startLanguage($b['id'], 'nl');
    assert_throws(RuntimeException::class, fn() => $svc->profileOwned($nl['id'], $b['id']));
    assert_true($nl['id'] !== $foreign['id'], 'separate users get separate profiles');
    // invalid language rejected
    assert_throws(InvalidArgumentException::class, fn() => $svc->startLanguage($a['id'], 'qq'));
});

test('assessment: all wrong answers → Beginner; levels come only from answers', function () {
    $svc = platform()->langlearn;
    $u = ll_user('asm-zero');
    $profile = $svc->startLanguage($u['id'], 'es');
    $result = ll_run_assessment($svc, $u['id'], (int) $profile['id'], fn($item) => ($item['options'][0] === 'never-this' ? 1 : 3));
    assert_equals('Beginner', $result['overallLevel']);
    // profile level unchanged source: level only set by assessment — it IS the assessment here
    $stored = $svc->profileOwned((int) $profile['id'], $u['id']);
    assert_equals('Beginner', $stored['level']);
});

test('assessment: strong answers yield a verifiable level and per-skill detail', function () {
    $svc = platform()->langlearn;
    $u = ll_user('asm-strong');
    $profile = $svc->startLanguage($u['id'], 'nl');
    // Answer correctly using the bank (simulates a capable learner — the engine
    // only sees the answer indexes, exactly like the real UI).
    $result = ll_run_assessment($svc, $u['id'], (int) $profile['id'], function ($item) {
        $bank = \Aegis\LangLearn\ItemBanks::find('nl', $item['id']);
        return $bank['answer'];
    });
    // Core Dutch bank covers A1/A2 (+B1 probe): a perfect run must land at/above A1
    assert_true(\Aegis\LangLearn\LanguageRegistry::levelIndex($result['overallLevel']) >= \Aegis\LangLearn\LanguageRegistry::levelIndex('A1'), 'level from real answers: ' . $result['overallLevel']);
    assert_true(isset($result['perSkill']['vocabulary']) || isset($result['perSkill']['grammar']));
    foreach ($result['perSkill'] as $s) {
        assert_true($s['total'] > 0, 'per-skill stats from answered items');
    }
    // determinism: identical answers → identical level (no randomness)
    $u2 = ll_user('asm-strong-2');
    $p2 = $svc->startLanguage($u2['id'], 'nl');
    $result2 = ll_run_assessment($svc, $u2['id'], (int) $p2['id'], fn($item) => \Aegis\LangLearn\ItemBanks::find('nl', $item['id'])['answer']);
    assert_equals($result['overallLevel'], $result2['overallLevel'], 'assessment is deterministic');
});

test('assessment: A1-only banks can never award above A1 (honest ceiling)', function () {
    $svc = platform()->langlearn;
    $u = ll_user('asm-yo');
    $profile = $svc->startLanguage($u['id'], 'yo');
    $result = ll_run_assessment($svc, $u['id'], (int) $profile['id'], fn($item) => \Aegis\LangLearn\ItemBanks::find('yo', $item['id'])['answer']);
    assert_equals('A1', $result['overallLevel']);
    assert_equals('A1', $result['bankCeiling']);
    assert_not_null($result['ceilingNote'], 'ceiling disclosed instead of inventing a higher level');
});

test('assessment: adaptive difficulty — struggles stop a skill early', function () {
    $svc = platform()->langlearn;
    $u = ll_user('asm-adaptive');
    $profile = $svc->startLanguage($u['id'], 'fr');
    // always wrong → the engine must stop each skill quickly (fewer items than a strong run)
    $result = ll_run_assessment($svc, $u['id'], (int) $profile['id'], fn($item) => -1 + 1 === 0 ? 99 : 3);
    $answered = 0;
    foreach ($result['perSkill'] as $s) $answered += $s['total'];
    assert_equals('Beginner', $result['overallLevel']);
    assert_true($answered <= 8, 'adaptive engine stops struggling skills early (asked ' . $answered . ')');
});

test('learning path: generated from the assessed level, gated checkpoints, unlock chain', function () {
    $svc = platform()->langlearn;
    $u = ll_user('path');
    $profile = $svc->startLanguage($u['id'], 'pt');
    ll_run_assessment($svc, $u['id'], (int) $profile['id'], fn($item) => \Aegis\LangLearn\ItemBanks::find('pt', $item['id'])['answer']);

    $path = $svc->generatePath($u['id'], (int) $profile['id']);
    assert_true(count($path['modules']) >= 4, 'CEFR modules generated');
    assert_equals('AVAILABLE', $path['modules'][0]['status']);
    assert_equals('LOCKED', $path['modules'][1]['status']);

    // locked module refuses a checkpoint
    assert_throws(RuntimeException::class, fn() => $svc->startCheckpoint($path['modules'][1]['id'], $u['id']));

    // fail the first checkpoint honestly (< 75%)
    $cp = $svc->startCheckpoint($path['modules'][0]['id'], $u['id']);
    assert_true(count($cp['quiz']) >= 2);
    $wrong = [];
    foreach ($cp['quiz'] as $item) $wrong[$item['id']] = 99;
    $res = $svc->submitCheckpoint($path['modules'][0]['id'], $u['id'], $wrong);
    assert_false($res['passed']);
    assert_equals('IN_PROGRESS', $res['moduleStatus'], 'failed checkpoint keeps the module open');

    // pass it with real answers → completes + unlocks the next module
    $cp2 = $svc->startCheckpoint($path['modules'][0]['id'], $u['id']);
    $good = [];
    foreach ($cp2['quiz'] as $item) $good[$item['id']] = \Aegis\LangLearn\ItemBanks::find('pt', $item['id'])['answer'];
    $res2 = $svc->submitCheckpoint($path['modules'][0]['id'], $u['id'], $good);
    assert_true($res2['passed'], 'correct answers pass');
    $after = $svc->pathFor($u['id'], (int) $profile['id']);
    assert_equals('COMPLETED', $after['modules'][0]['status']);
    assert_equals('AVAILABLE', $after['modules'][1]['status'], 'next module unlocked');

    // already-completed module refuses a retry
    assert_throws(RuntimeException::class, fn() => $svc->startCheckpoint($path['modules'][0]['id'], $u['id']));
});

test('progress: every number traces to real activity (no fake percentages)', function () {
    $svc = platform()->langlearn;
    $u = ll_user('prog');
    $profile = $svc->startLanguage($u['id'], 'de');
    // before any activity: no path %, streak 0, skills not assessed
    $before = $svc->progressFor($profile);
    assert_equals('Beginner', $before['level']);
    assert_equals(null, $before['pathCompletionPct']);
    assert_equals(0, $before['studyStreakDays']);
    assert_equals('not_assessed_this_build', $before['skills']['listening']['source']);

    ll_run_assessment($svc, $u['id'], (int) $profile['id'], fn($item) => \Aegis\LangLearn\ItemBanks::find('de', $item['id'])['answer']);
    $svc->generatePath($u['id'], (int) $profile['id']);
    $path = $svc->pathFor($u['id'], (int) $profile['id']);
    $cp = $svc->startCheckpoint($path['modules'][0]['id'], $u['id']);
    $good = [];
    foreach ($cp['quiz'] as $item) $good[$item['id']] = \Aegis\LangLearn\ItemBanks::find('de', $item['id'])['answer'];
    $svc->submitCheckpoint($path['modules'][0]['id'], $u['id'], $good);

    $after = $svc->progressFor($svc->profileOwned((int) $profile['id'], $u['id']));
    assert_equals(1, $after['studyStreakDays'], 'streak from today\'s study sessions');
    assert_not_null($after['pathCompletionPct']);
    assert_true($after['pathCompletionPct'] > 0 && $after['pathCompletionPct'] < 100, 'path % from completed modules');
    foreach (['vocabulary', 'grammar', 'reading'] as $skill) {
        assert_true(isset($after['skills'][$skill]['level']), "{$skill} level stored from the assessment");
    }
    // level only from assessment — never changed by checkpoints
    assert_true(\Aegis\LangLearn\LanguageRegistry::levelIndex($after['level']) >= \Aegis\LangLearn\LanguageRegistry::levelIndex('A1'));
});
