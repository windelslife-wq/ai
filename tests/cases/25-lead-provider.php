<?php
require_once APPPATH . 'libraries/LeadDiscovery/LeadDiscoveryProvider.php';
require_once APPPATH . 'libraries/LeadDiscovery/ProviderException.php';
require_once APPPATH . 'libraries/LeadDiscovery/GooglePlacesProvider.php';
require_once APPPATH . 'libraries/LeadDiscovery/ProviderRegistry.php';

class StagedGooglePlacesProvider extends \LeadDiscovery\GooglePlacesProvider {
    protected function post(string $payload): array { return ['places'=>[['id'=>'stable-place-id','displayName'=>['text'=>'Lagos Kitchen'],'formattedAddress'=>'12 Marina, Lagos','types'=>['restaurant','food'],'nationalPhoneNumber'=>'+234 1 555 0100','websiteUri'=>'https://lagoskitchen.example','location'=>['latitude'=>6.45,'longitude'=>3.39]]]]; }
}
test('Google Places provider normalizes stable provider fields into lead contract', function () {
    $provider=new StagedGooglePlacesProvider('test-key'); $rows=$provider->searchBusinesses(['query'=>'Restaurants in Lagos']);
    assert_equals(1,count($rows)); assert_equals('stable-place-id',$rows[0]['sourceId']); assert_equals('Lagos Kitchen',$rows[0]['name']); assert_equals('restaurant, food',$rows[0]['category']); assert_close(6.45,$rows[0]['latitude'],0.00001); assert_equals('Google Places',$rows[0]['metadata']['provider']);
});
test('provider registry only reports actually implemented adapters', function () {
    $registry=new \LeadDiscovery\ProviderRegistry([new StagedGooglePlacesProvider('test-key')]);
    $health=$registry->health(); assert_equals(1,count($health)); assert_equals('google_places',$health[0]['name']); assert_equals('IMPLEMENTED',$health[0]['status']);
    assert_throws(\LeadDiscovery\ProviderException::class,fn()=>$registry->get('future_provider'));
});
