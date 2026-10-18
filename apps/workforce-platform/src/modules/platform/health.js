/**
 * Health, readiness and honest platform-status endpoints.
 *
 * Liveness must never depend on the database; readiness does, and reports which
 * storage adapter is in use so a file-store demo can never be mistaken for a
 * production-ready database connection. `system/status` states plainly which
 * product modules are ported and which are not — the platform's honesty contract
 * carried over from the PHP application.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../../http/errors.js";

const PACKAGE_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json");
let cachedVersion = null;

/** Ported product modules and their acceptance state. Never invented. */
export const MODULE_STATUS = Object.freeze([
  {
    key: "identity",
    label: "Identity, sessions, RBAC, account management and self-service password reset (Phase 47: POST /api/v1/auth/password-reset-request + POST /api/v1/auth/password-reset-confirm with single-use 15-minute HMAC tokens delivered via SMTP when VP_SMTP_ENABLED=1, or legacy administrator-issued notice when SMTP is disabled)",
    state: "ported",
    tests: "unit + http + compatibility fixtures",
  },
  // Pages, robots/sitemap/manifest, the PWA shell, contact intake (stored, audited,
  // throttled, with optional SMTP operator copy in Phase 42) and the grounded
  // public chat assistant (Phase 43: POST /api/v1/chat/respond + floating widget on
  // the public site and workspace shell) are ported and tested. SITE_ANNOUNCEMENT
  // stays empty by default unless explicitly configured.
  {
    key: "publicSite",
    label: "Public site, SEO + PWA shell, contact intake (stored, audited, throttled, with optional SMTP operator copy) and the grounded public chat assistant at POST /api/v1/chat/respond (Phase 43: local product guide by default, optional https-only AI_CHAT_* provider, no private account/market/sports/lottery/lead data access, floating widget on public pages and the signed-in workspace shell, absent on auth pages; SITE_ANNOUNCEMENT stays empty by default unless configured)",
    state: "ported",
    tests: "unit + http + content checks + php-parity",
  },
  // The trail was already written by every ported action; Phase 10 adds the
  // permissioned browser over it (filter by actor, action, entity and time
  // window) and puts the actor's identity in the read view. Phase 28 adds the
  // console at /app/admin/audit. Still read-only on both adapters: no route can
  // edit, redact or delete an audit event — the screen offers no such control
  // either. Row 5 decided retention: `AUDIT_RETENTION_DAYS` is an operator-run
  // window applied by `npm run prune:retention`, and it is 0 (keep forever) by
  // default, because a trail that silently ages out is not an audit trail. Legacy
  // audit_logs rows have not been imported, and that is still stated.
  { key: "audit", label: "Security audit trail plus a permissioned read-only browser API and console (operator-run retention window, off by default, no historical import)", state: "ported", tests: "unit + http + both adapters" },
  // Notifications are ported: the unread-deduped notifier, broadcast/targeted
  // visibility and the three legacy inbox endpoints, with governance and
  // paper-proposal transitions publishing through it. Phase 49 (row 5, DV-28)
  // added the one outbound channel: an opt-in, severity-gated email COPY of each
  // stored alert, sent after the in-product row exists, carrying no action
  // links, suppressed by dedupe, immune to send failure, and audited with masked
  // addresses. Off unless explicitly configured, so a default host still claims
  // no delivery it has not made; SMTP separately serves the administrator test
  // send and the contact-form copy.
  { key: "notifications", label: "Operator notifications: unread-deduped inbox, broadcast + targeted, governance publishers, plus an opt-in severity-gated audited email copy (VP_NOTIFY_EMAIL_*, DV-28); SMTP separately serves the administrator test send and the contact-form copy", state: "ported", tests: "unit + http + both adapters" },
  // Market data is ported: the provider chain, normalization, circuit breakers
  // and the three legacy endpoints, with provenance that labels synthetic output.
  { key: "marketData", label: "Market data providers and health", state: "ported", tests: "unit + http + provider fixtures" },
  // Analysis is ported: indicators, regime detection, the seven-agent panel, the
  // consensus combiner, the adversarial debate and the five legacy endpoints. It
  // produces proposals only — nothing here can place an order.
  {
    key: "analysis",
    label: "Analysis engines, agents, consensus (proposals only), with their console at /app/analysis (Phase 32): a run on the legacy page's own symbols and timeframes, the consensus/regime meters, the four-round debate, the signal table, the five-agent panel, the risk-engine panel with the run's own risk context, the stored run history and the SVG candle chart ported from views/welcome/partials/chart.php. Like legacy's Api_controller the screen is session-only — the analysis and market-data routes guard on authentication alone — and the two governance controls it renders are the paper module's own trading.control writes (mode and kill switch), with the three modes this edition does not have refused by the request schema rather than silently accepted",
    state: "ported",
    tests: "unit + http + persistence + client contract",
  },
  // Research-only portfolio optimization (row 9) is ported: the long-only
  // mean-variance core with diagonal shrinkage, minimum-variance and maximum-Sharpe
  // allocations under a per-asset cap, the synthetic-data gates and per-asset
  // provenance. It computes weights and nothing else — it has no reference to the
  // paper, strategy or execution services, so it cannot reach an order path.
  // Phase 29 adds the console at /app/portfolio/optimizer, which is the same gate
  // (trading.view) the legacy page used and sends only declared body properties —
  // the client pre-flight is pinned against this endpoint's own schema by test. There
  // is still no saved-report history: a run is returned and the console says so,
  // because the only durable trace is the audit event the server writes.
  { key: "portfolioOptimizer", label: "Research-only portfolio optimization, long-only mean-variance, with its console at /app/portfolio/optimizer (no saved reports — a run is returned, not stored)", state: "ported", tests: "unit + http + client contract" },
  {
    key: "strategies",
    label: "Strategy lab, lifecycle, backtesting and durable AI review, with its console at /app/strategy (Phase 31): a backtest runs against the version on screen and shows the report, its equity curve, trades, provenance and warnings, the stored history, the six-stage lifecycle stepper (Request advance, always to the server's own nextStage) and the 70/30 optimizer with its finalist table. Like legacy's Api_controller the screen is session-only — no screen permission — and the one permissioned control on it, the human sign-off for an ai-sourced version, is the route's own trading.control write. Journal reads and the model/decision analytics stay under /journal/* rather than an alias (DV-8), and the journal console at /app/journal (Phase 41) is `Journal::index` over them: the five group switches, the six overall figures with their per-group table, the newest 200 entries and the confidence-calibration meters, every figure formatted the way the PHP formatted it and every read session-only, as the legacy controllers were. It states its two divergences rather than leaving them to be discovered — the group switch is in-page state because this shell's router has no query string, and the summary endpoint reads 500 rows while the table lists 200. `POST /journal/manual` is documented beside the reads and not drawn, as legacy drew no form for it. That screen was F-29's last",
    state: "ported",
    tests: "unit + http + persistence + client contract",
  },
  { key: "paperTrading", label: "Owner-scoped simulation accounts, orders, fills and deployments", state: "ported", tests: "unit + http + persistence" },
  {
    key: "risk",
    // The console is named here the way the other ported modules' labels name theirs: a
    // reader of `/system/status` should not have to guess whether a ported module has a
    // screen. Phase 44 closed F-30 by enforcing `maxCorrelatedPositions` across the six
    // disclosed static correlation groups at order time and in the portfolio scan.
    label: "Risk engine, persisted limits, kill switch and paper-portfolio monitor, with their console at /app/risk (Phase 38 + Phase 44): the eleven editable limits the API accepts, the limits it persists, the portfolio scan with each breach classified the way the operations job publishes it, and the audit trail (behind identity.users.view — AV-1). maxCorrelatedPositions is enforced at order time and in the portfolio scan across the six disclosed static correlation groups (F-30 closed in Phase 44). The scan is a read here: the audited alert transitions belong to the scheduled operations job",
    state: "ported",
    tests: "unit + http + persistence",
  },
  // Phase 8A adds human-reviewed paper proposals; Phase 13 reconciles them against
  // `ExecutionSupervisor.php` step by step. It stays `partial`, but the label now says
  // *why* rather than letting a reader assume the governance work is unfinished: nine
  // of the supervisor's fifteen steps read broker state that does not exist here
  // (connector readiness, market session, per-class quote freshness, duplicate
  // positions, margin, order placement, execution confirmation, portfolio update),
  // and two more bind to `SEMI_AUTONOMOUS`/`FULLY_AUTOMATED`. Legacy's own step 2
  // routes paper orders elsewhere, so this module is a paper-scoped analogue of the
  // supervisor's human-approval workflow, not a partial port of its broker pipeline.
  // What Phase 13 added is evidence: a submission refused by the kill switch or the
  // trading mode used to throw a bare 409 and leave no trace, so "who tried to route
  // while the platform was stopped" was unanswerable. Every refusal is now audited
  // outside the transaction that rolled back, and the governance refusal broadcasts a
  // daily-deduped `ROUTING_BLOCKED` alert, as legacy's `routingBlocked()` did.
  { key: "execution", label: "Human-reviewed paper proposals with fail-closed governance and blocked-submission evidence, and the Execution Center console at /app/execution (Phase 39), which ports `Execution::index`'s propose and decide panels, shows all fifteen supervisor steps and marks where this port stops, and states the automation envelope as unported rather than faking it. No live route and no automated mode: the remaining supervisor steps are broker-bound (row 13), not unfinished governance. F-29 no longer counts the execution screen as absent; brokers left that list in Phase 40 and the journal in Phase 41, so F-29's screen list is empty", state: "partial", tests: "unit + http + persistence + governance bypass/recovery + client console" },
  // Phase 12 ported `Tools::cron()` (the portfolio risk sweep across every owner and
  // the cross-owner stale-proposal expiry, coordinated by a `wf_job_locks` row and
  // driven by the host's cron through `tools/scheduled-jobs.mjs`), Phase 14 added
  // broker connect/disconnect transition alerts (`BROKER_CONNECTED` /
  // `BROKER_DISCONNECTED`, with `DISABLED` never counted), and Phase 44 completed
  // the legacy monitor's early-warning tiers and leverage/correlation checks:
  //   * 80% early-warning tiers for portfolio exposure (`PORTFOLIO_EXPOSURE_APPROACHING`)
  //     and gross notional leverage (`LEVERAGE_APPROACHING`), 70% for maximum drawdown
  //     (`DRAWDOWN_APPROACHING`) and 60% for daily loss (`DAILY_LOSS_APPROACHING`),
  //     all classified as `warning` while hard breaches (`PORTFOLIO_EXPOSURE_LIMIT`,
  //     `LEVERAGE_LIMIT`, `DRAWDOWN_LIMIT`, `DAILY_LOSS_LIMIT`, `CORRELATED_POSITION_LIMIT`)
  //     remain `critical` (closing SJ-8, SJ-9 and F-30);
  //   * static disclosed correlation groups (`CRYPTO_MAJORS`, `USD_MAJORS`, `USD_COUNTER`,
  //     `METALS`, `ENERGY`, `US_EQUITY_INDEX`) checked at 2+ positions as
  //     `CORRELATED_GROUP_EXPOSURE` (`warning`) and above `maxCorrelatedPositions` as
  //     `CORRELATED_POSITION_LIMIT` (`critical`, plus vetoed at order time in `RiskEngine.evaluate`);
  //   * the sports cron (`sports:jobs`) and lottery cron (`lottery:jobs`) are their own CLI entrypoints.
  // There is deliberately no HTTP route: `runOperations` takes no owner argument.
  { key: "scheduledJobs", label: "Scheduled operations cron: cross-owner portfolio risk sweep with 80/70/60% early-warning tiers (`PORTFOLIO_EXPOSURE_APPROACHING`, `LEVERAGE_APPROACHING`, `DRAWDOWN_APPROACHING`, `DAILY_LOSS_APPROACHING`), gross notional leverage (`LEVERAGE_LIMIT`), static disclosed correlation-group checks (`CORRELATED_GROUP_EXPOSURE` at 2+ positions and `CORRELATED_POSITION_LIMIT` above `maxCorrelatedPositions`, also enforced at order time in `RiskEngine.evaluate`), stale-proposal expiry and broker connect/disconnect transitions under a DB-backed lock (CLI only, no HTTP route — the sports cron is its own CLI, `sports:jobs`, and the lottery cron is its own, `lottery:jobs`)", state: "ported", tests: "unit + both adapters + CLI + early-warning & correlation parity" },
  // Phase 14 ports the connector *boundary* and its gates, not a working
  // integration. What exists: the normalized data contracts every adapter must
  // satisfy, the DISABLED -> NOT_CONFIGURED -> DOWN -> READY health ladder, and the
  // order gates (local flag AND bridge-reported tradingEnabled AND a demo account
  // unless live trading is separately allowed), all re-verified against a
  // force-refreshed probe on every write. Legacy's ten connectors are registered and
  // all are disabled by default. What does not exist: a verified adapter, an order
  // path, or the simulated bridge legacy used for its offline demo. So `routable` is
  // false on every host that has not deployed and verified a real bridge, and the
  // label says that instead of letting `partial` imply a half-working broker.
  { key: "brokers", label: "Broker connector boundary, normalized data contracts and demo-only order gates (ten adapters registered, all disabled by default; one read-only route, no order routing, no simulated bridge, no adapter verified against its provider), with the Broker Center console at /app/brokers (Phase 40): the read route and the governance state on one screen, the ten connectors in roster order with the nine PLANNED adapters in the controller's own words, and the three legacy routes this port does not have (`/brokers/sim-toggle` and the two MT5 reads legacy answered unauthenticated, F-32) named as absent rather than drawn as controls that call nothing. The screen holds no write: there is none behind it", state: "partial", tests: "unit + http + gates + client console" },
  // Slice 5 (row 14) completes the measured half: settlement from verified results,
  // result verification, calibration fitting, the point-in-time backtester, the drift
  // monitor (whose SPORTS_MODEL_DRIFT publisher closes NV-6) and measured performance.
  // Phase 36 ported the console screens, and Phase 48 ported the module's last not-ported
  // entry — stake sizing — as a bounded, record-only engine (DV-27), so the matrix is now
  // EMPTY and the label is `ported`. The boundaries it must keep naming are the module's,
  // not unfinished code: nothing is executed (a sized stake is recorded, never staked),
  // no stored result is trusted before a person attests to it, and no provider has been
  // verified against a real vendor. "Sports intelligence: ported" must not read as "a
  // betting engine that runs": nothing here executes, and the label keeps saying so.
  { key: "sports", label: "Sports data foundation, ingestion, decision chain, ticket engine and the measured half (slice 5): normalized fixture/odds/result contracts, data-quality and freshness gates, the provider boundary (sandbox simulation double-gated and labelled, generic REST provider never verified against a vendor), idempotent ingestion under a unique execution key, derived provider health from stored observations, PHP-parity proven by differential test, the decision chain with immutable predictions, the ticket engine (correlation, exhaustive optimizer, governance, a daily run recorded as PENDING for a person), and slice 5: result verification under sports.settle, settlement from verified results only (RESTITUTE_ODDS by default), calibration fitting on settled outcomes (PENDING until an administrator approves), the point-in-time backtester whose reports are flagged simulation, the drift monitor that publishes SPORTS_MODEL_DRIFT, and measured performance analytics. The sports cron (row 19) runs the nine scheduled jobs — syncs, quality, the daily ticket, the settlement sweep, performance snapshots, monitoring, retention cleanup — from the CLI under window locks, never from an HTTP route. Phase 48 ported the matrix's last entry as bounded record-only stake sizing (DV-27): the versioned configuration's `staking_method` — FLAT by default, byte-identical to legacy's fixed stake_amount on every existing configuration row (migration 022) — or the opt-in CONFIDENCE_SCALED, which multiplies the flat stake by confidence × risk × correlation factors (each ≤ 1, floors documented) so it can only size DOWN from it; the breakdown is reconstructible from the ticket and its configuration version, so no breakdown column exists; a sized stake is recorded and settled, never executed. Nothing is executed and no stored result is trusted before a person attests to it. Phase 36 ported the console screens — `Sports::index` and `Sports::tickets` are `/app/sports`, which closes F-29 for this module — and the decision route carries legacy's second guard: while the platform kill switch is ACTIVE (how it boots) an approval is refused 409, while settlement stays available, exactly as `Api_sports::decide_ticket` refuses. Not ported: nothing — the not-ported matrix is empty. Nineteen sports.view reads, two sports.manage reads, ten sports.manage writes (sync, configuration patch, evaluate, calibration fit/approve/reject, daily ticket run, backtest run, drift run, stuck-run recovery), one sports.approve write (ticket decision) and two sports.settle writes (result verification, ticket settlement)", state: "ported", tests: "unit + php-parity + http + store" },
  // Row 15, slice 1: the lottery foundation — the provider boundary (official feed
  // offline until an explicit, https-only, license-carrying configuration; the sandbox
  // double-gated and labelled; a default host has NO provider), the rules engine,
  // full draw validation before storage, idempotent ingestion with VERIFIED-conflict
  // protection, the statistics engine over stored draws (every output carrying the
  // DISCLAIMER; no "due" concept), and audited provider health. PHP-parity proven by
  // differential test (rules, validator, statistics, the PRNG and the sandbox draws).
  // Phase 30 closes the last entry: the console screens. The label is `ported` now,
  // and it names both screens so the state is checkable rather than asserted — the
  // not-ported matrix travels in /lottery/status and is asserted EMPTY.
  { key: "lottery", label: "Lottery intelligence, foundation + combinations + tickets + backtests + the cron (row 15, slices 1–5): provider-neutral draw contracts, the rules engine (EuroMillions as data), draw validation before storage (a failed draw is never inserted), idempotent ingestion that never overwrites a VERIFIED draw, derived provider health from stored observations and audited explicit probes, and the statistics engine (frequency, gaps, hot/cold, distribution, pairs) whose every output carries the independence DISCLAIMER — EuroMillions is a random lottery and nothing here predicts. The official provider is offline until an explicit, https-only, license-carrying configuration; the sandbox is double-gated and labelled; a default host has no provider and fabricates nothing. Slice 2 landed the combination engines (analyzer, five-mode generator, diversification, system builder) with their persistence (migration 017); slice 3 landed saved tickets — user-scoped records of number lines, never purchases — with owner-only checking against stored VERIFIED draws and official prize-tier LABELS only, never an amount (migration 018); slice 4 landed the measured half — the no-look-ahead Strategy Lab (four seeded strategies, the mandatory RANDOM_BASELINE), persisted HISTORICAL SIMULATION reports with cost/winnings honestly NULL, model versions ensured once and never replaced, and the performance overview whose ACTUAL/HISTORICAL/DEMO sections are never mixed (migration 019); slice 5 landed the lottery cron (tools/lottery-jobs.mjs, npm run lottery:jobs) — CLI-only like every scheduled job on this platform, no HTTP route — seven execution-key-idempotent jobs (sync, health, the data-integrity sweep, the systems consumer that finally drains the queued background builds, auto post-draw ticket checking, one backtest per strategy per day, and the 90/30-day retention sweep). Phase 30 ported the console screens, which were row 15's last entry (F-29 is closed for this module): the operations board at /app/lottery — engine state, the latest stored draw with its typed numbers and the rules note, provider health and its persisted history, the provider registry, a filtered draw browser, the seven statistics kinds, the AI decision reports with each stored payload, job runs, the performance overview and the module's own not-ported boundary — and the lab at /app/lottery/lab — the generator with locks and excludes, saved combinations, the diversity check, tickets as records (never purchases), the Strategy Lab with its mandatory baseline, stored backtest reports and model versions. Both screens read under lottery.view; only the probe, the sync and the system build are lottery.manage. Nineteen lottery.view reads, eight lottery.view POSTs (records and analysis, not managed ingestion), one authenticated status read and three lottery.manage writes (probe, sync, system-build)", state: "ported", tests: "unit + php-parity + http + store" },
  { key: "languageLearning", label: "Language learning and AI teacher (row 16 — Phase 46): 20 authored languages (18 CEFR A1–C2 plus Japanese JLPT N5–N1 and Mandarin Chinese HSK 1–6) with honest capability flags (nativeScript, romanized, ttsLocale, speechRecognition, proficiencySystem, ceiling), deterministic placement assessment staircase (level changes only on completion and capped at ceiling), 5-module curriculum path and 75% pass checkpoints, AI teacher guided lessons, multi-turn conversation scenarios with four correction modes (immediate, after, important, conversation_only) and two-miss assisted advance, writing feedback preserving original learner text, grammar explain-simply, 200-word authored vocabulary bank with 6-stage spaced repetition (1, 3, 7, 14, 30, 90 days; learned at stage 4), listening comprehension and diacritic-folded transcription exercises, honest speaking practice (browser Web Speech transcript word accuracy only, null/empty transcripts stored unscored, pronunciation never scored), adaptive weakness detector (>=3 skill attempts, <60% weak / >=80% strong, vocabulary-retention on >=2 words with lapse_count >= 2 & stage < 4, repeated-mistakes >=2x, module failed >=2x), daily study plan (5–120 minutes), skill mastery, and deterministic 20-language phrasebook/word-by-word translator, with the Language Learning & AI Teacher console at /app/languages and /app/languages/teacher", state: "ported", tests: "unit + php-parity + http + store + client console" },
  { key: "leadDiscovery", label: "Lead discovery and business pipeline (row 17 — Phase 45): organization-scoped workspaces (wf_lead_organizations + wf_lead_organization_members, auto-provisioned on first authenticated use and verified on X-Lead-Organization), pluggable provider registry (GooglePlacesProvider over GOOGLE_PLACES_API_KEY, disabled by default and never fabricating business records), primary source deduplication and conservative secondary duplicate detection (website_domain 0.95, normalized_phone 0.92, name_address 0.84) into open review candidates (keep_a, keep_b, merge, ignore), collections, pipeline stages (new, contacted, qualified, disqualified, converted), owner assignment, notes, activity trail, field coverage diagnostics, search history, and CSV-safe export, with the Lead Discovery console at /app/leads and /app/leads/pipeline", state: "ported", tests: "unit + php-parity + http + store + client console" },
]);

