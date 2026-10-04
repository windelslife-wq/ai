<?php
/** Minimal dotenv loader for shared hosting. No Composer, CLI, or server env setup required. */
function vp_load_env(string $path): void
{
    if (!is_readable($path)) return;
    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) continue;
        [$key, $value] = explode('=', $line, 2);
        $key = trim($key); $value = trim($value);
        if ($key === '' || preg_match('/[^A-Z0-9_]/', $key)) continue;
        if ((str_starts_with($value, '"') && str_ends_with($value, '"')) || (str_starts_with($value, "'") && str_ends_with($value, "'"))) $value = substr($value, 1, -1);
        // Real server environment variables take precedence over the file.
        if (getenv($key) === false) { putenv($key . '=' . $value); $_ENV[$key] = $value; }
    }
}
