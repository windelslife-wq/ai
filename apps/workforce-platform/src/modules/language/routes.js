/**
 * AI Language Learning & AI Teacher HTTP routes (row 16 — Phase 46).
 *
 * Mirrors all routes in `application/controllers/Api_lang_learning.php` and
 * `application/config/routes.php` (lines 226–263).
 */

import { AppError } from "../../http/errors.js";
import { createAuthenticator, requirePermission } from "../platform/guards.js";
import {
  ANSWER_ASSESSMENT_BODY_SCHEMA,
  ASSESSMENT_ID_PARAMS_SCHEMA,
  AUDIO_EXERCISES_QUERY_SCHEMA,
  CHECKPOINT_ANSWERS_BODY_SCHEMA,
  CONVERSATION_TURN_BODY_SCHEMA,
  DAILY_PLAN_QUERY_SCHEMA,
  DETECT_BODY_SCHEMA,
  LANGUAGE_CODE_PARAMS_SCHEMA,
  LISTENING_ATTEMPT_BODY_SCHEMA,
  MODULE_ID_PARAMS_SCHEMA,
  PROFILE_ID_PARAMS_SCHEMA,
  PROFILE_PARAM_SCHEMA,
  PROFILE_RULE_PARAMS_SCHEMA,
  SESSION_ID_PARAMS_SCHEMA,
  SPEAKING_ATTEMPT_BODY_SCHEMA,
  START_CONVERSATION_BODY_SCHEMA,
  START_PROFILE_BODY_SCHEMA,
  SUBMIT_WRITING_BODY_SCHEMA,
  TRANSLATE_BODY_SCHEMA,
  VOCABULARY_ADD_BODY_SCHEMA,
  VOCABULARY_REVIEW_QUERY_SCHEMA,
  VOCABULARY_REVIEW_SUBMIT_BODY_SCHEMA,
} from "./contracts.js";
import { createLanguageLearningService } from "./service.js";

export const LANGUAGE_PERMISSION = "system.authenticated";

