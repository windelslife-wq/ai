<?php
defined('BASEPATH') or exit('No direct script access allowed');

/**
 * System / governance API: status, features matrix, events, risk limits,
 * kill switch, trading mode.
 */
class Api_system extends Api_controller
{
    public const FEATURES = [
        // market data
        ['name' => 'Market-data abstraction (health/retry/timeout/breaker/cache/fallback)', 'category' => 'market-data', 'status' => 'TESTED', 'detail' => 'Provider interface with full provenance; synthetic never silent'],
        ['name' => 'Binance market data (crypto)', 'category' => 'market-data', 'status' => 'IMPLEMENTED', 'detail' => 'Real public REST klines/quotes; reports DOWN and falls back when host has no egress'],
        ['name' => 'Frankfurter/ECB (forex daily)', 'category' => 'market-data', 'status' => 'IMPLEMENTED', 'detail' => 'Real ECB daily reference rates; serves 1d only'],
        ['name' => 'Synthetic demo provider', 'category' => 'market-data', 'status' => 'TESTED', 'detail' => 'Deterministic generator, always labeled SIMULATION'],
        ['name' => 'Stock/ETF/futures/options data providers', 'category' => 'market-data', 'status' => 'PLANNED', 'detail' => 'Provider-neutral licensed-feed adapters are scaffolded and registered; production remains PLANNED until a licensed source, schema and symbol allow-list are verified'],
        // agents
        ['name' => 'Technical Analysis Agent', 'category' => 'agent', 'status' => 'TESTED', 'detail' => 'Full indicator suite ported with fixture tests'],
        ['name' => 'Market Structure Agent', 'category' => 'agent', 'status' => 'TESTED', 'detail' => 'Swings, close-confirmed BOS/CHoCH, zones, order blocks, FVGs'],
        ['name' => 'Forex / Crypto / Sentiment agents', 'category' => 'agent', 'status' => 'TESTED', 'detail' => 'Honest unavailability for macro/on-chain/sentiment data'],
        ['name' => 'Fundamentals Intelligence Agent', 'category' => 'agent', 'status' => 'IMPLEMENTED', 'detail' => 'Phase 6 boundary: explicit abstention until an attributable licensed fundamentals feed is configured'],
        ['name' => 'Sentiment feed boundary (news/social)', 'category' => 'agent', 'status' => 'IMPLEMENTED', 'detail' => 'Phase 6 boundary: SentimentFeed contract with provenance + freshness validation (per-observation source, timestamp, license, 1h staleness floor); votes only on licensed attributable fresh data, abstains otherwise — no live news/social provider is claimed'],
        ['name' => 'Trading Intelligence consensus', 'category' => 'agent', 'status' => 'TESTED', 'detail' => 'Confluence, confidence, conflicts, NO_TRADE gates'],
        // engines
        ['name' => 'Trading Intelligence Engine + Risk Engine', 'category' => 'engine', 'status' => 'TESTED', 'detail' => 'Full pipeline with independent risk veto and kill-switch participation'],
        ['name' => 'Strategy Engine + lifecycle', 'category' => 'engine', 'status' => 'TESTED', 'detail' => '4 built-ins, evidence-gated lifecycle through PAPER_TRADING (Phase 3)'],
        ['name' => 'Backtesting Engine', 'category' => 'engine', 'status' => 'TESTED', 'detail' => 'Next-bar-open fills, cost model, pessimistic stop rule, look-ahead guard'],
        ['name' => 'Paper Trading Engine', 'category' => 'engine', 'status' => 'TESTED', 'detail' => 'Phase 3: simulated accounts/orders/fills with full governance chain, strategy deployments, journaling'],
        ['name' => 'Trade Execution Supervisor (15-step pipeline)', 'category' => 'engine', 'status' => 'TESTED', 'detail' => 'Kill switch → mode → strategy → broker → session → freshness → duplicates → symbol permissions → margin → risk engine → automation limits → approval → route → confirm → audit → portfolio update; durable auditable proposals'],
        ['name' => 'Portfolio Risk Monitor', 'category' => 'engine', 'status' => 'TESTED', 'detail' => 'Continuous scan: HIGH_EXPOSURE, EXCESSIVE_LEVERAGE, CORRELATED_POSITIONS (static disclosed groups), MAX_DRAWDOWN_WARNING, DAILY_LOSS_WARNING, BROKER_DISCONNECTED — transition-audited'],
        ['name' => 'Strategy live-approval gate', 'category' => 'engine', 'status' => 'TESTED', 'detail' => 'APPROVED requires the PAPER_TRADING stage plus ≥10 closed paper trades with PF>1 and positive expectancy'],
        ['name' => 'Operator RBAC on the trading API', 'category' => 'module', 'status' => 'TESTED', 'detail' => 'trading.view / trading.control / trading.execute permissions (seeded via tools/rbac.php) + CSRF on mutating endpoints; decisions record the deciding operator'],
        ['name' => 'Operator notifications', 'category' => 'module', 'status' => 'TESTED', 'detail' => 'Risk transitions, approval requests, execution outcomes, broker disconnects, kill switch — unread-deduped, console + /api/notifications'],
        ['name' => 'Scheduled operations worker (cron)', 'category' => 'module', 'status' => 'TESTED', 'detail' => 'php index.php tools cron — portfolio scan, broker READY/DOWN transitions, proposal expiry (spec §5), CRON_RUN audit summary'],
        ['name' => 'Multi-agent debate (Phase 6)', 'category' => 'agent', 'status' => 'TESTED', 'detail' => 'Deterministic adversarial review: bull/bear advocates cite evidence, skeptic + risk-critic objections (conflicts, regime contradiction, staleness, conviction, setup quality). Verdict can only REDUCE a bias — never inflate; transcript is auditable'],
        ['name' => 'Strategy optimizer (Phase 6)', 'category' => 'engine', 'status' => 'TESTED', 'detail' => 'Parameter grid search with walk-forward verification (in-sample 70% / out-of-sample 30%). Adopts ONLY candidates that survive out-of-sample and beat the baseline there; registered variants are source ai (DRAFT, human sign-off required)'],
        ['name' => 'AI Language Learning — Phase 1', 'category' => 'module', 'status' => 'TESTED', 'detail' => 'Registry-driven 20-language catalog (expandable), per-user multi-language profiles with isolated progress, ADAPTIVE level assessment (levels computed only from real answers, capped at each language\'s verified bank ceiling), CEFR learning paths with real module checkpoints, activity-derived progress (streak, path %). Listening/speaking/writing honestly not assessed in this build'],
        ['name' => 'AI Language Learning — Phase 2 (AI Teacher)', 'category' => 'module', 'status' => 'TESTED', 'detail' => 'Lessons (teach→examples→practice→grade, module completion), structured conversation drills with correction preferences (immediate/after/important/conversation-only, assisted advance after two misses), guided writing with real element checks (original text always preserved), grammar rules + simpler explanations, full lesson history'],
        ['name' => 'AI Language Learning — Phase 3 (Vocabulary)', 'category' => 'module', 'status' => 'TESTED', 'detail' => '10-word authored bank per language (word/translation/pronunciation where confidently known/example where genuine), spaced repetition 1→3→7→14→30→90 days with lapse resets, deterministic MCQ quizzes (same options at start and submit), self-assessed flashcards, due-today queue, vocabulary progress from real reviews only'],
        ['name' => 'AI Language Learning — Phase 4 (Listening + Speaking)', 'category' => 'module', 'status' => 'TESTED', 'detail' => 'Listening exercises from the real reading bank (browser speech-synthesis playback, slow/normal/replay/transcript; comprehension + transcription scoring). Speaking practice with browser speech-to-text where the user\'s browser exposes it; word accuracy from the REAL transcript; pronunciation/fluency scores never invented (no provider)'],
        ['name' => 'AI Language Learning — Phase 5 (Adaptive)', 'category' => 'module', 'status' => 'TESTED', 'detail' => 'Weakness detection from stored attempts (per-skill averages, vocabulary lapses, repeated item misses, failed modules — every finding cites evidence; honest empty state), personalized daily plans budgeted to profile minutes with completion tracked from real same-day activity, evidence-cited recommendations, item-level mastery tracking'],
        ['name' => 'Kill switch', 'category' => 'engine', 'status' => 'TESTED', 'detail' => 'Ships ACTIVE in DB state; blocks all order placement (paper included)'],
        ['name' => 'Lottery Intelligence — EuroMillions foundation', 'category' => 'module', 'status' => 'IMPLEMENTED', 'detail' => 'WINDELS native module: provider-neutral LotteryProvider contract, EuroMillions rule engine (5/1-50 + 2/1-12, DB-updatable), source-attributed validated draws (DATA_VALIDATION_FAILED + audit, idempotent imports, verified results never silently overwritten), frequency/gap/hot-cold/distribution/pair statistics with the independence disclaimer on every output, RBAC (lottery.view/lottery.manage), lottery-cron idempotent jobs. Honest DISABLED_NO_PROVIDER until a provider is configured — no prediction of future draws is claimed anywhere'],
        ['name' => 'Lottery Combination Intelligence (analyzer, generator, diversification)', 'category' => 'module', 'status' => 'IMPLEMENTED', 'detail' => 'Per-line statistical profile vs stored draws (odd/even, low/high, sum & spread percentiles, consecutive patterns, per-number and star history, historical similarity, pattern traits) with a labelled STATISTICAL BALANCE SCORE — never a probability. Five generation modes (RANDOM, BALANCED, HISTORICAL, DIVERSIFIED, ANTI-POPULAR) with lock/exclude support, seeded reproducibility and a full AI decision report (model version, actual inputs, factors, method). Diversification engine scores number/pair/triplet/star overlap and distribution similarity for 10/20/50+ lines (DIVERSITY SCORE, not a likelihood). Combinations and AI decisions persist (lottery_combinations, lottery_ai_decisions) and are audited; results stay connected to the model version that produced them'],
        ['name' => 'Lottery System Builder (C(N,5) combinatorics)', 'category' => 'module', 'status' => 'IMPLEMENTED', 'detail' => 'Main/star pool to every valid combination: line count computed as C(N,5) x C(S,2) (never hardcoded), 100% pool coverage report, honest cost handling (official pricing unavailable — cost stays null, never fabricated), lazy paginated enumeration with a 10,000-line synchronous limit and idempotent background builds (execution-key queue processed by lottery-cron systems)'],
        ['name' => 'Lottery Ticket Builder + Saved Tickets', 'category' => 'module', 'status' => 'IMPLEMENTED', 'detail' => 'User-scoped named tickets (multiple lines, every line validated before saving, lines normalized), generation-method + model-version + configuration stamping, check against stored VERIFIED draws (per-line main/star matches + official EuroMillions prize tiers — amounts never stored), automatic post-draw checking (lottery-cron tickets, idempotent), archive/soft-delete; users can only access their own tickets unless they hold lottery.manage (spec §38); actual ticket outcomes stay separate from backtests and demo data (spec §30)'],
        ['name' => 'Lottery Backtesting + Model Versioning + Performance (Strategy Lab)', 'category' => 'module', 'status' => 'IMPLEMENTED', 'detail' => 'Four deterministic strategies (RANDOM_BASELINE, BALANCED_PROFILE, HISTORICAL_FREQ, ANTI_POPULAR) replayed over stored draws without look-ahead: main/star match distributions, official prize-tier counts (amounts never stored), best line, per-draw detail. Reports are labelled HISTORICAL SIMULATION; simulated cost/winnings stay null while official figures are unavailable (never fabricated). The random baseline is mandatory in every comparison (spec §25) and no strategy is declared "better" (spec §24/§34). Model versioning: WINDELS Lottery Model v1.0 row with full statistical config — versions are never deleted or replaced, historical results stay connected to their model (spec §33). Performance overview keeps ACTUAL TICKET RESULTS, HISTORICAL BACKTEST RESULTS and DEMO/SANDBOX DATA in separate sections that are never mixed (spec §30). Daily per-strategy backtests run via lottery-cron backtests (execution-key idempotent); every run persisted + audited'],
        ['name' => 'Lottery data providers (official feeds)', 'category' => 'module', 'status' => 'PLANNED', 'detail' => 'Authorized-feed HTTP adapter is scaffolded with license/source metadata, normalized draws and health checks; production remains PLANNED until an authorized source is verified'],
        // platform
        ['name' => 'MySQL / MariaDB persistence', 'category' => 'module', 'status' => 'IMPLEMENTED', 'detail' => 'Canonical schema + mysqli config (application/database/schema.mysql.sql); the offline sandbox verifies the identical app+SQL through pdo_sqlite'],
        ['name' => 'SQLite dev driver', 'category' => 'module', 'status' => 'TESTED', 'detail' => 'Same CI3 app on pdo_sqlite for offline demo/tests (AEGIS_DB_DRIVER=pdo_sqlite)'],
        ['name' => 'CodeIgniter 3.1.13 MVC', 'category' => 'module', 'status' => 'TESTED', 'detail' => 'Traditional server-rendered MVC + JSON API layer'],
        ['name' => 'ANALYSIS_ONLY mode', 'category' => 'mode', 'status' => 'TESTED', 'detail' => 'Default'],
        ['name' => 'PAPER_TRADING mode', 'category' => 'mode', 'status' => 'TESTED', 'detail' => 'Phase 3 — simulated execution with real prices when reachable'],
        ['name' => 'HUMAN_APPROVAL mode', 'category' => 'mode', 'status' => 'TESTED', 'detail' => 'Pipeline passes persist a proposal that a human must approve before routing'],
        ['name' => 'SEMI_AUTONOMOUS mode', 'category' => 'mode', 'status' => 'TESTED', 'detail' => 'Auto-routes inside the automation envelope: max notional, max daily trades, max risk %, approved symbols only'],
        ['name' => 'FULLY_AUTOMATED mode', 'category' => 'mode', 'status' => 'TESTED', 'detail' => 'Same envelope plus: APPROVED strategy mandatory, order-capable READY connector, kill switch released, explicit limits configured'],
        // brokers
        ['name' => 'MT5 bridge connector (account/quote/candles/positions/orders/history + place/modify/cancel/close)', 'category' => 'broker', 'status' => 'TESTED', 'detail' => 'Full Phase 4 surface against the documented bridge contract, unit-tested with a simulated bridge; order submission needs AEGIS_MT5_TRADING_ENABLED=1 AND bridge-side tradingEnabled AND a demo account unless AEGIS_MT5_LIVE_ALLOWED=1 — NOT yet verified against a real MetaTrader terminal'],
        ['name' => 'Python MT5 bridge service', 'category' => 'broker', 'status' => 'IMPLEMENTED', 'detail' => 'python-services/mt5-bridge (FastAPI + MetaTrader5): full contract unit-tested against a simulated terminal; requires deployment on a Windows MT5 host with a demo account before real use'],
        ['name' => 'Broker order routing', 'category' => 'broker', 'status' => 'TESTED', 'detail' => 'Supervisor-owned, connector-verified routing with durable proposals/executions, confirm + audit + post-trade portfolio snapshot; tested against a simulated bridge only'],
        ['name' => 'Simulated MT5 bridge (offline demo)', 'category' => 'broker', 'status' => 'TESTED', 'detail' => 'Broker Center toggle starts an in-process mock that speaks the documented bridge contract (loopback, demo account, health reports simulated:true). Lets the offline demo run propose→approve→route→fill end-to-end. NEVER a real broker; production ignores the marker entirely'],
        ['name' => 'MT4 / crypto exchange / stock broker connectors', 'category' => 'broker', 'status' => 'PLANNED', 'detail' => 'Disabled-by-default connector adapters are scaffolded for MT4, Binance, Bybit, OKX, Coinbase, Kraken, Interactive Brokers, Alpaca and OANDA; each remains PLANNED until its provider contract is verified'],
    ];

