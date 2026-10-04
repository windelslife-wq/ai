<?php
namespace Aegis\LangLearn;

use Aegis\LangLearn\Persistence\LangLearnRepository;

/**
 * VOCABULARY SERVICE (Phase 3): word bank, spaced repetition, daily reviews,
 * flashcards, quizzes and vocabulary progress.
 *
 * Spaced repetition (deterministic, spec intervals):
 *   stage 0 → remember → +1 day      stage 3 → remember → +14 days
 *   stage 1 → remember → +3 days     stage 4 → remember → +30 days (learned)
 *   stage 2 → remember → +7 days     stage 5 → remember → +90 days
 *   any stage → forget → reset to stage 0, review again tomorrow (+lapse).
 *
 * Familiarity = stage / 5. Grading is objective for quizzes (multiple choice
 * from the bank) and clearly labeled self-report for flashcards. Word audio
 * uses the browser's own speech synthesis when it has a voice for the
 * language — nothing is faked when it does not.
 */
class VocabularyService
{
    public const INTERVAL_DAYS = [1, 3, 7, 14, 30, 90];
    public const LEARNED_STAGE = 4;

    public function __construct(
        private LangLearnRepository $repo,
        private LangLearnService $core,
    ) {}

    // ------------------------------------------------------------- bank

    /** Sync the authored bank into the vocabulary table (idempotent). */
    public function syncBank(string $languageCode): int
    {
        $count = 0;
        foreach (VocabularyBank::items($languageCode) as $w) {
            $this->repo->upsertVocabulary([
                'language_code' => $languageCode, 'word' => $w['word'], 'translation' => $w['translation'],
                'pronunciation' => $w['pronunciation'], 'example_sentence' => $w['example'],
                'category' => $w['category'], 'level' => $w['level'], 'active' => 1,
            ]);
            $count++;
        }
        return $count;
    }

