<?php
/** Public site, authentication gates and dashboard separation. */

test('public website routes and views exist without exposing dashboards', function () {
    $routes = file_get_contents(FCPATH . 'application/config/routes.php');
    assert_contains("\$route['default_controller'] = 'site';", $routes);
    assert_contains("\$route['dashboard'] = 'workspace/index';", $routes);
    assert_contains("\$route['analysis'] = 'welcome';", $routes);
    assert_contains("\$route['register'] = 'auth/register';", $routes);
    assert_contains("\$route['access-denied'] = 'auth/denied';", $routes);
    assert_contains("\$route['admin/dashboard'] = 'admin/index';", $routes);
    foreach (['about', 'services', 'how-it-works', 'locations', 'safety', 'faq', 'contact'] as $path) {
        assert_contains("\$route['{$path}']", $routes);
    }
    assert_true(is_file(FCPATH . 'application/controllers/Site.php'));
    assert_true(is_file(FCPATH . 'application/controllers/Workspace.php'));
    assert_true(is_file(FCPATH . 'application/views/site/home.php'));
    assert_true(is_file(FCPATH . 'application/views/workspace/index.php'));
    $home = file_get_contents(FCPATH . 'application/views/site/home.php');
    assert_false(str_contains($home, 'href="/analysis"'));
    assert_contains('Get started', $home);
});

test('workspace controllers require App_Controller login gate', function () {
    foreach (['Welcome', 'Workspace', 'Paper', 'Admin', 'Sports', 'Lang_learn', 'Leads'] as $name) {
        $src = file_get_contents(FCPATH . 'application/controllers/' . $name . '.php');
        assert_contains('extends App_Controller', $src, $name . ' must extend App_Controller');
    }
    $core = file_get_contents(FCPATH . 'application/core/MY_Controller.php');
    assert_contains('function requireLogin', $core);
    assert_contains('function requireAdminPage', $core);
    $api = $core;
    assert_contains('unauthenticated', $api);
    $admin = file_get_contents(FCPATH . 'application/controllers/Admin.php');
    assert_contains('requireAdminPage', $admin);
});

test('member registration role is seeded in the RBAC matrix', function () {
    assert_true(isset(AEGIS_RBAC_ROLES['platform_member']));
    assert_in_array('trading.view', AEGIS_RBAC_GRANTS['platform_member']);
    assert_in_array('sports.view', AEGIS_RBAC_GRANTS['platform_member']);
    assert_false(in_array('system.super_admin', AEGIS_RBAC_GRANTS['platform_member'], true));
});

test('sitemap lists public pages and robots hide dashboards', function () {
    $seo = file_get_contents(FCPATH . 'application/controllers/Seo.php');
    assert_contains("'/about'", $seo);
    assert_contains("'/register'", $seo);
    assert_false(str_contains($seo, "'/strategy'"));
    assert_contains('Disallow: /dashboard', $seo);
});
