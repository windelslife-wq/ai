/**
 * Phase 3 — public site, SEO documents, PWA shell and contact intake.
 *
 * The parity oracle is the legacy PHP application itself: the route table
 * (`application/config/routes.php`), the page views (`application/views/site/*`)
 * and `application/controllers/Seo.php` are read from disk and compared with what
 * this platform serves. A copy edit in PHP that Node silently dropped fails here;
 * a deliberate divergence is asserted as a divergence, with its reason, so it can
 * never become silent.
 *
 * Finding numbers referenced: F-09 (PWA icons / hashed shell / update UX),
 * F-10 (sitemap, canonical, public pages, SEO config), F-13 (concurrency ceiling).
 */

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createFileStore } from "../src/persistence/file-store.js";
import { neverCachePatternLiteral, robotsTxt, SERVICE_WORKER_NEVER_CACHE, sitemapXml, webManifest } from "../src/modules/site/seo.js";
import { ALIASES, AUTH_REDIRECTS, CONTENT, PAGES, sitemapPaths } from "../src/modules/site/pages.js";
import { encodePng, ICON_SPECS, readPngHeader, renderIcon, renderMark } from "../tools/generate-icons.mjs";
import { createConcurrencyTracker } from "../src/security/ratelimit.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { cookieFrom, createFileStoreApp } from "./helpers.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const LEGACY_ROUTES = path.join(REPO_ROOT, "application", "config", "routes.php");
const LEGACY_VIEWS = path.join(REPO_ROOT, "application", "views", "site");

const SITE_ENV = { PUBLIC_BASE_URL: "https://site.example.test" };

function harness(env = {}, options = {}) {
  return createFileStoreApp({ configOverrides: { env: { ...SITE_ENV, ...env } }, ...options });
}

async function signIn(app, identifier, password) {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  const body = response.statusCode === 200 ? response.json() : null;
  return { response, cookie: cookieFrom(response), csrfToken: body?.csrfToken ?? null };
}

