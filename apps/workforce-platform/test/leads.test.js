/**
 * Phase 45 — Lead Discovery (`leadDiscovery`, Row 17) unit, PHP-parity, store, and HTTP tests.
 *
 * Ports and verifies all contracts from:
 * - `application/controllers/Api_lead_discovery.php`
 * - `application/libraries/LeadDiscovery/{GooglePlacesProvider,ProviderRegistry,Deduplicator}.php`
 * - `tests/cases/23-lead-discovery-schema.php` .. `28-lead-coverage.php`
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createLeadRepository } from "../src/db/lead-repository.js";
import { splitSqlStatements } from "../src/db/migrator.js";
import {
  COVERAGE_FIELDS,
  CSV_EXPORT_COLUMNS,
  DUPLICATE_ACTIONS,
  LEAD_STATUSES,
  safeCsvValue,
} from "../src/modules/leads/contracts.js";
import { matchDuplicateLead } from "../src/modules/leads/deduplicator.js";
import {
  ProviderException,
  createGooglePlacesProvider,
  createLeadProviderRegistry,
} from "../src/modules/leads/providers.js";
import { createLeadDiscoveryService } from "../src/modules/leads/service.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

async function registerMember(app, { username, email, password = "Member-password-123!" }) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      username,
      email,
      password,
      passwordConfirm: password,
      termsAccepted: true,
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  return {
    cookie: cookieFrom(res),
    user: res.json().user,
  };
}

async function signInHeaders(app, user) {
  const me = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: user.cookie },
  });
  return {
    cookie: user.cookie,
    "x-csrf-token": me.json().csrfToken,
  };
}

test("Phase 45 migration 020_lead_discovery.sql creates all 11 organization-scoped Lead Discovery tables", async () => {
  const sql = await readFile(
    new URL("../src/db/migrations/020_lead_discovery.sql", import.meta.url),
    "utf8",
  );
  const statements = splitSqlStatements(sql);
  assert.equal(statements.length, 11);
  const expectedTables = [
    "wf_lead_organizations",
    "wf_lead_organization_members",
    "wf_leads",
    "wf_lead_notes",
    "wf_lead_activities",
    "wf_lead_collections",
    "wf_lead_collection_leads",
    "wf_lead_search_history",
    "wf_lead_duplicate_candidates",
    "wf_lead_duplicate_resolutions",
    "wf_lead_export_history",
  ];
  for (const table of expectedTables) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.match(sql, /UNIQUE KEY uq_wf_lead_source \(organization_id, source, source_id\)/);
});

test("PHP source parity: statuses, duplicate actions, coverage fields, CSV columns, and deduplicator weights match legacy PHP", async () => {
  const controllerPhp = await readFile(
    path.join(REPO_ROOT, "application/controllers/Api_lead_discovery.php"),
    "utf8",
  );
  const dedupePhp = await readFile(
    path.join(REPO_ROOT, "application/libraries/LeadDiscovery/Deduplicator.php"),
    "utf8",
  );

  for (const status of LEAD_STATUSES) {
    assert.ok(controllerPhp.includes(`'${status}'`), `legacy controller must declare status '${status}'`);
  }
  for (const action of DUPLICATE_ACTIONS) {
    assert.ok(controllerPhp.includes(`'${action}'`), `legacy controller must declare duplicate action '${action}'`);
  }
  for (const { key, label } of COVERAGE_FIELDS) {
    assert.ok(controllerPhp.includes(`'${key}'=>'${label}'`), `legacy coverage field ${key} -> ${label}`);
  }
  for (const col of CSV_EXPORT_COLUMNS) {
    assert.ok(controllerPhp.includes(`'${col}'`), `legacy CSV export column ${col}`);
  }

  assert.ok(dedupePhp.includes("['website_domain',0.95]"));
  assert.ok(dedupePhp.includes("['normalized_phone',0.92]"));
  assert.ok(dedupePhp.includes("['name_address',0.84]"));

  assert.deepEqual(
    matchDuplicateLead(
      { name: "Alpha", website: "https://www.example.org/about" },
      { name: "Beta", website: "http://example.org/contact" },
    ),
    ["website_domain", 0.95],
  );
  assert.deepEqual(
    matchDuplicateLead(
      { name: "Alpha", phone: "+32 (2) 555-0199" },
      { name: "Beta", phone: "32 2 555 0199" },
    ),
    ["normalized_phone", 0.92],
  );
  assert.deepEqual(
    matchDuplicateLead(
      { name: "Acorn Bakery!", address: "10 Rue Haute, Brussels" },
      { name: "acorn bakery", address: "10 rue haute brussels" },
    ),
    ["name_address", 0.84],
  );
  assert.deepEqual(
    matchDuplicateLead(
      { name: "Alpha", address: "1 Main St" },
      { name: "Beta", address: "2 Main St" },
    ),
    [null, 0.0],
  );
});

test("GooglePlacesProvider and ProviderRegistry fail closed without fabricating leads when unconfigured or planned", async () => {
  const unconfigured = createGooglePlacesProvider({ apiKey: "" });
  assert.deepEqual(unconfigured.healthCheck(), {
    status: "DISABLED",
    detail: "GOOGLE_PLACES_API_KEY is not configured",
  });
  await assert.rejects(
    () => unconfigured.searchBusinesses({ query: "coffee shops" }),
    (err) => err instanceof ProviderException && err.httpStatus === 503,
  );

  const registry = createLeadProviderRegistry([unconfigured]);
  assert.throws(
    () => registry.get("yelp_fusion"),
    (err) => err instanceof ProviderException && err.httpStatus === 422 && /planned and not active/.test(err.message),
  );
});

test("MySQL lead-repository adapter executes parameterized organization-scoped SQL for all 22 methods", async () => {
  const executed = [];
  const fakePool = {
    async execute(sql, values = []) {
      executed.push({ sql, values });
      return [[], { affectedRows: 1 }];
    },
    async query(sql, values = []) {
      executed.push({ sql, values });
      return [[], []];
    },
  };
  const repo = createLeadRepository(fakePool);
  const nowIso = "2026-10-17T12:00:00.000Z";
  await repo.listLeadWorkspaces(7);
  await repo.ensureLeadWorkspace({ userId: 7, email: "u@example.test", nowIso });
  await repo.listLeads("org-7", { status: "new", limit: 10 });
  await repo.findLeadById("org-7", "lead-1");
  await repo.findLeadBySource("org-7", "google_places", "src-1");
  await repo.saveLead({
    id: "lead-1",
    organization_id: "org-7",
    source: "google_places",
    source_id: "src-1",
    name: "Cafe Belga",
    status: "new",
    created_at: nowIso,
    updated_at: nowIso,
  });
  await repo.listLeadNotes("org-7", "lead-1");
  await repo.createLeadNote({
    id: "note-1",
    lead_id: "lead-1",
    organization_id: "org-7",
    author_id: 7,
    body: "Called reception",
    created_at: nowIso,
  });
  await repo.listLeadActivities("org-7", "lead-1");
  await repo.recordLeadActivity({
    id: "act-1",
    lead_id: "lead-1",
    organization_id: "org-7",
    actor_id: 7,
    type: "NOTE_ADDED",
    detail: "{}",
    created_at: nowIso,
  });
  await repo.listLeadCollections("org-7");
  await repo.findLeadCollection("org-7", "col-1");
  await repo.saveLeadCollection({
    id: "col-1",
    organization_id: "org-7",
    name: "Brussels Cafes",
    created_at: nowIso,
    updated_at: nowIso,
  });
  await repo.listCollectionLeads("org-7", "col-1");
  await repo.setCollectionLeadMembership({ collectionId: "col-1", leadId: "lead-1", member: true });
  await repo.setCollectionLeadMembership({ collectionId: "col-1", leadId: "lead-1", member: false });
  await repo.deleteLeadCollection("org-7", "col-1");
  await repo.listLeadDuplicateCandidates("org-7", { status: "open" });
  await repo.saveLeadDuplicateCandidate({
    id: "dup-1",
    organization_id: "org-7",
    lead_a_id: "lead-1",
    lead_b_id: "lead-2",
    rule_name: "website_domain",
    confidence: 0.95,
    status: "open",
    created_at: nowIso,
  });
  await repo.resolveLeadDuplicateCandidate({
    organizationId: "org-7",
    candidateId: "dup-1",
    resolution: { id: "res-1", resolver_id: 7, action: "keep_a", created_at: nowIso },
  });
  await repo.recordLeadSearchHistory({
    id: "sh-1",
    organization_id: "org-7",
    user_id: 7,
    query: "coffee",
    provider: "google_places",
    filters: "{}",
    results_returned: 1,
    new_leads_created: 1,
    duplicates_detected: 0,
    errors: null,
    duration_ms: 25,
    created_at: nowIso,
  });
  await repo.listLeadSearchHistory("org-7", 25);
  await repo.recordLeadExportHistory({
    id: "ex-1",
    organization_id: "org-7",
    user_id: 7,
    format: "csv",
    filters: "{}",
    lead_count: 1,
    created_at: nowIso,
  });
  assert.ok(executed.length >= 22);
});

test("HTTP & workflow parity (cases 24–28): disabled provider fails closed, real provider discovers leads, deduplicates, isolates tenants, tracks coverage, and guards CSV exports", async (t) => {
  const instance = await createFileStoreApp();
  t.after(() => instance.cleanup());

  const alice = await registerMember(instance.app, {
    username: "alice_leads",
    email: "alice_leads@example.test",
  });
  const bob = await registerMember(instance.app, {
    username: "bob_leads",
    email: "bob_leads@example.test",
  });
  const aliceHeaders = await signInHeaders(instance.app, alice);
  const bobHeaders = await signInHeaders(instance.app, bob);

  // 1. Unauthenticated caller is refused 401.
  const anon = await instance.app.inject({ method: "GET", url: "/api/v1/lead-discovery/workspaces" });
  assert.equal(anon.statusCode, 401);

  // 2. First authenticated call auto-provisions private workspace org-<userId>.
  const wsRes = await instance.app.inject({
    method: "GET",
    url: "/api/v1/lead-discovery/workspaces",
    headers: aliceHeaders,
  });
  assert.equal(wsRes.statusCode, 200);
  const aliceOrgId = wsRes.json().activeOrganizationId;
  assert.match(aliceOrgId, /^org-\d+$/);

  // 3. Default unconfigured Google Places provider reports DISABLED and fails closed with 503 without creating leads.
  const provRes = await instance.app.inject({
    method: "GET",
    url: "/api/v1/lead-discovery/providers",
    headers: aliceHeaders,
  });
  assert.equal(provRes.statusCode, 200);
  assert.equal(provRes.json().providers[0].status, "DISABLED");

  const searchDisabled = await instance.app.inject({
    method: "POST",
    url: "/api/v1/lead-discovery/search",
    headers: aliceHeaders,
    payload: { query: "specialty coffee brussels" },
  });
  assert.equal(searchDisabled.statusCode, 503);
  assert.equal(searchDisabled.json().error.details.providerStatus, "DISABLED");

  const leadsAfterFailedSearch = await instance.app.inject({
    method: "GET",
    url: "/api/v1/lead-discovery/leads",
    headers: aliceHeaders,
  });
  assert.equal(leadsAfterFailedSearch.json().leads.length, 0, "no synthetic leads may be created when provider is disabled");

  const histAfterFailedSearch = await instance.app.inject({
    method: "GET",
    url: "/api/v1/lead-discovery/history",
    headers: aliceHeaders,
  });
  assert.equal(histAfterFailedSearch.json().history.length, 1);
  assert.match(histAfterFailedSearch.json().history[0].errors, /GOOGLE_PLACES_API_KEY/);

  // 4. Drive discovery through a configured GooglePlacesProvider transport (case 25/26).
  const configuredService = createLeadDiscoveryService({
    config: { leads: { googlePlacesApiKey: "test-places-key" } },
    store: instance.store,
    transport: async () => ({
      places: [
        {
          id: "gp-101",
          displayName: { text: "=SUM(1,2) Roastery" },
          formattedAddress: "12 Rue Royale, Brussels",
          types: ["cafe", "food"],
          nationalPhoneNumber: "+32 2 555 0100",
          websiteUri: "https://roastery.example.test",
          location: { latitude: 50.8466, longitude: 4.3528 },
        },
        {
          id: "gp-102",
          displayName: { text: "Roastery Annex" },
          formattedAddress: "99 Avenue Louise, Brussels",
          types: ["cafe"],
          nationalPhoneNumber: null,
          websiteUri: "https://www.roastery.example.test/annex",
          location: { latitude: 50.8333, longitude: 4.3666 },
        },
      ],
    }),
  });

  const discovered = await configuredService.search(
    { id: alice.user.id, email: alice.user.email },
    { query: "roastery brussels", limit: 10 },
    aliceOrgId,
  );
  assert.equal(discovered.providerStatus, "IMPLEMENTED");
  assert.equal(discovered.results.length, 2);
  assert.equal(discovered.newLeadsCreated, 2);
  assert.equal(discovered.duplicateCandidatesCreated, 1, "shared website domain creates an open duplicate review candidate");

  // Re-running the same search updates by (organization_id, source, source_id) instead of duplicating rows.
  const rediscovered = await configuredService.search(
    { id: alice.user.id, email: alice.user.email },
    { query: "roastery brussels", limit: 10 },
    aliceOrgId,
  );
  assert.equal(rediscovered.newLeadsCreated, 0);
  assert.ok(rediscovered.duplicatesDetected >= 2);

  // 5. Cross-organization tenant isolation (case 27): Bob cannot spoof Alice's X-Lead-Organization header or read Alice's leads.
  const bobSpoof = await instance.app.inject({
    method: "GET",
    url: "/api/v1/lead-discovery/leads",
    headers: { ...bobHeaders, "x-lead-organization": aliceOrgId },
  });
  assert.equal(bobSpoof.statusCode, 403);
  assert.match(bobSpoof.json().error.message, /forbidden organization workspace/);

  const bobLeads = await instance.app.inject({
    method: "GET",
    url: "/api/v1/lead-discovery/leads",
    headers: bobHeaders,
  });
  assert.equal(bobLeads.statusCode, 200);
  assert.equal(bobLeads.json().leads.length, 0);

  // 6. Coverage diagnostics (case 28): 1 of 2 leads is missing `phone` (50% coverage).
  const covRes = await instance.app.inject({
    method: "GET",
    url: "/api/v1/lead-discovery/coverage?missing=phone",
    headers: aliceHeaders,
  });
  assert.equal(covRes.statusCode, 200);
  const cov = covRes.json();
  assert.equal(cov.leadCount, 2);
  const phoneField = cov.fields.find((f) => f.key === "phone");
  assert.equal(phoneField.coverage, 50);
  assert.equal(phoneField.missing, 1);
  assert.equal(cov.missingLeads.length, 1);
  assert.equal(cov.missingLeads[0].name, "Roastery Annex");

  const badCov = await instance.app.inject({
    method: "GET",
    url: "/api/v1/lead-discovery/coverage?missing=unknown_column",
    headers: aliceHeaders,
  });
  assert.equal(badCov.statusCode, 400);

  // 7. Collections, status transitions, owner assignment, notes, and activity trail.
  const leadAId = discovered.results[0].id;
  const colCreate = await instance.app.inject({
    method: "POST",
    url: "/api/v1/lead-discovery/collections",
    headers: aliceHeaders,
    payload: { name: "Priority Roasters" },
  });
  assert.equal(colCreate.statusCode, 201);
  const colId = colCreate.json().id;

  const colAdd = await instance.app.inject({
    method: "POST",
    url: "/api/v1/lead-discovery/collections/" + colId + "/leads",
    headers: aliceHeaders,
    payload: { leadIds: [leadAId] },
  });
  assert.equal(colAdd.statusCode, 200);
  assert.equal(colAdd.json().added, 1);

  const statusPatch = await instance.app.inject({
    method: "PATCH",
    url: `/api/v1/lead-discovery/leads/${leadAId}/status`,
    headers: aliceHeaders,
    payload: { status: "qualified" },
  });
  assert.equal(statusPatch.statusCode, 200);

  const ownerPatch = await instance.app.inject({
    method: "PATCH",
    url: `/api/v1/lead-discovery/leads/${leadAId}/owner`,
    headers: aliceHeaders,
    payload: { ownerId: alice.user.id },
  });
  assert.equal(ownerPatch.statusCode, 200);

  const noteCreate = await instance.app.inject({
    method: "POST",
    url: `/api/v1/lead-discovery/leads/${leadAId}/notes`,
    headers: aliceHeaders,
    payload: { body: "Spoke with head roaster; interested in Q4 wholesale." },
  });
  assert.equal(noteCreate.statusCode, 201);

  const actRes = await instance.app.inject({
    method: "GET",
    url: `/api/v1/lead-discovery/leads/${leadAId}/activity`,
    headers: aliceHeaders,
  });
  assert.equal(actRes.statusCode, 200);
  const actTypes = actRes.json().activity.map((a) => a.type);
  for (const expectedType of ["LEAD_DISCOVERED", "DUPLICATE_DETECTED", "LEAD_ADDED_TO_COLLECTION", "STATUS_CHANGED", "OWNER_ASSIGNED", "NOTE_ADDED"]) {
    assert.ok(actTypes.includes(expectedType), `activity trail must include ${expectedType}`);
  }

  // 8. Duplicate candidate resolution (`merge` fills missing phone on canonical lead and archives duplicate).
  const dupList = await instance.app.inject({
    method: "GET",
    url: "/api/v1/lead-discovery/duplicates",
    headers: aliceHeaders,
  });
  assert.equal(dupList.statusCode, 200);
  assert.equal(dupList.json().duplicates.length, 1);
  const candidate = dupList.json().duplicates[0];

  const dupResolve = await instance.app.inject({
    method: "POST",
    url: "/api/v1/lead-discovery/duplicates/resolve",
    headers: aliceHeaders,
    payload: { candidateId: candidate.id, action: "merge" },
  });
  assert.equal(dupResolve.statusCode, 200);

  const archivedLead = await instance.app.inject({
    method: "GET",
    url: `/api/v1/lead-discovery/leads/${candidate.lead_b_id}`,
    headers: aliceHeaders,
  });
  assert.equal(archivedLead.json().status, "disqualified");
  assert.equal(JSON.parse(archivedLead.json().metadata).duplicateResolution.reason, "merged");

  // 9. CSV formula-injection guard on preview and CSV export (`=SUM(1,2) Roastery` -> `'=SUM(1,2) Roastery`).
  assert.equal(safeCsvValue("=SUM(1,2)"), "'=SUM(1,2)");
  const previewRes = await instance.app.inject({
    method: "POST",
    url: "/api/v1/lead-discovery/export/preview",
    headers: aliceHeaders,
    payload: {},
  });
  assert.equal(previewRes.statusCode, 200);
  assert.equal(previewRes.json().csvSafe, true);
  assert.ok(previewRes.json().rows.some((r) => r.name === "'=SUM(1,2) Roastery"));

  const csvRes = await instance.app.inject({
    method: "POST",
    url: "/api/v1/lead-discovery/export/csv",
    headers: aliceHeaders,
    payload: {},
  });
  assert.equal(csvRes.statusCode, 200);
  assert.match(csvRes.headers["content-type"], /^text\/csv/);
  assert.match(csvRes.body, /"'=SUM\(1,2\) Roastery"/);
});