    public function status()
    {
        $state = $this->platform->state();
        $this->json([
            'platform' => 'AEGIS Trading Intelligence (CodeIgniter 3 / PHP MVC edition)',
            'phase' => 5,
            'version' => '0.5.0',
            'stack' => 'CodeIgniter ' . CI_VERSION . ' / PHP ' . PHP_VERSION . ' / ' . $this->db->platform(),
            'tradingMode' => $state['tradingMode'],
            'implementedTradingModes' => ['ANALYSIS_ONLY', 'PAPER_TRADING', 'HUMAN_APPROVAL', 'SEMI_AUTONOMOUS', 'FULLY_AUTOMATED'],
            'supportedTradingModes' => ['ANALYSIS_ONLY', 'PAPER_TRADING', 'HUMAN_APPROVAL', 'SEMI_AUTONOMOUS', 'FULLY_AUTOMATED'],
            'killSwitch' => $state['killSwitch'],
            'providers' => $this->platform->providers->getAllHealth(),
            'brokers' => $this->platform->brokers->allStatus(),
        ]);
    }

    public function features()
    {
        $this->json(self::FEATURES);
    }

    /** Connector health only; this endpoint cannot trigger broker actions. */
    public function brokers()
    {
        $this->json(['brokers' => $this->platform->brokers->allStatus()]);
    }

