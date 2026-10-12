# Phase 15 — Sports Intelligence: data foundation, provider boundary, and the first PHP↔Node differential harness

**Row 14 of `UNFINISHED_MODULES.md`.** Slice 1 of a multi-slice row.

| | |
| --- | --- |
| Commit | this change |
| Tests | **752** Node assertions, 0 failures (was 689, **+63**) |
| PHP oracle | **367** passed, 0 failed · **0** PHP paths modified |
| Total executed | **1 119** |
| Install checks | **29/29** · **76** documented environment variables (was 69, **+7**) |
| Routes | **82** total, **7** admin, **1** sports route |
| Storage contract | **86** methods — unchanged, this slice adds no persistence |
| Tables | **24** across migrations **001–010** — unchanged |
| Version | **0.14.0** (was 0.13.0) |
| Module ledger | **9** ported · **5** partial · **3** not-ported, across 17 |

---

## 1. Why this row is sliced, and where the cut is

Row 14 is the largest row in the backlog by a wide margin — roughly four times
Phase 14:

| Component | Size |
| --- | --- |
| `application/libraries/Aegis/Sports/**` | **3 056 lines** across ~30 classes |
| `application/controllers/Api_sports.php` | 426 lines, ~24 endpoints |
| `application/controllers/Sports.php` + views | 137 + 324 lines |
| `SportsRepository` interface | **65 methods** across **18 tables** |
| `tests/cases/*sports*.php` | **16 oracle files** |

A single change containing all of that could not be reviewed, and an unreviewable
change is how a platform ends up with an unverified "complete" claim — which the
migration plan forbids outright. So the row is cut along its **dependency order**,
and this phase takes the layer everything else reads from:

```
providers ──> normalizer ──> matches / odds / results ──> quality gates ──> [predictions] ──> [tickets] ──> [settlement]
                └── this slice ──────────────────────────────────────┘        └── not ported, slices 2–5 ──┘
```

**Ported in this slice (7 classes, 1 013 lines of legacy):**

| Legacy | Lines | Node |
| --- | --- | --- |
| `SportsDataNormalizer` | 64 | `modules/sports/normalizer.js` |
| `DataQualityEngine` | 26 | `modules/sports/quality.js` |
| `OddsFreshnessEngine` | 18 | `modules/sports/quality.js` |
| `Providers\ProviderException` | 20 | `modules/sports/provider-error.js` |
| `Providers\SportsDataProvider` + `SportsProviderManager` | 112 | `modules/sports/providers/manager.js` |
| `Providers\SandboxSportsProvider` | 215 | `modules/sports/providers/sandbox.js` |
| `Providers\HttpSportsProvider` | 140 | `modules/sports/providers/http.js` |
| `ProviderHealthMonitor` | 93 | `modules/sports/health-monitor.js` |
| `SportsIntelligence::registerProviders/status` (partial) | — | `modules/sports/service.js` |

**Not ported, and named as such by the API** (`SPORTS_NOT_PORTED`, ten entries):
ingestion persistence, predictions, value and staking, ticket governance and
optimization, settlement and result verification, calibration, backtesting, model
monitoring, the configuration service, and performance analytics/dashboards.

Consequences that are stated rather than left to inference:

- **`SPORTS_MODEL_DRIFT` remains unpublished.** `ModelDriftMonitor` is its only
  publisher, so **NV-6 is unchanged** by this phase. The `notifications` row still
  reads "every type except `SPORTS_MODEL_DRIFT` (row 14)".
- **No migration.** Seven tables were drafted and then **removed from this change**.
  Creating `wf_sports_matches` and six siblings that nothing reads or writes would
  have cost four pinned counts (backup table list, readiness, migrator's
  last-filename pin, two `stats()` maps) and bought a host a schema it cannot use.
  Slice 2 lands them together with the repository that fills them.
- **One route.** Legacy's ~24 sports endpoints all read or write the eleven tables
  this slice does not create. A `GET /api/v1/sports/matches` that answered from a
  live provider call would return a different thing under a familiar name, and the
  name is what an operator and the SPA both rely on.

---

## 2. The differential harness — F-26 closed

`RISK_REGISTER.md` has carried **F-26** ("no PHP↔Node differential harness") since
Phase 4. Phase 14 preserved legacy's error messages and timestamp shape
specifically to keep that option open and could not use it. **This phase uses it.**

`runtime/parity/sports-golden.php` `require`s six legacy class files by path and
emits their real output as JSON. `runtime/sports-parity.mjs` runs it in WASM PHP
8.2 and writes `apps/workforce-platform/test/fixtures/sports-parity-golden.json`.
`test/sports_parity.test.js` recomputes every case with the Node port and asserts
the two agree — **16 tests, 62 captured cases**, to the last double and the last
character of every error message.

