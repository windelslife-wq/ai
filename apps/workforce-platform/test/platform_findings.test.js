/**
 * One test per audit finding closed in Phase 2 (`docs/migration/PHASE0_AUDIT_20261008.md`).
 *
 * Each test asserts the *behaviour* the finding said was missing — not the shape of a
 * helper — so a refactor that quietly reintroduces a gap fails here with the finding's
 * number in the test name.
 */

import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFileStore, fileStorePaths } from "../src/persistence/file-store.js";
import { buildApp } from "../src/app.js";
import { createRouter, joinPath, SUPPORTED_METHODS } from "../src/http/router.js";
import { validateRequest, validationDetails, validationMessage } from "../src/http/validate.js";
import { contentTypeOf, boundaryOf, parseMultipart, readRawBody } from "../src/http/bodies.js";
import { cacheControlFor, staticAssetPath } from "../src/http/static.js";
import { AppError } from "../src/http/errors.js";
import { buildCsp, isCrossSiteMutation, parseAllowedOrigins, resolveCors, securityHeaders } from "../src/security/headers.js";
import { createLoginGuard, createRateLimiter } from "../src/security/ratelimit.js";
import { avatarFileName, inspectImage, parseAvatarFileId, removeAvatarFile, validateImageUpload } from "../src/security/uploads.js";
import { createStore } from "../src/db/store.js";
import { loadConfig } from "../src/config.js";
import * as identityContracts from "../src/modules/identity/contracts.js";
import { REQUIRED_MIGRATIONS } from "../src/db/store.js";
import { assertRepositoryContract, REPOSITORY_METHODS } from "../src/persistence/contract.js";
import { cookieFrom, createFileStoreApp, testConfig } from "./helpers.js";

// Config clamps these; the tests below that need tight limits set them per-test.
const GENEROUS_LIMITS = { RATE_LIMIT_API_MAX: "100000", RATE_LIMIT_LOGIN_MAX: "1000", LOGIN_LOCKOUT_FAILURES: "1000" };

/** A real app on the real durable file adapter, with limits out of the way by default. */
function harness(env = {}, options = {}) {
  return createFileStoreApp({ configOverrides: { env: { ...GENEROUS_LIMITS, ...env } }, ...options });
}

async function signIn(app, identifier, password, extra = {}) {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password, ...extra } });
  const body = response.statusCode === 200 ? response.json() : null;
  return { response, cookie: cookieFrom(response), csrfToken: body?.csrfToken ?? null, user: body?.user ?? null };
}

async function workDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

// A minimal but *consistent* PNG: 8x8 IHDR, so the resolution guard is satisfied.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from("IHDR"),
  Buffer.from([0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x08]),
  Buffer.alloc(9, 8),
]);

