# Phase 26 — File-adapter atomicity: R-30 closed, F-46 found

> **Status: landed on `arena/653d6218-ai`.** A cross-cutting durability change, not a module slice:
> the file adapter's aggregate writes are now single-record atomic, closing risk **R-30** — and the
> work surfaced **F-46**, a latent draw-numbers delete bug of the same family the lottery cron's
> cleanup fix (Phase 25) found in the job-run table. The previous record is
> [`PHASE25_LOTTERY_CRON.md`](PHASE25_LOTTERY_CRON.md).

## 1. The mechanism

The file adapter is a write-ahead log replayed line by line: a parsed line applies whole, a torn
trailing line is discarded whole. `withPaperTransaction` has always used that for multi-row
atomicity (`{"op":"batch","changes":[…]}`); Phase 26 promotes it to the internal `mutateBatch`
helper and points the three aggregate-critical writers at it:

- **`saveSportsTicket`** — the R-30 subject. One batch, **selections first, the ticket last**: a
  crash can no longer leave a ticket with fewer selections than `selection_count` claims. The
  `replace: false` duplicate-id guard is checked up front, so a refusal still writes nothing.
- **`saveLotteryDrawNumbers`** — the delete-then-insert of a draw's numbers is one record; a crash
  mid-replace can no longer leave a draw carrying some old numbers and some new.
- **`saveLotteryTicketLines`** — the same for a ticket's lines: a crash can no longer leave a
  ticket with fewer lines than it was recorded with.

The keys inside a batch are derived from each value's own `keyOf`, exactly as single `mutate`
derives them — entities with composite keys (draw numbers key by `draw_id|kind|position`) cannot
be keyed by a bare id, or deletes and upserts land beside their rows.

## 2. F-46 — the draw-numbers replace was a silent no-op

Converting the method exposed it: the old delete built its key from `{ id }` alone —
`keyOf("lotteryDrawNumbers", { id })` is `"undefined|undefined|undefined"` — so **every replace
deleted nothing** and the file adapter accumulated one duplicate number set per re-save (the
probe: 14 rows for 7 numbers after one re-import). The existing store test asserted only the
surviving rows' positions and numbers, never the absence of the replaced ones — the same
test-shaped blind spot the lottery cleanup bug hid in. Fixed with the key the table uses, and the
new atomicity tests assert the delete count inside the batch record.

## 3. Honest scope

The aggregate-critical writers are converted; four sequential two-mutate methods are deliberately
left as they are, because their halves are not read as one aggregate (a lottery game row and its
rules-version refresh; a draw row and its health stamp; a user and their profile; a user update
and its session bookkeeping) — a torn pair there is self-healing or cosmetic, and converting them
would be mechanism for its own sake. One residual is **recorded, not fixed** (see the R-30
entry): the lottery ticket create remains legacy's two repository calls — ticket, then lines — on
both adapters, so that crash window is exactly the one legacy has always had, and no line-count
column exists to check on read. The file adapter still makes no multi-process or cross-host
claims; a real deployment uses the SQL adapter (whose ticket+legs write is transactional and
pinned by the rollback test).

## 4. Gates

| Gate | Result |
| --- | --- |
| `npm run check` (`verify:install` + full suite) | exit 0 — 975/975 tests, 67 files, 29/29 install checks |
| PHP/WASM oracle (`node runtime/run-tests.mjs`) | 367 passed, 0 failed |
| Legacy tree (`application/`, `system/`, `tests/`) | byte-identical, 0 changes |
| New tests | `test/file_atomicity.test.js` — 5 (record shape, torn-tail discard, duplicate refusal, both replace-writes) |
| Version | 0.23.0 |
