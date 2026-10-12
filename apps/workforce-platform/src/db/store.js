import { createHash } from "node:crypto";
import { createAccountRepository } from "./account-repository.js";
import { createAnalysisRepository } from "./analysis-repository.js";
import { createSiteRepository } from "./site-repository.js";
import { createStrategyRepository } from "./strategy-repository.js";
import { createPaperRepository } from "./paper-repository.js";
import { createExecutionRepository } from "./execution-repository.js";
import { createNotificationRepository } from "./notification-repository.js";
import { createJobRepository } from "./job-repository.js";
import { createSportsRepository } from "./sports-repository.js";
import { createLotteryRepository } from "./lottery-repository.js";

export const REQUIRED_MIGRATIONS = Object.freeze([
  "001_platform_foundation",
  "002_identity_import_fields",
  "003_account_management",
  "004_public_site",
  "005_analysis_runs",
  "006_strategies",
  "007_paper_trading",
  "008_execution_supervisor",
  "009_notifications",
  "010_job_locks",
  "011_sports_foundation",
  "012_sports_intelligence",
  "013_sports_tickets",
  "014_sports_settlement",
  "015_sports_snapshots",
  "016_lottery_foundation",
  // Slice 2: the generated-combination record and its AI decision report.
  "017_lottery_combinations",
  // Slice 3: the ticket record and its number lines.
  "018_lottery_tickets",
]);

/** Only driver codes are ever reported; never an SQL statement or credential. */
function safeDriverDetail(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  if (!code) return "unreachable";
  if (code === "ER_ACCESS_DENIED_ERROR") return "access-denied";
  if (code === "ER_BAD_DB_ERROR") return "unknown-database";
  if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT"].includes(code)) return "unreachable";
  if (["PROTOCOL_CONNECTION_LOST", "ER_SERVER_SHUTDOWN"].includes(code)) return "disconnected";
  return "error";
}

