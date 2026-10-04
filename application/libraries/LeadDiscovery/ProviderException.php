<?php
namespace LeadDiscovery;
class ProviderException extends \RuntimeException
{
    public function __construct(string $message, public int $httpStatus = 503, public bool $retryable = false) { parent::__construct($message); }
}