/**
 * The deployed version, read from the package manifest and cached. `WF_BUILD_VERSION`
 * overrides it so a release pipeline can stamp the artifact. Never a literal here:
 * a status endpoint that reports a version the tree does not contain is a lie.
 */
export function platformVersion() {
  if (process.env.WF_BUILD_VERSION) return process.env.WF_BUILD_VERSION;
  if (cachedVersion) return cachedVersion;
  try {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
    cachedVersion = `${manifest.name}@${manifest.version}`;
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

/**
 * Probe-free count of connectors this host has actually configured.
 *
 * Reads no state and opens no socket: `/system/status` is unauthenticated and every
 * other field on it is computed the same way, so an anonymous caller cannot make
 * this server reach an outbound host or do measurable work.
 */
function countConfiguredConnectors(brokers) {
  if (!brokers || typeof brokers.configuredCount !== "function") return 0;
  try {
    const total = Number(brokers.configuredCount());
    return Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  } catch {
    return 0;
  }
}

export async function healthRoutes(app, { store, config, adapter, router, marketData = null, analysis = null, notifications = null, brokers = null, sports = null, chat = null, leads = null }) {
  app.get("/health/live", async () => ({
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    node: process.versions.node,
  }));

  app.get("/health/ready", { config: { rateLimit: { max: 120, windowMs: 60_000 } } }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    if (!store) {
      reply.header("retry-after", "5");
      return reply.code(503).send({ status: "not_ready", database: false, schema: false, adapter: adapter || "none", detail: "no-store-configured" });
    }
    let readiness;
    try {
      readiness = await store.readiness();
    } catch (error) {
      // A dependency outage is "not ready", never a 500 and never a green light.
      // The underlying error (which can contain host, port and credentials) stays
      // in the log.
      app.log?.error?.({ errorCode: error?.code || "READINESS_PROBE_FAILED" }, "Readiness probe failed");
      reply.header("retry-after", "5");
      return reply.code(503).send({ status: "not_ready", database: false, schema: false, adapter: adapter || "unknown", detail: "probe-failed" });
    }
    const ready = Boolean(readiness.database && readiness.schema);
    if (!ready) reply.header("retry-after", "5");
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      database: Boolean(readiness.database),
      schema: Boolean(readiness.schema),
      adapter: readiness.adapter || adapter || "unknown",
      ...(readiness.detail ? { detail: readiness.detail } : {}),
      ...(store.capabilities?.recommendedForProduction === false ? { durability: "development-only" } : {}),
    });
  });

  app.get("/system/status", async () => {
    let readiness = { database: false, schema: false };
    if (store) {
      try {
        readiness = await store.readiness();
      } catch {
        readiness = { database: false, schema: false, detail: "probe-failed" };
      }
    }
    return {
      platform: "WINDELS AI WORKFORCE (Node.js core-http edition)",
      version: platformVersion(),
      runtime: { node: process.versions.node, env: config.mode, adapter: readiness.adapter || adapter || "unknown" },
      origin: config.publicBaseUrl || null,
      storage: store?.capabilities || null,
      readiness: {
        database: Boolean(readiness.database),
        schema: Boolean(readiness.schema),
        ...(readiness.detail ? { detail: readiness.detail } : {}),
      },
      modules: MODULE_STATUS,
      // The legacy status surface reported provider health inline. This snapshot
      // never probes an external host: an unauthenticated endpoint must not be
      // able to make the server fan out to third parties. Authenticated callers
      // use GET /api/v1/market-data/providers for a live probe.
      marketData: marketData ? await marketData.statusSnapshot() : null,
      // Static description of the analysis panel and the trading state it is
      // evaluated against. Like the market-data snapshot it never probes or
      // computes: an unauthenticated caller cannot make this server do work.
      analysis: analysis ? analysis.statusSnapshot() : null,
      // Same rule as the two snapshots above: this describes the module, it does
      // not read the inbox, so an unauthenticated caller cannot enumerate alerts.
      notifications: notifications ? notifications.statusSnapshot() : null,
      // Same rule again: this describes the public chat assistant from
      // configuration alone (local-guide vs configured-ai, model name when active,
      // privateDataAccess: false). It never exposes AI_CHAT_API_KEY or probes the
      // upstream model provider.
      chat: chat ? chat.statusSnapshot() : null,
      // Same rule again: this describes the sports module from configuration alone.
      // It never contacts a provider, so an unauthenticated caller cannot make this
      // server reach a third-party feed. Derived health is therefore not reported
      // here at all -- it would be UNKNOWN with nothing behind it, and a field that
      // can only ever hold one value is a field that invites a reader to think it
      // was measured.
      sports: sports ? sports.statusSnapshot() : null,
      leads: leads ? leads.statusSnapshot() : null,
      trading: {
        enabled: true,
        simulationOnly: true,
        paperTradingAvailable: true,
        paperProposalWorkflowAvailable: true,
        liveTradingEnabled: false,
        // Deliberately `false` on this surface rather than probed (BC-11).
        // Answering it truthfully requires a health probe against every enabled
        // bridge, and `/system/status` is unauthenticated: the invariant this
        // snapshot holds — that an anonymous caller cannot make this server do work
        // or reach an outbound host — is worth more than a live boolean here. The
        // authoritative, probed answer is `routable` on the authenticated
        // `GET /api/v1/brokers`. Understating live-trading capability on a public
        // endpoint is also the safe direction to be wrong in, and it is stated
        // rather than left to inference.
        brokerConnectorAvailable: false,
        // Config-only and probe-free: how many connectors this host has an enabled,
        // reachable-looking configuration for. Zero on a default deployment.
        brokerConnectorsConfigured: countConfiguredConnectors(brokers),
        reason: "Paper accounts, proposal submissions and fills are simulation-only. Human approval and the existing paper risk/governance checks are required. The broker connector boundary and its demo-only order gates are ported, but no adapter is verified and no order can be routed; `brokerConnectorAvailable` is not probed on this unauthenticated surface — see `routable` on GET /api/v1/brokers.",
      },
    };
  });

  /**
   * Machine-readable route inventory: the parity ledger is built from this, so
   * an endpoint cannot be quietly dropped during migration.
   */
  app.get("/system/routes", async (_request, reply) => {
    const inventory = router || app.router;
    if (!inventory) throw AppError.unavailable("Route inventory is not available", { retryAfter: 5 });
    const routes = inventory.list();
    return reply.code(200).send({ routes, count: routes.length });
  });

  app.get("/system/features", async () => {
    const features = {};
    for (const module of MODULE_STATUS) features[module.key] = module.state;
    return {
      features,
      legend: { ported: "implemented and tested on Node", partial: "some behaviour ported", "not-ported": "only the legacy application provides this" },
      honesty: "No module is reported as ready unless its tests run in this build.",
    };
  });
}
