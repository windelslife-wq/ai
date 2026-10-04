import test from "node:test";
import assert from "node:assert/strict";
import { AddCollectionLeadsSchema, BusinessSearchInputSchema, ExportRequestSchema, LeadStatusSchema, ResolveDuplicateSchema } from "../src/leadDiscovery.js";

test("business search contract accepts bounded live-provider input", () => {
  const parsed = BusinessSearchInputSchema.parse({ query: "Restaurants in Lagos" });
  assert.equal(parsed.provider, "google_places");
  assert.equal(parsed.limit, 20);
  assert.throws(() => BusinessSearchInputSchema.parse({ query: "x" }));
});
test("lead status and duplicate decisions are closed contracts", () => {
  assert.equal(LeadStatusSchema.parse("qualified"), "qualified");
  assert.throws(() => LeadStatusSchema.parse("in_progress"));
  assert.equal(ResolveDuplicateSchema.parse({ candidateId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8", action: "merge" }).action, "merge");
});
test("collection and export contracts guard cardinality and date ranges", () => {
  assert.throws(() => AddCollectionLeadsSchema.parse({ leadIds: [] }));
  assert.throws(() => ExportRequestSchema.parse({ from: "2026-08-24T00:00:00.000Z", to: "2026-08-23T00:00:00.000Z" }));
});
