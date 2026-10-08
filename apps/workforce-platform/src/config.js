import path from "node:path";
import { buildCsp, parseAllowedOrigins } from "./security/headers.js";

const LOG_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const SUPPORTED_STORAGE_ADAPTERS = Object.freeze(["auto", "mysql", "file"]);

/**
 * Resolved lazily so a caller (or test) can point WF_APP_ROOT at a scratch
 * directory before the first config load.
 */
function appRoot() {
  return process.env.WF_APP_ROOT || process.cwd();
}

function absoluteFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(appRoot(), value);
}


export function assertSupportedNodeVersion(version = process.versions.node) {
  const parts = String(version).replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10));
  const [major, minor] = parts;
  const supported = parts.length >= 2 && parts.every(Number.isSafeInteger)
    && ((major === 22 && minor >= 20) || major === 23 || major === 24);
  if (!supported) throw new Error("Node.js >=22.20.0 <25 is required");
}

function required(env, keys) {
  const missing = keys.filter((key) => typeof env[key] !== "string" || env[key].length === 0);
  if (missing.length) throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
}

function integer(value, name, { fallback, min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function boolean(value, name, fallback = false) {
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes"].includes(String(value).toLowerCase())) return true;
  if (["0", "false", "no"].includes(String(value).toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

function prefixedDatabaseConfig(env, prefix) {
  const keys = ["HOST", "NAME", "USER", "PASSWORD"].map((key) => `${prefix}${key}`);
  required(env, keys);
  return Object.freeze({
    host: env[`${prefix}HOST`],
    port: integer(env[`${prefix}PORT`], `${prefix}PORT`, { fallback: 3306, max: 65535 }),
    database: env[`${prefix}NAME`],
    user: env[`${prefix}USER`],
    password: env[`${prefix}PASSWORD`],
    connectionLimit: integer(env[`${prefix}CONNECTION_LIMIT`], `${prefix}CONNECTION_LIMIT`, { fallback: 5, max: 20 }),
  });
}

export function loadDatabaseConfig(env = process.env) {
  return prefixedDatabaseConfig(env, "DB_");
}

// Used only by the one-shot legacy identity import CLI; do not add these
// credentials to the long-running Passenger application's environment.
export function loadLegacyDatabaseConfig(env = process.env) {
  return prefixedDatabaseConfig(env, "LEGACY_DB_");
}

export function databaseConfigured(env) {
  return ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"].some((key) => typeof env[key] === "string" && env[key].length > 0);
}

function loadStorageConfig(env, { production, hasDatabase }) {
  const requested = env.STORAGE_ADAPTER || "auto";
  if (!SUPPORTED_STORAGE_ADAPTERS.includes(requested)) {
    throw new Error(`STORAGE_ADAPTER must be one of: ${SUPPORTED_STORAGE_ADAPTERS.join(", ")}`);
  }
  if (requested === "mysql" && !hasDatabase) {
    throw new Error("STORAGE_ADAPTER=mysql requires DB_HOST, DB_NAME, DB_USER and DB_PASSWORD");
  }
  const adapter = requested === "auto" ? (hasDatabase ? "mysql" : "file") : requested;
  if (adapter === "file" && production) {
    // Allowed only with an explicit acknowledgement; the adapter has no
    // transactions and no cross-process locking (see persistence/file-store.js).
    const acknowledged = ["1", "true", "yes"].includes(String(env.ALLOW_FILE_STORE_IN_PRODUCTION || "").toLowerCase());
    if (!acknowledged && requested === "file") {
      throw new Error("STORAGE_ADAPTER=file is not approved for production; use MySQL or set ALLOW_FILE_STORE_IN_PRODUCTION=1");
    }
  }
  const fileDir = env.STORAGE_DIR || absoluteFromRoot(production ? path.join("data", "store") : path.join(".data", "store"));
  return Object.freeze({
    adapter,
    requested,
    fileDir: path.resolve(fileDir),
    allowFileStoreInProduction: ["1", "true", "yes"].includes(String(env.ALLOW_FILE_STORE_IN_PRODUCTION || "").toLowerCase()),
  });
}

function loadUploadConfig(env, { production }) {
  const maxBytes = integer(env.UPLOAD_MAX_BYTES, "UPLOAD_MAX_BYTES", {
    fallback: 2 * 1024 * 1024,
    min: 1024,
    max: 10 * 1024 * 1024,
  });
  const directory = env.UPLOAD_DIR || absoluteFromRoot(path.join("data", "uploads"));
  return Object.freeze({
    enabled: boolean(env.UPLOADS_ENABLED, "UPLOADS_ENABLED", true),
    maxBytes,
    bodyLimitBytes: integer(env.UPLOAD_BODY_LIMIT_BYTES, "UPLOAD_BODY_LIMIT_BYTES", {
      fallback: Math.min(maxBytes + 64 * 1024, 10 * 1024 * 1024 + 64 * 1024),
      min: 32 * 1024,
      max: 16 * 1024 * 1024,
    }),
    dir: path.resolve(directory),
    // Avatars are private: the only read path is the authorized API route, so the
    // URL handed to clients must be that route (a /files/... path would 404).
    publicPathPrefix: "/api/v1/files/avatars",
    cacheSeconds: integer(env.UPLOAD_CACHE_SECONDS, "UPLOAD_CACHE_SECONDS", { fallback: 300, min: 0, max: 31536000 }),
    requireSecureInProduction: production,
  });
}

function loadRateLimitConfig(env) {
  return Object.freeze({
    enabled: boolean(env.RATE_LIMIT_ENABLED, "RATE_LIMIT_ENABLED", true),
    api: {
      max: integer(env.RATE_LIMIT_API_MAX, "RATE_LIMIT_API_MAX", { fallback: 120, min: 1, max: 100_000 }),
      windowMs: integer(env.RATE_LIMIT_API_WINDOW_MS, "RATE_LIMIT_API_WINDOW_MS", { fallback: 60_000, min: 1_000, max: 3_600_000 }),
    },
    login: {
      max: integer(env.RATE_LIMIT_LOGIN_MAX, "RATE_LIMIT_LOGIN_MAX", { fallback: 5, min: 1, max: 1_000 }),
      windowMs: integer(env.RATE_LIMIT_LOGIN_WINDOW_MS, "RATE_LIMIT_LOGIN_WINDOW_MS", { fallback: 60_000, min: 1_000, max: 3_600_000 }),
    },
    lockout: {
      failures: integer(env.LOGIN_LOCKOUT_FAILURES, "LOGIN_LOCKOUT_FAILURES", { fallback: 5, min: 1, max: 1_000 }),
      lockMs: integer(env.LOGIN_LOCKOUT_MS, "LOGIN_LOCKOUT_MS", { fallback: 15 * 60_000, min: 1_000, max: 24 * 3_600_000 }),
    },
    maxEntries: integer(env.RATE_LIMIT_MAX_ENTRIES, "RATE_LIMIT_MAX_ENTRIES", { fallback: 20_000, min: 100, max: 1_000_000 }),
  });
}

function loadSiteConfig(env) {
  const raw = env.SITE_NAME || "WINDELS AI WORKFORCE";
  return Object.freeze({
    name: raw.slice(0, 120),
    description: (env.SITE_DESCRIPTION || "Research, learning and operational tools with clear guardrails.").slice(0, 300),
    titleSuffix: (env.SITE_TITLE_SUFFIX || "").slice(0, 60),
    themeColor: /^#[0-9a-fA-F]{6}$/.test(env.THEME_COLOR || "") ? env.THEME_COLOR : "#071511",
    robots: ["index, follow", "noindex, follow", "index, nofollow", "noindex, nofollow"].includes(env.ROBOTS) ? env.ROBOTS : "index, follow",
    keywords: (env.SITE_KEYWORDS || "").slice(0, 500),
  });
}

export function loadConfig(env = process.env) {
  assertSupportedNodeVersion();
  const mode = env.NODE_ENV || "development";
  if (!["development", "test", "production"].includes(mode)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }

  const hasDatabase = databaseConfigured(env);
  const database = hasDatabase ? loadDatabaseConfig(env) : null;
  const storage = loadStorageConfig(env, { production: mode === "production", hasDatabase });

  required(env, ["SESSION_SECRET"]);
  if (Buffer.byteLength(env.SESSION_SECRET, "utf8") < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 bytes");
  }

  const production = mode === "production";
  let publicBaseUrl = null;
  if (env.PUBLIC_BASE_URL) {
    let parsed;
    try {
      parsed = new URL(env.PUBLIC_BASE_URL);
    } catch {
      throw new Error("PUBLIC_BASE_URL must be a valid HTTPS origin");
    }
    const localHttpAllowed = !production && parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if ((parsed.protocol !== "https:" && !localHttpAllowed) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("PUBLIC_BASE_URL must be an HTTPS origin (HTTP is allowed only on local development hosts), without credentials, path, query, or fragment");
    }
    publicBaseUrl = parsed.origin;
  }
  if (production && !publicBaseUrl) {
    throw new Error("PUBLIC_BASE_URL is required in production");
  }

  const logLevel = env.LOG_LEVEL || (production ? "info" : "debug");
  if (!LOG_LEVELS.has(logLevel)) throw new Error("LOG_LEVEL is not supported");

  // A wildcard in the raw value is refused here rather than silently dropped:
  // `CORS_ALLOWED_ORIGINS=*` with credentials is the single worst CORS mistake.
  if (/(^|,)\s*\*\s*(,|$)/.test(String(env.CORS_ALLOWED_ORIGINS || ""))) {
    throw new Error("CORS_ALLOWED_ORIGINS must list explicit origins; * is not accepted");
  }
  const corsAllowedOrigins = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
  if (String(env.CORS_ALLOWED_ORIGINS || "").trim() && corsAllowedOrigins.length === 0) {
    throw new Error("CORS_ALLOWED_ORIGINS contains no usable origin (each entry must be an http(s) origin with no path)");
  }
  if (corsAllowedOrigins.some((origin) => origin.startsWith("http:")) && production) {
    throw new Error("CORS_ALLOWED_ORIGINS must use HTTPS origins in production");
  }

  const bodyLimitBytes = integer(env.BODY_LIMIT_BYTES, "BODY_LIMIT_BYTES", { fallback: 16 * 1024, min: 1024, max: 1024 * 1024 });
  const requestTimeoutMs = integer(env.REQUEST_TIMEOUT_MS, "REQUEST_TIMEOUT_MS", { fallback: 20_000, min: 1_000, max: 120_000 });

  return Object.freeze({
    mode,
    production,
    host: env.HOST || "0.0.0.0",
    port: integer(env.PORT, "PORT", { fallback: 3000, max: 65535 }),
    logLevel,
    database,
    storage,
    site: loadSiteConfig(env),
    uploads: loadUploadConfig(env, { production }),
    rateLimit: loadRateLimitConfig(env),
    sessionSecret: env.SESSION_SECRET,
    sessionTtlSeconds: integer(env.SESSION_TTL_SECONDS, "SESSION_TTL_SECONDS", {
      fallback: 8 * 60 * 60,
      min: 300,
      max: 7 * 24 * 60 * 60,
    }),
    cookieName: production ? "__Host-wf_session" : "wf_session",
    secureCookie: production || boolean(env.COOKIE_SECURE, "COOKIE_SECURE"),
    trustProxy: boolean(env.TRUST_PROXY, "TRUST_PROXY", false),
    publicBaseUrl,
    corsAllowedOrigins: Object.freeze(corsAllowedOrigins),
    contentSecurityPolicy: buildCsp({ unsafeInline: !production && ["1", "true"].includes(String(env.CSP_UNSAFE_INLINE || "").toLowerCase()) }),
    bodyLimitBytes,
    requestTimeoutMs,
    // Password policy preserved from the PHP application: 12 characters minimum.
    passwordMinLength: integer(env.PASSWORD_MIN_LENGTH, "PASSWORD_MIN_LENGTH", { fallback: 12, min: 8, max: 64 }),
    usernameMinLength: 3,
    usernameMaxLength: 20,
    adminPasswordMinLength: integer(env.ADMIN_PASSWORD_MIN_LENGTH, "ADMIN_PASSWORD_MIN_LENGTH", { fallback: 14, min: 12, max: 64 }),
  });
}
