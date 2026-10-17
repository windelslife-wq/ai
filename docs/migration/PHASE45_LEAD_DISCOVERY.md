# Phase 45 — Lead Discovery (`leadDiscovery`, Row 17)

**Date:** 2026-10-17  
**Branch:** `arena/0d5104b6-ai`  
**Module key:** `leadDiscovery` (`not-ported` → `ported`)

## 1. Summary

Phase 45 ports the legacy CodeIgniter 3 Lead Discovery module (`application/controllers/{Api_lead_discovery,Leads}.php`, `application/libraries/LeadDiscovery/{LeadDiscoveryProvider,ProviderException,GooglePlacesProvider,ProviderRegistry,Deduplicator}.php`, `application/views/leads/index.php`, `application/database/schema.mysql.sql`, and `tests/cases/23-lead-discovery-schema.php` .. `28-lead-coverage.php`) into the Node.js modular monolith (`apps/workforce-platform/`), promoting `leadDiscovery` from `not-ported` to `ported` (`13 ported / 3 partial / 1 not-ported` of 17 modules).

## 2. Database Schema & Dual-Adapter Persistence (`020_lead_discovery.sql`)

- Added migration `020_lead_discovery.sql` creating the 11 organization-scoped tables (`54 → 65` tables total):
  1. `wf_lead_organizations` (`leadOrganizations`)
  2. `wf_lead_organization_members` (`leadOrganizationMembers`, composite key `${organization_id}:${user_id}`)
  3. `wf_leads` (`leads`, unique `(organization_id, source, source_id)`)
  4. `wf_lead_notes` (`leadNotes`)
  5. `wf_lead_activities` (`leadActivities`)
  6. `wf_lead_collections` (`leadCollections`, unique `(organization_id, name)`)
  7. `wf_lead_collection_leads` (`leadCollectionLeads`, composite key `${collection_id}:${lead_id}`)
  8. `wf_lead_search_history` (`leadSearchHistory`)
  9. `wf_lead_duplicate_candidates` (`leadDuplicateCandidates`)
  10. `wf_lead_duplicate_resolutions` (`leadDuplicateResolutions`)
  11. `wf_lead_export_history` (`leadExportHistory`)
- Extended `REPOSITORY_METHODS` in `src/persistence/contract.js` (`188 → 210` methods) and implemented all 22 methods identically in `src/persistence/file-store.js` and `src/db/lead-repository.js` (wired into `src/db/store.js` alongside `"020_lead_discovery"` in `REQUIRED_MIGRATIONS`).

## 3. Provider Boundary, Deduplication & API Surface (`src/modules/leads/`)

- **Provider Boundary (`src/modules/leads/providers.js`):**
  - `createGooglePlacesProvider` reads `GOOGLE_PLACES_API_KEY` from `src/config.js` (documented in `.env.example`).
  - Reports `DISABLED` by default when `GOOGLE_PLACES_API_KEY` is blank and fails closed with HTTP `503` without fabricating synthetic business leads; still records the failed search attempt in `wf_lead_search_history`.
  - Unknown/planned providers fail with `ProviderException(..., 422)` and report `providerStatus: "PLANNED"` on HTTP `503`.
- **Conservative Secondary Deduplication (`src/modules/leads/deduplicator.js`):**
  - Primary deduplication updates existing `(organization_id, source, source_id)` rows and logs `DUPLICATE_DETECTED`.
  - Secondary deduplication (`matchDuplicateLead` / `detectLeadDuplicates`) creates `open` review candidates ordered lexicographically (`lead_a_id < lead_b_id`) for `website_domain` (`0.95`), `normalized_phone` (`0.92`, `>= 7` digits), and `name_address` (`0.84`), never auto-merging leads without operator action (`keep_a`, `keep_b`, `merge`, `ignore`).
- **23 HTTP Routes (`src/modules/leads/routes.js`, all guarded by `system.authenticated` and verified `X-Lead-Organization` membership):**
  - `GET /api/v1/lead-discovery/status`
  - `GET /api/v1/lead-discovery/workspaces`
  - `GET /api/v1/lead-discovery/providers`
  - `POST /api/v1/lead-discovery/search`
  - `GET /api/v1/lead-discovery/leads` & `GET /api/v1/lead-discovery/leads/:id`
  - `GET`/`POST /api/v1/lead-discovery/collections` & `PATCH`/`DELETE /api/v1/lead-discovery/collections/:id`
  - `GET`/`POST`/`DELETE /api/v1/lead-discovery/collections/:id/leads` & `DELETE /api/v1/lead-discovery/collections/:id/leads/:leadId`
  - `PATCH /api/v1/lead-discovery/leads/:id/status` & `PATCH /api/v1/lead-discovery/leads/:id/owner`
  - `GET`/`POST /api/v1/lead-discovery/leads/:id/notes` & `GET /api/v1/lead-discovery/leads/:id/activity`
  - `GET /api/v1/lead-discovery/duplicates` & `POST /api/v1/lead-discovery/duplicates/resolve`
  - `GET /api/v1/lead-discovery/coverage`, `GET /api/v1/lead-discovery/history`, `GET /api/v1/lead-discovery/summary`, `GET /api/v1/lead-discovery/pipeline`
  - `POST /api/v1/lead-discovery/export`, `POST /api/v1/lead-discovery/export/preview`, `POST /api/v1/lead-discovery/export/csv` (with `safeCsvValue` prefixing `=`, `+`, `-`, `@` with `'`).

## 4. Workspace Console & Verification Gates

- Added `client/src/leads.js`, `LeadDiscoveryView` in `client/src/views.jsx`, `/app/leads` and `/app/leads/pipeline` in `client/src/App.jsx`, and legacy redirects `/leads` → `/app/leads` and `/lead-pipeline` → `/app/leads/pipeline` in `src/modules/site/pages.js`.
- Added `test/leads.test.js` and `test/client_leads_console.test.js`.
- Verified:
  - `npm run verify:install` — **30 / 30** checks passed (`186` source files, `20` required migrations, `92` documented env vars)
  - `npm run check:workforce` — **1,222 / 1,222** workforce tests passed
  - `npm run typecheck` — clean
  - `npm run test:contracts` — **12 / 12** contract tests passed
