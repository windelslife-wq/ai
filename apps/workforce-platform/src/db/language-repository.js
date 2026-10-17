function decodeJsonColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  return JSON.parse(String(value));
}

function encodeJsonColumn(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "{}";
  return JSON.stringify(value);
}

function toInt(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

function toFloatOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function decodeMaybe(value, context, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    return decodeJsonColumn(value, context);
  } catch {
    return fallback;
  }
}

function castLanguage(row) {
  if (!row) return null;
  return {
    code: String(row.code),
    name: String(row.name),
    native_name: String(row.native_name),
    iso_code: String(row.iso_code),
    writing_system: String(row.writing_system),
    direction: String(row.direction || "ltr"),
    features: typeof row.features === "string" ? row.features : encodeJsonColumn(row.features || {}),
    active: toInt(row.active, 1),
    updated_at: String(row.updated_at || new Date().toISOString()),
  };
}

function castProfile(row) {
  if (!row) return null;
  return {
    id: toInt(row.id),
    user_id: toInt(row.user_id),
    language_code: String(row.language_code),
    level: String(row.level || "Beginner"),
    goal: row.goal !== null && row.goal !== undefined ? String(row.goal) : null,
    explanation_language: String(row.explanation_language || "en"),
    status: String(row.status || "ACTIVE"),
    daily_minutes: toInt(row.daily_minutes, 20),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function castAssessment(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    profile_id: toInt(row.profile_id),
    user_id: toInt(row.user_id),
    language_code: String(row.language_code),
    status: String(row.status || "IN_PROGRESS"),
    state: decodeMaybe(row.state, "wf_language_assessments.state", {}),
    result: row.result !== null && row.result !== undefined
      ? decodeMaybe(row.result, "wf_language_assessments.result", null)
      : null,
    started_at: String(row.started_at),
    completed_at: row.completed_at !== null && row.completed_at !== undefined ? String(row.completed_at) : null,
  };
}

function castPath(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    profile_id: toInt(row.profile_id),
    language_code: String(row.language_code),
    from_level: String(row.from_level),
    target_level: String(row.target_level),
    status: String(row.status || "ACTIVE"),
    created_at: String(row.created_at),
  };
}

function castModule(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    path_id: String(row.path_id),
    profile_id: toInt(row.profile_id),
    language_code: String(row.language_code),
    sequence: toInt(row.sequence),
    code: String(row.code),
    title: String(row.title),
    focus_skill: String(row.focus_skill),
    level: String(row.level),
    status: String(row.status || "LOCKED"),
    attempts_count: toInt(row.attempts_count, 0),
    completed_at: row.completed_at !== null && row.completed_at !== undefined ? String(row.completed_at) : null,
  };
}

function castAttempt(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    profile_id: toInt(row.profile_id),
    user_id: toInt(row.user_id),
    language_code: String(row.language_code),
    module_id: row.module_id !== null && row.module_id !== undefined ? String(row.module_id) : null,
    kind: String(row.kind),
    score_pct: toFloatOrNull(row.score_pct),
    passed: row.passed === null || row.passed === undefined ? null : toInt(row.passed),
    detail: decodeMaybe(row.detail, "wf_lesson_attempts.detail", {}),
    created_at: String(row.created_at),
  };
}

function castConversation(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    profile_id: toInt(row.profile_id),
    user_id: toInt(row.user_id),
    language_code: String(row.language_code),
    scenario: String(row.scenario),
    mode: String(row.mode || "casual"),
    correction: String(row.correction || "important"),
    status: String(row.status || "ACTIVE"),
    state: decodeMaybe(row.state, "wf_conversation_sessions.state", {}),
    turn_count: toInt(row.turn_count, 0),
    started_at: String(row.started_at),
    completed_at: row.completed_at !== null && row.completed_at !== undefined ? String(row.completed_at) : null,
  };
}

function castWriting(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    profile_id: toInt(row.profile_id),
    user_id: toInt(row.user_id),
    language_code: String(row.language_code),
    task_code: String(row.task_code),
    original_text: String(row.original_text || ""),
    feedback: decodeMaybe(row.feedback, "wf_writing_attempts.feedback", {}),
    score_pct: toFloatOrNull(row.score_pct),
    created_at: String(row.created_at),
  };
}

