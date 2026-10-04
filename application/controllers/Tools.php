<?php
defined('BASEPATH') or exit('No direct script access allowed');

/**
 * CLI utilities: database install + test runner.
 *   php index.php tools install
 *   php index.php tools tests
 */
class Tools extends MY_Controller
{
    public function __construct()
    {
        parent::__construct();
        if (!is_cli() && getenv('AEGIS_ALLOW_HTTP_TOOLS') !== '1') {
            show_404();
        }
    }

    public function index()
    {
        echo "AEGIS tools:\n  php index.php tools install           — (re)install schemas and seed RBAC defaults\n  php index.php tools bootstrap_admin   — create initial super-admin from environment variables\n  php index.php tools tests             — run the full test suite\n  php index.php tools cron              — scheduled operations: portfolio risk scan, broker transitions, proposal expiry\n  php index.php tools sports-cron [job] — sports scheduled jobs (fixtures|odds|results|quality|ticket|settlement|performance|monitoring|cleanup)\n  php index.php tools lottery-cron [job] — lottery scheduled jobs (sync|health|statistics|systems|tickets|backtests|cleanup)\n";
    }

    public function install()
    {
        $this->load->helper('file');
        $driver = $this->db->platform(); // mysql / sqlite
        $schemaFile = APPPATH . 'database/schema.' . ($driver === 'sqlite' ? 'sqlite' : 'mysql') . '.sql';
        if (!is_file($schemaFile)) {
            fwrite(STDERR, "schema not found: {$schemaFile}\n");
            exit(1);
        }
        $variant = $driver === 'sqlite' ? 'sqlite' : 'mysql';
        $schemaFiles = [$schemaFile, APPPATH . 'database/sports_identity.' . $variant . '.sql', APPPATH . 'database/sports.' . $variant . '.sql', APPPATH . 'database/sports_decisions.' . $variant . '.sql', APPPATH . 'database/sports_results.' . $variant . '.sql', APPPATH . 'database/sports_intelligence.' . $variant . '.sql', APPPATH . 'database/lottery.' . $variant . '.sql'];
        foreach ($schemaFiles as $file) {
            if (!is_file($file)) continue;
            $sql = file_get_contents($file);
            // Strip whole-line SQL comments before splitting: otherwise a leading
            // comment can cause the first CREATE TABLE statement to be skipped.
            $sql = preg_replace('/^\s*--[^\r\n]*[\r\n]?/m', '', $sql);
            $statements = array_filter(array_map('trim', preg_split('/;\s*[\r\n]+/', $sql)));
            foreach ($statements as $stmt) {
                if ($stmt === '') continue;
                $this->db->query($stmt);
            }
        }
        // Spec §30: index upgrades for pre-existing sports tables (idempotent;
        // CI query() returns false on duplicate-index errors — ignore safely).
        require_once FCPATH . 'tools/sports_indexes.php';
        foreach ([
            ['idx_sports_odds_provider', 'sports_odds', 'provider_id, observed_at'],
            ['idx_sports_matches_provider_kickoff', 'sports_matches', 'provider_id, kickoff_at'],
            ['idx_sports_predictions_market', 'sports_predictions', 'market, created_at'],
            ['idx_sports_selections_market', 'sports_ticket_selections', 'market, selection'],
            ['idx_sports_selections_match', 'sports_ticket_selections', 'match_id'],
            ['idx_sports_predictions_created', 'sports_predictions', 'created_at'],
            ['idx_sports_health_provider', 'sports_provider_health', 'provider_id, observed_at'],
        ] as [$name, $table, $cols]) {
            $this->db->query($variant === 'sqlite'
                ? "CREATE INDEX IF NOT EXISTS {$name} ON {$table} ({$cols})"
                : "CREATE INDEX {$name} ON {$table} ({$cols})");
        }
        $this->seedAccessControls();
        echo 'OK — schemas installed and RBAC defaults seeded on driver "' . $driver . "\".\n";
    }

