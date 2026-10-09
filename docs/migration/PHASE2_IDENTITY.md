# Phase 2 — Identity, accounts and the platform core (2026-10-09)

**Branch:** `arena/c204b9d0-ai` · **Sandbox Node:** v22.22.3 · **Suite:** 85 app tests, 367 legacy runtime tests, 21 install checks — all passing.

This phase ported **one** module completely — identity + accounts — and rebuilt the
core underneath it so later phases have something to stand on. Nothing here is a
production cutover: PHP remains authoritative and deployable.

## 1. What now exists

### Core HTTP layer (`src/http/`)

| File | Replaces | Notes |
|---|---|---|
| `router.js` | the router embedded in `app.js` | 7 verbs (`GET HEAD POST PUT PATCH DELETE OPTIONS`), path params, duplicate registration refused, `find()` → `{route, params, allowed, methodMismatch}`, 405 + `Allow`, HEAD→GET only in the transport, `list()` producing the route ledger |
| `validate.js` | `validateSchema` | JSON-Schema subset for body/query/params: numbers, booleans, arrays, enums, `pattern`, `format`, nullable, coercion, `additionalProperties:false`, per-field issues |
| `bodies.js` | the inline JSON-only reader | declared-length 413 **before** reading, `application/json` + `+json` suffix, form bodies, multipart (≤24 parts) with raw bytes kept for signature checks |
| `errors.js` | ad-hoc `reply.code(500)` | `AppError(status, code, message, {details, retryAfter, cause})`; a dependency failure maps to 503 + `Retry-After`, never 500; unexpected errors never echo a cause |
| `static.js` | the static block in `app.js` | document / hashed-asset / SPA-route distinction, traversal refusal, weak ETag, per-kind cache headers |

`src/app.js` is composition only: reply object (incl. 204 with no body and no
`content-length`), registrar, middleware order, request log line, fatal handlers,
server lifecycle. `src/security/headers.js` owns CSP/HSTS/CORS, `ratelimit.js` the
bounded limiter and lockout, `uploads.js` the image policy, `session.js` the
cookie/bearer styles.

### Persistence (`src/persistence/`)

`contract.js` defines the 30 methods every adapter must implement plus the
`capabilities` object (`durable`, `transactions`, `crossProcessSafety`,
`recommendedForProduction`). `index.js` resolves `STORAGE_ADAPTER`
(`auto` → `mysql` only when `DB_HOST`/`DB_NAME`/`DB_USER` are present), builds the
store and calls `assertRepositoryContract` **before** the server listens, so a
half-implemented store cannot serve traffic.

`file-store.js` is the `STORAGE_ADAPTER=file` implementation: append-only
`windels-store.jsonl`, snapshot compaction, `checksum()`, `stats()`, `snapshot()`,
`close()`. It exists because a migration that cannot be exercised without a database
cannot be reviewed. **It is not production storage** and refuses to start under
`NODE_ENV=production` unless `ALLOW_FILE_STORE_IN_PRODUCTION=1` is set deliberately.

### Modules (`src/modules/`)

`identity/` — `contracts.js` (legacy-accurate field rules), `service.js` (login,
registration, password change, sessions, avatars, RBAC baseline, audit vocabulary),
`routes.js` (the 23 auth/account/admin routes; the other 5 are health and status). `platform/` — `guards.js`
(session and bearer authentication, permission checks, CSRF, origin policy),
`health.js` (live/ready/status/routes/features and the version stamp).
`src/db/account-repository.js` holds the MySQL side of the account queries
(parameterized, with sort/filter columns resolved against a column allow-list);
`src/db/platform-baseline.js` holds the seed matrix both adapters share.
`src/routes/auth.js` and `src/routes/health.js` are re-export shims so the pre-Phase-2
import paths keep working — they are not a second implementation.

### Operations (`tools/`)