/** Builds a multipart body as a Buffer: a binary part must not pass through UTF-8. */
function multipart(parts, { boundary = "wf-boundary" } = {}) {
  const chunks = [];
  for (const { name, filename, value } of parts) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    const isFile = filename !== undefined;
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${isFile ? `; filename="${filename}"` : ""}\r\n` +
      `${isFile ? "Content-Type: application/octet-stream\r\n" : ""}\r\n`,
      "utf8",
    ));
    chunks.push(data);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function fakeResponse() {
  const headers = new Map();
  return {
    statusCode: 200,
    setHeader(name, value) { headers.set(name.toLowerCase(), String(value)); },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    hasHeader(name) { return headers.has(name.toLowerCase()); },
    removeHeader(name) { headers.delete(name.toLowerCase()); },
    end() {},
    write() {},
  };
}

// ---------------------------------------------------------------- F-04 headers

test("hardening headers: every response carries the set, and production adds HSTS", () => {
  const response = fakeResponse();
  securityHeaders(response, { production: false, requestId: "req-1", contentSecurityPolicy: buildCsp({}) });
  assert.equal(response.getHeader("x-request-id"), "req-1");
  assert.equal(response.getHeader("x-content-type-options"), "nosniff");
  assert.equal(response.getHeader("x-frame-options"), "DENY");
  assert.equal(response.getHeader("referrer-policy"), "no-referrer");
  assert.equal(response.getHeader("cross-origin-opener-policy"), "same-origin");
  assert.equal(response.getHeader("cross-origin-resource-policy"), "same-origin");
  assert.equal(response.getHeader("permissions-policy"), "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  assert.equal(response.getHeader("strict-transport-security"), undefined, "HSTS on a plain-HTTP host is ignored by browsers and poisons their cache");
  const csp = response.getHeader("content-security-policy");
  for (const directive of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "worker-src 'self'"]) {
    assert.ok(csp.includes(directive), `CSP must contain ${directive}`);
  }
  assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline/);

  const secure = fakeResponse();
  securityHeaders(secure, { production: true, requestId: "req-2", contentSecurityPolicy: buildCsp({}) });
  assert.equal(secure.getHeader("strict-transport-security"), "max-age=31536000; includeSubDomains");
});

test("hardening headers: the inline-script escape hatch cannot reach a production build", () => {
  const development = buildCsp({ unsafeInline: true });
  assert.match(development, /script-src 'self' 'unsafe-inline'/);
  assert.match(development, /style-src 'self' 'unsafe-inline'/);
  assert.doesNotMatch(development, /default-src[^;]*unsafe-inline/);
  assert.equal(buildCsp({ connectSrc: ["https://api.example.test"] }).includes("connect-src 'self' https://api.example.test"), true);
  assert.equal(buildCsp({ extra: ["img-src 'self' data: https:"] }).includes("img-src 'self' data: https:"), true, "an override replaces its directive instead of duplicating it");

  const production = loadConfig({
    NODE_ENV: "production",
    PUBLIC_BASE_URL: "https://workforce.example.test",
    SESSION_SECRET: "a".repeat(48),
    STORAGE_ADAPTER: "file",
    ALLOW_FILE_STORE_IN_PRODUCTION: "1",
    CSP_UNSAFE_INLINE: "1",
  });
  assert.equal(production.production, true);
  assert.doesNotMatch(production.contentSecurityPolicy, /unsafe-inline/, "CSP_UNSAFE_INLINE must be ignored in production, not honoured");

  assert.throws(() => loadConfig({ NODE_ENV: "production", SESSION_SECRET: "a".repeat(48), STORAGE_ADAPTER: "file", ALLOW_FILE_STORE_IN_PRODUCTION: "1" }), /PUBLIC_BASE_URL is required/);
  assert.throws(() => loadConfig({ NODE_ENV: "production", PUBLIC_BASE_URL: "http://workforce.example.test", SESSION_SECRET: "a".repeat(48), STORAGE_ADAPTER: "file", ALLOW_FILE_STORE_IN_PRODUCTION: "1" }), /https/i);
  assert.throws(() => loadConfig({ NODE_ENV: "production", PUBLIC_BASE_URL: "https://workforce.example.test", SESSION_SECRET: "short", STORAGE_ADAPTER: "file", ALLOW_FILE_STORE_IN_PRODUCTION: "1" }), /SESSION_SECRET/);
  assert.throws(() => loadConfig({ NODE_ENV: "production", PUBLIC_BASE_URL: "https://workforce.example.test", SESSION_SECRET: "a".repeat(48), STORAGE_ADAPTER: "file" }), /not approved for production/);
});

test("hardening headers: API responses are never cacheable and every response carries a request id", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  const response = await app.app.inject({ method: "GET", url: "/api/v1/health/live" });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.headers["x-request-id"], /^[0-9a-f-]{36}$/);
  const missing = await app.app.inject({ method: "GET", url: "/api/v1/nothing-here" });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.headers["cache-control"], "no-store");
  assert.ok(missing.headers["x-request-id"]);
  assert.equal(missing.headers["x-content-type-options"], "nosniff");
  assert.equal(missing.json().error.message !== undefined, true);
  assert.deepEqual(Object.keys(missing.json().error).sort(), ["code", "message"], "an error body carries a code and a message, nothing else");
});

// ---------------------------------------------------------------- F-05 routing

test("F-03 the router is method-exact, replies 405 with Allow, and rejects ambiguous registration", () => {
  const router = createRouter();
  const seen = [];
  router.add("GET", "/thing", {}, () => { seen.push("get"); });
  router.add("POST", "/thing", {}, () => { seen.push("post"); });
  router.add("GET", "/thing/:id", {}, () => { seen.push("param"); });

  const hit = router.find("GET", "/thing");
  hit.route.handler();
  assert.deepEqual(seen, ["get"], "exactly one route may run per request");
  // The router itself stays method-exact; the transport maps HEAD to GET (asserted
  // end-to-end in F-21), so a module can never register HEAD-only behaviour.
  assert.equal(router.find("HEAD", "/thing").methodMismatch, true);
  assert.equal(router.find("GET", "/thing/9").params.id, "9");
  router.find("GET", "/thing/9").route.handler();
  assert.deepEqual(seen, ["get", "param"], "a static route must not be shadowed by a parameter route");

  const mismatch = router.find("DELETE", "/thing");
  assert.equal(mismatch.route, undefined);
  assert.equal(mismatch.methodMismatch, true);
  assert.deepEqual(mismatch.allowed, ["GET", "HEAD", "POST"]);
  assert.equal(router.find("GET", "/nothing"), null);
  assert.throws(() => router.add("GET", "/thing", {}, () => {}), /Duplicate route/);
  assert.throws(() => router.add("TRACE", "/thing", {}, () => {}), /Unsupported HTTP method/);
  assert.throws(() => router.add("GET", "/other", {}), /Route handler is required/);
  assert.throws(() => router.add("GET", "/:1bad", {}, () => {}), /Invalid parameter name/);
  assert.throws(() => router.add("GET", "/a:b", {}, () => {}), /whole path segment/);
  assert.deepEqual([...SUPPORTED_METHODS], ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
  assert.equal(joinPath("/api/v1", "/auth/login"), "/api/v1/auth/login");
  assert.equal(joinPath("/api/v1/", "/"), "/api/v1");
  assert.throws(() => joinPath("/api/v1", "no-leading-slash"), /must start with \//);
});

test("F-03 every verb is declared explicitly: unknown methods get 405 with Allow, static paths reject them", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  const wrongVerb = await app.app.inject({ method: "DELETE", url: "/api/v1/auth/login" });
  assert.equal(wrongVerb.statusCode, 405);
  assert.equal(wrongVerb.headers.allow, "POST", "HEAD is only implied where GET exists");
  assert.equal(wrongVerb.json().error.code, "METHOD_NOT_ALLOWED");

  const postToStatic = await app.app.inject({ method: "POST", url: "/styles.css" });
  assert.equal(postToStatic.statusCode, 405, "a real static resource answers 405 with its verbs");
  assert.equal(postToStatic.headers.allow, "GET, HEAD");

  const postToMissing = await app.app.inject({ method: "POST", url: "/not-a-page" });
  assert.equal(postToMissing.statusCode, 404, "an unknown path must not reveal itself through 405");

  const unknownPath = await app.app.inject({ method: "GET", url: "/api/v1/does-not-exist" });
  assert.equal(unknownPath.statusCode, 404);
  assert.equal(unknownPath.headers.allow, undefined, "404 must not advertise an Allow list for a path that does not exist");

  const preflight = await app.app.inject({ method: "OPTIONS", url: "/api/v1/auth/login" });
  assert.equal(preflight.statusCode, 204, "OPTIONS is answered by the transport, not a handler");
  assert.equal(preflight.body, "");
  assert.equal(preflight.headers["content-length"], undefined, "a 204 must not claim a body length");
});

// ---------------------------------------------------------------- F-06 CORS

test("F-05 CORS is opt-in, exact-origin and credentialed", () => {
  const config = { corsAllowedOrigins: ["https://admin.example.test"], publicBaseUrl: "https://workforce.example.test" };
  const request = (headers) => ({ headers, protocol: "https", hostname: "workforce.example.test" });

  assert.deepEqual(resolveCors(request({}), config), { origin: null, allowed: true }, "a same-origin request needs no CORS headers at all");
  assert.deepEqual(resolveCors(request({ origin: "https://workforce.example.test" }), config), { origin: null, allowed: true });
  assert.deepEqual(resolveCors(request({ origin: "https://admin.example.test" }), config), { origin: "https://admin.example.test", allowed: true });
  assert.equal(resolveCors(request({ origin: "https://admin.example.test/" }), config).allowed, true, "a trailing slash is not a different origin");
  assert.deepEqual(resolveCors(request({ origin: "https://evil.example" }), config), { origin: "https://evil.example", allowed: false });
  assert.deepEqual(resolveCors(request({ origin: "null" }), config), { origin: null, allowed: false }, "an opaque origin is never allowed");
  assert.deepEqual(resolveCors(request({ origin: "file://" }), config), { origin: null, allowed: false });
  assert.deepEqual(resolveCors(request({ origin: "https://admin.example.test:443" }), config), { origin: "https://admin.example.test", allowed: true }, "a default port is not a different origin");
  assert.deepEqual(parseAllowedOrigins(" https://a.test ,, https://b.test ,"), ["https://a.test", "https://b.test"]);
  assert.deepEqual(parseAllowedOrigins("*"), [], "a wildcard is dropped so it can never be echoed with credentials");
  assert.deepEqual(parseAllowedOrigins("https://a.test/paths-are-not-origins"), []);
  const baseEnv = { NODE_ENV: "test", SESSION_SECRET: "t".repeat(40), STORAGE_ADAPTER: "file", LOG_LEVEL: "silent" };
  assert.throws(() => loadConfig({ ...baseEnv, CORS_ALLOWED_ORIGINS: "*" }), /must list explicit origins/);
  assert.throws(() => loadConfig({ ...baseEnv, NODE_ENV: "production", PUBLIC_BASE_URL: "https://a.test", SESSION_SECRET: "t".repeat(40), STORAGE_ADAPTER: "file", ALLOW_FILE_STORE_IN_PRODUCTION: "1", CORS_ALLOWED_ORIGINS: "http://a.test" }), /must use HTTPS origins in production/);

  assert.equal(isCrossSiteMutation({ method: "GET", headers: { origin: "https://evil.example" }, protocol: "https", hostname: "workforce.example.test" }, config), false, "a cross-site read is not a mutation");
  assert.equal(isCrossSiteMutation({ method: "POST", headers: { origin: "https://evil.example" }, protocol: "https", hostname: "workforce.example.test" }, config), true);
  assert.equal(isCrossSiteMutation({ method: "POST", headers: { origin: "https://workforce.example.test", "sec-fetch-site": "cross-site" }, protocol: "https", hostname: "workforce.example.test" }, config), true, "Sec-Fetch-Site is honoured even when the origin looks right");
  assert.equal(isCrossSiteMutation({ method: "POST", headers: {}, protocol: "https", hostname: "workforce.example.test" }, config), false, "non-browser clients send no Origin header");
});

test("F-05 a cross-origin request gets CORS headers on the success, the error and the preflight", async (t) => {
  const allowed = "https://admin.example.test";
  const app = await harness({ CORS_ALLOWED_ORIGINS: allowed });
  t.after(() => app.cleanup());

  const preflight = await app.app.inject({
    method: "OPTIONS",
    url: "/api/v1/auth/login",
    headers: { origin: allowed, "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-csrf-token" },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], allowed);
  assert.equal(preflight.headers["access-control-allow-credentials"], "true");
  assert.match(preflight.headers["access-control-allow-methods"], /POST/);
  assert.match(preflight.headers["access-control-allow-headers"], /x-csrf-token/);
  assert.equal(preflight.headers["access-control-max-age"], "600");
  assert.equal(preflight.headers.vary, "Origin");

  const failure = await app.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { origin: allowed } });
  assert.equal(failure.statusCode, 401);
  assert.equal(failure.headers["access-control-allow-origin"], allowed, "without CORS headers the browser hides the 401 and the client cannot react");
  assert.equal(failure.headers.vary, "Origin");

  const denied = await app.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: "https://evil.example" }, payload: { identifier: "rootadmin", password: "Root administrator pass" } });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "ORIGIN_INVALID");
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
  assert.equal(denied.headers.vary, undefined, "a refused origin must not become a cacheable variation");

  const plain = await app.app.inject({ method: "GET", url: "/api/v1/health/live" });
  assert.equal(plain.headers["access-control-allow-origin"], undefined, "a same-origin request must not gain CORS headers");
  assert.equal(plain.headers.vary, undefined);
});

test("F-05 a cross-site mutation is refused before the guard chain and before the handler", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  const session = await signIn(app.app, "rootadmin", "Root administrator pass");
  assert.equal(session.response.statusCode, 200, session.response.body);

  const forged = await app.app.inject({
    method: "DELETE",
    url: "/api/v1/account/sessions",
    headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken, origin: "https://bank.example" },
  });
  assert.equal(forged.statusCode, 403);
  assert.equal(forged.json().error.code, "ORIGIN_INVALID");
  const still = await app.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: session.cookie } });
  assert.equal(still.statusCode, 200, "a refused request must not have touched the session");
});

// ---------------------------------------------------------------- F-07 validation

test("F-04 the validator enforces the legacy rules and coerces bounded query integers", () => {
  const register = (body) => validateRequest({ bodySchema: identityContracts.REGISTER }, { body, query: {}, params: {} });

  const good = register({ username: "newcomer", email: "New@Example.TEST", password: "a long enough password", passwordConfirm: "a long enough password", termsAccepted: true });
  assert.deepEqual(good.issues, []);
  assert.equal(good.value.body.email, "new@example.test", "email is lower-cased before storage, exactly as the legacy model did");
  assert.equal(good.value.body.username, "newcomer");

  assert.equal(register({ username: "Bad Name!", email: "a@b.test", password: "a long enough password", passwordConfirm: "a long enough password", termsAccepted: true }).issues[0].code, "PATTERN");
  assert.equal(register({ username: "ok", email: "a@b.test", password: "short", passwordConfirm: "short", termsAccepted: true }).issues[0].code, "TOO_SHORT");
  assert.equal(register({ username: "ok12", email: "not-an-email", password: "a long enough password", passwordConfirm: "a long enough password", termsAccepted: true }).issues[0].code, "FORMAT");
  assert.equal(register({ username: "ok12", email: "a@b.test", password: "a long enough password", termsAccepted: true }).issues[0].code, "REQUIRED");
  assert.equal(register({ username: "ok12", email: "a@b.test", password: "a long enough password", passwordConfirm: "a long enough password", termsAccepted: true, admin: true }).issues[0].code, "UNKNOWN_PROPERTY");
  assert.equal(register({ username: "x".repeat(40), email: "a@b.test", password: "a long enough password", passwordConfirm: "a long enough password", termsAccepted: true }).issues[0].code, "TOO_LONG");
  assert.equal(register({ username: "ok12", email: "a@b.test", password: "a long enough password", passwordConfirm: "a long enough password", termsAccepted: "yes" }).issues[0].code, "TYPE");
  assert.match(validationMessage(register({ username: "ok12", email: "a@b.test", password: "short", passwordConfirm: "short", termsAccepted: true }).issues), /^password is too short$/);
  assert.deepEqual(validationDetails([{ field: "body.username", code: "PATTERN", message: "nope" }]), [{ field: "username", code: "PATTERN", message: "nope" }]);

  const query = (value) => validateRequest({ querySchema: identityContracts.LIST_USERS_QUERY }, { body: undefined, query: value, params: {} });
  assert.deepEqual(query({ limit: "10", offset: "5" }).value.query, { limit: 10, offset: 5, sort: "id", direction: "asc" }, "defaults are applied and strings coerced for GET");
  assert.equal(query({ limit: "9999" }).issues[0].code, "MAX");
  assert.equal(query({ sort: "password_hash" }).issues[0].code, "ENUM");
  assert.equal(query({ status: "nope" }).issues[0].code, "ENUM");
  assert.equal(query({ limit: "1e999" }).issues.length > 0, true, "a non-finite number is refused, not turned into Infinity");
  assert.equal(query({}).issues.length, 0, "every query field is optional with a safe default");

  const params = (value) => validateRequest({ paramsSchema: identityContracts.USER_ID_PARAM }, { body: undefined, query: {}, params: value });
  assert.equal(params({ userId: "17" }).value.params.userId, 17);
  assert.equal(params({ userId: "abc" }).issues[0].code, "TYPE");
  assert.equal(params({ userId: "0" }).issues[0].code, "MIN");
  assert.equal(params({}).issues[0].code, "REQUIRED");
  for (const hostile of ["../../etc/passwd", "1; DROP TABLE wf_users", "u1_deadbeef.png", ""]) {
    assert.equal(validateRequest({ paramsSchema: identityContracts.AVATAR_FILE_PARAM }, { params: { fileId: hostile }, query: {}, body: undefined }).issues[0].code, "PATTERN", `${hostile} must be refused`);
  }
});

test("F-04 a rejected request answers 400 INVALID_REQUEST with field names and never values, and the handler is not reached", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  const before = await app.store.stats();
  const rejected = await app.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "9bad!", email: "nope", password: "short" } });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.json().error.code, "INVALID_REQUEST");
  const details = rejected.json().error.details;
  assert.ok(details.some((entry) => entry.field === "username" && entry.code === "PATTERN"));
  assert.ok(details.some((entry) => entry.field === "email" && entry.code === "FORMAT"));
  assert.ok(details.some((entry) => entry.field === "passwordConfirm" && entry.code === "REQUIRED"));
  assert.doesNotMatch(JSON.stringify(details), /short|nope/, "rejected values are never echoed back");
  assert.deepEqual(await app.store.stats(), before, "no row may be written by a rejected request");
});

// ---------------------------------------------------------------- F-08 bodies

test("F-06 body limits, content types and JSON syntax are enforced before parsing costs anything", async (t) => {
  const app = await harness({ BODY_LIMIT_BYTES: "2048" });
  t.after(() => app.cleanup());
  assert.equal(app.config.bodyLimitBytes, 2048);

  const oversize = await app.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: "rootadmin", password: "x".repeat(4000) } });
  assert.equal(oversize.statusCode, 413);
  assert.equal(oversize.json().error.code, "BODY_TOO_LARGE");

  await assert.rejects(readRawBody(nodeRequest(Buffer.alloc(1200)), 1024), (error) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.statusCode, 413);
    assert.equal(error.code, "BODY_TOO_LARGE");
    return true;
  }, "the cap is checked while streaming, so a hostile body cannot pre-commit memory");
  await assert.rejects(readRawBody({ headers: { "content-length": "999999999999" }, [Symbol.asyncIterator]() { throw new Error("must never be read"); } }, 1024), /must not exceed/, "an oversized Content-Length fails before the first chunk");

  const malformed = await app.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: "{not-json", headers: { "content-type": "application/json" } });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, "INVALID_JSON");

  const csv = await app.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: "a,b,c", headers: { "content-type": "text/csv" } });
  assert.equal(csv.statusCode, 415);
  assert.equal(csv.json().error.code, "UNSUPPORTED_MEDIA_TYPE");

  const empty = await app.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { "content-type": "application/json" } });
  assert.equal(empty.statusCode, 401, "an empty body is a missing credential, not a parse error");

  // A multipart body is parsed for fields without a file part being required.
  const fieldsOnly = multipart([{ name: "identifier", value: "rootadmin" }]);
  const parsed = parseMultipart(fieldsOnly.body, "wf-boundary");
  assert.deepEqual(parsed.fields, { identifier: "rootadmin" });
  assert.deepEqual(parsed.files, [], "a part without a filename is a field, not a file");
  assert.equal(contentTypeOf({ headers: { "content-type": "APPLICATION/JSON; charset=UTF-8" } }), "application/json");
  assert.equal(boundaryOf({ headers: { "content-type": 'multipart/form-data; boundary="abc"' } }), "abc");
  await assert.rejects(
    (async () => parseMultipart(Buffer.from("no delimiters"), "wf-boundary"))(),
    (error) => error.code === "MALFORMED_MULTIPART",
  );
});

/** Minimal async-iterable request stand-in for the bounded-reader test. */
function nodeRequest(buffer) {
  let sent = false;
  return {
    headers: {},
    [Symbol.asyncIterator]() {
      return { next: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: buffer })) };
    },
  };
}

// ---------------------------------------------------------------- F-09 lockout

test("F-08 the login guard locks after five failures and unlocks on the window, keyed per account and per address", () => {
  const guard = createLoginGuard({ maxFailures: 5, lockMs: 60_000, windowMs: 60_000 });
  const keys = ["login:account:rootadmin", "login:ip:203.0.113.7"];
  let now = 1_000;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal(guard.recordFailure(keys, now), 0, "four failures must not lock");
    now += 1;
  }
  assert.equal(guard.recordFailure(keys, now), 60, "the fifth failure locks for the configured window");
  assert.equal(guard.evaluate(keys, now + 1_000), 59);
  assert.equal(guard.evaluate(["login:account:someoneelse", "login:ip:203.0.113.8"], now), 0, "one client cannot lock another account");
  assert.equal(guard.evaluate(keys, now + 61_000), 0, "the lock expires");
  guard.recordFailure(keys, now + 62_000);
  guard.clear(keys);
  assert.equal(guard.evaluate(keys, now + 62_000), 0, "a successful sign-in clears the counter");
  assert.equal(guard.size, 0);
  const bounded = createLoginGuard({ maxFailures: 1, maxEntries: 10 });
  for (let index = 0; index < 50; index += 1) bounded.recordFailure([`k${index}`], 1_000 + index);
  assert.ok(bounded.size <= 10, `attempt tracking must stay capped (got ${bounded.size})`);
});

test("F-08 five failed sign-ins lock the account, and the failure is audited without the identifier", async (t) => {
  const app = await harness({ RATE_LIMIT_LOGIN_MAX: "1000", LOGIN_LOCKOUT_FAILURES: "5", LOGIN_LOCKOUT_MS: "900000" });
  t.after(() => app.cleanup());
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await app.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: "rootadmin", password: "definitely not the password" } });
    assert.equal(failed.statusCode, 401, failed.body);
    assert.equal(failed.json().error.code, "LOGIN_INVALID");
    assert.equal(failed.json().error.message, "The supplied credentials are invalid", "the response must not reveal whether the account exists");
  }
  const locked = await app.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: "rootadmin", password: "Root administrator pass" } });
  assert.equal(locked.statusCode, 429);
  assert.equal(locked.json().error.code, "RATE_LIMITED");
  assert.match(locked.headers["retry-after"], /^\d+$/);
  assert.ok(Number(locked.headers["retry-after"]) > 800, "the lock must be long enough to slow a spray");

  const { total, events } = await app.store.listAuditEvents({ action: "identity.login" });
  assert.equal(total, 5);
  for (const event of events) {
    const serialized = JSON.stringify(event);
    assert.doesNotMatch(serialized, /rootadmin/i, "a failed-login audit row must not carry the searched identifier");
    assert.doesNotMatch(serialized, /definitely not the password/);
  }
  assert.equal(events[0].action, "identity.login.failed");
  assert.match(events[0].details.identifierHash, /^[0-9a-f]{64}$/, "the searched identifier is stored only as a hash, so a leak cannot be matched to an account");
  assert.equal(events[0].details.reason, "password", "the reason distinguishes a wrong password from an unknown handle");
  const unknownHandle = await app.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: "ghostuser", password: "whatever it might be" } });
  assert.equal(unknownHandle.statusCode, 401, "an unknown handle is answered exactly like a wrong password");
  // The lock is scoped to the account, so one locked account behind a shared
  // office or carrier address cannot deny sign-in to everybody else there.
  const neighbour = await app.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "neighbour", email: "neighbour@example.test", password: "a long enough password", passwordConfirm: "a long enough password", termsAccepted: true } });
  assert.equal(neighbour.statusCode, 200, neighbour.body);
  assert.ok(cookieFrom(neighbour));
  const { events: afterUnknown } = await app.store.listAuditEvents({ action: "identity.login" });
  assert.equal(afterUnknown[0].details.reason, "unknown-identifier");
});

// ---------------------------------------------------------------- F-10 rate limits

test("F-08 the limiter is per key, bounded in memory, and never shares a bucket across routes", () => {
  const limiter = createRateLimiter({ maxEntries: 4, sweepIntervalMs: 1_000 });
  const at = (key, now) => limiter.check(key, { max: 2, windowMs: 10_000 }, now);
  assert.equal(at("a", 1_000), 0);
  assert.equal(at("a", 1_500), 0);
  assert.equal(at("a", 2_000), 9, "the third hit reports whole seconds until the window resets");
  assert.equal(at("b", 2_000), 0, "a different client keeps its own bucket");
  for (let index = 0; index < 20; index += 1) at(`flood-${index}`, 3_000 + index);
  assert.ok(limiter.size <= 4, `bucket count must stay capped (got ${limiter.size})`);
  assert.equal(at("a", 20_000), 0, "the window rolls over");
  assert.throws(() => limiter.check("x", { max: 0, windowMs: 1000 }), /positive integer/);
  limiter.reset();
  assert.equal(limiter.size, 0);
});

test("F-08 the per-route limit is independent of the global limit, and both answer 429 with Retry-After", async (t) => {
  const app = await harness({ RATE_LIMIT_LOGIN_MAX: "2", RATE_LIMIT_API_MAX: "1000" });
  t.after(() => app.cleanup());
  const throttled = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throttled.push(await app.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: "rootadmin", password: "nope" } }));
  }
  assert.deepEqual(throttled.map((entry) => entry.statusCode), [401, 401, 429]);
  assert.ok(Number(throttled[2].headers["retry-after"]) <= 60);
  // The login bucket is full; other routes still answer, so one endpoint cannot starve the rest.
  assert.equal((await app.app.inject({ method: "GET", url: "/api/v1/auth/csrf" })).statusCode, 401);

  const global = await harness({ RATE_LIMIT_API_MAX: "3", RATE_LIMIT_LOGIN_MAX: "1000" });
  t.after(() => global.cleanup());
  const statuses = [];
  for (let index = 0; index < 4; index += 1) {
    statuses.push((await global.app.inject({ method: "GET", url: "/api/v1/system/features" })).statusCode);
  }
  assert.deepEqual(statuses, [200, 200, 200, 429], "the API-wide limit applies to every endpoint equally");
  assert.equal(global.app.config.rateLimit.api.max, 3);
});

test("F-08 limits can be switched off deliberately without disabling authentication", async (t) => {
  const app = await harness({ RATE_LIMIT_ENABLED: "0", RATE_LIMIT_LOGIN_MAX: "1" });
  t.after(() => app.cleanup());
  assert.equal(app.config.rateLimit.enabled, false);
  for (let index = 0; index < 8; index += 1) {
    const response = await app.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: "rootadmin", password: "wrong" } });
    assert.equal(response.statusCode, 401, response.body);
  }
});

// ---------------------------------------------------------------- F-11 uploads

test("F-06 an avatar is identified by its bytes, not by the label the browser sent", async () => {
  assert.equal(inspectImage(PNG).ext, "png");
  assert.equal(inspectImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)])).mime, "image/jpeg");
  assert.equal(inspectImage(Buffer.from(`GIF89a${" ".repeat(20)}`)).ext, "gif");
  assert.equal(inspectImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 1), Buffer.from("WEBP"), Buffer.alloc(8)])).ext, "webp");
  assert.equal(inspectImage(Buffer.from("#!/bin/sh\necho nope\n")), null, "a script is not an image whatever it is named");
  assert.equal(inspectImage(Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(4), Buffer.from("IDAT")])), null, "PNG needs its IHDR chunk");
  assert.equal(inspectImage(Buffer.alloc(4)), null);
  assert.equal(inspectImage(null), null);

  const name = avatarFileName(7, "png");
  assert.match(name, /^u7_[0-9a-f]{32}\.png$/);
  assert.equal(parseAvatarFileId(name), name, "the validated id is returned unchanged for the filesystem lookup");
  for (const hostile of ["..%2f..%2fserver.js", "../server.js", "u7_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.png", "u7_deadbeefdeadbeefdeadbeefdeadbeef.exe", "u7_deadbeefdeadbeefdeadbeefdeadbeef.png/../../x", "u0_deadbeefdeadbeefdeadbeefdeadbeef.png"]) {
    assert.equal(parseAvatarFileId(hostile), null, `${hostile} must not resolve`);
  }
  assert.equal(validateImageUpload({ data: Buffer.alloc(3 * 1024 * 1024) }, { maxBytes: 2 * 1024 * 1024 }).code, "FILE_TOO_LARGE");
  const accepted = validateImageUpload({ data: PNG }, { maxBytes: 2 * 1024 * 1024 });
  assert.equal(accepted.ok, true, accepted.message);
  assert.deepEqual(
    validateImageUpload({ data: Buffer.concat([PNG.subarray(0, 16), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), PNG.subarray(24)]) }, { maxBytes: 2 * 1024 * 1024 }),
    { ok: false, code: "IMAGE_TOO_LARGE", message: "The image resolution is too large" },
    "a tiny file claiming an absurd resolution is refused like the bomb it is",
  );
  assert.equal(validateImageUpload({ data: Buffer.alloc(0) }, { maxBytes: 1024 }).code, "NO_FILE");
  assert.equal(await removeAvatarFile("/nonexistent-dir", "../../etc/passwd"), false, "a non-generated name can never become an arbitrary unlink");
});

test("F-06 the avatar route stores, serves and removes files, and no other user can read them", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  const owner = await signIn(app.app, "rootadmin", "Root administrator pass");
  const withCsrf = { cookie: owner.cookie, "x-csrf-token": owner.csrfToken };

  const noFile = await app.app.inject({ method: "POST", url: "/api/v1/account/avatar", headers: { ...withCsrf, "content-type": multipart([{ name: "note", value: "hi" }]).contentType }, payload: multipart([{ name: "note", value: "hi" }]).body });
  assert.equal(noFile.statusCode, 400);
  assert.equal(noFile.json().error.code, "NO_FILE");

  const disguisedPart = multipart([{ name: "avatar", filename: "payload.png", value: `#!/bin/sh\necho pwned\n${" ".repeat(40)}` }]);
  const refused = await app.app.inject({ method: "POST", url: "/api/v1/account/avatar", headers: { ...withCsrf, "content-type": disguisedPart.contentType }, payload: disguisedPart.body });
  assert.equal(refused.statusCode, 422);
  assert.equal(refused.json().error.code, "UNSUPPORTED_TYPE");
  assert.equal(refused.json().error.message, "Only PNG, JPEG, GIF or WebP images are allowed");

  const upload = multipart([{ name: "avatar", filename: "me.png", value: PNG }]);
  const stored = await app.app.inject({ method: "POST", url: "/api/v1/account/avatar", headers: { ...withCsrf, "content-type": upload.contentType }, payload: upload.body });
  assert.equal(stored.statusCode, 201, stored.body);
  const avatarUrl = stored.json().avatarUrl;
  assert.equal(stored.json().contentType, "image/png");
  assert.equal(stored.json().bytes, PNG.length);
  assert.ok(avatarUrl.startsWith("/api/v1/files/avatars/"), "the URL handed to the client must be the route that actually serves it");
  const fileId = avatarUrl.split("/").pop();
  const onDisk = path.join(app.config.uploads.dir, fileId);
  assert.equal((await stat(onDisk)).size, PNG.length);
  assert.equal(await app.store.findAvatarPath(owner.user.id), avatarUrl);
  assert.deepEqual((await readFile(onDisk)).subarray(0, 8), PNG.subarray(0, 8), "the bytes on disk are the bytes that were sent");

  const served = await app.app.inject({ method: "GET", url: avatarUrl, headers: { cookie: owner.cookie } });
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers["content-type"], "image/png");
  assert.equal(Number(served.headers["content-length"]), PNG.length);
  assert.match(served.headers["cache-control"], /^private, max-age=/);
  assert.equal(served.buffer.length, PNG.length, "the streamed bytes match what was stored");

  const anonymous = await app.app.inject({ method: "GET", url: avatarUrl });
  assert.equal(anonymous.statusCode, 401);

  const created = await app.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { username: "curious", email: "curious@example.test", password: "a long enough password", passwordConfirm: "a long enough password", termsAccepted: true },
  });
  assert.equal(created.statusCode, 200, created.body);
  const peek = await app.app.inject({ method: "GET", url: avatarUrl, headers: { cookie: cookieFrom(created) } });
  assert.equal(peek.statusCode, 403);
  assert.equal(peek.json().error.code, "NOT_OWNER");

  const hostile = await app.app.inject({ method: "GET", url: "/api/v1/files/avatars/..%2f..%2fserver.js", headers: { cookie: owner.cookie } });
  assert.equal(hostile.statusCode, 400, "a malformed file id is refused by the parameter schema");
  const stale = await app.app.inject({ method: "GET", url: "/api/v1/files/avatars/u1_0000000000000000000000000000dead.png", headers: { cookie: owner.cookie } });
  assert.equal(stale.statusCode, 404);

  const removed = await app.app.inject({ method: "DELETE", url: "/api/v1/account/avatar", headers: withCsrf });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().avatarUrl, null);
  await assert.rejects(stat(onDisk), { code: "ENOENT" }, "removal must delete the bytes, not just the row");
  const gone = await app.app.inject({ method: "GET", url: avatarUrl, headers: { cookie: owner.cookie } });
  assert.equal(gone.statusCode, 404);

  // Uploads live outside the static root, so the public tree must not reach them.
  const leaked = await app.app.inject({ method: "GET", url: `/uploads/${fileId}` });
  assert.ok([404, 405].includes(leaked.statusCode), `uploads must not be statically reachable (got ${leaked.statusCode})`);
});

