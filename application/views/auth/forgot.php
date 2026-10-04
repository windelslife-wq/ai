<?php defined('BASEPATH') or exit('No direct script access allowed'); if (!function_exists('e')) { function e($value): string { return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8'); } } ?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reset password · WINDELS AI WORKFORCE</title>
  <meta name="robots" content="noindex,nofollow">
  <link rel="icon" href="/assets/images/windels-mark.png">
  <link rel="stylesheet" href="/assets/css/aegis.css">
</head>
<body class="auth-page">
  <main class="auth-shell">
    <section class="auth-card">
      <div class="auth-brand">
        <img src="/assets/images/windels-mark.png" alt="" class="auth-brand-mark" onerror="this.onerror=null;this.src='/assets/images/aegis-mark.png'">
        <span class="auth-brand-text">WINDELS AI Workforce</span>
      </div>
      <h1>Password reset</h1>
      <p class="auth-sub">This installation does not invent email reset tokens. Ask an administrator to issue a new password or create a replacement account.</p>

      <?php if (!empty($notice)): ?><div class="notice ok auth-notice" role="status"><?= e($notice) ?></div><?php endif; ?>

      <form method="post" action="/forgot-password/submit" class="auth-form">
        <input type="hidden" name="csrf_token" value="<?= e((string) ($csrfToken ?? '')) ?>">
        <label class="auth-field">
          <span>Email address</span>
          <span class="auth-control">
            <input type="email" name="email" required autocomplete="username" placeholder="you@example.com" inputmode="email">
          </span>
        </label>
        <button class="btn primary auth-submit" type="submit">Send request</button>
      </form>

      <div class="auth-foot"><a href="/login"><b>Back to sign in</b></a> · <a href="/contact">Contact support</a></div>
    </section>
  </main>
</body>
</html>
