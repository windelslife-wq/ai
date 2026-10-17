# Phase 35 — the administrator control centre (row 3)

**Status:** complete · 2026-10-16 · branch `arena/046b29ac-ai`

`/app/admin` is now the port of `views/admin/index.php` (`Admin::index`): legacy's four statistics with
their captions, the access-policy list, the user directory's entry point, the SMTP panel stated as
unported, and the feature-readiness table. It closes the second and last half of row 3's settings gap —
there is no legacy settings controller, so row 3's remaining absence is the sports dashboard alone.

## Scope

| | |
|---|---|
| Legacy | `views/admin/index.php` (`Admin::index`, `Admin::toggle_user`'s words), `application/core/MY_Controller.php::isAdmin` (`can($user, 'system.super_admin')`) |
| Node routes (all already present, unchanged) | `GET /admin/users`, `GET /admin/roles` (`identity.users.view`) · `GET /strategies` (session) · `GET /lottery/status` (`system.authenticated`) · `GET /system/status` and `GET /system/features` (public) |
| New files | `client/src/admin.js`, `test/client_admin_console.test.js`, this record |
| Edited (client) | `client/src/views.jsx` (the new view, the nav entry, and the `AdminUsersView` parity fixes below), `client/src/App.jsx`, `client/src/styles.css` |
| Unchanged | no route, migration, contract method or permission: the server registers **146 routes** before and after; **no server file was touched in this phase** |

## The screen

- **Four statistics, legacy's captions, honest sources.** `Users` reads `GET /admin/users`'s
  `meta.total` (not the length of a page); `Strategies` reads the strategy list and reports the number
  legacy counted — the *version rows*, because `Api_strategies::index()`'s groups are `strategy_id →
  versions` and `count($this->Aegis_model->strategies->all())` counted rows — naming both numbers;
  `Lottery draws` reads `drawsTracked` from `GET /lottery/status`; and `Languages` is the card this
  edition cannot answer, so it shows an em dash and *"No Node module can answer this: language learning
  is not ported (row 16)"* rather than a zero — the same rule the workspace dashboard's language card
  follows.
- **The access policy carries machine-readable keys.** Legacy's five hand-written lines are transcribed
  (plus the `platform_member` baseline the panel never named), and every row now names the role keys it
  describes and how many permissions each holds. `test/client_admin_console.test.js` asserts those
  claims against `src/db/platform-baseline.js` — the Node mirror of `tools/rbac.php` — so a grant that
  drifts from this panel fails the suite instead of shipping a screen that describes a policy the server
  does not enforce. The super administrator's row states "all N permissions", which is both the seeded
  vocabulary and true at runtime through the service's short-circuit.
- **Readiness is the ledger itself.** `GET /system/status` → `modules` (17 rows, 10 ported / 5 partial /
  2 not-ported) with the checks behind each row, and the legend is the server's own text from
  `GET /system/features` — not a client paraphrase. The two rows with no checks listed are exactly the
  two modules that are not ported, and the table says "not stated" for them.
  **Legacy's own table was `Api_system::FEATURES`** — TESTED / IMPLEMENTED / PLANNED about the PHP build.
  Reusing those words in Node would have been a claim this edition cannot support; `INVENTORY.md` records
  the port decision and this screen keeps it.
- **The SMTP panel cannot be ported and says so.** Legacy's panel summarised `Aegis\Mailer::configSummary()`
  and its button performed a real send (`POST /admin/test-email`). There is no mail transport here and no
  route that could be one, so the panel is labelled `not-ported` and names the two ledger rows that wait on
  it: password reset (`delivered: false`, row 2) and the notification-delivery decision (row 5).
- **The gate is legacy's.** `/app/admin` requires `system.super_admin` — `Admin::index` called
  `requireAdmin()` → `isAdmin()` → `can($user, 'system.super_admin')` — and the two administration reads
  are `identity.users.view`, exactly as the directory's route enforces. A viewer without the former sees
  the locked navigation entry and the shell's denial; the panel withholds the reads it could not make
  (and says which permission stood there) while still rendering everything it *can* source.

## Defects found and fixed on the way

`AdminUsersView` was audited against the same routes while the panel was written, and three of its
controls could never have worked. They are fixed here because the panel describes the same policy:

1. **The create form's role list was invented.** The `<select>` offered `member`, `analyst`, `operator`,
   `supervisor`, `compliance_officer`, `admin`, `super_admin`; `POST /admin/users` validates `role`
   against `contracts.ADMIN_ROLES` — the eight seeded roles — so **six of the seven options were refused
   with `INVALID_REQUEST`**, and the one that worked was `super_admin`. The options are now
   `GET /admin/roles`'s `assignable` list in the server's own order, labelled with the store's display
   name and legacy's label, and the form cannot submit without one.
2. **The status button aimed at a state the API does not have.** "Suspend" sent `status: "suspended"`;
   `USER_STATUS_UPDATE` accepts exactly `active` and `disabled`. The buttons now say what legacy's own
   page said — **Deactivate / Activate** — and send those two values. The directory's status *filter*
   offered `suspended` and `pending` for the same reason and is now `any / active / disabled`
   (`LIST_USERS_QUERY.status`).
3. **The administrator's own row was offered a control that always fails.** `PATCH /admin/users/:id/status`
   refuses self-deactivation with `SELF_DEACTIVATION`; legacy's own table printed "Current account" there.
   The table now does the same, so the refusal is never reachable by a button.

A fourth, smaller fix: the audit-browser and directory pagination and the shell's nav are unchanged, but
the control centre adds an entry to the navigation — `Control centre`, gated on `system.super_admin` —
beside the existing `Users` and `Audit trail` entries, which keep their own `identity.users.view` gates.

## Tests

`test/client_admin_console.test.js` — **10 tests**, hermetic (file adapter, `createFileStoreApp`, no
network), and two of them seed the real platform baseline (`seedPlatformBaseline`) so the policy panel
and the role list are asserted against the deployment's actual shape rather than the two-role test
fixture:

- the page's eyebrow, heading, lede and the five legacy policy lines, transcribed;
- the policy panel against `ROLE_GRANTS`/`PLATFORM_PERMISSIONS` (every row's key set matches the seeded
  grants; the super-admin row is the whole vocabulary; every permission key exists);
- the four cards: legacy's labels and captions, an em dash and row 16 for languages, **no fabricated
  zero anywhere**, `meta.total` rather than the page length, and legacy's version-row count for
  strategies (with the group count named beside it);
- the super-admin shortcut mirrored (`holdsPermission`) so the panel withholds exactly what the API
  refuses — a session with nothing granted is told which permission stood there;
- the readiness table versus `MODULE_STATUS` (tones, the two rows without checks, "not stated");
- the SMTP panel's two named ledger rows;
- every read is a registered route with the permission the server enforces, and the screen is declared
  and rendered where the router will find it;
- live behaviour: the administrator's session reads all six surfaces; a member holding only the
  signed-in baseline gets **403 `PERMISSION_DENIED`** on the two administration reads while the
  session-only strategy list still answers;
- the store holds exactly the eight assignable roles plus the legacy-schema `user`, and the form names
  the extra one as unassignable;
- the create route accepts **all eight** offered roles and refuses the six the old list offered; the
  status route accepts `active`/`disabled` and refuses `suspended`/`pending`; and self-deactivation is
  `SELF_DEACTIVATION`.

## Gates

- `npm run check:workforce` → **1045 / 1045** (1035 before), 5 suites.
- The six client suites together → **69 / 69**; `test/client_admin_console.test.js` **10 / 10**.
- `npm run typecheck` → clean (root `tsc --noEmit`).
- `npm run build:client` → `index-B-yTeuEP.js` 433.76 kB / 119.52 kB gzip, `index-CmBSwtE7.css`
  39.72 kB / 8.64 kB gzip.
- `npm run verify:install -- --require-bundle` → **30 / 30**.
- Live probe (`/tmp/admin_probe.mjs`, file-store demo, admin `root`): **36 / 36** — the four card
  sources, the ledger's 17 rows and its 10/5/2 counts with the two unported rows as the only ones
  without checks, the server's own legend, the six role options exactly as the API lists them, a role
  outside that list refused (`INVALID_REQUEST`), `suspended` refused, self-deactivation refused, a
  member created through the API with `platform_member` and then refused `PERMISSION_DENIED` on the two
  administration reads while the strategy list still answers, `/app/admin` 200, and the served bundle
  carrying the panel's strings with the three stale vocabularies gone.
- **Probe note:** the demo store was re-seeded for this phase (`seed-platform.mjs`, 9 roles / 14
  permissions / 29 grants, admin `root` id 1) because the sandbox restart had left it without accounts,
  and the demo host was started with `RATE_LIMIT_LOGIN_MAX=50` so repeated probe runs do not trip the
  login limiter. Neither is a product change; the limiter's own behaviour is covered by its suite.
- **Not run:** a real browser (no DOM/WebDriver here), real MySQL/MariaDB, any live market-data
  provider, SMTP, cPanel/Passenger, and still no PHP↔Node numeric diff (F-26).

## Row 3 after this phase

Closed: the workspace dashboard (Phase 33), the account screen's avatar control (Phase 34) and the
admin control centre (this phase). **Still absent: the sports dashboard** — the last screen row 3 names.
F-29's residual console list shrinks by one: paper, risk, execution, brokers, journal, sports (the admin
control centre is no longer on it). **The module counts are unchanged — 10 ported / 5 partial /
2 not-ported:** this phase ported a screen over routes that already existed.