export function languageLearningRoutes(app, { store, config, service = null }) {
  const languageService = service || createLanguageLearningService({ store });
  const authenticate = createAuthenticator({ store, config });
  const guard = requirePermission(LANGUAGE_PERMISSION, config);
  guard.permission = LANGUAGE_PERMISSION;
  const authGuard = [authenticate, guard];

  // ---------------------------------------------------------- Languages
  app.get("/language-learning/languages", {
    preHandler: authGuard,
  }, async () => ({ languages: await languageService.languages() }));

  app.get("/language-learning/languages/:code", {
    preHandler: authGuard,
    paramsSchema: LANGUAGE_CODE_PARAMS_SCHEMA,
  }, async (request) => ({ language: languageService.language(request.params.code) }));

  // ---------------------------------------------------------- AI Teacher Translate
  app.post("/language-learning/detect", {
    preHandler: authGuard,
    bodySchema: DETECT_BODY_SCHEMA,
  }, async (request) => ({ detection: languageService.detect(request.body.text) }));

  app.post("/language-learning/translate", {
    preHandler: authGuard,
    bodySchema: TRANSLATE_BODY_SCHEMA,
  }, async (request) => ({
    translation: languageService.translate(
      request.body.text,
      request.body.target,
      request.body.source ?? null,
    ),
  }));

  // ---------------------------------------------------------- Profiles
  app.get("/language-learning/profiles", {
    preHandler: authGuard,
  }, async (request) => ({
    profiles: await languageService.profiles(Number(request.auth.user.id)),
  }));

  app.post("/language-learning/profiles", {
    preHandler: authGuard,
    bodySchema: START_PROFILE_BODY_SCHEMA,
  }, async (request, reply) => {
    const profile = await languageService.startLanguage(
      Number(request.auth.user.id),
      request.body.languageCode,
      request.body.goal ?? null,
      request.body.explanationLanguage || "en",
    );
    return reply.code(201).send({ profile });
  });

  app.get("/language-learning/profiles/:id", {
    preHandler: authGuard,
    paramsSchema: PROFILE_ID_PARAMS_SCHEMA,
  }, async (request) => {
    const userId = Number(request.auth.user.id);
    const profile = await languageService.profileOwned(Number(request.params.id), userId);
    const progress = await languageService.progressFor(profile);
    return { profile: { ...profile, progress } };
  });

  // ---------------------------------------------------------- Assessment
  app.post("/language-learning/profiles/:profileId/assessment/start", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
  }, async (request, reply) => reply.code(201).send(
    await languageService.startAssessment(
      Number(request.auth.user.id),
      Number(request.params.profileId),
    ),
  ));

  app.get("/language-learning/assessment/:id", {
    preHandler: authGuard,
    paramsSchema: ASSESSMENT_ID_PARAMS_SCHEMA,
  }, async (request) => {
    const a = await languageService.assessmentOwned(request.params.id, Number(request.auth.user.id));
    return {
      assessment: {
        id: a.id,
        status: a.status,
        languageCode: a.language_code,
        startedAt: a.started_at,
        completedAt: a.completed_at,
        pendingItem: a.state?.pendingItem || null,
        result: a.result,
      },
    };
  });

  app.post("/language-learning/assessment/:id/answer", {
    preHandler: authGuard,
    paramsSchema: ASSESSMENT_ID_PARAMS_SCHEMA,
    bodySchema: ANSWER_ASSESSMENT_BODY_SCHEMA,
  }, async (request) => languageService.answerAssessment(
    request.params.id,
    Number(request.auth.user.id),
    Number(request.body.answerIndex),
  ));

  // ---------------------------------------------------------- Learning Path & Checkpoints
  app.post("/language-learning/profiles/:profileId/path/generate", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
  }, async (request, reply) => reply.code(201).send(
    await languageService.generatePath(
      Number(request.auth.user.id),
      Number(request.params.profileId),
    ),
  ));

  app.get("/language-learning/profiles/:profileId/path", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
  }, async (request) => languageService.pathFor(
    Number(request.auth.user.id),
    Number(request.params.profileId),
  ));

  app.post("/language-learning/modules/:moduleId/checkpoint/start", {
    preHandler: authGuard,
    paramsSchema: MODULE_ID_PARAMS_SCHEMA,
  }, async (request, reply) => reply.code(201).send(
    await languageService.startCheckpoint(
      request.params.moduleId,
      Number(request.auth.user.id),
    ),
  ));

  app.post("/language-learning/modules/:moduleId/checkpoint/answer", {
    preHandler: authGuard,
    paramsSchema: MODULE_ID_PARAMS_SCHEMA,
    bodySchema: CHECKPOINT_ANSWERS_BODY_SCHEMA,
  }, async (request) => languageService.submitCheckpoint(
    request.params.moduleId,
    Number(request.auth.user.id),
    request.body.answers,
  ));

  // ---------------------------------------------------------- Progress
  app.get("/language-learning/profiles/:profileId/progress", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
  }, async (request) => {
    const profile = await languageService.profileOwned(
      Number(request.params.profileId),
      Number(request.auth.user.id),
    );
    return {
      languageCode: profile.language_code,
      progress: await languageService.progressFor(profile),
    };
  });

  // ---------------------------------------------------------- Phase 2: AI Teacher
  app.post("/language-learning/modules/:moduleId/lesson/start", {
    preHandler: authGuard,
    paramsSchema: MODULE_ID_PARAMS_SCHEMA,
  }, async (request, reply) => reply.code(201).send(
    await languageService.startLesson(
      request.params.moduleId,
      Number(request.auth.user.id),
    ),
  ));

  app.post("/language-learning/modules/:moduleId/lesson/answer", {
    preHandler: authGuard,
    paramsSchema: MODULE_ID_PARAMS_SCHEMA,
    bodySchema: CHECKPOINT_ANSWERS_BODY_SCHEMA,
  }, async (request) => languageService.submitLesson(
    request.params.moduleId,
    Number(request.auth.user.id),
    request.body.answers,
  ));

  app.get("/language-learning/profiles/:profileId/conversations", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
  }, async (request) => ({
    scenarios: await languageService.conversations(
      Number(request.auth.user.id),
      Number(request.params.profileId),
    ),
  }));

  app.post("/language-learning/profiles/:profileId/conversations/start", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
    bodySchema: START_CONVERSATION_BODY_SCHEMA,
  }, async (request, reply) => reply.code(201).send(
    await languageService.startConversation(
      Number(request.auth.user.id),
      Number(request.params.profileId),
      request.body.scenario,
      request.body.correction || "important",
    ),
  ));

  app.post("/language-learning/conversations/:sessionId/turn", {
    preHandler: authGuard,
    paramsSchema: SESSION_ID_PARAMS_SCHEMA,
    bodySchema: CONVERSATION_TURN_BODY_SCHEMA,
  }, async (request) => languageService.conversationTurn(
    request.params.sessionId,
    Number(request.auth.user.id),
    request.body.text,
  ));

  app.get("/language-learning/profiles/:profileId/writing/tasks", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
  }, async (request) => ({
    tasks: await languageService.writingTasks(
      Number(request.auth.user.id),
      Number(request.params.profileId),
    ),
  }));

  app.post("/language-learning/profiles/:profileId/writing/submit", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
    bodySchema: SUBMIT_WRITING_BODY_SCHEMA,
  }, async (request, reply) => reply.code(201).send(
    await languageService.submitWriting(
      Number(request.auth.user.id),
      Number(request.params.profileId),
      request.body.taskCode,
      request.body.text,
    ),
  ));

  app.get("/language-learning/profiles/:profileId/grammar", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
  }, async (request) => ({
    rules: await languageService.grammarRules(
      Number(request.auth.user.id),
      Number(request.params.profileId),
    ),
  }));

  app.get("/language-learning/profiles/:profileId/grammar/:ruleId/simple", {
    preHandler: authGuard,
    paramsSchema: PROFILE_RULE_PARAMS_SCHEMA,
  }, async (request) => languageService.explainSimply(
    Number(request.auth.user.id),
    Number(request.params.profileId),
    request.params.ruleId,
  ));

  // ---------------------------------------------------------- Phase 3: Vocabulary SRS
  app.get("/language-learning/profiles/:profileId/vocabulary", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
  }, async (request) => ({
    vocabulary: await languageService.catalog(
      Number(request.auth.user.id),
      Number(request.params.profileId),
    ),
  }));

  app.post("/language-learning/profiles/:profileId/vocabulary/add", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
    bodySchema: VOCABULARY_ADD_BODY_SCHEMA,
  }, async (request, reply) => reply.code(201).send(
    await languageService.addWords(
      Number(request.auth.user.id),
      Number(request.params.profileId),
      request.body.vocabularyIds || [],
      Boolean(request.body.starter),
    ),
  ));

  app.get("/language-learning/profiles/:profileId/vocabulary/due", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
  }, async (request) => ({
    due: await languageService.due(
      Number(request.auth.user.id),
      Number(request.params.profileId),
    ),
  }));

  app.get("/language-learning/profiles/:profileId/vocabulary/review/start", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
    querySchema: VOCABULARY_REVIEW_QUERY_SCHEMA,
  }, async (request) => languageService.startReview(
    Number(request.auth.user.id),
    Number(request.params.profileId),
    request.query?.mode || "quiz",
    Number(request.query?.limit || 10),
  ));

  app.post("/language-learning/profiles/:profileId/vocabulary/review/submit", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
    bodySchema: VOCABULARY_REVIEW_SUBMIT_BODY_SCHEMA,
  }, async (request, reply) => reply.code(201).send(
    await languageService.submitReview(
      Number(request.auth.user.id),
      Number(request.params.profileId),
      request.body.mode,
      request.body.answers,
    ),
  ));

  app.get("/language-learning/profiles/:profileId/vocabulary/progress", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
  }, async (request) => ({
    progress: await languageService.vocabularyProgress(
      Number(request.auth.user.id),
      Number(request.params.profileId),
    ),
  }));

  // ---------------------------------------------------------- Phase 4: Listening + Speaking
  app.get("/language-learning/profiles/:profileId/listening/exercises", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
    querySchema: AUDIO_EXERCISES_QUERY_SCHEMA,
  }, async (request) => languageService.listeningExercises(
    Number(request.auth.user.id),
    Number(request.params.profileId),
    request.query?.level ?? null,
    Number(request.query?.limit || 6),
  ));

  app.post("/language-learning/profiles/:profileId/listening/attempt", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
    bodySchema: LISTENING_ATTEMPT_BODY_SCHEMA,
  }, async (request, reply) => {
    const raw = request.body || {};
    if (raw.itemId === undefined || raw.mode === undefined || raw.answer === undefined) {
      throw AppError.badRequest("body must be {itemId, mode: comprehension|transcription, answer}", {
        code: "INVALID_LISTENING_ATTEMPT_BODY",
      });
    }
    return reply.code(201).send(
      await languageService.submitListening(
        Number(request.auth.user.id),
        Number(request.params.profileId),
        String(raw.itemId),
        String(raw.mode),
        raw.answer,
      ),
    );
  });

  app.get("/language-learning/profiles/:profileId/speaking/prompts", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
    querySchema: AUDIO_EXERCISES_QUERY_SCHEMA,
  }, async (request) => languageService.speakingPrompts(
    Number(request.auth.user.id),
    Number(request.params.profileId),
    request.query?.level ?? null,
    Number(request.query?.limit || 6),
  ));

  app.post("/language-learning/profiles/:profileId/speaking/attempt", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
    bodySchema: SPEAKING_ATTEMPT_BODY_SCHEMA,
  }, async (request, reply) => reply.code(201).send(
    await languageService.submitSpeaking(
      Number(request.auth.user.id),
      Number(request.params.profileId),
      request.body.promptId,
      request.body.transcript ?? null,
      request.body.provider || "browser_webspeech",
    ),
  ));

  // ---------------------------------------------------------- Phase 5: Adaptive Learning
  app.get("/language-learning/profiles/:profileId/adaptive/weaknesses", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
  }, async (request) => languageService.weaknesses(
    Number(request.auth.user.id),
    Number(request.params.profileId),
  ));

  app.get("/language-learning/profiles/:profileId/adaptive/daily-plan", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
    querySchema: DAILY_PLAN_QUERY_SCHEMA,
  }, async (request) => {
    const minutes = request.query?.minutes !== undefined ? Number(request.query.minutes) : null;
    return languageService.dailyPlan(
      Number(request.auth.user.id),
      Number(request.params.profileId),
      minutes,
      false,
    );
  });

  app.post("/language-learning/profiles/:profileId/adaptive/daily-plan", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
    querySchema: DAILY_PLAN_QUERY_SCHEMA,
  }, async (request) => {
    const minutes = request.query?.minutes !== undefined ? Number(request.query.minutes) : null;
    return languageService.dailyPlan(
      Number(request.auth.user.id),
      Number(request.params.profileId),
      minutes,
      true,
    );
  });

  app.get("/language-learning/profiles/:profileId/adaptive/recommendations", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
  }, async (request) => languageService.recommendations(
    Number(request.auth.user.id),
    Number(request.params.profileId),
  ));

  app.get("/language-learning/profiles/:profileId/adaptive/mastery", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
  }, async (request) => languageService.mastery(
    Number(request.auth.user.id),
    Number(request.params.profileId),
  ));

  app.get("/language-learning/profiles/:profileId/history", {
    preHandler: authGuard,
    paramsSchema: PROFILE_PARAM_SCHEMA,
  }, async (request) => languageService.history(
    Number(request.auth.user.id),
    Number(request.params.profileId),
  ));
}
