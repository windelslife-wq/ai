import test from "node:test";
import assert from "node:assert/strict";
import { assertSupportedNodeVersion, loadConfig, loadDatabaseConfig, loadLegacyDatabaseConfig } from "../src/config.js";

function validEnv(overrides = {}) {
  return {
    NODE_ENV: "production",
    DB_HOST: "localhost",
    DB_NAME: "windels",
    DB_USER: "app_user",
    DB_PASSWORD: "db-password",
    DB_PORT: "3306",
    SESSION_SECRET: "a-secure-session-secret-at-least-32-bytes-long",
    PUBLIC_BASE_URL: "https://node.example.test",
    TRUST_PROXY: "true",
    ...overrides,
  };
}

test("runtime enforcement accepts Node 22.20 through 24 and rejects out-of-range versions", () => {
  assert.doesNotThrow(() => assertSupportedNodeVersion("22.20.0"));
  assert.doesNotThrow(() => assertSupportedNodeVersion("23.9.1"));
  assert.doesNotThrow(() => assertSupportedNodeVersion("24.0.0"));
  assert.throws(() => assertSupportedNodeVersion("22.19.9"), /Node.js >=22.20.0 <25/);
  assert.throws(() => assertSupportedNodeVersion("25.0.0"), /Node.js >=22.20.0 <25/);
});

test("production config accepts an HTTPS origin and binds the cPanel-provided port", () => {
  const config = loadConfig(validEnv({ PORT: "49231" }));
  assert.equal(config.port, 49231);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.production, true);
  assert.equal(config.secureCookie, true);
  assert.equal(config.trustProxy, true);
  assert.equal(config.cookieName, "__Host-wf_session");
  assert.equal(config.publicBaseUrl, "https://node.example.test");
});

test("production requires a strong session secret and HTTPS public origin", () => {
  assert.throws(() => loadConfig(validEnv({ SESSION_SECRET: "short" })), /at least 32 bytes/);
  assert.throws(() => loadConfig(validEnv({ PUBLIC_BASE_URL: "http://node.example.test" })), /HTTPS origin/);
  assert.throws(() => loadConfig(validEnv({ PUBLIC_BASE_URL: undefined })), /required in production/);
});

test("database settings are required and bounded", () => {
  assert.throws(() => loadDatabaseConfig({ DB_HOST: "localhost" }), /DB_NAME, DB_USER, DB_PASSWORD/);
  assert.throws(() => loadDatabaseConfig(validEnv({ DB_CONNECTION_LIMIT: "100" })), /DB_CONNECTION_LIMIT/);
  assert.throws(() => loadConfig(validEnv({ PORT: "0" })), /PORT must be an integer/);
});

test("development mode still uses explicit secrets but allows an HTTP-local origin", () => {
  const config = loadConfig(validEnv({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "http://localhost:3000",
    COOKIE_SECURE: "false",
    TRUST_PROXY: "false",
  }));
  assert.equal(config.production, false);
  assert.equal(config.secureCookie, false);
  assert.equal(config.cookieName, "wf_session");
});

test("legacy database credentials are a separate, prefixed CLI-only configuration", () => {
  const env = {
    LEGACY_DB_HOST: "legacy-db",
    LEGACY_DB_NAME: "legacy_aegis",
    LEGACY_DB_USER: "readonly_user",
    LEGACY_DB_PASSWORD: "legacy-secret",
    LEGACY_DB_CONNECTION_LIMIT: "2",
  };
  const config = loadLegacyDatabaseConfig(env);
  assert.deepEqual(config, {
    host: "legacy-db",
    port: 3306,
    database: "legacy_aegis",
    user: "readonly_user",
    password: "legacy-secret",
    connectionLimit: 2,
  });
  assert.throws(() => loadLegacyDatabaseConfig({}), /LEGACY_DB_HOST, LEGACY_DB_NAME, LEGACY_DB_USER, LEGACY_DB_PASSWORD/);
});

test("R-26: analysis carries its own work limits, tighter for a scan than for a run", () => {
  const config = loadConfig(validEnv());
  const { rateLimit } = config;

  // The shipped defaults are the real production ceiling, so they are pinned here
  // rather than left to whatever a test harness happens to override.
  assert.deepEqual(rateLimit.analysisRun, { max: 12, windowMs: 600_000 });
  assert.deepEqual(rateLimit.analysisConsensus, { max: 4, windowMs: 600_000 });
  assert.equal(rateLimit.analysisMaxConcurrentRuns, 2);

  // A scan is up to ten runs, so it must be the tighter of the two budgets.
  assert.ok(rateLimit.analysisConsensus.max < rateLimit.analysisRun.max);
  assert.equal(rateLimit.analysisRun.windowMs, rateLimit.analysisConsensus.windowMs);

  // Worst case per window: 12 runs at up to 8 upstream series each, plus 4 scans of
  // up to 10 symbols. Before R-26 the only bound was 120 requests/minute against
  // the global API limiter, which counts requests and not the work each triggers.
  const worstCaseSeries = rateLimit.analysisRun.max * 8 + rateLimit.analysisConsensus.max * 10 * 8;
  assert.equal(worstCaseSeries, 416);
  assert.ok(worstCaseSeries < 120 * 8, "far below what the global limiter alone allowed");

  // Every knob is operator-tunable, and 0 disables the concurrency cap exactly as
  // MAX_REQUESTS_PER_CLIENT does — "off", never "refuse everything".
  const tuned = loadConfig(validEnv({
    RATE_LIMIT_ANALYSIS_RUN_MAX: "30",
    RATE_LIMIT_ANALYSIS_RUN_WINDOW_MS: "60000",
    RATE_LIMIT_ANALYSIS_CONSENSUS_MAX: "10",
    RATE_LIMIT_ANALYSIS_CONSENSUS_WINDOW_MS: "120000",
    ANALYSIS_MAX_CONCURRENT_RUNS: "0",
  }));
  assert.deepEqual(tuned.rateLimit.analysisRun, { max: 30, windowMs: 60_000 });
  assert.deepEqual(tuned.rateLimit.analysisConsensus, { max: 10, windowMs: 120_000 });
  assert.equal(tuned.rateLimit.analysisMaxConcurrentRuns, 0);

  // Out-of-range values are refused rather than silently clamped, matching every
  // other limit in this file.
  assert.throws(() => loadConfig(validEnv({ RATE_LIMIT_ANALYSIS_RUN_MAX: "0" })), /RATE_LIMIT_ANALYSIS_RUN_MAX/);
  assert.throws(() => loadConfig(validEnv({ ANALYSIS_MAX_CONCURRENT_RUNS: "-1" })), /ANALYSIS_MAX_CONCURRENT_RUNS/);
  assert.throws(() => loadConfig(validEnv({ RATE_LIMIT_ANALYSIS_CONSENSUS_WINDOW_MS: "10" })), /RATE_LIMIT_ANALYSIS_CONSENSUS_WINDOW_MS/);
});
