/**
 * Regenerates the sports parity golden file from the **real PHP implementation**,
 * running the legacy classes in WASM PHP 8.2.
 *
 * This is the executable half of the differential harness that finding F-26 has
 * asked for since Phase 4: `apps/workforce-platform/test/sports_parity.test.js`
 * recomputes every case in
 * `apps/workforce-platform/test/fixtures/sports-parity-golden.json` with the Node
 * port and asserts the two agree exactly. The golden file is PHP's own output, so
 * the Node test is not asserting against a transcription of what PHP was believed
 * to do — it is asserting against what PHP did.
 *
 * Usage: `node runtime/sports-parity.mjs`
 *
 * The legacy tree is read, never written: the generator script lives under
 * `runtime/parity/` and `require`s six class files by path.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNodeRuntime, useHostFilesystem } from "@php-wasm/node";
import { PHP, ProcessIdAllocator } from "@php-wasm/universal";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(APP_ROOT, "runtime", "parity", "sports-golden.php");
const OUT = path.join(APP_ROOT, "apps", "workforce-platform", "test", "fixtures", "sports-parity-golden.json");

if (!fs.existsSync(SCRIPT)) {
  console.error(`missing generator: ${SCRIPT}`);
  process.exit(2);
}

const allocator = new ProcessIdAllocator();
const runtime = await loadNodeRuntime(process.env.PHP_VERSION ?? "8.2", {
  emscriptenOptions: { processId: allocator.claim() },
});
const php = new PHP(runtime);
useHostFilesystem(php);

const script = SCRIPT.replaceAll("'", "\\'");
const code = `<?php
ini_set('display_errors', '1');
error_reporting(E_ALL & ~E_DEPRECATED & ~E_NOTICE & ~E_WARNING);
// The sandbox provider reads these at construction. The generator also withdraws
// the opt-in temporarily to capture the refusal path, so both are set here rather
// than only inside the script.
putenv('WINDELS_SPORTS_MODE=SANDBOX');
putenv('WINDELS_SPORTS_SANDBOX=1');
require '${script}';
`;

const result = await php.run({ code }).catch((error) => ({
  text: `${error.response?.text ?? ""}\nRUN-THREW: ${String(error.message).slice(0, 400)}`,
  errors: error.errors,
}));

const text = String(result.text ?? "");
if (text.includes("RUN-THREW") || text.includes("FATAL") || text.includes("Warning:")) {
  console.error(text);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(text);
} catch (error) {
  console.error("the generator did not emit valid JSON:\n");
  console.error(text.slice(0, 4000));
  console.error(`\n${String(error.message)}`);
  process.exit(1);
}

// The PHP version is recorded for provenance but must not make the file differ
// between hosts running the same PHP major/minor, so it is normalized here rather
// than in the generator: the golden file is an input to a test, and a test input
// that changes when nobody changed any code is not a test input.
payload.php = { version: "8.2 (normalized)", sapi: String(payload.php?.sapi ?? "unknown") };

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

const cases = payload.cases ?? {};
const counts = {
  fixture: Object.keys(cases.fixture ?? {}).length,
  odds: Object.keys(cases.odds ?? {}).length,
  quality: Object.keys(cases.quality ?? {}).length,
  freshness: Object.keys(cases.freshness ?? {}).length,
  sandboxFixtures: cases.sandbox?.fixtureCount ?? 0,
};
console.log(`wrote ${path.relative(APP_ROOT, OUT)}`);
console.log(`cases: ${JSON.stringify(counts)}`);
// The PHP WASM runtime keeps the event loop alive after the payload is written, so the
// process must exit explicitly. Without it the run hangs until the caller's timeout kills it.
process.exit(0);
