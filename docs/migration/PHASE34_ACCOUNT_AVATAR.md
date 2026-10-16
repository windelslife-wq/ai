# Phase 34 — the account screen's profile image (row 3)

**Status:** complete · 2026-10-16 · branch `arena/046b29ac-ai`

`/app/account` now carries legacy's profile-image control: the 84px circular hero, the upload form and
the remove form, driving `POST`/`DELETE /api/v1/account/avatar` — two routes that have existed since the
identity slice with **no caller**. It closes the first half of row 3's settings gap; the second half, the
admin control centre, is untouched.

## Scope

| | |
|---|---|
| Legacy | `views/auth/account.php` (the `.avatar-lg-wrap` hero and `.avatar-actions` row), `Auth::upload_avatar`, `Auth::remove_avatar`, `Auth::reestablishIdentity` |
| Node routes (already present, unchanged) | `POST /api/v1/account/avatar` (authenticate + CSRF, 10 uploads / 10 min, multipart), `DELETE /api/v1/account/avatar`, `GET /api/v1/files/avatars/:fileId` |
| New files | `client/src/avatar.js`, `test/client_account_avatar.test.js`, this record |
| Edited (client) | `client/src/views.jsx`, `client/src/api.js`, `client/src/styles.css` |
| Edited (server) | `src/app.js`, `src/http/bodies.js`, `src/modules/identity/routes.js` — message parity only |
| Unchanged | no route, migration, contract method or permission was added: the server registers **146 routes** before and after |

## What the routes already did — and what the screen therefore did not have to invent

The upload route has been complete since the identity slice: it refuses when `UPLOADS_ENABLED` is false
(503 `UPLOADS_DISABLED`, `retryAfter` 3600), decides the type by **content sniffing** (the client's
filename and declared MIME are never trusted), caps the file at `UPLOAD_MAX_BYTES` (2 MB by default),
stores outside the static root under a generated `u<userId>_<32hex>.<ext>` name, deletes the file it
replaced, writes `identity.user.avatar-updated` / `identity.user.avatar-removed` to the audit trail, and
serves the bytes back only through the owner-or-super-admin read route. The screen adds no rule of its
own: every accepted format and every refusal is the server's, and `client/src/avatar.js` holds only the
sentences and the hero decision.

## The control

- **Hero.** The stored image (`user.avatarUrl`) in legacy's 84px circle, or the initials of the display
  name — `avatarInitials("Ada Lovelace") === "A"`, the legacy `preg_replace('/[^A-Za-z0-9 ]/','')` +
  first-character rule, `W` when nothing is left. Never an empty frame: a blank or whitespace-only
  stored path is treated as no image. One deliberate deviation is documented in the module: legacy took
  the first character even when it was a space, so `" Ada"` rendered a blank circle; leading spaces are
  skipped here.
- **The three labels are legacy's:** `Upload image`, `Save image`, `Remove image`, with the legacy
  `accept` attribute (`image/png,image/jpeg,image/gif,image/webp`), the legacy hint line
  (`PNG, JPEG, GIF or WebP · up to 2 MB.`) and the legacy notices (`Your profile image has been
  updated.` / `Your profile image has been removed.`). The remove control renders **only when an image
  exists**, as in the legacy markup.
- **Chosen file name.** The legacy `.avatar-file` script was a no-op stub (`input.value;`); the control
  prints `Chosen: <name>` instead, so a member can see which file the browser will send.
- **The session is refreshed after every change** (`GET /auth/me` → `onSessionChanged`), the same reload
  `Auth::reestablishIdentity()` performed, because `user.avatarUrl` is what the hero and every other
  view read.
- The file input sits **inside its label** (as in the legacy form) and the focus ring lands on the
  visible `Upload image` text rather than on a 1px hidden input.

## The refusals speak the routes' own reasons

| What happened | What the control shows |
|---|---|
| No file chosen | The server's own `NO_FILE` sentence, `Choose an image to upload`, stated before the round trip (the browser submits nothing, and legacy's `UPLOAD_ERR_NO_FILE` branch said exactly this) |
| A text file named `notes.png` | `Only PNG, JPEG, GIF or WebP images are allowed` (422 `UNSUPPORTED_TYPE`) |
| An image over the limit | `Profile image must be 2 MB or smaller` (413) — see defect 1 |
| More than ten uploads in ten minutes | The server's `RATE_LIMITED` sentence plus `Try again in about <retry-after>s.`, read from the response header exactly as `ApiError.retryAfter` does |
| `UPLOADS_ENABLED=0` on the host | The server's `Profile image storage is not enabled on this host` **plus the operator's remedy** (`UPLOADS_ENABLED=1`), and deliberately **no** retry advice: the server's `retryAfter` for this state is 3600s, and "try again in about 3600s" would be a lie about a switched-off feature |

`avatarFailureMessage` never falls back to "Upload failed." for a refusal that has a reason, and the
bundle carries no second copy of the disabled-host sentence — the control renders the server's message.

