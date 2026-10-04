<?php defined('BASEPATH') or exit('No direct script access allowed');
$csrf = (string) $this->session->userdata('csrf_token');
$u = $user ?? [];
$uid = (string) ($u['user_uid'] ?? '');
$username = (string) ($u['username'] ?? '');
$email = (string) ($u['email'] ?? '');
$avatar = (string) ($u['profile_image'] ?? '');
$displayName = (string) ($u['display_name'] ?? $username ?: 'Platform user');
$initials = strtoupper(mb_substr(preg_replace('/[^A-Za-z0-9 ]/', '', $displayName), 0, 1) ?: 'W');
?>
<div class="page-head">
  <div>
    <p class="eyebrow">Account</p>
    <h2>My Account</h2>
    <p>Manage your profile image, username, email, password and account details.</p>
  </div>
  <div class="page-actions">
    <form method="post" action="/logout">
      <input type="hidden" name="csrf_token" value="<?= e($csrf) ?>">
      <button class="btn danger" type="submit">Sign out</button>
    </form>
  </div>
</div>
<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>

<!-- ============ PROFILE ============ -->
<section class="panel" id="profile">
  <h3>Profile</h3>
  <div class="body">
    <div class="account-hero">
      <div class="avatar-lg-wrap">
        <?php if ($avatar !== ''): ?>
          <img src="<?= e($avatar) ?>" alt="Profile image" class="avatar-lg">
        <?php else: ?>
          <div class="avatar-lg avatar-lg--initial" aria-hidden="true"><?= e($initials) ?></div>
        <?php endif; ?>
      </div>
      <div>
        <h3 style="margin:0"><?= e($displayName) ?></h3>
        <p class="dim">@<?= e($username) ?> · <?= e($email) ?></p>
      </div>
    </div>

    <div class="avatar-actions">
      <form method="post" action="/account/avatar" enctype="multipart/form-data" class="inline">
        <input type="hidden" name="csrf_token" value="<?= e($csrf) ?>">
        <label class="btn small">Upload image
          <input type="file" name="avatar" accept="image/png,image/jpeg,image/gif,image/webp" class="avatar-file" required>
        </label>
        <button class="btn small primary" type="submit">Save image</button>
      </form>
      <?php if ($avatar !== ''): ?>
        <form method="post" action="/account/avatar/remove" class="inline">
          <input type="hidden" name="csrf_token" value="<?= e($csrf) ?>">
          <button class="btn small ghost" type="submit">Remove image</button>
        </form>
      <?php endif; ?>
      <span class="dim" style="font-size:11px">PNG, JPEG, GIF or WebP · up to 2 MB. Circular preview shown throughout the dashboard.</span>
    </div>

    <table class="tbl" style="margin-top:18px">
      <tr>
        <td class="dim">Username</td>
        <td><b>@<?= e($username) ?></b></td>
        <td class="num">
          <button class="btn small" type="button" data-toggle-panel="edit-username" aria-expanded="false">Edit</button>
        </td>
      </tr>
      <tr>
        <td class="dim">Email</td>
        <td><?= e($email) ?></td>
        <td class="num">
          <button class="btn small" type="button" data-toggle-panel="edit-email" aria-expanded="false">Edit</button>
        </td>
      </tr>
      <tr>
        <td class="dim">User ID</td>
        <td><span class="mono badge b-sky"><?= e($uid) ?></span> <span class="dim" style="font-size:11px">permanent — cannot be changed</span></td>
        <td class="num"></td>
      </tr>
    </table>

    <div id="edit-username" class="account-edit" hidden>
      <h4>Change username</h4>
      <form method="post" action="/account/username" class="auth-form" style="margin-top:12px">
        <input type="hidden" name="csrf_token" value="<?= e($csrf) ?>">
        <label class="auth-field">
          <span>New username</span>
          <span class="auth-control"><input name="username" id="new-username" required maxlength="20" value="<?= e($username) ?>" placeholder="carlosjohn"></span>
          <span class="auth-hint">3–20 characters, letters, numbers or underscores, starting with a letter. Must be unique.</span>
        </label>
        <div><button class="btn primary" type="submit">Save username</button></div>
      </form>
    </div>

    <div id="edit-email" class="account-edit" hidden>
      <h4>Change email</h4>
      <form method="post" action="/account/email" class="auth-form" style="margin-top:12px">
        <input type="hidden" name="csrf_token" value="<?= e($csrf) ?>">
        <label class="auth-field">
          <span>Current email</span>
          <span class="auth-control"><input type="email" value="<?= e($email) ?>" disabled></span>
        </label>
        <label class="auth-field">
          <span>New email</span>
          <span class="auth-control"><input type="email" name="email" id="new-email" required maxlength="190" placeholder="new@example.com" inputmode="email"></span>
          <span class="auth-hint">Must not already be attached to another account.</span>
        </label>
        <div><button class="btn primary" type="submit">Change email</button></div>
      </form>
    </div>
  </div>
</section>

