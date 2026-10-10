# Phase 3 — Public site, SEO/PWA shell and contact intake (2026-10-09)

**Branch:** `arena/774d9e70-ai` · **Sandbox Node:** v22.22.3 · **Suite:** 103 app tests (18 new), 367 legacy runtime tests, 12 Scout contract tests, 29 football-prediction tests, 30/30 install checks, 4/4 icon checks — all executed and passing.

This phase ported the second module — the public marketing site (`Site`, `Seo`), its SEO
documents, the PWA shell and the public contact form — and closed findings **F-09** (PWA
installability/updates) and **F-10** (SEO/public-site parity). It also delivered the SPA
slice the Phase 3 redirects depend on (`/app/login`, `/app/register`, `/app/account`,
`/app/status`, `/app/admin/users`, `/app/admin/inquiries`).

Nothing here is a cutover. `application/` and `system/` are byte-for-byte unchanged; the
PHP platform remains authoritative and remains the rollback target.

---

## 1. What now exists

### Public-site module (`src/modules/site/`)

| File | Replaces | Notes |
|---|---|---|
| `pages.js` | `views/site/*.php` (8 views) | The page inventory as data: key, path, nav label, title, and an ordered block list (`hero`, `cards`, `steps`, `grid`, `faq`, `cta`, `form`, …). Headings and body copy are ported from the legacy templates, heading for heading — asserted in `test/site.test.js` against the PHP files themselves. |
| `render.js` | `views/site/layout/{header,footer}.php` | Server-side HTML emitter: escaping `tag()` builder, head metadata, announcement bar, 8-entry nav, footer columns, skip link, flash markup, 404/405 documents. No inline `style=`, no inline handlers, no inline `<script>` — the production CSP is `script-src 'self'; style-src 'self'`. |
| `seo.js` | `application/config/seo.php` + `Seo.php` | `robotsTxt()`, `sitemapXml()`, `webManifest()`, `serviceWorkerSource()`, `neverCachePatternLiteral()`, `SERVICE_WORKER_NEVER_CACHE`. Every document is generated per request from validated config, never committed as a file. |
| `documents.js` | `index.php` front controller routing | The document ledger: which paths are pages, redirects, generated documents or form targets; `describeShell(publicDir)` hashes the precache set; `/service-worker.js` is served `no-cache`. |
| `contracts.js` | `Site::contact_submit` validation | `CONTACT_SUBMIT` (JSON), `CONTACT_FORM` (urlencoded), `INQUIRY_LIST_QUERY`, `CONTACT_INVALID_MESSAGE` (legacy text, verbatim). |
| `service.js` | `Site::contact_submit` + `tryMail()` | Stores the inquiry, writes the `CONTACT_INQUIRY` audit entry, and reports the mail situation truthfully (`mail.sent: false` — there is no outbound transport on this platform). |
| `reference.js` | — | 26-character Crockford-base32 ULID for the public receipt reference; no new dependency (`node:crypto` only). |
| `routes.js` | `Api_*` conventions | `POST /api/v1/site/contact` (public, throttled) and `GET /api/v1/admin/inquiries` (`system.super_admin`, paginated). |

### Supporting code

| File | Notes |
|---|---|
| `src/security/flash.js` | Signed one-shot flash messages for the no-script form path: `wf_flash` cookie, HMAC-SHA256 over the payload with `SESSION_SECRET`, base64url, 120 s TTL, `HttpOnly`, `SameSite=Strict`, `Secure` when the platform runs behind HTTPS. A forged or expired signature renders nothing. |
| `src/security/ratelimit.js` | Added the per-client-address `contact:<addr>` bucket used by the public write endpoint. |
| `src/db/site-repository.js` | MySQL statements for `recordContactInquiry` / `pageContactInquiries`, with bound parameters and a row mapper. |
| `src/db/migrations/004_public_site.sql` | Additive: `wf_contact_inquiries` (unique `reference`, indexes on `created_at` and `(status, created_at)`), `client_fingerprint CHAR(64)` rather than a raw IP. |
| `src/persistence/contract.js` | Repository contract grows from 30 to **32** methods; both adapters are asserted against it at boot. |
| `src/persistence/file-store.js` | `inquiries` entity added, so the file adapter can run the whole public site with no database. |
| `src/app.js` | `handleDocument()`: rendered documents first, then static files, then the SPA shell for `Accept: text/html` under `/app/*`; per-client concurrency ceiling (`MAX_REQUESTS_PER_CLIENT`) answering `429 TOO_MANY_CONCURRENT_REQUESTS` with `Retry-After: 1`. |
| `src/modules/platform/health.js` | `publicSite` module state reported as **`partial`**, not `ported`: the chat assistant is not here (see §5). |
| `tools/generate-icons.mjs` | Deterministic PNG encoder/verifier (`node:zlib`, hand-rolled CRC32) that renders the brand mark at 192, 512, maskable-512 and apple-touch-180. `npm run build:icons` / `npm run check:icons`. |
| `public/site.js` | Vanilla public-site behaviour: menu toggle, announcement/PWA install banner host, online/offline state, service-worker registration with the waiting-worker **Reload / Not now** prompt, contact submit via `fetch` with a no-script form fallback. |
| `public/styles.css` | Public-site styles appended (pages, nav, footer, flash, forms, install banner). |
| `public/icons/*` | 4 committed PNGs + the existing SVG mark. Verified byte-reproducible from the generator by an install check. |
| `client/src/{api,router,ui,views}.jsx` + rewritten `App.jsx` | The SPA slice — see §7. |

