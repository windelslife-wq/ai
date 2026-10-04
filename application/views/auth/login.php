<?php defined('BASEPATH') or exit('No direct script access allowed'); if (!function_exists('e')) { function e($value): string { return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8'); } } ?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title><?= e($title . ' · WINDELS AI WORKFORCE') ?></title>
  <meta name="robots" content="noindex,nofollow">
  <link rel="icon" href="/assets/images/windels-mark.png">
  <link rel="stylesheet" href="/assets/css/aegis.css">
</head>
<body class="auth-page">
  <main class="auth-shell auth-split">
    <!-- LEFT — WINDELS AI WORKFORCE visual -->
    <section class="auth-visual" aria-hidden="true">
      <div class="auth-visual-frame">
        <img src="/assets/images/hero-windels.jpg" alt="WINDELS AI WORKFORCE — AI language teacher, market analysis and lead discovery" class="auth-visual-img" loading="lazy"
             onerror="this.style.display='none';this.nextElementSibling.style.display='grid';">
        <div class="auth-visual-fallback"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="16" height="13" rx="2"/><path d="M12 2v4M8.5 12h.01M15.5 12h.01M9 16h6"/></svg></div>
      </div>
      <div class="auth-visual-copy">
        <p class="eyebrow">WINDELS AI WORKFORCE</p>
        <h2>Your AI-powered workspace</h2>
        <p>Market analysis, language learning, sports &amp; lottery intelligence and lead discovery — evidence-first, audited, fail-closed.</p>
      </div>
    </section>

    <!-- RIGHT — Login form -->
    <section class="auth-card">
      <div class="auth-brand">
        <img src="/assets/images/windels-mark.png" alt="" class="auth-brand-mark" onerror="this.onerror=null;this.src='/assets/images/aegis-mark.png'">
        <span class="auth-brand-text">WINDELS AI Workforce</span>
      </div>
      <h1><?= $admin ? 'Administrator access' : 'Welcome back' ?></h1>
      <p class="auth-sub"><?= $admin ? 'Restricted access for platform administrators.' : 'Sign in with your username, email or User ID.' ?></p>

      <?php if (!empty($error)): ?><div class="notice err auth-notice" role="alert"><?= e($error) ?></div><?php endif; ?>
      <?php if (!empty($notice)): ?><div class="notice ok auth-notice" role="status"><?= e($notice) ?></div><?php endif; ?>

      <form method="post" action="/login/submit" class="auth-form" id="login-form" autocomplete="on" novalidate>
        <input type="hidden" name="admin" value="<?= $admin ? '1' : '0' ?>">
        <input type="hidden" name="csrf_token" value="<?= e((string) ($csrfToken ?? '')) ?>">

        <label class="auth-field">
          <span>Username, Email or User ID</span>
          <span class="auth-control">
            <input type="text" name="identifier" id="login-identifier" required autocomplete="username" placeholder="carlosjohn / user@example.com / 482731" autofocus>
          </span>
        </label>

        <label class="auth-field">
          <span>Password</span>
          <span class="auth-control has-toggle">
            <input type="password" name="password" id="login-password" required autocomplete="current-password" placeholder="Your password">
            <button type="button" class="pw-toggle" data-toggle="login-password" aria-label="Show password" title="Show password">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>
            </button>
          </span>
        </label>

        <div class="auth-row">
          <label class="auth-check"><input type="checkbox" name="remember" value="1"> Remember me</label>
          <a href="/forgot-password">Forgot password?</a>
        </div>

        <div id="login-inline-error" class="notice err" role="alert" hidden></div>

        <button class="btn primary auth-submit" type="submit" id="login-submit"><?= $admin ? 'Enter' : 'Sign In' ?></button>
      </form>

      <div class="auth-foot">
        Don't have an account? <a href="/register"><b>Create an account</b></a>
      </div>
      <a class="auth-back" href="/">← Back to website</a>
    </section>
  </main>
  <script>
  (function () {
    'use strict';
    var form = document.getElementById('login-form');
    var submit = document.getElementById('login-submit');
    var inlineError = document.getElementById('login-inline-error');

    document.querySelectorAll('.pw-toggle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = document.getElementById(btn.getAttribute('data-toggle'));
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        btn.title = show ? 'Hide password' : 'Show password';
      });
    });

    form.addEventListener('submit', function (event) {
      var identifier = document.getElementById('login-identifier');
      var password = document.getElementById('login-password');
      if (!identifier.value.trim() || !password.value) {
        event.preventDefault();
        inlineError.hidden = false;
        inlineError.textContent = !identifier.value.trim() ? 'Enter your username, email or User ID.' : 'Enter your password.';
        (!identifier.value.trim() ? identifier : password).focus();
        return;
      }
      inlineError.hidden = true;
      submit.disabled = true;
      submit.classList.add('is-loading');
      submit.innerHTML = '<span class="auth-spinner"></span> Signing in…';
    });
  })();
  </script>
</body>
</html>
