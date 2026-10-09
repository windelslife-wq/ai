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
  // public site (Phase 3): visitor contact intake
  "recordContactInquiry",
  "pageContactInquiries",
  // analysis (Phase 5): persisted intelligence runs
  "saveAnalysisRun",
  "listAnalysisRuns",
  "findAnalysisRun",
  "pruneAnalysisRuns",
  // operational
  "readiness",
]);

export const REPOSITORY_FIELDS = Object.freeze(["adapter", "capabilities"]);

/**
 * Validate a retention cutoff (risk R-27).
 *
 * `wf_analysis_runs.completed_at` is VARCHAR(32) holding an ISO-8601 UTC string,
 * and retention compares it as *text* — which is only chronological while every
 * writer uses one format. A `+00:00` offset string sorts after the `Z` form of the
 * same instant, so a mixed-format cutoff would silently delete the wrong rows;
 * migration `005_analysis_runs.sql` warns about exactly this. Both adapters refuse
 * anything that is not the canonical `…Z` form rather than guess, and both are
 * handed their cutoff through this one function so they cannot disagree about it.
 *
 * Lives here rather than in a module because it is a storage-layer invariant about
 * how a stored column may be compared, and `src/db/` must not import from
 * `src/modules/`.
 *
 * @param {string} value
 * @returns {string} the trimmed cutoff, safe to compare against `completed_at`.
 * @throws {TypeError} when the value is not an ISO-8601 UTC instant.
 */
export function assertIsoCutoff(value) {
  const cutoff = typeof value === "string" ? value.trim() : "";
  const canonical = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  if (!canonical.test(cutoff) || Number.isNaN(Date.parse(cutoff))) {
    throw new TypeError(`retention cutoff must be an ISO-8601 UTC string ending in "Z" (e.g. 2026-07-11T00:00:00.000Z), received ${JSON.stringify(value)}`);
  }
  return cutoff;
}

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
