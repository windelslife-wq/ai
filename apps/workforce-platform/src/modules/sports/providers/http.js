/**
 * Generic REST sports-data provider — the port of
 * `Aegis\Sports\Providers\HttpSportsProvider`.
 *
 * Legacy's contract comment, reproduced because it is the specification this class
 * implements and because any vendor matching it plugs in through environment
 * configuration alone:
 *
 * ```
 * GET {base}/fixtures?from=YYYY-MM-DD&to=YYYY-MM-DD
 *     → [{"externalId","homeTeam","awayTeam","competition","kickoff","status",
 *         "sport"?,"sourceTimestamp"?,"context"?}]
 * GET {base}/fixtures/{externalId}/odds
 *     → [{"market","selection","decimalOdds","observedAt"}]
 * GET {base}/fixtures/{externalId}/results
 *     → [{"externalId","status","homeScore"?,"awayScore"?,"sourceTimestamp"}]
 * ```
 *
 * *"Every payload is untrusted input and is validated by the normalizers before
 * persistence. Credentials come from the environment only."* Both halves are
 * load-bearing: this class never interprets a payload — `decodeList` establishes
 * that there **is** a list and hands the rows to the caller, which passes each one
 * to `normalizeFixture` / `normalizeOdds` — and the token is read once, from
 * configuration, and appears in exactly one place: the `Authorization` header.
 *
 * **This provider has never been verified against a real upstream.** There is no
 * configured sports data vendor for this platform (row 14's own note: *"A live
 * provider is not currently configured"*), so every behaviour here is proven
 * against an injected transport, exactly as the broker adapters were in Phase 14.
 * That is sufficient to prove the classification logic and insufficient to claim
 * any vendor works — and no such claim is made.
 */

import { PROVIDER_STATUS, ProviderError } from "../provider-error.js";

/** The default upstream timeout, in **seconds** — the unit legacy's variable uses. */
export const DEFAULT_TIMEOUT_SECONDS = 10;

/**
 * Classify an HTTP status into a provider failure.
 *
 * The order of these checks is the logic: `0` means no response at all (a timeout
 * or an unreachable host), which is `OFFLINE` rather than `DATA_ERROR` because
 * retrying a different provider is the right response; `401`/`403` and `429` get
 * their own statuses because they are **terminal for this provider** in different
 * ways — a credential problem is not fixed by waiting and a rate limit is not
 * fixed by rotating a credential; and only then are 5xx and 4xx collapsed into
 * `DATA_ERROR`.
 *
 * @param {number} status
 * @returns {ProviderError|null} `null` when the status is a success
 */
export function classifyHttpStatus(status) {
  const code = Number.isFinite(status) ? Math.trunc(status) : 0;
  if (code === 0) return new ProviderError("no HTTP response (timeout/unreachable)", PROVIDER_STATUS.OFFLINE);
  if (code === 401 || code === 403) return new ProviderError(`authentication rejected (HTTP ${code})`, PROVIDER_STATUS.AUTHENTICATION_ERROR);
  if (code === 429) return new ProviderError("rate limited (HTTP 429)", PROVIDER_STATUS.RATE_LIMITED);
  if (code >= 500) return new ProviderError(`provider server error (HTTP ${code})`, PROVIDER_STATUS.DATA_ERROR);
  if (code >= 400) return new ProviderError(`provider client error (HTTP ${code})`, PROVIDER_STATUS.DATA_ERROR);
  return null;
}

/**
 * PHP's `round($value, 4)` for the two rates this class reports. Half away from
 * zero, matching legacy, so an error rate of `0.00005` rounds the same way on both
 * sides.
 */
function round4(value) {
  if (!Number.isFinite(value)) return 0;
  return (Math.sign(value) * Math.floor(Math.abs(value) * 10_000 + 0.5)) / 10_000;
}

/**
 * Create an HTTP sports provider.
 *
 * @param {object} options
 * @param {string} options.id the provider's identity, stored as its `provider_code`
 * @param {string} options.baseUrl trailing-slash-stripped base URL
 * @param {string} [options.token] bearer credential; sent on every call including `/health`
 * @param {number} [options.timeoutSeconds]
 * @param {(url: string, init: Record<string, unknown>) => Promise<{status: number, body: string}>} [options.transport]
 *   injectable for tests; the default uses `fetch`
 * @param {() => number} [options.now] epoch milliseconds
 * @returns {Readonly<Record<string, unknown>>}
 */
