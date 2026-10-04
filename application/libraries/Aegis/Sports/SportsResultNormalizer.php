<?php
namespace Aegis\Sports;
/** Validates provider result payloads before verification/persistence. */
class SportsResultNormalizer {
 public static function normalize(array $raw,string $provider): array {
  foreach(['externalId','status','sourceTimestamp'] as $f) if(!isset($raw[$f])||$raw[$f]==='') throw new \InvalidArgumentException("result missing {$f}");
  $status=strtoupper((string)$raw['status']); if(!in_array($status,['FINISHED','VOID','CANCELLED','POSTPONED','SUSPENDED'],true)) throw new \InvalidArgumentException('result status invalid');
  $finished=$status==='FINISHED'; if($finished && (!isset($raw['homeScore'],$raw['awayScore'])||filter_var($raw['homeScore'],FILTER_VALIDATE_INT)===false||filter_var($raw['awayScore'],FILTER_VALIDATE_INT)===false||(int)$raw['homeScore']<0||(int)$raw['awayScore']<0)) throw new \InvalidArgumentException('finished result scores invalid');
  return ['provider'=>$provider,'externalId'=>(string)$raw['externalId'],'status'=>$status,'homeScore'=>$finished?(int)$raw['homeScore']:null,'awayScore'=>$finished?(int)$raw['awayScore']:null,'sourceTimestamp'=>(string)$raw['sourceTimestamp'],'verified'=>false,'payload'=>$raw];
 }
}
