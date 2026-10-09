# Phase 0 — Data Dictionary & Schema Inventory

**Audit date:** 2026-10-05 · **Audited commit:** `675a05c`
Complete inventory of every database schema in the repository (per master plan §6: "read-only inventory of every MySQL, SQLite, and PostgreSQL schema used by the current applications, plus all migration/seed scripts").

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
`readiness()` reports `schema:false` until all four are present, so `/api/v1/health/ready`
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

The file adapter (`STORAGE_ADAPTER=file`) implements the same 32-method repository contract over
an append-only JSONL log, so every table above has a non-MySQL shape used by tests and local
rehearsal; it is refused in production unless `ALLOW_FILE_STORE_IN_PRODUCTION=1`.

**Not verified against a real server:** no migration in this set — including 004 — has ever been
applied by a MySQL/MariaDB instance in this sandbox (F-15). The DDL is unit-checked and
checksum-verified by the migrator against a fake pool only.

— End of Phase 0 data dictionary.
