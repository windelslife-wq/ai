# Phase 4 — Market data and provider health (2026-10-09)

**Branch:** `arena/774d9e70-ai` · **Sandbox Node:** v22.22.3 · **App version:** `@windels/workforce-platform@0.5.0`
**Suite:** 137 app tests (34 new), 30/30 install checks, **367/367 legacy PHP/WASM oracle tests**, 12/12 Scout
contract tests, 29/29 football-prediction tests, `npm run typecheck` clean — all executed and passing in this
sandbox (**545 passed, 0 failed**).

This phase ported the third module — **market data**: the provider chain, candle normalization, circuit
breakers, provenance/staleness reporting, the four licensed-feed adapters and the three legacy
`api/market-data/*` endpoints. It is the first module in the master-plan dependency order (§11) because
analysis, strategies and paper trading all consume it: porting it first means every later module is
built on a data layer whose honesty rules are already enforced and tested.

Nothing here is a cutover. `application/` and `system/` are byte-for-byte unchanged; the PHP platform
remains authoritative and remains the rollback target. **No trading capability was added or enabled.**

> **Phase-numbering divergence (recorded, not reconciled).** The master plan's §11 sequence calls this
> work "Phase 3 — market data", while `STATUS.md` numbers phases by what this repository actually
> delivered: Phase 1 foundation, Phase 2 identity, Phase 3 public site, **Phase 4 market data**. This
> document follows the repository numbering and cites the plan's ordering as the reason market data came
> next. Both numberings refer to the same plan; neither is wrong, and no document should "fix" the other
> silently.

---

## 1. What now exists

### Market-data module (`apps/workforce-platform/src/modules/market-data/`)

| File | Replaces | Notes |
|---|---|---|
| `timeframes.js` | `Aegis/Timeframes.php` | `TIMEFRAMES` (1m…1d), `timeframeMs`, `staleMs` (3× interval), `MARKET_CLASSES` (9), `isMarketClass`, `inferMarketClass` (`…USDT` → crypto, else forex) |
| `normalize.js` | `Aegis/CandleNormalizer.php` + `MathUtils::{hashString,seededRandom,gaussian}` | drop non-finite/non-positive OHLC, negative volume, bad timestamps; clamp high/low to the body; sort; dedupe; gap detection at >1.5× interval; `ok = count ≥ 30 && gaps ≤ max(2, floor(count×0.1))`; issues capped at 20 |
| `circuit-breaker.js` | `Aegis/CircuitBreaker.php` | CLOSED/OPEN/HALF_OPEN, 5 failures / 60 s window / 30 s cooldown, a failed probe re-opens immediately. **Clock is injectable** so the state machine is tested without sleeping |
| `http.js` | `Aegis/Http.php` | platform `fetch` + `AbortSignal.timeout`; 6 s timeout, 2 retries, backoff `min(1000, 300×2^attempt)` ms; `isProviderErrorPayload` refuses `{code≠200,msg}` envelopes; transport injectable |
| `providers/binance.js` | `Providers/BinanceProvider.php` | 12 listed symbols only; klines `limit` clamped 1–1000; host fallback `[configured, data-api.binance.vision, api1.binance.com]`; `bookTicker` quote with bid/ask > 0 and ask ≥ bid; `/api/v3/ping` health; market-data endpoints only — **no trading endpoint is called** |
| `providers/frankfurter.js` | `Providers/FrankfurterProvider.php` | 31 ECB currencies; **`1d` only** and intraday requests are refused rather than interpolated; date-keyed `rates` → candles with open = previous close and `volume: 0.0`; quote stamped 16:00 UTC of the publication date; `delayed: true` |
| `providers/licensed-asset.js` | `Providers/LicensedAssetMarketDataProvider.php` | provider-neutral wire contract (`/candles`, `/quote`, `/health`); inert until URL + license metadata + symbol allow-list + `ENABLED=1`; health `DISABLED` / `NOT_CONFIGURED` / `UP` / `DOWN`; rejects invalid OHLCV from the wire; no symbol discovery |
| `providers/synthetic.js` | `Providers/SyntheticProvider.php` | deterministic generator, same `aegis:<symbol>:<timeframe>` seed, same 13 base prices, same phase schedule, same 6-dp rounding; priority 999, always registered last; health detail reads *"SIMULATION ONLY — not market data"* |
| `manager.js` | `Aegis/ProviderManager.php` | priority sort, capability + market-class filtering, timeframe-capable first, breaker gating, TTL caches (candles `max(15 s, 25 % of interval)`, quotes 15 s, health 10 s), `DEGRADED` promotion, 50 ms settle between failures, provenance stamping, `PROVIDER_FALLBACK` hook |
| `contracts.js` | `Api_marketdata.php` validation | `symbol` 2–24 chars, `timeframe` enum, `marketClass` enum (nullable), `limit` 30–5000 default 200 |
| `service.js` | `Aegis/Platform.php` L50–84 | configuration-driven registration in legacy order, fallback → audit event, registry/status snapshots |
| `routes.js` | `application/controllers/Api_marketdata.php` | the three endpoints, session-gated |

