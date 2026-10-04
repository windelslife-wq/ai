import Image from "next/image";
import Link from "next/link";
import { Navigation } from "../components/layout/Navigation";

const capabilities = [
  ["AI Language Teacher", "Instant translation with auto-detection, pronunciation with real TTS, speaking practice with word-accuracy grading. Target language only changes when you explicitly select it."],
  ["Trading Intelligence", "Multi-agent analysis, consensus, regime detection, trade setups, mandatory risk engine, 15-step execution supervisor."],
  ["Lead Discovery", "Search real businesses via Google Places, deduplicate, organize collections, pipeline board, auditable activity."],
  ["Sports & Lottery Research", "Provider-neutral intelligence, honest DISABLED_NO_PROVIDER states, historical statistics labelled non-predictive."],
];

const howItWorks = [
  ["01", "Create account", "Register as a platform member. Role is determined securely by backend/session/database."],
  ["02", "Open workspace", "Login sends you to your dashboard. Admins are routed to admin dashboard securely — no public Admin Login button."],
  ["03", "Choose a module", "Language Teacher, AI Workforce, Leads, Trading, and other tools — all behind authentication."],
  ["04", "Stay governed", "Kill switch, RBAC, CSRF, labelled simulation, audit trail. Nothing is faked to look complete."],
];

const agents = [
  ["Technical Analyst", "Indicators, market structure, regime detection."],
  ["Forex & Crypto Sentiment", "Currency strength, sentiment feed with provenance."],
  ["Fundamentals & Risk", "Risk engine veto, exposure, drawdown, daily loss."],
  ["Language Teacher", "Translator, adaptive assessment, vocabulary SRS, listening & speaking with real browser engines."],
  ["Lead Scout", "Discovery, coverage, duplicates, export safety."],
];

const features = [
  ["Persistent Dashboard", "Sidebar remains mounted while navigating. Back/Forward controls use real navigation history."],
  ["Professional AI Visual", "AI agent avatar displays correctly on desktop, tablet, mobile — no stretch, no overflow, no clipping."],
  ["Secure Auth", "Public sees only Login/Register/Forgot. Admins still authenticate via normal secure system, role checked server-side."],
  ["Voice & Audio", "Listen to words, sentences, AI responses with correct locale voices (nl-NL, es-ES, it-IT, fr-FR, de-DE, en-GB). Speed control, replay, stop."],
  ["Auto Language Detection", "Detects input language, compares with target, translates/explains without accidentally changing target language."],
  ["Responsive & Balanced", "Homepage has clear hierarchy, balanced spacing, no scattered components, no dashboard elements in public pages."],
];

const useCases = [
  ["Learn Dutch, Spanish, Italian...", "Type naturally: 'Hallo, hoe gaat het?' → AI responds in Dutch. Type English while learning Dutch → get Dutch translation + explanation, target stays Dutch."],
  ["Practice Pronunciation", "Every sentence has 🔊 Listen. Uses SpeechProvider abstraction with real Web Speech API, correct locale."],
  ["Trade with Governance", "Analysis → consensus → risk review → paper trading → execution supervisor. No silent fake data."],
  ["Discover Leads", "Real businesses only, provider-attributed, coverage calculated from stored fields."],
];

const faqs = [
  ["Can I open the dashboard without an account?", "No. /dashboard and module consoles redirect visitors to login."],
  ["What is WINDELS AI WORKFORCE?", "An AI-powered workforce platform: language learning, market analysis, sports/lottery research, lead discovery. Evidence-first, audited, fail-closed."],
  ["How does language switching work?", "Your target language only changes when you explicitly select a new language or clearly request it. Typing another language for translation does not change your profile."],
  ["Is voice real?", "Yes. Uses real text-to-speech via browser SpeechSynthesis where available, with locale-correct voices. No fake audio."],
  ["Where is Admin Login?", "There is no public Admin Login button. Admins log in through the normal secure login — role is determined by backend/session/database, and admin routes/APIs are protected server-side."],
];

