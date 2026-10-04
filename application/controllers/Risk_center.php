<?php
defined('BASEPATH') or exit('No direct script access allowed');
require_once APPPATH . 'core/App_Controller.php';

/**
 * Phase 5 — Risk Center: limits, continuous portfolio risk monitoring and the
 * audit trail.
 */
class Risk_center extends App_Controller
{
    public function index()
    {
        $data = $this->base('Risk Center');
        $data['limits'] = $this->platform->risk->getLimits();
        $data['lastReport'] = $this->platform->monitor->lastReport();
        $data['events'] = array_slice($this->platform->model->audit->recent(60), 0, 25);
        $this->load->view('layout/header', $data);
        $this->load->view('risk/index', $data);
        $this->load->view('layout/footer');
    }

    /** Run a portfolio risk scan now (transition-audited). */
    public function scan()
    {
        try {
            $report = $this->platform->monitor->scan();
            $count = count($report['alerts']);
            $this->flash('notice', $count === 0
                ? 'Portfolio scan clean — no risk alerts.'
                : "Portfolio scan: {$count} active alert(s) — see the monitor panel.");
        } catch (Throwable $e) {
            $this->flash('error', 'Scan failed: ' . $e->getMessage());
        }
        redirect('/risk');
    }

    public function limits()
    {
        $post = $this->input->post();
        $percent = ['riskPerTradePct', 'maxRiskPerTradePct', 'maxDailyLossPct', 'maxWeeklyLossPct', 'maxDrawdownPct', 'maxSymbolExposurePct', 'maxPortfolioExposurePct'];
        $patch = [];
        foreach ($post as $key => $value) {
            if ($key === 'maxTradeNotional' || $key === 'maxPositionNotionalUsd') continue;
            if (!is_numeric($value) || (float) $value <= 0) continue;
            $patch[$key] = in_array($key, $percent, true) ? (float) $value / 100 : (float) $value;
        }
        if (!$patch) {
            $this->flash('error', 'No valid limit fields supplied.');
        } else {
            $this->platform->updateRiskLimits($patch);
            $this->flash('notice', 'Risk limits updated.');
        }
        redirect('/risk');
    }

    private function base(string $title): array
    {
        $state = $this->platform->state();
        return [
            'title' => $title, 'active' => 'risk',
            'status' => ['tradingMode' => $state['tradingMode'], 'killSwitch' => $state['killSwitch'],
                'providers' => $this->platform->providers->getAllHealth()],
            'notice' => $this->flashGet('notice'), 'error' => $this->flashGet('error'),
        ];
    }

    private function flash(string $key, string $msg): void
    {
        $this->session->set_flashdata($key, $msg);
    }

    private function flashGet(string $key): ?string
    {
        $msg = $this->session->flashdata($key);
        return is_string($msg) && $msg !== '' ? $msg : null;
    }
}
