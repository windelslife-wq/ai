<?php
namespace Aegis\LangLearn;

use Aegis\LangLearn\Persistence\LangLearnRepository;

/**
 * LANGUAGE LEARNING ORCHESTRATOR (Phase 1).
 *
 * Service-oriented module in one process (no premature microservices):
 *   LanguageRegistryService → registry sync + catalog reads
 *   UserLanguageProfileService → per-user, per-language profiles (independent progress)
 *   LanguageAssessmentService → ADAPTIVE assessment (real answers → real levels)
 *   LearningPathService → CEFR path generation + module checkpoints
 *   LanguageProgressService → rollups derived ONLY from stored activity
 *
 * Honesty rules enforced here:
 *   - Levels change ONLY through a completed assessment (never randomly).
 *   - No level may exceed the language's bank ceiling.
 *   - Progress percentages are computed from real events, never invented.
 *   - Unassessable skills (listening/speaking/writing in this build) are
 *     reported as "not assessed in this build" instead of faked.
 */
class LangLearnService
{
    private const ASSESSABLE_SKILLS = ['vocabulary', 'grammar', 'reading'];
    private const PENDING_SKILLS_NOTE = 'Listening, speaking and writing are not assessed in this build — they arrive with Phase 2/4 providers and will never be faked.';

    public function __construct(private LangLearnRepository $repo) {}

    // ------------------------------------------------------------ registry

    /** Sync the code registry into the languages table (idempotent). */
    public function syncRegistry(): array
    {
        $count = 0;
        foreach (LanguageRegistry::all() as $code => $lang) {
            $this->repo->upsertLanguage([
                'code' => $code, 'name' => $lang['name'], 'native_name' => $lang['native_name'],
                'iso_code' => $lang['iso_code'], 'writing_system' => $lang['writing_system'],
                'direction' => $lang['direction'], 'features' => json_encode($lang['features']),
                'active' => $lang['active'] ? 1 : 0, 'updated_at' => gmdate('c'),
            ]);
            $count++;
        }
        return ['synced' => $count];
    }

    public function languages(): array
    {
        if (!$this->repo->listLanguages()) $this->syncRegistry();
        return array_map(function (array $row) {
            $row['features'] = json_decode($row['features'], true) ?: [];
            return $row;
        }, $this->repo->listLanguages());
    }

    public function language(string $code): array
    {
        $lang = LanguageRegistry::get($code);
        if (!$lang || !$lang['active']) throw new \InvalidArgumentException("language {$code} is not in the registry");
        return $lang;
    }

    // ------------------------------------------------------------ profiles

    public function startLanguage(int $userId, string $code, ?string $goal = null, string $explanationLanguage = 'en'): array
    {
        $this->language($code); // validates + active
        $existing = $this->repo->findProfileByUserLanguage($userId, $code);
        if ($existing) return $existing; // idempotent: one profile per (user, language)
        return $this->repo->saveProfile([
            'user_id' => $userId, 'language_code' => $code, 'level' => 'Beginner',
            'goal' => mb_substr((string) $goal, 0, 300), 'explanation_language' => substr($explanationLanguage, 0, 8),
            'status' => 'ACTIVE', 'created_at' => gmdate('c'), 'updated_at' => gmdate('c'),
        ]);
    }

    public function profileOwned(int $profileId, int $userId): array
    {
        $profile = $this->repo->findProfile($profileId);
        if (!$profile || (int) $profile['user_id'] !== $userId) {
            throw new \RuntimeException('profile not found', 404);
        }
        return $profile;
    }

    public function profiles(int $userId): array
    {
        return array_map(fn($p) => $p + [
            'language' => LanguageRegistry::get($p['language_code']) ?? ['name' => $p['language_code']],
            'progress' => $this->progressFor($p),
        ], $this->repo->listProfilesByUser($userId));
    }

    // ---------------------------------------------------------- assessment

    /** Start an adaptive assessment for the profile's language. */
    public function startAssessment(int $userId, int $profileId): array
    {
        $profile = $this->profileOwned($profileId, $userId);
        $code = $profile['language_code'];
        if (ItemBanks::count($code) === 0) {
            throw new \RuntimeException("no assessment bank for {$code} yet — this language is registered, assessment arrives with its content bank", 409);
        }
        $ceiling = ItemBanks::ceiling($code);
        $state = [
            'ceiling' => $ceiling,
            'skills' => array_values(array_filter(self::ASSESSABLE_SKILLS,
                fn($s) => count(array_filter(ItemBanks::items($code), fn($i) => $i['skill'] === $s)) > 0)),
            'skillIdx' => 0,
            'skillState' => [],
            'asked' => [],
            'pendingItem' => null,
        ];
        $assessment = $this->repo->saveAssessment([
            'id' => self::uuid(), 'profile_id' => $profileId, 'user_id' => $userId, 'language_code' => $code,
            'status' => 'IN_PROGRESS', 'state' => $state, 'result' => null,
            'started_at' => gmdate('c'), 'completed_at' => null,
        ]);
        return $this->advanceAssessment($assessment, $userId);
    }

