/**
 * Sports foundation — unit tests for the parts the PHP differential harness cannot
 * cover.
 *
 * `test/sports_parity.test.js` compares the four pure classes against PHP's own
 * output. This file covers what has no PHP counterpart to compare against: the
 * fallback chain's control flow, the HTTP provider's failure classification, the
 * health monitor's seven precedence rules, and the service's registration gates.
 * Every provider call here runs against an **injected transport**, so no test in
 * this file performs I/O — which is also why the sandbox provider matters: it is the
 * one provider whose real implementation is itself I/O-free.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { assessOddsFreshness, assessQuality } from "../src/modules/sports/quality.js";
import { normalizeFixture, normalizeOdds } from "../src/modules/sports/normalizer.js";
import { PROVIDER_STATUS, ProviderError } from "../src/modules/sports/provider-error.js";
import { createSportsProviderManager } from "../src/modules/sports/providers/manager.js";
import { createHttpSportsProvider, classifyHttpStatus } from "../src/modules/sports/providers/http.js";
import { createSandboxSportsProvider, SANDBOX_PROVIDER_ID } from "../src/modules/sports/providers/sandbox.js";
import {
  DEGRADED_ERROR_RATE,
  RECENT_FAILURE_WINDOW_SECONDS,
  STALE_AFTER_SECONDS,
  TERMINAL_REPORT_WINDOW_SECONDS,
  assessProviderHealth,
} from "../src/modules/sports/health-monitor.js";
import { SPORTS_NOT_PORTED, createSportsService } from "../src/modules/sports/service.js";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const NOW_SECONDS = NOW / 1000;
const iso = (offsetSeconds) => new Date((NOW_SECONDS + offsetSeconds) * 1000).toISOString();

/** A stub provider whose health and payloads are fixed by the test. */
function stub(id, { status = "ONLINE", payloads = {}, throwOn = null, healthThrows = false, detail = "" } = {}) {
  const calls = [];
  return {
    calls,
    provider: {
      id: () => id,
      health: async () => {
        calls.push("health");
        if (healthThrows) throw new Error(`${id} health exploded`);
        return { status, ...(detail ? { detail } : {}) };
      },
      fixtures: async (query) => {
        calls.push(`fixtures:${JSON.stringify(query)}`);
        if (throwOn === "fixtures") throw new ProviderError(`${id} fixtures refused`, PROVIDER_STATUS.RATE_LIMITED);
        return payloads.fixtures ?? [{ externalId: `${id}-fixture` }];
      },
      odds: async (externalId) => {
        calls.push(`odds:${externalId}`);
        if (throwOn === "odds") throw new ProviderError(`${id} odds refused`, PROVIDER_STATUS.AUTHENTICATION_ERROR);
        return payloads.odds ?? [];
      },
      results: async (externalId) => {
        calls.push(`results:${externalId}`);
        if (throwOn === "results") throw new Error(`${id} results exploded`);
        return payloads.results ?? [];
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The fallback chain                                                          */
/* -------------------------------------------------------------------------- */

test("the registration order IS the fallback preference", async () => {
  const first = stub("first");
  const second = stub("second");
  const manager = createSportsProviderManager({ providers: [first.provider, second.provider] });
  assert.deepEqual(manager.all().map((entry) => entry.id()), ["first", "second"]);

  const outcome = await manager.withFallback("fixtures", (provider) => provider.fixtures({}));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.provider, "first");
  assert.deepEqual(second.calls, [], "the second provider is never consulted once the first succeeds");
});

test("a provider that is not ONLINE is skipped and named, and the next one serves", async () => {
  const down = stub("down", { status: "OFFLINE", detail: " (upstream unreachable)" });
  const up = stub("up");
  const manager = createSportsProviderManager({ providers: [down.provider, up.provider] });

  const outcome = await manager.withFallback("fixtures", (provider) => provider.fixtures({}));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.provider, "up");
  // The failure map is what stops "the first provider was down" from being
  // invisible behind a successful overall result.
  assert.equal(outcome.failures.down, "provider status OFFLINE (upstream unreachable)");
  assert.deepEqual(up.calls.filter((entry) => entry.startsWith("fixtures")), ["fixtures:{}"]);
});

test("total failure returns a structured failure, never an empty success", async () => {
  // Every provider in a chain must actually fail the operation under test. A stub
  // configured to refuse *odds* still legitimately serves a *results* call, and the
  // first version of this test built one chain and asserted a total failure that was
  // in fact a success from its third provider. Two chains, each with every member
  // failing the operation it is asked for.
  const down = stub("down", { status: "OFFLINE" });
  const limited = stub("limited", { throwOn: "odds" });
  const alsoLimited = stub("also-limited", { throwOn: "odds" });
  const oddsChain = createSportsProviderManager({ providers: [down.provider, limited.provider, alsoLimited.provider] });

  const odds = await oddsChain.withFallback("odds", (provider) => provider.odds("FX-1"));
  assert.equal(odds.ok, false, "an empty list would be indistinguishable from a day with no odds");
  assert.equal(odds.result, undefined);
  assert.deepEqual(Object.keys(odds.failures).sort(), ["also-limited", "down", "limited"]);
  assert.equal(odds.failures.down, "provider status OFFLINE");
  assert.match(odds.failures.limited, /^AUTHENTICATION_ERROR: /, "the classified status leads the message");
  assert.match(odds.failures["also-limited"], /^AUTHENTICATION_ERROR: /);

  // A non-ProviderError is classified DATA_ERROR rather than escaping as a raw throw,
  // and a provider whose health() itself throws is skipped without killing the chain.
  const resultsChain = createSportsProviderManager({
    providers: [stub("health-broken", { healthThrows: true }).provider, stub("raw", { throwOn: "results" }).provider],
  });
  const results = await resultsChain.withFallback("results", (provider) => provider.results("FX-1"));
  assert.equal(results.ok, false);
  assert.deepEqual(Object.keys(results.failures).sort(), ["health-broken", "raw"]);
  assert.match(results.failures["health-broken"], /^DATA_ERROR: health-broken health exploded/);
  assert.match(results.failures.raw, /^DATA_ERROR: raw results exploded/);
});

test("a preferred provider is tried first without losing its place for later attempts", async () => {
  const a = stub("a");
  const b = stub("b");
  const manager = createSportsProviderManager({ providers: [a.provider, b.provider] });

  const preferred = await manager.withFallback("fixtures", (provider) => provider.fixtures({}), "b");
  assert.equal(preferred.provider, "b");

  // An unregistered preference is ignored rather than becoming an error.
  const ignored = await manager.withFallback("fixtures", (provider) => provider.fixtures({}), "nope");
  assert.equal(ignored.provider, "a");
});

test("re-registering an id replaces it in place and keeps its fallback position", async () => {
  const original = stub("vendor");
  const replacement = stub("vendor", { payloads: { fixtures: [{ externalId: "replaced" }] } });
  const other = stub("other");
  const manager = createSportsProviderManager({ providers: [original.provider, other.provider] });
  manager.register(replacement.provider);

  assert.deepEqual(manager.all().map((entry) => entry.id()), ["vendor", "other"], "no duplicate, no reordering");
  const outcome = await manager.withFallback("fixtures", (provider) => provider.fixtures({}));
  assert.equal(outcome.result[0].externalId, "replaced");
});

test("a provider whose health() throws is classified and skipped, not fatal", async () => {
  const exploding = stub("exploding", { healthThrows: true });
  const fine = stub("fine");
  const manager = createSportsProviderManager({ providers: [exploding.provider, fine.provider] });

  const outcome = await manager.withFallback("fixtures", (provider) => provider.fixtures({}));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.provider, "fine");
  assert.match(outcome.failures.exploding, /^DATA_ERROR: exploding health exploded/);
});

test("the health observer sees successes, classified failures AND silent skips", async () => {
  const down = stub("down", { status: "DEGRADED" });
  const up = stub("up");
  const seen = [];
  const manager = createSportsProviderManager({ providers: [down.provider, up.provider] });
  manager.setHealthObserver((event) => seen.push(event));

  await manager.withFallback("fixtures", (provider) => provider.fixtures({}));
  assert.equal(seen.length, 2, "a provider that is silently never consulted would otherwise look healthy forever");
  assert.deepEqual(seen[0].payload, { skipped: "DEGRADED" });
  assert.equal(seen[0].error, null);
  assert.equal(seen[1].providerId, "up");
  assert.deepEqual(seen[1].payload, { ok: true });

  seen.length = 0;
  const limited = stub("limited", { throwOn: "fixtures" });
  const second = createSportsProviderManager({ providers: [limited.provider] });
  second.setHealthObserver((event) => seen.push(event));
  await second.withFallback("fixtures", (provider) => provider.fixtures({}));
  assert.equal(seen.length, 1);
  assert.ok(seen[0].error instanceof ProviderError);
  assert.equal(seen[0].error.status, PROVIDER_STATUS.RATE_LIMITED);
});

test("an observer that throws cannot break the sync it is observing", async () => {
  const up = stub("up");
  const manager = createSportsProviderManager({ providers: [up.provider] });
  manager.setHealthObserver(() => {
    throw new Error("observer is broken");
  });
  const outcome = await manager.withFallback("fixtures", (provider) => provider.fixtures({}));
  assert.equal(outcome.ok, true, "a monitoring defect must not turn a working ingest into a failed one");
});

test("live health degrades one broken provider rather than the whole map", async () => {
  const exploding = stub("exploding", { healthThrows: true });
  const fine = stub("fine");
  const limited = stub("limited", { status: "RATE_LIMITED" });
  const manager = createSportsProviderManager({ providers: [exploding.provider, fine.provider, limited.provider] });

  const health = await manager.health();
  assert.deepEqual(Object.keys(health), ["exploding", "fine", "limited"], "registration order, every provider present");
  assert.equal(health.exploding.status, PROVIDER_STATUS.DATA_ERROR);
  assert.equal(health.fine.status, PROVIDER_STATUS.ONLINE);
  assert.equal(health.limited.status, PROVIDER_STATUS.RATE_LIMITED);
  assert.equal(health.fine.id, "fine");
});

test("registering nothing means configured() is false and the chain fails cleanly", async () => {
  const manager = createSportsProviderManager();
  assert.equal(manager.configured(), false);
  assert.deepEqual(await manager.health(), {});
  const outcome = await manager.withFallback("fixtures", () => []);
  assert.deepEqual(outcome, { ok: false, failures: {} });
});

test("a manager rejects something that is not a provider", () => {
  const manager = createSportsProviderManager();
  assert.throws(() => manager.register({}), /must expose id\(\)/);
  assert.throws(() => manager.register(null), /must expose id\(\)/);
});

/* -------------------------------------------------------------------------- */
/* The HTTP provider                                                           */
/* -------------------------------------------------------------------------- */

/** A transport that records every request and answers from a scripted table. */
function scriptedTransport(responses) {
  const requests = [];
  return {
    requests,
    transport: async (url, init) => {
      requests.push({ url, init });
      const match = responses.find((entry) => url.includes(entry.match));
      if (!match) return { status: 404, body: "[]" };
      if (match.throw) throw match.throw;
      return { status: match.status ?? 200, body: match.body ?? "[]" };
    },
  };
}

const httpOptions = { id: "vendor", baseUrl: "https://feed.example.com/v1", token: "super-secret-token", now: () => NOW };

test("HTTP statuses classify into the five failure statuses, in the right precedence", () => {
  assert.equal(classifyHttpStatus(200), null);
  assert.equal(classifyHttpStatus(204), null);
  assert.equal(classifyHttpStatus(0).status, PROVIDER_STATUS.OFFLINE, "no response at all is not a data error");
  assert.equal(classifyHttpStatus(401).status, PROVIDER_STATUS.AUTHENTICATION_ERROR);
  assert.equal(classifyHttpStatus(403).status, PROVIDER_STATUS.AUTHENTICATION_ERROR);
  assert.equal(classifyHttpStatus(429).status, PROVIDER_STATUS.RATE_LIMITED);
  assert.equal(classifyHttpStatus(500).status, PROVIDER_STATUS.DATA_ERROR);
  assert.equal(classifyHttpStatus(503).status, PROVIDER_STATUS.DATA_ERROR);
  assert.equal(classifyHttpStatus(400).status, PROVIDER_STATUS.DATA_ERROR);
  assert.equal(classifyHttpStatus(404).status, PROVIDER_STATUS.DATA_ERROR);
  // 429 must not be swallowed by the generic 4xx branch, and 401 by the 5xx one.
  assert.match(classifyHttpStatus(429).message, /rate limited \(HTTP 429\)/);
  assert.match(classifyHttpStatus(401).message, /authentication rejected \(HTTP 401\)/);
});

test("the HTTP provider builds the documented URLs and keeps the base path prefix", async () => {
  const { requests, transport } = scriptedTransport([{ match: "/fixtures", body: "[]" }]);
  const provider = createHttpSportsProvider({ ...httpOptions, transport });
  await provider.fixtures({ from: "2026-01-01", to: "2026-01-02" });
  // The `/v1` prefix survives — `brokerBaseUrl` would have dropped it, which is why
  // sports has its own resolver (divergence SP-9).
  assert.equal(requests[0].url, "https://feed.example.com/v1/fixtures?from=2026-01-01&to=2026-01-02");

  await provider.odds("FX/1 a&b");
  assert.equal(requests[1].url, "https://feed.example.com/v1/fixtures/FX%2F1%20a%26b/odds", "a path segment cannot escape into the query");
  await provider.results("FX-2");
  assert.equal(requests[2].url, "https://feed.example.com/v1/fixtures/FX-2/results");
});

test("the token appears in exactly one place and in no error message", async () => {
  const { requests, transport } = scriptedTransport([{ match: "/fixtures?", status: 401, body: "denied" }]);
  const provider = createHttpSportsProvider({ ...httpOptions, transport });

  const error = await provider.fixtures({}).then(() => null, (thrown) => thrown);
  assert.ok(error instanceof ProviderError);
  assert.equal(error.status, PROVIDER_STATUS.AUTHENTICATION_ERROR);
  assert.equal(error.message.includes("super-secret-token"), false, "the credential must not travel in the message");
  assert.equal(error.message.includes("feed.example.com"), false, "nor the host");

  assert.deepEqual(requests[0].init.headers.Authorization, "Bearer super-secret-token");
  assert.equal(requests[0].init.headers.Accept, "application/json");
  assert.equal(JSON.stringify(requests[0].init.headers).split("super-secret-token").length - 1, 1, "one header, once");
});

test("a transport exception becomes OFFLINE with a generic message", async () => {
  const failure = new Error("connect ENOTFOUND feed.example.com 10.1.2.3");
  const { transport } = scriptedTransport([{ match: "/fixtures?", throw: failure }]);
  const provider = createHttpSportsProvider({ ...httpOptions, transport });

  const error = await provider.fixtures({}).then(() => null, (thrown) => thrown);
  assert.equal(error.status, PROVIDER_STATUS.OFFLINE);
  // Divergence SP-7: legacy interpolated the transport's own message, whose Node
  // equivalent can carry a resolved address.
  assert.equal(error.message, "provider transport failure");
  assert.equal(error.message.includes("10.1.2.3"), false);
  assert.equal(error.cause, failure, "the original is kept as the cause, not in the text");
});

test("decodeList accepts a bare array and a data envelope, and refuses everything else", async () => {
  const cases = [
    { body: '[{"externalId":"A"}]', count: 1 },
    { body: '{"data":[{"externalId":"A"},{"externalId":"B"}]}', count: 2 },
    { body: "[]", count: 0 },
    { body: '{"data":[]}', count: 0 },
  ];
  for (const entry of cases) {
    const { transport } = scriptedTransport([{ match: "/fixtures?", body: entry.body }]);
    const provider = createHttpSportsProvider({ ...httpOptions, transport });
    assert.equal((await provider.fixtures({})).length, entry.count, entry.body);
  }

  for (const body of ["not-json", '{"a":1}', '{"data":{"not":"a list"}}', "null", '"a string"']) {
    const { transport } = scriptedTransport([{ match: "/fixtures?", body }]);
    const provider = createHttpSportsProvider({ ...httpOptions, transport });
    const error = await provider.fixtures({}).then(() => null, (thrown) => thrown);
    assert.ok(error instanceof ProviderError, `${body} should be refused`);
    assert.equal(error.status, PROVIDER_STATUS.DATA_ERROR);
  }
});

test("a non-object row becomes _malformed so the normalizer can name the refusal", async () => {
  const complete = { externalId: "A", homeTeam: "H", awayTeam: "Aw", competition: "C", kickoff: "2026-01-01T12:00:00Z" };
  const { transport } = scriptedTransport([{ match: "/fixtures", body: `[${JSON.stringify(complete)},"garbage",42]` }]);
  const provider = createHttpSportsProvider({ ...httpOptions, transport });
  const rows = await provider.fixtures({});
  assert.equal(rows.length, 3, "nothing is silently dropped");
  assert.deepEqual(rows[1], { _malformed: "garbage" });
  // And the normalizer then refuses it with a message that says which field.
  assert.throws(() => normalizeFixture(rows[1], "vendor", { now: () => NOW }), /fixture missing externalId/);
  assert.throws(() => normalizeFixture(rows[2], "vendor", { now: () => NOW }), /fixture missing externalId/);
  assert.equal(normalizeFixture(rows[0], "vendor", { now: () => NOW }).externalId, "A");
});

test("health() reports a classified failure instead of throwing, and earns its error rate", async () => {
  const { transport } = scriptedTransport([
    { match: "/health", status: 200, body: '{"status":"ONLINE"}' },
    { match: "/fixtures?", status: 500, body: "boom" },
  ]);
  const provider = createHttpSportsProvider({ ...httpOptions, transport });

  const healthy = await provider.health();
  assert.equal(healthy.status, PROVIDER_STATUS.ONLINE);
  assert.equal(healthy.errorRate, 0);
  assert.equal(healthy.reliability, 1);
  assert.equal(healthy.lastFailureAt, null);

  await provider.fixtures({}).catch(() => {});
  await provider.fixtures({}).catch(() => {});
  const observations = provider.observations();
  assert.equal(observations.requests, 3, "the health probe counts as a request");
  assert.equal(observations.failures, 2);
  assert.equal(observations.errorRate, 0.6667, "rounded to four places, as legacy does");

  // A body claiming ONLINE cannot override the classification.
  const { transport: lying } = scriptedTransport([{ match: "/health", status: 503, body: '{"status":"ONLINE"}' }]);
  const lied = createHttpSportsProvider({ ...httpOptions, transport: lying });
  const reported = await lied.health();
  assert.equal(reported.status, PROVIDER_STATUS.DATA_ERROR);
  assert.equal(reported.lastSuccessAt, null);
  assert.match(reported.detail, /provider server error \(HTTP 503\)/);
});

test("a 200 with a non-JSON health body is still a successful call", async () => {
  const { transport } = scriptedTransport([{ match: "/health", status: 200, body: "not-json" }]);
  const provider = createHttpSportsProvider({ ...httpOptions, transport });
  const health = await provider.health();
  assert.equal(health.status, PROVIDER_STATUS.ONLINE, "classification comes from the status, not the body");
  assert.equal(health.lastReportedStatus ?? null, null);
});

/* -------------------------------------------------------------------------- */
/* The health monitor                                                          */
/* -------------------------------------------------------------------------- */

const PROVIDER_ROW = { provider_code: "vendor", enabled: 1 };
const healthRow = (status, offsetSeconds) => ({ status, observed_at: iso(offsetSeconds) });
const runRow = (status, offsetSeconds) => ({ status, started_at: iso(offsetSeconds) });

test("with no observations at all the derived status is UNKNOWN, never a guess", () => {
  const derived = assessProviderHealth(PROVIDER_ROW, [], [], NOW_SECONDS);
  assert.equal(derived.status, PROVIDER_STATUS.UNKNOWN);
  assert.equal(derived.reliability, 0);
  assert.equal(derived.detail, "no observations yet");
  assert.equal(derived.checkedAt, "2026-01-01T00:00:00+00:00", "legacy's gmdate('c') shape, for parity");
});

test("a terminal self-report inside 30 minutes wins outright over older successes", () => {
  const runs = [runRow("COMPLETED", -60), runRow("COMPLETED", -120), runRow("COMPLETED", -180)];
  for (const status of ["AUTHENTICATION_ERROR", "RATE_LIMITED"]) {
    const derived = assessProviderHealth(PROVIDER_ROW, [healthRow(status, -600)], runs, NOW_SECONDS);
    assert.equal(derived.status, status);
    assert.equal(derived.detail, `last provider report: ${status}`);
    assert.equal(derived.reliability, 0.95, "a perfect run history still cannot claim 1.0 on this path");
  }
  // Outside the window it no longer wins, and the run history is consulted instead.
  const aged = assessProviderHealth(
    PROVIDER_ROW,
    [healthRow("AUTHENTICATION_ERROR", -(TERMINAL_REPORT_WINDOW_SECONDS + 1))],
    runs,
    NOW_SECONDS,
  );
  assert.notEqual(aged.status, PROVIDER_STATUS.AUTHENTICATION_ERROR);
});

test("a failure inside 5 minutes overrides the run history, and keeps a terminal status", () => {
  const runs = [runRow("COMPLETED", -60)];
  const degraded = assessProviderHealth(PROVIDER_ROW, [healthRow("DATA_ERROR", -120)], runs, NOW_SECONDS);
  assert.equal(degraded.status, PROVIDER_STATUS.DEGRADED);
  assert.match(degraded.detail, /^failing since .+\(DATA_ERROR\)$/);

  const limited = assessProviderHealth(PROVIDER_ROW, [healthRow("RATE_LIMITED", -120)], runs, NOW_SECONDS);
  assert.equal(limited.status, PROVIDER_STATUS.RATE_LIMITED, "a terminal failure is not flattened to DEGRADED");

  // Outside the window rule 3 stops applying. The status is still DEGRADED, because
  // rule 7's fallback is DEGRADED as well — what changes is the *reason*, and the
  // reason is the part an operator actually acts on.
  const aged = assessProviderHealth(PROVIDER_ROW, [healthRow("DATA_ERROR", -(RECENT_FAILURE_WINDOW_SECONDS + 1))], runs, NOW_SECONDS);
  assert.equal(aged.status, PROVIDER_STATUS.DEGRADED);
  assert.equal(aged.detail, "no recent ONLINE observation");
  assert.equal(degraded.detail.startsWith("failing since"), true);
});

test("OFFLINE needs BOTH channels stale — no recent observation and no recent run", () => {
  const staleHealth = [healthRow("ONLINE", -(STALE_AFTER_SECONDS + 1))];
  // A recent sync run means the provider has been doing work, so it is not OFFLINE.
  const withRecentRun = assessProviderHealth(PROVIDER_ROW, staleHealth, [runRow("COMPLETED", -60)], NOW_SECONDS);
  assert.notEqual(withRecentRun.status, PROVIDER_STATUS.OFFLINE);

  const bothStale = assessProviderHealth(PROVIDER_ROW, staleHealth, [runRow("COMPLETED", -(STALE_AFTER_SECONDS + 1))], NOW_SECONDS);
  assert.equal(bothStale.status, PROVIDER_STATUS.OFFLINE);
  assert.equal(bothStale.detail, `no successful observation within ${STALE_AFTER_SECONDS}s`);

  // An unparseable observation timestamp counts as stale rather than as fresh.
  const unparseable = assessProviderHealth(PROVIDER_ROW, [{ status: "ONLINE", observed_at: "whenever" }], [], NOW_SECONDS);
  assert.equal(unparseable.status, PROVIDER_STATUS.OFFLINE);
});

test("an error rate at or above 50% across runs is DEGRADED, and the detail names the sample", () => {
  const runs = [runRow("FAILED", -60), runRow("FAILED", -120), runRow("COMPLETED", -180), runRow("COMPLETED", -240)];
  const derived = assessProviderHealth(PROVIDER_ROW, [healthRow("ONLINE", -30)], runs, NOW_SECONDS);
  // The recent ONLINE observation is rule 6, which outranks the error-rate rule only
  // when the rate is below the threshold; at exactly 50% the rate rule fires first.
  assert.equal(derived.status, PROVIDER_STATUS.DEGRADED);
  assert.equal(derived.detail, `error rate 50% over ${runs.length} runs`);
  assert.equal(DEGRADED_ERROR_RATE, 0.5);

  const healthy = assessProviderHealth(PROVIDER_ROW, [healthRow("ONLINE", -30)], [runRow("COMPLETED", -60), runRow("FAILED", -120), runRow("COMPLETED", -180)], NOW_SECONDS);
  assert.equal(healthy.status, PROVIDER_STATUS.ONLINE);
  assert.equal(healthy.detail, "last observation ONLINE");
  assert.equal(healthy.reliability, 0.6667, "the recency boost means (2/3) * 1.0, not * 0.95");
});

test("a run history with no completed or failed rows earns no reliability unless boosted", () => {
  const pending = [runRow("RUNNING", -60)];
  const plain = assessProviderHealth(PROVIDER_ROW, [healthRow("DEGRADED", -30)], pending, NOW_SECONDS);
  assert.equal(plain.reliability, 0, "no evidence, no credit");
  const boosted = assessProviderHealth(PROVIDER_ROW, [healthRow("ONLINE", -30)], pending, NOW_SECONDS);
  assert.equal(boosted.status, PROVIDER_STATUS.ONLINE);
  assert.equal(boosted.reliability, 0.5, "a provider that just answered is probably fine");
});

test("the fallback verdict is DEGRADED, because pessimism is the safe direction for a data source", () => {
  // Rule 7 needs an observation that is old enough not to be a *recent failure*
  // (rule 3, 300 s) and fresh enough not to be *stale* (rule 4, 6 h). A DEGRADED row
  // 30 seconds old is caught by rule 3 and reports "failing since", which is a
  // different — and more useful — answer.
  const derived = assessProviderHealth(PROVIDER_ROW, [healthRow("DEGRADED", -600)], [], NOW_SECONDS);
  assert.equal(derived.status, PROVIDER_STATUS.DEGRADED);
  assert.equal(derived.detail, "no recent ONLINE observation");
  const veryRecent = assessProviderHealth(PROVIDER_ROW, [healthRow("DEGRADED", -30)], [], NOW_SECONDS);
  assert.equal(veryRecent.status, PROVIDER_STATUS.DEGRADED);
  assert.match(veryRecent.detail, /^failing since /);
});

test("a future-dated observation cannot manufacture a failure, but still shadows the newest real one (SP-11)", () => {
  const derived = assessProviderHealth(
    PROVIDER_ROW,
    [healthRow("DATA_ERROR", 600), healthRow("ONLINE", -60)],
    [runRow("COMPLETED", -60)],
    NOW_SECONDS,
  );
  // The failure scan is clock-skew aware: it skips any row whose `observed_at` is
  // after `now`, so a provider whose clock is ahead cannot invent a failure. That
  // half of the assertion is the safety property.
  assert.notEqual(derived.status, PROVIDER_STATUS.DATA_ERROR);
  assert.equal(derived.detail, "no recent ONLINE observation");

  // But `latest` is `health[0]` with **no** skew guard, exactly as in legacy, so the
  // future row still shadows the real ONLINE one and rule 6 cannot fire. The result
  // is DEGRADED rather than ONLINE: wrong, but wrong in the pessimistic direction,
  // and preserving it is the rule this migration runs under. Divergence SP-11
  // records it so the asymmetry is a decision rather than an oversight — the fix is
  // a one-line guard, and it belongs in a phase whose brief is to improve rather
  // than to port.
  assert.equal(derived.status, PROVIDER_STATUS.DEGRADED);
  // Once the skewed row ages out of the future, the real observation governs.
  const settled = assessProviderHealth(PROVIDER_ROW, [healthRow("ONLINE", -60)], [runRow("COMPLETED", -60)], NOW_SECONDS);
  assert.equal(settled.status, PROVIDER_STATUS.ONLINE);
});

/* -------------------------------------------------------------------------- */
/* The service                                                                 */
/* -------------------------------------------------------------------------- */

const sportsConfig = (overrides = {}) => ({ sports: { enabled: false, mode: "SANDBOX", sandboxEnabled: false, http: { id: "http-provider", baseUrl: null, token: "", timeoutSeconds: 10 }, ...overrides } });

test("a default host registers no provider at all", async () => {
  const service = createSportsService({ config: sportsConfig(), now: () => NOW });
  const report = await service.status();
  assert.equal(report.providersConfigured, false);
  assert.deepEqual(report.providers, []);
  assert.equal(report.enabled, false);
  assert.equal(report.mode, "SANDBOX");
  assert.equal(report.isDemoData, true);
  assert.equal(report.ticketEngine, "ON_REQUEST");
  // Legacy's own wording, because it is the sentence that says nothing was invented.
  assert.equal(report.message, "No sports provider is configured. No fixtures, odds, predictions, or tickets are fabricated.");
});

test("the sandbox provider needs BOTH halves of its opt-in", async () => {
  const both = createSportsService({ config: sportsConfig({ mode: "SANDBOX", sandboxEnabled: true }), now: () => NOW });
  assert.equal((await both.status()).providersConfigured, true);
  assert.deepEqual((await both.status()).providers.map((entry) => entry.id), [SANDBOX_PROVIDER_ID]);

  // MODE defaults to SANDBOX, so mode alone would enable it on a host that set
  // nothing — which is exactly why the second variable exists (divergence SP-8).
  for (const overrides of [{ mode: "SANDBOX", sandboxEnabled: false }, { mode: "PAPER", sandboxEnabled: true }, { mode: "PRODUCTION", sandboxEnabled: true }]) {
    const service = createSportsService({ config: sportsConfig(overrides), now: () => NOW });
    assert.equal((await service.status()).providersConfigured, false, JSON.stringify(overrides));
  }
});

test("the HTTP provider is registered only when a base URL is configured", async () => {
  const configured = createSportsService({
    config: sportsConfig({ http: { id: "vendor", baseUrl: "https://feed.example.com/v1", token: "t", timeoutSeconds: 10 } }),
    now: () => NOW,
  });
  const report = await configured.status();
  assert.deepEqual(report.providers.map((entry) => entry.id), ["vendor"]);
  assert.equal(report.providers[0].kind, "http");
  assert.equal(report.providers[0].simulated, false);
  assert.equal(report.providers[0].verifiedAgainstProvider, false, "no adapter here has ever spoken to its provider");
  assert.equal(JSON.stringify(report).includes("feed.example.com"), false, "the base URL is not reported");
  assert.equal(JSON.stringify(report).includes('"t"'), false, "nor the token");

  const sandboxAndHttp = createSportsService({
    config: sportsConfig({ sandboxEnabled: true, http: { id: "vendor", baseUrl: "https://feed.example.com", token: "", timeoutSeconds: 10 } }),
    now: () => NOW,
  });
  assert.deepEqual((await sandboxAndHttp.status()).providers.map((entry) => entry.id), [SANDBOX_PROVIDER_ID, "vendor"]);
});

test("derived health is UNKNOWN with nothing stored, and status() does not probe", async () => {
  let probed = 0;
  const service = createSportsService({
    config: sportsConfig({ sandboxEnabled: true }),
    now: () => NOW,
    transport: async () => {
      probed += 1;
      return { status: 200, body: "[]" };
    },
  });
  const report = await service.status();
  assert.equal(probed, 0, "the default status performs no outbound I/O");
  assert.equal(report.probed, false);
  assert.equal(report.liveHealth, null);
  assert.equal(report.providers[0].derivedStatus, PROVIDER_STATUS.UNKNOWN);
  assert.equal(report.providers[0].detail, "no observations yet");
});

test("probe: true performs a live reading and stamps it as not persisted", async () => {
  const service = createSportsService({ config: sportsConfig({ sandboxEnabled: true }), now: () => NOW });
  const report = await service.status({ probe: true });
  assert.equal(report.probed, true);
  assert.equal(report.persisted, false, "a reading with no history behind it must not look like an observation");
  assert.equal(report.liveHealth[SANDBOX_PROVIDER_ID].status, PROVIDER_STATUS.ONLINE);
  assert.equal(report.liveHealth[SANDBOX_PROVIDER_ID].simulated, undefined, "live health is the provider's own report");
});

test("the not-ported matrix names every slice row 14 still owes", async () => {
  const service = createSportsService({ config: sportsConfig(), now: () => NOW });
  const report = await service.status();
  assert.equal(report.notPorted, SPORTS_NOT_PORTED);
  // Six, down from seven. Phase 16 removed ingestion, slice 3 removed predictions and the
  // configuration service, and slice 4 removed correlation and ticket governance, which now
  // exist. Asserting the count moved DOWN is the point:
  // a matrix that only ever grows is a matrix nobody checks for entries that are no longer true.
  assert.equal(SPORTS_NOT_PORTED.length, 6);
  const areas = SPORTS_NOT_PORTED.map((entry) => entry.area).join(" | ");
  for (const expected of ["stake sizing", "settlement", "calibration", "backtesting", "model monitoring", "dashboards"]) {
    assert.match(areas, new RegExp(expected, "i"), `the matrix must name ${expected}`);
  }
  for (const entry of SPORTS_NOT_PORTED) {
    assert.ok(entry.legacy && entry.state && entry.detail, `${entry.area} must name its legacy class and its state`);
    assert.notEqual(entry.state, "ported", "this matrix lists what is NOT ported");
    // And ingestion is no longer in it at all — not re-labelled, removed.
    assert.ok(!/ingestion/i.test(entry.area), "ingestion is ported and must not appear in a not-ported matrix");
  }
  // NV-6's last remaining type is named here, so a reader of the API can see why it
  // is still unpublished rather than having to find the migration doc.
  assert.match(SPORTS_NOT_PORTED.find((entry) => entry.area === "model monitoring").detail, /SPORTS_MODEL_DRIFT/);
});

test("statusSnapshot() is synchronous, probe-free and reports configuration only", () => {
  let probed = 0;
  const service = createSportsService({
    config: sportsConfig({ enabled: true, sandboxEnabled: true }),
    now: () => NOW,
    transport: async () => {
      probed += 1;
      return { status: 200, body: "[]" };
    },
  });
  const snapshot = service.statusSnapshot();
  assert.equal(probed, 0);
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.mode, "SANDBOX");
  assert.equal(snapshot.isDemoData, true);
  assert.equal(snapshot.providersConfigured, true);
  assert.deepEqual(snapshot.providerIds, [SANDBOX_PROVIDER_ID]);
  assert.equal(snapshot.simulatedProviders, 1);
  assert.equal(snapshot.persistence, false, "stated as a fact about this slice, not implied by empty arrays");
  assert.equal(snapshot.notPortedAreas, SPORTS_NOT_PORTED.length);
  assert.equal(snapshot.ticketEngine, "ON_REQUEST");
  assert.equal(snapshot.derivedStatus, undefined, "no derived health on a surface that has witnessed nothing");
  assert.match(snapshot.reason, /GET \/api\/v1\/sports\/status/);
  // Deep-freeze: the snapshot is embedded in an unauthenticated response.
  assert.throws(() => {
    snapshot.mode = "PRODUCTION";
  });
});

