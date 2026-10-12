/**
 * PHP↔Node differential parity for the ticket engine (row 14, slice 4).
 *
 * Every expectation is legacy's output, captured in `test/fixtures/sports-parity-golden.json`
 * under `cases.slice4` by `runtime/sports-parity.mjs` from `runtime/parity/sports-tickets-golden.php`.
 * The inputs come from the same file, so the two sides cannot disagree about what was computed.
 *
 * Three groups:
 *
 *  - `correlation` and `classifySelections`: exact. The Node result equals PHP's, reasons and
 *    order included.
 *  - `optimize`: exact, except for the one field that cannot match. Legacy's ticket id is a
 *    PHP-side random value, so the golden strips it. The test checks the id's SHAPE, and that
 *    it is present exactly when legacy's result had one, and then compares everything else.
 *  - `constants`: the score table and the optimizer defaults, which the other groups depend on.
 *
 * Evidence, not endorsement: the F-39 cases assert that legacy's pipeline-shaped candidate
 * shares no team and so is LOW. The port-shaped twins are HIGH. The difference is the
 * finding, and the test pins both so a fix to legacy is noticed rather than absorbed.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assessCorrelation, classifySelections, CORRELATION_SCORES } from "../src/modules/sports/correlation.js";
import { optimizeTicket } from "../src/modules/sports/ticket-optimizer.js";

const golden = JSON.parse(await readFile(new URL("./fixtures/sports-parity-golden.json", import.meta.url), "utf8"));
const s4 = golden.cases.slice4;

/** The same canonical form the slice-3 parity test uses: sorted keys, PHP's `{}` as `[]`. */
function canon(value) {
  if (value === -0) return 0;
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return [];
    const out = {};
    for (const key of keys.sort()) out[key] = canon(value[key]);
    return out;
  }
  return value;
}

/** The Node value as it would be serialized, so it is compared the way PHP's JSON is. */
function asJson(value) {
  return canon(JSON.parse(JSON.stringify(value)));
}

test("the golden carries the slice 4 group, and the score table matches legacy", () => {
  assert.ok(s4, "cases.slice4 is present; regenerate the golden if this fails");
  assert.deepEqual(Object.keys(s4).sort(), ["classifySelections", "constants", "correlation", "optimize"]);
  assert.equal(Object.keys(s4.correlation).length, 8);
  assert.equal(Object.keys(s4.classifySelections).length, 4);
  assert.equal(Object.keys(s4.optimize).length, 17);
  assert.deepEqual(s4.constants.correlationScore, { ...CORRELATION_SCORES });
});

test("correlation: every legacy case matches PHP's CorrelationEngine::assess exactly", () => {
  for (const [name, entry] of Object.entries(s4.correlation)) {
    const { candidate, selected } = entry.input;
    const actual = asJson(assessCorrelation(candidate, selected));
    assert.deepEqual(actual, canon(entry.result), `correlation — ${name}`);
  }
});

test("classifySelections: every legacy case matches PHP exactly, reasons and order included", () => {
  for (const [name, entry] of Object.entries(s4.classifySelections)) {
    const actual = asJson(classifySelections(entry.input));
    assert.deepEqual(actual, canon(entry.result), `classifySelections — ${name}`);
  }
});

test("optimize: every legacy case matches PHP's TicketOptimizer, with the ticket id checked by shape", () => {
  for (const [name, entry] of Object.entries(s4.optimize)) {
    const { pool, config } = entry.input;
    // A fixed id is passed so the id is present whenever the optimizer would give one.
    const out = optimizeTicket(pool, config, { ticketId: "tkt_0123456789abcdef" });

    assert.equal(Object.hasOwn(out, "ticketId") && out.ticketId !== null, entry.hasTicketId,
      `optimize — ${name}: ticketId presence`);
    if (entry.hasTicketId) {
      assert.match(out.ticketId, /^tkt_[0-9a-f]{16}$/, `optimize — ${name}: ticketId shape`);
      assert.equal(entry.ticketIdShape, true, `optimize — ${name}: PHP's own id had the shape`);
    }

    const { ticketId: _ticketId, ...rest } = out;
    assert.deepEqual(asJson(rest), canon(entry.result), `optimize — ${name}`);
  }
});

test("F-39 is pinned as evidence: legacy's pipeline-shaped team match is LOW, the port-shaped one HIGH", () => {
  const pipelineShaped = s4.correlation["F-39: a shared team is invisible on the pipeline shape, so the pair is LOW"];
  assert.equal(pipelineShaped.result.classification, "LOW", "legacy never sees the shared team");

  // The same pair with the teams at the top level, which is what the ticket service supplies.
  const { candidate, selected } = pipelineShaped.input;
  const lift = (c) => ({ ...c, homeTeam: c.match.homeTeam, awayTeam: c.match.awayTeam, competition: c.match.competition });
  const port = assessCorrelation(lift(candidate), selected.map(lift));
  assert.equal(port.classification, "HIGH");
  assert.ok(port.reasons.some((reason) => reason.startsWith("SAME_TEAM_")), "the shared team is named");
});