// ---------------------------------------------------------------- F-12 persistence

test("F-01 the durable file adapter replays its log, survives a torn write, and fsyncs acknowledged mutations", async (t) => {
  const root = await workDir("wf-filestore-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "store");
  const store = await createFileStore({ dir });
  const user = await store.createUser({ username: "durable", email: "durable@example.test", passwordHash: "$2y$12$abcdefghijklmnopqrstuv", displayName: "Durable" });
  assert.equal((await store.findUserByIdentifier("durable")).password_hash, "$2y$12$abcdefghijklmnopqrstuv", "a legacy digest is stored byte-for-byte");
  await store.createSession({ tokenHash: "a".repeat(64), userId: user.id, expiresAt: new Date(Date.now() + 60_000).toISOString(), deviceLabel: "studio" });
  await store.recordAudit({ actorId: user.id, action: "identity.test", entityType: "identity", entityId: user.id, details: { ok: true } });
  const checksumBefore = await store.checksum();
  const logText = await readFile(fileStorePaths(dir).log, "utf8");
  assert.ok(logText.split("\n").filter(Boolean).length >= 4, "each acknowledged mutation is its own log record");
  await store.close();

  // A torn trailing record is what a crash actually leaves behind.
  await appendFile(fileStorePaths(dir).log, '{"entity":"users","key":"999","op":"upsert","value":{"id":999,"username":"fract');
  const warnings = [];
  const reopened = await createFileStore({ dir, logger: { warn: (value) => warnings.push(value) } });
  assert.equal(warnings.length, 1, "a discarded torn write is logged, never silent");
  assert.match(warnings[0].message, /torn/);
  assert.equal(await reopened.findUserByIdentifier("fract"), null, "the incomplete record must not create a user");
  assert.equal((await reopened.findUserByIdentifier("durable")).username, "durable");
  assert.equal((await reopened.findSession("a".repeat(64))).user.username, "durable");
  const { total, events } = await reopened.listAuditEvents({ userId: user.id });
  assert.equal(total, 1);
  assert.equal(events[0].action, "identity.test");
  assert.deepEqual(await reopened.stats(), { users: 1, profiles: 1, sessions: 1, roles: 0, permissions: 0, userRoles: 0, rolePermissions: 0, audit: 1, inquiries: 0, analysisRuns: 0, strategies: 0, backtests: 0, journalEntries: 0 });

  await reopened.compact();
  const compacted = (await readFile(fileStorePaths(dir).log, "utf8")).trim();
  assert.equal(JSON.parse(compacted).op, "snapshot", "compaction rewrites the log as one snapshot record");
  const afterCompaction = await createFileStore({ dir });
  assert.equal((await afterCompaction.findUserByIdentifier("durable")).username, "durable");
  assert.equal(await afterCompaction.checksum(), checksumBefore, "compaction must not change the data");
  await afterCompaction.close();

  // A mid-log corruption is fatal instead of silently losing the tail.
  const lines = (await readFile(fileStorePaths(dir).log, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const corrupt = await workDir("wf-corrupt-");
  t.after(() => rm(corrupt, { recursive: true, force: true }));
  await writeFile(path.join(corrupt, "windels-store.jsonl"), '{"op":"snapshot","entity":"*","key":"*","value":{"users":[]}}\ngarbage\n');
  await assert.rejects(createFileStore({ dir: corrupt, logger: { warn() {} } }), /Corrupt file store log/);
});

test("F-01 the file store and the SQL store implement one repository contract, so a route cannot depend on an adapter", async (t) => {
  const root = await workDir("wf-parity-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakePool = { async execute() { return [[], []]; }, async query() { return [[], []]; } };
  const sql = createStore(fakePool, { logger: { info() {}, warn() {}, error() {} } });
  const file = await createFileStore({ dir: path.join(root, "store"), syncWrites: false });
  // One list, checked against both adapters and enforced at start-up by
  // `assertRepositoryContract`, so a route can never depend on one adapter.
  assert.doesNotThrow(() => assertRepositoryContract(sql, { adapter: "mysql" }));
  assert.doesNotThrow(() => assertRepositoryContract(file, { adapter: "file" }));
  assert.throws(
    () => assertRepositoryContract({ adapter: "stub", capabilities: {}, readiness: async () => ({}) }, { adapter: "stub" }),
    /does not implement the repository contract.*findUserByIdentifier/s,
  );
  assert.equal(REPOSITORY_METHODS.length, 46, "8 identity + 6 session + 9 RBAC + 2 admin + 4 audit/profile + 2 contact intake + 4 analysis runs + 10 strategy lab + 1 readiness");
  assert.equal(file.adapter, "file");
  assert.equal(file.capabilities.durable, true);
  assert.equal(file.capabilities.transactions, false);
  assert.equal(file.capabilities.crossProcessSafety, false);
  assert.equal(file.capabilities.recommendedForProduction, false, "the file adapter must never claim to be production storage");
  // A schema-less store reports the log format, not the seed data, as its schema;
  // the missing baseline is reported in `detail` so `/health/ready` can stay green
  // while `verify:data` fails the install until `seed:platform` has run.
  assert.deepEqual(await file.readiness(), { database: true, schema: true, adapter: "file", detail: "roles-not-seeded" });
  await file.ensureRole("platform_member", "Platform member");
  assert.deepEqual(await file.readiness(), { database: true, schema: true, adapter: "file", detail: null });
  await file.close();
});

// ---------------------------------------------------------------- F-14..F-17 accounts

test("identity parity: sessions are opaque and rotated, and logout expires the cookie", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  const first = await signIn(app.app, "rootadmin", "Root administrator pass");
  const second = await signIn(app.app, "rootadmin", "Root administrator pass");
  assert.equal(second.response.statusCode, 200, second.response.body);
  const firstToken = first.cookie.split("=")[1];
  const secondToken = second.cookie.split("=")[1];
  assert.ok(firstToken && secondToken && firstToken !== secondToken, "each sign-in mints a fresh opaque token");
  assert.ok(firstToken.length >= 32, "a session token must not be guessable");
  assert.doesNotMatch(first.cookie, /rootadmin|\.|\$/, "the cookie holds nothing but the token");

  const me = await app.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: second.cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.username, "rootadmin");
  assert.ok(me.json().permissions.includes("system.super_admin"));
  assert.match(me.json().csrfToken, /^[A-Za-z0-9_-]{16,}$/);
  assert.equal(me.json().via, "cookie");

  const loggedOut = await app.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: second.cookie, "x-csrf-token": me.json().csrfToken } });
  assert.equal(loggedOut.statusCode, 200);
  assert.match(loggedOut.headers["set-cookie"], /wf_session=;/, "the cookie must be expired, not merely absent");
  assert.match(loggedOut.headers["set-cookie"], /HttpOnly/);
  assert.match(loggedOut.headers["set-cookie"], /SameSite=Strict/);
  assert.match(loggedOut.headers["set-cookie"], /Path=\//);
  const reuse = await app.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: second.cookie } });
  assert.equal(reuse.statusCode, 401);
  assert.equal(reuse.json().error.code, "SESSION_INVALID");
  // Only the presented session was revoked.
  assert.equal((await app.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: first.cookie } })).statusCode, 200);
});

