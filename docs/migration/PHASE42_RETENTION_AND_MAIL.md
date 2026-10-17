# Phase 42 — row 5: one retention policy, and the outbound mail transport

**Status:** complete · 2026-10-17 · branch `arena/046b29ac-ai`

Row 5 of [`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md) ended with two open decisions, and the
module ledger said so on every status read:

> Decide **one** retention policy covering audit, notifications, `wf_analysis_runs` (R-27) and
> `wf_backtests` (R-28) rather than four. Decide the outbound mail transport before any delivery
> claim.

Both are now decided, implemented on both adapters, exercised over HTTP and — for mail — against a
real SMTP conversation on a local socket. Nothing else in row 5 changed: settings screens are still
absent, and the notifier still has **no delivery channel**, so `emailDeliveryAvailable` remains
`false` and no alert claims to have been emailed.

## 1. The retention decision

**One policy, one command, four windows.** `tools/prune-retention.mjs` /
`npm run prune:retention` applies every window. A dry run is the default, `--apply` is required,
`0` means *keep forever*, and **there is no HTTP route that can delete a row** — the same rule R-27
set for analysis runs, now stated for all four tables.

| Table | Window | Default | Why that default |
|---|---|---|---|
| `wf_analysis_runs` | `ANALYSIS_RETENTION_DAYS` | **90** | R-27's existing decision, unchanged. A run is advisory output. |
| `wf_notifications` | `NOTIFICATION_RETENTION_DAYS` | **0** | The inbox is the only record of what was announced. Read rows can be aged out; unread ones never are. |
| `wf_backtests` | `BACKTEST_RETENTION_DAYS` | **0** | A backtest is load-bearing evidence for a promotion already granted. Off unless an operator decides otherwise. |
| `wf_audit_events` | `AUDIT_RETENTION_DAYS` | **0** | A trail that silently ages out is not an audit trail. A window is a deliberate, warned act. |

Three guards make the windows safe, and each is tested on both adapters:

1. **Notifications: read rows only.** The predicate is `read_at IS NOT NULL AND created_at < ?`.
   An unread alert is somebody's to-do item, and an unread row is also what suppresses a duplicate
   publish (`hasUnreadNotificationDedupe`); deleting it would lose both. A test proves the surviving
   unread row still dedupes after a prune.
2. **Backtests: never the newest report for a `(strategy, version)`.** The pair's newest row is
   excluded from the measurement *and* the `DELETE`. The BACKTESTED gate requires
   `countBacktests(...) > 0` and the VALIDATED gate reads `latestBacktest(...)`; keeping the newest
   row preserves both **by construction**, whatever window is set. Ties on `created_at` keep every
   tied row — deleting fewer is the safe direction. MySQL uses a materialised derived table for the
   exclusion, which is also what makes it legal under `ERROR 1093`.
3. **Text timestamps are shape-checked.** `wf_notifications.created_at` and `wf_backtests.created_at`
   are `VARCHAR(32)` ISO-8601 text, compared as text. That comparison is chronological only while
   every writer uses the canonical form (migration 006 says so): a legacy-imported `11/07/2026`
   sorts *before* every `2026-…` string and would be deleted as "oldest". Both prunes therefore add
   `created_at LIKE '____-__-__T__:__:__%'` on MySQL and the equivalent regex in the file adapter, so
   a malformed row is skipped rather than guessed at. (The file-adapter tests seed exactly such a
   row and assert it survives.) `wf_audit_events.created_at` is `DATETIME(3)`, so the cutoff is
   bound as a JS `Date` and compared by the server, with the pool's `timezone: "Z"` making that
   binding mean the UTC instant the CLI printed.

Every prune returns one report shape — `matching`, `deleted`, `oldest`, `newest`, `bytes`,
`cutoff`, `batches`, `exhausted`, `dryRun` — so the CLI prints one table. Measurement and deletion
share one predicate per table, so the count an operator reads is exactly the set the loop removes.
MySQL deletes in clamped batches (1–5 000, default 500) with `ORDER BY created_at ASC, id ASC`,
because `DELETE … LIMIT` without an order is non-deterministic and statement-based replication logs
that as unsafe; the file adapter deletes through the log's existing `delete` op so replay and
`compact()` need no format change, and the tests reopen the store from disk to prove the deletions
replay.

**What retention cannot do.** It cannot delete an unread notification, the last backtest of a
strategy, a row whose timestamp is not canonical ISO text, or anything at all when no window is set.
It also cannot be reached from a browser: the route inventory has no delete verb for any of the four
tables, and `test/retention.test.js` already pins the analysis module's zero-`DELETE` registration.

## 2. The mail decision

**SMTP, from the server environment, with the transport injected.** `src/mail/` is a dependency-free
SMTP submission client (`smtp-transport.js`), an RFC 2047/2045 message builder (`mime.js`), and
`src/modules/mail/service.js` — the port of `Aegis\Mailer`, method for method:

| Legacy | Port |
|---|---|
| `Mailer::enabled()` — switch is `1` **and** a host is set | `config.mail.enabled`, computed the same way from `VP_SMTP_ENABLED`/`SMTP_ENABLED` + `VP_SMTP_HOST` |
| `Mailer::configSummary()` — nine credential-free fields | `mail.configSummary()`, same nine keys, never the password |
| `Mailer::send()` — four refusals in a fixed order, one sentence each | `mail.send()`, same order and same words |
| `Mailer::sendTest()` — subject `WINDELS AI WORKFORCE — test email (html\|plain)`, four summary rows | `mail.sendTest()`, same subject and body |
| `Admin::test_email` — super-admin + CSRF, audits `ADMIN_TEST_EMAIL` `{to, ok}` | `POST /api/v1/admin/mail/test`, same guard and same audit payload |
| `Site::tryMail` — copy to `VP_MAIL_FROM`, visitor as Reply-To, failure never fails the intake | `copyToOperator()` in the site service, same behaviour and same early returns |
| `application/config/email.php` — names, defaults, coercion | `loadMailConfig()`, same names and defaults; `472`-style values coerced to `tls` as the PHP config did |

The refusals, verbatim and in legacy's order:

1. `The recipient address is not a valid email.`
2. `Outgoing email is disabled. Set VP_SMTP_ENABLED=1 and a VP_SMTP_HOST on the server to send.`
3. `SMTP username/password are not configured in the server environment.`
4. `No VP_MAIL_FROM address is configured on the server.`

…and the success sentence is legacy's too: `Message accepted for delivery to <to>.` A server
rejection becomes `The SMTP server did not accept the message. …`, with the same three short forms
CodeIgniter produced (connection failure, a `4xx`/`5xx` status line, or the transcript tail). A test
seeds the password into the transcript and asserts it cannot reach the message a person reads.

**The transport supports what the legacy config supported**, and only that: implicit TLS
(`ssl`, usually 465), STARTTLS (`tls`, usually 587), no encryption (`none`), and `AUTH PLAIN` or
`AUTH LOGIN` when both a username and password are configured. It is **injected**: production builds
one client per send from `config.mail`, while the suite injects either a recorder or a local
`test/smtp-server.js` on `127.0.0.1` — so the integration tests assert what a server received, not
what the client claimed, and no test can reach a public host.

### Divergences

* **MA-1 — credentials are never sent unencrypted in production.** Legacy would happily put `AUTH`
  on a clear-text socket. Production configuration now refuses to boot when mail is enabled with
  credentials and `VP_SMTP_CRYPTO=none`. Development and a credential-free local relay are still
  allowed. This is a deliberate tightening, not parity.
* **MA-2 — STARTTLS is required, not attempted.** When `tls` is configured and the server does not
  advertise `STARTTLS`, the send fails with `The SMTP server does not offer STARTTLS; refusing to
  send over an unencrypted connection.` CodeIgniter would have continued in clear text. A protocol
  downgrade that only shows up in a transcript is not a behaviour worth preserving.
* **MA-3 — certificates are verified.** `tls.connect` validates the chain by default; CodeIgniter's
  SMTP client did not. A host with a broken chain now gets a connection error naming the certificate
  instead of a silent success. No configuration turns verification off.

Two smaller consequences: the recipient pattern is the platform's one `FIELD_FORMATS.email` (so
`a@b` is refused, as every route already refused it), and messages always carry both an HTML and a
plain-text part, which is what `mailtype: html` + `set_alt_message()` produced.

### What mail is *not* wired to

Password reset still answers `delivered: false`; there is no token store, so there is nothing to
send (row 2's blocker is now half gone). Notifications are still stored and read in-product only —
no publisher is given the mail service, and `statusSnapshot()` says so. The only two senders are the
administrator test and the contact-form copy, exactly the two legacy had.

## 3. The surface

| | |
|---|---|
| New routes (2) | `GET /api/v1/admin/mail` (summary, `system.super_admin`, unvalidated read), `POST /api/v1/admin/mail/test` (validated, rate-limited 5/min, `system.super_admin`, CSRF via the permission guard). Route inventory **146 → 148**. |
| New contract methods (3) | `pruneAuditEvents`, `pruneNotifications`, `pruneBacktests`. Repository contract **185 → 188**, pinned in the five files that pin it (with the annotation string in `platform_findings.test.js`). |
| New files | `src/mail/mime.js`, `src/mail/smtp-transport.js`, `src/modules/mail/{service,routes,contracts}.js`, `src/db/retention.js`, `tools/prune-retention.mjs`, `test/smtp-server.js`, `test/mail.test.js` (11 tests), `test/retention_policy.test.js` (13 tests), this record |
| Edited (server) | `src/config.js` (`retention`, `mail`), `src/persistence/contract.js`, `src/db/{account,notification,strategy}-repository.js`, `src/persistence/file-store.js`, `src/db/store.js` (composes `pruneNotifications`), `src/app.js`, `src/modules/site/{service,routes}.js`, `src/modules/platform/health.js`, `src/modules/notifications/service.js` (reason text only — fields unchanged), `tools/prune-analysis-runs.mjs` (exports `parseFlags`; same behaviour) |
| Edited (client) | `client/src/admin.js` (`MAIL_PANEL`, `mailSummaryRows`, `mailPanelState`; the not-ported `SMTP_PANEL` is gone), `client/src/views.jsx` (the panel: summary table, test form, result notice), `client/src/api.js` (two wrappers), the account email hint (no longer claims no transport exists) |
| Edited (tests) | `test/site.test.js` (the disabled reason is legacy's sentence), `test/platform_findings.test.js` (188, the audit label, 9 admin routes, `prune:retention` in the operational list), `test/client_admin_console.test.js` (the panel's rows, states and routes), `test/{lottery_*,strategies_store}.test.js` (the contract pin), `test/notifications_service.test.js` (the reason names the two real senders) |
| Edited (docs/env) | `.env.example` (three windows + the SMTP block), `README.md`, `STATUS.md`, `UNFINISHED_MODULES.md` (row 5 and row 2), `RISK_REGISTER.md` (R-28 closed, R-27 notes the shared policy), `DATA_DICTIONARY.md` (the four-table policy) |

`/app/admin` is gated on `system.super_admin`, which is the permission both routes enforce, so the
panel withholds nothing it could read and offers nothing the API would refuse. It renders the
server's summary as a table (blank fields are an em dash, never a zero), says whether credentials are
*set* and never what they are, disables nothing (a send against a disabled mailer returns legacy's
sentence, which is the useful answer), and prints the server's sentence for both outcomes.

## 4. Tests and gates

`test/retention_policy.test.js` — 13 tests. The file adapter is real and reopened from disk; the SQL
adapters are pinned against a recording fake pool (there is no MySQL in this sandbox) for the
statement text, bound values, the guard clause, batch clamping and the ceiling report; the CLI is a
subprocess, so flags, output and exit codes are an operator's. The three safety properties each have
a direct test: an unread notification survives and still dedupes, a strategy's newest backtest
survives a 90-day window that would otherwise take it, and a malformed timestamp is never deleted.

`test/mail.test.js` — 11 tests. Configuration (legacy's `enabled()` rule, `VP_` precedence, coercion,
MA-1), message building (encoded subject, quoted names, header-injection refusal, base64 round trip),
the refusals in order, the summary (no password, ever), the SMTP conversation against
`test/smtp-server.js` (success, dot-stuffing, AUTH refusal, RCPT refusal, STARTTLS refusal, dead
port), and the HTTP surface (401/403/400/200, the audit row, the disabled sentence, the contact copy
with its Reply-To).

Full gate: `npm run check:workforce` **1205 / 1205**, the client suites **204 / 204**, `npm run
typecheck` clean, `npm run test:contracts` 12/12, `npm run verify:install -- --require-bundle`
**30 / 30**, and the client build at `index-Dv9NrFsv.js` 590.71 kB / 157.00 kB gzip with
`index-CkPGdTlp.css` 47.51 kB / 9.88 kB gzip. The hash changed from Phase 41's
`index-DqanVWU-.js`; the Phase 41 record keeps the hash it shipped.

**Not run:** a real browser against the panel (the client suite reads the built bundle and the
source, and the HTTP tests drive the routes), **real SMTP** — every send in this phase went to a
local `127.0.0.1` server written for the test — real MySQL/MariaDB (the SQL prunes are pinned
against a fake pool, as every previous phase's are), cPanel/Passenger, live market providers, and
still no PHP↔Node numeric diff (F-26).

**Ledger:** unchanged at **10 ported / 5 partial / 2 not-ported**. This phase closed decisions
inside an already-`ported` module rather than porting a new one; `audit` and `notifications` keep
their `ported` state, with the audit label now naming the operator-run window and the notifier's
label naming what SMTP is actually for.