**Deleted, deliberately:** `public/index.html`, `public/robots.txt`, `public/sitemap.xml`,
`public/manifest.webmanifest`, `public/service-worker.js`. All five are rendered per
request; a committed copy would drift and would win over the generated one on any host
that serves files before the app. `verify:install` fails the build if any of them returns.

---

## 2. Route parity — the ported surface

Legacy source of truth: `application/config/routes.php` (site block), `controllers/Site.php`,
`controllers/Seo.php`, `views/site/*`. `test/site.test.js` parses the legacy route file with a
regex and asserts every rule is answered by the Node transport — the parity list is read from
the PHP, not retyped.

### 2.1 Pages (8)

| Legacy | Node | Data contract ported |
|---|---|---|
| `GET /` → `site/index` → `site/home` | `GET /` | `title`, `active`, `notice`/`error` (flash), `languages` → `SITE_LANGUAGE_COUNT`; 8 service cards with the legacy card titles |
| `GET /about` → `site/about` | `GET /about` | same contract |
| `GET /services` → `site/services` | `GET /services` | same contract |
| `GET /how-it-works` → `site/how` | `GET /how-it-works` | same contract |
| `GET /locations` → `site/locations` | `GET /locations` | same contract |
| `GET /safety` → `site/safety` | `GET /safety` | same contract |
| `GET /faq` → `site/faq` | `GET /faq` | same contract |
| `GET /contact` → `site/contact` | `GET /contact` | same contract + the contact form and its intake rules |

Headings (`h1`–`h3`) are compared against the legacy view files with HTML entities decoded, so
a rewritten heading fails the suite.

### 2.2 Aliases and redirects (9)

| Path | Status | Target | Legacy relationship |
|---|---|---|---|
| `/coverage` | 301 | `/locations` | legacy alias |
| `/help` | 301 | `/faq` | legacy alias |
| `/how` | 301 | `/how-it-works` | legacy alias |
| `/login` | 302 | `/app/login` | legacy `auth/index` page → SPA sign-in |
| `/admin/login` | 302 | `/app/login` | legacy `auth/admin_login` |
| `/register` | 302 | `/app/register` | legacy `auth/register` page → SPA register view |
| `/forgot-password` | 302 | `/app/login` | **divergence:** password reset is not ported (§5) |
| `/access-denied` | 302 | `/app/` | legacy `auth/denied`; the SPA renders the refusal with the permission named |
| `/dashboard` | 302 | `/app/` | legacy `workspace/index` |

### 2.3 Generated documents (4) and the form target (1)

| Path | Kind | Behaviour |
|---|---|---|
| `GET /robots.txt` | generated | Legacy rule set preserved (`User-agent: *`, `Allow: /`, `Disallow: /api/ /admin /account /dashboard /analysis /app/`) plus three Node-only private prefixes (`/uploads/`, `/private/`, `/data/`). The `Sitemap:` line appears only when `PUBLIC_BASE_URL` is set, exactly like the legacy conditional. |
| `GET /sitemap.xml` | generated | 8 marketing pages. With no canonical base it emits an explanatory XML comment and **zero** `<url>` entries rather than publishing relative `<loc>` values (the legacy emitted `$base . $path`, i.e. relative URLs, when `VP_BASE_URL` was empty). |
| `GET /manifest.webmanifest` | generated | `id`/`start_url` `/app/`, `scope` `/`, `display: standalone`, configured colours, 4 icons including a `purpose: maskable` 512 PNG. |
| `GET /service-worker.js` | generated | Versioned by shell content (`windels-shell-<sha256[:16]>`), served `cache-control: no-cache` as `text/javascript`. |
| `POST /contact/submit` | form | 303 back to `/contact` with a signed flash; `GET /contact/submit` is **not** a route (legacy `contact_submit` is POST-only), so a GET answers 405 with `Allow: POST`. |

