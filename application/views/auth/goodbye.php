<?php defined('BASEPATH') or exit('No direct script access allowed'); if (!function_exists('e')) { function e($value): string { return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8'); } } ?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title><?= e(($title ?? 'Signed out') . ' · WINDELS AI WORKFORCE') ?></title>
  <meta name="robots" content="noindex,nofollow">
  <link rel="icon" href="/assets/images/windels-mark.png">
  <link rel="stylesheet" href="/assets/css/aegis.css">
</head>
<body class="auth-page">
  <main class="auth-shell auth-shell--goodbye">
    <section class="auth-card auth-card--goodbye">
      <div class="auth-brand">
        <img src="/assets/images/windels-mark.png" alt="" class="auth-brand-mark" onerror="this.onerror=null;this.src='/assets/images/aegis-mark.png'">
        <span class="auth-brand-text">WINDELS AI Workforce</span>
      </div>
      <div class="goodbye-visual">
        <img src="/assets/images/about-workspace.jpg" alt="WINDELS AI WORKFORCE workspace" class="goodbye-img" loading="lazy"
             onerror="this.style.display='none';this.nextElementSibling.style.display='grid';">
        <div class="goodbye-fallback" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h13a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H3z"/><path d="m3 4 1 7 1-7M19 5l3 2-3 2"/></svg></div>
      </div>
      <h1>You've been signed out</h1>
      <p class="auth-sub">Your account has been safely logged out. Your session and remember-me cookie were cleared.</p>
      <form method="get" action="/login" class="auth-form" style="margin-top:26px">
        <input type="hidden" name="csrf_token" value="<?= e((string) ($csrfToken ?? '')) ?>">
        <button class="btn primary auth-submit" type="submit">Sign In Again</button>
      </form>
      <div class="auth-foot" style="margin-top:20px">
        Want to explore first? <a href="/"><b>Back to website</b></a>
      </div>
    </section>
  </main>
</body>
</html>
