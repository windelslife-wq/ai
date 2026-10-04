<?php
use Aegis\Sports\ResultVerificationEngine;
test('sports results do not settle until verified finished score exists', function () {
 $e=new ResultVerificationEngine(); $v=$e->verify(['verified'=>false,'status'=>'FINISHED','homeScore'=>2,'awayScore'=>0]); assert_false($v['verified']); assert_equals('PENDING',$e->settleSelection(['market'=>'TOTAL_GOALS','selection'=>'OVER_1_5'],$v)['status']);
});
test('verified cancellation and void produce explicit non-win outcomes', function () {
 $e=new ResultVerificationEngine(); $v=$e->verify(['verified'=>true,'status'=>'VOID']); assert_equals('VOID',$e->settleSelection(['market'=>'TOTAL_GOALS','selection'=>'OVER_1_5'],$v)['status']);
});
test('verified result settles supported market deterministically', function () {
 $e=new ResultVerificationEngine(); $v=$e->verify(['verified'=>true,'status'=>'FINISHED','homeScore'=>1,'awayScore'=>1]); assert_true($v['verified']); assert_equals('WON',$e->settleSelection(['market'=>'TOTAL_GOALS','selection'=>'OVER_1_5'],$v)['status']);
});
