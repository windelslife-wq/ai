import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";

const BODY_LIMIT = 16 * 1024;
const API_PREFIX = "/api/v1";
const MIME_TYPES = Object.freeze({
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
  ".woff2": "font/woff2",
});

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) return value.map(String);
  return String(value);
}

function createReply(response) {
  return {
    statusCode: 200,
    sent: false,
    payload: undefined,
    code(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    header(name, value) {
      response.setHeader(name, normalizeHeaderValue(value));
      return this;
    },
    send(payload) {
      this.sent = true;
      this.payload = payload;
      return this;
    },
  };
}

function validateSchema(schema, value) {
  if (!schema) return null;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "body must be an object";
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) return `body.${key} is required`;
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      if (Object.keys(value).some((key) => !allowed.has(key))) return "body contains an unknown property";
    }
    for (const [key, rules] of Object.entries(schema.properties || {})) {
      const current = value[key];
      if (current === undefined) continue;
      if (rules.type === "string" && typeof current !== "string") return `body.${key} must be a string`;
      if (rules.type === "string" && rules.minLength !== undefined && current.length < rules.minLength) return `body.${key} is too short`;
      if (rules.type === "string" && rules.maxLength !== undefined && current.length > rules.maxLength) return `body.${key} is too long`;
    }
  }
  return null;
}

function routePath(prefix, route) {
  const left = prefix.replace(/\/$/, "");
  const right = route.startsWith("/") ? route : `/${route}`;
  return `${left}${right}` || "/";
}

function isWithin(parent, child) {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function makeSecurityHeaders(response, { production, requestId }) {
  response.setHeader("x-request-id", requestId);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("content-security-policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
  ].join("; "));
  if (production) response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
}

function createRateLimiter() {
  const buckets = new Map();
  return (key, { max, windowMs }, now = Date.now()) => {
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (buckets.size > 10_000) {
      for (const [bucketKey, entry] of buckets) {
        if (now >= entry.resetAt) buckets.delete(bucketKey);
      }
    }
    return bucket.count <= max ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  };
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > BODY_LIMIT) {
    throw new HttpError(413, "BODY_TOO_LARGE", "The request body is too large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, "BODY_TOO_LARGE", "The request body is too large");
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  const contentType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "API requests must use application/json");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON");
  }
}

function ipAddress(request, trustProxy) {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length < 512) {
      const candidate = forwarded.split(",")[0].trim();
      if (candidate) return candidate;
    }
  }
  return request.socket.remoteAddress || "unknown";
}

function writeJson(response, statusCode, body, headOnly = false) {
  response.statusCode = statusCode;
  if (!response.hasHeader("content-type")) response.setHeader("content-type", "application/json; charset=utf-8");
  const data = body === undefined ? "" : JSON.stringify(body);
  if (data) response.setHeader("content-length", Buffer.byteLength(data));
  if (headOnly || statusCode === 204 || statusCode === 304) return response.end();
  response.end(data);
}

function staticAssetPath(publicRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return null;
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.startsWith("."))) return null;
  const relative = segments.join(path.sep) || "index.html";
  const absolute = path.resolve(publicRoot, relative);
  return isWithin(publicRoot, absolute) ? absolute : null;
}

async function resolveStaticFile(publicRoot, pathname, allowSpaFallback) {
  const publicRealPath = await realpath(publicRoot).catch(() => null);
  if (!publicRealPath) return null;
  const candidate = staticAssetPath(publicRealPath, pathname);
  if (!candidate) return null;
  let targetRealPath = await realpath(candidate).catch(() => null);
  if (targetRealPath) {
    const initialDetails = await stat(targetRealPath).catch(() => null);
    if (initialDetails?.isDirectory()) {
      targetRealPath = await realpath(path.join(targetRealPath, "index.html")).catch(() => null);
    }
  }
  if (!targetRealPath && allowSpaFallback) {
    targetRealPath = await realpath(path.join(publicRealPath, "app", "index.html")).catch(() => null);
  }
  if (!targetRealPath || !isWithin(publicRealPath, targetRealPath)) return null;
  const details = await stat(targetRealPath).catch(() => null);
  if (!details?.isFile()) return null;
  return { filePath: targetRealPath, details };
}

