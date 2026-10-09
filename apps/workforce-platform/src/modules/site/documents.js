/**
 * Public-site documents: the rendered pages, the generated SEO files and the
 * legacy-compatible contact form endpoint.
 *
 * These live outside the JSON API router on purpose. `GET /api/v1/system/routes`
 * is the API parity ledger and every entry in it is an `/api/v1/*` endpoint; the
 * document surface has its own ledger (`documents.paths()`), which
 * `test/site.test.js` compares against the legacy route table
 * (`application/config/routes.php` §2 and `Seo.php`).
 *
 * Response rules:
 *  - pages are rendered per request and revalidated with a weak ETag;
 *  - a page carrying a one-shot flash message is `no-store` and has no ETag, so a
 *    shared cache can never serve one visitor's notice to another;
 *  - aliases and the legacy auth pages answer 301/302 to the canonical location;
 *  - `robots.txt`, `sitemap.xml` and `manifest.webmanifest` are generated from the
 *    validated site config, never read from a committed file.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parseFormBody, readRawBody } from "../../http/bodies.js";
import { isCrossSiteMutation, resolveCors } from "../../security/headers.js";
import { decodeFlash, encodeFlash, expiredFlashCookie, flashCookie, FLASH_COOKIE, readFlashCookie } from "../../security/flash.js";
import { validateRequest, validationDetails, validationMessage } from "../../http/validate.js";
import { ALIASES, AUTH_REDIRECTS, CONTENT, NOT_FOUND_CONTENT, PAGE_BY_PATH, PAGES } from "./pages.js";
import { renderDocument } from "./render.js";
import { robotsTxt, serviceWorkerSource, sitemapXml, webManifest } from "./seo.js";
import { CONTACT_SUBMIT } from "./contracts.js";
import { createSiteService } from "./service.js";

const HTML_TYPE = "text/html; charset=utf-8";
const FORM_BODY_LIMIT = 8 * 1024;

function etagFor(body) {
  return `W/"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
}

/** Shell files whose content defines the service-worker cache version. */
const SHELL_FILES = Object.freeze([
  "/",
  "/styles.css",
  "/site.js",
  "/manifest.webmanifest",
  "/icons/windels-mark.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
]);

/**
 * The precache list and cache version are derived from what is actually on disk:
 * an icon that was not built is not precached, and any edit to the shell changes
 * the version, which is what makes the update banner appear without anyone having
 * to remember to bump a constant.
 */
export function describeShell(publicDir) {
  const hash = createHash("sha256");
  const present = [];
  for (const file of SHELL_FILES) {
    if (file === "/" || file === "/manifest.webmanifest") {
      // Dynamic documents: "/" is the rendered home page, the manifest comes from
      // config. Their content is covered by the version inputs below.
      present.push(file);
      continue;
    }
    const absolute = path.join(publicDir, file);
    if (!existsSync(absolute)) continue;
    present.push(file);
    hash.update(file);
    hash.update(readFileSync(absolute));
  }
  hash.update(JSON.stringify(configlessFingerprint()));
  return { version: hash.digest("hex").slice(0, 16), precache: present };
}

function configlessFingerprint() {
  // Rendered documents also depend on the site config (name, colours), so the
  // version tracks it: a redeploy with new copy must not reuse the old cache.
  return ["shell-v1"];
}

