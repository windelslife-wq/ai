# Phase 47 — Self-Service Password Reset Flow & Admin Control Center Language Registry Sync

**Date:** 2026-10-17 · **Rows closed:** Row 2 (Self-Service Password Reset Token Flow & Outbound SMTP Wiring) and Row 3 / Row 16 (`/app/admin` Language Registry Statistic Card & `MODULE_STATUS` Label Reconciliation).

---

## 1. Scope & Architecture

Phase 47 completes the two remaining in-code backlog items across `identity`, `admin`, and `platform/health`:

1. **Row 2 — Self-Service Password Reset Token Flow (`src/modules/identity/`, `client/src/{api.js,views.jsx}`):**
   - **Single-use, 15-minute expiring tokens (`mintPasswordResetToken`, `parsePasswordResetToken`, `PASSWORD_RESET_TTL_MS = 900_000`):**
     - Format: `<userId>.<expiresAtMs>.<jti>.<hmacBase64Url>`
     - Signed with `HMAC-SHA256(sessionSecret, "wf-password-reset:v1:<userId>:<expiresAtMs>:<jti>:<sha256(passwordHash)>")` and verified in constant time via `crypto.timingSafeEqual`.
     - **Single-use by cryptographic construction + bounded in-memory JTI set:** Updating `user.password_hash` immediately invalidates the HMAC signature on all outstanding tokens for that user (even across process restarts), while `consumedResetTokens` (`MAX_CONSUMED_RESET_TOKENS = 4096`) also tracks consumed `jti` values until expiry. Requires zero additional SQL tables or repository methods (`21` migrations, `81` tables, `250` repository contract methods unchanged).
   - **Outbound SMTP integration (`POST /api/v1/auth/password-reset-request`):**
     - When outbound SMTP is disabled (`VP_SMTP_ENABLED=0`, default host), preserves the exact legacy response (`delivered: false`, administrator-issued reset notice).
     - When outbound SMTP is enabled (`VP_SMTP_ENABLED=1`), mints a 15-minute single-use token for matching active accounts, sends the reset email via `mail.send`, audits `identity.password.reset-requested`, and returns a uniform enumeration-safe response for both known and unknown identifiers.
   - **Password reset confirmation (`POST /api/v1/auth/password-reset-confirm`):**
     - Rate-limited (`5` requests per `10` minutes per client address) and schema-validated (`PASSWORD_RESET_CONFIRM`).
     - Enforces password confirmation match (`PASSWORD_MISMATCH`), token expiry (`RESET_TOKEN_EXPIRED`), single-use signature/JTI validity (`RESET_TOKEN_INVALID`), role-appropriate minimum password length (`14` chars for `super_admin`, `12` chars for regular accounts), revokes all active sessions (`store.revokeAllSessions`), and records `identity.user.password-reset` (`legacyAction: "PASSWORD_CHANGED"`).
   - **Workspace Sign-In Console (`LoginPanel` in `client/src/views.jsx`):**
     - Adds an inline "Forgot password?" two-step flow on `/app/login` (the target of `/forgot-password`) wired to `endpoints.passwordResetRequest` and `endpoints.passwordResetConfirm`.

2. **Row 3 / Row 16 — Administrator Control Center Language Registry Card (`client/src/admin.js`, `client/src/views.jsx`) & `MODULE_STATUS` Label Sync (`src/modules/platform/health.js`):**
   - Wires the `Languages` KPI card on `/app/admin` (`ADMIN_STATS` and `ADMIN_READS` in `client/src/admin.js`, `AdminControlCentreView` in `client/src/views.jsx`) to `GET /api/v1/language-learning/languages` (`permission: "system.authenticated"`), displaying the authored language count (`20`) when loaded and `—` when unloaded.
   - Reconciles the `identity`, `publicSite`, and `risk` labels in `src/modules/platform/health.js` with Phases 44–47.

---

## 2. Verification

- `test/auth.test.js` — verifies disabled-SMTP notice, enabled-SMTP enumeration-safe reset token dispatch, expired token rejection (`RESET_TOKEN_EXPIRED`), valid token password update + session revocation, and single-use replay rejection (`RESET_TOKEN_INVALID`).
- `test/client_admin_console.test.js` — verifies `ADMIN_STATS`, `ADMIN_READS`, and `statCards` with the Language Learning registry endpoint.
- Release gates:
  - `npm --prefix apps/workforce-platform run verify:install`
  - `npm run check:workforce`
  - `npm run typecheck`
  - `npm run test:contracts`
