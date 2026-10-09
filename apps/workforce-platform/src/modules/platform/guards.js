/**
 * Authentication and authorization guards shared by every module.
 *
 * Two credential styles are accepted, and never both at once:
 *  - cookie sessions (web + PWA): opaque, server-side, `SameSite=Strict`, plus a
 *    session-bound CSRF token on every unsafe method;
 *  - bearer tokens (native shells): same server-side session record, presented
 *    explicitly, so CSRF does not apply but TLS and revocation do.
 *
 * `system.super_admin` implies every permission, matching `Identity::can()`.
 */

import { AppError } from "../../http/errors.js";
import { isCrossSiteMutation, resolveCors } from "../../security/headers.js";
import { csrfTokenForSession, hashSessionToken, readBearerToken, readSessionCookie, expiredSessionCookie } from "../../security/session.js";
import { SUPER_ADMIN_PERMISSION, userHasPermission } from "../identity/service.js";

import { constantTimeEqual } from "../../security/session.js";

export const SAFE_METHODS = Object.freeze(["GET", "HEAD", "OPTIONS"]);

function attachIdentity(request, session, config, { token, tokenHash, via }) {
  request.auth = {
    user: session.user,
    permissions: session.permissions || [],
    token,
    tokenHash,
    via,
    csrfToken: csrfTokenForSession(token, config.sessionSecret),
  };
  request.permissions = session.permissions || [];
}

/**
 * Resolves the credential before route validation so a handler can assume
 * `request.auth` exists on guarded routes.
 */
export function createAuthenticator({ store, config }) {
  return async function authenticate(request, reply) {
    const bearer = readBearerToken(request.headers.authorization);
    const cookieToken = bearer ? null : readSessionCookie(request.headers.cookie, config.cookieName);
    const token = bearer || cookieToken;
    if (!token) {
      throw AppError.unauthorized("Authentication is required", { code: "AUTH_REQUIRED" });
    }
    const tokenHash = hashSessionToken(token);
    const session = await store.findSession(tokenHash);
    if (!session) {
      if (cookieToken) {
        reply.header("set-cookie", expiredSessionCookie(config.cookieName, { secure: config.secureCookie }));
      }
      throw AppError.unauthorized("The session is invalid or expired", { code: "SESSION_INVALID" });
    }
    attachIdentity(request, session, config, { token, tokenHash, via: bearer ? "bearer" : "cookie" });
  };
}

/** CSRF applies to ambient (cookie) credentials only. */
export function requireCsrf(config) {
  return async function verifyCsrf(request) {
    if (SAFE_METHODS.includes(request.method)) return;
    if (request.auth?.via === "bearer") return;
    const cors = resolveCors(request, config);
    if (!cors.allowed) throw AppError.forbidden("The request origin is not allowed", { code: "ORIGIN_INVALID" });
    if (isCrossSiteMutation(request, config)) {
      throw AppError.forbidden("The request origin is not allowed", { code: "ORIGIN_INVALID" });
    }
    const expected = csrfTokenForSession(request.auth.token, config.sessionSecret);
    const supplied = request.headers["x-csrf-token"];
    if (!constantTimeEqual(supplied, expected)) {
      throw AppError.forbidden("A valid CSRF token is required", { code: "CSRF_INVALID" });
    }
  };
}

export function requirePermission(permission, config) {
  return async function verifyPermission(request) {
    if (!request.auth?.user?.id) throw AppError.unauthorized("Authentication is required", { code: "AUTH_REQUIRED" });
    if (!userHasPermission(request.auth.permissions, permission)) {
      throw AppError.forbidden("You do not have permission to perform this action", { code: "PERMISSION_DENIED" });
    }
    if (!SAFE_METHODS.includes(request.method)) await requireCsrf(config)(request);
  };
}

export { SUPER_ADMIN_PERMISSION };