| Command | Purpose |
|---|---|
| `npm run verify:install` | 21 static release checks (engines, dependency set, required files, migrations present and referenced, `.env.example` coverage, production config rules, built bundle). No data access. |
| `npm run verify:data` | Live-store readiness: RBAC baseline, duplicate/collision keys, dangling role/permission rows, orphan sessions, non-bcrypt digests, users without a handle, expired-but-unrevoked sessions. `--strict` fails on warnings. |
| `npm run seed:platform` | Idempotent RBAC baseline via the repository contract, plus `--admin-username/--admin-password` for the first administrator. |
| `npm run backup` / `npm run restore` | sha256-manifested backups; `mysqldump --single-transaction` for MySQL with the password in a `0600` defaults file. Restore verifies every hash first and refuses a non-empty target without `--force`. |
| `npm run migrate:status` / `migrate:dry-run` | Reads the migration ledger: pending / applied / **drifted** (a file whose bytes changed after apply). Status and dry-run never write. |

## 2. Route parity — the ported surface

`GET /api/v1/system/routes` is the machine-readable version of this table.

| Route | Auth | Permission | Validated |
|---|---|---|---|
| `GET /health/live` | no | — | no |
| `GET /health/ready` | no | — | no |
| `GET /system/status` | no | — | no |
| `GET /system/routes` | no | — | no |
| `GET /system/features` | no | — | no |
| `POST /auth/login` | no | — | yes |
| `POST /auth/register` | no | — | yes |
| `POST /auth/password-reset-request` | no | — | yes |
| `GET /auth/csrf` | yes | — | no |
| `GET /auth/me` | yes | — | no |
| `POST /auth/logout` | yes | — | no |
| `POST /auth/device-session` | yes | — | yes |
| `GET /account` | yes | — | no |
| `PATCH /account/username` | yes | — | yes |
| `PATCH /account/email` | yes | — | yes |
| `PUT /account/profile` | yes | — | yes |
| `PUT /account/password` | yes | — | yes |
| `GET /account/sessions` | yes | — | no |
| `DELETE /account/sessions` | yes | — | no |
| `GET /account/activity` | yes | — | yes |
| `POST /account/avatar` | yes | — | no |
| `DELETE /account/avatar` | yes | — | no |
| `GET /files/avatars/:fileId` | yes | — | yes |
| `GET /admin/users` | yes | `identity.users.view` | yes |
| `POST /admin/users` | yes | `identity.users.manage` | yes |
| `PATCH /admin/users/:userId/status` | yes | `identity.users.manage` | yes |
| `GET /admin/roles` | yes | `identity.users.view` | no |
| `GET /admin/identity/users` | yes | `identity.users.view` | no |

All paths are under `/api/v1`. `GET /admin/identity/users` is the pre-Phase-2 shape,
kept for the SPA that already calls it; its response carries a `deprecated` field
pointing at `GET /admin/users`. `POST /auth/password-reset-request` exists so the
legacy client receives a **400 with an actionable code** rather than a 404; it sends
no mail and creates no token (see §4, "deferred").

## 3. Deliberate contract changes

These are recorded because they change what existing clients and tests may assume.

1. **`readiness()` on the file adapter no longer reports `schema:false`.** A
   schema-less store reports the log format as its schema; whether the RBAC baseline
   has been seeded is reported in `detail: "roles-not-seeded"`. `/health/ready`
   therefore stays 200 on a fresh file install (the process *is* healthy) while
   `verify:data` fails it. The old assertion in `test/auth.test.js` was changed to
   match, and F-20's 503 path is now driven by a store that genuinely reports
   unreadiness.
2. **Every mutating route declares a body schema** (`F-03`), and every admin route
   reports its permission in the inventory. An inline guard carries `.permission`
   for exactly that reason.
3. **Login lockout is keyed per account, never per IP.** A `login:ip:*` counter was
   tried first and rejected: behind one shared address it freezes every account (see
   `docs/migration/RISK_REGISTER.md`). The failure counter is keyed by
   `sha256(normalized identifier)` and stored hashed.