    public function assessmentOwned(string $assessmentId, int $userId): array
    {
        $a = $this->repo->findAssessment($assessmentId);
        if (!$a || (int) $a['user_id'] !== $userId) throw new \RuntimeException('assessment not found', 404);
        return $a;
    }

    /** Submit an answer to the pending item; returns the next item or the result. */
    public function answerAssessment(string $assessmentId, int $userId, int $answerIndex): array
    {
        $a = $this->assessmentOwned($assessmentId, $userId);
        if ($a['status'] !== 'IN_PROGRESS') throw new \RuntimeException('assessment already completed', 409);
        $state = is_array($a['state']) ? $a['state'] : (json_decode($a['state'], true) ?: []);
        $pending = $state['pendingItem'] ?? null;
        if (!$pending) throw new \RuntimeException('no pending question', 409);
        $item = ItemBanks::find($a['language_code'], $pending['id']);
        if (!$item) throw new \RuntimeException('pending item vanished', 500);
        $correct = $answerIndex === $item['answer'];
        $skill = $pending['skill'];
        $ss = $state['skillState'][$skill] ?? ['levelIdx' => null, 'log' => []];
        $ss['log'][] = ['itemId' => $item['id'], 'level' => $item['level'], 'correct' => $correct];
        $state['skillState'][$skill] = $ss;
        $state['asked'][] = ['id' => $item['id'], 'correct' => $correct, 'level' => $item['level'], 'skill' => $skill,
            'answer' => $answerIndex, 'explanation' => $item['explanation']];
        $state['pendingItem'] = null;
        $this->repo->saveAssessment(array_merge($a, ['state' => $state]));
        return $this->advanceAssessment(array_merge($a, ['state' => $state]), $userId);
    }

    /**
     * Adaptive staircase: within the current skill, ask items level by level —
     * answer correctly and difficulty rises, struggle and it stops that skill.
     * Deterministic (bank order); no randomness anywhere.
     */
    private function advanceAssessment(array $a, int $userId): array
    {
        $state = is_array($a['state']) ? $a['state'] : (json_decode($a['state'], true) ?: []);
        $items = ItemBanks::items($a['language_code']);
        $askedIds = array_map(fn($x) => $x['id'], $state['asked'] ?? []);

        while ($state['skillIdx'] < count($state['skills'])) {
            $skill = $state['skills'][$state['skillIdx']];
            $ss = $state['skillState'][$skill] ?? ['levelIdx' => null, 'log' => []];
            $levels = [];
            foreach ($items as $it) if ($it['skill'] === $skill) $levels[$it['level']] = true;
            $levels = array_keys($levels); // bank order (A1 before A2 before B1)
            if ($ss['levelIdx'] === null) $ss['levelIdx'] = 0;

            $log = $ss['log'];
            $next = null;
            while ($ss['levelIdx'] < count($levels)) {
                $level = $levels[$ss['levelIdx']];
                $pool = array_values(array_filter($items, fn($it) => $it['skill'] === $skill && $it['level'] === $level && !in_array($it['id'], $askedIds, true)));
                $atLevel = array_filter($log, fn($l) => $l['level'] === $level);
                $correctAt = count(array_filter($atLevel, fn($l) => $l['correct']));
                if (count($atLevel) >= 2 || ($correctAt >= 1 && count($atLevel) >= 1 && $ss['levelIdx'] + 1 < count($levels) && count(array_filter($log, fn($l) => $l['level'] === $levels[$ss['levelIdx'] + 1])) === 0)) {
                    // level settled: >=1 correct moves up, 0 correct stops the skill
                    if ($correctAt >= 1) { $ss['levelIdx']++; continue; }
                    break;
                }
                if (count($atLevel) >= 2 && $correctAt === 0) break;
                if (!$pool) { // bank exhausted at this level
                    if ($correctAt >= 1 && $ss['levelIdx'] + 1 < count($levels)) { $ss['levelIdx']++; continue; }
                    break;
                }
                $next = $pool[0];
                break;
            }
            $state['skillState'][$skill] = $ss;
            if ($next !== null) {
                $state['pendingItem'] = ItemBanks::publicItem($next);
                $this->repo->saveAssessment(array_merge($a, ['state' => $state]));
                return ['status' => 'IN_PROGRESS', 'assessmentId' => $a['id'], 'item' => $state['pendingItem'],
                    'progress' => $this->assessmentProgressMeta($state)];
            }
            $state['skillIdx']++;
        }
        return $this->completeAssessment($a, array_merge($state, ['pendingItem' => null]), $userId);
    }

