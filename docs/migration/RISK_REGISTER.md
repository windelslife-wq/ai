# Phase 0 — Risk Register

**Audit date:** 2026-10-05 · **Audited commit:** `675a05c` (includes migration master plan)
Per master plan §11 Phase 0: "Record known failures and contradictions. Never silently reconcile them." Every item below was **observed directly in the repository or by executing its tooling** during this audit; nothing is speculative. Severity: 🔴 blocker for cutover/production · 🟠 must be resolved before/within the phase noted · 🟡 track, decide consciously.

| ID | Sev | Area | Risk / contradiction (evidence) | Mitigation / owner phase |
|---|---|---|---|---|
| **R-01** | 🟠 | Scope | **Football Predictions app (`apps/football-predictions`) is absent from the master plan's module list (§3).** Merged 2026-10-04 via PR #2 after the plan was drafted. It is a full Node/Express/MySQL app with 19 `fp_` tables, its own auth, cron jobs and cPanel docs, explicitly "staging validation required". Silently leaving it out of the migration would either orphan it or break the "migrate everything" contract. | Update plan scope; decide **keep-isolated vs. absorb into monolith** in Phase 1 architecture decision record. Either way add its routes/tables/jobs to the parity inventory. |
| **R-02** | 🔴 | Architecture | **Two parallel lead-discovery implementations with divergent data models.** (a) CI3 module: `Api_lead_discovery.php` + `libraries/LeadDiscovery/*`, session+CSRF auth, 11 MySQL tables, ids `org-<n>` / 32-hex. (b) Scout: `apps/api`+`apps/web`, JWT+rotating refresh tokens, 13 PostgreSQL tables + Redis, UUID ids. Both serve `/api/v1/lead-discovery/*`. Data cannot be merged without an id-mapping layer; features are not identical (Scout has refresh tokens & admin user management; CI3 has first-use auto workspace). | Phase 1 decision record: consolidate to one implementation + one storage (cPanel baseline = MySQL per plan §3); build id-mapping + column-diff in Phase 4 import tooling. Do **not** silently drop either side's data. |
| **R-03** | 🔴 | Deployment | **`application-deployment.zip` is stale.** Committed 2026-08-24; 29+ files differ from current tree (e.g. `routes.php`, `Auth.php`, `Identity.php`, `Repositories.php`, `Aegis_model.php`, 10+ views, all CSS/JS; `application/views/auth/goodbye.php` missing). README + `docs/CPANEL_DEPLOYMENT.md` instruct users to upload **this zip** for production installs → cPanel customers would deploy outdated code missing current security/UI fixes. | Rebuild the zip from a scripted, verifiable packaging step (or stop shipping a zip and tag releases); checksum-diff zip vs tree in CI (see R-05). Until then, treat the zip as untrusted. |
| **R-04** | 🟠 | Build | **Root `npm ci` fails** — `package-lock.json` out of sync with `package.json` (football workspace + its deps never locked). Additionally, the **nested `apps/football-predictions/package-lock.json` breaks workspace installs**: a plain root `npm install` installs *only* the football tree (root devDeps `tsx`/`typescript` and Scout deps are skipped — verified). Workaround used in this audit: `npm install --no-package-lock`. | Phase 1: regenerate one root lockfile covering all workspaces (or move football out of the workspace glob); add `npm ci && npm run typecheck && npm run test:contracts` to CI (R-05). |
| **R-05** | 🟠 | QA | **No CI pipeline exists** (no `.github/` directory). 407 tests exist but nothing runs them automatically on push/PR; regressions like R-03/R-04 went unnoticed. | Phase 1: GitHub Actions running all five suites (PHP via the WASM runner or a PHP container, typecheck, Scout contracts, football tests, bridge pytest). |
| **R-06** | 🟡 | Documentation | **README contradicts itself.** Two status tables: current ("Phases 1–3 complete; Phase 4/5 automation core complete", **351 tests**) and a stale leftover table ("Phase 4/5 PLANNED", **57 tests**). Also "63 case files, 351 tests" vs. actual **67 case files, 357 tests** (two files share the number `28`). The truthful number as executed in this audit is 357 (see `BASELINE_TESTS.md`). | Fix README (remove stale table, update counts); adopt a single machine-readable status source (`/api/system/features` + test output) as the plan requires. Documentation-only change, safe pre-Phase 1. |
| **R-07** | 🟠 | Security | **Three independent auth stacks** to reconcile in the Node target: CI3 sessions (`ci_sessions`/files, bcrypt `$2y$`, CSRF token header), Scout JWT + rotating refresh tokens (bcryptjs), football cookie sessions (`fp_sessions`, CSRF). Users may exist independently in each. Unifying them risks lockouts or, worse, weakening (e.g. dropping CSRF, mixing session/JWT trust). | Phase 2 design: single identity service with session+CSRF baseline; migrate hashes verbatim and rehash to Argon2id on login; map any Scout/football accounts via email with explicit linking (audit-logged). |
| **R-08** | 🔴 | Security | **Initial administrator bcrypt hash committed to the repository** (`database/production.sql` line 925: `admin@example.com`, `$2y$10$…`, id=1, super_admin; also inside the stale zip and git history). Any repo reader can attempt offline cracking; if the bootstrap password is weak/documented, every install that keeps the seed account is exposed. Plan rule #7 forbids secrets in GitHub. | Stop seeding a fixed admin: Node installer must require an interactive/env-provided admin credential (like football's `create-admin.js` pattern). For existing installs: force password rotation on first login. Document that the hash remains in git history (rotating the password, not the file, is the fix). |
| **R-09** | 🟠 | Trading safety | **MT5 path never verified against a real terminal** (bridge contract-tested only against a fake; requires Windows host + demo account). Repo is honest about this; the risk for the migration is *carrying the claim forward correctly*. | Preserve: bridge stays Python (documented migration exception per plan §3); Node connector must re-verify bridge health/order-submission capability before routing; live trading stays disabled (`AEGIS_MT5_LIVE_ALLOWED=0`) until the real-demo verification procedure is executed and signed off. |
| **R-10** | 🔴 | Trading safety | **Safety invariants must survive the port 1:1** — the 15-step ordered pipeline, Risk Engine veto on actual order volume, kill switch first + re-check at routing, strategy lifecycle gates (APPROVED requires ≥10 paper trades PF>1), automation envelope, synthetic-provenance labeling, `allowSyntheticPaperData` off by default, agents structurally unable to reach connectors. A Node rewrite that reorders or relaxes any gate is a production-safety bug. | Port the domain layer behind the existing repository contracts; port the 357-test suite as the parity oracle **before** behavior; add explicit bypass-attempt negative tests (plan §7). Gate: no module is "done" until its safety tests pass in Node. |
| **R-11** | 🔴 | cPanel | **Hosting capabilities unconfirmed** (plan §8 requires verification): actual Node LTS version offered, Passenger support & process limits, whether WebSockets/SSE pass through the proxy, cron min-interval & max execution time (needed: every-minute `tools cron` equivalent), MySQL/MariaDB version (JSON columns, CHECK constraints, `utf8mb4` index lengths), outbound HTTPS to Binance/Frankfurter/Google Places/API-Football, ability to run PHP app + Node app side-by-side on one account during coexistence, and whether Next.js SSR (Scout web) can run under Passenger or must become static/SPA. | Phase 1 "minimal app deploys to cPanel" spike answers all of these before any module migration; record answers in `deploy/cpanel/ENVIRONMENT.md`. |
| **R-12** | 🟠 | Data | **No versioned migrations anywhere** (raw SQL files; `sports_identity` DDL explicitly split out pending "explicit reviewed migration"). Current production schema evolution is manual; there is no schema-version table. | Phase 1 introduces versioned, ordered migrations with a baseline snapshot = current `production.sql` DDL; never reset data. |
| **R-13** | 🟠 | Data | **Legacy storage conventions are semantic traps:** timestamps as `VARCHAR(32)` ISO strings (lexicographic sort, no DB time functions), JSON as `LONGTEXT` (no native JSON ops), mixed identifier types (INT AI, VARCHAR composite PKs, 32-hex, `org-<n>`, UUIDs in Scout). A naive ORM mapping will corrupt ordering/comparisons. | Decide per-convention in the Phase 1 schema ADR; converter must be checksum-verified and reversible (plan §6). Football schema (`DATETIME(3)`, native JSON, CHECKs, FKs) can serve as the modern style reference. |
| **R-14** | 🟡 | QA | **The 357-test suite runs on SQLite, not the production MySQL path.** MySQL-only behaviors (`ON DUPLICATE KEY UPDATE` seeds, collations, index length limits, locking) are untested by CI; the docker-compose MySQL stack was never exercised in the dev sandbox (stated in the compose file header). | Node integration tests must run against real MySQL/MariaDB (container locally, real DB on the cPanel staging account). |
| **R-15** | 🟡 | DevOps | **Dev-compose defaults are weak** (`MARIADB_ROOT_PASSWORD` default `aegis` in `docker-compose.yml`) and two compose files overlap the same repo (legacy AEGIS + Scout). Dev-only, but easy to mis-deploy. | Mark dev-only explicitly; remove default passwords (require env). Superseded by the cPanel Node deployment for production. |
| **R-16** | 🔴 | Data | **Production data exists only on the live cPanel host** (no dumps in repo — correct per rule #7, but it means the migration importer has never seen real data volumes: audit_logs and analysis_runs may be large; lottery draws modest; sports tables possibly empty). Importer must handle production-scale `audit_logs` within shared-hosting time/memory limits. | Phase 4 rehearsal with a sanitized production dump; batch + checkpoint + resume design (plan §6); measure real row counts first. |
| **R-17** | 🟠 | Frontend | **UI consolidation is unresolved:** AEGIS UI = 61 server-rendered PHP views + 3 CSS/4 JS (no framework); Scout = Next.js 16 SSR app; football = vanilla static pages. "Reuse and consolidate the existing Scout frontend" (plan §4) needs the R-11 Passenger answer (SSR feasible?) and an honest audit of Scout's dependencies before it becomes the shell for everything. | Phase 1 decision record; default safe path: server-rendered (or pre-built static) pages served by the Node app, no build toolchain on the host (plan §4). |
| **R-18** | 🟠 | Cutover | **Coexistence + rollback constraints:** PHP app must keep running (rollback target) while Node is built and rehearsed; cron jobs exist in both worlds (every-minute portfolio scan); the same MySQL database will be read by PHP (legacy) and written by Node only after cutover freeze; rollback requires the legacy schema untouched (additive-only migrations during coexistence). | Follow plan §11 Phase 6 exactly: freeze → import → verify → switch; additive-only schema changes; tested restore before cutover; PHP stays deployable through acceptance. |
| **R-19** | 🟡 | Repo hygiene | **A 2.4 MB binary zip is tracked in git** and already drifted (R-03); every future release would re-commit a large binary. Also `.gitignore` excludes `data/*.json` etc. correctly — good. | Stop tracking build artifacts; produce the deployment archive in a release step (GitHub Release asset) instead. |
| **R-20** | 🟡 | Hardening | **Minor escape hatches to keep locked:** `AEGIS_ALLOW_HTTP_TOOLS=1` can expose the CLI tools controller over HTTP (default off, 404s otherwise — verified); `WINDELS_LOTTERY_SANDBOX=1` enables the sandbox lottery provider (labeled simulation); `AEGIS_ALLOW_SYNTHETIC_PAPER=1` (dev runtime only). All are honest, documented and default-off — the Node port must preserve the defaults and keep them out of production env templates. | Carry into the Node `.env.example` as disabled; add deployment self-check that fails if any escape hatch is on in production. |

## Contradiction ledger (recorded, not reconciled — per Phase 0 rules)

1. README status table A ("351 tests", Phases 1–5 core complete) vs. README status table B ("57 tests", Phase 4/5 PLANNED) — table B is stale leftover content.
2. README "63 case files, 351 tests" vs. actual 67 files / 357 tests (executed).
3. `application-deployment.zip` contents vs. current working tree (29+ files differ).
4. Root `package-lock.json` vs. root `package.json` (football workspace untracked in lock).
5. Master plan module list vs. actual repository contents (football predictions missing from plan; plan's own §3 rule requires inventorying discovered modules — done in `INVENTORY.md` §3.12).

## cPanel capability questions to answer in the Phase 1 spike (R-11 detail)

1. Node.js version available via Setup Node.js App (need ≥ 20 LTS; Scout uses Next 16 which wants recent Node; football requires ≥ 22 — **check whether the host offers Node 22**, else football's `engines` field must be relaxed or the host upgraded).
2. Passenger: startup-file support, memory/CPU ceilings, graceful restart, environment-variable UI.
3. WebSocket/SSE support through the Apache/Passenger proxy (else polling fallback).
4. Cron: minimum interval (need 1 minute for the portfolio/expiry worker), max execution time, per-job locking.
5. MySQL/MariaDB version + `max_user_connections`, DB size limits; PostgreSQL/Redis availability (if absent, Scout consolidation must target MySQL — plan §3 already anticipates this).
6. Outbound network: allowed destinations/ports (Binance, Frankfurter/ECB, Google Places, API-Football, the MT5 bridge host).
7. Concurrent PHP + Node apps on one account during coexistence; document-root layout for `public/` + API proxy.
8. Upload/storage paths writable by the Passenger user (avatars, exports).

## Additions after Phase 3 (2026-10-09, branch `arena/774d9e70-ai`)

Risks created or first observed by the public-site/PWA/contact-intake work. The Phase 0 table
above is unchanged; these are additive, per the "never silently reconcile" rule.

| ID | Sev | Area | Risk / contradiction (evidence) | Mitigation / owner phase |
|---|---|---|---|---|
| **R-21** | 🟠 | Deployment / caching | **Generated documents can be shadowed on a real host.** `public/index.html`, `robots.txt`, `sitemap.xml`, `manifest.webmanifest` and `service-worker.js` were deleted from the tree and are rendered per request. An Apache `DirectoryIndex`, a leftover file from an earlier deploy, an archive extracted over `public/`, or a rewrite that serves files before Passenger would publish a stale document instead — and a stale `service-worker.js` pins every returning visitor to an obsolete shell. `verify:install` (check 29) guards the *repository* only; it cannot see the host's document root. | Phase 5 (cPanel hardening): after upload, request all five paths on the host and diff them against locally generated output; add it to the pre-cutover checklist; never extract a deployment archive over an existing `public/` without deleting those five names first. |
| **R-22** | 🟡 | Privacy / data | **Public contact intake stores personal data with no retention story.** `wf_contact_inquiries` (migration 004) holds a visitor's name, email and message, and the same three fields are duplicated in the `CONTACT_INQUIRY` audit details so an operator can answer from the trail alone. There is no retention window, no purge job and no data-subject deletion path. The client address is stored only as an HMAC-SHA256 fingerprint (deliberate), but a deletion request would have to reach two places. | Decide retention + purge with the notifications/audit module port: a cron-invoked CLI job with DB-backed locking (plan §8), plus an approved answer for audit-trail immutability vs. erasure requests. Until then the inbox is read-only and the docs state plainly that personal data is stored. |
| **R-23** | 🟡 | Frontend / security | **Client-side gates could be mistaken for access control.** The SPA renders permission-gated navigation and refuses to mount a view whose permission is missing. That is presentation: the API re-checks the same permission and answers 403 regardless, and the denial view says so and names the permission. The risk is a future contributor treating the client guard as the control. | Keep the invariant explicit: no client-only gate is ever the control. Every new SPA view gets a matching 401/403 server test (Phase 3 precedent: `the administrator inquiry listing is super-admin only and paginated`). |

## Additions after Phase 4 (2026-10-09, branch `arena/774d9e70-ai`)

Risks created or first observed by the market-data port. The Phase 0 table and the Phase 3 additions
above are unchanged; these are additive, per the "never silently reconcile" rule.

| ID | Sev | Area | Risk / contradiction (evidence) | Mitigation / owner phase |
|---|---|---|---|---|
| **R-24** | 🟠 | External dependency / data integrity | **The platform now depends on third-party hosts it does not control, and on a licensed feed that does not exist.** `GET /api/v1/market-data/*` calls `api.binance.com` (plus the mirrors `data-api.binance.vision`, `api1.binance.com`) and `api.frankfurter.dev`. Both are unauthenticated public endpoints with their own rate limits and their own release schedule: a renamed field, a new error envelope or a tightened limit changes behaviour without any change here, and nothing in CI would notice (finding **F-25** — every provider test injects a transport; this sandbox has no egress at all, so both reported `DOWN` live). Stocks, ETFs, futures and options have **no** source: all four licensed adapters are inert scaffolds reporting `DISABLED`, so those four market classes are unserved on any host until a vendor is contracted. Related: R-20 (the legacy escape hatches stay off) and R-11 item 6 (outbound destinations must be allowed on the cPanel host). | Phase 5/6: confirm outbound HTTPS to all four hostnames on the target host, re-run the live rehearsal there, and record the result in `PHASE4_MARKET_DATA.md` §9. Add a scheduled probe that calls both real providers and records health + payload shape, so vendor drift is caught by a job rather than by a user (F-25). Do not claim stock/ETF/futures/options coverage anywhere until a licensed feed passes its own contract tests. |
| **R-25** | 🟠 | Honesty / downstream consumers | **Labelled synthetic data can be consumed as if it were real one layer up.** The synthetic provider is registered last, every candle carries `provenance.synthetic: true`, and a host can refuse it outright (`MARKET_DATA_ALLOW_SYNTHETIC=0` → `503 SYNTHETIC_DATA_DISABLED`). But the label only protects anyone who reads it: analysis, strategies, paper trading and risk all consume this module next, and the legacy platform's own rules (Rule 2 vetoes on synthetic + stale data, the mandatory "SIMULATION / SYNTHETIC DATA" banner) live in *those* modules, not here. A ported analysis engine that drops `provenance` from its own payload would silently launder simulated candles into a real-looking signal — and `AEGIS_ALLOW_SYNTHETIC_PAPER` (R-20) shows the legacy platform already had to fence this off once. | Every consuming module must carry `provenance.synthetic`, `.live`, `.stale` and `.fallbackChain` forward into its own responses, and must inherit the veto/banner rules rather than reimplement them; each gets a negative test asserting that a synthetic-fed analysis says so. Written into `PHASE4_MARKET_DATA.md` §12 as an entry criterion for the analysis phase. |

## Additions after Phase 5 (2026-10-09, branch `arena/774d9e70-ai`)

Risks created or first observed by the analysis/agent/consensus port. The Phase 0 table and the Phase 3
and Phase 4 additions above are unchanged; these are additive, per the "never silently reconcile" rule.

| ID | Sev | Area | Risk / contradiction (evidence) | Mitigation / owner phase |
|---|---|---|---|---|
| **R-26** | ✅ **Closed** (was 🟠) | Cost / abuse amplification | **Analysis is the most expensive authenticated endpoint on the platform, and it is bounded only by the global limiter.** One `POST /api/v1/analysis/run` fetches up to **8** provider series (the symbol plus, for forex and commodities, the seven reference legs at 60 candles each); one `POST /api/v1/analysis/consensus` with no `symbols` scans the 7-symbol default watchlist, and with 10 symbols it can trigger **up to 80** upstream calls — four of those symbols being forex/commodity. The only bound is the process-wide `api:<client>` limiter at **120 requests / 60 s** (`src/app.js`), which the route inventory reports as `rateLimited: false` because it is not a per-route limit. On a host with real providers (R-24) a single authenticated account can therefore fan out into ten upstream requests per call, and shared-hosting CPU/second quotas (R-11) make the same call expensive locally: each run computes ~20 indicators over 300 candles, a seven-agent panel and a four-round debate. | **Closed in the Phase 5 hardening pass (`PHASE5_ANALYSIS.md` §13.2), on instruction to close it before porting another module.** Both POST routes carry their own window limits via the platform's per-route mechanism — `RATE_LIMIT_ANALYSIS_RUN_MAX` **12** and `RATE_LIMIT_ANALYSIS_CONSENSUS_MAX` **4** per `…_WINDOW_MS` **600 000** (10 min), per client address, charged *before* body validation so a malformed request still costs budget — and both hold a slot in a new per-session in-flight cap (`ANALYSIS_MAX_CONCURRENT_RUNS`, default **2**, `0` disables) implemented by `createAnalysisRunGate` over the existing `createConcurrencyTracker`. The cap is keyed **by session, not address**, so a shared office NAT cannot be used to starve a colleague (the reasoning that keeps login lockout per account); the release is in `finally`, so a run that throws cannot lock a session out. Window refusals are `429 RATE_LIMITED`, cap refusals `429 TOO_MANY_CONCURRENT_ANALYSES` — distinct because the client's remedy differs. Worst case per window is now **≤ 416 upstream series** (12 × 8 + 4 × 10 × 8) against 120 requests/min × 80 calls, pinned by a test; `GET /api/v1/system/routes` reports `rateLimited: true` for both POSTs. The market-data TTL cache (candles `max(15 s, 25 % interval)` = 15 min at `1h`) already meant repeat identical runs did not re-hit providers. **Still true and unchanged:** these limits are per *process*, so N Passenger workers each get their own (F-24). No load test was possible — this sandbox has no egress, so any throughput figure would have been invented. |
| **R-27** | ✅ **Closed** (was 🟡) | Data growth / retention | **`wf_analysis_runs.payload` grows without bound and holds a full run per row.** Each row stores every agent report, the debate transcript, three scenarios, the setup, the risk decision, provenance and validation as `LONGTEXT` — deliberately, so a run can be re-read years later without re-deriving it from market data that no longer exists. Nothing prunes it: no retention window, no archive job, no CLI command. A consensus scan writes 7–10 such rows per call, so the same amplification as R-26 applies to storage. The legacy table has the same shape (`analysis_runs`), so this is inherited growth, not new — but the Node platform is the one that will run on a shared host with a database size quota (R-11 item 5, R-16). | **Closed in the Phase 5 hardening pass (`PHASE5_ANALYSIS.md` §13.3).** The audit-vs-operational question is answered explicitly: the run is an **audit record while it is inside the retention window and operational data after it**, so retention is an operator decision taken outside a request — `ANALYSIS_RETENTION_DAYS` (default **90**, `0` = keep forever, the pre-R-27 behaviour) plus `tools/prune-analysis-runs.mjs` / `npm run prune:analysis`, backed by a new `pruneAnalysisRuns` on **both** adapters (repository contract **35 → 36**). **Dry run is the default** and reports the matching count, the oldest and newest affected timestamps and the reclaimable payload bytes before anything is deleted; `--apply` deletes. MySQL deletes in clamped batches (default 500, ceiling 5 000) with `ORDER BY completed_at ASC`, because `DELETE … LIMIT` without an order is non-deterministic and statement-based replication logs that as unsafe, and it reports `exhausted: false` rather than implying completion when the batch ceiling is hit. The file adapter deletes through the log's existing `delete` op so replay and `compact()` need no format change, and a test reopens the store from disk to prove the deletions replay. Both adapters share `assertIsoCutoff`: `completed_at` is `VARCHAR(32)` compared as **text**, so a `+00:00` offset cutoff would sort differently from the `Z` form of the same instant and delete the wrong rows. **There is deliberately no HTTP route that can delete analysis history** — pinned by a test asserting the module registers no `DELETE` verb. `ANALYSIS_RETENTION_DAYS=0` with `--apply` still deletes nothing, because reading `0` as `now - 0` would mean "delete every run ever written". **Still open:** the cron entry does not exist on any host yet (`PHASE5_ANALYSIS.md` §12 criterion 7), and real legacy row counts are still unmeasured (R-16). |

**R-25 obligation discharged for this module, still open for the next ones.** R-25 required that every
consumer of market data carry `provenance.synthetic`, `.live`, `.stale` and `.fallbackChain` forward into
its own responses and inherit the veto/banner rules rather than reimplementing them, with a negative test
asserting that a synthetic-fed analysis says so. The analysis module does exactly that: provenance is
copied verbatim into the run payload, promoted to `synthetic`/`source` **columns** on `wf_analysis_runs`
(so a query can find every synthetic-fed run without opening the payload), written into the
`analysis.run.completed` audit details, graded into the consensus freshness factor (live 1.0 / synthetic
0.5 / stale 0.2) and enforced by `blockSyntheticData`/`blockStaleData` in the risk veto. Tests assert a
synthetic run says so, that a stale run is forced to `NO_TRADE` with its proposal dropped, and that a live
run leaves the kill switch as the only remaining veto. This was the Phase 5 boundary; Phase 6 and Phase 7
records below describe the subsequent consumers.

**R-25 discharged for the Strategy Lab (Phase 6) and paper/risk surface (Phase 7).**
The strategy module copies `provenance.synthetic` into the backtest record, promotes it
to a **column** on `wf_backtests`, writes it into audit details and warnings, and carries
`dataProvenance` into optimization reports. Phase 7 preserves synthetic provenance on
paper orders, positions, trade legs and journal rows, audits account/control actions, and
applies the configured synthetic-data veto before a fill. The global synthetic-paper
setting defaults off; synthetic paper trades are not counted as live-approval evidence.
These Node tests establish local behavior only; no real feed, MySQL execution or
PHP↔Node parity diff was performed.

---

## Additions after Phase 6 (2026-10-10)

### R-28 — `wf_backtests` grows without bound and nothing prunes it (open)

Each row stores a full `LONGTEXT` payload: the request, the metrics, **every trade** and
**every equity-curve point**. A 720-bar run produces ~720 curve points and one object per
trade; the optimizer does not persist its segments, but a busy operator running backtests
will grow this table steadily, and no code path deletes a row.

This is the same shape as R-27 was for `wf_analysis_runs`, and R-27 was closed with a
retention setting, a bounded batch delete and an operator CLI. **That remedy was deliberately
not copied here**, because the two tables are not the same kind of thing. Analysis runs are
advisory outputs: pruning old ones loses history. Backtests are **load-bearing evidence** —
the `BACKTESTED` and `VALIDATED` gates count and rank them, so deleting the run that
justified a promotion destroys the audit basis for a decision already granted. The gates do
not re-run after `VALIDATED`, so nothing would break loudly; the evidence would simply be
gone.

That trade-off deserves its own decision rather than an inherited one. Options include
pruning only runs whose strategy is `RETIRED`, archiving payloads to object storage while
keeping the summary columns, or keeping evidence for any strategy past `BACKTESTED` forever
and pruning only abandoned drafts. Recorded so the table does not grow silently while the
question is unanswered.

### F-29 — ported domain APIs lack workspace consoles (open)

The SPA now ships identity, account, admin, status and an in-product notification inbox. The
remaining product/domain APIs still have no operator console: market data (Phase 4), analysis
(Phase 5), Strategy Lab (Phase 6), portfolio optimization (Phase 11), sports (Phases 15–20)
and lottery (Phases 21–25). The legacy rendered these as pages; `views/strategy/index.php`
alone is 8 466 bytes of operator UI with forms for backtest, optimize and advance, and its four
document routes remain unported. The audit browser and portfolio optimizer APIs also still
need workspace screens.

Compounding it, `ModuleCards` labelled market intelligence *"Not yet ported to Node"* — false
since Phase 5, and still on screen through Phase 6. Corrected in `a2bef0f` with a three-state
vocabulary (`live` / `api` / `planned`), because two states could not describe reality:
"not ported" understates a tested, served API, and "ported" implies an operator can click it
here, which they cannot. The middle state is styled blue rather than the green used for
`live`, since the colour is part of the claim.

The first shared-shell console is now the notification inbox. F-29 remains open until the
remaining domain consoles are ported one module at a time; the notification view is not evidence
that an unrelated API has a usable screen.

**Update (Phases 28–33).** The consoles landed for the audit browser (28), the portfolio optimizer
(29), the lottery (30), strategies (31), the analysis engines (32) and now the shared shell's own
**workspace dashboard** (33, `/app` — `views/workspace/index.php`, legacy's `/dashboard`). The
residual list was also **wrong before Phase 33**: it said *"still open for the Broker Center and the
sports screens only"*, but a screen-by-screen pass over `application/views/*` finds consoles with no
SPA counterpart for **paper** (`views/paper/{index,account}.php`), **risk** (`views/risk/index.php`),
**execution** (`views/execution/index.php`), **brokers** (`views/brokers/index.php`), **journal**
(`views/journal/index.php`), **sports** (`views/sports/{index,tickets}.php`) and the **admin control
centre** (`views/admin/index.php`; its user table and create/toggle forms are at `/app/admin/users`,
its SMTP panel needs a mail transport). The unported modules' own screens (`views/leads/`,
`views/langlearn/*`) are the row 16/17 workstreams rather than this finding. F-29 stays open for
those seven screens, and the dashboard's own quick actions name the two it touches rather than
linking into the gap.

### F-30 — `maxCorrelatedPositions` is a declared risk limit with no enforcement (open)

Found in Phase 12 while porting the portfolio risk monitor's alert vocabulary
([`PHASE12_SCHEDULED_JOBS.md`](PHASE12_SCHEDULED_JOBS.md), divergence SJ-9).

`maxCorrelatedPositions` appears in three places — the RiskEngine defaults
(`src/modules/analysis/risk-engine.js:42`, value **3**), the paper contract schema
(`src/modules/paper/contracts.js:106`, integer 1–100) and the paper service's bounds table
(`src/modules/paper/service.js:59`) — and in **no check anywhere**. Every other risk limit has
at least one enforcement point: `maxLeverage` at order time (`risk-engine.js:154`),
`minDataQuality` and `blockStaleData` in the same file, the exposure, drawdown, position-count
and daily/weekly loss limits in the portfolio scan.

So an operator can set `maxCorrelatedPositions: 3` through the permissioned
`PATCH /api/v1/risk/limits` route (or the legacy-style `POST /api/v1/risk/limits/update`), be
told it was saved, see it echoed back by `GET /api/v1/risk/limits` and inside the
`GET /api/v1/portfolio/risk-scan` report's `limits` block, and nothing will ever act on it. **A limit that reads as enforced and is not is worse than no limit**, because the
echo is the evidence an operator or an auditor will accept.

Legacy did enforce it, in the monitor: a static disclosed group table
(`PortfolioRiskMonitor::CORRELATION_GROUPS` — `CRYPTO_MAJORS`, `USD_MAJORS`, `USD_COUNTER`,
`METALS`, `ENERGY`, `US_EQUITY_INDEX`) raised `CORRELATED_POSITIONS` as a `warning` when two or
more open positions shared a group, labelled in its own message as a *"static heuristic, not
statistical"*. Neither the table nor the alert code was ported, and the Node portfolio scan has
no correlation check of any kind.

Not fixed in Phase 12, deliberately: choosing a correlation heuristic is a risk-modelling
decision, not a port, and inventing one inside a phase whose rule is to preserve behaviour
before improving it would be the wrong way to close it. The three options are to port legacy's
static group table as-is, to compute correlation from the same sample covariance the Phase 11
optimizer already builds, or to **remove the limit from the API** so it stops reading as
enforced. The third is the only one that is honest without doing any modelling, and it is the
minimum acceptable action. Related: R-20 and divergence SJ-9.

### F-31 — legacy `automation_limits` authenticated but never authorized (open, legacy-only)

Found in Phase 13 while reconciling the Execution Supervisor against its controller surface
([`PHASE13_EXECUTION_GOVERNANCE.md`](PHASE13_EXECUTION_GOVERNANCE.md)).

`Api_system::automation_limits()` (`application/controllers/Api_system.php:266`) is the read
half of the automation governance envelope — `approvedSymbols`, `maxTradeNotionalUsd`,
`maxDailyTrades`, `maxRiskPerTradePct`, `updatedAt`. It makes **no `requirePermission` call**:

```php
public function automation_limits()
{
    $this->json(['limits' => \Aegis\ExecutionSupervisor::automationLimits($this->platform->state())]);
}
```

`api_system/automation_limits` is not in `MY_Controller::PUBLIC_ACTIONS`
(`application/core/MY_Controller.php:165`, which lists only `api_auth/login`,
`api_chat/respond`, `api_system/status` and `api_system/features`), so it is not anonymous —
but authentication without authorization means **every signed-in user** could read the
governance envelope. Its sibling `update_automation_limits()` correctly requires
`trading.control` and catches `InvalidArgumentException`, which makes the omission on the read
side look like an oversight rather than a decision.

This is the same shape as **AV-1** (Phase 10: `Api_system::events()` exposed the whole audit
trail to any signed-in operator because it never called `requirePermission`). Lower severity —
configuration rather than identity and trade history — but the same class, and the pair is
evidence for a general statement about the legacy API: **it authenticated broadly and
authorized inconsistently.** A read endpoint sitting next to a correctly gated write endpoint
in the same controller is exactly the pattern a reviewer should expect to find more of.

Impact on this migration: **none, because the endpoint was never ported.** The Node platform
has no automation-limits state and no route for it (divergence ES-6 explains why porting the
document without enforcement would recreate F-30). Recorded so the gap is not inherited:
**row 13 must port `automation_limits` gated** — `trading.control` for the write and at minimum
`trading.view` for the read — and must port the limits *with* enforcement from the first
commit, never as an echoed-back document nothing acts on.

**Phase 14 status: still not ported, and now for a different reason.** Row 13's scope was
reconciled in [`PHASE14_BROKER_CENTER.md`](PHASE14_BROKER_CENTER.md) and the connector
boundary and health/demo gates shipped, but `automationLimits` did not. `automationModeGate()`
is a gate on *enabling `FULLY_AUTOMATED`*, and enabling that mode is meaningless while
`tradingConnector()` returns `null` — porting it now would produce a gate that always reports
the same two reasons, which is the same settable-but-inert shape as F-30. It stays unported and
is blocked on a verified adapter, not on scope. **F-32 below records that `automation_limits()`
is one of six ungated reads in the same controller**, which upgrades this from an isolated
omission to a pattern.

The PHP source is authoritative and must not be modified during migration, so this is **not
fixed in legacy**. If the PHP application remains reachable in production after cutover, the
gap is live there and belongs in the cutover decision (row 22), not in this port. Related:
AV-1, F-30, ES-6.

### F-32 — the legacy system API authorized its writes and left its reads open (open, legacy-only)

Found in Phase 14 while reconciling the broker connector surface
([`PHASE14_BROKER_CENTER.md`](PHASE14_BROKER_CENTER.md)).

`Api_system` gates **every write** and **most reads**, and then leaves a group of reads with
no `requirePermission` call at all:

| Ungated (any signed-in user) | Gated |
|---|---|
| `status`, `features` (**public**, in `PUBLIC_ACTIONS`) | `update_risk_limits`, `kill_switch`, `synthetic_paper`, `update_automation_limits`, `trading_mode` → `trading.control` |
| `brokers`, `mt5_account`, `mt5_quote` | `execution_approvals`, `execution_recent`, `portfolio_scan` → `trading.view` |
| `risk_limits`, `execution_preflight`, `automation_limits` | `execution_propose`, `execution_execute` → `trading.execute` |
| | `notifications`, `notification_read_all` → `system.authenticated` |

The pattern is not random: **writes are consistently gated, reads consistently are not.** This
is AV-1 (Phase 10, `events()`) and F-31 (Phase 13, `automation_limits()`) generalized, and
finding the same omission in three consecutive phases is what makes it a property of the
legacy API rather than a run of oversights.

**Severity varies enormously across the ungated group, and the two worst are broker-related:**

* `mt5_account()` returns the broker `accountId` (**the login**), currency, balance, equity,
  margin, free margin and leverage to any signed-in user.
* `status` is **anonymous** and embeds `BrokerManager::allStatus()` plus the kill-switch state,
  so an unauthenticated caller can enumerate connector health including `bridgeVersion`,
  `accountType` and `simulated` — the exact fields that say whether a real bridge is live.

The escalation path is trivial and needs no exploit: read `status` anonymously to learn a
bridge is `READY`, sign in with any account, read the account snapshot. Compare
`risk_limits()` (returns limits to the same user who cannot write them) and
`execution_preflight()` (returns a governance verdict for a symbol the caller may not trade)
— lower impact, same class.

**Mitigated on the Node side in this phase:** `GET /api/v1/brokers` requires `trading.view`,
and `mt5_account` / `mt5_quote` are **not ported at all** — a route that can only answer 503
with no verified adapter is a worse surface than no route. The connector methods behind them
exist and are tested against an injected transport, so they are two thin handlers once a real
bridge is verified.

**Not fixed in legacy.** The PHP source is authoritative and unmodified, so if the PHP
application remains reachable in production after cutover, `mt5_account`, `automation_limits`,
`risk_limits`, `execution_preflight` and `brokers` are still readable by any signed-in user
there, and `status` still leaks connector health anonymously. **This belongs in the cutover
decision (row 22): either the legacy API is retired, or these six reads are gated before
cutover.** Related: AV-1, F-31, F-30, R-20.

### F-33 — the configuration-documentation gate could not see a composed variable name (closed in Phase 14)

Found in Phase 14 while documenting the broker connector settings.

`verify:install` and the F-14 test both establish that every environment variable the config
reads is documented in `.env.example`. Both do it by scanning `src/config.js` for **literal
dotted reads** of the environment object. Every licensed-feed and broker setting is instead
read through a **composed** name built from a prefix table — an array lookup whose key is
assembled at runtime — which no regex over the source text can see.

The consequence was real, not theoretical: `AEGIS_ETF_DATA_*`, `AEGIS_FUTURES_DATA_*` and
`AEGIS_OPTIONS_DATA_*` — **21 variables across three licensed feed families** — had shipped
undocumented with the gate reporting green. The 50 broker variables added by Phase 14 would
have joined them, taking the blind spot to 71 knobs on a platform where
**an undocumented knob is an unconfigurable one** (the principle F-14 exists to enforce).

**How it was found matters more than what was found:** not by reading the gate, but by
strengthening it. The test now enumerates prefix × suffix from the config's own exported
tables (`LICENSED_ASSET_CLASSES`, `BROKER_CONNECTOR_ENV`, `brokerEnvNames`,
`LICENSED_DATA_ENV_SUFFIXES`, `BROKER_ENV_SUFFIXES`) and requires each generated name to
appear in `.env.example`. The strengthened gate immediately reported the 21 pre-existing gaps
itself. Enumerating from `brokerEnvNames()` rather than a hand-written list is what keeps the
gate from drifting when a prefix turns out to be irregular — which it did: MT5's trading flags
are `AEGIS_MT5_TRADING_ENABLED` and `AEGIS_MT5_LIVE_ALLOWED`, **without** the `_BRIDGE`
infix that its URL, token and enabled flag carry (divergence **D-21**).

**Closed:** all 71 composed names are documented, the gate is derived from the same table the
loader reads, and a future prefix cannot be documented and read inconsistently.

**Lesson worth carrying forward:** a documentation gate is only as good as its ability to see
the names the code actually uses. Two other gates in this repository work the same way — the
route-inventory count and the persistence-contract length — and both enumerate a *live*
structure rather than scanning source text, which is why neither has a comparable blind spot.
**F-14 was the only one scanning text.** Related: F-14, F-30, F-31.

### F-26 — no PHP↔Node differential harness (closed in Phase 15 for the sports foundation, extended in Phase 16; coverage still owed elsewhere)

Open since Phase 4 and restated at every phase since: both suites were green and
**nothing compared the two implementations against each other**, so a port could be
internally consistent and externally wrong. Every earlier phase preserved legacy's
error messages, rounding behaviour or timestamp shape *in case* such a harness ever
existed; none could use them.

**It now exists.** `runtime/parity/sports-golden.php` `require`s **eight** legacy
class files by path and emits their real output; `runtime/sports-parity.mjs` runs it
in WASM PHP 8.2 and writes
`apps/workforce-platform/test/fixtures/sports-parity-golden.json`;
`test/sports_parity.test.js` recomputes all **124 cases** with the Node port and
asserts agreement to the last double and the last character of every refusal
message. The golden file is PHP's own output, not a transcription of what PHP was
believed to do. Regenerating it is a normal workflow step, and the generator lives
under `runtime/` so producing parity evidence never touches the authoritative PHP
tree.

**It paid for itself immediately** — see **F-34**, found on its first run, and
**D-23**, a clock-convention mismatch that made the Node port refuse a *valid*
fixture as unparseable.

**Why the sports foundation and not something earlier.** The harness needs pure
functions: no I/O, no global state, no database, no clock reads beyond an
injectable `now`. The normalizer, the two engines and the sandbox provider are
exactly that. Every earlier candidate either touched the database (the risk engine,
the supervisor) or diverged numerically on purpose — **PO-1** keeps legacy's
bisection projection precisely so the numbers stay aligned, but nothing had ever
verified that they were.

**What this closure does *not* cover, stated so the finding is not read as retired:**

- The optimizer, indicators, `MathUtils`, regime/setup/scenario generation and the
  notification rules are still un-diffed. Each of those references to F-26 in
  `INVENTORY.md`, `STATUS.md` and `BASELINE_TESTS.md` **stands**.
- **DV-10** must appear in any future numeric diff as an *expected* difference:
  Node's `RiskEngine` vetoes zero, negative and non-finite equity where legacy PHP
  approves it.
- The sports provider **manager** and **health monitor** are pure enough to capture
  but are not captured yet: their inputs are repository rows, and the repository
  does not exist in this slice. Synthesising rows on the PHP side to compare
  against would test a fiction. Slice 2 captures them against the real thing.

Related: F-34, D-22, D-23, PO-1, DV-10.

### F-34 — PHP exposes two different CRC-32 algorithms under near-identical names, and legacy uses both in one class (found and fixed in Phase 15)

**Severity: high, and silent.** Not a risk that *might* materialise — one that did,
in the Phase 15 port, and would have survived every test written against the Node
implementation alone.

| PHP call | Algorithm | `hash("123456789")` |
| --- | --- | --- |
| `crc32($s)` ≡ `hash('crc32b', $s)` | reflected CRC-32/ISO-HDLC (`zlib`'s) | `cbf43926` |
| `hash('crc32', $s)` | non-reflected CRC-32/BZIP2, **rendered little-endian** | `181989fc` |

The two differ in the polynomial direction *and* in byte order, so they agree on
nothing. `Aegis\Sports\Providers\SandboxSportsProvider` uses **both in the same
class**: `crc32()` for per-team strength and `hash('crc32', …)` for the league
component of every generated external id.

**What happened.** The Node port implemented the reflected algorithm once, exported
it as `crc32()`, and used it for both call sites. The result was stable, plausible,
self-consistent and wrong: `sim-bc27c7-2026-10-10-0` where PHP produces
`sim-f3ff5d-…`. Every fixture id belonged to a **different fixture universe** from
legacy's. Determinism tests passed. Golden-value tests written against the Node
output passed. The sandbox generated 12 fixtures per day and they all looked right.

**Why it is a finding and not just a fixed bug.** Three reasons:

1. **Nothing downstream would have failed until row 22.** The mismatch only becomes
   visible when legacy data meets Node data — the cutover — which is the most
   expensive possible moment to discover that two implementations disagree about
   the identity of every record.
2. **The name is the trap.** `crc32` and `crc32b` differ by one character, and the
   *function* `crc32()` maps to `crc32b` rather than to `hash('crc32')`. A porter
   reading `hash('crc32', $league)` reasonably concludes it is the same CRC-32
   everyone means. It is not.
3. **Any future port that touches a PHP hash name will hit the same wall.** PHP's
   hash extension has this shape for other algorithms too. The rule to carry
   forward: *never assume two PHP hash spellings are the same function — capture
   the digest from PHP and compare.*

**How it was caught.** By the differential harness built in the same phase
(**F-26**, closed below): `runtime/parity/sports-golden.php` ran the real legacy
class in WASM PHP 8.2 and emitted its external ids; the Node test compared and
failed on the first one. This is the finding that justifies the harness existing —
it paid for itself on its first run.

**Fix.** Two separately-exported, separately-pinned implementations:
`crc32()` (reflected, verified against the published check value `0xCBF43926`) and
`crc32HashHex()` (CRC-32/BZIP2 byte-swapped via `Buffer#swap32()`, so the intent is
stated rather than buried in four shift masks). `test/sports.test.js` asserts
`crc32BigEndian("123456789") === 0xfc891918` next to
`crc32HashHex("123456789") === "181989fc"`, because the byte swap is exactly the
kind of step a later reader would "simplify" away. Related: F-26, D-22.


### F-35 — legacy wrote sync evidence it could not read, and built a provider-health monitor it never called (found in Phase 16; closed for the Node port, open in legacy)

Found while looking for the concrete `SportsRepository` implementation, which turned
out to be an anonymous class inside `application/models/Aegis_model.php` rather than
anything in the `Persistence` namespace — a navigation fact worth recording on its
own, because grepping the persistence namespace for behaviour finds only signatures.

Two independent gaps, both verified by grepping every PHP file under `application/`:

1. **`sports_sync_runs` has no reader.** The `SportsRepository` interface declares
   `startSync` and `finishSync` and nothing else for that table, and no file in the
   application issues a `SELECT` against it. The only other occurrence of the table
   name anywhere is a *docblock*. So each run's counters, and the per-record refusal
   messages `finishSync` stores truncated to 200 characters, were written into a
   table no operator could query. A row left in `RUNNING` — which is precisely the
   evidence that a worker died mid-sync — was invisible.
2. **`ProviderHealthMonitor::assess()` has no caller.** The only references to the
   class in the whole application are its `use` statement and its construction in
   `SportsIntelligence`. And its own docblock documents the third parameter as
   *"newest-first `sports_sync_runs` rows for this provider"* — the table gap 1 says
   cannot be read.

So the derived provider status, which is the monitor's entire purpose and the value
the data-quality engine consumes as `providerReliability`, was **never computed in
the legacy application**. Every quality assessment was scored against a provider
reliability that came from whatever a provider self-reported in its own `health()`
payload, and the seven-rule derivation that was supposed to discipline that number
never ran.

This retroactively justifies a Phase 15 decision. Slice 1 declined to report
`derivedStatus` on the unauthenticated status surface, on the reasoning that "a field
that can only ever hold `UNKNOWN` invites a reader to think it was measured". F-35 is
the evidence for *why* it could only ever hold `UNKNOWN`: legacy never measured it.

**Severity: high, silent.** Nothing fails, nothing logs, and no test in either suite
could notice — both were green for the whole life of the module. It is the same shape
as F-30 (`maxCorrelatedPositions` declared and enforced nowhere) and F-31
(`automation_limits` authenticated but never authorized): a control that exists in
code and not in behaviour.

**Closed for the Node port.** The fix is not porting the class — Phase 15 already did
that — but adding the read it needs. `listSportsSyncRuns` has **no legacy
counterpart** (divergence SP-15) and is what makes `assessProviderHealth` reachable:
`GET /api/v1/sports/status` now derives each provider's status from stored health
observations and stored sync runs, `GET /api/v1/sports/sync-runs` exposes the run
evidence including its refusal messages, and `test/sports_sync.test.js` asserts that
after one sync the derived status is *not* `UNKNOWN`. Porting the class would not have
closed this; porting the capability did.

**Open in legacy, and not fixed there.** The PHP application remains authoritative and
is not modified during migration (master plan §2). Legacy's monitor is still
unreachable and its sync evidence is still unreadable. Recorded here so the gap is
visible to anyone comparing the two, and so the Node port's extra method is understood
as a deliberate extension rather than a porting error.

A smaller observation from the same reading: `assess()`'s first parameter is
documented as the `sports_data_sources` row and is never read by the implementation.
The harness captures a case with an empty provider row to pin that, so a future port
cannot "helpfully" start using it and silently change every derived status.

Related: F-26 (the harness that made the monitor comparable), F-30 and F-31 (the same
declared-but-inert shape), SP-15, SP-21, SP-22.

### F-36 — legacy's Brier score is always 0.0 (found in Phase 17; the port does not reproduce it)

`CalibrationEngine::evaluate` accumulates `(int) (($p - $y) ** 2)`. A squared error between two
probabilities is always below 1, so the cast is always 0. The reported Brier score, and
`identityBrier` with it, is **always 0.0**. The model-performance `brier` inherits the defect.

The port computes the real squared error, and the parity test asserts the difference explicitly
rather than treating the two as equal. Anyone comparing a Node Brier with a legacy figure must know
that the legacy figure measured nothing. **Open in legacy**, which is the rollback target and is not
modified.

### F-37 — legacy's calibration is linear, Node's is logistic, and the identity fallback's output depends on the map (found in Phase 17)

Three facts, each verified in the PHP and in the port.

1. Legacy `PredictionEngine` applies `intercept + slope · raw` **linearly**. Legacy `CalibrationEngine::apply`
   applies the logistic map. The two disagree, and the linear form is the one that reaches a decision.
2. The port uses the **logistic** map everywhere (DV-12, user-chosen). That changes decisions: a case that is
   fully qualified is `REJECTED` with `LOW_MODEL_EDGE` under the linear form and `QUALIFIED` under the logistic form.
3. The identity fallback, used when a fit is degenerate, is `sigmoid(raw)` under the logistic map and `raw` under
   legacy's linear `PredictionEngine`. Legacy's fallback keeps the method `platt`, so the stored label does not say
   which output it produces. **The user chose `raw`** (DV-19). The port stores the fallback with method `identity` and returns the raw
   probability, so a stored fallback is distinguishable from a fitted line that happens to be 0 + 1·x.

**Mitigation.** The method label, the golden test (`isIdentityFallback`) and PHASE17 §3 make the divergence
visible. **Residual risk:** a calibration measured on the identity has ECE and Brier values that describe the raw
probability, not a calibration. Those are reported with `method: identity`, and `fitCalibration` never presents them as a learned fit.

### F-38 — the stored quality assessment could not qualify any decision (found in Phase 17; closed by re-assessment)

`latestSportsQuality` is written at sync, which assesses without odds and without recent form, as the sync code
states it does for legacy (SP-22). Legacy's `Api_sports` reads that stored assessment (`Api_sports.php:90`).
Legacy's `DailyTicketService` (`:101`) re-assesses with the current odds before it evaluates. Slice 3 first
reproduced the legacy controller, and every decision was refused on a READY prediction.

**Closed.** The user chose re-assessment, and `evaluate` now re-assesses from the current price, the provider's
derived reliability and the recent form in `payload.context`. The stored row is never written by the evaluation.
Reliability is derived from stored sync history, so a provider with no history scores 0.

**New risk, open.** A sandbox fixture with a fresh price now reaches `QUALIFIED`, labelled `simulated: true`. Legacy's
gate ignores the flag too, so the port matches. Slice 3 creates no ticket from it. Whether a `simulated` decision
should be allowed to qualify is open (PHASE17 §9, decision 3). A real provider has not been connected, so this
cannot yet reach a real fixture.

Related: SP-22, DV-18, DV-19, F-15, NV-6.

— End of Phase 0 risk register.

## Additions after Phase 18 (2026-10-12, branch `arena/7577d922-ai`)

### R-29 — A daily ticket run stuck in RUNNING blocks its day and configuration version, with no recovery route (open)

**Risk.** A run claims `(run_date, configuration_version)` before any work and finishes it after. A crash, or a
process stopped mid-run, leaves the row `RUNNING`. The claim is an insert on a unique key, so every later run for
that day and version reports `DUPLICATE_SKIPPED`, and nothing in the API clears the row.

**Mitigation / owner.** None yet. Before any scheduled run (`SportsCronService`, still unported), add a recovery
route or an operator procedure that finishes an abandoned run and records who did it and why. The status it writes is decided with that route. Related: DV-23.

### R-30 — The file adapter writes a ticket and its legs in separate appends (closed, Phase 26)

**Risk.** `saveSportsTicket` on the file adapter appends the ticket and then each leg. A crash between the appends
leaves a ticket with missing legs, which reads as a combination with fewer selections than it was recorded with.
The MySQL adapter writes them in one transaction, and a test proves it rolls back whole.

**Mitigation / owner.** Acceptable while the file adapter is test or sandbox storage. Before the file adapter holds
anything real, make the ticket write atomic or check on read that every ticket has its legs.

**Closed (Phase 26).** The file adapter gained `mutateBatch`: an aggregate write is ONE WAL batch record
(`{"op":"batch","changes":[…]}`), applied whole on replay — a torn line is discarded whole, so the state after a
crash is either everything or nothing, never the half-written aggregate. `saveSportsTicket` (legs first, parent
last), `saveLotteryDrawNumbers` and `saveLotteryTicketLines` (delete + inserts) all use it, and
`test/file_atomicity.test.js` pins the record shape, the torn-tail discard, and the duplicate-id refusal writing
nothing. Found on the way and fixed in the same change (**F-46**): the draw-numbers delete built its key from
`{id}` alone while the table keys by `draw_id|kind|position`, so every replace was a silent no-op and the file
adapter accumulated duplicate number rows per re-save — the same bug family the lottery cron's cleanup found in
the job-run table. Residual, recorded rather than fixed: the LOTTERY ticket create is legacy's TWO repository
calls (ticket, then lines) on both adapters, so the same crash window exists there as always existed in legacy;
there is no line-count column to check on read. If the file adapter ever holds anything real, that path needs
the same single-record treatment first.

### R-31 — An approved ticket is a record, and a reader may take `APPROVED_NOT_EXECUTED` as an order (mitigated)

**Risk.** A person approves a ticket and the status reads as approval. A reader who does not know the engine has no
execution path could take it as instruction to place a bet.

**Mitigation.** The status name says `NOT_EXECUTED`, every decision audit carries `externalExecution: false`, and no
route, table or column reaches a paper, order or broker path. Owner: the slice that adds any execution connector
must revisit this before it lands.

### R-32 — F-39: the port's ticket composition differs from legacy's production behaviour (open, decided)

**Risk.** Legacy's team and competition correlation checks never fire, so two selections that share a team are LOW
and can share a ticket. The port runs the checks as documented, so it refuses some pairs legacy would place. The
ticket a person sees is therefore not the one legacy would have produced for the same day.

**Mitigation.** The difference is pinned by `sports_tickets_parity.test.js` (the pipeline-shaped pair is LOW, the
port-shaped twin HIGH), so it is visible rather than silent. **Decided:** the user chose the documented checks (PHASE18 §9, decision 2). The residual risk is
that tickets differ from legacy's production output, which is the reason for the decision.

Related: F-39, F-40, DV-20, DV-21, DV-22, DV-23, R-29.

