<?php
/** Authentication and administrator page wiring review for browser deployments. */
test('user and administrator login/account pages are routed and use the secure controller', function () {
    $routes = file_get_contents(FCPATH . 'application/config/routes.php');
    assert_contains("\$route['login'] = 'auth/index';", $routes);
    assert_contains("\$route['admin/login'] = 'auth/admin_login';", $routes);
    assert_contains("\$route['account'] = 'auth/account';", $routes);
    assert_contains("\$route['admin'] = 'admin/index';", $routes);
    assert_true(is_file(FCPATH . 'application/controllers/Auth.php'));
    assert_true(is_file(FCPATH . 'application/controllers/Admin.php'));
    assert_true(is_file(FCPATH . 'application/views/auth/login.php'));
    assert_true(is_file(FCPATH . 'application/views/auth/account.php'));
    assert_true(is_file(FCPATH . 'application/views/admin/index.php'));
    assert_contains('csrf_token', file_get_contents(FCPATH . 'application/views/auth/account.php'));
    assert_contains('system.super_admin', file_get_contents(FCPATH . 'application/controllers/Admin.php'));
});

test('generated brand assets are wired into PHP views', function () {
    assert_true(is_file(FCPATH . 'assets/images/aegis-mark.png'));
    assert_true(is_file(FCPATH . 'assets/images/ai-agent-avatar.png'));
    $header = file_get_contents(FCPATH . 'application/views/layout/header.php');
    assert_contains('/assets/images/aegis-mark.png', $header);
    assert_contains('/dashboard', $header);
    assert_contains('/assets/images/ai-agent-avatar.png', file_get_contents(FCPATH . 'application/views/admin/index.php'));
});

test('SEO documents and public chat widget are routed for every PHP page', function () {
    $routes = file_get_contents(FCPATH . 'application/config/routes.php');
    assert_contains("\$route['robots.txt'] = 'seo/robots';", $routes);
    assert_contains("\$route['sitemap.xml'] = 'seo/sitemap';", $routes);
    assert_contains("\$route['api/chat/respond'] = 'api_chat/respond';", $routes);
    assert_true(is_file(FCPATH . 'application/config/seo.php'));
    assert_true(is_file(FCPATH . 'application/controllers/Seo.php'));
    assert_true(is_file(FCPATH . 'application/controllers/Api_chat.php'));
    assert_true(is_file(FCPATH . 'application/libraries/Aegis/ChatAssistant.php'));
    assert_true(is_file(FCPATH . 'assets/js/aegis-chat.js'));
    assert_contains('aegis-chat', file_get_contents(FCPATH . 'application/views/layout/footer.php') . file_get_contents(FCPATH . 'application/views/partials/chat_widget.php'));
});
