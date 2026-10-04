<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<section class="page-hero">
  <p class="kicker">How it works</p>
  <h1>From visitor to a role-checked workspace</h1>
  <p class="lede">Create an account, sign in, and the server decides which dashboard you can open.</p>
</section>
<section class="band">
  <ol class="steps">
    <li><span>01</span><div><h3>Create an account</h3><p>Register with name, email and a 12+ character password. New accounts receive the <span class="mono">platform_member</span> role (trading.view, sports.view, lottery.view).</p></div></li>
    <li><span>02</span><div><h3>Authenticate</h3><p>Login checks the password hash, regenerates the session and issues a CSRF token. Five failures lock the session for 15 minutes.</p></div></li>
    <li><span>03</span><div><h3>Role check</h3><p>Members go to <span class="mono">/dashboard</span>. Administrators reach their private control centre separately — never via a public link — and a member who opens an admin URL sees Access denied.</p></div></li>
    <li><span>04</span><div><h3>Use a module</h3><p>Each console still enforces its own permission for writes — kill switch, sports approve/settle, lottery manage, and trading execute are never implied by a URL.</p></div></li>
  </ol>
</section>
<section class="band alt">
  <h2>What a visitor cannot do</h2>
  <ul class="checklist">
    <li>Open /dashboard, /analysis or any module console without signing in</li>
    <li>Call protected /api/* routes (401 unauthenticated)</li>
    <li>See the workspace sidebar on public pages</li>
  </ul>
</section>