    /** Read-only MT5 account view. It can never submit or modify an order. */
    public function mt5_account()
    {
        $connector = $this->platform->brokers->get('mt5-bridge');
        if (!$connector instanceof \Aegis\Brokers\Mt5BridgeConnector) return $this->jsonError('MT5 connector unavailable', 503);
        try {
            $this->json(['account' => $connector->account()]);
        } catch (\Throwable $e) {
            $this->jsonError($e->getMessage(), 503);
        }
    }

    /** Read-only MT5 quote view. */
    public function mt5_quote()
    {
        $symbol = (string) $this->input->get('symbol', true);
        $connector = $this->platform->brokers->get('mt5-bridge');
        if (!$connector instanceof \Aegis\Brokers\Mt5BridgeConnector) return $this->jsonError('MT5 connector unavailable', 503);
        try {
            $this->json(['quote' => $connector->quote($symbol)]);
        } catch (\InvalidArgumentException $e) {
            $this->jsonError($e->getMessage());
        } catch (\Throwable $e) {
            $this->jsonError($e->getMessage(), 503);
        }
    }

    public function events(int $limit = 100)
    {
        $this->json(['events' => $this->platform->model->audit->recent(min($limit, 500))]);
    }

    public function risk_limits()
    {
        $this->json(['limits' => $this->platform->risk->getLimits()]);
    }

