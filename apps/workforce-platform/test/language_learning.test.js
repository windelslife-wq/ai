import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  Curriculum,
  ItemBanks,
  LanguageRegistry,
} from "../src/modules/language/registry.js";
import {
  TeacherContent,
  Translator,
  VocabularyBank,
} from "../src/modules/language/content.js";
import { wordAccuracy } from "../src/modules/language/service.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

async function signIn(instance, identifier, password) {
  const response = await instance.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifier, password },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  return {
    headers: { cookie: cookieFrom(response), "x-csrf-token": body.csrfToken },
    user: body.user,
  };
}

test("PHP parity: LanguageRegistry, ItemBanks, VocabularyBank, and Translator match legacy Aegis/LangLearn", () => {
  const catalog = LanguageRegistry.all();
  const codes = Object.keys(catalog);
  assert.equal(codes.length, 20, "all 20 target languages are registered");
  assert.deepEqual(codes, [
    "nl", "es", "it", "fr", "de", "en", "pt", "ar", "zh", "ja",
    "ko", "ru", "hi", "tr", "sw", "yo", "ig", "ha", "af", "zu",
  ]);

  const ar = LanguageRegistry.get("ar");
  assert.equal(ar.direction, "rtl");
  assert.equal(ar.writing_system, "arabic");

  const nl = LanguageRegistry.get("nl");
  assert.equal(nl.features.assessment_ceiling, "B1");
  assert.equal(nl.assessment_bank, 12);

  const sw = LanguageRegistry.get("sw");
  assert.equal(sw.features.assessment_ceiling, "A1");
  assert.equal(sw.assessment_bank, 5);

  // Every language has placement items, 10 vocabulary words, teacher phrases, and translator support
  let totalWords = 0;
  for (const code of codes) {
    const items = ItemBanks.items(code);
    assert.ok(items.length >= 5, `${code} has placement/checkpoint item bank`);
    const words = VocabularyBank.items(code);
    assert.equal(words.length, 10, `${code} has 10 authored vocabulary words`);
    totalWords += words.length;
    assert.ok(TeacherContent.conversations(code).length >= 1, `${code} has authored conversation scenario`);
    assert.equal(TeacherContent.writingTasks(code).length, 2, `${code} has 2 authored writing tasks`);
  }
  assert.equal(totalWords, 200, "10 authored vocabulary words across 20 languages = 200 words");

  // Verify against legacy PHP source files
  const phpRegistry = readFileSync(
    path.join(REPO_ROOT, "application/libraries/Aegis/LangLearn/LanguageRegistry.php"),
    "utf8",
  );
  for (const code of codes) {
    assert.ok(phpRegistry.includes(`'${code}'`), `PHP LanguageRegistry contains ${code}`);
  }

  // Translator detection & translation parity
  const detFr = Translator.detect("Bonjour");
  assert.equal(detFr.code, "fr");
  assert.equal(detFr.method, "phrase");
  assert.equal(detFr.confidence, 0.95);

  const detJa = Translator.detect("こんにちは");
  assert.equal(detJa.code, "ja");

  const trSame = Translator.translate("Hello", "en", "en");
  assert.equal(trSame.method, "same-language");
  assert.equal(trSame.translation, "Hello");

  const trPhrase = Translator.translate("Thank you", "fr", "en");
  assert.equal(trPhrase.method, "phrasebook");
  assert.equal(trPhrase.translation, "merci");

  const trHonestNone = Translator.translate("Thank you", "ja", "en");
  assert.equal(trHonestNone.method, "none");
  assert.equal(trHonestNone.translation, null);

  const trWord = Translator.translate("water book", "es", "en");
  assert.equal(trWord.method, "word-by-word");
  assert.match(trWord.translation.toLowerCase(), /agua/);

  // Diacritic folding in wordAccuracy
  const acc = wordAccuracy("Un café s'il vous plaît", "un cafe s il vous plait");
  assert.equal(acc, 100);

  // Curriculum modules between A1 and B1
  const mods = Curriculum.modulesFor("A1", "B1");
  assert.equal(mods.length, 11);
});