<div class="grid cols-main" style="margin-top:16px">
  <!-- ============ SECURITY ============ -->
  <section class="panel" id="security">
    <h3>Security</h3>
    <div class="body">
      <h4 style="margin:0 0 6px">Change password</h4>
      <p class="dim" style="font-size:12px;margin:0 0 10px">Verify your current password, then set a new one (at least 12 characters).</p>
      <form method="post" action="/account/password" class="auth-form" id="change-password-form">
        <input type="hidden" name="csrf_token" value="<?= e($csrf) ?>">
        <label class="auth-field">
          <span>Current password</span>
          <span class="auth-control has-toggle">
            <input type="password" name="current_password" id="pw-current" required autocomplete="current-password" placeholder="********">
            <button type="button" class="pw-toggle" data-toggle="pw-current" aria-label="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg></button>
          </span>
        </label>
        <label class="auth-field">
          <span>New password</span>
          <span class="auth-control has-toggle">
            <input type="password" name="new_password" id="pw-new" required minlength="12" autocomplete="new-password" placeholder="At least 12 characters">
            <button type="button" class="pw-toggle" data-toggle="pw-new" aria-label="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg></button>
          </span>
        </label>
        <label class="auth-field">
          <span>Confirm new password</span>
          <span class="auth-control has-toggle">
            <input type="password" name="new_password_confirm" id="pw-confirm" required minlength="12" autocomplete="new-password" placeholder="Repeat new password">
            <button type="button" class="pw-toggle" data-toggle="pw-confirm" aria-label="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg></button>
          </span>
        </label>
        <div id="password-inline-error" class="notice err" role="alert" hidden></div>
        <div><button class="btn primary" type="submit">Change password</button></div>
      </form>
    </div>
  </section>

  <!-- ============ ACCOUNT INFORMATION ============ -->
  <section class="panel">
    <h3>Account information</h3>
    <div class="body">
      <table class="tbl">
        <tr><td class="dim">User ID</td><td><span class="mono badge b-sky"><?= e($uid) ?></span></td></tr>
        <tr><td class="dim">Username</td><td>@<?= e($username) ?></td></tr>
        <tr><td class="dim">Email</td><td><?= e($email) ?></td></tr>
        <tr><td class="dim">Account created</td><td><?= e(substr((string) ($u['created_at'] ?? ''), 0, 16)) ?></td></tr>
        <tr><td class="dim">Last login</td><td><?= e(substr((string) ($u['last_login_at'] ?? 'Not recorded'), 0, 16)) ?></td></tr>
        <tr><td class="dim">Account status</td><td><span class="badge <?= empty($u['active']) ? 'b-red' : 'b-green' ?>"><?= empty($u['active']) ? 'INACTIVE' : 'ACTIVE' ?></span></td></tr>
      </table>
    </div>
  </section>
</div>

<section class="panel" style="margin-top:16px">
  <h3>Access &amp; permissions</h3>
  <div class="body">
    <p class="dim">Your access is determined by assigned RBAC roles. Sensitive actions still require CSRF and the relevant permission.</p>
    <div class="permission-list">
      <?php foreach (($u['permissions'] ?? []) as $permission): ?>
        <span class="badge b-violet"><?= e((string) $permission) ?></span>
      <?php endforeach; ?>
    </div>
    <?php if ($this->platform->identity->can($u, 'system.super_admin')): ?>
      <div class="page-actions" style="margin-top:14px"><a class="btn" href="/admin">Open administrator controls</a></div>
    <?php endif; ?>
  </div>
</section>

<script>
(function () {
  'use strict';
  // Inline edit toggles
  document.querySelectorAll('[data-toggle-panel]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var panel = document.getElementById(btn.getAttribute('data-toggle-panel'));
      if (!panel) return;
      var open = panel.hidden;
      panel.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { var f = panel.querySelector('input'); if (f) f.focus(); }
    });
  });
  // Avatar file name preview
  var fileInputs = document.querySelectorAll('.avatar-file');
  fileInputs.forEach(function (input) {
    input.addEventListener('change', function () {
      if (input.files && input.files.length) input.value; // browser shows selection
    });
  });
  // Password toggles
  document.querySelectorAll('.pw-toggle').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var input = document.getElementById(btn.getAttribute('data-toggle'));
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });
  // Change password client validation
  var form = document.getElementById('change-password-form');
  if (form) {
    var errEl = document.getElementById('password-inline-error');
    form.addEventListener('submit', function (e) {
      var cur = document.getElementById('pw-current');
      var neu = document.getElementById('pw-new');
      var conf = document.getElementById('pw-confirm');
      var ok = true, msg = '';
      if (!cur.value) { msg = 'Enter your current password.'; ok = false; }
      else if (neu.value.length < 12) { msg = 'New password must be at least 12 characters.'; ok = false; }
      else if (neu.value !== conf.value) { msg = 'The new passwords do not match.'; ok = false; }
      if (!ok) { e.preventDefault(); errEl.hidden = false; errEl.textContent = msg; return; }
      errEl.hidden = true;
    });
  }
})();
</script>
