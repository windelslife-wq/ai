<?php
namespace Aegis\LangLearn;

use Aegis\LangLearn\Persistence\LangLearnRepository;

/**
 * ADAPTIVE LEARNING INTELLIGENCE (Phase 5): weakness detection, personalized
 * daily plans, recommendations and mastery tracking.
 *
 * Golden rule (spec): weaknesses and recommendations must come from REAL
 * stored performance — attempts, reviews, corrections, lapses. Every finding
 * cites its evidence (counts, averages, item lists). When there is not
 * enough activity, the service says so instead of inventing findings.
 */
class AdaptiveLearningService
{
    private const MIN_ATTEMPTS_FOR_SKILL = 3;

    public function __construct(
        private LangLearnRepository $repo,
        private LangLearnService $core,
    ) {}

    // --------------------------------------------------------- weaknesses

    /**
     * Evidence-based weaknesses + strengths.
     * @return array{weaknesses: array, strengths: array, coverage: array, note: string}
     */
    public function weaknesses(int $userId, int $profileId): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        $code = $profile['language_code'];

        $skillStats = $this->skillStats($profileId);
        $weaknesses = [];
        $strengths = [];
        foreach ($skillStats as $skill => $s) {
            if ($s['count'] >= self::MIN_ATTEMPTS_FOR_SKILL) {
                $entry = ['area' => $skill, 'kind' => 'skill', 'evidence' => [
                    'attempts' => $s['count'], 'averagePct' => round($s['avg'], 1), 'window' => 'all stored attempts']];
                if ($s['avg'] < 60) $weaknesses[] = $entry;
                elseif ($s['avg'] >= 80) $strengths[] = $entry;
            }
        }

        // Vocabulary retention: repeated lapses on live words
        $lapsing = [];
        foreach ($this->repo->listUserVocabulary($profileId, false, 200) as $u) {
            if ((int) $u['lapse_count'] >= 2 && (int) $u['stage'] < VocabularyService::LEARNED_STAGE) {
                $w = $this->repo->findVocabulary((int) $u['vocabulary_id']);
                if ($w) $lapsing[] = ['word' => $w['word'], 'lapses' => (int) $u['lapse_count'], 'stage' => (int) $u['stage']];
            }
        }
        if (count($lapsing) >= 2) {
            $weaknesses[] = ['area' => 'vocabulary-retention', 'kind' => 'retention', 'evidence' => [
                'lapsedWords' => array_slice($lapsing, 0, 5), 'total' => count($lapsing)]];
        }

        // Repeated specific mistakes: the same bank item wrong ≥ 2 times
        $wrongItems = [];
        foreach ($this->attemptOutcomes($profileId) as $itemId => $results) {
            $wrong = count(array_filter($results, fn($r) => $r === false));
            if ($wrong >= 2) {
                $item = ItemBanks::find($code, $itemId);
                if ($item) $wrongItems[] = ['item' => $item['prompt'], 'skill' => $item['skill'], 'timesWrong' => $wrong];
            }
        }
        if ($wrongItems) {
            $weaknesses[] = ['area' => 'repeated-mistakes', 'kind' => 'items', 'evidence' => ['items' => array_slice($wrongItems, 0, 5), 'total' => count($wrongItems)]];
        }

        // Modules attempted repeatedly without passing
        $moduleFails = [];
        foreach ($this->repo->listAttemptsForProfile($profileId, 200) as $a) {
            if (in_array($a['kind'], ['checkpoint', 'lesson'], true) && $a['module_id'] && ($a['passed'] ?? 1) === 0) {
                $moduleFails[$a['module_id']] = ($moduleFails[$a['module_id']] ?? 0) + 1;
            }
        }
        foreach ($moduleFails as $moduleId => $fails) {
            $m = $this->repo->findModule($moduleId);
            if ($fails >= 2 && $m) {
                $weaknesses[] = ['area' => 'module:' . $m['code'], 'kind' => 'module', 'evidence' => [
                    'module' => $m['title'], 'failedAttempts' => $fails, 'hint' => 'Review the lesson examples before retrying the checkpoint.']];
            }
        }

