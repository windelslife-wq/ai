/**
 * Application assembly for the WINDELS AI WORKFORCE Node monolith.
 *
 * The HTTP layer is Node core `http` only: no Express, no Fastify, no middleware
 * framework. This module wires the pieces together and owns the request
 * pipeline; behaviour lives in `src/http/*` (transport), `src/security/*`
 * (policy), `src/modules/*` (business rules) and `src/persistence/*` (storage).
 *
 * Request pipeline (every step is asserted by tests in `test/`):
 *   request id → security headers → static or API
 *   API: no-store → CORS/preflight → cross-site mutation block → rate limit →
 *        route match (405/404) → bounded body → validation → guards (auth,
 *        CSRF, permission) → handler → response
 *   errors: AppError → status + code (+ Retry-After); anything else → 500 with
 *        the cause logged and never sent.
 */

import { createServer } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError, normalizeError } from "./http/errors.js";
import { createRouter, SUPPORTED_METHODS } from "./http/router.js";
import { readRawBody, contentTypeOf, parseJsonBody, parseFormBody, parseMultipart, boundaryOf } from "./http/bodies.js";
import { resolveStaticFile, serveStatic, DEFAULT_DENY_PREFIXES } from "./http/static.js";
import { validateRequest, validationDetails, validationMessage } from "./http/validate.js";
import { applyCorsHeaders, isCrossSiteMutation, resolveCors, securityHeaders } from "./security/headers.js";
import { createRateLimiter, createLoginGuard, createConcurrencyTracker } from "./security/ratelimit.js";
import { healthRoutes } from "./modules/platform/health.js";
import { identityRoutes } from "./modules/identity/routes.js";
import { siteRoutes } from "./modules/site/routes.js";
import { chatRoutes } from "./modules/chat/routes.js";
import { createChatService } from "./modules/chat/service.js";
import { mailRoutes } from "./modules/mail/routes.js";
import { createMailService } from "./modules/mail/service.js";
import { createSiteDocuments } from "./modules/site/documents.js";
import { marketDataRoutes } from "./modules/market-data/routes.js";
import { createMarketDataService } from "./modules/market-data/service.js";
import { analysisRoutes } from "./modules/analysis/routes.js";
import { createAnalysisService } from "./modules/analysis/service.js";
import { strategyRoutes } from "./modules/strategies/routes.js";
import { createStrategiesService } from "./modules/strategies/service.js";
import { paperRoutes } from "./modules/paper/routes.js";
import { createPaperService } from "./modules/paper/service.js";
import { executionRoutes } from "./modules/execution/routes.js";
import { createExecutionService } from "./modules/execution/service.js";
import { createScheduledJobs } from "./jobs/scheduled.js";
import { notificationRoutes } from "./modules/notifications/routes.js";
import { createNotificationService } from "./modules/notifications/service.js";
import { portfolioRoutes } from "./modules/portfolio/routes.js";
import { createPortfolioService } from "./modules/portfolio/service.js";
import { brokerRoutes } from "./modules/brokers/routes.js";
import { sportsRoutes } from "./modules/sports/routes.js";
import { createSportsService } from "./modules/sports/service.js";
import { lotteryRoutes } from "./modules/lottery/routes.js";
import { createLotteryService } from "./modules/lottery/service.js";
import { leadDiscoveryRoutes } from "./modules/leads/routes.js";
import { createLeadDiscoveryService } from "./modules/leads/service.js";
import { createBrokerRegistry } from "./modules/brokers/registry.js";

const JSON_TYPE = "application/json; charset=utf-8";

function writeJson(response, statusCode, body, headOnly = false, extraHeaders = {}) {
  response.statusCode = statusCode;
  if (!response.hasHeader("content-type")) response.setHeader("content-type", JSON_TYPE);
  for (const [name, value] of Object.entries(extraHeaders)) response.setHeader(name, value);
  const data = body === undefined ? "" : JSON.stringify(body);
  if (data) response.setHeader("content-length", Buffer.byteLength(data));
  if (headOnly || statusCode === 204 || statusCode === 304) return response.end();
  response.end(data);
}