| Group | Cases | What is compared |
| --- | --- | --- |
| fixture normalization | 23 | values *and* refusal messages |
| odds normalization | 13 | values *and* refusal messages |
| data quality | 14 | score, band, both eligibility flags, the checks array |
| odds freshness | 12 | verdict, `ageSeconds`, score, reason |
| sandbox provider | 12 fixtures + internals | health, fixtures, odds, results, refusals, `strength`, `form`, `externalId`, `pairing`, `kickoffTs`, `randValue`, `randInt`, `poisson`, `parseExternalId` |

This was only possible because of **which** classes were ported first. These four
are pure — no I/O, no global state, no database, no clock reads beyond an
injectable `now`. Every earlier candidate either touched the database or diverged
numerically on purpose.

Determinism is engineered into the capture, not hoped for: the generator asks the
sandbox only for dates **entirely in the past**, so every fixture is `FINISHED` and
every `observedAt` resolves to `kickoff − 7200` rather than to "now". The three
fields that genuinely are "now" are replaced with a `<NOW>` sentinel **in the
generator**, so the committed artifact does not change when it is regenerated, and
the Node test applies the identical substitution.

Regenerating is part of the workflow, not a recovery step:
`node runtime/sports-parity.mjs`. The generator lives under `runtime/` and touches
nothing in `application/`, so `git status --porcelain application/ system/ tests/`
stays empty — which `platform_findings.test.js` asserts independently.

### F-34 — PHP has two different CRC-32 algorithms, and legacy uses both in one class

**The harness found this on its first run.** It is recorded as a finding because it
is a property of PHP that any future port will hit, not a mistake confined to this
one.

