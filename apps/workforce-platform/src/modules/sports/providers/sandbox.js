/**
 * SANDBOX-mode simulation provider — the port of
 * `Aegis\Sports\Providers\SandboxSportsProvider`.
 *
 * Legacy's honesty contract is reproduced verbatim because it is the reason this
 * class is worth porting at all:
 *
 *  - Every record it emits is explicitly marked `simulated: true`.
 *  - It is only ONLINE when `WINDELS_SPORTS_MODE=SANDBOX` **and**
 *    `WINDELS_SPORTS_SANDBOX=1` (explicit opt-in). In PAPER/PRODUCTION mode it
 *    reports OFFLINE so sandbox data can never leak into real statistics.
 *  - Generation is fully deterministic (seeded PRNG): the same date range always
 *    produces the same fixtures, odds and results — reproducible but never
 *    presented as real-world data.
 *  - Injuries/lineups are intentionally NEVER produced: the sandbox simulates
 *    form, goals and markets only, so missing critical data is handled the same
 *    way it is for real providers.
 *
 * That last point is the one worth dwelling on. A simulation provider that also
 * invented injuries would let a downstream model believe it had richer inputs than
 * any real provider supplies, and the gap would only appear in production. Leaving
 * the same fields missing means the sandbox exercises the *refusal* paths — the
 * data-quality gates that reject a fixture for having no form — rather than
 * bypassing them.
 *
 * **The double opt-in is not redundant.** `WINDELS_SPORTS_MODE` defaults to
 * `SANDBOX`, so mode alone would enable this provider on a host that set nothing
 * at all; requiring `WINDELS_SPORTS_SANDBOX=1` as well means a default install
 * has **no** provider, which is the honest state for a platform with no verified
 * sports data source. The status route reports exactly that.
 *
 * This provider performs **no I/O of any kind** — no network, no clock reads
 * beyond an injectable `now`, no filesystem. That is what makes the whole sports
 * foundation testable end to end in this sandbox, which the broker port could not
 * be (Phase 14 had to inject a fake transport for every gate).
 */

import { createHash } from "node:crypto";
import { formatGmdateC } from "../../../lib/php-date.js";
import { PROVIDER_STATUS, ProviderError } from "../provider-error.js";

/** The provider's own id, which is also its `provider_code` in migration 011. */
export const SANDBOX_PROVIDER_ID = "sandbox-sim";

/** The default PRNG seed. Changing it changes every generated fixture. */
export const SANDBOX_DEFAULT_SEED = "windels-sandbox-v1";

/** Two leagues of eight teams each, exactly as legacy declares them. */
const LEAGUES = Object.freeze({
  "Premier Simulation League": Object.freeze([
    "Alpha United",
    "Bolt City",
    "Comet Rangers",
    "Delta Athletic",
    "Ember Rovers",
    "Falcon SC",
    "Granite Town",
    "Harbor Wanderers",
  ]),
  "Continental Simulation Cup": Object.freeze([
    "Apex FC",
    "Bronze Valley",
    "Cinder Sports",
    "Drake United",
    "Eagle Grove",
    "Foxes Athletic",
    "Glacier Town",
    "Horizon FC",
  ]),
});

const LEAGUE_NAMES = Object.freeze(Object.keys(LEAGUES));

/** Three fixtures per league per day, as legacy hard-codes. */
const FIXTURES_PER_LEAGUE_PER_DAY = 3;
/** Legacy's guard against an unbounded date range: at most 62 days per call. */
const MAX_DAYS = 62;
const KICKOFF_HOURS = Object.freeze([14, 16, 19]);

/**
 * The message a disabled sandbox reports. Kept byte-identical to legacy's because
 * it names the two variables an operator has to set, and it is surfaced verbatim
 * by the status route.
 */
export const SANDBOX_DISABLED_DETAIL =
  "SANDBOX_NOT_ENABLED — set WINDELS_SPORTS_MODE=SANDBOX and WINDELS_SPORTS_SANDBOX=1";

