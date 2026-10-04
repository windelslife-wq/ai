<?php
namespace LeadDiscovery;

/** Every discovery provider returns the same normalized business contract. */
interface LeadDiscoveryProvider
{
    public function name(): string;
    /** @return array{status:string,detail:string} */
    public function healthCheck(): array;
    /** @return array<int,array{sourceId:string,name:string,category:?string,address:?string,phone:?string,website:?string,latitude:?float,longitude:?float,metadata:array}> */
    public function searchBusinesses(array $input): array;
}
