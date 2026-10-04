<?php
/** Workspace membership is server-side tenancy metadata, never a client-trusted organization field. */
test('lead discovery workspace memberships scope users to their organizations', function () {
    $db = ci()->db; $now = gmdate('c');
    $db->insert('lead_organizations', ['id'=>'tenant-a','name'=>'Tenant A','created_at'=>$now]);
    $db->insert('lead_organizations', ['id'=>'tenant-b','name'=>'Tenant B','created_at'=>$now]);
    $db->insert('lead_organization_members', ['organization_id'=>'tenant-a','user_id'=>9001,'role'=>'owner','created_at'=>$now]);
    $db->insert('lead_organization_members', ['organization_id'=>'tenant-b','user_id'=>9002,'role'=>'member','created_at'=>$now]);
    $one = $db->where('user_id',9001)->get('lead_organization_members')->result_array();
    assert_equals(1, count($one));
    assert_equals('tenant-a', $one[0]['organization_id']);
    assert_equals(0, $db->where(['user_id'=>9001,'organization_id'=>'tenant-b'])->count_all_results('lead_organization_members'));
});
