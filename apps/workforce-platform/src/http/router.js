/**
 * Minimal, explicit router for the Node core HTTP server (finding F-03).
 *
 * - Supports GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS.
 * - Path parameters use `:name` segments (`/account/sessions/:tokenIdHash` style
 *   ids stay opaque: the pattern never decodes or normalizes them).
 * - Static segments win over parameters so a literal route can never be shadowed.
 * - No wildcards and no regex routes: every endpoint must be declared, which
 *   keeps the API surface auditable against the parity ledger.
 */

export const SUPPORTED_METHODS = Object.freeze(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
/** HEAD is dispatched as GET; only these methods may carry a request body. */
export const BODY_METHODS = Object.freeze(["POST", "PUT", "PATCH", "DELETE"]);

function compilePattern(prefix, pattern) {
  const joined = joinPath(prefix, pattern);
  const segments = joined.split("/").filter(Boolean);
  return segments.map((segment) => {
    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error(`Invalid parameter name in route ${joined}`);
      return { param: name };
    }
    if (segment.includes(":")) throw new Error(`Parameters must occupy a whole path segment: ${joined}`);
    return { literal: segment };
  });
}

export function joinPath(prefix, pattern) {
  const left = String(prefix || "").replace(/\/+$/, "");
  const right = String(pattern || "/");
  if (!right.startsWith("/")) throw new TypeError(`Routes must start with / (got ${pattern})`);
  const joined = `${left}${right}`.replace(/\/+$/, "");
  return joined === "" ? "/" : joined;
}

function matchSegments(compiled, segments) {
  if (compiled.length !== segments.length) return null;
  const params = Object.create(null);
  for (let index = 0; index < compiled.length; index += 1) {
    const node = compiled[index];
    const value = segments[index];
    if (node.param) {
      if (value === "") return null;
      params[node.param] = value;
    } else if (node.literal !== value) {
      return null;
    }
  }
  return params;
}

export function createRouter() {
  /** @type {Array<{method: string, path: string, compiled: any, options: object, handler: Function}>} */
  const routes = [];

  function add(method, path, options, handler) {
    if (typeof options === "function") {
      handler = options;
      options = {};
    }
    const upper = String(method).toUpperCase();
    if (!SUPPORTED_METHODS.includes(upper)) throw new Error(`Unsupported HTTP method: ${method}`);
    if (typeof handler !== "function") throw new Error(`Route handler is required for ${upper} ${path}`);
    if (routes.some((route) => route.method === upper && route.path === path)) {
      throw new Error(`Duplicate route: ${upper} ${path}`);
    }
    routes.push({ method: upper, path, compiled: compilePattern("", path), options: options || {}, handler });
  }

  function find(method, pathname) {
    const segments = pathname.split("/").filter(Boolean);
    const verbs = new Set();
    for (const route of routes) {
      const params = matchSegments(route.compiled, segments);
      if (!params) continue;
      if (route.method === method) return { route, params };
      verbs.add(route.method);
    }
    return verbs.size ? { methodMismatch: true, allowed: [...verbs, ...(verbs.has("GET") ? ["HEAD"] : [])].sort() } : null;
  }

  return {
    routes,
    add,
    find,
    /**
     * Route inventory. Deliberately derived from what each route *declares*, so a
     * route cannot be listed as protected while missing its guard: `auth` reflects
     * a real pre-handler, `permission` the permission it checks, and `validated`
     * whether any part of the request is schema-checked before the handler runs.
     */
    list() {
      return routes.map(({ method, path, options }) => ({
        method,
        path,
        auth: Boolean(options?.auth) || (Array.isArray(options?.preHandler) && options.preHandler.length > 0),
        permission: options?.permission ?? (options?.preHandler || []).flat().find?.((guard) => guard?.permission)?.permission ?? null,
        validated: Boolean(options?.bodySchema || options?.querySchema || options?.paramsSchema),
        rateLimited: Boolean(options?.config?.rateLimit),
      }));
    },
  };
}

/**
 * Route registrar with an optional prefix, mirroring how modules will declare
 * endpoints: `router.route("/api/v1").post("/auth/login", …)`.
 */
export function createRegistrar(router, prefix = "") {
  const registrar = { prefix };
  for (const method of SUPPORTED_METHODS) {
    registrar[method.toLowerCase()] = (path, options, handler) => router.add(method, joinPath(prefix, path), options, handler);
  }
  return registrar;
}
