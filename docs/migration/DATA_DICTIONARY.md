# Phase 0 — Data Dictionary & Schema Inventory

**Audit date:** 2026-10-05 · **Audited commit:** `675a05c`
Complete inventory of every database schema in the repository (per master plan §6: "read-only inventory of every MySQL, SQLite, and PostgreSQL schema used by the current applications, plus all migration/seed scripts").

> **Current Node schema addendum (2026-10-11):** The Node workforce platform now
> has migrations 001–008 and 22 tables. Phase 7's paper-trading tables and Phase 8A's
> proposal table are summarized in §§9–10 and their phase records. No migration has
> been executed against a real MySQL/MariaDB server; this remains a schema inventory,
> not a deployment-validation report.

---

## 1. Storage engines at a glance

| Application | Engine | DDL location | Migration tooling | Identifier style |
|---|---|---|---|---|
| AEGIS PHP app (production) | MySQL/MariaDB, InnoDB, `utf8mb4` | `application/database/*.mysql.sql` (8 files) + consolidated `database/production.sql` | `tools/install.php` (idempotent, creates DB + all tables, verifies) | Mixed: `INT AUTO_INCREMENT` (users, roles), composite `VARCHAR` PKs (`strategies(strategy_id,version)`), random `VARCHAR(40)` PKs (proposals, leads `CHAR(32)` hex), `org-<n>` VARCHAR org IDs |
| AEGIS PHP app (dev) | SQLite (`pdo_sqlite`) | `application/database/*.sqlite.sql` (8 files, mirrors MySQL DDL) | Same installer, driver-selected | Same |
| Scout | PostgreSQL 16 (+ Redis 7, operational only: rate limits, locks, not source of truth) | `apps/api/migrations/001-004.sql` | `apps/api/src/migrate.ts` + `bootstrap.ts` (CLI) | **UUIDs** everywhere |
| Football predictions | MySQL/MariaDB, InnoDB, `utf8mb4` | `apps/football-predictions/database/migrations/001_init.sql` | `server/migrate.js` (own DB, `fp_` prefix) | `BIGINT UNSIGNED AUTO_INCREMENT`, real FKs, `CHECK` constraints |

**No versioned migration framework exists anywhere** (no knex/umzug/flyway/CI migrations). Schema changes are raw SQL files; `sports_identity.mysql.sql` is explicitly "kept separate temporarily because existing deployments need an explicit reviewed migration". The Node target must introduce versioned migrations (plan §4) and treat today's DDL files as the baseline snapshot.

---

## 2. AEGIS MySQL schema — 79 tables (canonical: `database/production.sql`)

### 2.0 Cross-cutting column conventions (critical for the Node port)

- **Timestamps are `VARCHAR(32)` ISO-8601 strings** (`gmdate('c')`, e.g. `2026-08-24T00:00:00Z`) — **not** DATETIME. Every table follows this. The Node schema must either keep this (compatibility) or convert to proper `DATETIME(3)`/UTC with a documented, reversible transform. Sorting currently relies on ISO-string lexicographic order.
- **JSON documents are `LONGTEXT`** (`json_encode`/`json_decode` via `Aegis_model` codec — "TEXT for maximum engine compatibility"): strategy params, lifecycle history, proposal intent/checks/risk_decision, audit detail, notification detail, sports payloads, lottery AI decision reports, language feature matrices, etc.
- **Money/quantities use `DECIMAL(18,6)` / `DECIMAL(18,8)`** (good — must be preserved with exact-decimal arithmetic in Node).
- All tables `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`.
- Soft-delete/archive patterns: lottery tickets (archive flag), users (`active` toggle — never deleted).

### 2.1 Identity & access (6) — `application/database/sports_identity.mysql.sql`

| Table | Purpose / notable columns |
|---|---|
| `users` | `id INT AI PK`, `email VARCHAR(190) UNIQUE`, `password_hash VARCHAR(255)` (PHP bcrypt `$2y$10$`), `username`, `user_uid CHAR(6)` (6-digit login ID), `profile_image`, `active`, ISO-string timestamps |
| `roles` / `permissions` | code+name; seeded 7 roles × 10 permissions |
| `user_roles` / `role_permissions` | composite PK join tables |
| `auth_events` | login/logout/security events (`type`, `detail LONGTEXT`, `at`) |

### 2.2 Platform & trading core (15) — `application/database/schema.mysql.sql`

| Table | Purpose |
|---|---|
| `platform_state` | `k/v` JSON state: tradingMode (default `ANALYSIS_ONLY`), killSwitch (default ACTIVE), allowSyntheticPaperData (default false) |
| `strategies` | versioned strategies; composite PK `(strategy_id, version)`; `source` (builtin/ai), `lifecycle` + `lifecycle_history` JSON; 4 builtins seeded DRAFT |
| `backtests` | backtest runs + results (metrics JSON) |
| `analysis_runs` | analysis history incl. agent consensus + debate transcripts |
| `journal_entries` | trade journal (source=paper/manual…), confidence — feeds calibration |
| `paper_accounts` / `paper_orders` / `paper_positions` / `paper_trades` / `paper_deployments` | paper-trading lifecycle; decimals for balances/prices |
| `trade_proposals` | durable execution proposals (`status`, `intent`/`checks`/`risk_decision` JSON, `decision_by`, expiry) |
| `trade_executions` | executed/rejected proposals + broker results (immutable evidence) |
| `audit_logs` | append-only audit trail (actor, action, detail JSON) |
| `notifications` | user notifications with unread dedupe keys |
| `ci_sessions` | CodeIgniter session table (used by dev bridge; production uses files) |

### 2.3 Lead discovery, MySQL edition (11) — also in `schema.mysql.sql`

`lead_organizations` (VARCHAR ids `org-<n>`) · `lead_organization_members` (role owner/member) · `leads` (CHAR(32) hex ids, org-scoped, provider data JSON, status) · `lead_notes` · `lead_activities` (type, detail JSON) · `collections` · `collection_leads` · `search_history` · `duplicate_candidates` · `duplicate_resolutions` · `export_history`.

### 2.4 Sports intelligence (18) — `sports.mysql.sql` (6) + `sports_decisions.mysql.sql` (4) + `sports_intelligence.mysql.sql` (7) + `sports_results.mysql.sql` (1)

