/**
 * Identity and account business rules, transport-free.
 *
 * `SUPER_ADMIN_PERMISSION` short-circuits permission checks exactly like
 * `Identity::can()` in PHP, and `system.authenticated` is satisfied by any signed-in
 * user. Everything else must be granted explicitly (deny-by-default).
 *
 * Errors are AppError instances so the HTTP layer can render a predictable body
 * without string matching.
 */

import { AppError } from "../../http/errors.js";
import { hashPassword, inspectPassword } from "../../security/passwords.js";
import { csrfTokenForSession, hashSessionToken, newSessionToken } from "../../security/session.js";
import { ADMIN_ROLES } from "./contracts.js";

export const SUPER_ADMIN_PERMISSION = "system.super_admin";
export const AUTHENTICATED_PERMISSION = "system.authenticated";
export const MEMBER_ROLE = "platform_member";
/** Grants the legacy registration flow gives a self-registered member. */
export const MEMBER_PERMISSIONS = Object.freeze(["trading.view", "sports.view", "lottery.view"]);

/** Legacy `Auth::logout`/`Identity` audit vocabulary, kept traceable. */
export const LEGACY_AUDIT_ACTIONS = Object.freeze({
  "identity.login.succeeded": "LOGIN_SUCCEEDED",
  "identity.login.failed": "LOGIN_FAILED",
  "identity.logout": "LOGOUT",
  "identity.user.registered": "USER_REGISTERED",
  "identity.user.username-changed": "USER_UPDATED",
  "identity.user.email-changed": "USER_UPDATED",
  "identity.user.profile-updated": "USER_UPDATED",
  "identity.user.password-changed": "PASSWORD_CHANGED",
  "identity.user.avatar-updated": "USER_UPDATED",
  "identity.user.avatar-removed": "USER_UPDATED",
  "identity.sessions.revoked-others": "USER_UPDATED",
  "admin.user.created": "ADMIN_USER_CREATED",
  "admin.user.status-changed": "ADMIN_USER_STATUS_CHANGED",
});

export function userHasPermission(permissions, permission) {
  if (permission === AUTHENTICATED_PERMISSION) return true;
  return permissions.includes(permission) || permissions.includes(SUPER_ADMIN_PERMISSION);
}

export function publicUser(user) {
  return {
    id: user.id,
    legacyUid: user.legacyUid ?? user.legacy_uid ?? null,
    username: user.username,
    displayName: user.displayName || user.username,
    email: user.email ?? null,
    avatarUrl: user.profileImage ?? user.avatarUrl ?? null,
    createdAt: user.created_at ?? user.createdAt ?? null,
  };
}

async function allocateSession(store, { userId, ttlSeconds, deviceLabel = null }) {
  const token = newSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await store.createSession({ tokenHash, userId, expiresAt, deviceLabel });
  const session = await store.findSession(tokenHash);
  if (!session) throw new AppError(503, "SESSION_UNAVAILABLE", "The session could not be created. Try again.", { retryAfter: 5 });
  return { token, tokenHash, expiresAt, session };
}

async function audit(store, event) {
  await store.recordAudit({ ...event, details: { ...(event.details || {}), ...(LEGACY_AUDIT_ACTIONS[event.action] ? { legacyAction: LEGACY_AUDIT_ACTIONS[event.action] } : {}) } });
}

