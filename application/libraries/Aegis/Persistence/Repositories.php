<?php
namespace Aegis\Persistence;

/**
 * Thin repository interfaces over CI3's database layer. The concrete
 * implementation (Aegis_model) speaks MySQL/MariaDB in production and
 * SQLite for the offline dev runtime — identical SQL subset either way.
 */
interface StrategyRepository
{
    /** @return array<string, mixed>|null */
    public function find(string $id, string $version): ?array;
    /** @return array<int, array<string, mixed>> */
    public function all(): array;
    public function save(array $record): void;
    public function countBacktests(string $strategyId, string $version): int;
    /** @return array<string, mixed>|null */
    public function latestBacktest(string $strategyId, string $version): ?array;
}

interface BacktestRepository
{
    public function save(array $record): void;
    /** @return array<string, mixed>|null */
    public function find(string $id): ?array;
    /** @return array<int, array<string, mixed>> */
    public function list(?string $strategyId = null, int $limit = 50): array;
}

interface JournalRepository
{
    public function save(array $entry): void;
    /** @return array<int, array<string, mixed>> */
    public function list(array $filter = [], int $limit = 200): array;
}

interface AuditRepository
{
    /** Emit an audit event (type, summary, detail array). */
    public function emit(string $type, string $summary, array $detail = [], string $actor = 'system'): void;
    /** @return array<int, array<string, mixed>> */
    public function recent(int $limit = 100): array;
}

interface AnalysisRepository
{
    public function save(array $run): void;
    /** @return array<int, array<string, mixed>> summaries, newest first */
    public function history(int $limit = 20): array;
    /** @return array<string, mixed>|null */
    public function find(string $id): ?array;
}

interface PlatformStateRepository
{
    /** @return array<string, mixed> {tradingMode, killSwitch: {active, activatedAt, reason}} */
    public function load(): array;
    public function save(array $state): void;
}

/** Identity and access-control persistence. Password hashes only; never raw secrets. */
interface SportsRepository
{
    public function ensureProvider(string $code, string $name): array;
    /** @return array<int,array<string,mixed>> */
    public function listProviders(bool $enabledOnly = false): array;
    public function setProviderEnabled(int $id, bool $enabled): void;
    /** @return array<int,array<string,mixed>> */
    public function listHealth(int $providerId, int $limit = 20): array;
    /** @return array<string,mixed>|null */
    public function latestHealth(int $providerId): ?array;

    /** @return array<string,mixed>|null */
    public function findMatchById(int $id): ?array;
    /** @return array<int,array<string,mixed>> */
    public function listMatches(array $filter = [], int $limit = 200): array;
    /** Latest odds row for a match (optionally pinned to market/selection). */
    /** @return array<string,mixed>|null */
    public function latestOdds(int $matchId, ?string $market = null, ?string $selection = null): ?array;
    /** @return array<int,array<string,mixed>> */
    public function listOdds(int $matchId, int $limit = 50): array;
    /** @return array<string,mixed>|null */
    public function latestQuality(int $matchId): ?array;

    public function saveCalibration(array $c): int;
    /** @return array<string,mixed>|null */
    public function findCalibration(int $id): ?array;
    /** @return array<int,array<string,mixed>> */
    public function listCalibrations(?int $modelVersionId = null, ?string $status = null, int $limit = 50): array;
    /** Latest APPROVED calibration for a model version, or null. */
    /** @return array<string,mixed>|null */
    public function activeCalibration(int $modelVersionId): ?array;
    public function updateCalibrationStatus(int $id, string $status, ?string $actor = null): void;
    /** @return array<int,array<string,mixed>> */
    public function listModelVersions(): array;
    /** @return array<string,mixed>|null */
    public function findModelVersion(int $id): ?array;

    /** @return array<int,array<string,mixed>> */
    public function listPredictions(array $filter = [], int $limit = 200): array;
    /** @return array<string,mixed>|null */
    public function findPrediction(string $id): ?array;
    /**
     * Predictions whose match has a verified finished result — calibration
     * training data. Each row carries raw/calibrated probability and the
     * binary outcome (0|1) for the predicted market/selection.
     * @return array<int,array<string,mixed>>
     */
    public function predictionOutcomes(?int $modelVersionId = null): array;