/** Rendered HTML escapes text; parity compares decoded text on both sides. */
function decodeEntities(value) {
  return String(value)
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** `<h1>…</h1>`, `<h2>…</h2>`, `<h3>…</h3>` text of a legacy view, entity-decoded. */
function legacyHeadings(source) {
  const decoded = source
    .replace(/<\?php[\s\S]*?\?>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
  return [...decoded.matchAll(/<h([123])[^>]*>([\s\S]*?)<\/h\1>/g)]
    .map((match) => match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- F-10 routes

test("F-10 every legacy public route is answered: pages render, aliases redirect, SEO documents generate", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  const routes = await readFile(LEGACY_ROUTES, "utf8");

  // The legacy route table's public-site block, read rather than remembered.
  const legacySiteRoutes = [...routes.matchAll(/\$route\['([a-z-]+(?:\/[a-z-]+)?)'\] = 'site\/([a-z_]+)';/g)]
    .map((match) => ({ path: `/${match[1]}`, target: match[2] }));
  assert.ok(legacySiteRoutes.length >= 9, `the legacy site route block must be found (got ${legacySiteRoutes.length})`);

  for (const entry of legacySiteRoutes) {
    if (entry.path.endsWith("/submit")) continue; // a mutation; asserted below
    const response = await app.app.inject({ method: "GET", url: entry.path, headers: { accept: "text/html" } });
    if (ALIASES.has(entry.path)) {
      assert.equal(response.statusCode, 301, `${entry.path} is a legacy alias and must move permanently`);
      assert.ok(PAGES.some((page) => page.path === response.headers.location), `${entry.path} must point at a real page, got ${response.headers.location}`);
      continue;
    }
    assert.equal(response.statusCode, 200, `GET ${entry.path} must render`);
    assert.match(response.headers["content-type"], /^text\/html/);
  }

  for (const document of ["/robots.txt", "/sitemap.xml"]) {
    const legacy = `$route['${document.slice(1)}']`;
    assert.ok(routes.includes(legacy), `the legacy table must define ${document}`);
    const response = await app.app.inject({ method: "GET", url: document });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-cache");
  }

  // The contact mutation keeps its legacy path and verb.
  const submit = await app.app.inject({
    method: "POST",
    url: "/contact/submit",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "name=Visitor&email=visitor%40example.test&message=A+perfectly+reasonable+question+about+the+platform.",
  });
  assert.equal(submit.statusCode, 303, "the no-script form path redirects back to /contact like the legacy flashdata flow");
  assert.equal(submit.headers.location, "/contact");
  assert.match(submit.headers["set-cookie"], /wf_flash=/);
});

test("F-10 the navigation and footer mirror the legacy layout, and the inventory drives nav, sitemap and routes", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  const header = await readFile(path.join(LEGACY_VIEWS, "layout", "header.php"), "utf8");

  const legacyNav = [...header.matchAll(/'([a-z]+)' => \['(\/[a-z-]*)', '([^']+)'\]/g)]
    .map((match) => ({ key: match[1], href: match[2], label: match[3] }));
  assert.equal(legacyNav.length, 8, "the legacy header defines eight navigation entries");

  const home = await app.app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
  for (const entry of legacyNav) {
    assert.ok(home.body.includes(`href="${entry.href}"`), `nav must link ${entry.href}`);
    assert.ok(home.body.includes(`>${entry.label}</a>`), `nav must label ${entry.href} as "${entry.label}"`);
  }
  // The one deliberate addition: the workspace entry point, which the legacy site
  // expressed as "Login / Get started" buttons.
  assert.ok(home.body.includes('href="/app/"'), "the Node site offers the workspace shell");

  const footer = await readFile(path.join(LEGACY_VIEWS, "layout", "footer.php"), "utf8");
  for (const label of ["Explore", "Account"]) {
    assert.ok(footer.includes(`<span>${label}</span>`), "the legacy footer groups are the reference");
    assert.ok(home.body.includes(`<span>${label}</span>`), `the Node footer keeps the "${label}" group`);
  }
  assert.match(home.body, /Dashboards require a signed-in account\. Synthetic or sandbox data is always labelled\./, "the legacy legal line is preserved");

  // Inventory coherence: nav + sitemap + aliases all derive from PAGES.
  assert.deepEqual(sitemapPaths(), PAGES.filter((page) => page.inSitemap).map((page) => page.path));
  assert.equal(new Set(PAGES.map((page) => page.path)).size, PAGES.length);
  for (const [alias, target] of ALIASES) assert.ok(PAGES.some((page) => page.path === target), `${alias} must alias a real page`);
});

test("F-10 page copy is ported from the legacy views, heading for heading", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());

  const viewByKey = { home: "home.php", about: "about.php", services: "services.php", how: "how.php", locations: "locations.php", safety: "safety.php", faq: "faq.php", contact: "contact.php" };
  for (const [key, file] of Object.entries(viewByKey)) {
    const legacy = await readFile(path.join(LEGACY_VIEWS, file), "utf8");
    const headings = legacyHeadings(legacy);
    assert.ok(headings.length > 0, `${file} must contribute headings to compare`);
    const page = PAGES.find((entry) => entry.key === key);
    const response = await app.app.inject({ method: "GET", url: page.path, headers: { accept: "text/html" } });
    assert.equal(response.statusCode, 200);
    const rendered = decodeEntities(response.body);
    for (const heading of headings) {
      assert.ok(rendered.includes(heading), `${page.path} must carry the legacy heading "${heading}"`);
    }
  }

  // The legacy home stats band, including its honesty claim.
  const home = await app.app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
  for (const claim of ["Languages in the authored teacher registry", "Steps in the execution supervisor", "Orders placed from the public website"]) {
    assert.ok(home.body.includes(claim), `the stats band must keep "${claim}"`);
  }
});

// ---------------------------------------------------------------- F-10 SEO

test("F-10 robots.txt keeps every legacy disallow rule and adds the private prefixes", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  const response = await app.app.inject({ method: "GET", url: "/robots.txt" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /^text\/plain/);

  const legacy = ["/api/", "/admin", "/account", "/dashboard", "/analysis", "/app/"];
  for (const disallow of legacy) assert.ok(response.body.includes(`Disallow: ${disallow}`), `legacy rule ${disallow} must survive`);
  assert.ok(response.body.includes("Sitemap: https://site.example.test/sitemap.xml"), "with a canonical origin the sitemap is advertised");

  const seo = app.config.site;
  assert.equal(robotsTxt(seo), response.body, "the served document is exactly the configured builder's output");
});

test("F-10 the sitemap lists the marketing pages and refuses to advertise the disallowed workspace", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  const response = await app.app.inject({ method: "GET", url: "/sitemap.xml" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /^application\/xml/);

  for (const pagePath of sitemapPaths()) {
    assert.ok(response.body.includes(`<loc>https://site.example.test${pagePath}</loc>`), `sitemap must list ${pagePath}`);
  }
  // Deliberate divergence from the legacy 10-entry sitemap: /login and /register
  // redirect into /app/, which robots.txt disallows — submitting them would be a
  // self-contradiction. The redirects keep every legacy link working instead.
  assert.ok(!response.body.includes("/login"), "redirecting auth pages are not submitted to crawlers");
  assert.ok(!response.body.includes("/app/"), "the disallowed workspace is not submitted");
  assert.ok(AUTH_REDIRECTS.has("/login") && AUTH_REDIRECTS.has("/register"), "and no legacy auth link is left dead");

  const withoutOrigin = await buildApp({ config: loadConfig({ NODE_ENV: "test", SESSION_SECRET: "x".repeat(40), STORAGE_ADAPTER: "file", LOG_LEVEL: "silent" }), store: null, logger: false });
  t.after(() => withoutOrigin.close());
  const bare = await withoutOrigin.inject({ method: "GET", url: "/sitemap.xml" });
  assert.match(bare.body, /PUBLIC_BASE_URL is not configured/, "without a canonical origin the sitemap says so instead of publishing relative URLs");
});

test("F-10 every page carries canonical, robots, Open Graph and theme metadata from one configured surface", async (t) => {
  const app = await harness({
    SITE_NAME: "Example Workforce",
    SITE_TITLE_SUFFIX: " · Example",
    ROBOTS: "noindex, follow",
    SITE_OG_IMAGE: "https://cdn.example.test/share.png",
    THEME_COLOR: "#101820",
  });
  t.after(() => app.cleanup());

  const about = await app.app.inject({ method: "GET", url: "/about", headers: { accept: "text/html" } });
  assert.ok(about.body.includes('<link rel="canonical" href="https://site.example.test/about">'));
  assert.ok(about.body.includes('<meta name="robots" content="noindex, follow">'), "the configured robots directive reaches every head");
  assert.ok(about.body.includes('<meta property="og:url" content="https://site.example.test/about">'));
  assert.ok(about.body.includes('<meta property="og:image" content="https://cdn.example.test/share.png">'));
  assert.ok(about.body.includes('<meta name="theme-color" content="#101820">'));
  assert.ok(about.body.includes("<title>About · Example</title>"), "the configured title suffix is applied");
  assert.ok(about.body.includes('lang="en"'));

  // A hostile config value cannot become markup: the head is escaped like content.
  const hostile = await harness({ SITE_NAME: '"><script>alert(1)</script>' });
  t.after(() => hostile.cleanup());
  const page = await hostile.app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
  assert.ok(!page.body.includes("<script>alert(1)</script>"), "a configured site name must never become markup");
  assert.ok(page.body.includes("&lt;script&gt;"), "it is escaped instead");
});

test("the manifest is generated: PNG icon set with a maskable entry, workspace start URL, configured colours", async (t) => {
  const app = await harness({ THEME_COLOR: "#0a0f14" });
  t.after(() => app.cleanup());
  const response = await app.app.inject({ method: "GET", url: "/manifest.webmanifest" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /manifest\+json/);
  const manifest = response.json();
  assert.equal(manifest.start_url, "/app/");
  assert.equal(manifest.theme_color, "#0a0f14");
  const purposes = manifest.icons.map((icon) => icon.purpose);
  assert.ok(purposes.includes("maskable"), "an installable manifest needs a maskable icon");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192" && icon.type === "image/png"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.type === "image/png"));
  for (const icon of manifest.icons) {
    if (icon.type === "image/png") {
      const details = await stat(path.join(import.meta.dirname, "..", "public", icon.src));
      assert.ok(details.isFile(), `${icon.src} must exist on disk`);
    }
  }
  assert.deepEqual(webManifest(app.config.site).icons.length, manifest.icons.length);
});

// ------------------------------------------------------------------ F-09 PWA

test("F-09 the icon set is real PNGs at the sizes install prompts require, reproducible from the generator", async () => {
  for (const spec of ICON_SPECS) {
    const file = await readFile(path.join(import.meta.dirname, "..", "public", "icons", spec.file));
    const header = readPngHeader(file);
    assert.equal(header.width, spec.size, `${spec.file} width`);
    assert.equal(header.height, spec.size, `${spec.file} height`);
    assert.equal(header.bitDepth, 8);
    assert.equal(header.colorType, 6, `${spec.file} must be truecolour+alpha`);
    assert.equal(header.interlace, 0);
    assert.ok(file.equals(renderIcon(spec)), `${spec.file} must equal the generated bytes`);
  }
  // The encoder round-trips its own contract and refuses malformed input.
  const rgba = renderMark({ size: 8, samples: 1 });
  assert.equal(rgba.length, 8 * 8 * 4);
  assert.throws(() => encodePng(4, 4, Buffer.alloc(10)), /RGBA bytes/);
  assert.throws(() => readPngHeader(Buffer.from("not a png at all")), /Not a PNG/);
});

test("F-09 the service worker is generated, versioned by shell content, and its policy is data", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());

  const response = await app.app.inject({ method: "GET", url: "/service-worker.js" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-cache", "an HTTP-cached worker would freeze the shell");
  assert.match(response.headers["content-type"], /javascript/);

  // The downloaded worker must parse: a syntax error here is a site that can never
  // go offline again, and nothing else in the suite would notice.
  assert.doesNotThrow(() => new Function(response.body), "the generated worker must be valid JavaScript");

  for (const prefix of SERVICE_WORKER_NEVER_CACHE) {
    assert.ok(response.body.includes(neverCachePatternLiteral(prefix)), `the worker bypasses ${prefix}`);
  }
  assert.match(response.body, /SKIP_WAITING/, "the update flow the page offers must exist in the worker");
  assert.match(response.body, /clients\.claim\(\)/);

  const shell = app.app.siteDocuments.shell();
  assert.ok(shell.precache.includes("/"), "the home page is part of the precache");
  assert.ok(shell.precache.includes("/icons/icon-512.png"), "generated icons are precached");
  assert.match(shell.version, /^[0-9a-f]{16}$/, "the cache version is a content hash");

  // A changed shell must produce a changed version: this is what makes the
  // "new version available" banner appear without anyone bumping a constant.
  const other = await buildApp({
    config: loadConfig({ NODE_ENV: "test", SESSION_SECRET: "x".repeat(40), STORAGE_ADAPTER: "file", LOG_LEVEL: "silent", WF_APP_ROOT: REPO_ROOT }),
    store: null,
    logger: false,
    publicDir: path.join(import.meta.dirname, "fixtures-shell-a"),
  });
  t.after(() => other.close());
  assert.notEqual(other.siteDocuments.shell().version, shell.version, "an absent shell hashes differently from the real one");
});

// ------------------------------------------------------------- contact intake

test("contact intake stores, audits and reports the mail situation honestly", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());

  const response = await app.app.inject({
    method: "POST",
    url: "/api/v1/site/contact",
    payload: { name: "Ada", email: "ADA@Example.TEST", message: "Does the Node platform already serve the public pages?" },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.match(body.reference, /^[0-9A-HJKMNP-TV-Z]{26}$/, "visitors get a quotable reference, not an auto-increment id");
  assert.equal(body.recorded, true);
  assert.equal(body.mail.sent, false, "no transport exists, so no delivery may be claimed");
  assert.match(body.mail.reason, /no outbound mail transport/i);
  assert.match(body.notice, /recorded/);

  const { inquiries } = await app.store.pageContactInquiries({});
  assert.equal(inquiries.length, 1);
  assert.equal(inquiries[0].email, "ada@example.test", "the email is lower-cased like the legacy handler");
  assert.match(inquiries[0].clientFingerprint, /^[0-9a-f]{64}$/, "the client address is stored hashed, never raw");

  const audit = await app.store.listAuditEvents({ action: "CONTACT_INQUIRY" });
  assert.equal(audit.total, 1, "the legacy audit vocabulary is preserved");
  assert.equal(audit.events[0].details.name, "Ada");

  const tooShort = await app.app.inject({
    method: "POST",
    url: "/api/v1/site/contact",
    payload: { name: "Ada", email: "ada@example.test", message: "nine char" },
  });
  assert.equal(tooShort.statusCode, 400);
  assert.equal(tooShort.json().error.details[0].field, "message");

  const extraField = await app.app.inject({
    method: "POST",
    url: "/api/v1/site/contact",
    payload: { name: "Ada", email: "ada@example.test", message: "A perfectly reasonable question.", admin: true },
  });
  assert.equal(extraField.statusCode, 400, "unknown fields are refused, not silently stored");
});

test("contact intake throttles per client and refuses cross-site submissions", async (t) => {
  const app = await harness({ CONTACT_MAX_PER_HOUR: "2", RATE_LIMIT_API_MAX: "100000" });
  t.after(() => app.cleanup());
  const payload = { name: "Ada", email: "ada@example.test", message: "One reasonable question, asked repeatedly." };

  assert.equal((await app.app.inject({ method: "POST", url: "/api/v1/site/contact", payload })).statusCode, 200);
  assert.equal((await app.app.inject({ method: "POST", url: "/api/v1/site/contact", payload })).statusCode, 200);
  const limited = await app.app.inject({ method: "POST", url: "/api/v1/site/contact", payload });
  assert.equal(limited.statusCode, 429, "the third submission inside the window is throttled");
  assert.ok(Number(limited.headers["retry-after"]) > 0);

  const crossSite = await app.app.inject({
    method: "POST",
    url: "/contact/submit",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://evil.example.test",
      "sec-fetch-site": "cross-site",
    },
    payload: "name=Ada&email=ada@example.test&message=Posted+from+someone+else's+page.",
  });
  assert.equal(crossSite.statusCode, 403, "a public form is still a mutation: cross-site posts are refused");
  const { inquiries } = await app.store.pageContactInquiries({});
  assert.equal(inquiries.length, 2, "the refused post stored nothing");
});

test("the no-script form path redirects with a signed flash, and the page consumes it once", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());

  const submit = await app.app.inject({
    method: "POST",
    url: "/contact/submit",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "name=Ada&email=ada@example.test&message=Sent+without+JavaScript+at+all.",
  });
  assert.equal(submit.statusCode, 303);
  const cookie = cookieFrom(submit);
  assert.match(cookie, /^wf_flash=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const withFlash = await app.app.inject({ method: "GET", url: "/contact", headers: { accept: "text/html", cookie } });
  assert.equal(withFlash.statusCode, 200);
  assert.match(withFlash.body, /Your message was recorded/, "the one-shot notice renders on the redirect target");
  assert.equal(withFlash.headers["cache-control"], "no-store", "a page carrying someone's notice must never be cached");
  assert.equal(withFlash.headers.etag, undefined, "and must not be revalidated into another visitor's browser");
  assert.match(withFlash.headers["set-cookie"], /wf_flash=;.*Max-Age=0/, "the notice is consumed by rendering it");

  // The notice deletes its own cookie on every render, so a *browser* can see it
  // exactly once. Manually re-sending the bytes is not a browser: it re-renders,
  // and each render deletes the cookie again — the property that matters is that
  // the cookie never survives a response.
  const again = await app.app.inject({ method: "GET", url: "/contact", headers: { accept: "text/html", cookie } });
  assert.match(again.headers["set-cookie"], /wf_flash=;.*Max-Age=0/, "every render of the notice clears the cookie again");

  const forged = await app.app.inject({
    method: "GET",
    url: "/contact",
    headers: { accept: "text/html", cookie: "wf_flash=AAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
  });
  assert.equal(forged.statusCode, 200);
  assert.doesNotMatch(forged.body, /flash-ok/, "a forged flash signature renders nothing");

  const invalid = await app.app.inject({
    method: "POST",
    url: "/contact/submit",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
    payload: "name=&email=nope&message=short",
  });
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.headers["content-type"], /^text\/html/, "a form client gets the page back, not JSON");
  assert.match(invalid.body, /flash-error/);
});

