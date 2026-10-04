import test from "node:test";
import assert from "node:assert/strict";
import { GooglePlacesProvider } from "../src/providers/googlePlaces.js";
test("Google Places provider normalizes configured live-provider payloads without synthetic rows", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ places: [{ id: "place-stable", displayName: { text: "Lagos Kitchen" }, formattedAddress: "12 Marina, Lagos", types: ["restaurant", "food"], nationalPhoneNumber: "+23415550100", websiteUri: "https://lagoskitchen.example", location: { latitude: 6.45, longitude: 3.39 } }] }), { status: 200 });
  try { const rows = await new GooglePlacesProvider("configured-key").search("Restaurants in Lagos", 10); assert.equal(rows.length, 1); assert.equal(rows[0]?.sourceId, "place-stable"); assert.equal(rows[0]?.category, "restaurant, food"); assert.equal(rows[0]?.metadata.provider, "Google Places"); } finally { globalThis.fetch = original; }
});
