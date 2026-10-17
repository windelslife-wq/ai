/**
 * Floating website assistant for the workspace shell (rows 4 and 18 — Phase 43).
 *
 * Legacy mounted `views/partials/chat_widget.php` in both `views/site/layout/footer.php`
 * (the public pages) and `views/layout/footer.php` (the signed-in workspace), while
 * deliberately omitting it from `views/auth/*` (the login and registration pages).
 * This module holds the pure copy, validation and request/response shapers for the
 * workspace widget so they can be asserted directly against `src/modules/chat/*`
 * and `src/modules/site/render.js` without a browser DOM.
 */

export const CHAT_ENDPOINT = Object.freeze({
  method: "POST",
  path: "/api/v1/chat/respond",
  auth: false,
  permission: null,
});

export const CHAT_MAX_MESSAGE_CHARS = 1_000;

export const CHAT_INVALID_MESSAGE = "message must contain 1–1000 characters";

export const CHAT_RATE_LIMIT_MESSAGE = "chat rate limit exceeded; please try again shortly";

/**
 * Verbatim copy from `application/views/partials/chat_widget.php`, shared with
 * `src/modules/site/render.js` (`CHAT_WIDGET_COPY`).
 */
export const CHAT_WIDGET_COPY = Object.freeze({
  endpoint: "/api/v1/chat/respond",
  dialogLabel: "WINDELS Assistant",
  title: "WINDELS Assistant",
  subtitle: "Product help · grounded responses",
  closeLabel: "Close assistant",
  closeTitle: "Close",
  greeting: "Hi, I'm the WINDELS Assistant. Ask me how to use the platform.",
  placeholder: "Ask about a page or feature…",
  inputLabel: "Message",
  sendLabel: "Send message",
  sendText: "Send",
  pendingText: "Thinking…",
  note: "Guidance only. No private account, market, sports, lottery or lead records are exposed to this assistant.",
  launchLabel: "Open WINDELS Assistant",
  launchTitle: "Ask WINDELS Assistant",
  launchText: "Ask WINDELS",
  fallbackInitial: "W",
});

export const CHAT_PORT_COPY = Object.freeze({
  isolation:
    "Product guidance only: POST /api/v1/chat/respond has no access to private account, market, sports, lottery or lead records.",
  divergences: Object.freeze({
    rateLimitKey:
      "Divergence CH-1: rate limiting (30 requests per 60 seconds) is keyed by client address rather than a session-cookie counter, so callers that omit cookies cannot bypass the limit.",
    httpsOnlyProvider:
      "Divergence CH-2: AI_CHAT_API_URL must be an https:// URL with no embedded credentials before the external provider is enabled; otherwise the assistant stays on local-guide.",
  }),
});

/**
 * Legacy `Aegis\ChatAssistant::respond` length check (1–1 000 Unicode characters
 * after trimming). Returns `null` when valid, or legacy's exact 400 sentence.
 */
export function validateChatMessage(raw) {
  const trimmed = String(raw ?? "").trim();
  const count = Array.from(trimmed).length;
  if (count === 0 || count > CHAT_MAX_MESSAGE_CHARS) {
    return CHAT_INVALID_MESSAGE;
  }
  return null;
}

/**
 * Builds the `POST /api/v1/chat/respond` body. Sends only `{ message }` so
 * `CHAT_RESPOND_BODY` (`additionalProperties: false`) never sees extra keys.
 */
export function buildChatBody(raw) {
  return {
    message: String(raw ?? "").trim(),
  };
}

export function formatChatReply(response) {
  return {
    text: String(response?.message || "No response was returned."),
    provider: response?.provider === "configured-ai" ? "configured-ai" : "local-guide",
    grounded: Boolean(response?.grounded ?? true),
    disclaimer: typeof response?.disclaimer === "string" ? response.disclaimer : null,
  };
}

export function formatChatFailure(error) {
  const message = String(error?.message || "The assistant could not process that question.");
  if (error?.status === 429 && Number(error?.retryAfter) > 0) {
    return `${message} Try again in about ${error.retryAfter}s.`;
  }
  return message;
}
