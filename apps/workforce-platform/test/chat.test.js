/**
 * Phase 43 — Public website assistant (`Aegis\ChatAssistant`, `Api_chat::respond`,
 * `views/partials/chat_widget.php` — rows 4 and 18).
 *
 * Verifies:
 *  1. Configuration (`loadConfig().chat`) and the `https://`-only provider URL
 *     gate (divergence CH-2).
 *  2. Differential PHP-vs-Node parity against `application/libraries/Aegis/ChatAssistant.php`,
 *     `application/controllers/Api_chat.php` and `application/views/partials/chat_widget.php`.
 *  3. Upstream OpenAI-compatible provider transport, 2 000-character truncation,
 *     graceful fallback to `local-guide`, and API-key redaction in logs.
 *  4. HTTP contract on `POST /api/v1/chat/respond`: public (`auth: false`),
 *     schema-validated (`additionalProperties: false`), 1–1 000 Unicode character
 *     bound with legacy's exact 400 message, and per-client-address rate limiting
 *     with legacy's exact 429 message (divergence CH-1).
 *  5. Floating widget wiring on both the public pages (`src/modules/site/render.js`,
 *     `public/site.js`, `public/styles.css`) and the signed-in workspace shell
 *     (`client/src/chat.js`, `client/src/views.jsx`, `client/src/App.jsx`), while
 *     remaining absent on the guest auth screens (`EntryLayout`).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CHAT_ENDPOINT,
  CHAT_INVALID_MESSAGE as CLIENT_INVALID_MESSAGE,
  CHAT_MAX_MESSAGE_CHARS as CLIENT_MAX_CHARS,
  CHAT_PORT_COPY,
  CHAT_RATE_LIMIT_MESSAGE as CLIENT_RATE_LIMIT_MESSAGE,
  CHAT_WIDGET_COPY as CLIENT_WIDGET_COPY,
  buildChatBody,
  formatChatFailure,
  formatChatReply,
  validateChatMessage,
} from "../client/src/chat.js";
import { JOURNAL_PORT_COPY } from "../client/src/journal.js";
import { loadConfig } from "../src/config.js";
import {
  CHAT_INVALID_MESSAGE,
  CHAT_RATE_LIMIT_MESSAGE,
  CHAT_RESPOND_BODY,
} from "../src/modules/chat/contracts.js";
import {
  CHAT_DISCLAIMERS,
  CHAT_FALLBACK_MESSAGE,
  CHAT_MAX_MESSAGE_CHARS,
  CHAT_MAX_PROVIDER_CHARS,
  CHAT_SYSTEM_PROMPT,
  LOCAL_GUIDE_RULES,
  createChatService,
  isSafeProviderUrl,
  localAnswer,
} from "../src/modules/chat/service.js";
import { CHAT_WIDGET_COPY as SITE_WIDGET_COPY, renderChatWidget } from "../src/modules/site/render.js";
import { createFileStoreApp } from "./helpers.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const PHP_ASSISTANT = path.join(REPO_ROOT, "application", "libraries", "Aegis", "ChatAssistant.php");
const PHP_CONTROLLER = path.join(REPO_ROOT, "application", "controllers", "Api_chat.php");
const PHP_WIDGET = path.join(REPO_ROOT, "application", "views", "partials", "chat_widget.php");
const CLIENT_SRC = path.resolve(import.meta.dirname, "..", "client", "src");

const ENV_BASE = {
  NODE_ENV: "test",
  STORAGE_ADAPTER: "file",
  SESSION_SECRET: "test-session-secret-with-at-least-32-bytes-long",
};

function loadChat(overrides = {}) {
  return loadConfig({ ...ENV_BASE, ...overrides }).chat;
}

// ------------------------------------------------------------ 1. configuration

test("CHAT configuration is disabled by default and requires all four AI_CHAT_* values", () => {
  const defaults = loadChat();
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.apiUrl, "");
  assert.equal(defaults.apiKey, "");
  assert.equal(defaults.model, "");
  assert.equal(defaults.timeoutMs, 8_000);
  assert.equal(defaults.maxPerWindow, 30);
  assert.equal(defaults.windowMs, 60_000);

  const complete = {
    AI_CHAT_ENABLED: "1",
    AI_CHAT_API_URL: "https://api.openai.example.test/v1/chat/completions",
    AI_CHAT_API_KEY: "sk-test-secret-value",
    AI_CHAT_MODEL: "gpt-4o-mini",
  };
  const enabled = loadChat(complete);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.apiUrl, complete.AI_CHAT_API_URL);
  assert.equal(enabled.apiKey, complete.AI_CHAT_API_KEY);
  assert.equal(enabled.model, complete.AI_CHAT_MODEL);

  for (const key of Object.keys(complete)) {
    const partial = loadChat({ ...complete, [key]: "" });
    assert.equal(partial.enabled, false, `missing ${key} must keep config.chat.enabled false`);
  }
});

test("CHAT divergence CH-2 refuses non-HTTPS or credential-bearing provider URLs", () => {
  assert.equal(isSafeProviderUrl("https://api.openai.example.test/v1/chat/completions"), true);
  assert.equal(isSafeProviderUrl("http://api.openai.example.test/v1/chat/completions"), false, "cleartext http:// must be refused");
  assert.equal(isSafeProviderUrl("https://user:pass@api.openai.example.test/v1/chat/completions"), false, "embedded credentials must be refused");
  assert.equal(isSafeProviderUrl("file:///etc/passwd"), false);
  assert.equal(isSafeProviderUrl("not a url"), false);
  assert.equal(isSafeProviderUrl(""), false);

  let transportCalled = false;
  const service = createChatService({
    config: {
      enabled: true,
      apiUrl: "http://api.openai.example.test/v1/chat/completions",
      apiKey: "sk-test-secret",
      model: "gpt-4o-mini",
    },
    transport: async () => {
      transportCalled = true;
      return { choices: [{ message: { content: "Should never be called" } }] };
    },
  });
  assert.equal(service.configured(), false, "an http:// provider URL must keep the service on local-guide");
  assert.equal(service.statusSnapshot().provider, "local-guide");
  assert.equal(transportCalled, false);
});

// ------------------------------------------------ 2. PHP differential parity

test("CHAT constants, disclaimers, rate-limit copy and local-guide rules match PHP source verbatim", () => {
  const phpAssistant = readFileSync(PHP_ASSISTANT, "utf8");
  const phpController = readFileSync(PHP_CONTROLLER, "utf8");

  assert.ok(phpAssistant.includes(CHAT_SYSTEM_PROMPT), "CHAT_SYSTEM_PROMPT must match Aegis\\ChatAssistant::SYSTEM byte-for-byte");
  assert.ok(phpAssistant.includes(CHAT_DISCLAIMERS.configuredAi), "configured-ai disclaimer must match PHP");
  assert.ok(phpAssistant.includes(CHAT_DISCLAIMERS.localGuide), "local-guide disclaimer must match PHP");
  assert.ok(phpAssistant.includes(CHAT_INVALID_MESSAGE), "invalid-message error must match PHP");
  assert.ok(phpAssistant.includes(CHAT_FALLBACK_MESSAGE), "fallback guide message must match PHP");

  let lastOffset = -1;
  for (const rule of LOCAL_GUIDE_RULES) {
    const offset = phpAssistant.indexOf(rule.answer);
    assert.ok(offset > lastOffset, `rule answer "${rule.answer.slice(0, 32)}…" must appear in ChatAssistant.php in the exact evaluation order`);
    lastOffset = offset;
  }

  assert.ok(phpController.includes(CHAT_RATE_LIMIT_MESSAGE), "429 message must match Api_chat::respond");
  assert.match(phpController, /count\(\$window\)\s*>=\s*30/, "legacy rate limit cap is 30 requests");
  assert.match(phpController, /\$at\s*>\s*\$now\s*-\s*60/, "legacy rate limit window is 60 seconds");
});

/**
 * Extracts `Aegis\ChatAssistant::localAnswer` and `respond` directly from the PHP
 * source file so the parity check executes the live PHP rules without needing a
 * local `php` binary in the container.
 */