12 new source files (1 651 lines) + 1 new test file (924 lines, 34 tests).

### Supporting changes

| File | Change |
|---|---|
| `src/config.js` | `config.marketData` — `realProviders`, `allowSynthetic`, `timeoutMs`, `retries`, **`deadlineMs`**, **`healthTimeoutMs`**, `binanceBaseUrl`, `frankfurterBaseUrl`, and the four licensed adapters (`AEGIS_{STOCK,ETF,FUTURES,OPTIONS}_DATA_*`, legacy spelling kept so a cPanel environment carries over unchanged) |
| `src/app.js` | builds **one** market-data service per app and passes it to both the API routes and the health module, so caches and breakers are shared rather than duplicated |
| `src/modules/platform/health.js` | `marketData` → `state: "ported"`; `/api/v1/system/status` gains a `marketData` block (registry + policy + non-probing health) |
| `.env.example` | 8 new documented variables plus the 7-variable `AEGIS_STOCK_DATA_*` family (53 documented in total; `verify:install` check 25 passes) |
| `package.json` | 0.4.0 → **0.5.0** |
| `test/platform_findings.test.js` | pins updated: 2 modules `ported`, 11 `not-ported`, `features.marketData === "ported"`, status carries a market-data snapshot |

No new runtime dependency was added (`fetch`, `AbortSignal` and `URLSearchParams` are platform built-ins);
no `devDependencies`; no new database table — market data persists nothing except the fallback audit event.

---

## 2. Route parity — the ported surface

| Legacy | Node | Auth | Notes |
|---|---|---|---|
| `GET api/market-data/candles` | `GET /api/v1/market-data/candles` | session | payload shape preserved: `symbol`, `marketClass`, `timeframe`, `candles[]`, `provenance`, `validation` |
| `GET api/market-data/quote` | `GET /api/v1/market-data/quote` | session | `quote`, `source`, `synthetic`, `fallbackChain` (+ additive `live`, `fetchedAt`, `fromCache`) |
| `GET api/market-data/providers` | `GET /api/v1/market-data/providers` | session | `providers` (live health) + `registry` (+ additive `policy`) |

None of the three appears in `Api_controller::PUBLIC_ACTIONS` (`api_auth/login`, `api_chat/respond`,
`api_system/status`, `api_system/features`), so all three require a signed-in session — asserted by
`market-data endpoints require an authenticated session`. None requires a *permission*: market data was
readable by every legacy role, and inventing a permission here would have extended the legacy
9-role/14-permission vocabulary, which this migration does not do.

`GET /api/v1/system/status` also reports the module (`marketData.providers`, `.registry`, `.policy`),
mirroring the legacy `Api_system::status` `providers` key — **without probing**: see §5.

Live inventory after this phase: **33 API routes** (`GET /api/v1/system/routes`), 22 document routes.

---

## 3. Honesty rules that are enforced, not documented

