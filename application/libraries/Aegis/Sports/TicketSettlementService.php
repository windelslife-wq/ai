<?php
namespace Aegis\Sports;

use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\SportsRepository;

/**
 * Ticket settlement (spec §22) — settles ONLY from verified persisted
 * provider results.
 *
 * VOID handling is configurable:
 *  - RESTITUTE_ODDS (default): a VOID/CANCELLED selection is refunded — its
 *    odds count as 1.0. The ticket wins at the reduced effective odds when
 *    every non-void selection wins; all-void tickets are VOID.
 *  - ALL_VOID_ONLY: the ticket is VOID only when every selection is void.
 *
 * Paper P/L accounting (stake-based, simulated in PAPER/SANDBOX modes):
 *  WON → +stake*(effectiveOdds-1) · LOST → -stake · VOID/CANCELLED → 0
 */
class TicketSettlementService
{
    public function __construct(private SportsRepository $repo, private ResultVerificationEngine $verifier, private AuditRepository $audit) {}

    /** Settle one selection's match from the stored verified provider result. */
    public function applyStoredResult(string $ticketId, int $matchId, int $providerId): array
    {
        $stored = $this->repo->findResult($matchId, $providerId);
        if (!$stored) throw new \InvalidArgumentException('verified provider result not found');
        return $this->applyVerifiedResult($ticketId, $matchId, [
            'verified' => (bool) $stored['verified'], 'status' => $stored['status'],
            'homeScore' => $stored['home_score'] === null ? null : (int) $stored['home_score'],
            'awayScore' => $stored['away_score'] === null ? null : (int) $stored['away_score'],
        ]);
    }

    public function applyVerifiedResult(string $ticketId, int $matchId, array $result): array
    {
        $verified = $this->verifier->verify($result);
        if (empty($verified['verified'])) return ['status' => 'PENDING', 'reason' => $verified['reason']];
        $ticket = $this->repo->findTicket($ticketId);
        if (!$ticket) throw new \InvalidArgumentException('ticket not found');
        foreach ($this->repo->ticketSelections($ticketId) as $s) {
            if ((int) $s['match_id'] === $matchId && $s['status'] === 'PENDING') {
                $out = $this->verifier->settleSelection(['market' => $s['market'], 'selection' => $s['selection']], $verified);
                if ($out['status'] !== 'PENDING') $this->repo->updateTicketSelection((int) $s['id'], ['status' => $out['status'], 'result' => $out['status']]);
            }
        }
        return $this->finalizeTicket($ticketId);
    }

    /**
     * Sweep: settle every PENDING selection of a ticket for which a verified
     * result exists (any provider), then finalize. Safe to run repeatedly.
     */
    public function settlePending(string $ticketId): array
    {
        $ticket = $this->repo->findTicket($ticketId);
        if (!$ticket) throw new \InvalidArgumentException('ticket not found');
        if (in_array($ticket['settlement_status'] ?? '', ['WON', 'LOST', 'VOID', 'CANCELLED'], true) && count(array_filter($this->repo->ticketSelections($ticketId), fn($s) => $s['status'] === 'PENDING')) === 0) {
            return ['ticketId' => $ticketId, 'status' => $ticket['settlement_status'], 'unchanged' => true];
        }
        foreach ($this->repo->ticketSelections($ticketId) as $s) {
            if ($s['status'] !== 'PENDING') continue;
            $stored = $this->repo->findResultByMatch((int) $s['match_id']);
            if ($stored === null) continue; // results unavailable → selection stays PENDING
            $this->applyVerifiedResult($ticketId, (int) $s['match_id'], [
                'verified' => (bool) $stored['verified'], 'status' => $stored['status'],
                'homeScore' => $stored['home_score'] === null ? null : (int) $stored['home_score'],
                'awayScore' => $stored['away_score'] === null ? null : (int) $stored['away_score'],
            ]);
        }
        return $this->finalizeTicket($ticketId);
    }

    private function finalizeTicket(string $ticketId): array
    {
        $all = $this->repo->ticketSelections($ticketId);
        $states = array_column($all, 'status');
        $voidCount = count(array_filter($states, fn($s) => in_array($s, ['VOID', 'CANCELLED'], true)));
        $lostCount = count(array_filter($states, fn($s) => $s === 'LOST'));
        $pendingCount = count(array_filter($states, fn($s) => $s === 'PENDING'));
        $config = $this->repo->activeConfiguration();
        $voidPolicy = (string) ($config['void_policy'] ?? 'RESTITUTE_ODDS');

        if ($pendingCount > 0) $status = 'PENDING';
        elseif ($lostCount > 0) $status = 'LOST';
        elseif ($voidCount === count($all)) $status = 'VOID';
        else $status = 'WON';

        // Effective odds under the configured void policy.
        $effectiveOdds = 1.0;
        foreach ($all as $s) {
            if (in_array($s['status'], ['VOID', 'CANCELLED'], true)) {
                if ($voidPolicy === 'RESTITUTE_ODDS') continue; // odds refunded (1.0)
            }
            $effectiveOdds *= (float) $s['odds'];
        }
        $ticket = $this->repo->findTicket($ticketId);
        $stake = $ticket['stake'] !== null ? (float) $ticket['stake'] : null;
        $pnl = null;
        if ($stake !== null) {
            if ($status === 'WON') $pnl = round($stake * ($effectiveOdds - 1), 4);
            elseif ($status === 'LOST') $pnl = round(-$stake, 4);
            else $pnl = 0.0;
        }
        $this->repo->updateTicket($ticketId, [
            'settlement_status' => $status, 'status' => $status,
            'total_odds' => $status === 'PENDING' ? $ticket['total_odds'] : round($effectiveOdds, 6),
            'reason' => $status === 'PENDING' ? 'waiting on unverified results' : null,
        ]);
        if ($pnl !== null) $this->repo->recordTicketOutcome($ticketId, $pnl);
        $this->audit->emit('SPORTS_TICKET_SETTLED', 'Sports ticket settlement updated', ['ticketId' => $ticketId, 'status' => $status, 'effectiveOdds' => round($effectiveOdds, 4), 'voidPolicy' => $voidPolicy, 'pnl' => $pnl]);
        return ['ticketId' => $ticketId, 'status' => $status, 'effectiveOdds' => round($effectiveOdds, 4), 'pnl' => $pnl, 'selections' => array_count_values($states)];
    }
}
