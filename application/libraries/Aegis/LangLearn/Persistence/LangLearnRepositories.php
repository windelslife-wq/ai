<?php
namespace Aegis\LangLearn\Persistence;

/**
 * Language-learning persistence contract. Implemented by Aegis_model over
 * CI3's query builder (mysqli in production, pdo_sqlite in the dev runtime).
 */
interface LangLearnRepository
{
    public function upsertLanguage(array $row): void;
    /** @return array<int, array<string, mixed>> */
    public function listLanguages(bool $activeOnly = true): array;
    /** @return array<string, mixed>|null */
    public function findLanguage(string $code): ?array;

    /** Insert-or-update by id; returns the stored record with its id. */
    public function saveProfile(array $profile): array;
    public function findProfile(int $id): ?array;
    public function findProfileByUserLanguage(int $userId, string $code): ?array;
    /** @return array<int, array<string, mixed>> */
    public function listProfilesByUser(int $userId): array;

    /** Insert-or-update by id. state/result accept arrays (encoded as JSON). */
    public function saveAssessment(array $assessment): array;
    public function findAssessment(string $id): ?array;
    public function latestCompletedAssessment(int $profileId): ?array;

    public function savePath(array $path): array;
    public function activePath(int $profileId): ?array;

    public function saveModule(array $module): array;
    public function findModule(string $id): ?array;
    /** @return array<int, array<string, mixed>> ordered by sequence */
    public function listModules(string $pathId): array;

    public function saveAttempt(array $attempt): array;
    /** @return array<int, array<string, mixed>> newest first */
    public function listAttemptsForProfile(int $profileId, int $limit = 100): array;
    public function saveSession(array $session): void;
    /** @return array<int, string> distinct UTC study days, newest first */
    public function sessionDays(int $profileId): array;

    // Phase 2 (AI teacher)
    public function saveConversation(array $session): array;
    public function findConversation(string $id): ?array;
    /** @return array<int, array<string, mixed>> */
    public function listConversations(int $profileId, int $limit = 20): array;
    public function saveWriting(array $attempt): array;
    /** @return array<int, array<string, mixed>> */
    public function listWriting(int $profileId, int $limit = 20): array;

    // Phase 3 (vocabulary)
    /** Upsert a bank word by (language_code, word); returns the stored row with id. */
    public function upsertVocabulary(array $word): array;
    /** @return array<int, array<string, mixed>> */
    public function listVocabulary(string $languageCode, bool $activeOnly = true): array;
    public function findVocabulary(int $id): ?array;
    /** Insert-or-update by (profile_id, vocabulary_id). */
    public function saveUserVocabulary(array $row): array;
    public function findUserVocabulary(int $profileId, int $vocabularyId): ?array;
    /** @return array<int, array<string, mixed>> due first (or all when $dueOnly=false) */
    public function listUserVocabulary(int $profileId, bool $dueOnly = false, int $limit = 100): array;

    // Phase 4 (listening/speaking)
    public function saveListeningAttempt(array $attempt): array;
    /** @return array<int, array<string, mixed>> */
    public function listListeningAttempts(int $profileId, int $limit = 20): array;
    public function saveSpeakingAttempt(array $attempt): array;
    /** @return array<int, array<string, mixed>> */
    public function listSpeakingAttempts(int $profileId, int $limit = 20): array;

    // Phase 5 (adaptive learning)
    /** Upsert by (profile_id, day); plan may be an array (stored as JSON). */
    public function saveDailyPlan(array $plan): array;
    public function findDailyPlan(int $profileId, string $day): ?array;
    public function saveRecommendation(array $row): array;
    public function clearRecommendations(int $profileId): void;

    /** Upsert keyed on (profile_id, skill, source). */
    public function upsertProgress(array $row): void;
    /** @return array<int, array<string, mixed>> */
    public function listProgress(int $profileId): array;
}
