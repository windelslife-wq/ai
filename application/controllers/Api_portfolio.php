<?php
defined('BASEPATH') or exit('No direct script access allowed');

/** Portfolio analysis endpoints. No endpoint in this controller routes orders. */
class Api_portfolio extends Api_controller
{
    /**
     * POST /api/portfolio/optimize
     * Body: {assets:[{symbol,marketClass}], timeframe?, limit?, objective?, ...}
     */
    public function optimize()
    {
        $user = $this->requirePermission('trading.view');
        if (!$user) return;

        try {
            $actorId = isset($user['id']) ? (string) $user['id'] : 'unknown';
            $report = $this->platform->optimizePortfolio($this->jsonBody(), 'user:' . $actorId);
            $this->json(['optimization' => $report]);
        } catch (\InvalidArgumentException $e) {
            $this->jsonError($e->getMessage(), 400);
        } catch (\RuntimeException $e) {
            $this->jsonError($e->getMessage(), 422);
        } catch (\Throwable $e) {
            log_message('error', 'Portfolio optimization failed: ' . $e->getMessage());
            $this->jsonError('portfolio optimization failed', 500);
        }
    }
}
