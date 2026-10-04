<?php
defined('BASEPATH') or exit('No direct script access allowed');

/** Browser authentication pages for the portable PHP/cPanel application. */
class Auth extends MY_Controller
{
    public function index()
    {
        if ($user = $this->sessionUser()) {
            redirect($this->isAdmin($user) ? '/admin' : '/dashboard');
            return;
        }
        $this->renderAuth(false);
    }

    public function admin_login()
    {
        if ($user = $this->sessionUser()) {
            redirect($this->isAdmin($user) ? '/admin' : '/access-denied');
            return;
        }
        $this->renderAuth(true);
    }

    public function register()
    {
        if ($this->sessionUser()) { redirect('/dashboard'); return; }
        $this->load->view('auth/register', [
            'title' => 'Create an account',
            'error' => $this->consumeFlash('error'),
            'notice' => $this->consumeFlash('notice'),
            'csrfToken' => $this->ensureVisitorCsrf(),
        ]);
    }

    public function register_submit()
    {
        if ($this->sessionUser()) { redirect('/dashboard'); return; }
        if (!$this->validAuthCsrf()) {
            $this->flash('error', 'Your session expired while filling in the form. Please try again.');
            redirect('/register');
            return;
        }
        $username = strtolower(trim((string) $this->input->post('username')));
        $email = strtolower(trim((string) $this->input->post('email')));
        $password = (string) $this->input->post('password');
        $confirm = (string) $this->input->post('password_confirm');
        $terms = (string) $this->input->post('terms');
        if (!$this->validUsername($username) || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $this->flash('error', 'Enter a valid username (3–20 letters, numbers or underscores) and a valid email address.');
            redirect('/register');
            return;
        }
        if (strlen($password) < 12 || $password !== $confirm) {
            $this->flash('error', 'Use a password of at least 12 characters and confirm it exactly.');
            redirect('/register');
            return;
        }
        if ($terms !== '1') {
            $this->flash('error', 'Please accept the Terms and Privacy Policy to create an account.');
            redirect('/register');
            return;
        }
        if ($this->Aegis_model->identity->findUserByEmail($email)) {
            $this->flash('error', 'An account with that email already exists. Sign in instead.');
            redirect('/login');
            return;
        }
        if ($this->Aegis_model->identity->usernameTaken($username)) {
            $this->flash('error', 'That username is already taken. Try a different one.');
            redirect('/register');
            return;
        }
        $now = gmdate('c');
        $new = $this->Aegis_model->identity->createUser([
            'username' => $username,
            'email' => $email,
            'password_hash' => password_hash($password, PASSWORD_DEFAULT),
            'display_name' => $username,
            'active' => 1,
            'created_at' => $now,
            'updated_at' => $now,
            'last_login_at' => $now,
        ]);
        $role = $this->Aegis_model->identity->ensureRole('platform_member', 'Platform member');
        foreach (['trading.view', 'sports.view', 'lottery.view'] as $code) {
            $pid = $this->Aegis_model->identity->ensurePermission($code, $code);
            $this->Aegis_model->identity->grantRolePermission($role, $pid);
        }
        $this->Aegis_model->identity->assignRole((int) $new['id'], $role);
        $this->Aegis_model->audit->emit('USER_REGISTERED', 'A visitor created a platform member account', ['userId' => (int) $new['id'], 'userUid' => (string) ($new['user_uid'] ?? '')], 'visitor');
        $user = $this->platform->identity->authenticate($username, $password);
        if (!$user) { $this->flash('error', 'Account created. Sign in to continue.'); redirect('/login'); return; }
        $this->establishSession($user);
        redirect('/dashboard');
    }

    public function forgot()
    {
        $this->load->view('auth/forgot', [
            'title' => 'Reset password',
            'notice' => $this->consumeFlash('notice'),
            'csrfToken' => $this->ensureVisitorCsrf(),
        ]);
    }

    public function forgot_submit()
    {
        if (!$this->validAuthCsrf()) {
            $this->flash('error', 'Your session expired. Please try again.');
            redirect('/forgot-password'); return;
        }
        $this->flash('notice', 'Password resets are issued by an administrator. Email support or your platform admin — this form does not invent a reset token.');
        redirect('/forgot-password');
    }

    public function denied()
    {
        $this->load->view('auth/denied', [
            'title' => 'Access denied',
            'user' => $this->sessionUser(),
        ]);
    }

