<?php
namespace LeadDiscovery;
class ProviderRegistry
{
    /** @param LeadDiscoveryProvider[] $providers */
    public function __construct(private array $providers) {}
    public function get(string $name): LeadDiscoveryProvider { foreach($this->providers as $provider) if($provider->name()===$name) return $provider; throw new ProviderException('provider is not implemented',422); }
    public function health(): array { return array_map(fn($p)=>['name'=>$p->name()]+$p->healthCheck(),$this->providers); }
}
