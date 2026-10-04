<?php
defined('BASEPATH') or exit('No direct script access allowed');

/** Public website assistant endpoint; account data is never exposed to it. */
class Api_chat extends Api_controller
{
    public function respond()
    {
        $key = 'aegis_chat_window'; $window = (array) $this->session->userdata($key); $now = time();
        $window = array_values(array_filter(array_map('intval', $window), fn($at) => $at > $now - 60));
        if (count($window) >= 30) return $this->jsonError('chat rate limit exceeded; please try again shortly', 429);
        $window[] = $now; $this->session->set_userdata($key, $window);
        $body = $this->jsonBody(); $message = (string) ($body['message'] ?? '');
        try {
            $user = $this->session->userdata('identity');
            $this->json((new \Aegis\ChatAssistant())->respond($message, is_array($user) ? $user : null));
        } catch (\InvalidArgumentException $e) { $this->jsonError($e->getMessage(), 400); }
    }
}