/* -------------------------------------------------------------------------- */
/* The engines, beyond what parity pins                                        */
/* -------------------------------------------------------------------------- */

test("the quality engine's weights make odds the single heaviest missing input", () => {
  const fixture = { externalId: "FX", homeTeam: "A", awayTeam: "B", competition: "C", kickoff: "2026-01-01T00:00:00Z" };
  const full = assessQuality(fixture, { oddsAvailable: true, recentFormAvailable: true, providerReliability: 1, dataAgeSeconds: 0 });
  assert.equal(full.score, 100);
  assert.equal(full.band, "EXCELLENT");
  assert.equal(full.eligibleForTicket, true);

  const noOdds = assessQuality(fixture, { oddsAvailable: false, recentFormAvailable: true, providerReliability: 1, dataAgeSeconds: 0 });
  const noForm = assessQuality(fixture, { oddsAvailable: true, recentFormAvailable: false, providerReliability: 1, dataAgeSeconds: 0 });
  assert.ok(noOdds.score < noForm.score, "missing odds costs more than missing form");
  assert.equal(noOdds.band, "GOOD", "18 of 108 points is enough to leave EXCELLENT but not eligibility");
  assert.equal(noOdds.eligibleForTicket, true);
  assert.deepEqual(noOdds.missing, ["odds"]);
});

