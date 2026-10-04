<?php
/**
 * PHASE 5 hardening — RBAC on the trading governance surface (spec §16/§18):
 * seeded trading roles/permissions and the Identity decision matrix. The
 * HTTP layer itself is verified against the live server in smoke tests
 * (unauthenticated mutating calls must 403).
 */
test('installer seeds trading roles and permissions', function () {
    $p = platform();
    $db = $p->model->db;
    $roles = array_column($db->get('roles')->result_array(), 'code');
    $perms = array_column($db->get('permissions')->result_array(), 'code');
    foreach (['trading_operator', 'trading_viewer'] as $role) {
        assert_contains($role, implode(',', $roles));
    }
    foreach (['trading.view', 'trading.control', 'trading.execute'] as $perm) {
        assert_contains($perm, implode(',', $perms));
    }
});

test('trading_viewer can view but never control or execute', function () {
    $p = platform();
    $repo = $p->model->identity;
    $now = gmdate('c');
    $email = 'viewer-' . uniqid() . '@example.com';
    $user = $repo->createUser(['email' => $email, 'password_hash' => password_hash('long-password-123456', PASSWORD_DEFAULT), 'display_name' => 'Viewer', 'active' => 1, 'created_at' => $now, 'updated_at' => $now]);
    $role = $repo->ensureRole('trading_viewer', 'Trading viewer (read-only)');
    $repo->assignRole((int) $user['id'], $role);

    $fresh = $repo->findUserById((int) $user['id']);
    $fresh['permissions'] = $repo->permissionsForUser((int) $user['id']);
    assert_true($p->identity->can($fresh, 'system.authenticated'));
    assert_true($p->identity->can($fresh, 'trading.view'));
    assert_false($p->identity->can($fresh, 'trading.control'));
    assert_false($p->identity->can($fresh, 'trading.execute'));
});

test('trading_operator holds the full trading surface', function () {
    $p = platform();
    $repo = $p->model->identity;
    $now = gmdate('c');
    $email = 'operator-' . uniqid() . '@example.com';
    $user = $repo->createUser(['email' => $email, 'password_hash' => password_hash('long-password-123456', PASSWORD_DEFAULT), 'display_name' => 'Operator', 'active' => 1, 'created_at' => $now, 'updated_at' => $now]);
    $role = $repo->ensureRole('trading_operator', 'Trading operator (control + execution)');
    $repo->assignRole((int) $user['id'], $role);

    $fresh = $repo->findUserById((int) $user['id']);
    $fresh['permissions'] = $repo->permissionsForUser((int) $user['id']);
    foreach (['trading.view', 'trading.control', 'trading.execute'] as $perm) {
        assert_true($p->identity->can($fresh, $perm), "operator can {$perm}");
    }
    // operators are NOT super admins
    assert_false($p->identity->can($fresh, 'sports.settle'));
    assert_false($p->identity->can($fresh, 'system.super_admin'));
});

test('super_admin overrides every trading permission', function () {
    $p = platform();
    $now = gmdate('c');
    $email = 'root-' . uniqid() . '@example.com';
    $user = $p->model->identity->createUser(['email' => $email, 'password_hash' => password_hash('long-password-123456', PASSWORD_DEFAULT), 'display_name' => 'Root', 'active' => 1, 'created_at' => $now, 'updated_at' => $now]);
    $role = $p->model->identity->ensureRole('super_admin', 'Super administrator');
    $p->model->identity->assignRole((int) $user['id'], $role);
    $fresh = $p->model->identity->findUserById((int) $user['id']);
    $fresh['permissions'] = $p->model->identity->permissionsForUser((int) $user['id']);
    assert_true($p->identity->can($fresh, 'trading.control'));
    assert_true($p->identity->can($fresh, 'trading.execute'));
    assert_true($p->identity->can($fresh, 'sports.settle'));
});

test('approval decisions record the deciding operator identity', function () {
    es_state();
    $sup = es_supervisor(new FakeTradingConnector());
    $result = $sup->propose(es_intent(), 'alice@example.com');
    $sup->decide($result['id'], true, 'bob@example.com', 'risk reviewed');
    $stored = $sup->proposal($result['id']);
    assert_equals('bob@example.com', $stored['decision_by']);
    assert_not_null($stored['decided_at']);
    $events = array_filter(platform()->model->audit->recent(50), fn($e) => $e['type'] === 'EXECUTION_APPROVAL_GRANTED' && str_contains($e['summary'], $result['id']));
    assert_equals(1, count($events));
    assert_equals('bob@example.com', array_values($events)[0]['actor']);
});