| PHP call | Algorithm | `"123456789"` |
| --- | --- | --- |
| `crc32($s)` ≡ `hash('crc32b', $s)` | reflected CRC-32/ISO-HDLC (`zlib`'s) | `cbf43926` |
| `hash('crc32', $s)` | **non-reflected CRC-32/BZIP2, rendered little-endian** | `181989fc` |

`SandboxSportsProvider` uses `crc32()` for per-team strength and `hash('crc32', …)`
for the league component of every external id — **both in the same class**.

The Node port implemented the reflected algorithm once and used it for both. The
result was stable, plausible, self-consistent and wrong: `sim-bc27c7-…` where PHP
produces `sim-f3ff5d-…`. Every fixture id belonged to a different fixture universe
than legacy's. **No test written against the Node implementation alone could have
caught it**, because the Node implementation agreed with itself perfectly. Nothing
would have failed until legacy data met Node data — which is row 22, the cutover,
the worst possible moment to discover it.

Two exports now exist and are separately pinned: `crc32()` (reflected) and
`crc32HashHex()` (BZIP2, byte-swapped via `Buffer#swap32()` so the intent is stated
rather than buried in four masks). The second byte-swap is the part that is easy to
" simplify" away later, so `test/sports.test.js` asserts
`crc32HashHex("123456789") === "181989fc"` next to
`crc32BigEndian("123456789") === 0xfc891918`.

---

## 3. Defects found and fixed while porting (D-22 … D-26)

| # | Defect | How it was caught | Why it matters |
| --- | --- | --- | --- |
| **D-22** | The two CRC-32 algorithms conflated into one (F-34's instance here). | The differential harness, first run. | Would have produced an incompatible fixture universe, silently, until row 22. |
| **D-23** | `normalizeFixture`'s `now` was documented and read as a **number** while the broker normalizer's is a **function**. A caller passing a function got `new Date(fn)` → Invalid Date, so a *valid* fixture that simply omitted `sourceTimestamp` was refused as `"sourceTimestamp is invalid"`. | The harness, on its first case. | A wrong clock convention does not look like a wrong clock convention — it looks like the provider sent bad data, which sends an operator to the wrong system. `toClock()` now accepts both and the two ports share one convention. |
| **D-24** | `?probe=1` never reached the handler. `validateRequest` **rebuilds `request.query` from `querySchema`**, so an undeclared parameter is dropped rather than passed through. The route silently always took the cheap reading. | `test/sports_http.test.js`. | A flag that looks settable and is not read is the same shape as **F-30** and **D-21**. Checked the rest of the platform: `market-data`'s `PROVIDERS_QUERY` does declare `refresh`, so no shipped route is affected. |
| **D-25** | `loadSportsConfig` reused `brokerBaseUrl`, which keeps only `parsed.origin`. A vendor hosted at `https://feed.example.com/v1` would have had `/v1` **silently dropped**, and every request would 404 against a path that looks correct in the configuration. | Inspection against legacy's `rtrim($baseUrl, '/')`, before shipping. | Origin-only is right for the MT5 bridge (a local service at its root) and wrong for a third-party REST vendor. `sportsBaseUrl()` now keeps the path and additionally refuses a query string, a fragment and embedded credentials. |
| **D-26** | The `probe` flag was first written as a string with a hand-rolled value list. It worked, and it contradicted the platform: `validate.js` **already coerces** query booleans from `1`/`true`/`yes` and `0`/`false`/`no` **case-insensitively**, so `?probe=YES` was refused on this route and accepted on every other boolean flag on the platform. | Comparison against `PROVIDERS_QUERY`. | Two sources of truth for one convention is how flags end up behaving differently depending on which module you call. Now `{ type: "boolean", default: false }`, matching market-data. |

D-24 and D-26 are the same lesson twice in one file: **read the platform's existing
convention before writing a parallel one.**

---

## 4. Divergences SP-1 … SP-11

| # | Divergence | Reason |
| --- | --- | --- |
| **SP-1** | The pure classes emit legacy's `gmdate('c')` shape (`+00:00`, second precision), not the platform's canonical `…Z`. | They are the differential harness's subject; a formatting difference would fail every comparison on a technicality rather than on behaviour. `src/lib/php-date.js#toCanonicalUtc` exists for the persistence boundary slice 2 adds, so a stored column will be canonical while a normalized payload stays legacy-shaped. Shared with the broker port from one module so the two cannot drift. |
| **SP-2** | `parseStrictInstant` accepts a calendar instant with an optional time and offset and **refuses everything else**, where PHP's `DateTime` also accepts relative text (`"now"`, `"+1 day"`). | PHP accepts forms `Date` reads differently: `new Date("12345")` is the *year 12345* (**D-12**) and `new Date("0")` is the year 2000 where PHP throws. The harness proved PHP also refuses numeric strings, so for those the strictness is **parity, not a tightening**. Relative text is refused because it would resolve differently in two runtimes at two moments and could never be compared. Fail-closed. |
| **SP-3** | Legacy's `context()` ends `$out === null ? null : (count($out) ? $out : null)`. `$out` is initialised to `[]` and never assigned `null`, so the first branch is unreachable. Ported as its effective behaviour: an empty context is `null`. | Recording it makes the omission a decision rather than an oversight. |
| **SP-4** | Every provider method and every manager method is `async`. | Legacy blocks on `file_get_contents`; Node does non-blocking I/O. Same divergence as **BC-8**. Shapes unchanged. |
| **SP-5** | The HTTP provider sends `Authorization` on `GET /health` as well as on data calls, where the broker port **withholds** the token from its health probe (**BC-4**). | Different trust relationship. The MT5 bridge is a local service that accepts an unauthenticated probe, so withholding costs nothing. A third-party feed vendor may require auth on every endpoint including `/health`, and a probe that 401s would report `AUTHENTICATION_ERROR` for a provider that is fine. The contrast is recorded because a reader who knows BC-4 will ask. |
| **SP-6** | Provider redirects are **refused** (`redirect: "error"`). | Legacy's stream context followed them with the `Authorization` header still attached, so an upstream redirecting to a third host would have been sent this provider's bearer credential. Same tightening as **BC-14**. |
| **SP-7** | A transport exception becomes the generic message `"provider transport failure"`; the original is kept as `error.cause`. | Legacy interpolated `$e->getMessage()`. Node's `fetch` rejects with `cause` chains that can carry a resolved address, and an error string that reaches an audit row must not name a host the deployment chose to keep private. The classified status (`OFFLINE`) — the part the fallback chain acts on — is unchanged. |
| **SP-8** | The sandbox opt-in is **two** variables and both default off. | `WINDELS_SPORTS_MODE` defaults to `SANDBOX`, so mode alone would enable the labelled simulation on a host that configured nothing at all. Legacy has the same rule; what is stated here is why it is not redundant, because it reads like it is. |
| **SP-9** | A feed base URL **keeps its path prefix**; credentials, a query string and a fragment are refused; plain `http://` is refused in production except for a loopback host. | Legacy used `filter_var(…, FILTER_VALIDATE_URL)`, which accepts plain http anywhere — a feed token in transit. See **D-25** for why origin-only would have been worse than legacy. |
| **SP-10** | `status()` **does not probe** by default. Legacy's did: its `status()` returned `liveHealth`, an outbound request per provider on every dashboard load. A live probe is opt-in (`?probe=1`) and its result is stamped `persisted: false`. | **BC-11**'s reasoning applied to third-party vendors rather than local bridges. Derived health comes from stored observations; this slice stores none, so it is `UNKNOWN` — the monitor's defined answer when it has witnessed nothing, not a placeholder. `statusSnapshot()` on the unauthenticated surface is synchronous and never contacts a provider. |
| **SP-11** | `ProviderHealthMonitor` scans health history for a failure **skipping rows dated in the future**, but picks `latest = health[0]` with **no** such guard. A provider whose clock is ahead therefore cannot invent a failure, yet its skewed row still shadows the newest real observation and rule 6 cannot fire — the result is `DEGRADED` instead of `ONLINE`. | Legacy behaves identically. It is wrong, but wrong in the pessimistic direction, and "preserve behaviour before improving" is the rule this migration runs under. The fix is a one-line guard and belongs in a phase whose brief is to improve. Pinned by a test so the asymmetry cannot be "fixed" accidentally. |

---

## 5. What the gate semantics actually are

### The fallback chain

`withFallback(operation, fn, preferredId?)` returns **`{ok: true, provider, result, failures}` or `{ok: false, failures}`** — never an empty success. Legacy's contract is
*"If no provider can serve the request the caller receives a structured failure — the pipeline then degrades safely (no fabricated data, no forced tickets)."* An empty
list on total failure would be indistinguishable from a day with no fixtures, and a downstream ticket engine would have to guess which it was looking at.

Per attempt: health is consulted **fresh** (a provider that failed the last call may have recovered, and one that succeeded may have just been rate-limited); a
non-`ONLINE` provider is skipped and named in `failures`; a `ProviderError` keeps its classified status; anything else is classified `DATA_ERROR`. Every outcome —
success, classified failure, **and silent skip** — reaches the health observer, because a provider that is never consulted would otherwise look healthy forever. An
observer that throws is swallowed: *"health observation must never break sync."*

### The quality gates

Nine weighted checks totalling **108** points: the five required fixture fields at 12 each, odds availability **18**, recent form 12, provider reliability 10,
freshness 8. Odds carry the heaviest single weight because a fixture with no price has no value to find — missing odds alone drops a fixture from `EXCELLENT` to `GOOD`.

Two eligibility flags, and the asymmetry is the design: **`eligibleForTicket` (score ≥ 75 *and* fresh) is strictly harder than `eligibleForPrediction` (score ≥ 60).**
A fixture can be good enough to predict on and still not good enough to stake on, because predicting is reversible and staking is not.

PHP's `empty()` semantics are preserved exactly: `0`, `0.0`, `"0"`, `""`, `false`, `null` and `[]` are all empty, so a required field holding the *string* `"0"` counts as
missing. A JavaScript truthiness check would disagree on precisely the payloads that matter, and three golden cases pin it.

### The health monitor's seven rules, in precedence order

1. Nothing observed → **`UNKNOWN`** (never a guess in either direction).
2. A terminal self-report (`AUTHENTICATION_ERROR`, `RATE_LIMITED`) within 30 min → wins outright; fallback cannot fix either.
3. A failure within 5 min → that status if terminal, else `DEGRADED`, detail `failing since …`.
4. Stale on **both** channels (> 6 h, no recent observation *and* no recent run) → `OFFLINE`. Requiring both is what separates "nobody has asked this provider for six hours" from "it has been failing for six hours".
5. Run error rate ≥ 50% → `DEGRADED`, detail naming the sample size.
6. Latest observation `ONLINE` → `ONLINE`, and the **only** branch that earns the recency boost.
7. Otherwise `DEGRADED` — pessimistic, which is the safe direction for a data source.

Reliability is `(success/total) × 1.0` boosted or `× 0.95` unboosted, so a perfect run history still cannot claim exactly `1.0`. With no runs at all the answer is `0.5`
boosted and `0.0` otherwise: a provider that just answered is probably fine; no evidence earns no credit.

### The sandbox provider

Double-gated, deterministic, and **I/O-free** — which is why this slice can be tested end to end where Phase 14 had to inject a fake transport for every gate. Every
record carries `simulated: true`. Injuries and lineups are **never** produced, deliberately: a simulation that also invented injuries would let a model believe it had
richer inputs than any real provider supplies, and the gap would only appear in production. Leaving the same fields missing means the sandbox exercises the *refusal*
paths rather than bypassing them.

`results()` returns `[]` for today or any future day — *"not finished — nothing fabricated"*. That refusal is the single most important behaviour in the class: a
simulation that returned a score for an unplayed match would fabricate an outcome.

`health()` reports `reliability: 0.9` when enabled — deliberately below the `1.0` a real provider could earn, because reproducible is not the same as trustworthy.

---

## 6. Authorization — a positive finding

**`Api_sports` is the best-gated controller in the legacy application.** Every read requires `sports.view`; writes require `sports.manage`; approval and settlement have
their own `sports.approve` and `sports.settle`. The Node route requires `sports.view` **because legacy did**, not because a finding forced it.

That contrast is worth stating next to **F-32**, where `Api_system` left `brokers()`, `mt5_account()` and `mt5_quote()` ungated entirely. F-32's own conclusion was that
the defect is a property of *the legacy API surface* rather than of one controller; this is the counter-example that makes the point precise — **the same codebase got one
module's authorization right and another's wrong.** "Legacy did it this way" is therefore evidence about a controller, never about the application, and each controller has
to be read.

Node's permission baseline already declared `sports.view`, `sports.manage`, `sports.approve`, `sports.settle` and the `sports_admin` / `sports_viewer` roles
(`src/db/platform-baseline.js`), so no catalog change was needed — only the first of the four is enforced yet, because only one route exists.

---

## 7. Verification

```
npm run check          0 failures
npm run verify:install 29/29 · 76 documented environment variables
npm test               752 tests, 752 pass, 0 fail
node runtime/run-tests.mjs   367 passed, 0 failed
git status --porcelain application/ system/ tests/   (empty)
```

New test files: `test/sports_parity.test.js` (16), `test/sports.test.js` (39), `test/sports_http.test.js` (8).

Route inventory, probed rather than assumed: **82** routes, **7** admin, and exactly one sports route —
`GET /api/v1/sports/status`, `permission: "sports.view"`, `validated: true`.

---

## 8. Not claimed

- **No persistence.** Nothing this module reads is stored. Seven tables were drafted and removed from this change (see §1).
- **No sync, prediction, value calculation, ticket, settlement, calibration, backtest, model metric or dashboard.** Ten `notPorted` entries say so in the API response.
- **`SPORTS_MODEL_DRIFT` is still unpublished**, so **NV-6 is unchanged**.
- **No provider is verified against a real vendor.** There is no configured sports data source for this platform; the HTTP provider's behaviour is proven against an injected transport, which is sufficient for the classification logic and insufficient to claim any vendor works.
- **The health monitor and the manager are not covered by the differential harness.** They are pure enough to be, but their inputs are repository rows, and the repository does not exist in this slice. Synthesising rows on the PHP side to compare against would test a fiction; slice 2 captures them against the real thing.
- **`Api_sports`'s ~24 endpoints are absent**, not approximated.
- **No console UI**, as for every ported module (**F-29**). The `notPorted` matrix travels in the API response for that reason (**BC-10**).
- **Row 14 remains `partial`, not `ported`.** Four more slices are owed.

## 9. Remaining slices for row 14

| Slice | Contents | Tables |
| --- | --- | --- |
| **2 — ingestion** | migration 011, `SportsRepository`'s 22 foundation methods, `SportsSyncService`, `SportsCronService`, the health observer writing real observations | `sports_data_sources`, `sports_provider_health`, `sports_matches`, `sports_odds`, `sports_results`, `sports_data_quality_assessments`, `sports_sync_runs` |
| **3 — prediction** | `PredictionPipeline`, `FeatureEngineeringEngine`, `MatchIntelligenceEngine`, `ConfidenceEngine`, `CalibrationEngine`, `ModelPerformanceService` | `sports_model_versions`, `sports_predictions`, `sports_calibrations`, `sports_configurations` |
| **4 — tickets** | `TicketGovernance`, `ValueEngine`, `RiskEngine`, `CorrelationEngine`, `TicketOptimizer`, `DailyTicketService` | `sports_tickets`, `sports_ticket_selections`, `sports_daily_tickets` |
| **5 — settlement and monitoring** | `TicketSettlementService`, `ResultVerificationEngine`, `SportsBacktester`, `ModelDriftMonitor` (**closes NV-6**), `PerformanceAnalytics` | `sports_results` verification, `sports_backtests`, `sports_model_metrics`, `sports_job_runs`, `sports_performance_snapshots` |

Slice 2 is the one that makes this slice useful: with the tables in place the
provider boundary stops being a reader and becomes an ingest, the health monitor
stops deriving `UNKNOWN` and starts deriving something, and the harness can extend
to the two classes it currently cannot reach.
