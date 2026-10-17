# Phase 43 — Public Website Assistant (`Aegis\ChatAssistant`, `POST /api/v1/chat/respond`, Floating Widget)

**Date:** 2026-10-17  
**Backlog rows closed:** Row 4 (`publicSite` — moves from `partial` to `ported`) and Row 18 (`Api_chat::respond` + `Aegis\ChatAssistant` — closes Row 18's last unported surface).

---

## 1. Scope & Legacy Oracle

Phase 43 ports the public website assistant from the legacy CodeIgniter 3 application:

- `application/controllers/Api_chat.php` (`Api_chat::respond`, listed in `Api_controller::PUBLIC_ACTIONS['api_chat/respond'] = true`)
- `application/libraries/Aegis/ChatAssistant.php` (`SYSTEM` prompt, 8 keyword branches + fallback in `localAnswer()`, `AI_CHAT_ENABLED` / `AI_CHAT_API_URL` / `AI_CHAT_API_KEY` / `AI_CHAT_MODEL` OpenAI-compatible provider call, 1–1 000 Unicode character validation, 2 000-character provider truncation, grounded disclaimers)
- `application/views/partials/chat_widget.php`, `assets/js/aegis-chat.js` and `assets/css/chat-widget.css` (mounted in `views/site/layout/footer.php` on the public pages and `views/layout/footer.php` in the signed-in workspace, and deliberately omitted from `views/auth/*`)

---

## 2. Delivered Surfaces

1. **Configuration (`src/config.js`, `.env.example`)**
   - `loadChatConfig(env)` reads `AI_CHAT_ENABLED`, `AI_CHAT_API_URL`, `AI_CHAT_API_KEY`, `AI_CHAT_MODEL`, `AI_CHAT_TIMEOUT_MS` (default `8000`, range `1000..30000`), `CHAT_MAX_PER_MINUTE` (default `30`, range `1..1000`) and `CHAT_WINDOW_MS` (default `60000`, range `1000..3600000`).
   - All seven variables are documented in `apps/workforce-platform/.env.example` (91 documented variables total, verified by `verify:install` and `F-14`).

2. **Assistant Service & Route (`src/modules/chat/{contracts.js,service.js,routes.js}`)**
   - `createChatService` is constructed in `src/app.js` with `{ config: config.chat, log: app.log }` and is deliberately **not** handed `store`, `paper`, `strategies`, `execution`, `sports`, `lottery`, `brokers`, `notifications` or the caller's session. Private account and domain records cannot be read by construction (`privateDataAccess: false`).
   - `POST /api/v1/chat/respond` is registered as a public route (`auth: false`, `permission: null`, `validated: true`, `rateLimited: true`) with `CHAT_RESPOND_BODY` (`additionalProperties: false`).
   - Trims `message` and enforces 1–1 000 Unicode code points with legacy's exact 400 sentence (`message must contain 1–1000 characters`).
   - When `AI_CHAT_ENABLED=1` and a safe `https://` `AI_CHAT_API_URL`, `AI_CHAT_API_KEY` and `AI_CHAT_MODEL` are configured, calls the upstream chat-completions endpoint with `CHAT_SYSTEM_PROMPT`, `temperature: 0.2` and `max_tokens: 260`, caps replies at 2 000 characters, redacts `AI_CHAT_API_KEY` from any warning log entry, and falls back to `local-guide` on any upstream failure.
   - `GET /api/v1/system/status` includes a credential-free, probe-free `chat` snapshot (`enabled`, `provider`, `model`, `apiKeyConfigured`, `privateDataAccess: false`, `disclaimer`).

3. **Floating Widget on Public Pages & Signed-In Workspace Shell**
   - Public site (`src/modules/site/render.js`, `public/site.js`, `public/styles.css`): renders `#aegis-chat` and `#aegis-chat-panel[hidden]` on every public page without inline `onerror=` or `style=` attributes (preserving `script-src 'self'; style-src 'self'` CSP).
   - Workspace SPA (`client/src/chat.js`, `client/src/api.js`, `client/src/views.jsx`, `client/src/App.jsx`, `client/src/styles.css`): mounts `<ChatWidget />` inside `WorkspaceShell` and omits it from `EntryLayout` (`/app/login`, `/app/register`), matching `views/partials/chat_widget.php`.

4. **Platform Status Ledger (`src/modules/platform/health.js`)**
   - `publicSite` advances from `partial` to `ported` (**11 `ported`**, **4 `partial`**, **2 `not-ported`** across the 17-module ledger).

---

## 3. Recorded Divergences

| ID | Legacy PHP behaviour | Node.js behaviour | Reason |
|---|---|---|---|
| **CH-1** | `Api_chat::respond` stored `aegis_chat_window` in the session cookie (`$this->session->userdata('aegis_chat_window')`). | `POST /api/v1/chat/respond` uses the platform's per-client-address rate limiter (`route:/api/v1/chat/respond:<client>`, 30 requests per 60 s, returning HTTP 429 `chat rate limit exceeded; please try again shortly` with `Retry-After`). | A caller that omitted cookies bypassed the session-stored rate limit on every request. Keying by client address enforces the 30/60 s cap without requiring or mutating a session. |
| **CH-2** | `ChatAssistant::providerAnswer` passed `AI_CHAT_API_URL` directly to `file_get_contents()`. | `isSafeProviderUrl()` requires `https:` with no embedded `username` or `password`; otherwise `configured()` returns `false` and the service stays on `local-guide`. | Prevents sending `Authorization: Bearer <AI_CHAT_API_KEY>` over cleartext `http://` or opening non-HTTPS schemes if misconfigured. |
| **CH-3** | `views/partials/chat_widget.php` used `<img ... onerror="this.parentElement.classList.add('is-fallback'); this.remove();">`. | Both `renderChatWidget()` and `<ChatWidget />` render `<span class="aegis-chat-avatar is-fallback"><span class="aegis-chat-fallback" aria-hidden="true">W</span></span>` directly without an inline `onerror` attribute. | Production CSP is `script-src 'self'; style-src 'self'` with no `unsafe-inline`, and no `/assets/brand/windels-ai-avatar.svg` static file is shipped. |

---

## 4. Verification

- `npm run build:workforce-client` — client bundle built cleanly (`34 modules`).
- `npm run check:workforce` — `30/30` installation checks (`180` source files, `91` documented env vars) and `1212/1212` Node tests passing (including `test/chat.test.js` differential parity against `ChatAssistant.php`, `Api_chat.php` and `chat_widget.php`).
- `npm run typecheck && npm run test:contracts` — TypeScript and contract suites passing (`12/12`).
