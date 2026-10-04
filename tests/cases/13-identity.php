<?php
use Aegis\Identity;
use Aegis\Persistence\IdentityRepository;

function fx_identity(): array {
    $repo = new class implements IdentityRepository {
        public array $events = [];
        public array $user;
        public function __construct() { $this->user = ['id' => 1, 'email' => 'admin@example.test', 'password_hash' => password_hash('safe-password', PASSWORD_DEFAULT), 'active' => 1]; }
        public function findUserByEmail(string $email): ?array { return $email === $this->user['email'] ? $this->user : null; }
        public function findUserByUsername(string $username): ?array { return $username === ($this->user['username'] ?? 'admin') ? $this->user : null; }
        public function findUserByUid(string $uid): ?array { return $uid === ($this->user['user_uid'] ?? '000001') ? $this->user : null; }
        public function findUserById(int $id): ?array { return $id === 1 ? $this->user : null; }
        public function findUserByIdentifier(string $identifier): ?array {
            return filter_var($identifier, FILTER_VALIDATE_EMAIL)
                ? $this->findUserByEmail(strtolower($identifier))
                : (preg_match('/^\d{6}$/', $identifier) ? $this->findUserByUid($identifier) : $this->findUserByUsername($identifier));
        }
        public function createUser(array $user): array { return $user; }
        public function updateUser(int $id, array $patch): void {}
        public function usernameTaken(string $username, ?int $exceptId = null): bool { return false; }
        public function emailTaken(string $email, ?int $exceptId = null): bool { return false; }
        public function generateUniqueUsername(string $base): string { return 'user1'; }
        public function generateUniqueUid(): string { return '100001'; }
        public function ensureRole(string $code, string $name): int { return 1; }
        public function ensurePermission(string $code, string $name): int { return 1; }
        public function grantRolePermission(int $roleId, int $permissionId): void {}
        public function assignRole(int $userId, int $roleId): void {}
        public function permissionsForUser(int $userId): array { return ['sports.manage']; }
        public function recordAuthEvent(int $userId, string $type, array $detail = []): void { $this->events[] = $type; }
    };
    return [new Identity($repo), $repo];
}
test('identity authenticates a password hash and removes secret hash from response', function () {
    [$identity, $repo] = fx_identity(); $user = $identity->authenticate('ADMIN@example.test', 'safe-password');
    assert_equals('LOGIN_SUCCEEDED', $repo->events[0]); assert_false(isset($user['password_hash'])); assert_true($identity->can($user, 'sports.manage')); assert_true($identity->can($user, 'system.authenticated'));
});
test('identity rejects invalid password and records failure', function () {
    [$identity, $repo] = fx_identity(); assert_equals(null, $identity->authenticate('admin@example.test', 'wrong'));
    assert_equals('LOGIN_FAILED', $repo->events[0]);
});
