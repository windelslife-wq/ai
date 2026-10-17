/**
 * Phase 45 — Lead Discovery console (`client/src/leads.js`, `/app/leads`, `/app/leads/pipeline`) tests.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  COVERAGE_FIELD_KEYS,
  DUPLICATE_RESOLUTION_ACTIONS,
  LEAD_STATUS_OPTIONS,
  LEADS_COPY,
  LEADS_PERMISSION,
  LEADS_READS,
  LEADS_TABS,
  buildExportPreviewSummary,
  formatProviderBadge,
  parseLeadMetadata,
  validateCollectionName,
  validateLeadNoteBody,
  validateLeadSearchQuery,
} from "../client/src/leads.js";
import {
  COVERAGE_FIELDS,
  DUPLICATE_ACTIONS,
  LEAD_PERMISSION,
  LEAD_STATUSES,
} from "../src/modules/leads/contracts.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";

const CLIENT = path.resolve(import.meta.dirname, "..", "client", "src");

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

test("client/src/leads.js vocabulary matches src/modules/leads/contracts.js", () => {
  assert.equal(LEADS_PERMISSION, LEAD_PERMISSION);
  assert.deepEqual([...LEAD_STATUS_OPTIONS], [...LEAD_STATUSES]);
  assert.deepEqual(
    [...DUPLICATE_RESOLUTION_ACTIONS.map((a) => a.action)].sort(),
    [...DUPLICATE_ACTIONS].sort(),
  );
  assert.deepEqual(
    [...COVERAGE_FIELD_KEYS],
    COVERAGE_FIELDS.map((f) => f.key),
  );
  assert.equal(LEADS_TABS.length, 7);
  assert.match(LEADS_COPY.noSyntheticRule, /never fabricate business leads/i);
});

test("client validation helpers enforce the server's exact character bounds", () => {
  assert.equal(validateLeadSearchQuery("ab"), "query must be 3–300 characters");
  assert.equal(validateLeadSearchQuery("coffee roasters"), null);
  assert.equal(validateCollectionName(""), "name must be 1–150 characters");
  assert.equal(validateCollectionName("Brussels Leads"), null);
  assert.equal(validateLeadNoteBody(""), "note must be 1–4000 characters");
  assert.equal(validateLeadNoteBody("Spoke with owner"), null);

  assert.deepEqual(formatProviderBadge({ name: "google_places", status: "DISABLED", detail: "GOOGLE_PLACES_API_KEY is not configured" }), {
    name: "google_places",
    status: "DISABLED",
    detail: "GOOGLE_PLACES_API_KEY is not configured",
    tone: "badge-gray",
  });
  assert.deepEqual(parseLeadMetadata({ metadata: '{"duplicateResolution":{"reason":"merged"}}' }), {
    duplicateResolution: { reason: "merged" },
  });
  assert.deepEqual(buildExportPreviewSummary({ rows: [{ id: "1" }], count: 4, csvSafe: true }), {
    count: 4,
    previewCount: 1,
    csvSafe: true,
    rows: [{ id: "1" }],
  });
});

test("App.jsx, views.jsx, and site redirects wire /app/leads and /app/leads/pipeline against live routes", async (t) => {
  const appSource = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  const viewsSource = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");

  assert.match(appSource, /path:\s*"\/app\/leads",\s*view:\s*"lead-discovery",\s*requiresAuth:\s*true,\s*permission:\s*"system\.authenticated"/);
  assert.match(appSource, /path:\s*"\/app\/leads\/pipeline",\s*view:\s*"lead-pipeline",\s*requiresAuth:\s*true,\s*permission:\s*"system\.authenticated"/);
  assert.match(viewsSource, /to:\s*"\/app\/leads",\s*label:\s*"Lead Discovery",\s*permission:\s*LEADS_PERMISSION/);
  assert.match(viewsSource, /to:\s*"\/app\/leads\/pipeline",\s*label:\s*"Lead Pipeline",\s*permission:\s*LEADS_PERMISSION/);

  const instance = await createFileStoreApp();
  t.after(() => instance.cleanup());

  for (const [legacyPath, target] of [["/leads", "/app/leads"], ["/lead-pipeline", "/app/leads/pipeline"]]) {
    const redirect = await instance.app.inject({ method: "GET", url: legacyPath });
    assert.equal(redirect.statusCode, 302);
    assert.equal(redirect.headers.location, target);
  }

  const member = await registerMember(instance.app, {
    username: "leads_console_user",
    email: "leads_console_user@example.test",
  });
  for (const read of LEADS_READS) {
    const res = await instance.app.inject({
      method: "GET",
      url: read.path,
      headers: { cookie: member.cookie },
    });
    assert.equal(res.statusCode, 200, `${read.path} must answer 200 for an authenticated member`);
  }
});
