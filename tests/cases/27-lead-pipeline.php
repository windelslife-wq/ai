<?php
test('lead pipeline persists each configured status and groups summary counts', function () {
    $db=ci()->db;$org='pipeline-test';$db->where('organization_id',$org)->delete('leads');$now=gmdate('c');
    foreach(['new','contacted','qualified','disqualified','converted'] as $i=>$status)$db->insert('leads',['id'=>'pipeline-'.$status,'organization_id'=>$org,'source'=>'test','source_id'=>'pipeline-'.$i,'name'=>'Lead '.$status,'status'=>$status,'metadata'=>'{}','created_at'=>$now,'updated_at'=>$now]);
    $rows=$db->select('status, COUNT(*) total')->where('organization_id',$org)->group_by('status')->get('leads')->result_array();$counts=[];foreach($rows as $row)$counts[$row['status']]=(int)$row['total'];
    foreach(['new','contacted','qualified','disqualified','converted'] as $status)assert_equals(1,$counts[$status]);
});
