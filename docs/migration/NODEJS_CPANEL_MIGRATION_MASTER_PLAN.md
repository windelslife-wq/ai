# WINDELS AI WORKFORCE — JavaScript / Node.js / cPanel Migration Master Plan

**Target repository:** `windelslife-wq/ai`  
**Source branch:** `main`  
**Arena working branch:** `arena/01a10951-ai`
**Status:** Architecture and execution contract. This document does not claim that the migration has been implemented. For current implementation evidence, see [`STATUS.md`](STATUS.md); for the active, verified port/provider/deployment backlog, see [`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md).

## 1. Mission

Migrate the complete WINDELS AI WORKFORCE platform from its current mixed PHP/CodeIgniter and supporting-runtime architecture to a maintainable, JavaScript-first Node.js application that can be deployed and operated on compatible cPanel hosting.

This is a whole-platform migration, not a rewrite of only the sports-predictions feature. Preserve the existing product capabilities, user workflows, data, access rules, audit history, safety gates, and honest provider-status behavior.

The existing repository includes a substantial CodeIgniter 3.1.13 / PHP 8 / MySQL application, a separate Fastify/TypeScript + Next.js lead-discovery application, a development runtime, and a Python MT5 bridge. Treat every existing module and its tests as migration input. Do not assume that a module is complete merely because a README says so; verify its implementation and tests.

## 2. Non-negotiable migration rules

1. **Do not delete or overwrite the PHP production application during migration.** Build the Node.js replacement alongside it. The PHP app remains the rollback target until explicit acceptance.
2. **Preserve behavior before improving it.** Record current routes, permissions, database semantics, calculations, UI flows, scheduled jobs, provider contracts, and known limitations.
3. **No silent data loss or schema reset.** Use additive, versioned, reversible migrations. Preserve primary keys where practical, relationships, timestamps, audit records, encrypted values, and user ownership.
4. **No fake integrations or fabricated data.** Keep real, synthetic, sandbox, unavailable, and planned provider states distinct in APIs and UI.
5. **Security and risk gates must not weaken.** In particular, AI agents must not bypass the Risk Engine, Execution Supervisor, approval workflow, broker safeguards, or kill switch.
6. **Live trading remains disabled by default.** Default to ANALYSIS_ONLY, active kill switch, no live credentials, and no broker order routing until separately authorized and verified.
7. **Do not expose secrets in GitHub.** Never commit production `.env`, database dumps containing personal data, API keys, encryption keys, broker credentials, session secrets, or private user data.
8. **No unverified “complete” claims.** Every migrated module must have parity evidence, automated tests, and an explicit status.
9. **Use JavaScript for application code.** Prefer Node.js with modern JavaScript (ES modules) and JSDoc or TypeScript only where the repository's existing TypeScript app provides a useful, consistent pattern. Do not introduce a new PHP dependency.
10. **cPanel is a first-class deployment target.** Design for cPanel's Node.js Application Manager / Passenger environment, supported Node versions, MySQL/MariaDB, Apache reverse proxy, and cPanel cron. Do not require Docker, Redis, root access, PM2, or a permanently running shell session for the baseline deployment.

## 3. Existing platform scope — migrate all of it

Create a verified inventory from source code, routes, schema, UI, tests, and README. At minimum account for:

### Core platform
- Authentication, registration, sessions, password reset, account settings, roles, permissions, CSRF protection, and admin management.
- Shared application shell, dashboard, navigation, notifications, audit logs, feature/status reporting, settings, and health checks.
- Existing CodeIgniter controllers, models, libraries, helpers, views, route definitions, and install/deployment behavior.

### Market and AI intelligence
- Market-data provider abstraction, provider health, retries, timeouts, circuit breakers, cache/fallback rules, data freshness, provenance, and normalization.
- Binance and Frankfurter/ECB integrations and explicitly labeled synthetic/demo providers.
- Technical indicators, math utilities, candle normalization, timeframe handling, regime detection, trade setup generation, and analysis history.
- Specialized agents (technical, market structure, forex, crypto, sentiment, fundamentals boundary), consensus, adversarial debate, and abstention behavior.
- Strategy registry, versioning, lifecycle gates, built-in strategies, optimization, backtesting, metrics, look-ahead protection, and out-of-sample evaluation.
- Confidence calibration, journal, analytics, and model/decision evidence.

### Trading and broker governance
- Paper accounts, orders, fills, positions, ticks, deployments, journal integration, and paper-trading lifecycle.
- Risk Engine, risk limits, exposure/drawdown/loss checks, portfolio risk monitoring, alerts, and correlated-position warnings.
- Trade Execution Supervisor and its complete ordered 15-step pipeline.
- HUMAN_APPROVAL, SEMI_AUTONOMOUS, and FULLY_AUTOMATED modes with approved automation envelopes.
- Kill switch, duplicate protection, proposal expiry, durable execution proposals, approval records, broker state transitions, and immutable audit evidence.
- Broker connector contracts, MT5 account/quote/candle/order/position/history operations, bridge health and demo/live gates.
- Preserve the current simulated MT5 behavior as simulation only. Assess a Node.js bridge implementation separately; do not pretend a Node implementation is equivalent until contract-tested against a real demo terminal. If a platform-specific MT5 dependency cannot responsibly be replaced in the first release, isolate it behind a documented adapter boundary and mark it as a temporary migration exception, not as a completed JavaScript conversion.

### Lottery intelligence
- EuroMillions rules and versioning, provider abstraction, ingestion validation, idempotency, verified-draw conflict handling, historical statistics, combination analysis, generation modes, lock/exclude constraints, diversification, system builder, saved user tickets, backtesting, model versioning, performance separation, RBAC, and scheduled jobs.
- Preserve the mathematical and honesty disclaimers. Historical frequencies, gaps, hot/cold labels, balance scores, and diversity scores are not predictions or improved odds. Never invent prize amounts, costs, feeds, or winning probabilities.

### Language learning / AI teacher
- Language registry and feature matrix, learner profiles, adaptive assessments, CEFR paths, checkpoint quizzes, lessons, conversation drills, guided writing, grammar help, lesson history, vocabulary, spaced repetition, listening/speaking browser capabilities, adaptive plans, weakness detection, evidence citations, and honest unsupported-feature reporting.
- Preserve user progress and ownership isolation. Do not manufacture pronunciation or fluency scores when no validated provider supports them.

### Lead discovery / Scout
- Audit and migrate the existing standalone `apps/api`, `apps/web`, and `packages/shared` application rather than duplicating it blindly.
- Preserve organization isolation, provider integrations, deduplication, pipeline workflows, lead coverage, and all current APIs/UI behavior.
- Consolidate it into the chosen Node architecture only after mapping its independent PostgreSQL/Redis assumptions and deciding how to support them on cPanel. Prefer a supported MySQL/MariaDB persistence adapter for the cPanel edition unless a documented cPanel environment provides the required PostgreSQL/Redis services. Do not silently substitute storage semantics.

### Other modules and platform surfaces
- Chat, journal, paper trading, trading tools, risk center, strategy lab, broker center, notifications, account management, SEO/public pages, and any additional modules discovered during inventory.
- Search all route declarations, controllers, views, libraries, jobs, tables, tests, and feature flags for modules not listed here. Add them to the inventory before implementation.

## 4. Target architecture

Use a modular monolith for the cPanel edition. Keep clear module boundaries so modules can be extracted later, but do not introduce microservices that require infrastructure unavailable on ordinary shared hosting. The Fastify preference below describes the original implementation baseline; a later user request proposes replacing it with Node core `http` plus a Vanilla public site, React/Vite SPA, PWA, and Capacitor shell. That replacement remains a proposal until reviewed: see [`FULL_STACK_ARCHITECTURE_PROPOSAL.md`](FULL_STACK_ARCHITECTURE_PROPOSAL.md).

Suggested repository layout:

```text
/
  apps/
    web/                         # browser UI; server-rendered or static assets
    api/                         # Node.js HTTP application
  packages/
    core/                        # config, errors, logging, utilities
    database/                    # MySQL pool, migrations, repositories
    auth/                        # identity, sessions, RBAC, CSRF
    market-data/
    intelligence/
    strategies/
    backtesting/
    risk/
    paper-trading/
    execution/
    brokers/
    lottery/
    language-learning/
    lead-discovery/
    notifications/
    audit/
    scheduler/
  database/
    migrations/
    seeds/
    import/
  public/                        # cPanel document root; public assets only
  scripts/
    migrate.js
    import-legacy.js
    verify-install.js
    cron/
  tests/
    unit/
    integration/
    parity/
    security/
    e2e/
  deploy/
    cpanel/
      passenger-start.js
      .htaccess.example
      deployment-checklist.md
      cron-examples.md
      backup-and-rollback.md
  docs/
    migration/
      inventory.md
      route-parity.md
      data-mapping.md
      decisions.md
  .env.example
  package.json
  README.md
```

The final structure may be adapted after inventory. Do not move or delete the existing Scout application or PHP app until the migration plan explicitly maps every file and capability.

### Backend
- Node.js LTS version supported by the target cPanel provider.
- Fastify preferred for the API because the repository already contains a Fastify-based application; Express is acceptable only if a documented technical reason and consistent conventions justify it.
- ES modules, asynchronous I/O, schema validation at every input boundary, centralized error handling, structured logging, request IDs, and graceful shutdown.
- Use a single documented API versioning strategy. Preserve legacy routes through compatibility adapters where needed.
- Use a modular service/repository/domain separation. Business rules must not live in route handlers.
- All money, odds, prices, quantities, and risk calculations must use safe decimal arithmetic (e.g. decimal.js or an equivalent audited decimal approach), not binary floating-point shortcuts.

### Frontend
- Reuse and consolidate the existing Scout frontend only after its UI and dependencies have been audited.
- For cPanel compatibility, compile frontend assets during CI/development and deploy build artifacts; do not require a build toolchain on the production host unless the host explicitly supports it.
- Keep the public document root limited to public assets and the application entry point. Never expose source maps containing secrets, `.env`, uploads, logs, backups, SQL dumps, or private configuration.
- Preserve responsive desktop/mobile behavior, accessibility, existing navigation, dashboards, charts, forms, and user workflows.

### Database
- Baseline target: MySQL/MariaDB supported by the cPanel account.
- Use a single canonical schema and versioned migrations. Keep table/column naming consistent and document every legacy mapping.
- Use parameterized queries, transactions, foreign keys where supported, unique constraints, indexes, and explicit tenant/user scoping.
- Do not assume PostgreSQL-specific SQL from Scout can be copied unchanged. Translate semantics carefully and test JSON, timestamps, collations, indexes, locking, and transaction behavior.
- Store secrets encrypted at rest where required; never reuse or expose legacy encryption keys without a reviewed compatibility plan.
- Use UTC for persisted timestamps and explicit timezone conversion at the UI boundary.

## 5. API and compatibility requirements

1. Inventory every current route and method, including public pages, authenticated APIs, admin endpoints, CLI commands, and webhook/provider callbacks.
2. Produce a route mapping table: legacy route → Node route → auth/RBAC/CSRF → request/response shape → parity test.
3. Preserve response semantics where clients depend on them. If a response must change, version it and document the migration.
4. Apply authentication, authorization, ownership/tenant isolation, validation, rate limits, CSRF protection for cookie-authenticated mutations, and safe CORS rules centrally.
5. Do not trust client-provided user IDs, organization IDs, roles, prices, odds, account balances, or permission flags.
6. Webhooks must verify signatures, enforce replay protection, and be idempotent.
7. Generate OpenAPI documentation from the actual implemented schemas; keep it synchronized with tests.
8. Maintain an honest feature matrix endpoint so the UI never claims a provider or capability is live when it is merely scaffolded.

## 6. Data migration and legacy coexistence

- First produce a read-only inventory of every MySQL, SQLite, and PostgreSQL schema used by the current applications, plus all migration/seed scripts.
- Build a canonical data dictionary and explicit old-table → new-table mapping. Identify collisions, nullable differences, enum changes, encoding/collation issues, and encrypted columns.
- Write repeatable import tooling that supports dry-run, batch processing, checkpoints, resumability, row counts, checksums, validation reports, and safe retry.
- Preserve user IDs and ownership references where feasible. If IDs must change, maintain a permanent mapping table and prove every foreign key is migrated.
- Never import development/demo/synthetic records as real production evidence. Keep data provenance.
- Back up source database and files before every migration. Test restore, not just backup creation.
- Run parity checks for row counts, relationships, critical aggregates, balances, trade history, audit logs, lottery draws/tickets, language progress, and lead ownership.
- Plan a controlled cutover: freeze writes or use a documented delta-sync strategy, import final changes, verify, switch traffic, monitor, and retain a tested rollback path.
- The old PHP app must remain deployable until post-cutover acceptance and an agreed retention period.

## 7. Trading safety and domain invariants

These rules are acceptance blockers:

- Agents can analyze and recommend; they cannot directly access a broker connector or submit orders.
- Every order intent must pass through the Risk Engine and Execution Supervisor. No alternate route may bypass either.
- Preserve the ordered 15-step execution pipeline, approval requirements, automation envelope, duplicate checks, market/data freshness checks, symbol permissions, margin checks, and audit records.
- Kill switch is checked first and re-checked immediately before routing. A kill-switch state or risk veto must prevent execution.
- Live trading disabled by default. ANALYSIS_ONLY default. Demo-only until a separately documented, manually approved live authorization procedure is completed.
- Synthetic data provenance must flow through every analysis, backtest, order, fill, and UI view. Synthetic data must never be represented as live market data.
- Strategies must retain lifecycle gates and out-of-sample validation; AI-created strategies require human sign-off.
- Broker connector health and actual order-submission capability must be verified, not inferred from an HTTP health endpoint.
- Preserve idempotency and immutable evidence for proposals, approvals, executions, fills, and audit events.
- Automated tests must prove all bypass attempts fail.

## 8. cPanel deployment contract

The app must be deployable on a cPanel account that explicitly supports Node.js applications. Hosting plans differ; verify the actual Node version, Passenger support, process limits, environment-variable UI, MySQL version, cron availability, and outbound network restrictions before promising compatibility.

### Expected deployment model
- Create a Node.js application in cPanel → Setup Node.js App / Application Manager.
- Select a supported Node LTS runtime.
- Set application root to a private directory outside `public_html`, where possible.
- Configure startup file (for example `passenger-start.js`) and the host-provided Passenger environment.
- Install production dependencies using cPanel's supported process.
- Set production environment variables in cPanel's Node app configuration, not in a publicly accessible file.
- Configure MySQL database/user and least-privilege grants using cPanel → MySQL Databases.
- Point the domain/subdomain document root to the safe public directory and configure Passenger/Apache routing as required by the host.
- Verify HTTPS, secure cookies, trusted proxy configuration, static asset paths, uploads, and file permissions.
- Include a browser-based deployment guide with screenshots/labels described textually, plus a CLI alternative only when the host permits it.

### Runtime constraints
- Do not require Docker, root access, systemd, PM2, Redis, a dedicated queue server, or persistent terminal sessions for the baseline.
- Do not rely on WebSockets unless the selected host confirms support through Passenger/proxy. Provide polling or Server-Sent Events fallback only where supported and tested.
- Use database-backed jobs/locks for scheduled tasks and idempotent cron entry points. cPanel cron invokes short-lived Node scripts; never start a second permanent worker from cron.
- Design cron jobs to finish within hosting execution limits, use bounded batches, locks, retries, and resumable checkpoints.
- Use local disk for temporary/cache data only where appropriate. For uploads, enforce MIME/content validation, size limits, randomized names, private storage, and non-executable paths. Provide S3-compatible optional storage only as an optional integration, not a requirement.
- Add health/readiness endpoints and a deployment self-check that reports missing extensions/services/configuration without exposing secrets.

### Required cPanel deliverables
- `deploy/cpanel/README.md`: full installation from a clean cPanel account.
- `deploy/cpanel/ENVIRONMENT.md`: every environment variable, type, required/optional, default, and secret handling.
- `deploy/cpanel/CRON.md`: exact cron entries and safe schedules.
- `deploy/cpanel/HTACCESS.md`: required rewrite/proxy/static-file rules, with safe examples.
- `deploy/cpanel/ROLLBACK.md`: backup, restore, rollback and recovery.
- `deploy/cpanel/HEALTHCHECK.md`: post-deployment verification.
- A clean production package/archive excluding tests, development dependencies, local databases, secrets, logs, caches, and repository history.

## 9. Security baseline

- Password hashing with Argon2id or a maintained secure equivalent; never store plaintext passwords.
- Secure, HttpOnly, SameSite cookies; session rotation; expiration; logout invalidation; CSRF protection.
- RBAC enforced server-side on every protected route and action; deny by default.
- Tenant and user ownership checks in every repository query.
- Rate limits for login, password reset, public APIs, expensive AI/provider endpoints, and mutations.
- Input validation, output encoding, SQL injection prevention, XSS prevention, SSRF controls, path traversal protection, upload scanning/validation, and safe file serving.
- Strict security headers, TLS-only production, trusted proxy configuration, safe CORS, and no wildcard credentialed CORS.
- Secrets supplied through host environment variables; redaction in logs; rotation procedure.
- Audit log sensitive actions and security events without logging passwords, tokens, full payment data, or private secrets.
- Dependency scanning, lockfile, supported Node LTS, and documented patch/update policy.
- Backup encryption and access control; restore drills.

## 10. Testing and acceptance gates

Build tests before migrating each module. Reuse existing tests as behavioral specifications, but port them into JavaScript tests and add parity tests.

Required layers:
- Unit tests for domain logic, calculations, validation, risk rules, statistics, generators, and state machines.
- Integration tests for MySQL/MariaDB repositories, transactions, migrations, providers, and API routes.
- Contract tests for all external providers and broker bridges, including negative/unavailable cases.
- Parity tests comparing old PHP outputs and new Node outputs against identical fixtures.
- Security tests for RBAC, tenant isolation, CSRF, auth/session handling, injection, SSRF, upload handling, and secret exposure.
- End-to-end tests for public and authenticated workflows and every admin surface.
- Deployment tests on a real cPanel Node.js Application Manager environment (or a faithful Passenger test host), not merely local Node.
- Data import tests with duplicate, partial, malformed, and interrupted batches.
- Performance tests for bounded memory/CPU and database query efficiency within shared-hosting limits.

A module is accepted only when:
1. Its inventory is complete.
2. Route and UI parity is demonstrated.
3. Its data migration is verified.
4. Its tests pass.
5. Its permissions and safety invariants pass negative tests.
6. Its cPanel deployment instructions are validated.
7. Its known limitations are documented.

Do not mark the platform production-ready while any critical module, migration, security test, or rollback path is incomplete.

## 11. Execution phases — follow in order

### Phase 0 — Repository audit (read-only)
- Inspect every tracked file and directory; do not edit or delete anything.
- Identify all runtimes, entry points, package manifests, PHP modules, Python bridge code, Scout services, SQL schemas, migrations, tests, cron tasks, uploads, and deployment artifacts.
- Build module inventory, route inventory, database dictionary, dependency map, risk register, and current test baseline.
- Record known failures and contradictions. Never silently reconcile them.
- Deliver: `docs/migration/INVENTORY.md`, `ROUTE_MAP.md`, `DATA_DICTIONARY.md`, `RISK_REGISTER.md`, `BASELINE_TESTS.md`.

### Phase 1 — Target foundation
- Create Node modular-monolith foundation, config validation, logging, error handling, MySQL pool, migrations, health checks, API versioning, auth/RBAC/CSRF, audit foundation, and cPanel Passenger bootstrap.
- Add CI checks, linting, formatting, dependency lockfile, and test framework.
- Verify a minimal app deploys successfully to cPanel before migrating business modules.

### Phase 2 — Identity and shared platform
- Migrate accounts, sessions, permissions, admin functions, notifications, audit, settings, public pages, and shared UI.
- Prove user and tenant isolation.

### Phase 3 — Migrate modules one by one
Suggested order after dependency review:
1. Market data and provider health.
2. Analysis engines, agents, consensus, and debate.
3. Strategies, backtesting, and analytics.
4. Paper trading, risk engine, portfolio monitor.
5. Execution supervisor, approvals, broker connectors (demo-only).
6. Lottery intelligence.
7. Language learning and AI teacher.
8. Lead discovery / Scout.
9. Remaining tools, chat, SEO, dashboards, and any discovered modules.

Do not start the next module until the current module passes its acceptance gates. Reorder only when dependency evidence requires it.

### Phase 4 — Data migration rehearsal
- Build importer and mapping scripts.
- Test full and incremental import, data integrity, restore, and rollback.
- Produce signed-off migration report.

### Phase 5 — cPanel hardening
- Validate Node runtime compatibility, Passenger startup, static routing, cron, MySQL limits, outbound provider access, file permissions, HTTPS, backups, logs, and resource ceilings.
- Test with production-like data volume and shared-hosting limits.

### Phase 6 — Cutover
- Take verified backups.
- Freeze writes or run approved delta sync.
- Import final data and run integrity checks.
- Switch traffic only after all release gates pass.
- Monitor logs, health, queues, provider states, and user workflows.
- Keep rollback to PHP immediately available.

### Phase 7 — Decommission legacy (separate approval required)
- Only after agreed stability period, user acceptance, backups, audit retention, and rollback sign-off may legacy PHP runtime be retired.
- Never delete the original source history or migration evidence.

## 12. Required deliverables

- Complete Node.js application source for all existing modules.
- Canonical MySQL/MariaDB schema and ordered migrations.
- Legacy import/export and verification scripts.
- API OpenAPI specification and route compatibility map.
- Responsive web UI with public, user, and admin surfaces.
- cPanel Passenger startup/configuration and complete deployment package.
- cPanel browser-based installation guide, cron guide, environment guide, backup/restore, rollback, and troubleshooting guide.
- Automated unit, integration, contract, parity, security, and end-to-end tests.
- CI workflow and release checklist.
- Architecture decisions, module inventory, known limitations, provider matrix, and production-readiness report.
- A final change log mapping every legacy module to its Node replacement and test evidence.

## 13. Instructions to the implementation agent

You are acting as a senior JavaScript/Node.js architect, legacy migration engineer, database migration specialist, security engineer, QA lead, and cPanel deployment engineer.

Start with Phase 0 only. Read the repository completely before writing application code. Do not generate placeholder files to make the inventory look complete. Do not skip files because they are large or unfamiliar. Follow references into tests, schemas, routes, jobs, and UI.

After Phase 0, report:
- What exists and where.
- What is actually implemented versus planned/scaffolded.
- Every module and its dependencies.
- All legacy routes and tables.
- Existing tests and baseline results.
- Data/security/deployment risks.
- The exact Node architecture and migration sequence.
- Any cPanel hosting capability that must be confirmed.

Then implement only the next approved phase. Work in small, reviewable commits. Never claim tests passed unless they were executed and results are available. Never deploy, delete legacy code, change production data, enable live trading, or cut over traffic without explicit human approval.

**Primary success condition:** the complete WINDELS AI WORKFORCE platform runs as a JavaScript/Node.js application on a compatible cPanel host, with its existing capabilities and data preserved, all safety/security controls intact, tested rollback, and no false claims about unsupported providers or features.