    public function update_risk_limits()
    {
        if (!$this->requirePermission('trading.control')) return;
        $body = $this->jsonBody();
        $allowed = ['riskPerTradePct', 'maxRiskPerTradePct', 'minRiskReward', 'maxPositionNotionalUsd', 'maxLeverage',
            'maxOpenPositions', 'maxDailyLossPct', 'maxWeeklyLossPct', 'maxDrawdownPct', 'maxSymbolExposurePct',
            'maxPortfolioExposurePct', 'minDataQuality', 'blockSyntheticData', 'blockStaleData'];
        $patch = array_intersect_key($body, array_flip($allowed));
        if (!$patch) return $this->jsonError('no valid limit fields supplied');
        $this->json(['limits' => $this->platform->updateRiskLimits($patch)]);
    }

    public function kill_switch()
    {
        if (!$this->requirePermission('trading.control')) return;
        $body = $this->jsonBody();
        if (!isset($body['active']) || !is_bool($body['active'])) {
            return $this->jsonError('body must be {active: boolean, reason?: string}');
        }
        $ks = $this->platform->setKillSwitch($body['active'], $body['reason'] ?? null);
        $this->json(['killSwitch' => $ks]);
    }

    public function synthetic_paper()
    {
        if (!$this->requirePermission('trading.control')) return;
        $body = $this->jsonBody();
        if (!isset($body['allow']) || !is_bool($body['allow'])) {
            return $this->jsonError('body must be {allow: boolean}');
        }
        $state = $this->platform->state();
        $state['allowSyntheticPaperData'] = $body['allow'];
        $this->platform->model->state->save($state);
        $this->platform->model->audit->emit('RISK_LIMITS_UPDATED',
            'Paper-trading synthetic prices ' . ($body['allow'] ? 'ALLOWED (dev)' : 'BLOCKED'),
            ['allow' => $body['allow']], 'user');
        $this->json(['allowSyntheticPaperData' => $body['allow']]);
    }

