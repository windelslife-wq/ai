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
    /**
     * Analysis is the most expensive authenticated surface on the platform (R-26):
     * one run fetches up to 8 upstream series — a forex or commodity run also
     * fetches seven reference legs — and one consensus scan is up to 10 runs, so a
     * 10-symbol scan can fan out into ~80 provider calls. The global `api` limiter
     * bounds *requests*; these bound *work*.
     *
     * The window limits ride the existing per-route mechanism (keyed by client
     * address, checked before validation, so a refused request still counts and
     * cannot be used to hammer the contract for free). The concurrency cap is
     * per-session and lives in the analysis routes; `0` disables it, matching the
     * `MAX_REQUESTS_PER_CLIENT` convention.
     */
    analysisRun: {
      max: integer(env.RATE_LIMIT_ANALYSIS_RUN_MAX, "RATE_LIMIT_ANALYSIS_RUN_MAX", { fallback: 12, min: 1, max: 10_000 }),
      windowMs: integer(env.RATE_LIMIT_ANALYSIS_RUN_WINDOW_MS, "RATE_LIMIT_ANALYSIS_RUN_WINDOW_MS", { fallback: 600_000, min: 1_000, max: 24 * 3_600_000 }),
    },
    analysisConsensus: {
      max: integer(env.RATE_LIMIT_ANALYSIS_CONSENSUS_MAX, "RATE_LIMIT_ANALYSIS_CONSENSUS_MAX", { fallback: 4, min: 1, max: 10_000 }),
      windowMs: integer(env.RATE_LIMIT_ANALYSIS_CONSENSUS_WINDOW_MS, "RATE_LIMIT_ANALYSIS_CONSENSUS_WINDOW_MS", { fallback: 600_000, min: 1_000, max: 24 * 3_600_000 }),
    },
    analysisMaxConcurrentRuns: integer(env.ANALYSIS_MAX_CONCURRENT_RUNS, "ANALYSIS_MAX_CONCURRENT_RUNS", { fallback: 2, min: 0, max: 100 }),
  });
}

/**
 * Public-site identity and SEO settings (finding F-10).
 *
 * These drive the rendered public pages, `/robots.txt`, `/sitemap.xml` and
 * `/manifest.webmanifest`, so every value is validated here rather than in a
 * template: a metadata field that accepted any string would be an injection
 * point into every page head.
 *
 * Legacy parity: the PHP application reads the same settings from
 * `application/config/seo.php` (`VP_SITE_NAME`, `VP_SITE_DESCRIPTION`,
 * `VP_SITE_KEYWORDS`, `VP_ROBOTS`, `VP_BASE_URL`, `VP_OG_IMAGE`,
 * `VP_THEME_COLOR`). The Node names drop the `VP_` prefix but keep the
 * semantics, including the default title suffix and the robots vocabulary.
 */
const ROBOTS_VALUES = Object.freeze(["index, follow", "noindex, follow", "index, nofollow", "noindex, nofollow"]);

