import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp, TEST_CONFIG } from "./helpers.js";
import { hashSessionToken, newSessionToken } from "../src/security/session.js";

function cookieFrom(response) {
  return response.headers["set-cookie"]?.split(";")[0] || "";
}

test("health endpoints distinguish liveness from database/schema readiness", async (t) => {
  const ready = await createTestApp();
  t.after(() => ready.app.close());
  const live = await ready.app.inject({ method: "GET", url: "/api/v1/health/live" });
  const health = await ready.app.inject({ method: "GET", url: "/api/v1/health/ready" });
  assert.equal(live.statusCode, 200);
  // Liveness must stay cheap and truthful: uptime + runtime, no database probe.
  assert.equal(live.json().status, "ok");
  assert.match(live.json().node, /^22\./);
  assert.equal(health.statusCode, 200);
  // A non-production adapter is announced as such instead of pretending to be ready.
  assert.deepEqual(health.json(), { status: "ready", database: true, schema: true, adapter: "test", durability: "development-only" });

  const unready = await createTestApp({ readiness: { database: true, schema: false, adapter: "mysql", detail: "missing-schema" } });
  t.after(() => unready.app.close());
  const response = await unready.app.inject({ method: "GET", url: "/api/v1/health/ready" });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    status: "not_ready",
    database: true,
    schema: false,
    adapter: "mysql",
    detail: "missing-schema",
    durability: "development-only",
  });
});

test("login accepts legacy username, email, or six-digit UID and returns a secure opaque session", async (t) => {
  const { app } = await createTestApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifier: "alice@example.test", password: "Correct horse battery staple" },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.user.username, "alice");
  assert.deepEqual(body.permissions, ["identity.users.view"]);
  assert.match(body.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(response.headers["set-cookie"], /^wf_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=1800; HttpOnly; SameSite=Strict$/);
  assert.equal(JSON.stringify(body).includes("password"), false);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("successful login rotates a previously presented session", async (t) => {
  const { app, sessions } = await createTestApp();
  t.after(() => app.close());
  const previousToken = newSessionToken();
  const previousHash = hashSessionToken(previousToken);
  sessions.set(previousHash, {
    tokenHash: previousHash,
    userId: 7,
    expiresAt: new Date(Date.now() + 60_000),
    revoked: false,
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { cookie: `wf_session=${previousToken}` },
    payload: { identifier: "alice", password: "Correct horse battery staple" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(sessions.get(previousHash).revoked, true);
  assert.notEqual(cookieFrom(response), `wf_session=${previousToken}`);
});

test("invalid credentials use a generic response and are audited without storing the identifier", async (t) => {
  const { app, audits } = await createTestApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifier: "unknown@example.test", password: "wrong password" },
  });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: { code: "LOGIN_INVALID", message: "The supplied credentials are invalid" } });
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(audits[0].action, "identity.login.failed");
  assert.equal(audits[0].details.legacyAction, "LOGIN_FAILED");
  assert.equal(JSON.stringify(audits[0]).includes("unknown@example.test"), false);
});

test("authenticated reads work; state changes require the session-bound CSRF token", async (t) => {
  const { app, sessions } = await createTestApp();
  t.after(() => app.close());
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifier: "123456", password: "Correct horse battery staple" },
  });
  const cookie = cookieFrom(login);
  assert.ok(cookie.startsWith("wf_session="));

  const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.legacyUid, "123456");

  const denied = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie }, payload: {} });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "CSRF_INVALID");
  assert.equal([...sessions.values()][0].revoked, false);

  const csrf = login.json().csrfToken;
  const logout = await app.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: { cookie, "x-csrf-token": csrf },
    payload: {},
  });
  assert.equal(logout.statusCode, 200);
  assert.equal(logout.json().ok, true);
  assert.equal([...sessions.values()][0].revoked, true);
  assert.match(logout.headers["set-cookie"], /Max-Age=0/);
});

test("RBAC denies by default, and origin checks reject cross-site login attempts", async (t) => {
  const { app } = await createTestApp({ permissions: [] });
  t.after(() => app.close());
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifier: "alice", password: "Correct horse battery staple" },
  });
  const denied = await app.inject({
    method: "GET",
    url: "/api/v1/admin/identity/users",
    headers: { cookie: cookieFrom(login) },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "PERMISSION_DENIED");

  const originDenied = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: "https://attacker.invalid" },
    payload: { identifier: "alice", password: "Correct horse battery staple" },
  });
  assert.equal(originDenied.statusCode, 403);
  assert.equal(originDenied.json().error.code, "ORIGIN_INVALID");
});

test("production cookies carry Secure and the __Host- prefix", async (t) => {
  const config = { ...TEST_CONFIG, mode: "production", production: true, cookieName: "__Host-wf_session", secureCookie: true };
  const { app, store } = await createTestApp();
  await app.close();
  const { buildApp } = await import("../src/app.js");
  const secureApp = await buildApp({ config, store, logger: false });
  t.after(() => secureApp.close());
  const response = await secureApp.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifier: "alice", password: "Correct horse battery staple" },
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["set-cookie"], /^__Host-wf_session=.*; Secure$/);
});