    private function assessmentProgressMeta(array $state): array
    {
        $skills = $state['skills'];
        $done = min($state['skillIdx'], count($skills));
        return ['skills' => $skills, 'skillIndex' => $done, 'questionsAnswered' => count($state['asked'] ?? [])];
    }

    private function completeAssessment(array $a, array $state, int $userId): array
    {
        $levelsIn = LanguageRegistry::LEVELS;
        $perSkill = [];
        $idxs = [];
        foreach ($state['skills'] as $skill) {
            $log = $state['skillState'][$skill]['log'] ?? [];
            $achieved = 'Beginner';
            $byLevel = [];
            foreach ($log as $l) $byLevel[$l['level']][] = $l['correct'];
            foreach ($levelsIn as $lv) {
                $at = $byLevel[$lv] ?? [];
                if ($at && count(array_filter($at, fn($c) => $c)) >= max(1, (int) ceil(count($at) / 2))) $achieved = $lv;
            }
            $perSkill[$skill] = [
                'level' => $achieved,
                'correct' => count(array_filter($log, fn($l) => $l['correct'])),
                'total' => count($log),
            ];
            $idxs[] = array_search($achieved, $levelsIn, true);
        }
        sort($idxs);
        $overall = $levelsIn[$idxs[intdiv(count($idxs), 2)]] ?? 'Beginner';
        $ceiling = $state['ceiling'] ?? 'Beginner';
        $capped = LanguageRegistry::levelIndex($overall) > LanguageRegistry::levelIndex($ceiling) ? $ceiling : $overall;

        $strengths = array_keys(array_filter($perSkill, fn($s) => LanguageRegistry::levelIndex($s['level']) > LanguageRegistry::levelIndex($capped)));
        $weaknesses = array_keys(array_filter($perSkill, fn($s) => LanguageRegistry::levelIndex($s['level']) < LanguageRegistry::levelIndex($capped)));
        $result = [
            'overallLevel' => $capped,
            'perSkill' => $perSkill,
            'strengths' => $strengths,
            'weaknesses' => $weaknesses,
            'bankCeiling' => $ceiling,
            'ceilingNote' => $capped === $ceiling && $capped !== 'C2'
                ? "Level verified up to the current bank ceiling ({$ceiling}) for this language — higher levels need a deeper item bank before they can be awarded."
                : null,
            'notAssessed' => ['listening', 'speaking', 'writing'],
            'notAssessedNote' => self::PENDING_SKILLS_NOTE,
            'answers' => $state['asked'] ?? [],
        ];

        $this->repo->saveAssessment(array_merge($a, ['status' => 'COMPLETED', 'state' => $state, 'result' => $result, 'completed_at' => gmdate('c')]));
        // Levels change ONLY here — never randomly.
        $profile = $this->repo->findProfile((int) $a['profile_id']);
        if ($profile) {
            $profile['level'] = $capped;
            $profile['updated_at'] = gmdate('c');
            $this->repo->saveProfile($profile);
        }
        foreach ($perSkill as $skill => $s) {
            $this->repo->upsertProgress([
                'profile_id' => (int) $a['profile_id'], 'user_id' => $userId, 'language_code' => $a['language_code'],
                'skill' => $skill, 'level' => $s['level'], 'value_pct' => null, 'source' => 'assessment', 'updated_at' => gmdate('c'),
            ]);
        }
        $this->recordAttempt($a['profile_id'], $userId, $a['language_code'], null, 'assessment',
            (int) round(100 * count(array_filter($result['answers'], fn($x) => $x['correct'])) / max(1, count($result['answers']))), null, $result);
        $this->recordSession($a['profile_id'], $userId, $a['language_code'], 'assessment');
        return ['status' => 'COMPLETED', 'assessmentId' => $a['id'], 'result' => $result];
    }

    // -------------------------------------------------------- learning path