export function createStore(pool, { requiredMigrations = REQUIRED_MIGRATIONS } = {}) {
  const repository = createAccountRepository(pool);
  const site = createSiteRepository(pool);
  const analysis = createAnalysisRepository(pool);
  const strategies = createStrategyRepository(pool);
  const paper = createPaperRepository(pool);
  const execution = createExecutionRepository(pool);
  const notifications = createNotificationRepository(pool);
  const jobs = createJobRepository(pool);
  const sports = createSportsRepository(pool);
  const lottery = createLotteryRepository(pool);
  return {
    ...repository,
    ...site,
    ...analysis,
    ...strategies,
    ...paper,
    // Public execution-store contract is read-only; transitions are available
    // only on the pinned paper transaction view below.
    findExecutionProposal: execution.findExecutionProposal,
    listExecutionProposals: execution.listExecutionProposals,
    // Cross-owner READ for the scheduled expiry job only. Still read-only: expiry
    // itself goes through the owner-bound transactional path above, so this adds no
    // unscoped write to the public contract. See `job-repository.js` and
    // `src/jobs/scheduled.js` for who is allowed to call it.
    listExecutionProposalsAllOwners: execution.listExecutionProposalsAllOwners,
    // Job coordination locks (migration 010). These write, but only to
    // `wf_job_locks` — they can never touch a proposal, order or account row.
    findJobLock: jobs.findJobLock,
    listJobLocks: jobs.listJobLocks,
    acquireJobLock: jobs.acquireJobLock,
    releaseJobLock: jobs.releaseJobLock,
    extendJobLock: jobs.extendJobLock,
    // Persisted job state (the portfolio-risk monitor's transition memory). Same
    // table as trading governance, different `state_key`, and the job repository
    // refuses the `'global'` key outright — so a cron run cannot rewrite the kill
    // switch. See `PORTFOLIO_RISK_STATE_KEY`.
    loadJobState: jobs.loadJobState,
    // Sports Intelligence data foundation (migration 011). Listed explicitly rather
    // than spread, matching the job block above, so the boundary is stated instead of
    // implied: these 22 methods read and write ONLY the seven `wf_sports_*` foundation tables.
    // None of them can reach a proposal, order, position, account or broker row, and
    // none of them places a bet — this is observed sporting data and the evidence of
    // how it was obtained. (`verifySportsResult` used to be deliberately absent here;
    // since slice 5 it exists, but it lives in the attestation block below — the
    // ingest writes and the attesting write stay distinct names on one repository.)
    ensureSportsProvider: sports.ensureSportsProvider,
    listSportsProviders: sports.listSportsProviders,
    setSportsProviderEnabled: sports.setSportsProviderEnabled,
    saveSportsHealth: sports.saveSportsHealth,
    latestSportsHealth: sports.latestSportsHealth,
    listSportsHealth: sports.listSportsHealth,
    pruneSportsHealth: sports.pruneSportsHealth,
    findSportsMatchById: sports.findSportsMatchById,
    listSportsMatches: sports.listSportsMatches,
    saveSportsMatch: sports.saveSportsMatch,
    findSportsMatch: sports.findSportsMatch,
    saveSportsOdds: sports.saveSportsOdds,
    latestSportsOdds: sports.latestSportsOdds,
    listSportsOdds: sports.listSportsOdds,
    findSportsOddsBefore: sports.findSportsOddsBefore,
    saveSportsResult: sports.saveSportsResult,
    findSportsResult: sports.findSportsResult,
    saveSportsQuality: sports.saveSportsQuality,
    latestSportsQuality: sports.latestSportsQuality,
    startSportsSync: sports.startSportsSync,
    finishSportsSync: sports.finishSportsSync,
    listSportsSyncRuns: sports.listSportsSyncRuns,
    // Sports decision chain (migration 012, slice 3). Same boundary as the foundation:
    // these twelve read and write ONLY the four `wf_sports_*` intelligence tables.
    // Predictions are insert-only; configuration and calibration are the sole mutable
    // state, and calibration decisions are compare-and-set on PENDING. None of them
    // can place a bet or reach a proposal, order, position or broker row.
    ensureSportsModelVersion: sports.ensureSportsModelVersion,
    listSportsModelVersions: sports.listSportsModelVersions,
    saveSportsPrediction: sports.saveSportsPrediction,
    findSportsPrediction: sports.findSportsPrediction,
    listSportsPredictions: sports.listSportsPredictions,
    saveSportsConfiguration: sports.saveSportsConfiguration,
    activeSportsConfiguration: sports.activeSportsConfiguration,
    listSportsConfigurations: sports.listSportsConfigurations,
    saveSportsCalibration: sports.saveSportsCalibration,
    findSportsCalibration: sports.findSportsCalibration,
    listSportsCalibrations: sports.listSportsCalibrations,
    decideSportsCalibration: sports.decideSportsCalibration,
    // Tickets and the daily ticket run (migration 013, slice 4). These write only the three
    // `wf_sports_*ticket*` tables. A ticket is a record of a proposal and a person's
    // decision on it. Nothing here reaches a paper, order or broker path.
    saveSportsTicket: sports.saveSportsTicket,
    findSportsTicket: sports.findSportsTicket,
    listSportsTickets: sports.listSportsTickets,
    listSportsTicketSelections: sports.listSportsTicketSelections,
    decideSportsTicket: sports.decideSportsTicket,
    claimSportsDailyTicketRun: sports.claimSportsDailyTicketRun,
    finishSportsDailyTicketRun: sports.finishSportsDailyTicketRun,
    findSportsDailyTicketRun: sports.findSportsDailyTicketRun,
    listSportsDailyTicketRuns: sports.listSportsDailyTicketRuns,
    // Slice 5 completes the ticket write surface: leg and ticket outcome updates are
    // what settlement applies, and run recovery is the R-29 stuck-run release. Still
    // ticket tables only, and still nothing that places or prices a bet.
    updateSportsTicket: sports.updateSportsTicket,
    updateSportsTicketSelection: sports.updateSportsTicketSelection,
    recordSportsTicketOutcome: sports.recordSportsTicketOutcome,
    recoverSportsDailyTicketRuns: sports.recoverSportsDailyTicketRuns,
    // Settlement and the measured half (migration 014, slice 5). Result attestation
    // sits here deliberately next to the ingest block it refines: `saveSportsResult`
    // records what a provider said, `verifySportsResult` records that a person
    // attested to it, and nothing in the ingest block can call the attesting one.
    // The analytics reads feed settlement, measurement and reporting only.
    verifySportsResult: sports.verifySportsResult,
    findSportsResultByMatch: sports.findSportsResultByMatch,
    listSportsPredictionOutcomes: sports.listSportsPredictionOutcomes,
    listSportsSettledSelections: sports.listSportsSettledSelections,
    saveSportsModelMetrics: sports.saveSportsModelMetrics,
    listSportsModelMetrics: sports.listSportsModelMetrics,
    saveSportsBacktest: sports.saveSportsBacktest,
    findSportsBacktest: sports.findSportsBacktest,
    listSportsBacktests: sports.listSportsBacktests,
    // The performance snapshot (migration 015, row 19). Its only writer is the sports
    // cron's `performance` job; the read is the history an operator compares windows
    // with. Upsert on (as_of, window) — a re-run of the same hour replaces, never
    // appends — exactly as legacy's unique key makes it.
    saveSportsPerformanceSnapshot: sports.saveSportsPerformanceSnapshot,
    listSportsPerformanceSnapshots: sports.listSportsPerformanceSnapshots,
    // Lottery Intelligence data foundation (migration 016, row 15 slice 1). Listed
    // explicitly like the sports block above — the F-41 lesson is that an implicit
    // list is a stale list waiting to happen, so each name is written out and the
    // contract test counts them. These 23 methods read and write ONLY the seven
    // `wf_lottery*` tables: published draw results and the evidence of how they were
    // obtained. Nothing here purchases, wagers or pays out anything, and none of it
    // can reach a proposal, order, position, account or broker row.
    ensureLotteryGame: lottery.ensureLotteryGame,
    listLotteryGames: lottery.listLotteryGames,
    activeLotteryRules: lottery.activeLotteryRules,
    saveLotteryRules: lottery.saveLotteryRules,
    ensureLotteryProvider: lottery.ensureLotteryProvider,
    listLotteryProviders: lottery.listLotteryProviders,
    saveLotteryHealth: lottery.saveLotteryHealth,
    latestLotteryHealth: lottery.latestLotteryHealth,
    listLotteryHealth: lottery.listLotteryHealth,
    findLotteryDraw: lottery.findLotteryDraw,
    findLotteryDrawByExternal: lottery.findLotteryDrawByExternal,
    listLotteryDraws: lottery.listLotteryDraws,
    saveLotteryDraw: lottery.saveLotteryDraw,
    listLotteryDrawNumbers: lottery.listLotteryDrawNumbers,
    saveLotteryDrawNumbers: lottery.saveLotteryDrawNumbers,
    lotteryDrawsForStats: lottery.lotteryDrawsForStats,
    countLotteryDraws: lottery.countLotteryDraws,
    startLotteryJobRun: lottery.startLotteryJobRun,
    finishLotteryJobRun: lottery.finishLotteryJobRun,
    listLotteryJobRuns: lottery.listLotteryJobRuns,
    findLotteryJobRunByKey: lottery.findLotteryJobRunByKey,
    deleteOldLotteryJobRuns: lottery.deleteOldLotteryJobRuns,
    deleteOldLotteryHealth: lottery.deleteOldLotteryHealth,
    // Slice 2 (migration 017): combinations + AI decisions (F-41: the explicit list).
    saveLotteryCombination: lottery.saveLotteryCombination,
    findLotteryCombination: lottery.findLotteryCombination,
    listLotteryCombinations: lottery.listLotteryCombinations,
    saveLotteryAiDecision: lottery.saveLotteryAiDecision,
    findLotteryAiDecision: lottery.findLotteryAiDecision,
    listLotteryAiDecisions: lottery.listLotteryAiDecisions,
    // Slice 3 (migration 018): tickets + lines (records, never purchases).
    saveLotteryTicket: lottery.saveLotteryTicket,
    findLotteryTicket: lottery.findLotteryTicket,
    listLotteryTickets: lottery.listLotteryTickets,
    listAllLotteryTickets: lottery.listAllLotteryTickets,
    updateLotteryTicket: lottery.updateLotteryTicket,
    listLotteryTicketLines: lottery.listLotteryTicketLines,
    saveLotteryTicketLines: lottery.saveLotteryTicketLines,
    saveJobState: jobs.saveJobState,
    // Notifications are written outside any paper transaction: they are evidence
    // about a change that already committed, and a failed notification must never
    // roll back a governance decision (see `modules/notifications/service.js`).
    createNotification: notifications.createNotification,
    listNotifications: notifications.listNotifications,
    markNotificationRead: notifications.markNotificationRead,
    markAllNotificationsRead: notifications.markAllNotificationsRead,
    countUnreadNotifications: notifications.countUnreadNotifications,
    hasUnreadNotificationDedupe: notifications.hasUnreadNotificationDedupe,
    adapter: "mysql",
    capabilities: Object.freeze({
      adapter: "mysql",
      sql: true,
      durable: true,
      transactions: true,
      crossProcessSafety: true,
      recommendedForProduction: true,
    }),

    /**
     * Run one paper command on a pinned MySQL connection. The callback receives
     * transaction-scoped paper rows (SELECT ... FOR UPDATE), journal writes and
     * audit insertion; no write can escape the commit/rollback boundary.
     */
    async withPaperTransaction(work) {
      if (typeof work !== "function") throw new TypeError("paper transaction requires a callback");
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const tx = {
          ...createPaperRepository(connection, { lockRows: true }),
          ...createStrategyRepository(connection, { lockRows: true }),
          ...createExecutionRepository(connection),
          async recordAudit({ actorId = null, action, entityType = null, entityId = null, details = {} }) {
            await connection.execute(
              `INSERT INTO wf_audit_events
                (actor_user_id, action_key, entity_type, entity_id, detail_json, created_at)
               VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
              [actorId, action, entityType, entityId === null ? null : String(entityId), JSON.stringify(details)],
            );
          },
        };
        const result = await work(tx);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback().catch(() => {});
        throw error;
      } finally {
        connection.release();
      }
    },

    async readiness() {
      try {
        await pool.execute("SELECT 1 AS healthy");
      } catch (error) {
        return { database: false, schema: false, adapter: "mysql", detail: safeDriverDetail(error) };
      }
      try {
        const placeholders = requiredMigrations.map(() => "?").join(", ");
        const [rows] = await pool.execute(
          `SELECT migration_name FROM wf_schema_migrations WHERE migration_name IN (${placeholders})`,
          requiredMigrations,
        );
        return { database: true, schema: rows.length === requiredMigrations.length, adapter: "mysql", detail: null };
      } catch {
        return { database: true, schema: false, adapter: "mysql", detail: "missing-schema" };
      }
    },

    async health() {
      return { adapter: "mysql", pool: { connectionLimit: pool.pool?.config?.connectionLimit ?? null, all: pool.pool?._all?.length ?? null } };
    },

    async findUserByIdentifier(identifier) {
      const normalized = identifier.trim().toLowerCase();
      const [rows] = await pool.execute(
        `SELECT id, legacy_user_id, legacy_uid, username, email, password_hash, status
           FROM wf_users
          WHERE username_normalized = ? OR email_normalized = ? OR legacy_uid = ?
          LIMIT 1`,
        [normalized, normalized, normalized],
      );
      return rows[0] || null;
    },

    async createSession({ tokenHash, userId, expiresAt, deviceLabel = null, createdAt = null }) {
      await pool.execute(
        `INSERT INTO wf_sessions (token_hash, user_id, expires_at, device_label, created_at)
         VALUES (?, ?, ?, ?, COALESCE(?, UTC_TIMESTAMP(3)))`,
        [tokenHash, userId, expiresAt, deviceLabel || null, createdAt ? new Date(createdAt) : null],
      );
    },

    async findSession(tokenHash) {
      const [rows] = await pool.execute(
        `SELECT s.user_id, u.legacy_uid, u.username, u.email, up.display_name, up.profile_image, p.permission_key
           FROM wf_sessions s
           JOIN wf_users u ON u.id = s.user_id
           LEFT JOIN wf_user_profiles up ON up.user_id = u.id
           LEFT JOIN wf_user_roles ur ON ur.user_id = u.id
           LEFT JOIN wf_role_permissions rp ON rp.role_id = ur.role_id
           LEFT JOIN wf_permissions p ON p.id = rp.permission_id
          WHERE s.token_hash = ?
            AND s.revoked_at IS NULL
            AND s.expires_at > UTC_TIMESTAMP(3)
            AND u.status = 'active'`,
        [tokenHash],
      );
      if (!rows.length) return null;
      const row = rows[0];
      return {
        user: {
          id: row.user_id,
          legacyUid: row.legacy_uid,
          username: row.username,
          email: row.email,
          displayName: row.display_name,
          profileImage: row.profile_image,
        },
        permissions: [...new Set(rows.map((item) => item.permission_key).filter(Boolean))],
      };
    },

    async revokeSession(tokenHash) {
      await pool.execute(
        `UPDATE wf_sessions
            SET revoked_at = UTC_TIMESTAMP(3)
          WHERE token_hash = ? AND revoked_at IS NULL`,
        [tokenHash],
      );
    },

    async recordAudit({ actorId = null, action, entityType = null, entityId = null, details = {} }) {
      const detailJson = JSON.stringify(details);
      await pool.execute(
        `INSERT INTO wf_audit_events
          (actor_user_id, action_key, entity_type, entity_id, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
        [actorId, action, entityType, entityId === null ? null : String(entityId), detailJson],
      );
    },

    async listUsers(limit = 100) {
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
      const [rows] = await pool.query(
        `SELECT u.id, u.legacy_uid, u.username, u.email, u.status, u.created_at,
                up.display_name, up.profile_image, up.last_login_at
           FROM wf_users u
           LEFT JOIN wf_user_profiles up ON up.user_id = u.id
          ORDER BY u.id ASC
          LIMIT ${boundedLimit}`,
      );
      return rows;
    },
  };
}

export function hashFailedLoginIdentifier(identifier) {
  return createHash("sha256").update(identifier.trim().toLowerCase()).digest("hex");
}
