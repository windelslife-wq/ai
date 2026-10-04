# Phase 0 source audit — 2026-10-04

Boundary: apps/football-predictions. Existing files remain unchanged. Session branch arena/01a10922-ai; merge to main requires separate review.

## Inventory and dependencies
The root README and directory inventory establish a CI3/PHP platform with independent lead-discovery workspaces (apps/api Fastify/TypeScript, apps/web Next.js, packages/shared). Neither runtime satisfies this application's restrictions. Application controllers Sports and Api_sports use Platform->sports and Aegis_model; views sports/index.php and tickets.php depend on CI escaping and sessions. Aegis_model delegates sports persistence to repository implementations. Existing schema families sports, sports_decisions, sports_identity, sports_intelligence and sports_results define matches, providers, health, odds, quality, predictions, tickets, selections, calibration, configuration, jobs, results and shared identity tables. Existing SQL frequently uses VARCHAR timestamps and lacks declared foreign keys in these sports schema files.

Read source: PredictionEngine, FeatureEngineeringEngine, ConfidenceEngine, CalibrationEngine, DataQualityEngine, RiskEngine, OddsFreshnessEngine, CorrelationEngine, TicketOptimizer, DailyTicketService, TicketGovernance, TicketSettlementService, ConfigurationService, HttpSportsProvider and SportsCronService; Sports/Api_sports/Auth controllers; Aegis_model sports wiring; routes/session configuration; sports view; tests 41 and 49; deployment and environment conventions.

## Reuse assessment
Reuse conceptual veto gates, append-only decision reporting, provenance and explicit authorization, not PHP runtime code. Separate fp_* identity and tables are justified by independent deployment and differing business rules. Do not alter shared users, configuration, cron, frontend assets or root environment. Root npm workspaces already cover apps/*; isolated installation must use --workspaces=false.

## Compatibility/security risks
Existing defaults target 5–8, permit configurable markets and expose a cron ticket operation; incompatible with manual-only 2–4 rules. Generic HTTP provider is not API-Football. Odds freshness clamps future timestamps rather than rejecting them. Settlement rewrites ticket total odds; new implementation must separate original and effective odds. CalibrationEngine truncates squared residuals to int in Brier calculation; PredictionEngine affine calibration differs from CalibrationEngine's logistic transform. These findings are not modifications to existing modules.
Existing RBAC distinguishes sports.view/manage/approve/settle and native session/CSRF. Existing cookie security is environment-controlled. Independent app must require production secrets, secure cookies, same-origin mutations, CSRF and permission checks. Never publish upstream errors or keys.

## Tests and deployment
Existing tests/cases cover sports foundation, sync, prediction, risk, optimizer, confidence, providers, daily E2E, settlement, monitoring, RBAC and dashboard. CI runner is php index.php tools tests, with runtime WASM alternative. Existing cPanel instructions deploy PHP and do not establish Node support. New deployment needs host-confirmed Node Application Manager, independent subdomain, database, SSL and cron executable. No credentials/live provider or cPanel access has been verified.

## Ordered implementation plan
1. Isolated architecture, UTC fp_* relational schema and API contracts.
2. MySQL migrations/repositories, Express/session/RBAC/CSRF foundation.
3. API-Football adapter with durable provenance/cache/health and locked sync jobs.
4. Strict Over 1.5 validation, deterministic explainable baseline, separate quality/risk and empirical calibration.
5. Bounded exact-decimal optimization, transactional manual generation/reporting and publication.
6. Vanilla public/admin pages consuming real API responses and persisted progress.
7. Idempotent result settlement and database-derived analytics.
8. Unit, real MySQL integration, HTTP/E2E and existing regression tests.
9. cPanel operational guide and verified configuration where available.
10. File-by-file acceptance review; explicitly disclose unimplemented or unverified requirements.