### 2.4 New API routes (2 of the now 30)

| Method/path | Auth | Limits | Notes |
|---|---|---|---|
| `POST /api/v1/site/contact` | public | `CONTACT_MAX_PER_HOUR` (default 3) per client address per `CONTACT_WINDOW_MS`; general API limit also applies | Returns `{id, recorded, reference, mail:{sent:false, reason}, notice}`. Unknown body fields are refused (`additionalProperties: false`), so a smuggled honeypot or extra key is a 400, not a silently dropped value. |
| `GET /api/v1/admin/inquiries` | `system.super_admin` | paginated (`limit` ≤ 200, `offset`), `search`, `sort`, `direction` | Gated on `system.super_admin`, not `identity.users.view`: an inquiry row holds a visitor's name and email, and the legacy platform exposed it only through the administrator audit trail. Reports `mail.transport` so the UI cannot imply delivery. |

The two ledgers stay disjoint and a test asserts it: `GET /api/v1/system/routes` lists
**30** API routes and no document path; `app.documents()` lists **22** document routes and no
`/api/v1/*` path.

---

## 3. Generated documents and the PWA shell (F-09)

### 3.1 Icon set

| File | Size | Purpose | Bytes (this build) |
|---|---|---|---|
| `icons/icon-192.png` | 192×192 RGBA | `any` | 2 550 |
| `icons/icon-512.png` | 512×512 RGBA | `any` | 7 029 |
| `icons/maskable-512.png` | 512×512 RGBA | `maskable`, glyph scaled to 62 % inside the safe zone | 3 558 |
| `icons/apple-touch-icon.png` | 180×180 RGBA | iOS home screen, full-bleed | 1 473 |
| `icons/windels-mark.svg` | vector | favicon / `sizes: any` | unchanged |

Rendered by `tools/generate-icons.mjs` (3×3 supersampling, deterministic byte output, no
image dependency). `npm run check:icons` re-renders and compares, and `verify:install`
check 28 fails if the committed PNGs are not exactly what the generator produces — an icon
set that cannot be reproduced is an icon set nobody can audit.

### 3.2 Service worker policy

| Concern | Behaviour |
|---|---|
| Cache identity | `windels-shell-<sha256(shell files)[:16]>`; `activate` purges every other `windels-*` cache |
| Precache | `/`, `/styles.css`, `/site.js`, `/manifest.webmanifest` and the icon set (icons only when present on disk), hashed by `describeShell(publicDir)` |
| Never cached | `/api/`, `/uploads/`, `/private/`, `/data/`, `/service-worker.js`, `/contact/submit` — emitted as anchored regex literals (`/^\/api\//` …) and asserted in tests by re-deriving the same literals, so the policy is data, not prose |
| Navigations | Network-first; on failure, the cached `/app/` shell for `/app/*` and `/` otherwise — an offline visit shows the shell, never stale data |
| Hashed build assets | `/assets/<name>-<hash>.<ext>` cache-first (immutable by construction) |
| Everything else | Stale-while-revalidate |
| Update flow | New worker installs, then `public/site.js` and the SPA's `UpdateBanner` offer **Reload / Not now** via `postMessage({type:"SKIP_WAITING"})`; `controllerchange` reloads once. A worker is never swapped under an open session without the visitor agreeing |
| Own registration | `cache-control: no-cache` so a host proxy cannot pin an old worker |

The legacy `windels-public-shell-v1` static cache name and its cache-first rule for unhashed
`/styles.css` + `/site.js` are gone: that combination could keep a visitor on an obsolete
shell indefinitely, which is exactly what F-09 described.

### 3.3 Metadata

One configured surface (`SITE_*`, `THEME_COLOR`, `ROBOTS`, `PUBLIC_BASE_URL`) drives the
title, title suffix, description, keywords, robots directive, canonical link, Open Graph
(`og:title/description/type/site_name/url/image`), `twitter:card`, `theme-color`, manifest
and sitemap. Values are validated in `src/config.js`, not in a template: `ROBOTS` accepts
only the four legacy vocabulary strings, `SITE_OG_IMAGE` must be an absolute URL and must be
`https:` in production, and with no canonical origin the `og:image` tag and the sitemap
`<loc>` entries are **omitted** rather than published as relative or invented URLs.

