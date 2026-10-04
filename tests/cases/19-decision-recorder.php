<?php
use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\SportsRepository;
use Aegis\Sports\DecisionRecorder;
test('sports decision recorder persists versioned traceable decision', function () {
 $repo = new SportsRepositoryStub(); $audit = new class implements AuditRepository { public array $events = []; public function emit(string $a, string $b, array $c = [], string $d = 'system'): void { $this->events[] = $a; } public function recent(int $a = 100): array { return []; } };
 $id = (new DecisionRecorder($repo, $audit))->recordPrediction(9, ['modelName' => 'M', 'modelVersion' => '1', 'featureVersion' => 'f', 'calibrationVersion' => 'c', 'decision' => 'PREDICTION_READY', 'market' => 'TOTAL', 'selection' => 'OVER', 'rawModelProbability' => .7, 'calibratedProbability' => .68], ['impliedProbability' => .6, 'expectedValue' => .1], ['classification' => 'LOW', 'reasons' => []], ['score' => 90], ['correlation' => 'LOW'], 88.0, 1.75, gmdate('c'), 'LOW');
 assert_contains('prd_', $id);
 $row = end($repo->predictions);
 assert_equals(9, $row['match_id']);
 assert_equals('PREDICTION_READY', $row['decision']);
 assert_equals(88.0, $row['confidence']);
 assert_equals(1.75, $row['odds']);
 assert_equals('SPORTS_DECISION_RECORDED', $audit->events[0]);
});
