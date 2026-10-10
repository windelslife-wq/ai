#!/usr/bin/env node
/**
 * Installation verification for a deployment (audit finding F-13: the Node side had
 * no pre-release gate, so "it runs on my machine" was the only evidence).
 *
 * Answers one question before a release is handed to a host: is this tree actually
 * runnable and complete? It checks syntax, the declared runtime, the dependency
 * floor, the files a boot needs, the migration set, the documented environment
 * variables, and finally that a production configuration loads — without touching
 * a database or a network.
 *
 * Usage:  node tools/verify-install.mjs [--json] [--require-bundle]
 * Exit:   0 all checks passed, 1 at least one failure.
 *
 * `--require-bundle` turns the client-bundle check from a skip into a failure. Run it
 * in a release pipeline *after* `npm run build:client`; without it a fresh clone passes
 * this gate because there is no bundle to talk about, which is correct for development
 * and not correct for an artefact.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireBundle = process.argv.includes("--require-bundle");
const jsonMode = process.argv.includes("--json");

// In --json mode stdout carries exactly one document: no progress lines, no summary.
// Anything worth reading by a human goes to stderr, so `verify-install --json | jq`
// never chokes on a "[PASS]" prefix.
function note(message) {
  if (!jsonMode) console.log(message);
}
const checks = [];

function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  note(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

async function jsFilesIn(relative) {
  const base = path.join(ROOT, relative);
  const found = [];
  try {
    for await (const file of walk(base)) if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) found.push(file);
  } catch {
    return null;
  }
  return found.sort((a, b) => a.localeCompare(b));
}

const manifest = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));

// 1. Every shipped source file parses under the target runtime.
const sources = [...(await jsFilesIn("src") || []), ...(await jsFilesIn("tools") || [])];
if (!sources.length) record("source tree present", false, "no files found under src/");
let syntaxFailures = [];
for (const file of sources) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) syntaxFailures.push(`${path.relative(ROOT, file)}: ${result.stderr.trim().split("\n")[0]}`);
}
for (const entry of ["server.js", "passenger-start.cjs"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(ROOT, entry)], { encoding: "utf8" });
  if (result.status !== 0) syntaxFailures.push(`${entry}: ${result.stderr.trim().split("\n")[0]}`);
}
record("syntax of every source file", syntaxFailures.length === 0, syntaxFailures.slice(0, 5).join(" | ") || `${sources.length + 2} files`);

// 2. The runtime is inside the declared range.
const major = Number(process.versions.node.split(".")[0]);
const range = manifest.engines?.node || "";
const inRange = /22/.test(range) ? major >= 22 && major < 25 : major >= 22;
record("node runtime", inRange, `running ${process.versions.node}, engines "${range}"`);

// 3. The dependency floor: two production packages, nothing that implies a framework.
const dependencies = Object.keys(manifest.dependencies || {}).sort();
const expected = ["bcryptjs", "mysql2"];
record("production dependencies", JSON.stringify(dependencies) === JSON.stringify(expected), dependencies.join(", ") || "none");
record("no devDependencies in the server package", Object.keys(manifest.devDependencies || {}).length === 0, Object.keys(manifest.devDependencies || {}).join(", ") || "none declared");
const banned = ["express", "fastify", "koa", "hapi", "next", "nuxt", "ioredis", "redis", "connect-redis", "helmet", "cors", "body-parser"];
const packageText = await readFile(path.join(ROOT, "package.json"), "utf8");
const foundBanned = banned.filter((name) => packageText.includes(`"${name}"`));
record("no HTTP framework, cache or proxy package", foundBanned.length === 0, foundBanned.join(", ") || "clean");

// 4. Files the boot and the release actually need.
const required = [
  "server.js",
  "src/app.js",
  "src/config.js",
  "src/persistence/index.js",
  "src/persistence/file-store.js",
  "src/db/store.js",
  "src/db/migrate.js",
  "src/modules/site/pages.js",
  "src/modules/site/render.js",
  "src/modules/site/documents.js",
  "public/styles.css",
  "public/site.js",
  "public/icons/icon-192.png",
  "public/icons/icon-512.png",
  "public/icons/maskable-512.png",
  "public/icons/apple-touch-icon.png",
  ".env.example",
];
for (const entry of required) {
  const details = await stat(path.join(ROOT, entry)).catch(() => null);
  record(`present: ${entry}`, Boolean(details?.isFile()), details ? `${details.size} bytes` : "missing");
}

// 5. Migrations are complete, ordered, and named the way the store expects them.
const migrationDir = path.join(ROOT, "src", "db", "migrations");
const migrationFiles = (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort();
const storeSource = await readFile(path.join(ROOT, "src", "db", "store.js"), "utf8");
const { REQUIRED_MIGRATIONS } = await import(path.join(ROOT, "src", "db", "store.js"));
const listed = REQUIRED_MIGRATIONS.every((name) => migrationFiles.some((file) => file === `${name}.sql`));
record("every required migration exists on disk", listed, `${migrationFiles.join(", ")} (store requires ${REQUIRED_MIGRATIONS.length})`);
record("migrations are referenced by the readiness check", storeSource.includes("REQUIRED_MIGRATIONS"), "readiness must not go green on a partial schema");

// 6. Every environment variable the config reads is documented.
const configSource = await readFile(path.join(ROOT, "src", "config.js"), "utf8");
const referenced = new Set();
for (const match of configSource.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) referenced.add(match[1]);
for (const match of configSource.matchAll(/env\[["']([A-Z][A-Z0-9_]{2,})["']\]/g)) referenced.add(match[1]);
const example = await readFile(path.join(ROOT, ".env.example"), "utf8");
const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]{2,})=/gm)].map((match) => match[1]));
const undocumented = [...referenced].filter((name) => !documented.has(name)).sort();
record("config variables are documented in .env.example", undocumented.length === 0, undocumented.length ? `undocumented: ${undocumented.join(", ")}` : `${referenced.size} documented`);

// 7. A production configuration loads, and the unsafe ones do not.
const { loadConfig } = await import(path.join(ROOT, "src", "config.js"));
try {
  const production = loadConfig({
    NODE_ENV: "production",
    PUBLIC_BASE_URL: "https://example.invalid",
    SESSION_SECRET: "x".repeat(48),
    STORAGE_ADAPTER: "mysql",
    DB_HOST: "localhost",
    DB_NAME: "wf",
    DB_USER: "wf",
    DB_PASSWORD: "not-a-secret-in-this-file",
    PORT: "3000",
  });
  record("production configuration loads", production.production === true && production.secureCookie === true && production.cookieName === "__Host-wf_session", `cookie ${production.cookieName}`);
} catch (error) {
  record("production configuration loads", false, error.message);
}
let refused = 0;
for (const env of [
  { NODE_ENV: "production", SESSION_SECRET: "x".repeat(48) },
  { NODE_ENV: "production", PUBLIC_BASE_URL: "http://example.invalid", SESSION_SECRET: "x".repeat(48) },
  { NODE_ENV: "production", PUBLIC_BASE_URL: "https://example.invalid", SESSION_SECRET: "short" },
  { NODE_ENV: "production", PUBLIC_BASE_URL: "https://example.invalid", SESSION_SECRET: "x".repeat(48), STORAGE_ADAPTER: "file" },
]) {
  try {
    loadConfig(env);
  } catch {
    refused += 1;
  }
}
record("unsafe production configurations are refused", refused === 4, `${refused}/4 refused`);

// 8. The PWA icon set must be reproducible from the generator, byte for byte: a
// hand-edited or stale icon is exactly the artefact a release gate exists to catch.
{
  const { ICON_SPECS, renderIcon, readPngHeader } = await import(path.join(ROOT, "tools", "generate-icons.mjs"));
  let iconFailures = [];
  for (const spec of ICON_SPECS) {
    const destination = path.join(ROOT, "public", "icons", spec.file);
    const existing = await readFile(destination).catch(() => null);
    if (!existing) { iconFailures.push(`${spec.file} missing (run npm run build:icons)`); continue; }
    const header = readPngHeader(existing);
    if (header.width !== spec.size || header.height !== spec.size || header.colorType !== 6 || header.interlace !== 0) {
      iconFailures.push(`${spec.file} header ${header.width}x${header.height} colour ${header.colorType}`);
      continue;
    }
    if (!existing.equals(renderIcon(spec))) iconFailures.push(`${spec.file} differs from the generated bytes`);
  }
  record("the committed icon set is exactly what the generator produces", iconFailures.length === 0, iconFailures.join(" | ") || `${ICON_SPECS.length} icons verified`);
}

// 9. The SEO documents and the service worker are generated per deployment, so a
// committed static copy would be a second, silently-wrong source of truth.
{
  const stale = ["public/robots.txt", "public/sitemap.xml", "public/manifest.webmanifest", "public/service-worker.js", "public/index.html"]
    .filter((file) => { try { statSync(path.join(ROOT, file)); return true; } catch { return false; } });
  record("generated documents are not duplicated as static files", stale.length === 0, stale.length ? `stale: ${stale.join(", ")}` : "all five are rendered per request");
}

// 10. The client bundle, when it has been built, must be reachable from the server.
const clientIndex = await stat(path.join(ROOT, "public", "app", "index.html")).catch(() => null);
if (clientIndex) {
  const html = await readFile(path.join(ROOT, "public", "app", "index.html"), "utf8");
  const assets = [...html.matchAll(/(?:src|href)="\/app\/([^"]+)"/g)].map((match) => match[1]);
  const missingAssets = [];
  for (const asset of assets) {
    const details = await stat(path.join(ROOT, "public", "app", asset)).catch(() => null);
    if (!details?.isFile()) missingAssets.push(asset);
  }
  record("built client bundle references only files that exist", missingAssets.length === 0, `${assets.length} referenced${missingAssets.length ? `; missing ${missingAssets.join(", ")}` : ""}`);
} else if (requireBundle) {
  record("built client bundle is present", false, "public/app/index.html is absent; run `npm run build:client` (this run used --require-bundle)");
} else {
  note("[SKIP] built client bundle — public/app/index.html is absent; run `npm run build:client` before release");
}

const failures = checks.filter((entry) => !entry.ok);
if (jsonMode) {
  console.log(JSON.stringify({ ok: failures.length === 0, passed: checks.length - failures.length, total: checks.length, failures, checks }, null, 2));
} else {
  console.log(`\n${checks.length - failures.length}/${checks.length} installation checks passed`);
}
if (failures.length) {
  console.error("Verification failed:");
  for (const failure of failures) console.error(`  - ${failure.name}: ${failure.detail}`);
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}
