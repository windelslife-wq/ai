<?php
namespace Aegis\LangLearn;

/**
 * LANGUAGE REGISTRY — the single source of truth for the language catalog.
 * Nothing else in the application hard-codes languages: controllers, views,
 * services and the DB seed all read from here. New languages are added by
 * registering them (or seeding a row synced from this catalog).
 *
 * Honesty rules (module-wide): `assessmentBank` reflects the real number of
 * authored assessment items for that language; features list what is
 * actually implemented for it. No language may claim capabilities it does
 * not have, and no level may be reported beyond the bank's ceiling.
 */
final class LanguageRegistry
{
    public const LEVELS = ['Beginner', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

    /** @var array<string, array> keyed by ISO code */
    private static ?array $catalog = null;

    public static function all(): array
    {
        if (self::$catalog === null) self::$catalog = self::build();
        return self::$catalog;
    }

    public static function get(string $code): ?array
    {
        return self::all()[strtolower(trim($code))] ?? null;
    }

    /** Runtime extension point — new languages without a code change elsewhere. */
    public static function register(array $language): void
    {
        $code = strtolower(trim((string) ($language['code'] ?? '')));
        if (!preg_match('/^[a-z]{2,3}$/', $code)) {
            throw new \InvalidArgumentException('language code must be 2-3 letters');
        }
        $language['code'] = $code;
        $language['direction'] = in_array($language['direction'] ?? 'ltr', ['ltr', 'rtl'], true) ? $language['direction'] : 'ltr';
        $language['assessment_bank'] = ItemBanks::count($code);
        $language['features'] = [
            'registry' => true,
            'adaptive_assessment' => $language['assessment_bank'] > 0,
            'assessment_ceiling' => ItemBanks::ceiling($code),
            'lessons' => false, 'conversation' => false, 'writing_correction' => false,
            'vocabulary_srs' => false, 'listening' => false, 'speaking' => false,
        ];
        $language['active'] = (bool) ($language['active'] ?? true);
        self::$catalog ??= self::build();
        self::$catalog[$code] = $language;
    }

    public static function isLevel(string $level): bool
    {
        return in_array($level, self::LEVELS, true);
    }

    public static function levelIndex(string $level): int
    {
        $i = array_search($level, self::LEVELS, true);
        return $i === false ? 0 : (int) $i;
    }

    private static function build(): array
    {
        $mk = fn(string $code, string $name, string $native, string $script, string $dir = 'ltr'): array => [
            'code' => $code, 'name' => $name, 'native_name' => $native, 'iso_code' => $code,
            'writing_system' => $script, 'direction' => $dir,
        ];
        $langs = [
            $mk('nl', 'Dutch', 'Nederlands', 'latin'),
            $mk('es', 'Spanish', 'Español', 'latin'),
            $mk('it', 'Italian', 'Italiano', 'latin'),
            $mk('fr', 'French', 'Français', 'latin'),
            $mk('de', 'German', 'Deutsch', 'latin'),
            $mk('en', 'English', 'English', 'latin'),
            $mk('pt', 'Portuguese', 'Português', 'latin'),
            $mk('ar', 'Arabic', 'العربية', 'arabic', 'rtl'),
            $mk('zh', 'Chinese (Mandarin)', '中文', 'han'),
            $mk('ja', 'Japanese', '日本語', 'kana'),
            $mk('ko', 'Korean', '한국어', 'hangul'),
            $mk('ru', 'Russian', 'Русский', 'cyrillic'),
            $mk('hi', 'Hindi', 'हिन्दी', 'devanagari'),
            $mk('tr', 'Turkish', 'Türkçe', 'latin'),
            $mk('sw', 'Swahili', 'Kiswahili', 'latin'),
            $mk('yo', 'Yoruba', 'Yorùbá', 'latin'),
            $mk('ig', 'Igbo', 'Igbo', 'latin'),
            $mk('ha', 'Hausa', 'Hausa', 'latin'),
            $mk('af', 'Afrikaans', 'Afrikaans', 'latin'),
            $mk('zu', 'Zulu', 'isiZulu', 'latin'),
        ];
        $catalog = [];
        foreach ($langs as $l) {
            $l['assessment_bank'] = ItemBanks::count($l['code']);
            // Feature truth table for the CURRENT build: adaptive assessment
            // runs wherever a bank exists; listening/speaking/writing practice
            // arrive in later phases and must not be claimed yet.
            $l['features'] = [
                'registry' => true,
                'adaptive_assessment' => $l['assessment_bank'] > 0,
                'assessment_ceiling' => ItemBanks::ceiling($l['code']), // highest verifiable level
                'lessons' => false,            // Phase 2 (AI Teacher)
                'conversation' => false,       // Phase 2
                'writing_correction' => false, // Phase 2
                'vocabulary_srs' => false,     // Phase 3
                'listening' => false,          // Phase 4 (needs an audio provider)
                'speaking' => false,           // Phase 4 (needs a speech provider — scores never invented)
            ];
            $l['active'] = true;
            $catalog[$l['code']] = $l;
        }
        return $catalog;
    }
}
