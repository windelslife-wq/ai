/**
 * Bounded JSON HTTP client for market-data providers.
 *
 * Ported from `application/libraries/Aegis/Http.php`: the same retry budget, the
 * same exponential backoff (300 ms × 2^attempt, capped at 1 s), the same
 * injectable transport, and the same provider-error detection. It uses the
 * platform's built-in `fetch` — no HTTP package is added.
 *
 * The error-payload rule is not cosmetic. Binance answers a bad symbol with
 * `{"code":-1121,"msg":"Invalid symbol."}` and an HTTP 200; treating that object
 * as a candle row once produced two invalid bars and a silently empty dashboard
 * in the legacy platform. Refusing it here is what makes the fallback chain
 * honest instead of inventive.
 */

const USER_AGENT = "WINDELS-WORKFORCE/0.5 (+market-data)";

/**
 * @param {*} json decoded payload
 * @returns {boolean} true when the payload is a provider error envelope
 */
export function isProviderErrorPayload(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return false;
  if (!("code" in json) || json.msg === undefined) return false;
  const code = typeof json.code === "number" ? json.code : Number(json.code);
  if (!Number.isFinite(code)) return false;
  return Math.trunc(code) !== 200;
}

/** Default transport: `fetch` with a hard timeout. Returns null on any failure. */
export function createFetchTransport({ timeoutMs }) {
  return async function transport(url, options = {}) {
    const { signal } = options;
    const controllers = [AbortSignal.timeout(timeoutMs)];
    if (signal) controllers.push(signal);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: AbortSignal.any(controllers),
        redirect: "follow",
      });
      const text = await response.text();
      // A non-2xx body is still returned to the caller: providers such as
      // Binance put the reason in the payload, and `isProviderErrorPayload`
      // turns it into a failure with the provider's own message.
      return text === "" ? null : text;
    } catch {
      return null;
    }
  };
}

export function createHttpClient({
  timeoutMs = 6_000,
  retries = 2,
  backoffMs = 300,
  maxBackoffMs = 1_000,
  transport = createFetchTransport({ timeoutMs }),
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
} = {}) {
  /**
   * @param {string} url absolute https URL
   * @param {{retries?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<any>} the decoded JSON payload
   */
  async function getJson(url, options = {}) {
    const attempts = Math.max(0, Math.min(options.retries ?? retries, 5));
    let lastError = "transport failed";

    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      if (options.signal?.aborted) throw new Error("market data request cancelled");
      const body = await transport(url, { signal: options.signal });
      if (body !== null && body !== undefined) {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {
          json = null;
        }
        if (json !== null && (typeof json === "object" || Array.isArray(json))) {
          if (isProviderErrorPayload(json)) {
            lastError = `provider error: ${String(json.msg)}`;
          } else {
            return json;
          }
        } else {
          lastError = "invalid JSON response";
        }
      } else {
        lastError = "request failed (network/timeout)";
      }
      if (attempt < attempts) {
        await sleep(Math.min(maxBackoffMs, backoffMs * 2 ** attempt));
      }
    }
    throw new Error(lastError);
  }

  return { getJson, timeoutMs, retries };
}
