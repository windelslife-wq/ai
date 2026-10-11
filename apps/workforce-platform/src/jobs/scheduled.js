/**
 * Scheduled operations jobs (row 19 of docs/migration/UNFINISHED_MODULES.md).
 *
 * Ports `Tools::cron()` (`application/controllers/Tools.php:104`), the every-minute
 * worker the legacy platform ran from cPanel cron:
 *
 *   * * * * * php /path/to/index.php tools cron >> /var/log/aegis-cron.log 2>&1
 *
 * and the `PortfolioRiskMonitor::scan()` / `recordTransitions()` pair behind it
 * (`application/libraries/Aegis/Portfolio/PortfolioRiskMonitor.php`).
 *
 * Two jobs, in the legacy order:
 *
 *  1. **Portfolio risk sweep** — every paper account across every owner, scanned
 *     with the ported risk logic, reduced to alerts with stable keys, diffed against
 *     the keys persisted by the last run. Only **transitions** are audited and
 *     notified, so a breach that persists for a week produces one alert rather than
 *     ten thousand. This is the publisher Phase 9 declared and could not wire:
 *     `PORTFOLIO_RISK` was on the NV-6 list of notification types with no publisher
 *     because the monitor's transition memory did not exist yet.
 *  2. **Stale proposal expiry** — `execution.expireStaleProposals()`, the cross-owner
 *     sweep ported from `ExecutionSupervisor::expireStaleProposals()`.
 *
 * Then one `system.job.run` audit event as the **system** actor, exactly as legacy
 * emitted `CRON_RUN` with actor `'system'`.
 *
 * ## What is deliberately not here
 *
 * **Broker transition detection.** Legacy `brokerAlerts()` raised
 * `BROKER_DISCONNECTED` / `BROKER_CONNECTED` on READY↔DOWN transitions. The brokers
 * module is `not-ported` (row 13), so there is no connector registry to observe.
 * Emitting those alerts against a stub would be a fabricated integration, which the
 * migration plan forbids; they stay on the NV-6 unpublished list until row 13 lands.
 *
 * **`sports_cron` and `lottery_cron`** belong to rows 14 and 15, both `not-ported`.
 *
 * **A persistent worker.** There is no loop, no timer and no `setInterval` here: the
 * platform runs on cPanel/Passenger, which does not guarantee a long-lived process,
 * so scheduling belongs to the host's cron and this module is a short-lived entry
 * point that runs once and exits.
 *
 * ## Concurrency
 *
 * The whole run holds a `wf_job_locks` row (migration 010). Row 19 required the lock
 * *before* the next job that writes, and this one writes: it expires proposals,
 * publishes notifications and persists the transition memory. The lock's TTL must
 * exceed the run's worst case, and the summary reports both so a mismatch is visible
 * in the cron log rather than silent.
 */

import { PORTFOLIO_RISK_STATE_KEY } from "../db/job-repository.js";

/** Lock name for the whole operations run. */
export const OPERATIONS_JOB_NAME = "operations.cron";

/** Legacy action keys, preserved in `details.legacyAction` so the PHP and Node trails correlate. */
export const LEGACY_ACTIONS = Object.freeze({
  cronRun: "CRON_RUN",
  riskAlert: "PORTFOLIO_RISK_ALERT",
  riskCleared: "PORTFOLIO_RISK_CLEARED",
});

/** Node's dotted audit vocabulary for the same events. */
export const AUDIT_ACTIONS = Object.freeze({
  cronRun: "system.job.run",
  riskAlert: "portfolio.risk.alert",
  riskCleared: "portfolio.risk.cleared",
});

/** The notification type Phase 9 declared and this module finally publishes (NV-6). */
export const PORTFOLIO_RISK_NOTIFICATION_TYPE = "PORTFOLIO_RISK";

/**
 * Alert severities, most severe first.
 *
 * Legacy sorted with a tuple comparison on `[severity, code]`, which orders severity
 * **alphabetically** — `critical` before `warning` before `info`. That coincides with
 * importance for exactly the three severities in use, so an explicit rank gives the
 * same order without depending on the alphabet. Recorded as divergence SJ-6.
 */
