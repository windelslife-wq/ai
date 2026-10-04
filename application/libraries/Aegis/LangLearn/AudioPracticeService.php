<?php
namespace Aegis\LangLearn;

use Aegis\LangLearn\Persistence\LangLearnRepository;

/**
 * LISTENING + SPEAKING (Phase 4) — honest provider boundaries.
 *
 * Audio: played by the USER'S browser speech synthesis (real capability,
 * feature-detected client-side; no voice → the exercise cannot be played and
 * says so — nothing is faked server-side).
 * Speech-to-text: the browser's SpeechRecognition where the user's browser
 * exposes one; the stored transcript is exactly what the provider returned.
 * Scoring: deterministic, server-side.
 *   - listening comprehension: graded against the real bank answer.
 *   - transcription: word-similarity between typed text and the real sentence.
 *   - speaking: word accuracy of the REAL transcript vs the prompt.
 * Pronunciation / fluency scores are NEVER produced or stored — they need a
 * pronunciation-assessment provider that is not configured.
 */
class AudioPracticeService
{
    public function __construct(
        private LangLearnRepository $repo,
        private LangLearnService $core,
    ) {}

    // -------------------------------------------------------- listening

    /**
     * Listening exercises built from the language's real reading bank
     * (authentic target-language sentences + their real comprehension
     * questions). Only languages with reading items get exercises.
     */
    public function listeningExercises(int $userId, int $profileId, ?string $level = null, int $limit = 6): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        $items = array_values(array_filter(ItemBanks::items($profile['language_code']),
            fn($i) => $i['skill'] === 'reading' && ($level === null || $i['level'] === $level)));
        if (!$items) {
            return ['available' => false, 'exercises' => [],
                'note' => 'No listening exercises banked for this language yet — audio arrives with its reading bank.'];
        }
        $exercises = [];
        foreach (array_slice($items, 0, max(1, min(12, $limit))) as $i) {
            $sentence = $this->spokenSentence($i['prompt']);
            $exercises[] = [
                'itemId' => $i['id'], 'level' => $i['level'],
                'speakText' => $sentence,                       // played by the browser TTS
                'modes' => ['comprehension', 'transcription'],
                'comprehension' => ['question' => $this->comprehensionQuestion($i['prompt']),
                    'options' => $i['options']],               // the bank's REAL question + options
                'transcript' => $sentence,                      // UI hides it behind "show transcript"
                'audioNote' => 'Played by your browser\'s speech synthesis when a voice for this language exists.',
            ];
        }
        return ['available' => true, 'exercises' => $exercises,
            'speeds' => ['slow' => 0.7, 'normal' => 1.0], 'replay' => true];
    }

    /** Grade a listening attempt (real answer vs the bank). */
    public function submitListening(int $userId, int $profileId, string $itemId, string $mode, $answer): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        $item = ItemBanks::find($profile['language_code'], $itemId);
        if (!$item || $item['skill'] !== 'reading') throw new \RuntimeException('listening exercise not found', 404);
        if (!in_array($mode, ['comprehension', 'transcription'], true)) throw new \InvalidArgumentException('mode must be comprehension or transcription');

        if ($mode === 'comprehension') {
            if (!is_numeric($answer)) throw new \InvalidArgumentException('comprehension answers must be the chosen option index');
            $ok = (int) $answer === $item['answer'];
            $score = $ok ? 100 : 0;
            $detail = ['question' => $this->comprehensionQuestion($item['prompt']), 'given' => $item['options'][(int) $answer] ?? null,
                'expected' => $item['options'][$item['answer']], 'explanation' => $item['explanation']];
        } else {
            $transcript = trim((string) $answer);
            if (mb_strlen($transcript) < 2) throw new \InvalidArgumentException('write what you heard');
            $expected = $this->spokenSentence($item['prompt']);
            $score = self::transcriptionSimilarity($expected, $transcript);
            $ok = $score >= 70;
            $detail = ['expected' => $expected, 'given' => $transcript, 'similarityPct' => $score,
                'note' => 'Word-level comparison after normalization; diacritic-insensitive matching is intentional because speech engines often drop accents.'];
        }

        $this->repo->saveListeningAttempt([
            'id' => bin2hex(random_bytes(16)), 'profile_id' => $profileId, 'user_id' => $userId,
            'language_code' => $profile['language_code'], 'exercise_item_id' => $itemId, 'mode' => $mode,
            'score_pct' => $score, 'passed' => $ok ? 1 : 0, 'detail' => $detail, 'created_at' => gmdate('c'),
        ]);
        $this->recordSession($userId, $profileId, $profile['language_code'], 'listening');
        return ['passed' => $ok, 'scorePct' => $score, 'detail' => $detail];
    }

    public function listeningHistory(int $userId, int $profileId): array
    {
        $this->core->profileOwned($profileId, $userId);
        return $this->repo->listListeningAttempts($profileId);
    }

    // -------------------------------------------------------- speaking

    /** Prompts to say aloud: real bank sentences (reading items' spoken parts). */
    public function speakingPrompts(int $userId, int $profileId, ?string $level = null, int $limit = 6): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        $items = array_values(array_filter(ItemBanks::items($profile['language_code']),
            fn($i) => $i['skill'] === 'reading' && ($level === null || $i['level'] === $level)));
        if (!$items) {
            return ['available' => false, 'prompts' => [],
                'note' => 'No speaking prompts banked for this language yet.'];
        }
        $prompts = [];
        foreach (array_slice($items, 0, max(1, min(12, $limit))) as $i) {
            $prompts[] = ['id' => $i['id'], 'level' => $i['level'], 'text' => $this->spokenSentence($i['prompt'])];
        }
        return ['available' => true, 'prompts' => $prompts,
            'providerNote' => 'Speech-to-text uses your browser\'s speech recognition when available. Pronunciation and fluency scores are NOT provided — they require a pronunciation-assessment provider (not configured); only real word accuracy from the transcript is reported.'];
    }

    /**
     * Score a speaking attempt against the ACTUAL transcript the speech
     * provider returned. No pronunciation score is invented.
     */
    public function submitSpeaking(int $userId, int $profileId, string $promptId, ?string $transcript, string $provider = 'browser_webspeech'): array
    {
        $profile = $this->core->profileOwned($profileId, $userId);
        $item = ItemBanks::find($profile['language_code'], $promptId);
        if (!$item || $item['skill'] !== 'reading') throw new \RuntimeException('speaking prompt not found', 404);
        $promptText = $this->spokenSentence($item['prompt']);
        $provider = in_array($provider, ['browser_webspeech', 'none', 'manual_review'], true) ? $provider : 'unknown';
        if ($transcript === null || trim($transcript) === '') {
            // an honest "no transcript" record (engine unavailable / nothing heard)
            $this->repo->saveSpeakingAttempt([
                'id' => bin2hex(random_bytes(16)), 'profile_id' => $profileId, 'user_id' => $userId,
                'language_code' => $profile['language_code'], 'prompt_text' => $promptText,
                'transcript' => null, 'word_accuracy_pct' => null, 'exact_match' => 0,
                'provider' => $provider,
                'detail' => ['note' => 'No transcript was returned — nothing was scored or invented.'],
                'created_at' => gmdate('c'),
            ]);
            return ['scored' => false, 'note' => 'No transcript returned by the speech engine — attempt recorded unscored.'];
        }
        $accuracy = self::wordAccuracy($promptText, $transcript);
        $exact = self::normalize($promptText) === self::normalize($transcript);
        $detail = [
            'prompt' => $promptText, 'transcript' => $transcript,
            'wordAccuracyPct' => $accuracy, 'matchedWords' => self::matchedWords($promptText, $transcript),
            'expectedWords' => self::tokens($promptText),
            'pronunciationNote' => 'Pronunciation and fluency scores are not available — they require a pronunciation-assessment provider. Only word accuracy from the returned transcript is reported.',
        ];
        $this->repo->saveSpeakingAttempt([
            'id' => bin2hex(random_bytes(16)), 'profile_id' => $profileId, 'user_id' => $userId,
            'language_code' => $profile['language_code'], 'prompt_text' => $promptText,
            'transcript' => mb_substr($transcript, 0, 1000), 'word_accuracy_pct' => $accuracy,
            'exact_match' => $exact ? 1 : 0, 'provider' => $provider, 'detail' => $detail, 'created_at' => gmdate('c'),
        ]);
        $this->recordSession($userId, $profileId, $profile['language_code'], 'speaking');
        return ['scored' => true, 'wordAccuracyPct' => $accuracy, 'exactMatch' => $exact, 'detail' => $detail];
    }

    public function speakingHistory(int $userId, int $profileId): array
    {
        $this->core->profileOwned($profileId, $userId);
        return $this->repo->listSpeakingAttempts($profileId);
    }

    // --------------------------------------------------------- scoring

    /** The speakable sentence: the quoted speech inside the reading prompt. */
    private function spokenSentence(string $prompt): string
    {
        // Bank reading prompts look like: Anna zegt: 'Hallo, ik heet Anna. …' Question?
        // Extract the first quoted span (', «, „, or "…") — the target-language line.
        if (preg_match('/[\'"«„]([^\'"»“]+)[\'"»“]/u', $prompt, $m)) {
            return trim($m[1]);
        }
        // Non-quoted banks (ar/zh/ja/ko/ru/hi/tr): text before "means", with the
        // parenthesized romanization removed so the prompt is script-only.
        $stripped = preg_replace('/\s*\([^)]*\)\s*/u', ' ', $prompt);
        $cut = preg_split('/\s+means\b/u', (string) $stripped);
        return trim($cut[0], " \t.:!?¡¿„");
    }

    private function comprehensionQuestion(string $prompt): string
    {
        // The English question tail after the quote.
        if (preg_match('/[\'"»“]\s*([^\'"]+\?)$/u', $prompt, $m)) return trim($m[1]);
        if (preg_match('/means\s+([^.]*\.?)\?*$/u', $prompt, $m)) return 'What does it mean? — ' . trim($m[1], ' .?');
        return 'What did you hear?';
    }

    /** @return array<int, string> normalized word tokens */
    public static function tokens(string $text): array
    {
        $normalized = self::normalize($text);
        $tokens = preg_split('/\s+/u', $normalized, -1, PREG_SPLIT_NO_EMPTY) ?: [];
        return array_values(array_filter($tokens, fn($t) => $t !== ''));
    }

        /** Common Latin diacritics → ascii (speech engines often drop accents). */
    private const FOLD = [
        'à'=>'a','á'=>'a','â'=>'a','ã'=>'a','ä'=>'a','å'=>'a','ā'=>'a','ă'=>'a',
        'è'=>'e','é'=>'e','ê'=>'e','ë'=>'e','ē'=>'e','ę'=>'e','ė'=>'e','ẹ'=>'e',
        'ì'=>'i','í'=>'i','î'=>'i','ï'=>'i','ī'=>'i','į'=>'i','ị'=>'i',
        'ò'=>'o','ó'=>'o','ô'=>'o','õ'=>'o','ö'=>'o','ø'=>'o','ō'=>'o','ő'=>'o','ọ'=>'o',
        'ù'=>'u','ú'=>'u','û'=>'u','ü'=>'u','ū'=>'u','ů'=>'u','ű'=>'u','ụ'=>'u',
        'ç'=>'c','ć'=>'c','č'=>'c','ď'=>'d','đ'=>'d','ñ'=>'n','ń'=>'n','ň'=>'n',
        'ř'=>'r','š'=>'s','ş'=>'s','ș'=>'s','ß'=>'ss','ť'=>'t','ţ'=>'t','ț'=>'t',
        'ł'=>'l','ľ'=>'l','ž'=>'z','ź'=>'z','ż'=>'z','ğ'=>'g','ġ'=>'g','ḥ'=>'h',
        'ṣ'=>'s','ṭ'=>'t','ḍ'=>'d','ý'=>'y','ÿ'=>'y','ɛ'=>'e','ɔ'=>'o','ɲ'=>'ny','ŋ'=>'ng','ɣ'=>'gh','ʃ'=>'sh','ɩ'=>'i','ʼ'=>'',
    ];

    private static function normalize(string $text): string
    {
        $t = mb_strtolower(trim($text));
        $t = strtr($t, self::FOLD);                               // Latin diacritics → ascii
        $t = preg_replace('/[^\p{L}\p{N}\s]/u', ' ', $t);       // punctuation/symbols out (scripts preserved)
        $t = preg_replace('/\s+/u', ' ', $t);                     // collapse whitespace
        return trim((string) $t);
    }

    /** Percentage of expected words present in the transcript (order-free). */
    public static function wordAccuracy(string $expected, string $transcript): float
    {
        $expectedTokens = self::tokens($expected);
        if (!$expectedTokens) return 0.0;
        $have = array_count_values(self::tokens($transcript));
        $matched = 0;
        foreach ($expectedTokens as $t) {
            if (($have[$t] ?? 0) > 0) { $matched++; $have[$t]--; }
        }
        return round(100 * $matched / count($expectedTokens), 2);
    }

    /** @return array<int, string> expected words the transcript contained */
    public static function matchedWords(string $expected, string $transcript): array
    {
        $have = array_count_values(self::tokens($transcript));
        $out = [];
        foreach (self::tokens($expected) as $t) {
            if (($have[$t] ?? 0) > 0) { $out[] = $t; $have[$t]--; }
        }
        return $out;
    }

    /** Transcription similarity: word overlap of expected vs typed. */
    public static function transcriptionSimilarity(string $expected, string $typed): float
    {
        return self::wordAccuracy($expected, $typed);
    }

    private function recordSession(int $userId, int $profileId, string $lang, string $activity): void
    {
        $this->repo->saveSession([
            'id' => bin2hex(random_bytes(16)), 'profile_id' => $profileId, 'user_id' => $userId,
            'language_code' => $lang, 'activity' => $activity, 'day' => gmdate('Y-m-d'), 'created_at' => gmdate('c'),
        ]);
    }
}
