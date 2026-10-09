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
  { key: "identity", label: "Identity, sessions, RBAC, account management", state: "ported", tests: "unit + http + parity" },
  // Pages, robots/sitemap/manifest, the PWA shell and contact intake are ported
  // and parity-tested; the legacy public chat assistant is not, so the module is
  // reported partial rather than ported.
  { key: "publicSite", label: "Public site, SEO + PWA shell, contact intake (chat assistant not ported)", state: "partial", tests: "unit + http + parity" },
  { key: "audit", label: "Security audit trail for ported actions", state: "partial", tests: "unit" },
  { key: "notifications", label: "Operator notifications", state: "not-ported", tests: null },
  // Market data is ported: the provider chain, normalization, circuit breakers
  // and the three legacy endpoints, with provenance that labels synthetic output.
  { key: "marketData", label: "Market data providers and health", state: "ported", tests: "unit + http + parity" },
  { key: "analysis", label: "Analysis engines, agents, consensus", state: "not-ported", tests: null },
  { key: "strategies", label: "Strategy lab, lifecycle, backtesting", state: "not-ported", tests: null },
  { key: "paperTrading", label: "Paper trading engine", state: "not-ported", tests: null },
  { key: "risk", label: "Risk engine and portfolio monitor", state: "not-ported", tests: null },
  { key: "execution", label: "Execution supervisor (15-step pipeline)", state: "not-ported", tests: null },
  { key: "brokers", label: "Broker connectors", state: "not-ported", tests: null },
  { key: "sports", label: "Sports intelligence", state: "not-ported", tests: null },
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

export async function healthRoutes(app, { store, config, adapter, router, marketData = null }) {
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
      trading: {
        enabled: false,
        reason: "The trading, risk, execution and broker modules are not ported to Node yet. The legacy application remains authoritative.",
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
