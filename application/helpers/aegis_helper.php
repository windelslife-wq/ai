<?php
defined('BASEPATH') or exit('No direct script access allowed');

/**
 * View-safe access to platform state (views must not reach into controllers).
 */
final class Aegis_PlatformStateHelper
{
    private static ?array $state = null;

    public static function current(): array
    {
        if (self::$state === null) {
            $ci = get_instance();
            if (isset($ci->platform)) {
                self::$state = $ci->platform->state();
            } else {
                self::$state = ['tradingMode' => 'ANALYSIS_ONLY', 'killSwitch' => ['active' => true]];
            }
        }
        return self::$state;
    }
}

/** View-safe unread-notification count (broadcast + signed-in operator). */
final class Aegis_NotificationsHelper
{
    public static function unreadCount(): int
    {
        $ci = get_instance();
        if (!isset($ci->platform) || !isset($ci->platform->notifications)) return 0;
        try {
            $user = $ci->session->userdata('identity');
            $userId = is_array($user) && !empty($user['id']) ? (int) $user['id'] : null;
            return (int) $ci->platform->notifications->inbox($userId, true, 1)['unread'];
        } catch (Throwable $e) {
            return 0;
        }
    }
}