---

## 4. Contact intake

| Step | Behaviour |
|---|---|
| Validation | `name` 1–120, `email` ≤ 190 and format-checked, `message` 10–2 000. The legacy rejected with `Enter your name, a valid email, and a message of at least 10 characters.` — that exact string is `CONTACT_INVALID_MESSAGE`. |
| Truncation | The legacy silently truncated the stored message with `mb_substr(…, 0, 2000)`. The Node port **refuses** an over-long message with a field-level 400 instead of storing less than the visitor wrote. |
| Storage | `wf_contact_inquiries` (migration 004) with a 26-character ULID `reference`, `status='new'`, `handled_by`/`handled_at` for a future queue. |
| Fingerprint | `client_fingerprint` = HMAC-SHA256 of the client address keyed with `SESSION_SECRET`. A raw IP stored beside a name and an email address is more personal data than abuse review needs; the fingerprint still groups repeat submissions. |
| Audit | `CONTACT_INQUIRY` with `actorId: null`, `entityType: "site"`, and the same `name`/`email`/`message` detail the legacy entry carried, so an operator can answer from the audit trail alone. |
| Mail | `mail.sent: false` plus the reason. No transport exists; the response never implies a delivery that did not happen. The legacy `tryMail()` is documented as deferred, not replaced. |
| Throttle | Per client address, 3 per hour by default, `429` + `Retry-After`; cross-site submissions are refused by the origin/CSRF check (asserted by test). |
| No-script path | `POST /contact/submit` → `303 /contact` with the signed `wf_flash` cookie. A page carrying a flash renders `cache-control: no-store` with **no ETag**, so a shared cache can never serve one visitor's notice to another, and every render re-issues the `Max-Age=0` clearing cookie. |
| Admin read | `GET /api/v1/admin/inquiries` (`system.super_admin`) and the SPA view at `/app/admin/inquiries`. |

---

## 5. Deliberate divergences from the legacy behaviour

Each of these is a decision, recorded here rather than discovered later by a diff.

| # | Legacy | Node | Why |
|---|---|---|---|
| 1 | `views/partials/chat_widget.php` + `assets/js/aegis-chat.js` render a public chat assistant on every page | **Not ported.** `publicSite` is reported `partial` in `/api/v1/system/status` | The assistant belongs to the chat module (`Api_chat`, `Aegis\ChatAssistant`), which has its own provider contract, grounding rules and RBAC. Shipping the widget without the module would advertise a capability this platform does not have |
| 2 | `announcement_bar.php` defaults to three messages, one advertising "the AI Language Teacher" | Banner renders only from `SITE_ANNOUNCEMENT`; **empty by default** | Language learning is not ported. A default banner claiming it would be a false statement on every page |
| 3 | Success flash: "…If outbound mail is configured, a copy was sent to the site operator." | "Thank you. Your message was recorded. No outbound mail is configured on this platform, so nothing was emailed." | There is no mail transport; the legacy sentence is conditional in wording but reads as a delivery promise. The rejection text is kept verbatim because it is accurate |
| 4 | `sitemap.xml` lists 10 paths including `/login` and `/register` | 8 paths | Both now 302 into `/app/`, which `robots.txt` disallows. Advertising a redirect into a disallowed area is how crawlers waste budget and how duplicate URLs appear |
| 5 | `robots.txt` disallows 6 prefixes | the same 6 plus `/uploads/`, `/private/`, `/data/` | Those prefixes exist only in the Node target (avatar storage, private files, adapter data) and must never be crawled |
| 6 | Header swaps Login/Get-started for "My workspace" when a session exists | One static header for every visitor, with a permanent "Open workspace" entry | Public pages carry an ETag and are cacheable; varying them per session would break shared caching and leak session state into the cache key. The legacy `$user` branch is the only page-level behaviour not reproduced |
| 7 | `og:image` defaults to `/assets/images/windels-mark.png`; favicon is that PNG; `<img onerror=…>` fallback in the brand | SVG mark + generated PNGs at `/icons/*`; no inline handler | Inline `onerror` is refused by the production CSP (`script-src 'self'`). The generated icon set is real PNGs at install sizes, which the single legacy SVG was not |
| 8 | `/forgot-password` renders a form (`auth/forgot`) | 302 to `/app/login` | Password-reset delivery needs a mail transport and a single-use token store; neither exists. A form that cannot send mail is worse than a redirect |
| 9 | Sitemap `<loc>` values are `$base . $path` (relative when `VP_BASE_URL` is empty) | No `<loc>` entries without a canonical base, plus an explanatory comment | Relative `<loc>` is invalid per the sitemap protocol |
| 10 | Message over 2 000 characters is truncated on store | 400 with a field-level issue | Silent truncation stores something the visitor did not write |
| 11 | `robots` meta defaults to `index,follow` (no space) | Vocabulary normalized to `index, follow`, validated against the four legacy values | Equivalent to crawlers; the validated form keeps the config surface honest |

