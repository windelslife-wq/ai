<?php
namespace Aegis\Notifications;

use Aegis\Persistence\NotificationRepository;

/**
 * Operator notification service (spec §16/§18). Domain services publish
 * through notify(); nothing here knows about HTTP or views.
 *
 * Dedupe: while an UNREAD notification with the same dedupe key exists, new
 * publishes with that key are skipped — a recurring risk alert produces one
 * unread badge until an operator acknowledges it, not one per scan.
 */
class Notifier
{
    public function __construct(private NotificationRepository $repo) {}

    /**
     * @param array $detail structured payload stored as JSON
     * @return array{created: bool, notification: array|null}
     */
    public function notify(string $type, string $severity, string $title, array $detail = [], ?string $dedupeKey = null, ?int $userId = null): array
    {
        if ($dedupeKey !== null && $this->repo->hasUnreadDedupe($dedupeKey)) {
            return ['created' => false, 'notification' => null];
        }
        $notification = $this->repo->save([
            'userId' => $userId, 'type' => $type, 'severity' => $severity, 'title' => $title,
            'detail' => $detail, 'dedupeKey' => $dedupeKey, 'createdAt' => gmdate('c'),
        ]);
        return ['created' => true, 'notification' => $notification];
    }

    /** @return array{unread: int, notifications: array<int, array<string, mixed>>} */
    public function inbox(?int $userId = null, bool $unreadOnly = false, int $limit = 50): array
    {
        return [
            'unread' => $this->repo->unreadCount($userId),
            'notifications' => $this->repo->list($userId, $unreadOnly, $limit),
        ];
    }

    public function markRead(string $id, ?int $userId = null): bool
    {
        return $this->repo->markRead($id, $userId);
    }

    public function markAllRead(?int $userId = null): int
    {
        return $this->repo->markAllRead($userId);
    }
}
