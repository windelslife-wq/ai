<?php
defined('BASEPATH') or exit('No direct script access allowed');

/**
 * WINDELS Lottery Intelligence JSON API (spec §38/§43).
 *
 * Authorization follows the existing WINDELS RBAC (tools/rbac.php):
 *   - status                          public (no secrets, no PII)
 *   - read endpoints (draws, statistics, providers, jobs,
 *     analyze, combinations)          lottery.view
 *   - generate / diversity (mutations) lottery.view + session CSRF
 *   - provider sync (ingestion)       lottery.manage  (+ session CSRF)
 *
 * Honesty rules: every endpoint returns stored, source-attributed data with
 * the engine's DISCLAIMER; no endpoint claims knowledge of future draws
 * (spec §41). Generator scores are STATISTICAL BALANCE SCORES and diversity
 * scores — never probabilities (spec §16/§17/§22).
 */
class Api_lottery extends Api_controller
{
    // ---------------------------------------------------------------- public
    public function status()
    {
        $this->json($this->platform->lottery->status());
    }

    // ------------------------------------------------------------- read-only
    public function lotteries()
    {
        if (!$this->requirePermission('lottery.view', false)) return;
        $this->json(['lotteries' => $this->platform->lottery->status()['lotteries']]);
    }

    public function rules()
    {
        if (!$this->requirePermission('lottery.view', false)) return;
        $this->json(['rules' => $this->platform->lottery->status()['rules']]);
    }

    public function draws()
    {
        if (!$this->requirePermission('lottery.view', false)) return;
        $g = $this->input->get(NULL, true) ?: [];
        $this->json(['draws' => $this->platform->lottery->listDraws((int) ($g['limit'] ?: 50), $g['from'] ?? null, $g['to'] ?? null)]);
    }

    public function show_draw(string $id)
    {
        if (!$this->requirePermission('lottery.view', false)) return;
        $draw = $this->platform->lottery->drawDetail((int) $id);
        if (!$draw) return $this->jsonError('draw not found', 404);
        $this->json(['draw' => $draw]);
    }

    /**
     * Statistical intelligence (spec §8–§14). All outputs are historical
     * observations carrying the engine DISCLAIMER — never forecasts of
     * future draws.
     * Kinds: numbers | stars | hot-cold | distribution | pairs | triplets | star-pairs
     */
    public function statistics(string $kind)
    {
        if (!$this->requirePermission('lottery.view', false)) return;
        $window = (int) ($this->input->get('window') ?: 0);
        try {
            $this->json(['kind' => $kind, 'window' => $window, 'data' => $this->platform->lottery->statistics($kind, $window)]);
        } catch (\InvalidArgumentException $e) {
            $this->jsonError($e->getMessage(), 400);
        }
    }

    public function providers()
    {
        if (!$this->requirePermission('lottery.view', false)) return;
        $this->json(['providers' => $this->Aegis_model->lottery->listProviders()]);
    }

    public function health()
    {
        if (!$this->requirePermission('lottery.view', false)) return;
        $this->json($this->platform->lottery->providerHealth());
    }

    public function jobs()
    {
        if (!$this->requirePermission('lottery.view', false)) return;
        $g = $this->input->get(NULL, true) ?: [];
        $this->json(['jobs' => $this->Aegis_model->lottery->listJobRuns(!empty($g['jobType']) ? (string) $g['jobType'] : null, (int) ($g['limit'] ?: 50))]);
    }

    /**
     * Phase 13 (spec §13): full statistical profile of one line.
     * GET ?mains=1,2,3,4,5&stars=2,5  — historical observation only.
     */
    public function analyze()
    {
        if (!$this->requirePermission('lottery.view', false)) return;
        $g = $this->input->get(NULL, true) ?: [];
        $mains = array_map('intval', array_values(array_filter(explode(',', (string) ($g['mains'] ?? '')), fn($x) => $x !== '')));
        $stars = array_map('intval', array_values(array_filter(explode(',', (string) ($g['stars'] ?? '')), fn($x) => $x !== '')));
        try {
            $this->json($this->platform->lottery->analyzeLine($mains, $stars));
        } catch (\InvalidArgumentException $e) {
            $this->jsonError($e->getMessage(), 400);
        }
    }