export function createHttpSportsProvider({
  id,
  baseUrl,
  token = "",
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  transport,
  now = () => Date.now(),
}) {
  const providerId = String(id);
  const base = String(baseUrl).replace(/\/+$/, "");
  const credential = String(token ?? "");
  const timeoutMs = Math.max(1, Math.trunc(Number(timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS)) * 1000;

  // Observations about this provider's own recent behaviour. Legacy keeps them on
  // the instance, so a long-lived process accumulates a real error rate and a fresh
  // one starts at zero — which is why `reliability` is 1.0 before the first call
  // and only earns its value afterwards.
  let lastResponseMs = 0;
  let lastSuccess = null;
  let lastFailure = null;
  // The upstream's own word for its state, if it offered one (legacy's
  // `lastStatus`). Recorded and reported, never used to override the
  // classification.
  let lastReportedStatus = null;
  let requests = 0;
  let failures = 0;

  /**
   * The default transport.
   *
   * Two deliberate departures from legacy's `file_get_contents` stream context,
   * both recorded as divergences:
   *
   *  - **Redirects are refused** (SP-6). Legacy's context followed them with the
   *    `Authorization` header still attached, so an upstream that redirected to a
   *    third host would have been sent this provider's bearer credential. This is
   *    the same tightening as BC-14 in the broker port.
   *  - **A transport exception becomes a generic message** (SP-7). Legacy
   *    interpolated `$e->getMessage()`; Node's `fetch` rejects with `cause` chains
   *    that can carry the resolved address, and an error string that reaches an
   *    audit row or a log must not contain a host the deployment chose to keep
   *    private. The classified status still says `OFFLINE`, which is the part the
   *    fallback chain acts on.
   */
  const defaultTransport = async (url, init) => {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await response.text() };
  };

  const send = transport ?? defaultTransport;

  function errorRate() {
    return requests > 0 ? round4(failures / requests) : 0.0;
  }

  function reliability() {
    return round4(1 - errorRate());
  }

  /**
   * Perform one GET and classify the outcome.
   *
   * @param {string} url
   * @returns {Promise<{status: number, body: string}>}
   * @throws {ProviderError} always classified, never a raw transport error
   */
  async function call(url) {
    requests += 1;
    const startedAt = Date.now();
    let response;
    try {
      response = await send(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" },
      });
    } catch (error) {
      failures += 1;
      throw new ProviderError("provider transport failure", PROVIDER_STATUS.OFFLINE, error);
    }
    lastResponseMs = Date.now() - startedAt;
    const status = Number(response?.status ?? 0);
    const failure = classifyHttpStatus(status);
    if (failure !== null) {
      failures += 1;
      throw failure;
    }
    lastSuccess = new Date(now()).toISOString();
    return { status, body: String(response?.body ?? "") };
  }

  /**
   * PHP's `decodeList()`: establish that the body contains a list, and nothing more.
   *
   * Accepts a bare JSON array or an object with a `data` array, because vendors
   * differ on envelope and refusing the second shape would reject a working
   * provider. A row that is not an object is **not dropped** — it becomes
   * `{_malformed: row}` and is then refused by the normalizer with a message that
   * says which field was missing, so a provider returning `[fixture, "garbage"]`
   * reports one stored record and one named refusal rather than silently losing a
   * row. That is legacy's behaviour and it is the right one: the sync run's
   * `errors` array is the evidence.
   */
  function decodeList(response) {
    let decoded;
    try {
      decoded = JSON.parse(response.body);
    } catch {
      throw new ProviderError("provider returned a non-JSON payload", PROVIDER_STATUS.DATA_ERROR);
    }
    const pick = Array.isArray(decoded)
      ? decoded
      : decoded && typeof decoded === "object" && Array.isArray(decoded.data)
        ? decoded.data
        : null;
    if (pick === null) throw new ProviderError("provider response has no list body", PROVIDER_STATUS.DATA_ERROR);
    return pick.map((row) => (row && typeof row === "object" ? row : { _malformed: row }));
  }

  /**
   * Self-reported health: one real `GET /health`.
   *
   * This performs outbound I/O, so it is only ever called from a deliberately
   * probed path — the manager's fallback chain and an explicit live probe — and
   * never from an unauthenticated surface or a synchronous status snapshot. That is
   * the same rule BC-11 established for the broker connectors.
   *
   * A failure is **not** thrown: health is the one operation whose whole purpose is
   * to report that something went wrong, so it returns the classified status with
   * the message in `detail` instead.
   */
  async function health() {
    lastFailure = null;
    const startedAt = Date.now();
    try {
      const response = await call(`${base}/health`);
      lastResponseMs = Date.now() - startedAt;
      try {
        const decoded = JSON.parse(response.body);
        // The upstream may name its own state; it is recorded but never trusted to
        // override the classification, so a body claiming `"status":"ONLINE"` from
        // a 500 cannot make this provider look healthy.
        if (decoded && typeof decoded === "object" && typeof decoded.status === "string") {
          lastReportedStatus = decoded.status;
        }
      } catch {
        // A `/health` that answers 200 with a non-JSON body is still a successful
        // call for classification purposes; legacy behaves the same way.
      }
      return {
        status: PROVIDER_STATUS.ONLINE,
        responseMs: lastResponseMs,
        reliability: reliability(),
        lastSuccessAt: lastSuccess,
        lastFailureAt: null,
        errorRate: errorRate(),
      };
    } catch (error) {
      lastFailure = new Date(now()).toISOString();
      const classified = error instanceof ProviderError ? error : new ProviderError(String(error?.message ?? error), PROVIDER_STATUS.DATA_ERROR, error);
      return {
        status: classified.status,
        responseMs: lastResponseMs,
        reliability: reliability(),
        lastSuccessAt: lastSuccess,
        lastFailureAt: lastFailure,
        errorRate: errorRate(),
        detail: classified.message,
      };
    }
  }

  /** @param {{from?: string, to?: string}} [query] */
  async function fixtures(query = {}) {
    const today = new Date(now()).toISOString().slice(0, 10);
    const from = typeof query?.from === "string" && query.from !== "" ? query.from : today;
    const to = typeof query?.to === "string" && query.to !== "" ? query.to : today;
    const response = await call(`${base}/fixtures?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    return decodeList(response);
  }

  /** @param {string} fixtureExternalId interpolated as a single path segment */
  async function odds(fixtureExternalId) {
    const response = await call(`${base}/fixtures/${encodeURIComponent(String(fixtureExternalId))}/odds`);
    return decodeList(response);
  }

  /** @param {string} fixtureExternalId */
  async function results(fixtureExternalId) {
    const response = await call(`${base}/fixtures/${encodeURIComponent(String(fixtureExternalId))}/results`);
    return decodeList(response);
  }

  /** The counters, exposed so a test can assert an error rate was really earned. */
  function observations() {
    return Object.freeze({ requests, failures, errorRate: errorRate(), reliability: reliability(), lastResponseMs, lastReportedStatus });
  }

  return Object.freeze({ id: () => providerId, health, fixtures, odds, results, observations });
}
