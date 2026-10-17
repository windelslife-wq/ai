# Phase 48 — Sports stake sizing (row 14, slice 6; DV-27)

> Completes the sports module's last not-ported area. The previous record is
> [`PHASE47_PASSWORD_RESET_AND_ADMIN_SYNC.md`](PHASE47_PASSWORD_RESET_AND_ADMIN_SYNC.md);
> the module ledger entry point is [`STATUS.md`](STATUS.md). This phase ports **no**
> legacy class: legacy has no sizing engine — `TicketGovernance::record` copies the
> configured fixed `stake_amount` onto each ticket, and that is what the port already
> did. What this phase adds, as an explicit and bounded divergence, is the sizing
 *engine* the backlog named "not ported, no slice owns it".

## 1. What is ported, and the decision behind it

The user decided on 2026-10-17 (see §9): build the bounded opt-in sizing engine rather
than declaring parity-by-absence. The result:

- **`src/modules/sports/stake-sizing.js`** — a pure, deterministic sizing engine with
  two methods. `FLAT` (the default) returns the configured fixed stake unchanged,
  byte-identical to legacy. `CONFIDENCE_SCALED` multiplies the flat stake by three
  documented factors — confidence (`(confidence − min_confidence) / max(1, 100 −
  min_confidence)`, clamped to a 0.1 floor and 1), risk (LOW 1 / MEDIUM 0.5 / HIGH
  0.25) and correlation (same table) — and can therefore **only size down** from the
  configured stake. Every unknown classification maps to the HIGH factor, a missing
  confidence to the floor, an unknown method to `FLAT`, and a non-positive or
  non-numeric `stake_amount` to a **null** stake: a refusal to size, not zero, and
  never an exception at ticket time. Rounding is `phpRound` (two decimals for the
  stake, four for the reported factors).
- **`staking_method` on the versioned configuration** (migration
  `022_sports_stake_sizing.sql`): `ALTER TABLE wf_sports_configurations ADD COLUMN
  staking_method VARCHAR(24) NOT NULL DEFAULT 'FLAT' AFTER stake_amount`. The
  configuration is append-only, and the default means every row written before the
  migration keeps the only behaviour legacy ever had. The column is added to
  `REQUIRED_MIGRATIONS` because the configuration INSERT names it — a host without it
  must fail readiness, not the write (the same reasoning the readiness list's own
  comments record).
- **No new table, no breakdown column.** The ticket stores the sized stake in the
  existing `stake` column, settlement already computes P/L on it, and the breakdown is
  reconstructible from the ticket (confidence, risk, correlation) and its stored
  configuration version — the daily-run HTTP test re-derives the stored stake exactly
  from the stored ticket to prove it. The breakdown itself travels in the run's return
  (`stakeSizing`) and in `sports.daily_ticket.run`'s audit event details.
- **`buildTicket`** returns the sizing as a third key (`ticket`, `selections`,
  `sizing`); the repositories destructure the first two, so the breakdown can never
  become storage by accident. Record-only is unchanged: nothing in the sports module
  reaches a paper, execution or broker path, and no test was added that could.

## 2. Divergence DV-27

**The port adds a bounded, record-only sizing engine legacy does not have, under a
versioned configuration key legacy does not know.** The default value — and the value
the DDL supplies to every historical row — is exactly legacy's behaviour, so the
divergence is opt-in and reconstructible, not silent. Legacy's own list discipline
applies to it: it is recorded here, in the module docblocks, in the ledger label, and
in the §9 decisions. Legacy PHP is unchanged (the oracle below proves it), so if a
cutover ever wants legacy's exact write, the `FLAT` configuration reproduces it.

One deliberate interaction with the PHP-parity golden: `defaultConfiguration()` gains
the key, but the golden's fixture is generated from PHP and must stay byte-identical to
legacy. The parity test therefore exempts the key from the defaults comparison and
asserts it is `FLAT` — an exemption with a reason, asserted, not a silent edit. The
validator treats an **absent** key as valid (every read path supplies the default), so
the golden's validation cases — which carry only legacy's keys — stay meaningful on
both sides; a **present** key must be valid.

## 3. The ledger moves

