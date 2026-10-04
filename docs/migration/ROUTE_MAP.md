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

### 7.4 Strategies & backtesting
`GET /api/strategies` · `GET /api/strategies/:id` · `GET/POST /api/strategies/:id/status` · `POST /api/strategies/:id/optimize` · `POST /api/backtesting/run` · `GET /api/backtesting/results` · `GET /api/backtesting/results/:id` → api_strategies/*.

### 7.5 Paper trading
`GET /api/accounts` · `POST /api/accounts/create` · `GET /api/accounts/:id` · `GET /api/accounts/:id/orders` · `POST /api/accounts/:id/order` · `GET /api/accounts/:id/positions` · `POST /api/accounts/:id/positions/:pid/close` · `POST /api/accounts/:id/tick` · `GET /api/accounts/:id/deployments` · `POST /api/accounts/:id/deploy` · `POST /api/accounts/:id/deployments/:did/toggle` → api_paper/*.

### 7.6 Journal & analytics
`GET /api/journal` · `POST /api/journal/manual` · `GET /api/analytics/summary` · `GET /api/analytics/confidence-calibration` → api_journal/*.

### 7.7 Sports intelligence (~35 routes → `Api_sports`)
`GET /api/sports/{status,dashboard,performance,matches,odds,predictions,providers,models,calibrations,backtests,audit,jobs,configuration,risk,correlation}` · `GET /api/sports/matches/:id` · `GET /api/sports/predictions/:id/decision` · `GET/POST /api/sports/tickets` · `GET /api/sports/tickets/:id` · `POST /api/sports/tickets/:id/{decide,settle}` · `GET /api/sports/daily-tickets` · `GET /api/sports/results` · `POST /api/sports/results/verify` · `POST /api/sports/providers/:id/toggle` · `GET /api/sports/models/performance` · `POST /api/sports/calibrations/fit` · `POST /api/sports/calibrations/:id/{approve,reject}` · `POST /api/sports/backtests/run` · `GET /api/sports/backtests/:id` · `POST /api/sports/jobs/:job/run` · `POST /api/sports/configuration/update` · `POST /api/sports/ticket-engine/run`. RBAC: sports.view / sports.manage / sports.approve / sports.settle.

### 7.8 Lottery intelligence (~30 routes → `Api_lottery`)
`GET /api/lottery/{status,lotteries,rules,draws,models,performance,tickets,providers,health,jobs}` · `GET /api/lottery/draws/:id` · `GET /api/lottery/statistics/:scope` · `POST /api/lottery/{analyze,generate,diversity,system,backtest,backtest-compare}` · `GET /api/lottery/combinations` · `GET /api/lottery/combinations/:id` · `POST /api/lottery/system-build` · `GET /api/lottery/backtests` · `GET /api/lottery/backtests/:id` · `GET /api/lottery/tickets/:id` · `POST /api/lottery/tickets/:id/check` · `POST /api/lottery/tickets/:id/delete` · `POST /api/lottery/sync`. RBAC: lottery.view / lottery.manage (+CSRF on mutations). Status endpoint public pattern per README.

### 7.9 Language learning API (~35 routes under `/api/v1/language-learning` → `Api_lang_learning`)
`GET /languages` · `GET /languages/:code` · `POST /translate` · `POST /detect` · `GET/POST /profiles` · `GET /profiles/:id` · `POST /profiles/:id/assessment/start` · `GET /profiles/:id/path` · `POST /profiles/:id/path/generate` · `GET /profiles/:id/progress` · `GET /assessment/:id` · `POST /assessment/:id/answer` · `POST /modules/:mod/lesson/start` · `POST /modules/:mod/lesson/answer` · `GET /profiles/:id/conversations` · `POST /profiles/:id/conversations/start` · `POST /conversations/:id/turn` · `GET /profiles/:id/writing/tasks` · `POST /profiles/:id/writing/submit` · `GET /profiles/:id/grammar` · `GET /profiles/:id/grammar/:rule/simple` · `GET/POST /profiles/:id/vocabulary` (+`/add`, `/due`, `/review/start`, `/review/submit`, `/progress`) · `GET /profiles/:id/listening/exercises` · `POST /profiles/:id/listening/attempt` · `GET /profiles/:id/speaking/prompts` · `POST /profiles/:id/speaking/attempt` · `GET /profiles/:id/adaptive/{weaknesses,daily-plan,recommendations,mastery}` · `GET /profiles/:id/history` · `POST /modules/:mod/checkpoint/start` · `POST /modules/:mod/checkpoint/answer`. Strict per-profile ownership isolation.

### 7.10 Lead discovery (native CI3 module, ~20 routes under `/api/v1/lead-discovery` → `Api_lead_discovery`)
`GET /workspaces` · `GET /providers` · `POST /search` · `GET /leads` · `GET /leads/:id` · `PATCH-equivalent /leads/:id/status` · `/leads/:id/owner` · `GET/POST /leads/:id/notes` · `GET /leads/:id/activity` · `GET/POST /collections` · `GET /collections/:id` · `GET/POST /collections/:id/leads` · `DELETE-equivalent /collections/:id/leads/:leadId` · `GET /coverage` · `GET /duplicates` · `POST /duplicates/resolve` · `GET /history` · `GET /summary` · `GET /pipeline` · `POST /export` (+`/preview`, `/csv`). Org resolved **only** from the user's memberships (first-use auto-creates private workspace); `X-Lead-Organization` header selects among memberships; client-supplied org IDs never trusted. CSV export is formula-injection-safe (`'`-prefix on `=+-@`).

> ⚠️ Same path namespace as the Scout API (§9) — two live implementations with different auth (session+CSRF vs JWT) and storage (MySQL vs PostgreSQL). Consolidation decision required (R-02).

## 8. CLI routes (`php index.php tools …`, also HTTP-reachable via convention routing — must be blocked or re-homed in Node)

`tools install` (schema installer) · `tools bootstrap_admin` (initial admin) · `tools cron` (portfolio scan + broker transitions + proposal expiry; every-minute) · `tools sports_cron [fixtures|odds|results|quality|ticket|settlement|performance|monitoring|cleanup]` (15 min) · `tools lottery_cron [sync|health|statistics|systems|tickets|backtests|cleanup]` · `tools tests` (runs the 357-test suite).

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
7. Response semantics (JSON envelope, error codes 400/401/403/404, `provenance` fields) are pinned by the 357-test suite; use it as the parity oracle.
