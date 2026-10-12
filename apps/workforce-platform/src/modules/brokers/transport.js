/**
 * The bridge HTTP transport — a port of the `defaultRequest()` closures in
 * `ConfiguredTradingConnectors.php` and `Mt5BridgeConnector.php` (row 13).
 *
 * Separate from `market-data/http.js` on purpose: that client is GET-only,
 * returns raw text and retries with backoff, because a market-data provider is a
 * cacheable read. A bridge call is a **state-changing RPC** — retrying a `POST
 * /v1/orders` after a timeout is how an order gets placed twice — so this
 * transport makes exactly one attempt, has no retry budget, and returns a parsed
 * envelope or `null`.
 *
 * Legacy's `ignore_errors: true` behaviour is preserved: a non-2xx response body
 * is still parsed and returned, because the bridge contract puts the reason in
 * `{ok: false, error: "…"}` and that reason is worth more than the status code.
 */

const USER_AGENT = "WINDELS-WORKFORCE/0.12 (+brokers)";

/**
 * @param {object} options
 * @param {string} options.baseUrl absolute origin, already validated by config
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl] injectable, for tests
 * @returns {(method: string, path: string, token: string|null, body: object|null, extra?: {timeoutMs?: number}) => Promise<object|null>}
 */
export function createBridgeTransport({ baseUrl, timeoutMs = 8_000, fetchImpl = fetch } = {}) {
  const origin = String(baseUrl ?? "").replace(/\/+$/, "");

  return async function transport(method, path, token, body, extra = {}) {
    if (!origin) return null;
    const budget = Number.isFinite(extra?.timeoutMs) ? extra.timeoutMs : timeoutMs;
    const headers = { accept: "application/json", "content-type": "application/json", "user-agent": USER_AGENT };
    // Bearer only when a token exists. Legacy's health probe sent none, and the
    // connector never passes one for `/health` (divergence BC-4).
    if (typeof token === "string" && token !== "") headers.authorization = `Bearer ${token}`;

    try {
      const response = await fetchImpl(`${origin}${path}`, {
        method: String(method).toUpperCase(),
        headers,
        body: body === null || body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(budget),
        redirect: "error",
      });
      const text = await response.text();
      if (text === "") return null;
      const decoded = JSON.parse(text);
      return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded) ? decoded : null;
    } catch {
      // Every failure — DNS, timeout, TLS, non-JSON body, a redirect — becomes
      // `null`. The connector turns that into "health check failed" or "request
      // failed", so neither the bridge URL nor a provider stack trace can reach a
      // caller through an error message.
      return null;
    }
  };
}