function buildPhpOracleFromSource(phpSource) {
  const localBodyMatch = phpSource.match(/private function localAnswer\(string \$message\): string\s*\{([\s\S]*?)\n    \}/);
  assert.ok(localBodyMatch, "ChatAssistant.php must define private function localAnswer(string $message): string");
  const body = localBodyMatch[1];

  const branches = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("if (")) continue;
    const keywords = [...trimmed.matchAll(/str_contains\(\$value,\s*'([^']+)'\)/g)].map((m) => m[1]);
    const ret = trimmed.match(/return\s+'([^']+)';/);
    assert.ok(keywords.length >= 1 && ret, `unrecognised localAnswer branch in PHP: ${trimmed}`);
    branches.push({ keywords, answer: ret[1] });
  }
  const fallbackMatch = body.match(/^\s*return\s+'([^']+)';/m);
  assert.ok(fallbackMatch, "localAnswer must end with a default return literal");
  const fallback = fallbackMatch[1];

  const invalidMatch = phpSource.match(/InvalidArgumentException\('([^']+)'\)/);
  assert.ok(invalidMatch, "ChatAssistant::respond must throw InvalidArgumentException");
  const invalidMessage = invalidMatch[1];

  const localDisclaimerMatch = phpSource.match(/'provider'\s*=>\s*'local-guide'[\s\S]*?'disclaimer'\s*=>\s*'([^']+)'/);
  assert.ok(localDisclaimerMatch, "ChatAssistant::respond must declare the local-guide disclaimer");
  const localDisclaimer = localDisclaimerMatch[1];

  return (rawMessage) => {
    const message = String(rawMessage ?? "").trim();
    const len = Array.from(message).length;
    if (message === "" || len > 1_000) {
      return { ok: false, error: invalidMessage };
    }
    const m = message.toLowerCase();
    let answer = fallback;
    for (const branch of branches) {
      if (branch.keywords.some((kw) => m.includes(kw))) {
        answer = branch.answer;
        break;
      }
    }
    return {
      ok: true,
      result: {
        message: answer,
        provider: "local-guide",
        grounded: true,
        disclaimer: localDisclaimer,
      },
    };
  };
}