---

## 6. Defects found and closed while porting

Bugs the tests exposed, not pre-existing code that was tidied:

1. **`POST /contact/submit` answered 404 instead of 303.** `handleDocument()` had an
   unconditional "non-GET methods are not documents" branch that swallowed declared POST
   document routes. The branch is now conditional on `allowed.length === 0`, and the three
   POST semantics are pinned by tests: unknown path + non-GET → **404**; a real static file +
   non-GET → **405** with `Allow: GET, HEAD`; a declared document route + wrong verb → **405**
   with its own methods.
2. **The generated service worker was syntactically invalid.** `neverCachePatternLiteral()`
   escaped `[.*+?^${}()|[\]\\]` but not `/`, so the emitted literal was `/^/api//` —
   "Invalid regular expression flags" the moment a browser parsed it. `/` is now escaped, and
   the test compiles the generated source (`new Function(src)`) instead of only reading it:
   a worker that cannot parse is a worker that cannot update, and no assertion caught that
   until it was executed.
3. **`clientFingerprint` was written but never read back.** `recordContactInquiry` stored the
   fingerprint; `pageContactInquiries` (file adapter) and the MySQL `SELECT`/row mapper both
   omitted it, so the admin listing could not show or group by it. Both adapters now surface it
   and the test asserts a 64-hex value end to end.
4. **Home-page cards had drifted from the legacy headings.** The ported `cards` block used
   paraphrased titles; the heading-parity test compares against `views/site/home.php` and
   failed. The eight legacy titles are restored (AI Workforce, AI Assistant, AI Conversations,
   Language Learning, Translation, Voice / Pronunciation, Speaking Practice, Productivity).
5. **A permission test asserted a user the file adapter never seeds.** The harness seeds only
   `rootadmin`; the 403 case now creates its own member through `store.createUser` +
   `bcrypt.hash`, so it tests the permission and not the fixture.
6. **The flash "consumed once" claim was not assertable as written.** Replaying the same
   cookie bytes server-side re-renders the notice harmlessly — one-shot-ness is a *browser*
   property, delivered by re-issuing `Max-Age=0` on every render. The test now asserts that
   real property instead of a fake one.

---

## 7. SPA slice (`client/`)

Phase 3 makes `/login` and `/register` redirect into `/app/`, so the SPA had to be able to
receive them. It previously had one view (a sign-in panel) and an untyped `fetch` wrapper.

| File | What it does |
|---|---|
| `src/api.js` | `ApiError {status, code, message, details, retryAfter}` with `isAuthFailure`, `isPermissionFailure` and `fieldMessage(field)`; CSRF token attached to every unsafe method; one `setUnauthorizedHandler` so a 401 from any view clears the session once; `endpoints` maps the ported API surface |
| `src/router.jsx` | History-API router: exact declared paths only (a wildcard would let an undeclared URL look intentional), intercepted `<Link>`, back/forward, `replace` navigation |
| `src/ui.jsx` | `useResource` (loading/ready/error + retry), `StateBox` for the four states, `Notice`, `Field`, `PermissionTag`, `ConnectivityBanner` (online/offline), `UpdateBanner` (the F-09 waiting-worker prompt in React) |
| `src/views.jsx` | `LoginPanel`, `RegisterPanel` (field-level errors from `details`), `WorkspaceNav` (permission-gated, locked entries shown rather than hidden), `ModuleCards`, `AccountView` (profile/username/email/password, sessions + revoke-others, activity, permissions), `AdminUsersView` (search/status filters, pagination, create + suspend/activate when `identity.users.manage`), `InquiriesView` (search, pagination, expandable rows, mail-transport notice), `StatusView` (runtime, readiness, trading state, per-module port status), `NotFoundView` |
| `src/App.jsx` | Session bootstrap (`/auth/me` + `/auth/csrf`), route guards, post-sign-in return to the requested path, sign-out, and the native-build preview path unchanged |

