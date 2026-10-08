/**
 * Identity, account and user-administration endpoints.
 *
 * The path surface mirrors the legacy PHP routes (`/login`, `/register`,
 * `/account/*`, `/admin/users*`) under the versioned JSON API; route-by-route
 * parity is recorded in `docs/migration/PARITY_IDENTITY.md`.
 *
 * Route options are declarative and enforced by the HTTP layer before the
 * handler runs: `bodySchema`, `querySchema`, `paramsSchema`, `preHandler`,
 * `config.rateLimit`, `config.multipart`. Handlers therefore receive already
 * validated, trimmed, type-checked input on `request.body/query/params`.
 */

import path from "node:path";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { AppError } from "../../http/errors.js";
import { expiredSessionCookie, hashSessionToken, readSessionCookie, sessionCookie } from "../../security/session.js";
import { removeAvatarFile, storeAvatarFile, validateImageUpload } from "../../security/uploads.js";
import { createAuthenticator, requireCsrf, requirePermission, SAFE_METHODS } from "../platform/guards.js";
import { createIdentityService, publicUser, SUPER_ADMIN_PERMISSION } from "./service.js";
import * as contracts from "./contracts.js";

const OBJECT = (schema) => ({ type: "object", additionalProperties: false, ...schema });

function withSessionCookie(reply, config, token, expiresAt) {
  const maxAge = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
  reply.header("set-cookie", sessionCookie(config.cookieName, token, { maxAge, secure: config.secureCookie }));
}