test("CHAT differential parity: PHP Aegis\\ChatAssistant::respond and Node createChatService agree on every branch", async () => {
  const phpSource = readFileSync(PHP_ASSISTANT, "utf8");
  const phpOracle = buildPhpOracleFromSource(phpSource);

  const corpus = [
    "How do I review duplicate candidates?",
    "Can I export leads to CSV?",
    "Where is the admin login?",
    "How does an administrator sign in?",
    "How does a user sign in or register?",
    "How do I search for a lead in a city?",
    "Is paper trading live or simulation?",
    "How do I trade on this platform?",
    "Tell me about language learning.",
    "How does EuroMillions lottery research work?",
    "What can you help me with?",
    // Multi-keyword precedence: earlier branches in ChatAssistant::localAnswer win.
    "duplicate export admin user search trade language lottery",
    "admin user trade",
    "search paper lottery",
    // Case-insensitivity and surrounding whitespace.
    "   EUROMILLIONS   ",
    "  Paper Trading  ",
    // Boundary lengths (1 char, 1000 Unicode chars, empty, 1001 Unicode chars).
    "?",
    "é".repeat(1_000),
    "   ",
    "é".repeat(1_001),
  ];

  const service = createChatService({ config: { enabled: false } });
  for (let i = 0; i < corpus.length; i += 1) {
    const input = corpus[i];
    const expected = phpOracle(input);
    if (expected.ok) {
      const actual = await service.respond(input);
      assert.deepEqual(actual, expected.result, `mismatch for input index ${i} (${JSON.stringify(input.slice(0, 40))})`);
    } else {
      await assert.rejects(
        () => service.respond(input),
        (error) => {
          assert.equal(error.statusCode, 400);
          assert.equal(error.message, expected.error);
          return true;
        },
        `expected 400 for input index ${i}`,
      );
    }
  }
});

