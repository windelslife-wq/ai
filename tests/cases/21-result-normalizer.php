<?php
use Aegis\Sports\SportsResultNormalizer;
test('sports result normalizer rejects incomplete finished scores', function () { assert_throws(InvalidArgumentException::class, fn()=>SportsResultNormalizer::normalize(['externalId'=>'x','status'=>'FINISHED','sourceTimestamp'=>'2026-01-01T00:00:00Z'],'p')); });
test('sports result normalizer preserves unverified provider result', function () { $r=SportsResultNormalizer::normalize(['externalId'=>'x','status'=>'FINISHED','homeScore'=>2,'awayScore'=>1,'sourceTimestamp'=>'2026-01-01T00:00:00Z'],'p'); assert_false($r['verified']); assert_equals(2,$r['homeScore']); });
