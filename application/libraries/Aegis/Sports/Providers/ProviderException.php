<?php
namespace Aegis\Sports\Providers;

/**
 * Typed provider failure. Carries the classified status so the manager and
 * health monitor never have to guess what went wrong.
 *
 * Statuses: OFFLINE | DEGRADED | RATE_LIMITED | AUTHENTICATION_ERROR | DATA_ERROR
 */
final class ProviderException extends \RuntimeException
{
    public const OFFLINE = 'OFFLINE';
    public const DEGRADED = 'DEGRADED';
    public const RATE_LIMITED = 'RATE_LIMITED';
    public const AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR';
    public const DATA_ERROR = 'DATA_ERROR';

    public function __construct(string $message, public readonly string $status = self::DATA_ERROR, ?\Throwable $previous = null)
    {
        parent::__construct($message, 0, $previous);
    }
}
