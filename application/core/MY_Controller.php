<?php
defined('BASEPATH') or exit('No direct script access allowed');

require_once __DIR__ . '/../libraries/Aegis/autoload.php';

/**
 * Base controller: builds the AEGIS Platform (domain services wired to the
 * database through CI3's model layer) once per request.
 */
class MY_Controller extends CI_Controller
{
    public \Aegis\Platform $platform;

    public function __construct()
    {
        parent::__construct();
        $this->load->model('Aegis_model');
        $disableReal = getenv('AEGIS_DISABLE_REAL_PROVIDERS') === '1';
        $this->platform = new \Aegis\Platform($this->Aegis_model, $disableReal);
    }

    protected function currentUser(): ?array
    {
        $user = $this->session->userdata('identity');
        if (is_array($user) && !empty($user['id'])) return $user;
        return $this->restoreFromRememberCookie();
    }

    /**
     * Remember-me support: when no session identity exists, a valid signed
     * cookie (issued by Auth::login when "remember me" was checked) restores
     * the session transparently. The cookie is stateless — userId + expiry +
     * HMAC signed with the configured encryption key — so it fails closed
     * when no key is configured, when the signature/expiry is wrong, or when
     * the account was deactivated.
     */
    protected function restoreFromRememberCookie(): ?array
    {
        $key = (string) $this->config->item('encryption_key');
        if ($key === '') return null; // fail closed without a signing key
        $raw = (string) ($this->input->cookie(self::REMEMBER_COOKIE, true) ?: ($_COOKIE[self::REMEMBER_COOKIE] ?? ''));
        if ($raw === '' || substr_count($raw, '.') !== 3) return null;
        [$version, $id, $expires, $sig] = explode('.', $raw, 4);
        if ($version !== 'v1' || !ctype_digit($id) || !ctype_digit($expires)) return null;
        if ((int) $expires < time()) return null;
        $expected = hash_hmac('sha256', "v1.{$id}.{$expires}", $key);
        if (!hash_equals($expected, $sig)) return null;
        $user = $this->platform->identity->rememberUser((int) $id);
        if (!$user) return null;
        $this->session->set_userdata([
            'identity' => $user,
            'csrf_token' => (string) ($this->session->userdata('csrf_token') ?: bin2hex(random_bytes(32))),
        ]);
        return $user;
    }

    /** Issue the signed remember-me cookie (30 days, HttpOnly, SameSite=Lax). */
    protected function issueRememberCookie(int $userId): void
    {
        $key = (string) $this->config->item('encryption_key');
        if ($key === '') return; // feature disabled without a signing key
        $expires = time() + 30 * 86400;
        $sig = hash_hmac('sha256', "v1.{$userId}.{$expires}", $key);
        setcookie(self::REMEMBER_COOKIE, "v1.{$userId}.{$expires}.{$sig}", [
            'expires' => $expires,
            'path' => '/',
            'domain' => (string) $this->config->item('cookie_domain'),
            'secure' => (bool) $this->config->item('cookie_secure'),
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }

    /** Clear the remember-me cookie (logout, credential changes). */
    protected function clearRememberCookie(): void
    {
        setcookie(self::REMEMBER_COOKIE, '', [
            'expires' => time() - 3600,
            'path' => '/',
            'domain' => (string) $this->config->item('cookie_domain'),
            'secure' => (bool) $this->config->item('cookie_secure'),
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }

    public const REMEMBER_COOKIE = 'aegis_remember';

    protected function isAdmin(?array $user = null): bool
    {
        $user = $user ?? $this->currentUser();
        return $user !== null && $this->platform->identity->can($user, 'system.super_admin');
    }

    protected function requireLogin(): array
    {
        $user = $this->currentUser();
        if ($user) return $user;
        $next = '/' . ltrim((string) uri_string(), '/');
        if ($next !== '/' && $next !== '') $this->session->set_userdata('return_to', $next);
        redirect('/login');
        exit;
    }

    protected function requireAdminPage(): array
    {
        $user = $this->currentUser();
        if (!$user) {
            $this->session->set_userdata('return_to', '/admin');
            redirect('/login');
            exit;
        }
        if (!$this->isAdmin($user)) {
            redirect('/access-denied');
            exit;
        }
        return $user;
    }

    /** Require a signed-in user plus an explicit permission for privileged APIs. */
    protected function requirePermission(string $permission, bool $csrf = true): ?array
    {
        $user = $this->session->userdata('identity');
        if (!is_array($user) || !$this->platform->identity->can($user, $permission)) {
            $this->jsonError('forbidden', 403); return null;
        }
        if ($csrf && !in_array($this->input->method(true), ['GET', 'HEAD'], true)) {
            $token = $this->input->get_request_header('X-CSRF-Token');
            if (!is_string($token) || !hash_equals((string) $this->session->userdata('csrf_token'), $token)) {
                $this->jsonError('invalid CSRF token', 403); return null;
            }
        }
        return $user;
    }

    /** JSON response helper. */
    protected function json($data, int $status = 200): void
    {
        http_response_code($status);
        $this->output
            ->set_content_type('application/json')
            ->set_output(json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    protected function jsonError(string $message, int $status = 400, array $extra = []): void
    {
        $this->json(array_merge(['error' => $message], $extra), $status);
    }

    /** Read + validate a JSON request body. */
    protected function jsonBody(): array
    {
        $raw = file_get_contents('php://input');
        if ($raw === '' || $raw === false) {
            return $this->input->post() ?: [];
        }
        $decoded = json_decode($raw, true);
        return is_array($decoded) ? $decoded : [];
    }
}

/** JSON API base — always returns JSON, never a view. */
class Api_controller extends MY_Controller
{
    private const PUBLIC_ACTIONS = [
        'api_auth/login' => true,
        'api_chat/respond' => true,
        'api_system/status' => true,
        'api_system/features' => true,
    ];

    public function __construct()
    {
        parent::__construct();
        $key = strtolower($this->router->class . '/' . $this->router->method);
        if (!isset(self::PUBLIC_ACTIONS[$key]) && $this->currentUser() === null) {
            $this->jsonError('unauthenticated', 401);
            $this->output->_display();
            exit;
        }
    }
    protected function requireFields(array $body, array $fields): ?array
    {
        $missing = [];
        foreach ($fields as $f) {
            if (!isset($body[$f]) || $body[$f] === '' || $body[$f] === null) $missing[] = $f;
        }
        if ($missing) {
            $this->jsonError('missing required fields: ' . implode(', ', $missing), 400);
            return null;
        }
        return $body;
    }
}