Guards are presentation only: every permission check runs server-side and answers 403
regardless of what the browser rendered, and the denial view says so and names the permission.
Styles for the new views were appended to `client/src/styles.css` (no new dependency, no CSS
framework).

Build evidence (Vite 8.3.2, React 19.3.0, `npm ci` then `npm run build` in `client/`):
**20 modules transformed**, `public/app/assets/index-*.js` **265.27 kB (79.47 kB gzip)**,
`index-*.css` **18.12 kB (4.82 kB gzip)**, `index.html` 0.68 kB, `asset-manifest.json` 0.18 kB,
exit 0. Output stays git-ignored; `verify:install` check 30 asserts the built bundle references
only files that exist.

---

## 8. Security review of the new surface

| Control | Implementation |
|---|---|
| Injection | Every value reaching HTML goes through the escaping `tag()` builder; the sitemap XML escapes with the same discipline; no `innerHTML` with server data in `public/site.js` |
| CSP | `script-src 'self'; style-src 'self'` — a test asserts rendered pages contain no inline script, no inline style attribute and no inline handler |
| Cache poisoning | Public pages: `no-cache` + weak ETag. Flash-bearing pages: `no-store`, no ETag. `/service-worker.js`: `no-cache`. Private/API/upload paths: never cached by the worker |
| Cross-site writes | `POST /contact/submit` and `POST /api/v1/site/contact` are origin-checked; the flash cookie is `SameSite=Strict` and HMAC-signed, so a forged notice renders nothing |
| Abuse | Per-address contact throttle (3/hour default) plus the general API limit; `MAX_REQUESTS_PER_CLIENT` bounds concurrent in-flight requests per address (429 + `Retry-After: 1`) — a windowed counter limits rate, this stops one address holding hundreds of slow connections |
| Personal data | No raw client IP stored; HMAC fingerprint instead. Inquiry rows readable only by `system.super_admin`; the listing is paginated and bounded (`limit` ≤ 200) |
| Storage failure | No adapter → `503` + `Retry-After: 30`, never a `200` that implies a message was recorded |
| Secrets | `SESSION_SECRET` is required for the flash signature and the fingerprint key; no new secret was introduced |

---

## 9. Test and rehearsal evidence (this sandbox, 2026-10-09)

```
cd apps/workforce-platform
npm run verify:install     # 30/30 installation checks passed
npm run check:icons        # 4/4 icons verified (re-rendered and compared)
npm test                   # node --test test/*.test.js → 103 pass, 0 fail (22.6 s, 12 test files)
cd client && npm ci && npm run build   # 20 modules, exit 0

cd /home/user/ai           # repo root
node runtime/run-tests.mjs # 367 passed, 0 failed (legacy PHP oracle on WASM PHP 8.2, 19.3 s)
npm run test:contracts     # 12 passed, 0 failed (Scout + shared)
npm test --workspace=windels-football-predictions   # 29 passed, 0 failed
```

**Total executed here: 511 passed, 0 failed.**