    /**
     * Phase 5 pipeline (steps 1–11) as a dry run: nothing is persisted and
     * no order can be routed from this endpoint.
     */
    public function execution_preflight()
    {
        try { $this->json($this->platform->execution->evaluate($this->jsonBody(), false)); }
        catch (\Throwable $e) { $this->jsonError($e->getMessage(), 400); }
    }

    /** All proposals (optionally ?status=PENDING_APPROVAL), newest first. */
    public function execution_approvals()
    {
        if (!$this->requirePermission('trading.view', false)) return;
        $status = $this->input->get('status', true) ?: null;
        $this->json(['proposals' => $this->platform->execution->proposals($status)]);
    }

    /** POST /api/trading/propose — run the pipeline and persist the proposal. */
    public function execution_propose()
    {
        $user = $this->requirePermission('trading.execute');
        if (!$user) return;
        try { $this->json(['proposal' => $this->platform->execution->propose($this->jsonBody(), $user['email'] ?? 'user')]); }
        catch (\Throwable $e) { $this->jsonError($e->getMessage(), 400); }
    }

    /** POST /api/trading/execute — SEMI_AUTONOMOUS / FULLY_AUTOMATED entry. */
    public function execution_execute()
    {
        $user = $this->requirePermission('trading.execute');
        if (!$user) return;
        try { $this->json($this->platform->execution->executeAutomated($this->jsonBody())); }
        catch (\Throwable $e) { $this->jsonError($e->getMessage(), 400); }
    }