    /** @return array<string,mixed>|null */
    public function activeConfiguration(): ?array;
    /** @return array<int,array<string,mixed>> */
    public function listConfigurations(int $limit = 20): array;
    public function saveConfiguration(array $c): int;
    /** @return array<string,mixed>|null */
    public function findConfiguration(int $id): ?array;

    /** Latest stored result row for a match (any provider), or null. */
    /** @return array<string,mixed>|null */
    public function findResultByMatch(int $matchId): ?array;
    public function recordTicketOutcome(string $ticketId, float $pnl): void;
    /** Latest odds row observed BEFORE the given timestamp (point-in-time backtesting). */
    /** @return array<string,mixed>|null */
    public function oddsBefore(int $matchId, string $timestamp): ?array;
    public function deleteOldJobRuns(string $cutoff): void;
    public function deleteOldHealth(string $cutoff): void;

    /** Starts once per idempotency key, or returns null if already processed. */
    public function startJobRun(array $run): ?array;
    public function finishJobRun(string $id, array $result): void;
    /** @return array<int,array<string,mixed>> */
    public function listJobRuns(?string $jobType = null, int $limit = 50): array;

    public function saveBacktest(array $b): void;
    /** @return array<string,mixed>|null */
    public function findBacktest(string $id): ?array;
    /** @return array<int,array<string,mixed>> */
    public function listBacktests(int $limit = 20): array;

    public function saveModelMetrics(array $m): void;
    /** @return array<int,array<string,mixed>> */
    public function listModelMetrics(?int $modelVersionId = null, ?int $windowDays = null, ?string $sampleType = null, int $limit = 200): array;

    /** @return array<string,mixed>|null */
    public function findDailyTicket(string $date): ?array;
    public function saveDailyTicket(array $d): void;
    public function updateDailyTicket(string $date, array $patch): void;
    /** @return array<int,array<string,mixed>> */
    public function listDailyTickets(int $limit = 60): array;

    public function savePerformanceSnapshot(string $asOf, string $window, array $payload): void;
    /** @return array<int,array<string,mixed>> */
    public function performanceSnapshots(string $window, int $limit = 30): array;

    /** Settled selections joined with their match competition, for breakdowns. */
    /** @return array<int,array<string,mixed>> */
    public function settledSelections(array $filter = []): array;

    public function saveHealth(int $providerId, array $health): void;
    /** Returns saved canonical match, inserting/updating by provider + external ID. */
    public function saveMatch(int $providerId, array $match): array;
    public function findMatch(int $providerId, string $externalId): ?array;
    public function saveOdds(int $matchId, int $providerId, array $odds): void;
    public function saveResult(int $matchId, int $providerId, array $result): void;
    public function findResult(int $matchId, int $providerId): ?array;
    public function verifyResult(int $id): void;
    public function saveQuality(int $matchId, array $assessment): void;
    /** Starts once per idempotency key, or returns null if already processed. */
    public function startSync(array $run): ?array;
    public function finishSync(string $id, array $result): void;
    public function ensureModelVersion(array $model): int;
    public function savePrediction(array $prediction): void;
    public function saveTicket(array $ticket): void;
    public function saveTicketSelection(array $selection): void;
    /** @return array<int,array<string,mixed>> */
    public function ticketSelections(string $ticketId): array;
    public function updateTicketSelection(int $id, array $patch): void;
    public function findTicket(string $id): ?array;
    /** @return array<int,array<string,mixed>> */
    public function listTickets(array $filter = [], int $limit = 500): array;
    public function updateTicket(string $id, array $patch): void;
}

interface IdentityRepository
{
    public function findUserByEmail(string $email): ?array;
    public function findUserByUsername(string $username): ?array;
    public function findUserByUid(string $uid): ?array;
    public function findUserById(int $id): ?array;
    /** Resolve a login identifier that may be an email, a username or a six-digit User ID. */
    public function findUserByIdentifier(string $identifier): ?array;
    public function createUser(array $user): array;
    public function updateUser(int $id, array $patch): void;
    /** True when the username belongs to another account (optionally excluding one id). */
    public function usernameTaken(string $username, ?int $exceptId = null): bool;
    /** True when the email belongs to another account (optionally excluding one id). */
    public function emailTaken(string $email, ?int $exceptId = null): bool;
    /** Generate a unique, available username derived from a base (e.g. display name / email prefix). */
    public function generateUniqueUsername(string $base): string;
    /** Generate a unique six-digit numeric User ID (never exposing the DB primary key). */
    public function generateUniqueUid(): string;
    public function ensureRole(string $code, string $name): int;
    public function ensurePermission(string $code, string $name): int;
    public function grantRolePermission(int $roleId, int $permissionId): void;
    public function assignRole(int $userId, int $roleId): void;
    /** @return array<int,string> */
    public function permissionsForUser(int $userId): array;
    public function recordAuthEvent(int $userId, string $type, array $detail = []): void;
}

