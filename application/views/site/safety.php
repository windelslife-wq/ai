<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<section class="page-hero">
  <p class="kicker">Safety &amp; trust</p>
  <h1>Controls that stay on when nobody is watching</h1>
</section>
<section class="band">
  <div class="cards two">
    <article class="card"><h3>Authentication</h3><p>Sessions live server-side. Passwords are hashed. Login is rate-limited. Logout requires the CSRF token issued at sign-in.</p></article>
    <article class="card"><h3>Authorization</h3><p>Hiding a menu is not enough. Pages call requireLogin / requireAdminPage. APIs return 401 or 403. Writes re-check RBAC and CSRF.</p></article>
    <article class="card"><h3>Kill switch</h3><p>The platform boots with the kill switch active. Paper and broker orders are blocked until an authorized operator releases it.</p></article>
    <article class="card"><h3>Honest data</h3><p>Synthetic candles, sandbox sports and missing providers are labelled. Missing values stay null. CSV export is formula-safe.</p></article>
    <article class="card"><h3>Audit</h3><p>Logins, contact inquiries, user creation and trading events are written to audit_logs with an actor.</p></article>
    <article class="card"><h3>Broker writes</h3><p>Order submission needs an authenticated bridge, TRADING_ENABLED, and a demo account unless live is explicitly allowed.</p></article>
  </div>
</section>
