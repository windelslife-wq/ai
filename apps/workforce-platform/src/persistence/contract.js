/**
 * The storage contract every adapter must satisfy.
 *
 * Routes and services talk to exactly this surface — never to an adapter-specific
 * helper — which is what lets the MySQL and file adapters be swapped by
 * configuration alone. The list is enforced at start-up by
 * `assertRepositoryContract`, so an adapter that gains or loses a method fails at
 * boot with a readable message instead of returning 500 on the first request that
 * needs it.
 *
 * `test/platform_findings.test.js` asserts that both shipped adapters satisfy it.
 */

export const REPOSITORY_METHODS = Object.freeze([
  // identity
  "findUserByIdentifier",
  "findUserById",
  "createUser",
  "updateUser",
  "setUserStatus",
  "updatePasswordHash",
  "usernameTaken",
  "emailTaken",
  // sessions
  "createSession",
  "findSession",
  "revokeSession",
  "revokeAllSessions",
  "listSessions",
  "updateSessionExpiry",
  // roles and permissions
  "listRoles",
  "listPermissions",
  "ensureRole",
  "ensurePermission",
  "grantRolePermission",
  "assignRole",
  "setRoles",
  "permissionsForUser",
  "rolesForUser",
  // administration listings
  "listUsers",
  "pageUsers",
  // audit and profile files
  "recordAudit",
  "listAuditEvents",
  "setAvatarPath",
  "findAvatarPath",
  // operational
  "readiness",
]);

export const REPOSITORY_FIELDS = Object.freeze(["adapter", "capabilities"]);

/**
 * @throws {Error} naming the adapter and every missing member.
 */
export function assertRepositoryContract(store, { adapter = "unknown", methods = REPOSITORY_METHODS, fields = REPOSITORY_FIELDS } = {}) {
  if (!store || typeof store !== "object") throw new Error(`The ${adapter} storage adapter did not produce a store object`);
  const missingMethods = methods.filter((name) => typeof store[name] !== "function");
  const missingFields = fields.filter((name) => store[name] === undefined || store[name] === null);
  if (missingMethods.length || missingFields.length) {
    const parts = [];
    if (missingMethods.length) parts.push(`methods: ${missingMethods.join(", ")}`);
    if (missingFields.length) parts.push(`fields: ${missingFields.join(", ")}`);
    throw new Error(`The ${adapter} storage adapter does not implement the repository contract (${parts.join("; ")})`);
  }
  return store;
}