// ------------------------------------ 3. provider transport & secret scrubbing

test("CHAT configured provider sends the system prompt, caps replies at 2000 chars and falls back cleanly on error without leaking AI_CHAT_API_KEY", async () => {
  const calls = [];
  const secretKey = "sk-live-super-secret-token-value";
  const longReply = "A".repeat(2_250);

  const service = createChatService({
    config: {
      enabled: true,
      apiUrl: "https://api.openai.example.test/v1/chat/completions",
      apiKey: secretKey,
      model: "gpt-4o-mini",
      timeoutMs: 5_000,
    },
    transport: async (request) => {
      calls.push(request);
      return {
        choices: [{ message: { content: `  ${longReply}  ` } }],
      };
    },
  });

  assert.equal(service.configured(), true);
  const snapshot = service.statusSnapshot();
  assert.deepEqual(snapshot, {
    enabled: true,
    provider: "configured-ai",
    model: "gpt-4o-mini",
    apiKeyConfigured: true,
    privateDataAccess: false,
    disclaimer: CHAT_DISCLAIMERS.configuredAi,
  });
  assert.equal(JSON.stringify(snapshot).includes(secretKey), false, "statusSnapshot must never contain AI_CHAT_API_KEY");

  const reply = await service.respond("  How does paper trading work?  ");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.example.test/v1/chat/completions");
  assert.equal(calls[0].apiKey, secretKey);
  assert.deepEqual(calls[0].body, {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: CHAT_SYSTEM_PROMPT },
      { role: "user", content: "How does paper trading work?" },
    ],
    temperature: 0.2,
    max_tokens: 260,
  });
  assert.equal(reply.provider, "configured-ai");
  assert.equal(reply.grounded, true);
  assert.equal(reply.disclaimer, CHAT_DISCLAIMERS.configuredAi);
  assert.equal(reply.message.length, CHAT_MAX_PROVIDER_CHARS);

  // Now simulate an upstream failure whose error message echoes the Bearer token.
  const warnings = [];
  const failing = createChatService({
    config: {
      enabled: true,
      apiUrl: "https://api.openai.example.test/v1/chat/completions",
      apiKey: secretKey,
      model: "gpt-4o-mini",
    },
    log: {
      warn(meta, msg) {
        warnings.push({ meta, msg });
      },
    },
    transport: async () => {
      throw new Error(`Upstream 401 for Bearer ${secretKey}`);
    },
  });

  const fallback = await failing.respond("How does paper trading work?");
  assert.equal(fallback.provider, "local-guide");
  assert.equal(fallback.grounded, true);
  assert.equal(fallback.disclaimer, CHAT_DISCLAIMERS.localGuide);
  assert.equal(fallback.message, localAnswer("How does paper trading work?"));
  assert.equal(warnings.length, 1);
  assert.equal(JSON.stringify(warnings).includes(secretKey), false, "logged warnings must redact AI_CHAT_API_KEY");
  assert.match(warnings[0].meta.errorMessage, /\[redacted\]/);
});

// -------------------------------------------- 4. HTTP route & security checks

