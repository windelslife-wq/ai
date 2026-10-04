<?php
defined('BASEPATH') or exit('No direct script access allowed');
require_once APPPATH . 'core/App_Controller.php';

use Aegis\Journal\Analytics;

class Journal extends App_Controller
{
    public function index()
    {
        $groupBy = (string)($this->input->get('groupBy') ?: 'strategy');
        if (!in_array($groupBy, ['strategy', 'market', 'symbol', 'source', 'confidence'], true)) {
            $groupBy = 'strategy';
        }
        $entries = $this->platform->model->journal->list([], 200);
        $data = [
            'title' => 'Journal & Analytics', 'active' => 'journal',
            'status' => $this->statusView(),
            'entries' => $entries,
            'groupBy' => $groupBy,
            'summary' => Analytics::analyze($entries, $groupBy),
            'calibration' => Analytics::calibration($this->platform->model->journal->list([], 2000)),
        ];
        $this->load->view('layout/header', $data);
        $this->load->view('journal/index', $data);
        $this->load->view('layout/footer');
    }

    private function statusView(): array
    {
        $state = $this->platform->state();
        return ['tradingMode' => $state['tradingMode'], 'killSwitch' => $state['killSwitch'],
            'providers' => $this->platform->providers->getAllHealth()];
    }
}
