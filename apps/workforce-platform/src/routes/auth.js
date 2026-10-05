import { hashFailedLoginIdentifier } from "../db/store.js";
import {
  constantTimeEqual,
  csrfTokenForSession,
  expiredSessionCookie,
  hashSessionToken,
  newSessionToken,
  readSessionCookie,
  sessionCookie,
} from "../security/session.js";
import { verifyPassword } from "../security/passwords.js";

function errorReply(reply, statusCode, code, message) {
  return reply.code(statusCode).send({ error: { code, message } });
}

function originIsAllowed(request, config) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== "string") return false;
  try {
    const supplied = new URL(origin);
    const expected = config.publicBaseUrl || `${request.protocol}://${request.hostname}`;
    return supplied.origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

export function requireAuth({ store, config }) {
  return async function authenticate(request, reply) {
    const token = readSessionCookie(request.headers.cookie, config.cookieName);
    if (!token) return errorReply(reply, 401, "AUTH_REQUIRED", "Authentication is required");

    const tokenHash = hashSessionToken(token);
    const session = await store.findSession(tokenHash);
    if (!session) {
      reply.header("set-cookie", expiredSessionCookie(config.cookieName, { secure: config.secureCookie }));
      return errorReply(reply, 401, "SESSION_INVALID", "The session is invalid or expired");
    }
    request.auth = { ...session, token, tokenHash };
  };
}

export function requireCsrf(config) {
  return async function verifyCsrf(request, reply) {
    if (!originIsAllowed(request, config)) {
      return errorReply(reply, 403, "ORIGIN_INVALID", "The request origin is not allowed");
    }
    const expected = csrfTokenForSession(request.auth.token, config.sessionSecret);
    if (!constantTimeEqual(request.headers["x-csrf-token"], expected)) {
      return errorReply(reply, 403, "CSRF_INVALID", "A valid CSRF token is required");
    }
  };
}

export function requirePermission(permission) {
  return async function verifyPermission(request, reply) {
    if (!request.auth?.permissions?.includes(permission)) {
      return errorReply(reply, 403, "PERMISSION_DENIED", "You do not have permission to perform this action");
    }
  };
}

function publicUser(user) {
  return {
    id: user.id,
    legacyUid: user.legacyUid ?? null,
    username: user.username,
    email: user.email ?? null,
  };
}

export async function authRoutes(app, { store, config }) {
  const authenticate = requireAuth({ store, config });
  const verifyCsrf = requireCsrf(config);

  app.post("/auth/login", {
    config: { rateLimit: { max: 5, timeWindow: 60_000 } },
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["identifier", "password"],
        properties: {
          identifier: { type: "string", minLength: 1, maxLength: 254 },
          password: { type: "string", minLength: 1, maxLength: 1024 },
        },
      },
    },
  }, async (request, reply) => {
    if (!originIsAllowed(request, config)) {
      return errorReply(reply, 403, "ORIGIN_INVALID", "The request origin is not allowed");
    }

    const identifier = request.body.identifier.trim();
    const user = await store.findUserByIdentifier(identifier);
    const validPassword = await verifyPassword(request.body.password, user?.password_hash);
    if (!user || user.status !== "active" || !validPassword) {
      await store.recordAudit({
        actorId: null,
        action: "auth.login.failed",
        entityType: "identity",
        details: { identifierHash: hashFailedLoginIdentifier(identifier) },
      });
      return errorReply(reply, 401, "LOGIN_INVALID", "The supplied credentials are invalid");
    }

    const previousToken = readSessionCookie(request.headers.cookie, config.cookieName);
    if (previousToken) await store.revokeSession(hashSessionToken(previousToken));

    const token = newSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000);
    await store.createSession({ tokenHash, userId: user.id, expiresAt });
    await store.recordAudit({
      actorId: user.id,
      action: "auth.login.succeeded",
      entityType: "identity",
      entityId: user.id,
      details: {},
    });
    const session = await store.findSession(tokenHash);
    if (!session) throw new Error("New session could not be verified");

    reply.header("set-cookie", sessionCookie(config.cookieName, token, {
      maxAge: config.sessionTtlSeconds,
      secure: config.secureCookie,
    }));
    return reply.code(200).send({
      user: publicUser(session.user),
      permissions: session.permissions,
      csrfToken: csrfTokenForSession(token, config.sessionSecret),
    });
  });

  app.get("/auth/me", { preHandler: [authenticate] }, async (request) => ({
    user: publicUser(request.auth.user),
    permissions: request.auth.permissions,
  }));

  app.get("/auth/csrf", { preHandler: [authenticate] }, async (request) => ({
    csrfToken: csrfTokenForSession(request.auth.token, config.sessionSecret),
  }));

  app.post("/auth/logout", {
    preHandler: [authenticate, verifyCsrf],
  }, async (request, reply) => {
    await store.revokeSession(request.auth.tokenHash);
    await store.recordAudit({
      actorId: request.auth.user.id,
      action: "auth.logout",
      entityType: "identity",
      entityId: request.auth.user.id,
      details: {},
    });
    reply.header("set-cookie", expiredSessionCookie(config.cookieName, { secure: config.secureCookie }));
    return { ok: true };
  });

  app.get("/admin/identity/users", {
    preHandler: [authenticate, requirePermission("identity.users.view")],
  }, async () => ({ users: await store.listUsers(100) }));
}