test("request validation and hardening headers are enabled", async (t) => {
  const { app } = await createTestApp();
  t.after(() => app.close());
  const invalid = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifier: "alice", password: "x", extra: "no" },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "INVALID_REQUEST");
  const health = await app.inject({ method: "GET", url: "/api/v1/health/live" });
  assert.equal(health.headers["x-content-type-options"], "nosniff");
  assert.ok(health.headers["content-security-policy"]);
});

test("self-service password reset tokens are single-use, expire in 15 minutes, revoke active sessions, and integrate with SMTP", async (t) => {
  const { createFileStoreApp } = await import("./helpers.js");
  const { createIdentityService, mintPasswordResetToken, PASSWORD_RESET_TTL_MS } = await import("../src/modules/identity/service.js");

  const instance = await createFileStoreApp();
  t.after(() => instance.cleanup());

  // 1. Register a regular member account
  const reg = await instance.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      username: "resetmember",
      email: "resetmember@example.test",
      password: "InitialPassword123!",
      passwordConfirm: "InitialPassword123!",
      termsAccepted: true,
    },
  });
  assert.equal(reg.statusCode, 200, reg.body);
  const memberCookie = cookieFrom(reg);

  // 2. When SMTP is disabled (default host), password-reset-request returns delivered: false
  const disabledReset = await instance.app.inject({
    method: "POST",
    url: "/api/v1/auth/password-reset-request",
    payload: { identifier: "resetmember@example.test" },
  });
  assert.equal(disabledReset.statusCode, 200);
  assert.equal(disabledReset.json().delivered, false);

  // 3. With an enabled mailer stub, requestPasswordReset mints a token and sends it without leaking account existence
  const sentMessages = [];
  const fakeMail = {
    enabled: () => true,
    send: async (msg) => {
      sentMessages.push(msg);
      return { ok: true, message: "sent" };
    },
  };
  let fakeNow = Date.now();
  const identityWithSmtp = createIdentityService({
    store: instance.store,
    config: instance.config,
    mail: fakeMail,
    now: () => fakeNow,
  });

  const knownReq = await identityWithSmtp.requestPasswordReset({ identifier: "resetmember@example.test" });
  const unknownReq = await identityWithSmtp.requestPasswordReset({ identifier: "nobody@example.test" });
  assert.equal(knownReq.delivered, true);
  assert.equal(unknownReq.delivered, true);
  assert.equal(knownReq.notice, unknownReq.notice, "enumeration-safe response for known and unknown identifiers");
  assert.equal(sentMessages.length, 1, "only the known active user triggers an outbound email");
  assert.equal(sentMessages[0].to, "resetmember@example.test");

  const tokenMatch = sentMessages[0].text.match(/(\d+\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
  assert.ok(tokenMatch, "reset email must include the single-use token");
  const resetToken = tokenMatch[1];

  // 4. An expired token is rejected with RESET_TOKEN_EXPIRED
  const userRow = await instance.store.findUserByIdentifier("resetmember");
  const expiredToken = mintPasswordResetToken({
    userId: userRow.id,
    passwordHash: userRow.password_hash,
    sessionSecret: instance.config.sessionSecret,
    nowMs: Date.now() - PASSWORD_RESET_TTL_MS - 5_000,
  }).token;
  const expiredRes = await instance.app.inject({
    method: "POST",
    url: "/api/v1/auth/password-reset-confirm",
    payload: {
      token: expiredToken,
      newPassword: "UpdatedPassword456!",
      newPasswordConfirm: "UpdatedPassword456!",
    },
  });
  assert.equal(expiredRes.statusCode, 400);
  assert.equal(expiredRes.json().error.code, "RESET_TOKEN_EXPIRED");

  // 5. Confirming with the valid token updates the password, revokes all active sessions, and audits PASSWORD_CHANGED
  const confirmRes = await instance.app.inject({
    method: "POST",
    url: "/api/v1/auth/password-reset-confirm",
    payload: {
      token: resetToken,
      newPassword: "UpdatedPassword456!",
      newPasswordConfirm: "UpdatedPassword456!",
    },
  });
  assert.equal(confirmRes.statusCode, 200, confirmRes.body);
  assert.equal(confirmRes.json().reset, true);
  assert.ok(confirmRes.json().revokedSessions >= 1);

  // Previous session cookie is now revoked
  const meAfterReset = await instance.app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: memberCookie },
  });
  assert.equal(meAfterReset.statusCode, 401);

  // Replaying the same token is rejected immediately (single-use)
  const replayRes = await instance.app.inject({
    method: "POST",
    url: "/api/v1/auth/password-reset-confirm",
    payload: {
      token: resetToken,
      newPassword: "AnotherPassword789!",
      newPasswordConfirm: "AnotherPassword789!",
    },
  });
  assert.equal(replayRes.statusCode, 400);
  assert.equal(replayRes.json().error.code, "RESET_TOKEN_INVALID");

  // Signing in with the new password succeeds
  const newLogin = await instance.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifier: "resetmember", password: "UpdatedPassword456!" },
  });
  assert.equal(newLogin.statusCode, 200);
});