function loadSiteConfig(env, { production, publicBaseUrl }) {
  const name = (env.SITE_NAME || "WINDELS AI WORKFORCE").slice(0, 120);
  const description = (env.SITE_DESCRIPTION
    || "WINDELS AI WORKFORCE — research, learning and operational tools in one governed workspace. Evidence-first, audited and fail-closed.").slice(0, 300);
  const canonicalBase = publicBaseUrl || null;

  // The Open Graph image must be an absolute URL to be usable by a crawler. When
  // no canonical origin is configured (development) it stays null and the page
  // head omits the tag instead of publishing a relative or invented URL.
  let ogImage = null;
  if (env.SITE_OG_IMAGE) {
    let parsed = null;
    try {
      parsed = new URL(env.SITE_OG_IMAGE);
    } catch {
      throw new Error("SITE_OG_IMAGE must be an absolute https:// URL to the shared image");
    }
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && !production)) {
      throw new Error("SITE_OG_IMAGE must use https:// in production");
    }
    ogImage = parsed.href;
  } else if (canonicalBase) {
    ogImage = `${canonicalBase}/icons/icon-512.png`;
  }

  const announcement = String(env.SITE_ANNOUNCEMENT || "")
    .split("|")
    .map((entry) => entry.trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, 3);

  return Object.freeze({
    name,
    description,
    titleSuffix: (env.SITE_TITLE_SUFFIX === undefined ? ` · ${name}` : env.SITE_TITLE_SUFFIX).slice(0, 60),
    themeColor: /^#[0-9a-fA-F]{6}$/.test(env.THEME_COLOR || "") ? env.THEME_COLOR.toLowerCase() : "#071511",
    backgroundColor: /^#[0-9a-fA-F]{6}$/.test(env.SITE_BACKGROUND_COLOR || "") ? env.SITE_BACKGROUND_COLOR.toLowerCase() : "#071511",
    robots: ROBOTS_VALUES.includes(env.ROBOTS) ? env.ROBOTS : "index, follow",
    keywords: (env.SITE_KEYWORDS || "WINDELS AI Workforce, AI workforce, language learning, market intelligence, sports research, lottery analysis, lead discovery").slice(0, 500),
    canonicalBase,
    ogImage,
    announcement: Object.freeze(announcement),
    /**
     * The legacy public pages quote the size of the authored language-teacher
     * registry (`count($this->platform->langlearn->languages())` → 20). Language
     * learning is not ported to this platform, so there is no registry to count:
     * the number is a stated configuration value describing the product, and the
     * parity ledger records exactly that. Set it to 0 to drop the claim.
     */
    languageCount: integer(env.SITE_LANGUAGE_COUNT, "SITE_LANGUAGE_COUNT", { fallback: 20, min: 0, max: 500 }),
    contact: Object.freeze({
      // A public, unauthenticated write endpoint: the limit is per client address
      // and deliberately tight, and the accepted message length matches the legacy
      // form (10..2000 characters).
      maxPerWindow: integer(env.CONTACT_MAX_PER_HOUR, "CONTACT_MAX_PER_HOUR", { fallback: 3, min: 1, max: 1_000 }),
      windowMs: integer(env.CONTACT_WINDOW_MS, "CONTACT_WINDOW_MS", { fallback: 3_600_000, min: 60_000, max: 86_400_000 }),
      messageMinLength: 10,
      messageMaxLength: 2_000,
    }),
  });
}

/**
 * Market-data provider configuration (module: marketData).
 *
 * Legacy parity: `Aegis\Platform` registers Binance, Frankfurter/ECB, four inert
 * licensed-asset adapters and — always last — the synthetic demo provider. The
 * environment names for the licensed adapters keep their legacy `AEGIS_*_DATA_*`
 * spelling on purpose: a host that already has them set keeps working at cutover.
 *
 * Two honesty switches matter more than the rest:
 *  - `MARKET_DATA_REAL_PROVIDERS=0` registers the synthetic provider alone
 *    (the legacy `$disableRealProviders` flag used by the dev runtime and tests);
 *  - `MARKET_DATA_ALLOW_SYNTHETIC=0` refuses to serve simulated data at all, so a
 *    host that must never show a synthetic candle can say so and get an error
 *    instead of a fallback.
 */
const LICENSED_ASSET_CLASSES = Object.freeze([
  { assetClass: "stock", envPrefix: "AEGIS_STOCK_DATA", displayName: "Licensed stock data", priority: 30 },
  { assetClass: "etf", envPrefix: "AEGIS_ETF_DATA", displayName: "Licensed ETF data", priority: 31 },
  { assetClass: "futures", envPrefix: "AEGIS_FUTURES_DATA", displayName: "Licensed futures data", priority: 32 },
  { assetClass: "options", envPrefix: "AEGIS_OPTIONS_DATA", displayName: "Licensed options data", priority: 33 },
]);

function httpsBaseUrl(value, name, { production, optional = true }) {
  const raw = String(value || "").trim();
  if (!raw) {
    if (optional) return null;
    throw new Error(`${name} is required`);
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && !production)) {
    throw new Error(`${name} must use https:// in production`);
  }
  if (parsed.username || parsed.password) throw new Error(`${name} must not contain credentials`);
  return parsed.origin;
}

function symbolList(value) {
  return Object.freeze(String(value || "")
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 500));
}