export function createReply(response) {
  return {
    statusCode: 200,
    sent: false,
    payload: undefined,
    streamBody: null,
    ended: false,
    code(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    header(name, value) {
      response.setHeader(name, Array.isArray(value) ? value.map(String) : String(value));
      return this;
    },
    send(payload) {
      this.sent = true;
      this.payload = payload;
      return this;
    },
    /** Streams a file body; the pipeline pipes it and ends the response. */
    stream(readable) {
      this.sent = true;
      this.streamBody = readable;
      return this;
    },
    /** Terminates the response directly (redirects, file downloads). */
    end(data) {
      this.sent = true;
      this.ended = true;
      if (data !== undefined) response.end(data);
      else response.end();
      return this;
    },
  };
}

/**
 * Builds the module-facing `app` object: declarative route registration plus a
 * shared log, mirroring the Fastify-style API the modules were written against
 * while staying entirely inside Node core.
 */
export function createRegistrarFor(router, log) {
  const makeScoped = (prefix) => {
    const registrar = { log };
    for (const method of SUPPORTED_METHODS) {
      registrar[method.toLowerCase()] = (url, options, handler) => {
        const target = typeof options === "function" ? {} : options || {};
        const fn = typeof options === "function" ? options : handler;
        router.add(method, prefix ? path.posix.join(prefix, url) : url, target, fn);
      };
    }
    return registrar;
  };

  const root = makeScoped("");
  return {
    ...root,
    log,
    async register(plugin, options = {}) {
      const scoped = makeScoped(options.prefix || "");
      await plugin(scoped, options);
      return this;
    },
  };
}

export async function buildApp({ config, store, logger = true, publicDir = path.join(process.cwd(), "public"), adapter = store?.adapter || null }) {
  const router = createRouter();
  const app = createRegistrarFor(router, createLogger(config, logger));
  const rateLimiter = createRateLimiter({ maxEntries: config.rateLimit?.maxEntries ?? 20_000 });
  const loginGuard = createLoginGuard({
    maxFailures: config.rateLimit?.lockout?.failures ?? 5,
    lockMs: config.rateLimit?.lockout?.lockMs ?? 900_000,
  });

  const concurrency = createConcurrencyTracker({ maxEntries: config.rateLimit?.maxEntries ?? 20_000 });

  // One market-data service per app: the provider chain owns in-process caches and
  // circuit breakers, so both the API routes and the public status snapshot must
  // read the same instance rather than each building their own view of the world.
  const marketData = createMarketDataService({ config, store, log: app.log });

  // One analysis engine per app, built on that same market-data service: the engine
  // reads provider provenance to decide how much to trust its own opinion, so it
  // must see the same caches, breakers and provenance stamps as the API does.
  const analysis = createAnalysisService({ store, marketData, log: app.log });

  // One broker registry per app (row 13). All ten connectors legacy registered are
  // registered here too, and all ten are disabled unless the host configured them.
  // Registering is not enabling: an unconfigured connector reports DISABLED without
  // performing any I/O, and `tradingConnector()` returns null unless a bridge is
  // reachable, reports tradingEnabled, and holds a demo account (or live trading was
  // separately and explicitly allowed). Nothing in this process is given a connector
  // directly — the execution supervisor asks the manager, exactly as legacy did.
  const brokers = createBrokerRegistry({ brokers: config.brokers });

  // One notification service per app. It is built before the sports and paper
  // services because governance transitions publish through it, and it is handed to
  // each as an *optional* collaborator: a host whose migration 009 has not
  // been applied must still be able to move the kill switch, so the publisher
  // degrades to a logged no-op instead of failing the governance action.
  const notifications = createNotificationService({ store, log: app.log });

  // One outbound-mail service per app (row 5). Configuration comes from the
  // environment only; a default host has no transport, and every send then answers
  // with the legacy "Outgoing email is disabled" sentence. It is handed to the
  // public site as an optional collaborator (the contact copy) and to its own
  // administrator routes (the test send); no notification publisher is given it —
  // operator alerts are still stored and read in-product.
  const mail = createMailService({ config: config.mail, log: app.log });

  // Public website assistant (rows 4 and 18 — Phase 43). Deliberately not handed
  // `store`, `paper`, `strategies`, `execution`, `sports`, `lottery`, `brokers` or
  // `notifications`: it cannot read private account or domain records by construction.
  const chat = createChatService({ config: config.chat, log: app.log });

  // One sports service per app (row 14). Providers come from the environment only,
  // and a default host registers none at all: the sandbox provider needs
  // WINDELS_SPORTS_MODE=SANDBOX *and* WINDELS_SPORTS_SANDBOX=1, and the HTTP
  // provider needs a valid base URL.
  //
  // Slice 2 hands it the store, which is what changes the module's reach: with a
  // repository it can ingest fixtures, odds and results into the seven
  // `wf_sports_*` tables, read that history back, and derive a provider's health
  // from stored observations instead of reporting UNKNOWN for want of any. Without
  // one — a host whose migration 011 has not been applied — every stored read
  // refuses with 503 rather than returning an empty list that would look like an
  // empty database, and `/api/v1/sports/status` still answers, because configuration
  // is not something a missing table can make unknown.
  //
  // Slice 5 also hands it the notification service, because the drift monitor is the
  // publisher `SPORTS_MODEL_DRIFT` has been declared-and-unwired for since Phase 9
  // (NV-6): a drift warning now reaches the operator inbox, deduped per model per day.
  const sports = createSportsService({ config, store, notifications });

  // One lottery service per app (row 15, slice 1). The provider is legacy's
  // Platform.php choice: an authorized official feed when configured, else the
  // sandbox when WINDELS_LOTTERY_SANDBOX=1, else nothing — a default host has no
  // provider, which is the honest state for a platform with no verified source.
  // The service performs NO writes at construction (LT-4): the game registry row is
  // ensured lazily on the first call that needs it, so booting stays read-free.
  const lottery = createLotteryService({ config, store });
  const leads = createLeadDiscoveryService({ config, store });

  // The status surface reports the notification module alongside market data and
  // analysis, so an operator can see that alerts are stored-and-read only and that
  // no outbound delivery channel exists.
  await app.register(healthRoutes, { prefix: "/api/v1", store, config, adapter, router, marketData, analysis, notifications, brokers, sports, chat, leads });
  if (config.auth !== false) {
    await app.register(identityRoutes, { prefix: "/api/v1", store, config, loginGuard });
  }
  // The public site: contact intake over JSON, plus the rendered documents the
  // transport consults before it falls back to static files.
  await app.register(siteRoutes, { prefix: "/api/v1", store, config, mail });
  await app.register(chatRoutes, { prefix: "/api/v1", config, chat });
  await app.register(mailRoutes, { prefix: "/api/v1", store, config, mail });
  await app.register(marketDataRoutes, { prefix: "/api/v1", store, config, service: marketData });
  // The same tracker backs the platform-wide per-address ceiling; the analysis
  // module keys its slots `analysis:session:<id>` so the two never collide (R-26).
  await app.register(analysisRoutes, { prefix: "/api/v1", store, config, service: analysis, concurrency });
  // One Strategy Lab service per app, on that same market-data service: a backtest
  // reads provider provenance to label its own evidence synthetic-or-not, so it
  // must see the same caches, breakers and provenance stamps the API sees.
  const strategies = createStrategiesService({ store, marketData, log: app.log });
  // Seeding the four builtins is idempotent and runs on every boot, as the legacy
  // Platform did. A failure is logged rather than fatal: the platform must still
  // serve documents and every other API on a host whose migration 006 has not been
  // applied yet, and refusing to boot would turn a missing table into an outage.
  try {
    await strategies.seed();
  } catch (error) {
    app.log?.warn?.({ err: error }, "strategy builtin seeding failed");
  }
  // The same tracker backs the platform-wide ceiling; this module keys its slots
  // `strategies:session:<id>` so they never collide with `analysis:` ones (R-26).
  await app.register(strategyRoutes, { prefix: "/api/v1", store, config, service: strategies, marketData, concurrency });
  // Research-only portfolio optimization (row 9). Built on the SAME market-data
  // service as analysis and the Strategy Lab, so a series it labels synthetic is
  // labelled synthetic here too — the gates that refuse a synthetic/live mix depend
  // on that shared provenance rather than on a second opinion. Deliberately not
  // given `paper`, `strategies` or `execution`: it cannot reach an order path.
  const portfolio = createPortfolioService({ store, marketData, log: app.log });
  // The same tracker backs the platform-wide ceiling; this module keys its slots
  // `portfolio:session:<id>` so they never collide with `analysis:` or `strategies:`
  // ones (R-26).
  await app.register(portfolioRoutes, { prefix: "/api/v1", store, config, service: portfolio, marketData, concurrency });
  const paper = createPaperService({ store, marketData, strategies, notifications, log: app.log });
  await app.register(paperRoutes, { prefix: "/api/v1", store, config, service: paper, marketData, strategies, log: app.log });
  const execution = createExecutionService({ store, paper, strategies, notifications, brokers, log: app.log });
  await app.register(executionRoutes, { prefix: "/api/v1", store, config, service: execution, paper, strategies, notifications, log: app.log });
  await app.register(notificationRoutes, { prefix: "/api/v1", store, config, service: notifications, log: app.log });
  // Broker Center (row 13): one read-only route. There is no order endpoint and no
  // connector-enable endpoint here — routing stays in the execution supervisor.
  await app.register(brokerRoutes, { prefix: "/api/v1", store, config, brokers });
  // Sports Intelligence (row 14): the stored reads, the ingestion writes, the decision
  // chain, the ticket engine and the measured surface. The paper service is passed in as
  // well, because the ticket decision route carries legacy's second guard — the platform
  // kill switch (`Api_sports::decide_ticket`), which only the paper module normalizes.
  await app.register(sportsRoutes, { prefix: "/api/v1", store, config, sports, paper });
  // Lottery Intelligence (row 15, slice 1): the foundation surface — status, rules,
  // draws, statistics, providers, health, jobs, and the two lottery.manage writes
  // (probe and sync). Legacy's thirty-odd other lottery endpoints read tables this
  // slice does not create, so none of them is ported; the status route carries the
  // not-ported matrix.
  await app.register(lotteryRoutes, { prefix: "/api/v1", store, config, lottery });
  // Lead Discovery (row 17 — Phase 45): organization-scoped workspaces, provider
  // health, business search, duplicate review, collections, pipeline, coverage,
  // search history, and CSV-safe export.
  await app.register(leadDiscoveryRoutes, { prefix: "/api/v1", store, config, service: leads });

  /**
   * Scheduled operations (row 19): the portfolio risk sweep and the cross-owner
   * stale-proposal expiry that legacy ran from `Tools::cron()`.
   *
   * Deliberately **not registered as a route**. `runOperations` takes no owner
   * argument: it scans every paper account on the platform and expires proposals
   * belonging to every operator. Exposing that over HTTP would turn any reachable
   * caller — or any session with the wrong permission check — into a platform-wide
   * actor, which is the same mistake AV-1 avoided by requiring `identity.users.view`
   * for the audit trail. The host's cron drives it through
   * `tools/scheduled-jobs.mjs`, which holds a `wf_job_locks` row for the duration.
   */
  const jobs = createScheduledJobs({ store, paper, execution, notifications, brokers, log: app.log });
  const siteDocuments = createSiteDocuments({ config, store, log: app.log, rateLimiter, publicDir });
  for (const extra of config.modules || []) await app.register(extra, { prefix: "/api/v1", store, config, loginGuard });

  /** Compatibility alias for the pre-pagination admin surface. */
  app.get("/api/v1/admin/identity/users", { preHandler: [createAuthenticatorLazy(store, config, "identity.users.view")] }, async () => ({
    users: await store.listUsers(100),
    deprecated: "Use GET /api/v1/admin/users, which supports search, sort and pagination.",
  }));

  const server = createServer((incoming, outgoing) => {
    handle(incoming, outgoing).catch((error) => {
      app.log.error({ errorCode: error?.code || "UNEXPECTED_REQUEST_FAILURE" }, "Request pipeline failed outside the handler");
      if (!outgoing.headersSent) writeJson(outgoing, 500, { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
      else outgoing.destroy();
    });
  });
  server.requestTimeout = config.requestTimeoutMs ?? 20_000;
  server.headersTimeout = Math.min(10_000, config.requestTimeoutMs ?? 20_000);
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  async function handle(incoming, outgoing) {
    const startedAt = process.hrtime.bigint();
    const requestId = randomUUID();
    securityHeaders(outgoing, { production: config.production, requestId, contentSecurityPolicy: config.contentSecurityPolicy });
    const method = incoming.method === "HEAD" ? "GET" : incoming.method;
    const headOnly = incoming.method === "HEAD";
    let parsedUrl;
    try {
      parsedUrl = new URL(incoming.url || "/", `http://${incoming.headers.host || "localhost"}`);
    } catch {
      writeJson(outgoing, 400, { error: { code: "INVALID_REQUEST", message: "The request target is invalid" } }, headOnly);
      return;
    }
    const pathname = parsedUrl.pathname;
    const client = clientAddress(incoming, config.trustProxy);
    // `buildRequest` decorates the IncomingMessage itself, so `request === incoming`
    // for the rest of the pipeline and both branches see the same object.
    const request = buildRequest(incoming, { requestId, client, parsedUrl });
    request.pathname = pathname;

    // Concurrency ceiling (the second half of F-13): a windowed counter limits
    // rate, this limits what one address can hold open at once. Disabled at 0.
    if (!concurrency.acquire(client, config.maxRequestsPerClient ?? 0)) {
      outgoing.setHeader("retry-after", "1");
      writeJson(outgoing, 429, { error: { code: "TOO_MANY_CONCURRENT_REQUESTS", message: "Too many concurrent requests from this address" } }, headOnly);
      logRequest({ incoming, outgoing, requestId, startedAt, pathname, method, status: 429, kind: "rejected", errorCode: "TOO_MANY_CONCURRENT_REQUESTS" });
      return;
    }

    try {
      await dispatch(request, outgoing, { requestId, startedAt, pathname, method, headOnly });
    } finally {
      concurrency.release(client);
    }
  }

  async function dispatch(incoming, outgoing, { requestId, startedAt, pathname, method, headOnly }) {
    if (!pathname.startsWith("/api/")) {
      await handleDocument(incoming, outgoing, { requestId, startedAt, pathname, method, headOnly });
      return;
    }

    const client = incoming.clientAddress;
    const request = incoming;
    const reply = createReply(outgoing);
    outgoing.setHeader("cache-control", "no-store");

    try {
      const cors = resolveCors(request, config);
      if (!cors.allowed) throw AppError.forbidden("The request origin is not allowed", { code: "ORIGIN_INVALID" });
      if (cors.origin) applyCorsHeaders(outgoing, cors.origin);
      if (method === "OPTIONS") {
        outgoing.statusCode = 204;
        outgoing.end();
        return logRequest({ incoming, outgoing, requestId, startedAt, pathname, method, status: 204, kind: "api" });
      }
      if (isCrossSiteMutation(incoming, config)) {
        throw AppError.forbidden("The request origin is not allowed", { code: "ORIGIN_INVALID" });
      }

      if (config.rateLimit.enabled !== false) {
        const wait = rateLimiter.check(`api:${client}`, config.rateLimit.api ?? { max: 120, windowMs: 60_000 });
        if (wait) throw AppError.tooManyRequests("Too many requests", { retryAfter: wait });
      }

      const match = router.find(method, pathname);
      if (!match) throw AppError.notFound();
      if (match.methodMismatch) {
        outgoing.setHeader("allow", match.allowed.join(", "));
        throw new AppError(405, "METHOD_NOT_ALLOWED", "This resource does not support that method");
      }
      const { route, params } = match;
      request.params = params;
      request.route = route;

      if (route.options?.config?.rateLimit && config.rateLimit.enabled !== false) {
        const limit = route.options.config.rateLimit;
        const wait = rateLimiter.check(`route:${route.path}:${client}`, { max: limit.max, windowMs: limit.windowMs ?? limit.timeWindow });
        if (wait) throw AppError.tooManyRequests(limit.message || "Too many requests", { retryAfter: wait });
      }

      await readRequestBody(request, route, config);

      const validation = validateRequest({ bodySchema: route.options?.bodySchema, querySchema: route.options?.querySchema, paramsSchema: route.options?.paramsSchema }, request);
      if (validation.issues.length) {
        throw AppError.badRequest(validationMessage(validation.issues), {
          code: "INVALID_REQUEST",
          details: validationDetails(validation.issues),
        });
      }
      request.body = validation.value.body;
      request.query = validation.value.query;
      request.params = { ...request.params, ...validation.value.params };

      for (const preHandler of (route.options?.preHandler || []).flat()) {
        await preHandler(request, reply);
        if (reply.sent) break;
      }
      if (reply.ended) return logRequest({ incoming, outgoing, requestId, startedAt, pathname, method, status: reply.statusCode, kind: "api" });

      if (!reply.sent) {
        const result = await route.handler(request, reply);
        // A handler may reply through `reply.send()`/`reply.stream()` and return
        // the reply itself; only adopt a returned value when nothing was sent.
        if (!reply.sent && result !== reply) reply.send(result);
      }

      if (reply.streamBody) {
        await new Promise((resolve, reject) => {
          reply.streamBody.once("error", reject);
          outgoing.once("finish", resolve);
          outgoing.once("close", resolve);
          if (headOnly) {
            reply.streamBody.destroy();
            outgoing.end();
            return;
          }
          reply.streamBody.pipe(outgoing);
        });
      } else if (!reply.ended && !outgoing.writableEnded) {
        if (reply.payload === undefined) {
          outgoing.statusCode = reply.statusCode;
          outgoing.end();
        } else {
          writeJson(outgoing, reply.statusCode, reply.payload, headOnly);
        }
      }
      logRequest({ incoming, outgoing, requestId, startedAt, pathname, method, status: outgoing.statusCode, kind: "api" });
    } catch (error) {
      const normalized = error instanceof AppError ? error : normalizeError(error);
      const statusCode = normalized.statusCode || 500;
      outgoing.statusCode = statusCode;
      if (normalized.retryAfter) outgoing.setHeader("retry-after", String(normalized.retryAfter));
      if (statusCode >= 500) {
        app.log.error({
          requestId,
          errorCode: normalized.internalCode || normalized.code,
          cause: normalized.cause?.code || undefined,
          path: pathname,
          // Stack traces are never emitted in production: they leak absolute paths.
          stack: config.production ? undefined : (error?.stack || normalized.stack),
        }, "Request failed");
      } else if (statusCode === 401 || statusCode === 403) {
        app.log.info({ requestId, code: normalized.code, path: pathname }, "Request rejected by security policy");
      }
      if (outgoing.headersSent && statusCode >= 500) {
        outgoing.destroy();
        return;
      }
      writeJson(outgoing, statusCode, normalized.toBody?.() || { error: { code: normalized.code, message: normalized.message } }, headOnly);
      logRequest({ incoming, outgoing, requestId, startedAt, pathname, method, status: statusCode, kind: "api", errorCode: normalized.code });
    }
  }

  /**
   * Everything that is not `/api/*`: rendered public pages, generated SEO
   * documents, the legacy-compatible contact form, then static files, then a
   * content-negotiated 404 (HTML for a browser, JSON for a client that asked).
   */
  async function handleDocument(incoming, outgoing, { requestId, startedAt, pathname, method, headOnly }) {
    const allowed = siteDocuments.methodsFor(pathname);
    if (allowed.length && !allowed.includes(incoming.method)) {
      outgoing.setHeader("allow", allowed.join(", "));
      writeJson(outgoing, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "This resource does not support that method" } }, headOnly);
      logRequest({ incoming, outgoing, requestId, startedAt, pathname, method, status: 405, kind: "document" });
      return;
    }
    if (!["GET", "HEAD"].includes(incoming.method) && allowed.length === 0) {
      // No document route accepts that verb. 405 only when the path really is a
      // resource (a static file); otherwise 404 is the honest answer, so a POST
      // to a made-up path cannot be used to probe which files exist.
      const existing = await resolveStaticFile(publicDir, pathname, { denyPrefixes: DEFAULT_DENY_PREFIXES }).catch(() => null);
      if (existing) outgoing.setHeader("allow", "GET, HEAD");
      writeJson(outgoing, existing ? 405 : 404, existing
        ? { error: { code: "METHOD_NOT_ALLOWED", message: "This resource only supports GET and HEAD" } }
        : { error: { code: "NOT_FOUND", message: "The requested resource was not found" } }, headOnly);
      logRequest({ incoming, outgoing, requestId, startedAt, pathname, method, status: outgoing.statusCode, kind: "document" });
      return;
    }
    try {
      const rendered = await siteDocuments.handle(incoming, outgoing, { headOnly });
      if (rendered) {
        logRequest({ incoming, outgoing, requestId, startedAt, pathname, method, status: outgoing.statusCode, kind: "document" });
        return;
      }
      const served = await serveStatic(incoming, outgoing, {
        publicRoot: publicDir,
        pathname,
        headOnly,
        denyPrefixes: DEFAULT_DENY_PREFIXES,
        spaFallback: (candidate, accept) => candidate === "/app" || candidate === "/app/" || (candidate.startsWith("/app/") && accept.includes("text/html")),
      });
      if (!served) {
        // A browser that asked for a page gets the site's own 404; a client that
        // asked for JSON (or an asset path) keeps the machine-readable one.
        const wantsHtml = String(incoming.headers.accept || "").includes("text/html");
        if (wantsHtml) siteDocuments.renderNotFound(incoming, outgoing, { headOnly });
        else writeJson(outgoing, 404, { error: { code: "NOT_FOUND", message: "The requested resource was not found" } }, headOnly);
      }
      logRequest({ incoming, outgoing, requestId, startedAt, pathname, method, status: outgoing.statusCode, kind: "static" });
    } catch (error) {
      app.log.error({ requestId, errorCode: error?.code || "DOCUMENT_ERROR", cause: error?.cause?.code }, "Document or static response failed");
      if (outgoing.headersSent) outgoing.destroy();
      else writeJson(outgoing, 500, { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } }, headOnly);
    }
  }

  function buildRequest(incoming, { requestId, client, parsedUrl }) {
    const protocol = config.trustProxy && typeof incoming.headers["x-forwarded-proto"] === "string"
      ? String(incoming.headers["x-forwarded-proto"].split(",")[0]).trim()
      : null;
    const query = Object.create(null);
    for (const [key, value] of parsedUrl.searchParams) {
      if (Object.hasOwn(query, key)) query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
      else query[key] = value;
    }
    return Object.assign(incoming, {
      requestId,
      clientAddress: client,
      params: Object.create(null),
      query,
      body: undefined,
      rawBody: Buffer.alloc(0),
      upload: null,
      hostname: new URL(`http://${incoming.headers.host || "localhost"}`).hostname,
      protocol: protocol || (incoming.socket.encrypted ? "https" : "http"),
      log: {
        info: (fields, message) => app.log.info({ requestId, ...fields }, message),
        warn: (fields, message) => app.log.warn({ requestId, ...fields }, message),
        error: (fields, message) => app.log.error({ requestId, ...fields }, message),
      },
    });
  }

  function logRequest({ requestId, startedAt, pathname, method, status, kind, errorCode }) {
    if (config.logLevel === "silent") return;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const level = status >= 500 ? "error" : "info";
    app.log[level](
      { requestId, kind, method, path: pathname, status, durationMs: Math.round(durationMs * 100) / 100, errorCode: errorCode || undefined },
      "request",
    );
  }

  async function readRequestBody(request, route, config) {
    const method = request.method;
    if (["GET", "HEAD", "OPTIONS"].includes(method)) return;
    const declaredLength = Number(request.headers["content-length"] || 0);
    if (!Number.isFinite(declaredLength) ? false : declaredLength === 0) {
      request.body = undefined;
      return;
    }
    const limit = route.options?.config?.multipart ? config.uploads.bodyLimitBytes : config.bodyLimitBytes;
    // A route that knows what its body means can word the oversize refusal itself
    // (the avatar upload says "Profile image must be 2 MB or smaller"); the limit
    // is unchanged, only the sentence.
    const oversizeMessage = route.options?.config?.oversizeMessage || null;
    const { buffer } = await readRawBody(request, limit, { message: oversizeMessage });
    request.rawBody = buffer;
    const type = contentTypeOf(request);
    if (type === "application/json" || type === "text/json") {
      request.body = parseJsonBody(buffer, { required: false });
      return;
    }
    if (type === "application/x-www-form-urlencoded") {
      request.body = parseFormBody(buffer);
      return;
    }
    if (type === "multipart/form-data") {
      if (!route.options?.config?.multipart) {
        throw AppError.unsupportedMediaType("This endpoint does not accept multipart uploads");
      }
      const { fields, files } = parseMultipart(buffer, boundaryOf(request), { maxFileBytes: config.uploads.maxBytes, message: oversizeMessage });
      request.body = fields;
      request.upload = { fields, file: files[0] || null, files };
      return;
    }
    if (buffer.length === 0) return;
    // Direct binary uploads (avatar PUT-style) are accepted only where declared.
    if (route.options?.config?.multipart && type.startsWith("image/")) {
      request.upload = { fields: {}, file: { field: "avatar", filename: null, contentType: type, data: buffer }, files: [{ field: "avatar", data: buffer }] };
      return;
    }
    throw AppError.unsupportedMediaType("API requests must use application/json, x-www-form-urlencoded or multipart/form-data");
  }

  let listening = false;
  let listenPromise = null;
  const api = {
    server,
    log: app.log,
    config,
    store,
    adapter,
    router,
    loginGuard,
    rateLimiter,
    concurrency,
    siteDocuments,
    jobs,
    sports,
    lottery,
    routes: () => router.list(),
    documents: () => siteDocuments.paths(),
    async listen({ host = config.host, port = config.port } = {}) {
      if (listening) return server.address();
      if (listenPromise) return listenPromise;
      listenPromise = new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          listening = true;
          resolve(server.address());
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      try {
        return await listenPromise;
      } catch (error) {
        listenPromise = null;
        throw error;
      }
    },
    async inject({ method = "GET", url = "/", headers = {}, payload } = {}) {
      if (!listening) await api.listen({ host: "127.0.0.1", port: 0 });
      const address = server.address();
      const requestHeaders = new Headers(headers);
      let body;
      if (payload !== undefined) {
        if (Buffer.isBuffer(payload)) body = payload;
        else if (typeof payload === "string") body = payload;
        else body = JSON.stringify(payload);
        // A default JSON content type mirrors a browser fetch; tests that need to
        // exercise content-type negotiation set the header explicitly.
        if (!requestHeaders.has("content-type")) requestHeaders.set("content-type", "application/json");
      }
      const response = await fetch(`http://127.0.0.1:${address.port}${url}`, {
        method,
        headers: requestHeaders,
        body: ["GET", "HEAD"].includes(method) ? undefined : body,
        redirect: "manual",
      });
      const responseHeaders = Object.fromEntries(response.headers.entries());
      if (typeof response.headers.getSetCookie === "function") {
        const cookies = response.headers.getSetCookie();
        if (cookies.length) responseHeaders["set-cookie"] = cookies.length === 1 ? cookies[0] : cookies;
      }
      const responseBody = await response.arrayBuffer();
      const text = Buffer.from(responseBody).toString("utf8");
      return {
        statusCode: response.status,
        headers: responseHeaders,
        body: text,
        buffer: Buffer.from(responseBody),
        json() {
          return text ? JSON.parse(text) : null;
        },
      };
    },
    async close() {
      if (!listening) return;
      server.closeIdleConnections?.();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      listening = false;
      listenPromise = null;
    },
  };
  return api;
}