    /** Persisted generations (spec §14/§16/§33), newest first. */
    public function combinations()
    {
        if (!$this->requirePermission('lottery.view', false)) return;
        $g = $this->input->get(NULL, true) ?: [];
        $this->json(['combinations' => $this->platform->lottery->listCombinations((int) ($g['limit'] ?: 50), (int) ($g['offset'] ?: 0))]);
    }

    public function show_combination(string $id)
    {
        if (!$this->requirePermission('lottery.view', false)) return;
        $row = $this->platform->lottery->combinationDetail((int) $id);
        if (!$row) return $this->jsonError('combination not found', 404);
        $this->json(['combination' => $row]);
    }

    // ------------------------------------------------------------- mutation

    /**
     * Phase 14 (spec §14–§17, §21, §26): AI combination generator.
     * POST {mode: RANDOM|BALANCED|HISTORICAL|DIVERSIFIED|ANTI-POPULAR,
     *       count, seed?, locks: {mains, stars}, excludes: {mains, stars},
     *       contextLines?}
     * Returns the AI combination report + decision report and persists both
     * (lottery_combinations + lottery_ai_decisions, audited).
     */
    public function generate()
    {
        $user = $this->requirePermission('lottery.view');
        if (!$user) return;
        $body = $this->jsonBody();
        try {
            $report = $this->platform->lottery->generate([
                'mode' => (string) ($body['mode'] ?? 'RANDOM'),
                'count' => (int) ($body['count'] ?? 1),
                'seed' => isset($body['seed']) && $body['seed'] !== null ? (int) $body['seed'] : null,
                'locks' => is_array($body['locks'] ?? null) ? $body['locks'] : [],
                'excludes' => is_array($body['excludes'] ?? null) ? $body['excludes'] : [],
                'contextLines' => is_array($body['contextLines'] ?? null) ? $body['contextLines'] : [],
            ]);
            $saved = $this->platform->lottery->saveGeneration($report, (string) $user['id']);
            $this->json(array_merge($report, ['saved' => $saved]));
        } catch (\InvalidArgumentException $e) {
            $this->jsonError($e->getMessage(), 400);
        }
    }

    /**
     * Phase 15 (spec §22): diversification score for a set of lines.
     * POST {lines: [{mains: [..], stars: [..]}, ...]}
     */
    public function diversity()
    {
        if (!$this->requirePermission('lottery.view')) return;
        $body = $this->jsonBody();
        try {
            $this->json($this->platform->lottery->diversity(is_array($body['lines'] ?? null) ? $body['lines'] : []));
        } catch (\InvalidArgumentException $e) {
            $this->jsonError($e->getMessage(), 400);
        }
    }

    /**
     * Phase 16 (spec §18/§19): system builder — a pool of mains + stars →
     * every valid combination. Line counts are computed as C(N,5) x C(S,2),
     * never hardcoded. Lines are paginated (lazy enumeration); systems above
     * the synchronous limit must use POST api/lottery/system-build.
     * POST {mains: [pool], stars: [pool], page?: 0, limit?: 50}
     */
    public function system()
    {
        if (!$this->requirePermission('lottery.view')) return;
        $body = $this->jsonBody();
        try {
            $builder = $this->platform->lottery->systemBuilder;
            $plan = $builder->plan(
                is_array($body['mains'] ?? null) ? $body['mains'] : [],
                is_array($body['stars'] ?? null) ? $body['stars'] : []
            );
            if ($plan['requiresBackground']) {
                return $this->jsonError('system has ' . $plan['totalLines'] . ' lines — above the synchronous limit (' . \Aegis\Lottery\SystemBuilder::SYNC_LINE_LIMIT . '); use POST api/lottery/system-build for a background build', 409);
            }
            $page = max(0, (int) ($body['page'] ?? 0));
            $limit = min(\Aegis\Lottery\SystemBuilder::MAX_PAGE, max(1, (int) ($body['limit'] ?: 50)));
            $this->json([
                'plan' => $plan,
                'page' => $page,
                'limit' => $limit,
                'lines' => $builder->page($plan['mainPool'], $plan['starPool'], $page * $limit, $limit),
            ]);
        } catch (\InvalidArgumentException $e) {
            $this->jsonError($e->getMessage(), 400);
        }
    }

