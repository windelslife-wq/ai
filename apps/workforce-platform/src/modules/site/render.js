/**
 * Server-side HTML rendering for the public site.
 *
 * Rules this module exists to enforce:
 *  - every value is escaped; no block can emit raw markup, so the CSP stays
 *    `script-src 'self'; style-src 'self'` with no `unsafe-inline` in production;
 *  - links are validated (same-origin relative paths only) before they reach an
 *    `href`, so a copy edit cannot create a `javascript:` URL;
 *  - `<head>` metadata (title, description, robots, canonical, Open Graph) comes
 *    from the validated site config, never from a per-page literal — that is the
 *    F-10 fix: one SEO surface, configured once;
 *  - output is deterministic for a given config and path, so it can be hashed
 *    into an ETag and precached by the service worker.
 */

import { PAGES, navigation } from "./pages.js";

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

/**
 * A link is only rendered when it is a same-origin absolute path (optionally with
 * a query or fragment). Everything else — including `//host`, `javascript:` and
 * absolute URLs — is refused, and the caller renders plain text instead.
 */
export function safeHref(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  if (/[\s"'<>\\]/.test(trimmed)) return null;
  return trimmed;
}

function attributes(entries) {
  const parts = [];
  for (const [name, value] of Object.entries(entries)) {
    if (value === null || value === undefined || value === false) continue;
    parts.push(value === true ? escapeHtml(name) : `${escapeHtml(name)}="${escapeHtml(value)}"`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function tag(name, attrs, children) {
  const open = `<${name}${attributes(attrs || {})}`;
  if (VOID_ELEMENTS.has(name)) return `${open}>`;
  const body = Array.isArray(children) ? children.join("") : (children ?? "");
  return `${open}>${body}</${name}>`;
}

/** `{languages}` / `{year}` are the only substitutions copy may contain. */
export function interpolate(text, { languages, year }) {
  return String(text ?? "")
    .replaceAll("{languages}", String(languages))
    .replaceAll("{year}", String(year));
}

function link(block, tokens) {
  const href = safeHref(block.href);
  if (!href) return tag("span", { class: "text-link" }, escapeHtml(interpolate(block.label, tokens)));
  const style = block.style === "primary" ? "button button-primary" : block.style === "ghost" ? "button button-ghost" : "text-link";
  return tag("a", { class: style, href }, `${escapeHtml(interpolate(block.label, tokens))}${block.arrow === false ? "" : ""}`);
}

function actions(blocks, tokens, className = "section-actions") {
  if (!blocks?.length) return "";
  return tag("div", { class: className }, blocks.map((block) => link(block, tokens)));
}

function heading(block, tokens) {
  const parts = [];
  if (block.index) parts.push(tag("div", { class: "section-index" }, escapeHtml(interpolate(block.index, tokens))));
  if (block.eyebrow) parts.push(tag("p", { class: "eyebrow" }, escapeHtml(interpolate(block.eyebrow, tokens))));
  if (block.heading) parts.push(tag("h2", { id: block.headingId || undefined }, escapeHtml(interpolate(block.heading, tokens))));
  if (block.intro) parts.push(tag("p", { class: "section-intro" }, escapeHtml(interpolate(block.intro, tokens))));
  return parts.join("");
}

/** Renders one content block. Unknown types throw: a typo must fail a test, not a page. */
export function renderBlock(block, tokens) {
  switch (block.type) {
    case "hero": {
      const copy = tag("div", { class: "hero-copy" }, [
        tag("div", { class: "eyebrow" }, `${tag("span", { class: "eyebrow-dot" })} ${escapeHtml(interpolate(block.eyebrow, tokens))}`),
        tag("h1", {}, escapeHtml(interpolate(block.heading, tokens))),
        tag("p", { class: "hero-lede" }, escapeHtml(interpolate(block.lede, tokens))),
        actions(block.actions, tokens, "hero-actions"),
        block.pills?.length ? tag("div", { class: "pill-row" }, block.pills.map((pill) => tag("span", { class: "pill" }, escapeHtml(interpolate(pill, tokens))))) : "",
        block.note ? tag("p", { class: "hero-note" }, `${tag("span", { class: "note-marker" }, "i")} ${escapeHtml(interpolate(block.note, tokens))}`) : "",
      ]);
      const visual = block.visual
        ? tag("div", { class: "hero-visual", "aria-label": "Illustration of the connected workspace modules" }, [
          tag("div", { class: "orbit orbit-one" }),
          tag("div", { class: "orbit orbit-two" }),
          tag("div", { class: "orbit orbit-three" }),
          tag("div", { class: "visual-center" }, [tag("span", { class: "visual-center-mark" }, escapeHtml(block.visual.center[0])), tag("span", {}, escapeHtml(block.visual.center[1]))]),
          ...block.visual.nodes.map((node) => tag("div", { class: `visual-node ${node.className}` }, [
            tag("span", { class: "node-icon" }, escapeHtml(node.icon)),
            tag("span", {}, node.label.split("\n").map(escapeHtml).join(tag("br"))),
          ])),
          tag("div", { class: "visual-stamp" }, [
            tag("span", {}, escapeHtml(block.visual.stamp[0])),
            tag("strong", {}, block.visual.stamp[1].split("\n").map(escapeHtml).join(tag("br"))),
            tag("i", { "aria-hidden": "true" }, "✳"),
          ]),
        ])
        : "";
      const bottomline = block.visual?.bottomline
        ? tag("div", { class: "hero-bottomline" }, block.visual.bottomline.map((entry) => tag("span", {}, escapeHtml(entry))))
        : "";
      return tag("section", { class: "hero", id: block.id || "platform" }, [copy, visual, bottomline]);
    }

    case "pageHero":
      return tag("section", { class: "page-hero" }, [
        block.eyebrow ? tag("p", { class: "eyebrow" }, escapeHtml(interpolate(block.eyebrow, tokens))) : "",
        tag("h1", {}, escapeHtml(interpolate(block.heading, tokens))),
        block.lede ? tag("p", { class: "hero-lede" }, escapeHtml(interpolate(block.lede, tokens))) : "",
      ]);

    case "split": {
      const body = [
        block.subheading ? tag("h3", {}, escapeHtml(interpolate(block.subheading, tokens))) : "",
        ...(block.paragraphs || []).map((paragraph) => tag("p", {}, escapeHtml(interpolate(paragraph, tokens)))),
        block.checklist?.length ? tag("ul", { class: "checklist" }, block.checklist.map((item) => tag("li", {}, escapeHtml(interpolate(item, tokens))))) : "",
        actions(block.actions, tokens),
      ].join("");
      const headingId = block.heading ? `${block.id || "section"}-title` : undefined;
      return tag("section", { class: "band intro-section section-wrap", id: block.id || undefined, "aria-labelledby": headingId }, [
        block.index ? tag("div", { class: "section-index" }, escapeHtml(interpolate(block.index, tokens))) : "",
        tag("div", { class: "intro-content" }, [
          block.heading ? tag("h2", { id: headingId }, escapeHtml(interpolate(block.heading, tokens))) : "",
          block.intro ? tag("p", {}, escapeHtml(interpolate(block.intro, tokens))) : "",
          body,
        ]),
        // The third grid column. Empty when the page has no aside note; the CSS
        // drops the column below 980px, so an empty cell costs nothing there.
        tag("div", { class: "intro-aside" }, block.aside
          ? [tag("span", { class: "aside-line" }), tag("span", {}, block.aside.map(escapeHtml).join(tag("br")))]
          : ""),
      ]);
    }

    case "cards":
      return tag("section", { class: "band modules-section", id: block.id || undefined }, [
        tag("div", { class: "section-wrap" }, [
          block.heading || block.index || block.intro ? tag("div", { class: "section-heading" }, [tag("div", {}, heading(block, tokens)), block.intro && !block.heading ? tag("p", {}, escapeHtml(interpolate(block.intro, tokens))) : ""]) : "",
          tag("div", { class: "module-grid" }, block.cards.map((card) => tag("article", { class: "module-card" }, [
            tag("div", { class: "card-top" }, [
              card.number ? tag("span", { class: "card-number" }, escapeHtml(card.number)) : "",
              tag("span", { class: "card-arrow", "aria-hidden": "true" }, "↗"),
            ]),
            tag("h3", {}, escapeHtml(interpolate(card.title, tokens))),
            tag("p", {}, escapeHtml(interpolate(card.text, tokens))),
            card.link ? tag("div", { class: "card-link" }, link(card.link, tokens)) : "",
            card.foot ? tag("span", { class: "card-foot" }, escapeHtml(interpolate(card.foot, tokens))) : "",
          ]))),
          actions(block.actions, tokens),
        ]),
      ]);

    case "steps":
      return tag("section", { class: "band steps-section section-wrap", id: block.id || undefined }, [
        heading(block, tokens),
        tag("ol", { class: "steps" }, block.steps.map((step, index) => tag("li", {}, [
          tag("span", { class: "step-number" }, String(index + 1).padStart(2, "0")),
          tag("div", {}, [tag("h3", {}, escapeHtml(interpolate(step.title, tokens))), tag("p", {}, escapeHtml(interpolate(step.text, tokens)))]),
        ]))),
        actions(block.actions, tokens),
      ]);

    case "principles":
      return tag("section", { class: "band principles-section", id: block.id || undefined }, [
        tag("div", { class: "section-wrap principles-layout" }, [
          tag("div", { class: "principles-heading" }, [
            block.index ? tag("div", { class: "section-index" }, escapeHtml(interpolate(block.index, tokens))) : "",
            tag("h2", {}, escapeHtml(interpolate(block.heading, tokens))),
            block.intro ? tag("p", {}, escapeHtml(interpolate(block.intro, tokens))) : "",
            actions(block.actions, tokens),
          ]),
          tag("div", { class: "principles-list" }, block.principles.map((principle, index) => tag("article", {}, [
            tag("span", { class: "principle-number" }, String(index + 1).padStart(2, "0")),
            tag("div", {}, [tag("h3", {}, escapeHtml(interpolate(principle.title, tokens))), tag("p", {}, escapeHtml(interpolate(principle.text, tokens)))]),
            tag("span", { class: "principle-mark", "aria-hidden": "true" }, "↗"),
          ]))),
        ]),
      ]);

    case "stats":
      return tag("section", { class: "stats-band" }, block.stats.map((entry) => tag("div", {}, [
        tag("b", {}, escapeHtml(interpolate(entry.value, tokens))),
        tag("span", {}, escapeHtml(interpolate(entry.label, tokens))),
      ])));

    case "pills":
      return tag("section", { class: "band section-wrap", id: block.id || undefined }, [
        heading(block, tokens),
        tag("div", { class: "pill-row" }, block.pills.map((pill) => tag("span", { class: "pill" }, escapeHtml(interpolate(pill, tokens))))),
        actions(block.actions, tokens),
      ]);

    case "checklist":
      return tag("section", { class: "band section-wrap", id: block.id || undefined }, [
        block.heading ? tag("h2", {}, escapeHtml(interpolate(block.heading, tokens))) : "",
        tag("ul", { class: "checklist" }, block.items.map((item) => tag("li", {}, escapeHtml(interpolate(item, tokens))))),
        actions(block.actions, tokens),
      ]);

    case "faq":
      return tag("section", { class: "band section-wrap", id: block.id || undefined }, [
        heading(block, tokens),
        tag("div", { class: "faq" }, block.items.map((item, index) => tag("details", { open: index === 0 || undefined }, [
          tag("summary", {}, escapeHtml(interpolate(item.question, tokens))),
          tag("p", {}, escapeHtml(interpolate(item.answer, tokens))),
        ]))),
        actions(block.actions, tokens),
      ]);

    case "cta":
      return tag("section", { class: "closing-section section-wrap", id: block.id || undefined }, [
        tag("div", { class: "closing-mark", "aria-hidden": "true" }, "W"),
        tag("div", {}, [tag("h2", {}, escapeHtml(interpolate(block.heading, tokens))), tag("p", {}, escapeHtml(interpolate(block.text, tokens)))]),
        actions(block.actions, tokens, "closing-actions"),
      ]);

    case "notice":
      return tag("section", { class: "band section-wrap" }, [
        tag("div", { class: "notice-box", role: "status" }, [
          block.heading ? tag("strong", {}, escapeHtml(interpolate(block.heading, tokens))) : "",
          tag("span", {}, escapeHtml(interpolate(block.text, tokens))),
        ]),
        actions(block.actions, tokens),
      ]);

    case "contactForm":
      return tag("section", { class: "band section-wrap" }, [
        // The flash slot is filled by the route from a signed, expiring cookie; the
        // form itself posts to the JSON API and is progressively enhanced. Without
        // script it posts to /contact/submit, which redirects back here.
        tag("div", { class: "flash-slot", "data-flash": "", role: "status", "aria-live": "polite" }),
        tag("form", { class: "contact-form", method: "post", action: "/contact/submit", "data-contact-form": "" }, [
          tag("label", { for: "contact-name" }, [
            "Name",
            tag("input", { id: "contact-name", name: "name", required: true, maxlength: "120", autocomplete: "name" }),
          ]),
          tag("label", { for: "contact-email" }, [
            "Email",
            tag("input", { id: "contact-email", name: "email", type: "email", required: true, maxlength: "190", autocomplete: "email" }),
          ]),
          tag("label", { for: "contact-message" }, [
            "Message",
            tag("textarea", { id: "contact-message", name: "message", required: true, minlength: "10", rows: "6", maxlength: "2000" }),
          ]),
          tag("p", { class: "form-note" }, "Stored on the audit trail with your name and email. Outbound mail is sent only when the host configures SMTP; the response always says which happened."),
          tag("button", { class: "button button-primary", type: "submit" }, "Send message"),
        ]),
      ]);

    default:
      throw new Error(`Unknown public-site block type: ${block.type}`);
  }
}

export function renderBlocks(blocks, tokens) {
  return blocks.map((block) => renderBlock(block, tokens)).join("\n");
}

/**
 * The full document. `flash` is a verified one-shot message from a contact
 * submission; `active` marks the current nav entry.
 */
export function renderDocument({ page, blocks, seo, tokens, active = null, flash = null, statusCode = 200 }) {
  const title = `${page.title}${seo.titleSuffix}`;
  const canonical = seo.canonicalBase ? `${seo.canonicalBase}${page.path === "/" ? "/" : page.path}` : null;
  const description = page.description || seo.description;

  const head = [
    tag("meta", { charset: "utf-8" }),
    tag("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
    tag("title", {}, escapeHtml(title)),
    tag("meta", { name: "description", content: description }),
    seo.keywords ? tag("meta", { name: "keywords", content: seo.keywords }) : "",
    tag("meta", { name: "robots", content: seo.robots }),
    canonical ? tag("link", { rel: "canonical", href: canonical }) : "",
    tag("meta", { property: "og:title", content: title }),
    tag("meta", { property: "og:description", content: description }),
    tag("meta", { property: "og:type", content: "website" }),
    tag("meta", { property: "og:site_name", content: seo.name }),
    canonical ? tag("meta", { property: "og:url", content: canonical }) : "",
    seo.ogImage ? tag("meta", { property: "og:image", content: seo.ogImage }) : "",
    tag("meta", { name: "twitter:card", content: "summary" }),
    tag("meta", { name: "theme-color", content: seo.themeColor }),
    tag("link", { rel: "manifest", href: "/manifest.webmanifest" }),
    tag("link", { rel: "icon", href: "/icons/windels-mark.svg", type: "image/svg+xml" }),
    tag("link", { rel: "icon", href: "/icons/icon-192.png", type: "image/png", sizes: "192x192" }),
    tag("link", { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" }),
    tag("link", { rel: "stylesheet", href: "/styles.css" }),
  ].filter(Boolean).join("");

  const announcement = seo.announcement.length
    ? tag("div", { class: "announcement-bar", "aria-label": "Site announcements" }, [
      tag("div", { class: "announcement-track" }, [
        tag("span", {}, seo.announcement.map(escapeHtml).join(" • ")),
        // Duplicated for a seamless marquee; hidden from assistive technology.
        tag("span", { "aria-hidden": "true" }, seo.announcement.map(escapeHtml).join(" • ")),
      ]),
    ])
    : "";

  const header = tag("header", { class: "site-header" }, [
    tag("a", { class: "brand", href: "/", "aria-label": `${seo.name} home` }, [
      tag("span", { class: "brand-mark", "aria-hidden": "true" }, "W"),
      tag("span", { class: "brand-name" }, `${escapeHtml(seo.name.split(" ")[0])}${tag("span", {}, escapeHtml(seo.name.split(" ").slice(1).join(" ")))}`),
    ]),
    tag("button", { class: "menu-toggle", type: "button", "aria-expanded": "false", "aria-controls": "site-nav", "aria-label": "Open navigation" }, [tag("span"), tag("span")]),
    tag("nav", { id: "site-nav", class: "site-nav", "aria-label": "Main navigation" }, [
      ...navigation().map((entry) => tag("a", { href: entry.href, class: entry.key === active ? "is-active" : null, "aria-current": entry.key === active ? "page" : null }, escapeHtml(entry.label))),
      tag("a", { class: "nav-cta", href: "/app/" }, [escapeHtml("Open workspace"), tag("span", { "aria-hidden": "true" }, "↗")]),
    ]),
  ]);

  const flashMarkup = flash
    ? tag("div", { class: `flash ${flash.tone === "error" ? "flash-error" : "flash-ok"}`, role: flash.tone === "error" ? "alert" : "status" }, escapeHtml(flash.message))
    : "";

  const footer = tag("footer", { class: "site-footer" }, [
    tag("div", { class: "footer-grid" }, [
      tag("div", {}, [
        tag("a", { class: "brand footer-brand", href: "/" }, [tag("span", { class: "brand-mark", "aria-hidden": "true" }, "W"), tag("span", { class: "brand-name" }, escapeHtml(seo.name))]),
        tag("p", {}, escapeHtml(seo.description)),
      ]),
      tag("div", { class: "footer-column" }, [
        tag("span", {}, "Explore"),
        ...PAGES.filter((entry) => ["about", "services", "how", "safety"].includes(entry.key)).map((entry) => tag("a", { href: entry.path }, escapeHtml(entry.nav))),
      ]),
      tag("div", { class: "footer-column" }, [
        tag("span", {}, "Account"),
        tag("a", { href: "/app/login" }, "Login"),
        tag("a", { href: "/app/register" }, "Register"),
        tag("a", { href: "/contact" }, "Contact"),
        tag("a", { href: "/faq" }, "FAQ"),
      ]),
      tag("div", { class: "footer-column" }, [
        tag("span", {}, "Platform"),
        tag("a", { href: "/app/" }, "Workspace"),
        tag("a", { href: "/api/v1/system/status" }, "Module status"),
        tag("a", { href: "/sitemap.xml" }, "Sitemap"),
      ]),
    ]),
    tag("p", { class: "footer-legal" }, `© ${escapeHtml(String(tokens.year))} ${escapeHtml(seo.name)}. Dashboards require a signed-in account. Synthetic or sandbox data is always labelled.`),
  ]);

  return `<!doctype html>
<html lang="en" data-status="${escapeHtml(String(statusCode))}">
<head>
${head}
</head>
<body class="public-site">
${tag("a", { class: "skip-link", href: "#main" }, "Skip to content")}
${announcement}
${header}
<main id="main">
${flashMarkup}
${renderBlocks(blocks, tokens)}
</main>
${footer}
${tag("script", { src: "/site.js", defer: true })}
</body>
</html>
`;
}
