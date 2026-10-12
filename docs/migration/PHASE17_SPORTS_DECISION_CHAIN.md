# Phase 17 — Sports Intelligence: the decision chain (row 14, slice 3 of 5)

> **Status: slice 3 landed; slices 4 and 5 are not started.** This record covers the
> prediction pipeline, match intelligence, feature engineering, confidence, value, risk,
> the configuration service, the model registry, calibration approval and model
> performance. It does **not** cover correlation, staking, tickets, settlement, calibration
> fitting, backtesting or model drift. Those are slices 4 and 5, and they remain not ported.
> The previous record is [`PHASE16_SPORTS_PERSISTENCE.md`](PHASE16_SPORTS_PERSISTENCE.md).

## 1. What this slice is

Slices 1 and 2 stored and ingested sports data. Slice 3 is the first slice that **decides**.
A fixture is evaluated against its quality, re-assessed now from its latest odds, the
provider's current reliability and its recent form, plus an approved calibration, under the
configuration in force. The conclusion and every input it used are stored immutably, so the
reasons for a refusal can be read back later.

Nothing in this slice places a bet, sizes a stake or builds a ticket. No stored result is
verified, so no decision can yet be scored against an outcome.

## 2. What was ported

| Legacy (PHP, read-only) | Node | Notes |
|---|---|---|
| `Aegis\Sports\PredictionPipeline`, `PredictionEngine`, `FeatureEngineeringEngine`, `MatchIntelligenceEngine` | `src/modules/sports/intelligence.js` | Feature building, `predictOver15`, `evaluatePrediction`, `finalize`. Logistic calibrated probability (DV-12). |
| `ValueEngine`, `ConfidenceEngine`, `RiskEngine` | `intelligence.js` | Pulled forward from slice 4, as the user approved. |
| `CalibrationEngine` | `src/modules/sports/calibration.js` | `applyCalibration`, `applyFittedCalibration`, `evaluateCalibration`, and `fitCalibration`. The fit is ported and parity-tested, but the service refuses it until slice 5 (§4). |
| `ConfigurationService` | `src/modules/sports/configuration.js` | Defaults, validation, and `planConfigurationUpdate`. |
| `ModelPerformanceService` | `src/modules/sports/model-performance.js` | Window and metric arithmetic. Ticket metrics are `NOT_PORTED` (`TICKET_METRICS_STATUS`). |
| `DecisionRecorder` | `src/modules/sports/intelligence-service.js` | Loads inputs, runs the pure chain, persists, audits. It computes no probability, value or gate itself. |
| PHP `round()` | `src/lib/php.js` (`phpRound`) | Reimplements PHP 8.2 pre-rounding. See the `quality.js` caveat in §8. |

## 3. Findings

### F-36 — legacy's Brier score is always 0.0

`CalibrationEngine::evaluate` casts each squared error with `(int)`, so every error below 1
becomes 0 and the Brier score is always `0.0`. The port computes the real squared error. The
affected values are `brier`, `identityBrier` and the model-performance `brier`. A Node Brier
is therefore not a parity failure, and the legacy figure measured nothing.

### F-37 — legacy's calibration is linear; Node's is logistic, and the choice changes decisions

Legacy applies the fitted intercept and slope **linearly** to the raw probability. Node uses
`sigmoid(intercept + slope · raw)`, the Platt form the name promises. **The user chose the
logistic form (DV-12).** It changes decisions: a case that is fully qualified is `REJECTED`
with `LOW_MODEL_EDGE` under the linear form and `QUALIFIED` under the logistic form.

A consequence was open, and is now decided. Under the logistic form, the identity fallback
(used when a fit is degenerate) would return `sigmoid(raw)`. **The user chose `raw`.** A
degenerate fit is stored with method `identity`, and `applyFittedCalibration` returns the raw
probability for it, clamped like every other output. A fit that happens to be 0 + 1·x is still
logistic, because its method says so.

