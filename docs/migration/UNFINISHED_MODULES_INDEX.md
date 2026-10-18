# Unfinished modules — name index

**Compiled:** 2026-10-17 (updated after Phase 48) · **Source of truth:** the in-code ledger in
`apps/workforce-platform/src/modules/platform/health.js` (served by `/api/v1/system/features`
and `/api/v1/system/status`), cross-checked against `docs/migration/UNFINISHED_MODULES.md`
and `docs/migration/STATUS.md`.

"Unfinished" = **not implemented and parity-accepted in the Node.js target**. Several of these
already exist and pass tests in the PHP application; they are still unfinished as Node ports.

---

## A. Platform status ledger — 17 modules, 2 unfinished (15 ported / 2 partial / 0 not-ported)

### Partial (code exists, work remains) — 2

| # | Module key | Name | What is still missing |
|---:|---|---|---|
| 1 | `execution` | **Execution Supervisor and trading governance** | Console landed (Phase 39, `/app/execution`); no live route and no automated mode; remaining supervisor steps are broker-bound (row 13). Whole live path is paper-only. |
| 2 | `brokers` | **Broker Center and broker connectors** | Console landed (Phase 40, `/app/brokers`); ten adapters registered but all disabled by default, no order routing, no simulated bridge, no MT5 account/quote read, no adapter verified against its provider (MT5 real-terminal validation outstanding). |

### Not ported (Node equivalent absent) — 0

All 17 modules in `MODULE_STATUS` now have a Node port (`15 ported / 2 partial / 0 not-ported`).

