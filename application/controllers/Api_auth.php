<?php
defined('BASEPATH') or exit('No direct script access allowed');

/** Session authentication API. Credentials never appear in logs or responses. */
class Api_auth extends Api_controller
{
    public function login()
    {
        $body = $this->jsonBody(); $email = (string) ($body['email'] ?? ''); $password = (string) ($body['password'] ?? '');
        $attempts = (int) $this->session->userdata('login_attempts');
        $until = (int) $this->session->userdata('login_locked_until');
        if ($until > time()) return $this->jsonError('too many login attempts; try again later', 429);
        if ($email === '' || $password === '') return $this->jsonError('email and password are required');
        $user = $this->platform->identity->authenticate($email, $password);
        if (!$user) {
            $attempts++; $this->session->set_userdata('login_attempts', $attempts);
            if ($attempts >= 5) $this->session->set_userdata('login_locked_until', time() + 900);
            return $this->jsonError('invalid credentials', 401);
        }
        $this->session->sess_regenerate(TRUE);
        $csrf = bin2hex(random_bytes(32));
        $this->session->set_userdata(['identity' => $user, 'csrf_token' => $csrf, 'login_attempts' => 0, 'login_locked_until' => 0]);
        $this->json(['user' => $user, 'csrfToken' => $csrf]);
    }
    public function me()
    {
        $user = $this->session->userdata('identity');
        if (!is_array($user)) return $this->jsonError('unauthenticated', 401);
        $this->json(['user' => $user, 'csrfToken' => $this->session->userdata('csrf_token')]);
    }
    public function logout()
    {
        if (!$this->requirePermission('system.authenticated')) return;
        $this->session->sess_destroy(); $this->json(['ok' => true]);
    }
}
