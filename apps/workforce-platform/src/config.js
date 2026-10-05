const LOG_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

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

export function loadDatabaseConfig(env = process.env) {
  required(env, ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]);
  return Object.freeze({
    host: env.DB_HOST,
    port: integer(env.DB_PORT, "DB_PORT", { fallback: 3306, max: 65535 }),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    connectionLimit: integer(env.DB_CONNECTION_LIMIT, "DB_CONNECTION_LIMIT", { fallback: 5, max: 20 }),
  });
}

export function loadConfig(env = process.env) {
  const mode = env.NODE_ENV || "development";
  if (!["development", "test", "production"].includes(mode)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }

  const database = loadDatabaseConfig(env);
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

  return Object.freeze({
    mode,
    production,
    host: env.HOST || "0.0.0.0",
    port: integer(env.PORT, "PORT", { fallback: 3000, max: 65535 }),
    logLevel,
    database,
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
  });
}
