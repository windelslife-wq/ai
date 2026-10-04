<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head">
  <div>
    <p class="eyebrow">Restricted area</p>
    <h2>Administrator control center</h2>
    <p>Manage users and inspect platform readiness. Privileged actions require a super administrator and a CSRF token.</p>
  </div>
  <div class="admin-badge"><img src="/assets/images/ai-agent-avatar.png" alt="" width="28" height="28"><span>Admin mode</span></div>
</div>
<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>
<div class="grid stat-grid">
  <div class="stat"><div class="k">Users</div><div class="v"><?= (int) $counts['users'] ?></div><div class="dim">accounts in database</div></div>
  <div class="stat"><div class="k">Strategies</div><div class="v"><?= (int) $counts['strategies'] ?></div><div class="dim">versioned implementations</div></div>
  <div class="stat"><div class="k">Languages</div><div class="v"><?= (int) $counts['languages'] ?></div><div class="dim">registry entries</div></div>
  <div class="stat"><div class="k">Lottery draws</div><div class="v"><?= (int) $counts['lotteryDraws'] ?></div><div class="dim">verified or sandbox rows</div></div>
</div>
<div class="grid cols-main" style="margin-top:14px">
  <section class="panel"><h3>Create user account</h3><div class="body"><p class="dim">Create an account with a scoped role. Passwords are hashed and never displayed again.</p><form method="post" action="/admin/users/create" class="admin-form"><input type="hidden" name="csrf_token" value="<?= e($csrfToken) ?>"><label>Display name<input name="display_name" required maxlength="120" placeholder="Team member"></label><label>Email<input type="email" name="email" required maxlength="190" placeholder="person@example.com"></label><label>Temporary password<input type="password" name="password" required minlength="14" placeholder="At least 14 characters"></label><label>Role<select name="role"><option value="platform_member">Platform member</option><option value="trading_viewer">Trading viewer</option><option value="sports_viewer">Sports viewer</option><option value="lottery_viewer">Lottery viewer</option><option value="trading_operator">Trading operator</option><option value="sports_admin">Sports admin</option><option value="lottery_admin">Lottery admin</option><option value="super_admin">Super administrator</option></select></label><button class="btn primary" type="submit">Create account</button></form></div></section>
  <section class="panel"><h3>Access policy</h3><div class="body"><div class="policy-list"><div><b>Super administrator</b><span>All platform permissions</span></div><div><b>Trading operator</b><span>Trading view, control and execution</span></div><div><b>Sports administrator</b><span>Sports provider, approval and settlement controls</span></div><div><b>Lottery administrator</b><span>Lottery viewing, sync and management</span></div><div><b>Viewer roles</b><span>Read-only access to their module</span></div></div><p class="dim" style="margin-top:12px">A deactivated account cannot authenticate. Existing audit history is retained.</p></div></section>
</div>
<section class="panel" id="smtp" style="margin-top:14px"><h3>Email / SMTP</h3><div class="body">
  <p class="dim">Outbound mail uses the server environment only — credentials are never stored in source or shown here. Provider for this mailbox: <b>Namecheap Private Email</b> (mail.privateemail.com · 465 SSL / 587 TLS). From: <b>WINDELS AI WORKFORCE &lt;<?= e($smtp['fromEmail'] ?: 'not set') ?>&gt;</b>.</p>
  <div class="stat-grid" style="margin:10px 0">
    <div class="stat"><div class="k">Status</div><div class="v"><span class="badge <?= $smtp['enabled'] ? 'b-green' : 'b-gray' ?>"><?= $smtp['enabled'] ? 'ENABLED' : 'DISABLED' ?></span></div></div>
    <div class="stat"><div class="k">Host</div><div class="v" style="font-size:13px"><?= e($smtp['host'] ?: '—') ?></div></div>
    <div class="stat"><div class="k">Port / TLS</div><div class="v" style="font-size:13px"><?= e((string)($smtp['port'] ?: '—')) ?> · <?= e(strtoupper($smtp['crypto']) ?: '—') ?></div></div>
    <div class="stat"><div class="k">Auth</div><div class="v"><span class="badge <?= $smtp['usernameConfigured'] && $smtp['passwordConfigured'] ? 'b-green' : 'b-gray' ?>"><?= ($smtp['usernameConfigured'] && $smtp['passwordConfigured']) ? 'READY' : 'MISSING' ?></span></div></div>
  </div>
  <?php if (!empty($smtpOk)): ?><div class="notice ok"><?= e($smtpOk) ?></div><?php endif; ?>
  <?php if (!empty($smtpError)): ?><div class="notice err"><?= e($smtpError) ?></div><?php endif; ?>
  <form method="post" action="/admin/test-email" class="admin-form" style="margin-top:10px">
    <input type="hidden" name="csrf_token" value="<?= e($csrfToken) ?>">
    <label>Send a real test email to<input type="email" name="to" required placeholder="you@example.com"></label>
    <label>Format<select name="variant"><option value="html">HTML (with plain-text fallback)</option><option value="plain">Plain text only</option></select></label>
    <button class="btn primary" type="submit">Send test email</button>
  </form>
  <p class="dim" style="font-size:11px;margin-top:8px">This performs a live SMTP send and reports whether the server accepted the message. The full transcript is written to the server error log with credentials redacted.</p>
</div></section>
<section class="panel" style="margin-top:14px"><h3>Platform feature readiness</h3><div class="body table-scroll"><table class="tbl"><thead><tr><th>Feature</th><th>Category</th><th>Status</th><th>Detail</th></tr></thead><tbody><?php foreach ($features as $feature): ?><tr><td><?= e($feature['name']) ?></td><td class="dim"><?= e($feature['category']) ?></td><td><span class="badge <?= $feature['status'] === 'TESTED' ? 'b-green' : ($feature['status'] === 'PLANNED' ? 'b-gray' : 'b-violet') ?>"><?= e($feature['status']) ?></span></td><td class="dim"><?= e($feature['detail']) ?></td></tr><?php endforeach; ?></tbody></table></div></section>
<section class="panel" style="margin-top:14px"><h3>User accounts</h3><div class="body table-scroll"><table class="tbl"><thead><tr><th>User</th><th>Role permissions</th><th>Status</th><th>Action</th></tr></thead><tbody><?php foreach ($users as $member): ?><tr><td><b><?= e($member['display_name']) ?></b><div class="dim"><?= e($member['email']) ?></div></td><td><div class="permission-list"><?php foreach ($member['permissions'] as $permission): ?><span class="badge b-violet"><?= e($permission) ?></span><?php endforeach; ?></div></td><td><span class="badge <?= !empty($member['active']) ? 'b-green' : 'b-gray' ?>"><?= !empty($member['active']) ? 'ACTIVE' : 'DISABLED' ?></span></td><td><?php if ((int) $member['id'] !== (int) $this->session->userdata('identity')['id']): ?><form method="post" action="/admin/users/<?= (int) $member['id'] ?>/toggle"><input type="hidden" name="csrf_token" value="<?= e($csrfToken) ?>"><button class="btn small <?= !empty($member['active']) ? 'danger' : '' ?>" type="submit"><?= !empty($member['active']) ? 'Deactivate' : 'Activate' ?></button></form><?php else: ?><span class="dim">Current account</span><?php endif; ?></td></tr><?php endforeach; ?></tbody></table></div></section>