4. **Session rotation is real.** A password change and a device-session issue mint a
   new session id and revoke the acting one; the pre-Phase-2 code re-hashed the same
   token, which was indistinguishable from doing nothing.
5. **`SESSION_SECRET` is required for every adapter**, including `file`: it keys the
   CSRF derivation and the login-attempt hash, not only the cookie. Tools and scripts
   must supply it.
6. **`platformVersion()` reads `package.json`** instead of a hardcoded fallback, and
   the app version moved to `0.3.0` to match what the status endpoint had been
   claiming. `WF_BUILD_VERSION` still overrides.
7. **`.env.example` is the documentation of the config surface.** A `verify:install`
   check requires that every `env.*` the config reads appears in it, so a new knob
   cannot ship undocumented.
8. **No new runtime dependencies.** `mysql2` and `bcryptjs` only, no
   `devDependencies`, built-in `node:crypto` everywhere else, no Docker/Redis.

## 4. Defects found and closed while porting

Each row is a test name in `test/`; the `F-` column is the Phase 0 audit finding it
answers.

| F- | Defect closed | Test |
|---|---|---|
| F-01 | Server could not boot without MySQL; login against a healthy-but-unseeded store returned 500 | `F-01 the server boots, serves and signs in with no database configured at all`; `F-01 the durable file adapter replays its log…`; `F-01 the file store and the SQL store implement one repository contract` |
| F-02 | DB outages surfaced as 500 `INTERNAL_ERROR`, readiness crashed instead of returning 503 | `F-02 readiness reports the adapter, and a dependency outage is 503 with Retry-After…`; `F-02 the status surface is honest about unported modules…` |
| F-03 | Router supported GET/POST only; no params, no query parsing, no 405/`Allow`; admin listing had no pagination | `F-03 the router is method-exact…`; `F-03 every verb is declared explicitly…`; `F-03 administration is paginated, role-bounded, self-protecting and audited` |
| F-04 | Validation covered strings and `required` only; every rejection was an opaque 400 | `F-04 the validator enforces…`; `F-04 a rejected request answers 400 with field-level detail…` |
| F-05 | No CORS surface; cross-origin credentialed requests impossible to grant safely | `F-05 CORS is opt-in…`; `F-05 a cross-origin request gets CORS headers on success and failure…`; `F-05 a cross-site mutation is refused…` |
| F-06 | No uploads at all; a future `public/uploads/` would have been world-readable | `F-06 body limits…`; `F-06 an avatar is identified by its bytes…`; `F-06 the avatar route stores, serves and removes…` |
| F-07 | Node seeded 2 roles / 3 permissions against the legacy 8 / 10; `system.super_admin` absent | `F-07 the SQL migrations and the code baseline seed the identical role and permission vocabulary`; `F-07 seeding is idempotent…`; `F-07 migration 003 seeds the legacy RBAC vocabulary…` |
| F-08 | Process-local limiter, lazy eviction only above 10 000 keys, no per-account lockout | `F-08 the login guard locks…`; `F-08 five failed sign-ins lock…`; `F-08 the limiter is per key…`; `F-08 the per-route limit is independent…`; `F-08 limits can be switched off…` |
| F-13 | No request log line, no `uncaughtException`/`unhandledRejection` handlers, no backup/restore or data-integrity tooling | `F-13 a file-store backup verifies…`; `F-13 a restore refuses to overwrite a non-empty store…`; `F-13 a damaged backup is refused…`; `F-13 MySQL dumps use the host tool…` |
| F-14 | `.env.example` claimed "development" while setting `NODE_ENV=production`, and documented 5 of 38 variables | `F-14 the example environment documents every variable…` |

Bugs found by writing those tests, fixed in product code (not in the assertions):

