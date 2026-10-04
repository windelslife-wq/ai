-- AI Language Learning module — sqlite dev mirror of langlearn.mysql.sql.
CREATE TABLE IF NOT EXISTS languages (
 code TEXT PRIMARY KEY, name TEXT NOT NULL, native_name TEXT NOT NULL, iso_code TEXT NOT NULL,
 writing_system TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'ltr', features TEXT NOT NULL DEFAULT '{}',
 active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_language_profiles (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, language_code TEXT NOT NULL,
 level TEXT NOT NULL DEFAULT 'Beginner', goal TEXT, explanation_language TEXT NOT NULL DEFAULT 'en',
 status TEXT NOT NULL DEFAULT 'ACTIVE', daily_minutes INTEGER NOT NULL DEFAULT 20, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(user_id, language_code)
);
CREATE TABLE IF NOT EXISTS language_assessments (
 id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL, user_id INTEGER NOT NULL, language_code TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'IN_PROGRESS', state TEXT NOT NULL, result TEXT,
 started_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_assessments_profile ON language_assessments(profile_id, started_at);
CREATE TABLE IF NOT EXISTS learning_paths (
 id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL, language_code TEXT NOT NULL,
 from_level TEXT NOT NULL, target_level TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paths_profile ON learning_paths(profile_id);
CREATE TABLE IF NOT EXISTS learning_modules (
 id TEXT PRIMARY KEY, path_id TEXT NOT NULL, profile_id INTEGER NOT NULL, language_code TEXT NOT NULL,
 sequence INTEGER NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL, focus_skill TEXT NOT NULL,
 level TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'LOCKED', attempts_count INTEGER NOT NULL DEFAULT 0,
 completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_modules_path ON learning_modules(path_id, sequence);
CREATE INDEX IF NOT EXISTS idx_modules_profile ON learning_modules(profile_id);
CREATE TABLE IF NOT EXISTS lesson_attempts (
 id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL, user_id INTEGER NOT NULL, language_code TEXT NOT NULL,
 module_id TEXT, kind TEXT NOT NULL, score_pct REAL, passed INTEGER, detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_profile ON lesson_attempts(profile_id, created_at);
CREATE TABLE IF NOT EXISTS study_sessions (
 id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL, user_id INTEGER NOT NULL, language_code TEXT NOT NULL,
 activity TEXT NOT NULL, day TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_profile_day ON study_sessions(profile_id, day);
CREATE TABLE IF NOT EXISTS language_progress (
 id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
 language_code TEXT NOT NULL, skill TEXT NOT NULL, level TEXT, value_pct REAL, source TEXT NOT NULL,
 updated_at TEXT NOT NULL, UNIQUE(profile_id, skill, source)
);
CREATE INDEX IF NOT EXISTS idx_progress_user ON language_progress(user_id);
CREATE TABLE IF NOT EXISTS conversation_sessions (
 id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL, user_id INTEGER NOT NULL, language_code TEXT NOT NULL,
 scenario TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'casual', correction TEXT NOT NULL DEFAULT 'important',
 status TEXT NOT NULL DEFAULT 'ACTIVE', state TEXT NOT NULL, turn_count INTEGER NOT NULL DEFAULT 0,
 started_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_conv_profile ON conversation_sessions(profile_id, started_at);
CREATE TABLE IF NOT EXISTS writing_attempts (
 id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL, user_id INTEGER NOT NULL, language_code TEXT NOT NULL,
 task_code TEXT NOT NULL, original_text TEXT NOT NULL, feedback TEXT NOT NULL, score_pct REAL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_writing_profile ON writing_attempts(profile_id, created_at);
CREATE TABLE IF NOT EXISTS vocabulary (
 id INTEGER PRIMARY KEY AUTOINCREMENT, language_code TEXT NOT NULL, word TEXT NOT NULL,
 translation TEXT NOT NULL, pronunciation TEXT, example_sentence TEXT, category TEXT NOT NULL,
 level TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, UNIQUE(language_code, word)
);
CREATE TABLE IF NOT EXISTS user_vocabulary (
 id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
 vocabulary_id INTEGER NOT NULL, stage INTEGER NOT NULL DEFAULT 0, familiarity REAL NOT NULL DEFAULT 0.0,
 next_review_at TEXT NOT NULL, review_count INTEGER NOT NULL DEFAULT 0, lapse_count INTEGER NOT NULL DEFAULT 0,
 last_result TEXT, last_reviewed_at TEXT, added_at TEXT NOT NULL,
 UNIQUE(profile_id, vocabulary_id)
);
CREATE INDEX IF NOT EXISTS idx_user_vocabulary_due ON user_vocabulary(profile_id, next_review_at);
CREATE TABLE IF NOT EXISTS listening_attempts (
 id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL, user_id INTEGER NOT NULL, language_code TEXT NOT NULL,
 exercise_item_id TEXT NOT NULL, mode TEXT NOT NULL, score_pct REAL, passed INTEGER, detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listening_profile ON listening_attempts(profile_id, created_at);
CREATE TABLE IF NOT EXISTS speaking_attempts (
 id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL, user_id INTEGER NOT NULL, language_code TEXT NOT NULL,
 prompt_text TEXT NOT NULL, transcript TEXT, word_accuracy_pct REAL, exact_match INTEGER NOT NULL DEFAULT 0,
 provider TEXT NOT NULL DEFAULT 'none', detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_speaking_profile ON speaking_attempts(profile_id, created_at);
CREATE TABLE IF NOT EXISTS daily_learning_plans (
 id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL, user_id INTEGER NOT NULL, language_code TEXT NOT NULL,
 day TEXT NOT NULL, plan TEXT NOT NULL, est_minutes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
 UNIQUE(profile_id, day)
);
CREATE TABLE IF NOT EXISTS ai_learning_recommendations (
 id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL, user_id INTEGER NOT NULL, language_code TEXT NOT NULL,
 kind TEXT NOT NULL, message TEXT NOT NULL, evidence TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE',
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reco_profile ON ai_learning_recommendations(profile_id, created_at);
