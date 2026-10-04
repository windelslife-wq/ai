<?php
defined('BASEPATH') OR exit('No direct script access allowed');

/**
 * CodeIgniter Email library config, driven by root .env.
 *
 * Used when the app loads $this->load->library('email').
 * Mail stays off until VP_SMTP_ENABLED=1 (or SMTP_ENABLED=1) and a host is set.
 */
$smtpEnabled = (getenv('VP_SMTP_ENABLED') ?: getenv('SMTP_ENABLED')) === '1';
$smtpHost = (string) (getenv('VP_SMTP_HOST') ?: (getenv('SMTP_HOST') ?: ''));
$smtpUser = (string) (getenv('VP_SMTP_USER') ?: (getenv('SMTP_USER') ?: (getenv('SMTP_USERNAME') ?: '')));
$smtpPass = (string) (getenv('VP_SMTP_PASS') ?: (getenv('SMTP_PASS') ?: (getenv('SMTP_PASSWORD') ?: '')));
$smtpPort = (int) (getenv('VP_SMTP_PORT') ?: (getenv('SMTP_PORT') ?: 587));
$smtpCrypto = strtolower((string) (getenv('VP_SMTP_CRYPTO') ?: (getenv('SMTP_CRYPTO') ?: (getenv('SMTP_ENCRYPTION') ?: 'tls'))));
if (!in_array($smtpCrypto, ['tls', 'ssl', ''], true)) {
    $smtpCrypto = 'tls';
}

$config['useragent'] = 'AEGIS';
$config['protocol'] = $smtpEnabled && $smtpHost !== '' ? 'smtp' : 'mail';
$config['mailpath'] = '/usr/sbin/sendmail';
$config['smtp_host'] = $smtpHost;
$config['smtp_user'] = $smtpUser;
$config['smtp_pass'] = $smtpPass;
$config['smtp_port'] = $smtpPort > 0 ? $smtpPort : 587;
$config['smtp_timeout'] = (int) (getenv('VP_SMTP_TIMEOUT') ?: (getenv('SMTP_TIMEOUT') ?: 10));
$config['smtp_keepalive'] = FALSE;
$config['smtp_crypto'] = $smtpCrypto;
$config['wordwrap'] = TRUE;
$config['wrapchars'] = 76;
$config['mailtype'] = (string) (getenv('VP_MAIL_TYPE') ?: (getenv('MAIL_TYPE') ?: 'html'));
$config['charset'] = 'UTF-8';
$config['validate'] = TRUE;
$config['priority'] = 3;
$config['crlf'] = "\r\n";
$config['newline'] = "\r\n";
$config['bcc_batch_mode'] = FALSE;
$config['bcc_batch_size'] = 200;

$config['from_email'] = (string) (getenv('VP_MAIL_FROM') ?: (getenv('MAIL_FROM') ?: (getenv('MAIL_FROM_ADDRESS') ?: $smtpUser)));
$config['from_name'] = (string) (getenv('VP_MAIL_FROM_NAME') ?: (getenv('MAIL_FROM_NAME') ?: (getenv('VP_SITE_NAME') ?: 'WINDELS AI WORKFORCE')));
$config['reply_to'] = (string) (getenv('VP_MAIL_REPLY_TO') ?: (getenv('MAIL_REPLY_TO') ?: $config['from_email']));
