/**
 * Request contract and refusal vocabulary for the public website assistant
 * (rows 4 and 18 — Phase 43).
 *
 * Legacy parity (`application/controllers/Api_chat.php`, `Aegis\ChatAssistant`):
 *  - `POST /api/chat/respond` accepted a JSON body with `message` and returned
 *    `{ message, provider, grounded, disclaimer }`.
 *  - `ChatAssistant::respond()` trimmed `message` and refused an empty string or
 *    one over 1 000 Unicode characters with `message must contain 1–1000 characters`
 *    (HTTP 400).
 *  - `Api_chat::respond()` throttled at 30 requests per 60 seconds with
 *    `chat rate limit exceeded; please try again shortly` (HTTP 429).
 *
 * `CHAT_RESPOND_BODY` checks the object envelope (`additionalProperties: false`,
 * so extra keys like `user`, `account`, `system` or `role` are refused at the
 * schema boundary) and requires `message` to be a string if present, while the
 * service enforces the trimmed 1–1 000 character bound so the caller receives
 * legacy's exact validation sentence.
 */

export const CHAT_RESPOND_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string", trim: false, default: "" },
  },
});

/** Legacy's exact 400 validation sentence (`Aegis\ChatAssistant::respond`). */
export const CHAT_INVALID_MESSAGE = "message must contain 1–1000 characters";

/** Legacy's exact 429 throttle sentence (`Api_chat::respond`). */
export const CHAT_RATE_LIMIT_MESSAGE = "chat rate limit exceeded; please try again shortly";