test("the administrator inquiry listing is super-admin only and paginated", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  for (const index of [1, 2, 3]) {
    await app.app.inject({
      method: "POST",
      url: "/api/v1/site/contact",
      payload: { name: `Visitor ${index}`, email: `v${index}@example.test`, message: `Question number ${index}, long enough to be accepted.` },
    });
  }

  const anonymous = await app.app.inject({ method: "GET", url: "/api/v1/admin/inquiries" });
  assert.equal(anonymous.statusCode, 401);

  // The file store starts with only the seeded administrator, so a plain member is
  // created here: the point is that a signed-in account *without* system.super_admin
  // is denied, not that a particular fixture user exists.
  const bcrypt = (await import("bcryptjs")).default;
  await app.store.createUser({ username: "member1", email: "member1@example.test", passwordHash: await bcrypt.hash("Member one password", 4), displayName: "Member One" });
  const member = await signIn(app.app, "member1", "Member one password");
  assert.equal(member.response.statusCode, 200);
  const denied = await app.app.inject({ method: "GET", url: "/api/v1/admin/inquiries", headers: { cookie: member.cookie } });
  assert.equal(denied.statusCode, 403, "a member without system.super_admin cannot read visitor mail addresses");

  const admin = await signIn(app.app, "rootadmin", "Root administrator pass");
  assert.equal(admin.response.statusCode, 200);
  const listed = await app.app.inject({ method: "GET", url: "/api/v1/admin/inquiries?limit=2&offset=1", headers: { cookie: admin.cookie } });
  assert.equal(listed.statusCode, 200);
  const body = listed.json();
  assert.equal(body.total, 3);
  assert.equal(body.inquiries.length, 2);
  assert.equal(body.mail.transport, "none", "the listing repeats the honest mail situation");
  const searched = await app.app.inject({ method: "GET", url: "/api/v1/admin/inquiries?search=v2", headers: { cookie: admin.cookie } });
  assert.equal(searched.json().total, 1);
});