function castVocabulary(row) {
  if (!row) return null;
  return {
    id: toInt(row.id),
    language_code: String(row.language_code),
    word: String(row.word),
    translation: String(row.translation),
    pronunciation: row.pronunciation !== null && row.pronunciation !== undefined ? String(row.pronunciation) : null,
    example_sentence: row.example_sentence !== null && row.example_sentence !== undefined ? String(row.example_sentence) : null,
    category: String(row.category),
    level: String(row.level),
    active: toInt(row.active, 1),
  };
}

function castUserVocabulary(row) {
  if (!row) return null;
  return {
    id: toInt(row.id),
    profile_id: toInt(row.profile_id),
    user_id: toInt(row.user_id),
    vocabulary_id: toInt(row.vocabulary_id),
    stage: toInt(row.stage, 0),
    familiarity: Number(row.familiarity ?? 0),
    next_review_at: String(row.next_review_at),
    review_count: toInt(row.review_count, 0),
    lapse_count: toInt(row.lapse_count, 0),
    last_result: row.last_result !== null && row.last_result !== undefined ? String(row.last_result) : null,
    last_reviewed_at: row.last_reviewed_at !== null && row.last_reviewed_at !== undefined ? String(row.last_reviewed_at) : null,
    added_at: String(row.added_at),
  };
}

function castListening(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    profile_id: toInt(row.profile_id),
    user_id: toInt(row.user_id),
    language_code: String(row.language_code),
    exercise_item_id: String(row.exercise_item_id),
    mode: String(row.mode),
    score_pct: toFloatOrNull(row.score_pct),
    passed: row.passed === null || row.passed === undefined ? null : toInt(row.passed),
    detail: decodeMaybe(row.detail, "wf_listening_attempts.detail", {}),
    created_at: String(row.created_at),
  };
}

function castSpeaking(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    profile_id: toInt(row.profile_id),
    user_id: toInt(row.user_id),
    language_code: String(row.language_code),
    prompt_text: String(row.prompt_text),
    transcript: row.transcript !== null && row.transcript !== undefined ? String(row.transcript) : null,
    word_accuracy_pct: toFloatOrNull(row.word_accuracy_pct),
    exact_match: toInt(row.exact_match, 0),
    provider: String(row.provider || "none"),
    detail: decodeMaybe(row.detail, "wf_speaking_attempts.detail", {}),
    created_at: String(row.created_at),
  };
}

function castDailyPlan(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    profile_id: toInt(row.profile_id),
    user_id: toInt(row.user_id),
    language_code: String(row.language_code),
    day: String(row.day),
    plan: decodeMaybe(row.plan, "wf_daily_learning_plans.plan", {}),
    est_minutes: toInt(row.est_minutes, 0),
    created_at: String(row.created_at),
  };
}

function castRecommendation(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    profile_id: toInt(row.profile_id),
    user_id: toInt(row.user_id),
    language_code: String(row.language_code),
    kind: String(row.kind),
    message: String(row.message),
    evidence: decodeMaybe(row.evidence, "wf_ai_learning_recommendations.evidence", {}),
    status: String(row.status || "ACTIVE"),
    created_at: String(row.created_at),
  };
}

function castProgress(row) {
  if (!row) return null;
  return {
    id: toInt(row.id),
    profile_id: toInt(row.profile_id),
    user_id: toInt(row.user_id),
    language_code: String(row.language_code),
    skill: String(row.skill),
    level: row.level !== null && row.level !== undefined ? String(row.level) : null,
    value_pct: toFloatOrNull(row.value_pct),
    source: String(row.source),
    updated_at: String(row.updated_at),
  };
}

