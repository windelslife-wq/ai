<?php
defined('BASEPATH') or exit('No direct script access allowed');
require_once APPPATH . 'core/App_Controller.php';

/** Signed-in user home. Real counts only — empty modules stay empty. */
class Workspace extends App_Controller
{
    public function index()
    {
        $user = $this->identity;
        $state = $this->platform->state();
        $inbox = $this->platform->notifications->inbox((int) $user['id'], false, 8);
        $history = $this->platform->model->analysis->history(6);
        $accounts = $this->platform->model->paper->listAccounts();
        $profiles = [];
        try { $profiles = $this->platform->langlearn->profiles((int) $user['id']); } catch (Throwable $e) { $profiles = []; }
        $data = [
            'title' => 'Dashboard',
            'active' => 'home',
            'user' => $user,
            'admin' => $this->isAdmin($user),
            'status' => [
                'tradingMode' => $state['tradingMode'],
                'killSwitch' => $state['killSwitch'],
                'providers' => $this->platform->providers->getAllHealth(),
            ],
            'inbox' => $inbox,
            'history' => $history,
            'paperAccounts' => count($accounts),
            'languageProfiles' => count($profiles),
            'notice' => $this->session->flashdata('notice'),
            'error' => $this->session->flashdata('error'),
        ];
        $this->load->view('layout/header', $data);
        $this->load->view('workspace/index', $data);
        $this->load->view('layout/footer');
    }
}
