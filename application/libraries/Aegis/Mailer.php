<?php
namespace Aegis;

use CI_Controller;

/**
 * Centralised outbound email.
 *
 * Credentials live ONLY in the server environment (root .env, which is
 * gitignored, or real server env vars). This class never reads, echoes, logs
 * or returns a password — it hands the CI_Email library the values from
 * getenv() and reports a success/failure summary that is safe to display.
 *
 * Provider is operator-configured. For the halykpetroleum-kz.com mailbox the
 * MX records resolve to Namecheap Private Email, whose submission settings are
 *   host mail.privateemail.com · port 465 (SSL) or 587 (TLS).
 */
final class Mailer
{
    public static function enabled(): bool
    {
        return (getenv('VP_SMTP_ENABLED') ?: getenv('SMTP_ENABLED')) === '1'
            && trim((string) (getenv('VP_SMTP_HOST') ?: getenv('SMTP_HOST'))) !== '';
    }

    /** A safe, credential-free summary of the current mail configuration. */
    public static function configSummary(): array
    {
        return [
            'enabled' => self::enabled(),
            'protocol' => self::enabled() ? 'smtp' : 'disabled',
            'host' => (string) (getenv('VP_SMTP_HOST') ?: getenv('SMTP_HOST') ?: ''),
            'port' => (int) (getenv('VP_SMTP_PORT') ?: getenv('SMTP_PORT') ?: 0),
            'crypto' => strtolower((string) (getenv('VP_SMTP_CRYPTO') ?: getenv('SMTP_CRYPTO') ?: '')),
            'fromEmail' => (string) (getenv('VP_MAIL_FROM') ?: getenv('MAIL_FROM_ADDRESS') ?: ''),
            'fromName' => (string) (getenv('VP_MAIL_FROM_NAME') ?: getenv('VP_SITE_NAME') ?: 'WINDELS AI WORKFORCE'),
            'usernameConfigured' => trim((string) (getenv('VP_SMTP_USER') ?: getenv('SMTP_USER') ?: '')) !== '',
            'passwordConfigured' => trim((string) (getenv('VP_SMTP_PASS') ?: getenv('SMTP_PASS') ?: '')) !== '',
        ];
    }

    /**
     * Send an HTML message with a plain-text fallback. Returns a safe result.
     * @return array{ok:bool,message:string}
     */
    public static function send(CI_Controller $ci, string $to, string $subject, string $htmlBody, string $textBody = '', ?string $replyTo = null, ?string $replyName = null): array
    {
        $to = trim($to);
        if (!filter_var($to, FILTER_VALIDATE_EMAIL)) {
            return ['ok' => false, 'message' => 'The recipient address is not a valid email.'];
        }
        if (!self::enabled()) {
            return ['ok' => false, 'message' => 'Outgoing email is disabled. Set VP_SMTP_ENABLED=1 and a VP_SMTP_HOST on the server to send.'];
        }
        if (!self::configSummary()['passwordConfigured'] || !self::configSummary()['usernameConfigured']) {
            return ['ok' => false, 'message' => 'SMTP username/password are not configured in the server environment.'];
        }

        $ci->load->library('email');
        $fromEmail = (string) (getenv('VP_MAIL_FROM') ?: getenv('MAIL_FROM_ADDRESS') ?: getenv('VP_SMTP_USER') ?: '');
        $fromName = (string) (getenv('VP_MAIL_FROM_NAME') ?: getenv('VP_SITE_NAME') ?: 'WINDELS AI WORKFORCE');
        if ($fromEmail === '') {
            return ['ok' => false, 'message' => 'No VP_MAIL_FROM address is configured on the server.'];
        }

        $ci->email->from($fromEmail, $fromName);
        $ci->email->to($to);
        if ($replyTo !== null && filter_var($replyTo, FILTER_VALIDATE_EMAIL)) {
            $ci->email->reply_to($replyTo, (string) ($replyName ?? ''));
        }
        $ci->email->subject($subject);
        $ci->email->message($htmlBody);
        if ($textBody !== '') {
            $ci->email->set_alt_message($textBody);
        }

        $sent = @$ci->email->send();
        // Safe logging: the CI debug string may include host/port but NEVER the
        // password. Strip any accidental occurrence as defence-in-depth.
        $debug = (string) $ci->email->print_debugger(['headers', 'subject']);
        $debug = self::scrub($debug);
        if ($sent) {
            log_message('error', '[mailer] sent "' . $subject . '" to ' . $to);
            return ['ok' => true, 'message' => 'Message accepted for delivery to ' . $to . '.'];
        }
        log_message('error', '[mailer] send failed for ' . $to . ': ' . $debug);
        return ['ok' => false, 'message' => 'The SMTP server did not accept the message. ' . self::shortError($debug)];
    }

