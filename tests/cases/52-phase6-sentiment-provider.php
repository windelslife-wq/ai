<?php
/**
 * Phase 6 — sentiment provider boundary (licensed-feeds increment 2 of 4).
 *
 * The SentimentFeed contract: per-observation provenance (source, timestamp,
 * license) + freshness validation (default 1h). The agent votes ONLY on
 * licensed, attributable, fresh data and abstains with an explained reason
 * otherwise — price action is never relabelled as sentiment.
 */
use Aegis\Agents\SentimentAgent;
use Aegis\Providers\SentimentFeed;
use Aegis\Providers\SentimentSnapshotValidator;
use Aegis\Providers\UnavailableSentimentFeed;

function fx_sentiment_ctx(): array
{
    return ['series' => ['symbol' => 'EURUSD', 'marketClass' => 'forex', 'candles' => [], 'provenance' => []], 'now' => (int) (microtime(true) * 1000)];
}

/** Stub licensed feed returning fixed observations (meta: id/source/licensed/available/reason). */
function fx_sentiment_feed(array $observations, array $meta = []): SentimentFeed
{
    return new class($observations, $meta) implements SentimentFeed {
        public function __construct(private array $observations, private array $meta) {}
        public function id(): string { return (string) ($this->meta['id'] ?? 'test-feed'); }
        public function health(): array { return ['state' => 'ONLINE', 'licensed' => true, 'message' => 'stub licensed feed']; }
        public function snapshot(string $symbol): array
        {
            return ['available' => (bool) ($this->meta['available'] ?? true), 'symbol' => strtoupper($symbol),
                'source' => $this->meta['source'] ?? 'test-news-wire', 'observedAt' => time(),
                'licensed' => (bool) ($this->meta['licensed'] ?? true),
                'observations' => $this->observations,
                'reason' => $this->meta['reason'] ?? null];
        }
    };
}

/** One normalized observation, aged `$ageSeconds` seconds. */
function fx_sent_obs(float $score, int $ageSeconds, string $channel = 'news', string $source = 'test-news-wire', int $sampleSize = 100): array
{
    return ['channel' => $channel, 'source' => $source, 'observedAt' => time() - $ageSeconds, 'score' => $score, 'sampleSize' => $sampleSize, 'headline' => 'stub headline'];
}

test('phase6 sentiment: boundary default abstains without a licensed feed', function () {
    $feed = new UnavailableSentimentFeed();
    assert_equals('unconfigured', $feed->id());
    assert_equals('UNCONFIGURED', $feed->health()['state']);
    assert_false($feed->health()['licensed']);
    $snap = $feed->snapshot('eurusd');
    assert_false($snap['available']);
    assert_equals('EURUSD', $snap['symbol']);

    $report = (new SentimentAgent())->analyze(fx_sentiment_ctx());
    assert_false($report['vote']['votes']);
    assert_equals('NEUTRAL', $report['vote']['signal']);
    assert_contains('abstain', $report['vote']['reason']);
    assert_equals('unconfigured', $report['provenance']['feed']);
    assert_false($report['news']['available']);
    assert_false($report['social']['available']);
    assert_equals(0.0, $report['dataQuality']);
});

test('phase6 sentiment: licensed fresh observations produce an attributed bounded vote', function () {
    $feed = fx_sentiment_feed([fx_sent_obs(0.4, 600, 'news'), fx_sent_obs(0.2, 900, 'social', 'test-social', 5000)]);
    $report = (new SentimentAgent($feed))->analyze(fx_sentiment_ctx());
    assert_true($report['vote']['votes'], 'fresh licensed data must vote');
    assert_close(0.3, $report['vote']['directionalScore'], 0.001);
    assert_equals('BUY', $report['vote']['signal']);
    assert_true($report['dataQuality'] > 0.0 && $report['dataQuality'] <= 1.0);
    assert_equals('test-news-wire', $report['provenance']['source']);
    assert_true($report['provenance']['licensed']);
    assert_equals('test-feed', $report['provenance']['feed']);
    assert_not_null($report['provenance']['observedAt']);
    assert_true($report['news']['available']);
    assert_true($report['social']['available']);
    assert_equals(1, count($report['news']['observations']));
    assert_equals('test-social', $report['social']['observations'][0]['source']);
});