/**
 * Client address used for rate limiting. `x-forwarded-for` is only trusted when
 * TRUST_PROXY is explicitly enabled, otherwise a client could spoof around limits.
 */
export function clientAddress(request, trustProxy) {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length < 512) {
      const candidate = forwarded.split(",")[0].trim();
      if (candidate && candidate.length <= 128) return candidate;
    }
  }
  return request.socket?.remoteAddress || "unknown";
}

function createLogger(config, enabled) {
  const levels = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5, silent: -1 };
  const threshold = levels[config.logLevel] ?? 3;
  const emit = (level, fields, message) => {
    if (!enabled || levels[level] > threshold) return;
    const line = JSON.stringify({ level, time: new Date().toISOString(), message, ...fields });
    if (level === "error" || level === "fatal") console.error(line);
    else console.info(line);
  };
  return {
    info: (fields, message) => emit("info", fields, message),
    warn: (fields, message) => emit("warn", fields, message),
    error: (fields, message) => emit("error", fields, message),
    debug: (fields, message) => emit("debug", fields, message),
    fatal: (fields, message) => emit("fatal", fields, message),
    trace: (fields, message) => emit("trace", fields, message),
  };
}

/**
 * The compatibility alias needs the guards before the module list is built; it
 * is resolved lazily so the authenticator shares the identity module's store.
 */
function createAuthenticatorLazy(store, config, permission) {
  let inner = null;
  const guard = async (request, reply) => {
    if (!inner) {
      const { createAuthenticator, requirePermission } = await import("./modules/platform/guards.js");
      inner = async (req, rep) => {
        await createAuthenticator({ store, config })(req, rep);
        await requirePermission(permission, config)(req, rep);
      };
    }
    await inner(request, reply);
  };
  // The route inventory is the parity ledger, so an inline guard has to declare its
  // permission the same way `guarded(permission)` does — otherwise a protected route
  // reads as unprotected in `GET /api/v1/system/routes`.
  if (permission) guard.permission = permission;
  return guard;
}

export { AppError };
