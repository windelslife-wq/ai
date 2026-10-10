# Phase 0 — Legacy Route Inventory (Route Map)

**Audit date:** 2026-10-05 · **Audited commit:** `675a05c`
Source of truth: `application/config/routes.php` (285 explicit rules) + CodeIgniter 3 convention routing + controller code. This is the complete legacy route inventory the Node migration must cover. Per-route request/response shapes and the legacy→Node parity table are a Phase 1+ deliverable (`docs/migration/route-parity.md` in the target layout); this document enumerates **what exists today**.

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

### 14.4 Administration (6)

| Method/path | Permission | Legacy relationship |
|---|---|---|
| `GET /api/v1/admin/users` | `identity.users.view` | `GET /admin` / `Admin::index` listing; paginated, `search`, `status`, `sort`, `direction` |
| `POST /api/v1/admin/users` | `identity.users.manage` | `POST /admin/users/create` |
| `PATCH /api/v1/admin/users/:userId/status` | `identity.users.manage` | `POST /admin/users/:id/toggle`; refuses to suspend the caller |
| `GET /api/v1/admin/roles` | `identity.users.view` | the `tools/rbac.php` seeded matrix, read-only |
| `GET /api/v1/admin/identity/users` | `identity.users.view` | alias retained from the Phase 1 foundation slice |
| `GET /api/v1/admin/inquiries` | `system.super_admin` | new working copy of the legacy `CONTACT_INQUIRY` audit entries; super-admin only because a row holds a visitor's name and email |

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

5 + 7 + 11 + 6 + 1 + 3 + 5 = **38** routes, matching the `count` the live inventory reports.

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

### 14.8 Strategies, backtesting and the journal (11) — Phase 6

All session-only with **no permission gate**, matching the legacy `Api_controller`
surface; the four mutating routes are CSRF-gated and bearer callers are exempt.
Route count for the platform: **38 → 49**.

| Method/path | Auth | Legacy relationship |
|---|---|---|
| `GET /api/v1/strategies` | session | `GET /api/strategies`: grouped by id, `latest` plus every `versions[]` entry with `lifecycle`/`updatedAt`. `supportsShorts` comes from the executable implementation, not the record |
| `GET /api/v1/strategies/:strategyId` | session | `GET /api/strategies/(:any)`: the record plus `supportsShorts` and `nextStage`. `?version=` selects one exactly; an **empty** `?version=` means latest, as legacy did |
| `POST /api/v1/strategies/:strategyId/status` | session + CSRF | `api/strategies/(:any)/status` — **DV-4:** `POST` only, since a legacy `GET` could only ever 400 on an empty body. A refusal is **409** with `reasons` and `warnings`, and warnings now survive a *successful* transition too (**DV-3**) |
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
