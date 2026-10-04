<?php
/**
 * Full-project UI audit (routes · buttons · auth · dashboard chrome).
 *
 * Static review of the parts that a browser click-test verifies dynamically:
 * every sidebar item, profile-menu action, footer link and homepage CTA must
 * point at a routed destination, the dashboard chrome must stay compact and
 * consistent, and role gates must be enforced in the controller layer.
 */

test('dashboard sidebar contains every required item with a real route and an icon', function () {
    $header = file_get_contents(FCPATH . 'application/views/layout/header.php');
    $routes = file_get_contents(FCPATH . 'application/config/routes.php');
    $required = [
        'Dashboard'       => '/dashboard',
        'AI Workforce'    => '/analysis',
        'AI Teacher'      => '/app/languages/teacher',
        'My Languages'    => '/app/languages',
        'Lead Discovery'  => '/leads',
        'Pipeline'        => '/lead-pipeline',
        'Paper Trading'   => '/paper',
        'Strategy Lab'    => '/strategy',
        'Analytics'       => '/journal',
        'Execution'       => '/execution',
        'Brokers'         => '/brokers',
        'Risk Center'     => '/risk',
        'Sports Intel'    => '/sports',
        'Alerts'          => '/notifications',
        'Settings'        => '/account',
        'Help'            => '/faq',
    ];
    foreach ($required as $label => $href) {
        assert_contains('href="' . $href . '"', $header, "sidebar item '$label' must link to $href");
    }
    // Every sidebar link uses the SPA navigation hook (keeps the shell mounted).
    assert_contains('data-dashboard-link', $header);
    // Every required destination must exist as a route (or resolve through
    // CodeIgniter's default controller/method routing).
    foreach ($required as $label => $href) {
        $segments = trim($href, '/');
        $hasRoute = str_contains($routes, "\$route['" . $segments . "']")
            || ($segments !== '' && preg_match("/\\\$route\['" . preg_quote($segments, '/') . "\//", $routes));
        if (!$hasRoute) {
            $first = explode('/', $segments)[0];
            $controller = FCPATH . 'application/controllers/' . str_replace(' ', '', ucwords(str_replace('_', ' ', $first))) . '.php';
            $hasRoute = is_file($controller);
        }
        assert_true($hasRoute, "route for sidebar destination '$href' must exist");
    }
    // No sidebar item may be a dead "#" link.
    assert_false(str_contains($header, 'href="#"'), 'sidebar must not contain dead href="#" links');
});

test('sidebar icons are one consistent compact size', function () {
    $css = file_get_contents(FCPATH . 'assets/css/aegis.css');
    assert_contains('.sidebar a svg { width: 20px; height: 20px;', $css, 'sidebar svg icons sized 20x20');
    $header = file_get_contents(FCPATH . 'application/views/layout/header.php');
    // Sidebar icons rely on the stylesheet size: no inline width/height overrides.
    preg_match_all('#<a href="/[^"]*" class="[^"]*" data-dashboard-link><svg[^>]*>#', $header, $m);
    foreach ($m[0] as $anchor) {
        assert_false(preg_match('/\swidth=/', $anchor), 'sidebar svg must not carry inline width: ' . $anchor);
        assert_false(preg_match('/\sheight=/', $anchor), 'sidebar svg must not carry inline height: ' . $anchor);
    }
    // Section labels, brand and logout keep the sidebar tidy.
    assert_contains('.sidebar-label', $css);
    assert_contains('.sidebar-logout', $css);
});

test('top-right controls are compact and contain no oversized dot glyph', function () {
    $header = file_get_contents(FCPATH . 'application/views/layout/header.php');
    $css = file_get_contents(FCPATH . 'assets/css/aegis.css');
    // Status pill uses a small CSS dot, not a large text bullet.
    assert_contains('statuspill', $header);
    assert_false(str_contains($header, "● Kill switch"), 'statuspill must not render a text bullet glyph');
    assert_contains('.statuspill .pill-dot { width: 6px; height: 6px;', $css, 'statuspill dot is a 6px element');
    // Notification icon button and avatar stay small.
    assert_contains('.icon-btn svg { width: 20px; height: 20px; }', $css);
    assert_contains('.profile .avatar { width: 28px; height: 28px;', $css);
    // Notifications dot is tiny.
    assert_contains('.icon-btn .dot { position: absolute;', $css);
});

test('profile menu exposes working actions (settings, security, notifications, sign out)', function () {
    $header = file_get_contents(FCPATH . 'application/views/layout/header.php');
    $account = file_get_contents(FCPATH . 'application/views/auth/account.php');
    assert_contains('id="profile-menu"', $header);
    assert_contains('href="/account"', $header);
    assert_contains('href="/account#security"', $header, 'profile menu has a Security action');
    assert_contains('href="/notifications"', $header);
    assert_contains('action="/logout"', $header, 'profile menu contains the logout form');
    assert_contains('name="csrf_token"', $header, 'logout form is CSRF protected');
    // The Security target section exists on the account page.
    assert_contains('id="security"', $account, 'account page has a #security section');
});