    /** Send a self-contained test email (used by the admin control centre). */
    public static function sendTest(CI_Controller $ci, string $to, string $variant = 'html'): array
    {
        $summary = self::configSummary();
        $isHtml = $variant !== 'plain';
        $html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
            . '<h2 style="color:#2563eb;margin:0 0 8px">WINDELS AI WORKFORCE — test email</h2>'
            . '<p>This confirms outbound email is working from your WINDELS AI WORKFORCE installation.</p>'
            . '<table style="border-collapse:collapse;font-size:13px;color:#334155">'
            . '<tr><td style="padding:3px 12px 3px 0;color:#64748b">Protocol</td><td>' . htmlspecialchars($summary['protocol']) . '</td></tr>'
            . '<tr><td style="padding:3px 12px 3px 0;color:#64748b">Host</td><td>' . htmlspecialchars($summary['host']) . '</td></tr>'
            . '<tr><td style="padding:3px 12px 3px 0;color:#64748b">Port / TLS</td><td>' . htmlspecialchars((string) $summary['port']) . ' / ' . htmlspecialchars(strtoupper($summary['crypto']) ?: '—') . '</td></tr>'
            . '<tr><td style="padding:3px 12px 3px 0;color:#64748b">From</td><td>' . htmlspecialchars($summary['fromEmail']) . ' (' . htmlspecialchars($summary['fromName']) . ')</td></tr>'
            . '</table>'
            . '<p style="margin-top:16px;color:#64748b;font-size:12px">Sent at ' . date('Y-m-d H:i:s') . ' UTC. If you can read this, HTML email works.</p>'
            . '</div>';
        $text = "WINDELS AI WORKFORCE — test email\n\n"
            . "This confirms outbound email is working from your WINDELS AI WORKFORCE installation.\n\n"
            . "Protocol: {$summary['protocol']}\nHost: {$summary['host']}\nPort/TLS: {$summary['port']} / " . strtoupper($summary['crypto']) . "\n"
            . "From: {$summary['fromEmail']} ({$summary['fromName']})\n\nSent at " . date('Y-m-d H:i:s') . ' UTC.';
        return self::send($ci, $to, 'WINDELS AI WORKFORCE — test email (' . $variant . ')', $isHtml ? $html : $text, $text);
    }

    /** Remove credentials and trim the verbose SMTP transcript to a useful tail. */
    private static function scrub(string $text): string
    {
        $pass = (string) (getenv('VP_SMTP_PASS') ?: getenv('SMTP_PASS') ?: '');
        if ($pass !== '') $text = str_replace($pass, '[redacted]', $text);
        $user = (string) (getenv('VP_SMTP_USER') ?: getenv('SMTP_USER') ?: '');
        if ($user !== '') $text = str_replace($user, '[redacted-user]', $text);
        return $text;
    }

    private static function shortError(string $debug): string
    {
        $low = strtolower($debug);
        // CI3 emits these when the SMTP socket cannot be opened.
        if (str_contains($low, 'fsockopen') || str_contains($low, 'connection refused')
            || str_contains($low, 'timed out') || str_contains($low, 'unable to send email using php smtp')
            || str_contains($low, 'smtp error was encountered') || str_contains($low, 'failed to connect')
            || str_contains($low, 'network is unreachable') || str_contains($low, 'permission denied')) {
            return 'Could not connect to the SMTP host/port — check host, port (465 SSL / 587 TLS), that outbound SMTP is allowed by the network/firewall, and that the username/password are correct.';
        }
        // A real 3-digit SMTP status code (auth/data rejection).
        if (preg_match('/\b([245]\d{2})\b[ -].+/i', $debug, $m)) {
            return 'SMTP responded "' . trim(mb_substr($m[0], 0, 180)) . '".';
        }
        $tail = trim(implode(' ', array_slice(preg_split('/\r\n|\r|\n/', $debug), -4)));
        return $tail !== '' ? mb_substr($tail, 0, 200) : 'See the server error log for the full SMTP transcript.';
    }
}
