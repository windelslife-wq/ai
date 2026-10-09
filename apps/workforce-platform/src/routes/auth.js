/**
 * Compatibility shim (temporary, documented).
 *
 * The identity endpoints moved to `src/modules/identity/` when the platform grew
 * beyond a single auth slice. Anything still importing this path keeps working;
 * new code must import the module directly. Remove once no consumer remains.
 */

export { identityRoutes as authRoutes } from "../modules/identity/routes.js";
export { createAuthenticator as requireAuth, requireCsrf, requirePermission } from "../modules/platform/guards.js";