    public function login()
    {
        $admin = $this->input->post('admin') === '1';
        if (!$this->validAuthCsrf()) { $this->flash('error', 'Your session expired. Please try again.'); $this->redirectLogin($admin); return; }
        // Single sign-in identifier — username, email address OR six-digit User ID.
        $identifier = trim((string) $this->input->post('identifier'));
        if ($identifier === '') $identifier = trim((string) $this->input->post('email'));
        $password = (string) $this->input->post('password');
        $remember = $this->input->post('remember') === '1';
        $attempts = (int) $this->session->userdata('login_attempts');
        $until = (int) $this->session->userdata('login_locked_until');
        if ($until > time()) { $this->flash('error', 'Too many attempts. Try again later.'); $this->redirectLogin($admin); return; }
        if ($identifier === '' || $password === '') { $this->flash('error', 'Enter your username, email or User ID and your password.'); $this->redirectLogin($admin); return; }
        $user = $this->platform->identity->authenticate($identifier, $password);
        if (!$user || ($admin && !$this->platform->identity->can($user, 'system.super_admin'))) {
            $attempts++;
            $this->session->set_userdata('login_attempts', $attempts);
            if ($attempts >= 5) $this->session->set_userdata('login_locked_until', time() + 900);
            $this->flash('error', $admin ? 'Administrator access was not granted.' : 'Invalid username, email or User ID, or password.');
            $this->redirectLogin($admin); return;
        }
        $this->establishSession($user);
        // "Remember me" keeps the user signed in on this browser for 30 days
        // via a signed, HttpOnly cookie; the session itself stays short-lived.
        if ($remember) $this->issueRememberCookie((int) $user['id']);
        else $this->clearRememberCookie();
        $next = (string) $this->session->userdata('return_to');
        $this->session->unset_userdata('return_to');
        if ($admin || $this->isAdmin($user)) { redirect('/admin'); return; }
        if ($next !== '' && str_starts_with($next, '/') && !str_starts_with($next, '//') && !str_contains($next, '://')) {
            redirect($next); return;
        }
        redirect('/dashboard');
    }

    public function logout()
    {
        $identity = $this->sessionUser();
        if ($identity) {
            $token = (string) $this->input->post('csrf_token');
            $known = (string) $this->session->userdata('csrf_token');
            if ($token === '' || $known === '' || !hash_equals($known, $token)) { $this->flash('error', 'Invalid security token.'); redirect('/account'); return; }
        }
        $this->clearRememberCookie();
        $this->session->sess_destroy();
        // Render the goodbye page for both a completed POST logout and a GET.
        $this->load->view('auth/goodbye', [
            'title' => 'You\'ve been signed out',
            'csrfToken' => bin2hex(random_bytes(32)),
        ]);
    }

    public function account()
    {
        $user = $this->requireLogin();
        $this->renderPage('My Account', 'account', ['user' => $user]);
    }

    /** Dashboard → My Account → Profile: change the username (their own only). */
    public function update_username()
    {
        $user = $this->requireLogin();
        if (!$this->validAuthCsrf()) { $this->flash('error', 'Your session expired. Please try again.'); redirect('/account'); return; }
        $username = strtolower(trim((string) $this->input->post('username')));
        if (!$this->validUsername($username)) {
            $this->flash('error', 'Usernames must be 3–20 characters using letters, numbers or underscores, starting with a letter.');
            redirect('/account'); return;
        }
        if ($this->Aegis_model->identity->usernameTaken($username, (int) $user['id'])) {
            $this->flash('error', 'That username is already in use by another account.');
            redirect('/account'); return;
        }
        $this->Aegis_model->identity->updateUser((int) $user['id'], ['username' => $username, 'display_name' => $username]);
        $this->Aegis_model->audit->emit('USER_UPDATED', 'User changed their username', ['userId' => (int) $user['id']], (string) $user['id']);
        $this->reestablishIdentity((int) $user['id']);
        $this->flash('notice', 'Your username has been updated.');
        redirect('/account');
    }

