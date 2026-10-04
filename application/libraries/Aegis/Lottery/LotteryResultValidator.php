<?php
namespace Aegis\Lottery;

/**
 * WINDELS Lottery Intelligence — Phase 7 (spec §6): data validation.
 *
 * Every imported draw must pass ALL checks before it may be stored as
 * official data. Failed draws are marked DATA_VALIDATION_FAILED and audited;
 * they are never inserted as official results.
 */
final class LotteryResultValidator
{
    public const STATUS_VALID = 'VALID';
    public const STATUS_FAILED = 'DATA_VALIDATION_FAILED';

    public function __construct(private LotteryRules $rules) {}

    /** @return array{valid:bool,status:string,errors:list<string>} */
    public function validate(array $draw): array
    {
        $errors = [];

        $externalId = trim((string) ($draw['externalId'] ?? ''));
        if ($externalId === '') {
            $errors[] = 'missing draw ID (externalId)';
        }

        $date = (string) ($draw['drawDate'] ?? '');
        if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $date, $m)
            || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
            $errors[] = 'invalid draw date: ' . ($date === '' ? '(missing)' : $date);
        }

        $main = $this->asInts($draw['main'] ?? null, 'main');
        $stars = $this->asInts($draw['stars'] ?? null, 'Lucky Star');

        $source = trim((string) ($draw['source'] ?? ''));
        if ($source === '') {
            $errors[] = 'missing source attribution — no draw may be stored without a source';
        }
        if (trim((string) ($draw['sourceTimestamp'] ?? '')) === '') {
            $errors[] = 'missing source timestamp';
        }

        $line = $this->rules->validateLine($main, $stars);
        $errors = array_merge($errors, $line['errors']);

        return [
            'valid' => $errors === [],
            'status' => $errors === [] ? self::STATUS_VALID : self::STATUS_FAILED,
            'errors' => $errors,
        ];
    }

    /** Coerce a number list to ints; non-numeric entries become -1 (always out of range). */
    private function asInts($values, string $label): array
    {
        if (!is_array($values)) {
            return [];
        }
        $out = [];
        foreach ($values as $v) {
            if (is_int($v)) $out[] = $v;
            elseif (is_numeric($v)) $out[] = (int) $v;
            else $out[] = -1;
        }
        return $out;
    }
}