`sports_data_sources` (provider registry; only "manual" seeded, disabled) · `sports_provider_health` · `sports_matches` · `sports_odds` · `sports_data_quality_assessments` · `sports_sync_runs` · `sports_model_versions` · `sports_predictions` · `sports_tickets` · `sports_ticket_selections` · `sports_results` · `sports_configurations` (versioned config, seeded SANDBOX/USER_APPROVAL_REQUIRED) · `sports_calibrations` (approve/reject workflow) · `sports_job_runs` (idempotent cron execution keys) · `sports_backtests` · `sports_model_metrics` · `sports_daily_tickets` · `sports_performance_snapshots`. (Index helper: `tools/sports_indexes.php`.)

### 2.5 Language learning (16) — `langlearn.mysql.sql`

`languages` (20 seeded; `features` JSON feature matrix, direction LTR/RTL) · `user_language_profiles` (one per user×language, ownership isolation) · `language_assessments` · `learning_paths` · `learning_modules` · `lesson_attempts` · `study_sessions` · `language_progress` · `conversation_sessions` · `writing_attempts` (original text preserved alongside feedback) · `vocabulary` (seeded banks, 10 words/language) · `user_vocabulary` (SRS stage, due dates, lapse counts) · `listening_attempts` · `speaking_attempts` (empty transcript stored unscored) · `daily_learning_plans` · `ai_learning_recommendations` (evidence-cited).

### 2.6 Lottery intelligence (13) — `lottery.mysql.sql`

`lotteries` (EUROMILLIONS seeded) · `lottery_rules` (5/1-50 + 2/1-12, schedule JSON, versioned) · `lottery_data_sources` (official feed disabled; sandbox provider env-gated) · `lottery_provider_health` · `lottery_draws` (VERIFIED never silently overwritten; source provenance) · `lottery_draw_numbers` · `lottery_sync_runs` · `lottery_combinations` (generated lines + constraints + model version) · `lottery_ai_decisions` (full decision report: model, seed, rules/dataset version, factors) · `lottery_tickets` + `lottery_ticket_lines` (user-scoped, validated, archived; prize amounts never stored) · `lottery_backtests` (mandatory RANDOM_BASELINE; simulated cost/winnings NULL) · `lottery_model_versions` (immutable, never deleted/replaced).

### 2.7 Seed data inside `database/production.sql` (the cPanel import)

`platform_state` (ANALYSIS_ONLY + kill switch ACTIVE) · 4 builtin strategies (DRAFT) · 7 roles + 10 permissions + grants · **initial administrator `admin@example.com` with a committed bcrypt hash** (R-08: must not ship in the Node baseline; the hash is in git history) · admin lead workspace (`org-1`) · sports config + manual data source · EuroMillions lottery + rules + model version v1.0 · 20 languages + vocabulary banks. All inserts are `ON DUPLICATE KEY UPDATE` (re-importable).

### 2.8 SQLite dev mirror

`application/database/*.sqlite.sql` mirror the MySQL DDL for the WASM dev runtime (same tables/columns; SQLite type affinity). The 357-test suite runs entirely on this mirror — it is a second DDL surface that must be kept in sync (a known maintenance cost; the Node port removes the need by testing on real MySQL or a container, but parity fixtures from these tests are the migration oracle).

---

## 3. Scout PostgreSQL schema — 13 tables (`apps/api/migrations/`)

| Migration | Tables |
|---|---|
| `001_lead_discovery.sql` | `organizations` · `users` · `organization_members` (role owner/member/admin) · `leads` · `collections` · `collection_leads` · `lead_notes` · `lead_activities` · `search_history` · `duplicate_candidates` · `duplicate_resolutions` · `export_history` |
| `002_authentication.sql` | (users/orgs auth columns — bcryptjs hashes) |
| `003_refresh_tokens.sql` | `refresh_tokens` (token_hash, expires_at, revoked_at, replaced_by — rotation with reuse detection) |
| `004_operational_indexes.sql` | performance indexes |

Notes: UUID primary keys; `leadPipeline` status enums; Redis holds only operational state (rate limits, locks) — "PostgreSQL is the permanent source of truth" (`.env.example`). Migrations are plain SQL applied by `src/migrate.ts` (no framework).

## 4. Football predictions MySQL schema — 19 tables (`fp_` prefix, own database)

`fp_users` (email, bcrypt hash, role ADMIN/VIEWER, active) · `fp_sessions` (id_hash + csrf_hash + expiry) · `fp_competitions` · `fp_teams` · `fp_fixtures` (kickoff, status, goals) · `fp_bookmakers` · `fp_odds` (DECIMAL(18,12) price, observed_at, payload_hash, UNIQUE quote key, CHECK market='OVER_1_5', CHECK price>1) · `fp_team_form` · `fp_settings` · `fp_model_versions` · `fp_generation` (one immutable UTC-day attempt) · `fp_predictions` · `fp_tickets` (DRAFT/PUBLISHED/UNPUBLISHED; WON/LOST/VOID; original vs settlement odds preserved) · `fp_selections` (price + probability/confidence/risk, fixture & bookmaker snapshots, payload_hash) · `fp_results` (payload_hash) · `fp_sync_logs` · `fp_audit` (JSON detail) · `fp_system_logs` · `fp_provider_cache` (JSON body, expires_at).

Style contrast vs. legacy AEGIS schema: football uses **real `DATETIME(3)`, native `JSON` columns, `ENUM`s, `CHECK` constraints and foreign keys** — i.e., the repository already contains a modern-MySQL reference style that the unified Node schema can follow.

---

## 5. Data-mapping considerations for the Node/cPanel target (inputs to Phase 4)

