<?php
namespace Aegis;

use Aegis\Persistence\IdentityRepository;

/** Password verification and permission checks; HTTP/session handling stays in CI middleware. */
class Identity
{
    public function __construct(private IdentityRepository $users) {}
    /**
     * Authenticate using any single identifier — email address, username or
     * six-digit User ID — plus the account password.
     */
    public function authenticate(string $identifier, string $password): ?array
    {
        $user = $this->users->findUserByIdentifier(trim($identifier));
        if (!$user || empty($user['active']) || !password_verify($password, $user['password_hash'])) {
            if ($user) $this->users->recordAuthEvent((int) $user['id'], 'LOGIN_FAILED');
            return null;
        }
        $user['permissions'] = $this->users->permissionsForUser((int) $user['id']);
        $this->users->recordAuthEvent((int) $user['id'], 'LOGIN_SUCCEEDED');
        unset($user['password_hash']);
        return $user;
    }
    /**
     * Rehydrate a session identity for a signed remember-me cookie. The
     * caller must verify the cookie signature first; this only rebuilds the
     * same identity shape authenticate() returns (fresh permissions, no
     * password hash) and refuses inactive accounts.
     */
    public function rememberUser(int $userId): ?array
    {
        $user = $this->users->findUserById($userId);
        if (!$user || empty($user['active'])) return null;
        $user['permissions'] = $this->users->permissionsForUser($userId);
        $this->users->recordAuthEvent($userId, 'REMEMBER_RESTORED');
        unset($user['password_hash']);
        return $user;
    }

    public function can(array $user, string $permission): bool
    {
        if ($permission === 'system.authenticated') return !empty($user['id']);
        return in_array($permission, $user['permissions'] ?? [], true) || in_array('system.super_admin', $user['permissions'] ?? [], true);
    }
}
