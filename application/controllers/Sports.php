<?php
defined('BASEPATH') or exit('No direct script access allowed');
require_once APPPATH . 'core/App_Controller.php';

/**
 * Sports Intelligence console (integration plan step 6 — dashboards,
 * responsive UI).
 *
 * Traditional MVC pages that render the same stored data the permissioned
 * JSON API exposes (no data fabrication in either path). Read pages are open
 * like the rest of the console; mutation actions enforce the sports RBAC
 * matrix (sports.approve / sports.settle) from the signed-in identity — the
 * same permission checks the API enforces, and the ticket stays audited with
 * the acting user.
 */
class Sports extends App_Controller
{
    public function index()
    {
        $data = $this->base('Sports Intelligence', 'sports');
        $data['dashboard'] = $this->platform->sports->dashboard();
        $this->render('sports/index', $data);
    }

    public function tickets()
    {
        $data = $this->base('Sports Tickets', 'sports');
        $data['tickets'] = $this->platform->model->sports->listTickets([], 100);
        $data['dailyRuns'] = $this->platform->model->sports->listDailyTickets(30);
        $data['performance'] = $this->platform->sports->performanceReport([]);
        $this->render('sports/tickets', $data);
    }

    /** Approve / reject a PENDING_USER_APPROVAL ticket (sports.approve). */
    public function decide(string $id)
    {
        if (!$this->requireSportsPermission('sports.approve', 'approve/reject')) return;
        if ($this->killSwitchActive()) {
            $this->flash('error', 'Refused: platform kill switch is ACTIVE — release it before approving sports tickets (settlement remains available).');
            redirect('/sports/tickets');
            return;
        }
        $approve = $this->input->post('approve') === '1';
        $reason = trim((string) $this->input->post('reason'));
        try {
            $this->platform->sports->governance->decide($id, $approve, $this->actor(), $reason);
            $this->flash('notice', 'Ticket ' . ($approve ? 'approved' : 'rejected') . ' and audited — no external execution exists in this deployment.');
        } catch (Throwable $e) {
            $this->flash('error', $e->getMessage());
        }
        redirect('/sports/tickets');
    }

    /** Settle a ticket from stored verified results (sports.settle). */
    public function settle(string $id)
    {
        if (!$this->requireSportsPermission('sports.settle', 'settle')) return;
        try {
            $out = $this->platform->sports->settlement->settlePending($id);
            $this->flash('notice', sprintf('Ticket settlement: %s (effective odds %s, P/L %s)',
                $out['status'] ?? 'PENDING', $out['effectiveOdds'] ?? 'n/a', $out['pnl'] ?? 'n/a'));
        } catch (Throwable $e) {
            $this->flash('error', $e->getMessage());
        }
        redirect('/sports/tickets');
    }

    /**
     * Enforce the sports RBAC matrix + production guards for console
     * mutations (PRG flow). Plan step 6 (production review): form POSTs
     * self-guard with the session CSRF token issued at sign-in — the same
     * token the JSON API verifies as the X-CSRF-Token header, since
     * platform-wide csrf_protection is off and privileged endpoints guard
     * themselves.
     */
    private function requireSportsPermission(string $permission, string $action): bool
    {
        $user = $this->session->userdata('identity');
        if (!is_array($user) || !$this->platform->identity->can($user, $permission)) {
            $this->flash('error', "Refused: signed-in identity lacks '{$permission}' — the {$action} action was not performed.");
            redirect('/sports');
            return false;
        }
        $sent = (string) $this->input->post('csrf_token');
        $known = $this->session->userdata('csrf_token');
        if ($sent === '' || !is_string($known) || $known === '' || !hash_equals($known, $sent)) {
            $this->flash('error', "Refused: missing or invalid CSRF token — the {$action} action was not performed.");
            redirect('/sports');
            return false;
        }
        return true;
    }

    /** True while the platform kill switch is ACTIVE (it boots ACTIVE — fail closed). */
    private function killSwitchActive(): bool
    {
        $ks = $this->platform->state()['killSwitch'] ?? [];
        return !empty($ks['active']);
    }

    private function actor(): string
    {
        $user = $this->session->userdata('identity');
        return is_array($user) ? (string) $user['id'] : 'anonymous';
    }

    private function base(string $title, string $active): array
    {
        $state = $this->platform->state();
        return [
            'title' => $title, 'active' => $active,
            'csrfToken' => (string) $this->session->userdata('csrf_token'),
            'status' => ['tradingMode' => $state['tradingMode'], 'killSwitch' => $state['killSwitch'],
                'providers' => $this->platform->providers->getAllHealth()],
            'notice' => $this->flashGet('notice'), 'error' => $this->flashGet('error'),
        ];
    }

    private function render(string $view, array $data): void
    {
        $this->load->view('layout/header', $data);
        $this->load->view($view, $data);
        $this->load->view('layout/footer');
    }

    private function flash(string $key, string $msg): void
    {
        setcookie("flash_{$key}", rawurlencode($msg), time() + 30, '/');
    }

    private function flashGet(string $key): ?string
    {
        $v = $_COOKIE["flash_{$key}"] ?? null;
        if ($v !== null) setcookie("flash_{$key}", '', time() - 3600, '/');
        return $v !== null ? rawurldecode($v) : null;
    }
}