1. **Synthetic data is always labelled.** `provenance.synthetic: true`, `live: false`, `source:
   "synthetic-demo"`, and the provider's own health detail says *"SIMULATION ONLY — not market data"*.
   Synthetic is registered last and only serves after every real candidate has failed.
2. **A host can refuse synthetic data entirely.** `MARKET_DATA_ALLOW_SYNTHETIC=0` leaves the provider
   unregistered; the request then answers `503 SYNTHETIC_DATA_DISABLED` with `details.syntheticAllowed:
   false` and **no candle array** — asserted by
   `a host that refuses synthetic data returns an outage, never invented candles`.
3. **A provider that returns junk fails instead of being repaired into a chart.** An empty response or
   fewer than 30 normalized candles is a provider failure and moves the chain along (the legacy
   "two invalid bars → silently empty dashboard" defect). Binance's `{"code":-1121,"msg":"Invalid
   symbol."}` is refused by `isProviderErrorPayload`; a zero or inverted bid/ask is refused; a licensed
   feed sending `high < max(open, close)` is refused.
4. **Every fallback is audited.** Action `marketData.provider.fallback` with
   `details.legacyAction: "PROVIDER_FALLBACK"` and the legacy message verbatim:
   `` `BTCUSDT`: providers [binance] failed — falling back to synthetic-demo ``.
5. **Licensed feeds are inert and say so.** `DISABLED` until `*_ENABLED=1`; `NOT_CONFIGURED` until a safe
   URL, license metadata and a symbol allow-list exist; `supportsSymbol()` returns false while inert, so
   an unconfigured adapter can never be selected by the chain.
6. **Frankfurter never invents intraday data.** ECB publishes daily reference rates, so `1d` is the only
   supported timeframe and `volume` is a real `0.0`, not an estimate.
7. **Staleness is reported, not hidden.** `provenance.stale` compares `dataAgeMs` against
   `staleMs(timeframe)` (3× interval) and the threshold is included in the response.

---

## 4. Test evidence (this sandbox, 2026-10-09)

```
npm test                        → 137 pass / 0 fail  (13 files; test/market_data.test.js = 34)
npm run verify:install          → 30/30 checks       (53 documented env vars, 4 migrations, 4 icons)
node runtime/run-tests.mjs      → 367 pass / 0 fail  (the legacy PHP oracle, run in WASM PHP 8.2, 18.6 s)
npm run test:contracts          → 12 pass / 0 fail   (Scout shared contracts, unchanged)
football-predictions npm test   → 29 pass / 0 fail   (unchanged)
npm run typecheck               → clean, exit 0      (tsc -p tsconfig.json --noEmit)
```

The oracle run matters more than its total: **all eleven `tests/cases/02-providers.php` cases are in it and
passed**, listed by name in the runner output (`provider manager falls back and records the chain`,
`synthetic generator is deterministic`, `circuit breaker opens and half-opens`, `http rejects binance-style
error envelopes`, `binance rejects error-object klines instead of inventing c…`, `frankfurter parses
date-keyed time series`, `normalizer sorts, dedupes, drops NaN and counts gaps`, …). The same eleven cases
pass in the Node suite, so both sides of the migration are green against the same expectations — read the
legacy PHP from disk, transcribe it, run both.

### 4.1 The eleven legacy cases, ported 1:1

`tests/cases/02-providers.php` is the parity oracle. Each case is reproduced with the same inputs and the
same assertions, and is prefixed `legacy 02-providers:` in the Node suite:

