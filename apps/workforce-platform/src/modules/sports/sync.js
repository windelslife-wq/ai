/**
 * Idempotent sports ingestion — the port of `Aegis\Sports\SportsSyncService`.
 *
 * Legacy's summary is the whole design in one line: *"Idempotent fixture ingestion.
 * Provider exceptions and malformed records are counted, never hidden."* Both halves
 * are load-bearing and both are easy to lose in a rewrite, so they are stated here as
 * the two rules this file exists to keep:
 *
 *  1. **Idempotent by execution key, not by intent.** Every entry point takes an
 *     `executionKey` and hands it to `startSportsSync`, whose UNIQUE constraint is the
 *     arbiter. A cron job that fires twice for one window, or a retry after a timeout,
 *     cannot ingest the same data twice — and the second caller is told
 *     `DUPLICATE_SKIPPED` rather than being allowed to believe it did the work.
 *  2. **A refusal is a recorded record, not a lost one.** One malformed fixture out of
 *     forty does not fail the run; it increments `invalid`, appends its message to
 *     `errors`, and the run still completes — because the alternative (aborting) hides
 *     the thirty-nine that were fine and tells the operator nothing about the one that
 *     was not. Conversely a *provider-level* failure — not `ONLINE`, or a fixture that
 *     was never synchronized — fails the whole run, because there is no partial answer
 *     to give.
 *
 * **Every run is written to `wf_sports_sync_runs` before the work starts and closed
 * afterwards, whatever happens.** That is what makes a `RUNNING` row that never
 * finished evidence of a worker that died, rather than a gap nobody can explain.
 * Legacy does the same, and it is the reason `finishSportsSync` sits outside the
 * `try`/`catch` here rather than inside it.
 *
 * Divergences from legacy are marked inline and collected in
 * `docs/migration/PHASE16_SPORTS_PERSISTENCE.md`.
 */

import { randomUUID } from "node:crypto";
import { normalizeFixture, normalizeOdds } from "./normalizer.js";
import { normalizeResult } from "./result-normalizer.js";
import { assessQuality } from "./quality.js";

/** Legacy truncates each stored error message to 200 characters with `mb_substr`. */
const ERROR_MESSAGE_LIMIT = 200;

/**
 * The sentinel legacy appends when a provider returns **no odds at all**.
 *
 * Verbatim, because it is operator-facing text stored in the run's `errors` array and
 * shown by the sync-runs route. Note what it implies about the run's status: an empty
 * odds response is `COMPLETED`, not `FAILED` — the call succeeded and returned nothing,
 * which is a different fact from a call that broke. But it is recorded, because a
 * completed odds sync that stored zero rows is exactly the circumstance under which a
 * ticket must not be generated, and a bare `processed: 0` in a counter column is too
 * quiet a way to say it.
 */
export const NO_ODDS_SENTINEL = "provider returned no odds; no odds-dependent ticket may be generated";

/** The two provider-level refusals that fail a whole run. Also verbatim from legacy. */
export const PROVIDER_NOT_ONLINE = "provider is not ONLINE";
export const FIXTURE_NOT_SYNCED = "fixture is not synchronized for this provider";

/**
 * Audit action names.
 *
 * Legacy emits `SPORTS_FIXTURE_SYNC_COMPLETED` and five siblings. This port uses the
 * platform's dotted-lowercase vocabulary (`execution.proposal.expired`,
 * `notification.published`) because the audit browser filters on these strings: one
 * event type spelled two ways is two event types to anyone building a filter, and every
 * console this platform has — the audit browser included — filters on these strings.
 * The screens still missing are sports' own (**F-29**). Divergence SP-24.
 */
export const SYNC_AUDIT_ACTIONS = Object.freeze({
  FIXTURES_COMPLETED: "sports.sync.fixtures.completed",
  FIXTURES_FAILED: "sports.sync.fixtures.failed",
  ODDS_COMPLETED: "sports.sync.odds.completed",
  ODDS_FAILED: "sports.sync.odds.failed",
  RESULTS_COMPLETED: "sports.sync.results.completed",
  RESULTS_FAILED: "sports.sync.results.failed",
});