function loadMarketDataConfig(env, { production }) {
  const licensed = LICENSED_ASSET_CLASSES.map((entry) => Object.freeze({
    ...entry,
    baseUrl: httpsBaseUrl(env[`${entry.envPrefix}_URL`], `${entry.envPrefix}_URL`, { production }),
    healthUrl: httpsBaseUrl(env[`${entry.envPrefix}_HEALTH_URL`], `${entry.envPrefix}_HEALTH_URL`, { production }),
    token: String(env[`${entry.envPrefix}_TOKEN`] || "").trim(),
    license: String(env[`${entry.envPrefix}_LICENSE`] || "").trim(),
    enabled: boolean(env[`${entry.envPrefix}_ENABLED`], `${entry.envPrefix}_ENABLED`, false),
    // Legacy rule: delayed unless the host says `_DELAYED=0` explicitly.
    delayed: String(env[`${entry.envPrefix}_DELAYED`] || "").trim() !== "0",
    symbols: symbolList(env[`${entry.envPrefix}_SYMBOLS`]),
  }));

  return Object.freeze({
    realProviders: boolean(env.MARKET_DATA_REAL_PROVIDERS, "MARKET_DATA_REAL_PROVIDERS", true),
    allowSynthetic: boolean(env.MARKET_DATA_ALLOW_SYNTHETIC, "MARKET_DATA_ALLOW_SYNTHETIC", true),
    timeoutMs: integer(env.MARKET_DATA_TIMEOUT_MS, "MARKET_DATA_TIMEOUT_MS", { fallback: 6_000, min: 500, max: 30_000 }),
    retries: integer(env.MARKET_DATA_RETRIES, "MARKET_DATA_RETRIES", { fallback: 2, min: 0, max: 5 }),
    // Hardening added during the port: the legacy manager had no overall budget,
    // so a host with no outbound access stacked one provider timeout after
    // another. Every request — including health probes — now dies inside this
    // window and reports the honest failure instead of hanging.
    deadlineMs: integer(env.MARKET_DATA_DEADLINE_MS, "MARKET_DATA_DEADLINE_MS", { fallback: 15_000, min: 1_000, max: 120_000 }),
    healthTimeoutMs: integer(env.MARKET_DATA_HEALTH_TIMEOUT_MS, "MARKET_DATA_HEALTH_TIMEOUT_MS", { fallback: 5_000, min: 500, max: 60_000 }),
    binanceBaseUrl: httpsBaseUrl(env.BINANCE_API_BASE, "BINANCE_API_BASE", { production }) || "https://api.binance.com",
    frankfurterBaseUrl: httpsBaseUrl(env.FRANKFURTER_API_BASE, "FRANKFURTER_API_BASE", { production }) || "https://api.frankfurter.dev",
    licensed: Object.freeze(licensed),
  });
}

/**
 * Analysis retention policy (risk R-27).
 *
 * `wf_analysis_runs.payload` is a LONGTEXT copy of an entire run — every agent
 * verdict, the debate transcript, scenarios, the setup, the risk decision and the
 * data provenance — kept so a decision can be re-read later without re-deriving it
 * from market data that no longer exists. Nothing else in the platform ever deletes
 * a row, so without retention the table grows for the life of the deployment on
 * shared hosting where disk is not elastic.
 *
 * Only the *policy* is configurable. Retention is applied by an operator running
 * `npm run prune:analysis`, never by a request: there is deliberately no HTTP route
 * that can delete analysis history, because a session-scoped API with a delete verb
 * on the audit copy of what a user was shown is not a trade worth making. Batch size
 * stays a code constant with a CLI override, since it is an implementation detail
 * about lock duration rather than a decision about what to keep.
 *
 * `0` keeps rows forever — the pre-R-27 behaviour, still available to a deployment
 * that would rather grow than lose history.
 */
function loadAnalysisConfig(env) {
  return Object.freeze({
    retentionDays: integer(env.ANALYSIS_RETENTION_DAYS, "ANALYSIS_RETENTION_DAYS", { fallback: 90, min: 0, max: 3_650 }),
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
    site: loadSiteConfig(env, { production, publicBaseUrl }),
    marketData: loadMarketDataConfig(env, { production }),
    analysis: loadAnalysisConfig(env),
    uploads: loadUploadConfig(env, { production }),
    rateLimit: loadRateLimitConfig(env),
    // Concurrent in-flight requests tracked per client address. A per-window
    // counter cannot stop a client that opens hundreds of parallel slow
    // connections; this ceiling can. 0 disables it (the default) so a shared
    // office address is never throttled by accident — set it deliberately.
    maxRequestsPerClient: integer(env.MAX_REQUESTS_PER_CLIENT, "MAX_REQUESTS_PER_CLIENT", { fallback: 0, min: 0, max: 10_000 }),
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