| # | Legacy case | Node test |
|---|---|---|
| 1 | manager falls back and records the chain | `provider manager falls back and records the chain` |
| 2 | synthetic marks provenance + consistent OHLC | `synthetic provider marks provenance and generates consistent OHLC` |
| 3 | synthetic generator is deterministic | `synthetic generator is deterministic` (+ golden first/last timestamps) |
| 4 | breaker opens and half-opens | `circuit breaker opens and half-opens` (injectable clock instead of `usleep(30000)`) |
| 5 | http rejects binance-style error envelopes | `http rejects binance-style error envelopes` |
| 6 | http accepts list payloads | `http accepts list payloads` |
| 7 | binance rejects error-object klines | `binance rejects error-object klines instead of inventing candles` |
| 8 | binance rejects zero bid/ask quotes | `binance rejects zero bid/ask quotes` |
| 9 | manager falls back when candles are all invalid | `provider manager falls back when candles are all invalid` |
| 10 | frankfurter parses date-keyed series | `frankfurter parses date-keyed time series` |
| 11 | normalizer sorts, dedupes, drops NaN, counts gaps | `normalizer sorts, dedupes, drops NaN and counts gaps` |

The legacy `fx_candles()` and `FakeProvider` helpers are ported into the Node suite (`fxCandles`,
`fakeProvider`) so the fixtures are the same series, generated by the same seeded PRNG.

### 4.2 Node-specific coverage beyond the legacy suite

Body clamping and issue reporting; rejection of negative prices/volume, non-numeric timestamps, `null`
and string rows; timeframe/market-class vocabulary; `hashString` bit-31 quirk and unsigned return;
`seededRandom` seed-0 remap and Box-Muller range; refusal when synthetic is forbidden; timeframe-capable
ordering over raw priority; `DEGRADED` promotion after a recorded failure; `probe: false` health that
touches no network; TTL cache reuse plus bounded eviction (520 distinct symbols → ≤ 500 entries); stale
provenance; the four licensed-adapter states and their payload rejections; Binance symbol allow-list,
ragged kline rows and host-mirror fallback; retry/backoff budget; the HTTP surface (401, seven validation
refusals, synthetic-labelled success, registry/policy, 503 refusal, `Retry-After`); the audit event; and
the public status/features/route-inventory assertions.

### 4.3 Live rehearsal (file adapter, no database, no outbound egress)

Run against the sandbox server on `0.0.0.0:3000` with `MARKET_DATA_REAL_PROVIDERS` at its default `1`:

```
GET /api/v1/market-data/candles?symbol=BTCUSDT&timeframe=1h        (no session) → 401 AUTH_REQUIRED
GET /api/v1/market-data/candles?symbol=BTCUSDT&timeframe=2h        (session)    → 400 "timeframe must be one of: 1m, 5m, 15m, 1h, 4h, 1d"
GET /api/v1/market-data/candles?symbol=BTCUSDT&timeframe=1h&limit=40            → 200
    symbol BTCUSDT · marketClass crypto (inferred) · 40 candles · validation.ok true
    provenance: source synthetic-demo, synthetic true, live false, fallbackChain ["binance"], stale false
GET /api/v1/market-data/quote?symbol=eurusd                                     → 200
    quote {bid 1.089381, ask 1.089599, last 1.08949} · source synthetic-demo · fallbackChain ["frankfurter-ecb"]
GET /api/v1/market-data/providers                                               → 200
    binance DOWN ("request failed (network/timeout)") · frankfurter-ecb DOWN · licensed-{stock,etf,futures,options} DISABLED · synthetic-demo UP
    registry: binance(10) frankfurter-ecb(20) licensed-stock(30) licensed-etf(31) licensed-futures(32) licensed-options(33) synthetic-demo(999,synthetic)
GET /api/v1/system/status                                                       → 200
    version @windels/workforce-platform@0.5.0 · modules[marketData] = ported · marketData.providers all UNKNOWN (no probe)
```

Two audit rows were written by that rehearsal, e.g.
`` `EURUSD`: providers [frankfurter-ecb] failed — falling back to synthetic-demo `` with
`legacyAction: "PROVIDER_FALLBACK"`.

**This is the correct behaviour for a host with no outbound access, not a defect.** Binance and
Frankfurter are unreachable from the sandbox, so both report `DOWN` with the real reason, the chain falls
back, and every served candle is labelled synthetic. On a cPanel host with egress the same code reports
`UP` and serves real data; nothing about that path is simulated here.

