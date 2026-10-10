/**
 * Public-site page inventory and content (finding F-10).
 *
 * One source of truth for three things that must never disagree: the navigation,
 * the sitemap, and the routes. Adding a page here adds it to all three, and
 * `test/site.test.js` asserts that against the legacy oracle
 * (`application/controllers/Site.php`, `application/views/site/*`,
 * `application/controllers/Seo.php`).
 *
 * Content is data, not template strings, so the renderer escapes every value and
 * a copy edit cannot introduce markup. `raw` is never used: no block can emit
 * unescaped HTML, which is what keeps the CSP free of `unsafe-inline`.
 *
 * Copy is ported from the legacy PHP views. Where the Node platform genuinely
 * differs (no ported language-learning registry, no binary image assets, the
 * side-by-side migration state) the difference is stated on the page instead of
 * being papered over.
 */

/** Every public page, in navigation order. `aliases` are legacy paths that 301 here. */
export const PAGES = Object.freeze([
  {
    key: "home",
    path: "/",
    nav: "Home",
    title: "Home",
    description: "WINDELS AI WORKFORCE — one workspace for market analysis, sports research, lottery study, language learning and lead discovery, with the guardrails in view.",
    inSitemap: true,
  },
  {
    key: "about",
    path: "/about",
    nav: "About",
    title: "About",
    description: "What WINDELS AI WORKFORCE is, what already exists in the product, and how visitors, members and administrators are separated.",
    inSitemap: true,
  },
  {
    key: "services",
    path: "/services",
    nav: "Services",
    title: "Services",
    description: "The modules that run in this product — trading intelligence, language learning, sports, lead discovery, lottery research, risk and execution.",
    inSitemap: true,
  },
  {
    key: "how",
    path: "/how-it-works",
    aliases: Object.freeze(["/how"]),
    nav: "How it works",
    title: "How it works",
    description: "From visitor to a role-checked workspace: registration, authentication, role resolution and per-module permission checks.",
    inSitemap: true,
  },
  {
    key: "locations",
    path: "/locations",
    aliases: Object.freeze(["/coverage"]),
    nav: "Coverage",
    title: "Coverage",
    description: "Where the product actually operates: market watchlist, language registry, lead search coverage, and provider-gated sports and lottery research.",
    inSitemap: true,
  },
  {
    key: "safety",
    path: "/safety",
    nav: "Safety",
    title: "Safety & trust",
    description: "Authentication, authorization, the kill switch, honest data labelling, the audit trail and the conditions a broker write must satisfy.",
    inSitemap: true,
  },
  {
    key: "faq",
    path: "/faq",
    aliases: Object.freeze(["/help"]),
    nav: "FAQ",
    title: "FAQ",
    description: "Short answers about dashboards, administrator access, password resets, empty sports data, simulated candles and the public assistant.",
    inSitemap: true,
  },
  {
    key: "contact",
    path: "/contact",
    nav: "Contact",
    title: "Contact",
    description: "Send a message to the operator. Every inquiry is written to the audit trail; outbound mail is sent only when the host configures it.",
    inSitemap: true,
  },
]);

export const PAGE_BY_PATH = Object.freeze(new Map(PAGES.map((page) => [page.path, page])));
export const PAGE_BY_KEY = Object.freeze(new Map(PAGES.map((page) => [page.key, page])));

/** Alias → canonical path, for the 301s that keep legacy links and bookmarks working. */
export const ALIASES = Object.freeze(new Map(PAGES.flatMap((page) => (page.aliases || []).map((alias) => [alias, page.path]))));

/**
 * Authentication entry points. The legacy application renders `/login` and
 * `/register` as PHP pages; on this platform the sign-in and registration forms
 * live in the SPA under `/app/`, so these paths redirect there rather than
 * maintaining a second implementation of the same form.
 *
 * They are deliberately **not** in the sitemap: `robots.txt` disallows `/app/`,
 * and submitting a URL that redirects into a disallowed tree is the kind of
 * self-contradiction a crawler reports as an error.
 */