- every admin route was missing `authenticate`, so all admin traffic 401'd;
- the file store lacked `usernameTaken` / `emailTaken` / `rolesForUser`;
- `pageUsers` returned `password_hash` to the browser;
- `device_label` was accepted then dropped;
- `/system/routes` 503'd; readiness threw on an unseeded store;
- the GIF signature check compared 3 bytes and could never pass;
- the avatar route resolved any path under the uploads root (traversal);
- `u0_` avatar ids were accepted;
- lockout keyed by IP froze every account behind one address;
- `joinPath("/api/v1", "/")` produced a double slash.

## 5. Findings still open after this phase

| F- | State | What closing it needs |
|---|---|---|
| F-09 (PWA) / F-10 (SEO) | not started in this phase | Phase 3 (public site, manifest icon set, SW update UX, sitemap/canonical/10 pages). |
| F-11 (supply chain) | unchanged | Scout-stack advisories (`next`, `fastify`, `postcss`, `tailwindcss`); the workforce package itself reports none. Needs a deliberate upgrade pass. |
| F-12 (reproducibility) | open | A decision: one root lockfile vs per-package pinning. The workforce package still has no lockfile of its own. |
| F-13 | partially closed | Request log, error handlers, backup/restore, data-integrity and migration-status tooling are in. Pool-saturation metrics and `maxRequestsPerClient` remain. |
| F-15 (real MySQL) | **cannot close here** | No MySQL server exists in this sandbox. Needs a staging host (or an approved container) for migrations, sessions, the import ledger, uniqueness conflicts, transaction behaviour and a restore rehearsal. |
| F-16 (deployment zip) | still open, now warned at the point of use | Re-verified this phase: `application-deployment.zip` (573 files, 2026-08-24) differs from the tree — `application/config/routes.php` differs, `application/controllers/Api_portfolio.php` is **absent** from the archive. README and `docs/CPANEL_DEPLOYMENT.md` now say so. Replacing the artefact is a production action and needs approval. |
| F-17 (documentation) | closed by this phase's docs pass | The contradictory status table in the root README ("57 automated tests") is removed; `docs/migration/BASELINE_TESTS.md` still needs a re-count. |
| F-18 (two lead-discovery stacks) | untouched | Deliberate: consolidation is gated on the id-mapping and column-diff decision. |
| — | deferred on purpose | Password **reset** delivery (mail transport + single-use token store) and lazy bcrypt→scrypt rehash. `verifyPassword` normalises `$2y$`; changing hash algorithm for live accounts must be an approved, reversible decision with its own tests. |

## 6. Rehearsal record (this sandbox, file adapter)

```
node tools/verify-data.mjs                 # before seeding → exit 1, "the store holds no roles"
node tools/seed-platform.mjs               # Seeded 9 role(s), 14 permission(s), 29 grant(s); warns that no account holds system.super_admin
node tools/verify-data.mjs                 # after seeding  → 12 checks passed, 1 warning, 0 failures, exit 0
node tools/backup.mjs create --destination …/backups        # 2 file(s), file adapter
node tools/backup.mjs verify --backup …                      # verifies, exit 0
node tools/backup.mjs restore --backup …                      # exit 1: "…already holds 1 file(s). Pass --force…"
node tools/backup.mjs restore --backup … --force              # checksum matches the manifest, exit 0
node tools/verify-install.mjs                                 # 21/21
node --test test/*.test.js                                      # 85/85
node runtime/run-tests.mjs                                      # 367/367 (repo root)
```

The MySQL adapter's dump/restore path is unit-tested for argument shape (no password
in `argv`, `--single-transaction`, `--no-tablespaces`, `--routines`, `--triggers`) but
has **not** been executed against a server — see F-15.

## 7. Entry criteria for Phase 3

1. A staging MySQL host (or approved container) so F-15 can close; until then no
   import or cutover is attempted.
2. Public-site inventory taken from `docs/migration/ROUTE_MAP.md` §2 as the working
   list; each page ported with its legacy template's data contract recorded.
3. PWA work (icon set, hashed shell assets, update UX) lands with the public site,
   not after it.
4. `docs/migration/BASELINE_TESTS.md` re-counted, and the lockfile decision (F-12)
   taken before any new package is added.