---

## 5. Deliberate divergences from the legacy behaviour

| # | Divergence | Reason |
|---|---|---|
| 1 | Provider failure answers **`503` + `Retry-After`** with `error.code` `MARKET_DATA_UNAVAILABLE` / `SYNTHETIC_DATA_DISABLED`; legacy answered `502` with a bare `{error:"<provider message>"}` | The platform-wide dependency-outage contract (finding F-02): a dependency outage is 503 with `Retry-After`, never 500, and every error carries a machine-readable code. The provider's own message is preserved in `error.details.reason`, so no diagnostic value is lost |
| 2 | Error envelope is `{error:{code,message,details}}` rather than the legacy `{error:message}` | Same platform-wide contract, established in Phase 2 |
| 3 | `provenance` gains `staleThresholdMs` and `fromCache`; the quote payload gains `live`, `fetchedAt`, `fromCache`; `providers` gains `policy` | Additive only — a legacy client reading the old keys still works, and the new keys make the freshness and cache story explicit instead of inferred |
| 4 | The fallback handler receives `{symbol, marketClass, timeframe, failed, used, synthetic}` instead of `{symbol, failed, used}` | The audit event records which class/timeframe fell back and whether the result is synthetic; the legacy three fields are still present |
| 5 | `/api/v1/system/status` reports provider health **from cache only** (`UNKNOWN` when never probed) | The legacy status endpoint called `getAllHealth()` and could trigger live probes from an unauthenticated route. On the Node platform that would let any anonymous caller make the server fan out to third parties — a cheap amplification vector. Probing is available on the authenticated `/market-data/providers` |
| 6 | In-process caches are **bounded** (500 entries, expired-first then oldest-out) | The legacy arrays grew without limit; a Node process is long-lived and a burst of symbols would grow the heap forever |
| 7 | Every request has a **deadline** (`MARKET_DATA_DEADLINE_MS`, default 15 s; health probes `MARKET_DATA_HEALTH_TIMEOUT_MS`, default 5 s) | The legacy manager had no overall budget, so a host with no egress stacked one provider timeout after another. Now the request fails fast and honestly |
| 8 | `hashString("")` returns `2166136261` rather than a negative int32 | PHP's `$h | 0` cannot make a 64-bit non-negative int negative; a JS `| 0` would. The unsigned return is the faithful transcription. Only the empty string is affected, and no platform caller hashes one |
| 9 | Circuit-breaker state transitions are driven by an injectable clock | The legacy test had to `usleep(30000)` to observe `HALF_OPEN`. Same state machine, no sleeping suite |
| 10 | Synthetic `now` is injectable (`createSyntheticProvider({now})`) | Makes the deterministic series reproducible under test without freezing the process clock |

Nothing else was changed on purpose: symbol upper-casing, the 2-character floor, the timeframe and
market-class vocabularies, the 30–5000 limit, `inferClass`, provider priorities, cache keys and TTLs, the
50 ms settle, `DEGRADED` promotion, normalization thresholds and the synthetic seed string are all
carried over verbatim.

---

## 6. Defects found and closed while porting

| Ref | Defect in the port-in-progress | Fix |
|---|---|---|
| D-1 | `loadMarketDataConfig` computed `delayed` as `!boolean(...) || value === ""`, which **inverted** the legacy rule (`delayed = getenv(PREFIX.'_DELAYED') !== '0'`): `_DELAYED=0` reported delayed and `_DELAYED=1` reported live | `String(env[…_DELAYED] \|\| "").trim() !== "0"`; verified against all three states (unset → true, `0` → false, `1` → true) |
| D-2 | `createFetchTransport` was written as `async function transport(url, {signal} = {}) => {…}` — a syntax error that would have failed at import, i.e. the whole app would not boot | Corrected to a function declaration with destructuring inside; caught by the first smoke run, not by review |
| D-3 | The first draft of `contracts.js` used a JSON-Schema-style `{type:"object",properties:{…}}` wrapper. The platform's validator expects a **flat field map**, so every query parameter validated as absent: `timeframe=2h` was accepted and `symbol` arrived `undefined` (the response said `symbol: "UNDEFINED"`) | Rewritten in the flat dialect; `timeframe=2h` now answers 400 and the symbol round-trips. This is exactly the class of bug the smoke rehearsal exists to catch |
| D-4 | `hashString` returned `hash \| 0`, truncating the FNV offset basis to a negative int32 for the empty string — a divergence from PHP | Returns `hash >>> 0`; pinned by a test |
| D-5 | `candidatesFor` in the first test draft was exercised with `marketClass: "forex"` against fixtures declaring `["crypto"]`, so it returned an empty candidate list | Test corrected, and the empty-list behaviour is now asserted deliberately as its own case |

