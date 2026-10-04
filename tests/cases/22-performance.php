<?php
use Aegis\Sports\PerformanceAnalytics;
test('sports performance uses settled tickets only and does not invent ROI', function () { $s=(new PerformanceAnalytics())->summarize([['settlement_status'=>'WON','total_odds'=>2],['settlement_status'=>'LOST','total_odds'=>3],['settlement_status'=>'PENDING','total_odds'=>4],['settlement_status'=>'VOID']]); assert_equals(3,$s['settledTickets']); assert_close(.5,$s['winRate'],.00001); assert_equals(null,$s['roi']); });
