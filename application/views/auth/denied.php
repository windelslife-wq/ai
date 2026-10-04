<?php defined('BASEPATH') or exit('No direct script access allowed'); if (!function_exists('e')) { function e($value): string { return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8'); } } ?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Access denied · WINDELS AI WORKFORCE</title>
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
      <h1>Access denied</h1>
      <p class="auth-sub">Your signed-in account does not have administrator permission. The admin dashboard stays closed.</p>
      <div class="auth-foot"><a href="/dashboard"><b>Go to your dashboard</b></a> · <a href="/">Public site</a></div>
    </section>
  </main>
</body>
</html>
