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
 * `status()` so the gap is stated, not silent (the BC-10 rule). Slice 2 (this
 * record's combination intelligence) landed the four engines and their two
 * persistence tables; the matrix shrinks accordingly.
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
import { createCombinationAnalyzer } from "./combinations.js";
import { createCombinationGenerator } from "./generator.js";
import { createDiversificationEngine } from "./diversification.js";
import { createSystemBuilder, SYNC_LINE_LIMIT } from "./system.js";
import {
  createLotteryBacktester,
  BACKTESTER_STRATEGIES,
  BACKTESTER_MIN_HISTORY,
  BACKTESTER_MAX_WINDOW,
  BACKTESTER_MAX_LINES,
} from "./backtester.js";
import { ANALYZER_WEIGHTS } from "./combinations.js";
import { GENERATOR_MODES } from "./generator.js";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../../http/errors.js";

export const MODEL_VERSION = "1.0";
export const LOTTERY = "EUROMILLIONS";
export const ENGINE_DISABLED = "DISABLED_NO_PROVIDER";
export const ENGINE_ACTIVE = "ACTIVE";

// ── tickets (slice 3) — legacy's constants, verbatim ──────────────────────────

export const MAX_TICKET_LINES = 50;
export const TICKET_METHODS = Object.freeze(["MANUAL", "RANDOM", "BALANCED", "HISTORICAL", "DIVERSIFIED", "ANTI-POPULAR"]);
export const TICKET_STATUS_OPEN = "OPEN";
export const TICKET_STATUS_CHECKED = "CHECKED";
export const TICKET_STATUS_ARCHIVED = "ARCHIVED";

/**
 * Official EuroMillions prize tier structure (a stable rule set — legacy's own
 * `match(true)` ladder, exported pure for the differential harness). Tier
 * LABELS only: prize amounts vary per draw and are NEVER stored or fabricated
 * (spec §29). There is deliberately no amount column anywhere in this module.
 */
export function prizeTier(mainMatches, starMatches) {
  if (mainMatches === 5 && starMatches === 2) return "TIER_1 (5 mains + 2 stars)";
  if (mainMatches === 5 && starMatches === 1) return "TIER_2 (5 mains + 1 star)";
  if (mainMatches === 5) return "TIER_3 (5 mains)";
  if (mainMatches === 4 && starMatches === 2) return "TIER_4 (4 mains + 2 stars)";
  if (mainMatches === 4 && starMatches === 1) return "TIER_5 (4 mains + 1 star)";
  if (mainMatches === 3 && starMatches === 2) return "TIER_6 (3 mains + 2 stars)";
  if (mainMatches === 3 && starMatches === 1) return "TIER_7 (3 mains + 1 star)";
  if (mainMatches === 2 && starMatches === 2) return "TIER_8 (2 mains + 2 stars)";
  if (mainMatches === 1 && starMatches === 2) return "TIER_9 (1 main + 2 stars)";
  if (mainMatches === 0 && starMatches === 2) return "TIER_10 (2 stars)";
  return null;
}

/**
 * The parts of row 15 this port still does not contain, in legacy's own terms.
 * Slice 2 (combination intelligence, tickets, backtests, model versions) empties
 * the middle entries; slice 3 (the cron) removes the jobs entry. The console screens
 * stay until F-29 is lifted platform-wide. Removed, never re-labelled, as entries
 * become untrue.
 */
export const LOTTERY_NOT_PORTED = Object.freeze([
  // Slices 2–4 removed the combination-intelligence, generation-persistence,
  // tickets and backtest/model-version entries: they became untrue, and untrue
  // entries are removed, never re-labelled. What remains is what no slice has
  // landed yet.
  Object.freeze({ area: "scheduled jobs", legacy: "LotteryCronService (sync, health, statistics, systems, tickets, backtests, cleanup)", state: "not ported", detail: "The lottery cron is a later slice, on the same wf_job_locks pattern as the sports cron (row 19). Until then nothing here runs on a schedule — and the queued background system builds have no consumer yet." }),
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
  // Slice 2: the four combination engines. Legacy wires them in its constructor
  // around `storedRules() ?? new EuroMillionsRules()`; the port builds them
  // lazily around the same resolved rules (LT-4 — nothing at construction).
  let combinationEngines = null;
  async function engines() {
    if (!combinationEngines) {
      const rules = await resolveRules();
      const lineAnalyzer = createCombinationAnalyzer(rules, statistics);
      const generator = createCombinationGenerator(rules, lineAnalyzer, statistics, MODEL_VERSION);
      combinationEngines = {
        rules,
        analyzer: lineAnalyzer,
        generator,
        diversification: createDiversificationEngine(rules),
        systemBuilder: createSystemBuilder(rules),
        // Slice 4: the Strategy Lab, wired around the SAME generator instance
        // legacy uses. Its constructor signature is kept — it takes the
        // analyzer its own methods never call.
        backtester: createLotteryBacktester(rules, lineAnalyzer, generator, MODEL_VERSION),
      };
    }
    return combinationEngines;
  }
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

  /** PHP's (int) cast: numeric strings truncate, anything else is 0. */
  function phpIntval(value) {
    const n = Math.trunc(Number(value));
    return Number.isNaN(n) ? 0 : n;
  }

  /** PHP is_numeric for the string ids the routes pass through. */
  function isNumeric(value) {
    if (typeof value === "number") return Number.isFinite(value);
    return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
  }

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

  // ---------------------------------------------------- combination intelligence
  //
  // Slice 2: legacy `LotteryIntelligence` analyzeLine / generate /
  // saveGeneration / diversity / buildSystem / combination reads. Every output
  // keeps legacy's honesty contract: balance scores, never probabilities.

  /** Full statistical profile of one line against stored history (GET /lottery/analyze). */
  async function analyzeLine(mainsIn, starsIn) {
    await ensureRegistered();
    const active = await engines();
    const draws = await requireStore().lotteryDrawsForStats(LOTTERY, 10_000);
    const profile = active.analyzer.analyze(mainsIn.map(phpIntval), starsIn.map(phpIntval), draws);
    const last = draws.length !== 0 ? String(draws[draws.length - 1].drawDate) : null;
    return {
      ...profile,
      lottery: LOTTERY,
      modelVersion: MODEL_VERSION,
      datasetVersion: `n=${draws.length};last=${last ?? "none"}`,
    };
  }

  /**
   * Generate combination lines (spec §14–§17). Returns the full AI combination
   * report + decision report. NOT persisted until saveGeneration is called —
   * the route does both, exactly like legacy's controller.
   */
  async function generate(opts = {}) {
    await ensureRegistered();
    const active = await engines();
    const draws = await requireStore().lotteryDrawsForStats(LOTTERY, 10_000);
    return active.generator.generate(draws, opts);
  }

  /**
   * Persist a generated report: one combination row (lines + constraints) and
   * one AI-decision row (the full report), plus an audit event. Historical
   * results stay connected to their model version (spec §33).
   * @returns {Promise<{combinationId: number, decisionId: number}>}
   */
  async function saveGeneration(report, actor = "system") {
    const store = requireStore();
    const at = nowIso();
    const model = String(report?.model ?? `WINDELS Lottery Model v${MODEL_VERSION}`);
    const mode = String(report?.mode ?? "RANDOM");
    const lines = (Array.isArray(report?.lines) ? report.lines : []).map((l) => ({
      mains: (Array.isArray(l?.mains) ? l.mains : []).map(phpIntval),
      stars: (Array.isArray(l?.stars) ? l.stars : []).map(phpIntval),
      score: l?.score ?? null,
    }));
    const saved = await store.saveLotteryCombination({
      lotteryCode: LOTTERY,
      mode,
      modelVersion: model,
      seed: report?.inputs?.seed !== undefined && report?.inputs?.seed !== null ? String(report.inputs.seed) : null,
      lineCount: lines.length,
      lines,
      constraints: {
        locks: report?.inputs?.locks ?? { mains: [], stars: [] },
        excludes: report?.inputs?.excludes ?? { mains: [], stars: [] },
      },
      scoreSummary: { averageBalanceScore: report?.averageBalanceScore ?? null },
      createdBy: isNumeric(actor) ? Number(actor) : null,
      createdAt: at,
    });
    const combinationId = Number(saved.row.id);
    const decision = await store.saveLotteryAiDecision({
      lotteryCode: LOTTERY,
      combinationId,
      modelVersion: model,
      mode,
      decision: report,
      createdAt: at,
    });
    const decisionId = Number(decision.row.id);
    await recordAudit(
      isNumeric(actor) ? Number(actor) : null,
      "lottery.combination.generated",
      `Generated ${lines.length} combination line(s), mode ${mode}, model ${model}`,
      { combinationId, decisionId, mode, lineCount: lines.length, seed: report?.inputs?.seed ?? null, modelVersion: model },
    );
    return { combinationId, decisionId };
  }

  /** Diversification score for a set of lines (spec §22). */
  async function diversity(lines) {
    const active = await engines();
    return active.diversification.score(Array.isArray(lines) ? lines : []);
  }

  /**
   * Build a system from a main/star pool. Small systems build inline and save;
   * larger ones queue idempotently (execution key) for the lottery cron —
   * which is slice 3, and the queue note says so rather than pointing at a
   * command that does not exist on this platform.
   */
  async function buildSystem(pools, actor = "system") {
    const store = requireStore();
    const active = await engines();
    const plan = active.systemBuilder.plan(pools?.mains ?? [], pools?.stars ?? []);
    if (plan.totalLines <= SYNC_LINE_LIMIT) {
      const lines = active.systemBuilder.allLines(plan.mainPool, plan.starPool);
      return { plan, queued: false, saved: await saveSystem(plan, lines, actor) };
    }
    const key = `system:${LOTTERY}:${createHash("md5").update(`${plan.mainPool.join(",")}|${plan.starPool.join(",")}`).digest("hex")}`;
    const existing = await store.findLotteryJobRunByKey(key);
    if (existing) {
      return { plan, queued: true, run: existing, note: `a system build for this pool is already ${String(existing.status)} (idempotent)` };
    }
    const run = await store.startLotteryJobRun({
      id: randomUUID(),
      jobType: "system",
      executionKey: key,
      payload: { mains: plan.mainPool, stars: plan.starPool, totalLines: plan.totalLines },
    });
    await recordAudit(
      isNumeric(actor) ? Number(actor) : null,
      "lottery.system.queued",
      `System build queued: ${plan.totalLines} lines (${plan.formula})`,
      { executionKey: key, totalLines: plan.totalLines },
    );
    return {
      plan,
      queued: true,
      run,
      note: "background build queued — the lottery cron that processes it is not ported yet (slice 3); nothing consumes this queue today",
    };
  }

  /** Persist a built system (inline or from a future background job) as a SYSTEM combination row. */
  async function saveSystem(plan, lines, actor = "system") {
    const store = requireStore();
    const row = await store.saveLotteryCombination({
      lotteryCode: LOTTERY,
      mode: "SYSTEM",
      modelVersion: `WINDELS Lottery Model v${MODEL_VERSION}`,
      seed: null,
      lineCount: lines.length,
      lines,
      constraints: { type: "system", mainPool: plan.mainPool, starPool: plan.starPool },
      scoreSummary: { totalLines: lines.length, formula: plan.formula },
      createdBy: isNumeric(actor) ? Number(actor) : null,
      createdAt: nowIso(),
    });
    const combinationId = Number(row.row.id);
    await recordAudit(
      isNumeric(actor) ? Number(actor) : null,
      "lottery.system.built",
      `System built and saved: ${lines.length} lines (${plan.formula})`,
      { combinationId, totalLines: lines.length },
    );
    return { combinationId };
  }

  /**
   * The raw system plan (spec §19) — what the controller route exposes per page.
   * Separated from buildSystem so a paginated interactive read never writes.
   */
  async function systemPlan(mainPoolIn, starPoolIn) {
    const active = await engines();
    return active.systemBuilder.plan(mainPoolIn, starPoolIn);
  }

  /** One paginated window over the lazy line enumeration (spec §18). */
  async function systemPage(mains, stars, offset, limit) {
    const active = await engines();
    return active.systemBuilder.page(mains, stars, offset, limit);
  }

  /** Persisted generations, newest first. */
  async function listCombinations(limit = 50, offset = 0) {
    return requireStore().listLotteryCombinations(limit, offset);
  }

  /** One combination with its (latest five) decision reports. */
  async function combinationDetail(id) {
    const store = requireStore();
    const row = await store.findLotteryCombination(id);
    if (!row || row.lottery_code !== LOTTERY) return null;
    row.decisions = await store.listLotteryAiDecisions(Number(row.id), 5);
    return row;
  }

  /** Persisted decision reports, newest first, this lottery only. */
  async function listDecisions(combinationId = null, limit = 50) {
    const store = requireStore();
    const bounded = Math.min(200, Math.max(1, Math.trunc(Number(limit)) || 50));
    const rows = await store.listLotteryAiDecisions(combinationId, 500);
    return rows.filter((row) => (row.lottery_code ?? null) === LOTTERY).slice(0, bounded);
  }

  /** Full persisted decision report. */
  async function decisionDetail(id) {
    const store = requireStore();
    const row = await store.findLotteryAiDecision(id);
    if (!row || (row.lottery_code ?? null) !== LOTTERY) return null;
    return row;
  }

  // ---------------------------------------------------------- saved tickets
  //
  // Slice 3: legacy `LotteryIntelligence` ticket methods. A ticket on this
  // platform is a RECORD of number lines a user chose or generated — never a
  // purchase, never a wager. Checking compares the lines against the stored
  // VERIFIED draw and records official prize-tier LABELS; amounts vary per
  // draw and are never stored or fabricated (spec §29).

  /**
   * Create a named, user-scoped ticket. EVERY line is validated against the
   * rules before anything is stored — one bad line rejects the whole ticket.
   * Lines are normalized (sorted) on save, exactly as legacy normalizes them.
   */
  async function createTicket(userId, name, linesIn, method = "MANUAL", drawDate = null, modelVersion = null, configuration = {}) {
    const store = requireStore();
    const ticketMethod = String(method ?? "MANUAL").toUpperCase();
    if (!TICKET_METHODS.includes(ticketMethod)) throw new TypeError(`unknown generation method: ${ticketMethod}`);
    if (String(name ?? "").trim() === "") throw new TypeError("ticket name is required");
    const lines = Array.isArray(linesIn) ? linesIn : [];
    if (lines.length === 0) throw new TypeError("at least one line is required");
    if (lines.length > MAX_TICKET_LINES) throw new TypeError(`a ticket holds at most ${MAX_TICKET_LINES} lines`);
    if (drawDate !== null && drawDate !== undefined && drawDate !== "") {
      // Legacy: DateTimeImmutable::createFromFormat('Y-m-d') + a format round-trip,
      // refusing with ITS OWN string (not the validator's) — this is a caller
      // argument, not a stored draw.
      const text = String(drawDate);
      const at = new Date(`${text}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== text) {
        throw new TypeError(`invalid draw date: ${text}`);
      }
    }
    const active = await engines();
    const validated = lines.map((line, i) => {
      const mains = Array.isArray(line?.mains) ? [...line.mains] : [];
      const stars = Array.isArray(line?.stars) ? [...line.stars] : [];
      const check = active.rules.validateLine(mains, stars);
      if (!check.valid) throw new TypeError(`line ${i + 1} invalid: ${check.errors.join("; ")}`);
      mains.sort((a, b) => a - b);
      stars.sort((a, b) => a - b);
      return { mains, stars };
    });
    const at = nowIso();
    const saved = await store.saveLotteryTicket({
      userId,
      lotteryCode: LOTTERY,
      name: String(name),
      drawDate: drawDate ?? null,
      generationMethod: ticketMethod,
      modelVersion: modelVersion ?? "MANUAL",
      configuration: configuration && typeof configuration === "object" ? configuration : {},
      status: TICKET_STATUS_OPEN,
      result: null,
      createdAt: at,
      updatedAt: at,
    });
    const ticketId = Number(saved.row.id);
    await store.saveLotteryTicketLines(ticketId, validated);
    await recordAudit(
      typeof userId === "number" ? userId : null,
      "lottery.ticket.created",
      `Ticket "${String(name)}" created with ${validated.length} line(s)`,
      { ticketId, userId, method: ticketMethod, lineCount: validated.length },
    );
    return { ...saved.row, lines: await store.listLotteryTicketLines(ticketId) };
  }

  /** The caller's own tickets (spec §38 — never other users'). */
  async function listMyTickets(userId, limit = 50) {
    return requireStore().listLotteryTickets(userId, limit);
  }

  /** One ticket with its lines; user-scoped when userId is given (admin/system passes null). */
  async function ticketDetail(id, userId = null) {
    const store = requireStore();
    const row = await store.findLotteryTicket(id, userId);
    if (!row || row.lottery_code !== LOTTERY) return null;
    row.lines = await store.listLotteryTicketLines(Number(row.id));
    return row;
  }

  /**
   * Compare a ticket's lines against the stored draw for its draw date — the
   * latest VERIFIED draw on or before that date (latest overall when the ticket
   * has no date). Marks the ticket CHECKED with per-line matches + official
   * prize tier LABELS (no amounts). User-scoped: only the owner (or system)
   * can check. null = not found / not the owner.
   */
  async function checkTicket(ticketId, userId = null, actor = "system") {
    const store = requireStore();
    const ticket = await store.findLotteryTicket(ticketId, userId);
    if (!ticket || ticket.lottery_code !== LOTTERY) return null;
    const drawFilter = { lotteryCode: LOTTERY, verificationStatus: "VERIFIED" };
    if (ticket.draw_date) drawFilter.to = String(ticket.draw_date);
    const draws = await store.listLotteryDraws(drawFilter, 1);
    if (draws.length === 0) {
      return {
        ticketId,
        status: "NO_DRAW",
        note: `no stored VERIFIED draw on or before ${ticket.draw_date ? String(ticket.draw_date) : "the latest draw"}`,
      };
    }
    const draw = draws[0];
    const drawPayload = draw.payload && typeof draw.payload === "object" ? draw.payload : {};
    const drawMains = new Set((drawPayload.main ?? []).map(phpIntval));
    const drawStars = new Set((drawPayload.stars ?? []).map(phpIntval));
    const lines = await store.listLotteryTicketLines(Number(ticket.id));
    const lineResults = lines.map((line) => {
      const mainMatches = (line.mains ?? []).filter((m) => drawMains.has(phpIntval(m))).length;
      const starMatches = (line.stars ?? []).filter((st) => drawStars.has(phpIntval(st))).length;
      return {
        mains: line.mains ?? [],
        stars: line.stars ?? [],
        mainMatches,
        starMatches,
        prizeTier: prizeTier(mainMatches, starMatches),
      };
    });
    const result = {
      drawDate: String(draw.draw_date),
      drawExternalId: String(draw.external_id),
      drawSource: String(draw.source),
      lines: lineResults,
      checkedAt: nowIso(),
      note: "Prize tiers follow the official EuroMillions structure; amounts vary per draw and are not stored. These are ACTUAL ticket outcomes — kept separate from backtest results and demo data (spec §30).",
    };
    await store.updateLotteryTicket(Number(ticket.id), {
      status: TICKET_STATUS_CHECKED,
      result: JSON.stringify(result),
      updated_at: nowIso(),
    });
    await recordAudit(
      typeof actor === "number" ? actor : isNumeric(actor) ? Number(actor) : null,
      "lottery.ticket.checked",
      `Ticket ${ticketId} checked against draw ${String(draw.draw_date)}`,
      { ticketId, drawDate: String(draw.draw_date) },
    );
    return { ...result, ticketId, status: TICKET_STATUS_CHECKED };
  }

  /** Archive (soft delete) — user-scoped. */
  async function archiveTicket(ticketId, userId = null, actor = "system") {
    const store = requireStore();
    const ticket = await store.findLotteryTicket(ticketId, userId);
    if (!ticket || ticket.lottery_code !== LOTTERY) return false;
    await store.updateLotteryTicket(Number(ticket.id), {
      status: TICKET_STATUS_ARCHIVED,
      updated_at: nowIso(),
    });
    await recordAudit(
      typeof actor === "number" ? actor : isNumeric(actor) ? Number(actor) : null,
      "lottery.ticket.archived",
      `Ticket ${ticketId} archived`,
      { ticketId },
    );
    return true;
  }

  // ── slice 4: the measured half (spec §23/§24/§25/§30/§33) ──────────────────

  /**
   * Model versioning (spec §33): the model row records name, version and the
   * full statistical configuration. It is ensured once and never deleted or
   * replaced — historical results stay connected to the model that produced
   * them. Idempotent: repeated calls return the same row.
   */
  async function ensureModelVersion() {
    const store = requireStore();
    const config = {
      model: `WINDELS Lottery Model v${MODEL_VERSION}`,
      scoreWeights: ANALYZER_WEIGHTS,
      generatorModes: GENERATOR_MODES,
      backtesterStrategies: BACKTESTER_STRATEGIES,
      backtester: {
        minHistory: BACKTESTER_MIN_HISTORY,
        maxWindow: BACKTESTER_MAX_WINDOW,
        maxLines: BACKTESTER_MAX_LINES,
      },
    };
    return store.ensureLotteryModelVersion({
      modelName: "WINDELS Lottery Model",
      modelVersion: MODEL_VERSION,
      config,
      datasetVersion: null,
      status: "ACTIVE",
      createdAt: nowIso(),
    });
  }

  /** Every known model version, oldest first (ensuring the current one exists first). */
  async function modelVersions() {
    await ensureModelVersion();
    return requireStore().listLotteryModelVersions();
  }

  /**
   * spec §23: replay one strategy over the stored draws WITHOUT look-ahead,
   * persist the HISTORICAL SIMULATION report (audited, model-stamped) and
   * return it with the saved row id. Unknown strategy or insufficient history
   * is a TypeError — the route answers 400.
   */
  async function backtest(strategy, lines = 1, window = 0) {
    const store = requireStore();
    await ensureModelVersion();
    const active = await engines();
    const draws = await store.lotteryDrawsForStats(LOTTERY, 100_000);
    const report = active.backtester.run(draws, String(strategy), lines, window);
    const saved = await persistBacktest(String(strategy), report, draws);
    return { ...report, saved: { backtestId: Number(saved.row.id) } };
  }

  /**
   * spec §24: strategy comparison on the SAME period, the random baseline
   * mandatory (spec §25), no strategy declared "better" (spec §34). Persisted
   * like any other backtest row, under the COMPARISON stamp.
   */
  async function backtestCompare(strategies, lines = 1, window = 0) {
    const store = requireStore();
    await ensureModelVersion();
    const active = await engines();
    const draws = await store.lotteryDrawsForStats(LOTTERY, 100_000);
    const report = active.backtester.compare(draws, Array.isArray(strategies) ? strategies : [], lines, window);
    const saved = await persistBacktest("COMPARISON", report, draws);
    return { ...report, saved: { backtestId: Number(saved.row.id) } };
  }

  async function persistBacktest(strategy, report, draws) {
    const store = requireStore();
    const last = draws.length > 0 ? String(draws[draws.length - 1].drawDate) : "none";
    const row = await store.saveLotteryBacktest({
      lotteryCode: LOTTERY,
      strategy,
      modelVersion: MODEL_VERSION,
      linesPerDraw: Number(report.linesPerDraw),
      drawsTested: Number(report.period.drawsTested),
      periodFrom: String(report.period.from),
      periodTo: String(report.period.to),
      datasetVersion: `n=${draws.length};last=${last}`,
      report,
      createdAt: nowIso(),
    });
    const id = Number(row.row.id);
    await recordAudit(
      null,
      "lottery.backtest.run",
      `Backtest ${strategy} over ${report.period.drawsTested} draws saved (id ${id})`,
      { backtestId: id, strategy, modelVersion: MODEL_VERSION },
    );
    return row;
  }

  /** Persisted backtests, newest first, report decoded. */
  async function listBacktests(limit = 50) {
    return requireStore().listLotteryBacktests(limit);
  }

  async function backtestDetail(id) {
    const row = await requireStore().findLotteryBacktest(id);
    if (!row || row.lottery_code !== LOTTERY) return null;
    return row;
  }

  /**
   * Performance overview (spec §30): ACTUAL ticket results, HISTORICAL
   * backtest results and DEMO/SANDBOX data — three separate sections that
   * are never mixed. Prize tiers only; official amounts are never stored.
   */
  async function performance() {
    const store = requireStore();
    const tickets = await store.listAllLotteryTickets(200);
    const checked = tickets.filter((t) => (t.status ?? "") === TICKET_STATUS_CHECKED);
    const byTier = {};
    let linesChecked = 0;
    for (const t of checked) {
      const res = t.result && typeof t.result === "object" ? t.result : {};
      for (const ln of Array.isArray(res.lines) ? res.lines : []) {
        linesChecked += 1;
        if (ln?.prizeTier) byTier[ln.prizeTier] = (byTier[ln.prizeTier] ?? 0) + 1;
      }
    }
    const sortedEntries = Object.entries(byTier).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sortedTiers = sortedEntries.length > 0 ? Object.fromEntries(sortedEntries) : [];
    const backtests = await store.listLotteryBacktests(500);
    const recentBacktests = backtests.slice(0, 5).map((b) => ({
      id: Number(b.id),
      strategy: String(b.strategy),
      modelVersion: String(b.model_version),
      drawsTested: Number(b.draws_tested),
      periodFrom: b.period_from,
      periodTo: b.period_to,
      createdAt: String(b.created_at),
    }));
    const health = chosenProvider.health();
    return {
      lottery: LOTTERY,
      label: "PERFORMANCE OVERVIEW — sections are separate and never mixed (spec §30)",
      actualTicketResults: {
        section: "ACTUAL TICKET RESULTS",
        ticketsTotal: tickets.length,
        ticketsChecked: checked.length,
        linesChecked,
        byTier: sortedTiers,
        recent: tickets.slice(0, 5).map((t) => ({
          id: Number(t.id),
          name: String(t.name),
          status: String(t.status),
          drawDate: t.draw_date ?? null,
          checkedAt: t.result && typeof t.result === "object" ? (t.result.checkedAt ?? null) : null,
        })),
        note: "Outcomes of saved tickets checked against stored VERIFIED draws. Prize tiers only — official amounts are never stored.",
      },
      historicalBacktestResults: {
        section: "HISTORICAL BACKTEST RESULTS",
        count: backtests.length,
        recent: recentBacktests,
        note: "HISTORICAL SIMULATION of strategies over past draws without look-ahead. Descriptive only — the random baseline is always available for comparison.",
      },
      demoSandboxData: {
        section: "DEMO / SANDBOX DATA",
        provider: chosenProvider.id(),
        synthetic: Boolean(health?.synthetic ?? false),
        state: health?.state ?? "UNKNOWN",
        drawsTracked: await store.countLotteryDraws(LOTTERY),
        note: "Sandbox simulation draws are clearly labeled synthetic and are never presented as official results.",
      },
      separationNote: "ACTUAL ticket results, HISTORICAL backtest results and DEMO/SANDBOX data are reported separately and are never mixed (spec §30).",
      disclaimer: DISCLAIMER,
    };
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
    analyzeLine,
    generate,
    saveGeneration,
    diversity,
    buildSystem,
    saveSystem,
    systemPlan,
    systemPage,
    listCombinations,
    combinationDetail,
    listDecisions,
    decisionDetail,
    createTicket,
    listMyTickets,
    ensureModelVersion,
    modelVersions,
    backtest,
    backtestCompare,
    listBacktests,
    backtestDetail,
    performance,
    ticketDetail,
    checkTicket,
    archiveTicket,
    rules: () => resolveRules().then((r) => ({
      code: r.code(), version: r.version(),
      main: { count: r.mainCount(), min: r.mainMin(), max: r.mainMax() },
      stars: { count: r.starCount(), min: r.starMin(), max: r.starMax() },
      schedule: r.drawSchedule(),
    })),
    provider: chosenProvider,
  });
}