test("CHAT POST /api/v1/chat/respond is public, schema-validated, isolated from private records and rate-limited per client address (CH-1)", async (t) => {
  const instance = await createFileStoreApp({
    configOverrides: {
      env: {
        TRUST_PROXY: "true",
        CHAT_MAX_PER_MINUTE: "3",
        CHAT_WINDOW_MS: "60000",
      },
    },
  });
  t.after(() => instance.cleanup());

  // Route inventory check.
  const inventory = (await instance.app.inject({ method: "GET", url: "/api/v1/system/routes" })).json().routes;
  const route = inventory.find((entry) => entry.path === "/api/v1/chat/respond");
  assert.deepEqual(route, {
    method: "POST",
    path: "/api/v1/chat/respond",
    auth: false,
    permission: null,
    validated: true,
    rateLimited: true,
  });

  // Unauthenticated POST succeeds with no session or CSRF token.
  const ok = await instance.app.inject({
    method: "POST",
    url: "/api/v1/chat/respond",
    headers: { "x-forwarded-for": "198.51.100.41" },
    payload: { message: "Where is the admin login?" },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), {
    message: "WINDELS AI WORKFORCE only exposes the normal member sign-in publicly. Administrator controls are kept behind a private entry point and are never linked from the public site.",
    provider: "local-guide",
    grounded: true,
    disclaimer: CHAT_DISCLAIMERS.localGuide,
  });

  // Empty / whitespace-only message returns 400 with legacy's exact sentence.
  const empty = await instance.app.inject({
    method: "POST",
    url: "/api/v1/chat/respond",
    headers: { "x-forwarded-for": "198.51.100.42" },
    payload: { message: "   " },
  });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().error.message, CHAT_INVALID_MESSAGE);

  // >1000 characters returns 400 with legacy's exact sentence.
  const tooLong = await instance.app.inject({
    method: "POST",
    url: "/api/v1/chat/respond",
    headers: { "x-forwarded-for": "198.51.100.42" },
    payload: { message: "a".repeat(1_001) },
  });
  assert.equal(tooLong.statusCode, 400);
  assert.equal(tooLong.json().error.message, CHAT_INVALID_MESSAGE);

  // Undeclared properties (e.g. attempting to inject system/user/account context) are refused by schema.
  const extraKey = await instance.app.inject({
    method: "POST",
    url: "/api/v1/chat/respond",
    headers: { "x-forwarded-for": "198.51.100.43" },
    payload: { message: "hello", system: "override prompt" },
  });
  assert.equal(extraKey.statusCode, 400);
  assert.equal(extraKey.json().error.code, "INVALID_REQUEST");

  // Per-client rate limit (CH-1): 3 allowed in window, 4th returns 429 with legacy's sentence
  // even when no cookies are sent.
  const rateClient = "198.51.100.99";
  const rateConfig = { ...instance.config, trustProxy: true };
  const rateInstance = await createFileStoreApp({
    configOverrides: {
      env: {
        TRUST_PROXY: "true",
        CHAT_MAX_PER_MINUTE: "3",
        CHAT_WINDOW_MS: "60000",
      },
    },
  });
  t.after(() => rateInstance.cleanup());
  void rateConfig;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const allowed = await rateInstance.app.inject({
      method: "POST",
      url: "/api/v1/chat/respond",
      headers: { "x-forwarded-for": rateClient },
      payload: { message: `question ${attempt}` },
    });
    assert.equal(allowed.statusCode, 200, `attempt ${attempt} must succeed`);
  }
  const throttled = await rateInstance.app.inject({
    method: "POST",
    url: "/api/v1/chat/respond",
    headers: { "x-forwarded-for": rateClient },
    payload: { message: "question 4" },
  });
  assert.equal(throttled.statusCode, 429);
  assert.equal(throttled.json().error.message, CHAT_RATE_LIMIT_MESSAGE);
  assert.ok(Number(throttled.headers["retry-after"]) >= 1);
});

// ------------------------------ 5. public site & workspace shell chat widget