const SEVERITY_RANK = Object.freeze({ critical: 0, warning: 1, info: 2 });

/**
 * Severity for one of the paper scan's breach codes.
 *
 * The rule is not arbitrary: a breach that means **money is outside its limit** is
 * `critical`, matching legacy's at-limit severities, while a breach that means **the
 * measurement itself is untrustworthy** is `warning`, matching legacy's `SCAN_FAILED`.
 * An operator who gets a `critical` at 3 a.m. should be able to assume capital is at
 * risk rather than that a quote failed to load.
 */
export const CRITICAL_BREACH_CODES = Object.freeze(new Set([
  "NON_POSITIVE_EQUITY",
  "OPEN_POSITION_LIMIT",
  "DAILY_LOSS_LIMIT",
  "WEEKLY_LOSS_LIMIT",
  "DRAWDOWN_LIMIT",
  "PORTFOLIO_EXPOSURE_LIMIT",
  "SYMBOL_EXPOSURE_LIMIT",
]));

/**
 * Breaches meaning the *measurement* is untrustworthy rather than that capital is
 * outside a limit.
 *
 * Listed explicitly rather than treated as "everything else", so a code added to the
 * paper scan later has to be classified here deliberately. `test/scheduled_jobs.test.js`
 * reads the codes the real `portfolioRiskScan` emits and asserts every one appears in
 * one of these two sets — an unclassified breach would otherwise arrive silently as a
 * `warning`, which is how a capital breach ends up in the low-priority pile.
 */
export const WARNING_BREACH_CODES = Object.freeze(new Set([
  "VALUATION_UNAVAILABLE",
  "SYNTHETIC_EXPOSURE",
  "SCAN_FAILED",
]));

/**
 * Severity for one breach code. Unclassified codes are `warning` and flagged, never
 * thrown: a sweep that aborted on an unknown code would stop monitoring the accounts
 * it does understand, which is the worse failure.
 */
export function severityForBreachCode(code) {
  const key = String(code);
  if (CRITICAL_BREACH_CODES.has(key)) return "critical";
  if (WARNING_BREACH_CODES.has(key)) return "warning";
  return "warning";
}

/** Legacy scanned a fixed 200 accounts per run (`listAccounts()` was unbounded; the sweep was not). */
export const DEFAULT_ACCOUNT_LIMIT = 500;
/** Legacy swept 200 pending proposals per run. */
export const DEFAULT_PROPOSAL_LIMIT = 200;
/**
 * Lock TTL. Must exceed the worst-case run: 500 accounts each needing a market-data
 * valuation, plus the proposal sweep. Ten minutes is generous against a run that
 * normally takes seconds, and short enough that a killed job does not wedge the
 * schedule for an hour.
 */
export const DEFAULT_LOCK_TTL_MS = 10 * 60_000;

function canonicalInstant(ms) {
  return new Date(ms).toISOString();
}

