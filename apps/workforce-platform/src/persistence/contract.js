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
  // Strategy Lab (Phase 6/7): lifecycle records, persisted human sign-off, backtests, trade journal
  "saveStrategy",
  "recordStrategyHumanSignoff",
  "findStrategy",
  "listStrategies",
  "saveBacktest",
  "findBacktest",
  "listBacktests",
  "countStrategyBacktests",
  "latestStrategyBacktest",
  "saveJournalEntry",
  "listJournalEntries",
  // paper trading + persisted trading governance (Phase 7)
  "loadTradingState",
  "saveTradingState",
  "createPaperAccount",
  "savePaperAccount",
  "findPaperAccount",
  "listPaperAccounts",
  "markPaperAccountPeak",
  "savePaperOrder",
  "findPaperOrder",
  "listPaperOrders",
  "findOpenPaperOrder",
  "listAllPendingPaperOrders",
  "savePaperPosition",
  "findPaperPosition",
  "findOpenPaperPosition",
  "listPaperPositions",
  "savePaperTrade",
  "listPaperTrades",
  "savePaperDeployment",
  "findPaperDeployment",
  "listPaperDeployments",
  "listAllActivePaperDeployments",
  // paper-only human-reviewed execution proposals (Phase 8A)
  "findExecutionProposal",
  "listExecutionProposals",
  // Cross-owner READ for the scheduled expiry job (row 19). It is a separate method
  // rather than `listExecutionProposals(null)` on purpose: the owner-scoped one
  // binds `Number(ownerUserId)`, so a missing owner would match user 0 rather than
  // everyone, and widening it to mean "no filter" would turn one forgotten argument
  // at an HTTP call site into a platform-wide read. There is no matching all-owners
  // WRITE — expiry stays on the owner-bound transactional path.
  "listExecutionProposalsAllOwners",
  "withPaperTransaction",
  // operator notifications (row 5): unread-deduped alerts, broadcast or targeted
  "createNotification",
  "listNotifications",
  "markNotificationRead",
  "markAllNotificationsRead",
  "countUnreadNotifications",
  "hasUnreadNotificationDedupe",
  // scheduled-job coordination locks (row 19, migration 010). These are the only
  // cross-process primitive in the contract, and they write only to `wf_job_locks`.
  "findJobLock",
  "listJobLocks",
  "acquireJobLock",
  "releaseJobLock",
  "extendJobLock",
  // Persisted job state. Shares `wf_trading_state` with trading governance but is
  // confined to a non-`global` `state_key`, which is what lets a scheduled job
  // remember what it already alerted on without ever writing the kill switch.
  "loadJobState",
  "saveJobState",
  // ── Sports Intelligence data foundation (row 14, slice 2) ─────────────────
  //
  // Module-prefixed like every other name here, and deliberately so: this contract
  // is ONE flat namespace shared by every module, whereas legacy's `SportsRepository`
  // is a PHP interface whose methods are scoped by the interface itself. Legacy's
  // lottery repository declares `ensureProvider`, `saveHealth`, `latestHealth`,
  // `listHealth` and `deleteOldHealth` with exactly the same names as its sports one —
  // so porting row 15 would have overwritten row 14's methods in the spread that
  // composes the store, and the last module to load would silently win. Divergence
  // SP-18. `pruneSportsHealth` uses the platform's retention verb rather than
  // legacy's `delete`, so "what can be deleted" is findable under one prefix.
  //
  // Slice 5 (migration 014) adds the two names the comment below reserved —
  // `verifySportsResult` and `findSportsResultByMatch` — because attesting to a
  // result is exactly what slice 5 exists to do. Until slice 4, ingestion was the
  // only writer of `wf_sports_results`, and a writer that reported an outcome must
  // not also attest to it.
  "ensureSportsProvider",
  "listSportsProviders",
  "setSportsProviderEnabled",
  "saveSportsHealth",
  "latestSportsHealth",
  "listSportsHealth",
  "pruneSportsHealth",
  "findSportsMatchById",
  "listSportsMatches",
  "saveSportsMatch",
  "findSportsMatch",
  "saveSportsOdds",
  "latestSportsOdds",
  "listSportsOdds",
  "findSportsOddsBefore",
  "saveSportsResult",
  "findSportsResult",
  "verifySportsResult",
  "findSportsResultByMatch",
  "saveSportsQuality",
  "latestSportsQuality",
  "startSportsSync",
  "finishSportsSync",
  "listSportsSyncRuns",
  // ── Sports decision chain (row 14, slice 3, migration 012) ────────────────
  // Predictions are immutable: there is no update or delete name here, and the contract
  // test that counts names would notice one being added.
  "ensureSportsModelVersion",
  "listSportsModelVersions",
  "saveSportsPrediction",
  "findSportsPrediction",
  "listSportsPredictions",
  "saveSportsConfiguration",
  "activeSportsConfiguration",
  "listSportsConfigurations",
  "saveSportsCalibration",
  "findSportsCalibration",
  "listSportsCalibrations",
  "decideSportsCalibration",
  // ── Tickets and the daily ticket run (row 14, slice 4, migration 013) ─────
  // A ticket is decided once, by compare-and-set on PENDING_USER_APPROVAL. Nothing here can
  // place a bet or reach an execution, paper or broker row.
  "saveSportsTicket",
  "findSportsTicket",
  "listSportsTickets",
  "listSportsTicketSelections",
  "decideSportsTicket",
  "claimSportsDailyTicketRun",
  "finishSportsDailyTicketRun",
  "findSportsDailyTicketRun",
  "listSportsDailyTicketRuns",
  // ── Settlement and result verification (row 14, slice 5, migration 014) ────
  // Settlement writes ONLY the settlement columns. `updateSportsTicket` takes four
  // named fields rather than legacy's arbitrary patch, so it cannot reach
  // `approval_status` — the column a person's decision owns (slice 4). A selection
  // status can move once, PENDING → terminal; `result` mirrors it, as legacy writes it.
  "updateSportsTicket",
  "updateSportsTicketSelection",
  "recordSportsTicketOutcome",
  // A stuck run's claim is released, not edited: the row is deleted and its counters
  // are reported to the caller and audited, so the day and version can be re-run
  // (R-29). Only a RUNNING row can be removed; a finished run is evidence.
  "recoverSportsDailyTicketRuns",
  // ── Measured performance: outcomes, metrics and backtests (migration 014) ──
  // `listSportsPredictionOutcomes` is the read every measured number in this module
  // derives from: a prediction joined to a VERIFIED finished result, with the binary
  // outcome for its market. No legacy counterpart method exists to read results
  // without one — this closes it.
  "listSportsPredictionOutcomes",
  "listSportsSettledSelections",
  "saveSportsModelMetrics",
  "listSportsModelMetrics",
  // Storage for the point-in-time backtester's reports (legacy `sports_backtests`).
  "saveSportsBacktest",
  "findSportsBacktest",
  "listSportsBacktests",
  "saveSportsPerformanceSnapshot",
  "listSportsPerformanceSnapshots",
  // ── Lottery Intelligence data foundation (row 15, slice 1, migration 016) ──
  // The methods SP-18 predicted: legacy's lottery repository declares the very names
  // (`ensureProvider`, `saveHealth`, `latestHealth`, `listHealth`, `deleteOldHealth`)
  // that would have collided with the sports ones in one flat namespace. Every name
  // here is `Lottery`-prefixed, and `deleteOld*` keeps legacy's verb because the
  // retention decision it serves is this module's own cleanup job (slice 3), unlike
  // the sports foundation's shared retention read.
  "ensureLotteryGame",
  "listLotteryGames",
  "activeLotteryRules",
  "saveLotteryRules",
  "ensureLotteryProvider",
  "listLotteryProviders",
  "saveLotteryHealth",
  "latestLotteryHealth",
  "listLotteryHealth",
  "findLotteryDraw",
  "findLotteryDrawByExternal",
  "listLotteryDraws",
  "saveLotteryDraw",
  "listLotteryDrawNumbers",
  "saveLotteryDrawNumbers",
  "lotteryDrawsForStats",
  "countLotteryDraws",
  "startLotteryJobRun",
  "finishLotteryJobRun",
  "listLotteryJobRuns",
  "findLotteryJobRunByKey",
  "deleteOldLotteryJobRuns",
  "deleteOldLotteryHealth",
  // ── Lottery combination intelligence (row 15, slice 2, migration 017) ──
  // Generated combination lines (spec §14/§16) and their AI decision reports
  // (spec §26/§33), exactly legacy's Persistence interface block: the save
  // methods return {row, created} with the JSON columns decoded on read.
  "saveLotteryCombination",
  "findLotteryCombination",
  "listLotteryCombinations",
  "saveLotteryAiDecision",
  "findLotteryAiDecision",
  "listLotteryAiDecisions",
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
 * Validate a job-lock instant (row 19, migration `010_job_locks.sql`).
 *
 * The same hazard as `assertIsoCutoff`, with a worse failure mode. A lock's
 * `expires_at` is VARCHAR(32) and is compared as *text* — `expires_at <= now` —
 * which is only chronological while every writer uses one fixed-width canonical
 * form. A `+00:00` offset string sorts **after** the `Z` form of the same instant,
 * so a mixed-format lock would be read as still live after it had expired: two cron
 * runs would overlap and both believe they are alone, which is the precise failure
 * the lock exists to prevent. Both adapters are handed their instants through this
 * one function so they cannot disagree, and an offset is refused rather than
 * silently converted (the reasoning behind divergence AV-2 in
 * `docs/migration/PHASE10_AUDIT_BROWSER.md`).
 *
 * @param {string} value
 * @returns {string} the trimmed instant, safe to compare against `expires_at`.
 * @throws {TypeError} when the value is not a canonical ISO-8601 UTC instant.
 */