    /** Dashboard → My Account → Profile: change the email (their own only). */
    public function update_email()
    {
        $user = $this->requireLogin();
        if (!$this->validAuthCsrf()) { $this->flash('error', 'Your session expired. Please try again.'); redirect('/account'); return; }
        $email = strtolower(trim((string) $this->input->post('email')));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $this->flash('error', 'Enter a valid email address.');
            redirect('/account'); return;
        }
        if ($this->Aegis_model->identity->emailTaken($email, (int) $user['id'])) {
            $this->flash('error', 'That email address is already attached to another account.');
            redirect('/account'); return;
        }
        $this->Aegis_model->identity->updateUser((int) $user['id'], ['email' => $email]);
        $this->Aegis_model->audit->emit('USER_UPDATED', 'User changed their email address', ['userId' => (int) $user['id']], (string) $user['id']);
        $this->reestablishIdentity((int) $user['id']);
        $this->flash('notice', 'Your email address has been updated.');
        redirect('/account');
    }

    /** Dashboard → My Account → Security: change the password (their own only). */
    public function change_password()
    {
        $user = $this->requireLogin();
        if (!$this->validAuthCsrf()) { $this->flash('error', 'Your session expired. Please try again.'); redirect('/account'); return; }
        $current = (string) $this->input->post('current_password');
        $password = (string) $this->input->post('new_password');
        $confirm = (string) $this->input->post('new_password_confirm');
        $stored = $this->Aegis_model->identity->findUserById((int) $user['id']);
        if (!$stored || !password_verify($current, $stored['password_hash'])) {
            $this->flash('error', 'Your current password is not correct.');
            redirect('/account#security'); return;
        }
        if (strlen($password) < 12) { $this->flash('error', 'Your new password must be at least 12 characters.'); redirect('/account#security'); return; }
        if ($password !== $confirm) { $this->flash('error', 'The two new passwords do not match.'); redirect('/account#security'); return; }
        $this->Aegis_model->identity->updateUser((int) $user['id'], ['password_hash' => password_hash($password, PASSWORD_DEFAULT)]);
        $this->Aegis_model->audit->emit('PASSWORD_CHANGED', 'User changed their password', ['userId' => (int) $user['id']], (string) $user['id']);
        // Regenerate the session and CSRF token after a password change.
        $this->reestablishIdentity((int) $user['id']);
        $this->flash('notice', 'Your password has been changed.');
        redirect('/account#security');
    }

    /** Dashboard → My Account → Profile: upload / replace the profile image. */
    public function upload_avatar()
    {
        $user = $this->requireLogin();
        if (!$this->validAuthCsrf()) { $this->flash('error', 'Your session expired. Please try again.'); redirect('/account'); return; }
        if (empty($_FILES['avatar']) || ($err = (int) ($_FILES['avatar']['error'] ?? UPLOAD_ERR_NO_FILE)) !== UPLOAD_ERR_OK) {
            $this->flash('error', $err === UPLOAD_ERR_NO_FILE ? 'Choose an image to upload.' : 'The upload failed. Please try again.');
            redirect('/account#profile'); return;
        }
        $tmp = (string) $_FILES['avatar']['tmp_name'];
        $size = (int) $_FILES['avatar']['size'];
        $maxBytes = 2 * 1024 * 1024;
        if ($size <= 0 || $size > $maxBytes) { $this->flash('error', 'Profile image must be 2 MB or smaller.'); redirect('/account#profile'); return; }
        // Verify it really is an image (content-based) and read its real type.
        $info = @getimagesize($tmp);
        if ($info === false) { $this->flash('error', 'That file is not a valid image.'); redirect('/account#profile'); return; }
        $allowed = [IMAGETYPE_PNG => 'png', IMAGETYPE_JPEG => 'jpg', IMAGETYPE_GIF => 'gif', IMAGETYPE_WEBP => 'webp'];
        $ext = $allowed[$info[2]] ?? null;
        if ($ext === null) { $this->flash('error', 'Only PNG, JPEG, GIF or WebP images are allowed.'); redirect('/account#profile'); return; }
        $uploadDir = FCPATH . 'assets/uploads/avatars';
        if (!is_dir($uploadDir)) @mkdir($uploadDir, 0775, true);
        if (!is_dir($uploadDir) || !is_writable($uploadDir)) { $this->flash('error', 'Profile storage is not available. Contact an administrator.'); redirect('/account#profile'); return; }
        $filename = 'u' . (int) $user['id'] . '_' . bin2hex(random_bytes(8)) . '.' . $ext;
        if (!@move_uploaded_file($tmp, $uploadDir . '/' . $filename)) { $this->flash('error', 'Could not save the image.'); redirect('/account#profile'); return; }
        $path = '/assets/uploads/avatars/' . $filename;
        // Remove the previous uploaded avatar (never the user's own session image elsewhere).
        $previous = (string) ($user['profile_image'] ?? '');
        $this->Aegis_model->identity->updateUser((int) $user['id'], ['profile_image' => $path]);
        if ($previous !== '' && str_starts_with($previous, '/assets/uploads/avatars/')) {
            $old = FCPATH . ltrim($previous, '/');
            if ($old !== $uploadDir . '/' . $filename && is_file($old)) @unlink($old);
        }
        $this->reestablishIdentity((int) $user['id']);
        $this->flash('notice', 'Your profile image has been updated.');
        redirect('/account#profile');
    }

    /** Dashboard → My Account → Profile: remove the profile image (reset to default). */
    public function remove_avatar()
    {
        $user = $this->requireLogin();
        if (!$this->validAuthCsrf()) { $this->flash('error', 'Your session expired. Please try again.'); redirect('/account'); return; }
        $previous = (string) ($user['profile_image'] ?? '');
        $this->Aegis_model->identity->updateUser((int) $user['id'], ['profile_image' => null]);
        if ($previous !== '' && str_starts_with($previous, '/assets/uploads/avatars/')) {
            $old = FCPATH . ltrim($previous, '/');
            if (is_file($old)) @unlink($old);
        }
        $this->reestablishIdentity((int) $user['id']);
        $this->flash('notice', 'Your profile image has been removed.');
        redirect('/account#profile');
    }

    /** Reload the signed-in user from the DB and refresh the session identity. */
    private function reestablishIdentity(int $userId): void
    {
        $fresh = $this->Aegis_model->identity->findUserById($userId);
        if (!$fresh) return;
        $fresh['permissions'] = $this->Aegis_model->identity->permissionsForUser($userId);
        unset($fresh['password_hash']);
        $this->session->sess_regenerate(true);
        $this->session->set_userdata(['identity' => $fresh, 'csrf_token' => bin2hex(random_bytes(32))]);
    }

    /** Username policy: 3–20 chars, letters/numbers/underscore, must start with a letter. */
    private function validUsername(string $username): bool
    {
        return (bool) preg_match('/^[a-z][a-z0-9_]{2,19}$/', $username);
    }

    private function establishSession(array $user): void
    {
        $this->session->sess_regenerate(true);
        $this->session->set_userdata(['identity' => $user, 'csrf_token' => bin2hex(random_bytes(32)), 'login_attempts' => 0, 'login_locked_until' => 0]);
    }

    private function renderAuth(bool $admin): void
    {
        $this->load->view('auth/login', [
            'title' => $admin ? 'Administrator sign in' : 'User sign in',
            'admin' => $admin,
            'error' => $this->consumeFlash('error'),
            'notice' => $this->consumeFlash('notice'),
            'csrfToken' => $this->ensureVisitorCsrf(),
        ]);
    }

    /** CSRF for signed-out visitors: mint one for the session on first render. */
    private function ensureVisitorCsrf(): string
    {
        $token = (string) $this->session->userdata('csrf_token');
        if ($token === '') {
            $token = bin2hex(random_bytes(32));
            $this->session->set_userdata('csrf_token', $token);
        }
        return $token;
    }

    /** Verify the csrf_token posted by an auth form against the session. */
    private function validAuthCsrf(): bool
    {
        $token = (string) $this->input->post('csrf_token');
        $known = (string) $this->session->userdata('csrf_token');
        return $token !== '' && $known !== '' && hash_equals($known, $token);
    }

    private function renderPage(string $title, string $active, array $data = []): void
    {
        $state = $this->platform->state();
        $data = array_merge($data, [
            'title' => $title, 'active' => $active,
            'status' => ['tradingMode' => $state['tradingMode'], 'killSwitch' => $state['killSwitch'], 'providers' => $this->platform->providers->getAllHealth()],
            'notice' => $this->consumeFlash('notice'), 'error' => $this->consumeFlash('error'),
        ]);
        $this->load->view('layout/header', $data); $this->load->view('auth/account', $data); $this->load->view('layout/footer');
    }

    private function sessionUser(): ?array { return $this->currentUser(); }
    private function redirectLogin(bool $admin): void { redirect($admin ? '/admin/login' : '/login'); }
    private function flash(string $key, string $value): void { $this->session->set_flashdata($key, $value); }
    private function consumeFlash(string $key): ?string { $value = $this->session->flashdata($key); return is_string($value) && $value !== '' ? $value : null; }
}