test("identity parity: a mutation without the session-bound CSRF token is refused, and the token is derived not stored", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  const session = await signIn(app.app, "rootadmin", "Root administrator pass");
  const noToken = await app.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: session.cookie }, payload: {} });
  assert.equal(noToken.statusCode, 403);
  assert.equal(noToken.json().error.code, "CSRF_INVALID");
  const wrongToken = await app.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: session.cookie, "x-csrf-token": "guess".repeat(4) }, payload: {} });
  assert.equal(wrongToken.statusCode, 403);
  const csrf = await app.app.inject({ method: "GET", url: "/api/v1/auth/csrf", headers: { cookie: session.cookie } });
  assert.equal(csrf.json().csrfToken, session.csrfToken, "the token is derived from the session, so a fresh endpoint agrees with login");
  const unauthenticated = await app.app.inject({ method: "GET", url: "/api/v1/auth/csrf" });
  assert.equal(unauthenticated.statusCode, 401);
});

test("identity parity: registration follows the legacy rules: terms, confirmation, uniqueness, then immediate sign-in", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  const payload = (overrides) => ({ username: "freshface", email: "fresh@example.test", password: "a long enough password", passwordConfirm: "a long enough password", termsAccepted: true, ...overrides });

  const declined = await app.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: payload({ termsAccepted: false }) });
  assert.equal(declined.statusCode, 400);
  assert.equal(declined.json().error.code, "TERMS_NOT_ACCEPTED");
  assert.match(declined.json().error.message, /Terms and Privacy Policy/);

  const mismatched = await app.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: payload({ passwordConfirm: "a different long password" }) });
  assert.equal(mismatched.statusCode, 400);
  assert.equal(mismatched.json().error.code, "PASSWORD_MISMATCH");

  const taken = await app.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: payload({ username: "rootadmin", email: "other@example.test" }) });
  assert.equal(taken.statusCode, 409);
  assert.equal(taken.json().error.code, "USERNAME_TAKEN");
  const emailTaken = await app.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: payload({ username: "othername", email: "root@example.test" }) });
  assert.equal(emailTaken.statusCode, 409);
  assert.equal(emailTaken.json().error.code, "EMAIL_TAKEN");

  const created = await app.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: payload({ displayName: "Fresh Face" }) });
  assert.equal(created.statusCode, 200, created.body);
  const body = created.json();
  assert.equal(body.user.username, "freshface");
  assert.equal(body.user.displayName, "Fresh Face");
  assert.match(body.user.legacyUid, /^\d{6}$/, "a Node-created account still gets the six-digit public ID the legacy product exposes");
  assert.ok(cookieFrom(created), "registration signs the new user in, as the legacy flow did");
  assert.equal((await app.store.listAuditEvents({ action: "identity.user.registered" })).total, 1);

  const signedIn = await signIn(app.app, "fresh@example.test", "a long enough password");
  assert.equal(signedIn.response.statusCode, 200, signedIn.response.body);

  await app.store.setUserStatus(body.user.id, false);
  const blocked = await signIn(app.app, "freshface", "a long enough password");
  assert.equal(blocked.response.statusCode, 401, "a disabled account must not sign in, even with the right password");
  assert.equal(blocked.response.json().error.code, "LOGIN_INVALID");
});

