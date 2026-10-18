/**
 * Regenerates the analysis parity golden file from the **real PHP
 * implementation**, running `Aegis\Indicators` and `Aegis\MathUtils` in WASM
 * PHP 8.2.
 *
 * This extends the F-26 differential harness to the analysis module, with the
 * same contract as the sports slices: the Node port
 * (`src/modules/analysis/indicators.js`, plus the `MathUtils` half that Phase 4
 * placed in `market-data/normalize.js` and the formatting verbs in
 * `analysis/math.js`) is recomputed in `test/analysis_parity.test.js` against
 * this file's output and required to agree exactly.
 *
 * Usage: `node runtime/analysis-parity.mjs`
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNodeRuntime, useHostFilesystem } from "@php-wasm/node";
import { PHP, ProcessIdAllocator } from "@php-wasm/universal";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(APP_ROOT, "runtime", "parity", "analysis-golden.php");
const OUT = path.join(APP_ROOT, "apps", "workforce-platform", "test", "fixtures", "analysis-parity-golden.json");

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
// between hosts running the same PHP major/minor, so it is normalized here
// rather than in the generator: the golden file is an input to a test, and a
// test input that changes when nobody changed any code is not a test input.
payload.php = { version: "8.2 (normalized)", sapi: String(payload.php?.sapi ?? "unknown") };

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`analysis parity golden written: ${OUT} (${payload.cases.length} cases)`);
// The WASM runtime keeps the event loop alive after the run finishes; the file
// is the sole purpose, so exit once it is written rather than outlive the job.
process.exit(0);