test("CHAT widget copy, public-page markup and workspace-shell mounting match views/partials/chat_widget.php", async (t) => {
  const phpWidget = readFileSync(PHP_WIDGET, "utf8");

  // Both the public-site renderer and the SPA client share the exact widget copy.
  assert.deepEqual(CLIENT_WIDGET_COPY, SITE_WIDGET_COPY);
  assert.equal(CLIENT_MAX_CHARS, CHAT_MAX_MESSAGE_CHARS);
  assert.equal(CLIENT_INVALID_MESSAGE, CHAT_INVALID_MESSAGE);
  assert.equal(CLIENT_RATE_LIMIT_MESSAGE, CHAT_RATE_LIMIT_MESSAGE);
  assert.equal(CHAT_ENDPOINT.path, "/api/v1/chat/respond");

  for (const snippet of [
    SITE_WIDGET_COPY.title,
    SITE_WIDGET_COPY.subtitle,
    SITE_WIDGET_COPY.closeLabel,
    SITE_WIDGET_COPY.greeting,
    SITE_WIDGET_COPY.placeholder,
    SITE_WIDGET_COPY.note,
    SITE_WIDGET_COPY.launchLabel,
    SITE_WIDGET_COPY.launchTitle,
    SITE_WIDGET_COPY.launchText,
  ]) {
    assert.ok(phpWidget.includes(snippet), `views/partials/chat_widget.php must contain "${snippet}"`);
  }

  // Rendered public-site widget has no inline event handlers or inline styles (CSP-safe).
  const markup = renderChatWidget();
  assert.match(markup, /id="aegis-chat"/);
  assert.match(markup, /data-endpoint="\/api\/v1\/chat\/respond"/);
  assert.match(markup, /id="aegis-chat-panel"[^>]*hidden/);
  assert.doesNotMatch(markup, /\son\w+\s*=/i, "widget markup must not use inline event handlers");
  assert.doesNotMatch(markup, /\sstyle\s*=/i, "widget markup must not use inline styles");

  // Every public page includes the widget.
  const instance = await createFileStoreApp({
    configOverrides: { env: { PUBLIC_BASE_URL: "https://site.example.test" } },
  });
  t.after(() => instance.cleanup());

  for (const pagePath of ["/", "/about", "/services", "/how-it-works", "/safety", "/faq", "/contact"]) {
    const response = await instance.app.inject({ method: "GET", url: pagePath });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /id="aegis-chat"/, `${pagePath} must render the floating chat widget`);
    assert.match(response.body, /data-endpoint="\/api\/v1\/chat\/respond"/);
  }

  // Workspace shell mounts <ChatWidget /> inside WorkspaceShell and NEVER inside EntryLayout.
  const appSource = readFileSync(path.join(CLIENT_SRC, "App.jsx"), "utf8");
  const entryBlock = appSource.slice(
    appSource.indexOf("function EntryLayout"),
    appSource.indexOf("function WorkspaceShell"),
  );
  const workspaceBlock = appSource.slice(
    appSource.indexOf("function WorkspaceShell"),
    appSource.indexOf("function WorkspaceOverview"),
  );
  assert.doesNotMatch(entryBlock, /ChatWidget/, "EntryLayout (/app/login, /app/register) must not render ChatWidget");
  assert.match(workspaceBlock, /<ChatWidget\s*\/>/, "WorkspaceShell must render <ChatWidget />");

  // Client helpers validate, build and format without inventing rules or dropping server errors.
  assert.equal(validateChatMessage(""), CHAT_INVALID_MESSAGE);
  assert.equal(validateChatMessage("   "), CHAT_INVALID_MESSAGE);
  assert.equal(validateChatMessage("x".repeat(1_001)), CHAT_INVALID_MESSAGE);
  assert.equal(validateChatMessage("How do I use paper trading?"), null);

  const built = buildChatBody("  How do I use paper trading?  ");
  assert.deepEqual(built, { message: "How do I use paper trading?" });
  assert.deepEqual(Object.keys(built), Object.keys(CHAT_RESPOND_BODY.properties));

  const formatted = formatChatReply({
    message: "Trading defaults to analysis-only with the kill switch active.",
    provider: "local-guide",
    grounded: true,
    disclaimer: CHAT_DISCLAIMERS.localGuide,
  });
  assert.equal(formatted.provider, "local-guide");
  assert.equal(formatted.grounded, true);
  assert.equal(formatted.disclaimer, CHAT_DISCLAIMERS.localGuide);

  assert.equal(
    formatChatFailure({ status: 429, message: CHAT_RATE_LIMIT_MESSAGE, retryAfter: 12 }),
    `${CHAT_RATE_LIMIT_MESSAGE} Try again in about 12s.`,
  );
  assert.match(CHAT_PORT_COPY.isolation, /no access to private account/i);
  assert.match(JOURNAL_PORT_COPY.row18, /POST \/api\/v1\/chat\/respond/);
});
