# Phase 49 — Row 5: outbound notification email delivery (divergence DV-28)

**Date:** 2026-10-17 · **Branch:** `arena/d57504c6-ai` · **Version:** 0.25.0

Row 5 of `UNFINISHED_MODULES.md` ("Notifications, audit browser, feature/status
reporting and system health") had one deliberately open surface after Phase 42:
**the notifier had no delivery channel at all.** `emailDeliveryAvailable` was a
hard `false`, `deliveryChannels` was `[]`, and the status reason denied that any
alert was ever emailed — because none was: Phase 42 ported the SMTP transport,
but only for the administrator test send and the contact-form copy, exactly
where legacy used mail.

This phase closes that surface with one bounded, opt-in channel: **an email copy
of each stored operator notification** to a fixed operator address list, added
after the in-product row exists. Legacy never emailed an alert, so the channel
itself is divergence **DV-28**; the divergence is the *existence* of the
channel, and every safety property around it is engineered so the divergence
cannot lie about what happened.

## Why the shape is what it is

A notification in this platform is evidence about something that already
happened. The email had to stay a copy of that evidence — it must never become
a parallel source of truth, a control surface, or a failure mode for the
governance decision that produced the alert. Eight rules follow:

1. **Store first, copy second.** `notify()` persists the row, then — only on
   `created: true` — attempts delivery. A failed store sends nothing; the copy
   can never outlive or predate the row it copies.
2. **Delivery can never roll anything back.** The mailer's refusal is collected
   as `ok: false`; a transport throw is caught and logged. Neither changes the
   stored alert, the return's `created`, or the publisher's outcome. Publishers
   are governance code; an alerting outage must never look like a trading
   outage.
3. **Severity-gated, conservative by default.** The operator lists which
   severities are paged; the default is `critical` only. An operator who flips
   the flag gets paged about criticals, not spammed.
4. **Dedupe rate-limits email exactly as it rate-limits the badge.** A
   recurring alert republished while its unread row exists is `deduped: true`
   and sends nothing — five suppressed republishes leave the earlier two
   sends as the whole mail volume (tested).
5. **No action links.** The body carries no link that could perform anything;
   a one-line header identifies the platform, severity and type, and the
   disclaimer states that the in-product inbox is the channel of record.
6. **Bounded render.** The subject is one line; the detail JSON render is
   capped at 4 000 characters, and the cap admits itself in the text
   (`[truncated: detail exceeded …]`). A worst-case notification cannot produce
   a worst-case email (tested at 2× the cap).
7. **The audit trail never holds a full address.** Deliveries are audited as
   one `notification.email` event per alert (not per recipient) with masked
   recipients (`o***@host.tld`), `sent`/`failed` counts, and the severity/type;
   a test asserts the full address appears nowhere in the persisted event.
   The audit write itself is best-effort — it must not convert a stored alert
   into an apparent failure.
8. **The badge is an AND gate.** `emailDeliveryAvailable` is true only when
   the operator opted in (flag `1` + recipients + severities) **and** SMTP is
   actually configured (enabled + credentials + a valid envelope sender). Every
   clause missing keeps it `false` — the console may never advertise a channel
   that cannot send.

## Configuration (`src/config.js` → `loadNotifyEmailConfig`)

| Variable | Shape | Default |
|---|---|---|
| `VP_NOTIFY_EMAIL_ENABLED` | must be the literal `1` (legacy's `VP_SMTP_ENABLED` convention) | `0` |
| `VP_NOTIFY_EMAIL_TO` | comma-separated addresses, at most 10, trimmed, deduplicated | (none) |
| `VP_NOTIFY_EMAIL_SEVERITIES` | comma list from `info, warning, critical`, case-insensitive, deduplicated | `critical` |

`enabled = flag === "1" && recipients.length > 0 && severities.length > 0`.
An **invalid address refuses boot** and an **unknown severity refuses boot**:
on an explicit opt-in, a typo should stop the deploy, not silently un-notify
an operator. All three variables are documented in `.env.example`
(`verify:install` counts documented variables).

## What was wired

- `src/modules/notifications/email-copy.js` — new pure builder:
  `buildNotificationEmail` (subject/vnd bodies, escape, 4 000-char bounded
  detail render with self-admitted truncation), `maskEmail`, `escapeHtml`.
- `src/modules/notifications/service.js` — `createNotificationService` accepts
  optional `{ mail, notifyEmail }`. With neither present the service behaves
  exactly as before this phase (no `email` key in any result, no send) — the
  ports of the three inbox endpoints, dedupe, broadcast visibility and audit
  are untouched. `notify()` now returns
  `email: { attempted, sent, failed, recipients }` (mask-only) when a delivery
  was attempted; `statusSnapshot()` computes the AND gate and reports
  `deliveryChannels: ["in-product"]` (plus `"email-copy"` when the gate is up),
  and its reason names the gate either way.
- `src/app.js` — the mail service is built before notifications and handed in
  with `config.notifyEmail`; a default host composes the same service as
  before, because the collaborators are optional in both directions.
- `src/modules/platform/health.js`, `client/src/admin.js` footnote,
  `apps/workforce-platform/README.md` — the ledger copy, the SMTP panel copy
  and the capabilities list now describe the channel and its gate instead of
  denying any outbound channel exists.

## Tests (`test/notification_email.test.js`, 20 tests; suite 1 239 → 1 259)

- **Config:** defaults off; `enabled` requires flag + recipients + severities;
  recipient parsing/trim/dedupe; invalid address refuses boot; 11 recipients
  refuse boot; severity parsing, dedupe and unknown-value refusal.
- **Copy builder:** masking; the disclaimer and one-line subject injection
  safety (`\n` collapsed); HTML escaping of every user-controlled value;
  detail truncation at the cap with the marker.
- **Service (injected fake mailer):** stored-then-sent order; severity gate
  (info not paged under critical+warning); dedupe suppressing the copy across
  5 republishes; persistence failure sending nothing; mail refusal counted,
  audited, and leaving `created: true`; transport throw caught the same way;
  broadcast and targeted both emailed to the *operator list* — never to the
  targeted user's address; pre-Phase-49 service (no collaborators) unchanged.
- **The gate:** `emailDeliveryAvailable` true only with flag + recipients +
  severities + SMTP enabled + credentials + valid sender; each clause missing
  keeps it `false`.
- **End to end:** the assembled app against the real loopback SMTP server
  (`test/smtp-server.js`) — boot engaged (so re-affirm publishes nothing), the
  operator releases the kill switch (info → not paged under the default
  filter), engages it again (critical), and two envelopes arrive
  (`TO:<ops@…>`, `TO:<oncall@…>`) with the encoded-word subject decoding to
  `[CRITICAL] KILL SWITCH ACTIVATED — all order placement blocked — KILL_SWITCH`,
  the text part carrying the disclaimer, the HTML part carrying no `href`,
  and exactly one audit event with `sent: 2, failed: 0` and masked addresses.

Existing assertions that pinned the pre-Phase-49 surface were updated, not
deleted: the default host still answers `emailDeliveryAvailable: false` and
`["in-product"]`, and the service-composed-without-opt-in test now pins the
honest *gate-naming* reason.

## Verification

- Node suite: **1 259 / 1 259** (one full run showed a single transient
  sports-store failure that did not reproduce in isolation and passed on the
  re-run; the final state is clean).
- PHP oracle (WASM): **367 / 367**.
- `npm run verify:install`: **30 / 30** (includes the `.env.example`
  documentation count for the three new variables).

## What row 5 still means by "unfinished"

- Notification **preferences/settings screens** (`views/settings`) are still
  unported — the copy's knob is environment-only, matching this platform's
  SMTP policy.
- **Live-relay verification** is a host task: the wire is proven against a
  real socket on 127.0.0.1; the operator must still run the same conversation
  against their actual relay (and, in production, MA-1/MA-2 require TLS).
- Delivery beyond email (push, webhook) was never legacy behaviour and is
  not claimed anywhere.
