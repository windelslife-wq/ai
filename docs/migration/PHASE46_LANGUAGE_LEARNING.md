# Phase 46 — AI Language Learning & AI Teacher (`languageLearning`, Row 16)

**Date:** 2026-10-17  
**Branch:** `arena/0d5104b6-ai`  
**Module ledger transition:** `languageLearning` `not-ported` → `ported` (`14 ported / 3 partial / 0 not-ported`)

---

## 1. Scope & Summary

Phase 46 ports the complete 5-phase **AI Language Learning & AI Teacher** module (Row 16 of `UNFINISHED_MODULES.md`) from the legacy CodeIgniter 3 application (`application/database/langlearn.mysql.sql`, `application/models/Aegis_model.php`, `application/controllers/{Api_lang_learning.php,Lang_learn.php}`, `application/libraries/Aegis/LangLearn/*.php`, and `tests/cases/35-language-learning.php`..`39-adaptive-learning.php`) to the Node.js modular monolith (`apps/workforce-platform`).

With `languageLearning` ported, **zero** modules in the 17-module `MODULE_STATUS` ledger remain `not-ported` (`14 ported / 3 partial / 0 not-ported`).

---

## 2. Schema & Dual-Adapter Persistence (`021_language_learning.sql`)

- **Migration `apps/workforce-platform/src/db/migrations/021_language_learning.sql`:**
  Creates the 16 `wf_*` Language Learning tables (`65 → 81` total migration tables, `20 → 21` required migrations):
  1. `wf_languages`
  2. `wf_user_language_profiles`
  3. `wf_language_assessments`
  4. `wf_learning_paths`
  5. `wf_learning_modules`
  6. `wf_lesson_attempts`
  7. `wf_language_progress`
  8. `wf_study_sessions`
  9. `wf_conversation_sessions`
  10. `wf_writing_attempts`
  11. `wf_vocabulary`
  12. `wf_user_vocabulary`
  13. `wf_listening_attempts`
  14. `wf_speaking_attempts`
  15. `wf_daily_learning_plans`
  16. `wf_ai_learning_recommendations`
- **Repository contract (`apps/workforce-platform/src/persistence/contract.js`):**
  Expanded from `210` to `250` methods (+40 Language Learning methods), implemented across both `src/persistence/file-store.js` (WAL-backed file store) and `src/db/language-repository.js` (MySQL store).

---

## 3. Domain Services & Authored Content (`src/modules/language/`)

- **`registry.js` (`LanguageRegistry`, `ItemBanks`, `Curriculum`):**
  - 20 authored languages (`nl`, `es`, `it`, `fr`, `de`, `en`, `pt`, `ar`, `zh`, `ja`, `ko`, `ru`, `hi`, `tr`, `sw`, `yo`, `ig`, `ha`, `af`, `zu`) with honest capability flags (`writing_system`, `direction`, `assessment_bank`, `assessment_ceiling`).
  - Authored placement/checkpoint item banks across all 20 languages.
  - `Curriculum.modulesFor(fromLevel, toLevel)` generating ordered CEFR modules.
- **`content.js` (`TeacherContent`, `VocabularyBank`, `Translator`):**
  - `VocabularyBank`: 10 authored words per language across all 20 languages (200 total).
  - `TeacherContent`: lesson frames, multi-turn conversation scenarios (`first-meeting`, `cafe`), and writing tasks (`self-introduction`, `thank-you-note`).
  - `Translator`: deterministic phrasebook + word-by-word pivot dictionary + script detector across all 20 languages (`same-language`, `phrasebook`, `word-by-word`, or honest `none`).
- **`service.js` (`createLanguageLearningService`):**
  - **Phase 1 (Core):** idempotent learner profiles per `(user_id, language_code)`, deterministic placement assessment staircase (level changes only on completion and caps at `ceiling`), learning path generation, 75%-pass checkpoints that unlock the next module, and UTC study-streak tracking.
  - **Phase 2 (AI Teacher):** guided lessons, multi-turn conversations with 4 correction modes (`immediate`, `after`, `important`, `conversation_only`) and assisted advance after 2 misses, writing feedback preserving `originalText` verbatim, and grammar `explainSimply`.
  - **Phase 3 (Vocabulary SRS):** 6-stage spaced repetition (`[1, 3, 7, 14, 30, 90]` days; learned at stage `>= 4`) with `quiz` and self-assessed `flashcard` reviews.
  - **Phase 4 (Listening & Speaking):** listening comprehension + diacritic-folded transcription (`>= 70%` pass) and honest speaking attempts (`wordAccuracy` on browser Web Speech transcripts; `null`/empty transcripts stored unscored; pronunciation never fabricated).
  - **Phase 5 (Adaptive Learning):** evidence-backed weakness detector (`MIN_ATTEMPTS_FOR_SKILL = 3`, `< 60%` weak / `>= 80%` strong, `vocabulary-retention`, `repeated-mistakes`, failed `module`), persisted daily study plan (`5–120` minutes), recommendations, and item/skill mastery.

---

## 4. HTTP Routes & React Console (`routes.js`, `client/src/language.js`)

- **33 `/api/v1/language-learning/*` HTTP endpoints** guarded by `system.authenticated` and strict owner checks (`profileOwned`, `assessmentOwned`, `moduleOwned`).
- **Workspace console (`/app/languages` and `/app/languages/teacher`):**
  - `client/src/language.js` + `LanguageLearningView` in `client/src/views.jsx` covering all 8 tabs (`Languages & Profiles`, `Placement & Path`, `AI Teacher & Grammar`, `Conversations & Writing`, `Vocabulary SRS`, `Listening & Speaking`, `Adaptive Plan & Mastery`, `Translator`).
  - `WorkspaceDashboard` (`/app`) now reads `GET /api/v1/language-learning/profiles` and links its quick action and KPI card directly to `/app/languages`.
