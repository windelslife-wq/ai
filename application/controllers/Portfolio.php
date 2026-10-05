<?php
defined('BASEPATH') or exit('No direct script access allowed');
require_once APPPATH . 'core/App_Controller.php';

/** Research-only portfolio optimization console; it never places orders. */
class Portfolio extends App_Controller
{
    public function index()
    {
        $state = $this->platform->state();
        $data = [
            'title' => 'Portfolio Optimizer',
            'active' => 'portfolio',
            'status' => [
                'tradingMode' => $state['tradingMode'],
                'killSwitch' => $state['killSwitch'],
                'providers' => $this->platform->providers->getAllHealth(),
            ],
            'canOptimize' => $this->platform->identity->can($this->identity, 'trading.view'),
            'csrfToken' => (string) ($this->session->userdata('csrf_token') ?: ''),
        ];
        $this->load->view('layout/header', $data);
        $this->load->view('portfolio/optimizer', $data);
        $this->load->view('layout/footer');
    }
}
