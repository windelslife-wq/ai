/**
 * The lottery provider boundary — the port of `Aegis\Lottery\LotteryProvider`,
 * `UnavailableLotteryProvider`, `SandboxLotteryProvider` and `OfficialLotteryProvider`,
 * plus legacy's `Platform.php` wiring that chooses between them.
 *
 * The provider-neutral contract, as legacy's interface comment states it: additional
 * lotteries plug in by adding a provider + rules set, without touching the
 * statistics, backtesting or ticket engines. A provider returns NORMALIZED raw
 * draws; every draw must carry source attribution and a source timestamp. AI-
 * generated or simulated data is only ever acceptable through clearly-labelled
 * sandbox providers — never as official results.
 *
 * The three implementations, in the order legacy's wiring weighs them:
 *
 *  - **Official** (`WINDELS_LOTTERY_OFFICIAL_*`): an authorized feed over HTTPS with
 *    license metadata. Safety defaults are intentional — offline until an explicit
 *    ENABLED flag, an https:// URL with no embedded credentials, and non-empty
 *    license/source metadata. It never marks a draw VERIFIED on its own: the
 *    validator still rejects every count, range, date, source and timestamp problem.
 *    No default host configures one, and nothing here is verified against a real
 *    vendor (the same honesty boundary as the sports HTTP provider).
 *  - **Sandbox** (`WINDELS_LOTTERY_SANDBOX=1`): deterministic simulated draws — the
 *    same pattern as the trading SyntheticProvider and the sports sandbox. Only
 *    online with the explicit opt-in; draws walk the real EuroMillions schedule
 *    backwards from `now`, with the numbers drawn by the exact `seededRandom` port.
 *  - **Unavailable** (the default): no data is preferable to unlicensed or
 *    fabricated results.
 *
 * The providers do no I/O of any kind except the official one's injected transport
 * — which defaults to `fetch` but is never constructed with reachable credentials
 * on a default host.
 */

import { formatGmdateC } from "../../lib/php-date.js";
import { seededRandom } from "./prng.js";
import { createEuroMillionsRules } from "./rules.js";

export const UNAVAILABLE_PROVIDER_ID = "unconfigured";
export const SANDBOX_PROVIDER_ID = "sandbox-sim";
export const OFFICIAL_PROVIDER_ID = "official-euromillions";
export const SANDBOX_SOURCE = "sandbox-simulation";

/** Safe default: no data is preferable to unlicensed or fabricated results. */
export function createUnavailableLotteryProvider() {
  return Object.freeze({
    id: () => UNAVAILABLE_PROVIDER_ID,
    name: () => "No lottery data provider configured",
    kind: () => "unavailable",
    health: () => ({
      state: "UNCONFIGURED",
      licensed: false,
      synthetic: false,
      message: "No lottery data provider configured — configure an authorized source (environment-only credentials) to enable ingestion",
    }),
    draws: async () => [],
    jackpotInfo: async () => null,
  });
}

/**
 * Clearly-labelled SIMULATION provider for pipeline testing. Draws are
 * deterministic per seed, always carry source `sandbox-simulation`, and are NEVER
 * presented as official results. Only online when `WINDELS_LOTTERY_SANDBOX=1`.
 */
export function createSandboxLotteryProvider({ seed = 42, now = () => Date.now(), env = {}, enabled: enabledOverride = null } = {}) {
  // Legacy reads `getenv` per call, so the opt-in is re-checked every time. The
  // `enabled` override exists for a host that wants the state fixed at boot; when
  // absent, the env object (defaults to empty — a test double) decides.
  const enabled = () => {
    if (enabledOverride !== null) return enabledOverride;
    return env.WINDELS_LOTTERY_SANDBOX === "1";
  };

  return Object.freeze({
    id: () => SANDBOX_PROVIDER_ID,
    name: () => "Sandbox Simulation (clearly labeled — never official)",
    kind: () => "sandbox",
    seed: () => seed,

    enabled,

    health: () => {
      if (!enabled()) {
        return {
          state: "OFFLINE",
          licensed: false,
          synthetic: true,
          message: "SANDBOX_NOT_ENABLED — set WINDELS_LOTTERY_SANDBOX=1 for clearly-labeled simulated draws (pipeline testing only)",
        };
      }
      return { state: "ONLINE", licensed: false, synthetic: true, message: "Simulated draws for pipeline testing only — NOT official results" };
    },

    /**
     * Normalized simulated draws, walking the configured schedule backwards day by
     * day from `now`. The DATE WALK depends on the clock; the NUMBERS depend only
     * on the seed and the count of draws, so the differential harness pins the
     * number content with the clock-derived fields stripped (the same trick the
     * sports sandbox golden uses).
     */
    draws: async (from = null, to = null, limit = 100) => {
      if (!enabled()) return [];
      const rules = createEuroMillionsRules();
      const capped = Math.min(1000, Math.max(1, Math.trunc(Number(limit)) || 100));
      const rand = seededRandom(seed);
      // PHP works in whole seconds: `time()` then `$ts -= 86400`.
      let ts = Math.floor(Number(now()) / 1000);
      const scheduleDays = rules.drawSchedule().days;
      const out = [];
      let produced = 0;
      let guard = 0;
      while (produced < capped) {
        ts -= 86400; // walk backwards day by day
        guard += 1;
        if (guard > 10_000_000) break; // unreachable in practice; a runaway loop is worse than a short list
        const drawDate = new Date(ts * 1000).toISOString().slice(0, 10);
        const dow = new Date(ts * 1000).getUTCDay();
        if (!scheduleDays.includes(dow)) continue;
        if (to !== null && to !== undefined && drawDate > to) continue;
        if (from !== null && from !== undefined && drawDate < from) break;
        const main = [];
        while (main.length < rules.mainCount()) {
          const x = rules.mainMin() + Math.trunc(rand() * rules.mainMax());
          if (!main.includes(x)) main.push(x);
        }
        main.sort((a, b) => a - b);
        const stars = [];
        while (stars.length < rules.starCount()) {
          const x = rules.starMin() + Math.trunc(rand() * rules.starMax());
          if (!stars.includes(x)) stars.push(x);
        }
        stars.sort((a, b) => a - b);
        out.push({
          externalId: `SIM-${drawDate}`,
          drawDate,
          main,
          stars,
          jackpot: (1_000_000 + Math.trunc(rand() * 19_000_000)).toFixed(2),
          rollover: rand() > 0.8,
          winners: null,
          source: SANDBOX_SOURCE,
          sourceTimestamp: formatGmdateC(new Date(ts * 1000)),
        });
        produced += 1;
      }
      return out;
    },

    jackpotInfo: async () => {
      if (!enabled()) return null;
      return {
        source: SANDBOX_SOURCE,
        value: null,
        note: "Simulated environment — no real jackpot figure is available or fabricated",
      };
    },
  });
}

