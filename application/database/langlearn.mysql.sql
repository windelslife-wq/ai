-- AI Language Learning module (Phase 1). Canonical MySQL schema; the
-- sqlite dev mirror lives in langlearn.sqlite.sql. No fake progress: every
-- row is produced by real user activity (answers, attempts, sessions).

CREATE TABLE IF NOT EXISTS languages (
  code           VARCHAR(8) PRIMARY KEY,          -- ISO 639-1/3 code
  name           VARCHAR(60) NOT NULL,
  native_name    VARCHAR(120) NOT NULL,
  iso_code       VARCHAR(8) NOT NULL,
  writing_system VARCHAR(40) NOT NULL,            -- latin | cyrillic | devanagari | arabic | han | kana | hangul | ...
  direction      VARCHAR(3) NOT NULL DEFAULT 'ltr',
  features       LONGTEXT NOT NULL,               -- JSON: assessment, listening, speaking, writing …
  active         TINYINT(1) NOT NULL DEFAULT 1,
  updated_at     VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_language_profiles (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  user_id              INT NOT NULL,
  language_code        VARCHAR(8) NOT NULL,
  level                VARCHAR(10) NOT NULL DEFAULT 'Beginner',   -- Beginner|A1..C2 (set only by assessment)
  goal                 VARCHAR(300) NULL,
  explanation_language VARCHAR(8) NOT NULL DEFAULT 'en',
  status               VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  daily_minutes        INT NOT NULL DEFAULT 20,
  created_at           VARCHAR(32) NOT NULL,
  updated_at           VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_profile_user_language (user_id, language_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS language_assessments (
  id           VARCHAR(36) PRIMARY KEY,
  profile_id   INT NOT NULL,
  user_id      INT NOT NULL,
  language_code VARCHAR(8) NOT NULL,
  status       VARCHAR(12) NOT NULL DEFAULT 'IN_PROGRESS',        -- IN_PROGRESS|COMPLETED
  state        LONGTEXT NOT NULL,                 -- adaptive engine state (queue, position, per-skill stats)
  result       LONGTEXT NULL,                     -- final verdict: per-skill levels, overall, strengths, weaknesses
  started_at   VARCHAR(32) NOT NULL,
  completed_at VARCHAR(32) NULL,
  KEY idx_assessments_profile (profile_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS learning_paths (
  id            VARCHAR(36) PRIMARY KEY,
  profile_id    INT NOT NULL,
  language_code VARCHAR(8) NOT NULL,
  from_level    VARCHAR(10) NOT NULL,
  target_level  VARCHAR(10) NOT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  created_at    VARCHAR(32) NOT NULL,
  KEY idx_paths_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS learning_modules (
  id               VARCHAR(36) PRIMARY KEY,
  path_id          VARCHAR(36) NOT NULL,
  profile_id       INT NOT NULL,
  language_code    VARCHAR(8) NOT NULL,
  sequence         INT NOT NULL,
  code             VARCHAR(60) NOT NULL,
  title            VARCHAR(160) NOT NULL,
  focus_skill      VARCHAR(12) NOT NULL,          -- vocabulary|grammar|reading
  level            VARCHAR(10) NOT NULL,
  status           VARCHAR(12) NOT NULL DEFAULT 'LOCKED',  -- LOCKED|AVAILABLE|IN_PROGRESS|COMPLETED
  attempts_count   INT NOT NULL DEFAULT 0,
  completed_at     VARCHAR(32) NULL,
  KEY idx_modules_path (path_id, sequence),
  KEY idx_modules_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lesson_attempts (
  id             VARCHAR(36) PRIMARY KEY,
  profile_id     INT NOT NULL,
  user_id        INT NOT NULL,
  language_code  VARCHAR(8) NOT NULL,
  module_id      VARCHAR(36) NULL,
  kind           VARCHAR(16) NOT NULL,            -- assessment|checkpoint|lesson (Phase 2)
  score_pct      DECIMAL(5,2) NULL,
  passed         TINYINT(1) NULL,
  detail         LONGTEXT NOT NULL,               -- items, answers, explanations (audit-grade)
  created_at     VARCHAR(32) NOT NULL,
  KEY idx_attempts_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS study_sessions (
  id             VARCHAR(36) PRIMARY KEY,
  profile_id     INT NOT NULL,
  user_id        INT NOT NULL,
  language_code  VARCHAR(8) NOT NULL,
  activity       VARCHAR(24) NOT NULL,            -- assessment|checkpoint|review (Phase 3)…
  day            VARCHAR(10) NOT NULL,            -- UTC date, for streak math
  created_at     VARCHAR(32) NOT NULL,
  KEY idx_sessions_profile_day (profile_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS language_progress (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  profile_id         INT NOT NULL,
  user_id            INT NOT NULL,
  language_code      VARCHAR(8) NOT NULL,
  skill              VARCHAR(12) NOT NULL,        -- vocabulary|grammar|reading|listening|writing|speaking|overall
  level              VARCHAR(10) NULL,            -- from real assessment data only
  value_pct          DECIMAL(5,2) NULL,           -- derived from real events only, never invented
  source             VARCHAR(24) NOT NULL,        -- assessment|path_completion|activity
  updated_at         VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_progress (profile_id, skill, source),
  KEY idx_progress_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Phase 2 (AI Teacher): conversation drill sessions and writing practice.
-- Conversation turns store the authored scenario state + deterministic
-- evaluation; writing attempts ALWAYS keep the user's original text next to
-- the structured feedback (never overwritten).
CREATE TABLE IF NOT EXISTS conversation_sessions (
  id             VARCHAR(36) PRIMARY KEY,
  profile_id     INT NOT NULL,
  user_id        INT NOT NULL,
  language_code  VARCHAR(8) NOT NULL,
  scenario       VARCHAR(40) NOT NULL,
  mode           VARCHAR(20) NOT NULL DEFAULT 'casual',       -- beginner|intermediate|advanced|travel|restaurant|shopping|...
  correction     VARCHAR(24) NOT NULL DEFAULT 'important',     -- immediate|after|important|conversation_only
  status         VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',        -- ACTIVE|COMPLETED|ABANDONED
  state          LONGTEXT NOT NULL,                            -- scenario script state: turn index, history, evaluation
  turn_count     INT NOT NULL DEFAULT 0,
  started_at     VARCHAR(32) NOT NULL,
  completed_at   VARCHAR(32) NULL,
  KEY idx_conv_profile (profile_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS writing_attempts (
  id             VARCHAR(36) PRIMARY KEY,
  profile_id     INT NOT NULL,
  user_id        INT NOT NULL,
  language_code  VARCHAR(8) NOT NULL,
  task_code      VARCHAR(40) NOT NULL,
  original_text  MEDIUMTEXT NOT NULL,                          -- the user's own writing, never modified
  feedback       LONGTEXT NOT NULL,                            -- structured deterministic feedback
  score_pct      DECIMAL(5,2) NULL,
  created_at     VARCHAR(32) NOT NULL,
  KEY idx_writing_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Phase 3 (vocabulary): language word bank + per-user spaced-repetition state.
CREATE TABLE IF NOT EXISTS vocabulary (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  language_code    VARCHAR(8) NOT NULL,
  word             VARCHAR(120) NOT NULL,
  translation      VARCHAR(160) NOT NULL,
  pronunciation    VARCHAR(160) NULL,           -- romanization where confidently known
  example_sentence VARCHAR(300) NULL,           -- only sentences that contain the word
  category         VARCHAR(24) NOT NULL,
  level            VARCHAR(4) NOT NULL,
  active           TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_vocabulary_word (language_code, word)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_vocabulary (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  profile_id       INT NOT NULL,
  user_id          INT NOT NULL,
  vocabulary_id    INT NOT NULL,
  stage            INT NOT NULL DEFAULT 0,      -- SRS stage 0..5 (learned at >= 4)
  familiarity      DECIMAL(4,3) NOT NULL DEFAULT 0.000,  -- stage / 5
  next_review_at   VARCHAR(32) NOT NULL,        -- ISO timestamp; due when <= now
  review_count     INT NOT NULL DEFAULT 0,
  lapse_count      INT NOT NULL DEFAULT 0,
  last_result      VARCHAR(8) NULL,             -- remembered | forgot
  last_reviewed_at VARCHAR(32) NULL,
  added_at         VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_user_vocabulary (profile_id, vocabulary_id),
  KEY idx_user_vocabulary_due (profile_id, next_review_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Phase 4 (listening/speaking): attempts are REAL records — listening graded
-- against bank answers; speaking graded against the actual transcript the
-- speech provider returned. Pronunciation/fluency scores are NEVER stored:
-- they require a pronunciation-assessment provider (not configured).
CREATE TABLE IF NOT EXISTS listening_attempts (
  id              VARCHAR(36) PRIMARY KEY,
  profile_id      INT NOT NULL,
  user_id         INT NOT NULL,
  language_code   VARCHAR(8) NOT NULL,
  exercise_item_id VARCHAR(20) NOT NULL,        -- bank reading item id
  mode            VARCHAR(14) NOT NULL,          -- comprehension|transcription
  score_pct       DECIMAL(5,2) NULL,
  passed          TINYINT(1) NULL,
  detail          LONGTEXT NOT NULL,             -- question/transcript given vs expected, similarity
  created_at      VARCHAR(32) NOT NULL,
  KEY idx_listening_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS speaking_attempts (
  id              VARCHAR(36) PRIMARY KEY,
  profile_id      INT NOT NULL,
  user_id         INT NOT NULL,
  language_code   VARCHAR(8) NOT NULL,
  prompt_text     VARCHAR(400) NOT NULL,
  transcript      TEXT NULL,                     -- exactly what the speech provider returned
  word_accuracy_pct DECIMAL(5,2) NULL,           -- real: expected words present in transcript
  exact_match     TINYINT(1) NOT NULL DEFAULT 0,
  provider        VARCHAR(24) NOT NULL DEFAULT 'none',  -- browser_webspeech|none|…
  detail          LONGTEXT NOT NULL,
  created_at      VARCHAR(32) NOT NULL,
  KEY idx_speaking_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Phase 5 (adaptive learning): daily plans + AI recommendations. Every item
-- is derived from stored activity; evidence is cited; nothing is invented.
CREATE TABLE IF NOT EXISTS daily_learning_plans (
  id            VARCHAR(36) PRIMARY KEY,
  profile_id    INT NOT NULL,
  user_id       INT NOT NULL,
  language_code VARCHAR(8) NOT NULL,
  day           VARCHAR(10) NOT NULL,            -- UTC date
  plan          LONGTEXT NOT NULL,               -- blocks with evidence + completion
  est_minutes   INT NOT NULL DEFAULT 0,
  created_at    VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_daily_plan (profile_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_learning_recommendations (
  id            VARCHAR(36) PRIMARY KEY,
  profile_id    INT NOT NULL,
  user_id       INT NOT NULL,
  language_code VARCHAR(8) NOT NULL,
  kind          VARCHAR(24) NOT NULL,            -- weakness|retention|module|engagement
  message       VARCHAR(400) NOT NULL,
  evidence      LONGTEXT NOT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  created_at    VARCHAR(32) NOT NULL,
  KEY idx_reco_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