export function identityRoutes(app, { store, config, loginGuard }) {
  const service = createIdentityService({ store, config, loginGuard });
  const authenticate = createAuthenticator({ store, config });
  const csrf = requireCsrf(config);
  /**
   * Authentication, then the permission check, then CSRF on unsafe methods (the
   * permission guard runs `requireCsrf` itself). Declaring `authenticate` here as
   * well is not decoration: `requirePermission` reads `request.auth`, which only the
   * authenticator fills in, so a route that listed the permission guard alone would
   * deny every caller with 401. The permission is attached to the guard so
   * `/system/routes` can report what each route enforces.
   */
  const guarded = (permission) => {
    const check = requirePermission(permission, config);
    check.permission = permission;
    return [authenticate, check];
  };

  // ---- sign in / out ------------------------------------------------------
  app.post("/auth/login", {
    bodySchema: OBJECT(contracts.LOGIN),
    config: { rateLimit: { max: config.rateLimit.login.max, windowMs: config.rateLimit.login.windowMs } },
  }, async (request, reply) => {
    const presented = readSessionCookie(request.headers.cookie, config.cookieName);
    const result = await service.signIn({
      ...request.body,
      clientIp: request.clientAddress,
      presentedTokenHash: presented ? hashSessionToken(presented) : null,
    });
    withSessionCookie(reply, config, result.token, result.expiresAt);
    return { user: result.user, permissions: result.permissions, csrfToken: result.csrfToken, expiresAt: result.expiresAt };
  });

  app.post("/auth/register", {
    bodySchema: OBJECT(contracts.REGISTER),
    config: { rateLimit: { max: 5, windowMs: 600_000 } },
  }, async (request, reply) => {
    const result = await service.register({ ...request.body, clientIp: request.clientAddress });
    withSessionCookie(reply, config, result.token, new Date(Date.now() + config.sessionTtlSeconds * 1000).toISOString());
    return { user: result.user, permissions: result.permissions, csrfToken: result.csrfToken, signIn: "established" };
  });

  /**
   * Legacy-compatible: the PHP form never mints a reset token, so neither does
   * this one. The response is identical for known and unknown identifiers.
   */
  app.post("/auth/password-reset-request", {
    bodySchema: OBJECT(contracts.PASSWORD_RESET_REQUEST),
    config: { rateLimit: { max: 5, windowMs: 600_000 } },
  }, async (request) => service.requestPasswordReset({ ...request.body, clientIp: request.clientAddress }));

  app.get("/auth/csrf", { preHandler: [authenticate] }, async (request) => ({ csrfToken: request.auth.csrfToken }));

  app.get("/auth/me", { preHandler: [authenticate] }, async (request) => ({
    user: publicUser(request.auth.user),
    permissions: request.auth.permissions,
    via: request.auth.via,
    ...(request.auth.via === "bearer" ? {} : { csrfToken: request.auth.csrfToken }),
  }));

  app.post("/auth/logout", { preHandler: [authenticate, csrf] }, async (request, reply) => {
    await store.revokeSession(request.auth.tokenHash);
    await store.recordAudit({
      actorId: request.auth.user.id,
      action: "identity.logout",
      entityType: "identity",
      entityId: request.auth.user.id,
      details: { via: request.auth.via },
    });
    reply.header("set-cookie", expiredSessionCookie(config.cookieName, { secure: config.secureCookie }));
    return { ok: true };
  });

  /**
   * Native shell handshake: the same server-side session, returned once as a
   * bearer token with an explicit expiry so the client can store it in
   * Keychain/Keystore. Revocation happens through /auth/logout or an admin.
   */
  app.post("/auth/device-session", {
    preHandler: [authenticate, csrf],
    bodySchema: OBJECT({ type: "object", properties: { label: { type: "string", maxLength: 120 } } }),
  }, async (request) => {
    const ttlSeconds = Math.min(config.sessionTtlSeconds * 4, 30 * 24 * 60 * 60);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await store.updateSessionExpiry(request.auth.tokenHash, expiresAt, request.body?.label ?? "native");
    return {
      token: request.auth.token,
      expiresAt: expiresAt.toISOString(),
      permissions: request.auth.permissions,
      storageGuidance: {
        ios: "Keychain, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly",
        android: "Android Keystore backed EncryptedSharedPreferences",
        never: ["localStorage", "sessionStorage", "window.name"],
      },
    };
  });

  // ---- account self-service ------------------------------------------------
  app.get("/account", { preHandler: [authenticate] }, async (request) => {
    const snapshot = await service.accountSnapshot(request.auth.user);
    return {
      ...snapshot,
      sessions: snapshot.sessions.map((session) => ({ ...session, current: request.auth.tokenHash.startsWith(session.id) })),
    };
  });

  app.patch("/account/username", { preHandler: [authenticate, csrf], bodySchema: OBJECT(contracts.UPDATE_USERNAME) }, async (request) =>
    service.updateUsername({ userId: request.auth.user.id, ...request.body }),
  );

  app.patch("/account/email", { preHandler: [authenticate, csrf], bodySchema: OBJECT(contracts.UPDATE_EMAIL) }, async (request) =>
    service.updateEmail({ userId: request.auth.user.id, ...request.body }),
  );

  app.put("/account/profile", { preHandler: [authenticate, csrf], bodySchema: OBJECT(contracts.UPDATE_PROFILE) }, async (request) =>
    service.updateProfile({ userId: request.auth.user.id, ...request.body }),
  );

  app.put("/account/password", {
    preHandler: [authenticate, csrf],
    bodySchema: OBJECT(contracts.CHANGE_PASSWORD),
    config: { rateLimit: { max: 5, windowMs: 300_000 } },
  }, async (request, reply) => {
    const result = await service.changePassword({
      userId: request.auth.user.id,
      currentTokenHash: request.auth.tokenHash,
      ...request.body,
    });
    // `rotated` is a promise the transport keeps: the presented cookie is revoked
    // and replaced in the same response, so the old token is useless from here on.
    const rotated = await service.rotateSession({ userId: request.auth.user.id, currentTokenHash: request.auth.tokenHash });
    withSessionCookie(reply, config, rotated.token, rotated.expiresAt);
    return { ...result, csrfToken: rotated.csrfToken, expiresAt: rotated.expiresAt.toISOString() };
  });

  app.get("/account/sessions", { preHandler: [authenticate] }, async (request) => {
    const sessions = await store.listSessions(request.auth.user.id);
    return {
      sessions: sessions.map((session) => ({ ...session, current: request.auth.tokenHash.startsWith(session.id) })),
      total: sessions.length,
    };
  });

  app.delete("/account/sessions", { preHandler: [authenticate, csrf] }, async (request) => {
    const revoked = await store.revokeAllSessions(request.auth.user.id, request.auth.tokenHash);
    await store.recordAudit({
      actorId: request.auth.user.id,
      action: "identity.sessions.revoked-others",
      entityType: "identity",
      entityId: request.auth.user.id,
      details: { revoked },
    });
    return { revoked };
  });

  app.get("/account/activity", { preHandler: [authenticate], querySchema: contracts.ACTIVITY_QUERY }, async (request) => {
    const result = await store.listAuditEvents({ userId: request.auth.user.id, ...request.query });
    return { events: result.events, meta: { total: result.total, limit: request.query.limit, offset: request.query.offset } };
  });

  // ---- avatar upload / download / removal -----------------------------------
  app.post("/account/avatar", {
    preHandler: [authenticate, csrf],
    config: { rateLimit: { max: 10, windowMs: 600_000 }, multipart: true },
  }, async (request, reply) => {
    if (!config.uploads.enabled) {
      throw AppError.unavailable("Profile image storage is not enabled on this host", { code: "UPLOADS_DISABLED", retryAfter: 3600 });
    }
    const file = request.upload?.file;
    if (!file?.data?.length) throw AppError.badRequest("Choose an image to upload", { code: "NO_FILE" });
    if (file.data.length > config.uploads.maxBytes) {
      throw AppError.tooLarge(`Profile image must be ${Math.floor(config.uploads.maxBytes / 1024 / 1024)} MB or smaller`);
    }
    // Content sniffing decides the type; the client's filename and MIME never do.
    // `validateImageUpload` also refuses an absurd resolution, so a small file
    // cannot become a decompression bomb on the next avatar render.
    const verdict = validateImageUpload({ data: file.data }, { maxBytes: config.uploads.maxBytes });
    if (!verdict.ok) throw AppError.unprocessable(verdict.message, { code: verdict.code });
    const inspected = verdict.file;

    const previous = await store.findAvatarPath(request.auth.user.id);
    const stored = await storeAvatarFile({ uploadsDir: config.uploads.dir, userId: request.auth.user.id, extension: inspected.ext, data: file.data });
    const avatarUrl = `${config.uploads.publicPathPrefix}/${stored.fileName}`;
    await store.setAvatarPath(request.auth.user.id, avatarUrl);
    const previousName = previous ? path.basename(String(previous)) : null;
    if (previousName && previousName !== stored.fileName) await removeAvatarFile(config.uploads.dir, previousName);
    await store.recordAudit({
      actorId: request.auth.user.id,
      action: "identity.user.avatar-updated",
      entityType: "identity",
      entityId: request.auth.user.id,
      details: { bytes: file.data.length, kind: inspected.ext },
    });
    return reply.code(201).send({ avatarUrl, contentType: inspected.mime, bytes: file.data.length });
  });

  app.delete("/account/avatar", { preHandler: [authenticate, csrf] }, async (request) => {
    const previous = await store.findAvatarPath(request.auth.user.id);
    if (previous) await removeAvatarFile(config.uploads.dir, path.basename(String(previous)));
    await store.setAvatarPath(request.auth.user.id, null);
    await store.recordAudit({ actorId: request.auth.user.id, action: "identity.user.avatar-removed", entityType: "identity", entityId: request.auth.user.id, details: {} });
    return { avatarUrl: null };
  });

  /**
   * Authorized avatar delivery. Uploads live outside the static root, so this
   * route — owner or super administrator only — is the only read path.
   */
  app.get("/files/avatars/:fileId", {
    preHandler: [authenticate],
    paramsSchema: contracts.AVATAR_FILE_PARAM,
  }, async (request, reply) => {
    const fileId = request.params.fileId;
    const ownerId = Number(/^u([1-9]\d*)_/.exec(fileId)?.[1]);
    const isOwner = Number.isSafeInteger(ownerId) && Number(request.auth.user.id) === ownerId;
    if (!isOwner && !request.auth.permissions.includes(SUPER_ADMIN_PERMISSION)) {
      throw AppError.forbidden("You may only read your own profile image", { code: "NOT_OWNER" });
    }
    const current = await store.findAvatarPath(isOwner ? request.auth.user.id : ownerId);
    if (isOwner && current && path.basename(String(current)) !== fileId) {
      throw AppError.notFound("That profile image is no longer available");
    }
    const filePath = path.resolve(config.uploads.dir, fileId);
    const details = await stat(filePath).catch(() => null);
    if (!details?.isFile()) throw AppError.notFound("That profile image is no longer available");
    const extension = path.extname(fileId).slice(1).toLowerCase();
    reply.code(200);
    reply.header("content-type", extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension}`);
    reply.header("content-length", String(details.size));
    reply.header("cache-control", `private, max-age=${config.uploads.cacheSeconds}`);
    return reply.stream(createReadStream(filePath));
  });

  // ---- administration --------------------------------------------------------
  app.get("/admin/users", { preHandler: [guarded("identity.users.view")], querySchema: contracts.LIST_USERS_QUERY }, async (request) => {
    const result = await store.pageUsers(request.query);
    return {
      users: result.users,
      meta: { total: result.total, limit: request.query.limit, offset: request.query.offset, sort: request.query.sort, direction: request.query.direction },
    };
  });

  app.post("/admin/users", { preHandler: [guarded("identity.users.manage")], bodySchema: OBJECT(contracts.ADMIN_CREATE_USER) }, async (request, reply) =>
    reply.code(201).send(await service.adminCreateUser({ actorId: request.auth.user.id, ...request.body })),
  );

  app.patch("/admin/users/:userId/status", {
    preHandler: [guarded("identity.users.manage")],
    paramsSchema: contracts.USER_ID_PARAM,
    bodySchema: OBJECT(contracts.USER_STATUS_UPDATE),
  }, async (request) => service.adminSetStatus({
    actorId: request.auth.user.id,
    userId: request.params.userId,
    status: request.body.status,
  }));

  app.get("/admin/roles", { preHandler: [guarded("identity.users.view")] }, async () => {
    const roles = await store.listRoles();
    const permissions = await store.listPermissions();
    return {
      roles: roles.map((role) => ({ id: role.id, key: role.role_key, displayName: role.display_name })),
      permissions: permissions.map((permission) => ({ id: permission.id, key: permission.permission_key, displayName: permission.display_name })),
      assignable: contracts.ADMIN_ROLES,
    };
  });
}
