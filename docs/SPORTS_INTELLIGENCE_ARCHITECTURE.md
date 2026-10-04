# WINDELS Sports Intelligence — Integration Plan

## Host adaptation

The target checkout is the AEGIS CodeIgniter 3 application. It has reusable MVC routing, environment configuration, repository-style persistence, audit logging, a domain-service container, and a custom test runner. It does **not** have authentication, RBAC, admin users, notifications, or scheduled-job infrastructure. Those capabilities must be established before any privileged Sports mutation, provider configuration, approval, or settlement endpoint is exposed.

## First implementation boundary

`Aegis\Sports` is a domain module, not a separate application. Its provider interface is deliberately provider-neutral and all inputs are normalized before use. At boot there are no providers and the module reports `DISABLED_NO_PROVIDER`; it never creates demo fixtures, odds, predictions, results, or tickets.

## Delivery order

1. Foundation, provider contract, normalization and data quality — implemented.
2. Auth/RBAC/CSRF and sports persistence migrations — implemented (provider, health, canonical fixture, odds, quality assessment, and idempotent sync-run tables).
3. Fixture and odds synchronization, odds freshness, and conservative match-intelligence gates — implemented; result synchronization follows as a separate provider-enabled increment.
4. Match intelligence, versioned features, prediction/calibration/value/risk/correlation, no-predict gates, and decision/ticket persistence schema — implemented.
5. Persisted decision writes, ticket approval, result verification, settlement and analytics — next.
6. Backtesting, model monitoring, dashboards, responsive UI, and production review.

## Security constraints

Provider credentials remain environment-only. Provider payloads are untrusted and must pass normalizers. No mutation endpoints are introduced before authentication, authorization, CSRF, rate limits, and audit attribution exist. Automated external execution remains disabled.