export function createLanguageRepository(pool) {
  return {
    async upsertLanguage(row) {
      const features = typeof row.features === "string" ? row.features : encodeJsonColumn(row.features || {});
      await pool.query(
        `INSERT INTO wf_languages (code, name, native_name, iso_code, writing_system, direction, features, active, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           native_name = VALUES(native_name),
           iso_code = VALUES(iso_code),
           writing_system = VALUES(writing_system),
           direction = VALUES(direction),
           features = VALUES(features),
           active = VALUES(active),
           updated_at = VALUES(updated_at)`,
        [
          row.code,
          row.name,
          row.native_name,
          row.iso_code,
          row.writing_system,
          row.direction || "ltr",
          features,
          row.active ? 1 : 0,
          row.updated_at || new Date().toISOString(),
        ],
      );
    },

    async listLanguages(activeOnly = true) {
      const sql = activeOnly
        ? "SELECT * FROM wf_languages WHERE active = 1 ORDER BY name ASC"
        : "SELECT * FROM wf_languages ORDER BY name ASC";
      const [rows] = await pool.query(sql);
      return rows.map(castLanguage);
    },

    async findLanguage(code) {
      const [rows] = await pool.query("SELECT * FROM wf_languages WHERE code = ? LIMIT 1", [code]);
      return rows[0] ? castLanguage(rows[0]) : null;
    },

    async saveLanguageProfile(profile) {
      if (profile.id) {
        await pool.query(
          `UPDATE wf_user_language_profiles
           SET level = ?, goal = ?, explanation_language = ?, status = ?, daily_minutes = ?, updated_at = ?
           WHERE id = ?`,
          [
            profile.level || "Beginner",
            profile.goal ?? null,
            profile.explanation_language || "en",
            profile.status || "ACTIVE",
            toInt(profile.daily_minutes, 20),
            profile.updated_at || new Date().toISOString(),
            toInt(profile.id),
          ],
        );
        return this.findLanguageProfile(toInt(profile.id));
      }
      const [result] = await pool.query(
        `INSERT INTO wf_user_language_profiles
           (user_id, language_code, level, goal, explanation_language, status, daily_minutes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          toInt(profile.user_id),
          profile.language_code,
          profile.level || "Beginner",
          profile.goal ?? null,
          profile.explanation_language || "en",
          profile.status || "ACTIVE",
          toInt(profile.daily_minutes, 20),
          profile.created_at || new Date().toISOString(),
          profile.updated_at || new Date().toISOString(),
        ],
      );
      return this.findLanguageProfile(toInt(result.insertId));
    },

    async findLanguageProfile(id) {
      const [rows] = await pool.query("SELECT * FROM wf_user_language_profiles WHERE id = ? LIMIT 1", [toInt(id)]);
      return rows[0] ? castProfile(rows[0]) : null;
    },

    async findLanguageProfileByUserLanguage(userId, code) {
      const [rows] = await pool.query(
        "SELECT * FROM wf_user_language_profiles WHERE user_id = ? AND language_code = ? LIMIT 1",
        [toInt(userId), code],
      );
      return rows[0] ? castProfile(rows[0]) : null;
    },

    async listLanguageProfilesByUser(userId) {
      const [rows] = await pool.query(
        "SELECT * FROM wf_user_language_profiles WHERE user_id = ? ORDER BY created_at ASC, id ASC",
        [toInt(userId)],
      );
      return rows.map(castProfile);
    },

    async saveLanguageAssessment(assessment) {
      const stateJson = typeof assessment.state === "string"
        ? assessment.state
        : encodeJsonColumn(assessment.state || {});
      const resultJson = assessment.result === null || assessment.result === undefined
        ? null
        : typeof assessment.result === "string"
          ? assessment.result
          : encodeJsonColumn(assessment.result);
      await pool.query(
        `INSERT INTO wf_language_assessments
           (id, profile_id, user_id, language_code, status, state, result, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           status = VALUES(status),
           state = VALUES(state),
           result = VALUES(result),
           completed_at = VALUES(completed_at)`,
        [
          assessment.id,
          toInt(assessment.profile_id),
          toInt(assessment.user_id),
          assessment.language_code,
          assessment.status || "IN_PROGRESS",
          stateJson,
          resultJson,
          assessment.started_at || new Date().toISOString(),
          assessment.completed_at ?? null,
        ],
      );
      return this.findLanguageAssessment(assessment.id);
    },

    async findLanguageAssessment(id) {
      const [rows] = await pool.query("SELECT * FROM wf_language_assessments WHERE id = ? LIMIT 1", [id]);
      return rows[0] ? castAssessment(rows[0]) : null;
    },

    async latestCompletedLanguageAssessment(profileId) {
      const [rows] = await pool.query(
        "SELECT * FROM wf_language_assessments WHERE profile_id = ? AND status = 'COMPLETED' ORDER BY completed_at DESC LIMIT 1",
        [toInt(profileId)],
      );
      return rows[0] ? castAssessment(rows[0]) : null;
    },

    async saveLearningPath(pathRow) {
      await pool.query(
        `INSERT INTO wf_learning_paths
           (id, profile_id, language_code, from_level, target_level, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           from_level = VALUES(from_level),
           target_level = VALUES(target_level),
           status = VALUES(status)`,
        [
          pathRow.id,
          toInt(pathRow.profile_id),
          pathRow.language_code,
          pathRow.from_level,
          pathRow.target_level,
          pathRow.status || "ACTIVE",
          pathRow.created_at || new Date().toISOString(),
        ],
      );
      const [rows] = await pool.query("SELECT * FROM wf_learning_paths WHERE id = ? LIMIT 1", [pathRow.id]);
      return rows[0] ? castPath(rows[0]) : castPath(pathRow);
    },

    async activeLearningPath(profileId) {
      const [rows] = await pool.query(
        "SELECT * FROM wf_learning_paths WHERE profile_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1",
        [toInt(profileId)],
      );
      return rows[0] ? castPath(rows[0]) : null;
    },

    async saveLearningModule(mod) {
      await pool.query(
        `INSERT INTO wf_learning_modules
           (id, path_id, profile_id, language_code, sequence, code, title, focus_skill, level, status, attempts_count, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           code = VALUES(code),
           title = VALUES(title),
           focus_skill = VALUES(focus_skill),
           level = VALUES(level),
           status = VALUES(status),
           attempts_count = VALUES(attempts_count),
           completed_at = VALUES(completed_at)`,
        [
          mod.id,
          mod.path_id,
          toInt(mod.profile_id),
          mod.language_code,
          toInt(mod.sequence),
          mod.code,
          mod.title,
          mod.focus_skill,
          mod.level,
          mod.status || "LOCKED",
          toInt(mod.attempts_count, 0),
          mod.completed_at ?? null,
        ],
      );
      return this.findLearningModule(mod.id);
    },

    async findLearningModule(id) {
      const [rows] = await pool.query("SELECT * FROM wf_learning_modules WHERE id = ? LIMIT 1", [id]);
      return rows[0] ? castModule(rows[0]) : null;
    },

    async listLearningModules(pathId) {
      const [rows] = await pool.query(
        "SELECT * FROM wf_learning_modules WHERE path_id = ? ORDER BY sequence ASC",
        [pathId],
      );
      return rows.map(castModule);
    },

    async saveLessonAttempt(attempt) {
      const detailJson = typeof attempt.detail === "string"
        ? attempt.detail
        : encodeJsonColumn(attempt.detail || {});
      await pool.query(
        `INSERT INTO wf_lesson_attempts
           (id, profile_id, user_id, language_code, module_id, kind, score_pct, passed, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attempt.id,
          toInt(attempt.profile_id),
          toInt(attempt.user_id),
          attempt.language_code,
          attempt.module_id ?? null,
          attempt.kind,
          attempt.score_pct ?? null,
          attempt.passed === null || attempt.passed === undefined ? null : (attempt.passed ? 1 : 0),
          detailJson,
          attempt.created_at || new Date().toISOString(),
        ],
      );
      return castAttempt(attempt);
    },

    async listLessonAttemptsForProfile(profileId, limit = 100) {
      const bounded = Math.max(1, Math.min(300, toInt(limit, 100)));
      const [rows] = await pool.query(
        `SELECT * FROM wf_lesson_attempts WHERE profile_id = ? ORDER BY created_at DESC LIMIT ${bounded}`,
        [toInt(profileId)],
      );
      return rows.map(castAttempt);
    },

    async saveStudySession(session) {
      await pool.query(
        `INSERT INTO wf_study_sessions (id, profile_id, user_id, language_code, activity, day, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          session.id,
          toInt(session.profile_id),
          toInt(session.user_id),
          session.language_code,
          session.activity,
          session.day,
          session.created_at || new Date().toISOString(),
        ],
      );
    },

    async listStudySessionDays(profileId) {
      const [rows] = await pool.query(
        "SELECT DISTINCT day FROM wf_study_sessions WHERE profile_id = ? ORDER BY day DESC LIMIT 400",
        [toInt(profileId)],
      );
      return rows.map((row) => String(row.day));
    },

    async saveConversationSession(session) {
      const stateJson = typeof session.state === "string"
        ? session.state
        : encodeJsonColumn(session.state || {});
      await pool.query(
        `INSERT INTO wf_conversation_sessions
           (id, profile_id, user_id, language_code, scenario, mode, correction, status, state, turn_count, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           status = VALUES(status),
           state = VALUES(state),
           turn_count = VALUES(turn_count),
           completed_at = VALUES(completed_at)`,
        [
          session.id,
          toInt(session.profile_id),
          toInt(session.user_id),
          session.language_code,
          session.scenario,
          session.mode || "casual",
          session.correction || "important",
          session.status || "ACTIVE",
          stateJson,
          toInt(session.turn_count, 0),
          session.started_at || new Date().toISOString(),
          session.completed_at ?? null,
        ],
      );
      return this.findConversationSession(session.id);
    },

    async findConversationSession(id) {
      const [rows] = await pool.query("SELECT * FROM wf_conversation_sessions WHERE id = ? LIMIT 1", [id]);
      return rows[0] ? castConversation(rows[0]) : null;
    },

    async listConversationSessions(profileId, limit = 20) {
      const bounded = Math.max(1, Math.min(100, toInt(limit, 20)));
      const [rows] = await pool.query(
        `SELECT * FROM wf_conversation_sessions WHERE profile_id = ? ORDER BY started_at DESC LIMIT ${bounded}`,
        [toInt(profileId)],
      );
      return rows.map(castConversation);
    },

    async saveWritingAttempt(attempt) {
      const feedbackJson = typeof attempt.feedback === "string"
        ? attempt.feedback
        : encodeJsonColumn(attempt.feedback || {});
      await pool.query(
        `INSERT INTO wf_writing_attempts
           (id, profile_id, user_id, language_code, task_code, original_text, feedback, score_pct, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attempt.id,
          toInt(attempt.profile_id),
          toInt(attempt.user_id),
          attempt.language_code,
          attempt.task_code,
          attempt.original_text,
          feedbackJson,
          attempt.score_pct ?? null,
          attempt.created_at || new Date().toISOString(),
        ],
      );
      return castWriting(attempt);
    },

    async listWritingAttempts(profileId, limit = 20) {
      const bounded = Math.max(1, Math.min(100, toInt(limit, 20)));
      const [rows] = await pool.query(
        `SELECT * FROM wf_writing_attempts WHERE profile_id = ? ORDER BY created_at DESC LIMIT ${bounded}`,
        [toInt(profileId)],
      );
      return rows.map(castWriting);
    },

    async upsertVocabulary(word) {
      await pool.query(
        `INSERT INTO wf_vocabulary
           (language_code, word, translation, pronunciation, example_sentence, category, level, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           translation = VALUES(translation),
           pronunciation = VALUES(pronunciation),
           example_sentence = VALUES(example_sentence),
           category = VALUES(category),
           level = VALUES(level),
           active = VALUES(active)`,
        [
          word.language_code,
          word.word,
          word.translation,
          word.pronunciation ?? null,
          word.example_sentence ?? null,
          word.category,
          word.level,
          word.active ?? 1,
        ],
      );
      const [rows] = await pool.query(
        "SELECT * FROM wf_vocabulary WHERE language_code = ? AND word = ? LIMIT 1",
        [word.language_code, word.word],
      );
      return rows[0] ? castVocabulary(rows[0]) : castVocabulary(word);
    },

    async listVocabulary(languageCode, activeOnly = true) {
      const sql = activeOnly
        ? "SELECT * FROM wf_vocabulary WHERE language_code = ? AND active = 1 ORDER BY id ASC"
        : "SELECT * FROM wf_vocabulary WHERE language_code = ? ORDER BY id ASC";
      const [rows] = await pool.query(sql, [languageCode]);
      return rows.map(castVocabulary);
    },

    async findVocabulary(id) {
      const [rows] = await pool.query("SELECT * FROM wf_vocabulary WHERE id = ? LIMIT 1", [toInt(id)]);
      return rows[0] ? castVocabulary(rows[0]) : null;
    },

    async saveUserVocabulary(row) {
      await pool.query(
        `INSERT INTO wf_user_vocabulary
           (profile_id, user_id, vocabulary_id, stage, familiarity, next_review_at, review_count, lapse_count, last_result, last_reviewed_at, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           stage = VALUES(stage),
           familiarity = VALUES(familiarity),
           next_review_at = VALUES(next_review_at),
           review_count = VALUES(review_count),
           lapse_count = VALUES(lapse_count),
           last_result = VALUES(last_result),
           last_reviewed_at = VALUES(last_reviewed_at)`,
        [
          toInt(row.profile_id),
          toInt(row.user_id),
          toInt(row.vocabulary_id),
          toInt(row.stage, 0),
          Number(row.familiarity ?? 0),
          row.next_review_at,
          toInt(row.review_count, 0),
          toInt(row.lapse_count, 0),
          row.last_result ?? null,
          row.last_reviewed_at ?? null,
          row.added_at || new Date().toISOString(),
        ],
      );
      return this.findUserVocabulary(toInt(row.profile_id), toInt(row.vocabulary_id));
    },

    async findUserVocabulary(profileId, vocabularyId) {
      const [rows] = await pool.query(
        "SELECT * FROM wf_user_vocabulary WHERE profile_id = ? AND vocabulary_id = ? LIMIT 1",
        [toInt(profileId), toInt(vocabularyId)],
      );
      return rows[0] ? castUserVocabulary(rows[0]) : null;
    },

    async listUserVocabulary(profileId, dueOnly = false, limit = 100) {
      const bounded = Math.max(1, Math.min(200, toInt(limit, 100)));
      if (dueOnly) {
        const now = new Date().toISOString();
        const [rows] = await pool.query(
          `SELECT * FROM wf_user_vocabulary WHERE profile_id = ? AND next_review_at <= ? ORDER BY next_review_at ASC LIMIT ${bounded}`,
          [toInt(profileId), now],
        );
        return rows.map(castUserVocabulary);
      }
      const [rows] = await pool.query(
        `SELECT * FROM wf_user_vocabulary WHERE profile_id = ? ORDER BY next_review_at ASC LIMIT ${bounded}`,
        [toInt(profileId)],
      );
      return rows.map(castUserVocabulary);
    },

    async saveListeningAttempt(attempt) {
      const detailJson = typeof attempt.detail === "string"
        ? attempt.detail
        : encodeJsonColumn(attempt.detail || {});
      await pool.query(
        `INSERT INTO wf_listening_attempts
           (id, profile_id, user_id, language_code, exercise_item_id, mode, score_pct, passed, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attempt.id,
          toInt(attempt.profile_id),
          toInt(attempt.user_id),
          attempt.language_code,
          attempt.exercise_item_id,
          attempt.mode,
          attempt.score_pct ?? null,
          attempt.passed === null || attempt.passed === undefined ? null : (attempt.passed ? 1 : 0),
          detailJson,
          attempt.created_at || new Date().toISOString(),
        ],
      );
      return castListening(attempt);
    },

    async listListeningAttempts(profileId, limit = 20) {
      const bounded = Math.max(1, Math.min(100, toInt(limit, 20)));
      const [rows] = await pool.query(
        `SELECT * FROM wf_listening_attempts WHERE profile_id = ? ORDER BY created_at DESC LIMIT ${bounded}`,
        [toInt(profileId)],
      );
      return rows.map(castListening);
    },

    async saveSpeakingAttempt(attempt) {
      const detailJson = typeof attempt.detail === "string"
        ? attempt.detail
        : encodeJsonColumn(attempt.detail || {});
      await pool.query(
        `INSERT INTO wf_speaking_attempts
           (id, profile_id, user_id, language_code, prompt_text, transcript, word_accuracy_pct, exact_match, provider, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attempt.id,
          toInt(attempt.profile_id),
          toInt(attempt.user_id),
          attempt.language_code,
          attempt.prompt_text,
          attempt.transcript ?? null,
          attempt.word_accuracy_pct ?? null,
          attempt.exact_match ? 1 : 0,
          attempt.provider || "none",
          detailJson,
          attempt.created_at || new Date().toISOString(),
        ],
      );
      return castSpeaking(attempt);
    },

    async listSpeakingAttempts(profileId, limit = 20) {
      const bounded = Math.max(1, Math.min(100, toInt(limit, 20)));
      const [rows] = await pool.query(
        `SELECT * FROM wf_speaking_attempts WHERE profile_id = ? ORDER BY created_at DESC LIMIT ${bounded}`,
        [toInt(profileId)],
      );
      return rows.map(castSpeaking);
    },

    async saveDailyLearningPlan(planRow) {
      const planJson = typeof planRow.plan === "string"
        ? planRow.plan
        : encodeJsonColumn(planRow.plan || {});
      await pool.query(
        `INSERT INTO wf_daily_learning_plans
           (id, profile_id, user_id, language_code, day, plan, est_minutes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           plan = VALUES(plan),
           est_minutes = VALUES(est_minutes),
           created_at = VALUES(created_at)`,
        [
          planRow.id,
          toInt(planRow.profile_id),
          toInt(planRow.user_id),
          planRow.language_code,
          planRow.day,
          planJson,
          toInt(planRow.est_minutes, 0),
          planRow.created_at || new Date().toISOString(),
        ],
      );
      return this.findDailyLearningPlan(toInt(planRow.profile_id), planRow.day);
    },

    async findDailyLearningPlan(profileId, day) {
      const [rows] = await pool.query(
        "SELECT * FROM wf_daily_learning_plans WHERE profile_id = ? AND day = ? LIMIT 1",
        [toInt(profileId), day],
      );
      return rows[0] ? castDailyPlan(rows[0]) : null;
    },

    async saveAiLearningRecommendation(row) {
      const evidenceJson = typeof row.evidence === "string"
        ? row.evidence
        : encodeJsonColumn(row.evidence || {});
      await pool.query(
        `INSERT INTO wf_ai_learning_recommendations
           (id, profile_id, user_id, language_code, kind, message, evidence, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          toInt(row.profile_id),
          toInt(row.user_id),
          row.language_code,
          row.kind,
          row.message,
          evidenceJson,
          row.status || "ACTIVE",
          row.created_at || new Date().toISOString(),
        ],
      );
      return castRecommendation(row);
    },

    async clearAiLearningRecommendations(profileId) {
      await pool.query("DELETE FROM wf_ai_learning_recommendations WHERE profile_id = ?", [toInt(profileId)]);
    },

    async upsertLanguageProgress(row) {
      await pool.query(
        `INSERT INTO wf_language_progress
           (profile_id, user_id, language_code, skill, level, value_pct, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           level = VALUES(level),
           value_pct = VALUES(value_pct),
           updated_at = VALUES(updated_at)`,
        [
          toInt(row.profile_id),
          toInt(row.user_id, 0),
          row.language_code,
          row.skill,
          row.level ?? null,
          row.value_pct ?? null,
          row.source,
          row.updated_at || new Date().toISOString(),
        ],
      );
    },

    async listLanguageProgress(profileId) {
      const [rows] = await pool.query("SELECT * FROM wf_language_progress WHERE profile_id = ?", [toInt(profileId)]);
      return rows.map(castProgress);
    },
  };
}
