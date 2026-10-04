<?php
/**
 * Integration plan step 6 — production review (code-level posture).
 *
 * Pins the security requirements the review imposes on the sports mutation
 * surface:
 *  - console form POSTs self-guard with the session CSRF token (platform
 *    csrf_protection is off; privileged endpoints guard themselves — the
 *    same token the JSON API verifies as X-CSRF-Token)
 *  - approval (new exposure) fails closed under an ACTIVE kill switch —
 *    like paper order placement
 *  - settlement (unwind/finalize) stays available under the kill switch —
 *    like position close
 *  - the gate reads LIVE platform state (round trip verified) and fresh
 *    installs boot fail-closed
 */

/** Method body between two markers in a source file (to assert on one method precisely). */
function fx_prod_body(string $src, string $from, string $to): string
{
    $a = strpos($src, $from);
    if ($a === false) return '';
    if ($to === '') return substr($src, $a);
    $b = strpos($src, $to, $a + strlen($from));
    return $b === false ? substr($src, $a) : substr($src, $a, $b - $a);
}

test('sports prod review: console mutation forms carry the session CSRF token', function () {
    $c = file_get_contents(FCPATH . 'application/controllers/Sports.php');
    assert_contains("input->post('csrf_token')", $c);
    assert_contains('hash_equals', $c);
    assert_contains("'csrfToken' => (string) \$this->session->userdata('csrf_token')", $c);
    foreach (['index', 'tickets'] as $page) {
        $v = file_get_contents(FCPATH . 'application/views/sports/' . $page . '.php');
        $forms = substr_count($v, 'method="post"');
        $tokens = substr_count($v, 'name="csrf_token"');
        assert_true($forms > 0, $page . ' view has mutation forms');
        assert_equals($forms, $tokens, 'every ' . $page . ' form carries a csrf_token field');
    }
});

test('sports prod review: approval fails closed under the kill switch; settlement stays open', function () {
    $c = file_get_contents(FCPATH . 'application/controllers/Sports.php');
    assert_contains('killSwitchActive()', fx_prod_body($c, 'public function decide(', 'public function settle('), 'console approval is gated on the kill switch');
    assert_true(!str_contains(fx_prod_body($c, 'public function settle(', 'private function requireSportsPermission('), 'killSwitch'), 'console settlement (unwind path) stays open under the kill switch');

    $a = file_get_contents(FCPATH . 'application/controllers/Api_sports.php');
    assert_contains('killSwitch', fx_prod_body($a, 'public function decide_ticket(', 'public function settle_ticket('), 'API approval is gated on the kill switch');
    assert_true(!str_contains(fx_prod_body($a, 'public function settle_ticket(', ''), 'killSwitch'), 'API settlement stays open under the kill switch');
});

test('sports prod review: kill switch gate reads live platform state and boots fail-closed', function () {
    $p = platform();
    $p->setKillSwitch(true, 'prod review: gate check');
    assert_true((bool) ($p->state()['killSwitch']['active'] ?? false), 'engaged kill switch persists and reloads');
    $p->setKillSwitch(false, 'prod review: release');
    assert_true(empty($p->state()['killSwitch']['active']), 'released kill switch reloads inactive');
    assert_contains('Default state at boot', file_get_contents(FCPATH . 'application/models/Aegis_model.php'), 'fresh installs boot with the kill switch ACTIVE (fail closed)');
});