/* -------------------------------------------------------------------------- */
/* CRC-32 (PHP's `crc32()` and `hash('crc32', …)` are the same polynomial)      */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/**
 * CRC-32/ISO-HDLC — the reflected polynomial `zlib` uses, and the one behind
 * **PHP's `crc32()` function** (equivalently `hash('crc32b', …)`).
 *
 * Legacy's `strength()` uses this one, masked with `& 0xFFFF` where sign does not
 * matter. Returned unsigned so the mask behaves the same on both sides.
 *
 * Verified bit-identical to PHP 8.2 by `test/sports_parity.test.js`: the standard
 * check value for `"123456789"` is `0xCBF43926`, and the five team strengths the
 * differential harness compares match to the last double.
 *
 * @param {string} text
 * @returns {number} 0 … 4294967295
 */
export function crc32(text) {
  const bytes = Buffer.from(text, "utf8");
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CRC_BE_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = (n << 24) >>> 0;
    for (let k = 0; k < 8; k += 1) c = (c & 0x80000000 ? ((c << 1) >>> 0) ^ 0x04c11db7 : (c << 1) >>> 0) >>> 0;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32/BZIP2 — the **non-reflected** polynomial, which is what PHP's
 * `hash('crc32', …)` computes before rendering it.
 *
 * @param {string} text
 * @returns {number} 0 … 4294967295
 */
export function crc32BigEndian(text) {
  const bytes = Buffer.from(text, "utf8");
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (c ^ ((byte << 24) >>> 0)) >>> 0;
    for (let k = 0; k < 8; k += 1) c = (c & 0x80000000 ? ((c << 1) >>> 0) ^ 0x04c11db7 : (c << 1) >>> 0) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * PHP's `hash('crc32', $text)`: an eight-character lowercase hex string.
 *
 * **This is not `crc32()`, and finding F-34 is the record of why that matters.**
 * PHP exposes two different CRC-32 algorithms under confusingly similar names:
 *
 *   - `crc32($s)` / `hash('crc32b', $s)` — reflected, CRC-32/ISO-HDLC (`zlib`'s).
 *   - `hash('crc32', $s)` — non-reflected CRC-32/BZIP2, rendered **little-endian**,
 *     so its hex digest is the byte-swapped form of the computed value.
 *
 * Legacy's `SandboxSportsProvider` uses **both in the same class**: `crc32()` for
 * per-team strength and `hash('crc32', …)` for the league component of every
 * external id. A port that assumed they were one algorithm — or that assumed
 * `hash('crc32')` was simply the big-endian rendering, without the byte swap —
 * would still produce plausible, stable, self-consistent ids and pass every test
 * written against itself, while generating an entirely different fixture universe
 * from legacy's. Nothing would fail until the two implementations were compared,
 * which is precisely what the differential harness does.
 *
 * `Buffer#swap32()` is used rather than shift arithmetic because it states the
 * intent — a byte-order swap — instead of inviting a reader to verify four masks.
 *
 * @param {string} text
 * @returns {string} eight lowercase hex characters
 */
export function crc32HashHex(text) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(crc32BigEndian(text));
  return buffer.swap32().toString("hex");
}

/**
 * PHP's `round($value, $precision)` — half **away from zero**, where JavaScript's
 * `Math.round` is half toward +∞. They agree on positive values, which is all this
 * provider produces, but the helper is explicit because a negative odds
 * adjustment would otherwise round differently on the two sides and break the
 * byte-for-byte determinism this class exists to provide.
 */
function phpRound(value, precision = 0) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** precision;
  const scaled = value * factor;
  return (Math.sign(scaled) * Math.floor(Math.abs(scaled) + 0.5)) / factor;
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create the sandbox provider.
 *
 * @param {object} [options]
 * @param {string} [options.mode] `WINDELS_SPORTS_MODE` — `SANDBOX` | `PAPER` | `PRODUCTION`
 * @param {boolean} [options.sandboxEnabled] `WINDELS_SPORTS_SANDBOX=1`
 * @param {string} [options.seed] the PRNG seed; changing it changes every record
 * @param {() => number} [options.now] epoch milliseconds, injectable so a test can
 *   pin "today" and get a fixture set that does not move between runs
 * @returns {Readonly<Record<string, unknown>>}
 */
export function createSandboxSportsProvider({
  mode = "SANDBOX",
  sandboxEnabled = false,
  seed = SANDBOX_DEFAULT_SEED,
  now = () => Date.now(),
} = {}) {
  // Both halves of the opt-in, evaluated once: `(mode ?: 'SANDBOX') === 'SANDBOX'
  // && WINDELS_SPORTS_SANDBOX === '1'`.
  const effectiveMode = mode === null || mode === undefined || mode === "" ? "SANDBOX" : String(mode);
  const enabled = effectiveMode === "SANDBOX" && sandboxEnabled === true;

  /* ---------------- deterministic internals ---------------- */

  /** PHP's `randValue()`: the first 48 bits of `sha256(seed|key)`, scaled into `[min, max]`. */
  function randValue(key, min, max) {
    const digest = createHash("sha256").update(`${seed}|${key}`).digest("hex");
    const value = Number.parseInt(digest.slice(0, 12), 16) / 0xffffffffffff;
    return min + value * (max - min);
  }

  /** PHP's `randInt()`. The cast binds tighter than the modulo, so it truncates first. */
  function randInt(key, min, max) {
    const range = max - min + 1;
    return min + (Math.trunc(randValue(key, 0, 1) * range) % range);
  }

  /** PHP's `strength()`: fixed in `[0.75, 1.35]` per team name, stable across runs. */
  function strength(team) {
    return 0.75 + ((crc32(`strength:${team}`) & 0xffff) / 0xffff) * 0.6;
  }

  /** PHP's `form()`: simulated recent form derived from a fixed per-team strength. */
  function form(league, home, away) {
    const sHome = strength(home);
    const sAway = strength(away);
    const jitter = (key) => (randValue(`${league}:${key}`, 0, 1) - 0.5) * 0.3;
    return {
      homeGoalsPerMatch: phpRound(0.6 + 0.75 * sHome + jitter(`hg${home}`), 3),
      awayGoalsPerMatch: phpRound(0.6 + 0.75 * sAway + jitter(`ag${away}`), 3),
      homeConcededPerMatch: phpRound(Math.max(0.3, 1.7 - 0.55 * sHome + jitter(`hc${home}`)), 3),
      awayConcededPerMatch: phpRound(Math.max(0.3, 1.7 - 0.55 * sAway + jitter(`ac${away}`)), 3),
    };
  }

  /** `gmdate('Y-m-d')` for the injected clock. */
  function todayUtc() {
    return new Date(now()).toISOString().slice(0, 10);
  }

  /** PHP's `externalId()`. */
  function externalId(league, day, slot) {
    return `sim-${crc32HashHex(league).slice(0, 6)}-${day}-${slot}`;
  }

  /**
   * PHP's `parseExternalId()`. Returns `null` for anything this provider did not
   * generate — including a well-formed id whose league hash matches no known
   * league — and every caller treats `null` as "no data" rather than as an error,
   * because asking the sandbox about a real fixture is a legitimate thing to do.
   */
  function parseExternalId(id) {
    const match = /^sim-([0-9a-f]{6})-(\d{4}-\d{2}-\d{2})-(\d+)$/.exec(String(id ?? ""));
    if (match === null) return null;
    const league = LEAGUE_NAMES.find((name) => crc32HashHex(name).slice(0, 6) === match[1]);
    if (league === undefined) return null;
    return { league, day: match[2], slot: Number.parseInt(match[3], 10) };
  }

  /** PHP's `pairing()`. Home and away are always different teams. */
  function pairing(league, day, slot) {
    const teams = LEAGUES[league];
    const n = teams.length;
    const offset = (randInt(`off:${league}:${day}`, 0, n - 1) + slot) % n;
    const home = teams[offset];
    let awayIdx = (offset + 1 + Math.trunc(slot / Math.max(1, n - 1))) % n;
    if (awayIdx === offset) awayIdx = (awayIdx + 1) % n;
    return [home, teams[awayIdx]];
  }

  /** PHP's `kickoffTs()`: 14:00, 16:00 or 19:00 UTC by slot. */
  function kickoffTs(day, slot) {
    const hours = KICKOFF_HOURS[slot % KICKOFF_HOURS.length];
    return Date.parse(`${day}T${String(hours).padStart(2, "0")}:00:00Z`) / 1000;
  }

  /** PHP's `fixturePayload()`. */
  function fixturePayload(ext, league, home, away, day, slot, status) {
    const stats = form(league, home, away);
    const observed = formatGmdateC(new Date(now()));
    return {
      externalId: ext,
      homeTeam: home,
      awayTeam: away,
      competition: league,
      kickoff: formatGmdateC(new Date(kickoffTs(day, slot) * 1000)),
      status,
      sport: "football",
      sourceTimestamp: observed,
      provider: SANDBOX_PROVIDER_ID,
      // The honesty marker. It survives normalization and is stored in the match
      // payload, so a row can never be mistaken for observed data later.
      simulated: true,
      context: {
        recentForm: {
          homeGoalsPerMatch: stats.homeGoalsPerMatch,
          awayGoalsPerMatch: stats.awayGoalsPerMatch,
          homeConcededPerMatch: stats.homeConcededPerMatch,
          awayConcededPerMatch: stats.awayConcededPerMatch,
          source: `${SANDBOX_PROVIDER_ID}:simulated-form`,
          timestamp: observed,
        },
        marketLiquidity: 20000 + randInt(`liq:${ext}`, 0, 80000),
        restDays: 2 + randInt(`rest:${ext}`, 0, 2),
      },
    };
  }

  function refuseWhenDisabled() {
    if (!enabled) {
      throw new ProviderError("sandbox provider is not enabled in this mode", PROVIDER_STATUS.OFFLINE);
    }
  }

  /* ---------------- provider surface ---------------- */

  function id() {
    return SANDBOX_PROVIDER_ID;
  }

  /**
   * Self-reported health.
   *
   * A disabled sandbox reports `OFFLINE` with the two variables named in `detail`,
   * and `reliability: 0.0` — so the data-quality engine's reliability check fails
   * and nothing downstream can treat it as a usable source. An enabled one reports
   * `ONLINE` at `reliability: 0.9`, deliberately below the `1.0` a real provider
   * could earn: the sandbox is reproducible, not trustworthy.
   */
  async function health() {
    if (!enabled) {
      return { status: PROVIDER_STATUS.OFFLINE, reliability: 0.0, detail: SANDBOX_DISABLED_DETAIL };
    }
    return {
      status: PROVIDER_STATUS.ONLINE,
      reliability: 0.9,
      responseMs: 2,
      lastSuccessAt: formatGmdateC(new Date(now())),
      lastFailureAt: null,
      errorRate: 0.0,
    };
  }

  /**
   * Deterministic fixtures for a date range.
   *
   * Bounded at 62 days per call so an open-ended range cannot become an unbounded
   * loop. Status is `FINISHED` for a day strictly before today and `SCHEDULED`
   * otherwise — today's fixtures stay `SCHEDULED`, because a simulation that
   * claimed a match was live would be a fabricated state.
   *
   * @param {{from?: string, to?: string}} [query]
   */
  async function fixtures(query = {}) {
    refuseWhenDisabled();
    const today = todayUtc();
    const from = typeof query?.from === "string" && query.from !== "" ? query.from : today;
    const to = typeof query?.to === "string" && query.to !== "" ? query.to : from;
    const out = [];
    let day = from;
    let guard = 0;
    while (day <= to && guard < MAX_DAYS) {
      guard += 1;
      for (const league of LEAGUE_NAMES) {
        for (let slot = 0; slot < FIXTURES_PER_LEAGUE_PER_DAY; slot += 1) {
          const ext = externalId(league, day, slot);
          const [home, away] = pairing(league, day, slot);
          const status = day < today ? "FINISHED" : "SCHEDULED";
          out.push(fixturePayload(ext, league, home, away, day, slot, status));
        }
      }
      // Next UTC day. Computed from the parsed date rather than by string maths so
      // a month or year boundary cannot produce an out-of-order range.
      const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000);
      day = next.toISOString().slice(0, 10);
    }
    return out;
  }

  /**
   * One `TOTAL_GOALS / OVER_1_5` price per fixture, derived from a Poisson
   * total-goals model on the simulated form.
   *
   * The market price is the true probability less a 4% margin plus deterministic
   * noise, so the generated book has a realistic overround and the value
   * calculation downstream has something to lose to. **This is simulation maths on
   * simulated inputs and is labelled as such** — `simulated: true` is on the row.
   *
   * `observedAt` is clamped to at least two hours before kickoff and never in the
   * future, so a generated price is always a plausible *pre-match* observation
   * rather than one taken after the event it prices.
   */
  async function odds(fixtureExternalId) {
    refuseWhenDisabled();
    const ctx = parseExternalId(fixtureExternalId);
    if (ctx === null) return [];
    const [home, away] = pairing(ctx.league, ctx.day, ctx.slot);
    const stats = form(ctx.league, home, away);

    // True probability of Over 1.5 from a Poisson total-goals model.
    const lambda = (stats.homeGoalsPerMatch + stats.awayGoalsPerMatch) / 2 + 0.35;
    const pUnder1 = Math.exp(-lambda) * (1 + lambda);
    const pTrue = Math.min(0.985, Math.max(0.02, 1 - pUnder1));
    const margin = 0.04;
    const noise = (randValue(`${fixtureExternalId}:noise`, 0, 1) - 0.5) * 0.04;
    const pMarket = Math.min(0.97, Math.max(0.05, pTrue * (1 - margin) + noise));
    const decimal = phpRound(1 / pMarket, 2);

    const kickoff = kickoffTs(ctx.day, ctx.slot);
    const observedSeconds = Math.min(Math.floor(now() / 1000), kickoff - 7200);
    return [
      {
        market: "TOTAL_GOALS",
        selection: "OVER_1_5",
        decimalOdds: decimal,
        observedAt: formatGmdateC(new Date(observedSeconds * 1000)),
        provider: SANDBOX_PROVIDER_ID,
        simulated: true,
      },
    ];
  }

  /**
   * A deterministic scoreline for a fixture that has already happened.
   *
   * **Returns an empty list for today or any future day** — legacy's comment is
   * *"not finished — nothing fabricated"*, and that refusal is the single most
   * important behaviour in this class. A simulation provider that returned a
   * score for a match that has not been played would produce a verified-looking
   * result for an event that never happened, which is precisely the fabrication
   * the platform's rules forbid.
   */
  async function results(fixtureExternalId) {
    refuseWhenDisabled();
    const ctx = parseExternalId(fixtureExternalId);
    if (ctx === null) return [];
    if (ctx.day >= todayUtc()) return [];
    const [home, away] = pairing(ctx.league, ctx.day, ctx.slot);
    const stats = form(ctx.league, home, away);
    const lambdaHome = stats.homeGoalsPerMatch * 0.95 + 0.15;
    const lambdaAway = stats.awayGoalsPerMatch * 0.95;
    return [
      {
        externalId: fixtureExternalId,
        status: "FINISHED",
        homeScore: poisson(lambdaHome, `${fixtureExternalId}:h`),
        awayScore: poisson(lambdaAway, `${fixtureExternalId}:a`),
        sourceTimestamp: formatGmdateC(new Date(Date.parse(`${ctx.day}T23:59:00Z`))),
        provider: SANDBOX_PROVIDER_ID,
        simulated: true,
      },
    ];
  }

  /**
   * Deterministic Poisson sample (Knuth) from the seeded stream, capped at 12
   * draws so a large lambda cannot loop. The cap is legacy's and is generous for a
   * goals-per-match rate.
   */
  function poisson(lambda, key) {
    if (!(lambda > 0)) return 0;
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = 1.0;
    do {
      k += 1;
      p *= randValue(`${key}:${k}`, 0, 1);
    } while (p > limit && k < 12);
    return k - 1;
  }

  return Object.freeze({
    id,
    health,
    fixtures,
    odds,
    results,
    /** Test seam: the generation internals, so determinism can be asserted directly. */
    internals: Object.freeze({ enabled, randValue, randInt, strength, form, pairing, externalId, parseExternalId, kickoffTs, poisson }),
  });
}