The sports status matrix (`status.notPorted`, surfaced by `/api/v1/sports/status` and
`/system/status`'s snapshot) is now **empty**, and every consumer was updated the same
way — removal, never re-labelling:

- `MODULE_STATUS`: `sports` is `ported` (**15 ported / 2 partial / 0 not-ported**). The
  label keeps the boundary as prose — nothing is executed, no stored result is trusted
  before a person attests to it, no provider is verified against a vendor — and states
  the port, its bound, its divergence number and its migration, because
  "sports intelligence: ported" otherwise reads as "a betting engine that runs".
- The module's own status message (the configured+store branch) states the same facts
  and names `staking_method`; the providerless message is unchanged byte-for-byte.
- The console's residual list (`SPORTS_RESIDUAL`, `/app/sports` boundary panel) drops
  the "no stake is sized" sentence and states instead that sizing is record-only and
  bounded, with no bankroll to size against because nothing is executed.
- The emptiness is pinned in `test/sports_http.test.js`, so a future "not ported"
  entry arrives as a conscious test change.

## 4. Tests

| File | New/updated | What it pins |
|---|---|---|
| `test/sports_stake_sizing.test.js` | **12 new** (1215 → 1227 file-level tests; suite total 1239 vs 1227 before) | FLAT parity incl. absent/unknown methods; null-stake failure mode; the exact factor arithmetic at every documented point plus the floor; the can-never-exceed-flat-stake sweep over the whole factor space; unknown-classification conservatism; `min_confidence: 100` cannot divide by zero; `phpRound` half-away-from-zero; configuration validation and versioning of the new key; the SQL INSERT naming the column with 24 bound parameters and both readers defaulting an absent key to FLAT; the configuration PATCH accepting/refusing like legacy's enums; the end-to-end daily run under both methods with the stored stake re-derived from the stored ticket; `buildTicket`'s three-key shape. |
| `test/sports_intelligence_parity.test.js` | updated | The defaults comparison exempts `staking_method`, asserts it is `FLAT`, and stays byte-identical to PHP elsewhere. |
| `test/sports.test.js` / `sports_http.test.js` / `client_sports_console.test.js` | updated | The empty matrix, its prose, and its removal-by-Phase-48 rationale; the providerless branches unchanged. |
| `test/platform_findings.test.js` / `client_dashboard.test.js` | updated | The ledger: `sports` `ported`, 15 ported / 2 partial / 0 not-ported, with the label pinned to name DV-27, the bound, and the default. |
| `test/migrator.test.js` / `store.test.js` | updated | The last-migration pin is `022` and readiness requires it. |

**Full suite: 1239/1239.** `node runtime/run-tests.mjs` (the PHP oracle): **367/367,
unchanged** — no PHP file was edited. `npm run verify:install`: **30/30**, including
the required-migration disk check that now lists `022_sports_stake_sizing.sql`.

## 5. What this slice does not claim

- **Nothing is executed.** A sized stake is a record; settlement settles the record.
  There is no bookmaker connector, no order path, no paper/trading endpoint involved,
  and the engine itself is one pure function over configuration and stored ticket
  numbers.
- **No bankroll- or edge-based sizing.** There is no bankroll in this deployment —
  sizing multiplies the *configured* stake, never an account. That remains true on
  purpose, and the residual sentences on the console say so.
- **No migration execution.** `022` is validated statically (migrator, readiness,
  INSERT-shape tests) exactly as migrations 011–021 were; real MySQL/MariaDB
  application of 001–022 is still F-15 host verification, not this phase's claim.
- **No sizing on historical tickets.** Rows written before this phase hold the stakes
  they hold; only new tickets are sized. The configuration version on each ticket is
  what makes the audit trail complete either way.
- **No live-provider or real-vendor verification**, and no change to the sports
  trust boundary: results are attested by a person (`sports.settle`), and no stored
  result is trusted before that.

## 6. Rollout on the real host

1. `npm run migrate` applies `022_sports_stake_sizing.sql`; readiness requires it, so
   an un-migrated host reports an incomplete schema rather than failing a write.
2. Existing configurations read `staking_method: "FLAT"` (the DDL default); behaviour
   is byte-identical to before the phase until an operator patches the configuration.
3. Opting in is one audited, versioned configuration change:
   `PATCH /api/v1/sports/configuration {"staking_method": "CONFIDENCE_SCALED",
   "reason": "…"}`.

## 9. Decisions

**Decided by the user (2026-10-17):**

1. **Build the bounded opt-in sizing engine** (this phase) rather than declaring the
   matrix entry parity-by-absence. The engine is bounded (mono-down from the flat
   stake), record-only (no execution path), audited (breakdown in the run's audit
   event) and configurable (versioned `staking_method`, default `FLAT`).
2. **Order of work:** ledger order — sports stake sizing first, then notification
   outbound delivery (row 5), then analysis per-route limits (R-26), then reassess.
3. The two questions the divergence raises were answered inside those decisions:
   caps-by-construction (factors ≤ 1) rather than a separate exposure check, and no
   breakdown column (the ticket + configuration version is the breakdown's storage).
