export const LANGUAGE_CODE_PARAMS_SCHEMA = Object.freeze({
  code: { type: "string", required: true, trim: true, lowercase: true, minLength: 2, maxLength: 8 },
});

export const PROFILE_ID_PARAMS_SCHEMA = Object.freeze({
  id: { type: "integer", required: true, min: 1 },
});

export const PROFILE_PARAM_SCHEMA = Object.freeze({
  profileId: { type: "integer", required: true, min: 1 },
});

export const PROFILE_RULE_PARAMS_SCHEMA = Object.freeze({
  profileId: { type: "integer", required: true, min: 1 },
  ruleId: { type: "string", required: true, trim: true, minLength: 1, maxLength: 60 },
});

export const ASSESSMENT_ID_PARAMS_SCHEMA = Object.freeze({
  id: { type: "string", required: true, trim: true, minLength: 1, maxLength: 64 },
});

export const MODULE_ID_PARAMS_SCHEMA = Object.freeze({
  moduleId: { type: "string", required: true, trim: true, minLength: 1, maxLength: 64 },
});

export const SESSION_ID_PARAMS_SCHEMA = Object.freeze({
  sessionId: { type: "string", required: true, trim: true, minLength: 1, maxLength: 64 },
});

export const DETECT_BODY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: { type: "string", required: true, trim: true, minLength: 1, maxLength: 1000 },
  },
});

export const TRANSLATE_BODY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["text", "target"],
  properties: {
    text: { type: "string", required: true, trim: true, minLength: 1, maxLength: 500 },
    target: { type: "string", required: true, trim: true, lowercase: true, minLength: 2, maxLength: 8 },
    source: { type: "string", nullable: true, trim: true, lowercase: true, minLength: 2, maxLength: 8 },
  },
});

export const START_PROFILE_BODY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["languageCode"],
  properties: {
    languageCode: { type: "string", required: true, trim: true, lowercase: true, minLength: 2, maxLength: 8 },
    goal: { type: "string", nullable: true, trim: true, maxLength: 300 },
    explanationLanguage: { type: "string", nullable: true, trim: true, lowercase: true, maxLength: 8, default: "en" },
  },
});

export const ANSWER_ASSESSMENT_BODY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["answerIndex"],
  properties: {
    answerIndex: { type: "integer", required: true, min: 0, max: 10 },
  },
});

export const CHECKPOINT_ANSWERS_BODY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["answers"],
  properties: {
    answers: { type: "object", required: true, additionalProperties: true },
  },
});

export const START_CONVERSATION_BODY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["scenario"],
  properties: {
    scenario: { type: "string", required: true, trim: true, minLength: 1, maxLength: 60 },
    correction: {
      type: "string",
      trim: true,
      values: ["immediate", "after", "important", "conversation_only"],
      default: "important",
    },
  },
});

export const CONVERSATION_TURN_BODY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: { type: "string", required: true, trim: true, minLength: 1, maxLength: 500 },
  },
});

export const SUBMIT_WRITING_BODY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["taskCode", "text"],
  properties: {
    taskCode: { type: "string", required: true, trim: true, minLength: 1, maxLength: 60 },
    text: { type: "string", required: true, trim: true, minLength: 1, maxLength: 2000 },
  },
});

export const AUDIO_EXERCISES_QUERY_SCHEMA = Object.freeze({
  level: { type: "string", trim: true, maxLength: 10 },
  limit: { type: "integer", min: 1, max: 12, default: 6 },
});

export const LISTENING_ATTEMPT_BODY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: true,
});

export const SPEAKING_ATTEMPT_BODY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["promptId"],
  properties: {
    promptId: { type: "string", required: true, trim: true, minLength: 1, maxLength: 60 },
    transcript: { type: "string", nullable: true, maxLength: 1000 },
    provider: { type: "string", nullable: true, trim: true, maxLength: 40, default: "browser_webspeech" },
  },
});

export const DAILY_PLAN_QUERY_SCHEMA = Object.freeze({
  minutes: { type: "integer", min: 5, max: 120 },
});

export const VOCABULARY_ADD_BODY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    vocabularyIds: {
      type: "array",
      items: { type: "integer", min: 1 },
      maxItems: 100,
    },
    starter: { type: "boolean", default: false },
  },
});

export const VOCABULARY_REVIEW_QUERY_SCHEMA = Object.freeze({
  mode: { type: "string", trim: true, values: ["quiz", "flashcard"], default: "quiz" },
  limit: { type: "integer", min: 1, max: 20, default: 10 },
});

export const VOCABULARY_REVIEW_SUBMIT_BODY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["mode", "answers"],
  properties: {
    mode: { type: "string", required: true, trim: true, values: ["quiz", "flashcard"] },
    answers: { type: "object", required: true, additionalProperties: true },
  },
});
