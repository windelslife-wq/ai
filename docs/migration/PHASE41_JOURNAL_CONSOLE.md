# Phase 41 — the journal console (row 18), and F-29 closed

**Status:** complete · 2026-10-17 · branch `arena/046b29ac-ai`

`/app/journal` is the port of `Journal::index` → `views/journal/index.php` (96 lines): the five group
switches, the six overall figures with their per-group table, the newest 200 entries and the
confidence-calibration meters, drawn over the three journal reads the strategies module has served
since Phase 6. With it **row 18 has no screen left**, and **F-29's screen list is empty**: every
legacy view that had no SPA counterpart after the Phase 33 audit now has one.

This is the quietest console in the series — the module was already ported and tested (Phase 6), the
page is a read, and the analytics are the server's. The work was in *not* introducing drift:

1. **The figures are the endpoint's, formatted as the PHP formatted them.** `journalNumber`,
   `journalPercent` and `journalCount` reproduce `number_format`'s fixed decimals and thousands
   separators; the six overall cells use the PHP's own precision (1 / 2 / 0 / 2 / 1 / 0 decimals),
   the group table uses 0 decimals for `Win%`, and the entries table uses 5 for prices, 1 for P&L,
   2 for R and 0 for confidence. Nothing is recomputed in the browser — the screen and the endpoint
   cannot disagree about a number.
2. **The page is a read, and says what it does not draw.** All three reads are session-only, as
   `Journal`'s `App_Controller` and `Api_journal`'s `Api_controller` were. `POST /api/v1/journal/manual`
   is the module's one human write; it is listed beside the reads with its CSRF requirement and
   marked **not drawn**, because legacy's page drew no form for it either and a console that invents
   one stops being the page it ports.