// ------------------------------------------------------- transport behaviours

test("unknown paths answer a rendered 404 for browsers and JSON for machines", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());

  const browser = await app.app.inject({ method: "GET", url: "/depots", headers: { accept: "text/html,application/xhtml+xml" } });
  assert.equal(browser.statusCode, 404);
  assert.match(browser.headers["content-type"], /^text\/html/);
  assert.match(browser.body, /That page is not here/);
  assert.equal(browser.headers["cache-control"], "no-store");

  const machine = await app.app.inject({ method: "GET", url: "/depots", headers: { accept: "application/json" } });
  assert.equal(machine.statusCode, 404);
  assert.equal(machine.json().error.code, "NOT_FOUND");
});

test("F-13 the concurrency ceiling refuses parallel slow requests from one address", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "wf-concurrency-"));
  const config = loadConfig({
    NODE_ENV: "test",
    WF_APP_ROOT: directory,
    STORAGE_ADAPTER: "file",
    STORAGE_DIR: path.join(directory, "store"),
    SESSION_SECRET: "test-session-secret-with-at-least-32-bytes-long",
    LOG_LEVEL: "silent",
    MAX_REQUESTS_PER_CLIENT: "1",
    ...SITE_ENV,
  });
  const store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: false });
  let releaseReadiness = () => {};
  const gate = new Promise((resolve) => { releaseReadiness = resolve; });
  const gated = { ...store, async readiness() { await gate; return store.readiness(); } };
  const app = await buildApp({ config, store: gated, logger: false });
  t.after(async () => { await app.close(); await store.close(); releaseReadiness(); await rm(directory, { recursive: true, force: true }); });

  const slow = app.inject({ method: "GET", url: "/api/v1/health/ready" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const refused = await app.inject({ method: "GET", url: "/api/v1/health/live" });
  assert.equal(refused.statusCode, 429, "the second concurrent request from one address is refused");
  assert.equal(refused.headers["retry-after"], "1");
  assert.equal(refused.json().error.code, "TOO_MANY_CONCURRENT_REQUESTS");
  releaseReadiness();
  assert.equal((await slow).statusCode, 200, "once released the gated probe completes and reports the file store as ready");

  // The tracker itself: bounded, and releasing returns capacity.
  const tracker = createConcurrencyTracker({ maxEntries: 4 });
  assert.equal(tracker.acquire("a", 1), true);
  assert.equal(tracker.acquire("a", 1), false);
  tracker.release("a");
  assert.equal(tracker.acquire("a", 1), true);
  assert.equal(tracker.acquire("b", 0), true, "0 disables the ceiling");
  assert.equal(tracker.count("b"), 0);
});