/**
 * Adapter for an authorized/official lottery result feed.
 *
 * The upstream must expose this provider-neutral contract:
 *
 *   GET {url}/draws?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=N
 *     -> {"data":{"draws":[{"externalId":"…","drawDate":"YYYY-MM-DD","main":[…],"stars":[…],"sourceTimestamp":"…"}]}}
 *   GET {healthUrl} -> {"ok":true,"version":"…"}
 *
 * An upstream adapter can map a vendor's payload into this contract before it
 * reaches the platform. This class does not mark a draw VERIFIED on its own: the
 * validator still rejects every problem, and a conflicting verified result is never
 * overwritten.
 */
export function createOfficialLotteryProvider({
  url = "",
  enabled = false,
  token = "",
  license = "",
  source = "authorized-official-feed",
  healthUrl = "",
  jackpotUrl = "",
  request = null,
} = {}) {
  // Every value arrives from `config.lottery.official` (parsed once in config.js, so
  // the F-14 gate sees the names) or from a test. No env reads here: a provider that
  // re-reads the environment per call cannot be unit-tested for what a host actually
  // runs.
  const resolved = {
    url: String(url ?? "").trim(),
    healthUrl: String(healthUrl ?? "").trim(),
    token: String(token ?? "").trim(),
    license: String(license ?? "").trim(),
    source: String(source ?? "").trim() || "authorized-official-feed",
    jackpotUrl: String(jackpotUrl ?? "").trim(),
    enabled: Boolean(enabled),
  };
  const transport = request ?? defaultRequest;

  const configured = () => resolved.enabled && validUrl(resolved.url) && resolved.license !== "" && resolved.source !== "";

  return Object.freeze({
    id: () => OFFICIAL_PROVIDER_ID,
    name: () => "Authorized EuroMillions feed",
    kind: () => "official",
    configured,

    health: async () => {
      if (!resolved.enabled) {
        return {
          state: "DISABLED",
          licensed: false,
          synthetic: false,
          message: "Official feed is disabled — set WINDELS_LOTTERY_OFFICIAL_ENABLED=1 only after authorization",
        };
      }
      if (!validUrl(resolved.url) || resolved.license === "" || resolved.source === "") {
        return {
          state: "UNCONFIGURED",
          licensed: false,
          synthetic: false,
          message: "Official feed requires a safe URL, license metadata and a source identifier",
        };
      }
      try {
        const target = resolved.healthUrl !== "" ? resolved.healthUrl : endpoint(resolved.url, "/health");
        const payload = await transport(target, resolved.token !== "" ? resolved.token : null);
        if (!isPlainObject(payload) || (payload.ok ?? true) === false) throw new Error("health endpoint reported failure");
        return {
          state: "ONLINE",
          licensed: true,
          synthetic: false,
          message: "Authorized official feed reachable; all imported draws remain subject to validation",
          source: resolved.source,
          licenseConfigured: true,
          version: isPlainObject(payload) && isScalar(payload.version) ? String(payload.version) : null,
        };
      } catch (error) {
        return {
          state: "OFFLINE",
          licensed: true,
          synthetic: false,
          message: `Authorized feed is configured but unavailable: ${String(error?.message ?? error).slice(0, 180)}`,
          source: resolved.source,
          licenseConfigured: true,
        };
      }
    },

    draws: async (from = null, to = null, limit = 100) => {
      if (!configured()) return [];
      const capped = Math.min(1000, Math.max(1, Math.trunc(Number(limit)) || 100));
      const query = { limit: capped };
      if (from !== null && from !== undefined && from !== "") query.from = from;
      if (to !== null && to !== undefined && to !== "") query.to = to;
      const payload = await transport(endpoint(resolved.url, "/draws", query), resolved.token !== "" ? resolved.token : null);
      const rows = rowsOf(payload);
      return rows.map((row) => normalizeDraw(row, resolved.source));
    },

    jackpotInfo: async () => {
      if (!configured()) return null;
      if (resolved.jackpotUrl === "") return null;
      const payload = await transport(resolved.jackpotUrl, resolved.token !== "" ? resolved.token : null);
      if (!isPlainObject(payload)) return null;
      const data = isPlainObject(payload.data) ? payload.data : payload;
      return {
        source: resolved.source,
        value: isScalar(data.value) ? String(data.value) : null,
        currency: isScalar(data.currency) ? String(data.currency) : null,
        observedAt: isScalar(data.observedAt) ? String(data.observedAt) : null,
        note: "Official feed value; not used to infer future draw outcomes",
      };
    },
  });
}

