<?php
namespace Aegis\Sports;

use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\SportsRepository;

/**
 * Ticket record + approval governance (spec §18/§20).
 *
 * Default mode is USER_APPROVAL_REQUIRED: a generated ticket is PENDING until
 * a human with sports.approve decides. Under an explicitly authorized
 * AUTOMATED_EXECUTION configuration the decision is recorded as
 * APPROVED_NOT_EXECUTED — and external execution STILL does not exist in this
 * deployment (there is no external execution connector by design).
 */
class TicketGovernance
{
    private const RISK_ORDER = ['LOW' => 0, 'MEDIUM' => 1, 'HIGH' => 2];

    public function __construct(private SportsRepository $repo, private AuditRepository $audit, private CorrelationEngine $correlation = new CorrelationEngine()) {}

    /**
     * Persist a QUALIFIED optimized ticket.
     * @param array $optimized TicketOptimizer QUALIFIED output (selections = pipeline candidates)
     * @param string $configurationVersion active configuration version
     * @param int|null $modelVersionId
     * @param array $config active configuration (stake, mode…)
     */
    public function record(array $optimized, string $configurationVersion, ?int $modelVersionId = null, array $config = []): array
    {
        if (($optimized['status'] ?? '') !== 'QUALIFIED') return ['status' => 'NO_QUALIFIED_TICKET', 'reason' => $optimized['reason'] ?? 'No compliant combination'];
        $sels = $optimized['selections'];

        $confidences = array_map(fn($s) => is_numeric($s['confidence']['confidence'] ?? null) ? (float) $s['confidence']['confidence'] : null, $sels);
        $qualities = array_map(fn($s) => (int) ($s['quality']['score'] ?? 0), $sels);
        $combined = 1.0;
        foreach ($sels as $s) $combined *= (float) ($s['prediction']['calibratedProbability'] ?? 0.5);
        $pairwise = $this->correlation->classifySelections($sels);
        $risk = 'LOW';
        foreach ($sels as $s) {
            $r = $s['risk']['classification'] ?? 'HIGH';
            if (isset(self::RISK_ORDER[$r]) && self::RISK_ORDER[$r] > self::RISK_ORDER[$risk]) $risk = $r;
        }
        $automated = (($config['engine_mode'] ?? '') === 'AUTOMATED_EXECUTION');

        $id = $optimized['ticketId'];
        $this->repo->saveTicket([
            'id' => $id, 'created_at' => gmdate('c'), 'model_version_id' => $modelVersionId,
            'configuration_version' => (string) $configurationVersion,
            'total_odds' => $optimized['totalOdds'], 'selection_count' => count($sels),
            'combined_probability' => round($combined, 8),
            'confidence' => array_filter($confidences) ? round(min(array_filter($confidences)), 2) : null,
            'risk' => $risk, 'correlation' => $pairwise['classification'],
            'data_quality_score' => min($qualities),
            'status' => $automated ? 'APPROVED' : 'PENDING',
            'approval_status' => $automated ? 'APPROVED_NOT_EXECUTED' : 'PENDING_USER_APPROVAL',
            'settlement_status' => 'PENDING',
            'stake' => $config['stake_amount'] ?? null,
            'reason' => null,
        ]);
        foreach ($sels as $s) {
            $this->repo->saveTicketSelection([
                'ticket_id' => $id, 'prediction_id' => $s['predictionId'] ?? 'unlinked',
                'match_id' => (int) $s['matchId'], 'market' => $s['market'] ?? 'UNSPECIFIED', 'selection' => $s['selection'] ?? 'UNSPECIFIED',
                'odds' => $s['value']['odds'], 'odds_timestamp' => $s['oddsTimestamp'] ?? gmdate('c'),
                'model_probability' => $s['prediction']['rawModelProbability'] ?? null,
                'calibrated_probability' => $s['prediction']['calibratedProbability'] ?? null,
                'expected_value' => $s['value']['expectedValue'], 'risk' => $s['risk']['classification'],
                'result' => null, 'status' => 'PENDING',
            ]);
        }
        $this->audit->emit('SPORTS_TICKET_RECORDED', 'Sports ticket generated, ' . ($automated ? 'auto-approved under AUTOMATED_EXECUTION (no external execution)' : 'awaiting user approval'), [
            'ticketId' => $id, 'configurationVersion' => $configurationVersion, 'totalOdds' => $optimized['totalOdds'],
            'selectionCount' => count($sels), 'risk' => $risk, 'correlation' => $pairwise['classification'], 'automated' => $automated,
        ]);
        return ['status' => $automated ? 'APPROVED_NOT_EXECUTED' : 'PENDING_USER_APPROVAL', 'ticketId' => $id];
    }

    /** Human (or authorized-automated) decision. Always audited with the actor. */
    public function decide(string $id, bool $approve, string $actor, string $reason = ''): array
    {
        $ticket = $this->repo->findTicket($id);
        if (!$ticket) throw new \InvalidArgumentException('ticket not found');
        if (($ticket['approval_status'] ?? '') !== 'PENDING_USER_APPROVAL') throw new \RuntimeException('ticket already decided');
        $state = $approve ? 'APPROVED_NOT_EXECUTED' : 'REJECTED';
        $this->repo->updateTicket($id, ['approval_status' => $state, 'status' => $approve ? 'APPROVED' : 'CANCELLED', 'reason' => $reason]);
        $this->audit->emit($approve ? 'SPORTS_TICKET_APPROVED' : 'SPORTS_TICKET_REJECTED', 'Sports ticket decision; no external execution', ['ticketId' => $id, 'reason' => $reason], $actor);
        return ['ticketId' => $id, 'approvalStatus' => $state, 'externalExecution' => false];
    }
}