One reproduction trap worth recording: `npm ci` inside `client/`, `runtime/` or
`apps/football-predictions/` prunes packages hoisted into the root `node_modules` — it removed
`bcryptjs` mid-phase and the app suite then failed with `ERR_MODULE_NOT_FOUND` (24 passed,
9 failed). `npm install --no-package-lock` at the repository root restores the tree without
touching `package-lock.json`; `npm run check` was then re-run to 30/30 and 103/103. Not re-run this phase, and therefore not claimed: the
MT5-bridge `pytest` suite (9 tests; it needs its own Python 3.11 virtual environment and
nothing it covers changed) and the strict TypeScript typecheck (`typescript` is not installed
in this sandbox's root tree, so `npm run typecheck` cannot execute here). Both were green at
the earlier recorded measurements.

`test/site.test.js` (18 new tests) reads the legacy PHP as its oracle:

| Test | Pins |
|---|---|
| F-10 every legacy public route is answered | pages render, aliases redirect, SEO documents generate — the legacy route file is parsed, not retyped |
| F-10 navigation and footer mirror the legacy layout | 8-entry nav, footer columns, and the inventory drives nav + sitemap + routes from one list |
| F-10 page copy is ported heading for heading | `h1`–`h3` compared against `views/site/*.php` with entities decoded |
| F-10 robots.txt keeps every legacy disallow rule | plus the three Node-only private prefixes |
| F-10 the sitemap lists marketing pages only | refuses to advertise the disallowed workspace |
| F-10 metadata comes from one configured surface | canonical, robots, Open Graph, theme colour |
| manifest is generated | PNG icon set with a maskable entry, workspace `start_url`, configured colours |
| F-09 the icon set is real PNGs | sizes install prompts require, reproducible from the generator |
| F-09 the service worker is generated | versioned by shell content; its never-cache policy is data and the emitted source parses |
| contact intake stores, audits and reports mail honestly | reference, audit action, `mail.sent:false` |
| contact intake throttles per client and refuses cross-site submissions | 429 + `Retry-After`, origin refusal |
| the no-script form path redirects with a signed flash | 303, `no-store`, cleared cookie, forged signature renders nothing |
| the administrator inquiry listing is super-admin only and paginated | 401/403 boundaries, bounded `limit` |
| unknown paths answer a rendered 404 for browsers and JSON for machines | content negotiation |
| F-13 the concurrency ceiling refuses parallel slow requests | `TOO_MANY_CONCURRENT_REQUESTS` + `Retry-After: 1` |
| the generated documents never leak into the JSON route ledger | the two ledgers are disjoint |
| rendered pages carry no inline script or style | production CSP stays honest |
| the page content model rejects unknown block types | no silent rendering of an unmodelled block |

### Live rehearsal (file adapter, no database)

Server started with `STORAGE_ADAPTER=file`, `NODE_ENV=development`, a throwaway store under
`/tmp`, and `seed:platform --admin-username demo`; observed with `curl`:

| Check | Result |
|---|---|
| `/`, `/about`, `/services`, `/how-it-works`, `/locations`, `/safety`, `/faq`, `/contact` | 200 |
| `/coverage`, `/help`, `/how` | 301 → `/locations`, `/faq`, `/how-it-works` |
| `/login`, `/register` | 302 → `/app/login`, `/app/register` |
| `/robots.txt`, `/sitemap.xml`, `/manifest.webmanifest`, `/service-worker.js`, `/styles.css`, `/site.js`, `/icons/icon-192.png` | 200 |
| `/app/`, `/app/login`, `/app/register`, `/app/status`, `/app/account`, `/app/admin/users`, `/app/admin/inquiries` | 200 (SPA shell) |
| `POST /api/v1/site/contact` | 200, `reference 01M4F3015SXR3TXZ5RDWX9W0A8`, `mail.sent:false` |
| `POST /contact/submit` (urlencoded, no extra fields) | 303 → `/contact` with `wf_flash` |
| `POST /contact/submit` with an undeclared field | 400 (unknown fields are refused, not dropped) |
| `POST /api/v1/auth/login` (`demo`) | 200 + 14 permissions + `csrfToken` |
| `GET /api/v1/admin/inquiries` with that session | 200, 1 inquiry, 64-hex `clientFingerprint`, `mail.transport:"none"` |
| `GET /api/v1/admin/inquiries` anonymously | 401 |
| `GET /api/v1/system/routes` | 30 routes |
| generated service worker | `windels-shell-e982bce1f0447305`, 9 precache entries, 6 never-cache literals |

---

## 10. Findings after this phase

| ID | State | Note |
|---|---|---|
| **F-09** (PWA) | **Closed** | Real PNG icon set incl. maskable, content-versioned cache, hashed-asset cache-first, unhashed shell no longer cache-first, update prompt in both the vanilla site and the SPA, `no-cache` on the worker itself, offline banner. Not closed by assertion alone: the generated worker is compiled in the test |
| **F-10** (SEO/public site) | **Closed** | 8 pages + 9 aliases/redirects + 4 generated documents + contact intake, metadata from one validated config surface, sitemap and robots parity-tested against the PHP. `publicSite` still reports `partial` because of divergence #1 (chat widget) |
| **F-11** (supply chain) | Open | Unchanged; Scout-stack advisories only, workforce package reports none. Needs an approval-gated upgrade pass |
| **F-12** (lockfile/pinning) | Open — decision, not code | **The gate was not triggered:** Phase 3 added no package to any manifest (`dependencies` remain exactly `bcryptjs` + `mysql2`; the client's `devDependencies` are unchanged). Recommendation recorded for approval: per-package lockfiles, starting with `npm install --package-lock-only` inside `apps/workforce-platform/`, because a cPanel install runs per application directory and root hoisting is not available there |
| **F-13** (ops) | Mostly closed | `MAX_REQUESTS_PER_CLIENT` concurrency ceiling landed this phase (429 + `Retry-After`). Still open: pool-saturation metrics in `/health` |
| **F-14** (env docs) | Closed and still enforced | `.env.example` now documents **45** variables (the `SITE_*`, `CONTACT_*`, `THEME_COLOR`, `ROBOTS`, `MAX_REQUESTS_PER_CLIENT` additions included); `verify:install` check 25 fails if the config reads an undocumented variable |
| **F-15** (real MySQL) | **Open, cannot close here** | No MySQL server exists in this sandbox. Migration 004 and `src/db/site-repository.js` are unit-covered against a fake pool only; `wf_contact_inquiries` has never been created by a real server |
| **F-16** (deployment zip) | Open | Unchanged; a production action needing approval |
| **F-17** (documentation) | Closed | `BASELINE_TESTS.md` re-counted this phase (Phase 2 entry criterion 4) |
| **F-18** (two lead-discovery stacks) | Open by decision | Unchanged |

Phase 2's entry criteria for this phase, answered: **(1)** staging MySQL — *not available*, so
F-15 stays open and no import or cutover was attempted; **(2)** public-site inventory taken
from `ROUTE_MAP.md` §2 with each page's legacy data contract recorded — §2 above; **(3)** PWA
work landed with the public site — §3; **(4)** `BASELINE_TESTS.md` re-counted — done; the
lockfile decision was not triggered because no package was added, and the recommendation is
recorded under F-12.

---

## 11. cPanel notes for this phase

- **No new runtime dependency.** `dependencies` are still exactly `bcryptjs` and `mysql2`;
  everything added (PNG encoding, CRC32, ULID, manifest, worker, sitemap) is `node:*` plus
  project code, so the Passenger install step is unchanged.
- **Migration 004 must run before the public contact form is used on MySQL.** `npm run
  migrate:dry-run` then `npm run migrate`; `readiness()` reports `schema:false` until all four
  migrations are applied, and `/api/v1/health/ready` stays 503 — the form then answers 503 with
  `Retry-After` rather than pretending to record.
- **Build the client before deploy** (`npm run build:client`). `public/app/` is generated and
  git-ignored; without it the SPA routes serve a shell with no bundle. `verify:install` check 30
  catches a bundle that references missing files.
- **`npm run check:icons` after any upload.** If a host's file manager mangles the PNGs, the
  icons no longer match the generator and the check fails loudly.
- **Do not re-add static `index.html`, `robots.txt`, `sitemap.xml`, `manifest.webmanifest` or
  `service-worker.js` to `public/`.** `verify:install` check 29 fails the install if they exist;
  an Apache `DirectoryIndex` or a `.htaccess` rewrite that serves them ahead of the app would
  publish stale documents.
- **Set `PUBLIC_BASE_URL`** (and optionally `SITE_OG_IMAGE`) in production: without it the
  sitemap publishes no URLs, `robots.txt` carries no `Sitemap:` line and `og:image` is omitted.
- **`MAX_REQUESTS_PER_CLIENT`** is worth setting deliberately on shared hosting (it is `0`,
  disabled, by default); Passenger limits concurrency per process, and this bounds one address
  inside it.

---

## 12. What was **not** exercised

Stated plainly, because an untested claim is how a migration fails in production:

- No MySQL/MariaDB server: migration 004 was never applied by a real server, and the inquiry
  SQL was never executed against one (F-15).
- No cPanel/Passenger host, no Apache reverse proxy, no `.htaccess` interaction, no cron.
- No real browser: no Lighthouse/PWA install prompt, no manual service-worker update
  observation. The worker's *source* is compiled in a test; its runtime behaviour in Chrome is
  not measured here.
- No outbound mail, no SMTP, no delivery of a contact message.
- No mobile SDK build, signing or store artefact; native sign-in remains disabled.
- No production data, no traffic, no cutover, no deletion of legacy code.

---

## 13. Entry criteria for the next phase

1. A staging MySQL host (or an approved container) so F-15 can close: apply migrations
   001–004, prove the file→MySQL switch under `STORAGE_ADAPTER=auto`, run `verify:data`,
   `backup`/`restore`, and exercise the identity importer's dry run.
2. The F-12 lockfile decision, taken explicitly, before any package is added anywhere.
3. Module order for the next port, from `UNFINISHED_MODULES.md` and the master plan §11
   dependency review — market data and provider health first, since analysis, strategies and
   paper trading all consume it. Its acceptance gates are the plan's §10 list, and its honesty
   rules (real / synthetic / sandbox / unavailable / planned) are already modelled by the
   status surface ported here.
4. Outbound mail: a decision on transport (cPanel SMTP vs an approved API) before password
   reset, contact-notification delivery or any email-backed flow is ported. Until then every
   response says no mail was sent.
