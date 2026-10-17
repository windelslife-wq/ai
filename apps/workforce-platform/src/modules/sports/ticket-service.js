/**
 * The ticket service (row 14, slice 4): the daily ticket run, the ticket reads, and the
 * decision a person makes on a ticket.
 *
 * It orchestrates. It does not compute a probability, a value, a correlation or an odds
 * window. Those live in `intelligence.js`, `correlation.js`, `ticket-optimizer.js` and
 * `ticket-governance.js`, and the parity tests hold them to legacy's output.
 *
 * Divergences from legacy `DailyTicketService`, each recorded in PHASE18:
 *
 *  - **DV-21: the run reads stored fixtures.** Legacy fetches the day's fixtures and odds
 *    from the provider inside the run. Here the run reads what the sync already stored for
 *    that day, and reads the latest stored odds. A run therefore cannot call a provider, and
 *    a stored fixture with no odds rejects on `ODDS_UNAVAILABLE` rather than being fetched.
 *  - **DV-20: simulated candidates are refused for tickets.** A qualified candidate whose
 *    fixture is simulated is still recorded as a prediction, but it never enters the
 *    ticket pool. Legacy ignores the flag. Real-data tickets are unchanged.
 *  - **DV-22: no automated approval.** See `ticket-governance.js`.
 *  - **DV-23 (preserved): a run that throws is NO_QUALIFIED_TICKET, as legacy stores it,**
 *    with the error in its message and in `errors`. The user chose legacy's status over a
 *    FAILED status. A reader can therefore see "no candidate qualified" for a run that broke,
 *    which is why the error is kept in two places.
 *  - **DV-27: stake sizing (Phase 48).** The active configuration's `staking_method`
 *    sizes the recorded stake (`stake-sizing.js` — bounded, record-only; `FLAT` is the
 *    default and is exactly legacy's fixed stake). The breakdown rides in
 *    `sports.daily_ticket.run`'s audit details and in this run's return, never in a new
 *    table: ticket + configuration version is enough to recompute it.
 *
 * Idempotency: the run is claimed for (day, configuration version) before any work, so a
 * second request for the same pair is DUPLICATE_SKIPPED, as legacy's `startJobRun` does.
 * A run that crashes mid-way stays RUNNING and blocks that pair. There is no recovery route
 * yet (see PHASE18, open items).
 */
import { randomBytes } from "node:crypto";

import { AppError } from "../../http/errors.js";
import { assertRunDate, assertTicketId } from "../../persistence/sports-rows.js";
import { defaultConfiguration } from "./configuration.js";
import { optimizeTicket } from "./ticket-optimizer.js";
import { buildTicket, decisionFor } from "./ticket-governance.js";

/** Engine modes that generate tickets. `AUTOMATED_EXECUTION` is refused at configuration (DV-14). */
export const TICKET_ENGINE_MODES = Object.freeze(["AI_TICKET_GENERATION", "USER_APPROVAL_REQUIRED"]);

/** The most fixtures one run reads. A day beyond this is reported, not silently cut. */
export const FIXTURE_LIMIT = 1000;

/**
 * The candidate the optimizer and governance read. It is the chain's result plus the
 * prediction id, and the team and competition fields at the top level.
 *
 * **F-39.** Legacy's `CorrelationEngine` reads `homeTeam`, `awayTeam` and `competition` at
 * the top level of a candidate, but the pipeline left them under `match`. The team and
 * competition checks therefore never fired in legacy, and only SAME_MATCH did. This builder
 * copies them up, so the documented checks run. The correlation function is unchanged.
 */
export function candidateFor(result, predictionId) {
  const match = result.match ?? {};
  return {
    ...result,
    predictionId,
    homeTeam: match.homeTeam ?? null,
    awayTeam: match.awayTeam ?? null,
    competition: match.competition ?? null,
  };
}

/** The optimizer's window and floors, under legacy's camelCase keys, from the configuration row. */
export function optimizerConfig(config) {
  return {
    targetOddsMin: Number(config.target_odds_min),
    targetOddsMax: Number(config.target_odds_max),
    maxSelections: Number(config.max_selections),
    minConfidence: Number(config.min_confidence ?? 0),
    minDataQuality: Number(config.min_data_quality ?? 0),
    maxCorrelation: config.max_correlation,
    allowedMarkets: Array.isArray(config.allowed_markets) ? config.allowed_markets : [],
    allowedLeagues: Array.isArray(config.allowed_leagues) ? config.allowed_leagues : [],
  };
}