    public function generatePath(int $userId, int $profileId): array
    {
        $profile = $this->profileOwned($profileId, $userId);
        $code = $profile['language_code'];
        $ceiling = ItemBanks::ceiling($code);
        $from = $profile['level'] === 'Beginner' ? 'A1' : $profile['level'];
        $target = LanguageRegistry::levelIndex($ceiling) > LanguageRegistry::levelIndex($from) ? $ceiling : $from;
        if ($target === $from) $target = LanguageRegistry::LEVELS[min(count(LanguageRegistry::LEVELS) - 1, LanguageRegistry::levelIndex($from) + 1)];

        $lang = $this->language($code);
        $path = $this->repo->savePath([
            'id' => self::uuid(), 'profile_id' => $profileId, 'language_code' => $code,
            'from_level' => $from, 'target_level' => $target, 'status' => 'ACTIVE', 'created_at' => gmdate('c'),
        ]);
        $seq = 0;
        foreach (Curriculum::modulesFor($from, $target) as $m) {
            $seq++;
            $this->repo->saveModule([
                'id' => self::uuid(), 'path_id' => $path['id'], 'profile_id' => $profileId, 'language_code' => $code,
                'sequence' => $seq, 'code' => $m['code'],
                'title' => "{$lang['name']} {$m['level']} · {$m['title']}",
                'focus_skill' => $m['focus'], 'level' => $m['level'],
                'status' => $seq === 1 ? 'AVAILABLE' : 'LOCKED', 'attempts_count' => 0, 'completed_at' => null,
            ]);
        }
        return $this->pathFor($userId, $profileId);
    }

    public function pathFor(int $userId, int $profileId): array
    {
        $this->profileOwned($profileId, $userId);
        $path = $this->repo->activePath($profileId);
        if (!$path) return ['path' => null, 'modules' => []];
        return ['path' => $path, 'modules' => $this->repo->listModules($path['id'])];
    }

    public function moduleOwned(string $moduleId, int $userId): array
    {
        $m = $this->repo->findModule($moduleId);
        if (!$m) throw new \RuntimeException('module not found', 404);
        $this->profileOwned((int) $m['profile_id'], $userId); // ownership via profile
        return $m;
    }

    /** Deterministic quiz draw for a module (focus skill first) — shared by checkpoint and lesson flows. */
    public function quizFor(array $module): array
    {
        $items = ItemBanks::items($module['language_code']);
        $at = array_values(array_filter($items, fn($i) => $i['level'] === $module['level']));
        usort($at, fn($x, $y) => ($x['skill'] === $module['focus_skill'] ? -1 : 1) <=> ($y['skill'] === $module['focus_skill'] ? -1 : 1));
        return array_slice($at, 0, min(4, max(2, count($at))));
    }

    /** Checkpoint quiz drawn from the module's level (focus skill first). */
    public function startCheckpoint(string $moduleId, int $userId): array
    {
        $m = $this->moduleOwned($moduleId, $userId);
        if (in_array($m['status'], ['LOCKED'], true)) throw new \RuntimeException('module is locked — complete the previous module first', 409);
        if ($m['status'] === 'COMPLETED') throw new \RuntimeException('module already completed', 409);
        $quiz = $this->quizFor($m);
        if (count($quiz) < 2) throw new \RuntimeException('not enough bank items at this level for a checkpoint yet', 409);
        $m['status'] = 'IN_PROGRESS';
        $m['attempts_count'] = (int) $m['attempts_count'] + 1;
        $this->repo->saveModule($m);
        return ['module' => $m, 'quiz' => array_map(fn($i) => ItemBanks::publicItem($i), $quiz)];
    }

