/**
 * Public website assistant endpoint (rows 4 and 18 — Phase 43), ported from
 * `application/controllers/Api_chat.php` (`POST /api/chat/respond`).
 *
 * Security and honesty properties:
 *  - Public route (`auth: false`, `permission: null`), matching `Api_controller`'s
 *    `PUBLIC_ACTIONS['api_chat/respond'] = true`.
 *  - Deliberately not handed `store` or any private domain service: private
 *    account, market, sports, lottery and lead records cannot be read here.
 *  - Divergence CH-1 (rate-limit key): legacy stored `aegis_chat_window` in the
 *    session cookie, so a caller that omitted cookies bypassed the 30/60s cap.
 *    Here the route uses the platform's per-client-address rate limiter with the
 *    same 30/60s window and legacy's exact 429 message.
 */

import { AppError } from "../../http/errors.js";
import { CHAT_RATE_LIMIT_MESSAGE, CHAT_RESPOND_BODY } from "./contracts.js";

export function chatRoutes(app, { config, chat }) {
  const maxPerWindow = config?.chat?.maxPerWindow ?? 30;
  const windowMs = config?.chat?.windowMs ?? 60_000;

  app.post("/chat/respond", {
    bodySchema: CHAT_RESPOND_BODY,
    config: {
      rateLimit: {
        max: maxPerWindow,
        windowMs,
        message: CHAT_RATE_LIMIT_MESSAGE,
      },
    },
  }, async (request) => {
    if (!chat) throw AppError.unavailable("Public chat assistant is unavailable", { retryAfter: 30 });
    return chat.respond(request.body.message);
  });
}