export function createScheduledJobs({
  store = null,
  paper = null,
  execution = null,
  notifications = null,
  log = null,
  now = () => Date.now(),
} = {}) {
  function requireStore() {
    if (!store) {
      const error = new Error("scheduled jobs require a persistence adapter");
      error.code = "JOBS_STORE_UNAVAILABLE";
      throw error;
    }
  }

  /**
   * Best-effort notification, mirroring the execution service's `publish`.
   *
   * The audit trail is the evidence and the notification is the nudge: a host whose
   * notification surface is missing or failing must still complete the sweep and
   * still record what it found. Otherwise an alerting outage would look like a risk
   * outage, and the cron log would report a failure that did not happen.
   */
  async function publish(type, severity, title, detail = {}, dedupeKey = null, userId = null) {
    if (!notifications || typeof notifications.notify !== "function") return null;
    try {
      const result = await notifications.notify(type, severity, title, detail, dedupeKey, userId);
      return result ?? null;
    } catch (error) {
      log?.warn?.({ err: error, notificationType: type }, "scheduled job notification could not be published");
      return null;
    }
  }

  async function audit(event) {
    if (!store || typeof store.recordAudit !== "function") return;
    try {
      // `actorId: null` is deliberate: Phase 10's attribution reports a NULL actor as
      // `kind: "system"` rather than borrowing an operator's identity, which is what
      // legacy meant by emitting `CRON_RUN` with actor `'system'`.
      await store.recordAudit({ actorId: null, ...event });
    } catch (error) {
      log?.warn?.({ err: error, action: event.action }, "scheduled job audit event could not be recorded");
    }
  }

  /**
   * Turn one account's scan entry into alerts with stable keys.
   *
   * The key is `paper:<accountId>:<CODE>`, legacy's `"{$scope}:{$code}"` with scope
   * `"paper:<id>"`. Stability is the whole mechanism: the same breach on the same
   * account must produce the same key on every run, or the transition diff would
   * report a new alert every minute and the dedupe would never engage.
   */
  function alertsForAccount(entry) {
    const scope = `paper:${entry.accountId}`;
    const alerts = [];
    for (const breach of entry.breaches || []) {
      const code = String(breach.code);
      alerts.push({
        code,
        severity: severityForBreachCode(code),
        classified: CRITICAL_BREACH_CODES.has(code) || WARNING_BREACH_CODES.has(code),
        scope,
        detail: breach.symbol ? `${breach.message} (${breach.symbol})` : String(breach.message),
        observedAt: canonicalInstant(now()),
        key: `${scope}:${code}`,
        // Carried for the notification payload; stripped from the persisted report,
        // exactly as legacy stored `array_diff_key($a, ['key' => true])`.
        accountId: entry.accountId,
        accountName: entry.accountName ?? null,
        ownerUserId: entry.ownerUserId ?? null,
      });
    }
    return alerts;
  }

  /** A `SCAN_FAILED` alert per account the sweep could not measure. */
  function scanFailedAlerts(accounts, reason) {
    return accounts.map((account) => ({
      code: "SCAN_FAILED",
      severity: "warning",
      scope: `paper:${account.id}`,
      detail: `account summary unavailable: ${reason}`,
      observedAt: canonicalInstant(now()),
      key: `paper:${account.id}:SCAN_FAILED`,
      accountId: Number(account.id),
      accountName: account.name ?? null,
      ownerUserId: account.owner_user_id === null || account.owner_user_id === undefined ? null : Number(account.owner_user_id),
    }));
  }

  /**
   * Scan every paper account across every owner.
   *
   * Accounts are grouped by owner and each group goes through the already-ported
   * `paper.portfolioRiskScan`, so the breach rules, the limit source and the
   * valuation path are the ones Phase 7 shipped and tested — this module does not
   * carry a second copy of the risk arithmetic that could drift from it.
   *
   * Failure isolation is **per owner**, and a failed group yields a `SCAN_FAILED`
   * alert for each of its accounts, preserving legacy's per-account behaviour: one
   * unmeasurable account must not blind the sweep to the rest. Legacy caught
   * `\Throwable` per account for exactly this reason.
   *
   * @returns {Promise<{accountsScanned:number, alerts:Array<object>, owners:number, scanFailures:Array<object>, exhausted:boolean}>}
   */
  async function portfolioRiskSweep({ limit = DEFAULT_ACCOUNT_LIMIT } = {}) {
    requireStore();
    if (!paper || typeof paper.portfolioRiskScan !== "function") {
      const error = new Error("the portfolio risk sweep requires the paper trading service");
      error.code = "PAPER_SERVICE_UNAVAILABLE";
      throw error;
    }
    const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || DEFAULT_ACCOUNT_LIMIT, 1), 5_000);

    // `listPaperAccounts(null)` is the pre-existing cross-owner read: an absent owner
    // means "do not filter". It is the one place in this platform where a null owner
    // widens rather than narrows, which is why it is called out here instead of
    // buried in a call.
    const accounts = await store.listPaperAccounts(null, bounded);

    const byOwner = new Map();
    for (const account of accounts) {
      const owner = account.owner_user_id === null || account.owner_user_id === undefined ? null : Number(account.owner_user_id);
      const key = owner === null ? "unowned" : String(owner);
      if (!byOwner.has(key)) byOwner.set(key, { owner, accounts: [] });
      byOwner.get(key).accounts.push(account);
    }

    const alerts = [];
    const scanFailures = [];
    let accountsScanned = 0;

    for (const { owner, accounts: group } of byOwner.values()) {
      if (owner === null) {
        // An account with no owner cannot be scanned through an owner-scoped path,
        // and inventing one would be a lie about whose risk it is.
        scanFailures.push({ owner: null, accountIds: group.map((account) => Number(account.id)), reason: "the account has no owner" });
        alerts.push(...scanFailedAlerts(group, "the account has no owner"));
        continue;
      }
      try {
        const report = await paper.portfolioRiskScan(owner, { limit: bounded });
        const scanned = report.accounts || [];
        accountsScanned += scanned.length;
        for (const entry of scanned) {
          alerts.push(...alertsForAccount({ ...entry, ownerUserId: owner }));
        }
        if ((report.totals?.accounts ?? scanned.length) < group.length) {
          // The per-owner scan is itself bounded, so a partial group must be visible
          // rather than silently dropping accounts from the sweep.
          scanFailures.push({ owner, accountIds: [], reason: `the owner scan returned ${scanned.length} of ${group.length} accounts` });
        }
      } catch (error) {
        const reason = String(error?.message || error).slice(0, 240);
        scanFailures.push({ owner, accountIds: group.map((account) => Number(account.id)), reason });
        alerts.push(...scanFailedAlerts(group, reason));
        if (log) log.warn({ err: error, owner }, "portfolio risk sweep could not scan one owner's accounts");
      }
    }

    alerts.sort((a, b) => {
      const bySeverity = (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99);
      return bySeverity !== 0 ? bySeverity : String(a.code).localeCompare(String(b.code));
    });

    return {
      accountsScanned,
      alerts,
      owners: byOwner.size,
      scanFailures,
      exhausted: accounts.length < bounded,
    };
  }

  /**
   * Diff this run's alerts against the persisted keys and act on the transitions.
   *
   * This is the edge-triggered heart of the sweep. A new key is audited and notified;
   * a key that disappeared is audited as cleared; a key present in both runs is
   * **silent**. Without the persisted memory a cron running every minute would
   * re-alert on the same breach 1 440 times a day, and the dedupe key would not save
   * it — Phase 9's dedupe only suppresses while an *unread* row exists, so an
   * operator who reads an alert would immediately get it again while the breach
   * persists. Legacy avoided that with `alertKeys`, and so does this.
   */
  async function recordTransitions(alerts, { dryRun = false } = {}) {
    const observedAt = canonicalInstant(now());
    let previous = {};
    // Two different reasons for "every alert looks new", and an operator needs to tell
    // them apart. `firstRun` is expected and harmless: nothing has been recorded yet,
    // so this run establishes the baseline. `memoryReadable: false` is a fault: a
    // baseline existed and could not be read, so alerts that were already sent are
    // about to be sent again.
    let memoryReadable = false;
    let firstRun = true;
    try {
      const state = typeof store.loadJobState === "function" ? await store.loadJobState(PORTFOLIO_RISK_STATE_KEY) : null;
      previous = state?.alertKeys && typeof state.alertKeys === "object" ? state.alertKeys : {};
      memoryReadable = true;
      firstRun = state === null;
    } catch (error) {
      // Losing the memory is self-healing — every alert reads as new, one extra
      // notification each, then the baseline is re-established. Refusing to scan
      // would trade a duplicate alert for a blind monitor.
      previous = {};
      memoryReadable = false;
      firstRun = false;
      if (log) log.warn({ err: error }, "portfolio risk transition memory could not be loaded; treating every alert as new");
    }

    const current = {};
    for (const alert of alerts) current[alert.key] = true;

    const raised = [];
    const cleared = [];
    for (const alert of alerts) {
      if (previous[alert.key]) continue;
      raised.push(alert);
      // A dry run classifies and reports; it emits no audit event, publishes no
      // notification and rewrites no transition memory, because the memory is the
      // thing that decides what counts as "new" on the next real run. Previewing a
      // transition must not consume it.
      if (dryRun) continue;
      await audit({
        action: AUDIT_ACTIONS.riskAlert,
        entityType: "portfolio_risk",
        entityId: alert.key,
        details: {
          legacyAction: LEGACY_ACTIONS.riskAlert,
          summary: `${alert.code} (${alert.severity}) — ${alert.detail}`,
          code: alert.code,
          severity: alert.severity,
          scope: alert.scope,
          detail: alert.detail,
          observedAt: alert.observedAt,
        },
      });
      // Broadcast, as legacy did: a portfolio risk alert is an operator concern, not
      // one user's. The dedupe key is the alert key, so a second raise of the same
      // breach while an unread alert exists is suppressed by Phase 9's dedupe.
      //
      // The title keeps legacy's exact form — `<CODE>: <scope prefix> risk alert`,
      // where the prefix of `paper:123` is `paper`. It is ambiguous for an operator
      // with several accounts and the account is only in `detail`; making it say
      // which account is a product decision, so it is recorded as divergence SJ-7
      // rather than quietly rewritten.
      await publish(
        PORTFOLIO_RISK_NOTIFICATION_TYPE,
        alert.severity,
        `${alert.code}: ${String(alert.scope).split(":")[0]} risk alert`,
        {
          key: alert.key,
          code: alert.code,
          severity: alert.severity,
          scope: alert.scope,
          accountId: alert.accountId ?? null,
          accountName: alert.accountName ?? null,
          ownerUserId: alert.ownerUserId ?? null,
          detail: alert.detail,
          observedAt: alert.observedAt,
        },
        alert.key,
        null,
      );
    }

    for (const key of Object.keys(previous)) {
      if (current[key]) continue;
      cleared.push(key);
      if (dryRun) continue;
      await audit({
        action: AUDIT_ACTIONS.riskCleared,
        entityType: "portfolio_risk",
        entityId: key,
        details: { legacyAction: LEGACY_ACTIONS.riskCleared, summary: `alert cleared: ${key}`, key },
      });
    }

    if (!dryRun && typeof store.saveJobState === "function") {
      try {
        await store.saveJobState(
          PORTFOLIO_RISK_STATE_KEY,
          {
            lastScanAt: observedAt,
            alertKeys: current,
            // The persisted report drops each alert's `key`, as legacy did, and also
            // `classified`: both are mechanism rather than finding. The key is what
            // the diff is computed from, and storing it inside the report would let a
            // reader mistake it for part of the alert.
            lastReport: {
              scannedAt: observedAt,
              alerts: alerts.map(({ key: _key, classified: _classified, ...rest }) => rest),
            },
          },
          { updatedAt: observedAt },
        );
      } catch (error) {
        // If the memory cannot be saved the next run re-alerts. That is noisy but
        // safe; failing the whole job would hide the alerts it already raised.
        if (log) log.warn({ err: error }, "portfolio risk transition memory could not be saved");
      }
    }

    return {
      raised,
      cleared,
      memoryReadable,
      firstRun,
      activeAlerts: Object.keys(current).length,
      dryRun: Boolean(dryRun),
    };
  }

  /**
   * The whole scheduled run: lock, risk sweep, proposal expiry, one audit event.
   *
   * Each stage is isolated. A risk sweep that throws must not stop proposals from
   * expiring — an approval window that lapses unactioned is a governance failure,
   * and it is the more time-sensitive of the two. Legacy ran them in sequence with no
   * isolation at all, so a scan failure skipped expiry entirely; that is divergence
   * SJ-1 applied at the job level as well as per item.
   *
   * **Dry run** (the CLI default) measures and writes nothing: no lock, no expiry, no
   * transition memory, no audit event. Skipping the lock matters as much as skipping
   * the writes — a dry run that took `operations.cron` would lock out the real run
   * that follows it, so a measurement tool scheduled every minute would silently stop
   * the job it was measuring.
   *
   * @param {{holder?:string|null, lockTtlMs?:number, accountLimit?:number, proposalLimit?:number, timestamp?:number|null, dryRun?:boolean}} [options]
   * @returns {Promise<object>} the summary the CLI prints and the audit event records
   */
  async function runOperations({
    holder = null,
    lockTtlMs = DEFAULT_LOCK_TTL_MS,
    accountLimit = DEFAULT_ACCOUNT_LIMIT,
    proposalLimit = DEFAULT_PROPOSAL_LIMIT,
    timestamp = null,
    dryRun = false,
  } = {}) {
    requireStore();
    const startedAt = typeof timestamp === "number" ? timestamp : now();
    const nowIso = canonicalInstant(startedAt);
    const expiresAt = canonicalInstant(startedAt + lockTtlMs);
    const owner = holder || `unspecified#${startedAt}`;

    const result = {
      ranAt: nowIso,
      job: OPERATIONS_JOB_NAME,
      lock: { holder: owner, ttlMs: lockTtlMs, expiresAt, acquired: false, released: false, reason: dryRun ? "a dry run does not take the lock, so it cannot block the real run" : null },
      adapter: store.capabilities?.adapter ?? store.adapter ?? "unknown",
      crossProcessSafety: Boolean(store.capabilities?.crossProcessSafety),
      risk: null,
      proposals: null,
      errors: [],
      completed: false,
      dryRun: Boolean(dryRun),
    };

    if (dryRun) {
      // Measured without the lock, so the report says explicitly that nothing was
      // reserved and a reader cannot mistake a dry run for a run that held the floor.
      try {
        const sweep = await portfolioRiskSweep({ limit: accountLimit });
        const transitions = await recordTransitions(sweep.alerts, { dryRun: true });
        result.risk = {
          accountsScanned: sweep.accountsScanned,
          owners: sweep.owners,
          alerts: sweep.alerts.length,
          activeAlerts: transitions.activeAlerts,
          wouldRaise: transitions.raised.length,
          wouldClear: transitions.cleared.length,
          memoryReadable: transitions.memoryReadable,
          firstRun: transitions.firstRun,
          scanFailures: sweep.scanFailures,
          exhausted: sweep.exhausted,
          codes: [...new Set(sweep.alerts.map((alert) => alert.code))].sort(),
          unclassifiedCodes: [...new Set(sweep.alerts.filter((alert) => alert.classified === false).map((alert) => alert.code))].sort(),
          dryRun: true,
        };
      } catch (error) {
        result.errors.push({ stage: "portfolio-risk-scan", reason: String(error?.message || error).slice(0, 240) });
        if (log) log.error({ err: error }, "dry-run portfolio risk sweep failed");
      }
      try {
        if (execution && typeof execution.expireStaleProposals === "function") {
          result.proposals = await execution.expireStaleProposals({ limit: proposalLimit, dryRun: true });
        } else {
          result.errors.push({ stage: "proposal-expiry", reason: "the execution service does not provide expireStaleProposals" });
        }
      } catch (error) {
        result.errors.push({ stage: "proposal-expiry", reason: String(error?.message || error).slice(0, 240) });
        if (log) log.error({ err: error }, "dry-run proposal expiry failed");
      }
      result.completed = result.errors.length === 0;
      result.durationMs = now() - startedAt;
      return result;
    }

    let acquired = null;
    try {
      acquired = await store.acquireJobLock(OPERATIONS_JOB_NAME, { holder: owner, nowIso, expiresAt });
    } catch (error) {
      // A lock that cannot be taken because the store is broken is not "another run
      // is active" — it is a failure, and reporting it as a skip would hide an outage.
      result.errors.push({ stage: "lock", reason: String(error?.message || error).slice(0, 240) });
      return result;
    }
    result.lock.acquired = Boolean(acquired?.acquired);
    result.lock.reason = acquired?.reason ?? null;
    if (!acquired?.acquired) {
      // Another run holds it. This is a normal outcome for an every-minute cron whose
      // previous run is still going, so it is a skip with a reason, not an error.
      result.skipped = true;
      return result;
    }

    try {
      try {
        const sweep = await portfolioRiskSweep({ limit: accountLimit });
        const transitions = await recordTransitions(sweep.alerts);
        result.risk = {
          accountsScanned: sweep.accountsScanned,
          owners: sweep.owners,
          alerts: sweep.alerts.length,
          activeAlerts: transitions.activeAlerts,
          raised: transitions.raised.length,
          cleared: transitions.cleared.length,
          memoryReadable: transitions.memoryReadable,
          firstRun: transitions.firstRun,
          scanFailures: sweep.scanFailures,
          exhausted: sweep.exhausted,
          // The alert codes, not the alerts: the cron log should say what fired
          // without dumping every account's numbers into it.
          codes: [...new Set(sweep.alerts.map((alert) => alert.code))].sort(),
          // A breach code the paper scan emits but this module has not classified.
          // Surfaced in the summary rather than only in a test, because the code
          // that drifts is added in production, not in CI.
          unclassifiedCodes: [...new Set(sweep.alerts.filter((alert) => alert.classified === false).map((alert) => alert.code))].sort(),
        };
      } catch (error) {
        result.errors.push({ stage: "portfolio-risk-scan", reason: String(error?.message || error).slice(0, 240) });
        if (log) log.error({ err: error }, "scheduled portfolio risk sweep failed");
      }

      try {
        if (execution && typeof execution.expireStaleProposals === "function") {
          result.proposals = await execution.expireStaleProposals({ limit: proposalLimit });
        } else {
          result.errors.push({ stage: "proposal-expiry", reason: "the execution service does not provide expireStaleProposals" });
        }
      } catch (error) {
        result.errors.push({ stage: "proposal-expiry", reason: String(error?.message || error).slice(0, 240) });
        if (log) log.error({ err: error }, "scheduled proposal expiry failed");
      }

      result.completed = true;
      result.durationMs = now() - startedAt;

      // The legacy `CRON_RUN` summary, with the same three counts and the same
      // sentence, so an operator reading an old log and a new one sees one format.
      const accountsScanned = result.risk?.accountsScanned ?? 0;
      const riskAlerts = result.risk?.alerts ?? 0;
      const proposalsExpired = result.proposals?.expiredIds?.length ?? 0;
      await audit({
        action: AUDIT_ACTIONS.cronRun,
        entityType: "system_job",
        entityId: OPERATIONS_JOB_NAME,
        details: {
          legacyAction: LEGACY_ACTIONS.cronRun,
          summary: `Scheduled operations: ${accountsScanned} account(s) scanned, ${riskAlerts} risk alert(s) active, ${proposalsExpired} proposal(s) expired`,
          ranAt: result.ranAt,
          accountsScanned,
          riskAlerts,
          proposalsExpired,
          expiredIds: result.proposals?.expiredIds ?? [],
          raised: result.risk?.raised ?? 0,
          cleared: result.risk?.cleared ?? 0,
          errors: result.errors,
          durationMs: result.durationMs,
        },
      });
      return result;
    } finally {
      // Released in `finally` and holder-scoped: if this run overran its TTL and the
      // next one took over, the release deletes nothing (it no longer holds the lock)
      // and reports that, rather than unlocking a run that is legitimately active.
      try {
        result.lock.released = await store.releaseJobLock(OPERATIONS_JOB_NAME, owner);
        if (!result.lock.released) {
          result.lock.reason = "the lock was no longer held at release — it expired and was taken over, or another run released it";
          if (log) log.warn({ job: OPERATIONS_JOB_NAME, holder: owner }, "scheduled job released a lock it no longer held");
        }
      } catch (error) {
        result.lock.released = false;
        result.errors.push({ stage: "lock-release", reason: String(error?.message || error).slice(0, 240) });
        if (log) log.error({ err: error }, "scheduled job could not release its lock");
      }
    }
  }

  /** The persisted report from the last sweep, without rescanning (legacy `lastReport()`). */
  async function lastRiskReport() {
    requireStore();
    if (typeof store.loadJobState !== "function") return null;
    const state = await store.loadJobState(PORTFOLIO_RISK_STATE_KEY);
    return state?.lastReport ?? null;
  }

  return {
    runOperations,
    portfolioRiskSweep,
    recordTransitions,
    lastRiskReport,
    OPERATIONS_JOB_NAME,
  };
}