/** The Platform.php choice: official when configured, else the sandbox when opted in, else nothing. */
export function chooseLotteryProvider({ lotteryConfig, now = () => Date.now() } = {}) {
  if (!lotteryConfig) throw new TypeError("chooseLotteryProvider requires the parsed lottery config");
  const official = createOfficialLotteryProvider(lotteryConfig.official);
  if (official.configured()) return official;
  if (lotteryConfig.sandboxEnabled) {
    // The enabled STATE comes from the parsed config, not from a fresh env read:
    // the provider's own env parameter is for tests and the parity harness, and a
    // chooser that passed the decision and then let the provider re-derive it from
    // an empty environment would report ONLINE in status and OFFLINE in health.
    return createSandboxLotteryProvider({ now, enabled: lotteryConfig.sandboxEnabled });
  }
  return createUnavailableLotteryProvider();
}

// ── official-feed internals, ported as written ────────────────────────────────

function rowsOf(payload) {
  if (!isPlainObject(payload)) throw new Error("official lottery feed returned invalid JSON");
  const rows = payload.draws ?? (payload.data?.draws ?? (payload.data ?? payload));
  if (!Array.isArray(rows)) throw new Error("official lottery feed returned no draw list");
  return rows.filter((row) => isPlainObject(row));
}

/** Keep missing fields missing so the central validator can reject and audit them. */
function normalizeDraw(row, providerSource) {
  let main = row.main ?? (row.numbers ?? (row.winningNumbers ?? null));
  let stars = row.stars ?? (row.luckyStars ?? (row.bonus ?? null));
  // PHP: is_array($main) && isset($main['main']) — a wrapper OBJECT one level deep
  // is unwrapped; a plain list never has the key, and an explicit null value does
  // not unwrap (isset() is false for null). The parity golden pins this case.
  if (main !== null && typeof main === "object" && main.main !== undefined && main.main !== null) main = main.main;
  if (stars !== null && typeof stars === "object" && stars.stars !== undefined && stars.stars !== null) stars = stars.stars;
  const sourceTimestamp = row.sourceTimestamp ?? (row.source_timestamp ?? (row.updatedAt ?? null));
  return {
    externalId: String(row.externalId ?? (row.external_id ?? (row.drawId ?? (row.id ?? "")))),
    drawDate: String(row.drawDate ?? (row.draw_date ?? (row.date ?? ""))),
    main: Array.isArray(main) ? [...main] : main,
    stars: Array.isArray(stars) ? [...stars] : stars,
    jackpot: isScalar(row.jackpot) ? String(row.jackpot) : null,
    rollover: !phpEmpty(row.rollover),
    winners: isScalar(row.winners) ? String(row.winners) : null,
    source: providerSource,
    sourceTimestamp: isScalar(sourceTimestamp) ? String(sourceTimestamp) : "",
  };
}

function endpoint(base, path, query = {}) {
  const target = `${String(base).replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  const params = Object.entries(query);
  return params.length === 0 ? target : `${target}?${new URLSearchParams(params).toString()}`;
}

function validUrl(value) {
  try {
    const parts = new URL(String(value));
    return parts.protocol === "https:" && parts.hostname !== "" && parts.username === "" && parts.password === "";
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function phpEmpty(value) {
  // PHP's empty(): null, false, 0, 0.0, '', '0', [] and []-like objects are empty;
  // NaN is a float and therefore TRUTHY in PHP. Used for `rollover`, where a feed
  // sending the STRING '0' means no rollover — JS Boolean('0') would say true.
  if (value === null || value === undefined || value === false) return true;
  if (typeof value === "number") return value === 0;
  if (typeof value === "string") return value === "" || value === "0";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function isScalar(value) {
  return value === null ? false : ["string", "number", "boolean"].includes(typeof value);
}

/** The 8-second HTTPS GET legacy's `defaultRequest` performs, on the platform's fetch. */
async function defaultRequest(url, token) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "WINDELS-Lottery-Provider/1.0",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(8_000),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
