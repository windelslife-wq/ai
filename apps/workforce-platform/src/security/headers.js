/**
 * Security headers and CORS policy (finding F-05).
 *
 * The web apps are same-origin by design; cross-origin access is opt-in through
 * CORS_ALLOWED_ORIGINS and never implied. Credentialed requests are answered only
 * for exact origins on the allow-list, and every response that varies by origin
 * carries `Vary: Origin`.
 */

export const BASE_CSP = Object.freeze([
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
]);

/**
 * @param {object} config { production, requestId, contentSecurityPolicy (optional override) }
 */
export function securityHeaders(response, { production, requestId, contentSecurityPolicy }) {
  response.setHeader("x-request-id", requestId);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("content-security-policy", contentSecurityPolicy || BASE_CSP.join("; "));
  if (production) response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
}

/**
 * Development convenience only: lets a local page use inline styles/scripts.
 * Refused in production so an override can never reach a real deployment.
 */
export function buildCsp({ unsafeInline = false, connectSrc = [], extra = [] } = {}) {
  const policy = [...BASE_CSP];
  if (unsafeInline) {
    for (const [index, entry] of policy.entries()) {
      if (entry.startsWith("script-src") || entry.startsWith("style-src")) {
        policy[index] = `${entry} 'unsafe-inline'`;
      }
    }
  }
  if (connectSrc.length) {
    const index = policy.findIndex((entry) => entry.startsWith("connect-src"));
    if (index >= 0) policy[index] = `connect-src 'self' ${connectSrc.join(" ")}`;
  }
  for (const entry of extra) {
    const key = entry.split(" ")[0];
    const index = policy.findIndex((candidate) => candidate.split(" ")[0] === key);
    if (index >= 0) policy[index] = entry;
    else policy.push(entry);
  }
  return policy.join("; ");
}


function normalizeOrigin(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "*") return null;
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    if (Array.from(url.hostname).some((character) => character !== character.toLowerCase())) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function parseAllowedOrigins(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((entry) => normalizeOrigin(entry))
    .filter(Boolean);
}

/**
 * @returns {{origin: string|null, allowed: boolean}} the origin that may be
 *   echoed back, or null when the request is same-origin / not cross-origin.
 */
export function resolveCors(request, config) {
  const originHeader = request.headers.origin;
  if (typeof originHeader !== "string" || originHeader === "") return { origin: null, allowed: true };
  const origin = normalizeOrigin(originHeader);
  if (!origin) return { origin: null, allowed: false };
  const requestOrigin = `${request.protocol}://${request.hostname}`;
  if (origin === requestOrigin) return { origin: null, allowed: true };
  if (config.corsAllowedOrigins?.includes(origin)) return { origin, allowed: true };
  if (config.publicBaseUrl && origin === config.publicBaseUrl) return { origin: null, allowed: true };
  return { origin, allowed: false };
}

export function applyCorsHeaders(response, origin, { methods = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS", maxAge = 600 } = {}) {
  response.setHeader("vary", "Origin");
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("access-control-allow-methods", methods);
  response.setHeader("access-control-allow-headers", "content-type, x-csrf-token, authorization, x-request-id");
  response.setHeader("access-control-max-age", String(maxAge));
}

/**
 * Same-site judgement for cookie-authenticated mutations. `Sec-Fetch-Site` is
 * advisory (older browsers omit it) so origin equality is the backstop.
 */
export function isCrossSiteMutation(request, config) {
  const method = request.method;
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return true;
  const origin = normalizeOrigin(request.headers.origin ?? "");
  if (!origin) return false;
  const expected = config.publicBaseUrl || `${request.protocol}://${request.hostname}`;
  return origin !== normalizeOrigin(expected);
}
