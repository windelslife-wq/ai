<?php
namespace Aegis\Sports;

/** Produces versioned features only from explicitly verified numeric inputs. */
class FeatureEngineeringEngine
{
    public const VERSION = 'sports-features-v1';
    public function build(array $intelligence): array
    {
        if (($intelligence['decision'] ?? '') !== 'INTELLIGENCE_READY') return ['ok' => false, 'reason' => 'INSUFFICIENT_DATA', 'version' => self::VERSION, 'features' => []];
        $form = $intelligence['inputs']['recentForm'] ?? null;
        foreach (['homeGoalsPerMatch', 'awayGoalsPerMatch', 'homeConcededPerMatch', 'awayConcededPerMatch'] as $key) {
            if (!is_array($form) || !isset($form[$key]) || !is_numeric($form[$key])) return ['ok' => false, 'reason' => 'INSUFFICIENT_DATA', 'version' => self::VERSION, 'features' => []];
        }
        $features = [
            'expectedGoalsProxy' => round(((float)$form['homeGoalsPerMatch'] + (float)$form['awayGoalsPerMatch'] + (float)$form['homeConcededPerMatch'] + (float)$form['awayConcededPerMatch']) / 2, 4),
            'homeAttack' => (float) $form['homeGoalsPerMatch'], 'awayAttack' => (float) $form['awayGoalsPerMatch'],
            'homeDefenseConceded' => (float) $form['homeConcededPerMatch'], 'awayDefenseConceded' => (float) $form['awayConcededPerMatch'],
        ];
        return ['ok' => true, 'version' => self::VERSION, 'features' => $features, 'inputSources' => ['recentForm' => $form['source'] ?? null]];
    }
}
