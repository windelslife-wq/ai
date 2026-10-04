<?php
namespace Aegis\LangLearn;

/**
 * CEFR curriculum templates — the skeleton of a learning path. Shared across
 * languages (module content is drawn from the language's item bank at the
 * module's level), so adding a language to the registry immediately yields a
 * path wherever the bank can support it.
 */
final class Curriculum
{
    /** @return array<int, array{code:string,title:string,focus:string,level:string}> */
    public static function modulesFor(string $fromLevel, string $toLevel): array
    {
        $levels = [];
        foreach (LanguageRegistry::LEVELS as $lv) {
            if (LanguageRegistry::levelIndex($lv) >= LanguageRegistry::levelIndex($fromLevel)
                && LanguageRegistry::levelIndex($lv) <= LanguageRegistry::levelIndex($toLevel)
                && $lv !== 'Beginner') {
                $levels[] = $lv;
            }
        }
        if (!$levels) $levels = [$fromLevel !== 'Beginner' ? $fromLevel : 'A1'];

        $modules = [];
        foreach ($levels as $lv) {
            foreach (self::TEMPLATE[$lv] ?? [] as $t) {
                $modules[] = ['code' => "{$lv}-{$t['code']}", 'title' => $t['title'], 'focus' => $t['focus'], 'level' => $lv];
            }
        }
        return $modules;
    }

    private const TEMPLATE = [
        'A1' => [
            ['code' => 'greetings', 'title' => 'Greetings and introductions', 'focus' => 'vocabulary'],
            ['code' => 'numbers-basics', 'title' => 'Numbers and everyday basics', 'focus' => 'vocabulary'],
            ['code' => 'simple-sentences', 'title' => 'Simple sentences (I am, you have)', 'focus' => 'grammar'],
            ['code' => 'first-readings', 'title' => 'First readings: who am I, where do I live', 'focus' => 'reading'],
        ],
        'A2' => [
            ['code' => 'people-places', 'title' => 'People, family and places', 'focus' => 'vocabulary'],
            ['code' => 'present-tense', 'title' => 'Everyday actions in the present', 'focus' => 'grammar'],
            ['code' => 'possession', 'title' => 'Whose is it? Possession and articles', 'focus' => 'grammar'],
            ['code' => 'daily-life', 'title' => 'Daily life readings', 'focus' => 'reading'],
        ],
        'B1' => [
            ['code' => 'past-tense', 'title' => 'Talking about the past', 'focus' => 'grammar'],
            ['code' => 'conditionals', 'title' => 'What if — conditions and wishes', 'focus' => 'grammar'],
            ['code' => 'opinions', 'title' => 'Opinions and longer readings', 'focus' => 'reading'],
        ],
        // B2/C1/C2 module templates arrive with deeper banks (Phases 2+).
    ];
}