Ported (for contrast): `identity`, `publicSite` (Phase 43 ported the grounded public chat
assistant `POST /api/v1/chat/respond` and the floating widget on both the public pages and the
signed-in workspace shell, advancing `publicSite` from `partial` to `ported`), `audit`,
`notifications`, `marketData`, `analysis`, `portfolioOptimizer`, `strategies` (its console landed
in Phase 31, closing the module's last recorded entry), `paperTrading`, `risk`, `scheduledJobs`
(Phase 44 ported the 80/70/60 % early-warning tiers, gross notional leverage check and static
disclosed correlation-group enforcement, closing SJ-8, SJ-9 and F-30 and advancing `scheduledJobs`
from `partial` to `ported`), `sports` (**Phase 48 ported bounded record-only stake sizing — DV-27,
`staking_method` on the versioned configuration via migration `022_sports_stake_sizing.sql`, `FLAT`
the default and byte-identical to legacy's fixed stake, `CONFIDENCE_SCALED` sizing only down from
it, nothing executed — emptying its not-ported matrix and advancing from `partial` to `ported`;
its ledger label keeps the module's boundaries as prose: nothing executed, attestation before any
stored result is trusted, no verified vendor**), `leadDiscovery` (Phase 45 ported the
organization-scoped Lead Discovery module, migration `020_lead_discovery.sql`, 22 repository
methods, `GooglePlacesProvider`, `Deduplicator`, 23 `/api/v1/lead-discovery/*` routes, and the
console at `/app/leads` and `/app/leads/pipeline`, advancing `leadDiscovery` from `not-ported` to
`ported`), `languageLearning` (Phase 46 ported the 5-phase AI Language Learning & AI Teacher
module, migration `021_language_learning.sql`, 40 repository methods, 20 authored languages,
placement staircase, curriculum path, AI teacher, vocabulary SRS, listening & speaking practice,
adaptive engine, translator, and the console at `/app/languages` and `/app/languages/teacher`,
advancing `languageLearning` from `not-ported` to `ported`), and — since Phase
30, when its last unported entry (the console screens) became a ported surface and its own
`notPorted` matrix went empty — `lottery`.

---

## B. Backlog rows that are not finished (from `UNFINISHED_MODULES.md`, 23 rows)

| Row | Module / workstream | Status |
|---:|---|---|
| 1 | Identity, authentication and legacy account import | Code present; no real-DB import rehearsal, no approval to import |
| 2 | Account management, registration, **password reset** and admin users | **Ported** (Phase 2 + Phase 3 + Phase 42 + Phase 47): single-use 15-minute HMAC password reset tokens wired to outbound SMTP (`POST /api/v1/auth/password-reset-request` + `POST /api/v1/auth/password-reset-confirm`) and the `/app/login` reset UI (`PHASE47_PASSWORD_RESET_AND_ADMIN_SYNC.md`) |
| 3 | **Shared app shell, dashboards, settings and navigation** | **No screen left.** The sports dashboard landed in Phase 36 (`/app/sports`), closing the last one this row named — the settings gap closed with the account screen's avatar control (Phase 34) and the administrator control centre (`/app/admin`, Phase 35); the portfolio-optimizer (Phase 29), lottery (Phase 30), Strategy Lab (Phase 31), AI Workforce (`/app/analysis`, Phase 32), workspace dashboard (`/app`, Phase 33), account avatar (Phase 34), admin control centre (Phase 35), sports console (Phase 36), paper console (Phase 37), risk console (Phase 38) and execution console (Phase 39) screens landed |
| 4 | Public website, help/contact and SEO | **Ported** (Phase 3 + Phase 42 + Phase 43): public pages, SEO/PWA shell, contact intake with optional SMTP copy (Phase 42), and the grounded public chat assistant (`POST /api/v1/chat/respond` + floating widget on public pages and the workspace shell, Phase 43). `publicSite` moved from `partial` to `ported`. |
| 5 | Notifications, audit browser, feature/status reporting | Retention policy (`npm run prune:retention`) and SMTP (`Aegis\\Mailer`) landed in Phase 42; **notification outbound delivery landed in Phase 49 (DV-28)** — an opt-in, severity-gated, dedupe-suppressed, audited-masked email copy per stored alert (`VP_NOTIFY_EMAIL_*`, fail-fast at boot, AND-gated `emailDeliveryAvailable`). Settings/preferences screens (`views/settings`) remain absent; live-relay send verification is a host task (inbox + audit consoles exist) |
| 6 | Market data and provider health | F-24 shared health store, F-25 live probe, F-26 PHP↔Node numeric diff |
| 7 | Analysis engines, agents, consensus/debate | **R-26 closed** (Phase 5 hardening 0.6.1: per-route window limits 12 runs / 4 scans per 10 min charged pre-validation, per-session in-flight cap default 2 with `finally` release) and **R-27 closed** (same pass; consolidated into the Phase 42 single retention policy). What remains is the F-26 numeric diff for the **regime/setup/scenario layer and strategy/journal metrics** — the indicator set + `MathUtils` + formatting verbs were diffed exact in Phase 50 (found/fixed F-47) (the screen landed in Phase 32, `/app/analysis`) |
| 8 | Strategy Lab, lifecycle, backtesting, analytics | **Closed for the screen** (Phase 31, `/app/strategy`); what remains is not a screen but the PHP↔Node evidence-threshold diff (F-26) |
| 9 | Research-only portfolio optimization | **Closed for the screen** (Phase 29, `/app/portfolio/optimizer`); saved reports deliberately absent |
| 12 | Execution Supervisor | Console landed (Phase 39, `/app/execution`); broker-bound steps outstanding (see row 13) |
| 13 | Broker Center and broker connectors | Real-terminal/demo verification, order routing |
| 14 | Sports intelligence | **Ported** (Phase 48): bounded record-only stake sizing (DV-27) landed — the module's last code gap — emptying the not-ported matrix and moving `sports` to `ported`. What remains is boundary/host: no verified sports vendor, no real-MySQL rehearsal (F-15). |
| 15 | Lottery intelligence and Operations console | **Ported** (Phase 30): both console screens land at `/app/lottery` and `/app/lottery/lab`, the module's `notPorted` matrix is empty, and `lottery` moved to `ported` in the ledger. What remains is host-level, not code: no authorized official feed configured |
| 16 | **Language learning / AI teacher** | **Ported** (Phase 46): 16 `wf_*` Language Learning tables (`021_language_learning.sql`), 40 repository methods across file and MySQL adapters, 20 authored languages, placement staircase, curriculum path & checkpoints, AI teacher guided lessons, multi-turn conversations, writing feedback, grammar explain-simply, 200-word vocabulary SRS, listening & speaking practice, adaptive weakness detector & daily study plan, deterministic translator, 33 `/api/v1/language-learning/*` routes, and the console at `/app/languages` and `/app/languages/teacher`. `languageLearning` moved from `not-ported` to `ported`. |
| 17 | **Lead Discovery: CI3 module + Scout consolidation** | **Ported** (Phase 45): organization-scoped Lead Discovery tables (`020_lead_discovery.sql`), 22 repository methods across file and MySQL adapters, `GooglePlacesProvider` (`GOOGLE_PLACES_API_KEY`, disabled by default and never fabricating business records), `Deduplicator`, 23 `/api/v1/lead-discovery/*` routes, and the console at `/app/leads` and `/app/leads/pipeline`. `leadDiscovery` moved from `not-ported` to `ported`. |
| 18 | **Chat, journal, trading tools and remaining platform surfaces** | **Closed** (Phases 41 & 43): journal console landed in Phase 41 (`/app/journal`), the public chat assistant (`Api_chat::respond`, `Aegis\ChatAssistant`) and floating widget landed in Phase 43 (`POST /api/v1/chat/respond`), and the legacy CLI tools map to the npm commands named in `UNFINISHED_MODULES.md` row 18. |
| 19 | Scheduled jobs, CLI and resumable work | **Ported** (Phase 12 + Phase 14 + Phase 20 + Phase 25 + Phase 44): operations cron (`npm run jobs`), sports cron (`npm run sports:jobs`), lottery cron (`npm run lottery:jobs`), broker connect/disconnect transitions, 80/70/60 % early-warning tiers (SJ-8), gross notional leverage and correlation-group checks (SJ-9, F-30). `scheduledJobs` moved from `partial` to `ported`. Host crontab installation and scheduled live-provider probe (F-25) remain deployment items. |
| 20 | **Football Predictions app integration** | Isolated app; consolidate-or-not decision; first-run MySQL/live provider/cPanel staging unverified |
| 21 | **Python MT5 bridge conversion or explicit exception** | FastAPI bridge remains; real demo-terminal check outstanding |
| 22 | **Full legacy data migration and cutover** | Identity importer unexecuted; no business-data importer, checksum reconciliation or restore rehearsal |
| 23 | **PWA + Capacitor release readiness** | Code closed; no real-browser/Lighthouse verification, native sign-in disabled, no SDK build/signing |

Rows 10 (paper trading) and 11 (risk center) are ported in code and appear here only for
host-verification reasons; row 10's two screens landed in Phase 37 (`/app/paper`) and row 11's
screen in Phase 38 (`/app/risk`).

---

## C. Unfinished build code — where it lives

- `apps/workforce-platform/` — Node modular monolith (`v0.24.0`); the 2 partial modules in section A.
  Consoles now exist for notifications, the audit trail, the portfolio optimizer, lottery (both
  screens), the Strategy Lab, the AI Workforce analysis run, the workspace dashboard, the admin
  control centre, sports, paper, risk, execution, brokers and journal; **F-29's screen list is
  empty** (settings closed with the account avatar and the control centre, and no legacy settings
  controller exists).
- `apps/api/` — TypeScript Lead Discovery API (routes, pipeline, quality, providers).
- `apps/web/` — Next.js `@lead-discovery/web` SPA for the same workstream.
- `apps/football-predictions/` — independent Express/MySQL app with 29 tests; production verification pending.
- `python-services/mt5-bridge/` — FastAPI MT5 bridge requiring a Windows MT5 host.

---

## D. Verification gates not yet run anywhere in this environment

Real MySQL/MariaDB (migrations 001–019, repository transactions, lock races — F-15), a crontab,
a real browser (PWA install/offline/update, screens), outbound HTTPS to any live provider, SMTP
delivery, official feeds, cPanel/Passenger deployment, backup/restore/rollback rehearsal, and the
documented PHP↔Node numeric diff (F-26). Existing legacy PHP financial-data results already
differ by DV-10, which remains an open acceptance difference.