    public function execution_decide(string $id)
    {
        $user = $this->requirePermission('trading.execute');
        if (!$user) return;
        $body = $this->jsonBody();
        if (!isset($body['approve']) || !is_bool($body['approve'])) return $this->jsonError('body must include approve: boolean');
        try { $this->json(['proposal' => $this->platform->execution->decide($id, $body['approve'], $user['email'] ?? 'user', $body['reason'] ?? null)]); }
        catch (\InvalidArgumentException $e) { $this->jsonError($e->getMessage(), 404); }
        catch (\Throwable $e) { $this->jsonError($e->getMessage(), 409); }
    }

    /**
     * Steps 12–15 (route an APPROVED/READY_TO_ROUTE proposal). Routing only
     * proceeds through a connector with verified order submission — otherwise
     * it is audited as ROUTING_BLOCKED and no order exists.
     */
    public function execution_route(string $id)
    {
        $user = $this->requirePermission('trading.execute');
        if (!$user) return;
        try { $this->json($this->platform->execution->route($id, $user['email'] ?? 'user')); }
        catch (\InvalidArgumentException $e) { $this->jsonError($e->getMessage(), 404); }
        catch (\Throwable $e) { $this->jsonError($e->getMessage(), 409); }
    }

    public function execution_recent()
    {
        if (!$this->requirePermission('trading.view', false)) return;
        $this->json(['executions' => $this->platform->execution->executions()]);
    }

    // ------------------------------------------------------- notifications

    /** Operator inbox: broadcast (user_id NULL) + the signed-in operator's own. */
    public function notifications()
    {
        $user = $this->requirePermission('system.authenticated', false);
        if (!$user) return;
        $unreadOnly = $this->input->get('unread') === '1';
        $this->json($this->platform->notifications->inbox((int) $user['id'], $unreadOnly, 50));
    }

    public function notification_read(string $id)
    {
        $user = $this->requirePermission('system.authenticated');
        if (!$user) return;
        $ok = $this->platform->notifications->markRead($id, (int) $user['id']);
        $ok ? $this->json(['ok' => true]) : $this->jsonError('notification not found or already read', 404);
    }

    public function notification_read_all()
    {
        $user = $this->requirePermission('system.authenticated');
        if (!$user) return;
        $this->json(['markedRead' => $this->platform->notifications->markAllRead((int) $user['id'])]);
    }

    /** Automation envelope for SEMI_AUTONOMOUS / FULLY_AUTOMATED modes. */
    public function automation_limits()
    {
        $this->json(['limits' => \Aegis\ExecutionSupervisor::automationLimits($this->platform->state())]);
    }

    public function update_automation_limits()
    {
        if (!$this->requirePermission('trading.control')) return;
        try { $this->json(['limits' => $this->platform->updateAutomationLimits($this->jsonBody())]); }
        catch (\InvalidArgumentException $e) { $this->jsonError($e->getMessage()); }
        catch (\Throwable $e) { $this->jsonError($e->getMessage(), 409); }
    }

    /** Continuous portfolio risk monitoring (spec §14). */
    public function portfolio_scan()
    {
        if (!$this->requirePermission('trading.view', false)) return;
        $this->json($this->platform->monitor->scan());
    }

    public function trading_mode()
    {
        if (!$this->requirePermission('trading.control')) return;
        $body = $this->jsonBody();
        $mode = $body['mode'] ?? '';
        $result = $this->platform->setTradingMode($mode);
        if (!$result['ok']) return $this->jsonError($result['message'], 409);
        $this->json(['tradingMode' => $result['state']['tradingMode'], 'message' => $result['message']]);
    }
}
