/**
 * The Lottery Intelligence service — the port of the foundation half of
 * `Aegis\Lottery\LotteryIntelligence` (row 15, slice 1).
 *
 * Legacy's class is the module facade: it wires provider → validation → historical
 * database → statistics → combination analysis / generation / diversification /
 * tickets / backtests, with the same governance rules as the rest of the platform —
 * source attribution on every record, idempotent ingestion, audited decisions, and
 * honest state when no provider is configured (`DISABLED_NO_PROVIDER` — nothing
 * fabricated). Slice 1 ports the foundation: status, ingestion (sync + import with
 * full validation), the stored reads, the statistics endpoints and the provider
 * health surface. The combination intelligence, tickets, backtests and model
 * versions are slice 2, the cron slice 3 — and the not-ported matrix travels in
 * `status()` so the gap is stated, not silent (the BC-10 rule).
 *
 * Legacy's honesty contract, unchanged: EuroMillions is a random lottery — this
 * module provides STATISTICAL intelligence, never a claim of prediction.
 *
 * One wiring divergence is deliberate (**LT-4**): legacy's constructor ensured the
 * `lotteries` row on every construction — a WRITE in a constructor. The port
 * ensures it lazily on the first call that needs the registry, so constructing the
 * service (as `buildApp` does on every boot, and the CLI tools do per run) performs
 * no writes; a host whose migration 016 has not been applied gets a 503 from the
 * stored routes, exactly like the sports module's, rather than a boot failure.
 */

import { createLotteryResultValidator, STATUS_FAILED } from "./validator.js";
import { createLotteryStatisticsEngine, DISCLAIMER } from "./statistics.js";
import { createEuroMillionsRules, euroMillionsRulesFromArray } from "./rules.js";
import { chooseLotteryProvider } from "./providers.js";
import { AppError } from "../../http/errors.js";

export const MODEL_VERSION = "1.0";
export const LOTTERY = "EUROMILLIONS";
export const ENGINE_DISABLED = "DISABLED_NO_PROVIDER";
export const ENGINE_ACTIVE = "ACTIVE";

/**
 * The parts of row 15 this port still does not contain, in legacy's own terms.
 * Slice 2 (combination intelligence, tickets, backtests, model versions) empties
 * the middle entries; slice 3 (the cron) removes the jobs entry. The console screens
 * stay until F-29 is lifted platform-wide. Removed, never re-labelled, as entries
 * become untrue.
 */
export const LOTTERY_NOT_PORTED = Object.freeze([
  Object.freeze({ area: "combination intelligence", legacy: "CombinationGenerator, CombinationAnalyzer, SystemBuilder, DiversificationEngine", state: "not ported", detail: "Generation, per-line analysis, full-system building and diversification scoring are statistical balance tooling over stored draws. They land in slice 2, against the draws this slice stores." }),
  Object.freeze({ area: "tickets and checking", legacy: "createTicket/checkTicket/archiveTicket, lottery_tickets + lottery_ticket_lines", state: "not ported", detail: "A lottery ticket on this platform is a record of number lines, never a purchase; slice 2 ports the record and its draw checking." }),
  Object.freeze({ area: "backtests and model versions", legacy: "LotteryBacktester, lottery_backtests + lottery_model_versions", state: "not ported", detail: "Strategy replay over stored history without look-ahead, persisted as historical simulation reports. Slice 2." }),
  Object.freeze({ area: "generation persistence", legacy: "lottery_combinations + lottery_ai_decisions, /lottery/combinations and /lottery/ai-decisions", state: "not ported", detail: "Generated reports and their decision records, persisted with model version and audit trail. Slice 2." }),
  Object.freeze({ area: "scheduled jobs", legacy: "LotteryCronService (sync, health, statistics, systems, tickets, backtests, cleanup)", state: "not ported", detail: "The lottery cron is slice 3, on the same wf_job_locks pattern as the sports cron (row 19). Until then nothing here runs on a schedule." }),
  Object.freeze({ area: "console screens", legacy: "Lottery::index (views/lottery/*.php)", state: "not ported", detail: "No ported module has a console screen (F-29, platform-wide); the API reads exist under /lottery/*." }),
]);