test("identity parity: the native shell gets a bearer session with an explicit expiry and a revocation path", async (t) => {
  const app = await harness({ SESSION_TTL_SECONDS: "300" });
  t.after(() => app.cleanup());
  const session = await signIn(app.app, "rootadmin", "Root administrator pass");
  const minted = await app.app.inject({ method: "POST", url: "/api/v1/auth/device-session", headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken }, payload: { label: "iPhone 15" } });
  assert.equal(minted.statusCode, 200, minted.body);
  const token = minted.json().token;
  assert.ok(token.length >= 32);
  assert.equal(minted.json().token === session.cookie.split("=")[1], true, "the native token is the same server-side session, not a second credential type");
  assert.ok(Date.parse(minted.json().expiresAt) > Date.now() + 60_000, "the expiry is extended for the device, not left at the 5-minute web TTL");
  assert.ok(Date.parse(minted.json().expiresAt) <= Date.now() + 30 * 24 * 60 * 60 * 1000, "but never beyond 30 days");
  assert.deepEqual(minted.json().storageGuidance.never, ["localStorage", "sessionStorage", "window.name"]);

  const viaBearer = await app.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: `Bearer ${token}` } });
  assert.equal(viaBearer.statusCode, 200);
  assert.equal(viaBearer.json().via, "bearer");
  assert.equal(viaBearer.json().csrfToken, undefined, "a bearer request has no ambient credential to forge");
  const tooLong = await app.app.inject({ method: "POST", url: "/api/v1/auth/device-session", headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken }, payload: { label: "x".repeat(200) } });
  assert.equal(tooLong.statusCode, 400, "a device label is bounded before it reaches storage");

  const listed = await app.app.inject({ method: "GET", url: "/api/v1/account/sessions", headers: { cookie: session.cookie } });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().sessions.some((entry) => entry.deviceLabel === "iPhone 15"), true, "the label is stored for the security screen");

  const other = await signIn(app.app, "rootadmin", "Root administrator pass");
  const revoked = await app.app.inject({ method: "DELETE", url: "/api/v1/account/sessions", headers: { authorization: `Bearer ${token}` } });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal(revoked.json().revoked, 1, "bearer revokes the other sessions and keeps its own");
  assert.equal((await app.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: other.cookie } })).statusCode, 401);
  assert.equal((await app.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
});

