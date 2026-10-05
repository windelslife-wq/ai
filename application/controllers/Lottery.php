<?php
defined('BASEPATH') or exit('No direct script access allowed');
require_once APPPATH . 'core/App_Controller.php';

/**
 * WINDELS Lottery Operations console. Read access is gated by lottery.view;
 * provider probes and draw synchronization are exposed only to lottery.manage
 * through CSRF-protected JSON API actions.
 */
class Lottery extends App_Controller
{
    public function index()
    {
        if (!$this->platform->identity->can($this->identity, 'lottery.view')) {
            redirect('/access-denied');
            return;
        }

        $state = $this->platform->state();
        try {
            $providerHealth = $this->platform->lottery->providerHealth();
        } catch (Throwable $e) {
            $providerHealth = [
                'provider' => 'unknown',
                'live' => [
                    'state' => 'ERROR',
                    'licensed' => false,
                    'synthetic' => false,
                    'message' => 'Live provider health could not be read. Use an administrator probe and inspect server logs.',
                ],
                'latest' => null,
                'history' => [],
            ];
        }

        $lottery = $this->platform->lottery;
        $rules = $lottery->rules;
        $draws = $lottery->listDraws(1);
        $data = [
            'title' => 'Lottery Operations',
            'active' => 'lottery',
            'csrfToken' => (string) ($this->session->userdata('csrf_token') ?: ''),
            'canManage' => $this->platform->identity->can($this->identity, 'lottery.manage'),
            'status' => [
                'tradingMode' => $state['tradingMode'],
                'killSwitch' => $state['killSwitch'],
                'providers' => $this->platform->providers->getAllHealth(),
            ],
            'lotteryStatus' => [
                'activeLottery' => $rules->code(),
                'engine' => (($providerHealth['live']['state'] ?? '') === 'ONLINE')
                    ? \Aegis\Lottery\LotteryIntelligence::ENGINE_ACTIVE
                    : \Aegis\Lottery\LotteryIntelligence::ENGINE_DISABLED,
                'drawsTracked' => $lottery->drawCount(),
                'lastDraw' => $draws[0] ?? null,
                'modelVersion' => \Aegis\Lottery\LotteryIntelligence::MODEL_VERSION,
                'rules' => [
                    'version' => $rules->version(),
                    'main' => ['count' => $rules->mainCount(), 'min' => $rules->mainMin(), 'max' => $rules->mainMax()],
                    'stars' => ['count' => $rules->starCount(), 'min' => $rules->starMin(), 'max' => $rules->starMax()],
                    'schedule' => $rules->drawSchedule(),
                ],
                'disclaimer' => \Aegis\Lottery\LotteryStatisticsEngine::DISCLAIMER,
            ],
            'providerHealth' => $providerHealth,
            'providers' => $this->platform->model->lottery->listProviders(),
            'decisions' => $lottery->listDecisions(null, 12),
            'error' => null,
            'notice' => null,
        ];

        $this->load->view('layout/header', $data);
        $this->load->view('lottery/index', $data);
        $this->load->view('layout/footer');
    }
}
