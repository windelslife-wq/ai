<?php
defined('BASEPATH') or exit('No direct script access allowed');
require_once APPPATH . 'core/App_Controller.php';

/**
 * Operator notifications console (server-rendered). Broadcast notifications
 * (user_id NULL) are visible to everyone; signed-in operators also see their
 * own targeted ones. Risk alerts, approval requests and execution outcomes
 * land here via the Notifier.
 */
class Notifications extends App_Controller
{
    public function index()
    {
        $data = $this->base('Notifications');
        $userId = $this->sessionUser();
        $data['inbox'] = $this->platform->notifications->inbox($userId, false, 60);
        $data['userId'] = $userId;
        $this->load->view('layout/header', $data);
        $this->load->view('notifications/index', $data);
        $this->load->view('layout/footer');
    }

    public function read(string $id)
    {
        $this->platform->notifications->markRead($id, $this->sessionUser());
        redirect('/notifications');
    }

    public function read_all()
    {
        $this->platform->notifications->markAllRead($this->sessionUser());
        redirect('/notifications');
    }

    private function sessionUser(): ?int
    {
        $user = $this->session->userdata('identity');
        return is_array($user) && !empty($user['id']) ? (int) $user['id'] : null;
    }

    private function base(string $title): array
    {
        $state = $this->platform->state();
        return [
            'title' => $title, 'active' => 'notifications',
            'status' => ['tradingMode' => $state['tradingMode'], 'killSwitch' => $state['killSwitch'],
                'providers' => $this->platform->providers->getAllHealth()],
            'notice' => null, 'error' => null,
        ];
    }
}
