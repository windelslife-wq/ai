/**
 * Runs the PHP test suite (tools/tests through CodeIgniter) inside WASM PHP.
 * Equivalent on a native host: `php index.php tools tests`.
 */
import path from 'node:path';
import { loadNodeRuntime, useHostFilesystem } from '@php-wasm/node';
import { PHP, ProcessIdAllocator } from '@php-wasm/universal';

const APP_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
process.env.AEGIS_DB_DRIVER = 'pdo_sqlite';
// Tests use a THROWAWAY database so they never pollute the demo data.
import fs from 'node:fs';
const TEST_DB = path.join(APP_ROOT, 'application', 'data', 'aegis-test.sqlite');
process.env.AEGIS_SQLITE_PATH = TEST_DB;
// Tests assume a pristine database — remove the throwaway file so state from
// a previous run (strategies mid-lifecycle, alert baselines…) cannot leak.
fs.rmSync(TEST_DB, { force: true });

const allocator = new ProcessIdAllocator();
const runtime = await loadNodeRuntime(process.env.PHP_VERSION ?? '8.2', {
  emscriptenOptions: { processId: allocator.claim() },
});
const php = new PHP(runtime);
useHostFilesystem(php);

const root = APP_ROOT.replaceAll("'", "\\'");
const code = `<?php
chdir('${root}');
putenv('AEGIS_DB_DRIVER=pdo_sqlite');
putenv('AEGIS_SQLITE_PATH=${process.env.AEGIS_SQLITE_PATH.replaceAll("'", "\\'")}');
ini_set('display_errors', '1');
error_reporting(E_ALL & ~E_DEPRECATED & ~E_NOTICE & ~E_WARNING);
// php-wasm runs with PHP_SAPI='wasm' — defining STDIN makes CI3's is_cli() true.
define('STDIN', fopen('php://stdin', 'r'));
define('STDOUT', fopen('php://stdout', 'w'));
define('STDERR', fopen('php://stderr', 'w'));
register_shutdown_function(function () {
  $e = error_get_last();
  while (ob_get_level() > 0) { @ob_end_flush(); }
  if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
    echo "FATAL: {$e['message']} @ {$e['file']}:{$e['line']}\n";
  }
});
$_SERVER['argv'] = ['index.php', 'tools', 'tests'];
$_SERVER['argc'] = 3;
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
// Install the schema into the (throwaway) test database first.
require '${root}/tools/install.php';
try {
  require '${root}/index.php';
} catch (Throwable $e) {
  while (ob_get_level() > 0) { @ob_end_flush(); }
  echo 'CAUGHT ' . get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine() . PHP_EOL;
  echo $e->getTraceAsString() . PHP_EOL;
}
`;

const result = await php.run({ code }).catch((e) => ({ text: (e.response?.text ?? '') + '\nRUN-THREW: ' + e.message.slice(0, 400) }));
console.log(result.text);
const m = /TESTS-RESULT:\s*(\d+)/.exec(result.text ?? '');
const fails = m ? Number(m[1]) : 99;
const inst = /INSTALL-RESULT:\s*(\d+)/.exec(result.text ?? '');
if (inst && inst[1] !== '0') process.exit(2);
process.exit(fails > 0 ? 1 : 0);
