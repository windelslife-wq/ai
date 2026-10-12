# Phase 0 — Legacy Route Inventory (Route Map)

**Audit date:** 2026-10-05 · **Audited commit:** `675a05c`
Source of truth: `application/config/routes.php` (285 explicit rules) + CodeIgniter 3 convention routing + controller code. This is the complete legacy route inventory the Node migration must cover. Per-route request/response shapes and the legacy→Node parity table are a Phase 1+ deliverable (`docs/migration/route-parity.md` in the target layout); this document enumerates **what exists today**.


> **Current Node route note (2026-10-11):** Sections 1–13 remain the Phase-0
> legacy inventory. Sections 14.4 and 14.7–14.12 describe the Node API through Phase 11;
> 75 API routes are implementation inventory, not a PHP-parity claim. Paper
> trading and approved proposal submission remain simulation-only and owner-scoped.
> The full supervisor and all live broker/order routes remain unavailable. See
> [`PHASE8_EXECUTION_PROPOSALS.md`](PHASE8_EXECUTION_PROPOSALS.md) for scope and
> verification limits.

---

## 1. Routing & auth model (must be replicated)

| Mechanism | Behavior |
|---|---|
| Web entry | Apache `.htaccess` rewrites all non-file requests to `index.php` (CI3 front controller). `Options -Indexes`; HTTP access to `database/`, `tools/`, `tests/`, `runtime/` is forbidden; `.env*` is denied. |
| Explicit routes | 285 rules in `routes.php` (`translate_uri_dashes = false`). |
| Convention routes | Any `public` method of a controller not matched by an explicit rule is reachable as `/controller/method/args` (e.g. `/tools/…` CLI pages, `/welcome/kill_switch`). **Inventory caveat:** the Node replacement must not blindly reproduce convention routing — each convention-reachable method must be mapped explicitly or intentionally dropped (recorded). |
| HTTP verbs | CI3 does **not** enforce verbs. Documented/observed usage: GET for reads, POST for mutations and form submits. The Node port MUST enforce verbs properly (Fastify per-method routes). |
| Page auth | `MY_Controller::requireLogin()`; `App_Controller` (workspace pages) redirects to `/login`. Public: site pages, auth pages, `/leads` marketing page, langlearn public pages. |
| API auth | `Api_controller`: 401 JSON unless session-authenticated. **Only 4 public API actions:** `api_auth/login`, `api_chat/respond`, `api_system/status`, `api_system/features`. |
| CSRF | `MY_Controller::requirePermission($perm, $csrf=true)`: every non-GET/HEAD authenticated request must send `X-CSRF-Token` matching the session token. Applies to API mutations and page form submits. |
| RBAC | Server-side permission checks per action: `trading.view/control/execute`, `sports.view/manage/approve/settle`, `lottery.view/manage`, `system.super_admin`, `system.authenticated` (lead discovery). Roles seeded by `tools/rbac.php`. |
| Sessions | CI3 `files` driver (production; `VP_SESSION_PATH` configurable) or `database` (`ci_sessions`) in dev bridge. Cookie `aegis_session` (configurable, `VP_COOKIE_SECURE=1` default). |

---

## 2. Legacy PHP routes — public site & SEO (controller `Site`, `Seo`)

> Ported: see §15 for the Node document ledger and §14.5 for the contact API.