This is a further divergence from legacy. Legacy's fallback keeps the method `platt` and is
measured through the logistic map (4 of the 7 calibration golden cases are fallbacks). The
golden test asserts the divergence explicitly rather than hiding it (`isIdentityFallback`).

### F-38 — the stored quality could never qualify a decision (closed by re-assessment)

Before this change, evaluation read the **latest stored quality assessment**. The fixture sync
writes that assessment without odds or recent form (SP-22), so `eligibleForTicket` stayed
`false` and every decision was refused. This was observed: with an approved calibration and a
fresh price, the chain reached `PREDICTION_READY` (raw 0.754, calibrated 0.680, expected value
0.292, confidence 79.21), and the gate still refused it on `LOW_DATA_QUALITY` (72 against a
floor of 75) and `STALE_OR_INCOMPLETE_DATA`.

Legacy's controller has the same stored-quality read (`Api_sports.php:90`). Legacy's
`DailyTicketService` (`:101`) re-assesses with the current odds before it evaluates. **The user
chose re-assessment** for the evaluate route, which is the daily ticket's behaviour. The
re-assessment is `currentQuality` in `intelligence-service.js`, and it reads the same inputs
legacy's `qualityContext` reads:

- the odds in use, and their age (or the fixture's `sourceTimestamp` when there are no odds),
  against a 3600-second limit;
- the provider's reliability, derived from its stored health observations and sync runs by the
  monitor the status route uses (0 when the provider has no history, as legacy's `?? 0`);
- recent form, read from `payload.context.recentForm` (legacy's `$match['context']`).

It writes **no quality row**. The sync stays the only writer of quality rows (DV-18).

**Consequence, observed.** With a fresh price and a sync that succeeded, the re-assessed score
is **100** (EXCELLENT), the gate says `QUALIFIED`, and the decision carries `simulated: true`,
because the sandbox emits that flag. The gate does not refuse simulated data. Legacy treats the
flag as informational too (`PredictionPipeline.php:59`), and the port matches. So a sandbox
fixture can qualify a decision. Slice 3 creates no ticket from it, and the flag is stored with
the decision, so a reader can see it. Whether a `simulated` decision should be allowed to qualify
is an open decision for the user (§9).

With a price three hours old, the same re-assessment is refused, because freshness fails. The
test `a stale price is refused` pins this. The test `a READY prediction is QUALIFIED` pins the
qualifying path and asserts that the stored quality row is unchanged.

## 4. The surface

### Repository

Twelve module-prefixed methods on both adapters, identical in behaviour and checked by the
same contract:

`ensureSportsModelVersion`, `listSportsModelVersions`, `saveSportsPrediction`,
`findSportsPrediction`, `listSportsPredictions`, `saveSportsConfiguration`,
`activeSportsConfiguration`, `listSportsConfigurations`, `saveSportsCalibration`,
`findSportsCalibration`, `listSportsCalibrations`, `decideSportsCalibration`.

Three of them behave differently from the foundation:

- **Predictions are insert-only.** There is no update or delete method, and a duplicate id is
  not swallowed (SP-31).
- **Configuration versions are unique.** A second writer that computes the same next version
  loses on the `UNIQUE` key. The method returns `null`, which the service maps to 409
  `SPORTS_CONFIGURATION_CONFLICT` (SP-29).
- **Calibration decisions are compare-and-set.** `decideSportsCalibration` updates only a
  `PENDING` row and reports whether it did (SP-28).

Contract counts: **REPOSITORY 108 → 120**, **SPORTS 22 → 34**.

### Routes

**13 added**, for **20** sports routes and **101** in total (was 88, with 7 sports routes).

| Method & path | Permission | Notes |
|---|---|---|
| `GET /sports/configuration` | `sports.manage` | The stored configuration, or the built-in default |
| `GET /sports/configuration/versions` | `sports.manage` | Versions, newest first |
| `PATCH /sports/configuration` | `sports.manage` | Requires `reason` (422 `CONFIGURATION_REASON_REQUIRED`). `AUTOMATED_EXECUTION` is refused in every case (DV-14) |
| `GET /sports/models` | `sports.view` | The registry of model identities |
| `GET /sports/models/performance` | `sports.view` | `samples: 0` and `null` metrics until settlement exists (slice 5) |
| `GET /sports/calibrations` | `sports.view` | Filter by status and model version |
| `POST /sports/calibrations/fit` | `sports.manage` | Always **422** `SETTLED_OUTCOMES_UNAVAILABLE` until slice 5 |
| `POST /sports/calibrations/:calibrationId/approve` | `sports.manage` | PENDING only; 409 otherwise |
| `POST /sports/calibrations/:calibrationId/reject` | `sports.manage` | PENDING only; 409 otherwise |
| `POST /sports/matches/:matchId/evaluate` | `sports.manage` | Records a decision from quality re-assessed now (F-38). No stored assessment is needed. 404 for an unknown fixture |
| `GET /sports/matches/:matchId/intelligence` | `sports.view` | Preview only. Stores nothing. `qualityAssessed` is always true, because quality is always re-assessed |
| `GET /sports/predictions` | `sports.view` | Filter by match, model version and decision |
| `GET /sports/predictions/:predictionId/decision` | `sports.view` | The stored decision with its gate |

### Audit actions

Dotted lowercase, the platform convention. Legacy's `SPORTS_CALIBRATION_*` names are
translated, not copied.

- `sports.decision.recorded` — a decision is stored
- `sports.configuration.updated` — a configuration version is published
- `sports.calibration.approved` / `sports.calibration.rejected` — a calibration is decided

## 5. Migration 012

Four tables, taking the schema from **31 to 35**. Migration 011 is unchanged.

- `wf_sports_model_versions`: identity is `(model_name, model_version, feature_version,
  calibration_version)`, `UNIQUE`. The uncalibrated state is stored as `''`, because a
  `UNIQUE` key treats NULLs as distinct. The reader presents `''` as `null`.
- `wf_sports_predictions`: `id` is `VARCHAR`, `prd_` plus 24 lower-case hex digits, generated
  before the insert as legacy does. `decision` holds the verdict. `rejection_reasons` holds
  the gate's **full** list (DV-17), so the verdict can be re-derived. `correlation` defaults
  to `UNKNOWN` (SP-32). `factors` and `input_version` record what the decision used.
- `wf_sports_configurations`: `version` is `UNIQUE`. Rows are never updated.
- `wf_sports_calibrations`: `status` is `PENDING`, `APPROVED` or `REJECTED`.
  `approved_by` and `approved_at` are stamped on a rejection as well (SP-27).

**Not run against a MySQL server.** The adapter is checked against a scripted executor in
`sports_intelligence_store.test.js`. F-15 still holds.

## 6. Divergences

Numbering continues from Phase 16, whose last entry is SP-26. Two IDs used during development,
SP-24 and SP-25, were already taken by earlier records and were reassigned.

| ID | Divergence | Kind | Why |
|---|---|---|---|
| **DV-12** | Logistic calibration, not linear (F-37) | Deliberate | User-chosen. It changes decisions. |
| **DV-14** | `AUTOMATED_EXECUTION` is refused in every case; a request cannot set the override | Deliberate | Legacy accepts `allowAutomatedExecution` from the request body. The Node route never passes it, and Node has no execution connector. The user accepted "no override". |
| **DV-15** | Types are checked before ranges | Deliberate | Legacy casts with `(float)` first, so `"abc"` becomes `0` and fails on a range. Node refuses the type up front. |
| **DV-17** | The stored decision keeps the gate's **full** rejection list | Deliberate | A first-reason-only record cannot show every refusal. |
| **SP-27** | A rejected calibration is stamped with `approved_by` and `approved_at` | Preserved | Legacy stamps on any status change when an actor is given. Kept as written. |
| **SP-28** | Calibration decisions are compare-and-set on `PENDING` | Necessary | Legacy checks the status in the controller, then runs `UPDATE … WHERE id` with no status condition. Two administrators can both succeed. |
| **SP-29** | Configuration versions are unique. A lost race is `null`, mapped to 409 | Necessary | Legacy's `saveConfiguration` is a bare insert, and nothing in the application checks for an existing version first. |
| **SP-30** | The calibration version label uses the float form (`i0.5`) everywhere | Alignment | `DailyTicketService::calibrationVersionLabel` reads DECIMAL columns, which arrive as strings (`i0.500000`). The fit path reads floats. One form is used. |
| **SP-31** | Predictions are insert-only | Necessary | A decision is evidence. It must not be rewritten. |
| **SP-32** | `correlation` is stored as `UNKNOWN` | Deliberate | Legacy's pipeline supplies a fixed `LOW` classification to the candidate. It does not measure correlation. A stored `LOW` would claim a measurement that never happened. |
| **SP-33** | ~~Evaluation refuses with 409 when no quality assessment is stored~~ | Superseded | Withdrawn with F-38. Evaluation re-assesses, so there is nothing to be missing. |
| **DV-18** | Re-assessment is recorded in the decision, not written as a quality row | Deliberate | Legacy's daily ticket writes the new quality (`saveQuality`). The port does not, so the sync stays the only writer of quality rows and the stored assessment keeps its meaning. |
| **DV-19** | The identity fallback is labelled `identity` and returns the raw probability | Deliberate (user-chosen) | Legacy keeps `platt` and measures the fallback through the logistic map. See F-37. |
| **SP-34** | The model-performance window compares instants, not formatted strings | Alignment | Legacy compares `Y-m-d H:i:s` against ISO strings, which misclassifies the boundary day. |
| **Q-2** | `LOW_CONFIDENCE` is appended on `NO_PREDICTION` when `min_confidence > 0` | Preserved (quirk) | Legacy's `($conf['confidence'] ?? 0) !== null` is always true (`PredictionPipeline.php:118`). Ported as written, and marked in `intelligence.js`. |
| **F-36** | Legacy Brier is always 0.0 | Divergence | See §3. |

One legacy idiom is worth naming. `!empty($value['qualified']) === false` reads as "not
(not empty)". In PHP, `!` binds tighter than `===`, so it means `empty($value['qualified'])`.
The port uses `phpEmpty` and says so in a comment (`intelligence.js`, line 22).

## 7. The differential harness

The golden file `test/fixtures/sports-parity-golden.json` holds **272** case records. **134**
are Phase 16's sections, and no Phase 16 section changed. **138** are slice 3's, across 13
groups: `phpRound` 21, `calibration` 7, `calibrationApply` 6, `calibrationEvaluate` 2,
`configurationDefaults` 22, `configuration` 22, `intelligence` 13, `features` 4, `prediction` 7,
`value` 5, `confidence` 6, `risk` 12 and `pipeline` 11.

The Phase 16 record reports **124** comparable cases, but the golden's Phase 16 sections hold
134 records. That difference is not reconciled in this record. The golden is generated from
`runtime/parity/sports-golden.php`, run through the PHP WASM oracle.

`test/sports_intelligence_parity.test.js` checks the slice 3 groups (**16** tests). Four of the
seven calibration cases are identity fallbacks. For those, the test asserts the fit parameters,
sample counts and ECE against the golden, and asserts the identity label and version, which
are the documented divergence (F-37, DV-19).

## 8. What this slice does not claim

- **Reliability is derived, not measured live.** It comes from the stored sync history, the
  same derivation the status route uses. A provider with no history scores 0, which lowers the
  quality score; it does not refuse the decision by itself (F-38).
- **A sandbox decision can QUALIFY** (F-38). It is labelled `simulated: true`. This slice
  creates no ticket, paper position or stake from it.
- **No correlation, staking or ticket.** `correlation` is `UNKNOWN`. Nothing here reaches a
  paper, execution or broker path.
- **No calibration can be fitted.** Approval and rejection are real, but they are exercised
  in tests only against rows stored directly through the repository.
- **No outcome, so no accuracy.** Model performance reports `samples: 0` with `null` metrics.
  The `null`s are the answer, not a placeholder for zero.
- **No MySQL was exercised** (F-15).
- **`quality.js` is not yet on `phpRound`.** It uses `Math.round` at three points (lines 93,
  98 and 166). `Math.round` does not reproduce PHP 8.2 pre-rounding, so the two can differ at
  values such as 1.005. These inputs were not checked against the oracle in this slice.
- **No cron.** `SportsCronService` is still unported. The configuration service it depends on
  now exists.
- **NV-6 is unchanged.** `SPORTS_MODEL_DRIFT` is still unpublished, pending slice 5.
- **A degenerate fit is not reported as a fit.** The identity label is what says so. Its ECE and
  Brier are measured on the raw probability, which is not a calibration measurement.

## 9. Decisions

**Decided by the user (2026-10-12):**

1. **F-37 identity fallback.** Return the raw probability (DV-19), not `sigmoid(raw)`.
2. **F-38 evaluation quality.** Re-assess with the current odds, as legacy's daily ticket does
   (DV-18), not read the stored assessment as legacy's controller does.

**Open:**

3. **Simulated decisions may QUALIFY.** Re-assessment means a sandbox fixture with a fresh
   price can reach `QUALIFIED`, labelled `simulated: true`. Legacy's gate also ignores the flag.
   Options: (a) keep parity and rely on the label, which is the current state; (b) refuse
   qualification whenever `simulated` is true, which is a deliberate departure from legacy.
   Recommendation: (b), before any real provider is connected, because a qualified verdict is
   the thing an operator is most likely to act on.
4. **Calibration approval before slice 5.** The fit is refused until settlement exists. Is it
   acceptable that approval is only reachable through a stored row until then?
5. **Record numbering.** Slice 3 is Phase 17. This record assumes slices 4 and 5 become Phases
   18 and 19.

## 10. Gates

Measured in `apps/workforce-platform` on this branch, on 2026-10-12, Node v22.22.3.

| Gate | Result |
|---|---|
| `npm test` | **841 / 841** across **47** files (was 812 / 812 across 44). The 29 new tests are `sports_intelligence_http` (7), `sports_intelligence_store` (6) and `sports_intelligence_parity` (16) |
| `npm run check` | **exit 0** |
| `verify:install` | **29 / 29**; **76** documented variables |
| PHP oracle (`runtime/run-tests.mjs`) | **367 / 367** (oracle output: `367 passed, 0 failed`) |
| Legacy tree | `git status --porcelain application/ system/ tests/` is **empty** |
| Routes | **101** total (was 88); **20** sports (was 7) |
| Contract | **120** repository methods (was 108); **34** sports (was 22) |
| Schema | **35** tables (was 31); migrations **001–012** |
| Differential harness | **272** golden records (§7) |
| Version | **0.15.0**, unchanged. No release was cut |

Test pins were updated to the new counts: the table count and the migration list, the
readiness placeholder count (now 12), the contract lengths, the sports route inventory, and
the not-ported matrix. The `sports` ledger label in `src/modules/platform/health.js` was
rewritten to describe slice 3.

**Known stale pin:** `test/sports_http.test.js` still carries slice 2 values in its route
inventory, its prediction-absence check and its matrix test. It is not yet rewritten. This is
listed as an open item and is not claimed as done.

## 11. Ledger

`sports` stays **partial** in the ledger, because slices 4 and 5 are not built. The ledger text
is rewritten to describe slice 3 accurately. See [`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md)
row 14.
