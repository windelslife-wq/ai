/**
 * Public website assistant (rows 4 and 18 — Phase 43), ported from
 * `application/libraries/Aegis/ChatAssistant.php`.
 *
 * Honesty and isolation contract:
 *  - Account and domain data are NEVER exposed to this service. `createChatService`
 *    is not handed `store`, `paper`, `strategies`, `execution`, `sports`,
 *    `lottery`, `brokers` or the caller's session, so it cannot read private
 *    records by construction.
 *  - By default (`AI_CHAT_ENABLED=0` or any missing/unsafe provider setting), the
 *    assistant answers from the deterministic local product guide (`provider:
 *    "local-guide"`) and states that an approved AI provider must be configured
 *    for generated responses.
 *  - When `AI_CHAT_ENABLED=1` and a valid `https://` `AI_CHAT_API_URL` (with no
 *    embedded credentials — divergence CH-2), `AI_CHAT_API_KEY` and
 *    `AI_CHAT_MODEL` are configured, the service calls the OpenAI-compatible
 *    chat-completions endpoint with legacy's exact `SYSTEM` prompt,
 *    `temperature: 0.2` and `max_tokens: 260`. If the upstream fails, times out
 *    or returns empty content, it falls back cleanly to `local-guide` rather
 *    than failing the visitor's question.
 */

import { AppError } from "../../http/errors.js";
import { CHAT_INVALID_MESSAGE } from "./contracts.js";

/** Legacy `Aegis\ChatAssistant::SYSTEM`, verbatim. */
export const CHAT_SYSTEM_PROMPT =
  "You are the WINDELS AI WORKFORCE website assistant. Explain only navigation and documented product features: the AI language teacher, language learning, trading intelligence, paper trading, sports intelligence, EuroMillions research, lead discovery and account access. Never reveal or link to the administrator login, never claim access to private records, never invent market, sports, lottery or business data, and say when a real provider or signed-in administrator is required. Keep replies concise and practical.";

/** Legacy disclaimers for the two response paths, verbatim. */
export const CHAT_DISCLAIMERS = Object.freeze({
  configuredAi: "Product guidance only; no private record data was provided to the assistant.",
  localGuide: "Product guidance only; configure an approved AI provider for generated responses.",
});

/**
 * Legacy `Aegis\ChatAssistant::localAnswer` rules in their exact evaluation order.
 * Exported as data so the parity suite can compare every branch against the PHP
 * source directly.
 */
export const LOCAL_GUIDE_RULES = Object.freeze([
  Object.freeze({
    keywords: Object.freeze(["duplicate"]),
    answer: "Open Lead Discovery Intelligence to review duplicate candidates. Provider plus stable source ID is the primary identity rule; secondary signals require a human decision.",
  }),
  Object.freeze({
    keywords: Object.freeze(["export"]),
    answer: "Open Lead Discovery or Intelligence to create a formula-safe CSV/JSON export. Every export is recorded in the audit history.",
  }),
  Object.freeze({
    keywords: Object.freeze(["admin", "administrator"]),
    answer: "WINDELS AI WORKFORCE only exposes the normal member sign-in publicly. Administrator controls are kept behind a private entry point and are never linked from the public site.",
  }),
  Object.freeze({
    keywords: Object.freeze(["user"]),
    answer: "Use the member sign-in to open your workspace. If you do not have an account yet, register on the homepage.",
  }),
  Object.freeze({
    keywords: Object.freeze(["search", "lead"]),
    answer: "Open Lead Discovery to search a city, category or business type. A configured provider is required; empty provider results are never replaced with fake businesses.",
  }),
  Object.freeze({
    keywords: Object.freeze(["trade", "paper"]),
    answer: "Trading defaults to analysis-only with the kill switch active. Paper trading is simulation and every order passes risk controls.",
  }),
  Object.freeze({
    keywords: Object.freeze(["language"]),
    answer: "Open Languages to create a profile, take an evidence-based assessment, study lessons and vocabulary, and review adaptive plans.",
  }),
  Object.freeze({
    keywords: Object.freeze(["lottery", "euromillions"]),
    answer: "EuroMillions outputs describe historical observations only. Official data providers must be configured before official draws are ingested.",
  }),
]);

/** Default local-guide response when no keyword branch matches. */
export const CHAT_FALLBACK_MESSAGE =
  "I can guide you through the AI Language Teacher, Languages, Dashboard, Lead Discovery, Pipeline, Sports, EuroMillions, Trading and Account. Ask about any area.";

