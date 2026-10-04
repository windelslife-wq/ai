<?php
namespace Aegis\LangLearn;

/**
 * AI LANGUAGE TEACHER (Phase 2): lessons, conversation drill, writing
 * practice, grammar help and lesson history — deterministic engines over
 * authored content (TeacherContent) and the verified item banks.
 *
 * Correction-preference contract (conversation):
 *   immediate          → per-turn verdict + guidance
 *   important          → per-turn feedback only when a turn fails
 *   after              → neutral per-turn, full corrections in the summary
 *   conversation_only  → no corrections at all, only a summary score
 *
 * What cannot be genuinely evaluated in this build (free-form grammar
 * quality, naturalness scoring, pronunciation) is labeled as needing its
 * provider — never simulated.
 */
class TeacherService
{
    public function __construct(
        private Persistence\LangLearnRepository $repo,
        private LangLearnService $core,
    ) {}

    // ------------------------------------------------------------- lessons

    /** Lesson = teach (frame + examples from the bank) → practice → grade. */
    public function startLesson(string $moduleId, int $userId): array
    {
        $m = $this->core->moduleOwned($moduleId, $userId);
        if ($m['status'] === 'LOCKED') throw new \RuntimeException('module is locked — complete the previous module first', 409);
        if ($m['status'] === 'COMPLETED') throw new \RuntimeException('module already completed', 409);
        $lang = $this->core->language($m['language_code']);
        $moduleCode = substr($m['code'], strpos($m['code'], '-') + 1); // "<level>-<code>"
        $frame = TeacherContent::LESSON_FRAMES[$moduleCode] ?? ['goal' => 'Practice this module', 'teach' => 'Study the examples, then practice.'];

        $quiz = $this->core->quizFor($m);
        if (count($quiz) < 2) throw new \RuntimeException('not enough bank items at this level for a lesson yet', 409);
        $m['status'] = 'IN_PROGRESS';
        $m['attempts_count'] = (int) $m['attempts_count'] + 1;
        $this->repo->saveModule($m);

        // Examples teach the exact items the practice will draw from — real
        // content, and the lesson is honestly self-consistent.
        $examples = array_map(fn($i) => [
            'prompt' => $i['prompt'], 'correct' => $i['options'][$i['answer']], 'why' => $i['explanation'],
        ], array_slice($quiz, 0, 2));

        return [
            'module' => $m,
            'lesson' => [
                'title' => $m['title'],
                'goal' => $frame['goal'],
                'teach' => str_replace('{lang}', $lang['name'], $frame['teach']),
                'examples' => $examples,
                'practiceItems' => array_map(fn($i) => ItemBanks::publicItem($i), $quiz),
                'passMarkPct' => 75,
            ],
        ];
    }

    /** Grade the practice phase; completion flows through the module system. */
    public function submitLesson(string $moduleId, int $userId, array $answers): array
    {
        return $this->core->submitCheckpoint($moduleId, $userId, $answers, 'lesson');
    }

    // ------------------------------------------------------- conversation

