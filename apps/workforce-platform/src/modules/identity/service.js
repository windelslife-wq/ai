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

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../../http/errors.js";
import { hashPassword, inspectPassword } from "../../security/passwords.js";
import { csrfTokenForSession, hashSessionToken, newSessionToken } from "../../security/session.js";
import { ADMIN_ROLES } from "./contracts.js";

export const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;
const MAX_CONSUMED_RESET_TOKENS = 4096;

function resetTokenMac(sessionSecret, { userId, expiresAtMs, jti, passwordHash }) {
  return createHmac("sha256", String(sessionSecret))
    .update(`wf-password-reset:v1:${userId}:${expiresAtMs}:${jti}:${hashSessionToken(String(passwordHash ?? ""))}`)
    .digest("base64url");
}

/**
 * Mints a single-use, 15-minute password reset token cryptographically bound to
 * `(userId, expiresAtMs, jti, sha256(passwordHash))`. Once the password hash is
 * updated, any outstanding reset token for that account automatically fails HMAC
 * verification even across process restarts.
 */
export function mintPasswordResetToken({ userId, passwordHash, sessionSecret, nowMs = Date.now(), ttlMs = PASSWORD_RESET_TTL_MS }) {
  const expiresAtMs = Math.trunc(nowMs + ttlMs);
  const jti = randomBytes(16).toString("base64url");
  const sig = resetTokenMac(sessionSecret, { userId, expiresAtMs, jti, passwordHash });
  return {
    token: `${userId}.${expiresAtMs}.${jti}.${sig}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
    jti,
  };
}

export function parsePasswordResetToken(token) {
  const parts = String(token ?? "").trim().split(".");
  if (parts.length !== 4) return null;
  const userId = Number(parts[0]);
  const expiresAtMs = Number(parts[1]);
  const jti = parts[2];
  const sig = parts[3];
  if (!Number.isSafeInteger(userId) || userId < 1) return null;
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 1) return null;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(jti) || !/^[A-Za-z0-9_-]{32,128}$/.test(sig)) return null;
  return { userId, expiresAtMs, jti, sig };
}

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
  "identity.user.password-reset": "PASSWORD_CHANGED",
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

export function createIdentityService({ store, config, loginGuard = null, mail = null, now = () => Date.now() }) {
  const rememberTtlSeconds = Math.min(Math.max(config.rememberSessionTtlSeconds ?? 30 * 24 * 60 * 60, config.sessionTtlSeconds), 30 * 24 * 60 * 60);
  const consumedResetTokens = new Map();

  function pruneConsumedTokens(nowMs) {
    for (const [jti, expiresAtMs] of consumedResetTokens) {
      if (expiresAtMs <= nowMs) consumedResetTokens.delete(jti);
    }
    while (consumedResetTokens.size > MAX_CONSUMED_RESET_TOKENS) {
      const oldest = consumedResetTokens.keys().next().value;
      if (oldest === undefined) break;
      consumedResetTokens.delete(oldest);
    }
  }

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
     * Self-service password reset request (Row 2 — Phase 47).
     *
     * When outbound SMTP is disabled (default host), preserves legacy's honest
     * `delivered: false` notice. When SMTP is enabled (`VP_SMTP_ENABLED=1`), mints
     * a single-use 15-minute HMAC token bound to `(userId, expiresAtMs, jti, sha256(passwordHash))`
     * and dispatches it to the account's email address, returning a uniform
     * enumeration-safe response regardless of whether the identifier matched.
     */
    async requestPasswordReset({ identifier, clientIp = "unknown" }) {
      const normalized = normalize(identifier);
      const user = await store.findUserByIdentifier(normalized);
      const smtpEnabled = Boolean(mail?.enabled?.());

      if (!smtpEnabled) {
        await audit(store, {
          actorId: null,
          action: "identity.password.reset-requested",
          entityType: "identity",
          details: { known: Boolean(user), smtpEnabled: false, delivered: false, identifierHash: hashSessionToken(normalized) },
        });
        return {
          delivered: false,
          notice: "Password resets are issued by an administrator. Contact support or your platform admin — this form does not create a reset link.",
        };
      }

      let delivered = true;
      if (user && user.status === "active" && user.email) {
        const nowMs = now();
        const minted = mintPasswordResetToken({
          userId: user.id,
          passwordHash: user.password_hash,
          sessionSecret: config.sessionSecret,
          nowMs,
        });
        const baseUrl = String(config.site?.publicBaseUrl || "").replace(/\/+$/, "");
        const resetUrl = baseUrl
          ? `${baseUrl}/app/forgot-password?token=${encodeURIComponent(minted.token)}`
          : `/app/forgot-password?token=${encodeURIComponent(minted.token)}`;
        const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#0f172a">`
          + `<h2 style="color:#2563eb;margin:0 0 8px">WINDELS AI WORKFORCE — password reset</h2>`
          + `<p>A password reset was requested for your account (<strong>${String(user.username || "")}</strong>).</p>`
          + `<p>Use the single-use reset token below within 15 minutes (expires at ${minted.expiresAt}):</p>`
          + `<pre style="background:#f1f5f9;padding:12px;border-radius:6px;word-break:break-all">${minted.token}</pre>`
          + `<p>Reset path: <code>${resetUrl}</code></p>`
          + `<p style="color:#64748b;font-size:12px">If you did not request this reset, you can safely ignore this message.</p>`
          + `</div>`;
        const text = `WINDELS AI WORKFORCE — password reset\n\n`
          + `A password reset was requested for your account (${user.username}).\n`
          + `Single-use token (valid for 15 minutes, until ${minted.expiresAt}):\n${minted.token}\n\n`
          + `Reset path: ${resetUrl}\n`;
        const sendResult = await mail.send({
          to: user.email,
          subject: "WINDELS AI WORKFORCE — password reset",
          html,
          text,
        });
        delivered = Boolean(sendResult?.ok);
      }

      await audit(store, {
        actorId: null,
        action: "identity.password.reset-requested",
        entityType: "identity",
        details: { known: Boolean(user), smtpEnabled: true, delivered, identifierHash: hashSessionToken(normalized) },
      });

      return {
        delivered,
        notice: delivered
          ? "If an active account matches that identifier, a single-use 15-minute password reset token has been sent via SMTP."
          : "Outbound email could not deliver the password reset message. Contact support or your platform administrator.",
      };
    },

    /**
     * Completes a password reset using a single-use, 15-minute reset token.
     * Updating the password hash immediately invalidates the token signature,
     * and all existing sessions for the account are revoked.
     */
    async confirmPasswordReset({ token, newPassword, newPasswordConfirm }) {
      if (newPassword !== newPasswordConfirm) {
        throw AppError.badRequest("The two new passwords do not match", { code: "PASSWORD_MISMATCH" });
      }
      const parsed = parsePasswordResetToken(token);
      if (!parsed) {
        throw AppError.badRequest("The password reset token is invalid or has already been used", { code: "RESET_TOKEN_INVALID" });
      }
      const nowMs = now();
      pruneConsumedTokens(nowMs);
      if (nowMs > parsed.expiresAtMs) {
        throw AppError.badRequest("The password reset token has expired", { code: "RESET_TOKEN_EXPIRED" });
      }
      if (consumedResetTokens.has(parsed.jti)) {
        throw AppError.badRequest("The password reset token is invalid or has already been used", { code: "RESET_TOKEN_INVALID" });
      }
      const user = await store.findUserById(parsed.userId);
      if (!user || user.status !== "active") {
        throw AppError.badRequest("The password reset token is invalid or has already been used", { code: "RESET_TOKEN_INVALID" });
      }
      const expectedSig = resetTokenMac(config.sessionSecret, {
        userId: user.id,
        expiresAtMs: parsed.expiresAtMs,
        jti: parsed.jti,
        passwordHash: user.password_hash,
      });
      const expectedBuf = Buffer.from(expectedSig, "utf8");
      const actualBuf = Buffer.from(parsed.sig, "utf8");
      if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
        throw AppError.badRequest("The password reset token is invalid or has already been used", { code: "RESET_TOKEN_INVALID" });
      }
      const permissions = store.permissionsForUser ? await store.permissionsForUser(user.id) : [];
      const isSuperAdmin = userHasPermission(permissions, SUPER_ADMIN_PERMISSION);
      const minLength = isSuperAdmin ? (config.adminPasswordMinLength ?? 14) : (config.passwordMinLength ?? 12);
      const passwordHash = await hashPassword(newPassword, { minLength });
      consumedResetTokens.set(parsed.jti, parsed.expiresAtMs);
      await store.updatePasswordHash(user.id, passwordHash);
      const revokedSessions = await store.revokeAllSessions(user.id);
      await audit(store, {
        actorId: user.id,
        action: "identity.user.password-reset",
        entityType: "identity",
        entityId: user.id,
        details: { revokedOtherSessions: revokedSessions },
      });
      return { reset: true, revokedSessions };
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