test("the generated documents never leak into the JSON route ledger, and vice versa", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  const documents = app.app.documents();
  assert.ok(documents.length >= 8 + ALIASES.size + AUTH_REDIRECTS.size + 4);
  for (const entry of documents) assert.ok(!entry.path.startsWith("/api/"), "documents are not API routes");

  const routes = await app.app.inject({ method: "GET", url: "/api/v1/system/routes" });
  for (const entry of routes.json().routes) {
    assert.match(entry.path, /^\/api\/v1\//, "the API ledger stays API-only");
    assert.ok(!documents.some((document) => document.path === entry.path), `${entry.path} must not appear in both ledgers`);
  }
  const contact = routes.json().routes.find((entry) => entry.path === "/api/v1/site/contact");
  assert.equal(contact.rateLimited, true, "public intake is throttled and the ledger says so");
  const listing = routes.json().routes.find((entry) => entry.path === "/api/v1/admin/inquiries");
  assert.equal(listing.permission, "system.super_admin");
});

test("rendered pages carry no inline script or style, keeping the production CSP honest", async (t) => {
  const app = await harness();
  t.after(() => app.cleanup());
  for (const page of PAGES) {
    const response = await app.app.inject({ method: "GET", url: page.path, headers: { accept: "text/html" } });
    assert.equal(response.statusCode, 200);
    assert.doesNotMatch(response.body, /<script(?![^>]*\ssrc=)/, `${page.path} must not embed inline script`);
    assert.doesNotMatch(response.body, /\son[a-z]+\s*=/i, `${page.path} must not use inline event handlers`);
    assert.doesNotMatch(response.body, /\sstyle\s*=/i, `${page.path} must not use inline styles`);
    assert.match(response.headers["content-security-policy"], /script-src 'self'/);
    for (const href of [...response.body.matchAll(/href="([^"]+)"/g)].map((match) => match[1])) {
      assert.ok(href.startsWith("/") || href.startsWith("#") || href.startsWith("https://site.example.test"), `${page.path} links only same-origin targets (${href})`);
      assert.ok(!href.startsWith("//"), `${page.path} has no protocol-relative link`);
    }
  }
});

test("the page content model rejects unknown block types instead of rendering them silently", async () => {
  const { renderBlock } = await import("../src/modules/site/render.js");
  assert.throws(
    () => renderBlock({ type: "carousel" }, { languages: 20, year: 2026 }),
    /Unknown public-site block type/,
    "a typo in a content block must fail a test, not ship an empty section",
  );
});
