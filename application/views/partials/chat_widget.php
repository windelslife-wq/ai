<?php defined('BASEPATH') or exit('No direct script access allowed');
/**
 * WINDELS Assistant — floating AI chat widget.
 * Ships its own stylesheet (fixed positioning, z-index, responsive sizing)
 * so it floats independently of whatever page shell, layout, overflow or
 * footer it is embedded in. Deliberately NOT loaded on auth pages.
 */ ?>
<link rel="stylesheet" href="/assets/css/chat-widget.css">
<div id="aegis-chat" class="aegis-chat" data-endpoint="/api/chat/respond">
  <section id="aegis-chat-panel" class="aegis-chat-panel" hidden role="dialog" aria-label="WINDELS Assistant">
    <header>
      <span class="aegis-chat-avatar">
        <img src="/assets/images/ai-agent-avatar.png" alt="" width="34" height="34" loading="lazy"
             onerror="this.style.display='none';this.parentElement.classList.add('is-fallback');">
        <span class="aegis-chat-fallback" aria-hidden="true">W</span>
      </span>
      <span class="aegis-chat-id">
        <strong>WINDELS Assistant</strong>
        <small>Product help · grounded responses</small>
      </span>
      <button type="button" class="aegis-chat-close" aria-label="Close assistant" title="Close">×</button>
    </header>
    <div class="aegis-chat-messages" aria-live="polite"><div class="aegis-chat-message agent">Hi, I'm the WINDELS Assistant. Ask me how to use the platform.</div></div>
    <form class="aegis-chat-form">
      <input name="message" maxlength="1000" required placeholder="Ask about a page or feature…" autocomplete="off" aria-label="Message">
      <button type="submit" aria-label="Send message">Send</button>
    </form>
    <p class="aegis-chat-note">Guidance only. No private account, market, sports, lottery or lead records are exposed to this assistant.</p>
  </section>
  <button class="aegis-chat-launch" type="button" aria-expanded="false" aria-controls="aegis-chat-panel" aria-label="Open WINDELS Assistant" title="Ask WINDELS Assistant">
    <span class="aegis-chat-avatar">
      <img src="/assets/images/ai-agent-avatar.png" alt="" width="40" height="40" loading="lazy"
           onerror="this.style.display='none';this.parentElement.classList.add('is-fallback');">
      <span class="aegis-chat-fallback" aria-hidden="true">W</span>
    </span>
    <span class="aegis-chat-launch-label" aria-hidden="true">Ask WINDELS</span>
  </button>
</div>
<script src="/assets/js/aegis-chat.js" defer></script>