    /**
     * Phase 16 background system build (spec §18): idempotent per pool
     * (execution key). Small systems build inline; large ones are queued
     * for `php index.php tools lottery-cron systems`.
     */
    public function system_build()
    {
        $user = $this->requirePermission('lottery.manage');
        if (!$user) return;
        $body = $this->jsonBody();
        try {
            $this->json($this->platform->lottery->buildSystem([
                'mains' => is_array($body['mains'] ?? null) ? $body['mains'] : [],
                'stars' => is_array($body['stars'] ?? null) ? $body['stars'] : [],
            ], (string) $user['id']));
        } catch (\InvalidArgumentException $e) {
            $this->jsonError($e->getMessage(), 400);
        }
    }

    // ------------------------------------------------ saved tickets (user-scoped, spec §38)

    /**
     * Phase 17 (spec §20): create the caller's own ticket. Every line is
     * validated before anything is stored.
     * POST {name, lines: [{mains, stars}], generationMethod?, drawDate?,
     *       modelVersion?, configuration?}
     */
    public function create_ticket()
    {
        $user = $this->requirePermission('lottery.view');
        if (!$user) return;
        $body = $this->jsonBody();
        try {
            $ticket = $this->platform->lottery->createTicket(
                (int) $user['id'],
                (string) ($body['name'] ?? ''),
                is_array($body['lines'] ?? null) ? $body['lines'] : [],
                (string) ($body['generationMethod'] ?? 'MANUAL'),
                isset($body['drawDate']) && $body['drawDate'] !== null ? (string) $body['drawDate'] : null,
                isset($body['modelVersion']) && $body['modelVersion'] !== null ? (string) $body['modelVersion'] : null,
                is_array($body['configuration'] ?? null) ? $body['configuration'] : []
            );
            $this->json(['ticket' => $ticket, 'lines' => $this->Aegis_model->lottery->ticketLines((int) $ticket['id'])]);
        } catch (\InvalidArgumentException $e) {
            $this->jsonError($e->getMessage(), 400);
        }
    }

    /** Phase 17: the caller's own tickets (never other users' — spec §38). */
    public function tickets()
    {
        $user = $this->requirePermission('lottery.view', false);
        if (!$user) return;
        $this->json(['tickets' => $this->platform->lottery->listMyTickets((int) $user['id'])]);
    }

    /** Phase 17: ticket detail — own tickets, or admin (lottery.manage) view. */
    public function show_ticket(string $id)
    {
        $user = $this->requirePermission('lottery.view', false);
        if (!$user) return;
        $admin = $this->platform->identity->can($user, 'lottery.manage');
        $ticket = $this->platform->lottery->ticketDetail((int) $id, $admin ? null : (int) $user['id']);
        if (!$ticket) return $this->jsonError('ticket not found', 404);
        $this->json(['ticket' => $ticket]);
    }

    /** Phase 18 (spec §29): compare the ticket against stored draws. */
    public function check_ticket(string $id)
    {
        $user = $this->requirePermission('lottery.view');
        if (!$user) return;
        $result = $this->platform->lottery->checkTicket((int) $id, (int) $user['id'], (string) $user['id']);
        if ($result === null) return $this->jsonError('ticket not found', 404);
        if (($result['status'] ?? '') === 'NO_DRAW') return $this->jsonError('no stored draw to compare yet (sync the provider first)', 409);
        $this->json($result);
    }