## Defects found and fixed on the way

1. **The route's size refusal was unreachable** (parity). The route words an oversized image as legacy
   did — `Profile image must be 2 MB or smaller` — but two HTTP-layer guards fired first with byte
   counts: `readRawBody` (`The request body must not exceed 2162688 bytes`) and `parseMultipart` (`The
   uploaded file must not exceed 2097152 bytes`). A member uploading a 3 MB photo would have been told
   a number, on a screen that says "up to 2 MB". Both layers now accept the route's own
   `config.oversizeMessage`, declared once by the avatar route through
   `profileImageTooLargeMessage(config.uploads)` — the limit is unchanged, only the sentence.
2. **The client had no multipart path** (latent). `api()` set `content-type: application/json` by
   default and ran `JSON.stringify(body)`, so a `FormData` would have been sent as the two characters
   `{}` with a JSON header and refused (`MALFORMED_MULTIPART`). The multipart branch keeps the browser's
   own content-type — the boundary — and the CSRF header is still attached.
3. **Two different empty submissions.** A browser's empty file input sends a file part with no content
   (`filename=""`), which the server answers with `NO_FILE` and the legacy sentence; a form envelope
   with *no parts at all* is `MALFORMED_MULTIPART` (`The upload could not be read`). Both are refusals
   with reasons; the live probe now pins the first, and the second is recorded here rather than smoothed
   into a single message.
4. **An accessibility fix, not a parity one:** the legacy markup nests the file input inside its label;
   keeping that shape is what makes the focus ring land on the visible text.

## Tests

`test/client_account_avatar.test.js` — **11 tests**, hermetic (file adapter, `createFileStoreApp`, no
network, uploads under `tmpdir`):

- the control's words against `views/auth/account.php` (accept list, hint, notices) and the initials
  rule case by case, including the documented leading-space deviation;
- `avatarView` and `avatarFailureMessage` as pure functions, including "no `Try again in about 3600s`";
- the route inventory: the two mutation routes are session-only (`permission: null`), the upload is
  rate-limited, the private read route is the **only** way to the bytes, and no fourth avatar surface
  exists; the account entry in the shell nav is session-only and the view is the rendered one;
- the refusals above, each asserted on the server's code **and** sentence;
- the whole lifecycle: 201 → `/auth/me` agrees → the bytes come back byte-for-byte (compared through
  `inject`'s `.buffer`, not a decoded string) with `content-type: image/png` and
  `cache-control: private` → an anonymous read is 401 → replacement deletes the old file and its URL
  404s → another signed-in member gets 403 `NOT_OWNER` → DELETE without a CSRF token is 403
  `CSRF_INVALID` → DELETE clears the path, deletes the file and falls back to initials → both audit
  actions are in the member's own activity.

## Gates

- `npm run check:workforce` → **1035 / 1035** (1024 before), 5 suites. *One earlier run of the same
  command reported a single failure whose name was not captured; the next full run and three focused
  runs of the six client suites (59 / 59 each) were green. Recorded as unexplained, not smoothed over.*
- `test/client_account_avatar.test.js` **11 / 11**; `test/http.test.js`, `legacy-identity`,
  `site`, `platform_findings` **62 / 62** (the suites that exercise the changed body reader).
- `npm run build:client` → `index-CC_niHxZ.js` 421.96 kB / 116.41 kB gzip, `index-DF950OMU.css`
  38.95 kB / 8.48 kB gzip (from 419.51 kB / 38.08 kB).
- `npm run verify:install -- --require-bundle` → **30 / 30**.
- Live probe against the file-store demo (`/tmp/avatar_probe.mjs`, admin `root`): **21 / 21** — a real
  multipart upload over HTTP, the private read compared byte-for-byte, an anonymous read refused, a
  replacement leaving the old URL 404, a text file named `.png` refused in the legacy words, a file-less
  form refused with `NO_FILE`, a 3 MB upload refused as `Profile image must be 2 MB or smaller`,
  removal clearing both the path and the file, and the **served bundle** carrying the control's strings.
- **Not run:** a real browser (no DOM/WebDriver here), real MySQL/MariaDB, any live market-data
  provider, SMTP, cPanel/Passenger, and still no PHP↔Node numeric diff (F-26).

## Row 3 after this phase

Closed: the workspace dashboard (Phase 33) and the account screen's avatar control (this phase).
Still absent and named in the ledger: the **sports dashboard** and the **admin control centre**
(`views/admin/index.php` — the access-policy list, the feature-readiness table and the SMTP panel, the
last of which cannot be ported while the platform has no mail transport; its user table and the
create/toggle forms are already at `/app/admin/users`). F-29's residual console list (paper, risk,
execution, brokers, journal, sports, the admin control centre) is unchanged. **The module counts are
unchanged — 10 ported / 5 partial / 2 not-ported:** this phase wired a control to existing routes, which
is not a promotion.