test("F-03 administration is paginated, role-bounded, self-protecting and audited", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  const admin = await signIn(app.app, "rootadmin", "Root administrator pass");
  const me = await app.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: admin.cookie } });
  const csrf = me.json().csrfToken;

  assert.equal(admin.response.statusCode, 200, "the seeded administrator can sign in");
  const page = await app.app.inject({ method: "GET", url: "/api/v1/admin/users?limit=1&offset=0&sort=username&direction=desc", headers: { cookie: admin.cookie } });
  assert.equal(page.statusCode, 200, page.body);
  assert.equal(page.json().users.length, 1);
  assert.deepEqual(page.json().meta, { total: 1, limit: 1, offset: 0, sort: "username", direction: "desc" });
  assert.doesNotMatch(JSON.stringify(page.json()), /password_hash|\$2y\$/, "an admin listing never leaks a digest");
  const badSort = await app.app.inject({ method: "GET", url: "/api/v1/admin/users?sort=email%20--", headers: { cookie: admin.cookie } });
  assert.equal(badSort.statusCode, 400, "sort is an enum, never a SQL fragment");
  const searched = await app.app.inject({ method: "GET", url: "/api/v1/admin/users?search=root&status=active", headers: { cookie: admin.cookie } });
  assert.equal(searched.json().meta.total, 1);

  const created = await app.app.inject({
    method: "POST",
    url: "/api/v1/admin/users",
    headers: { cookie: admin.cookie, "x-csrf-token": csrf },
    payload: { email: "operator@example.test", displayName: "Operator", password: "a long administrator password", role: "platform_member" },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().role, "platform_member");
  assert.equal(created.json().status, "active");
  assert.ok(created.json().username, "an administrator gets a usable handle, derived when none was supplied");

  const weak = await app.app.inject({
    method: "POST",
    url: "/api/v1/admin/users",
    headers: { cookie: admin.cookie, "x-csrf-token": csrf },
    payload: { email: "weak@example.test", displayName: "Weak", password: "short", role: "platform_member" },
  });
  assert.equal(weak.statusCode, 400);
  assert.ok(weak.json().error.details.some((entry) => entry.field === "password" && entry.code === "TOO_SHORT"), "administrators need the legacy 14-character minimum");
  const unknownRole = await app.app.inject({
    method: "POST",
    url: "/api/v1/admin/users",
    headers: { cookie: admin.cookie, "x-csrf-token": csrf },
    payload: { email: "role@example.test", displayName: "Role", password: "a long administrator password", role: "god_mode" },
  });
  assert.equal(unknownRole.statusCode, 400);
  assert.ok(unknownRole.json().error.details.some((entry) => entry.field === "role" && entry.code === "ENUM"));

  const status = await app.app.inject({
    method: "PATCH",
    url: `/api/v1/admin/users/${created.json().id}/status`,
    headers: { cookie: admin.cookie, "x-csrf-token": csrf },
    payload: { status: "disabled" },
  });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().status, "disabled");
  const selfDeactivation = await app.app.inject({
    method: "PATCH",
    url: `/api/v1/admin/users/${me.json().user.id}/status`,
    headers: { cookie: admin.cookie, "x-csrf-token": csrf },
    payload: { status: "disabled" },
  });
  assert.equal(selfDeactivation.statusCode, 400);
  assert.equal(selfDeactivation.json().error.code, "SELF_DEACTIVATION", "an administrator cannot lock themselves out of the platform");
  const missing = await app.app.inject({
    method: "PATCH",
    url: "/api/v1/admin/users/424242/status",
    headers: { cookie: admin.cookie, "x-csrf-token": csrf },
    payload: { status: "disabled" },
  });
  assert.equal(missing.statusCode, 404);

  const activity = await app.app.inject({ method: "GET", url: "/api/v1/account/activity?limit=10", headers: { cookie: admin.cookie } });
  assert.equal(activity.statusCode, 200);
  const actions = activity.json().events.map((entry) => entry.action);
  assert.ok(actions.includes("admin.user.created"), actions.join(","));
  assert.ok(actions.includes("admin.user.status-changed"));
  assert.equal(activity.json().meta.limit, 10);
  const badActivity = await app.app.inject({ method: "GET", url: "/api/v1/account/activity?limit=9999", headers: { cookie: admin.cookie } });
  assert.equal(badActivity.statusCode, 400);

  const member = await app.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { username: "plainmember", email: "plain@example.test", password: "a long enough password", passwordConfirm: "a long enough password", termsAccepted: true },
  });
  const denied = await app.app.inject({ method: "GET", url: "/api/v1/admin/users", headers: { cookie: cookieFrom(member) } });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "PERMISSION_DENIED");
  assert.equal(denied.json().error.message, "You do not have permission to perform this action");
  const anonymous = await app.app.inject({ method: "GET", url: "/api/v1/admin/users" });
  assert.equal(anonymous.statusCode, 401, "denial for an anonymous caller is 401, not 403");

  const roles = await app.app.inject({ method: "GET", url: "/api/v1/admin/roles", headers: { cookie: admin.cookie } });
  assert.equal(roles.statusCode, 200);
  assert.deepEqual(roles.json().assignable, [...identityContracts.ADMIN_ROLES]);
  assert.ok(roles.json().roles.some((role) => role.key === "super_admin"));
});

test("identity parity: a password change re-hashes, rotates the session, revokes the others", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  const first = await signIn(app.app, "rootadmin", "Root administrator pass");
  const second = await signIn(app.app, "rootadmin", "Root administrator pass");
  const me = await app.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: first.cookie } });
  const headers = { cookie: first.cookie, "x-csrf-token": me.json().csrfToken };

  const wrongCurrent = await app.app.inject({ method: "PUT", url: "/api/v1/account/password", headers, payload: { currentPassword: "not it", newPassword: "an even longer new password", newPasswordConfirm: "an even longer new password" } });
  assert.equal(wrongCurrent.statusCode, 400);
  assert.equal(wrongCurrent.json().error.code, "CURRENT_PASSWORD_INVALID");
  const mismatch = await app.app.inject({ method: "PUT", url: "/api/v1/account/password", headers, payload: { currentPassword: "Root administrator pass", newPassword: "an even longer new password", newPasswordConfirm: "something else entirely" } });
  assert.equal(mismatch.statusCode, 400);
  assert.equal(mismatch.json().error.code, "PASSWORD_MISMATCH");

  const changed = await app.app.inject({ method: "PUT", url: "/api/v1/account/password", headers, payload: { currentPassword: "Root administrator pass", newPassword: "an even longer new password", newPasswordConfirm: "an even longer new password", signOutOtherSessions: true } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().rotated, true);
  assert.equal(changed.json().revokedOthers, 1);
  assert.match(changed.json().csrfToken, /^[A-Za-z0-9_-]{16,}$/, "the new session gets a new CSRF token in the same response");
  assert.match(changed.headers["set-cookie"], /wf_session=/, "the acting session is rotated so the old cookie is useless");

  const stale = await app.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: second.cookie } });
  assert.equal(stale.statusCode, 401);
  const renewed = await signIn(app.app, "rootadmin", "an even longer new password");
  assert.equal(renewed.response.statusCode, 200, renewed.response.body);
  const old = await signIn(app.app, "rootadmin", "Root administrator pass");
  assert.equal(old.response.statusCode, 401, "the previous password must stop working immediately");

  const stored = await app.store.findUserByIdentifier("rootadmin");
  assert.match(stored.password_hash, /^\$2y\$12\$/, "the new digest uses the current cost and the PHP-compatible identifier");
  const { events } = await app.store.listAuditEvents({ action: "identity.user" });
  const audit = events.find((entry) => entry.action === "identity.user.password-changed");
  assert.ok(audit);
  assert.equal(audit.details.revokedOtherSessions, 1, "the audit row states the blast radius without naming sessions");
});