1. **Timestamp strategy decision (blocking):** legacy VARCHAR-ISO vs. native DATETIME. Any conversion must be reversible and proven by checksums; ISO strings sort lexicographically — replicate or convert consistently.
2. **JSON LONGTEXT columns → MySQL native JSON** is attractive but changes equality/index semantics; document per-table decisions.
3. **Identifier collisions across apps:** three user tables (`users` INT, Scout `users` UUID, `fp_users` BIGINT) and two lead schemas (VARCHAR hex ids vs. UUIDs). Any consolidation needs permanent ID mapping tables with proven FK verification (plan §6).
4. **Two lead schemas are NOT identical in coverage:** Scout adds `refresh_tokens`; the MySQL edition has no token table (session auth). Column-level diff is required before choosing a survivor.
5. **`ci_sessions` and `fp_sessions`** are runtime session stores — do not migrate; cut over with fresh sessions.
6. **Encrypted/secret columns:** password hashes (bcrypt `$2y$` PHP / bcryptjs Scout / football bcrypt) — migrate verbatim, rehash to Argon2id on first login in the Node app (never store plaintext, never break existing logins). No application-level encrypted columns were found in DDL (secrets live in `.env`).
7. **Provenance flags that must survive import untouched:** `provenance.synthetic` in analysis/paper data, lottery draw `source` + VERIFIED status, sports provider data, `allowSyntheticPaperData` platform flag (keep false).
8. **Idempotency keys:** lottery/sports job execution keys, proposal duplicate keys, `ON DUPLICATE KEY UPDATE` seeds — importer must be re-runnable.
9. **collations:** everything is `utf8mb4`; watch `VARCHAR(190)/(191)` UNIQUE index length limits on older MySQL (already respected).
10. **Backups:** `database/production.sql` is both schema and seed snapshot (2026-08-24 era for the zip copy; the repo copy is current) — treat as **reference seed**, not as a production-data backup; production data lives only on the cPanel host.

## 6. Node platform schema — `wf_*` (added by Phases 1–3; canonical: `apps/workforce-platform/src/db/migrations/`)

Recorded here because it is now part of the repository's data surface. It is **isolated**: every
table is `wf_`-prefixed, additive, and no migration touches a legacy table, so PHP keeps reading
and writing the 79-table schema unchanged during coexistence (R-18).

Conventions, deliberately different from §2.0: native `DATETIME(3)` UTC instead of
`VARCHAR(32)` ISO strings; native `JSON` (`detail_json`) instead of `LONGTEXT`; real foreign
keys with `ON DELETE SET NULL` for actors; `BIGINT UNSIGNED AUTO_INCREMENT` identifiers;
`utf8mb4` / `utf8mb4_unicode_ci`; `VARCHAR(190)` for indexed emails. Versioned, checksummed,
ordered migrations applied by `npm run migrate` and tracked in `wf_schema_migrations`;
`readiness()` reports `schema:false` until all five are present, so `/api/v1/health/ready`
stays 503 on a partial schema.

| Table | Migration | Purpose / notes |
|---|---|---|
| `wf_schema_migrations` | 001 | Applied-migration ledger with checksums; the migrator refuses a changed checksum |
| `wf_users` | 001 (+003 index) | Accounts. `password_hash` holds imported PHP `$2y$` digests verbatim (`bcryptjs` verifies them); `legacy_uid` carries the 6-digit UID for login parity; status toggling, never deletion |
| `wf_roles`, `wf_permissions`, `wf_user_roles`, `wf_role_permissions` | 001, seeded by 003 | The legacy RBAC vocabulary: 8 roles / 14 permissions including `system.super_admin`. `src/db/platform-baseline.js` seeds the same matrix for adapters without migrations (the file store), and a test asserts the SQL and the code agree key for key |
| `wf_sessions` | 001 (+003 `device_label`, index) | Opaque **hashed** server-side sessions (no JWT), expiry, revocation, rotation; `device_label` supports the session list |
| `wf_audit_events` | 001 (+003 index) | Audit trail: `actor_user_id` nullable (public contact intake audits with `NULL`), `action_key`, `entity_type`/`entity_id` as `VARCHAR`, `detail_json JSON` |
| `wf_user_profiles` | 002 | Display name, profile image path, last-login — separated from `wf_users` so identity import stays one-shot and reversible |
| `wf_data_imports` | 002 | Single-use import ledger for the legacy identity importer (dry-run first; never executed against production data) |
| `wf_contact_inquiries` | **004 (Phase 3)** | Public contact intake: unique 26-char ULID `reference`, `name`/`email`/`message` (10–2 000 chars, refused rather than truncated), `client_fingerprint CHAR(64)` = HMAC-SHA256 of the client address keyed with `SESSION_SECRET` (**no raw IP is stored**), `user_agent`, `request_id`, `status` (`new`) with `handled_by`/`handled_at` for a future queue, indexes on `created_at` and `(status, created_at)`. The legacy platform stored a contact submission **only** as an audit entry; this is the working copy, written *alongside* the `CONTACT_INQUIRY` audit event. Retention/purge is undecided — see R-22 |

**Phase 4 (market data) added no table and no migration.** The module persists exactly one kind of
record, through the existing repository contract: a `wf_audit_events` row with
`action_key = 'marketData.provider.fallback'`, `actor_user_id = NULL` (the platform, not a user, is the
actor), `entity_type = 'market_data'`, `entity_id = <SYMBOL>` and `detail_json`
`{legacyAction: "PROVIDER_FALLBACK", message, symbol, marketClass, timeframe, failed[], used, synthetic}`.
`message` reproduces the legacy wording verbatim
(`` `BTCUSDT`: providers [binance] failed — falling back to synthetic-demo ``) and `legacyAction` keeps the
legacy action name addressable, so an audit query written against the PHP platform still finds these rows
after cutover. Candles, quotes, provider health, circuit-breaker state and the TTL caches are **in-process
only** — nothing market-data-shaped is written to disk, and no cache survives a restart (finding F-24: that
also means each Passenger worker keeps its own view of provider health).

## 7. Node platform schema — analysis runs (Phase 5; `005_analysis_runs.sql`)

One table, additive, no legacy table touched.

| Table | Migration | Purpose / notes |
|---|---|---|
| `wf_analysis_runs` | **005 (Phase 5)** | One row per completed analysis run. `id CHAR(36)` (a `crypto.randomUUID()`, so re-running a symbol never collides with a legacy numeric id); summary columns `symbol VARCHAR(24)`, `timeframe VARCHAR(5)`, `bias VARCHAR(10)`, `confidence DECIMAL(5,4)`, `regime VARCHAR(20)`, `recommendation VARCHAR(10)`; provenance promoted to columns `synthetic TINYINT(1)` and `source VARCHAR(40)`; `completed_at VARCHAR(32)`; `payload LONGTEXT`; indexes `ix_wf_analysis_runs_completed (completed_at)` and `ix_wf_analysis_runs_symbol (symbol, completed_at)` |

**Why this table breaks the §6 conventions, deliberately.** §6 records that the Node schema uses native
`DATETIME(3)` instead of `VARCHAR(32)` ISO strings and native `JSON` instead of `LONGTEXT`. Migration 005
uses `VARCHAR(32)` and `LONGTEXT` anyway, for two reasons:

