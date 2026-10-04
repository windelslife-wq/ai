# Implementation audit — 2026-10-04

## Changed files / isolation
Only `apps/football-predictions/` created. Existing PHP, unrelated apps, root environment, root deployment zip and prior tests unchanged. Contains independent server, provider/sync, database migration, model/optimizer, public/admin UI, security implementation, tests and operations guides. No prohibited framework in the new app, no PHP runtime dependency, no production fixture or price seed, no auto-ticket cron, no non-Over-1.5 market storage.

## Executed verification
- `node --check` on server, generation, jobs, admin/public JavaScript: no syntax errors.
- `npm install --workspaces=false express@5 helmet@8 express-rate-limit@8 mysql2@3`: succeeded; installer reported zero known vulnerabilities at that time.
- `npm test` inside app: 29 deterministic isolated unit and HTTP-contract tests passed; no database/server E2E tests performed. Existing PHP tests could not run here (PHP executable not available). No live API-Football credentials/MySQL server/cPanel host were supplied. Do not interpret unit-test success as production validation.

## Remaining acceptance risks / limitations
1. **Not production verified.** First-run MySQL migration, REST integration with real database, cPanel SSL/proxy/cron, and live API-Football payloads still require staging verification. SQL DDL auto-commits; snapshot/restore before migration.
2. Baseline model is not trained AI and lacks empirical probability calibration, injury/standings/H2H/league-context data. Confidence is explicitly an evidence score; combined probability independence is not validated. Not appropriate to advertise as a calibrated prediction system.
3. Separate schema has ADMIN/VIEWER roles but not granular permissions tables. Stronger administrator MFA and password reset/provisioning workflow are not implemented.
4. Daily generation uses one immutable UTC-date attempt, including failures. Retries need an audited operator reconciliation; no unsafe reset endpoint exists.
5. Optimizer caps candidate pool and search; truncated results disclose incompleteness. Correlation restrictions are heuristics, not statistical estimates.
6. Analytics cover counts, win rates, odds range/average, current streaks, monthly/competition/model and raw probability reliability bins. Formal out-of-sample calibration and full predictive accuracy by confidence decile are not established.
7. Team data comes from last ten completed fixtures; no reliable provider injury, league-environment, standings, or H2H integration. Sparse or absent data returns DATA_UNAVAILABLE.
8. Login and admin UI need live browser testing across cPanel SSL/proxy modes; UI currently lacks filter controls beyond navigation and history pagination. Publisher checks current kickoff/freshness but does not re-price a previously generated ticket; original verified snapshot is preserved.
9. No production data is bundled. On a new install pages truthfully display no qualifying ticket until cron sync and manual generation/publication.

Acceptance remains conditional. Follow docs/TESTING.md and docs/DEPLOYMENT_CPANEL.md before enabling production traffic.