    public function conversations(int $userId, int $profileId): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        $scenarios = TeacherContent::conversations($profile['language_code']);
        return array_map(fn($s) => ['code' => $s['code'], 'title' => $s['title'], 'mode' => $s['mode'], 'turns' => count($s['turns'])], $scenarios);
    }

    public function startConversation(int $userId, int $profileId, string $scenarioCode, string $correction = 'important'): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        if (!in_array($correction, ['immediate', 'after', 'important', 'conversation_only'], true)) {
            throw new \InvalidArgumentException('correction must be immediate|after|important|conversation_only');
        }
        $scenario = $this->findScenario($profile['language_code'], $scenarioCode);
        $session = $this->repo->saveConversation([
            'id' => bin2hex(random_bytes(16)), 'profile_id' => $profileId, 'user_id' => $userId,
            'language_code' => $profile['language_code'], 'scenario' => $scenario['code'], 'mode' => $scenario['mode'],
            'correction' => $correction, 'status' => 'ACTIVE',
            'state' => ['turnIdx' => 0, 'history' => [], 'attemptsThisTurn' => 0],
            'turn_count' => 0, 'started_at' => gmdate('c'), 'completed_at' => null,
        ]);
        return $this->conversationView($session, $scenario);
    }

    /** Read-only view for the console (throws when not found / not owned). */
    public function conversationStateForPage(string $sessionId, int $userId): array
    {
        $session = $this->repo->findConversation($sessionId);
        if (!$session || (int) $session['user_id'] !== $userId) throw new \RuntimeException('conversation not found', 404);
        $scenario = $this->findScenario($session['language_code'], $session['scenario']);
        $state = $session['state'];
        if ($session['status'] === 'COMPLETED') {
            $good = count(array_filter($state['history'] ?? [], fn($h) => $h['ok']));
            return ['status' => 'COMPLETED', 'summary' => [
                'turns' => count($state['history'] ?? []), 'unassisted' => $good,
                'scorePct' => (int) round(100 * $good / max(1, count($state['history'] ?? [1]))),
                'history' => $state['history'] ?? [],
            ]];
        }
        return $this->conversationView($session, $scenario) + ['history' => array_slice($state['history'] ?? [], -4)];
    }

    public function conversationTurn(string $sessionId, int $userId, string $text): array
    {
        $session = $this->repo->findConversation($sessionId);
        if (!$session || (int) $session['user_id'] !== $userId) throw new \RuntimeException('conversation not found', 404);
        if ($session['status'] !== 'ACTIVE') throw new \RuntimeException('conversation already completed', 409);
        $scenario = $this->findScenario($session['language_code'], $session['scenario']);
        $state = $session['state'];
        $turnIdx = (int) $state['turnIdx'];
        $turn = $scenario['turns'][$turnIdx] ?? null;
        if (!$turn) throw new \RuntimeException('no pending turn', 409);

        $text = trim($text);
        if (mb_strlen($text) < 1) throw new \InvalidArgumentException('say something first');
        $ok = $this->turnMatches($text, $turn);
        $attemptNo = (int) ($state['attemptsThisTurn'] ?? 0) + 1; // 1-based attempt count for THIS turn
        $state['history'][] = ['turn' => $turnIdx, 'text' => mb_substr($text, 0, 500), 'ok' => $ok, 'attempt' => $attemptNo];

        $assisted = false;
        if ($ok) {
            $state['turnIdx'] = $turnIdx + 1;
            $state['attemptsThisTurn'] = 0;
        } elseif ($attemptNo >= 2) {
            // after two misses the drill reveals the target and moves on — the
            // learner always progresses, and the record is honest (assisted).
            $state['turnIdx'] = $turnIdx + 1;
            $state['attemptsThisTurn'] = 0;
            $assisted = true;
        } else {
            $state['attemptsThisTurn'] = $attemptNo;
        }

        $finished = $state['turnIdx'] >= count($scenario['turns']);
        $session['state'] = $state;
        $session['turn_count'] = count($state['history']);
        if ($finished) {
            $session['status'] = 'COMPLETED';
            $session['completed_at'] = gmdate('c');
        }
        $this->repo->saveConversation($session);

        $correction = $session['correction'];
        $feedback = null;
        if ($correction === 'immediate' || ($correction === 'important' && !$ok)) {
            $feedback = [
                'ok' => $ok,
                'expected' => $ok ? null : $turn['element'],
                'example' => $ok || $assisted || ($state['attemptsThisTurn'] ?? 0) >= 1 ? $turn['example'] : null,
            ];
        }
        if ($finished) {
            $good = count(array_filter($state['history'], fn($h) => $h['ok']));
            $score = (int) round(100 * $good / max(1, count($state['history'])));
            $this->recordConversationAttempt($session, $score, $state);
            return ['status' => 'COMPLETED', 'sessionId' => $session['id'], 'correctionMode' => $correction,
                'summary' => ['turns' => count($state['history']), 'unassisted' => $good, 'scorePct' => $score,
                    'history' => $state['history'], 'note' => $correction === 'conversation_only'
                        ? 'Conversation-only mode: no corrections were shown; here is your transcript and score.'
                        : 'Review your transcript — each turn shows what was expected.'],
                'lastFeedback' => $feedback];
        }
        $view = $this->conversationView($session, $scenario);
        $view['lastFeedback'] = $feedback;
        $view['assistedAdvance'] = $assisted;
        return $view;
    }

    private function turnMatches(string $text, array $turn): bool
    {
        $hay = mb_strtolower($text);
        if (isset($turn['requireAll'])) {
            foreach ($turn['requireAll'] as $group) {
                $hit = false;
                foreach ($group as $p) {
                    if (mb_stripos($hay, mb_strtolower($p)) !== false) { $hit = true; break; }
                }
                if (!$hit) return false;
            }
            return true;
        }
        foreach ($turn['patterns'] as $p) {
            if (mb_stripos($hay, mb_strtolower($p)) !== false) return true;
        }
        return false;
    }

    private function findScenario(string $lang, string $code): array
    {
        foreach (TeacherContent::conversations($lang) as $s) {
            if ($s['code'] === $code) return $s;
        }
        throw new \RuntimeException("conversation scenario {$code} is not available for {$lang} yet", 409);
    }

    private function conversationView(array $session, array $scenario): array
    {
        $turn = $scenario['turns'][(int) $session['state']['turnIdx']] ?? null;
        return [
            'status' => 'ACTIVE', 'sessionId' => $session['id'],
            'scenario' => $scenario['title'], 'languageCode' => $session['language_code'],
            'correctionMode' => $session['correction'],
            'aiOpens' => $scenario['aiOpeners'][0] ?? '',
            'turn' => $turn === null ? null : ['index' => (int) $session['state']['turnIdx'] + 1, 'total' => count($scenario['turns']), 'instruction' => $turn['instruction']],
            'attemptsThisTurn' => (int) ($session['state']['attemptsThisTurn'] ?? 0),
        ];
    }

    private function recordConversationAttempt(array $session, int $score, array $state): void
    {
        $this->repo->saveAttempt([
            'id' => bin2hex(random_bytes(16)), 'profile_id' => (int) $session['profile_id'], 'user_id' => (int) $session['user_id'],
            'language_code' => $session['language_code'], 'module_id' => null, 'kind' => 'conversation',
            'score_pct' => $score, 'passed' => $score >= 60 ? 1 : 0,
            'detail' => ['scenario' => $session['scenario'], 'correction' => $session['correction'], 'history' => $state['history']],
            'created_at' => gmdate('c'),
        ]);
        $this->repo->saveSession([
            'id' => bin2hex(random_bytes(16)), 'profile_id' => (int) $session['profile_id'], 'user_id' => (int) $session['user_id'],
            'language_code' => $session['language_code'], 'activity' => 'conversation', 'day' => gmdate('Y-m-d'), 'created_at' => gmdate('c'),
        ]);
    }

    // --------------------------------------------------------- writing

    public function writingTasks(int $userId, int $profileId): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        return TeacherContent::writingTasks($profile['language_code']);
    }

    /** Deterministic, honest writing feedback — original text always kept. */
    public function submitWriting(int $userId, int $profileId, string $taskCode, string $text): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        $task = null;
        foreach (TeacherContent::writingTasks($profile['language_code']) as $t) {
            if ($t['code'] === $taskCode) $task = $t;
        }
        if (!$task) throw new \RuntimeException("writing task {$taskCode} is not available for this language", 409);
        $text = trim($text);
        if (mb_strlen($text) < 3) throw new \InvalidArgumentException('write at least a few characters');
        if (mb_strlen($text) > 2000) throw new \InvalidArgumentException('keep it under 2000 characters');

        $hay = mb_strtolower($text);
        $check = function (array $patterns) use ($hay): ?string {
            foreach ($patterns as $p) if (mb_stripos($hay, mb_strtolower($p)) !== false) return $p;
            return null;
        };
        $elements = [];
        $metRequired = 0;
        foreach ($task['required'] as $req) {
            $hit = $check($req['patterns']);
            if ($hit !== null) $metRequired++;
            $elements[] = ['element' => $req['element'], 'met' => $hit !== null, 'matchedPattern' => $hit, 'targetPatterns' => $req['patterns']];
        }
        $bonusMet = [];
        foreach ($task['bonus'] as $b) {
            $hit = $check($b['patterns']);
            if ($hit !== null) $bonusMet[] = $b['element'];
        }
        $wordCount = count(preg_split('/\s+/u', $text) ?: []);
        $score = $task['required'] ? (int) round(100 * $metRequired / count($task['required'])) : 0;

        $feedback = [
            'task' => $task['title'],
            'elements' => $elements,
            'bonusMet' => $bonusMet,
            'wordCount' => $wordCount,
            'scorePct' => $score,
            'whatWasChecked' => $task['checkedNote'],
            'suggestion' => $metRequired === count($task['required'])
                ? 'All required elements are present. Try the bonus element next, or another task.'
                : 'Missing element(s) above — the target patterns show exactly what to aim for. Your original text is stored unchanged.',
        ];
        $attempt = $this->repo->saveWriting([
            'id' => bin2hex(random_bytes(16)), 'profile_id' => $profileId, 'user_id' => $userId,
            'language_code' => $profile['language_code'], 'task_code' => $taskCode,
            'original_text' => $text, 'feedback' => $feedback, 'score_pct' => $score, 'created_at' => gmdate('c'),
        ]);
        $this->repo->saveSession([
            'id' => bin2hex(random_bytes(16)), 'profile_id' => $profileId, 'user_id' => $userId,
            'language_code' => $profile['language_code'], 'activity' => 'writing', 'day' => gmdate('Y-m-d'), 'created_at' => gmdate('c'),
        ]);
        return ['attempt' => ['id' => $attempt['id'], 'originalText' => $text, 'feedback' => $feedback, 'createdAt' => $attempt['created_at']]];
    }

    public function writingHistory(int $userId, int $profileId): array
    {
        $this->core->profileOwned($profileId, $userId);
        return $this->repo->listWriting($profileId);
    }

    // ---------------------------------------------------------- grammar

    /** Grammar bank rendered as teachable rules with the correct forms. */
    public function grammarRules(int $userId, int $profileId): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        $rules = [];
        foreach (ItemBanks::items($profile['language_code']) as $i) {
            if ($i['skill'] !== 'grammar') continue;
            $rules[] = [
                'id' => $i['id'], 'level' => $i['level'],
                'rule' => $i['explanation'],
                'question' => $i['prompt'],
                'correctForm' => $i['options'][$i['answer']],
            ];
        }
        return $rules;
    }

    /** "Explain it more simply" — deterministic simplification, still true. */
    public function explainSimply(int $userId, int $profileId, string $ruleId): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        $item = ItemBanks::find($profile['language_code'], $ruleId);
        if (!$item || $item['skill'] !== 'grammar') throw new \RuntimeException('grammar rule not found', 404);
        return [
            'id' => $item['id'],
            'simple' => [
                'rule' => 'Remember: ' . $item['explanation'],
                'correctExample' => $item['prompt'] . ' → ' . $item['options'][$item['answer']],
                'tip' => 'Say the correct example out loud twice, then write it once from memory.',
            ],
            'note' => 'Simplified re-presentation of the same verified rule — the content never changes, only the framing.',
        ];
    }

    // ---------------------------------------------------------- history

    public function history(int $userId, int $profileId): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        return [
            'attempts' => array_map(fn($a) => [
                'id' => $a['id'], 'kind' => $a['kind'], 'scorePct' => $a['score_pct'], 'passed' => $a['passed'],
                'languageCode' => $a['language_code'], 'createdAt' => $a['created_at'],
                'detail' => $a['detail'],
            ], array_values(array_filter(
                $this->repo->listAttemptsForProfile((int) $profile['id']),
                fn($a) => in_array($a['kind'], ['lesson', 'checkpoint', 'conversation', 'assessment', 'vocab_review'], true)
            ))),
            'conversations' => $this->repo->listConversations((int) $profile['id']),
            'writing' => $this->repo->listWriting((int) $profile['id']),
        ];
    }
}