No legacy PHP file was modified, and no defect above was "fixed" by relaxing a rule: each one was a
transcription error caught by executing the port.

---

## 7. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MARKET_DATA_REAL_PROVIDERS` | `1` | `0` registers no real provider (offline development) |
| `MARKET_DATA_ALLOW_SYNTHETIC` | `1` | `0` refuses synthetic data: requests fail `503 SYNTHETIC_DATA_DISABLED` instead of being served simulated candles |
| `MARKET_DATA_TIMEOUT_MS` | `6000` | per-provider-call timeout, 500–30000 |
| `MARKET_DATA_RETRIES` | `2` | retries per call, 0–5, backoff `min(1000, 300×2^attempt)` ms |
| `MARKET_DATA_DEADLINE_MS` | `15000` | hard budget for a whole request across the chain, 1000–120000 |
| `MARKET_DATA_HEALTH_TIMEOUT_MS` | `5000` | shorter budget for health probes, 500–60000 |
| `BINANCE_API_BASE` | `https://api.binance.com` | mirror/proxy override; production refuses non-HTTPS |
| `FRANKFURTER_API_BASE` | `https://api.frankfurter.dev` | idem |
| `AEGIS_{STOCK,ETF,FUTURES,OPTIONS}_DATA_{URL,HEALTH_URL,TOKEN,LICENSE,ENABLED,DELAYED,SYMBOLS}` | unset / `ENABLED=0` | licensed feeds; legacy spelling preserved so an existing cPanel environment carries over. Each adapter stays `DISABLED`, then `NOT_CONFIGURED`, until URL + license + symbol allow-list exist |

All eight new `MARKET_DATA_*`/`*_API_BASE` variables are documented in `.env.example` (enforced by
`verify:install` check 25). The `AEGIS_*` names are read through a computed key, so the static scanner
cannot see them; they are documented explicitly anyway, because an undocumented knob is a knob nobody
sets correctly during cutover.

---

## 8. Security review of the new surface

- **Authentication:** all three routes sit behind `createAuthenticator`; 401 without a session (asserted).
  No permission is required, matching the legacy controller.
- **No mutation, no CSRF surface:** the module exposes three `GET` routes only. It writes exactly one kind
  of record — the fallback audit event — and does so from the server side.
- **Outbound calls are bounded and allow-listed by construction:** only the configured Binance and
  Frankfurter hosts (plus the two hard-coded Binance mirrors) and an explicitly configured licensed-feed
  URL are ever requested. URLs come from config validated as HTTPS in production, never from a request
  parameter, so the endpoints cannot be used as an SSRF pivot.
- **Unauthenticated amplification removed:** the public status route never probes (§5, divergence 5).
- **Input validation:** every query parameter is declared; unknown parameters are ignored by the query
  dialect and declared ones are type/length/enum/bounds-checked. `limit` is bounded at 5000, so a caller
  cannot ask a provider for an unbounded series.
- **Untrusted payloads:** provider responses are normalized field by field; nothing is passed through to
  a caller or into a cache without validation. Volume, price and timestamp sanity are all enforced.
- **Secrets:** `AEGIS_*_TOKEN` is sent only as a `Bearer` header to the configured licensed URL and is
  never logged, echoed in a response, or included in an error message.