1. The summary columns **are an API payload** — `GET /api/v1/analysis/history` returns them field for
   field — and the legacy `analysis_runs` table typed them this way. Retyping `completed_at` as
   `DATETIME(3)` would change the string a caller receives (no `Z`, no milliseconds in some drivers) and
   break the parity claim for a cosmetic gain.
2. History is ordered by `completed_at`. ISO-8601 **UTC** strings sort chronologically as plain text, which
   is what both adapters rely on. That holds only while every writer uses one format, so this column must
   never be fed a legacy `+00:00` offset string and a Node `Z` string in the same table; the Node platform
   writes only its own.

`payload` holds the entire run — agents, debate transcript, scenarios, setup, risk decision, provenance and
validation — as the audit copy of what the caller was shown, so a run can be re-read years later without
re-deriving it from market data that no longer exists.

**Retention (R-27, closed by the Phase 5 hardening pass).** That payload is also why this table needed a
retention policy: it is `LONGTEXT` per row, a consensus scan writes 7–10 rows per call, and nothing else in
the platform deletes a row. The policy is `ANALYSIS_RETENTION_DAYS` (default **90**; `0` keeps rows forever,
which is the pre-R-27 behaviour) and the mechanism is `tools/prune-analysis-runs.mjs` /
`npm run prune:analysis`, backed by `pruneAnalysisRuns(beforeIso, {dryRun, batchSize, maxBatches})` on
**both** adapters — repository contract **35 → 36**.

The answer to "is a run an audit record or operational data?" is now explicit: **an audit record while it is
inside the retention window, operational data after it.** Consequently retention is an operator decision
taken outside a request, and **there is deliberately no HTTP route that can delete analysis history** — a
test asserts the module registers no `DELETE` verb. A session-scoped API with a delete verb over the audit
copy of what a user was shown is not a trade worth making.

Two implementation constraints follow from the schema choices above, and both are enforced in code rather
than left as comments:

1. **`completed_at` is compared as text**, so the cutoff must be the canonical `…Z` form. A `+00:00` offset
   string sorts *after* the `Z` form of the same instant, which would silently delete the wrong rows rather
   than fail. Both adapters therefore share one guard, `assertIsoCutoff` in `src/persistence/contract.js`,
   and refuse anything non-canonical **before** a query runs.
2. **MySQL deletes in bounded, ordered batches** (default 500 rows per statement, ceiling 5 000) with
   `ORDER BY completed_at ASC`, because a single `DELETE` matching a year of runs would hold locks and grow
   the undo log on a shared host, and `DELETE … LIMIT` without an order is non-deterministic — which
   statement-based replication logs as unsafe. The query uses `ix_wf_analysis_runs_completed`. It reports
   `exhausted: false` if the batch ceiling is reached with rows still matching, rather than implying the job
   finished. The file adapter deletes row-by-row through the log's existing `delete` op, so the write-ahead
   log format, its replay and `compact()` are unchanged.

A dry run is the default and reports the matching count, the oldest and newest affected `completed_at`
values and the reclaimable payload bytes (`SUM(LENGTH(payload))`) before anything is deleted.

Because `db/pool.js` sets `decimalNumbers: false`, `confidence` comes back from MySQL as a *string*;
`src/db/analysis-repository.js` converts at the boundary (`Number(row.confidence)`) so both adapters return
a number. Writes are a single `ON DUPLICATE KEY UPDATE` upsert, and the file adapter mirrors it — pinned by
a test, because re-running a symbol must update the row rather than duplicate it.

This table accounts for **four** of the contract's 36 methods: `saveAnalysisRun`, `listAnalysisRuns`,
`findAnalysisRun` and `pruneAnalysisRuns`. Reads are bounded (`limit` 1–100, summaries carry **no**
payload), so history stays cheap even on a large table; the only way to shrink it is the CLI above.

**Audit rows written by this phase** (existing `wf_audit_events`, no schema change). All six actions use
`entity_type = 'analysis_run'` and `entity_id = <run id>` — including the risk decision, which is an
attribute of a run rather than its own entity — and all six carry `actor_user_id` = the signed-in account,
because analysis is a user action (unlike `marketData.provider.fallback`, where the platform is the actor
and the column is `NULL`).

| `action_key` | `legacyAction` in `detail_json` | Written when |
|---|---|---|
| `analysis.run.completed` | `TRADE_ANALYZED` | every run; also carries `symbol`, `timeframe`, `marketClass`, `regime`, `bias`, `confidence`, `recommendation`, `source`, `synthetic`, `stale` |
| `analysis.signal.proposed` | `SIGNAL_GENERATED` | a trade setup survived the debate; carries `action`, `entry`, `stopLoss`, `takeProfit`, `riskReward` |
| `analysis.signal.none` | `NO_SIGNAL` | no setup — mutually exclusive with the row above |
| `risk.decision.rejected` | `RISK_REJECTED` | a proposal was vetoed; carries `approved:false`, `reasons[]`, `warnings[]` |
| `risk.decision.approved` | `RISK_APPROVED` | a proposal cleared every risk gate. Phase 5 documented this as unreachable while the kill switch had no control route; Phase 7 persists a `trading.control` kill-switch release, after which an analysis proposal may return this decision. It is risk clearance, not execution authorization: analysis remains account-agnostic and proposal-only, paper orders require `PAPER_TRADING` and are rechecked against the owned account portfolio, and no live-order route exists. See [`PHASE7_PAPER_TRADING.md`](PHASE7_PAPER_TRADING.md). |
| `analysis.agent.failed` | `TRADE_REJECTED` | an agent threw; carries `agent` and `error`. The run continues without that agent |

Keeping `legacyAction` in `detail_json` means an audit query written against the PHP platform still finds
these rows after cutover. The `message` strings reproduce the legacy wording
(`BTCUSDT 1h: NEUTRAL @ 0.27 confidence`, `ETHUSDT BUY setup proposed (R:R 2.5)`,
`EURUSD setup rejected by Risk Engine`, `EURUSD 1h: no tradeable setup`).

The file adapter (`STORAGE_ADAPTER=file`) implements the same 35-method repository contract over
an append-only JSONL log, so every table above has a non-MySQL shape used by tests and local
rehearsal; it is refused in production unless `ALLOW_FILE_STORE_IN_PRODUCTION=1`.