/** Operator notifications: risk alerts, approval requests, execution outcomes. */
interface NotificationRepository
{
    /** Saves and RETURNS the record with its generated id. */
    public function save(array $notification): array;
    /** Broadcast (user_id NULL) + the user's own, newest first. */
    public function list(?int $userId = null, bool $unreadOnly = false, int $limit = 50): array;
    public function markRead(string $id, ?int $userId = null): bool;
    public function markAllRead(?int $userId = null): int;
    public function unreadCount(?int $userId = null): int;
    /** True when an UNREAD notification with this dedupe key already exists. */
    public function hasUnreadDedupe(string $dedupeKey): bool;
}

interface PaperRepository
{
    /** Saves and RETURNS the record with its generated id. */
    public function saveAccount(array $account): array;
    public function findAccount(int $id): ?array;
    /** @return array<int, array<string, mixed>> */
    public function listAccounts(): array;
    /** Saves and RETURNS the record with its generated id. */
    public function saveOrder(array $order): array;
    /** @return array<int, array<string, mixed>> */
    public function listOrders(int $accountId, ?string $status = null): array;
    public function findOpenOrder(int $accountId, string $symbol): ?array;
    /** Saves and RETURNS the record with its generated id. */
    public function savePosition(array $position): array;
    public function findPosition(int $id): ?array;
    public function findOpenPosition(int $accountId, string $symbol): ?array;
    /** @return array<int, array<string, mixed>> */
    public function listOpenPositions(int $accountId): array;
    public function saveTrade(array $trade): void;
    /** @return array<int, array<string, mixed>> */
    public function listTrades(int $accountId, int $limit = 100): array;
    /** Saves and RETURNS the record with its generated id. */
    public function saveDeployment(array $deployment): array;
    public function findDeployment(int $id): ?array;
    /** @return array<int, array<string, mixed>> */
    public function listDeployments(?int $accountId = null, ?bool $active = null): array;
}

/**
 * Phase 5 execution governance persistence: durable trade proposals with
 * their full pipeline checks, and the execution record for any proposal that
 * was actually routed to a broker connector.
 */
interface ProposalRepository
{
    /** Insert-or-update by id; always returns the stored record. */
    public function saveProposal(array $proposal): array;
    /** @return array<string, mixed>|null */
    public function findProposal(string $id): ?array;
    /** @return array<int, array<string, mixed>> newest first */
    public function listProposals(?string $status = null, int $limit = 100): array;
    /** Automated trades routed today (UTC) — the SEMI_AUTONOMOUS daily cap. */
    public function countAutomatedExecutionsToday(): int;
    public function saveExecution(array $execution): array;
    /** @return array<int, array<string, mixed>> */
    public function listExecutions(string $proposalId, int $limit = 10): array;
    public function listRecentExecutions(int $limit = 50): array;
}

/**
 * WINDELS Lottery Intelligence persistence (spec §7): provider-neutral,
 * source-attributed draw records. Draws are immutable once VERIFIED —
 * corrections go through the audited correction path in LotteryIntelligence.
 */
interface LotteryRepository
{
    public function ensureLottery(string $code, string $name, string $rulesVersion): array;
    /** @return array<int, array<string, mixed>> */
    public function listLotteries(): array;

    /** @return array<string, mixed>|null Active stored rules row, or null (code default applies). */
    public function activeRules(string $lotteryCode): ?array;
    public function saveRules(array $r): int;