// ---------------------------------------------------------------- F-18 migrations

test("F-07 migration 003 seeds the legacy RBAC vocabulary and stays additive and re-runnable", async () => {
  const sql = await readFile(path.join(import.meta.dirname, "..", "src", "db", "migrations", "003_account_management.sql"), "utf8");
  const statements = sql.split(/;\s*\n/).map((entry) => entry.trim()).filter((entry) => entry && !entry.startsWith("--"));
  assert.ok(statements.length >= 10, `expected a bounded statement list, got ${statements.length}`);
  assert.match(sql, /ALTER TABLE wf_sessions ADD COLUMN device_label VARCHAR\(120\) NULL AFTER expires_at;/);
  assert.match(sql, /CREATE INDEX ix_wf_sessions_user_revoked ON wf_sessions \(user_id, revoked_at\);/);
  assert.match(sql, /CREATE INDEX ix_wf_users_username_lookup ON wf_users \(username\);/);
  assert.match(sql, /CREATE INDEX ix_wf_audit_entity ON wf_audit_events \(entity_type, entity_id, created_at\);/);
  assert.equal((sql.match(/ON DUPLICATE KEY UPDATE/g) || []).length, 10, "every seed statement must be idempotent");
  for (const forbidden of [/^\s*(DROP|TRUNCATE|DELETE)\b/im, /MODIFY\s+COLUMN/i, /CHANGE\s+COLUMN/i, /\bADD\s+(CONSTRAINT|FOREIGN KEY)/i]) {
    assert.doesNotMatch(sql, forbidden, "003 may not remove, resize or re-key legacy tables");
  }
  for (const role of ["super_admin", "sports_admin", "sports_viewer", "trading_operator", "trading_viewer", "lottery_admin", "lottery_viewer", "platform_member"]) {
    assert.ok(sql.includes(`'${role}'`), `role ${role} must be seeded, or the ported role picker breaks`);
  }
  for (const permission of ["identity.users.view", "identity.users.manage", "system.health.view", "system.super_admin"]) {
    assert.ok(sql.includes(permission), `permission ${permission} must be seeded, or the guards deny everyone`);
  }
  assert.ok(REQUIRED_MIGRATIONS.includes("003_account_management"), "readiness must require 003, or a half-migrated host reports ready");
});

// ---------------------------------------------------------------- F-20 / F-03 health

test("F-02 readiness reports the adapter, and a dependency outage is 503 with Retry-After — never a 500 and never a leak", async (t) => {
  const unreadyStore = {
    adapter: "mysql",
    capabilities: { adapter: "mysql", recommendedForProduction: true },
    async readiness() { return { database: true, schema: false, adapter: "mysql", detail: "missing-schema" }; },
  };
  const unready = await buildApp({ config: testConfig(), store: unreadyStore, logger: false });
  t.after(() => unready.close());
  const notReady = await unready.inject({ method: "GET", url: "/api/v1/health/ready" });
  assert.equal(notReady.statusCode, 503);
  assert.deepEqual(notReady.json(), { status: "not_ready", database: true, schema: false, adapter: "mysql", detail: "missing-schema" });
  assert.equal(notReady.headers["retry-after"], "5");
  assert.equal(notReady.headers["cache-control"], "no-store");
  assert.equal((await unready.inject({ method: "GET", url: "/api/v1/health/live" })).statusCode, 200, "liveness never depends on the database");

  const seeded = await harness();
  t.after(() => seeded.cleanup());
  const ready = await seeded.app.inject({ method: "GET", url: "/api/v1/health/ready" });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.json().schema, true);
  assert.equal(ready.json().adapter, "file");
  assert.equal(ready.json().durability, "development-only", "a file-backed host must never look production-ready");

  const broken = { ...seeded.store, async readiness() { const error = new Error("connect ECONNREFUSED db.internal:3306/wf?password=hunter2"); error.code = "ECONNREFUSED"; throw error; } };
  const app = await buildApp({ config: seeded.config, store: broken, logger: false });
  t.after(() => app.close());
  const outage = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
  assert.equal(outage.statusCode, 503);
  assert.equal(outage.json().detail, "probe-failed");
  assert.doesNotMatch(outage.body, /3306|hunter2|ECONNREFUSED/, "a probe failure must not echo host, port or credentials");
  assert.equal(outage.headers["retry-after"], "5");

  const status = await app.inject({ method: "GET", url: "/api/v1/system/status" });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.json().readiness, { database: false, schema: false, detail: "probe-failed" }, "the status page must agree with readiness");
});