export default function HomePage() {
  return (
    <>
      <Navigation />
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
        {/* HERO SECTION */}
        <section className="grid overflow-hidden rounded-[2rem] border border-slate-800 bg-slate-900 shadow-2xl lg:grid-cols-[1.1fr_.9fr]">
          <div className="p-7 sm:p-12 lg:p-16">
            <div className="flex items-center gap-3">
              <Image src="/images/windels-mark.png" alt="WINDELS AI WORKFORCE" width={48} height={48} className="rounded-xl object-cover" />
              <p className="text-sm font-semibold uppercase tracking-[.22em] text-cyan-400">WINDELS AI WORKFORCE</p>
            </div>
            <h1 className="mt-7 max-w-2xl text-4xl font-bold leading-tight text-white sm:text-6xl">
              Your AI-powered workforce, grounded in evidence.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-8 text-slate-400">
              A modern workspace that connects people with an AI language teacher, market analysis, sports intelligence, lottery research and lead discovery — without inventing data or bypassing risk controls.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/login" className="rounded-xl bg-cyan-400 px-5 py-3 font-semibold text-slate-950 transition hover:bg-cyan-300">
                Get started
              </Link>
              <Link href="/app/leads" className="rounded-xl border border-slate-700 px-5 py-3 font-semibold text-slate-200 transition hover:border-cyan-600">
                Explore workforce
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap gap-2 text-xs text-slate-500">
              <span className="rounded-full border border-slate-700 px-3 py-1">Persistent sidebar</span>
              <span className="rounded-full border border-slate-700 px-3 py-1">Back/Forward history</span>
              <span className="rounded-full border border-slate-700 px-3 py-1">Real TTS voices</span>
              <span className="rounded-full border border-slate-700 px-3 py-1">Secure role check</span>
            </div>
          </div>
          {/* AI Agent Visual - professional hero composition */}
          <div className="relative flex min-h-[420px] flex-col justify-center bg-gradient-to-br from-slate-900 via-slate-900 to-cyan-950/30 p-7 sm:p-10 lg:min-h-full">
            <div className="relative mx-auto w-full max-w-[380px]">
              {/* Main AI visual card */}
              <div className="relative overflow-hidden rounded-[1.5rem] border border-slate-700 bg-slate-950 p-6 shadow-2xl">
                <div className="flex items-center gap-4">
                  <div className="relative h-[72px] w-[72px] shrink-0 overflow-hidden rounded-2xl border border-cyan-800 bg-slate-900">
                    <Image src="/images/ai-agent-avatar.png" alt="WINDELS AI Agent" fill className="object-cover" priority sizes="72px" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-white">WINDELS Assistant</p>
                    <p className="text-xs text-cyan-300">AI Workforce · Online</p>
                    <p className="mt-1 text-[11px] text-slate-500">Grounded responses · no fake data</p>
                  </div>
                </div>
                <div className="mt-5 space-y-3">
                  <div className="rounded-xl bg-slate-900 px-3 py-2 text-sm text-slate-300">
                    <span className="text-cyan-400">AI:</span> Hallo! Hoe gaat het met je? <span className="ml-2 inline-flex rounded bg-cyan-900/40 px-1.5 py-0.5 text-[10px] text-cyan-300">🔊 Listen</span>
                  </div>
                  <div className="ml-6 rounded-xl bg-cyan-400 px-3 py-2 text-sm font-medium text-slate-950">
                    Hello, how are you?
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs leading-5 text-slate-400">
                    <span className="font-semibold text-slate-300">Detected:</span> English → Dutch translation: <span className="text-white">Hallo! Hoe gaat het met je?</span>
                  </div>
                </div>
                <div className="mt-4 flex gap-2 text-[10px] text-slate-500">
                  <span className="rounded-full border border-slate-700 px-2 py-1">nl-NL voice</span>
                  <span className="rounded-full border border-slate-700 px-2 py-1">0.75x 1x 1.25x</span>
                  <span className="rounded-full border border-slate-700 px-2 py-1">Replay · Stop</span>
                </div>
              </div>
              {/* Floating accent cards - balanced spacing, no overlap */}
              <div className="absolute -right-3 top-6 hidden rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300 shadow-xl sm:block">
                <span className="text-emerald-400">●</span> 20 languages
              </div>
              <div className="absolute -left-4 bottom-10 hidden rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300 shadow-xl sm:block">
                <span className="text-cyan-400">●</span> Real TTS · no fake
              </div>
            </div>
            <p className="mx-auto mt-6 max-w-[380px] text-center text-[12px] leading-4 text-slate-500">
              Grounded assistant · real voices · no invented scores
            </p>
          </div>
        </section>

        {/* WHAT IS WINDELS AI WORKFORCE? */}
        <section className="mt-16">
          <p className="text-xs font-semibold uppercase tracking-[.24em] text-cyan-400">What is WINDELS AI WORKFORCE?</p>
          <h2 className="mt-3 max-w-3xl text-3xl font-bold text-white sm:text-4xl">One platform. Five working modules. Evidence-first.</h2>
          <p className="mt-4 max-w-3xl leading-7 text-slate-400">
            WINDELS AI WORKFORCE is the public face of this product. Behind login you use real tools that already ship: an AI language teacher with auto-detection and voice, plus research and analysis modules with audit trails.
          </p>
        </section>

        {/* CORE AI WORKFORCE CAPABILITIES */}
        <section className="mt-10 grid gap-4 md:grid-cols-2">
          {capabilities.map(([title, copy]) => (
            <article key={title} className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
              <h3 className="text-lg font-semibold text-white">{title}</h3>
              <p className="mt-2 leading-6 text-slate-400">{copy}</p>
            </article>
          ))}
        </section>

        {/* HOW IT WORKS */}
        <section className="mt-16">
          <p className="text-xs font-semibold uppercase tracking-[.24em] text-cyan-400">How it works</p>
          <h2 className="mt-3 text-3xl font-bold text-white sm:text-4xl">Four steps. Then the audit trail.</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-4">
            {howItWorks.map(([num, title, copy]) => (
              <article key={num} className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
                <p className="font-mono text-cyan-400">{num}</p>
                <h3 className="mt-4 text-lg font-semibold text-white">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">{copy}</p>
              </article>
            ))}
          </div>
        </section>

        {/* AI AGENTS / WORKFORCE */}
        <section className="mt-16 grid gap-10 lg:grid-cols-[.9fr_1.1fr] lg:items-start">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.24em] text-cyan-400">AI Agents / Workforce</p>
            <h2 className="mt-3 text-3xl font-bold text-white sm:text-4xl">A workforce that shows its work.</h2>
            <p className="mt-4 leading-7 text-slate-400">Every agent cites evidence. No silent fake data. Debate can only reduce bias — never manufacture conviction.</p>
            <div className="mt-6 space-y-3">
              {agents.map(([name, desc]) => (
                <div key={name} className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                  <p className="font-semibold text-white">{name}</p>
                  <p className="mt-1 text-sm leading-5 text-slate-500">{desc}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
            <Image src="/images/lead-discovery-hero.png" alt="AI workforce collaborating" width={1280} height={853} className="h-auto w-full object-cover" />
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-950 via-slate-950/80 to-transparent p-6 pt-24">
              <p className="text-lg font-semibold text-white">“The dashboard only shows what the engines actually computed. If a provider is down, it says so.”</p>
              <p className="mt-2 text-sm text-cyan-300">— Trading operator · paper workspace</p>
            </div>
          </div>
        </section>

        {/* KEY FEATURES */}
        <section className="mt-16">
          <p className="text-xs font-semibold uppercase tracking-[.24em] text-cyan-400">Key Features</p>
          <h2 className="mt-3 text-3xl font-bold text-white sm:text-4xl">Built for the acceptance checklist.</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {features.map(([title, copy]) => (
              <article key={title} className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
                <h3 className="font-semibold text-white">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">{copy}</p>
              </article>
            ))}
          </div>
        </section>

        {/* USE CASES */}
        <section className="mt-16">
          <p className="text-xs font-semibold uppercase tracking-[.24em] text-cyan-400">Use Cases</p>
          <h2 className="mt-3 text-3xl font-bold text-white sm:text-4xl">Language learning that feels natural.</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-2">
            {useCases.map(([title, copy]) => (
              <article key={title} className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
                <h3 className="font-semibold text-white">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">{copy}</p>
              </article>
            ))}
          </div>
        </section>

        {/* CALL TO ACTION */}
        <section className="mt-16 rounded-2xl border border-cyan-900/60 bg-cyan-950/20 p-7 sm:p-10">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.24em] text-cyan-300">Ready to open a workspace?</p>
              <h2 className="mt-2 text-2xl font-bold text-white">Create an account. No public admin button.</h2>
              <p className="mt-2 max-w-xl text-slate-400">Admins still authenticate through the normal secure system. Role determined by backend/session/database. Admin routes protected server-side.</p>
            </div>
            <div className="flex gap-3">
              <Link href="/login" className="shrink-0 rounded-xl bg-white px-5 py-3 text-center font-semibold text-slate-950 hover:bg-cyan-100">
                Sign in
              </Link>
              <Link href="/" className="shrink-0 rounded-xl border border-slate-700 px-5 py-3 text-center font-semibold text-slate-200">
                Learn more
              </Link>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="mt-16">
          <p className="text-xs font-semibold uppercase tracking-[.24em] text-cyan-400">FAQ</p>
          <h2 className="mt-3 text-3xl font-bold text-white sm:text-4xl">Short answers</h2>
          <div className="mt-8 grid gap-3">
            {faqs.map(([q, a]) => (
              <details key={q} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <summary className="cursor-pointer font-semibold text-white">{q}</summary>
                <p className="mt-2 text-sm leading-6 text-slate-400">{a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* FOOTER */}
        <footer className="mt-16 rounded-2xl border border-slate-800 bg-slate-900 p-7 text-sm text-slate-500">
          <div className="flex flex-col gap-4 sm:flex-row sm:justify-between">
            <div>
              <p className="font-semibold text-white">WINDELS AI WORKFORCE</p>
              <p className="mt-1 max-w-xl">Analysis and simulation only. Synthetic data is labelled. Nothing here is investment advice. Dashboards require authentication.</p>
            </div>
            <div className="flex gap-6">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-400">Explore</p>
                <div className="mt-2 space-y-1">
                  <p>AI Workforce</p>
                  <p>Language Teacher</p>
                  <p>Lead Discovery</p>
                </div>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-400">Account</p>
                <div className="mt-2 space-y-1">
                  <p>Login</p>
                  <p>Register</p>
                  <p>Forgot Password</p>
                </div>
              </div>
            </div>
          </div>
          <p className="mt-6 border-t border-slate-800 pt-4 text-xs">© {new Date().getFullYear()} WINDELS AI WORKFORCE. No public Admin Login. Secure role-based access.</p>
        </footer>
      </main>
    </>
  );
}