export const CHAT_MAX_MESSAGE_CHARS = 1_000;
export const CHAT_MAX_PROVIDER_CHARS = 2_000;

/**
 * Pure local product-guide responder (`Aegis\ChatAssistant::localAnswer`).
 */
export function localAnswer(message) {
  const value = String(message ?? "").toLowerCase();
  for (const rule of LOCAL_GUIDE_RULES) {
    if (rule.keywords.some((keyword) => value.includes(keyword))) {
      return rule.answer;
    }
  }
  return CHAT_FALLBACK_MESSAGE;
}

/**
 * Divergence CH-2: the provider URL must be `https://` with no embedded
 * username/password. Legacy passed `AI_CHAT_API_URL` directly to
 * `file_get_contents()`, which would send the Bearer key over cleartext `http://`
 * or open a non-HTTPS scheme if misconfigured.
 */
export function isSafeProviderUrl(rawUrl) {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) return false;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  return true;
}

function scrubSecret(text, secret) {
  const raw = String(text ?? "");
  const key = String(secret ?? "").trim();
  return key ? raw.split(key).join("[redacted]") : raw;
}

async function defaultTransport({ url, apiKey, body, timeoutMs = 8_000 }) {
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) return null;
  return response.json();
}

/**
 * @param {{config?: object, log?: object|null, transport?: Function}} options
 */
export function createChatService({ config = null, log = null, transport = undefined } = {}) {
  const sendRequest = typeof transport === "function"
    ? transport
    : (typeof config?.transport === "function" ? config.transport : defaultTransport);
  const settings = Object.freeze({
    enabled: false,
    apiUrl: "",
    apiKey: "",
    model: "",
    timeoutMs: 8_000,
    ...(config && typeof config === "object" ? config : {}),
  });

  function configured() {
    return (
      settings.enabled === true
      && isSafeProviderUrl(settings.apiUrl)
      && String(settings.apiKey ?? "").trim() !== ""
      && String(settings.model ?? "").trim() !== ""
    );
  }

  /**
   * Credential-free status description for `/api/v1/system/status`.
   * Never exposes `apiKey` or probes the external provider.
   */
  function statusSnapshot() {
    const ready = configured();
    return {
      enabled: ready,
      provider: ready ? "configured-ai" : "local-guide",
      model: ready ? String(settings.model).trim() : null,
      apiKeyConfigured: String(settings.apiKey ?? "").trim() !== "",
      privateDataAccess: false,
      disclaimer: ready ? CHAT_DISCLAIMERS.configuredAi : CHAT_DISCLAIMERS.localGuide,
    };
  }

  async function providerAnswer(message) {
    const body = {
      model: String(settings.model).trim(),
      messages: [
        { role: "system", content: CHAT_SYSTEM_PROMPT },
        { role: "user", content: message },
      ],
      temperature: 0.2,
      max_tokens: 260,
    };
    try {
      const payload = await sendRequest({
        url: String(settings.apiUrl).trim(),
        apiKey: String(settings.apiKey).trim(),
        body,
        timeoutMs: settings.timeoutMs,
      });
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") return null;
      return Array.from(content.trim()).slice(0, CHAT_MAX_PROVIDER_CHARS).join("");
    } catch (error) {
      log?.warn?.(
        { errorMessage: scrubSecret(error?.message || "chat provider request failed", settings.apiKey) },
        "Public chat provider failed; falling back to local guide",
      );
      return null;
    }
  }

  /**
   * Port of `Aegis\ChatAssistant::respond(string $message)`.
   * Never accepts or reads user/account state.
   */
  async function respond(rawMessage) {
    const trimmed = String(rawMessage ?? "").trim();
    const codePoints = Array.from(trimmed);
    if (codePoints.length === 0 || codePoints.length > CHAT_MAX_MESSAGE_CHARS) {
      throw AppError.badRequest(CHAT_INVALID_MESSAGE, { code: "INVALID_MESSAGE" });
    }
    if (configured()) {
      const answer = await providerAnswer(trimmed);
      if (answer !== null) {
        return {
          message: answer,
          provider: "configured-ai",
          grounded: true,
          disclaimer: CHAT_DISCLAIMERS.configuredAi,
        };
      }
    }
    return {
      message: localAnswer(trimmed),
      provider: "local-guide",
      grounded: true,
      disclaimer: CHAT_DISCLAIMERS.localGuide,
    };
  }

  return {
    configured,
    statusSnapshot,
    respond,
  };
}
