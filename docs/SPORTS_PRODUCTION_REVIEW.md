# Sports Intelligence — Production Review (Integration Plan Step 6)

**Status:** code-level review **complete** — both findings remediated and pinned by
tests (`tests/cases/51-sports-production-review.php`). Process-level cutover items
remain (checklist at the bottom).

## Scope

The mutation surface, reviewed against the plan's security constraints
(authentication, RBAC, CSRF, rate limits, audit attribution, environment-only
credentials, no automated external execution):

| Surface | Endpoints |
|---|---|
| Console (MVC) | `POST /sports/(:id)/decide`, `POST /sports/(:id)/settle` |
| JSON API | `POST api/sports/tickets/(:id)/decide`, `POST api/sports/tickets/(:id)/settle`, calibration approve/reject, provider toggle |
| Cron | `php index.php tools sports-cron [fixtures\|odds\|results\|quality\|ticket\|settlement\|performance\|monitoring\|cleanup]` |

## Verified — no change needed

- **RBAC matrix** — `sports.view/manage/approve/settle` enforced on both console and API paths with the same permission checks; console uses the PRG pattern and refuses loudly. Pinned by case 49.
- **Audit attribution** — ticket recorded / approved / rejected / settled events carry the acting identity and reason; `decide()` and `settlePending()` always emit through the `AuditRepository`. Pinned by case 43.
- **Environment-only credentials** — provider credentials live in env only; provider payloads are untrusted and pass normalizers; the sandbox provider is online only when `WINDELS_SPORTS_MODE=SANDBOX` **and** `WINDELS_SPORTS_SANDBOX=1`.
- **Honest disable** — with no provider the module boots `DISABLED_NO_PROVIDER` and fabricates no fixtures, odds, predictions or tickets; demo data is always bannered (`DEMO / SANDBOX DATA`). Pinned by cases 47/50.
- **Kill switch boot default** — platform state defaults to `killSwitch.active = true` ("orders blocked until explicitly released") — fail closed on fresh installs.
- **No external execution** — approval never places a bet; there is no execution connector in this deployment (stated in every UI surface and every audit event).
- **Calibration gate** — a calibration is only usable after administrator approval; until then ticket-grade decisions report `MODEL_NOT_CALIBRATED` (case 46).

## Findings and remediations

### 1. Console mutation forms had no CSRF protection (FIXED)

Platform-wide `csrf_protection` is **off** (`application/config/config.php`); the
JSON API self-guards by verifying the session token (issued at sign-in by
`Api_auth`) as the `X-CSRF-Token` header. The step-6 console mutation endpoints
only checked RBAC, so a forged cross-site form POST could approve/reject/settle
tickets for a signed-in operator.

**Fix** — `Sports::requireSportsPermission()` now verifies the posted
`csrf_token` field against the session token with `hash_equals()` (same token as
the API path), and `base()` passes `csrfToken` to the views. All six console
mutation forms (dashboard approve/reject/settle, tickets-console inline
approve/reject/settle) submit the hidden field.

### 2. Approval could proceed while the kill switch was ACTIVE (FIXED)

The paper engine blocks order placement while the kill switch is active
(`PaperTradingEngine::submitOrder`), but the sports mutation paths ignored the
switch — an operator could open new ticket exposure after tripping the kill
switch.

**Fix** — console `decide()` and API `decide_ticket()` now refuse (flash /
HTTP 409) while the switch is active, reading the live persisted state.
**Settlement is deliberately not gated** — it is the unwind/finalize path (it
records results on already-approved tickets), mirroring
`PaperTradingEngine::closePosition()`, which is also not kill-switch-gated.

Both fixes are pinned by case 51 (per-method source assertions so a refactor
that drops the guard fails the suite) plus a behavioral round trip of the kill
switch through the live platform state.

## Process items for cutover (not code — owner: operator)

1. **Data backfill before first real ticket** — enough historical odds +
   verified results to fit a calibration; the model stays
   `MODEL_NOT_CALIBRATED` until an administrator approves a calibration.
2. **Scheduler** — wire `php index.php tools sports-cron` (all jobs) on a
   schedule: fixtures/odds before kickoff windows, results + settlement after,
   `monitoring` + `cleanup` daily.
3. **Monitoring/alerts** — provider health (`api/sports/providers`), sync-run
   failures, calibration ECE/Brier drift (`api/sports/models/performance`),
   and settlement anomalies; alert on repeated `SPORTS_...` audit errors.
4. **Rollback** — unset the provider env credentials (module drops back to
   `DISABLED_NO_PROVIDER`) or re-engage the kill switch; no external state to
   unwind because no external execution exists.

## Go / no-go checklist

- [ ] Migrations applied (`tools install`); sports tables verified in target DB
- [ ] Provider credentials set in environment only; provider payload sample passed through normalizer
- [ ] RBAC users provisioned (`bootstrap_admin`); `sports.approve` / `sports.settle` granted only to named operators
- [ ] Kill switch deliberately released for the trading window (it boots ACTIVE)
- [ ] Mode set deliberately: `WINDELS_SPORTS_MODE` = `PAPER` (or `PRODUCTION`) — not left on `SANDBOX` in production
- [ ] Backfill + approved calibration in place (no `MODEL_NOT_CALIBRATED` on a live day)
- [ ] `sports-cron` scheduled; `monitoring` job observed healthy for ≥ 1 full match day
- [ ] Full test suite green (`tools tests`) on the deployed revision