export function createTicketService({ store = null, intelligence = null, now = () => Date.now() } = {}) {
  const requireStore = () => {
    if (!store) {
      throw new AppError(503, "SPORTS_PERSISTENCE_UNAVAILABLE",
        "This host has no sports repository, so tickets cannot be generated or read");
    }
    return store;
  };
  const nowIso = () => new Date(now()).toISOString();
  const todayUtc = () => new Date(now()).toISOString().slice(0, 10);
  const newTicketId = () => `tkt_${randomBytes(8).toString("hex")}`;

  /** Parse a caller's ticket id, or report it as not found. A malformed id cannot exist. */
  function ticketIdOrNotFound(id) {
    try {
      return assertTicketId(id);
    } catch {
      throw AppError.notFound("No sports ticket with that id");
    }
  }

  async function generate(runDate, config, outcome) {
    const repository = requireStore();
    const matches = await repository.listSportsMatches(
      { from: `${runDate}T00:00:00.000Z`, to: `${runDate}T23:59:59.999Z` },
      FIXTURE_LIMIT,
    );
    outcome.fixturesRead = matches.length;
    if (matches.length >= FIXTURE_LIMIT) {
      outcome.errors.push(`more than ${FIXTURE_LIMIT} fixtures are stored for ${runDate}; the rest were not read`);
    }

    const candidates = [];
    let modelVersionId = null;
    for (const match of matches) {
      const inputs = await intelligence.loadInputs(match.id);
      const result = intelligence.runChain(inputs);
      const persisted = await intelligence.persistDecision(inputs, result, { audit: false });
      outcome.candidatesEvaluated += 1;
      outcome.predictionsRecorded += 1;
      modelVersionId ??= persisted.modelVersionId;

      if (result.decision === "REJECTED") {
        outcome.rejections += 1;
        for (const reason of result.rejectionReasons ?? []) {
          outcome.rejectionSummary[reason] = (outcome.rejectionSummary[reason] ?? 0) + 1;
        }
      } else if (result.factors?.simulated === true) {
        // DV-20: recorded as a prediction, never placed on a ticket.
        outcome.simulatedRefused += 1;
      } else {
        candidates.push(candidateFor(result, persisted.prediction.id));
      }
    }

    if (candidates.length > 0) {
      const optimized = optimizeTicket(candidates, optimizerConfig(config), { ticketId: newTicketId() });
      if (optimized.status === "QUALIFIED") {
        const built = buildTicket(optimized, {
          configurationVersion: config.version,
          modelVersionId,
          config,
          createdAt: nowIso(),
        });
        const stored = await repository.saveSportsTicket(built);
        outcome.status = "PENDING_USER_APPROVAL";
        outcome.ticketId = stored.id;
        // DV-27: the sizing that produced the stored stake travels in the audit event
        // and the response. A breakdown column is unnecessary — the method and the
        // configuration version are on the ticket, and the engine is deterministic.
        outcome.stakeSizing = built.sizing;
        outcome.message = "ticket generated; awaiting user approval";
      } else {
        outcome.message = optimized.reason;
      }
    } else if (matches.length === 0) {
      outcome.message = `no fixtures stored for ${runDate}`;
    } else {
      outcome.message = "no candidate passed the risk/value/calibration gates";
    }

    if (outcome.simulatedRefused > 0) {
      outcome.message = `${outcome.message}; ${outcome.simulatedRefused} simulated candidate(s) refused for tickets (DV-20)`;
    }
  }

  /**
   * Run the daily ticket generation for one UTC day (default: today). Returns the run's
   * outcome. A second call for the same day and configuration version returns
   * DUPLICATE_SKIPPED and does no work.
   */
  async function runDaily({ date = null, actorId = null } = {}) {
    const repository = requireStore();
    let runDate;
    try {
      runDate = assertRunDate(date ?? todayUtc());
    } catch (error) {
      throw new AppError(400, "INVALID_RUN_DATE", error.message);
    }

    const config = (await repository.activeSportsConfiguration()) ?? defaultConfiguration();
    const claimed = await repository.claimSportsDailyTicketRun({
      runDate,
      configurationVersion: config.version,
      requestedBy: actorId,
      createdAt: nowIso(),
    });
    if (claimed === null) {
      const existing = await repository.findSportsDailyTicketRun(runDate, config.version);
      return Object.freeze({
        status: "DUPLICATE_SKIPPED",
        date: runDate,
        configurationVersion: config.version,
        existingRunStatus: existing?.status ?? null,
        message: "a run for this day and configuration version already exists",
      });
    }

    const outcome = {
      status: "NO_QUALIFIED_TICKET",
      ticketId: null,
      message: "",
      fixturesRead: 0,
      candidatesEvaluated: 0,
      predictionsRecorded: 0,
      rejections: 0,
      simulatedRefused: 0,
      rejectionSummary: {},
      errors: [],
    };

    try {
      if (!config.module_enabled) {
        outcome.message = "Sports Intelligence module is disabled";
      } else if (!config.ticket_engine_enabled) {
        outcome.message = "AI Ticket Engine is disabled";
      } else if (!TICKET_ENGINE_MODES.includes(config.engine_mode)) {
        outcome.message = `engine mode ${config.engine_mode} does not generate tickets`;
      } else {
        await generate(runDate, config, outcome);
      }
    } catch (error) {
      // DV-23: stored as legacy stores it. The error is in the message and in `errors`.
      outcome.status = "NO_QUALIFIED_TICKET";
      outcome.message = `unexpected failure: ${error.message}`;
      outcome.errors.push(outcome.message);
    }

    const finished = await repository.finishSportsDailyTicketRun(claimed.id, outcome, nowIso());
    await repository.recordAudit({
      actorId,
      action: "sports.daily_ticket.run",
      entityType: "sports_daily_ticket",
      entityId: String(claimed.id),
      details: {
        date: runDate,
        status: outcome.status,
        ticketId: outcome.ticketId,
        fixturesRead: outcome.fixturesRead,
        rejections: outcome.rejections,
        simulatedRefused: outcome.simulatedRefused,
        stakeSizing: outcome.stakeSizing ?? null,
      },
    });

    return Object.freeze({
      runId: finished?.id ?? claimed.id,
      status: outcome.status,
      ticketId: outcome.ticketId,
      date: runDate,
      configurationVersion: config.version,
      message: outcome.message,
      stakeSizing: outcome.stakeSizing ?? null,
      fixturesRead: outcome.fixturesRead,
      candidatesEvaluated: outcome.candidatesEvaluated,
      predictionsRecorded: outcome.predictionsRecorded,
      rejections: outcome.rejections,
      simulatedRefused: outcome.simulatedRefused,
      rejectionSummary: outcome.rejectionSummary,
      errors: outcome.errors,
    });
  }

  async function listDailyRuns(limit = 50) {
    return requireStore().listSportsDailyTicketRuns(limit);
  }

  async function listTickets(filter = {}, limit = 50) {
    const f = filter && typeof filter === "object" ? filter : {};
    return requireStore().listSportsTickets(
      {
        approvalStatus: f.approvalStatus ?? null,
        runDate: f.runDate ?? null,
      },
      limit,
    );
  }

  async function getTicket(id) {
    const repository = requireStore();
    const ticketId = ticketIdOrNotFound(id);
    const ticket = await repository.findSportsTicket(ticketId);
    if (!ticket) throw AppError.notFound("No sports ticket with that id");
    const selections = await repository.listSportsTicketSelections(ticketId);
    return Object.freeze({ ticket, selections });
  }

  /**
   * A person approves or rejects a ticket. Nothing is executed: the decision is recorded,
   * and `externalExecution` is always false. The decision moves once, by compare-and-set.
   */
  async function decideTicket({ id, approve, reason = "", actorId = null }) {
    const repository = requireStore();
    const ticketId = ticketIdOrNotFound(id);
    const ticket = await repository.findSportsTicket(ticketId);
    const decision = decisionFor(ticket, { approve: approve === true, actorId, reason, decidedAt: nowIso() });

    const decided = await repository.decideSportsTicket(ticketId, decision);
    if (decided === null) {
      throw new AppError(409, "SPORTS_TICKET_ALREADY_DECIDED", "This ticket was decided by another request");
    }
    await repository.recordAudit({
      actorId,
      action: approve === true ? "sports.ticket.approved" : "sports.ticket.rejected",
      entityType: "sports_ticket",
      entityId: ticketId,
      details: { approvalStatus: decision.approvalStatus, reason, externalExecution: false },
    });
    return Object.freeze({
      ticketId,
      approvalStatus: decision.approvalStatus,
      externalExecution: false,
    });
  }

  return Object.freeze({
    runDaily,
    listDailyRuns,
    listTickets,
    getTicket,
    decideTicket,
  });
}
