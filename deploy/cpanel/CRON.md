# cPanel cron jobs

**No cron entry is required for the current Node foundation.** It exposes health checks, identity/session routes, and RBAC only; it has no scheduled business jobs.

Do not copy cron commands from the existing PHP app or the separate Football Predictions app into the new platform. Each future migrated job must first have an idempotent short-lived Node CLI entry point, database-backed lock, bounded batch size, retry/checkpoint behavior, and an explicit schedule. Add its exact cPanel cron line here only after those properties and hosting execution limits are tested.

Never launch a persistent worker/daemon from cPanel cron, and do not schedule lottery/ticket generation or any trading action. Cron must not enable live providers, trading, or publication implicitly.
