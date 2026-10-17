import { randomBytes } from "node:crypto";
import { AppError } from "../../http/errors.js";
import { CEFR_LEVELS, Curriculum, ItemBanks, LanguageRegistry } from "./registry.js";
import { TeacherContent, Translator, VocabularyBank } from "./content.js";

const ASSESSABLE_SKILLS = Object.freeze(["vocabulary", "grammar", "reading"]);
const PENDING_SKILLS_NOTE =
  "Listening, speaking and writing are not assessed in this build — they arrive with Phase 2/4 providers and will never be faked.";

export const VOCAB_INTERVAL_DAYS = Object.freeze([1, 3, 7, 14, 30, 90]);
export const VOCAB_LEARNED_STAGE = 4;
const MIN_ATTEMPTS_FOR_SKILL = 3;

const FOLD_MAP = Object.freeze({
  à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a", ā: "a", ă: "a",
  è: "e", é: "e", ê: "e", ë: "e", ē: "e", ę: "e", ė: "e", ẹ: "e",
  ì: "i", í: "i", î: "i", ï: "i", ī: "i", į: "i", ị: "i",
  ò: "o", ó: "o", ô: "o", õ: "o", ö: "o", ø: "o", ō: "o", ő: "o", ọ: "o",
  ù: "u", ú: "u", û: "u", ü: "u", ū: "u", ů: "u", ű: "u", ụ: "u",
  ç: "c", ć: "c", č: "c", ď: "d", đ: "d", ñ: "n", ń: "n", ň: "n",
  ř: "r", š: "s", ş: "s", ș: "s", ß: "ss", ť: "t", ţ: "t", ț: "t",
  ł: "l", ľ: "l", ž: "z", ź: "z", ż: "z", ğ: "g", ġ: "g", ḥ: "h",
  ṣ: "s", ṭ: "t", ḍ: "d", ý: "y", ÿ: "y", ɛ: "e", ɔ: "o", ɲ: "ny",
  ŋ: "ng", ɣ: "gh", ʃ: "sh", ɩ: "i", ʼ: "",
});

function uuid() {
  return randomBytes(16).toString("hex");
}

function foldDiacritics(str) {
  let out = "";
  for (const ch of String(str || "").trim().toLowerCase()) {
    out += Object.prototype.hasOwnProperty.call(FOLD_MAP, ch) ? FOLD_MAP[ch] : ch;
  }
  return out
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function spokenSentence(prompt) {
  const str = String(prompt || "");
  const quoted = str.match(/['"«„]([^'"»“]+)['"»“]/u);
  if (quoted) return quoted[1].trim();
  const stripped = str.replace(/\s*\([^)]*\)\s*/gu, " ");
  const cut = stripped.split(/\s+means\b/u)[0] || "";
  return cut.replace(/^[\s.:!?¡¿„]+|[\s.:!?¡¿„]+$/gu, "");
}