test("the quality engine's checks array is the evidence behind the score", () => {
  const assessment = assessQuality({ externalId: "FX" }, {});
  assert.equal(assessment.checks.length, 9);
  assert.equal(assessment.checks.reduce((total, check) => total + check.weight, 0), 108);
  for (const check of assessment.checks) {
    assert.equal(typeof check.ok, "boolean");
    assert.equal(typeof check.weight, "number");
  }
  // Five required fixture fields, then the four context checks — the order is
  // observable because `missing` is derived from it.
  assert.deepEqual(assessment.checks.map((check) => check.field), [
    "externalId", "homeTeam", "awayTeam", "competition", "kickoff",
    "odds", "recentForm", "providerReliability", "freshness",
  ]);
  assert.deepEqual(assessment.missing, ["homeTeam", "awayTeam", "competition", "kickoff", "odds", "recentForm", "providerReliability", "freshness"]);
  assert.equal(assessment.band, "REJECT");
  assert.equal(assessment.eligibleForPrediction, false);
});

test("freshness scores decay linearly and hit zero exactly at the limit", () => {
  const at = (age) => assessOddsFreshness({ observedAt: iso(-age) }, 900, NOW_SECONDS);
  assert.equal(at(0).score, 100);
  assert.equal(at(450).score, 50);
  assert.equal(at(900).score, 0, "fresh at the limit, but the score has decayed to nothing");
  assert.equal(at(900).fresh, true);
  assert.equal(at(901).fresh, false);
  assert.equal(at(901).score, 0);
  assert.equal(at(901).reason, "STALE_ODDS");
});