| Route | Target | Method |
|---|---|---|
| `/` (default_controller) | site/index | GET |
| `/about` · `/services` · `/how-it-works` · `/locations` (+`/coverage`) · `/safety` · `/faq` (+`/help`) · `/contact` | site/* | GET |
| `/contact/submit` | site/contact_submit | POST |
| `/robots.txt` · `/sitemap.xml` | seo/robots · seo/sitemap | GET |

## 3. Auth & account pages (`Auth`)

| Route | Target | Method |
|---|---|---|
| `/login` · `/admin/login` | auth/index · auth/admin_login | GET |
| `/login/submit` | auth/login | POST |
| `/register` · `/register/submit` | auth/register · auth/register_submit | GET/POST |
| `/forgot-password` · `/forgot-password/submit` | auth/forgot · auth/forgot_submit | GET/POST |
| `/access-denied` | auth/denied | GET |
| `/logout` | auth/logout | POST (CSRF) |
| `/account` · `/account/username` · `/account/email` · `/account/password` | auth/account · update_username · update_email · change_password | GET/POST |
| `/account/avatar` · `/account/avatar/remove` | auth/upload_avatar · auth/remove_avatar | POST |

Login accepts **username, email, or 6-digit User ID**.

## 4. Workspace & admin pages

| Route | Target | Notes |
|---|---|---|
| `/dashboard` | workspace/index | login required |
| `/analysis` | welcome (analysis dashboard) | login required |
| `/admin` · `/admin/dashboard` | admin/index | super_admin |
| `/admin/users/create` · `/admin/users/:id/toggle` · `/admin/test-email` | admin/create_user · toggle_user · test_email | POST/GET, CSRF |
| `/notifications` · `/notifications/read-all` · `/notifications/:id/read` | notifications/* | pages |
| `/leads` · `/lead-pipeline` | leads/index · leads/pipeline | lead-discovery console pages |

## 5. Trading/operator pages

| Route | Target |
|---|---|
| `/strategy` · `/strategy/backtest` · `/strategy/optimize` · `/strategy/advance` | strategy_lab (index, run_backtest, optimize, advance) |
| `/kill-switch` · `/mode` | welcome/kill_switch · welcome/mode |
| `/execution` · `/execution/propose` · `/execution/execute` · `/execution/limits` · `/execution/:id/decide` · `/execution/:id/route` | execution/* (supervisor console) |
| `/brokers` · `/brokers/sim-toggle` | brokers/* (broker center; simulated-bridge toggle is dev-runtime-only marker) |
| `/risk` · `/risk/scan` · `/risk/limits` | risk_center/* |
| `/paper` · `/paper/create` · `/paper/:id` · `/paper/:id/order` · `/paper/:id/tick` · `/paper/:id/deploy` · `/paper/:id/positions/:pid/close` · `/paper/:id/deployments/:did/toggle` | paper/* |
| `/sports` · `/sports/tickets` · `/sports/:id/decide` · `/sports/:id/settle` | sports/* |

## 6. Language-learning pages (`Lang_learn`, ~30 routes under `/app/languages`)

`/app/languages` (console) · `/teacher` · `/login` · `/start` · `/p/:id` (profile) · `/p/:id/assessment/start` · `/p/:id/path/generate` · `/a/:id` + `/a/:id/answer` (assessment) · `/m/:mod/lesson` + `/lesson/answer` · `/c/:id` + `/c/:id/say` (conversation) · `/conv/:id` + `/conv/:id/start` · `/w/:id` + `/w/:id/submit` (writing) · `/g/:id` + `/g/:id/:rule/simple` (grammar) · `/v/:id` + `/v/:id/add` (vocabulary) · `/vr/:id/:mode` + `/submit` (SRS review) · `/l/:id` + `/l/:id/attempt` (listening) · `/s/:id` + `/s/:id/attempt` (speaking) · `/d/:id` + `/d/:id/regenerate` (daily plan) · `/h/:id` (history) · `/m/:mod/checkpoint` + `/checkpoint/answer`.

## 7. Legacy JSON API (`/api/…`) — auth: session (+CSRF on mutations) unless "public"

### 7.1 System, auth, events, notifications, brokers
| Route | Target | Notes |
|---|---|---|
| `GET /api/system/status` | api_system/status | **public** |
| `GET /api/system/features` | api_system/features | **public** — honesty matrix |
| `POST /api/auth/login` | api_auth/login | public; returns session cookie |
| `GET /api/auth/me` · `POST /api/auth/logout` | api_auth/* | |
| `POST /api/chat/respond` | api_chat/respond | public; safe fallback guidance |
| `GET /api/brokers` · `GET /api/brokers/mt5/account` · `GET /api/brokers/mt5/quote` | api_system/* | broker center data |
| `GET /api/events` · `GET /api/events/:id` | api_system/events | audit trail |
| `GET /api/notifications` · `POST /api/notifications/read-all` · `POST /api/notifications/:id/read` | api_system/* | |
| `GET/POST /api/risk/limits` · `/api/risk/limits/update` | api_system/risk_limits · update_risk_limits | trading.control |
| `POST /api/trading/kill-switch` · `POST /api/trading/mode` | api_system/* | trading.control; boot default ANALYSIS_ONLY + kill switch ACTIVE |
| `GET/POST /api/trading/limits` · `/api/trading/limits/update` | api_system/automation_limits · update | automation envelope |
| `POST /api/trading/synthetic-paper` | api_system/synthetic_paper | audited `allowSyntheticPaperData` flag |

### 7.2 Trading governance (Execution Supervisor)
| Route | Target |
|---|---|
| `POST /api/trading/propose` · `POST /api/trading/execute` | api_system/execution_propose · execution_execute |
| `POST /api/trading/:id/approve` · `POST /api/trading/:id/route` | api_system/execution_decide · execution_route |
| `GET /api/execution/preflight` · `GET /api/execution/proposals` · `GET /api/execution/executions` | api_system/* |
| `POST /api/execution/proposals/:id/decide` · `POST /api/execution/proposals/:id/route` | api_system/* |
| `GET/POST /api/portfolio/risk-scan` | api_system/portfolio_scan |

### 7.3 Market data, analysis, agents
`GET /api/market-data/candles` · `/quote` · `/providers` → api_marketdata/* · `POST /api/analysis/run` · `GET /api/analysis/history` · `GET /api/analysis/:id` · `GET /api/agents` · `GET /api/agents/consensus` → api_analysis/*.

> Ported in Phase 5: see §14.7. The legacy `/api/agents*` paths are served as `/api/v1/analysis/agents`
> and `/api/v1/analysis/consensus` (the latter as a `POST`), with no alias retained.

### 7.4 Strategies & backtesting
`GET /api/strategies` · `GET /api/strategies/:id` · `GET/POST /api/strategies/:id/status` · `POST /api/strategies/:id/optimize` · `POST /api/backtesting/run` · `GET /api/backtesting/results` · `GET /api/backtesting/results/:id` → api_strategies/*.

> **Ported (Phase 6)** — see §14.8 for the Node surface. Two notes on this legacy row:
> `GET/POST …/status` is method-agnostic only because CodeIgniter routes are; the
> handler reads a JSON body, so a `GET` always answered 400 and Node registers
> `POST` alone. The journal routes at §7.6 (`api/journal`, `api/analytics/*`) are
> ported with it, grouped under `/api/v1/journal/`.

### 7.5 Paper trading
`GET /api/accounts` · `POST /api/accounts/create` · `GET /api/accounts/:id` · `GET /api/accounts/:id/orders` · `POST /api/accounts/:id/order` · `GET /api/accounts/:id/positions` · `POST /api/accounts/:id/positions/:pid/close` · `POST /api/accounts/:id/tick` · `GET /api/accounts/:id/deployments` · `POST /api/accounts/:id/deploy` · `POST /api/accounts/:id/deployments/:did/toggle` → api_paper/*.

### 7.6 Journal & analytics
`GET /api/journal` · `POST /api/journal/manual` · `GET /api/analytics/summary` · `GET /api/analytics/confidence-calibration` → api_journal/*.

### 7.7 Sports intelligence (~35 routes → `Api_sports`)
`GET /api/sports/{status,dashboard,performance,matches,odds,predictions,providers,models,calibrations,backtests,audit,jobs,configuration,risk,correlation}` · `GET /api/sports/matches/:id` · `GET /api/sports/predictions/:id/decision` · `GET/POST /api/sports/tickets` · `GET /api/sports/tickets/:id` · `POST /api/sports/tickets/:id/{decide,settle}` · `GET /api/sports/daily-tickets` · `GET /api/sports/results` · `POST /api/sports/results/verify` · `POST /api/sports/providers/:id/toggle` · `GET /api/sports/models/performance` · `POST /api/sports/calibrations/fit` · `POST /api/sports/calibrations/:id/{approve,reject}` · `POST /api/sports/backtests/run` · `GET /api/sports/backtests/:id` · `POST /api/sports/jobs/:job/run` · `POST /api/sports/configuration/update` · `POST /api/sports/ticket-engine/run`. RBAC: sports.view / sports.manage / sports.approve / sports.settle.

### 7.8 Lottery intelligence (`Api_lottery` + `/lottery` operations console)
`GET /api/lottery/{status,lotteries,rules,draws,models,performance,tickets,providers,health,jobs,ai-decisions}` · `GET /api/lottery/draws/:id` · `GET /api/lottery/statistics/:scope` · `GET /api/lottery/ai-decisions/:id` · `POST /api/lottery/{analyze,generate,diversity,system,backtest,backtest-compare,tickets}` · `GET /api/lottery/combinations` · `GET /api/lottery/combinations/:id` · `POST /api/lottery/system-build` · `GET /api/lottery/backtests` · `GET /api/lottery/backtests/:id` · `GET /api/lottery/tickets/:id` · `POST /api/lottery/tickets/:id/check` · `POST /api/lottery/tickets/:id/delete` · `POST /api/lottery/providers/check` · `POST /api/lottery/sync`. Read APIs require `lottery.view`; provider probes, sync and system builds require `lottery.manage` + session CSRF. The desktop/mobile MVC console shows live and persisted health, source provenance, and full historical AI decision reports; operator probes and manual sync requests are actor-attributed in the audit log. Provider activation remains environment-gated and is not controlled by the console.

### 7.9 Language learning API (~35 routes under `/api/v1/language-learning` → `Api_lang_learning`)
`GET /languages` · `GET /languages/:code` · `POST /translate` · `POST /detect` · `GET/POST /profiles` · `GET /profiles/:id` · `POST /profiles/:id/assessment/start` · `GET /profiles/:id/path` · `POST /profiles/:id/path/generate` · `GET /profiles/:id/progress` · `GET /assessment/:id` · `POST /assessment/:id/answer` · `POST /modules/:mod/lesson/start` · `POST /modules/:mod/lesson/answer` · `GET /profiles/:id/conversations` · `POST /profiles/:id/conversations/start` · `POST /conversations/:id/turn` · `GET /profiles/:id/writing/tasks` · `POST /profiles/:id/writing/submit` · `GET /profiles/:id/grammar` · `GET /profiles/:id/grammar/:rule/simple` · `GET/POST /profiles/:id/vocabulary` (+`/add`, `/due`, `/review/start`, `/review/submit`, `/progress`) · `GET /profiles/:id/listening/exercises` · `POST /profiles/:id/listening/attempt` · `GET /profiles/:id/speaking/prompts` · `POST /profiles/:id/speaking/attempt` · `GET /profiles/:id/adaptive/{weaknesses,daily-plan,recommendations,mastery}` · `GET /profiles/:id/history` · `POST /modules/:mod/checkpoint/start` · `POST /modules/:mod/checkpoint/answer`. Strict per-profile ownership isolation.

### 7.10 Lead discovery (native CI3 module, ~20 routes under `/api/v1/lead-discovery` → `Api_lead_discovery`)
`GET /workspaces` · `GET /providers` · `POST /search` · `GET /leads` · `GET /leads/:id` · `PATCH-equivalent /leads/:id/status` · `/leads/:id/owner` · `GET/POST /leads/:id/notes` · `GET /leads/:id/activity` · `GET/POST /collections` · `GET /collections/:id` · `GET/POST /collections/:id/leads` · `DELETE-equivalent /collections/:id/leads/:leadId` · `GET /coverage` · `GET /duplicates` · `POST /duplicates/resolve` · `GET /history` · `GET /summary` · `GET /pipeline` · `POST /export` (+`/preview`, `/csv`). Org resolved **only** from the user's memberships (first-use auto-creates private workspace); `X-Lead-Organization` header selects among memberships; client-supplied org IDs never trusted. CSV export is formula-injection-safe (`'`-prefix on `=+-@`).

> ⚠️ Same path namespace as the Scout API (§9) — two live implementations with different auth (session+CSRF vs JWT) and storage (MySQL vs PostgreSQL). Consolidation decision required (R-02).

## 8. CLI routes (`php index.php tools …`, also HTTP-reachable via convention routing — must be blocked or re-homed in Node)

`tools install` (schema installer) · `tools bootstrap_admin` (initial admin) · `tools cron` (portfolio scan + broker transitions + proposal expiry; every-minute) · `tools sports_cron [fixtures|odds|results|quality|ticket|settlement|performance|monitoring|cleanup]` (15 min) · `tools lottery_cron [sync|health|statistics|systems|tickets|backtests|cleanup]` · `tools tests` (runs the 367-test suite).

---

## 9. Scout standalone API (`apps/api`, Fastify — prefix `/api/v1`)

| Group | Endpoints |
|---|---|
| `/auth` | `POST /login` · `POST /refresh` (rotating refresh tokens with reuse detection: revoke + `replaced_by` chain) · `POST /logout` · `GET /me` |
| `/chat` | `POST /respond` (public website assistant, grounded fallback) |
| `/admin` | `GET /overview` · `GET /users` · `POST /users` · `PATCH /users/:id` (admin-only, org-scoped) |
| `/lead-discovery` (leads.ts) | `GET /leads` · `GET /leads/:id` · `GET /coverage` |
| `/lead-discovery` (discovery.ts) | `GET /providers` · `POST /search` |
| `/lead-discovery` (pipeline.ts) | `GET /summary` · `GET /pipeline` · `PATCH /leads/:id/status` · `PATCH /leads/:id/owner` · `GET/POST /leads/:id/notes` · `GET /leads/:id/activity` · `GET/POST /collections` · `PATCH /collections/:id` · `DELETE /collections/:id` · `GET/POST /collections/:id/leads` · `DELETE /collections/:id/leads/:leadId` |
| `/lead-discovery` (intelligence.ts) | `GET /history` · `GET /duplicates` · `POST /duplicates/resolve` · `POST /export/preview` · `POST /export` · `POST /export/csv` |
| health | `GET /health` (also a DB+Redis readiness variant) |

Auth: `@fastify/jwt` bearer tokens + rotating refresh tokens (bcryptjs password hashes); CORS allow-list (`CORS_ORIGINS`), credentials enabled. Front end (`apps/web`, Next.js): server-side rewrite of `/api/*` → `LEAD_API_INTERNAL_URL` (browser code stays same-origin). Pages: `/`, `/login`, `/leads`, `/app/leads`, `/lead-pipeline`, `/app/lead-pipeline`, `/collections`, `/intelligence`, `/account`, `/admin`, `/admin/login`, `/api/v1/chat/respond` (Next route).

## 10. Football predictions API (`apps/football-predictions/server.js`, Express 5)

| Group | Endpoints |
|---|---|
| Auth | `POST /api/auth/login` · `GET /api/auth/me` · `POST /api/auth/csrf` · `POST /api/auth/logout` (cookie sessions, `fp_sessions`) |
| Public | `GET /api/fixtures` · `GET /api/odds` · `GET /api/predictions` · `GET /api/ticket/today` · `GET /api/tickets/history` · `GET /api/tickets/:id` |
| Admin (auth+CSRF) | `GET /api/admin/dashboard` · `POST /api/admin/generate-ticket` · `GET /api/admin/generation-report` · `POST /api/admin/tickets/:id/publish` · `POST /api/admin/tickets/:id/unpublish` · `GET/PUT /api/admin/settings` · `GET /api/admin/system-logs` · `GET /api/admin/api-status` · `GET /api/admin/analytics` · `GET /api/admin/predictions` · `GET /api/admin/tickets` · `GET /api/admin/tickets/:id` |
| Fallback | `404 JSON` for unknown `/api/*` |

Statics: `index.html`, `login.html`, `admin.html`, `history.html`, `ticket.html` + CSS/JS. Helmet + rate limiting; admin mutations CSRF-protected; **no cron path can generate or publish a ticket**.

## 11. MT5 bridge HTTP contract (`python-services/mt5-bridge/app.py`)

`GET /health` (reports `simulated`, `tradingEnabled`, account type) · `GET /v1/account` · `GET /v1/quotes/{symbol}` · `GET /v1/candles/{symbol}` · `GET /v1/positions` · `GET /v1/orders` · `GET /v1/history` · `POST /v1/orders` (place) · `POST /v1/orders/{ticket}/modify` · `POST /v1/orders/{ticket}/cancel` · `POST /v1/positions/{ticket}/close`. Auth: Bearer token (`MT5_BRIDGE_TOKEN`). Gates: `MT5_TRADING_ENABLED`, `MT5_ALLOW_LIVE` (demo-only default); AEGIS-side gates mirror these (`AEGIS_MT5_*`).

## 12. Static/asset routes (PHP app)

`/assets/css/*` (aegis.css, public.css, chat-widget.css) · `/assets/js/*` (app-shell.js, public.js, aegis-chat.js, speech-provider.js) · `/assets/images/*` · uploads under `/assets/uploads/` (gitignored, must be non-executable + private in Node target).

## 13. Route-parity requirements for the Node target (inputs for Phase 1)

1. **285 explicit routes + every convention-reachable controller method** must appear in the mapping table (legacy → Node → auth/RBAC/CSRF → shapes → parity test).
2. Public API surface is exactly 4 endpoints today (`api/auth/login`, `api/chat/respond`, `api/system/status`, `api/system/features`) — preserve.
3. Login identifiers: username, email, **or 6-digit User ID** — preserve.
4. Verb enforcement and CSRF must be added at the framework level (CI3 tolerated any verb).
5. `/api/v1/lead-discovery/*` collision between CI3 module and Scout must be resolved by design decision (R-02).
6. Convention-routed CLI surface (`tools/*`) must NOT remain HTTP-reachable in Node — re-home as cron-invoked scripts only.
7. Response semantics (JSON envelope, error codes 400/401/403/404, `provenance` fields) are pinned by the 367-test suite; use it as the parity oracle.

## 14. Node platform API ledger (Phases 2–5, measured 2026-10-09)

Authoritative source: **the running server**, not this table. `GET /api/v1/system/routes`
returns the 38 routes below; `app.documents()` returns the 22 document routes in §15.
`test/site.test.js` asserts the two ledgers are disjoint and that every legacy site route in
`application/config/routes.php` is answered by the Node transport.

> **Status vocabulary.** "Ported" here means implemented in Node with a named test against the
> legacy source. It does **not** mean accepted as the production replacement: PHP stays
> authoritative and deployable until an explicit cutover approval (master plan §11, Phase 6).

### 14.1 Health and platform status (5)

| Method/path | Auth | Legacy relationship |
|---|---|---|
| `GET /api/v1/health/live` | public | new operational liveness probe; no legacy equivalent |
| `GET /api/v1/health/ready` | public | new; 503 + `Retry-After` until the adapter answers and all 5 migrations are applied |
| `GET /api/v1/system/status` | public | `Api_system::status` (one of the 4 public legacy API actions); reports per-module `ported` / `partial` / `not-ported` and `trading.enabled:false` |
| `GET /api/v1/system/routes` | public | new — this ledger, machine-readable, so a route cannot be dropped quietly |
| `GET /api/v1/system/features` | public | `Api_system::features` honesty matrix |

### 14.2 Authentication (7)

| Method/path | Auth | Legacy relationship |
|---|---|---|
| `POST /api/v1/auth/login` | public, rate-limited, per-account lockout | `POST /login/submit` (`Auth::login`) and `api_auth/login`; accepts username, email **or** 6-digit UID; verifies PHP `$2y$` bcrypt |
| `POST /api/v1/auth/register` | public, 5/10 min | `POST /register/submit` (`Auth::register_submit`); signs the new account straight in |
| `POST /api/v1/auth/password-reset-request` | public, 5/10 min | `POST /forgot-password/submit` — **behaviour divergence:** no mail transport and no token store exist, so it answers `delivered:false` with an explicit "resets are issued by an administrator" notice and audits the attempt with a *hash* of the identifier. The legacy mailed a reset link |
| `GET /api/v1/auth/csrf` | session | new; the legacy derived its token from the CI3 session |
| `GET /api/v1/auth/me` | session or bearer | `api_auth/me`-equivalent session probe; returns user, permissions, `via`, and the CSRF token for cookie sessions |
| `POST /api/v1/auth/logout` | session + CSRF | `POST /logout` (`Auth::logout`); server-side revocation + expired cookie |
| `POST /api/v1/auth/device-session` | session | new — one-time bearer handshake for the native shell; states that `localStorage`/`sessionStorage`/`window.name` are never used |

### 14.3 Account self-service (11)

| Method/path | Auth | Legacy relationship |
|---|---|---|
| `GET /api/v1/account` | session | `GET /account` page data (`Auth::account`) |
| `PATCH /api/v1/account/username` | session + CSRF | `POST /account/username` |
| `PATCH /api/v1/account/email` | session + CSRF | `POST /account/email` |
| `PUT /api/v1/account/profile` | session + CSRF | display name from the legacy account page |
| `PUT /api/v1/account/password` | session + CSRF, 5/5 min | `POST /account/password`; rotates the session in the same response |
| `GET /api/v1/account/sessions` | session | new — the legacy had no session list; `current` marks the caller's token |
| `DELETE /api/v1/account/sessions` | session + CSRF | new — revoke every other session |
| `GET /api/v1/account/activity` | session | own audit trail (legacy audit views were admin-only), paginated |
| `POST /api/v1/account/avatar` | session + CSRF + multipart | `POST /account/avatar`; signature-sniffed, size/type-bounded |
| `DELETE /api/v1/account/avatar` | session + CSRF | `POST /account/avatar/remove` |
| `GET /api/v1/files/avatars/:fileId` | public bytes, owner-or-admin policy | legacy served uploads straight from `/assets/uploads/` (§12); Node keeps them outside the static root |

### 14.4 Administration (7)

| Method/path | Permission | Legacy relationship |
|---|---|---|
| `GET /api/v1/admin/users` | `identity.users.view` | `GET /admin` / `Admin::index` listing; paginated, `search`, `status`, `sort`, `direction` |
| `POST /api/v1/admin/users` | `identity.users.manage` | `POST /admin/users/create` |
| `PATCH /api/v1/admin/users/:userId/status` | `identity.users.manage` | `POST /admin/users/:id/toggle`; refuses to suspend the caller |
| `GET /api/v1/admin/roles` | `identity.users.view` | the `tools/rbac.php` seeded matrix, read-only |
| `GET /api/v1/admin/identity/users` | `identity.users.view` | alias retained from the Phase 1 foundation slice |
| `GET /api/v1/admin/inquiries` | `system.super_admin` | new working copy of the legacy `CONTACT_INQUIRY` audit entries; super-admin only because a row holds a visitor's name and email |
| `GET /api/v1/admin/audit` | `identity.users.view` | **Phase 10.** `api/events` · `api/events/(:num)` (`Api_system::events`). The whole trail: `action` (exact key or its dotted children), `entityType`/`entityId`, `actor` (`any` · `system` · a user id), inclusive `from`/`to`, `sort` (`createdAt`/`action`/`id`), `direction`, `limit` 1–200, `offset`. Every event carries a resolved `actor {userId, username, kind}`. **AV-1:** legacy needed only a signed-in user — `events()` makes no `requirePermission` call — so every operator could read every operator's trail; Node requires `identity.users.view`. **AV-2:** `from`/`to` must be canonical ISO-8601 **UTC**; a `+01:00` offset is a 400, because `created_at` is `DATETIME(3)` with no timezone and the two adapters would otherwise disagree about the same window. **AV-3:** an over-large `limit` is a 400, not a silent `min($limit, 500)` clamp. Read-only by construction — no route on either adapter can edit, redact or delete an audit event |

### 14.5 Public site (1)

| Method/path | Auth | Legacy relationship |
|---|---|---|
| `POST /api/v1/site/contact` | public, 3/hour per client address | `POST /contact/submit` (`Site::contact_submit`), JSON variant; returns a ULID receipt `reference` and `mail.sent:false`. Its read side is `GET /api/v1/admin/inquiries` in §14.4 |

### 14.6 Market data (3) — Phase 4

| Method/path | Auth | Legacy relationship |
|---|---|---|
| `GET /api/v1/market-data/candles` | session, no permission | `api/market-data/candles` (`Api_marketdata::candles`); `symbol`, `timeframe`, optional `marketClass` (inferred: `…USDT` → crypto, else forex), `limit` 30–5000 (default 200). Returns the legacy payload shape plus `provenance` (`source`, `synthetic`, `live`, `delayed`, `dataAgeMs`, `stale`, `fallbackChain`) and `validation` |
| `GET /api/v1/market-data/quote` | session, no permission | `api/market-data/quote` (`Api_marketdata::quote`) |
| `GET /api/v1/market-data/providers` | session, no permission | `api/market-data/providers` (`Api_marketdata::providers`): live provider health plus the registry (`name`, `synthetic`, `priority`, `capabilities`) and the host's synthetic policy |

None of the three is in the legacy `Api_controller::PUBLIC_ACTIONS` list, so all three require a
signed-in session; none needs a permission, because market data was readable by every legacy role.
**Divergence:** a provider failure answers `503` + `Retry-After` with error code
`MARKET_DATA_UNAVAILABLE` (or `SYNTHETIC_DATA_DISABLED` when the host refuses synthetic data) —
the platform-wide dependency-outage contract — where the legacy controller answered `502` with a
bare `{error: "<provider message>"}`. The provider's own message is preserved in
`error.details.reason`.

### 14.7 Analysis (5) — Phase 5

| Method/path | Auth | Legacy relationship |
|---|---|---|
| `POST /api/v1/analysis/run` | session + CSRF, no permission | `POST /api/analysis/run` (`api_analysis/run`): one symbol, one timeframe, one full panel run. Body `{symbol, marketClass, timeframe}`; `marketClass` is required here (the legacy inferred it) because a run's cost depends on it — forex and commodity runs also fetch 7 reference legs. Returns the legacy run payload (`bias`, `confidence`, `recommendation`, `marketRegime`, `agents[]`, `signals[]`, `scenarios`, `debate`, `tradeSetup`, `riskDecision`) plus the additive `marketClass`, `gates`, `riskContext` and the market-data `provenance`/`validation` carried forward verbatim |
| `GET /api/v1/analysis/history` | session, no permission | `GET /api/analysis/history`: summary rows newest first (`id`, `symbol`, `timeframe`, `bias`, `confidence`, `regime`, `recommendation`, `synthetic`, `source`, `completedAt`) — no payload, so the list stays cheap. `limit` 1–100, default 20 |
| `GET /api/v1/analysis/agents` | session, no permission | `GET /api/agents`: the static panel catalogue. Each entry states what it can and cannot do (`macro unavailable (no provider)`, `honestly unavailable`, `Abstains until a licensed … feed`) |
| `POST /api/v1/analysis/consensus` | session + CSRF, no permission | `GET /api/agents/consensus` — **method divergence:** the legacy answered a `GET` that nevertheless wrote one run per symbol and one audit row per run. Node makes it a `POST`, because a scan of up to 10 symbols is a mutation, not a read. Body `{timeframe?, symbols?}`; with no `symbols` the legacy 7-symbol watchlist is scanned and each class is inferred (`XAUUSD` → commodity) |
| `GET /api/v1/analysis/:runId` | session, no permission | `GET /api/analysis/:id`: the full persisted payload; `404 ANALYSIS_RUN_NOT_FOUND` when the id is well formed but unknown, `400` when it is not |

None of the five appears in the legacy `Api_controller::PUBLIC_ACTIONS` list, so all five require a
signed-in session, and none needs a permission — analysis was readable by every legacy role. The two
mutations additionally require the session CSRF token, which the legacy CI3 session did for free.
**Divergences:** an unsupported timeframe answers `400` from the contract rather than being coerced
(consensus accepts the narrower `15m/1h/4h/1d`); the legacy `/api/agents*` paths are **not** aliased —
every route lives under `/api/v1/analysis/*`; and no run can ever carry an approval, because the risk
engine is ported as a veto gate with the kill switch engaged at boot (§14.7 of
`PHASE5_ANALYSIS.md`).

**Cost controls added by the Phase 5 hardening pass (R-26 closed).** These two routes are the most
expensive authenticated surface on the platform — one run is up to 8 upstream series, one scan up to 80 —
so they carry limits the legacy routes never had:

| Control | `POST /analysis/run` | `POST /analysis/consensus` | The three GET routes |
|---|---|---|---|
| Per-route window limit (`rateLimited` in the live inventory) | **12 / 10 min** per client address | **4 / 10 min** per client address | `false` — they read the store and cost no upstream calls |
| Refusal | `429 RATE_LIMITED` + `Retry-After` | `429 RATE_LIMITED` + `Retry-After` | — |
| Per-session in-flight cap | **2** slots (`ANALYSIS_MAX_CONCURRENT_RUNS`, `0` disables) | **1** slot for the whole scan, not one per symbol | — |
| Cap refusal | `429 TOO_MANY_CONCURRENT_ANALYSES` + `Retry-After: 1` | same | — |

The window limit is charged **before** body validation, so a malformed request still costs budget and the
contract cannot be hammered for free. The cap is keyed by **session**, not address, so a shared office NAT
cannot let one colleague's scan starve another's — the reasoning that keeps login lockout per account — and
its slot is released in `finally`, so a run that throws cannot lock a session out. `RATE_LIMITED` and
`TOO_MANY_CONCURRENT_ANALYSES` are distinct codes because the client's remedy differs: slow down, versus
wait for the run you already started. These are per **process**, so N Passenger workers each get their own
(F-24). **No route was added or removed:** retention is CLI-only, and a test asserts this module registers
no `DELETE` verb at all.

At the Phase-5 cutoff, 5 + 7 + 11 + 6 + 1 + 3 + 5 = **38** API routes. Phase 6 added 11,
Phase 7 added 19 paper/risk routes and one strategy sign-off route, and Phase 8A adds
six paper-proposal routes; Phase 9 adds three notification routes, Phase 10 the audit browser and Phase 11 the
portfolio optimizer, for **80 current Node API routes**. This is an implementation inventory, not a legacy-parity claim.

**Phase 12 added none, deliberately.** The scheduled operations job (`tools cron` in
legacy) is CLI-only — see §14.13.

### 14.9 Paper trading and persisted portfolio risk controls (19) — Phase 7

Every endpoint requires an authenticated session (or explicit bearer token). Cookie
mutations require the session-bound CSRF token. Paper account IDs are never treated
as authorization: all account and child-resource reads/writes enforce owner scope
in the service and persistence layer.

| Method/path | Permission | Scope |
|---|---|---|
| `GET /api/v1/paper/accounts` | `trading.view` | List caller-owned accounts only |
| `POST /api/v1/paper/accounts` | `trading.execute` | Create an account owned by the caller |
| `GET /api/v1/paper/accounts/:accountId` | `trading.view` | Owner-only account summary |
| `GET /api/v1/paper/accounts/:accountId/orders` | `trading.view` | Owner-only order list |
| `POST /api/v1/paper/accounts/:accountId/orders` | `trading.execute` | Submit a simulated market/limit order; accepted market fills return 201, pending limits 202 and vetoed orders 409 |
| `GET /api/v1/paper/accounts/:accountId/positions` | `trading.view` | Owner-only positions |
| `POST /api/v1/paper/accounts/:accountId/positions/:positionId/close` | `trading.execute` | Owner-only manual close |
| `POST /api/v1/paper/accounts/:accountId/tick` | `trading.execute` | Evaluate limit fills, protective exits and active strategy deployments |
| `GET /api/v1/paper/accounts/:accountId/deployments` | `trading.view` | Owner-only deployment list |
| `POST /api/v1/paper/accounts/:accountId/deployments` | `trading.execute` | Deploy an eligible executable strategy to the owned paper account |
| `POST /api/v1/paper/accounts/:accountId/deployments/:deploymentId/toggle` | `trading.execute` | Pause/resume an owned deployment |
| `GET /api/v1/risk/limits` | `trading.view` | Read persisted limits |
| `PATCH /api/v1/risk/limits` | `trading.control` | Validate, persist and audit limits |
| `POST /api/v1/risk/limits/update` | `trading.control` | Legacy-style update alias to the same validator |
| `GET /api/v1/trading/mode` | `trading.view` | Read persisted trading mode and kill state |
| `POST /api/v1/trading/mode` | `trading.control` | Change mode; boot default remains `ANALYSIS_ONLY` |
| `POST /api/v1/trading/kill-switch` | `trading.control` | Change kill switch with actor/reason audit |
| `POST /api/v1/trading/synthetic-paper` | `trading.control` | Explicitly allow/deny synthetic paper input (default denied) |
| `GET /api/v1/portfolio/risk-scan` | `trading.view` | Scan the authenticated owner's paper portfolios only |

The Node risk engine retains DV-10: non-positive or non-finite equity is vetoed.
Synthetic-data provenance is retained through paper orders, positions, journal and
audit; synthetic trades do not count as live-approval evidence. All execution in
this surface is a simulation—no live broker route is present. SQL-repository tests
use recording fake pools, and migration assertions are static; neither proves that
the SQL has executed on MySQL/MariaDB.

### 14.10 Human-reviewed paper execution proposals (6) — Phase 8A

The bounded Phase-8A workflow is not a port of the full legacy supervisor. Proposal
creation, decisions and reads are scoped to the authenticated owner and that owner's
paper account. `trading.control` is required for the explicit human decision; actual
submission requires `trading.execute` and goes only through the existing Paper Trading
service, which reruns market-data, risk, account-equity and governance checks. Every
route requires authenticated credentials (cookie or bearer); cookie mutations also
require the session-bound CSRF token.

| Method/path | Permission | Scope |
|---|---|---|
| `GET /api/v1/execution/status` | `trading.view` | Reports paper-only scope, approval requirement and unavailable live/broker capabilities |
| `POST /api/v1/execution/proposals` | `trading.execute` | Normalize, preflight and persist an owner/account-scoped proposal; eligible proposals await approval |
| `GET /api/v1/execution/proposals` | `trading.view` | List only the caller's proposals; optional status/limit filters |
| `GET /api/v1/execution/proposals/:proposalId` | `trading.view` | Owner-bound detail (foreign IDs are indistinguishable from missing records) |
| `POST /api/v1/execution/proposals/:proposalId/decision` | `trading.control` | One-time approve/decline with a required reason; pending approvals expire after four hours |
| `POST /api/v1/execution/proposals/:proposalId/paper-submit` | `trading.execute` | One-time claimed submission to Paper Trading only; no generic `/route`, broker, or live-order handler exists |

Proposal and decision events are audited. Submission outcomes preserve synthetic
provenance, and use of the existing paper service ensures synthetic fills do not become
live-approval evidence. The 4-hour approval and at-most-once claim are not an automated
recovery queue: an interrupted `PAPER_SUBMITTING` attempt is not retried to avoid a
possible duplicate. The wider ordered supervisor, its automation envelope, broker/demo
gates, real MySQL/MariaDB execution and cPanel/Passenger rehearsal all remain
incomplete. See [`PHASE8_EXECUTION_PROPOSALS.md`](PHASE8_EXECUTION_PROPOSALS.md).

### 14.11 Operator notifications (3) — Phase 9

Ports `Api_system::notifications`, `notification_read` and `notification_read_all`
(`application/config/routes.php` lines 212–214). All three require the
`system.authenticated` baseline, exactly as the legacy controller did — an
operator's own unread alerts are not a privileged surface. Unsafe cookie
mutations also require the session-bound CSRF token; bearer callers are exempt.

| Method/path | Permission | Scope |
|---|---|---|
| `GET /api/v1/notifications` | `system.authenticated` | Broadcast (`user_id IS NULL`) plus the caller's own, newest first. `?unread=1` (legacy flag), `?severity=`, `?type=`, `?limit=` 1–200, default 50. `unread` always counts everything visible, independent of the page filters |
| `POST /api/v1/notifications/:notificationId/read` | `system.authenticated` + CSRF | Idempotent. A missing, already-read or **foreign** id all answer `404 notification not found or already read`, so the route cannot be used to discover which ids exist |
| `POST /api/v1/notifications/read-all` | `system.authenticated` + CSRF | Marks the caller's visible unread rows read and reports `markedRead` |

**There is deliberately no publish route.** No create, broadcast or delete
endpoint exists, so no HTTP caller can inject an alert that appears to come from
the risk engine or the execution supervisor. Publishing is internal to the
platform: `paper.setKillSwitch()`, `paper.setTradingMode()` and the execution
proposal lifecycle publish through the service, always *after* their audit row has
committed, and a failed alert never fails the governance action that caused it.

The legacy server-rendered console (`/notifications`,
`views/notifications/index.php`) is **not** ported; it belongs to the app-shell
workstream (F-29 still stands — no ported module has a workspace console).
See [`PHASE9_NOTIFICATIONS.md`](PHASE9_NOTIFICATIONS.md).

## 15. Node rendered document routes (22)

Documents are rendered per request by `src/modules/site/`; **no static copy of any of them is
committed** (`verify:install` fails the build if `public/index.html`, `robots.txt`,
`sitemap.xml`, `manifest.webmanifest` or `service-worker.js` reappear).

| Kind | Paths | Legacy relationship |
|---|---|---|
| Pages (8) | `/` · `/about` · `/services` · `/how-it-works` · `/locations` · `/safety` · `/faq` · `/contact` | `Site::index/about/services/how_it_works/locations/safety/faq/contact`; copy ported heading-for-heading from `views/site/*.php` |
| Permanent aliases (3) | `/coverage` → `/locations` · `/help` → `/faq` · `/how` → `/how-it-works` (301) | legacy aliases in `config/routes.php` |
| Auth/workspace redirects (6) | `/login` → `/app/login` · `/admin/login` → `/app/login` · `/register` → `/app/register` (302) · `/forgot-password` → `/app/login` · `/access-denied` → `/app/` · `/dashboard` → `/app/` | legacy `Auth`/`Workspace` pages, now served by the SPA. `/forgot-password` is a **divergence**: reset delivery is not ported |
| Generated documents (4) | `/robots.txt` · `/sitemap.xml` · `/manifest.webmanifest` · `/service-worker.js` | `Seo::robots` (all six legacy disallow rules kept, three Node-only private prefixes added) and `Seo::sitemap` (8 paths — `/login` and `/register` are omitted because they redirect into the disallowed `/app/`). Manifest and worker are new |
| Form target (1) | `POST /contact/submit` → 303 `/contact` with a signed one-shot `wf_flash` | `Site::contact_submit` incl. its flashdata flow; `GET /contact/submit` answers 405 `Allow: POST`, as the legacy route was POST-only |

Verb and fallback rules pinned by tests: documents answer `GET`/`HEAD`; a declared POST
document route answers its own verb; an **unknown** path with a non-GET method answers **404**;
a real static file with a non-GET method answers **405** + `Allow: GET, HEAD`. Any `/app/*` GET
carrying `Accept: text/html` receives the built SPA shell (200); without that header it stays
**404**, so a missing asset is never masked by HTML.

### 14.12 Research-only portfolio optimization (1) — Phase 11

Ports `POST /api/portfolio/optimize` (`Api_portfolio::optimize` →
`Aegis\Platform::optimizePortfolio()`). Session-only like its legacy
`Api_controller` surface, and gated on `trading.view` exactly as legacy was — a
permission every member role already holds, so this is a "signed-in operator" gate
rather than an administrative one. The unsafe cookie mutation is CSRF-gated; bearer
callers are exempt.

| Method/path | Permission | Legacy relationship |
|---|---|---|
| `POST /api/v1/portfolio/optimize` | `trading.view` + CSRF | `POST /api/portfolio/optimize`. Body: `assets` (2–12 `{symbol, marketClass}`), `timeframe` (`15m`/`1h`/`4h`/`1d`), `limit` 31–2000 default 500, `objective` (`max_sharpe` default / `min_variance`), `maxWeight`, `riskFreeRate`, `shrinkage`, `periodsPerYear`, `allowSyntheticData`. Response keeps the legacy envelope — the report is under `optimization`. **PO-5:** no alias for the unversioned legacy path. **PO-6:** the `/portfolio/` prefix is shared with the paper module's pre-existing `GET /api/v1/portfolio/risk-scan` (§14.9) — two different concerns, not re-homed because that would break a shipped path |

**It cannot reach an order path**, structurally rather than by comment: the service is
built with `{store, marketData, log}` and is never given the paper, strategy or
execution services. `additionalProperties: false` makes `execute`, `amount`,
`orderId`, `accountId` and `notional` a **400** at both the top level and inside an
asset. There is no `GET` counterpart — a run is computed and returned, never
persisted, so there is no history to read back.

Error mapping refines the legacy controller's three catches (**PO-2**): input-shape
failures answer **400 `INVALID_REQUEST`** (schema) or **400
`INVALID_PORTFOLIO_REQUEST`** (solver-level input guards such as a `maxWeight` too
small to be fully invested for the asset count); estimation and data conditions
answer **422 `PORTFOLIO_OPTIMIZATION_UNAVAILABLE`** (mixed synthetic/live, or
all-synthetic without the opt-in); provider failures answer **503** through the
shared `marketDataFailure` mapping, so an outage reads identically here and on
`/market-data/candles`, and a host with `MARKET_DATA_ALLOW_SYNTHETIC=0` answers
**503 `SYNTHETIC_DATA_DISABLED`** with a positive `Retry-After`; a missing provider
chain answers **503 `PORTFOLIO_DATA_UNAVAILABLE`** rather than fabricating prices.

Cost control (risk R-26), applied at birth: its own window limit
(`RATE_LIMIT_PORTFOLIO_OPTIMIZE_MAX`, default 6 per 10 min) **charged before
validation**, so a malformed request still counts against the budget, plus a
per-session in-flight cap (`PORTFOLIO_MAX_CONCURRENT_RUNS`, default **1**, keyed by
session so a shared office NAT cannot let one colleague starve another's) answered as
**429 `TOO_MANY_CONCURRENT_OPTIMIZATIONS`**. Assets are fetched sequentially, so one
request cannot open twelve concurrent provider connections. The slot is released in
`finally`, so a refused run cannot lock a session out until the process restarts.

Runs are audited as `portfolio.optimization.run` (entity type `portfolio`, legacy
action preserved in `details.legacyAction`), so they are visible through the Phase 10
audit browser at `?action=portfolio`. A **refused** run records nothing: nothing was
computed, so nothing is recorded as computed.

### 14.13 Scheduled operations (0) — Phase 12

| Method & path | Auth | Permission | Rate limit | Validated | Notes |
|---|---|---|---|---|---|
| *— none —* | | | | | |

Recorded as an empty section on purpose, because "why is there no route for the cron
job" is the first question a reader of this map will ask.

Legacy exposed it as `tools/cron`, a public controller method whose only protection was
that nobody knew the URL. The Node port is `tools/scheduled-jobs.mjs` (`npm run jobs`,
`npm run jobs:apply`), invoked by the host's cron, and `runOperations` **takes no owner
argument**: it scans every paper account on the platform and expires every operator's
stale proposals. Exposing that over HTTP would turn any reachable caller — or any session
that slipped past a permission check — into a platform-wide actor, which is the same
mistake AV-1 avoided by requiring `identity.users.view` for the audit trail.

`test/scheduled_jobs.test.js` asserts no route in the whole inventory matches
`job|cron|schedul|sweep|stale|lock`, so a future phase cannot add one without a test
failing and someone writing down why. The lock table it coordinates through
(`wf_job_locks`) is likewise unreachable: there is no route that reads, takes or clears a
lock, because a client that could clear one could wedge or unwedge the schedule.

See [`PHASE12_SCHEDULED_JOBS.md`](PHASE12_SCHEDULED_JOBS.md), divergence SJ-10.

### 14.14 Broker Center (1) — Phase 14

Ports `GET /api/brokers` (`Api_system::brokers`). **One route, and it is a read.**

| Method & path | Auth | Permission | Rate limit | Validated | Notes |
|---|---|---|---|---|---|
| `GET /api/v1/brokers` | session or bearer | `trading.view` | global | — | `GET /api/brokers`. Returns `{brokers, planned, routable, notice}`: every registered connector's state (`DISABLED` · `NOT_CONFIGURED` · `DOWN` · `READY` · `ERROR`) with its capabilities, the nine `PLANNED` adapters in legacy's own wording, and the one boolean that matters — whether any connector may actually route an order. **F-32:** legacy's `brokers()` made no `requirePermission` call, so any signed-in user could read connector health, and its siblings `mt5_account()` / `mt5_quote()` returned the broker login, currency, balance and equity to the same audience; Node requires `trading.view`. **BC-10:** `planned` and `routable` lived only in the legacy console view (`Brokers::index`), and no ported module has a console screen (F-29), so they move into the response rather than being lost |

**No broker write route exists, and `test/brokers_http.test.js` asserts that from the
route inventory rather than from a comment.** There is no order, modify, cancel or
close endpoint; there is no connector-enable endpoint; and there is no equivalent of
legacy's `Brokers::sim_toggle()`, which wrote a marker file that its dev front
controller translated into `AEGIS_MT5_*` environment variables. Porting a toggle for a
simulated bridge this platform does not have would advertise a capability that does not
exist. Every order-shaped route in the inventory belongs to `/api/v1/paper` and reaches
the simulation engine, never a connector.

Order routing stays where legacy put it — exclusively in the execution supervisor — and
stays unavailable: `BrokerManager::tradingConnector()` returns `null` unless a connector
is order-capable **and** its own freshly probed status reports `READY` with
`orderSubmissionEffective === true`, which requires the local trading flag, a bridge that
also reports `tradingEnabled`, and a demo account unless live trading was separately and
explicitly allowed.

The public `/api/v1/system/status` surface reports `brokerConnectorAvailable: false` and
a config-only `brokerConnectorsConfigured` count **without probing anything** (BC-11):
that endpoint is unauthenticated, and the invariant it keeps is that an anonymous caller
cannot make this server reach an outbound host. The probed answer is `routable` here.

Legacy's `GET /api/brokers/mt5/account` and `/api/brokers/mt5/quote` are **not ported**.
Both read a live bridge, and there is no verified adapter to read; a route that can only
answer 503 is a worse surface than no route, and the connector methods behind them exist
and are tested against an injected transport.

### 14.15 Sports Intelligence (1) — Phase 15

> **Superseded by §14.16 for everything except the status route's own semantics.**
> Slice 1 had one route because migration 011 did not exist; the absence list below is
> now historical, and six of its entries (`matches`, `providers`, `sync`) are routes that
> exist as of Phase 16. Kept in full because it records *why* those routes were absent
> rather than approximated — the reasoning, not the count, is what still applies to the
> endpoints that remain absent.

Slice 1 of row 14: the data foundation and provider boundary. **One route, and it is a
read.**

| Method & path | Auth | Permission | Rate limit | Validated | Notes |
|---|---|---|---|---|---|
| `GET /api/v1/sports/status` | session or bearer | `sports.view` | global | `querySchema` | Provider configuration, derived health, the ten-entry `notPorted` matrix and a `notice`. Probe-free unless `?probe=1`; a probed response is stamped `persisted: false` |

**Legacy has ~24 `Api_sports` endpoints and none of the others is ported** — not
approximated, absent. Every one reads or writes the eleven tables this slice does not
create, and `test/sports_http.test.js` asserts each absence against the route inventory
rather than against a count, because a count would also pass if a route were renamed:
`matches`, `odds`, `predictions`, `tickets`, `daily`, `results`, `providers`, `models`,
`calibration`, `backtest`, `configuration`, `sync`, `settle`, `verify`. No sports route
of any method other than `GET` exists.

**`?probe` is a coerced boolean** (`{type: "boolean", default: false}`), matching
`PROVIDERS_QUERY.refresh` in the market-data module. Declaring it is not decoration:
`validateRequest` **rebuilds `request.query` from the schema**, so an undeclared
parameter is dropped rather than passed through — the first version of this route had no
schema and `?probe=1` silently never reached the handler (**D-24**). An unparseable value
is a `400 INVALID_REQUEST` naming the field, not a silent "off" (**AV-3**'s reasoning),
while `?probe=` with an empty value counts as absent and takes the default.

**Authorization is not a divergence here.** `Api_sports` is the best-gated controller in
the legacy application — `sports.view` for every read, `sports.manage` for writes, and
separate `sports.approve` and `sports.settle`. The gate is reproduced because legacy had
it, which is the counter-example that makes **F-32** precise: the same codebase gated one
module's reads correctly and left another's open. Node's permission baseline already
declared all four permissions and the `sports_admin`/`sports_viewer` roles, so no catalog
change was needed; only `sports.view` is enforced yet, because only one route exists.

`GET /api/v1/system/status` additionally carries a synchronous, probe-free
`sports` snapshot (`enabled`, `mode`, `isDemoData`, `providersConfigured`, `providerIds`,
`simulatedProviders`, `persistence`, `ticketEngine: "NOT_PORTED"`, `reason`). It reports
**no derived health**, because a field that could only ever hold `UNKNOWN` invites a reader
to think it was measured — and **F-35** later supplied the evidence for why it could only
ever hold `UNKNOWN`: legacy never computed one either. `persistence` was hard-coded `false`
in slice 1 and is `store !== null` from Phase 16; the snapshot stays synchronous and
I/O-free either way, so it reports whether a repository *exists*, never what it contains.
See [`PHASE15_SPORTS_FOUNDATION.md`](PHASE15_SPORTS_FOUNDATION.md).

### 14.16 Sports Intelligence — stored reads and ingestion (7) — Phase 16

Slice 2 of row 14. Migration 011 created seven tables, so the routes that read and fill
them now exist. **Six are new; the status route is unchanged in path and gating but is now
store-backed.**

| Method & path | Auth | Permission | Rate limit | Validated | Notes |
|---|---|---|---|---|---|
| `GET /api/v1/sports/status` | session or bearer | `sports.view` | global | `querySchema` | Unchanged from §14.15, except that `providers[].derivedStatus` is now **measured** from stored health rows and sync runs rather than hard-coded `UNKNOWN`, and each entry also reports `registered`, `enabled`, `observations` and `syncRuns` |
| `GET /api/v1/sports/providers` | session or bearer | `sports.view` | global | `querySchema` | The **stored** registry (`wf_sports_data_sources`), `?enabledOnly=` a coerced boolean. Distinct from `status().providers`, which lists what *this process* registered from the environment — the two disagreeing is information |
| `GET /api/v1/sports/providers/:providerCode/health` | session or bearer | `sports.view` | global | `paramsSchema` + `querySchema` | One provider's observation **series**, newest first, bounded to 200. A series rather than a current value, because an outage is visible as a gap and invisible in an overwritten row. Unknown code → `404` |
| `GET /api/v1/sports/matches` | session or bearer | `sports.view` | global | `querySchema` | Stored fixtures, oldest kickoff first. Filters: `status` (enum), `from`/`to` (inclusive instants), `competition` (**prefix**), `providerId`, `limit` ≤ 200 |
| `GET /api/v1/sports/matches/:matchId` | session or bearer | `sports.view` | global | `paramsSchema` + `querySchema` | One fixture with its **odds series**, latest quality assessment and result, plus an explicit `verified` flag. Assembled in one response because read separately the four rows can be combined into a picture that never existed. Unknown id → `404` |
| `GET /api/v1/sports/sync-runs` | session or bearer | `sports.view` | global | `querySchema` | Sync-run evidence, newest first, with `errors` returned **whole** and an `unfinished` count. **The read legacy never had** — see F-35 |
| `POST /api/v1/sports/sync` | session or bearer + CSRF | **`sports.manage`** | global | `bodySchema` | Runs one ingestion job. Body: `jobType` (`FIXTURES`\|`ODDS`\|`RESULTS`), `providerId` (the registered id, not the row id), `executionKey`, and `fixtureExternalId`/`query` as the job needs |

**`POST /sports/sync` is the module's only write, and it writes only to the seven
`wf_sports_*` tables.** It cannot place an order, move a stake, verify a result or enable a
connector. `sports.manage` is enforced here for the first time — the permission and both
sports roles already existed in `src/db/platform-baseline.js`, declared in anticipation, so
this is the first caller rather than a new grant. `test/sports_http.test.js` proves a
`sports.view`-only member gets `403` and that a refused sync opens no run row.

**Idempotency is the property a caller can rely on.** `executionKey` is required *from the
caller* rather than generated server-side, because a key the server invented would differ on
every retry and would guarantee nothing. A reused key returns `200` with
`status: "DUPLICATE_SKIPPED"`, **no `runId`** (no run was opened, so returning an id would
imply a row that does not exist) and **no audit event** (the original run already has one, and
a second would double-count every retry in a filter built on these actions). The `UNIQUE`
constraint is the arbiter, not a preceding check — divergence **SP-12**.

**A malformed filter is a `400 INVALID_SPORTS_QUERY`, never a `500` and never a silently
empty result.** The repository's validators throw `TypeError`, which the route translates;
without that, `?from=12345` would report an internal error and invite a retry of a request
that can never succeed. This is defect **D-12**'s exact shape — `new Date("12345")` is the
year 12345, and an empty window looks like a working filter. An offset input
(`?from=2026-03-07T01:00:00+01:00`) is *normalized* rather than refused (**SP-26**), because
the columns hold one canonical width and comparing an offset string as text would be the
actual bug.

**Still absent, asserted by name against the route inventory** rather than by count: no
`prediction`, `ticket`, `settle`, `verify`, `calibrat`, `backtest`, `model`, `daily`,
`value`, `stake`, `order` or `broker` route under `/sports`. `odds` and `results` are absent
as standalone paths too, because both are served inside a fixture's detail response rather
than detached from the fixture they describe — a `/sports/odds` route would invite a caller
to read a price series with no fixture attached to it.

**A probe is still never persisted** (`persisted: false` on `?probe=1`), even on a host with
a repository. Making that conditional on `store` was the first thing slice 2 tried and it was
**D-27**: it reported `persisted: true` for a reading written nowhere, which is a false claim
about provenance on the one field whose job is to make that claim. Only ingestion appends
health rows, which also keeps a dashboard load from mutating the history the monitor derives
from. See [`PHASE16_SPORTS_PERSISTENCE.md`](PHASE16_SPORTS_PERSISTENCE.md).

### 14.8 Strategies, backtesting and the journal (11) — Phase 6

The Phase-6 routes are session-only with no permission gate, matching their legacy
`Api_controller` surface; unsafe cookie mutations are CSRF-gated and bearer callers
are exempt. Phase 7 adds the separately permissioned human sign-off route (shown
below). Route count: **38 at Phase 5 → 49 at Phase 6 → 69 after Phase 7 → 75 after Phase 8A → 78 after Phase 9 → 79 after Phase 10 → 80 after Phase 11 → 80 after Phase 12 (no route added)**.

| Method/path | Auth | Legacy relationship |
|---|---|---|
| `GET /api/v1/strategies` | session | `GET /api/strategies`: grouped by id, `latest` plus every `versions[]` entry with `lifecycle`/`updatedAt`. `supportsShorts` comes from the executable implementation, not the record |
| `GET /api/v1/strategies/:strategyId` | session | `GET /api/strategies/(:any)`: the record plus `supportsShorts` and `nextStage`. `?version=` selects one exactly; an **empty** `?version=` means latest, as legacy did |
| `POST /api/v1/strategies/:strategyId/status` | session + CSRF | `api/strategies/(:any)/status` — **DV-4:** `POST` only, since a legacy `GET` could only ever 400 on an empty body. A refusal is **409** with `reasons` and `warnings`, and warnings now survive a *successful* transition too (**DV-3**) |
| `POST /api/v1/strategies/:strategyId/sign-off` | session + `trading.control` + CSRF | Phase 7 addition: persists one-time attributed human risk review for an AI version; does not change `source: "ai"` or advance lifecycle by itself |
| `POST /api/v1/strategies/:strategyId/optimize` | session + CSRF, own window limit (2/10 min) + concurrency slot | `api/strategies/(:any)/optimize` — **DV-6:** id from the path only. Returns the walk-forward report; `register: true` adopts a winner as a new `source: "ai"` version at `DRAFT` |
| `POST /api/v1/backtesting/run` | session + CSRF, own window limit (12/10 min) + concurrency slot | `POST /api/backtesting/run`. Resolves the record (404) before the implementation (400), so an omitted version means latest |
| `GET /api/v1/backtesting/results` | session | `GET /api/backtesting/results` — **DV-11:** summaries carrying promoted `metrics`/`warnings`/`candles` columns rather than decoded payloads. Same response shape |
| `GET /api/v1/backtesting/results/:backtestId` | session | `GET /api/backtesting/results/(:any)`: the only route that reads a `payload` |
| `GET /api/v1/journal` | session | `GET /api/journal`, filters `source`/`strategy`/`symbol` (upper-cased server-side) |
| `POST /api/v1/journal/manual` | session + CSRF | `POST /api/journal/manual`, **201**. Derives `pnl`/`pnl_pct`/`r_multiple` rather than trusting them; **DV-9/DV-10** reject an overlong rationale and an out-of-range confidence |
| `GET /api/v1/journal/analytics/summary` | session | `GET /api/analytics/summary` — **DV-8:** regrouped under `/journal/` so it does not sit two letters from `/api/v1/analysis/*` |
| `GET /api/v1/journal/analytics/calibration` | session | `GET /api/analytics/confidence-calibration` — **DV-8.** Reads 2 000 rows, the legacy bound |

**Not ported:** the four legacy document routes `/strategy`, `/strategy/backtest`,
`/strategy/optimize`, `/strategy/advance` and `views/strategy/index.php`. Recorded
as **F-29** — no ported module (market data, analysis or strategies) has a
workspace console.

Workspace SPA surfaces declared by the client router: `/app/`, `/app/login`, `/app/register`,
`/app/account`, `/app/status`, `/app/admin/users` (`identity.users.view`),
`/app/admin/inquiries` (`system.super_admin`). Undeclared `/app/*` paths render an explicit
"nothing is served here" view rather than a blank screen.
