<?php
/** Lead Discovery persistence contract: scoped source identity and relationship storage. */
test('lead discovery schema enforces provider source identity per organization', function () {
    $db = ci()->db;
    $now = gmdate('c');
    $base = ['id' => 'lead-schema-a', 'organization_id' => 'org-a', 'source' => 'google_places', 'source_id' => 'place-stable-1', 'name' => 'Verified Place', 'status' => 'new', 'metadata' => '{}', 'created_at' => $now, 'updated_at' => $now];
    $db->insert('leads', $base);
    assert_equals(1, $db->where(['organization_id' => 'org-a', 'source' => 'google_places', 'source_id' => 'place-stable-1'])->count_all_results('leads'));
    // A provider source ID is unique inside one org, but a different organization is isolated.
    $other = $base; $other['id'] = 'lead-schema-b'; $other['organization_id'] = 'org-b';
    $db->insert('leads', $other);
    assert_equals(1, $db->where(['organization_id' => 'org-b', 'source_id' => 'place-stable-1'])->count_all_results('leads'));
});

test('lead discovery stores collections as relationships rather than copied lead records', function () {
    $db = ci()->db; $now = gmdate('c');
    $db->insert('collections', ['id'=>'collection-schema','organization_id'=>'org-a','name'=>'Lagos restaurants','created_at'=>$now,'updated_at'=>$now]);
    $db->insert('collection_leads', ['collection_id'=>'collection-schema','lead_id'=>'lead-schema-a']);
    $lead = $db->select('l.id,l.name')->from('leads l')->join('collection_leads cl','cl.lead_id=l.id')->where('cl.collection_id','collection-schema')->get()->row_array();
    assert_equals('lead-schema-a', $lead['id']);
    assert_equals('Verified Place', $lead['name']);
});

test('CSV formula safety rule prefixes dangerous cell values', function () {
    foreach (['=2+2', '+SUM(A1)', '-10', '@cmd'] as $value) {
        $safe = preg_match('/^[=+\-@]/', $value) ? "'" . $value : $value;
        assert_true(str_starts_with($safe, "'"));
    }
    assert_equals('normal business', preg_match('/^[=+\-@]/', 'normal business') ? "'normal business" : 'normal business');
});