    /** CLI only: creates the initial super-admin from environment values. */
    public function bootstrap_admin()
    {
        $email = strtolower(trim((string) getenv('AEGIS_BOOTSTRAP_ADMIN_EMAIL')));
        $password = (string) getenv('AEGIS_BOOTSTRAP_ADMIN_PASSWORD');
        $name = trim((string) (getenv('AEGIS_BOOTSTRAP_ADMIN_NAME') ?: 'Platform Administrator'));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($password) < 14) {
            fwrite(STDERR, "Set AEGIS_BOOTSTRAP_ADMIN_EMAIL and a 14+ character AEGIS_BOOTSTRAP_ADMIN_PASSWORD.\n"); return;
        }
        $this->seedAccessControls();
        $user = $this->Aegis_model->identity->findUserByEmail($email);
        if ($user) { echo "Admin already exists; no change made.\n"; return; }
        $now = gmdate('c');
        $user = $this->Aegis_model->identity->createUser(['email' => $email, 'password_hash' => password_hash($password, PASSWORD_DEFAULT), 'display_name' => $name, 'active' => 1, 'created_at' => $now, 'updated_at' => $now, 'last_login_at' => null]);
        $role = $this->Aegis_model->identity->ensureRole('super_admin', 'Super administrator');
        $this->Aegis_model->identity->assignRole((int) $user['id'], $role);
        $this->Aegis_model->audit->emit('ADMIN_BOOTSTRAPPED', 'Initial super administrator created', ['userId' => $user['id']], 'system');
        echo "Admin created. Remove bootstrap environment variables now.\n";
    }

    private function seedAccessControls(): void
    {
        require_once __DIR__ . '/../../tools/rbac.php';
        $identity = $this->Aegis_model->identity;
        aegis_seed_rbac(
            fn(string $code, string $name): int => $identity->ensureRole($code, $name),
            fn(string $code, string $name): int => $identity->ensurePermission($code, $name),
            fn(int $roleId, int $permissionId): bool => (bool) $identity->grantRolePermission($roleId, $permissionId)
        );
    }

    /**
     * Scheduled operations worker — safe to run every minute from cron:
     *   * * * * * php /path/to/index.php tools cron >> /var/log/aegis-cron.log 2>&1
     * Portfolio risk scan (with broker READY/DOWN transition detection and
     * operator notifications) plus stale-proposal expiry (spec §5).
     */
    public function cron()
    {
        $scan = $this->platform->monitor->scan();
        $expired = $this->platform->execution->expireStaleProposals();
        $summary = [
            'ranAt' => gmdate('c'),
            'accountsScanned' => $scan['accountsScanned'] ?? 0,
            'riskAlerts' => count($scan['alerts'] ?? []),
            'proposalsExpired' => count($expired),
            'expiredIds' => $expired,
        ];
        $this->Aegis_model->audit->emit('CRON_RUN', sprintf(
            'Scheduled operations: %d account(s) scanned, %d risk alert(s) active, %d proposal(s) expired',
            $summary['accountsScanned'], $summary['riskAlerts'], $summary['proposalsExpired']
        ), $summary, 'system');
        echo json_encode($summary, JSON_UNESCAPED_SLASHES), "\n";
    }

    /**
     * Sports Intelligence scheduled jobs (spec §31) — idempotent, safe to run
     * from cron every 15 minutes (use the standard "every 15 minutes" cron
     * expression) e.g.: php /path/to/index.php tools sports-cron
     * Individual jobs: fixtures | odds | results | quality | ticket |
     *                  settlement | performance | monitoring | cleanup
     */
    public function sports_cron()
    {
        $job = trim((string) ($_SERVER['argv'][3] ?? ''));
        $service = new \Aegis\Sports\SportsCronService($this->Aegis_model->sports, $this->Aegis_model->audit, $this->platform->sports);
        if ($job !== '') {
            if (!in_array($job, \Aegis\Sports\SportsCronService::JOBS, true)) {
                fwrite(STDERR, 'unknown job. Valid: ' . implode(', ', \Aegis\Sports\SportsCronService::JOBS) . "\n");
                exit(1);
            }
            $summary = $service->run($job);
        } else {
            $summary = $service->runAll();
        }
        echo json_encode($summary, JSON_UNESCAPED_SLASHES), "\n";
    }

    /**
     * WINDELS Lottery Intelligence scheduled jobs (spec §40).
     * php /path/to/index.php tools lottery-cron [job]
     * Individual jobs: sync | health | statistics | cleanup
     */
    public function lottery_cron()
    {
        $job = trim((string) ($_SERVER['argv'][3] ?? ''));
        $service = new \Aegis\Lottery\LotteryCronService($this->Aegis_model->lottery, $this->Aegis_model->audit, $this->platform->lottery);
        if ($job !== '') {
            if (!in_array($job, \Aegis\Lottery\LotteryCronService::JOBS, true)) {
                fwrite(STDERR, 'unknown job. Valid: ' . implode(', ', \Aegis\Lottery\LotteryCronService::JOBS) . "\n");
                exit(1);
            }
            $summary = $service->run($job);
        } else {
            $summary = $service->runAll();
        }
        echo json_encode($summary, JSON_UNESCAPED_SLASHES), "\n";
    }

    public function tests()
    {
        require_once TESTSPATH . 'framework.php';
        $suites = glob(TESTSPATH . 'cases/*.php') ?: [];
        sort($suites);
        foreach ($suites as $file) {
            require_once $file;
        }
        $failures = run_all_tests();
        // Sentinel instead of exit(): the WASM runtime loses buffered output
        // when PHP exits non-zero; callers parse TESTS-RESULT for the code.
        while (ob_get_level() > 0) {
            @ob_end_flush();
        }
        echo "TESTS-RESULT: {$failures}\n";
        if (PHP_SAPI === 'cli' && !defined('AEGIS_NO_EXIT')) {
            exit($failures > 0 ? 1 : 0);
        }
    }

}
