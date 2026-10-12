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
  { key: "identity", label: "Identity, sessions, RBAC, account management", state: "ported", tests: "unit + http + compatibility fixtures" },
  // Pages, robots/sitemap/manifest, the PWA shell and contact intake have local
  // rendering/content checks; the legacy chat assistant is absent, so the module
  // remains partial. These checks do not claim complete legacy parity.
  { key: "publicSite", label: "Public site, SEO + PWA shell, contact intake (chat assistant not ported)", state: "partial", tests: "unit + http + content checks" },
  // The trail was already written by every ported action; Phase 10 adds the
  // permissioned browser over it (filter by actor, action, entity and time
  // window) and puts the actor's identity in the read view. Still read-only on
  // both adapters: no route can edit, redact or delete an audit event. The
  // browser SCREEN is app-shell work (row 3), and security-event retention is an
  // undecided policy, so neither is claimed here.
  { key: "audit", label: "Security audit trail plus a permissioned read-only browser API (no console screen, no retention policy)", state: "ported", tests: "unit + http + both adapters" },
  // Notifications are ported: the unread-deduped notifier, broadcast/targeted
  // visibility and the three legacy inbox endpoints, with governance and
  // paper-proposal transitions publishing through it. Storage and in-product
  // reading only — there is no outbound delivery channel, so no alert is ever
  // reported as delivered to a device or an email inbox.
  { key: "notifications", label: "Operator notifications: unread-deduped inbox, broadcast + targeted, governance publishers (no outbound delivery)", state: "ported", tests: "unit + http + both adapters" },
  // Market data is ported: the provider chain, normalization, circuit breakers
  // and the three legacy endpoints, with provenance that labels synthetic output.
  { key: "marketData", label: "Market data providers and health", state: "ported", tests: "unit + http + provider fixtures" },
  // Analysis is ported: indicators, regime detection, the seven-agent panel, the
  // consensus combiner, the adversarial debate and the five legacy endpoints. It
  // produces proposals only — nothing here can place an order.
  { key: "analysis", label: "Analysis engines, agents, consensus (proposals only)", state: "ported", tests: "unit + http + persistence" },
  // Research-only portfolio optimization (row 9) is ported: the long-only
  // mean-variance core with diagonal shrinkage, minimum-variance and maximum-Sharpe
  // allocations under a per-asset cap, the synthetic-data gates and per-asset
  // provenance. It computes weights and nothing else — it has no reference to the
  // paper, strategy or execution services, so it cannot reach an order path. The
  // console screen (views/portfolio/optimizer.php) is app-shell work (row 3), and
  // there is no persisted-run history: a report is returned, not stored.
  { key: "portfolioOptimizer", label: "Research-only portfolio optimization, long-only mean-variance (no console screen, no saved reports)", state: "ported", tests: "unit + http" },
  { key: "strategies", label: "Strategy lab, lifecycle, backtesting and durable AI review", state: "ported", tests: "unit + http + persistence" },
  { key: "paperTrading", label: "Owner-scoped simulation accounts, orders, fills and deployments", state: "ported", tests: "unit + http + persistence" },
  { key: "risk", label: "Risk engine, persisted limits, kill switch and paper-portfolio monitor", state: "ported", tests: "unit + http + persistence" },
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
  { key: "execution", label: "Human-reviewed paper proposals with fail-closed governance and blocked-submission evidence (no live route, no automated mode; the remaining supervisor steps are broker-bound row 13, not unfinished governance)", state: "partial", tests: "unit + http + persistence + governance bypass/recovery" },
  // Phase 12 ports `Tools::cron()`: the portfolio risk sweep across every owner and
  // the cross-owner stale-proposal expiry, coordinated by a `wf_job_locks` row and
  // driven by the host's cron through `tools/scheduled-jobs.mjs`. It is `partial`,
  // and the label says precisely what is missing rather than letting `ported` imply
  // the legacy monitor's full alert vocabulary:
  //   * no early-warning tiers. Legacy raised a `warning` at 80% (exposure,
  //     leverage), 70% (drawdown) and 60% (daily loss) of a limit, and `critical`
  //     at the limit. This port alerts on the paper scan's at-limit breaches only,
  //     so an operator hears about a breach when it happens, not as it approaches.
  //     The tiers live in the paper scan's vocabulary (row 11, already accepted),
  //     and adding them here would have meant a second, divergent set of thresholds.
  //   * no `sports_cron` or `lottery_cron`; those modules are not ported.
  // (Broker transition alerts were added in Phase 14 — `BROKER_CONNECTED` and
  // `BROKER_DISCONNECTED` now come from the same sweep, and `DISABLED` is never
  // counted, so a default host with ten disabled connectors stays silent.)
  // There is deliberately no HTTP route: `runOperations` takes no owner argument.
  { key: "scheduledJobs", label: "Scheduled operations cron: cross-owner portfolio risk sweep, stale-proposal expiry and broker connect/disconnect transitions under a DB-backed lock (CLI only, no HTTP route, no early-warning tiers, no sports/lottery cron)", state: "partial", tests: "unit + both adapters + CLI" },
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
  { key: "brokers", label: "Broker connector boundary, normalized data contracts and demo-only order gates (ten adapters registered, all disabled by default; one read-only route, no order routing, no simulated bridge, no adapter verified against its provider)", state: "partial", tests: "unit + http + gates" },
  // Slice 3 (row 14) adds the decision chain: the prediction pipeline and match
  // intelligence, the value and risk gates, the configuration service, the model
  // registry and calibration approval. Every decision is recorded immutably with the gate's
  // reasons. What is NOT ported and must not be read as present: correlation and staking,
  // tickets, settlement, calibration fitting, backtests and model drift. `SPORTS_MODEL_DRIFT`
  // is still unpublished (NV-6). The label has to say that, because "sports intelligence:
  // partial" reads as "half a betting engine".
  { key: "sports", label: "Sports data foundation, ingestion and decision chain: normalized fixture/odds/result contracts, data-quality and freshness gates, the provider boundary (sandbox simulation double-gated and labelled, generic REST provider never verified against a vendor), idempotent ingestion into the seven foundation tables under a unique execution key, derived provider health from stored observations, PHP-parity proven by differential test (the intelligence chain included), and the decision chain over four further tables: prediction pipeline and match intelligence, value and risk gates, the configuration service with append-only versions, the model registry, and calibration approve/reject, with the calibration fit refused until settlement exists. Every decision is stored immutably with its gate's reasons. Not ported: correlation and staking, tickets, settlement, calibration fitting, backtests and model drift. No stored result is verified \u2014 ingestion reports an outcome, it does not attest to one. Twelve sports.view reads, two sports.manage reads, and six sports.manage writes (sync, configuration patch, evaluate, calibration fit/approve/reject)", state: "partial", tests: "unit + php-parity + http + store" },
  { key: "lottery", label: "Lottery intelligence", state: "not-ported", tests: null },
  { key: "languageLearning", label: "Language learning and AI teacher", state: "not-ported", tests: null },
  { key: "leadDiscovery", label: "Lead discovery", state: "not-ported", tests: null },
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

export async function healthRoutes(app, { store, config, adapter, router, marketData = null, analysis = null, notifications = null, brokers = null, sports = null }) {
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
      // Same rule again: this describes the sports module from configuration alone.
      // It never contacts a provider, so an unauthenticated caller cannot make this
      // server reach a third-party feed. Derived health is therefore not reported
      // here at all -- it would be UNKNOWN with nothing behind it, and a field that
      // can only ever hold one value is a field that invites a reader to think it
      // was measured.
      sports: sports ? sports.statusSnapshot() : null,
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