    public function ensureProvider(string $code, string $name): array;
    /** @return array<int, array<string, mixed>> */
    public function listProviders(bool $enabledOnly = false): array;
    public function saveHealth(int $providerId, array $health): void;
    /** @return array<string, mixed>|null */
    public function latestHealth(int $providerId): ?array;
    /** @return array<int, array<string, mixed>> */
    public function listHealth(int $providerId, int $limit = 20): array;

    /** @return array<string, mixed>|null */
    public function findDraw(int $id): ?array;
    /** @return array<string, mixed>|null */
    public function findDrawByExternal(string $lotteryCode, string $externalId): ?array;
    /** @return array<int, array<string, mixed>> */
    public function listDraws(array $filter = [], int $limit = 100, string $order = 'DESC'): array;
    /**
     * Insert a draw (numbers rows are written by the caller via
     * saveDrawNumbers) or update the non-verified row in place.
     * @return array{row:array<string,mixed>,created:bool}
     */
    public function saveDraw(array $d): array;
    /** @return array<int, array<string, mixed>> position-ordered numbers for a draw */
    public function listDrawNumbers(int $drawId): array;
    public function saveDrawNumbers(int $drawId, array $numbers): void;
    /** Draws as stats input: ['drawDate'=>, 'main'=>int[], 'stars'=>int[]] ASC, decoded. */
    /** @return array<int, array<string, mixed>> */
    public function drawsForStats(string $lotteryCode, int $limit = 10000): array;
    public function countDraws(string $lotteryCode): int;

    /** Starts once per idempotency key, or returns null if already processed. */
    public function startJobRun(array $run): ?array;
    public function finishJobRun(string $id, array $result): void;
    /** @return array<int, array<string, mixed>> */
    public function listJobRuns(?string $jobType = null, int $limit = 50): array;
    /** @return array<string, mixed>|null */
    public function findJobRunByKey(string $key): ?array;
    public function deleteOldJobRuns(string $cutoff): void;
    public function deleteOldHealth(string $cutoff): void;

    /** Generated combination lines (spec §14/§16). JSON columns decoded on read. */
    /** @return array{row:array<string,mixed>,created:bool} */
    public function saveCombination(array $c): array;
    /** @return array<string, mixed>|null */
    public function findCombination(int $id): ?array;
    /** @return array<int, array<string, mixed>> newest first */
    public function listCombinations(int $limit = 50, int $offset = 0): array;

    /** AI decision report attached to a generation (spec §26/§33). */
    /** @return array{row:array<string,mixed>,created:bool} */
    public function saveAiDecision(array $d): array;
    /** @return array<string, mixed>|null */
    public function findAiDecision(int $id): ?array;
    /** @return array<int, array<string, mixed>> newest first */
    public function listAiDecisions(?int $combinationId = null, int $limit = 50): array;

    /**
     * Saved tickets (spec §20/§29). JSON columns decoded on read.
     * User isolation (spec §38): when $userId is given, only that user's
     * ticket is returned; null = system/admin scope.
     */
    /** @return array{row:array<string,mixed>,created:bool} */
    public function saveTicket(array $t): array;
    /** @return array<string, mixed>|null */
    public function findTicket(int $id, ?int $userId = null): ?array;
    /** @return array<int, array<string, mixed>> newest first */
    public function listTickets(int $userId, int $limit = 50): array;
    /** @return array<int, array<string, mixed>> newest first (admin/system scope) */
    public function listAllTickets(int $limit = 200): array;
    public function updateTicket(int $id, array $patch): void;
    /** @return array<int, array<string, mixed>> position-ordered, decoded */
    public function ticketLines(int $ticketId): array;
    public function saveTicketLines(int $ticketId, array $lines): void;

    /**
     * Model versioning (spec §33): rows are never deleted or replaced —
     * historical results stay connected to the model that generated them.
     * @return array<string, mixed> the existing row when (name, version) already exists
     */
    public function ensureModelVersion(array $m): array;
    /** @return array<int, array<string, mixed>> oldest first, config decoded */
    public function listModelVersions(): array;

    /** Backtest report rows (spec §23–§25); report JSON decoded on read. */
    /** @return array{row:array<string,mixed>,created:bool} */
    public function saveBacktest(array $b): array;
    /** @return array<string, mixed>|null */
    public function findBacktest(int $id): ?array;
    /** @return array<int, array<string, mixed>> newest first */
    public function listBacktests(int $limit = 50): array;
}