test("Phase 1–5 HTTP & service lifecycle: profiles, placement staircase, path, checkpoint, AI teacher, vocabulary SRS, listening/speaking, and adaptive engine", async (t) => {
  const instance = await createFileStoreApp();
  t.after(() => instance.cleanup());

  const admin = await signIn(instance, "rootadmin", "Root administrator pass");
  const get = (url, headers = admin.headers) => instance.app.inject({ method: "GET", url, headers });
  const post = (url, payload, headers = admin.headers) =>
    instance.app.inject({ method: "POST", url, headers, payload });

  // 1. Languages & Translator endpoints
  const langsRes = await get("/api/v1/language-learning/languages");
  assert.equal(langsRes.statusCode, 200);
  assert.equal(langsRes.json().languages.length, 20);

  const jaRes = await get("/api/v1/language-learning/languages/ja");
  assert.equal(jaRes.statusCode, 200);
  assert.equal(jaRes.json().language.writing_system, "kana");

  const detectRes = await post("/api/v1/language-learning/detect", { text: "Gracias" });
  assert.equal(detectRes.statusCode, 200);
  assert.equal(detectRes.json().detection.code, "es");

  const translateRes = await post("/api/v1/language-learning/translate", {
    text: "Good morning",
    target: "nl",
    source: "en",
  });
  assert.equal(translateRes.statusCode, 200);
  assert.equal(translateRes.json().translation.translation.toLowerCase(), "goedemorgen");

  // 2. Start profile (idempotent per user + language)
  const createProf = await post("/api/v1/language-learning/profiles", {
    languageCode: "fr",
    goal: "Travel and work in Paris",
    explanationLanguage: "en",
  });
  assert.equal(createProf.statusCode, 201, createProf.body);
  const profileId = createProf.json().profile.id;
  assert.equal(createProf.json().profile.language_code, "fr");
  assert.equal(createProf.json().profile.level, "Beginner", "unassessed profile starts at Beginner");

  const createProfAgain = await post("/api/v1/language-learning/profiles", {
    languageCode: "fr",
    goal: "Second call returns existing profile",
  });
  assert.equal(createProfAgain.statusCode, 201);
  assert.equal(createProfAgain.json().profile.id, profileId, "idempotent profile per user+language");

  // 3. Placement assessment staircase (level changes ONLY on completion)
  const startAss = await post(`/api/v1/language-learning/profiles/${profileId}/assessment/start`, {});
  assert.equal(startAss.statusCode, 201);
  const assessmentId = startAss.json().assessmentId;
  let currentItem = startAss.json().item;
  assert.ok(currentItem);
  assert.equal(currentItem.answer, undefined, "correct answer is never leaked to client");

  let stepRes = null;
  const frBank = Object.fromEntries(ItemBanks.items("fr").map((i) => [i.id, i]));
  for (let i = 0; i < 20; i += 1) {
    // Mid-assessment profile level must still be Beginner
    const midProf = await get(`/api/v1/language-learning/profiles/${profileId}`);
    assert.equal(midProf.json().profile.level, "Beginner", "level must not change mid-assessment");

    const answerIndex = frBank[currentItem.id].answer;
    const ans = await post(`/api/v1/language-learning/assessment/${assessmentId}/answer`, { answerIndex });
    assert.equal(ans.statusCode, 200, ans.body);
    stepRes = ans.json();
    if (stepRes.status === "COMPLETED") break;
    currentItem = stepRes.item;
  }
  assert.equal(stepRes.status, "COMPLETED");
  assert.ok(["A2", "B1"].includes(stepRes.result.overallLevel), "correct answers on FR staircase advance level");

  const afterProf = await get(`/api/v1/language-learning/profiles/${profileId}`);
  assert.equal(afterProf.json().profile.level, stepRes.result.overallLevel);

  // Answering a completed assessment is rejected with 409
  const extraAns = await post(`/api/v1/language-learning/assessment/${assessmentId}/answer`, { answerIndex: 0 });
  assert.equal(extraAns.statusCode, 409);

  // 4. Learning path & checkpoints
  const genPath = await post(`/api/v1/language-learning/profiles/${profileId}/path/generate`, {});
  assert.equal(genPath.statusCode, 201);
  const modules = genPath.json().modules;
  assert.ok(modules.length >= 3);
  assert.equal(modules[0].status, "AVAILABLE");
  assert.equal(modules[1].status, "LOCKED");

  // Locked module checkpoint refused with 409
  const lockedCp = await post(`/api/v1/language-learning/modules/${modules[1].id}/checkpoint/start`, {});
  assert.equal(lockedCp.statusCode, 409);

  // Start checkpoint on available module #1
  const startCp = await post(`/api/v1/language-learning/modules/${modules[0].id}/checkpoint/start`, {});
  assert.equal(startCp.statusCode, 201);
  const cpItems = startCp.json().quiz;
  assert.ok(cpItems.length >= 2);

  // Fail checkpoint first (all wrong answers) -> next module stays LOCKED
  const wrongAnswers = {};
  for (const item of cpItems) {
    wrongAnswers[item.id] = (frBank[item.id].answer + 1) % 4;
  }
  const failCp = await post(`/api/v1/language-learning/modules/${modules[0].id}/checkpoint/answer`, {
    answers: wrongAnswers,
  });
  assert.equal(failCp.statusCode, 200);
  assert.equal(failCp.json().passed, false);

  // Pass checkpoint (all right answers) -> completes module #1 and unlocks module #2
  const rightAnswers = {};
  for (const item of cpItems) {
    rightAnswers[item.id] = frBank[item.id].answer;
  }
  const passCp = await post(`/api/v1/language-learning/modules/${modules[0].id}/checkpoint/answer`, {
    answers: rightAnswers,
  });
  assert.equal(passCp.statusCode, 200);
  assert.equal(passCp.json().passed, true);
  assert.equal(passCp.json().moduleStatus, "COMPLETED");

  // 5. Phase 2: AI Teacher (guided lesson, conversation, writing, grammar explain-simply)
  const startLesson = await post(`/api/v1/language-learning/modules/${modules[1].id}/lesson/start`, {});
  assert.equal(startLesson.statusCode, 201);
  assert.ok(startLesson.json().lesson.examples.length >= 1);
  const practiceAnswers = {};
  for (const item of startLesson.json().lesson.practiceItems) {
    practiceAnswers[item.id] = frBank[item.id].answer;
  }
  const submitLesson = await post(`/api/v1/language-learning/modules/${modules[1].id}/lesson/answer`, {
    answers: practiceAnswers,
  });
  assert.equal(submitLesson.statusCode, 200);
  assert.equal(submitLesson.json().scorePct, 100);

  // Conversation with assisted advance after 2 misses
  const startConv = await post(`/api/v1/language-learning/profiles/${profileId}/conversations/start`, {
    scenario: "first-meeting",
    correction: "immediate",
  });
  assert.equal(startConv.statusCode, 201);
  const sessionId = startConv.json().sessionId;

  const miss1 = await post(`/api/v1/language-learning/conversations/${sessionId}/turn`, {
    text: "unrelated phrase",
  });
  assert.equal(miss1.statusCode, 200);
  assert.equal(miss1.json().lastFeedback.ok, false);
  assert.equal(miss1.json().assistedAdvance, false);

  const miss2 = await post(`/api/v1/language-learning/conversations/${sessionId}/turn`, {
    text: "still unrelated",
  });
  assert.equal(miss2.statusCode, 200);
  assert.equal(miss2.json().assistedAdvance, true);

  // Writing preserves original text verbatim
  const originalText = "Bonjour, je m'appelle Marie. Merci";
  const submitWrit = await post(`/api/v1/language-learning/profiles/${profileId}/writing/submit`, {
    taskCode: "self-introduction",
    text: originalText,
  });
  assert.equal(submitWrit.statusCode, 201);
  assert.equal(submitWrit.json().attempt.originalText, originalText, "original learner text is preserved verbatim");
  assert.equal(submitWrit.json().attempt.feedback.scorePct, 100);

  // Grammar rules & explain simply
  const gramRes = await get(`/api/v1/language-learning/profiles/${profileId}/grammar`);
  assert.equal(gramRes.statusCode, 200);
  const ruleId = gramRes.json().rules[0].id;
  const simpleRes = await get(`/api/v1/language-learning/profiles/${profileId}/grammar/${ruleId}/simple`);
  assert.equal(simpleRes.statusCode, 200);
  assert.ok(simpleRes.json().simple.rule.startsWith("Remember:"));

  // 6. Phase 3: Vocabulary SRS
  const addStarter = await post(`/api/v1/language-learning/profiles/${profileId}/vocabulary/add`, {
    starter: true,
  });
  assert.equal(addStarter.statusCode, 201);
  assert.equal(addStarter.json().added, 10);

  const startRev = await get(`/api/v1/language-learning/profiles/${profileId}/vocabulary/review/start?mode=flashcard&limit=4`);
  assert.equal(startRev.statusCode, 200);
  const revCards = startRev.json().cards;
  assert.equal(revCards.length, 4);

  const revAnswers = {};
  for (const card of revCards) {
    revAnswers[card.vocabularyId] = "remembered";
  }
  const submitRev = await post(`/api/v1/language-learning/profiles/${profileId}/vocabulary/review/submit`, {
    mode: "flashcard",
    answers: revAnswers,
  });
  assert.equal(submitRev.statusCode, 201);
  assert.equal(submitRev.json().correct, 4);
  assert.equal(submitRev.json().results[0].stage, 1);

  // 7. Phase 4: Listening & Speaking
  const listEx = await get(`/api/v1/language-learning/profiles/${profileId}/listening/exercises`);
  assert.equal(listEx.statusCode, 200);
  const ex0 = listEx.json().exercises[0];

  const subList = await post(`/api/v1/language-learning/profiles/${profileId}/listening/attempt`, {
    itemId: ex0.itemId,
    mode: "transcription",
    answer: ex0.speakText,
  });
  assert.equal(subList.statusCode, 201);
  assert.equal(subList.json().passed, true);
  assert.equal(subList.json().scorePct, 100);

  const speakPrompts = await get(`/api/v1/language-learning/profiles/${profileId}/speaking/prompts`);
  assert.equal(speakPrompts.statusCode, 200);
  const pr0 = speakPrompts.json().prompts[0];

  // Unscored self-practice when transcript is null
  const unscoredSpeak = await post(`/api/v1/language-learning/profiles/${profileId}/speaking/attempt`, {
    promptId: pr0.id,
    transcript: null,
  });
  assert.equal(unscoredSpeak.statusCode, 201);
  assert.equal(unscoredSpeak.json().scored, false);

  // Scored transcript when browser Web Speech provides text
  const scoredSpeak = await post(`/api/v1/language-learning/profiles/${profileId}/speaking/attempt`, {
    promptId: pr0.id,
    transcript: pr0.text,
  });
  assert.equal(scoredSpeak.statusCode, 201);
  assert.equal(scoredSpeak.json().scored, true);
  assert.equal(scoredSpeak.json().wordAccuracyPct, 100);
  assert.equal(scoredSpeak.json().exactMatch, true);

  // 8. Phase 5: Adaptive Learning (weaknesses, daily plan, recommendations, mastery, history)
  const weakRes = await get(`/api/v1/language-learning/profiles/${profileId}/adaptive/weaknesses`);
  assert.equal(weakRes.statusCode, 200);
  assert.ok(Array.isArray(weakRes.json().weaknesses));

  const planRes = await get(`/api/v1/language-learning/profiles/${profileId}/adaptive/daily-plan?minutes=20`);
  assert.equal(planRes.statusCode, 200);
  assert.ok(planRes.json().blocks.length >= 1);

  const recRes = await get(`/api/v1/language-learning/profiles/${profileId}/adaptive/recommendations`);
  assert.equal(recRes.statusCode, 200);
  assert.ok(Array.isArray(recRes.json().recommendations));

  const mastRes = await get(`/api/v1/language-learning/profiles/${profileId}/adaptive/mastery`);
  assert.equal(mastRes.statusCode, 200);
  assert.ok(typeof mastRes.json().counts === "object");

  const histRes = await get(`/api/v1/language-learning/profiles/${profileId}/history`);
  assert.equal(histRes.statusCode, 200);
  assert.ok(histRes.json().attempts.length >= 1);
  assert.ok(histRes.json().writing.length >= 1);
});