test('logout is POST + CSRF, destroys the session and shows the goodbye page', function () {
    $auth = file_get_contents(FCPATH . 'application/controllers/Auth.php');
    assert_contains('public function logout()', $auth);
    assert_contains('sess_destroy', $auth);
    // POST-only enforcement via CSRF token check on logout.
    assert_contains('validAuthCsrf', $auth);
    // The signed-out goodbye page is rendered after the session is destroyed.
    assert_contains('load->view(\'auth/goodbye\'', $auth);
    $goodbye = file_get_contents(FCPATH . 'application/views/auth/goodbye.php');
    assert_contains('You\'ve been signed out', $goodbye);
    assert_contains('action="/login"', $goodbye);
    $header = file_get_contents(FCPATH . 'application/views/layout/header.php');
    assert_contains('method="post" action="/logout"', $header);
    assert_contains('csrf_token', $header);
});

test('homepage CTAs and site footer links all point at routed destinations', function () {
    $home = file_get_contents(FCPATH . 'application/views/site/home.php');
    $routes = file_get_contents(FCPATH . 'application/config/routes.php');
    assert_false(str_contains($home, 'href="#"'), 'homepage must not contain dead href="#" links');
    preg_match_all('~href="(/[^"#]*)"~', $home, $m);
    assert_true(count($m[1]) > 8, 'homepage exposes its navigation and CTA links');
    foreach (array_unique($m[1]) as $href) {
        if (str_starts_with($href, '/assets/') || str_starts_with($href, '/api/')) continue;
        $segments = trim($href, '/');
        assert_true(
            str_contains($routes, "\$route['" . $segments . "']") || str_contains($routes, "\$route['" . $segments . "']"),
            "homepage link '$href' must have a route"
        );
    }
    $footer = file_get_contents(FCPATH . 'application/views/site/layout/footer.php');
    assert_false(str_contains($footer, 'href="#"'), 'footer must not contain dead href="#" links');
    preg_match_all('#href="([^"]+)"#', $footer, $fm);
    $fm[1] = array_values(array_filter($fm[1], fn ($h) => $h !== '#'));
    assert_true(count($fm[1]) > 4, 'footer must expose its links');
    foreach (array_unique($fm[1]) as $href) {
        if (preg_match('#^(https?://|mailto:)#', $href)) continue; // real external destinations are fine
        $segments = trim($href, '/');
        assert_true(
            str_contains($routes, "\$route['" . $segments . "']") || str_contains($routes, "\$route['" . $segments . "']"),
            "footer link '$href' must have a route"
        );
    }
});

test('auth pages are routed and protected-dashboard routes redirect to login', function () {
    $routes = file_get_contents(FCPATH . 'application/config/routes.php');
    foreach (['login', 'register', 'forgot-password', 'logout', 'account', 'access-denied', 'admin/login'] as $path) {
        assert_contains("\$route['{$path}']", $routes, "auth route '$path' must exist");
    }
    $core = file_get_contents(FCPATH . 'application/core/MY_Controller.php');
    assert_contains('function requireLogin', $core);
    assert_contains("redirect('/login')", $core, 'requireLogin redirects visitors to /login');
    assert_contains('function requireAdminPage', $core);
    assert_contains("redirect('/access-denied')", $core, 'requireAdminPage redirects non-admins to /access-denied');
    foreach (['Welcome', 'Workspace', 'Paper', 'Admin', 'Sports', 'Lang_learn', 'Leads', 'Execution', 'Brokers', 'Risk_center', 'Journal', 'Notifications', 'Strategy_lab'] as $name) {
        $src = file_get_contents(FCPATH . 'application/controllers/' . $name . '.php');
        assert_contains('extends App_Controller', $src, "$name must extend App_Controller (login gate)");
    }
    $admin = file_get_contents(FCPATH . 'application/controllers/Admin.php');
    assert_contains('requireAdminPage', $admin, 'admin controller enforces the super-admin gate');
});

test('login/register/forgot forms submit to their real actions with CSRF', function () {
    $login = file_get_contents(FCPATH . 'application/views/auth/login.php');
    assert_contains('action="/login/submit"', $login);
    assert_contains('name="csrf_token"', $login);
    $register = file_get_contents(FCPATH . 'application/views/auth/register.php');
    assert_contains('action="/register/submit"', $register);
    assert_contains('name="csrf_token"', $register);
    $forgot = file_get_contents(FCPATH . 'application/views/auth/forgot.php');
    assert_contains('action="/forgot-password/submit"', $forgot);
    assert_contains('name="csrf_token"', $forgot);
});