function truncate(text) {
  return String(text ?? "").slice(0, ERROR_MESSAGE_LIMIT);
}

/**
 * @param {object} options
 * @param {object} options.store the composed store (the 22 `…Sports…` methods)
 * @param {object} [options.providers] the provider manager, for status reporting only
 * @param {number|null} [options.actorId] the operator who triggered the run, or `null`
 *   for a scheduled one. Phase 10's audit attribution reports a `null` actor as
 *   `kind: "system"` rather than borrowing an identity, so a cron sync is never
 *   recorded as though a human ran it.
 * @param {() => number} [options.now] injectable clock, epoch milliseconds
 * @param {() => string} [options.uuid] injectable run-id generator
 */
export function createSportsSyncService({
  store,
  providers = null,
  actorId = null,
  now = () => Date.now(),
  uuid = () => randomUUID(),
} = {}) {
  if (!store) throw new TypeError("createSportsSyncService requires a store");

  /**
   * The shared skeleton: open a run, do the work, close the run, record it.
   *
   * `body` receives the provider row and returns `{result}` — it never throws for an
   * expected outcome, because the caller has to distinguish "the run failed" from "the
   * run was a duplicate".
   */
  async function runSync({ jobType, executionKey, provider, auditBase, body }) {
    // Legacy passes `$provider->id()` as BOTH the code and the display name, so a
    // provider's human-readable name is its identifier. Preserved rather than
    // improved: inventing a prettier display name here would make this row disagree
    // with the health history and sync runs already attached to the same id, and a
    // rename is an operator's decision, not an ingestion side effect.
    const source = await store.ensureSportsProvider(provider.id(), provider.id());
    const providerId = Number(source?.id ?? 0);
    const run = { id: uuid(), providerId, jobType, executionKey };

    const opened = await store.startSportsSync(run);
    if (opened === null) {
      // No `runId`, no `finishSync`, and **no audit event** — exactly as legacy
      // returns. A duplicate is not an occurrence worth an audit row: the original run
      // already has one, and emitting a second would double-count every retry in a
      // filter built on these actions.
      return { status: "DUPLICATE_SKIPPED", executionKey };
    }

    let result;
    try {
      result = await body({ provider, source, providerId });
    } catch (error) {
      result = {
        status: "FAILED",
        processed: 0,
        created: 0,
        updated: 0,
        errors: [truncate(error?.message || error)],
      };
    }

    // Outside the try: the run must be closed whatever happened inside it.
    await store.finishSportsSync(run.id, result);
    await store.recordAudit({
      actorId,
      action: result.status === "COMPLETED" ? auditBase.completed : auditBase.failed,
      entityType: "sports_sync_run",
      entityId: run.id,
      details: { ...auditBase.details, jobType, executionKey, result },
    });

    return { runId: run.id, ...result };
  }

  /**
   * Fetch one fixture's worth of records, refusing a provider that is not `ONLINE`.
   *
   * The health gate is checked *after* the observation is persisted, so a provider
   * that reports `RATE_LIMITED` still leaves a health row behind — the evidence of why
   * the run failed. Gating first would discard exactly the observation that explains
   * the failure.
   */
  async function gate({ provider, providerId, jobType, persistHealth }) {
    const health = await provider.health();
    const status = typeof health?.status === "string" && health.status !== "" ? health.status : "DATA_ERROR";
    if (persistHealth) {
      // `array_merge($health, ['status' => $health['status'] ?? 'DATA_ERROR'])`:
      // the observation is stored with the fallback status applied, so a health row
      // can never hold an empty status that the monitor would then have to guess at.
      await store.saveSportsHealth(providerId, { ...health, status });
    }
    if (status !== "ONLINE") throw new Error(PROVIDER_NOT_ONLINE);
    return health;
  }

  /**
   * Ingest fixtures for a query window, scoring each one as it lands.
   *
   * @param {object} provider a registered sports provider
   * @param {Record<string, unknown>} query the provider's fixture query
   * @param {string} executionKey the idempotency key for this window
   */
  async function syncFixtures(provider, query, executionKey) {
    return runSync({
      jobType: "FIXTURES",
      executionKey,
      provider,
      auditBase: {
        completed: SYNC_AUDIT_ACTIONS.FIXTURES_COMPLETED,
        failed: SYNC_AUDIT_ACTIONS.FIXTURES_FAILED,
        details: { provider: provider.id() },
      },
      body: async ({ providerId }) => {
        let created = 0;
        let updated = 0;
        let processed = 0;
        const errors = [];
        try {
          const health = await gate({ provider, providerId, jobType: "FIXTURES", persistHealth: true });
          const reliability = Number(health?.reliability ?? 0);
          for (const raw of await provider.fixtures(query)) {
            processed += 1;
            try {
              const match = normalizeFixture(raw, provider.id(), { now });
              const existing = await store.saveSportsMatch(providerId, match);
              // The repository upserts, so the row itself says which happened: an
              // insert stamps `created_at` and `updated_at` to the same instant.
              //
              // Divergence SP-13: legacy's insert branch returned a row WITHOUT
              // `created_at`, so this test could never be true and **every newly
              // stored fixture was counted as an update** — a first sync of twelve
              // fixtures reported `created: 0, updated: 12`. The comparison below is
              // unchanged; what changed is that the repository now returns the column
              // it really wrote. These counters are operator evidence in
              // `wf_sports_sync_runs`, and false evidence is worse than divergent
              // evidence.
              if (existing?.created_at && existing.created_at === existing.updated_at) created += 1;
              else updated += 1;

              // Scored at sync time with `oddsAvailable: false` and
              // `recentFormAvailable: false`, exactly as legacy does — because at this
              // moment neither is true.
              //
              // Divergence SP-22, and the consequence is worth stating plainly: the
              // odds check is worth 18 of the 108 points, so a fixture synced without
              // a separate odds sync can score at most 90, and `eligibleForTicket`
              // (which additionally requires `freshnessScore > 0`) is **always false
              // here**. Ingesting fixtures can therefore never, on its own, make a
              // fixture eligible to be staked on. That is the gate working, not a bug:
              // ticket eligibility requires an odds observation that this call does
              // not have.
              const assessment = assessQuality(match, {
                oddsAvailable: false,
                recentFormAvailable: false,
                providerReliability: Number.isFinite(reliability) ? reliability : 0,
                dataAgeSeconds: 0,
              });
              await store.saveSportsQuality(Number(existing?.id ?? 0), assessment);
            } catch (error) {
              errors.push(truncate(error?.message || error));
            }
          }
          return { status: "COMPLETED", processed, created, updated, errors };
        } catch (error) {
          // A provider-level failure keeps the counters it had reached, so a run that
          // stored four fixtures before the provider dropped says so rather than
          // reporting zero work done.
          return {
            status: "FAILED",
            processed,
            created,
            updated,
            errors: [truncate(error?.message || error)],
          };
        }
      },
    });
  }

  /**
   * Ingest odds for one already-synchronized fixture.
   *
   * Odds are appended, never upserted: each observation is a row at an instant, which
   * is what makes `findSportsOddsBefore` able to answer "what did we know then" for
   * slice 5's backtester.
   */
  async function syncOdds(provider, fixtureExternalId, executionKey) {
    return runSync({
      jobType: "ODDS",
      executionKey,
      provider,
      auditBase: {
        completed: SYNC_AUDIT_ACTIONS.ODDS_COMPLETED,
        failed: SYNC_AUDIT_ACTIONS.ODDS_FAILED,
        details: { provider: provider.id(), fixture: fixtureExternalId },
      },
      body: async ({ providerId }) => {
        let processed = 0;
        let invalid = 0;
        const errors = [];
        try {
          await gate({ provider, providerId, jobType: "ODDS", persistHealth: true });
          const match = await store.findSportsMatch(providerId, fixtureExternalId);
          if (!match) throw new Error(FIXTURE_NOT_SYNCED);
          const matchId = Number(match.id);

          for (const raw of await provider.odds(fixtureExternalId)) {
            processed += 1;
            try {
              await store.saveSportsOdds(matchId, providerId, normalizeOdds(raw, provider.id(), { now }));
            } catch (error) {
              invalid += 1;
              errors.push(truncate(error?.message || error));
            }
          }
          if (processed === 0) errors.push(NO_ODDS_SENTINEL);
          // `created` is the number that actually stored; odds are never updates, so
          // `updated` stays 0 — a second observation of one market is a second row.
          return { status: "COMPLETED", processed, created: processed - invalid, updated: 0, errors };
        } catch (error) {
          return { status: "FAILED", processed, created: 0, updated: 0, errors: [truncate(error?.message || error)] };
        }
      },
    });
  }

  /**
   * Ingest results for one already-synchronized fixture.
   *
   * **Ingestion reports; it does not verify.** Every stored row lands with
   * `verified: false` and there is no code path here that sets it — verification is a
   * separate, separately-authorized step (`sports.settle`) belonging to slice 5, and
   * settlement and calibration both read the flag rather than trusting this method.
   *
   * Divergence SP-21, preserved: unlike the other two, legacy's `syncResults` calls
   * `provider->health()` and gates on it but **never persists the observation**. So a
   * results-only run leaves no health row behind, and a provider that is only ever
   * used for results would show as `UNKNOWN` to the health monitor forever. Kept as it
   * is, because silently adding a write would change what the monitor sees for every
   * existing deployment; recorded here so the gap is a decision rather than an
   * oversight.
   */
  async function syncResults(provider, fixtureExternalId, executionKey) {
    return runSync({
      jobType: "RESULTS",
      executionKey,
      provider,
      auditBase: {
        completed: SYNC_AUDIT_ACTIONS.RESULTS_COMPLETED,
        failed: SYNC_AUDIT_ACTIONS.RESULTS_FAILED,
        details: { provider: provider.id(), fixture: fixtureExternalId },
      },
      body: async ({ providerId }) => {
        let processed = 0;
        const errors = [];
        try {
          await gate({ provider, providerId, jobType: "RESULTS", persistHealth: false });
          const match = await store.findSportsMatch(providerId, fixtureExternalId);
          if (!match) throw new Error(FIXTURE_NOT_SYNCED);
          const matchId = Number(match.id);

          for (const raw of await provider.results(fixtureExternalId)) {
            processed += 1;
            try {
              await store.saveSportsResult(matchId, providerId, normalizeResult(raw, provider.id()));
            } catch (error) {
              errors.push(truncate(error?.message || error));
            }
          }
          // Legacy counts `created` as `processed - count(errors)` and leaves `updated`
          // at 0, even though `saveSportsResult` upserts — so a corrected scoreline is
          // reported as a creation. Preserved: the number is "records that stored
          // without a refusal", which is what an operator comparing `processed` against
          // `created` needs, and redefining it here would make the two job types'
          // counters mean different things in the same column.
          return { status: "COMPLETED", processed, created: processed - errors.length, updated: 0, errors };
        } catch (error) {
          return { status: "FAILED", processed, created: 0, updated: 0, errors: [truncate(error?.message || error)] };
        }
      },
    });
  }

  return Object.freeze({
    syncFixtures,
    syncOdds,
    syncResults,
    /** Exposed so the routes can list what this service can be asked to do. */
    jobTypes: Object.freeze(["FIXTURES", "ODDS", "RESULTS"]),
    providers,
  });
}
