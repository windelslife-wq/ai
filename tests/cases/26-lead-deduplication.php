<?php
require_once APPPATH . 'libraries/LeadDiscovery/Deduplicator.php';
test('secondary lead deduplication creates a review candidate for normalized phone matches', function () {
    $db=ci()->db;$db->where('organization_id','dedupe-org')->delete('duplicate_candidates');$db->where('organization_id','dedupe-org')->delete('leads');$now=gmdate('c');
    foreach ([['id'=>'dedupe-a','source_id'=>'source-a','phone'=>'+234 (1) 555-0100','website'=>null],['id'=>'dedupe-b','source_id'=>'source-b','phone'=>'23415550100','website'=>null]] as $lead) $db->insert('leads',$lead+['organization_id'=>'dedupe-org','source'=>'google_places','name'=>'Different Names','status'=>'new','metadata'=>'{}','created_at'=>$now,'updated_at'=>$now]);
    $lead=$db->get_where('leads',['id'=>'dedupe-a'],1)->row_array();$created=(new \LeadDiscovery\Deduplicator($db))->detect($lead,'dedupe-org');
    assert_equals(1,$created);$candidate=$db->get_where('duplicate_candidates',['organization_id'=>'dedupe-org'],1)->row_array();assert_equals('normalized_phone',$candidate['rule_name']);assert_close(0.92,(float)$candidate['confidence'],0.001);
});
test('secondary deduplication does not create a candidate without strong matching data', function () {
    $db=ci()->db;$db->where('organization_id','dedupe-no-match')->delete('duplicate_candidates');$db->where('organization_id','dedupe-no-match')->delete('leads');$now=gmdate('c');foreach ([['id'=>'dedupe-c','source_id'=>'source-c','name'=>'Alpha','phone'=>null],['id'=>'dedupe-d','source_id'=>'source-d','name'=>'Beta','phone'=>null]] as $lead)$db->insert('leads',$lead+['organization_id'=>'dedupe-no-match','source'=>'google_places','status'=>'new','metadata'=>'{}','created_at'=>$now,'updated_at'=>$now]);
    $lead=$db->get_where('leads',['id'=>'dedupe-c'],1)->row_array();assert_equals(0,(new \LeadDiscovery\Deduplicator($db))->detect($lead,'dedupe-no-match'));
});