test("the normalizer refuses a payload that is not an object at all", () => {
  for (const value of [null, undefined, "a string", 42, true]) {
    assert.throws(() => normalizeFixture(value, "p", { now: () => NOW }), /fixture missing externalId/);
    assert.throws(() => normalizeOdds(value, "p", { now: () => NOW }), /odds missing market/);
  }
});

test("a sandbox fixture passes the normalizer and stays labelled simulated", async () => {
  const sandbox = createSandboxSportsProvider({ mode: "SANDBOX", sandboxEnabled: true, now: () => NOW });
  const [raw] = await sandbox.fixtures({ from: "2025-01-04", to: "2025-01-04" });
  const normalized = normalizeFixture(raw, sandbox.id(), { now: () => NOW });
  assert.equal(normalized.simulated, true);
  assert.equal(normalized.status, "FINISHED");
  assert.ok(normalized.context.recentForm, "the sandbox supplies all four form rates, so the block survives");
  assert.equal(normalized.context.recentForm.source, "sandbox-sim:simulated-form");

  const [odds] = await sandbox.odds(raw.externalId);
  const normalizedOdds = normalizeOdds(odds, sandbox.id(), { now: () => NOW });
  assert.ok(normalizedOdds.decimalOdds > 1.0);
  assert.equal(normalizedOdds.market, "TOTAL_GOALS");

  // And the two engines accept the result, which is the whole point of the slice:
  // the pipeline from provider to eligibility verdict runs end to end with no I/O.
  const assessment = assessQuality(normalized, {
    oddsAvailable: true,
    recentFormAvailable: Boolean(normalized.context?.recentForm),
    providerReliability: (await sandbox.health()).reliability,
    dataAgeSeconds: 0,
  });
  assert.equal(assessment.eligibleForPrediction, true);
  assert.equal(assessment.band, "EXCELLENT");
});
