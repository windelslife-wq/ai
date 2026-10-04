<?php
use Aegis\Identity;

require_once FCPATH . 'tools/rbac.php';

test('sports RBAC matrix grants exactly the intended permissions', function () {
    assert_in_array('sports.view', AEGIS_RBAC_GRANTS['sports_viewer']);
    assert_equals(['sports.view'], AEGIS_RBAC_GRANTS['sports_viewer'], 'viewer is read-only');
    $admin = AEGIS_RBAC_GRANTS['sports_admin'];
    foreach (['sports.view', 'sports.manage', 'sports.approve', 'sports.settle'] as $p) assert_in_array($p, $admin);
    assert_false(in_array('trading.control', $admin, true), 'sports admin must not gain trading control');
    assert_equals(array_keys(AEGIS_RBAC_PERMISSIONS), AEGIS_RBAC_GRANTS['super_admin'], 'super admin holds every permission');
});

function fx_identity_for(array $permissions): Identity
{
    $repo = new class($permissions) implements \Aegis\Persistence\IdentityRepository {
        public function __construct(private array $p) {}
        public function findUserByEmail(string $e): ?array { return ['id' => 7, 'email' => $e, 'password_hash' => 'x', 'active' => 1]; }
        public function findUserByUsername(string $u): ?array { return ['id' => 7, 'email' => 'a@b.c', 'password_hash' => 'x', 'active' => 1]; }
        public function findUserByUid(string $u): ?array { return ['id' => 7, 'email' => 'a@b.c', 'password_hash' => 'x', 'active' => 1]; }
        public function findUserById(int $id): ?array { return ['id' => 7, 'email' => 'a@b.c', 'password_hash' => 'x', 'active' => 1]; }
        public function findUserByIdentifier(string $i): ?array { return ['id' => 7, 'email' => $i, 'password_hash' => 'x', 'active' => 1]; }
        public function createUser(array $u): array { return $u; }
        public function updateUser(int $id, array $patch): void {}
        public function usernameTaken(string $u, ?int $e = null): bool { return false; }
        public function emailTaken(string $e, ?int $x = null): bool { return false; }
        public function generateUniqueUsername(string $b): string { return 'user7'; }
        public function generateUniqueUid(): string { return '700001'; }
        public function ensureRole(string $c, string $n): int { return 1; }
        public function ensurePermission(string $c, string $n): int { return 1; }
        public function grantRolePermission(int $r, int $p): void {}
        public function assignRole(int $u, int $r): void {}
        public function permissionsForUser(int $u): array { return $this->p; }
        public function recordAuthEvent(int $u, string $t, array $d = []): void {}
    };
    return new Identity($repo);
}

test('identity: sports viewer can view but never approve or settle', function () {
    $identity = fx_identity_for(['sports.view']);
    $user = ['id' => 7, 'permissions' => ['sports.view']];
    assert_true($identity->can($user, 'sports.view'));
    assert_false($identity->can($user, 'sports.approve'));
    assert_false($identity->can($user, 'sports.settle'));
    assert_false($identity->can($user, 'sports.manage'));
    assert_false($identity->can($user, 'trading.view'));
});

test('identity: sports admin holds the full sports surface', function () {
    $identity = fx_identity_for(['sports.view', 'sports.manage', 'sports.approve', 'sports.settle']);
    $user = ['id' => 7, 'permissions' => ['sports.view', 'sports.manage', 'sports.approve', 'sports.settle']];
    foreach (['sports.view', 'sports.manage', 'sports.approve', 'sports.settle'] as $p) assert_true($identity->can($user, $p));
    assert_false($identity->can($user, 'trading.execute'));
});

test('identity: super_admin overrides every sports permission', function () {
    $identity = fx_identity_for(['system.super_admin']);
    $user = ['id' => 7, 'permissions' => ['system.super_admin']];
    foreach (['sports.view', 'sports.manage', 'sports.approve', 'sports.settle'] as $p) assert_true($identity->can($user, $p));
});

test('identity: anonymous user has no sports permission', function () {
    $identity = fx_identity_for([]);
    assert_false($identity->can([], 'sports.view'));
    assert_false($identity->can([], 'system.authenticated'));
});

test('sports API routes are wired with permission-bearing endpoints', function () {
    $routes = file_get_contents(FCPATH . 'application/config/routes.php');
    assert_contains('api/sports/status', $routes);
    assert_contains('api/sports/performance', $routes);
    assert_contains('api/sports/tickets/(:any)/decide', $routes);
    assert_contains('api/sports/tickets/(:any)/settle', $routes);
    assert_contains('api/sports/results/verify', $routes);
    assert_contains('api/sports/configuration', $routes);
    assert_contains('api/sports/backtests', $routes);
    assert_contains('api/sports/models', $routes);
});