**Not verified against a real server:** no migration in this set — including 004 — has ever been
applied by a MySQL/MariaDB instance in this sandbox (F-15). The DDL is unit-checked and
checksum-verified by the migrator against a fake pool only.

— End of Phase 0 data dictionary.

## 8. Node platform schema — Strategy Lab (Phase 6; `006_strategies.sql`)

Three tables, mirroring the legacy `strategies`, `backtests` and `journal_entries`
column for column, because those rows are what a lifecycle gate reads and what an
API payload returns. Platform table count **12 → 15**, all three picked up
automatically by `tablesFromMigrations()`.

| Table | Key | Notes |
|---|---|---|
| `wf_strategies` | **composite** `(strategy_id, version)` | The version is part of the key, not a column on a surrogate row, so a backtest cites the exact code it ran. `market_classes`/`timeframes`/`params`/`lifecycle_history` are JSON in `LONGTEXT` (not MySQL `JSON`) so they survive a `mysqldump` round trip on shared hosting. `source ∈ builtin\|manual\|ai`; `lifecycle ∈ DRAFT\|BACKTESTED\|VALIDATED\|RISK_REVIEWED\|PAPER_TRADING\|APPROVED\|RETIRED` |
| `wf_backtests` | `id CHAR(36)` | `strategy_id`/`strategy_version`/`symbol`/`timeframe`/`synthetic` **plus** `candles`/`metrics`/`warnings` are denormalised out of `payload` so a listing and the two gate queries never open a `LONGTEXT` blob (DV-11). `trades` and `equityCurve` stay inside it, read only by the detail route |
| `wf_journal_entries` | `id CHAR(36)` | `source ∈ backtest\|manual\|paper\|live`. Twelve `DECIMAL` money/ratio columns — the pool runs `decimalNumbers: false`, so **both adapters convert them to numbers at their boundary**; the approval gate sums `pnl` and divides gross win by gross loss, and `"-3.00" > 0` is a lexicographic comparison that gives the right answer for the wrong reason |

Timestamps are `VARCHAR(32)` holding canonical ISO-8601 UTC (`…Z`), as
`wf_analysis_runs` already does: legacy rows are VARCHAR ISO strings so an import
needs no conversion, and `latestStrategyBacktest` plus the journal listing order by
them, which is only chronological while every writer uses one format (**DV-2**).

`wf_journal_entries.backtest_id` is deliberately **not** a foreign key — a legacy
import writes journal and backtest rows in separate passes, and an FK would make
import order load-bearing. `tools/verify-data.mjs` enforces it instead, on both
adapters, and can report an orphan rather than refuse the row. `paper_position_id`
is reserved for row 10 (paper trading); nothing in this migration writes it, but
legacy rows carry values and dropping the column would lose them on import.

Retention for `wf_backtests` (R-28) is implemented in Phase 42 and **guarded**:
`BACKTEST_RETENTION_DAYS` is `0` (keep forever) by default, and when a window is set the
prune never deletes the newest report for a `(strategy_id, strategy_version)` pair — that
row is excluded from both the measurement and the `DELETE`, so `countBacktests(...) > 0`
and `latestBacktest(...)` cannot be changed by retention. Only canonical ISO-8601 text
timestamps are compared, so a malformed import row is never sorted into the delete set.

---
### Retention policy over the four evidence tables (row 5, Phase 42)

One operator command applies every window — `tools/prune-retention.mjs` /
`npm run prune:retention` — with a dry run by default and no HTTP route that can delete a row:

| Table | Window | Default | Guard |
|---|---|---|---|
| `wf_analysis_runs` | `ANALYSIS_RETENTION_DAYS` | 90 | R-27's original rule: strictly older than the cutoff, canonical ISO text |
| `wf_notifications` | `NOTIFICATION_RETENTION_DAYS` | 0 (keep forever) | only rows already **read**; unread alerts are a to-do item and a dedupe key |
| `wf_backtests` | `BACKTEST_RETENTION_DAYS` | 0 (keep forever) | newest report per `(strategy, version)` is never deleted |
| `wf_audit_events` | `AUDIT_RETENTION_DAYS` | 0 (keep forever) | `DATETIME(3)`, compared as a bound UTC instant; deleting an event is a deliberate act and the CLI says so |

The two text-timestamp tables (`wf_notifications`, `wf_backtests`) are compared with a
`LIKE '____-__-__T__:__:__%'` shape guard on MySQL and the equivalent in the file adapter:
text order is chronological only while every writer uses the canonical form (see migration 006's
note), and a `11/07/2026` row would otherwise sort before every `2026-…` string and be deleted
as "oldest". Measurement and deletion share one predicate in all four methods, and each report
carries `matching`, `deleted`, `oldest`, `newest`, `bytes`, `batches` and `exhausted`.


---

## 9. Node platform schema — Paper Trading and persisted risk controls (Phase 7; `007_paper_trading.sql`)

Migration 007 adds six tables to the Phase-6 Node schema (15 → 21 tables) and
makes three additive `ALTER TABLE` changes. These structures are for simulation-only execution;
there is no broker foreign key or live-order route.

| Table | Key / ownership | Purpose and important fields |
|---|---|---|
| `wf_trading_state` | `state_key` singleton (`global`) | `state_json` stores trading mode, kill switch, synthetic-paper setting and risk limits; `updated_by_user_id` / `updated_at` preserve the last control actor/time. Migration seeds `ANALYSIS_ONLY`, active kill switch and synthetic input denied. |
| `wf_paper_accounts` | `BIGINT UNSIGNED` id; `owner_user_id` FK to `wf_users` | Owner-private account, currency, starting/current balance, peak equity and revision counter. Owner index supports scoped listings. |
| `wf_paper_orders` | `BIGINT UNSIGNED` id; account FK | Market/limit request, side, units, protection, state, rejection reason, strategy reference and `synthetic` flag. |
| `wf_paper_positions` | `BIGINT UNSIGNED` id; account FK | Simulated position, mandatory stop/target, entry/exit values, realized P&L, strategy reference and synthetic provenance. |
| `wf_paper_trades` | `BIGINT UNSIGNED` id; account/order/position FKs | Append-only entry/exit legs, price, units, fee, timestamp and synthetic-data flag. Closed-position journal evidence is created from these fills. |
| `wf_paper_deployments` | `BIGINT UNSIGNED` id; account and composite strategy-version FKs | Active/inactive executable strategy deployment per owned paper account, with symbol, market class, timeframe and last evaluation/signal. |

