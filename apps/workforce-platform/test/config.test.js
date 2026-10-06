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
