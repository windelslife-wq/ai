<?php
defined('BASEPATH') or exit('No direct script access allowed');
require_once APPPATH . 'core/App_Controller.php';

/** Administrator control center: users, roles and platform status. */
class Admin extends App_Controller
{
    public function index()
    {
        $user = $this->requireAdmin(); if (!$user) return;
        $data = $this->base('Admin Control Center', 'admin');
        $data['users'] = $this->Aegis_model->identity->listUsers();
        if (!class_exists('Api_system')) require_once APPPATH . 'controllers/Api_system.php';
        $data['features'] = \Api_system::FEATURES;
        $data['counts'] = [
            'users' => count($data['users']),
            'strategies' => count($this->Aegis_model->strategies->all()),
            'languages' => count($this->platform->langlearn->languages()),
            'lotteryDraws' => $this->platform->lottery->drawCount(),
        ];
        $data['smtp'] = \Aegis\Mailer::configSummary();
        $data['smtpOk'] = $this->session->flashdata('smtpOk');
        $data['smtpError'] = $this->session->flashdata('smtpError');
        $this->render('admin/index', $data);
    }

    public function create_user()
    {
        $actor = $this->requireAdmin(); if (!$actor) return;
        if (!$this->validCsrf()) { $this->flash('error', 'Invalid security token.'); redirect('/admin'); return; }
        $email = strtolower(trim((string) $this->input->post('email')));
        $name = trim((string) $this->input->post('display_name'));
        $password = (string) $this->input->post('password');
        $roleCode = trim((string) $this->input->post('role'));
        $allowed = ['super_admin', 'sports_admin', 'sports_viewer', 'trading_operator', 'trading_viewer', 'lottery_admin', 'lottery_viewer', 'platform_member'];
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || $name === '' || strlen($name) > 120 || strlen($password) < 14 || !in_array($roleCode, $allowed, true)) {
            $this->flash('error', 'Enter a valid name, email, role and a password of at least 14 characters.'); redirect('/admin'); return;
        }
        if ($this->Aegis_model->identity->findUserByEmail($email)) { $this->flash('error', 'That email address already exists.'); redirect('/admin'); return; }
        $now = gmdate('c');
        $new = $this->Aegis_model->identity->createUser(['email' => $email, 'password_hash' => password_hash($password, PASSWORD_DEFAULT), 'display_name' => $name, 'active' => 1, 'created_at' => $now, 'updated_at' => $now, 'last_login_at' => null]);
        $role = $this->Aegis_model->identity->ensureRole($roleCode, ucwords(str_replace('_', ' ', $roleCode)));
        $this->Aegis_model->identity->assignRole((int) $new['id'], $role);
        $this->Aegis_model->audit->emit('ADMIN_USER_CREATED', 'Administrator created a user account', ['userId' => (int) $new['id'], 'role' => $roleCode], (string) $actor['id']);
        $this->flash('notice', 'User account created successfully.'); redirect('/admin');
    }

    public function toggle_user(int $id)
    {        $actor = $this->requireAdmin(); if (!$actor) return;
        if (!$this->validCsrf()) { $this->flash('error', 'Invalid security token.'); redirect('/admin'); return; }
        if ((int) $actor['id'] === $id) { $this->flash('error', 'You cannot deactivate your own administrator account.'); redirect('/admin'); return; }
        $target = $this->Aegis_model->identity->findUserById($id);
        if (!$target) { $this->flash('error', 'User not found.'); redirect('/admin'); return; }
        $active = empty($target['active']);
        $this->Aegis_model->identity->setActive($id, $active);
        $this->Aegis_model->audit->emit('ADMIN_USER_STATUS_CHANGED', 'Administrator changed user account status', ['userId' => $id, 'active' => $active], (string) $actor['id']);
        $this->flash('notice', 'User account ' . ($active ? 'activated.' : 'deactivated.')); redirect('/admin');
    }

    /**
     * Send a real test email through the configured SMTP provider and report
     * the actual result. Super-admin only, CSRF-guarded. Credentials are never
     * displayed — only a safe configuration summary and the send outcome.
     */
    public function test_email()
    {
        $actor = $this->requireAdmin(); if (!$actor) return;
        if (!$this->validCsrf()) { $this->flash('error', 'Invalid security token.'); redirect('/admin'); return; }
        $to = strtolower(trim((string) $this->input->post('to')));
        $variant = $this->input->post('variant') === 'plain' ? 'plain' : 'html';
        if (!filter_var($to, FILTER_VALIDATE_EMAIL)) {
            $this->flash('error', 'Enter a valid recipient email address.');
            redirect('/admin#smtp');
            return;
        }
        $res = \Aegis\Mailer::sendTest($this, $to, $variant);
        $this->Aegis_model->audit->emit('ADMIN_TEST_EMAIL', 'Administrator sent a test email', ['to' => $to, 'ok' => $res['ok']], (string) $actor['id']);
        $this->session->set_flashdata($res['ok'] ? 'smtpOk' : 'smtpError', $res['message']);
        redirect('/admin#smtp');
    }

    /** Only system.super_admin may enter the control centre. */
    private function requireAdmin(): ?array
    {
        return $this->requireAdminPage();
    }

    private function validCsrf(): bool
    {
        $sent = (string) $this->input->post('csrf_token'); $known = (string) $this->session->userdata('csrf_token');
        return $sent !== '' && $known !== '' && hash_equals($known, $sent);
    }

    private function base(string $title, string $active): array
    {
        $state = $this->platform->state();
        return ['title' => $title, 'active' => $active, 'status' => ['tradingMode' => $state['tradingMode'], 'killSwitch' => $state['killSwitch'], 'providers' => $this->platform->providers->getAllHealth()], 'csrfToken' => (string) $this->session->userdata('csrf_token'), 'notice' => $this->session->flashdata('notice'), 'error' => $this->session->flashdata('error')];
    }

    private function render(string $view, array $data): void { $this->load->view('layout/header', $data); $this->load->view($view, $data); $this->load->view('layout/footer'); }
    private function flash(string $key, string $msg): void { $this->session->set_flashdata($key, $msg); }
}