The additive alterations preserve strategy provenance and foreign-key width:

- `wf_strategies.human_signoff LONGTEXT NULL` stores the one-time attributed
  reviewer decision for an AI-sourced version. `source: "ai"` is never rewritten;
  the separately permissioned sign-off does not itself advance lifecycle.
- `wf_journal_entries.synthetic TINYINT(1) NOT NULL DEFAULT 0` makes synthetic
  provenance queryable. The strategy approval query excludes synthetic paper
  trades from live-approval evidence.
- `wf_journal_entries.paper_position_id` is widened from the Phase-6 `INT` to
  `BIGINT UNSIGNED` to match paper position identifiers.

All account, order, position, trade and deployment reads/writes are owner-scoped
at the service layer; SQL child-list queries also join accounts and bind the owner
ID. The MySQL mutation path uses a pinned transaction and `SELECT … FOR UPDATE`;
the file adapter serializes a WAL batch but is a single-process development
adapter, not production multi-worker storage.

Migration 007 is statically parsed and its repository SQL is tested with a
recording fake pool only. It has **not** been executed on a real MySQL/MariaDB
server, and no cPanel validation is claimed. Full details and safety constraints:
[`PHASE7_PAPER_TRADING.md`](PHASE7_PAPER_TRADING.md).

---

## 10. Node platform schema — Execution proposal workflow (Phase 8A; `008_execution_supervisor.sql`)

Migration 008 adds one table to the current Node schema (21 → 22 tables). It stores
paper-proposal state only; it defines no broker account, broker ticket, live order,
execution bridge or automation record. The table exists to preserve the owner-scoped,
human-reviewed lifecycle and its paper-order reference.

| Table | Key / ownership | Purpose and important fields |
|---|---|---|
| `wf_execution_proposals` | `proposal_id CHAR(36)`; owner FK; paper-account FK; nullable decision-user and paper-order FKs | Intent/check/result JSON; status; explicit decision actor/reason/time; optional Paper Trading order ID; created/updated timestamps. Indexes serve owner/status and paper-account/status listings. |

Repository reads and all transition writes bind both `owner_user_id` and the
paper account's owner. The SQL adapter uses compare-and-set status updates for
approval, expiry, one-time paper submission claim and finalization. The file adapter
uses the existing serialized WAL transaction for local development. The service
calls the Phase-7 Paper Trading method after approval, so that service repeats its
current mode/kill-switch, market-data, account and RiskEngine checks; the proposal
record cannot bypass those gates.

The stored result preserves synthetic provenance. This is not a source of live-
approval evidence, and no proposal method can create a live/broker order. An
interrupted `PAPER_SUBMITTING` attempt is not automatically retried: at-most-once
claiming intentionally favors avoiding duplicate paper submissions over automatic
recovery. Broader execution-supervisor steps and host validation are still
incomplete. See [`PHASE8_EXECUTION_PROPOSALS.md`](PHASE8_EXECUTION_PROPOSALS.md).

Migration 008 and repository SQL are currently covered by static migration checks
and recording-fake SQL assertions. Real MySQL/MariaDB and cPanel/Passenger execution
have not been performed.

## 11. Node platform schema — scheduled-job locks (Phase 12; `010_job_locks.sql`)

> Numbering note: migration `009_notifications.sql` (`wf_notifications`) was documented in
> [`PHASE9_NOTIFICATIONS.md`](PHASE9_NOTIFICATIONS.md) rather than here, so this section
> continues from §10 (migration 008) with migration **010**. The platform table count is
> **24**: 23 before Phase 12, plus `wf_job_locks`.

| Table | Columns | Purpose |
|---|---|---|
| `wf_job_locks` | `job_name` VARCHAR(64) **PK**, `holder` VARCHAR(120), `acquired_at` VARCHAR(32), `expires_at` VARCHAR(32); `KEY ix_wf_job_locks_expiry (expires_at)` | One row per named scheduled job, holding mutual exclusion between overlapping cron runs |

`job_name` is the primary key **because the primary key is the arbiter**: two concurrent
acquirers both attempt an `INSERT` and the loser receives a duplicate-key error. Any
`SELECT`-then-`INSERT` sequence would be a check-then-act race, which is the one thing a
lock must not be. `ix_wf_job_locks_expiry` exists for the single read that is not by
primary key — finding wedged or long-expired locks when an operator asks why a job has
not run.

