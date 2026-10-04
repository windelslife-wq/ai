<?php
defined('BASEPATH') or exit('No direct script access allowed');

/**
 * Moving announcement bar — black text on white background, shown on every
 * page (public site, dashboard shell and standalone auth pages).
 *
 * Self-contained: ships its own scoped CSS so it renders identically
 * regardless of which stylesheet the host page loads. On the dashboard grid
 * (.app-shell) it spans both columns so it never collides with the sidebar.
 *
 * Content is operator-configurable via the VP_ANNOUNCEMENT environment
 * variable; multiple messages are separated by "|". Nothing sensitive lives
 * here.
 */
if (!function_exists('ann_escape')) {
    function ann_escape(?string $s): string { return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8'); }
}
$raw = (string) (getenv('VP_ANNOUNCEMENT') ?: getenv('ANNOUNCEMENT') ?: '');
if (trim($raw) === '') {
    $raw = 'Welcome to WINDELS AI WORKFORCE — your AI-powered workforce platform.'
        . '|NEW: Open the AI Language Teacher for instant translation, listening and speaking practice.'
        . '|Enterprise-grade analysis, language learning and lead discovery — evidence-first, audited, fail-closed.';
}
$messages = array_values(array_filter(array_map('trim', explode('|', $raw)), fn($m) => $m !== ''));
if (!$messages) $messages = ['WINDELS AI WORKFORCE'];
$joined = implode('    •    ', $messages); // separator between messages on the track
?>
<style>
.ann-bar{background:#ffffff;color:#000000;width:100%;overflow:hidden;border-bottom:1px solid #e2e2e2;font:600 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.01em;}
.ann-track{display:inline-flex;white-space:nowrap;will-change:transform;animation:annscroll 30s linear infinite;}
.ann-item{padding:9px 0;padding-right:72px;display:inline-block;}
.ann-bar:hover .ann-track{animation-play-state:paused;}
@keyframes annscroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@media (prefers-reduced-motion:reduce){.ann-track{animation:none}.ann-item.ann-dup{display:none}}
.app-shell > .ann-bar{grid-column:1 / -1}
</style>
<div class="ann-bar" role="region" aria-label="Platform announcement">
  <div class="ann-track">
    <span class="ann-item"><?= ann_escape($joined) ?></span><span class="ann-item ann-dup" aria-hidden="true"><?= ann_escape($joined) ?></span>
  </div>
</div>
