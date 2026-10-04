<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<section class="hero">
  <div class="hero-copy">
    <p class="kicker">WINDELS AI WORKFORCE</p>
    <h1>Your AI-powered workforce, grounded in evidence.</h1>
    <p class="lede">One workspace for an AI language teacher, market analysis, sports intelligence, lottery research and lead discovery — without inventing data or bypassing risk controls.</p>
    <div class="hero-cta">
      <a class="btn solid" href="/register">Get started</a>
      <a class="btn ghost" href="/services">Explore services</a>
    </div>
    <div class="pills" style="margin-top:20px">
      <span>20 languages</span>
      <span>Real TTS voices</span>
      <span>Persistent dashboard</span>
      <span>Secure RBAC</span>
    </div>
  </div>
  <div class="hero-visual">
    <div class="hero-ai-wrap">
      <div class="hero-ai-card">
        <div class="hero-ai-card-head">
          <span class="ai-avatar" id="hero-ai-avatar">
            <img src="/assets/images/ai-agent-avatar.png" alt="WINDELS AI Agent" width="56" height="56" loading="eager" onerror="this.style.display='none';this.parentElement.classList.add('is-fallback');">
            <span class="ai-avatar-fallback">W</span>
          </span>
          <div>
            <strong style="display:block;font:700 14px system-ui,sans-serif">WINDELS Assistant</strong>
            <span style="font:600 12px system-ui,sans-serif;color:var(--brand)">Online · grounded answers</span>
          </div>
        </div>
        <div class="hero-ai-bubble agent">Hallo! Hoe gaat het met je?</div>
        <div class="hero-ai-bubble user">Hello, how are you?</div>
        <div class="hero-ai-bubble agent">Detected English → Dutch: <b>Hallo! Hoe gaat het met je?</b> Target stays Dutch.</div>
        <div class="hero-ai-meta">
          <span>nl-NL voice</span>
          <span>Listen · Replay</span>
          <span>No fake scores</span>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="band" id="what">
  <div class="section-head left">
    <p class="kicker">What WINDELS AI WORKFORCE does</p>
    <h2>One AI workforce. Every day's work in one workspace.</h2>
    <p>WINDELS AI WORKFORCE brings AI assistance, conversations, language learning and research tools into a single professional workspace — so you can run a task, understand the result and act on it from one place.</p>
  </div>
  <div class="split product-split">
    <div class="split-copy">
      <h3>Built for real tasks, not a demo display</h3>
      <ul class="checklist">
        <li><b>AI Workforce</b> — multi-agent analysis with an evidence trail and risk checks</li>
        <li><b>AI Assistant &amp; Conversations</b> — ask questions, keep context and get grounded answers</li>
        <li><b>Language Learning</b> — translation, listening, voice and speaking practice</li>
        <li><b>Productivity</b> — dashboards, alerts, analytics and account settings in one place</li>
      </ul>
      <div class="hero-cta">
        <a class="btn solid" href="/services">Explore the product</a>
      </div>
    </div>
    <figure class="media">
      <img src="/assets/images/about-workspace.jpg" alt="Professional workspace running WINDELS AI WORKFORCE" loading="lazy" width="800" height="550">
    </figure>
  </div>
</section>

<section class="band alt" id="capabilities">
  <div class="section-head">
    <p class="kicker">AI features</p>
    <h2>Everything you need, clearly organised</h2>
    <p>Every feature below is live in the product. Head to the right module when you are ready to use it.</p>
  </div>
  <div class="cards feature-cards four">
    <article class="card">
      <h3>AI Workforce</h3>
      <p>Run multi-agent analysis and review a clear consensus, regime and risk decision.</p>
      <a href="/services">Open AI Workforce</a>
    </article>
    <article class="card">
      <h3>AI Assistant</h3>
      <p>Ask a question while you work and get a grounded answer from the product help guide.</p>
      <a href="/how-it-works">See how it answers</a>
    </article>
    <article class="card">
      <h3>AI Conversations</h3>
      <p>Keep talking to the assistant in the floating chat window without losing your place.</p>
      <a href="/how-it-works">Open the guide</a>
    </article>
    <article class="card">
      <h3>Language Learning</h3>
      <p>Learn any supported language with a real learning path and authored content.</p>
      <a href="/services">Explore learning</a>
    </article>
    <article class="card">
      <h3>Translation</h3>
      <p>Translate both ways between any supported language pair with one click.</p>
      <a href="/services">Try translation</a>
    </article>
    <article class="card">
      <h3>Voice / Pronunciation</h3>
      <p>Listen to natural voice playback and replay the pronunciation while you learn.</p>
      <a href="/services">Hear the voices</a>
    </article>
    <article class="card">
      <h3>Speaking Practice</h3>
      <p>Practice speaking with real speech recognition and helpful, honest feedback.</p>
      <a href="/services">Start speaking</a>
    </article>
    <article class="card">
      <h3>Productivity</h3>
      <p>Keep dashboards, alerts, analytics and settings organised in one professional layout.</p>
      <a href="/services">See the workflow</a>
    </article>
  </div>