3. **The gaps are stated.** Two divergences sit on the page rather than in a diff: the group switch
   is in-page state (this shell's router matches exact paths and carries no query string, so
   legacy's `?groupBy=` links cannot be reproduced), and the summary endpoint reads 500 rows while
   the table lists 200, so the overall panel can describe trades the table does not show.

## Scope

| | |
|---|---|
| Legacy | `views/journal/index.php` (96 L), `controllers/Journal.php` (35 L — `index` and `statusView`), `controllers/Api_journal.php` (90 L), `libraries/Aegis/Journal/Analytics.php` (126 L, ported instruction-for-instruction in Phase 6 as `journal-analytics.js`) |
| Node routes used (all already present) | `GET /api/v1/journal`, `GET /api/v1/journal/analytics/summary`, `GET /api/v1/journal/analytics/calibration` — **all session-only, no permission** — plus the documented, undrawn `POST /api/v1/journal/manual` (session + CSRF) |
| New files | `client/src/journal.js` (306 L), `test/client_journal_console.test.js` (17 tests, 526 L), this record |
| Edited (client) | `client/src/views.jsx` (`JournalView`, its import block, the nav entry), `client/src/api.js` (three wrappers), `client/src/App.jsx` (route + view map), `client/src/styles.css` (`.journal-*`, one responsive rule), `client/src/dashboard.js` — **`PANEL_FEET.activity` is legacy's again**: `View analytics` → `/app/journal` |
| Edited (server) | `src/modules/platform/health.js` — the `strategies` label names the console, its two divergences and the undrawn write; the `execution` label's F-29 clause now ends "brokers left that list in Phase 40 and the journal in Phase 41, so F-29's screen list is empty". **No route, contract, service, migration, repository method, permission or dependency** |
| Edited (tests) | `test/client_dashboard.test.js` — `/app/journal` joins F-29's landed list, and the activity foot is asserted in legacy's words with `note: null` |

The route inventory is **146 before and after**: this phase added a screen over routes that already
existed, and the module's one write predates it.

## The screen

- **The five switches** are `JOURNAL_GROUPS` in the view's `foreach` order — strategy, symbol,
  market, source, confidence — which is *not* the order `GROUP_KEYS` validates in. The suite compares
  the sets and pins the view's order separately, because a reordering would change the page and not
  the API.
- **The overall panel** is `Overall (N closed trades)` with N from the summary's `overall.closedTrades`,
  then the six figures: win rate (`66.3%`), profit factor (`1.80`), total P&L (signed), average R,
  expectancy and max drawdown (`warn`, as the PHP's `.warn`). A missing aggregate is `—`; a real
  zero is `0`. `totalPnl` is the one figure legacy rounds to zero rather than null on an empty book,
  and the screen keeps that asymmetry.
- **The group table** carries the raw group key as its first header — legacy echoed `e($groupBy)` —
  then trades, win %, profit factor, E[P&L] and total P&L, each with legacy's signed colouring. The
  summary's own `note` (the confidence grouping's "no tagged trades" sentence) renders beneath it in
  the page's warn colour.
- **The entries table** keeps legacy's eleven columns: the ISO minute (16 characters, `T` included),
  a source badge in the PHP's colours (backtest sky, paper violet, manual gray, live red), symbol,
  a ▲/▼ direction glyph, strategy, entry price at five decimals, exit price or **open**, P&L, R,
  confidence and the reason with its full text in the cell's `title`. The empty state is legacy's
  sentence, and it is conditional — a populated table never renders beside it (the D-24 shape).
- **The calibration panel** shows the server's verdict in a green or amber notice according to
  `sufficientData` (legacy's `ok`/`warnbox`), then one meter per bucket: the bucket's own en-dash
  key and `N trades · win X% · E[R] Y`, over a bar at `round(winRate * 100)` percent in legacy's
  exact green (`#34d399`) above 50 % and red (`#fb7185`) below. With no tagged trades the panel
  shows legacy's empty sentence and no fabricated zero-width meter.
- **The reads panel** lists the three reads with their windows and the word `session` where another
  console would print a permission, then the manual write marked `not drawn`, then the sentences
  that explain the manual route, the two divergences and row 18's remaining surface.

## Divergences, stated rather than discovered

- **The group switch is not a URL.** Legacy's page had five bookmarkable links; this router has no
  query string, so they are buttons with `aria-pressed` and the page says the address bar does not
  change. The alternative — five exact-path routes — would have declared four screens the parity
  ledger does not have.
- **200 rows on screen, 500 in the summary.** `Journal::index` analysed the 200 rows it displayed;
  `GET /journal/analytics/summary` reads 500 (the legacy *API's* own bound, ported in Phase 6). The
  screen uses the endpoint and states the difference, so the heading's count can exceed the table's
  row count. The alternative was a second analytics implementation in the browser, which is exactly
  how two numbers start disagreeing.
- **The legacy `open` is inside a PHP ternary.** The copy suite asserts it against the raw source
  rather than the tag-stripped text, because `<[^>]+>` removes the whole `<?= … : 'open' ?>` tag.
- **DV-5 is inherited, not fixed.** `analyze` orders closed trades by `execution_time` as text (the
  legacy behaviour, ported deliberately in Phase 6). Manual entries written by this platform store
  canonical UTC, so they sort correctly; rows imported from legacy may not, and `maxDrawdownAbs` can
  depend on write order. The screen cannot correct that without changing the analytics, so it is
  stated in Phase 6's record and left alone.

## Row 18 after this phase

The row's remaining item is not a screen: the **public chat assistant** (`Api_chat::respond` →
`Aegis\ChatAssistant`, rendered by `views/partials/chat_widget.php`) has no Node port, and
`publicSite` reports `partial` for it. The legacy CLI `tools` commands map to the platform's npm
commands — `migrate`, `seed:platform`, `test`, `jobs`, `sports:jobs`, `lottery:jobs` — and `Tools`'
`AEGIS_ALLOW_HTTP_TOOLS` guard has nothing to guard here because no tool route exists. Both facts
are on the screen's reads panel and in `UNFINISHED_MODULES.md` row 18, so a reader does not have to
infer the row is finished from a console that is.

## Tests

`test/client_journal_console.test.js` — **17 tests**, hermetic (file adapter,
`MARKET_DATA_REAL_PROVIDERS=0`, no network). Six of them drive the real app over HTTP:

- copy: every `JOURNAL_COPY` string is asserted inside `views/journal/index.php` (markup- and
  entity-insensitive, with `open` read raw because it lives in a PHP tag); the five switch labels and
  the keys of the page's `foreach`; the eleven entry headers (some carry `class="num"`, so the label
  is what is compared); the two empty states. Every `JOURNAL_PORT_COPY` sentence is asserted **not**
  to appear in the PHP, so the port's claims stay its own;
- vocabularies: the five keys are the server's `GROUP_KEYS` as a set, with the page's own order
  pinned; windows agree with `JOURNAL_LIMIT_DEFAULT`, `JOURNAL_LIMIT_MAX` and the service's private
  `JOURNAL_SUMMARY_LIMIT = 500` (read from the source rather than guessed);
- formatting: thousands separators, fixed decimals, `—` for a gap, `0` for a real zero, signed tones
  with legacy's `?? 0` behaviour, the 16-character time slice, the source badge map and its neutral
  fallback;
- the panels: the six overall cells with their tones and the interpolated heading; the group rows;
  the entries rows (open exits, null strategies, a zero P&L that stays printed); the calibration
  bucket text, widths (clamped to the track), tones and the server's verdict read through
  `sufficientData`;
- routes: all four journal routes are in `/api/v1/system/routes` with `auth: true` and
  `permission: null`, `/api/v1/analytics/*` does not exist (DV-8), and the manual route is
  CSRF-gated (`403 CSRF_INVALID` with a cookie and no token);
- live: a signed-in account with **no permissions** reads all three surfaces; seeded rows flow into
  the table, the summary's groups, the confidence buckets and the small-sample verdict; an invalid
  grouping is 400; the "no tagged trades" note is exercised on a second store with its own session;
- declaration: the route is `requiresAuth` with **no permission**, the nav entry is `permission: null`,
  the view issues no write verb, the switch is state and not a `?groupBy=` link, and the reads panel
  names the undrawn write;
- the dashboard foot, the served shell and the built bundle's strings.

## Gates

- `npm run check:workforce` → **1181 / 1181** (1164 before: +17 console tests).
- The client suites together → **204 / 204** (187 + 17).
- `npm run typecheck` → clean; `npm run test:contracts` → 12/12.
- `npm run build:workforce-client` → `index-DqanVWU-.js` 587.69 kB / 156.25 kB gzip,
  `index-CkPGdTlp.css` 47.51 kB / 9.88 kB gzip.
- `npm run verify:install -- --require-bundle` → **30 / 30**.
- Live probe on a demo host reseeded from scratch (`:4020`, file store, admin `root`): **33 / 33** —
  anonymous 401; an empty journal, summary and calibration with legacy's exact small-sample
  sentence; an invalid grouping's 400; the manual write refused without CSRF (403) and recorded with
  it (201), with `pnl` and `r_multiple` derived rather than trusted; the listing, the strategy group
  and the top confidence bucket reading that row; an ordinary member with **no** journal permission
  reading all three surfaces; `/app/journal` serving the shell and the bundle carrying the page's
  strings, the dashboard foot's `View analytics` and the route; **146** routes, four journal routes
  all session-only, and no `/api/v1/analytics` alias. The probe left one `manual` EURUSD row
  ("Phase 41 probe row") and one ordinary member (`journalmember`) in the demo store.
- **Not run:** a real browser (no rendering, no click-through of the switches), real MySQL/MariaDB
  (F-15), any live provider, SMTP, cPanel/Passenger, and still no PHP↔Node numeric diff (F-26) —
  though the journal analytics themselves were compared to the PHP oracle in Phase 6, on both sides
  of the port.

## After this phase

**F-29 is closed.** The finding tracked seven screens after the Phase 33 audit — paper, risk,
execution, brokers, journal, sports and the admin control centre — and all seven are now declared
routes reached by the shared shell. Two notes belong with the closure rather than after it: the
unported modules' own views (`views/leads/`, `views/langlearn/*`) were always rows 16–17's
workstreams rather than this finding's, and the public chat assistant's floating window
(`views/partials/chat_widget.php`) is row 18's remaining *surface*, not one of the five consoles
F-29 counted.

Module counts are unchanged — **10 ported / 5 partial / 2 not-ported**: the journal is part of the
`strategies` module, which was already `ported`.

What row 18 still carries: the chat assistant; and the host-level items that were never its (a real
crontab, live providers). What the platform still carries platform-wide, unchanged: row 5's retention
and outbound-delivery decisions, row 18's chat assistant, the host gates (real MySQL/MariaDB,
cron, cPanel/Passenger, live providers, SMTP, official feeds) and the numeric PHP↔Node diff (F-26).
