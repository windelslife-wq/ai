/**
 * PHP↔Node parity for the ticket domain (row 15, slice 3) — the
 * `cases.tickets` group of the golden.
 *
 * `prizeTier` and the ticket constants are PUBLIC STATIC on legacy's
 * `LotteryIntelligence`, callable WITHOUT constructing the facade (whose
 * constructor demands the full repository interface). That makes the tier
 * ladder — the exact official strings and every boundary a checked ticket can
 * report — directly comparable to PHP's own output. The full 6×3 grid is
 * pinned, including the two behaviors a hand-written test would get wrong:
 * the ladder has NO star upper bound (5 mains is TIER_3 whatever the stars),
 * and there is no "2 stars + 1 main ≠ tier" gap to fall into.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_TICKET_LINES,
  TICKET_METHODS,
  TICKET_STATUS_ARCHIVED,
  TICKET_STATUS_CHECKED,
  TICKET_STATUS_OPEN,
  MODEL_VERSION,
  LOTTERY,
  prizeTier,
} from "../src/modules/lottery/service.js";

const GOLDEN = JSON.parse(await readFile(new URL("./fixtures/lottery-parity-golden.json", import.meta.url), "utf8"));
const TICKETS = GOLDEN.cases.tickets;

test("the golden covers the ticket domain", () => {
  assert.ok(Object.keys(TICKETS).length >= 4, `expected the tickets group, got ${Object.keys(TICKETS).length}`);
});

test("the ticket constants are legacy's, verbatim", () => {
  assert.deepEqual(TICKETS.constants.maxTicketLines, MAX_TICKET_LINES);
  assert.deepEqual(TICKETS.constants.methods, [...TICKET_METHODS]);
  assert.deepEqual(TICKETS.constants.statuses, [TICKET_STATUS_OPEN, TICKET_STATUS_CHECKED, TICKET_STATUS_ARCHIVED]);
  assert.equal(TICKETS.constants.lottery, LOTTERY);
  assert.equal(TICKETS.constants.modelVersion, MODEL_VERSION);
});

test("the prize-tier ladder is PHP's, on the full grid and the ten official strings", () => {
  const grid = {};
  for (let m = 0; m <= 5; m += 1) {
    for (let st = 0; st <= 2; st += 1) {
      grid[`${m}+${st}`] = prizeTier(m, st);
    }
  }
  assert.deepEqual(grid, TICKETS.tierGrid, "the full 6x3 boundary grid");

  const ten = [
    prizeTier(5, 2), prizeTier(5, 1), prizeTier(5, 0),
    prizeTier(4, 2), prizeTier(4, 1),
    prizeTier(3, 2), prizeTier(3, 1),
    prizeTier(2, 2),
    prizeTier(1, 2),
    prizeTier(0, 2),
  ];
  assert.deepEqual(ten, TICKETS["tierLabels are exactly the ten official strings"]);

  // The ladder has no star upper bound: 5 mains is TIER_3 whatever the stars —
  // PHP's match(true) order, not a special case the port invented.
  assert.equal(prizeTier(5, 3), TICKETS["the ladder has no star upper bound: 5 mains is TIER_3 whatever the stars"]);
});