    /** Phase 17: archive (soft delete) the caller's own ticket. */
    public function delete_ticket(string $id)
    {
        $user = $this->requirePermission('lottery.view');
        if (!$user) return;
        if (!$this->platform->lottery->archiveTicket((int) $id, (int) $user['id'], (string) $user['id'])) {
            return $this->jsonError('ticket not found', 404);
        }
        $this->json(['archived' => (int) $id]);
    }

    // ------------------------------------------------------- backtesting (20-25)

    /**
     * Phase 20 (spec §23): HISTORICAL SIMULATION — replay one strategy over
     * the stored draws without look-ahead. Report is persisted + audited.
     * POST {strategy: RANDOM_BASELINE|BALANCED_PROFILE|HISTORICAL_FREQ|ANTI_POPULAR,
     *       lines?: 1-10, window?: 0-100}
     */
    public function backtest()
    {
        if (!$this->requirePermission('lottery.view')) return;
        $body = $this->jsonBody();
        try {
            $this->json($this->platform->lottery->backtest(
                (string) ($body['strategy'] ?? 'RANDOM_BASELINE'),
                (int) ($body['lines'] ?: 1),
                (int) ($body['window'] ?: 0)
            ));
        } catch (\InvalidArgumentException $e) {
            $this->jsonError($e->getMessage(), 400);
        }
    }

    /**
     * Phase 22 (spec §24): strategy comparison on the SAME period. The random
     * baseline must be part of every comparison (spec §25); no strategy is
     * declared "better" (spec §34).
     * POST {strategies: [..must include RANDOM_BASELINE..], lines?: 1-10, window?: 0-100}
     */
    public function backtest_compare()
    {
        if (!$this->requirePermission('lottery.view')) return;
        $body = $this->jsonBody();
        try {
            $strategies = is_array($body['strategies'] ?? null) ? array_map('strval', $body['strategies']) : [];
            $this->json($this->platform->lottery->backtestCompare(
                $strategies,
                (int) ($body['lines'] ?: 1),
                (int) ($body['window'] ?: 0)
            ));
        } catch (\InvalidArgumentException $e) {
            $this->jsonError($e->getMessage(), 400);
        }
    }

    /** Phase 20: persisted backtests, newest first. GET ?limit=50 */
    public function backtests()
    {
        if (!$this->requirePermission('lottery.view', false)) return;
        $g = $this->input->get(NULL, true) ?: [];
        $this->json(['backtests' => $this->platform->lottery->listBacktests((int) ($g['limit'] ?: 50))]);
    }

    public function show_backtest(string $id)
    {
        if (!$this->requirePermission('lottery.view', false)) return;
        $row = $this->platform->lottery->backtestDetail((int) $id);
        if (!$row) return $this->jsonError('backtest not found', 404);
        $this->json(['backtest' => $row]);
    }

    /** Phase 23 (spec §33): model versions — never deleted or replaced. */
    public function models()
    {
        if (!$this->requirePermission('lottery.view', false)) return;
        $this->json(['models' => $this->platform->lottery->modelVersions()]);
    }

    /** Phase 25 (spec §30): performance overview — sections never mixed. */
    public function performance()
    {
        if (!$this->requirePermission('lottery.view', false)) return;
        $this->json($this->platform->lottery->performance());
    }

    /** Synchronize draws from the configured provider (idempotent, audited). */
    public function sync()
    {
        if (!$this->requirePermission('lottery.manage')) return;
        $limit = (int) ($this->jsonBody()['limit'] ?: 100);
        $this->json(['result' => $this->platform->lottery->sync(min(1000, max(1, $limit)))]);
    }
}