export function assertJobLockInstant(value, label = "instant") {
  const instant = typeof value === "string" ? value.trim() : "";
  const canonical = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  if (!canonical.test(instant) || Number.isNaN(Date.parse(instant))) {
    throw new TypeError(`${label} must be an ISO-8601 UTC string ending in "Z" (e.g. 2026-10-11T00:00:00.000Z), received ${JSON.stringify(value)}`);
  }
  return instant;
}

/**
 * Validate a job-lock name.
 *
 * A job name is a coordination identifier chosen in code, never user input, so it
 * is restricted to a lowercase dotted/dashed vocabulary. Bounding it here rather
 * than at the CLI keeps the two adapters from disagreeing about what a legal name
 * is, and means a name too long for the VARCHAR(64) primary key is refused with a
 * readable message instead of a truncation warning from MySQL.
 *
 * @throws {TypeError} when the name is not a legal job identifier.
 */
export function assertJobName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(name)) {
    throw new TypeError(`job name must be 1-64 characters of [a-z0-9._-] starting with a letter, received ${JSON.stringify(String(value).slice(0, 80))}`);
  }
  return name;
}

/**
 * Validate a lock holder token.
 *
 * The holder is what makes a release safe: `DELETE … WHERE holder = ?` can only ever
 * remove the caller's own lock, so a process whose lock expired and was taken over
 * cannot delete the new holder's row on its way out. That only holds if the token is
 * unique per run, which is the caller's job (`<pid>@<host>#<nonce>`); this bounds it
 * to the VARCHAR(120) column and refuses an empty token, which would match nothing
 * and silently make every release a no-op.
 *
 * @throws {TypeError} when the holder is empty or too long for the column.
 */
export function assertJobLockHolder(value) {
  const holder = typeof value === "string" ? value.trim() : "";
  if (holder === "" || holder.length > 120) {
    throw new TypeError(`lock holder must be a non-empty string of at most 120 characters, received ${JSON.stringify(String(value).slice(0, 140))}`);
  }
  return holder;
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