</section>

<section class="band" id="how-it-works">
  <div class="section-head">
    <p class="kicker">How it works</p>
    <h2>Four steps. Then the audit trail.</h2>
  </div>
  <ol class="steps">
    <li><span>01</span><div><h3>Create an account</h3><p>Register as a platform member. Public pages show Login, Register and Forgot password — never an admin login.</p></div></li>
    <li><span>02</span><div><h3>Open your workspace</h3><p>Members land on the dashboard. Administrators reach a private control centre. Role is decided by the server.</p></div></li>
    <li><span>03</span><div><h3>Use a real module</h3><p>Run analysis, paper-trade, study a language, review sports or search leads. The sidebar stays mounted.</p></div></li>
    <li><span>04</span><div><h3>Stay inside the rules</h3><p>Kill switch, RBAC, CSRF and labelled simulation stay on. Nothing is faked to look complete.</p></div></li>
  </ol>
  <p class="center" style="margin-top:24px"><a class="btn ghost" href="/how-it-works">See the full flow</a></p>
</section>

<section class="stats">
  <div><b><?= (int) ($languages ?? 20) ?></b><span>Languages in the authored registry</span></div>
  <div><b>15</b><span>Steps in the execution supervisor</span></div>
  <div><b>4</b><span>Built-in trading strategies</span></div>
  <div><b>0</b><span>Orders placed from the public website</span></div>
</section>

<section class="band alt" id="use-cases">
  <div class="section-head">
    <p class="kicker">Coverage</p>
    <h2>Software coverage, not invented depots</h2>
    <p>Use the real modules. The teacher registry, market watchlist and Places search are what exist in this codebase.</p>
  </div>
  <div class="pills">
    <span>Forex &amp; metals watchlist</span>
    <span>Crypto via Binance public REST</span>
    <span><?= (int) ($languages ?? 20) ?> languages in the learning registry</span>
    <span>EuroMillions research module</span>
    <span>Lead search wherever Places is configured</span>
  </div>
  <p class="center" style="margin-top:20px"><a class="btn ghost" href="/locations">View coverage</a></p>
</section>

<section class="cta" id="cta">
  <div>
    <h2>Ready to open a workspace?</h2>
    <p>Create a member account, or sign in if you already have one. Dashboards stay behind authentication.</p>
  </div>
  <div class="hero-cta">
    <a class="btn solid" href="/register">Create account</a>
    <a class="btn ghost" href="/login">Sign in</a>
  </div>
</section>

<section class="band" id="faq">
  <div class="section-head">
    <p class="kicker">FAQ</p>
    <h2>Short answers</h2>
  </div>
  <div class="faq">
    <details open><summary>Can I open the dashboard without an account?</summary><p>No. <span class="mono">/dashboard</span> and the module consoles redirect visitors to login.</p></details>
    <details><summary>What is WINDELS AI WORKFORCE?</summary><p>An AI-powered workforce platform for language learning, market analysis, sports and lottery research, and lead discovery. It never invents data to look complete.</p></details>
    <details><summary>Who can use the admin area?</summary><p>Only accounts with the super-administrator permission. Other users see Access denied.</p></details>
  </div>
  <p class="center" style="margin-top:20px"><a class="btn ghost" href="/faq">All questions</a></p>
</section>

<section class="band alt" id="contact">
  <div class="section-head">
    <p class="kicker">Contact</p>
    <h2>Talk to the operator</h2>
    <p>Messages are written to the audit trail. If SMTP is enabled on the server, a copy is emailed.</p>
  </div>
  <p class="center"><a class="btn solid" href="/contact">Open the contact form</a></p>
</section>