    /** Catalog for a profile's language, joined with the learner's SRS state. */
    public function catalog(int $userId, int $profileId): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        $code = $profile['language_code'];
        if (!$this->repo->listVocabulary($code)) $this->syncBank($code);
        $mine = [];
        foreach ($this->repo->listUserVocabulary($profileId, false, 200) as $u) $mine[(int) $u['vocabulary_id']] = $u;
        return array_map(function (array $w) use ($mine) {
            $u = $mine[(int) $w['id']] ?? null;
            $w['inList'] = $u !== null;
            $w['stage'] = $u['stage'] ?? null;
            $w['familiarity'] = $u !== null ? (float) $u['familiarity'] : null;
            $w['nextReviewAt'] = $u['next_review_at'] ?? null;
            $w['reviewCount'] = $u['review_count'] ?? 0;
            $w['lapseCount'] = $u['lapse_count'] ?? 0;
            return $w;
        }, $this->repo->listVocabulary($code));
    }

    /** Add words to the learner's list. Idempotent; returns added count. */
    public function addWords(int $userId, int $profileId, array $vocabularyIds, bool $starter = false): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        $code = $profile['language_code'];
        if (!$this->repo->listVocabulary($code)) $this->syncBank($code);
        if ($starter) {
            // first words of the language, in bank order (A1 greetings first)
            $vocabularyIds = array_map(fn($w) => $w['id'], array_slice($this->repo->listVocabulary($code), 0, 10));
        }
        $added = 0;
        foreach ($vocabularyIds as $vid) {
            $word = $this->repo->findVocabulary((int) $vid);
            if (!$word || $word['language_code'] !== $code) continue;
            if ($this->repo->findUserVocabulary($profileId, (int) $vid)) continue;
            $this->repo->saveUserVocabulary([
                'profile_id' => $profileId, 'user_id' => $userId, 'vocabulary_id' => (int) $vid,
                'stage' => 0, 'familiarity' => 0.0, 'next_review_at' => gmdate('c'), // new words are immediately reviewable
                'review_count' => 0, 'lapse_count' => 0, 'last_result' => null, 'last_reviewed_at' => null,
                'added_at' => gmdate('c'),
            ]);
            $added++;
        }
        return ['added' => $added, 'totalInList' => count($this->repo->listUserVocabulary($profileId, false, 200))];
    }

    // ------------------------------------------------------------ reviews

    /** Daily review queue: due items first, then never-reviewed new items. */
    public function due(int $userId, int $profileId): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        $rows = $this->repo->listUserVocabulary($profileId, true, 100);
        return array_map(fn($u) => $this->withWord($u), $rows);
    }

    /**
     * Start a review session: mode=quiz returns multiple-choice questions
     * (distractors are real translations from the same language); mode=flashcard
     * returns the card projection (self-assessment, labeled as such).
     */
    public function startReview(int $userId, int $profileId, string $mode = 'quiz', int $limit = 10): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        if (!in_array($mode, ['quiz', 'flashcard'], true)) throw new \InvalidArgumentException('mode must be quiz or flashcard');
        $due = $this->repo->listUserVocabulary($profileId, true, max(1, min(20, $limit)));
        if (!$due) return ['mode' => $mode, 'cards' => [], 'note' => 'Nothing due right now — add words or come back at the next scheduled review.'];
        $bank = $this->repo->listVocabulary($profile['language_code']);
        $cards = [];
        foreach ($due as $u) {
            $word = null;
            foreach ($bank as $w) if ((int) $w['id'] === (int) $u['vocabulary_id']) { $word = $w; break; }
            if (!$word) continue;
            $card = ['vocabularyId' => (int) $word['id'], 'word' => $word['word'],
                'pronunciation' => $word['pronunciation'], 'stage' => (int) $u['stage'], 'dueAt' => $u['next_review_at']];
            if ($mode === 'quiz') {
                // identical deterministic build used at submit time — grading
                // is always reproducible against the same options order
                $built = $this->buildQuizCard($word, $bank, count($cards));
                $card['prompt'] = 'What does "' . $word['word'] . '" mean?';
                $card['options'] = $built['options'];
                $card['correctIndex'] = $built['correctIndex'];
            } else {
                $card['reveal'] = ['translation' => $word['translation'], 'example' => $word['example_sentence']];
                $card['selfAssessment'] = true;
            }
            $cards[] = $card;
        }
        return ['mode' => $mode, 'cards' => $cards,
            'note' => $mode === 'flashcard' ? 'Flashcards are self-assessed — the schedule trusts your honest "forgot".' : null];
    }

    /**
     * Submit review results: quiz answers (vocabularyId → option index) or
     * flashcard self-assessments (vocabularyId → remembered|forgot).
     */
    public function submitReview(int $userId, int $profileId, string $mode, array $answers): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        if (!in_array($mode, ['quiz', 'flashcard'], true)) throw new \InvalidArgumentException('mode must be quiz or flashcard');
        $bank = [];
        foreach ($this->repo->listVocabulary($profile['language_code']) as $w) $bank[(int) $w['id']] = $w;
        $results = [];
        $correct = 0;
        foreach ($answers as $vid => $given) {
            $u = $this->repo->findUserVocabulary($profileId, (int) $vid);
            $word = $bank[(int) $vid] ?? null;
            if (!$u || !$word) continue;
            if ($mode === 'quiz') {
                // verify against a rebuilt question (same deterministic option order)
                $rebuilt = $this->buildQuizCard($word, $bank, count($results));
                $ok = is_numeric($given) && (int) $given === $rebuilt['correctIndex'];
            } else {
                if (!in_array($given, ['remembered', 'forgot'], true)) continue;
                $ok = $given === 'remembered';
            }
            $ok ? $correct++ : 0;
            $results[] = $this->applySrs($userId, $profileId, $u, $ok, $word);
        }
        if (!$results) throw new \InvalidArgumentException('no reviewable answers supplied');
        $this->repo->saveAttempt([
            'id' => bin2hex(random_bytes(16)), 'profile_id' => $profileId, 'user_id' => $userId,
            'language_code' => $profile['language_code'], 'module_id' => null, 'kind' => 'vocab_review',
            'score_pct' => (int) round(100 * $correct / count($results)), 'passed' => null,
            'detail' => ['mode' => $mode, 'items' => $results], 'created_at' => gmdate('c'),
        ]);
        $this->repo->saveSession([
            'id' => bin2hex(random_bytes(16)), 'profile_id' => $profileId, 'user_id' => $userId,
            'language_code' => $profile['language_code'], 'activity' => 'vocab_review', 'day' => gmdate('Y-m-d'), 'created_at' => gmdate('c'),
        ]);
        return ['mode' => $mode, 'correct' => $correct, 'total' => count($results), 'results' => $results];
    }

    /** Deterministic quiz card builder (used by start + submit alike). */
    private function buildQuizCard(array $word, array $bank, int $position): array
    {
        $others = array_values(array_filter($bank, fn($w) => (int) $w['id'] !== (int) $word['id']));
        // deterministic distractor choice: stride by word id
        $picked = [];
        for ($i = 0; $i < 3 && $i < count($others); $i++) {
            $picked[] = $others[((int) $word['id'] * 3 + $i * 5) % count($others)];
        }
        $options = array_merge([$word['translation']], array_map(fn($o) => $o['translation'], array_slice($picked, 0, 3)));
        $seed = ((int) $word['id'] * 7 + $position) % count($options);
        $correctText = $options[0];
        $options[0] = $options[$seed];
        $options[$seed] = $correctText;
        return ['options' => $options, 'correctIndex' => array_search($correctText, $options, true)];
    }

    private function applySrs(int $userId, int $profileId, array $u, bool $ok, array $word): array
    {
        $stage = (int) $u['stage'];
        if ($ok) {
            // the interval reflects the stage just demonstrated: 0→+1d, 1→+3d, 2→+7d, 3→+14d, 4→+30d, 5→+90d
            $interval = self::INTERVAL_DAYS[$stage];
            $stage = min(count(self::INTERVAL_DAYS) - 1, $stage + 1);
            $result = 'remembered';
            $next = gmdate('c', time() + $interval * 86400);
        } else {
            $stage = 0;
            $interval = 1;
            $result = 'forgot';
            $next = gmdate('c', time() + 86400);
        }
        $row = array_merge($u, [
            'stage' => $stage,
            'familiarity' => round($stage / 5, 3),
            'next_review_at' => $next,
            'review_count' => (int) $u['review_count'] + 1,
            'lapse_count' => (int) $u['lapse_count'] + ($ok ? 0 : 1),
            'last_result' => $result,
            'last_reviewed_at' => gmdate('c'),
        ]);
        $this->repo->saveUserVocabulary($row);
        return ['vocabularyId' => (int) $word['id'], 'word' => $word['word'], 'translation' => $word['translation'],
            'result' => $result, 'stage' => $stage, 'familiarity' => $row['familiarity'],
            'nextReviewAt' => $next, 'intervalDays' => $interval];
    }

    // ----------------------------------------------------------- progress

    /** Vocabulary progress — every number from stored SRS rows. */
    public function progress(int $userId, int $profileId): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        $rows = $this->repo->listUserVocabulary($profileId, false, 200);
        $bankSize = VocabularyBank::count($profile['language_code']);
        $learned = $learning = $new = 0;
        $byCategory = [];
        foreach ($this->repo->listVocabulary($profile['language_code']) as $w) $byCategory[$w['category']] = ['total' => 0, 'learned' => 0];
        foreach ($rows as $u) {
            $stage = (int) $u['stage'];
            if ($stage >= self::LEARNED_STAGE) $learned++; elseif ($stage > 0) $learning++; else $new++;
        }
        $due = count($this->repo->listUserVocabulary($profileId, true, 200));
        return [
            'inList' => count($rows), 'bankSize' => $bankSize,
            'learned' => $learned, 'learning' => $learning, 'notYetStudied' => $new,
            'dueNow' => $due,
            'averageFamiliarity' => $rows ? round(array_sum(array_map(fn($r) => $r['familiarity'], $rows)) / count($rows), 3) : 0.0,
            'masteryPct' => $rows ? round(100 * $learned / count($rows), 1) : 0.0,
        ];
    }

    private function withWord(array $u): array
    {
        $w = $this->repo->findVocabulary((int) $u['vocabulary_id']);
        return ['word' => $w['word'] ?? '?', 'translation' => $w['translation'] ?? '?',
            'stage' => (int) $u['stage'], 'familiarity' => (float) $u['familiarity'],
            'nextReviewAt' => $u['next_review_at'], 'lastResult' => $u['last_result']];
    }
}