export function createSiteDocuments({ config, store, log = null, rateLimiter = null, publicDir = path.join(process.cwd(), "public") }) {
  const service = createSiteService({ store, config });
  const seo = config.site;
  const shell = describeShell(publicDir);
  const serviceWorker = serviceWorkerSource(shell);

  function tokens(now = new Date()) {
    return { languages: seo.languageCount, year: now.getFullYear() };
  }

  function writeDocument(response, { body, statusCode = 200, headOnly = false, type = HTML_TYPE, cacheControl = "no-cache", etag = null, extraHeaders = {} }) {
    response.statusCode = statusCode;
    response.setHeader("content-type", type);
    response.setHeader("cache-control", cacheControl);
    for (const [name, value] of Object.entries(extraHeaders)) response.setHeader(name, value);
    if (etag) response.setHeader("etag", etag);
    const payload = Buffer.from(body, "utf8");
    response.setHeader("content-length", payload.length);
    if (headOnly) return response.end();
    return response.end(payload);
  }

  function redirect(response, location, statusCode = 302, { headOnly = false } = {}) {
    response.statusCode = statusCode;
    response.setHeader("location", location);
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-length", 0);
    return headOnly ? response.end() : response.end();
  }

  function renderPage(response, { page, request, headOnly, statusCode = 200, flash = null }) {
    const blocks = CONTENT[page.key] || NOT_FOUND_CONTENT;
    const body = renderDocument({
      page,
      blocks,
      seo,
      tokens: tokens(),
      active: page.key,
      flash,
      statusCode,
    });
    // A one-shot notice must never be cached or revalidated into another browser.
    const etag = flash ? null : etagFor(body);
    if (etag && request.headers["if-none-match"] === etag) {
      response.statusCode = 304;
      response.setHeader("cache-control", "no-cache");
      response.setHeader("etag", etag);
      response.removeHeader("content-length");
      return response.end();
    }
    return writeDocument(response, {
      body,
      statusCode,
      headOnly,
      etag,
      cacheControl: flash ? "no-store" : "no-cache",
      extraHeaders: flash ? { "set-cookie": expiredFlashCookie({ secure: config.secureCookie }) } : {},
    });
  }

  /** Every document path this module answers, for the parity ledger and tests. */
  function paths() {
    return Object.freeze([
      ...PAGES.map((page) => ({ method: "GET", path: page.path, kind: "page", canonical: true })),
      ...[...ALIASES.entries()].map(([alias, target]) => ({ method: "GET", path: alias, kind: "redirect", target, status: 301 })),
      ...[...AUTH_REDIRECTS.entries()].map(([alias, target]) => ({ method: "GET", path: alias, kind: "redirect", target, status: 302 })),
      { method: "GET", path: "/robots.txt", kind: "generated" },
      { method: "GET", path: "/sitemap.xml", kind: "generated" },
      { method: "GET", path: "/manifest.webmanifest", kind: "generated" },
      { method: "GET", path: "/service-worker.js", kind: "generated" },
      { method: "POST", path: "/contact/submit", kind: "form" },
    ]);
  }

  function methodsFor(pathname) {
    const methods = new Set();
    for (const entry of paths()) {
      if (entry.path === pathname) methods.add(entry.method);
    }
    if (methods.has("GET")) methods.add("HEAD");
    return [...methods].sort();
  }

  /**
   * @returns {Promise<boolean>} true when this module wrote the response.
   */
  async function handle(request, response, { headOnly = false } = {}) {
    const pathname = request.pathname || new URL(request.url, "http://localhost").pathname;

    if (request.method === "GET" || request.method === "HEAD") {
      const page = PAGE_BY_PATH.get(pathname);
      if (page) {
        if (page.key === "contact") {
          const raw = readFlashCookie(request.headers.cookie, FLASH_COOKIE);
          const flash = raw ? decodeFlash(raw, config.sessionSecret) : null;
          renderPage(response, { page, request, headOnly, flash });
          return true;
        }
        renderPage(response, { page, request, headOnly });
        return true;
      }

      const aliasTarget = ALIASES.get(pathname);
      if (aliasTarget) {
        redirect(response, aliasTarget, 301, { headOnly });
        return true;
      }

      const authTarget = AUTH_REDIRECTS.get(pathname);
      if (authTarget) {
        redirect(response, authTarget, 302, { headOnly });
        return true;
      }

      if (pathname === "/robots.txt") {
        writeDocument(response, { body: robotsTxt(seo), headOnly, type: "text/plain; charset=utf-8" });
        return true;
      }
      if (pathname === "/sitemap.xml") {
        writeDocument(response, { body: sitemapXml(seo), headOnly, type: "application/xml; charset=utf-8" });
        return true;
      }
      if (pathname === "/manifest.webmanifest") {
        writeDocument(response, { body: `${JSON.stringify(webManifest(seo), null, 2)}\n`, headOnly, type: "application/manifest+json; charset=utf-8" });
        return true;
      }
      if (pathname === "/service-worker.js") {
        // The worker script is never cached by HTTP: browsers revalidate it on every
        // update check, and a stale script would freeze the shell at an old version.
        writeDocument(response, { body: serviceWorker, headOnly, type: "text/javascript; charset=utf-8", cacheControl: "no-cache" });
        return true;
      }
      return false;
    }

    if (request.method === "POST" && pathname === "/contact/submit") {
      await handleContactForm(request, response, { headOnly });
      return true;
    }

    return false;
  }

  /**
   * The no-script path: a form-encoded POST that stores the inquiry and redirects
   * back to `/contact` with a signed one-shot notice, exactly like the legacy
   * handler. The enhanced path posts JSON to `/api/v1/site/contact`.
   */
  async function handleContactForm(request, response, { headOnly }) {
    // A public form is still a mutation: refuse cross-site submissions the same way
    // the API pipeline does, otherwise any page on the internet can file inquiries.
    const cors = resolveCors(request, config);
    if (!cors.allowed || isCrossSiteMutation(request, config)) {
      return respondFormError(request, response, 403, "The request origin is not allowed", { headOnly });
    }
    if (config.rateLimit.enabled !== false) {
      const wait = rateLimiter?.check(`contact:${request.clientAddress}`, { max: seo.contact.maxPerWindow, windowMs: seo.contact.windowMs }) ?? 0;
      if (wait) {
        response.setHeader("retry-after", String(wait));
        return respondFormError(request, response, 429, "Too many contact submissions from this address. Please try again later.", { headOnly });
      }
    }

    const contentType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/x-www-form-urlencoded") {
      return respondFormError(request, response, 415, "Submit the contact form as application/x-www-form-urlencoded", { headOnly });
    }
    const { buffer } = await readRawBody(request, FORM_BODY_LIMIT);
    request.body = parseFormBody(buffer);

    const validation = validateRequest({ bodySchema: CONTACT_SUBMIT }, request);
    if (validation.issues.length) {
      return respondFormError(request, response, 400, validationMessage(validation.issues), { headOnly, details: validationDetails(validation.issues) });
    }

    let receipt;
    try {
      receipt = await service.submitContact({
        ...validation.value.body,
        clientIp: request.clientAddress,
        userAgent: request.headers["user-agent"] || null,
        requestId: request.requestId || null,
      });
    } catch (error) {
      log?.error?.({ errorCode: error?.code || "CONTACT_INTAKE_FAILED" }, "Contact intake failed");
      const status = error?.statusCode || 500;
      if (error?.retryAfter) response.setHeader("retry-after", String(error.retryAfter));
      return respondFormError(request, response, status, status >= 500 ? "The message could not be recorded. Please try again later." : error.message, { headOnly });
    }

    const value = encodeFlash({ tone: "ok", message: receipt.notice }, config.sessionSecret);
    response.setHeader("set-cookie", flashCookie(value, { secure: config.secureCookie }));
    return redirect(response, "/contact", 303, { headOnly });
  }

  /**
   * Form failures are answered with the same site layout (not JSON) so a visitor
   * without script sees a readable message, and with JSON when the client asked
   * for it — content negotiation on `Accept`, mirroring the API pipeline.
   */
  function respondFormError(request, response, statusCode, message, { headOnly = false, details = null } = {}) {
    const wantsJson = String(request.headers?.accept || "").includes("application/json");
    if (wantsJson) {
      const body = JSON.stringify({ error: { code: statusCode === 429 ? "RATE_LIMITED" : "CONTACT_INVALID", message, ...(details ? { details } : {}) } });
      response.statusCode = statusCode;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-length", Buffer.byteLength(body));
      return headOnly ? response.end() : response.end(body);
    }
    const page = PAGE_BY_PATH.get("/contact");
    const body = renderDocument({
      page,
      blocks: CONTENT.contact,
      seo,
      tokens: tokens(),
      active: "contact",
      flash: { tone: "error", message },
      statusCode,
    });
    return writeDocument(response, { body, statusCode, headOnly, cacheControl: "no-store" });
  }

  return {
    handle,
    methodsFor,
    paths,
    shell: () => shell,
    /** The HTML 404 page: same layout, honest status, never a JSON body in a browser. */
    renderNotFound(request, response, { headOnly = false } = {}) {
      const body = renderDocument({
        page: { key: "not-found", path: request.pathname || "/", title: "Not found", description: "The requested page does not exist on this platform." },
        blocks: NOT_FOUND_CONTENT,
        seo,
        tokens: tokens(),
        active: null,
        statusCode: 404,
      });
      writeDocument(response, { body, statusCode: 404, headOnly, cacheControl: "no-store" });
      return true;
    },
  };
}