    /** Grade a checkpoint. ≥75% completes the module and unlocks the next. */
    public function submitCheckpoint(string $moduleId, int $userId, array $answers, string $kind = 'checkpoint'): array
    {
        $m = $this->moduleOwned($moduleId, $userId);
        $quiz = $this->quizFor($m);
        $outcomes = [];
        $correct = 0;
        foreach ($quiz as $i => $item) {
            $given = $answers[$item['id']] ?? $answers[(string) $i] ?? null;
            $ok = is_numeric($given) && (int) $given === $item['answer'];
            if ($ok) $correct++;
            $outcomes[] = ['itemId' => $item['id'], 'correct' => $ok,
                'explanation' => $ok ? $item['explanation'] : $item['prompt'] . ' — ' . $item['explanation']];
        }
        $score = (int) round(100 * $correct / count($quiz));
        $passed = $score >= 75;
        if ($passed) {
            $m['status'] = 'COMPLETED';
            $m['completed_at'] = gmdate('c');
            $this->repo->saveModule($m);
            // unlock the next module
            foreach ($this->repo->listModules($m['path_id']) as $sib) {
                if ((int) $sib['sequence'] === (int) $m['sequence'] + 1 && $sib['status'] === 'LOCKED') {
                    $sib['status'] = 'AVAILABLE';
                    $this->repo->saveModule($sib);
                }
            }
            $this->refreshPathCompletion($m);
        }
        $this->recordAttempt((int) $m['profile_id'], $userId, $m['language_code'], $m['id'], $kind, $score, $passed,
            ['outcomes' => $outcomes, 'module' => $m['title']]);
        $this->recordSession((int) $m['profile_id'], $userId, $m['language_code'], 'checkpoint');
        return ['passed' => $passed, 'scorePct' => $score, 'correct' => $correct, 'total' => count($quiz), 'outcomes' => $outcomes,
            'moduleStatus' => $passed ? 'COMPLETED' : $m['status']];
    }

    private function refreshPathCompletion(array $m): void
    {
        $modules = $this->repo->listModules($m['path_id']);
        $completed = count(array_filter($modules, fn($x) => $x['status'] === 'COMPLETED'));
        $pct = $modules ? round(100 * $completed / count($modules), 2) : 0.0;
        $this->repo->upsertProgress([
            'profile_id' => (int) $m['profile_id'], 'user_id' => (int) 0, 'language_code' => $m['language_code'],
            'skill' => 'overall', 'level' => null, 'value_pct' => $pct, 'source' => 'path_completion', 'updated_at' => gmdate('c'),
        ]);
    }

    // -------------------------------------------------------------- progress

    /** Dashboard rollup — every number derived from stored activity. */
    public function progressFor(array $profile): array
    {
        $pid = (int) $profile['id'];
        $rows = $this->repo->listProgress($pid);
        $skills = [];
        foreach ($rows as $r) {
            if ($r['source'] === 'assessment') $skills[$r['skill']] = ['level' => $r['level'], 'source' => 'assessment'];
        }
        $pathPct = null;
        foreach ($rows as $r) {
            if ($r['source'] === 'path_completion') $pathPct = (float) $r['value_pct'];
        }
        $days = $this->repo->sessionDays($pid);
        $streak = 0;
        $today = gmdate('Y-m-d');
        $yesterday = gmdate('Y-m-d', time() - 86400);
        if ($days && (in_array($today, $days, true) || in_array($yesterday, $days, true))) {
            $cursor = in_array($today, $days, true) ? $today : $yesterday;
            $set = array_flip($days);
            while (isset($set[$cursor])) {
                $streak++;
                $cursor = gmdate('Y-m-d', strtotime($cursor . ' -1 day'));
            }
        }
        return [
            'level' => $profile['level'],
            'levelSource' => $profile['level'] === 'Beginner' ? 'default (no assessment yet)' : 'assessment',
            'skills' => $skills + [
                'listening' => ['level' => null, 'source' => 'not_assessed_this_build'],
                'speaking' => ['level' => null, 'source' => 'not_assessed_this_build'],
                'writing' => ['level' => null, 'source' => 'not_assessed_this_build'],
            ],
            'pathCompletionPct' => $pathPct,
            'studyStreakDays' => $streak,
            'activeDays' => count($days),
        ];
    }

    // -------------------------------------------------------------- helpers

    private function recordAttempt(int $profileId, int $userId, string $lang, ?string $moduleId, string $kind, ?int $scorePct, ?bool $passed, array $detail): void
    {
        $this->repo->saveAttempt([
            'id' => self::uuid(), 'profile_id' => $profileId, 'user_id' => $userId, 'language_code' => $lang,
            'module_id' => $moduleId, 'kind' => $kind, 'score_pct' => $scorePct, 'passed' => $passed === null ? null : ($passed ? 1 : 0),
            'detail' => $detail, 'created_at' => gmdate('c'),
        ]);
    }

    private function recordSession(int $profileId, int $userId, string $lang, string $activity): void
    {
        $this->repo->saveSession([
            'id' => self::uuid(), 'profile_id' => $profileId, 'user_id' => $userId, 'language_code' => $lang,
            'activity' => $activity, 'day' => gmdate('Y-m-d'), 'created_at' => gmdate('c'),
        ]);
    }

    private static function uuid(): string
    {
        return bin2hex(random_bytes(16));
    }
}
