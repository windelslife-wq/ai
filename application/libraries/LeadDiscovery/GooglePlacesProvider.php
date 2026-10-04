<?php
namespace LeadDiscovery;

/** Google Places API (New) Text Search adapter. No results are fabricated when unavailable. */
class GooglePlacesProvider implements LeadDiscoveryProvider
{
    private const URL = 'https://places.googleapis.com/v1/places:searchText';
    public function __construct(private ?string $apiKey = null, private int $timeoutSeconds = 12, private int $maxAttempts = 2)
    { $this->apiKey ??= (string)getenv('GOOGLE_PLACES_API_KEY'); }
    public function name(): string { return 'google_places'; }
    public function healthCheck(): array
    { return $this->apiKey !== '' ? ['status'=>'IMPLEMENTED','detail'=>'Google Places Text Search configured'] : ['status'=>'DISABLED','detail'=>'GOOGLE_PLACES_API_KEY is not configured']; }
    public function searchBusinesses(array $input): array
    {
        $health=$this->healthCheck(); if($health['status'] !== 'IMPLEMENTED') throw new ProviderException($health['detail'],503);
        $query=trim((string)($input['query']??'')); if($query==='') throw new ProviderException('search query is required',400);
        $payload=json_encode(['textQuery'=>$query,'maxResultCount'=>min(20,max(1,(int)($input['limit']??20)))]);
        $last=null;
        for($attempt=1;$attempt<=$this->maxAttempts;$attempt++) {
            try { return $this->normalize($this->post($payload)); }
            catch(ProviderException $e) { $last=$e; if(!$e->retryable || $attempt===$this->maxAttempts) throw $e; usleep(150000*$attempt); }
        }
        throw $last ?: new ProviderException('Google Places request failed');
    }
    /** Separated for deterministic integration tests with a staged transport. */
    protected function post(string $payload): array
    {
        $headers="Content-Type: application/json\r\nX-Goog-Api-Key: {$this->apiKey}\r\nX-Goog-FieldMask: places.id,places.displayName,places.formattedAddress,places.types,places.nationalPhoneNumber,places.websiteUri,places.location\r\n";
        $context=stream_context_create(['http'=>['method'=>'POST','timeout'=>$this->timeoutSeconds,'ignore_errors'=>true,'header'=>$headers,'content'=>$payload]]);
        $body=@file_get_contents(self::URL,false,$context); $status=0;
        foreach(($http_response_header??[]) as $line) if(preg_match('#HTTP/\S+\s+(\d+)#',$line,$m)) {$status=(int)$m[1];break;}
        if($body===false) throw new ProviderException('Google Places request timed out or could not connect',503,true);
        $decoded=json_decode($body,true); if(!is_array($decoded)) throw new ProviderException('Google Places returned an invalid response',502,true);
        if($status>=400 || isset($decoded['error'])) { $message=(string)($decoded['error']['message']??'Google Places request failed'); throw new ProviderException($message,$status?:502,$status===429||$status>=500); }
        return $decoded;
    }
    private function normalize(array $payload): array
    {
        $out=[]; foreach(($payload['places']??[]) as $p) { $sourceId=(string)($p['id']??''); if($sourceId==='') continue; $types=array_values($p['types']??[]); $out[]=['sourceId'=>$sourceId,'name'=>(string)($p['displayName']['text']??'Unnamed business'),'category'=>implode(', ',array_slice($types,0,3))?:null,'address'=>$p['formattedAddress']??null,'phone'=>$p['nationalPhoneNumber']??null,'website'=>$p['websiteUri']??null,'latitude'=>isset($p['location']['latitude'])?(float)$p['location']['latitude']:null,'longitude'=>isset($p['location']['longitude'])?(float)$p['location']['longitude']:null,'metadata'=>['provider'=>'Google Places','types'=>$types]]; }
        return $out;
    }
}