export function createIdentityService({ store, config, loginGuard = null }) {
  const rememberTtlSeconds = Math.min(Math.max(config.rememberSessionTtlSeconds ?? 30 * 24 * 60 * 60, config.sessionTtlSeconds), 30 * 24 * 60 * 60);

  return {
    memberPermissions() {
      return [...MEMBER_PERMISSIONS];
    },

    /**
     * Verifies credentials, applies the account lockout, rotates any previously
     * presented session, lazily re-hashes legacy digests and returns the opaque
     * session token plus its bound CSRF token.
     */
    async signIn({ identifier, password, remember = false, admin = false, clientLabel = null, clientIp = "unknown", presentedTokenHash = null }) {
      const guardKeys = loginGuard ? [`login:account:${normalize(identifier)}`] : [];
      if (loginGuard) {
        const wait = loginGuard.evaluate(guardKeys);
        if (wait) {
          throw AppError.tooManyRequests("Too many failed sign-in attempts. Try again later.", { retryAfter: wait });
        }
      }

      const normalized = normalize(identifier);
      const user = await store.findUserByIdentifier(normalized);
      const inspection = await inspectPassword(password, user?.password_hash);

      if (!user || user.status !== "active" || !inspection.valid) {
        const wait = loginGuard ? loginGuard.recordFailure(guardKeys) : 0;
        await audit(store, {
          actorId: null,
          action: "identity.login.failed",
          entityType: "identity",
          details: { identifierHash: hashSessionToken(normalized), reason: user ? (inspection.valid ? "inactive" : "password") : "unknown-identifier" },
        });
        throw AppError.unauthorized("The supplied credentials are invalid", { code: "LOGIN_INVALID" });
      }

      if (admin) {
        const permissions = await store.permissionsForUser(user.id);
        if (!userHasPermission(permissions, SUPER_ADMIN_PERMISSION)) {
          throw AppError.forbidden("Administrator access was not granted", { code: "ADMIN_ONLY" });
        }
      }

      if (presentedTokenHash) await store.revokeSession(presentedTokenHash);
      const ttlSeconds = remember ? rememberTtlSeconds : config.sessionTtlSeconds;
      const { token, session } = await allocateSession(store, { userId: user.id, ttlSeconds, deviceLabel: clientLabel });

      if (loginGuard) loginGuard.clear(guardKeys);
      if (inspection.needsRehash) {
        try {
          await store.updatePasswordHash(user.id, await hashPassword(password, { minLength: config.passwordMinLength }));
          await audit(store, {
            actorId: user.id,
            action: "identity.password.rehashed",
            entityType: "identity",
            entityId: user.id,
            details: { reason: inspection.reason },
          });
        } catch (error) {
          // A failed re-hash must never break a valid sign-in; it is logged by the
          // caller through the audit-failure channel and retried on next login.
          session.rehashFailed = true;
          session.rehashError = error?.code || "REHASH_FAILED";
        }
      }
      await store.updateUser?.(user.id, { lastLoginAt: new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "") });
      await audit(store, { actorId: user.id, action: "identity.login.succeeded", entityType: "identity", entityId: user.id, details: { remember: Boolean(remember), admin: Boolean(admin) } });

      return {
        user: publicUser(session.user),
        permissions: session.permissions,
        csrfToken: csrfTokenForSession(token, config.sessionSecret),
        token,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        rehashFailed: Boolean(session.rehashFailed),
      };
    },

    async register({ username, email, password, passwordConfirm, termsAccepted, displayName = null, clientIp = "unknown" }) {
      if (password !== passwordConfirm) {
        throw AppError.badRequest("The two new passwords do not match", { code: "PASSWORD_MISMATCH" });
      }
      if (!termsAccepted) {
        throw AppError.badRequest("Please accept the Terms and Privacy Policy to create an account", { code: "TERMS_NOT_ACCEPTED" });
      }
      if (await store.usernameTaken(username)) {
        throw AppError.conflict("That username is already taken. Try a different one.", { code: "USERNAME_TAKEN" });
      }
      if (await store.emailTaken(email)) {
        throw AppError.conflict("An account with that email already exists. Sign in instead.", { code: "EMAIL_TAKEN" });
      }
      const passwordHash = await hashPassword(password, { minLength: config.passwordMinLength });
      const created = await store.createUser({ username, email, passwordHash, displayName: displayName || username, status: "active" });
      const role = await store.ensureRole(MEMBER_ROLE, "Platform member");
      for (const permissionKey of MEMBER_PERMISSIONS) {
        const permission = await store.ensurePermission(permissionKey, permissionKey);
        await store.grantRolePermission(role.id, permission.id);
      }
      await store.assignRole(created.id, role.id);
      await audit(store, {
        actorId: created.id,
        action: "identity.user.registered",
        entityType: "identity",
        entityId: created.id,
        details: { role: MEMBER_ROLE },
      });

      const { token, session } = await allocateSession(store, { userId: created.id, ttlSeconds: config.sessionTtlSeconds, deviceLabel: `registration:${clientIp}` });
      return {
        user: publicUser(session.user),
        permissions: session.permissions,
        csrfToken: csrfTokenForSession(token, config.sessionSecret),
        token,
      };
    },

    /**
     * The PHP application deliberately does not mint self-service reset tokens;
     * resets are issued by an administrator. That behaviour is preserved rather
     * than inventing a token flow, and the response is identical whether or not
     * the identifier exists.
     */
    async requestPasswordReset({ identifier, clientIp = "unknown" }) {
      const user = await store.findUserByIdentifier(normalize(identifier));
      await audit(store, {
        actorId: null,
        action: "identity.password.reset-requested",
        entityType: "identity",
        details: { known: Boolean(user), identifierHash: hashSessionToken(normalize(identifier)) },
      });
      return {
        delivered: false,
        notice: "Password resets are issued by an administrator. Contact support or your platform admin — this form does not create a reset link.",
      };
    },

    async changePassword({ userId, currentPassword, newPassword, newPasswordConfirm, signOutOtherSessions = false, currentTokenHash = null }) {
      if (newPassword !== newPasswordConfirm) {
        throw AppError.badRequest("The two new passwords do not match", { code: "PASSWORD_MISMATCH" });
      }
      const stored = await store.findUserById(userId);
      if (!stored) throw AppError.unauthorized("The session is no longer valid", { code: "SESSION_INVALID" });
      const valid = await inspectPassword(currentPassword, stored.password_hash);
      if (!valid.valid) {
        throw AppError.badRequest("Your current password is not correct", { code: "CURRENT_PASSWORD_INVALID" });
      }
      const passwordHash = await hashPassword(newPassword, { minLength: config.passwordMinLength });
      await store.updatePasswordHash(userId, passwordHash);
      let revokedOthers = 0;
      if (signOutOtherSessions) revokedOthers = await store.revokeAllSessions(userId, currentTokenHash);
      await audit(store, { actorId: userId, action: "identity.user.password-changed", entityType: "identity", entityId: userId, details: { revokedOtherSessions: revokedOthers } });
      return { rotated: true, revokedOthers };
    },

    /**
     * Re-issues the acting session after a password change. The presented token is
     * revoked only once its replacement exists, so a successful change never leaves
     * the user signed out mid-request. A remembered (long) session returns to the
     * standard web TTL: re-entering the password should not preserve a 30-day cookie.
     */
    async rotateSession({ userId, currentTokenHash, deviceLabel = null }) {
      const { token, tokenHash, expiresAt } = await allocateSession(store, {
        userId,
        ttlSeconds: config.sessionTtlSeconds,
        deviceLabel: deviceLabel || "password-change",
      });
      await store.revokeSession(currentTokenHash);
      return { token, tokenHash, expiresAt, csrfToken: csrfTokenForSession(token, config.sessionSecret) };
    },

    async updateUsername({ userId, username, displayName = null }) {
      if (await store.usernameTaken(username, userId)) {
        throw AppError.conflict("That username is already in use by another account.", { code: "USERNAME_TAKEN" });
      }
      const updated = await store.updateUser(userId, { username, displayName: displayName || username });
      await audit(store, { actorId: userId, action: "identity.user.username-changed", entityType: "identity", entityId: userId, details: {} });
      return { user: publicUser({ ...updated, profileImage: null }), usernameRotated: true };
    },

    async updateEmail({ userId, email }) {
      if (await store.emailTaken(email, userId)) {
        throw AppError.conflict("That email address is already attached to another account.", { code: "EMAIL_TAKEN" });
      }
      await store.updateUser(userId, { email });
      await audit(store, { actorId: userId, action: "identity.user.email-changed", entityType: "identity", entityId: userId, details: {} });
      return { email };
    },

    async updateProfile({ userId, displayName }) {
      await store.updateUser(userId, { displayName });
      await audit(store, { actorId: userId, action: "identity.user.profile-updated", entityType: "identity", entityId: userId, details: {} });
      return { displayName };
    },

    async accountSnapshot(user) {
      const roles = store.rolesForUser ? await store.rolesForUser(user.id) : [];
      const sessions = await store.listSessions(user.id);
      return { user: publicUser(user), roles, sessions: sessions.map((session) => ({ ...session, current: false })) };
    },

    async adminCreateUser({ actorId, email, displayName, password, role, username = null }) {
      if (!ADMIN_ROLES.includes(role)) {
        throw AppError.badRequest("Choose a supported role", { code: "ROLE_UNSUPPORTED" });
      }
      if (await store.emailTaken(email)) throw AppError.conflict("That email address already exists.", { code: "EMAIL_TAKEN" });
      const passwordHash = await hashPassword(password, { minLength: config.adminPasswordMinLength });
      const candidateUsername = username || deriveUsernameFromEmail(email, displayName);
      const finalUsername = await resolveFreeUsername(store, candidateUsername);
      const created = await store.createUser({ username: finalUsername, email, passwordHash, displayName, status: "active" });
      const assignedRole = await store.ensureRole(role, role.replace(/_/g, " "));
      await store.assignRole(created.id, assignedRole.id);
      await audit(store, { actorId, action: "admin.user.created", entityType: "identity", entityId: created.id, details: { role } });
      return { id: created.id, username: created.username, email: created.email, status: created.status, role };
    },

    async adminSetStatus({ actorId, userId, status }) {
      if (Number(actorId) === Number(userId)) {
        throw AppError.badRequest("You cannot deactivate your own administrator account.", { code: "SELF_DEACTIVATION" });
      }
      const target = await store.findUserById(userId);
      if (!target) throw AppError.notFound("User not found.", { code: "USER_NOT_FOUND" });
      const active = status === "active";
      await store.setUserStatus(userId, active);
      if (!active) await store.revokeAllSessions(userId);
      await audit(store, { actorId, action: "admin.user.status-changed", entityType: "identity", entityId: userId, details: { active } });
      return { id: userId, status: active ? "active" : "disabled" };
    },
  };
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function deriveUsernameFromEmail(email, displayName) {
  const local = String(email).split("@")[0].replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 14);
  const seed = (local || "member").replace(/^[^a-z]+/, "u").slice(0, 20);
  const candidate = displayName ? seed : seed;
  return /^[a-z]/.test(candidate) ? candidate : `u${candidate}`.slice(0, 20);
}

async function resolveFreeUsername(store, candidate) {
  let attempt = candidate.slice(0, 20);
  if (!/^[a-z][a-z0-9_]{2,19}$/.test(attempt)) attempt = `member${Math.floor(Math.random() * 900) + 100}`.slice(0, 20);
  for (let suffix = 1; suffix < 400; suffix += 1) {
    const trimmed = attempt.slice(0, 20 - String(suffix).length);
    const candidateName = suffix === 1 ? attempt : `${trimmed}${suffix}`;
    if (/^[a-z][a-z0-9_]{2,19}$/.test(candidateName) && !(await store.usernameTaken(candidateName))) return candidateName;
  }
  throw new AppError(500, "USERNAME_EXHAUSTED", "A unique username could not be allocated");
}
