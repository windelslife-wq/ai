# Unfinished modules — name index

**Compiled:** 2026-10-16 (updated after Phase 35) · **Source of truth:** the in-code ledger in
`apps/workforce-platform/src/modules/platform/health.js` (served by `/api/v1/system/features`
and `/api/v1/system/status`), cross-checked against `docs/migration/UNFINISHED_MODULES.md`
and `docs/migration/STATUS.md`.

"Unfinished" = **not implemented and parity-accepted in the Node.js target**. Several of these
already exist and pass tests in the PHP application; they are still unfinished as Node ports.

---

## A. Platform status ledger — 17 modules, 7 unfinished (10 ported / 5 partial / 2 not-ported)

### Partial (code exists, work remains) — 5

| # | Module key | Name | What is still missing |
|---:|---|---|---|
| 1 | `publicSite` | **Public website, help/contact and SEO** | Public chat widget; legacy announcement-bar default copy; outbound contact-mail delivery (messages are stored only). |
| 2 | `execution` | **Execution Supervisor and trading governance** | No live route and no automated mode; remaining supervisor steps are broker-bound (row 13). Whole live path is paper-only. |
| 3 | `scheduledJobs` | **Scheduled jobs, CLI and resumable work** | Legacy early-warning tiers at 80/70/60 % of a limit (SJ-8); `EXCESSIVE_LEVERAGE` / `CORRELATED_POSITIONS` codes (SJ-9); no crontab installed on a real host. |
| 4 | `brokers` | **Broker Center and broker connectors** | Ten adapters registered but all disabled by default; no order routing, no simulated bridge, no adapter verified against its provider (MT5 real-terminal validation outstanding). |
| 5 | `sports` | **Sports intelligence** | Stake sizing; no live provider verified against a real vendor. (The console screens left this row in Phase 36: `/app/sports` is `Sports::index` and `Sports::tickets`, and the decision route gained `Api_sports::decide_ticket`'s kill-switch refusal.) |

### Not ported (Node equivalent absent) — 2

| # | Module key | Name | Existing code |
|---:|---|---|---|
| 6 | `languageLearning` | **Language learning / AI teacher** | PHP only: `application/libraries/Aegis/LangLearn/`, `application/views/langlearn/`, `tests/cases/36-language-teacher.php`. |
| 7 | `leadDiscovery` | **Lead discovery** | PHP `application/libraries/LeadDiscovery/` + legacy Scout; separate Node/TypeScript stacks in `apps/api/` and `apps/web/`. |

Ported (for contrast): `identity`, `audit`, `notifications`, `marketData`, `analysis`,
`portfolioOptimizer`, `strategies` (its console landed in Phase 31, closing the module's last
recorded entry), `paperTrading`, `risk`, and — since Phase 30, when its
last unported entry (the console screens) became a ported surface and its own `notPorted`
matrix went empty — `lottery`.

---

## B. Backlog rows that are not finished (from `UNFINISHED_MODULES.md`, 23 rows)

| Row | Module / workstream | Status |
|---:|---|---|
| 1 | Identity, authentication and legacy account import | Code present; no real-DB import rehearsal, no approval to import |
| 2 | Account management, registration, **password reset** and admin users | Mostly ported; password reset not ported (`delivered: false`, no mail transport) |
| 3 | **Shared app shell, dashboards, settings and navigation** | **No screen left.** The sports dashboard landed in Phase 36 (`/app/sports`), closing the last one this row named — the settings gap closed with the account screen's avatar control (Phase 34) and the administrator control centre (`/app/admin`, Phase 35); the portfolio-optimizer (Phase 29), lottery (Phase 30), Strategy Lab (Phase 31), AI Workforce (`/app/analysis`, Phase 32), workspace dashboard (`/app`, Phase 33), account avatar (Phase 34), admin control centre (Phase 35), sports console (Phase 36) and paper console (Phase 37) screens landed |
| 4 | Public website, help/contact and SEO | Chat widget + announcement bar not ported |
| 5 | Notifications, audit browser, feature/status reporting | No outbound delivery channel, no retention policy decided (inbox + audit consoles exist) |
| 6 | Market data and provider health | F-24 shared health store, F-25 live probe, F-26 PHP↔Node numeric diff |
| 7 | Analysis engines, agents, consensus/debate | R-26 route limits, R-27 retention for `wf_analysis_runs.payload` (the screen landed in Phase 32, `/app/analysis`) |
| 8 | Strategy Lab, lifecycle, backtesting, analytics | **Closed for the screen** (Phase 31, `/app/strategy`); what remains is not a screen but the PHP↔Node evidence-threshold diff (F-26) |
| 9 | Research-only portfolio optimization | **Closed for the screen** (Phase 29, `/app/portfolio/optimizer`); saved reports deliberately absent |
| 12 | Execution Supervisor | Broker-bound steps outstanding (see row 13) |
| 13 | Broker Center and broker connectors | Real-terminal/demo verification, order routing |
| 14 | Sports intelligence | Stake sizing, live vendor (the console landed in Phase 36, `/app/sports`) |
| 15 | Lottery intelligence and Operations console | **Ported** (Phase 30): both console screens land at `/app/lottery` and `/app/lottery/lab`, the module's `notPorted` matrix is empty, and `lottery` moved to `ported` in the ledger. What remains is host-level, not code: no authorized official feed configured |
| 16 | **Language learning / AI teacher** | Node port absent |
| 17 | **Lead Discovery: CI3 module + Scout consolidation** | Unity/consolidation decision outstanding |
| 18 | **Chat, journal, trading tools and remaining platform surfaces** | Node equivalents absent; needs full controller/route/view inventory |
| 19 | Scheduled jobs, CLI and resumable work | Broker transition alerts; SJ-8/SJ-9 tiers; real crontab |
| 20 | **Football Predictions app integration** | Isolated app; consolidate-or-not decision; first-run MySQL/live provider/cPanel staging unverified |
| 21 | **Python MT5 bridge conversion or explicit exception** | FastAPI bridge remains; real demo-terminal check outstanding |
| 22 | **Full legacy data migration and cutover** | Identity importer unexecuted; no business-data importer, checksum reconciliation or restore rehearsal |
| 23 | **PWA + Capacitor release readiness** | Code closed; no real-browser/Lighthouse verification, native sign-in disabled, no SDK build/signing |

Rows 10 (paper trading) and 11 (risk center) are ported in code and appear here only for
host-verification reasons; row 10's two screens landed in Phase 37 (`/app/paper`).

---

## C. Unfinished build code — where it lives

- `apps/workforce-platform/` — Node modular monolith (`v0.23.0`); the 8 modules in section A.
  Consoles now exist for notifications, the audit trail, the portfolio optimizer, lottery (both
  screens), the Strategy Lab, the AI Workforce analysis run, the workspace dashboard, the admin
  control centre, sports and paper; the remaining F-29 gap is the risk, execution, Broker Center and
  journal screens (settings closed with the account avatar and the control centre, and no legacy
  settings controller exists).
- `apps/api/` — TypeScript Lead Discovery API (routes, pipeline, quality, providers).
- `apps/web/` — Next.js `@lead-discovery/web` SPA for the same workstream.
- `apps/football-predictions/` — independent Express/MySQL app with 29 tests; production verification pending.
- `python-services/mt5-bridge/` — FastAPI MT5 bridge requiring a Windows MT5 host.
- `application/libraries/Aegis/LangLearn/`, `application/views/langlearn/`, `application/libraries/LeadDiscovery/` — PHP-only modules with no Node port.

---

## D. Verification gates not yet run anywhere in this environment

Real MySQL/MariaDB (migrations 001–019, repository transactions, lock races — F-15), a crontab,
a real browser (PWA install/offline/update, screens), outbound HTTPS to any live provider, SMTP
delivery, official feeds, cPanel/Passenger deployment, backup/restore/rollback rehearsal, and the
documented PHP↔Node numeric diff (F-26). Existing legacy PHP financial-data results already
differ by DV-10, which remains an open acceptance difference.