- **Memory:** caches bounded (§5, divergence 6); the failure log is keyed by provider name (7 entries max
  with the default registry).
- **Denial-of-service posture:** the module inherits the global API rate limit and the per-client
  concurrency ceiling; a slow or dead upstream cannot hold a request open past `MARKET_DATA_DEADLINE_MS`.

---

## 9. What was **not** exercised (honest limitations)

1. **No live upstream call succeeded.** This sandbox has no egress to `api.binance.com`,
   `data-api.binance.vision`, `api1.binance.com` or `api.frankfurter.dev`. Real-provider behaviour is
   therefore verified against injected transports and stub payloads, and the DOWN → fallback → synthetic
   path is verified live. **A host with egress must re-run the rehearsal before cutover**; that is a
   Phase 5/6 checklist item, not something this document can claim.
2. **The two suites were not compared value-for-value.** The legacy oracle *was* executed here
   (`node runtime/run-tests.mjs` → 367 passed, including all eleven `02-providers` cases), so both sides
   are green. What is missing is a machine diff of the *numbers*: an attempt to boot WASM PHP directly and
   dump `MathUtils::hashString`, `seededRandom`, `gaussian`, `SyntheticProvider::generate` and
   `CandleNormalizer::normalize` output as JSON timed out in this sandbox, so the golden constants in the
   Node suite (synthetic first/last timestamps, the FNV offset basis, PRNG sequences) were produced by the
   Node port and pin it against *future* drift, not against PHP's output today. Closing that gap — a small
   `runtime/` extraction script, or the same comparison on a host with a native `php` binary — is a
   cutover prerequisite, and it is cheap: the algorithms are pure functions with no database or network.
3. **No licensed feed exists.** All four adapters are inert scaffolds. No vendor, schema, license or
   latency has been verified, and nothing in this phase claims otherwise.
4. **No database path was exercised.** Every test and the rehearsal used the file adapter; there is no
   MySQL/MariaDB in this sandbox (finding F-15 stays open). Market data writes only audit rows through
   the repository contract, so the MySQL path is exercised by the contract tests — but not against a real
   server.
5. **No user interface.** This phase is API-only: the SPA has no market-data view, no chart and no
   provider-health panel. The legacy UI surfaces that consumed market data (`views/dashboard`,
   chart partials) remain unported and belong to the app-shell/dashboard workstream. `MODULE_STATUS`
   reports the *module* as ported on the strength of its API and its tests; it does not claim a UI.
6. **Indicators and the rest of `MathUtils` were not ported here.** `Indicators.php` (SMA/EMA/RSI/MACD/
   ATR/Bollinger) and the remaining math helpers belong to the **analysis** module, which is next in the
   dependency order. Only the three functions the synthetic generator needs came across with it.
7. **Boundary feeds stay with analysis.** `FundamentalsFeed`, `SentimentFeed` and
   `SentimentSnapshotValidator` are abstention contracts consumed by analysis agents, not market-data
   providers; they are deliberately out of scope here.
8. **No typecheck of the new module beyond the repository's `tsconfig`.** `tsc -p tsconfig.json --noEmit`
   is clean, but the Node platform is JavaScript with JSDoc; there is no per-module type surface to verify.
9. **MT5 bridge pytest (9 tests) was not re-run** — no Python bridge environment in this sandbox. It is
   unrelated to market data and remains a documented migration exception.

---

## 10. Findings after this phase

