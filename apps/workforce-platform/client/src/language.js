/**
 * AI Language Learning & AI Teacher console logic (row 16 — Phase 46).
 *
 * Plain ESM with no JSX or browser globals so `test/client_language_console.test.js`
 * can import it directly and verify vocabulary parity against
 * `src/modules/language/{registry.js,content.js,contracts.js}` and legacy views
 * `application/views/languages/{index,teacher,vocabulary,audio,adaptive}.php`.
 */

export const LANGUAGE_PERMISSION = "system.authenticated";

export const LANGUAGE_COPY = Object.freeze({
  eyebrow: "AI Language Learning & Teacher",
  heading: "Language Learning & AI Teacher",
  lede: "Study 20 authored languages with deterministic placement assessments, a structured curriculum path, guided AI teacher lessons, multi-turn conversations, writing feedback, 6-stage vocabulary SRS, listening & speaking practice, adaptive study plans, and bidirectional translation.",
  teacherHeading: "AI Teacher Workspace",
  teacherLede: "Practice guided lessons, role-play scenarios with configurable correction modes, submit writing tasks that preserve your original text, review grammar rules with simpler explanations, and translate phrases across all 20 languages.",
  honestCapabilitiesRule: "Honest capability boundaries: placement level changes only on completed assessments and caps at each language's authored ceiling; speaking practice scores browser Web Speech transcript word accuracy only and never fabricates pronunciation scores.",
  emptyProfiles: "No language profiles started yet. Choose one of the 20 languages below to create your learner profile.",
  emptyVocabulary: "No vocabulary words scheduled for review right now.",
  emptyConversations: "Select a conversation scenario to begin a multi-turn practice session.",
  emptyHistory: "No completed lessons, checkpoints, writing submissions, or reviews recorded for this profile yet.",
});

export const LANGUAGE_TABS = Object.freeze([
  Object.freeze({ id: "catalog", label: "Languages & Profiles" }),
  Object.freeze({ id: "assessment", label: "Placement & Path" }),
  Object.freeze({ id: "teacher", label: "AI Teacher & Grammar" }),
  Object.freeze({ id: "conversations", label: "Conversations & Writing" }),
  Object.freeze({ id: "vocabulary", label: "Vocabulary SRS" }),
  Object.freeze({ id: "audio", label: "Listening & Speaking" }),
  Object.freeze({ id: "adaptive", label: "Adaptive Plan & Mastery" }),
  Object.freeze({ id: "translator", label: "Translator" }),
]);

export const CONVERSATION_CORRECTION_MODES = Object.freeze([
  "immediate",
  "after",
  "important",
  "conversation_only",
]);

export const VOCABULARY_REVIEW_MODES = Object.freeze([
  "quiz",
  "flashcard",
]);

export const LISTENING_MODES = Object.freeze([
  "comprehension",
  "transcription",
]);

export const LANGUAGE_READS = Object.freeze([
  Object.freeze({ key: "languages", path: "/api/v1/language-learning/languages", permission: LANGUAGE_PERMISSION }),
  Object.freeze({ key: "profiles", path: "/api/v1/language-learning/profiles", permission: LANGUAGE_PERMISSION }),
]);

export function formatProficiencyBadge(profile) {
  const level = profile?.level ? String(profile.level) : "Beginner";
  const assessed = level !== "Beginner";
  const tone = assessed ? "badge-green" : "badge-amber";
  return {
    level,
    label: assessed ? `CEFR ${level}` : "Beginner · Unassessed",
    tone,
  };
}

export function formatCapabilityBadges(language) {
  const features = language?.features || {};
  const ceiling = features.assessment_ceiling || "A1";
  const writingSystem = language?.writing_system || "latin";
  const direction = language?.direction || "ltr";
  return [
    {
      key: "ceiling",
      label: `Ceiling ${ceiling}`,
      tone: "badge-gray",
    },
    {
      key: "script",
      label: `${writingSystem} (${direction.toUpperCase()})`,
      tone: "badge-gray",
    },
    {
      key: "bank",
      label: `${language?.assessment_bank ?? 0} bank items`,
      tone: (language?.assessment_bank ?? 0) > 0 ? "badge-green" : "badge-muted",
    },
  ];
}

export function validateTranslationInput(text, target) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || trimmed.length > 500) {
    return "text must be 1–500 characters";
  }
  const code = String(target ?? "").trim().toLowerCase();
  if (code.length < 2 || code.length > 8) {
    return "target language code is required";
  }
  return null;
}

export function validateWritingInput(taskCode, text) {
  if (!String(taskCode ?? "").trim()) {
    return "taskCode is required";
  }
  const trimmed = String(text ?? "").trim();
  if (trimmed.length < 3 || trimmed.length > 2000) {
    return "writing submission must be 3–2000 characters";
  }
  return null;
}

export function summarizeDailyPlan(plan) {
  const blocks = Array.isArray(plan?.blocks) ? plan.blocks : [];
  return {
    day: String(plan?.day ?? ""),
    estimatedMinutes: Number(plan?.estimatedMinutes ?? 0),
    blockCount: blocks.length,
    completedBlocks: blocks.filter((b) => b.done).length,
  };
}