test("F-02 the status surface is honest about unported modules, and F-03 the route inventory states what each route enforces", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  const status = await app.app.inject({ method: "GET", url: "/api/v1/system/status" });
  assert.equal(status.statusCode, 200);
  const body = status.json();
  assert.equal(body.trading.enabled, false);
  assert.match(body.trading.reason, /not ported/i);
  assert.equal(body.modules.find((module) => module.key === "identity").state, "ported");
  assert.equal(body.modules.find((module) => module.key === "marketData").state, "ported", "market data was ported in Phase 4");
  assert.equal(body.modules.find((module) => module.key === "analysis").state, "ported", "the analysis engines were ported in Phase 5");
  assert.equal(body.modules.filter((module) => module.state === "ported").length, 3, "only identity, market data and analysis may be claimed as ported");
  assert.equal(body.modules.find((module) => module.key === "audit").state, "partial");
  // Risk is partial, not ported: the veto gate lives inside analysis, while the
  // kill-switch control surface and the portfolio snapshot are still legacy-only.
  assert.equal(body.modules.find((module) => module.key === "risk").state, "partial");
  assert.equal(body.modules.filter((module) => module.state === "partial").length, 3);
  assert.equal(body.modules.filter((module) => module.state === "not-ported").length, 9);
  assert.equal(body.modules.length, 15, "the ledger keeps listing every module, ported or not");
  // The public status surface carries a market-data snapshot that must not have
  // probed an external host to produce it.
  assert.ok(body.marketData && Array.isArray(body.marketData.providers), "status reports the provider registry");
  assert.ok(body.marketData.providers.every((entry) => entry.status === "UNKNOWN" || typeof entry.status === "string"));
  assert.equal(body.storage.adapter, "file");
  assert.equal(body.readiness.schema, true);
  assert.match(body.version, /@\d+\.\d+\.\d+$/, "the version comes from the package manifest");
  const manifest = JSON.parse(await readFile(path.join(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.equal(body.version, `${manifest.name}@${manifest.version}`);
  // `prune:analysis` joined the list with R-27: retention is documented as an
  // operator command in the cPanel instructions, so the script has to exist. The
  // tool's syntax is already covered by `verify:install` check 1, which walks
  // `src/` and `tools/`.
  const operational = ["backup", "restore", "prune:analysis", "verify:install", "verify:data", "seed:platform", "migrate", "import:identity", "start"];
  const missing = operational.filter((name) => !(name in manifest.scripts));
  assert.deepEqual(missing, [], "the documented operational commands must exist as scripts");
  assert.equal(Object.keys(manifest.scripts).filter((name) => operational.includes(name)).length, operational.length);

  const routes = await app.app.inject({ method: "GET", url: "/api/v1/system/routes" });
  const inventory = routes.json().routes;
  const adminRoutes = inventory.filter((entry) => entry.path.startsWith("/api/v1/admin/"));
  assert.equal(adminRoutes.length, 6, "account-admin routes, the inquiry listing, the deprecated identity listing — and no admin route is unguarded");
  for (const route of adminRoutes) {
    assert.ok(["identity.users.view", "identity.users.manage", "system.super_admin"].includes(route.permission), `${route.method} ${route.path} must report its permission in the ledger, got ${route.permission}`);
  }
  assert.deepEqual(adminRoutes.filter((route) => route.permission === "identity.users.manage").map((route) => route.method).sort(), ["PATCH", "POST"], "writes are the only routes needing manage");
  assert.equal(routes.statusCode, 200);
  assert.ok(routes.json().count >= 28, `the route inventory must not shrink (got ${routes.json().count})`);
  assert.equal(routes.json().count, new Set(routes.json().routes.map((entry) => `${entry.method} ${entry.path}`)).size, "the inventory must not double-count a route");
  for (const entry of routes.json().routes) {
    assert.match(entry.path, /^\/api\/v1\//);
    assert.equal(typeof entry.auth, "boolean");
  }
  const byPath = new Map(routes.json().routes.map((entry) => [`${entry.method} ${entry.path}`, entry]));
  assert.equal(byPath.get("POST /api/v1/auth/login").validated, true, "login must be schema-validated");
  assert.equal(byPath.get("POST /api/v1/auth/login").rateLimited, true, "login must be rate limited");
  assert.equal(byPath.get("POST /api/v1/auth/logout").auth, true, "logout must be authenticated");
  assert.equal(byPath.get("GET /api/v1/admin/users").permission, "identity.users.view", "the inventory states what each guard enforces");
  assert.equal(byPath.get("GET /api/v1/health/live").auth, false, "liveness must stay reachable");

  const features = await app.app.inject({ method: "GET", url: "/api/v1/system/features" });
  assert.equal(features.statusCode, 200);
  assert.equal(features.json().features.paperTrading, "not-ported");
  assert.equal(features.json().features.identity, "ported");
  assert.equal(features.json().features.marketData, "ported");
  assert.equal(features.json().features.analysis, "ported");
  assert.equal(features.json().features.risk, "partial");
  assert.equal(features.json().features.execution, "not-ported", "analysis producing proposals must not imply an execution path");
  assert.match(features.json().honesty, /No module is reported as ready/i);
});

// ---------------------------------------------------------------- F-21 static

test("static serving: a document, an asset and an SPA route are distinguished, and anything else is refused", async (t) => {
  const root = path.join(await workDir("wf-static-"), "public");
  await mkdir(path.join(root, "app", "assets"), { recursive: true });
  await mkdir(path.join(root, "uploads"), { recursive: true });
  await writeFile(path.join(root, "index.html"), "<!doctype html><title>Workforce</title>");
  await writeFile(path.join(root, "styles.css"), ":root{color:red}");
  await writeFile(path.join(root, "service-worker.js"), "// sw");
  await writeFile(path.join(root, "manifest.webmanifest"), "{}");
  await writeFile(path.join(root, "uploads", "leak.png"), PNG);
  await writeFile(path.join(root, ".env"), "SECRET=1");
  await writeFile(path.join(root, "app", "index.html"), "<!doctype html><title>SPA</title>");
  await writeFile(path.join(root, "app", "assets", "index-Q7dK3pLm.js"), "console.log(1)");
  await writeFile(path.join(root, "app", "assets", "site.js.map"), '{"sources":["src/main.jsx"]}');
  const config = testConfig({ env: GENEROUS_LIMITS });
  const app = await buildApp({ config, store: null, logger: false, publicDir: root });
  t.after(async () => { await app.close(); await rm(path.dirname(root), { recursive: true, force: true }); });

  const document = await app.inject({ method: "GET", url: "/" });
  assert.equal(document.statusCode, 200);
  assert.match(document.headers["content-type"], /^text\/html/);
  assert.equal(document.headers["cache-control"], "no-cache", "a document must be revalidated so a deploy is visible");
  // Static files keep the size/mtime weak ETag; generated documents carry a
  // content hash in the same weak form.
  assert.match(document.headers.etag, /^W\/"[0-9a-f]+(-[0-9a-f]+)?"$/);
  assert.equal(document.headers["x-content-type-options"], "nosniff");

  const asset = await app.inject({ method: "GET", url: "/styles.css" });
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.headers["cache-control"], "public, max-age=3600", "an unhashed file must not be cached forever");
  const notModified = await app.inject({ method: "GET", url: "/styles.css", headers: { "if-none-match": asset.headers.etag } });
  assert.equal(notModified.statusCode, 304);
  assert.equal(notModified.headers["content-length"], undefined);
  const hashed = await app.inject({ method: "GET", url: "/app/assets/index-Q7dK3pLm.js" });
  assert.equal(hashed.headers["cache-control"], "public, max-age=31536000, immutable", "a content-hashed build asset may be cached forever");
  assert.equal((await app.inject({ method: "GET", url: "/service-worker.js" })).headers["cache-control"], "no-cache");
  assert.equal((await app.inject({ method: "GET", url: "/manifest.webmanifest" })).headers["cache-control"], "no-cache");
  const head = await app.inject({ method: "HEAD", url: "/styles.css" });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, "");

  const fallback = await app.inject({ method: "GET", url: "/app/account/overview", headers: { accept: "text/html,application/xhtml+xml" } });
  assert.equal(fallback.statusCode, 200);
  assert.match(fallback.body, /SPA/);
  const assetRequest = await app.inject({ method: "GET", url: "/app/missing", headers: { accept: "*/*" } });
  assert.equal(assetRequest.statusCode, 404, "an asset request must not be answered with index.html");
  const apiUnderSpa = await app.inject({ method: "GET", url: "/api/v1/account", headers: { accept: "text/html" } });
  assert.doesNotMatch(apiUnderSpa.headers["content-type"] || "", /text\/html/, "an API path is never answered with the SPA shell");

  for (const forbidden of ["/uploads/leak.png", "/.env", "/app/assets/site.js.map", "/robots.txt/.hidden", "/%2e%2e%2fserver.js", "/app/assets/./site.js"]) {
    const response = await app.inject({ method: "GET", url: forbidden });
    assert.ok([404, 400].includes(response.statusCode), `${forbidden} must not be served (got ${response.statusCode})`);
    assert.doesNotMatch(response.body, /SECRET|sources|pwned/);
  }

  assert.equal(staticAssetPath(root, "/index.html"), path.join(root, "index.html"));
  assert.equal(staticAssetPath(root, "/"), path.join(root, "index.html"));
  assert.equal(staticAssetPath(root, "/uploads/leak.png"), null);
  assert.equal(staticAssetPath(root, "/.env"), null);
  assert.equal(staticAssetPath(root, "/a/../../b"), path.join(root, "b"), "the path is resolved, so no dot segment survives to the filesystem");
  assert.equal(staticAssetPath(root, "/%zz"), null, "an undecodable target is refused, never thrown");
  assert.equal(staticAssetPath(root, "/a\\b"), null);
  assert.equal(cacheControlFor("/app/assets/index-Q7dK3pLm.js", ".js"), "public, max-age=31536000, immutable");
  assert.equal(cacheControlFor("/sitemap.xml", ".xml"), "no-cache");
  assert.equal(cacheControlFor("/index.html", ".html"), "no-cache");
});

test("F-01 the server boots, serves and signs in with no database configured at all", async (t) => {
  // The finding was that `loadConfig` hard-required DB_* and `server.js` always
  // built a pool, so a host without MySQL could not start. Both must be untrue now.
  const env = {
    NODE_ENV: "development",
    SESSION_SECRET: "n".repeat(40),
    LOG_LEVEL: "silent",
    STORAGE_ADAPTER: "auto",
  };
  const { loadConfig } = await import("../src/config.js");
  const config = loadConfig(env);
  assert.equal(config.storage.adapter, "file", "auto resolves to the file adapter when no DB_* is set; booting is not gated on a database");
  assert.equal(config.database, null);
  assert.throws(() => loadConfig({ ...env, STORAGE_ADAPTER: "mysql" }), /requires DB_HOST/);
  const { resolveAdapter } = await import("../src/persistence/index.js");
  assert.equal(resolveAdapter({ storage: config.storage, databaseConfigured: false }), "file");
  assert.equal(resolveAdapter({ storage: { adapter: "mysql" }, databaseConfigured: true }), "mysql");
  assert.throws(() => loadConfig({ ...env, NODE_ENV: "production", STORAGE_ADAPTER: "file", PUBLIC_BASE_URL: "https://x.test" }), /not approved for production/);

  const root = await workDir("wf-nodb-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = await createFileStoreApp({ configOverrides: { __directory: root, env: GENEROUS_LIMITS }, seed: false });
  t.after(() => app.cleanup());
  const live = await app.app.inject({ method: "GET", url: "/api/v1/health/live" });
  assert.equal(live.statusCode, 200);
  // An unseeded store is ready to serve but announces the missing baseline; and a
  // credential check against it is a 401, never the 500 the finding reported.
  const login = await app.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: "nobody", password: "not the password" } });
  assert.equal(login.statusCode, 401, login.body);
  assert.equal(login.json().error.code, "LOGIN_INVALID");
  const ready = await app.app.inject({ method: "GET", url: "/api/v1/health/ready" });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.json().detail, "roles-not-seeded");
  const seededApp = await harness();
  t.after(() => seededApp.cleanup());
  const seededReady = await seededApp.app.inject({ method: "GET", url: "/api/v1/health/ready" });
  assert.equal(seededReady.json().detail, undefined);
  assert.equal(seededReady.statusCode, 200);
});

test("F-14 the example environment documents every variable and never defaults to production", async () => {
  const example = await readFile(path.join(import.meta.dirname, "..", ".env.example"), "utf8");
  const configSource = await readFile(path.join(import.meta.dirname, "..", "src", "config.js"), "utf8");
  const referenced = new Set();
  for (const match of configSource.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) referenced.add(match[1]);
  assert.ok(referenced.size >= 30, `expected the config to be fully scanned, found ${referenced.size} variables`);
  const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]{2,})=/gm)].map((match) => match[1]));
  const missing = [...referenced].filter((name) => !documented.has(name));
  assert.deepEqual(missing, [], "every variable the config reads must be documented");
  assert.match(example, /^NODE_ENV=development$/m, "an example file headed for development must not set NODE_ENV=production");
  for (const name of ["LEGACY_DB_HOST", "LEGACY_DB_NAME", "LEGACY_DB_USER", "LEGACY_DB_PASSWORD", "SESSION_SECRET", "STORAGE_DIR", "UPLOAD_DIR", "RATE_LIMIT_API_MAX", "LOGIN_LOCKOUT_FAILURES", "CORS_ALLOWED_ORIGINS", "PASSWORD_MIN_LENGTH"]) {
    assert.ok(documented.has(name), `${name} was the specific gap: undocumented knobs are unconfigurable`);
  }
  assert.doesNotMatch(example, /^(DB_PASSWORD|SESSION_SECRET)=(?!replace)[^\s]+$/m, "no example may ship a value that looks real");
});