async function serveStatic(request, response, publicRoot, pathname, headOnly) {
  const accept = String(request.headers.accept || "");
  const appEntry = pathname === "/app" || pathname === "/app/";
  const appHtmlRoute = pathname.startsWith("/app/") && accept.includes("text/html");
  const asset = await resolveStaticFile(publicRoot, pathname, appEntry || appHtmlRoute);
  if (!asset) return false;
  const extension = path.extname(asset.filePath).toLowerCase();
  const type = MIME_TYPES[extension];
  if (!type) return false;
  const { filePath, details } = asset;
  const etag = `W/\"${details.size.toString(16)}-${Math.trunc(details.mtimeMs).toString(16)}\"`;
  response.statusCode = 200;
  response.setHeader("content-type", type);
  response.setHeader("content-length", details.size);
  response.setHeader("last-modified", details.mtime.toUTCString());
  response.setHeader("etag", etag);
  const isHtml = extension === ".html";
  const isServiceWorker = pathname === "/service-worker.js";
  const isManifest = pathname === "/manifest.webmanifest";
  const hashedAsset = /[.-][a-f0-9]{8,}[.-]/i.test(pathname);
  response.setHeader("cache-control", isHtml || isServiceWorker || isManifest
    ? "no-cache"
    : hashedAsset ? "public, max-age=31536000, immutable" : "public, max-age=3600");
  if (request.headers["if-none-match"] === etag) {
    response.statusCode = 304;
    response.removeHeader("content-length");
    response.end();
    return true;
  }
  if (headOnly) {
    response.end();
    return true;
  }
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.once("error", reject);
    response.once("finish", resolve);
    response.once("close", resolve);
    stream.pipe(response);
  });
  return true;
}

function errorBody(code, message) {
  return { error: { code, message } };
}

