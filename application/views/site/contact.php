<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<section class="page-hero">
  <p class="kicker">Contact</p>
  <h1>Send a message to the operator</h1>
  <p class="lede">We store the inquiry on the audit trail. If SMTP is enabled in .env, a copy is emailed to the configured from-address.</p>
</section>
<section class="band">
  <?php if (!empty($notice)): ?><div class="flash ok"><?= e($notice) ?></div><?php endif; ?>
  <?php if (!empty($error)): ?><div class="flash err"><?= e($error) ?></div><?php endif; ?>
  <form class="contact-form" method="post" action="/contact/submit">
    <label>Name<input name="name" required maxlength="120"></label>
    <label>Email<input type="email" name="email" required maxlength="190"></label>
    <label>Message<textarea name="message" required minlength="10" rows="6" maxlength="2000"></textarea></label>
    <button class="btn solid" type="submit">Send message</button>
  </form>
</section>
