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
import { createSiteDocuments } from "./modules/site/documents.js";
import { marketDataRoutes } from "./modules/market-data/routes.js";
import { createMarketDataService } from "./modules/market-data/service.js";
import { analysisRoutes } from "./modules/analysis/routes.js";
import { createAnalysisService } from "./modules/analysis/service.js";

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

  await app.register(healthRoutes, { prefix: "/api/v1", store, config, adapter, router, marketData, analysis });
  if (config.auth !== false) {
    await app.register(identityRoutes, { prefix: "/api/v1", store, config, loginGuard });
  }
  // The public site: contact intake over JSON, plus the rendered documents the
  // transport consults before it falls back to static files.
  await app.register(siteRoutes, { prefix: "/api/v1", store, config });
  await app.register(marketDataRoutes, { prefix: "/api/v1", store, config, service: marketData });
  await app.register(analysisRoutes, { prefix: "/api/v1", store, config, service: analysis });
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
        if (wait) throw AppError.tooManyRequests("Too many requests", { retryAfter: wait });
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
    const { buffer } = await readRawBody(request, limit);
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
      const { fields, files } = parseMultipart(buffer, boundaryOf(request), { maxFileBytes: config.uploads.maxBytes });
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