export async function buildApp({ config, store, logger = true, publicDir = path.join(process.cwd(), "public") }) {
  const routes = [];
  const checkRateLimit = createRateLimiter();
  const log = {
    info(fields, message) {
      if (logger) console.info(JSON.stringify({ level: "info", message, ...fields }));
    },
    error(fields, message) {
      if (logger) console.error(JSON.stringify({ level: "error", message, ...fields }));
    },
  };

  function addRoute(method, url, options, handler) {
    if (typeof options === "function") {
      handler = options;
      options = {};
    }
    if (!url.startsWith("/")) throw new TypeError("Routes must start with /");
    if (routes.some((route) => route.method === method && route.url === url)) {
      throw new Error(`Duplicate route: ${method} ${url}`);
    }
    routes.push({ method, url, options: options || {}, handler });
  }

  const registrar = {
    get(url, options, handler) { addRoute("GET", url, options, handler); },
    post(url, options, handler) { addRoute("POST", url, options, handler); },
  };
  const app = {
    ...registrar,
    log,
    async register(plugin, options = {}) {
      const prefix = options.prefix || "";
      const scoped = {
        get(url, routeOptions, handler) {
          addRoute("GET", routePath(prefix, url), routeOptions, handler);
        },
        post(url, routeOptions, handler) {
          addRoute("POST", routePath(prefix, url), routeOptions, handler);
        },
      };
      await plugin(scoped, options);
      return this;
    },
  };

  await app.register(healthRoutes, { prefix: API_PREFIX, store });
  await app.register(authRoutes, { prefix: API_PREFIX, store, config });

  const server = createServer(async (incoming, outgoing) => {
    const requestId = randomUUID();
    makeSecurityHeaders(outgoing, { production: config.production, requestId });
    const headOnly = incoming.method === "HEAD";
    const method = headOnly ? "GET" : incoming.method;
    const originHost = incoming.headers.host || "localhost";
    let parsedUrl;
    try {
      parsedUrl = new URL(incoming.url || "/", `http://${originHost}`);
    } catch {
      writeJson(outgoing, 400, errorBody("INVALID_REQUEST", "The request target is invalid"), headOnly);
      return;
    }
    const pathname = parsedUrl.pathname;

    if (!pathname.startsWith(API_PREFIX)) {
      if (!["GET", "HEAD"].includes(incoming.method)) {
        outgoing.setHeader("allow", "GET, HEAD");
        writeJson(outgoing, 405, errorBody("METHOD_NOT_ALLOWED", "This resource only supports GET and HEAD"), headOnly);
        return;
      }
      try {
        const served = await serveStatic(incoming, outgoing, publicDir, pathname, headOnly);
        if (served) return;
      } catch (error) {
        log.error({ requestId, errorCode: error?.code || "STATIC_ERROR" }, "Static response failed");
        if (outgoing.headersSent) {
          outgoing.destroy();
          return;
        }
        writeJson(outgoing, 500, errorBody("INTERNAL_ERROR", "An unexpected error occurred"), headOnly);
        return;
      }
      writeJson(outgoing, 404, errorBody("NOT_FOUND", "The requested resource was not found"), headOnly);
      return;
    }

    outgoing.setHeader("cache-control", "no-store");
    const crossSiteMutation = !["GET", "HEAD", "OPTIONS"].includes(incoming.method)
      && incoming.headers["sec-fetch-site"] === "cross-site";
    if (crossSiteMutation) {
      writeJson(outgoing, 403, errorBody("ORIGIN_INVALID", "The request origin is not allowed"), headOnly);
      return;
    }
    const client = ipAddress(incoming, config.trustProxy);
    const route = routes.find((candidate) => candidate.method === method && candidate.url === pathname);
    const globalWait = checkRateLimit(`api:${client}`, { max: 120, windowMs: 60_000 });
    if (globalWait) {
      outgoing.setHeader("retry-after", String(globalWait));
      writeJson(outgoing, 429, errorBody("RATE_LIMITED", "Too many requests"), headOnly);
      return;
    }
    if (!route) {
      writeJson(outgoing, 404, errorBody("NOT_FOUND", "The requested resource was not found"), headOnly);
      return;
    }
    const routeLimit = route.options?.config?.rateLimit;
    if (routeLimit) {
      const wait = checkRateLimit(`route:${route.url}:${client}`, {
        max: routeLimit.max,
        windowMs: routeLimit.timeWindow,
      });
      if (wait) {
        outgoing.setHeader("retry-after", String(wait));
        writeJson(outgoing, 429, errorBody("RATE_LIMITED", "Too many requests"), headOnly);
        return;
      }
    }

    let body;
    try {
      if (method !== "GET" && method !== "HEAD") body = await readJsonBody(incoming);
      const validationError = validateSchema(route.options?.schema?.body, body);
      if (validationError) throw new HttpError(400, "INVALID_REQUEST", "Request validation failed");
      const hostname = new URL(`http://${originHost}`).hostname;
      const protocolHeader = config.trustProxy && typeof incoming.headers["x-forwarded-proto"] === "string"
        ? incoming.headers["x-forwarded-proto"].split(",")[0].trim()
        : null;
      const request = Object.assign(incoming, {
        body,
        hostname,
        protocol: protocolHeader || (incoming.socket.encrypted ? "https" : "http"),
        log: { error: (fields, message) => log.error({ requestId, ...fields }, message) },
      });
      const reply = createReply(outgoing);
      for (const preHandler of route.options?.preHandler || []) {
        await preHandler(request, reply);
        if (reply.sent) break;
      }
      if (!reply.sent) {
        const result = await route.handler(request, reply);
        if (!reply.sent) reply.send(result);
      }
      if (reply.sent) {
        const payload = reply.payload;
        if (payload === undefined) {
          outgoing.statusCode = reply.statusCode;
          outgoing.end();
        } else {
          writeJson(outgoing, reply.statusCode, payload, headOnly);
        }
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.statusCode : 500;
      const code = error instanceof HttpError ? error.code : "INTERNAL_ERROR";
      const message = error instanceof HttpError ? error.message
        : status < 500 ? "Request was rejected" : "An unexpected error occurred";
      if (status >= 500) log.error({ requestId, errorCode: error?.code || "INTERNAL_ERROR" }, "Request failed");
      writeJson(outgoing, status, errorBody(code, message), headOnly);
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  let listening = false;
  let listenPromise = null;
  const api = {
    server,
    log,
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
        body = typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
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
      const responseBody = await response.text();
      return {
        statusCode: response.status,
        headers: responseHeaders,
        body: responseBody,
        json() { return responseBody ? JSON.parse(responseBody) : null; },
      };
    },
    async close() {
      if (!listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      listening = false;
      listenPromise = null;
    },
  };
  return api;
}