        $coverage = array_map(fn($s) => ['attempts' => $s['count']], $skillStats);
        $enough = array_sum(array_map(fn($s) => $s['count'], $skillStats)) >= self::MIN_ATTEMPTS_FOR_SKILL;
        return [
            'weaknesses' => $weaknesses,
            'strengths' => $strengths,
            'coverage' => $coverage,
            'note' => $enough
                ? 'Findings cite the stored activity they came from.'
                : 'Not enough stored activity yet to detect weaknesses — findings appear from real attempts, never invented.',
        ];
    }

    /** @return array<string, array{count:int, avg:float}> per-skill score aggregates from REAL attempts */
    private function skillStats(int $profileId): array
    {
        $stats = [];
        $modules = [];
        foreach ($this->repo->listAttemptsForProfile($profileId, 300) as $a) {
            $skill = null;
            $score = $a['score_pct'];
            if ($a['kind'] === 'vocab_review') $skill = 'vocabulary';
            elseif ($a['kind'] === 'conversation') $skill = 'conversation';
            elseif ($a['kind'] === 'assessment') $skill = 'assessment'; // level event, not practice — excluded below
            elseif (in_array($a['kind'], ['checkpoint', 'lesson'], true) && $a['module_id']) {
                if (!isset($modules[$a['module_id']])) $modules[$a['module_id']] = $this->repo->findModule($a['module_id']);
                $skill = $modules[$a['module_id']]['focus_skill'] ?? null;
            }
            if ($skill === null || $skill === 'assessment' || $score === null) continue;
            $stats[$skill] ??= ['count' => 0, 'sum' => 0.0];
            $stats[$skill]['count']++;
            $stats[$skill]['sum'] += (float) $score;
        }
        foreach ($this->repo->listListeningAttempts($profileId, 100) as $a) {
            if ($a['score_pct'] === null) continue;
            $stats['listening'] ??= ['count' => 0, 'sum' => 0.0];
            $stats['listening']['count']++;
            $stats['listening']['sum'] += (float) $a['score_pct'];
        }
        foreach ($this->repo->listSpeakingAttempts($profileId, 100) as $a) {
            if ($a['word_accuracy_pct'] === null) continue;
            $stats['speaking'] ??= ['count' => 0, 'sum' => 0.0];
            $stats['speaking']['count']++;
            $stats['speaking']['sum'] += (float) $a['word_accuracy_pct'];
        }
        foreach ($this->repo->listWriting($profileId, 100) as $a) {
            if ($a['score_pct'] === null) continue;
            $stats['writing'] ??= ['count' => 0, 'sum' => 0.0];
            $stats['writing']['count']++;
            $stats['writing']['sum'] += (float) $a['score_pct'];
        }
        $out = [];
        foreach ($stats as $skill => $s) $out[$skill] = ['count' => $s['count'], 'avg' => $s['sum'] / $s['count']];
        return $out;
    }

    /** @return array<string, array<bool>> itemId → per-attempt correctness (real outcomes) */
    private function attemptOutcomes(int $profileId): array
    {
        $out = [];
        foreach ($this->repo->listAttemptsForProfile($profileId, 300) as $a) {
            $outcomes = $a['detail']['outcomes'] ?? null;
            if (is_array($outcomes)) {
                foreach ($outcomes as $o) {
                    if (isset($o['itemId'])) $out[(string) $o['itemId']][] = (bool) $o['correct'];
                }
                continue;
            }
            $answers = $a['detail']['answers'] ?? null;
            if (is_array($answers)) {
                foreach ($answers as $ans) {
                    if (isset($ans['id'])) $out[(string) $ans['id']][] = (bool) $ans['correct'];
                }
            }
        }
        return $out;
    }

    // --------------------------------------------------------- daily plan

    /**
     * Today's plan: built from real state (due vocabulary, current module,
     * weak areas, available practice), sized to the profile's daily minutes.
     * Completion markers are computed from today's ACTUAL activity.
     */
    public function dailyPlan(int $userId, int $profileId, ?int $minutes = null, bool $regenerate = false): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        $code = $profile['language_code'];
        $day = gmdate('Y-m-d');
        $budget = max(5, min(120, $minutes ?? (int) ($profile['daily_minutes'] ?? 20)));

        if (!$regenerate) {
            $existing = $this->repo->findDailyPlan($profileId, $day);
            if ($existing) return $this->planWithCompletion($existing);
        }

        $weak = $this->weaknesses($userId, $profileId);
        $weakSkills = array_map(fn($w) => $w['area'], array_filter($weak['weaknesses'], fn($w) => $w['kind'] === 'skill'));
        $dueCount = count($this->repo->listUserVocabulary($profileId, true, 100));
        $path = $this->repo->activePath($profileId);
        $currentModule = null;
        if ($path) {
            foreach ($this->repo->listModules($path['id']) as $m) {
                if (in_array($m['status'], ['AVAILABLE', 'IN_PROGRESS'], true)) { $currentModule = $m; break; }
            }
        }

        $blocks = [];
        if ($dueCount > 0) {
            $n = min($dueCount, max(5, (int) round($dueCount * 0.6)));
            $blocks[] = ['block' => 'vocabulary', 'title' => "Review {$n} due vocabulary words", 'minutes' => 5,
                'why' => "{$dueCount} word(s) scheduled for today by your spaced-repetition plan", 'target' => $n];
        }
        if ($currentModule) {
            $blocks[] = ['block' => 'module', 'title' => "Continue: {$currentModule['title']}", 'minutes' => 10,
                'why' => 'your next module in the learning path (focus: ' . $currentModule['focus_skill'] . ')', 'target' => $currentModule['id']];
        }
        // weak-skill practice, strongest weakness first
        $practiceMap = [
            'listening' => ['title' => 'Complete one listening exercise', 'minutes' => 5, 'why' => 'listening is your weakest measured skill'],
            'speaking' => ['title' => 'Practice speaking for 5 minutes', 'minutes' => 5, 'why' => 'speaking is your weakest measured skill'],
            'writing' => ['title' => 'One writing practice task', 'minutes' => 8, 'why' => 'writing is your weakest measured skill'],
            'grammar' => ['title' => 'Review the grammar rules you missed', 'minutes' => 5, 'why' => 'grammar is your weakest measured skill'],
            'vocabulary' => ['title' => 'Extra vocabulary quiz', 'minutes' => 5, 'why' => 'vocabulary quiz scores are low'],
        ];
        foreach ($weakSkills as $skill) {
            if (isset($practiceMap[$skill])) $blocks[] = ['block' => 'practice-' . $skill] + $practiceMap[$skill];
        }
        if (!$blocks) {
            $blocks[] = ['block' => 'start', 'title' => 'Take the level assessment to calibrate your path', 'minutes' => 5,
                'why' => 'no assessment on this profile yet', 'target' => null];
        }

        // fit the budget in priority order
        $plan = ['blocks' => [], 'budgetMinutes' => $budget];
        $used = 0;
        foreach ($blocks as $b) {
            if ($used + (int) $b['minutes'] <= $budget || $plan['blocks'] === []) {
                $plan['blocks'][] = $b;
                $used += (int) $b['minutes'];
            }
        }
        $plan['estimatedMinutes'] = $used;
        $plan['basedOn'] = array_values(array_filter([
            $dueCount > 0 ? "{$dueCount} vocabulary due" : null,
            $currentModule ? 'current path module' : null,
            $weakSkills ? 'weak areas: ' . implode(', ', $weakSkills) : null,
            !$weakSkills && ($dueCount || $currentModule) ? 'no weak areas measured yet' : null,
        ]));

        $stored = $this->repo->saveDailyPlan([
            'id' => bin2hex(random_bytes(16)), 'profile_id' => $profileId, 'user_id' => $userId,
            'language_code' => $code, 'day' => $day, 'plan' => $plan, 'est_minutes' => $used, 'created_at' => gmdate('c'),
        ]);
        return $this->planWithCompletion($stored);
    }

    /** Mark blocks done from today's real activity only. */
    private function planWithCompletion(array $stored): array
    {
        $plan = is_array($stored['plan']) ? $stored['plan'] : (json_decode((string) $stored['plan'], true) ?: []);
        $today = gmdate('Y-m-d');
        $vocabToday = 0;
        foreach ($this->repo->listAttemptsForProfile((int) $stored['profile_id'], 100) as $a) {
            if (substr((string) $a['created_at'], 0, 10) !== $today) continue;
            if ($a['kind'] === 'vocab_review') $vocabToday += count($a['detail']['items'] ?? []);
        }
        $listeningToday = count(array_filter($this->repo->listListeningAttempts((int) $stored['profile_id'], 50),
            fn($a) => substr((string) $a['created_at'], 0, 10) === $today));
        $speakingToday = count(array_filter($this->repo->listSpeakingAttempts((int) $stored['profile_id'], 50),
            fn($a) => substr((string) $a['created_at'], 0, 10) === $today));
        $writingToday = count(array_filter($this->repo->listWriting((int) $stored['profile_id'], 50),
            fn($a) => substr((string) $a['created_at'], 0, 10) === $today));
        $moduleDoneToday = [];
        foreach ($this->repo->listAttemptsForProfile((int) $stored['profile_id'], 100) as $a) {
            if (in_array($a['kind'], ['lesson', 'checkpoint'], true) && $a['module_id']
                && substr((string) $a['created_at'], 0, 10) === $today && !empty($a['passed'])) {
                $moduleDoneToday[$a['module_id']] = true;
            }
        }

        foreach ($plan['blocks'] as &$b) {
            $b['done'] = match ($b['block']) {
                'vocabulary' => $vocabToday >= (int) ($b['target'] ?? 1),
                'module' => isset($moduleDoneToday[$b['target'] ?? '']),
                'practice-listening' => $listeningToday > 0,
                'practice-speaking' => $speakingToday > 0,
                'practice-writing' => $writingToday > 0,
                default => false,
            };
        }
        return ['day' => $stored['day'], 'estimatedMinutes' => $plan['estimatedMinutes'] ?? 0, 'basedOn' => $plan['basedOn'] ?? [],
            'blocks' => $plan['blocks'], 'completionTrackedFrom' => 'today\'s stored activity only'];
    }

    // ---------------------------------------------------- recommendations

    /** Regenerate + persist evidence-cited recommendations (honest empties). */
    public function recommendations(int $userId, int $profileId): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        $weak = $this->weaknesses($userId, $profileId);
        $this->repo->clearRecommendations($profileId);
        $rows = [];
        foreach ($weak['weaknesses'] as $w) {
            $message = match ($w['kind']) {
                'skill' => sprintf('Your %s average is %s%% over %d attempts — practice it before advancing.', $w['area'], $w['evidence']['averagePct'], $w['evidence']['attempts']),
                'retention' => sprintf('%d words keep lapsing (%s…) — they are queued in today\'s review.', $w['evidence']['total'], implode(', ', array_column($w['evidence']['lapsedWords'], 'word'))),
                'items' => sprintf('You repeatedly miss %d item(s) (%s…).', $w['evidence']['total'], mb_substr($w['evidence']['items'][0]['item'] ?? '', 0, 40)),
                'module' => sprintf('%s failed %d times — review its lesson examples, then retry.', $w['evidence']['module'], $w['evidence']['failedAttempts']),
                default => 'Practice recommendation.',
            };
            $rows[] = $this->repo->saveRecommendation([
                'id' => bin2hex(random_bytes(16)), 'profile_id' => $profileId, 'user_id' => $userId,
                'language_code' => $profile['language_code'], 'kind' => $w['kind'],
                'message' => mb_substr($message, 0, 400), 'evidence' => $w['evidence'],
                'status' => 'ACTIVE', 'created_at' => gmdate('c'),
            ]);
        }
        // engagement nudge from real session days
        $days = $this->repo->sessionDays($profileId);
        $lastActive = $days[0] ?? null;
        if ($lastActive && $lastActive < gmdate('Y-m-d', time() - 2 * 86400)) {
            $rows[] = $this->repo->saveRecommendation([
                'id' => bin2hex(random_bytes(16)), 'profile_id' => $profileId, 'user_id' => $userId,
                'language_code' => $profile['language_code'], 'kind' => 'engagement',
                'message' => 'You last studied this language on ' . $lastActive . ' — a short review today keeps the streak.',
                'evidence' => ['lastActiveDay' => $lastActive], 'status' => 'ACTIVE', 'created_at' => gmdate('c'),
            ]);
        }
        return ['recommendations' => $rows,
            'note' => $rows ? 'Every recommendation cites the stored data behind it.' : 'Nothing to recommend yet — recommendations appear from real activity.'];
    }

    // ------------------------------------------------------------ mastery

    /** Grammar-item mastery from real outcomes (2+ correct incl. latest = mastered). */
    public function mastery(int $userId, int $profileId): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        $code = $profile['language_code'];
        $outcomes = $this->attemptOutcomes($profileId);
        $items = [];
        $counts = ['mastered' => 0, 'learning' => 0, 'weak' => 0, 'unseen' => 0];
        foreach (ItemBanks::items($code) as $i) {
            $results = $outcomes[$i['id']] ?? [];
            if (!$results) { $counts['unseen']++; continue; }
            $correct = count(array_filter($results));
            $mastery = 'weak';
            if ($correct >= 2 && end($results)) $mastery = 'mastered';
            elseif ($correct >= 1) $mastery = 'learning';
            $counts[$mastery]++;
            $items[] = ['id' => $i['id'], 'prompt' => $i['prompt'], 'skill' => $i['skill'], 'level' => $i['level'],
                'attempts' => count($results), 'correct' => $correct, 'mastery' => $mastery];
        }
        return ['grammarAndItems' => $items, 'counts' => $counts,
            'skillRollup' => array_map(fn($s) => ['attempts' => $s['count'], 'averagePct' => round($s['avg'], 1)], $this->skillStats($profileId)),
            'note' => 'Item mastery from real attempt outcomes only; unseen items are counted, never guessed.'];
    }
}