Timestamps are VARCHAR(32) canonical UTC (`…Z`), matching migrations 007, 008 and 009.
Fixed-width canonical instants compare correctly as strings, so `expires_at <= ?` needs no
timezone conversion and cannot be reordered by a host `time_zone` setting — the same
reasoning as divergence AV-2. The repository **refuses an offset form** (`+00:00`, which
PHP's `gmdate('c')` emits) on both adapters, because `+00:00` sorts *after* the `Z` form of
the same instant: a mixed-format `expires_at` would read as still live after expiring and
two runs would overlap.

`holder` is free text an operator can read in a cron log — the CLI writes `cron#<pid>`
unless `--holder` names the worker. Release and extend are scoped by `AND holder = ?`, so a
run whose lock expired and was taken over cannot delete the new holder's row on its way out.

**This table stores no business data.** It coordinates work and never authorises any of it:
no column here can reach an account, an order, a proposal or a permission. Additive only —
migration 010 alters no existing table and seeds no row, because a lock that exists before
any job runs would block the first run.

Job *state* is not stored here. The portfolio-risk monitor's transition memory lives in the
existing `wf_trading_state` table under `state_key = 'portfolio-risk'` — the same table
legacy used for its platform state — and the job repository refuses the `'global'` key
outright on both adapters, so a cron run cannot rewrite the kill switch (divergence SJ-4).

Real MySQL/MariaDB execution has not been performed: mutual exclusion is tested on the file
adapter and the SQL shapes, bindings and bounds against a recording executor (finding F-15).
See [`PHASE12_SCHEDULED_JOBS.md`](PHASE12_SCHEDULED_JOBS.md).

## 12. Node platform schema — Sports Intelligence data foundation (Phase 16; `011_sports_foundation.sql`)

> The platform table count is **31**: 24 before Phase 16, plus the seven `wf_sports_*`
> tables below. Migration `011` was drafted in Phase 15 and **removed from that change**,
> because tables nothing reads or writes are dead schema: they cost a host a migration and
> four pinned counts in the test suite and buy nothing until the repository that fills them
> exists. They land here, in the same change as that repository.

| Table | Key columns | Purpose |
|---|---|---|
| `wf_sports_data_sources` | `id` **PK** AI, `provider_code` VARCHAR(64) **UNIQUE**, `display_name`, `enabled` TINYINT **default 0**, `created_at`, `updated_at` | One row per data vendor. The provenance key every other table here points at |
| `wf_sports_provider_health` | `id` **PK** AI, `provider_id`, `status` VARCHAR(32), `response_ms`, `error_rate` DECIMAL(8,5), `rate_limit_remaining`, five `last_*_at` instants, `data_freshness_seconds`, `records_received`, `invalid_records`, `missing_fields` LONGTEXT (JSON), `observed_at`; `KEY (provider_id, observed_at)` | One row per health **observation**. Append-only, so an outage is a gap rather than an overwritten row |
| `wf_sports_matches` | `id` **PK** AI, `provider_id` + `external_id` VARCHAR(128) **UNIQUE together**, `sport`, `competition`, `home_team`, `away_team`, `kickoff_at`, `status`, `source_timestamp`, `payload` LONGTEXT (JSON), `created_at`, `updated_at`; `KEY (kickoff_at)`, `KEY (status)` | One row per provider per fixture. `external_id` is scoped by provider, not globally unique |
| `wf_sports_odds` | `id` **PK** AI, `match_id`, `provider_id`, `market` VARCHAR(96), `selection` VARCHAR(160), `decimal_odds` DECIMAL(12,6), `observed_at`, `payload`; `KEY (match_id, market, observed_at)`, `KEY (provider_id, observed_at)` | One row per odds **observation at an instant**. Deliberately no unique key on (match, market, selection) |
| `wf_sports_results` | `id` **PK** AI, `match_id` + `provider_id` **UNIQUE together**, `home_score` INT **NULL**, `away_score` INT **NULL**, `status`, `verified` TINYINT **default 0**, `source_timestamp`, `verified_at` **NULL**, `payload`; `KEY (match_id, verified)` | One stored outcome per provider per fixture |
| `wf_sports_data_quality_assessments` | `id` **PK** AI, `match_id`, `score` INT, `band` VARCHAR(16), `freshness_score`, `provider_reliability_score`, `eligible_prediction`, `eligible_ticket`, `missing_fields` (JSON), `checks_payload` (JSON), `assessed_at`; `KEY (match_id, assessed_at)` | One row per assessment. Append-only |
| `wf_sports_sync_runs` | `id` VARCHAR(36) **PK** (caller-supplied UUID), `provider_id` **NULL**, `job_type` VARCHAR(48), `status` VARCHAR(24), `started_at`, `ended_at` **NULL**, `records_processed`, `records_created`, `records_updated`, `errors` LONGTEXT (JSON), `execution_key` VARCHAR(128) **UNIQUE**; `KEY (job_type, started_at)` | One row per ingestion attempt, opened **before** the work starts |

**Three design decisions carry the most weight, and all three are about not collapsing rows
that mean different things.**

An **odds row is an observation at an instant, never a current price.** There is no unique key
on `(match_id, market, selection)`, and `latestSportsOdds` / `findSportsOddsBefore` are
queries rather than columns. Point-in-time backtesting (slice 5) depends on it: a table that
overwrote in place could not answer "what did we know then", and a backtest that used a price
observed *after* kickoff would be lookahead.

**Health is a series, not a value.** Append-only, so the monitor derives from the newest N and
an outage shows up as a gap. `observed_at` is stamped by the repository rather than taken from
the payload, because it records when *this platform* saw the report and a provider's own clock
is not authoritative for staleness.

**A result's `verified` flag is not set by ingestion.** Ingestion reports; a human verifies,
through a separate step behind `sports.settle` that does not exist yet (slice 5). Re-ingesting
a result **clears** the flag and `verified_at` (divergence SP-14) — a provider that changes a
scoreline invalidates the attestation made about the old one, so the safe direction is to
require a human to look again. Scores are nullable and are non-null only for `FINISHED`:
`NULL` means "no score was reported", which is a different fact from "no goals were scored",
and writing `0-0` for a postponed match would fabricate a scoreline.

**Timestamps are VARCHAR(32) canonical UTC with milliseconds always present** (divergence
SP-19), matching migrations 007–010 and divergence AV-2. Fixed-width canonical instants compare
correctly as strings, so `kickoff_at >= ?` — which `listSportsMatches` really does issue as a
string comparison — needs no timezone conversion and cannot be reordered by a host `time_zone`
setting. The fractional part is never trimmed: `"…T12:34:56.789Z"` sorts *before*
`"…T12:34:56Z"` because `.` is 0x2E and `Z` is 0x5A, even though it is 789 ms later, so one
width is what makes text ordering chronological. An *input* carrying an explicit offset is
parsed and normalized rather than refused (SP-26), unlike `wf_job_locks`, whose callers are
internal and must already be canonical. `test/sports_store.test.js` asserts the invariant by
measuring the lengths of nine stored instants.

`execution_key` is the idempotency arbiter, on the same reasoning as `wf_job_locks.job_name`:
the constraint is the guarantee, not a `SELECT` followed by an `INSERT`. A cron job that fires
twice for one window, or a retry after a timeout, cannot ingest the same data twice, and the
loser reports `DUPLICATE_SKIPPED` rather than throwing (divergence SP-12 — legacy checked and
then inserted without catching the collision).

`wf_sports_sync_runs.id` is a **caller-supplied UUID** rather than an auto-increment, because
the row has to exist before the work starts so that a crash mid-sync still leaves evidence of
the attempt. A row left in `RUNNING` is exactly that evidence. Its `errors` array holds each
refusal message truncated to 200 characters: a run that processed 40 records and stored 38 must
be able to say what the other two were and why, because counting them without naming them hides
the reason. **This table had no reader in legacy at all** (finding F-35) — `startSync` and
`finishSync` wrote it and nothing in `application/` selected from it, so run evidence was
recorded into a table no operator could query. `listSportsSyncRuns` has no legacy counterpart
(SP-15) and is what makes both this table readable and `ProviderHealthMonitor` reachable.

Provider and match ids are plain integers rather than foreign keys, for the reason migration 010
gives for avoiding `GET_LOCK()`: the file adapter must implement the identical contract, and it
has no referential engine. `missing_fields`, `checks_payload`, `errors` and `payload` are JSON
in a LONGTEXT column, decoded by both adapters on every read path (divergence SP-17 — legacy
decoded `missing_fields` on one health read path and not the other, so the same column had two
shapes depending on which method fetched it).

**No column in this migration names a stake, a wager, a payout or a bookmaker account**, and
there is no foreign key to any trading, order, position or broker table. This schema stores
observed sporting data and the evidence of how it was obtained. It cannot authorise or record a
bet. Additive only: migration 011 alters no existing table and seeds no row.

**Absent, and owed by slices 3–5:** `wf_sports_model_versions`, `wf_sports_predictions`,
`wf_sports_tickets`, `wf_sports_ticket_selections`, `wf_sports_configurations`,
`wf_sports_calibrations`, `wf_sports_job_runs`, `wf_sports_backtests`, `wf_sports_model_metrics`,
`wf_sports_daily_tickets`, `wf_sports_performance_snapshots`. No prediction, ticket or settlement
can be produced from this schema, which is the point: the honesty of the slice is visible in what
it cannot express.

Real MySQL/MariaDB execution has not been performed (finding F-15): behaviour is proven on the
file adapter, and the SQL shapes, bound parameters, `ON DUPLICATE KEY UPDATE` upserts and
`LIMIT` bounds against a recording executor.
See [`PHASE16_SPORTS_PERSISTENCE.md`](PHASE16_SPORTS_PERSISTENCE.md).

## 13. Node platform schema — Sports Intelligence decision chain (Phase 17; `012_sports_intelligence.sql`)

> The platform table count is **35**: 31 before Phase 17, plus the four tables below. Migration
> `012` is the decision chain. Its tables are written only by `SportsIntelligenceService`, and
> `wf_sports_predictions` is insert-only.

| Table | Purpose | Keys and constraints that carry meaning |
|---|---|---|
| `wf_sports_model_versions` | The registry of model identities. A decision names the version it used. | `UNIQUE (model_name, model_version, feature_version, calibration_version)`. The uncalibrated state is `calibration_version = ''`, not NULL, because a UNIQUE key treats NULLs as distinct. |
| `wf_sports_predictions` | One immutable decision per evaluation: the raw and calibrated probability, implied probability, expected value, confidence, risk, correlation, the data-quality score, the verdict and the gate's **full** rejection list. | `id` is `prd_` plus 24 lower-case hex digits. `correlation` defaults to `UNKNOWN` (SP-32). `rejection_reasons` and `factors` are JSON in `LONGTEXT`. No update or delete path (SP-31). |
| `wf_sports_configurations` | Versioned engine configuration. Rows are appended, never changed. | `UNIQUE (version)`. A lost race returns `null`, mapped to 409 (SP-29). `engine_mode` never accepts `AUTOMATED_EXECUTION` from a request (DV-14). |
| `wf_sports_calibrations` | Fitted calibrations, with their status and who decided them. | `method` is `platt` or `identity` (F-37). `status` is `PENDING`, `APPROVED` or `REJECTED`. Decisions are compare-and-set on PENDING (SP-28). `approved_by` and `approved_at` are stamped on a rejection too (SP-27). |

Cross-table references. `wf_sports_predictions` refers to a fixture in `wf_sports_matches` and to a row in
`wf_sports_model_versions`. Migration 012 declares **no foreign keys**, so the intelligence service checks that the
fixture exists before it writes a decision (404 otherwise, `intelligence-service.js`). The database does not enforce
these references.

See [`PHASE17_SPORTS_DECISION_CHAIN.md`](PHASE17_SPORTS_DECISION_CHAIN.md) §5.

## 14. Node platform schema — Sports Intelligence tickets (Phase 18; `013_sports_tickets.sql`)

> The platform table count is **38**: 35 before Phase 18, plus the three tables below. Migration `013` is the
> ticket engine. Its tables are written only by the ticket service (`ticket-service.js`, through the repository), and no column in
> them names a stake that is sized, a wager, a payout, a bookmaker account or an order. A ticket records what was
> proposed and who decided it. It cannot record whether it won, because settlement is slice 5.

| Table | Purpose | Keys and constraints that carry meaning |
|---|---|---|
| `wf_sports_tickets` | One recorded combination. | `id` VARCHAR(40) **PK**, `tkt_` plus 16 hex, generated before the insert. `status` is `PENDING` until a person decides, and the engine never writes `APPROVED` (DV-22). `approval_status` is `PENDING_USER_APPROVAL`, `APPROVED_NOT_EXECUTED` or `REJECTED`. `settlement_status` is `PENDING`. `stake` is the configured stake, copied, not sized. `confidence` is NULL when no leg had a measured confidence. |
| `wf_sports_ticket_selections` | One leg of a ticket, linked to its prediction by id. | `id` **PK** AI. `ticket_id` and `prediction_id` are indexed. `result` is NULL until settlement decides it. `correlation_reasons` is a JSON array of the pairwise reasons. |
| `wf_sports_daily_tickets` | One daily run, per UTC day and configuration version. | `id` **PK** AI. `UNIQUE (run_date, configuration_version)`: the claim is an insert on this key. `status` is `RUNNING`, then `NO_QUALIFIED_TICKET` (also the status of a run that throws, with the error in `message` and `errors`, DV-23) or `PENDING_USER_APPROVAL`. `DUPLICATE_SKIPPED` is never stored. `simulated_refused` counts candidates excluded for being simulated (DV-20). |

Cross-table references are by convention. `wf_sports_ticket_selections.ticket_id` refers to `wf_sports_tickets`,
`prediction_id` to `wf_sports_predictions`, and `wf_sports_daily_tickets.ticket_id` to `wf_sports_tickets`. Migration
013 declares **no foreign keys**. The repository writes a ticket and its legs in one transaction on MySQL, and the
file adapter does not (R-30).

Timestamps are canonical UTC strings. Probabilities and odds are `DECIMAL`. JSON-shaped fields are `LONGTEXT`.

**Still absent, owed by slice 5:** any settlement or result column on a ticket or leg, `wf_sports_backtests`,
`wf_sports_model_metrics` and `wf_sports_performance_snapshots`.