export function comprehensionQuestion(prompt) {
  const str = String(prompt || "");
  const tail = str.match(/['"»“]\s*([^'"]+\?)$/u);
  if (tail) return tail[1].trim();
  const means = str.match(/means\s+([^.]*\.?)\?*$/u);
  if (means) return `What does it mean? — ${means[1].replace(/^[ .?]+|[ .?]+$/gu, "")}`;
  return "What did you hear?";
}

export function audioTokens(text) {
  const normalized = foldDiacritics(text);
  if (!normalized) return [];
  return normalized.split(/\s+/u).filter(Boolean);
}

export function wordAccuracy(expected, transcript) {
  const expectedTokens = audioTokens(expected);
  if (!expectedTokens.length) return 0.0;
  const have = {};
  for (const t of audioTokens(transcript)) {
    have[t] = (have[t] || 0) + 1;
  }
  let matched = 0;
  for (const t of expectedTokens) {
    if ((have[t] || 0) > 0) {
      matched += 1;
      have[t] -= 1;
    }
  }
  return Math.round((100 * matched / expectedTokens.length) * 100) / 100;
}

export function matchedWords(expected, transcript) {
  const have = {};
  for (const t of audioTokens(transcript)) {
    have[t] = (have[t] || 0) + 1;
  }
  const out = [];
  for (const t of audioTokens(expected)) {
    if ((have[t] || 0) > 0) {
      out.push(t);
      have[t] -= 1;
    }
  }
  return out;
}

export function transcriptionSimilarity(expected, typed) {
  return wordAccuracy(expected, typed);
}

export function createLanguageLearningService({ store = null, now = () => new Date() } = {}) {

  function isoNow() {
    return now().toISOString();
  }

  function utcDay(offsetDays = 0) {
    const d = new Date(now().getTime() + offsetDays * 86400 * 1000);
    return d.toISOString().slice(0, 10);
  }

  async function recordAttempt(profileId, userId, lang, moduleId, kind, scorePct, passed, detail) {
    await store.saveLessonAttempt({
      id: uuid(),
      profile_id: Number(profileId),
      user_id: Number(userId),
      language_code: String(lang),
      module_id: moduleId ?? null,
      kind,
      score_pct: scorePct,
      passed: passed === null || passed === undefined ? null : (passed ? 1 : 0),
      detail,
      created_at: isoNow(),
    });
  }

  async function recordSession(profileId, userId, lang, activity) {
    await store.saveStudySession({
      id: uuid(),
      profile_id: Number(profileId),
      user_id: Number(userId),
      language_code: String(lang),
      activity,
      day: utcDay(0),
      created_at: isoNow(),
    });
  }

  // ------------------------------------------------------------ Phase 1: Core

  async function syncRegistry() {
    let count = 0;
    for (const [code, lang] of Object.entries(LanguageRegistry.all())) {
      await store.upsertLanguage({
        code,
        name: lang.name,
        native_name: lang.native_name,
        iso_code: lang.iso_code,
        writing_system: lang.writing_system,
        direction: lang.direction,
        features: JSON.stringify(lang.features),
        active: lang.active ? 1 : 0,
        updated_at: isoNow(),
      });
      count += 1;
    }
    return { synced: count };
  }

  async function languages() {
    let rows = await store.listLanguages();
    if (!rows.length) {
      await syncRegistry();
      rows = await store.listLanguages();
    }
    return rows.map((row) => ({
      ...row,
      features: typeof row.features === "string" ? JSON.parse(row.features || "{}") : (row.features || {}),
    }));
  }

  function language(code) {
    const lang = LanguageRegistry.get(code);
    if (!lang || !lang.active) {
      throw AppError.badRequest(`language ${code} is not in the registry`, { code: "INVALID_LANGUAGE" });
    }
    return lang;
  }

  async function startLanguage(userId, code, goal = null, explanationLanguage = "en") {
    const cleanCode = String(code || "").trim().toLowerCase();
    language(cleanCode);
    const existing = await store.findLanguageProfileByUserLanguage(Number(userId), cleanCode);
    if (existing) return existing;
    return store.saveLanguageProfile({
      user_id: Number(userId),
      language_code: cleanCode,
      level: "Beginner",
      goal: goal === null || goal === undefined ? "" : String(goal).slice(0, 300),
      explanation_language: String(explanationLanguage || "en").slice(0, 8),
      status: "ACTIVE",
      daily_minutes: 20,
      created_at: isoNow(),
      updated_at: isoNow(),
    });
  }

  async function profileOwned(profileId, userId) {
    const profile = await store.findLanguageProfile(Number(profileId));
    if (!profile || Number(profile.user_id) !== Number(userId)) {
      throw AppError.notFound("profile not found", { code: "PROFILE_NOT_FOUND" });
    }
    return profile;
  }

  async function progressFor(profile) {
    const pid = Number(profile.id);
    const rows = await store.listLanguageProgress(pid);
    const skills = {};
    let pathPct = null;
    for (const r of rows) {
      if (r.source === "assessment") {
        skills[r.skill] = { level: r.level, source: "assessment" };
      }
      if (r.source === "path_completion" && r.value_pct !== null && r.value_pct !== undefined) {
        pathPct = Number(r.value_pct);
      }
    }
    const days = await store.listStudySessionDays(pid);
    let streak = 0;
    const today = utcDay(0);
    const yesterday = utcDay(-1);
    if (days.length > 0 && (days.includes(today) || days.includes(yesterday))) {
      let cursor = days.includes(today) ? today : yesterday;
      const daySet = new Set(days);
      while (daySet.has(cursor)) {
        streak += 1;
        const prevMs = Date.parse(`${cursor}T00:00:00Z`) - 86400 * 1000;
        cursor = new Date(prevMs).toISOString().slice(0, 10);
      }
    }
    return {
      level: profile.level,
      levelSource: profile.level === "Beginner" ? "default (no assessment yet)" : "assessment",
      skills: {
        ...skills,
        listening: skills.listening || { level: null, source: "not_assessed_this_build" },
        speaking: skills.speaking || { level: null, source: "not_assessed_this_build" },
        writing: skills.writing || { level: null, source: "not_assessed_this_build" },
      },
      pathCompletionPct: pathPct,
      studyStreakDays: streak,
      activeDays: days.length,
    };
  }

  async function profiles(userId) {
    const list = await store.listLanguageProfilesByUser(Number(userId));
    const out = [];
    for (const p of list) {
      out.push({
        ...p,
        language: LanguageRegistry.get(p.language_code) || { name: p.language_code },
        progress: await progressFor(p),
      });
    }
    return out;
  }

  // ---------------------------------------------------------- Assessment

  function assessmentProgressMeta(state) {
    const skills = state.skills || [];
    const done = Math.min(state.skillIdx || 0, skills.length);
    return {
      skills,
      skillIndex: done,
      questionsAnswered: (state.asked || []).length,
    };
  }

  async function completeAssessment(a, state, userId) {
    const levelsIn = CEFR_LEVELS;
    const perSkill = {};
    const idxs = [];
    for (const skill of state.skills || []) {
      const log = state.skillState?.[skill]?.log || [];
      let achieved = "Beginner";
      const byLevel = {};
      for (const l of log) {
        if (!byLevel[l.level]) byLevel[l.level] = [];
        byLevel[l.level].push(Boolean(l.correct));
      }
      for (const lv of levelsIn) {
        const at = byLevel[lv] || [];
        const correctCount = at.filter(Boolean).length;
        if (at.length > 0 && correctCount >= Math.max(1, Math.ceil(at.length / 2))) {
          achieved = lv;
        }
      }
      perSkill[skill] = {
        level: achieved,
        correct: log.filter((l) => l.correct).length,
        total: log.length,
      };
      idxs.push(levelsIn.indexOf(achieved));
    }
    idxs.sort((x, y) => x - y);
    const overall = idxs.length ? (levelsIn[idxs[Math.floor(idxs.length / 2)]] || "Beginner") : "Beginner";
    const ceiling = state.ceiling || "Beginner";
    const capped = LanguageRegistry.levelIndex(overall) > LanguageRegistry.levelIndex(ceiling) ? ceiling : overall;

    const strengths = Object.keys(perSkill).filter(
      (s) => LanguageRegistry.levelIndex(perSkill[s].level) > LanguageRegistry.levelIndex(capped),
    );
    const weaknesses = Object.keys(perSkill).filter(
      (s) => LanguageRegistry.levelIndex(perSkill[s].level) < LanguageRegistry.levelIndex(capped),
    );

    const result = {
      overallLevel: capped,
      perSkill,
      strengths,
      weaknesses,
      bankCeiling: ceiling,
      ceilingNote: capped === ceiling && capped !== "C2"
        ? `Level verified up to the current bank ceiling (${ceiling}) for this language — higher levels need a deeper item bank before they can be awarded.`
        : null,
      notAssessed: ["listening", "speaking", "writing"],
      notAssessedNote: PENDING_SKILLS_NOTE,
      answers: state.asked || [],
    };

    await store.saveLanguageAssessment({
      ...a,
      status: "COMPLETED",
      state,
      result,
      completed_at: isoNow(),
    });

    const profile = await store.findLanguageProfile(Number(a.profile_id));
    if (profile) {
      await store.saveLanguageProfile({
        ...profile,
        level: capped,
        updated_at: isoNow(),
      });
    }

    for (const [skill, s] of Object.entries(perSkill)) {
      await store.upsertLanguageProgress({
        profile_id: Number(a.profile_id),
        user_id: Number(userId),
        language_code: a.language_code,
        skill,
        level: s.level,
        value_pct: null,
        source: "assessment",
        updated_at: isoNow(),
      });
    }

    const totalAsked = Math.max(1, (result.answers || []).length);
    const totalCorrect = (result.answers || []).filter((x) => x.correct).length;
    const scorePct = Math.round((100 * totalCorrect) / totalAsked);
    await recordAttempt(a.profile_id, userId, a.language_code, null, "assessment", scorePct, null, result);
    await recordSession(a.profile_id, userId, a.language_code, "assessment");

    return { status: "COMPLETED", assessmentId: a.id, result };
  }

  async function advanceAssessment(a, userId) {
    const state = typeof a.state === "string" ? JSON.parse(a.state || "{}") : structuredClone(a.state || {});
    const items = ItemBanks.items(a.language_code);
    const askedIds = new Set((state.asked || []).map((x) => x.id));

    while (state.skillIdx < state.skills.length) {
      const skill = state.skills[state.skillIdx];
      const ss = state.skillState[skill] || { levelIdx: null, log: [] };
      const levels = [];
      for (const it of items) {
        if (it.skill === skill && !levels.includes(it.level)) levels.push(it.level);
      }
      if (ss.levelIdx === null || ss.levelIdx === undefined) ss.levelIdx = 0;

      const log = ss.log || [];
      let next = null;
      while (ss.levelIdx < levels.length) {
        const level = levels[ss.levelIdx];
        const pool = items.filter((it) => it.skill === skill && it.level === level && !askedIds.has(it.id));
        const atLevel = log.filter((l) => l.level === level);
        const correctAt = atLevel.filter((l) => l.correct).length;

        if (
          atLevel.length >= 2 ||
          (correctAt >= 1 &&
            atLevel.length >= 1 &&
            ss.levelIdx + 1 < levels.length &&
            log.filter((l) => l.level === levels[ss.levelIdx + 1]).length === 0)
        ) {
          if (correctAt >= 1) {
            ss.levelIdx += 1;
            continue;
          }
          break;
        }
        if (atLevel.length >= 2 && correctAt === 0) break;
        if (!pool.length) {
          if (correctAt >= 1 && ss.levelIdx + 1 < levels.length) {
            ss.levelIdx += 1;
            continue;
          }
          break;
        }
        next = pool[0];
        break;
      }

      state.skillState[skill] = ss;
      if (next !== null) {
        state.pendingItem = ItemBanks.publicItem(next);
        await store.saveLanguageAssessment({ ...a, state });
        return {
          status: "IN_PROGRESS",
          assessmentId: a.id,
          item: state.pendingItem,
          progress: assessmentProgressMeta(state),
        };
      }
      state.skillIdx += 1;
    }

    return completeAssessment(a, { ...state, pendingItem: null }, userId);
  }

  async function startAssessment(userId, profileId) {
    const profile = await profileOwned(profileId, userId);
    const code = profile.language_code;
    if (ItemBanks.count(code) === 0) {
      throw AppError.conflict(
        `no assessment bank for ${code} yet — this language is registered, assessment arrives with its content bank`,
        { code: "NO_ASSESSMENT_BANK" },
      );
    }
    const ceiling = ItemBanks.ceiling(code);
    const items = ItemBanks.items(code);
    const state = {
      ceiling,
      skills: ASSESSABLE_SKILLS.filter((s) => items.some((i) => i.skill === s)),
      skillIdx: 0,
      skillState: {},
      asked: [],
      pendingItem: null,
    };
    const assessment = await store.saveLanguageAssessment({
      id: uuid(),
      profile_id: Number(profileId),
      user_id: Number(userId),
      language_code: code,
      status: "IN_PROGRESS",
      state,
      result: null,
      started_at: isoNow(),
      completed_at: null,
    });
    return advanceAssessment(assessment, Number(userId));
  }

  async function assessmentOwned(assessmentId, userId) {
    const a = await store.findLanguageAssessment(String(assessmentId));
    if (!a || Number(a.user_id) !== Number(userId)) {
      throw AppError.notFound("assessment not found", { code: "ASSESSMENT_NOT_FOUND" });
    }
    return a;
  }

  async function answerAssessment(assessmentId, userId, answerIndex) {
    const a = await assessmentOwned(assessmentId, userId);
    if (a.status !== "IN_PROGRESS") {
      throw AppError.conflict("assessment already completed", { code: "ASSESSMENT_COMPLETED" });
    }
    const state = typeof a.state === "string" ? JSON.parse(a.state || "{}") : structuredClone(a.state || {});
    const pending = state.pendingItem || null;
    if (!pending) {
      throw AppError.conflict("no pending question", { code: "NO_PENDING_QUESTION" });
    }
    const item = ItemBanks.find(a.language_code, pending.id);
    if (!item) {
      throw AppError.internal("pending item vanished");
    }
    const correct = Number(answerIndex) === item.answer;
    const skill = pending.skill;
    const ss = state.skillState[skill] || { levelIdx: null, log: [] };
    ss.log.push({ itemId: item.id, level: item.level, correct });
    state.skillState[skill] = ss;
    state.asked.push({
      id: item.id,
      correct,
      level: item.level,
      skill,
      answer: Number(answerIndex),
      explanation: item.explanation,
    });
    state.pendingItem = null;
    await store.saveLanguageAssessment({ ...a, state });
    return advanceAssessment({ ...a, state }, Number(userId));
  }

  // -------------------------------------------------------- Learning Path

  async function pathFor(userId, profileId) {
    await profileOwned(profileId, userId);
    const pathRow = await store.activeLearningPath(Number(profileId));
    if (!pathRow) return { path: null, modules: [] };
    const modules = await store.listLearningModules(pathRow.id);
    return { path: pathRow, modules };
  }

  async function generatePath(userId, profileId) {
    const profile = await profileOwned(profileId, userId);
    const code = profile.language_code;
    const ceiling = ItemBanks.ceiling(code);
    const from = profile.level === "Beginner" ? "A1" : profile.level;
    let target = LanguageRegistry.levelIndex(ceiling) > LanguageRegistry.levelIndex(from) ? ceiling : from;
    if (target === from) {
      target = CEFR_LEVELS[Math.min(CEFR_LEVELS.length - 1, LanguageRegistry.levelIndex(from) + 1)];
    }
    const lang = language(code);
    const pathRow = await store.saveLearningPath({
      id: uuid(),
      profile_id: Number(profileId),
      language_code: code,
      from_level: from,
      target_level: target,
      status: "ACTIVE",
      created_at: isoNow(),
    });
    let seq = 0;
    for (const m of Curriculum.modulesFor(from, target)) {
      seq += 1;
      await store.saveLearningModule({
        id: uuid(),
        path_id: pathRow.id,
        profile_id: Number(profileId),
        language_code: code,
        sequence: seq,
        code: m.code,
        title: `${lang.name} ${m.level} · ${m.title}`,
        focus_skill: m.focus,
        level: m.level,
        status: seq === 1 ? "AVAILABLE" : "LOCKED",
        attempts_count: 0,
        completed_at: null,
      });
    }
    return pathFor(userId, profileId);
  }

  async function moduleOwned(moduleId, userId) {
    const m = await store.findLearningModule(String(moduleId));
    if (!m) throw AppError.notFound("module not found", { code: "MODULE_NOT_FOUND" });
    await profileOwned(Number(m.profile_id), userId);
    return m;
  }

  function quizFor(mod) {
    const items = ItemBanks.items(mod.language_code);
    const at = items.filter((i) => i.level === mod.level);
    at.sort((x, y) => {
      const xFocus = x.skill === mod.focus_skill ? -1 : 1;
      const yFocus = y.skill === mod.focus_skill ? -1 : 1;
      return xFocus - yFocus;
    });
    return at.slice(0, Math.min(4, Math.max(2, at.length)));
  }

  async function startCheckpoint(moduleId, userId) {
    const m = await moduleOwned(moduleId, userId);
    if (m.status === "LOCKED") {
      throw AppError.conflict("module is locked — complete the previous module first", { code: "MODULE_LOCKED" });
    }
    if (m.status === "COMPLETED") {
      throw AppError.conflict("module already completed", { code: "MODULE_COMPLETED" });
    }
    const quiz = quizFor(m);
    if (quiz.length < 2) {
      throw AppError.conflict("not enough bank items at this level for a checkpoint yet", { code: "INSUFFICIENT_BANK" });
    }
    const updated = await store.saveLearningModule({
      ...m,
      status: "IN_PROGRESS",
      attempts_count: Number(m.attempts_count || 0) + 1,
    });
    return {
      module: updated,
      quiz: quiz.map((i) => ItemBanks.publicItem(i)),
    };
  }

  async function refreshPathCompletion(m) {
    const modules = await store.listLearningModules(m.path_id);
    const completed = modules.filter((x) => x.status === "COMPLETED").length;
    const pct = modules.length ? Math.round((100 * completed / modules.length) * 100) / 100 : 0.0;
    await store.upsertLanguageProgress({
      profile_id: Number(m.profile_id),
      user_id: 0,
      language_code: m.language_code,
      skill: "overall",
      level: null,
      value_pct: pct,
      source: "path_completion",
      updated_at: isoNow(),
    });
  }

  async function submitCheckpoint(moduleId, userId, answers, kind = "checkpoint") {
    const m = await moduleOwned(moduleId, userId);
    const quiz = quizFor(m);
    const outcomes = [];
    let correct = 0;
    for (let i = 0; i < quiz.length; i += 1) {
      const item = quiz[i];
      const given = answers?.[item.id] ?? answers?.[String(i)] ?? null;
      const ok = given !== null && given !== undefined && given !== "" && Number.isFinite(Number(given)) && Number(given) === item.answer;
      if (ok) correct += 1;
      outcomes.push({
        itemId: item.id,
        correct: ok,
        explanation: ok ? item.explanation : `${item.prompt} — ${item.explanation}`,
      });
    }
    const score = Math.round((100 * correct) / Math.max(1, quiz.length));
    const passed = score >= 75;
    if (passed) {
      await store.saveLearningModule({
        ...m,
        status: "COMPLETED",
        completed_at: isoNow(),
      });
      const siblings = await store.listLearningModules(m.path_id);
      for (const sib of siblings) {
        if (Number(sib.sequence) === Number(m.sequence) + 1 && sib.status === "LOCKED") {
          await store.saveLearningModule({
            ...sib,
            status: "AVAILABLE",
          });
        }
      }
      await refreshPathCompletion(m);
    }
    await recordAttempt(Number(m.profile_id), userId, m.language_code, m.id, kind, score, passed, {
      outcomes,
      module: m.title,
    });
    await recordSession(Number(m.profile_id), userId, m.language_code, "checkpoint");
    return {
      passed,
      scorePct: score,
      correct,
      total: quiz.length,
      outcomes,
      moduleStatus: passed ? "COMPLETED" : m.status,
    };
  }

  // -------------------------------------------------------- Phase 2: AI Teacher

  async function startLesson(moduleId, userId) {
    const m = await moduleOwned(moduleId, userId);
    if (m.status === "LOCKED") {
      throw AppError.conflict("module is locked — complete the previous module first", { code: "MODULE_LOCKED" });
    }
    if (m.status === "COMPLETED") {
      throw AppError.conflict("module already completed", { code: "MODULE_COMPLETED" });
    }
    const lang = language(m.language_code);
    const dashIdx = String(m.code).indexOf("-");
    const moduleCode = dashIdx === -1 ? String(m.code) : String(m.code).slice(dashIdx + 1);
    const frame = TeacherContent.LESSON_FRAMES[moduleCode] || {
      goal: "Practice this module",
      teach: "Study the examples, then practice.",
    };
    const quiz = quizFor(m);
    if (quiz.length < 2) {
      throw AppError.conflict("not enough bank items at this level for a lesson yet", { code: "INSUFFICIENT_BANK" });
    }
    const updated = await store.saveLearningModule({
      ...m,
      status: "IN_PROGRESS",
      attempts_count: Number(m.attempts_count || 0) + 1,
    });
    const examples = quiz.slice(0, 2).map((i) => ({
      prompt: i.prompt,
      correct: i.options[i.answer],
      why: i.explanation,
    }));
    return {
      module: updated,
      lesson: {
        title: updated.title,
        goal: frame.goal,
        teach: frame.teach.replace("{lang}", lang.name),
        examples,
        practiceItems: quiz.map((i) => ItemBanks.publicItem(i)),
        passMarkPct: 75,
      },
    };
  }

  async function submitLesson(moduleId, userId, answers) {
    return submitCheckpoint(moduleId, userId, answers, "lesson");
  }

  function findScenario(lang, code) {
    for (const s of TeacherContent.conversations(lang)) {
      if (s.code === code) return s;
    }
    throw AppError.conflict(`conversation scenario ${code} is not available for ${lang} yet`, {
      code: "SCENARIO_UNAVAILABLE",
    });
  }

  function conversationView(session, scenario) {
    const turnIdx = Number(session.state?.turnIdx || 0);
    const turn = scenario.turns[turnIdx] || null;
    return {
      status: "ACTIVE",
      sessionId: session.id,
      scenario: scenario.title,
      languageCode: session.language_code,
      correctionMode: session.correction,
      aiOpens: scenario.aiOpeners?.[0] || "",
      turn: turn === null
        ? null
        : {
            index: turnIdx + 1,
            total: scenario.turns.length,
            instruction: turn.instruction,
          },
      attemptsThisTurn: Number(session.state?.attemptsThisTurn || 0),
    };
  }

  function turnMatches(text, turn) {
    const hay = String(text || "").toLowerCase();
    if (turn.requireAll) {
      for (const group of Object.values(turn.requireAll)) {
        const hit = group.some((p) => hay.includes(String(p).toLowerCase()));
        if (!hit) return false;
      }
      return true;
    }
    return (turn.patterns || []).some((p) => hay.includes(String(p).toLowerCase()));
  }

  async function conversations(userId, profileId) {
    const profile = await profileOwned(profileId, userId);
    const scenarios = TeacherContent.conversations(profile.language_code);
    return scenarios.map((s) => ({
      code: s.code,
      title: s.title,
      mode: s.mode,
      turns: s.turns.length,
    }));
  }

  async function startConversation(userId, profileId, scenarioCode, correction = "important") {
    const profile = await profileOwned(profileId, userId);
    if (!["immediate", "after", "important", "conversation_only"].includes(correction)) {
      throw AppError.badRequest("correction must be immediate|after|important|conversation_only", {
        code: "INVALID_CORRECTION_MODE",
      });
    }
    const scenario = findScenario(profile.language_code, scenarioCode);
    const session = await store.saveConversationSession({
      id: uuid(),
      profile_id: Number(profileId),
      user_id: Number(userId),
      language_code: profile.language_code,
      scenario: scenario.code,
      mode: scenario.mode,
      correction,
      status: "ACTIVE",
      state: { turnIdx: 0, history: [], attemptsThisTurn: 0 },
      turn_count: 0,
      started_at: isoNow(),
      completed_at: null,
    });
    return conversationView(session, scenario);
  }

  async function conversationStateForPage(sessionId, userId) {
    const session = await store.findConversationSession(String(sessionId));
    if (!session || Number(session.user_id) !== Number(userId)) {
      throw AppError.notFound("conversation not found", { code: "CONVERSATION_NOT_FOUND" });
    }
    const scenario = findScenario(session.language_code, session.scenario);
    const state = session.state || {};
    const hist = state.history || [];
    if (session.status === "COMPLETED") {
      const good = hist.filter((h) => h.ok).length;
      return {
        status: "COMPLETED",
        summary: {
          turns: hist.length,
          unassisted: good,
          scorePct: Math.round((100 * good) / Math.max(1, hist.length)),
          history: hist,
        },
      };
    }
    return {
      ...conversationView(session, scenario),
      history: hist.slice(-4),
    };
  }

  async function conversationTurn(sessionId, userId, text) {
    const session = await store.findConversationSession(String(sessionId));
    if (!session || Number(session.user_id) !== Number(userId)) {
      throw AppError.notFound("conversation not found", { code: "CONVERSATION_NOT_FOUND" });
    }
    if (session.status !== "ACTIVE") {
      throw AppError.conflict("conversation already completed", { code: "CONVERSATION_COMPLETED" });
    }
    const scenario = findScenario(session.language_code, session.scenario);
    const state = structuredClone(session.state || { turnIdx: 0, history: [], attemptsThisTurn: 0 });
    const turnIdx = Number(state.turnIdx || 0);
    const turn = scenario.turns[turnIdx] || null;
    if (!turn) {
      throw AppError.conflict("no pending turn", { code: "NO_PENDING_TURN" });
    }
    const cleanText = String(text || "").trim();
    if (cleanText.length < 1) {
      throw AppError.badRequest("say something first", { code: "EMPTY_TURN" });
    }
    const ok = turnMatches(cleanText, turn);
    const attemptNo = Number(state.attemptsThisTurn || 0) + 1;
    state.history.push({
      turn: turnIdx,
      text: cleanText.slice(0, 500),
      ok,
      attempt: attemptNo,
    });

    let assisted = false;
    if (ok) {
      state.turnIdx = turnIdx + 1;
      state.attemptsThisTurn = 0;
    } else if (attemptNo >= 2) {
      state.turnIdx = turnIdx + 1;
      state.attemptsThisTurn = 0;
      assisted = true;
    } else {
      state.attemptsThisTurn = attemptNo;
    }

    const finished = state.turnIdx >= scenario.turns.length;
    const updatedSession = await store.saveConversationSession({
      ...session,
      state,
      turn_count: state.history.length,
      status: finished ? "COMPLETED" : session.status,
      completed_at: finished ? isoNow() : session.completed_at,
    });

    const correction = updatedSession.correction;
    let feedback = null;
    if (correction === "immediate" || (correction === "important" && !ok)) {
      feedback = {
        ok,
        expected: ok ? null : turn.element,
        example: ok || assisted || Number(state.attemptsThisTurn || 0) >= 1 ? turn.example : null,
      };
    }

    if (finished) {
      const good = state.history.filter((h) => h.ok).length;
      const score = Math.round((100 * good) / Math.max(1, state.history.length));
      await recordAttempt(
        Number(updatedSession.profile_id),
        Number(updatedSession.user_id),
        updatedSession.language_code,
        null,
        "conversation",
        score,
        score >= 60,
        {
          scenario: updatedSession.scenario,
          correction: updatedSession.correction,
          history: state.history,
        },
      );
      await recordSession(
        Number(updatedSession.profile_id),
        Number(updatedSession.user_id),
        updatedSession.language_code,
        "conversation",
      );
      return {
        status: "COMPLETED",
        sessionId: updatedSession.id,
        correctionMode: correction,
        summary: {
          turns: state.history.length,
          unassisted: good,
          scorePct: score,
          history: state.history,
          note: correction === "conversation_only"
            ? "Conversation-only mode: no corrections were shown; here is your transcript and score."
            : "Review your transcript — each turn shows what was expected.",
        },
        lastFeedback: feedback,
      };
    }

    const view = conversationView(updatedSession, scenario);
    view.lastFeedback = feedback;
    view.assistedAdvance = assisted;
    return view;
  }

  async function writingTasks(userId, profileId) {
    const profile = await profileOwned(profileId, userId);
    return TeacherContent.writingTasks(profile.language_code);
  }

  async function submitWriting(userId, profileId, taskCode, text) {
    const profile = await profileOwned(profileId, userId);
    const task = TeacherContent.writingTasks(profile.language_code).find((t) => t.code === taskCode) || null;
    if (!task) {
      throw AppError.conflict(`writing task ${taskCode} is not available for this language`, {
        code: "TASK_UNAVAILABLE",
      });
    }
    const cleanText = String(text || "").trim();
    if ([...cleanText].length < 3) {
      throw AppError.badRequest("write at least a few characters", { code: "WRITING_TOO_SHORT" });
    }
    if ([...cleanText].length > 2000) {
      throw AppError.badRequest("keep it under 2000 characters", { code: "WRITING_TOO_LONG" });
    }

    const hay = cleanText.toLowerCase();
    const check = (patterns) => {
      for (const p of patterns) {
        if (hay.includes(String(p).toLowerCase())) return p;
      }
      return null;
    };

    const elements = [];
    let metRequired = 0;
    for (const req of task.required) {
      const hit = check(req.patterns);
      if (hit !== null) metRequired += 1;
      elements.push({
        element: req.element,
        met: hit !== null,
        matchedPattern: hit,
        targetPatterns: req.patterns,
      });
    }
    const bonusMet = [];
    for (const b of task.bonus) {
      const hit = check(b.patterns);
      if (hit !== null) bonusMet.push(b.element);
    }
    const wordCount = cleanText.split(/\s+/u).filter(Boolean).length;
    const score = task.required.length ? Math.round((100 * metRequired) / task.required.length) : 0;

    const feedback = {
      task: task.title,
      elements,
      bonusMet,
      wordCount,
      scorePct: score,
      whatWasChecked: task.checkedNote,
      suggestion: metRequired === task.required.length
        ? "All required elements are present. Try the bonus element next, or another task."
        : "Missing element(s) above — the target patterns show exactly what to aim for. Your original text is stored unchanged.",
    };

    const attempt = await store.saveWritingAttempt({
      id: uuid(),
      profile_id: Number(profileId),
      user_id: Number(userId),
      language_code: profile.language_code,
      task_code: taskCode,
      original_text: cleanText,
      feedback,
      score_pct: score,
      created_at: isoNow(),
    });
    await recordSession(Number(profileId), Number(userId), profile.language_code, "writing");

    return {
      attempt: {
        id: attempt.id,
        originalText: cleanText,
        feedback,
        createdAt: attempt.created_at,
      },
    };
  }

  async function writingHistory(userId, profileId) {
    await profileOwned(profileId, userId);
    return store.listWritingAttempts(Number(profileId));
  }

  async function grammarRules(userId, profileId) {
    const profile = await profileOwned(profileId, userId);
    const rules = [];
    for (const i of ItemBanks.items(profile.language_code)) {
      if (i.skill !== "grammar") continue;
      rules.push({
        id: i.id,
        level: i.level,
        rule: i.explanation,
        question: i.prompt,
        correctForm: i.options[i.answer],
      });
    }
    return rules;
  }

  async function explainSimply(userId, profileId, ruleId) {
    const profile = await profileOwned(profileId, userId);
    const item = ItemBanks.find(profile.language_code, String(ruleId));
    if (!item || item.skill !== "grammar") {
      throw AppError.notFound("grammar rule not found", { code: "GRAMMAR_RULE_NOT_FOUND" });
    }
    return {
      id: item.id,
      simple: {
        rule: `Remember: ${item.explanation}`,
        correctExample: `${item.prompt} → ${item.options[item.answer]}`,
        tip: "Say the correct example out loud twice, then write it once from memory.",
      },
      note: "Simplified re-presentation of the same verified rule — the content never changes, only the framing.",
    };
  }

  async function history(userId, profileId) {
    const profile = await profileOwned(profileId, userId);
    const pid = Number(profile.id);
    const allAttempts = await store.listLessonAttemptsForProfile(pid);
    const filtered = allAttempts.filter((a) =>
      ["lesson", "checkpoint", "conversation", "assessment", "vocab_review"].includes(a.kind),
    );
    return {
      attempts: filtered.map((a) => ({
        id: a.id,
        kind: a.kind,
        scorePct: a.score_pct,
        passed: a.passed,
        languageCode: a.language_code,
        createdAt: a.created_at,
        detail: a.detail,
      })),
      conversations: await store.listConversationSessions(pid),
      writing: await store.listWritingAttempts(pid),
    };
  }

  // -------------------------------------------------------- Phase 3: Vocabulary SRS

  async function syncBank(languageCode) {
    const code = String(languageCode || "").trim().toLowerCase();
    let count = 0;
    for (const w of VocabularyBank.items(code)) {
      await store.upsertVocabulary({
        language_code: code,
        word: w.word,
        translation: w.translation,
        pronunciation: w.pronunciation,
        example_sentence: w.example,
        category: w.category,
        level: w.level,
        active: 1,
      });
      count += 1;
    }
    return count;
  }

  async function catalog(userId, profileId) {
    const profile = await profileOwned(profileId, userId);
    const code = profile.language_code;
    let words = await store.listVocabulary(code);
    if (!words.length) {
      await syncBank(code);
      words = await store.listVocabulary(code);
    }
    const mine = {};
    for (const u of await store.listUserVocabulary(Number(profileId), false, 200)) {
      mine[Number(u.vocabulary_id)] = u;
    }
    return words.map((w) => {
      const u = mine[Number(w.id)] || null;
      return {
        ...w,
        inList: u !== null,
        stage: u ? u.stage : null,
        familiarity: u ? Number(u.familiarity) : null,
        nextReviewAt: u ? u.next_review_at : null,
        reviewCount: u ? u.review_count : 0,
        lapseCount: u ? u.lapse_count : 0,
      };
    });
  }

  async function addWords(userId, profileId, vocabularyIds = [], starter = false) {
    const profile = await profileOwned(profileId, userId);
    const code = profile.language_code;
    let bank = await store.listVocabulary(code);
    if (!bank.length) {
      await syncBank(code);
      bank = await store.listVocabulary(code);
    }
    let ids = Array.isArray(vocabularyIds) ? vocabularyIds : [];
    if (starter) {
      ids = bank.slice(0, 10).map((w) => w.id);
    }
    let added = 0;
    for (const vid of ids) {
      const word = await store.findVocabulary(Number(vid));
      if (!word || word.language_code !== code) continue;
      const existing = await store.findUserVocabulary(Number(profileId), Number(vid));
      if (existing) continue;
      await store.saveUserVocabulary({
        profile_id: Number(profileId),
        user_id: Number(userId),
        vocabulary_id: Number(vid),
        stage: 0,
        familiarity: 0.0,
        next_review_at: isoNow(),
        review_count: 0,
        lapse_count: 0,
        last_result: null,
        last_reviewed_at: null,
        added_at: isoNow(),
      });
      added += 1;
    }
    const allInList = await store.listUserVocabulary(Number(profileId), false, 200);
    return { added, totalInList: allInList.length };
  }

  async function due(userId, profileId) {
    await profileOwned(profileId, userId);
    const rows = await store.listUserVocabulary(Number(profileId), true, 100);
    const out = [];
    for (const u of rows) {
      const w = await store.findVocabulary(Number(u.vocabulary_id));
      out.push({
        word: w?.word || "?",
        translation: w?.translation || "?",
        stage: Number(u.stage),
        familiarity: Number(u.familiarity),
        nextReviewAt: u.next_review_at,
        lastResult: u.last_result,
      });
    }
    return out;
  }

  function buildQuizCard(word, bankArray, position) {
    const others = bankArray.filter((w) => Number(w.id) !== Number(word.id));
    const picked = [];
    for (let i = 0; i < 3 && i < others.length; i += 1) {
      picked.push(others[(Number(word.id) * 3 + i * 5) % others.length]);
    }
    const options = [word.translation, ...picked.slice(0, 3).map((o) => o.translation)];
    const seed = (Number(word.id) * 7 + position) % options.length;
    const correctText = options[0];
    options[0] = options[seed];
    options[seed] = correctText;
    return {
      options,
      correctIndex: options.indexOf(correctText),
    };
  }

  async function startReview(userId, profileId, mode = "quiz", limit = 10) {
    const profile = await profileOwned(profileId, userId);
    if (!["quiz", "flashcard"].includes(mode)) {
      throw AppError.badRequest("mode must be quiz or flashcard", { code: "INVALID_REVIEW_MODE" });
    }
    const dueRows = await store.listUserVocabulary(Number(profileId), true, Math.max(1, Math.min(20, Number(limit) || 10)));
    if (!dueRows.length) {
      return {
        mode,
        cards: [],
        note: "Nothing due right now — add words or come back at the next scheduled review.",
      };
    }
    const bank = await store.listVocabulary(profile.language_code);
    const cards = [];
    for (const u of dueRows) {
      const word = bank.find((w) => Number(w.id) === Number(u.vocabulary_id));
      if (!word) continue;
      const card = {
        vocabularyId: Number(word.id),
        word: word.word,
        pronunciation: word.pronunciation,
        stage: Number(u.stage),
        dueAt: u.next_review_at,
      };
      if (mode === "quiz") {
        const built = buildQuizCard(word, bank, cards.length);
        card.prompt = `What does "${word.word}" mean?`;
        card.options = built.options;
        card.correctIndex = built.correctIndex;
      } else {
        card.reveal = {
          translation: word.translation,
          example: word.example_sentence,
        };
        card.selfAssessment = true;
      }
      cards.push(card);
    }
    return {
      mode,
      cards,
      note: mode === "flashcard" ? 'Flashcards are self-assessed — the schedule trusts your honest "forgot".' : null,
    };
  }

  async function applySrs(userId, profileId, u, ok, word) {
    let stage = Number(u.stage);
    let interval;
    let result;
    let next;
    if (ok) {
      interval = VOCAB_INTERVAL_DAYS[stage];
      stage = Math.min(VOCAB_INTERVAL_DAYS.length - 1, stage + 1);
      result = "remembered";
      next = new Date(now().getTime() + interval * 86400 * 1000).toISOString();
    } else {
      stage = 0;
      interval = 1;
      result = "forgot";
      next = new Date(now().getTime() + 86400 * 1000).toISOString();
    }
    const familiarity = Math.round((stage / 5) * 1000) / 1000;
    await store.saveUserVocabulary({
      ...u,
      stage,
      familiarity,
      next_review_at: next,
      review_count: Number(u.review_count) + 1,
      lapse_count: Number(u.lapse_count) + (ok ? 0 : 1),
      last_result: result,
      last_reviewed_at: isoNow(),
    });
    return {
      vocabularyId: Number(word.id),
      word: word.word,
      translation: word.translation,
      result,
      stage,
      familiarity,
      nextReviewAt: next,
      intervalDays: interval,
    };
  }

  async function submitReview(userId, profileId, mode, answers) {
    const profile = await profileOwned(profileId, userId);
    if (!["quiz", "flashcard"].includes(mode)) {
      throw AppError.badRequest("mode must be quiz or flashcard", { code: "INVALID_REVIEW_MODE" });
    }
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      throw AppError.badRequest("no reviewable answers supplied", { code: "EMPTY_REVIEW_ANSWERS" });
    }
    const bankList = await store.listVocabulary(profile.language_code);
    const bankById = {};
    for (const w of bankList) bankById[Number(w.id)] = w;

    const results = [];
    let correct = 0;
    for (const [vid, given] of Object.entries(answers)) {
      const u = await store.findUserVocabulary(Number(profileId), Number(vid));
      const word = bankById[Number(vid)] || null;
      if (!u || !word) continue;
      let ok = false;
      if (mode === "quiz") {
        const rebuilt = buildQuizCard(word, bankList, results.length);
        ok = given !== null && given !== undefined && given !== "" && Number.isFinite(Number(given)) && Number(given) === rebuilt.correctIndex;
      } else {
        if (!["remembered", "forgot"].includes(given)) continue;
        ok = given === "remembered";
      }
      if (ok) correct += 1;
      results.push(await applySrs(userId, profileId, u, ok, word));
    }
    if (!results.length) {
      throw AppError.badRequest("no reviewable answers supplied", { code: "EMPTY_REVIEW_ANSWERS" });
    }
    await recordAttempt(
      Number(profileId),
      Number(userId),
      profile.language_code,
      null,
      "vocab_review",
      Math.round((100 * correct) / results.length),
      null,
      { mode, items: results },
    );
    await recordSession(Number(profileId), Number(userId), profile.language_code, "vocab_review");
    return {
      mode,
      correct,
      total: results.length,
      results,
    };
  }

  async function vocabularyProgress(userId, profileId) {
    const profile = await profileOwned(profileId, userId);
    const rows = await store.listUserVocabulary(Number(profileId), false, 200);
    const bankSize = VocabularyBank.count(profile.language_code);
    let learned = 0;
    let learning = 0;
    let newCount = 0;
    for (const u of rows) {
      const stage = Number(u.stage);
      if (stage >= VOCAB_LEARNED_STAGE) learned += 1;
      else if (stage > 0) learning += 1;
      else newCount += 1;
    }
    const dueRows = await store.listUserVocabulary(Number(profileId), true, 200);
    const avgFam = rows.length
      ? Math.round((rows.reduce((acc, r) => acc + Number(r.familiarity || 0), 0) / rows.length) * 1000) / 1000
      : 0.0;
    const masteryPct = rows.length ? Math.round((100 * learned / rows.length) * 10) / 10 : 0.0;
    return {
      inList: rows.length,
      bankSize,
      learned,
      learning,
      notYetStudied: newCount,
      dueNow: dueRows.length,
      averageFamiliarity: avgFam,
      masteryPct,
    };
  }

  // -------------------------------------------------------- Phase 4: Listening + Speaking

  async function listeningExercises(userId, profileId, level = null, limit = 6) {
    const profile = await profileOwned(profileId, userId);
    const items = ItemBanks.items(profile.language_code).filter(
      (i) => i.skill === "reading" && (level === null || level === undefined || level === "" || i.level === level),
    );
    if (!items.length) {
      return {
        available: false,
        exercises: [],
        note: "No listening exercises banked for this language yet — audio arrives with its reading bank.",
      };
    }
    const bounded = Math.max(1, Math.min(12, Number(limit) || 6));
    const exercises = items.slice(0, bounded).map((i) => {
      const sentence = spokenSentence(i.prompt);
      return {
        itemId: i.id,
        level: i.level,
        speakText: sentence,
        modes: ["comprehension", "transcription"],
        comprehension: {
          question: comprehensionQuestion(i.prompt),
          options: i.options,
        },
        transcript: sentence,
        audioNote: "Played by your browser's speech synthesis when a voice for this language exists.",
      };
    });
    return {
      available: true,
      exercises,
      speeds: { slow: 0.7, normal: 1.0 },
      replay: true,
    };
  }

  async function submitListening(userId, profileId, itemId, mode, answer) {
    const profile = await profileOwned(profileId, userId);
    const item = ItemBanks.find(profile.language_code, String(itemId));
    if (!item || item.skill !== "reading") {
      throw AppError.notFound("listening exercise not found", { code: "LISTENING_NOT_FOUND" });
    }
    if (!["comprehension", "transcription"].includes(mode)) {
      throw AppError.badRequest("mode must be comprehension or transcription", { code: "INVALID_LISTENING_MODE" });
    }
    let ok = false;
    let score = 0;
    let detail = {};
    if (mode === "comprehension") {
      if (answer === null || answer === undefined || answer === "" || !Number.isFinite(Number(answer))) {
        throw AppError.badRequest("comprehension answers must be the chosen option index", {
          code: "INVALID_COMPREHENSION_ANSWER",
        });
      }
      const idx = Number(answer);
      ok = idx === item.answer;
      score = ok ? 100 : 0;
      detail = {
        question: comprehensionQuestion(item.prompt),
        given: item.options[idx] ?? null,
        expected: item.options[item.answer],
        explanation: item.explanation,
      };
    } else {
      const transcript = String(answer ?? "").trim();
      if ([...transcript].length < 2) {
        throw AppError.badRequest("write what you heard", { code: "TRANSCRIPT_TOO_SHORT" });
      }
      const expected = spokenSentence(item.prompt);
      score = transcriptionSimilarity(expected, transcript);
      ok = score >= 70;
      detail = {
        expected,
        given: transcript,
        similarityPct: score,
        note: "Word-level comparison after normalization; diacritic-insensitive matching is intentional because speech engines often drop accents.",
      };
    }
    await store.saveListeningAttempt({
      id: uuid(),
      profile_id: Number(profileId),
      user_id: Number(userId),
      language_code: profile.language_code,
      exercise_item_id: String(itemId),
      mode,
      score_pct: score,
      passed: ok ? 1 : 0,
      detail,
      created_at: isoNow(),
    });
    await recordSession(Number(profileId), Number(userId), profile.language_code, "listening");
    return {
      passed: ok,
      scorePct: score,
      detail,
    };
  }

  async function listeningHistory(userId, profileId) {
    await profileOwned(profileId, userId);
    return store.listListeningAttempts(Number(profileId));
  }

  async function speakingPrompts(userId, profileId, level = null, limit = 6) {
    const profile = await profileOwned(profileId, userId);
    const items = ItemBanks.items(profile.language_code).filter(
      (i) => i.skill === "reading" && (level === null || level === undefined || level === "" || i.level === level),
    );
    if (!items.length) {
      return {
        available: false,
        prompts: [],
        note: "No speaking prompts banked for this language yet.",
      };
    }
    const bounded = Math.max(1, Math.min(12, Number(limit) || 6));
    const prompts = items.slice(0, bounded).map((i) => ({
      id: i.id,
      level: i.level,
      text: spokenSentence(i.prompt),
    }));
    return {
      available: true,
      prompts,
      providerNote:
        "Speech-to-text uses your browser's speech recognition when available. Pronunciation and fluency scores are NOT provided — they require a pronunciation-assessment provider (not configured); only real word accuracy from the transcript is reported.",
    };
  }

  async function submitSpeaking(userId, profileId, promptId, transcript = null, provider = "browser_webspeech") {
    const profile = await profileOwned(profileId, userId);
    const item = ItemBanks.find(profile.language_code, String(promptId));
    if (!item || item.skill !== "reading") {
      throw AppError.notFound("speaking prompt not found", { code: "SPEAKING_PROMPT_NOT_FOUND" });
    }
    const promptText = spokenSentence(item.prompt);
    const cleanProvider = ["browser_webspeech", "none", "manual_review"].includes(provider) ? provider : "unknown";
    if (transcript === null || transcript === undefined || String(transcript).trim() === "") {
      await store.saveSpeakingAttempt({
        id: uuid(),
        profile_id: Number(profileId),
        user_id: Number(userId),
        language_code: profile.language_code,
        prompt_text: promptText,
        transcript: null,
        word_accuracy_pct: null,
        exact_match: 0,
        provider: cleanProvider,
        detail: { note: "No transcript was returned — nothing was scored or invented." },
        created_at: isoNow(),
      });
      return {
        scored: false,
        note: "No transcript returned by the speech engine — attempt recorded unscored.",
      };
    }
    const cleanTranscript = String(transcript);
    const accuracy = wordAccuracy(promptText, cleanTranscript);
    const exact = foldDiacritics(promptText) === foldDiacritics(cleanTranscript);
    const detail = {
      prompt: promptText,
      transcript: cleanTranscript,
      wordAccuracyPct: accuracy,
      matchedWords: matchedWords(promptText, cleanTranscript),
      expectedWords: audioTokens(promptText),
      pronunciationNote:
        "Pronunciation and fluency scores are not available — they require a pronunciation-assessment provider. Only word accuracy from the returned transcript is reported.",
    };
    await store.saveSpeakingAttempt({
      id: uuid(),
      profile_id: Number(profileId),
      user_id: Number(userId),
      language_code: profile.language_code,
      prompt_text: promptText,
      transcript: cleanTranscript.slice(0, 1000),
      word_accuracy_pct: accuracy,
      exact_match: exact ? 1 : 0,
      provider: cleanProvider,
      detail,
      created_at: isoNow(),
    });
    await recordSession(Number(profileId), Number(userId), profile.language_code, "speaking");
    return {
      scored: true,
      wordAccuracyPct: accuracy,
      exactMatch: exact,
      detail,
    };
  }

  async function speakingHistory(userId, profileId) {
    await profileOwned(profileId, userId);
    return store.listSpeakingAttempts(Number(profileId));
  }

  // -------------------------------------------------------- Phase 5: Adaptive Learning

  async function skillStats(profileId) {
    const pid = Number(profileId);
    const stats = {};
    const modulesCache = {};
    const attempts = await store.listLessonAttemptsForProfile(pid, 300);
    for (const a of attempts) {
      let skill = null;
      const score = a.score_pct;
      if (a.kind === "vocab_review") skill = "vocabulary";
      else if (a.kind === "conversation") skill = "conversation";
      else if (a.kind === "assessment") skill = "assessment";
      else if (["checkpoint", "lesson"].includes(a.kind) && a.module_id) {
        if (!modulesCache[a.module_id]) {
          modulesCache[a.module_id] = await store.findLearningModule(a.module_id);
        }
        skill = modulesCache[a.module_id]?.focus_skill || null;
      }
      if (!skill || skill === "assessment" || score === null || score === undefined) continue;
      if (!stats[skill]) stats[skill] = { count: 0, sum: 0.0 };
      stats[skill].count += 1;
      stats[skill].sum += Number(score);
    }
    for (const a of await store.listListeningAttempts(pid, 100)) {
      if (a.score_pct === null || a.score_pct === undefined) continue;
      if (!stats.listening) stats.listening = { count: 0, sum: 0.0 };
      stats.listening.count += 1;
      stats.listening.sum += Number(a.score_pct);
    }
    for (const a of await store.listSpeakingAttempts(pid, 100)) {
      if (a.word_accuracy_pct === null || a.word_accuracy_pct === undefined) continue;
      if (!stats.speaking) stats.speaking = { count: 0, sum: 0.0 };
      stats.speaking.count += 1;
      stats.speaking.sum += Number(a.word_accuracy_pct);
    }
    for (const a of await store.listWritingAttempts(pid, 100)) {
      if (a.score_pct === null || a.score_pct === undefined) continue;
      if (!stats.writing) stats.writing = { count: 0, sum: 0.0 };
      stats.writing.count += 1;
      stats.writing.sum += Number(a.score_pct);
    }
    const out = {};
    for (const [skill, s] of Object.entries(stats)) {
      out[skill] = { count: s.count, avg: s.sum / s.count };
    }
    return out;
  }

  async function attemptOutcomes(profileId) {
    const out = {};
    const attempts = await store.listLessonAttemptsForProfile(Number(profileId), 300);
    for (const a of attempts) {
      const outcomes = a.detail?.outcomes;
      if (Array.isArray(outcomes)) {
        for (const o of outcomes) {
          if (o?.itemId !== undefined) {
            const key = String(o.itemId);
            if (!out[key]) out[key] = [];
            out[key].push(Boolean(o.correct));
          }
        }
        continue;
      }
      const answers = a.detail?.answers;
      if (Array.isArray(answers)) {
        for (const ans of answers) {
          if (ans?.id !== undefined) {
            const key = String(ans.id);
            if (!out[key]) out[key] = [];
            out[key].push(Boolean(ans.correct));
          }
        }
      }
    }
    return out;
  }

  async function weaknesses(userId, profileId) {
    const profile = await profileOwned(profileId, userId);
    const pid = Number(profileId);
    const code = profile.language_code;

    const sStats = await skillStats(pid);
    const weakList = [];
    const strongList = [];
    for (const [skill, s] of Object.entries(sStats)) {
      if (s.count >= MIN_ATTEMPTS_FOR_SKILL) {
        const entry = {
          area: skill,
          kind: "skill",
          evidence: {
            attempts: s.count,
            averagePct: Math.round(s.avg * 10) / 10,
            window: "all stored attempts",
          },
        };
        if (s.avg < 60) weakList.push(entry);
        else if (s.avg >= 80) strongList.push(entry);
      }
    }

    const lapsing = [];
    for (const u of await store.listUserVocabulary(pid, false, 200)) {
      if (Number(u.lapse_count) >= 2 && Number(u.stage) < VOCAB_LEARNED_STAGE) {
        const w = await store.findVocabulary(Number(u.vocabulary_id));
        if (w) {
          lapsing.push({ word: w.word, lapses: Number(u.lapse_count), stage: Number(u.stage) });
        }
      }
    }
    if (lapsing.length >= 2) {
      weakList.push({
        area: "vocabulary-retention",
        kind: "retention",
        evidence: {
          lapsedWords: lapsing.slice(0, 5),
          total: lapsing.length,
        },
      });
    }

    const wrongItems = [];
    const outcomes = await attemptOutcomes(pid);
    for (const [itemId, results] of Object.entries(outcomes)) {
      const wrong = results.filter((r) => r === false).length;
      if (wrong >= 2) {
        const item = ItemBanks.find(code, itemId);
        if (item) {
          wrongItems.push({ item: item.prompt, skill: item.skill, timesWrong: wrong });
        }
      }
    }
    if (wrongItems.length > 0) {
      weakList.push({
        area: "repeated-mistakes",
        kind: "items",
        evidence: {
          items: wrongItems.slice(0, 5),
          total: wrongItems.length,
        },
      });
    }

    const moduleFails = {};
    for (const a of await store.listLessonAttemptsForProfile(pid, 200)) {
      if (["checkpoint", "lesson"].includes(a.kind) && a.module_id && Number(a.passed ?? 1) === 0) {
        moduleFails[a.module_id] = (moduleFails[a.module_id] || 0) + 1;
      }
    }
    for (const [moduleId, fails] of Object.entries(moduleFails)) {
      const m = await store.findLearningModule(moduleId);
      if (fails >= 2 && m) {
        weakList.push({
          area: `module:${m.code}`,
          kind: "module",
          evidence: {
            module: m.title,
            failedAttempts: fails,
            hint: "Review the lesson examples before retrying the checkpoint.",
          },
        });
      }
    }

    const coverage = {};
    let totalCount = 0;
    for (const [skill, s] of Object.entries(sStats)) {
      coverage[skill] = { attempts: s.count };
      totalCount += s.count;
    }
    const enough = totalCount >= MIN_ATTEMPTS_FOR_SKILL;

    return {
      weaknesses: weakList,
      strengths: strongList,
      coverage,
      note: enough
        ? "Findings cite the stored activity they came from."
        : "Not enough stored activity yet to detect weaknesses — findings appear from real attempts, never invented.",
    };
  }

  async function planWithCompletion(stored) {
    const plan = typeof stored.plan === "string"
      ? JSON.parse(stored.plan || "{}")
      : structuredClone(stored.plan || {});
    const today = utcDay(0);
    const pid = Number(stored.profile_id);

    let vocabToday = 0;
    const attempts = await store.listLessonAttemptsForProfile(pid, 100);
    for (const a of attempts) {
      if (String(a.created_at).slice(0, 10) !== today) continue;
      if (a.kind === "vocab_review") {
        vocabToday += (a.detail?.items || []).length;
      }
    }
    const listeningToday = (await store.listListeningAttempts(pid, 50)).filter(
      (a) => String(a.created_at).slice(0, 10) === today,
    ).length;
    const speakingToday = (await store.listSpeakingAttempts(pid, 50)).filter(
      (a) => String(a.created_at).slice(0, 10) === today,
    ).length;
    const writingToday = (await store.listWritingAttempts(pid, 50)).filter(
      (a) => String(a.created_at).slice(0, 10) === today,
    ).length;
    const moduleDoneToday = new Set();
    for (const a of attempts) {
      if (
        ["lesson", "checkpoint"].includes(a.kind) &&
        a.module_id &&
        String(a.created_at).slice(0, 10) === today &&
        Boolean(a.passed)
      ) {
        moduleDoneToday.add(String(a.module_id));
      }
    }

    const blocks = (plan.blocks || []).map((b) => {
      let done = false;
      if (b.block === "vocabulary") done = vocabToday >= Number(b.target ?? 1);
      else if (b.block === "module") done = moduleDoneToday.has(String(b.target || ""));
      else if (b.block === "practice-listening") done = listeningToday > 0;
      else if (b.block === "practice-speaking") done = speakingToday > 0;
      else if (b.block === "practice-writing") done = writingToday > 0;
      return { ...b, done };
    });

    return {
      day: stored.day,
      estimatedMinutes: Number(plan.estimatedMinutes ?? 0),
      basedOn: plan.basedOn || [],
      blocks,
      completionTrackedFrom: "today's stored activity only",
    };
  }

  async function dailyPlan(userId, profileId, minutes = null, regenerate = false) {
    const profile = await profileOwned(profileId, userId);
    const pid = Number(profileId);
    const code = profile.language_code;
    const day = utcDay(0);
    const budget = Math.max(5, Math.min(120, Number(minutes ?? profile.daily_minutes ?? 20)));

    if (!regenerate) {
      const existing = await store.findDailyLearningPlan(pid, day);
      if (existing) return planWithCompletion(existing);
    }

    const weak = await weaknesses(userId, pid);
    const weakSkills = weak.weaknesses.filter((w) => w.kind === "skill").map((w) => w.area);
    const dueCount = (await store.listUserVocabulary(pid, true, 100)).length;
    const pathRow = await store.activeLearningPath(pid);
    let currentModule = null;
    if (pathRow) {
      for (const m of await store.listLearningModules(pathRow.id)) {
        if (["AVAILABLE", "IN_PROGRESS"].includes(m.status)) {
          currentModule = m;
          break;
        }
      }
    }

    const blocks = [];
    if (dueCount > 0) {
      const n = Math.min(dueCount, Math.max(5, Math.round(dueCount * 0.6)));
      blocks.push({
        block: "vocabulary",
        title: `Review ${n} due vocabulary words`,
        minutes: 5,
        why: `${dueCount} word(s) scheduled for today by your spaced-repetition plan`,
        target: n,
      });
    }
    if (currentModule) {
      blocks.push({
        block: "module",
        title: `Continue: ${currentModule.title}`,
        minutes: 10,
        why: `your next module in the learning path (focus: ${currentModule.focus_skill})`,
        target: currentModule.id,
      });
    }

    const practiceMap = {
      listening: { title: "Complete one listening exercise", minutes: 5, why: "listening is your weakest measured skill" },
      speaking: { title: "Practice speaking for 5 minutes", minutes: 5, why: "speaking is your weakest measured skill" },
      writing: { title: "One writing practice task", minutes: 8, why: "writing is your weakest measured skill" },
      grammar: { title: "Review the grammar rules you missed", minutes: 5, why: "grammar is your weakest measured skill" },
      vocabulary: { title: "Extra vocabulary quiz", minutes: 5, why: "vocabulary quiz scores are low" },
    };
    for (const skill of weakSkills) {
      if (practiceMap[skill]) {
        blocks.push({ block: `practice-${skill}`, ...practiceMap[skill] });
      }
    }
    if (!blocks.length) {
      blocks.push({
        block: "start",
        title: "Take the level assessment to calibrate your path",
        minutes: 5,
        why: "no assessment on this profile yet",
        target: null,
      });
    }

    const plan = { blocks: [], budgetMinutes: budget };
    let used = 0;
    for (const b of blocks) {
      if (used + Number(b.minutes) <= budget || plan.blocks.length === 0) {
        plan.blocks.push(b);
        used += Number(b.minutes);
      }
    }
    plan.estimatedMinutes = used;
    plan.basedOn = [
      dueCount > 0 ? `${dueCount} vocabulary due` : null,
      currentModule ? "current path module" : null,
      weakSkills.length > 0 ? `weak areas: ${weakSkills.join(", ")}` : null,
      weakSkills.length === 0 && (dueCount > 0 || currentModule) ? "no weak areas measured yet" : null,
    ].filter(Boolean);

    const stored = await store.saveDailyLearningPlan({
      id: uuid(),
      profile_id: pid,
      user_id: Number(userId),
      language_code: code,
      day,
      plan,
      est_minutes: used,
      created_at: isoNow(),
    });
    return planWithCompletion(stored);
  }

  async function recommendations(userId, profileId) {
    const profile = await profileOwned(profileId, userId);
    const pid = Number(profileId);
    const weak = await weaknesses(userId, pid);
    await store.clearAiLearningRecommendations(pid);
    const rows = [];
    for (const w of weak.weaknesses) {
      let message = "Practice recommendation.";
      if (w.kind === "skill") {
        message = `Your ${w.area} average is ${w.evidence.averagePct}% over ${w.evidence.attempts} attempts — practice it before advancing.`;
      } else if (w.kind === "retention") {
        const lapsedNames = (w.evidence.lapsedWords || []).map((lw) => lw.word).join(", ");
        message = `${w.evidence.total} words keep lapsing (${lapsedNames}…) — they are queued in today's review.`;
      } else if (w.kind === "items") {
        const firstPrompt = String(w.evidence.items?.[0]?.item || "").slice(0, 40);
        message = `You repeatedly miss ${w.evidence.total} item(s) (${firstPrompt}…).`;
      } else if (w.kind === "module") {
        message = `${w.evidence.module} failed ${w.evidence.failedAttempts} times — review its lesson examples, then retry.`;
      }
      rows.push(
        await store.saveAiLearningRecommendation({
          id: uuid(),
          profile_id: pid,
          user_id: Number(userId),
          language_code: profile.language_code,
          kind: w.kind,
          message: message.slice(0, 400),
          evidence: w.evidence,
          status: "ACTIVE",
          created_at: isoNow(),
        }),
      );
    }

    const days = await store.listStudySessionDays(pid);
    const lastActive = days[0] || null;
    if (lastActive && lastActive < utcDay(-2)) {
      rows.push(
        await store.saveAiLearningRecommendation({
          id: uuid(),
          profile_id: pid,
          user_id: Number(userId),
          language_code: profile.language_code,
          kind: "engagement",
          message: `You last studied this language on ${lastActive} — a short review today keeps the streak.`,
          evidence: { lastActiveDay: lastActive },
          status: "ACTIVE",
          created_at: isoNow(),
        }),
      );
    }

    return {
      recommendations: rows,
      note: rows.length
        ? "Every recommendation cites the stored data behind it."
        : "Nothing to recommend yet — recommendations appear from real activity.",
    };
  }

  async function mastery(userId, profileId) {
    const profile = await profileOwned(profileId, userId);
    const pid = Number(profileId);
    const code = profile.language_code;
    const outcomes = await attemptOutcomes(pid);
    const items = [];
    const counts = { mastered: 0, learning: 0, weak: 0, unseen: 0 };
    for (const i of ItemBanks.items(code)) {
      const results = outcomes[i.id] || [];
      if (!results.length) {
        counts.unseen += 1;
        continue;
      }
      const correct = results.filter(Boolean).length;
      let state = "weak";
      if (correct >= 2 && results[results.length - 1] === true) state = "mastered";
      else if (correct >= 1) state = "learning";
      counts[state] += 1;
      items.push({
        id: i.id,
        prompt: i.prompt,
        skill: i.skill,
        level: i.level,
        attempts: results.length,
        correct,
        mastery: state,
      });
    }
    const sStats = await skillStats(pid);
    const skillRollup = {};
    for (const [skill, s] of Object.entries(sStats)) {
      skillRollup[skill] = { attempts: s.count, averagePct: Math.round(s.avg * 10) / 10 };
    }
    return {
      grammarAndItems: items,
      counts,
      skillRollup,
      note: "Item mastery from real attempt outcomes only; unseen items are counted, never guessed.",
    };
  }

  function detect(text) {
    const clean = String(text || "").trim();
    if (!clean) {
      throw AppError.badRequest("body must be {text: string}", { code: "INVALID_DETECT_BODY" });
    }
    return Translator.detect(clean);
  }

  function translate(text, target, source = null) {
    const cleanText = String(text || "").trim();
    const cleanTarget = String(target || "").trim().toLowerCase();
    const cleanSource = source !== null && source !== undefined && String(source).trim() !== ""
      ? String(source).trim().toLowerCase()
      : null;
    if (!cleanText || !cleanTarget) {
      throw AppError.badRequest("body must be {text: string, target: isoCode, source?: isoCode}", {
        code: "INVALID_TRANSLATE_BODY",
      });
    }
    if ([...cleanText].length > 500) {
      throw AppError.badRequest("text must be 500 characters or fewer", { code: "TEXT_TOO_LONG" });
    }
    try {
      return Translator.translate(cleanText, cleanTarget, cleanSource);
    } catch (err) {
      throw AppError.badRequest(err.message, { code: "TRANSLATE_FAILED" });
    }
  }

  return {
    // Phase 1
    syncRegistry,
    languages,
    language,
    startLanguage,
    profileOwned,
    profiles,
    progressFor,
    startAssessment,
    assessmentOwned,
    answerAssessment,
    generatePath,
    pathFor,
    moduleOwned,
    quizFor,
    startCheckpoint,
    submitCheckpoint,
    // Phase 2
    startLesson,
    submitLesson,
    conversations,
    startConversation,
    conversationStateForPage,
    conversationTurn,
    writingTasks,
    submitWriting,
    writingHistory,
    grammarRules,
    explainSimply,
    history,
    detect,
    translate,
    // Phase 3
    syncBank,
    catalog,
    addWords,
    due,
    startReview,
    submitReview,
    vocabularyProgress,
    // Phase 4
    listeningExercises,
    submitListening,
    listeningHistory,
    speakingPrompts,
    submitSpeaking,
    speakingHistory,
    // Phase 5
    weaknesses,
    dailyPlan,
    recommendations,
    mastery,
  };
}
