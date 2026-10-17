import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CONVERSATION_CORRECTION_MODES,
  LANGUAGE_COPY,
  LANGUAGE_PERMISSION,
  LANGUAGE_READS,
  LANGUAGE_TABS,
  LISTENING_MODES,
  VOCABULARY_REVIEW_MODES,
  formatCapabilityBadges,
  formatProficiencyBadge,
  summarizeDailyPlan,
  validateTranslationInput,
  validateWritingInput,
} from "../client/src/language.js";
import { LanguageRegistry } from "../src/modules/language/registry.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";

const CLIENT = path.resolve(import.meta.dirname, "..", "client", "src");

test("client language console helper vocabulary and pure validators match server contracts", () => {
  assert.equal(LANGUAGE_PERMISSION, "system.authenticated");
  assert.deepEqual(CONVERSATION_CORRECTION_MODES, ["immediate", "after", "important", "conversation_only"]);
  assert.deepEqual(VOCABULARY_REVIEW_MODES, ["quiz", "flashcard"]);
  assert.deepEqual(LISTENING_MODES, ["comprehension", "transcription"]);
  assert.equal(LANGUAGE_TABS.length, 8);
  assert.match(LANGUAGE_COPY.honestCapabilitiesRule, /never fabricates pronunciation scores/);

  const unassessed = formatProficiencyBadge({ level: "Beginner" });
  assert.equal(unassessed.label, "Beginner · Unassessed");
  assert.equal(unassessed.tone, "badge-amber");

  const assessed = formatProficiencyBadge({ level: "B1" });
  assert.equal(assessed.label, "CEFR B1");
  assert.equal(assessed.tone, "badge-green");

  const nlBadges = formatCapabilityBadges(LanguageRegistry.get("nl"));
  assert.equal(nlBadges[0].label, "Ceiling B1");
  assert.equal(nlBadges[1].label, "latin (LTR)");
  assert.equal(nlBadges[2].label, "12 bank items");

  const arBadges = formatCapabilityBadges(LanguageRegistry.get("ar"));
  assert.equal(arBadges[1].label, "arabic (RTL)");

  assert.equal(validateTranslationInput("", "es"), "text must be 1–500 characters");
  assert.equal(validateTranslationInput("Hello", ""), "target language code is required");
  assert.equal(validateTranslationInput("Hello", "es"), null);

  assert.equal(validateWritingInput("", "Hello world"), "taskCode is required");
  assert.equal(validateWritingInput("self-introduction", "hi"), "writing submission must be 3–2000 characters");
  assert.equal(validateWritingInput("self-introduction", "Bonjour, je m'appelle Jean."), null);

  const summary = summarizeDailyPlan({
    day: "2026-10-17",
    estimatedMinutes: 15,
    blocks: [{ block: "vocabulary", done: true }, { block: "module", done: false }],
  });
  assert.deepEqual(summary, {
    day: "2026-10-17",
    estimatedMinutes: 15,
    blockCount: 2,
    completedBlocks: 1,
  });
});

test("App.jsx and views.jsx declare /app/languages and /app/languages/teacher and match registered API routes", async (t) => {
  const instance = await createFileStoreApp();
  t.after(() => instance.cleanup());

  const login = await instance.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifier: "rootadmin", password: "Root administrator pass" },
  });
  assert.equal(login.statusCode, 200);
  const headers = { cookie: cookieFrom(login), "x-csrf-token": login.json().csrfToken };

  const routesRes = await instance.app.inject({ method: "GET", url: "/api/v1/system/routes", headers });
  assert.equal(routesRes.statusCode, 200);
  const routes = routesRes.json().routes;

  for (const read of LANGUAGE_READS) {
    const match = routes.find((r) => r.method === "GET" && r.path === read.path);
    assert.ok(match, `${read.path} is registered on the server`);
    assert.equal(match.permission, read.permission);
  }

  const appSource = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  const viewsSource = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");
  assert.match(appSource, /path:\s*"\/app\/languages"/);
  assert.match(appSource, /path:\s*"\/app\/languages\/teacher"/);
  assert.match(viewsSource, /export function LanguageLearningView/);
});