| Ref | Status | Note |
|---|---|---|
| F-02 (dependency outages answer 503 + `Retry-After`) | **Extended** | Market data is the first module with a real external dependency, and it follows the contract rather than the legacy 502 |
| F-14 (`.env.example` documents every variable) | **Still closed** | 53 documented; check 25 green |
| F-15 (no real MySQL verification) | **Open, unchanged** | This phase added no schema, which narrows but does not close it |
| F-11, F-12, F-16, F-18 | **Open, unchanged** | Untouched by this phase |
| F-24 (new) | **Open** | *Provider health is per-process.* Breakers, failure logs and caches live in one Node process. Under Passenger's multi-process model each worker keeps its own view, so `/market-data/providers` can answer `UP` from one worker and `DOWN` from another. Acceptable while PHP is authoritative; needs a shared store (or a single health prober) before market data is trusted operationally |
| F-25 (new) | **Open** | *No live-upstream verification exists anywhere in CI.* Every provider test injects a transport. A scheduled job on a host with egress should probe both real providers and record the result, so a silent upstream API change is caught by something other than a user |
| F-26 (new) | **Open** | *The ported numeric algorithms are not diffed against PHP output.* Both suites are green (367 legacy + 137 Node), but the golden constants in `test/market_data.test.js` came from the Node port; the WASM-PHP extraction attempt timed out here. They are pure functions — no database, no network — so the comparison is cheap and should be a cutover prerequisite (§9 item 2) |
| R-24, R-25 (new) | **Recorded** | External market-data dependency (egress, vendor drift, rate limits, no licensed feed) and the risk that labelled synthetic data is consumed as real by a later module. See `RISK_REGISTER.md`, "Additions after Phase 4" |

---

## 11. cPanel notes for this phase

- **Outbound HTTPS must be allowed** from the application's host for `api.binance.com` (and the mirrors
  `data-api.binance.vision`, `api1.binance.com`) and `api.frankfurter.dev`. On a shared host where
  outbound traffic is filtered, set `MARKET_DATA_REAL_PROVIDERS=0` and the platform will say plainly that
  it is serving synthetic data — it will not pretend otherwise.
- **No new files need to be writable** and no new directory is created: the module has no storage of its
  own. `STORAGE_DIR`/`UPLOAD_DIR` requirements are unchanged from Phase 2–3.
- **No migration to run.** Migration set stays at 001–004; `npm run migrate:status` is unaffected.
- **`verify:install` stays at 30 checks on purpose.** The required-file list was not extended with the 12
  new module files: `src/app.js` imports them at boot, so a partial upload that drops one fails loudly at
  startup instead of degrading quietly (which is what the icon and generated-document checks guard
  against). Adding entries would raise the count without adding signal.
- **Environment variables** are additive; an existing deployment keeps working with none of them set
  (real providers on, synthetic allowed, 6 s timeout, 2 retries, 15 s deadline, 5 s health budget).
- **Passenger/multi-process caveat (F-24):** health and breakers are per worker. Restarting the app
  clears them; there is nothing to migrate or warm.
- **Rollback:** delete nothing. Reverting the deployment to the previous artifact restores the 30-route
  surface; the legacy PHP endpoints are untouched and remain authoritative.

---

## 12. Entry criteria for the next phase (analysis)

The analysis module (`Aegis/AnalysisEngine.php`, `Indicators.php`, the agent set and consensus) may start
when:

1. This phase's tests are green on the target host, not only in the sandbox (`npm run check`).
2. The legacy oracle stays green (`node runtime/run-tests.mjs` here, `php index.php tools tests` on a
   native host) **and** F-26 is closed: the pure numeric functions (`hashString`, `seededRandom`,
   `gaussian`, `SyntheticProvider::generate`, `CandleNormalizer::normalize`, `Timeframes`) diffed
   value-for-value between PHP and Node, with any divergence recorded here rather than patched silently.
3. The analysis module imports `normalizeCandles`, `timeframeMs` and the market-data service **as they
   exist** — it must not re-implement normalization, and it must not widen the `validation.ok` rule to
   make a thin series analysable.
4. `Indicators.php` is ported with the same golden-value discipline used for `MathUtils`, and the
   abstention contracts (`FundamentalsFeed`, `SentimentFeed`, `SentimentSnapshotValidator`) come across
   with it, still abstaining.
5. Any analysis result that was computed from synthetic candles carries `provenance.synthetic` forward
   into its own payload — the label must survive the module boundary, or rule 4 of the master plan is
   broken one layer up.
