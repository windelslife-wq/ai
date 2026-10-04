<?php
test('lead data coverage is calculated from stored fields and identifies missing values', function () {
    $db=ci()->db;$org='coverage-test';$db->where('organization_id',$org)->delete('leads');$now=gmdate('c');
    foreach ([['id'=>'coverage-a','phone'=>'+23415550100','website'=>'https://one.example'],['id'=>'coverage-b','phone'=>null,'website'=>null]] as $i=>$lead)$db->insert('leads',$lead+['organization_id'=>$org,'source'=>'test','source_id'=>'coverage-'.$i,'name'=>'Coverage '.($i+1),'status'=>'new','metadata'=>'{}','created_at'=>$now,'updated_at'=>$now]);
    $leads=$db->where('organization_id',$org)->get('leads')->result_array();$phoneFilled=count(array_filter($leads,fn($x)=>!empty($x['phone'])));$missingWebsite=array_values(array_filter($leads,fn($x)=>empty($x['website'])));
    assert_close(50.0,100*$phoneFilled/count($leads),0.001);assert_equals(1,count($missingWebsite));assert_equals('coverage-b',$missingWebsite[0]['id']);
});
