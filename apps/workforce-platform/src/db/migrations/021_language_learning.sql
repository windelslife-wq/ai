-- 021_language_learning.sql
-- Ports the legacy AI Language Learning and AI Teacher schema (16 tables)
-- from application/database/langlearn.mysql.sql (Row 16).

CREATE TABLE IF NOT EXISTS wf_languages (
  code           VARCHAR(8) NOT NULL,
  name           VARCHAR(60) NOT NULL,
  native_name    VARCHAR(120) NOT NULL,
  iso_code       VARCHAR(8) NOT NULL,
  writing_system VARCHAR(40) NOT NULL,
  direction      VARCHAR(3) NOT NULL DEFAULT 'ltr',
  features       LONGTEXT NOT NULL,
  active         TINYINT(1) NOT NULL DEFAULT 1,
  updated_at     VARCHAR(32) NOT NULL,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_user_language_profiles (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id              BIGINT UNSIGNED NOT NULL,
  language_code        VARCHAR(8) NOT NULL,
  level                VARCHAR(10) NOT NULL DEFAULT 'Beginner',
  goal                 VARCHAR(300) NULL,
  explanation_language VARCHAR(8) NOT NULL DEFAULT 'en',
  status               VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  daily_minutes        INT NOT NULL DEFAULT 20,
  created_at           VARCHAR(32) NOT NULL,
  updated_at           VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wf_profile_user_language (user_id, language_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_language_assessments (
  id            VARCHAR(36) NOT NULL,
  profile_id    BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  language_code VARCHAR(8) NOT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'IN_PROGRESS',
  state         LONGTEXT NOT NULL,
  result        LONGTEXT NULL,
  started_at    VARCHAR(32) NOT NULL,
  completed_at  VARCHAR(32) NULL,
  PRIMARY KEY (id),
  KEY idx_wf_assessments_profile (profile_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_learning_paths (
  id            VARCHAR(36) NOT NULL,
  profile_id    BIGINT UNSIGNED NOT NULL,
  language_code VARCHAR(8) NOT NULL,
  from_level    VARCHAR(10) NOT NULL,
  target_level  VARCHAR(10) NOT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  created_at    VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_wf_paths_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_learning_modules (
  id             VARCHAR(36) NOT NULL,
  path_id        VARCHAR(36) NOT NULL,
  profile_id     BIGINT UNSIGNED NOT NULL,
  language_code  VARCHAR(8) NOT NULL,
  sequence       INT NOT NULL,
  code           VARCHAR(60) NOT NULL,
  title          VARCHAR(160) NOT NULL,
  focus_skill    VARCHAR(12) NOT NULL,
  level          VARCHAR(10) NOT NULL,
  status         VARCHAR(12) NOT NULL DEFAULT 'LOCKED',
  attempts_count INT NOT NULL DEFAULT 0,
  completed_at   VARCHAR(32) NULL,
  PRIMARY KEY (id),
  KEY idx_wf_modules_path (path_id, sequence),
  KEY idx_wf_modules_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_lesson_attempts (
  id            VARCHAR(36) NOT NULL,
  profile_id    BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  language_code VARCHAR(8) NOT NULL,
  module_id     VARCHAR(36) NULL,
  kind          VARCHAR(16) NOT NULL,
  score_pct     DECIMAL(5,2) NULL,
  passed        TINYINT(1) NULL,
  detail        LONGTEXT NOT NULL,
  created_at    VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_wf_attempts_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_study_sessions (
  id            VARCHAR(36) NOT NULL,
  profile_id    BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  language_code VARCHAR(8) NOT NULL,
  activity      VARCHAR(24) NOT NULL,
  day           VARCHAR(10) NOT NULL,
  created_at    VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_wf_sessions_profile_day (profile_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_language_progress (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id    BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  language_code VARCHAR(8) NOT NULL,
  skill         VARCHAR(12) NOT NULL,
  level         VARCHAR(10) NULL,
  value_pct     DECIMAL(5,2) NULL,
  source        VARCHAR(24) NOT NULL,
  updated_at    VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wf_progress (profile_id, skill, source),
  KEY idx_wf_progress_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_conversation_sessions (
  id            VARCHAR(36) NOT NULL,
  profile_id    BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  language_code VARCHAR(8) NOT NULL,
  scenario      VARCHAR(40) NOT NULL,
  mode          VARCHAR(20) NOT NULL DEFAULT 'casual',
  correction    VARCHAR(24) NOT NULL DEFAULT 'important',
  status        VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  state         LONGTEXT NOT NULL,
  turn_count    INT NOT NULL DEFAULT 0,
  started_at    VARCHAR(32) NOT NULL,
  completed_at  VARCHAR(32) NULL,
  PRIMARY KEY (id),
  KEY idx_wf_conv_profile (profile_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_writing_attempts (
  id            VARCHAR(36) NOT NULL,
  profile_id    BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  language_code VARCHAR(8) NOT NULL,
  task_code     VARCHAR(40) NOT NULL,
  original_text MEDIUMTEXT NOT NULL,
  feedback      LONGTEXT NOT NULL,
  score_pct     DECIMAL(5,2) NULL,
  created_at    VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_wf_writing_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_vocabulary (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  language_code    VARCHAR(8) NOT NULL,
  word             VARCHAR(120) NOT NULL,
  translation      VARCHAR(160) NOT NULL,
  pronunciation    VARCHAR(160) NULL,
  example_sentence VARCHAR(300) NULL,
  category         VARCHAR(24) NOT NULL,
  level            VARCHAR(4) NOT NULL,
  active           TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wf_vocabulary_word (language_code, word)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_user_vocabulary (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id       BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,
  vocabulary_id    BIGINT UNSIGNED NOT NULL,
  stage            INT NOT NULL DEFAULT 0,
  familiarity      DECIMAL(4,3) NOT NULL DEFAULT 0.000,
  next_review_at   VARCHAR(32) NOT NULL,
  review_count     INT NOT NULL DEFAULT 0,
  lapse_count      INT NOT NULL DEFAULT 0,
  last_result      VARCHAR(8) NULL,
  last_reviewed_at VARCHAR(32) NULL,
  added_at         VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wf_user_vocabulary (profile_id, vocabulary_id),
  KEY idx_wf_user_vocabulary_due (profile_id, next_review_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_listening_attempts (
  id               VARCHAR(36) NOT NULL,
  profile_id       BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,
  language_code    VARCHAR(8) NOT NULL,
  exercise_item_id VARCHAR(20) NOT NULL,
  mode             VARCHAR(14) NOT NULL,
  score_pct        DECIMAL(5,2) NULL,
  passed           TINYINT(1) NULL,
  detail           LONGTEXT NOT NULL,
  created_at       VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_wf_listening_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_speaking_attempts (
  id                VARCHAR(36) NOT NULL,
  profile_id        BIGINT UNSIGNED NOT NULL,
  user_id           BIGINT UNSIGNED NOT NULL,
  language_code     VARCHAR(8) NOT NULL,
  prompt_text       VARCHAR(400) NOT NULL,
  transcript        TEXT NULL,
  word_accuracy_pct DECIMAL(5,2) NULL,
  exact_match       TINYINT(1) NOT NULL DEFAULT 0,
  provider          VARCHAR(24) NOT NULL DEFAULT 'none',
  detail            LONGTEXT NOT NULL,
  created_at        VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_wf_speaking_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_daily_learning_plans (
  id            VARCHAR(36) NOT NULL,
  profile_id    BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  language_code VARCHAR(8) NOT NULL,
  day           VARCHAR(10) NOT NULL,
  plan          LONGTEXT NOT NULL,
  est_minutes   INT NOT NULL DEFAULT 0,
  created_at    VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wf_daily_plan (profile_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_ai_learning_recommendations (
  id            VARCHAR(36) NOT NULL,
  profile_id    BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  language_code VARCHAR(8) NOT NULL,
  kind          VARCHAR(24) NOT NULL,
  message       VARCHAR(400) NOT NULL,
  evidence      LONGTEXT NOT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  created_at    VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_wf_reco_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
