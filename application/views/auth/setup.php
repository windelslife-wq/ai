<?php defined('BASEPATH') or exit('no direct script access allowed'); if (!function_exists('e')) { function e($value): string { return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8'); } } ?><!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title><?= e(($title ?? 'Create the super-administrator account') . ' · WINDELS AI WORKFORCE') ?></title>
  <meta name="robots" content="noindex,nofollow">
  <link rel="icon" href="/assets/images/windels-mark.png">
  <link rel="stylesheet" href="/assets/css/aegis.css">
</head>
<body class="auth-page">
  <main class="auth-shell auth-split">
    <!-- LEFT — bootstrap callout -->
    <section class="auth-visual" aria-hidden="true">
      <div class="auth-visual-frame">
        <img src="/assets/images/hero-africa-mobility.jpg" alt="WINDELS AI WORKFORCE — set up your platform" class="auth-visual-img" loading="lazy"
             onerror="this.style.display='none';this.nextElementSibling.style.display='grid';">
        <div class="auth-visual-fallback"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg></div>
      </div>
      <div class="auth-visual-copy">
        <p class="eyebrow">PLATFORM SETUP</p>
        <h2>Claim your WINDELS AI Workforce</h2>
        <p>This is the first-run screen. The account you create here becomes the <b>super-administrator</b> — full control over users, trading controls, sports intelligence, lottery and all platform settings. Choose a strong password and keep it safe.</p>
        <ul class="auth-bullets">
          <li>Full system administration access</li>
          <li>Sign in any time with your username, email or six-digit User ID</li>
          <li>Invite additional admins and members after sign-in</li>
        </ul>
      </div>
    </section>

    <!-- RIGHT — Super admin bootstrap form -->
    <section class="auth-card">
      <div class="auth-brand">
        <img src="/assets/images/windels-mark.png" alt="" class="auth-brand-mark" onerror="this.onerror=null;this.src='/assets/images/aegis-mark.png'">
        <span class="auth-brand-text">WINDELS AI Workforce</span>
      </div>
      <span class="auth-badge">First-run setup</span>
      <h1>Create the super‑administrator</h1>
      <p class="auth-sub">This account owns the platform. It can only be created once.</p>

      <?php if (!empty($error)): ?><div class="notice err auth-notice" role="alert"><?= e($error) ?></div><?php endif; ?>
      <?php if (!empty($notice)): ?><div class="notice ok auth-notice" role="status"><?= e($notice) ?></div><?php endif; ?>

      <form method="post" action="/setup/submit" class="auth-form" id="setup-form" autocomplete="on" novalidate>
        <input type="hidden" name="csrf_token" value="<?= e((string) ($csrfToken ?? '')) ?>">

        <label class="auth-field">
          <span>Display name</span>
          <span class="auth-control">
            <input name="display_name" id="setup-name" maxlength="80" autocomplete="name" placeholder="e.g. Platform Owner">
          </span>
          <span class="auth-hint">Optional — shown in the admin console.</span>
        </label>

        <label class="auth-field">
          <span>Username</span>
          <span class="auth-control">
            <input name="username" id="setup-username" required maxlength="20" autocomplete="username" placeholder="admin">
          </span>
          <span class="auth-hint">3–20 characters, letters, numbers or underscores, starting with a letter.</span>
        </label>

        <label class="auth-field">
          <span>Email address</span>
          <span class="auth-control">
            <input type="email" name="email" id="setup-email" required maxlength="190" autocomplete="email" placeholder="you@example.com" inputmode="email">
          </span>
        </label>

        <label class="auth-field">
          <span>Password</span>
          <span class="auth-control has-toggle">
            <input type="password" name="password" id="setup-password" required minlength="14" autocomplete="new-password" placeholder="At least 14 characters">
            <button type="button" class="pw-toggle" data-toggle="setup-password" aria-label="Show password" title="Show password">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>
            </button>
          </span>
          <span class="auth-hint">Minimum 14 characters. Use a passphrase you won't forget.</span>
        </label>

        <label class="auth-field">
          <span>Confirm password</span>
          <span class="auth-control has-toggle">
            <input type="password" name="password_confirm" id="setup-confirm" required minlength="14" autocomplete="new-password" placeholder="Repeat your password">
            <button type="button" class="pw-toggle" data-toggle="setup-confirm" aria-label="Show password" title="Show password">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>
            </button>
          </span>
        </label>

        <label class="auth-check">
          <input type="checkbox" name="terms" id="setup-terms" value="1" required>
          <span>I accept the Terms and Privacy Policy</span>
        </label>

        <div id="setup-inline-error" class="notice err" role="alert" hidden></div>

        <button class="btn primary auth-submit" type="submit" id="setup-submit">Create super‑administrator</button>
      </form>

      <p class="auth-foot">
        Already completed setup? <a href="/admin/login"><b>Sign in to the admin console</b></a>
      </p>
    </section>
  </main>
  <script>
  (function () {
    'use strict';
    var form = document.getElementById('setup-form');
    var submit = document.getElementById('setup-submit');
    var inlineError = document.getElementById('setup-inline-error');

    document.querySelectorAll('.pw-toggle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = document.getElementById(btn.getAttribute('data-toggle'));
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        btn.title = show ? 'Hide password' : 'Show password';
      });
    });

    function fail(message, focusEl) {
      inlineError.hidden = false;
      inlineError.textContent = message;
      if (focusEl) focusEl.focus();
      return false;
    }

    form.addEventListener('submit', function (event) {
      var username = document.getElementById('setup-username');
      var email = document.getElementById('setup-email');
      var password = document.getElementById('setup-password');
      var confirm = document.getElementById('setup-confirm');
      var terms = document.getElementById('setup-terms');
      inlineError.hidden = true;
      var ok = true;
      if (!/^[a-z][a-z0-9_]{2,19}$/i.test(username.value.trim())) ok = fail('Username must be 3–20 characters, start with a letter, and use only letters, numbers or underscores.', username);
      else if (!email.value.trim()) ok = fail('Enter your email address.', email);
      else if (password.value.length < 14) ok = fail('The super-administrator password must be at least 14 characters.', password);
      else if (password.value !== confirm.value) ok = fail('The two passwords do not match.', confirm);
      else if (!terms.checked) ok = fail('Please accept the Terms and Privacy Policy.', terms);
      if (!ok) { event.preventDefault(); return; }
      submit.disabled = true;
      submit.classList.add('is-loading');
      submit.innerHTML = '<span class="auth-spinner"></span> Creating account…';
    });
  })();
  </script>
</body>
</html>
