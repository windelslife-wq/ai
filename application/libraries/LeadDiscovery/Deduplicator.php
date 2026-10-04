<?php
namespace LeadDiscovery;

/** Conservative secondary duplicate detector. It creates review candidates; it never auto-merges leads. */
class Deduplicator
{
    public function __construct(private object $db) {}
    public function detect(array $lead, string $organizationId): int
    {
        $rows=$this->db->where('organization_id',$organizationId)->where('id !=',$lead['id'])->get('leads')->result_array(); $created=0;
        foreach($rows as $other) {
            [$rule,$confidence]=$this->match($lead,$other); if(!$rule) continue;
            $a=strcmp($lead['id'],$other['id'])<0?$lead['id']:$other['id']; $b=$a===$lead['id']?$other['id']:$lead['id'];
            $exists=$this->db->where(['organization_id'=>$organizationId,'lead_a_id'=>$a,'lead_b_id'=>$b,'rule_name'=>$rule,'status'=>'open'])->count_all_results('duplicate_candidates');
            if(!$exists){$this->db->insert('duplicate_candidates',['id'=>bin2hex(random_bytes(16)),'organization_id'=>$organizationId,'lead_a_id'=>$a,'lead_b_id'=>$b,'rule_name'=>$rule,'confidence'=>$confidence,'status'=>'open','created_at'=>gmdate('c')]);$created++;}
        }
        return $created;
    }
    /** @return array{0:?string,1:float} */
    private function match(array $a, array $b): array
    {
        $domainA=$this->domain($a['website']??null);$domainB=$this->domain($b['website']??null);
        if($domainA && $domainA===$domainB) return ['website_domain',0.95];
        $phoneA=$this->phone($a['phone']??null);$phoneB=$this->phone($b['phone']??null);
        if($phoneA && strlen($phoneA)>=7 && $phoneA===$phoneB) return ['normalized_phone',0.92];
        $identityA=$this->text($a['name']??'').'|'.$this->text($a['address']??'');$identityB=$this->text($b['name']??'').'|'.$this->text($b['address']??'');
        if($identityA!=='|' && $identityA===$identityB) return ['name_address',0.84];
        return [null,0.0];
    }
    private function domain(?string $url): ?string { if(!$url)return null;$host=parse_url(str_contains($url,'://')?$url:'https://'.$url,PHP_URL_HOST);if(!$host)return null;return preg_replace('/^www\./','',strtolower($host)); }
    private function phone(?string $phone): ?string { return $phone?preg_replace('/\D+/','',$phone):null; }
    private function text(string $value): string { return preg_replace('/[^a-z0-9]+/','',strtolower($value)); }
}