export const AUTH_REDIRECTS = Object.freeze(new Map([
  ["/login", "/app/login"],
  ["/admin/login", "/app/login"],
  ["/register", "/app/register"],
  ["/forgot-password", "/app/login"],
  ["/access-denied", "/app/"],
  ["/dashboard", "/app/"],
]));

/** Sitemap paths, in the order the legacy `Seo::sitemap()` emitted them. */
export function sitemapPaths() {
  return PAGES.filter((page) => page.inSitemap).map((page) => page.path);
}

/** Paths a crawler must never be sent to: the API, the workspace and private files. */
export const DISALLOWED_PREFIXES = Object.freeze(["/api/", "/app/", "/admin", "/account", "/dashboard", "/analysis", "/uploads/", "/private/", "/data/"]);

export function navigation() {
  return PAGES.map((page) => ({ key: page.key, href: page.path, label: page.nav }));
}

/**
 * Page bodies. Each block is a declarative section; `render.js` turns it into
 * escaped HTML. `{languages}` and `{year}` are substituted by the renderer from
 * configuration — never concatenated into copy by hand.
 */
export const CONTENT = Object.freeze({
  home: Object.freeze([
    {
      type: "hero",
      eyebrow: "WINDELS AI WORKFORCE",
      heading: "Your AI-powered workforce, grounded in evidence.",
      lede: "One workspace for market analysis, sports research, lottery study, an AI language teacher and lead discovery — without inventing data or bypassing risk controls.",
      actions: [
        { href: "/app/register", label: "Get started", style: "primary" },
        { href: "/services", label: "Explore services", style: "text" },
      ],
      pills: ["{languages} languages", "Real TTS voices", "Persistent dashboard", "Secure RBAC"],
      note: "The Node.js platform is being built alongside the current PHP application, module by module. This site is not a production replacement, and no module is claimed as ported until its parity tests pass.",
      visual: {
        center: ["W", "ONE WORKSPACE"],
        nodes: [
          { className: "node-market", icon: "↗", label: "Market\nintelligence" },
          { className: "node-sports", icon: "⌁", label: "Sports\nresearch" },
          { className: "node-learning", icon: "文", label: "Language\nlearning" },
          { className: "node-leads", icon: "◎", label: "Lead\ndiscovery" },
        ],
        stamp: ["BUILT AROUND", "human\njudgment"],
        bottomline: ["RESEARCH · LEARNING · OPERATIONS", "BUILT FOR CLARITY, NOT HYPE"],
      },
    },
    {
      type: "split",
      id: "what",
      index: "01 / WHAT WINDELS AI WORKFORCE DOES",
      heading: "One AI workforce. Every day's work in one workspace.",
      intro: "WINDELS AI WORKFORCE brings AI assistance, conversations, language learning and research tools into a single professional workspace — so you can run a task, understand the result and act on it from one place.",
      subheading: "Built for real tasks, not a demo display",
      checklist: [
        "AI Workforce — multi-agent analysis with an evidence trail and risk checks",
        "AI Assistant & Conversations — ask questions, keep context, get grounded answers",
        "Language Learning — translation, listening, voice and speaking practice",
        "Productivity — dashboards, alerts, analytics and account settings in one place",
      ],
      actions: [{ href: "/services", label: "Explore the product", style: "primary" }],
      aside: ["Human decisions.", "Evidence in view."],
    },
    {
      type: "cards",
      id: "capabilities",
      index: "02 / AI FEATURES",
      heading: "Everything you need, clearly organised",
      intro: "Each card names a module in the product and says plainly whether this Node platform has ported it yet.",
      cards: [
        { number: "01", title: "AI Workforce", text: "Run multi-agent analysis and review a clear consensus, regime and risk decision.", foot: "ANALYSIS · CONSENSUS · RISK", link: { href: "/services", label: "Open AI Workforce" } },
        { number: "02", title: "AI Assistant", text: "Ask a question while you work and get a grounded answer from the product help guide.", foot: "GUIDE · GROUNDED ANSWERS", link: { href: "/how-it-works", label: "See how it answers" } },
        { number: "03", title: "AI Conversations", text: "Keep talking to the assistant in the floating chat window without losing your place.", foot: "CONTEXT · FLOATING WINDOW", link: { href: "/how-it-works", label: "Open the guide" } },
        { number: "04", title: "Language Learning", text: "Learn any supported language with a real learning path and authored content.", foot: "LESSONS · PRACTICE · PROGRESS", link: { href: "/services", label: "Explore learning" } },
        { number: "05", title: "Translation", text: "Translate both ways between any supported language pair with one click.", foot: "BIDIRECTIONAL · ONE CLICK", link: { href: "/services", label: "Try translation" } },
        { number: "06", title: "Voice / Pronunciation", text: "Listen to natural voice playback and replay the pronunciation while you learn.", foot: "TTS · REPLAY", link: { href: "/services", label: "Hear the voices" } },
        { number: "07", title: "Speaking Practice", text: "Practice speaking with real speech recognition and helpful, honest feedback.", foot: "RECOGNITION · HONEST FEEDBACK", link: { href: "/services", label: "Start speaking" } },
        { number: "08", title: "Productivity", text: "Keep dashboards, alerts, analytics and settings organised in one professional layout.", foot: "DASHBOARDS · ALERTS · SETTINGS", link: { href: "/services", label: "See the workflow" } },
      ],
    },
    {
      type: "steps",
      id: "how-it-works",
      index: "03 / HOW IT WORKS",
      heading: "Four steps. Then the audit trail.",
      steps: [
        { title: "Create an account", text: "Register as a platform member. Public pages show Login, Register and Forgot password — never an admin login." },
        { title: "Open your workspace", text: "Members land on the dashboard. Administrators reach a private control centre. Role is decided by the server." },
        { title: "Use a real module", text: "Run analysis, paper-trade, study a language, review sports or search leads. The sidebar stays mounted." },
        { title: "Stay inside the rules", text: "Kill switch, RBAC, CSRF and labelled simulation stay on. Nothing is faked to look complete." },
      ],
      actions: [{ href: "/how-it-works", label: "See the full flow", style: "ghost" }],
    },
    {
      type: "stats",
      stats: [
        { value: "{languages}", label: "Languages in the authored teacher registry" },
        { value: "15", label: "Steps in the execution supervisor" },
        { value: "4", label: "Built-in trading strategies" },
        { value: "0", label: "Orders placed from the public website" },
      ],
    },
    {
      type: "principles",
      id: "principles",
      index: "04 / OUR PRINCIPLES",
      heading: "Trust comes from knowing the limits.",
      intro: "AI should help people understand the options — not conceal uncertainty or bypass a safety check.",
      principles: [
        { title: "Evidence before confidence", text: "Data freshness, provenance and uncertainty belong beside the result." },
        { title: "People stay in control", text: "Recommendations are not orders. Sensitive actions stay behind explicit checks." },
        { title: "Private by design", text: "Account and organization boundaries are enforced on the server." },
        { title: "No inflated promises", text: "Unavailable providers and unsupported assessments are labeled honestly." },
      ],
      actions: [{ href: "/safety", label: "Read the safety controls", style: "text" }],
    },
    {
      type: "pills",
      id: "use-cases",
      index: "05 / COVERAGE",
      heading: "Software coverage, not invented depots",
      intro: "Use the real modules. The teacher registry, the market watchlist and Places search are what exist in this codebase.",
      pills: [
        "Forex & metals watchlist",
        "Crypto via Binance public REST",
        "{languages} languages in the learning registry",
        "EuroMillions research module",
        "Lead search wherever Places is configured",
      ],
      actions: [{ href: "/locations", label: "View coverage", style: "ghost" }],
    },
    {
      type: "cta",
      id: "cta",
      heading: "Ready to open a workspace?",
      text: "Create a member account, or sign in if you already have one. Dashboards stay behind authentication.",
      actions: [
        { href: "/app/register", label: "Create account", style: "primary" },
        { href: "/app/login", label: "Sign in", style: "ghost" },
      ],
    },
    {
      type: "faq",
      id: "faq",
      index: "06 / FAQ",
      heading: "Short answers",
      items: [
        { question: "Can I open the dashboard without an account?", answer: "No. /dashboard and the module consoles redirect visitors to login." },
        { question: "What is WINDELS AI WORKFORCE?", answer: "An AI-powered workforce platform for language learning, market analysis, sports and lottery research, and lead discovery. It never invents data to look complete." },
        { question: "Who can use the admin area?", answer: "Only accounts with the super-administrator permission. Other users see Access denied." },
      ],
      actions: [{ href: "/faq", label: "All questions", style: "ghost" }],
    },
    {
      type: "cta",
      id: "contact",
      heading: "Talk to the operator",
      text: "Messages are written to the audit trail. If outbound mail is configured on the host, a copy is emailed.",
      actions: [{ href: "/contact", label: "Open the contact form", style: "primary" }],
    },
  ]),

  about: Object.freeze([
    {
      type: "pageHero",
      eyebrow: "About us",
      heading: "Built as one product, not a pile of screens",
      lede: "WINDELS AI WORKFORCE is one application for visitors, members and administrators — with different layouts and different gates.",
    },
    {
      type: "split",
      heading: "What exists today",
      paragraphs: [
        "The repository already contains a multi-agent trading stack, paper trading, an execution supervisor, sports intelligence, a {languages}-language teacher, lottery research and Scout lead discovery.",
        "Those working pieces are organized into a public site, a member workspace and an admin control centre. No fictional logistics fleets or city depots were added to make the product look larger than it is.",
      ],
      subheading: "And what this Node platform is",
      checklist: [
        "A side-by-side migration target: the PHP/CodeIgniter application stays authoritative and deployable",
        "Identity, accounts and the platform core are ported and tested; the other product domains are not",
        "Every unported module is reported as unported by /api/v1/system/status rather than stubbed out",
      ],
      aside: ["One application.", "Three gates."],
    },
    {
      type: "cards",
      heading: "Three audiences, three gates",
      cards: [
        { number: "01", title: "Public visitors", text: "Read the company pages, compare services, and create or recover an account. They never see internal sidebars.", foot: "NO SESSION REQUIRED" },
        { number: "02", title: "Members", text: "After login they land on the dashboard and can open only the modules their roles allow.", foot: "ROLE-CHECKED" },
        { number: "03", title: "Administrators", text: "Super administrators use a private control centre for users, readiness and account status. It is never linked from the public site and non-admins are denied.", foot: "PERMISSION-GATED" },
      ],
    },
  ]),

  services: Object.freeze([
    {
      type: "pageHero",
      eyebrow: "Services",
      heading: "Modules that already run in this product",
      lede: "Each card maps to a signed-in console. Planned connectors stay marked planned.",
    },
    {
      type: "cards",
      cards: [
        { number: "01", title: "Trading intelligence", text: "Multi-agent analysis, consensus, regime detection and a risk-reviewed trade proposal. The public site cannot place an order.", foot: "ANALYSIS · STRATEGY LAB · PAPER · EXECUTION · BROKERS · RISK · JOURNAL", link: { href: "/app/login", label: "Open after login" } },
        { number: "02", title: "Language learning", text: "{languages} registered languages, adaptive assessment, lessons, vocabulary SRS, listening and speaking with honest provider limits.", foot: "WORKSPACE: /app/languages", link: { href: "/app/login", label: "Open after login" } },
        { number: "03", title: "Sports intelligence", text: "Stored fixtures, odds, tickets and settlement. The engine reports DISABLED_NO_PROVIDER until a feed is configured.", foot: "WORKSPACE: /sports", link: { href: "/app/login", label: "Open after login" } },
        { number: "04", title: "Lead discovery", text: "Google Places search, normalization, collections, pipeline and formula-safe export. Disabled when the Places key is empty.", foot: "WORKSPACE: /leads", link: { href: "/app/login", label: "Open after login" } },
        { number: "05", title: "Lottery research", text: "EuroMillions rules, statistics and ticket tools. Official feeds stay off until a licensed source is configured.", foot: "API MODULE · lottery.view", link: { href: "/app/login", label: "Open after login" } },
        { number: "06", title: "Risk & execution", text: "Kill switch, automation envelope and a 15-step supervisor. Broker writes need an authenticated bridge and explicit flags.", foot: "WORKSPACE: /execution · /risk", link: { href: "/app/login", label: "Open after login" } },
      ],
    },
    {
      type: "notice",
      heading: "Migration status of this platform",
      text: "The modules above run in the legacy PHP application today. On this Node platform only identity, accounts and administration are ported; /api/v1/system/status lists the state of every module and nothing is presented as ready before its parity tests pass.",
      actions: [{ href: "/how-it-works", label: "How the migration is gated", style: "text" }],
    },
  ]),

  how: Object.freeze([
    {
      type: "pageHero",
      eyebrow: "How it works",
      heading: "From visitor to a role-checked workspace",
      lede: "Create an account, sign in, and the server decides which dashboard you can open.",
    },
    {
      type: "steps",
      steps: [
        { title: "Create an account", text: "Register with a username, email and a 12+ character password. New accounts receive the platform_member role (trading.view, sports.view, lottery.view)." },
        { title: "Authenticate", text: "Login checks the password hash, rotates the session and issues a CSRF token. Five failures lock that account for 15 minutes." },
        { title: "Role check", text: "Members go to the dashboard. Administrators reach their private control centre separately — never via a public link — and a member who opens an admin URL is denied." },
        { title: "Use a module", text: "Each console still enforces its own permission for writes — kill switch, sports approve/settle, lottery manage and trading execute are never implied by a URL." },
      ],
    },
    {
      type: "checklist",
      heading: "What a visitor cannot do",
      items: [
        "Open the dashboard, analysis or any module console without signing in",
        "Call a protected /api/v1 route — the answer is 401 unauthenticated, 403 without the permission",
        "See the workspace sidebar on a public page",
        "Submit a cross-site mutation: origin checks and the session-bound CSRF token both apply",
      ],
    },
  ]),

  locations: Object.freeze([
    {
      type: "pageHero",
      eyebrow: "Coverage",
      heading: "Where the product actually operates",
      lede: "WINDELS AI WORKFORCE is software. We do not list warehouses, taxi ranks or fuel depots that are not in this codebase.",
    },
    {
      type: "cards",
      cards: [
        { number: "01", title: "Market coverage", text: "Watchlist symbols include EURUSD, GBPUSD, XAUUSD, BTCUSDT, ETHUSDT and SOLUSDT. Crypto uses Binance public REST when reachable; otherwise analysis is labelled simulation.", foot: "WATCHLIST · LABELLED SIMULATION" },
        { number: "02", title: "Language coverage", text: "The teacher registry lists {languages} languages. Assessment ceilings are per language and never exceed the authored bank.", foot: "AUTHORED REGISTRY" },
        { number: "03", title: "Lead coverage", text: "Business search follows Google Places for the query you type. There is no built-in Africa-only Places dataset.", foot: "PROVIDER-DEPENDENT" },
        { number: "04", title: "Sports & lottery", text: "Sports is provider-gated. Lottery research starts with EuroMillions rules. Official live feeds stay off until licensed.", foot: "DISABLED_NO_PROVIDER UNTIL CONFIGURED" },
      ],
    },
  ]),

  safety: Object.freeze([
    {
      type: "pageHero",
      eyebrow: "Safety & trust",
      heading: "Controls that stay on when nobody is watching",
      lede: "These are the invariants the platform is tested against, not aspirations.",
    },
    {
      type: "cards",
      cards: [
        { number: "01", title: "Authentication", text: "Sessions live server-side and are stored hashed. Passwords are hashed. Login is rate-limited and locks per account. Logout requires the CSRF token issued at sign-in.", foot: "SESSIONS · ROTATION · LOCKOUT" },
        { number: "02", title: "Authorization", text: "Hiding a menu is not enough. Pages require a session; APIs return 401 or 403; writes re-check RBAC and CSRF.", foot: "DENY BY DEFAULT" },
        { number: "03", title: "Kill switch", text: "The platform boots with the kill switch active. Paper and broker orders are blocked until an authorized operator releases it.", foot: "FAIL-CLOSED" },
        { number: "04", title: "Honest data", text: "Synthetic candles, sandbox sports and missing providers are labelled. Missing values stay null. CSV export is formula-safe.", foot: "PROVENANCE IN VIEW" },
        { number: "05", title: "Audit", text: "Logins, contact inquiries, user creation and trading events are written to the audit trail with an actor.", foot: "ATTRIBUTED EVENTS" },
        { number: "06", title: "Broker writes", text: "Order submission needs an authenticated bridge, TRADING_ENABLED, and a demo account unless live is explicitly allowed.", foot: "EXPLICIT FLAGS ONLY" },
      ],
    },
  ]),

  faq: Object.freeze([
    {
      type: "pageHero",
      eyebrow: "Help / FAQ",
      heading: "Questions we can answer from the product",
    },
    {
      type: "faq",
      items: [
        { question: "How do I get a dashboard?", answer: "Register or sign in. Members land on the dashboard. Administrator controls are reached through a private entry point that is never advertised on the public site." },
        { question: "I tried an admin URL as a normal user", answer: "You will be denied. Only accounts with the super-administrator permission may use the control centre." },
        { question: "I forgot my password", answer: "This build does not invent email reset tokens. An administrator can create a replacement account or set a new hash. The Node API answers a reset request with an actionable 400 rather than pretending to send mail." },
        { question: "Why is sports empty?", answer: "No sports provider is configured. The module refuses to fabricate fixtures, odds or tickets." },
        { question: "Why do some candles say SIM?", answer: "A real provider failed or does not serve that timeframe. The synthetic generator is labelled and the risk engine can veto it." },
        { question: "Can I book a ride or a shipment?", answer: "No. Those services are not implemented. The public site only describes modules that exist." },
        { question: "Is the chat connected to my account?", answer: "No. The public assistant uses the product guide. It does not receive private leads, tickets or positions." },
        { question: "Is this Node site the production platform?", answer: "Not yet. It is the migration target running side by side with the PHP application, which remains authoritative and is the rollback target. Identity and accounts are ported; the other modules are listed as unported by the status API." },
      ],
    },
  ]),

  contact: Object.freeze([
    {
      type: "pageHero",
      eyebrow: "Contact",
      heading: "Send a message to the operator",
      lede: "The inquiry is stored and written to the audit trail. Outbound mail is sent only if the host configures it — this platform never claims a delivery it did not make.",
    },
    { type: "contactForm" },
  ]),
});

/** Fallback for a path that matches no page: same layout, honest status. */
export const NOT_FOUND_CONTENT = Object.freeze([
  {
    type: "pageHero",
    eyebrow: "404",
    heading: "That page is not here",
    lede: "The path you asked for does not match a public page, a workspace route or an API endpoint on this platform.",
  },
  {
    type: "checklist",
    heading: "Where to go instead",
    items: [
      "Home — the product overview",
      "Services — the modules that exist",
      "FAQ — short answers, including what is not implemented",
      "Contact — ask the operator directly",
    ],
  },
]);