test('phase6 sentiment: freshness validation rejects stale observations', function () {
    // all stale (2h old) -> abstain
    $all = fx_sentiment_feed([fx_sent_obs(0.4, 7200, 'news'), fx_sent_obs(0.5, 7200, 'social', 'test-social')]);
    $r1 = (new SentimentAgent($all))->analyze(fx_sentiment_ctx());
    assert_false($r1['vote']['votes']);
    assert_contains('STALE_OR_INCOMPLETE', $r1['vote']['reason']);

    // 1 stale + 2 fresh -> vote on the fresh ones, stale one excluded
    $mixed = fx_sentiment_feed([
        fx_sent_obs(0.4, 120, 'news'),
        fx_sent_obs(0.5, 7200, 'social', 'test-social'),
        fx_sent_obs(0.1, 300, 'news', 'test-news-wire-2'),
    ]);
    $r2 = (new SentimentAgent($mixed))->analyze(fx_sentiment_ctx());
    assert_true($r2['vote']['votes'], 'fresh observations still vote when a stale one is excluded');
    assert_close(0.25, $r2['vote']['directionalScore'], 0.001);
    assert_contains('excluded as stale', $r2['vote']['reason']);

    // custom staleness horizon is honored
    $v = new SentimentSnapshotValidator(600);
    $snap = ['available' => true, 'licensed' => true, 'source' => 'wire', 'observations' => [fx_sent_obs(0.2, 120), fx_sent_obs(0.2, 120)]];
    assert_true($v->validate($snap, time())['ok']);
    $staleSnap = ['available' => true, 'licensed' => true, 'source' => 'wire', 'observations' => [fx_sent_obs(0.2, 1200), fx_sent_obs(0.2, 1200)]];
    assert_false($v->validate($staleSnap, time())['ok']);
});

test('phase6 sentiment: unlicensed or unattributable data never votes', function () {
    $unlicensed = fx_sentiment_feed([fx_sent_obs(0.4, 60), fx_sent_obs(0.4, 60)], ['licensed' => false]);
    $r1 = (new SentimentAgent($unlicensed))->analyze(fx_sentiment_ctx());
    assert_false($r1['vote']['votes']);
    assert_contains('UNLICENSED', $r1['vote']['reason']);

    $noSource = fx_sentiment_feed([fx_sent_obs(0.4, 60), fx_sent_obs(0.4, 60)], ['source' => '']);
    $r2 = (new SentimentAgent($noSource))->analyze(fx_sentiment_ctx());
    assert_false($r2['vote']['votes']);
    assert_contains('NO_SOURCE', $r2['vote']['reason']);

    // observations missing source / out-of-range score / stale are all excluded
    $bad = fx_sentiment_feed([
        fx_sent_obs(0.4, 60),
        ['channel' => 'news', 'observedAt' => time(), 'score' => 0.4, 'sampleSize' => 10],
        ['channel' => 'news', 'source' => 'wire', 'observedAt' => time(), 'score' => 1.5, 'sampleSize' => 10],
        ['channel' => 'news', 'source' => 'wire', 'observedAt' => time() - 7200, 'score' => 0.4, 'sampleSize' => 10],
    ]);
    $r3 = (new SentimentAgent($bad))->analyze(fx_sentiment_ctx());
    assert_false($r3['vote']['votes']);
    assert_contains('STALE_OR_INCOMPLETE', $r3['vote']['reason']);
});

test('phase6 sentiment: engine accepts a sentiment feed and defaults to honest abstention', function () {
    $c = file_get_contents(FCPATH . 'application/libraries/Aegis/TradingIntelligenceEngine.php');
    assert_contains('?SentimentFeed $sentimentFeed = null', $c);
    assert_contains('new SentimentAgent($sentimentFeed ?? new UnavailableSentimentFeed())', $c);

    $f = file_get_contents(FCPATH . 'application/libraries/Aegis/Providers/SentimentFeed.php');
    assert_contains('interface SentimentFeed', $f);
    assert_contains('class UnavailableSentimentFeed', $f);
    assert_contains('class SentimentSnapshotValidator', $f);

    // feature matrix: the boundary is listed, but no LIVE sentiment provider is claimed
    // (CI controllers are route-loaded — require the file; its parent chain
    //  MY_Controller/Api_controller is already loaded because tools run through it)
    require_once FCPATH . 'application/controllers/Api_system.php';
    $names = array_map(fn($x) => $x['name'], Api_system::FEATURES);
    assert_true(in_array('Sentiment feed boundary (news/social)', $names, true), 'boundary row present in feature matrix');
    $live = array_filter(Api_system::FEATURES, fn($x) => str_contains($x['name'], 'sentiment provider') && str_contains($x['name'], 'live'));
    assert_true(count($live) === 0, 'no live sentiment provider is claimed in the feature matrix');
});