/**
 * Create the lottery service.
 *
 * @param {object} options
 * @param {object} options.store a repository store implementing the lottery methods
 * @param {object} options.config the validated host configuration
 * @param {() => number} [options.now] the injectable clock
 * @param {object|null} [options.provider] an explicit provider (tests); default is
 *   legacy's Platform.php choice from the environment
 * @param {object|null} [options.rules] explicit rules (tests); default is stored
 *   rules when present, the code default otherwise
 */
export function createLotteryService({ store, config, now = () => Date.now(), provider = null, rules = null } = {}) {
  if (!config) throw new TypeError("createLotteryService requires config");

  const chosenProvider = provider ?? chooseLotteryProvider({ lotteryConfig: config.lottery, now });
  const statistics = createLotteryStatisticsEngine();
  /** The resolved rules: explicit → stored → code default (lazy, LT-4 — no reads at construction). */
  let rulesInstance = rules;
  let ensured = false;

  // A null store is a supported construction: the static-file boot builds the app
  // without a repository (the store-less boot contract the F-21 tests pin). Every
  // method that touches persistence asks requireStore() first and answers 503 —
  // the same lazy pattern the sports service uses — so a missing table is
  // "this host cannot read that" and never an empty list.
  function requireStore() {
    if (!store) {
      throw new AppError(
        503,
        "LOTTERY_PERSISTENCE_UNAVAILABLE",
        "This host has no lottery repository, so stored lottery data cannot be read. Ingestion needs the tables migration 016 creates.",
      );
    }
    return store;
  }

  const nowIso = () => new Date(Number(now())).toISOString();
  const gmdateC = () => new Date(Number(now())).toISOString().replace(/\.\d{3}Z$/, "+00:00");

  async function ensureRegistered() {
    if (ensured) return;
    const r = await resolveRules();
    await requireStore().ensureLotteryGame(r.code(), r.name(), r.version());
    ensured = true;
  }

  /** Stored rules when present; the code default is authoritative otherwise. */
  async function resolveRules() {
    if (rulesInstance) return rulesInstance;
    const row = await requireStore().activeLotteryRules(LOTTERY);
    rulesInstance = row
      ? euroMillionsRulesFromArray(LOTTERY, "EuroMillions", row)
      : createEuroMillionsRules();
    return rulesInstance;
  }

  /** The provider registry row for THIS provider, creating it only when the provider is real. */
  async function providerRowId() {
    if (chosenProvider.kind() === "unavailable") return null;
    const row = await requireStore().ensureLotteryProvider(chosenProvider.id(), chosenProvider.name());
    return Number(row.id);
  }

  /** Find a provider registry row without creating one during a read. */
  async function existingProviderRowId() {
    const rows = await requireStore().listLotteryProviders();
    const row = rows.find((candidate) => String(candidate.provider_code ?? "") === chosenProvider.id());
    return row ? Number(row.id) : null;
  }

  /** Read-only registry listing (GET /lottery/providers) — through the lazy store guard. */
  const registry = async () => ({ providers: await requireStore().listLotteryProviders() });

  function recordAudit(actorId, action, message, details = {}) {
    return store.recordAudit({
      actorId: actorId ?? null,
      action,
      entityType: "lottery_draw",
      entityId: null,
      details: { message, ...details },
    });
  }

  // ------------------------------------------------------------------ status

  async function status() {
    await ensureRegistered();
    const activeRules = await resolveRules();
    const health = await chosenProvider.health();
    const enabled = health.state === "ONLINE";
    const last = await requireStore().listLotteryDraws({ lotteryCode: LOTTERY }, 1);
    return {
      module: "lottery-intelligence",
      activeLottery: LOTTERY,
      lotteries: (await requireStore().listLotteryGames()).map((l) => ({ code: l.code, name: l.name, enabled: Boolean(l.enabled) })),
      rules: {
        code: activeRules.code(),
        version: activeRules.version(),
        main: { count: activeRules.mainCount(), min: activeRules.mainMin(), max: activeRules.mainMax() },
        stars: { count: activeRules.starCount(), min: activeRules.starMin(), max: activeRules.starMax() },
        schedule: activeRules.drawSchedule(),
      },
      provider: health,
      engine: enabled ? ENGINE_ACTIVE : ENGINE_DISABLED,
      modelVersion: MODEL_VERSION,
      drawsTracked: await drawCount(),
      lastDraw: last.length > 0 ? last[0] : null,
      disclaimer: DISCLAIMER,
      notPorted: LOTTERY_NOT_PORTED,
    };
  }

  async function drawCount() {
    return store.countLotteryDraws(LOTTERY);
  }

  // ------------------------------------------------------------------- ingestion

  /**
   * Sync from the configured provider: fetch → validate → store (idempotent) →
   * provider health. (legacy spec §28/§31)
   */
  async function sync(limit = 100) {
    await ensureRegistered();
    const health = await chosenProvider.health();
    if (health.state !== "ONLINE") {
      return { status: "NO_PROVIDER", provider: chosenProvider.id(), imported: 0, failed: 0, unchanged: 0, conflicts: 0, errors: [] };
    }
    const startedAt = Number(now());
    const raw = await chosenProvider.draws(null, null, limit);
    const summary = await importDraws(raw);
    const respMs = Math.round((Number(now()) - startedAt));
    const pid = await providerRowId();
    const ok = raw.length > 0;
    let lastDraw = null;
    for (const d of [...raw].reverse()) {
      if (d?.drawDate) {
        lastDraw = String(d.drawDate);
        break;
      }
    }
    if (pid !== null) {
      await requireStore().saveLotteryHealth(pid, {
        status: ok ? "ONLINE" : "DEGRADED",
        responseMs: respMs,
        recordsReceived: raw.length,
        invalidRecords: summary.failed,
        lastSuccessAt: ok ? nowIso() : null,
        lastFailureAt: ok ? null : nowIso(),
        lastDrawRetrieved: lastDraw,
        synthetic: health.synthetic ? 1 : 0,
      });
    }
    return { ...summary, status: ok ? "OK" : "NO_DATA", provider: chosenProvider.id(), responseMs: respMs };
  }

  /**
   * Import raw provider draws with full validation (spec §5/§6/§28):
   *  - invalid draws are NEVER stored; they are marked DATA_VALIDATION_FAILED and audited
   *  - re-import of identical data is a no-op (idempotent)
   *  - a VERIFIED draw is never silently overwritten; conflicting provider data is audited
   *  - every stored draw carries source + source timestamp + retrieved_at
   */
  async function importDraws(rawDraws) {
    await ensureRegistered();
    const activeRules = await resolveRules();
    const validator = createLotteryResultValidator(activeRules);
    const summary = { imported: 0, unchanged: 0, corrected: 0, failed: 0, conflicts: 0, errors: [] };
    const providerId = await providerRowId();
    for (const raw of rawDraws) {
      const externalId = String(raw?.externalId ?? "?");
      const check = validator.validate(raw);
      if (!check.valid) {
        summary.failed += 1;
        summary.errors.push({ externalId, errors: check.errors });
        await recordAudit(null, "lottery.draw.validation.failed", `Lottery draw ${externalId} rejected: ${check.errors.join("; ")}`, {
          externalId, errors: check.errors, lottery: LOTTERY, validatorStatus: STATUS_FAILED,
        });
        continue;
      }
      const numbers = { main: [...raw.main], stars: [...raw.stars] };
      const existing = await requireStore().findLotteryDrawByExternal(LOTTERY, externalId);
      if (existing) {
        const existingPayload = existing.payload && typeof existing.payload === "object" ? existing.payload : {};
        const same = JSON.stringify(existingPayload.main ?? null) === JSON.stringify(numbers.main)
          && JSON.stringify(existingPayload.stars ?? null) === JSON.stringify(numbers.stars);
        if (same) {
          summary.unchanged += 1; // idempotent — verified data never silently touched
          continue;
        }
        if ((existing.verification_status ?? "") === "VERIFIED") {
          summary.conflicts += 1;
          await recordAudit(null, "lottery.result.conflict", `Verified draw ${externalId} differs from provider data — NOT overwritten; manual correction required`, {
            externalId,
            existingMain: existingPayload.main ?? null,
            incomingMain: numbers.main,
          });
          continue;
        }
        const outcome = await requireStore().saveLotteryDraw(drawRow(raw, numbers, providerId));
        await requireStore().saveLotteryDrawNumbers(Number(existing.id), numbers);
        summary.corrected += 1;
        await recordAudit(null, "lottery.draw.corrected", `Unverified draw ${externalId} corrected from provider ${String(raw.source)}`, { externalId });
        void outcome;
        continue;
      }
      const out = await requireStore().saveLotteryDraw(drawRow(raw, numbers, providerId));
      await requireStore().saveLotteryDrawNumbers(Number(out.row.id), numbers);
      summary.imported += 1;
      await recordAudit(null, "lottery.draw.imported", `Lottery draw ${externalId} (${raw.drawDate}) imported from ${String(raw.source)}`, {
        drawId: Number(out.row.id), externalId, drawDate: String(raw.drawDate), source: String(raw.source),
      });
    }
    return summary;
  }

  function drawRow(raw, numbers, providerId) {
    return {
      lotteryCode: LOTTERY,
      providerId,
      externalId: String(raw.externalId),
      drawDate: String(raw.drawDate),
      jackpot: raw.jackpot ?? null,
      rollover: Boolean(raw.rollover),
      source: String(raw.source),
      sourceTimestamp: String(raw.sourceTimestamp),
      retrievedAt: gmdateC(),
      verificationStatus: "VERIFIED",
      payload: {
        main: numbers.main,
        stars: numbers.stars,
        jackpot: raw.jackpot ?? null,
        rollover: Boolean(raw.rollover),
        winners: raw.winners ?? null,
        source: String(raw.source),
      },
      now: gmdateC(),
    };
  }

  // ----------------------------------------------------------------- reads

  async function listDraws(limit = 50, from = null, to = null) {
    await ensureRegistered();
    return store.listLotteryDraws({ lotteryCode: LOTTERY, from, to }, limit);
  }

  async function drawDetail(id) {
    await ensureRegistered();
    const row = await requireStore().findLotteryDraw(id);
    if (!row || row.lottery_code !== LOTTERY) return null;
    row.numbers = await requireStore().listLotteryDrawNumbers(id);
    return row;
  }

  // --------------------------------------------------------------- statistics

  /**
   * Statistical endpoints (spec §8–§14). All outputs carry the DISCLAIMER.
   * @param {string} kind numbers|stars|hot-cold|distribution|pairs|triplets|star-pairs
   */
  async function statisticsOf(kind = "numbers", window = 0) {
    await ensureRegistered();
    const activeRules = await resolveRules();
    const draws = await requireStore().lotteryDrawsForStats(LOTTERY, 10_000);
    switch (kind) {
      case "numbers": return statistics.numberStats(draws, activeRules.mainMin(), activeRules.mainMax(), window);
      case "stars": return statistics.starStats(draws, activeRules.starMin(), activeRules.starMax(), window);
      case "hot-cold": return statistics.hotCold(draws, "main", activeRules.mainMin(), activeRules.mainMax(), window > 0 ? window : 50);
      case "distribution": return statistics.distribution(draws, activeRules.mainMin(), activeRules.mainMax(), activeRules.mainCount());
      case "pairs": return statistics.groupStats(draws, "main", activeRules.mainMin(), activeRules.mainMax(), 2);
      case "triplets": return statistics.groupStats(draws, "main", activeRules.mainMin(), activeRules.mainMax(), 3);
      case "star-pairs": return statistics.groupStats(draws, "stars", activeRules.starMin(), activeRules.starMax(), 2);
      default: throw new RangeError(`unknown statistics kind: ${kind}`);
    }
  }

  // ------------------------------------------------------------ provider health

  /** Persist one explicit, audited live-provider health probe. */
  async function probeProvider(actor = null) {
    const startedAt = Number(now());
    let health;
    try {
      health = await chosenProvider.health();
      if (!health || typeof health !== "object") throw new Error("invalid provider health response");
    } catch {
      // Provider exceptions may contain upstream details; do not expose them to the
      // caller. The failure state itself is still audited.
      health = {
        state: "ERROR",
        licensed: false,
        synthetic: false,
        message: "Provider health check failed; inspect server-side logs.",
      };
    }
    const responseMs = Math.max(0, Math.round(Number(now()) - startedAt));
    let state = String(health.state ?? "UNKNOWN").toUpperCase();
    if (!["ONLINE", "DEGRADED", "OFFLINE", "DISABLED", "UNCONFIGURED", "ERROR"].includes(state)) {
      state = "UNKNOWN";
      health.state = state;
    }
    const at = nowIso();
    const provider = await requireStore().ensureLotteryProvider(chosenProvider.id(), chosenProvider.name());
    const providerId = Number(provider.id ?? 0);
    const persisted = providerId > 0;
    const previousHealth = persisted ? await requireStore().latestLotteryHealth(providerId) : null;
    if (persisted) {
      await requireStore().saveLotteryHealth(providerId, {
        status: state,
        responseMs,
        recordsReceived: 0,
        invalidRecords: 0,
        lastSuccessAt: state === "ONLINE" ? at : null,
        lastFailureAt: ["DEGRADED", "OFFLINE", "ERROR"].includes(state) ? at : null,
        lastDrawRetrieved: previousHealth?.last_draw_retrieved ?? null,
        synthetic: health.synthetic ? 1 : 0,
      });
    }
    await requireStore().recordAudit({
      actorId: actor ?? null,
      action: "lottery.provider.health.probed",
      entityType: "lottery_data_source",
      entityId: String(providerId),
      details: {
        message: `Lottery provider health check: ${chosenProvider.id()} (${state})`,
        provider: chosenProvider.id(),
        state,
        responseMs,
        synthetic: Boolean(health.synthetic),
        persisted,
      },
    });
    return {
      provider: chosenProvider.id(),
      live: health,
      checkedAt: at,
      responseMs,
      latest: persisted ? await requireStore().latestLotteryHealth(providerId) : null,
      history: persisted ? await requireStore().listLotteryHealth(providerId, 20) : [],
      persisted,
    };
  }

  /** Provider health (spec §32): live status + persisted checks/sync history. */
  async function providerHealth() {
    const health = await chosenProvider.health();
    const pid = await existingProviderRowId();
    const latest = pid !== null ? await requireStore().latestLotteryHealth(pid) : null;
    const history = pid !== null ? await requireStore().listLotteryHealth(pid, 20) : [];
    return { provider: chosenProvider.id(), live: health, latest, history };
  }

  return Object.freeze({
    status,
    drawCount,
    sync,
    importDraws,
    listDraws,
    drawDetail,
    statistics: statisticsOf,
    probeProvider,
    providerHealth,
    registry,
    rules: () => resolveRules().then((r) => ({
      code: r.code(), version: r.version(),
      main: { count: r.mainCount(), min: r.mainMin(), max: r.mainMax() },
      stars: { count: r.starCount(), min: r.starMin(), max: r.starMax() },
      schedule: r.drawSchedule(),
    })),
    provider: chosenProvider,
  });
}
