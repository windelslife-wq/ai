/**
 * Static asset serving with containment guarantees (finding F-06 companion).
 *
 * Rules:
 *  - Files are resolved with realpath and must remain inside the public root.
 *  - Dotfiles and any path segment starting with "." are refused.
 *  - Only allow-listed extensions are served, with fixed MIME types.
 *  - Deny-listed prefixes (uploads, private areas) are refused even when a file
 *    physically exists there, so a mis-placed directory cannot leak.
 */

import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export const MIME_TYPES = Object.freeze({
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  // No source maps: the allow-list is the access control, and a map would publish
  // build-time source. `client/vite.config.js` sets `sourcemap: false` to match.
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
});

export const DEFAULT_DENY_PREFIXES = Object.freeze(["/uploads/", "/private/", "/data/"]);

function isWithin(parent, child) {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

export function staticAssetPath(publicRoot, pathname, denyPrefixes = DEFAULT_DENY_PREFIXES) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return null;
  const normalized = path.posix.resolve("/", decoded);
  if (denyPrefixes.some((prefix) => normalized === prefix.replace(/\/$/, "") || normalized.startsWith(prefix))) return null;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.startsWith("."))) return null;
  const relative = segments.join(path.sep);
  if (relative === "") return path.join(publicRoot, "index.html");
  const absolute = path.resolve(publicRoot, relative);
  return isWithin(publicRoot, absolute) ? absolute : null;
}

export async function resolveStaticFile(publicRoot, pathname, { allowSpaFallback = false, spaEntry = "app/index.html", denyPrefixes = DEFAULT_DENY_PREFIXES } = {}) {
  const publicRealPath = await realpath(publicRoot).catch(() => null);
  if (!publicRealPath) return null;
  const candidate = staticAssetPath(publicRealPath, pathname, denyPrefixes);
  if (!candidate) return null;
  let targetRealPath = await realpath(candidate).catch(() => null);
  if (targetRealPath) {
    const details = await stat(targetRealPath).catch(() => null);
    if (details?.isDirectory()) targetRealPath = await realpath(path.join(targetRealPath, "index.html")).catch(() => null);
  }
  if (!targetRealPath && allowSpaFallback) {
    targetRealPath = await realpath(path.join(publicRealPath, spaEntry)).catch(() => null);
  }
  if (!targetRealPath || !isWithin(publicRealPath, targetRealPath)) return null;
  const details = await stat(targetRealPath).catch(() => null);
  if (!details?.isFile()) return null;
  return { filePath: targetRealPath, details };
}

export function cacheControlFor(pathname, extension) {
  const isHtml = extension === ".html";
  const isVolatile = pathname === "/service-worker.js" || pathname === "/manifest.webmanifest" || pathname === "/sitemap.xml" || pathname === "/robots.txt";
  if (isHtml || isVolatile) return "no-cache";
  // Vite and the icon generator emit content-hashed names: safe forever.
  const hashed = /[.-][A-Za-z0-9_-]{8,}\.(js|css|png|jpg|jpeg|svg|webp|woff2)$/.test(pathname);
  return hashed ? "public, max-age=31536000, immutable" : "public, max-age=3600";
}

/**
 * @returns {Promise<boolean>} true when the response was written.
 */
export async function serveStatic(request, response, { publicRoot, pathname, headOnly = false, spaFallback, denyPrefixes, extraHeaders = {} }) {
  const accept = String(request.headers.accept || "");
  const allowSpaFallback = Boolean(spaFallback?.(pathname, accept));
  const asset = await resolveStaticFile(publicRoot, pathname, { allowSpaFallback, denyPrefixes });
  if (!asset) return false;
  const extension = path.extname(asset.filePath).toLowerCase();
  const type = MIME_TYPES[extension];
  if (!type) return false;
  const { filePath, details } = asset;
  const etag = `W/"${details.size.toString(16)}-${Math.trunc(details.mtimeMs).toString(16)}"`;
  response.statusCode = 200;
  response.setHeader("content-type", type);
  response.setHeader("content-length", details.size);
  response.setHeader("last-modified", details.mtime.toUTCString());
  response.setHeader("etag", etag);
  response.setHeader("cache-control", cacheControlFor(pathname, extension));
  for (const [name, value] of Object.entries(extraHeaders)) response.setHeader(name, value);
  if (request.headers["if-none-match"] === etag) {
    response.statusCode = 304;
    response.removeHeader("content-length");
    response.end();
    return true;
  }
  if (headOnly) {
    response.end();
    return true;
  }
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.once("error", reject);
    response.once("finish", resolve);
    response.once("close", resolve);
    stream.pipe(response);
  });
  return true;
}

export { isWithin };
