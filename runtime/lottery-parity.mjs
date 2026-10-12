#!/usr/bin/env node
/**
 * Regenerate the lottery parity golden: run the PHP harness in the local WASM
 * runtime and commit its output as the fixture the Node tests compare against.
 *
 *   node runtime/lottery-parity.mjs
 *
 * The legacy tree is never written. The emitted JSON is PHP's own answer; the
 * test file asserts the Node port reproduces it, divergence by divergence.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNodeRuntime, useHostFilesystem } from "@php-wasm/node";
import { PHP, ProcessIdAllocator } from "@php-wasm/universal";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(APP_ROOT, "runtime", "parity", "lottery-golden.php");
const OUT = path.join(APP_ROOT, "apps", "workforce-platform", "test", "fixtures", "lottery-parity-golden.json");

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
// The harness itself manages the sandbox opt-in per case (set, then withdrawn);
// nothing needs to be set here.
require '${script}';
`;

const result = await php.run({ code }).catch((error) => ({
  text: `${error.response?.text ?? ""}\nRUN-THREW: ${String(error.message).slice(0, 400)}`,
  errors: error.errors,
}));

const text = String(result.text ?? "");
if (!text.trimStart().startsWith("{")) {
  console.error("the generator did not emit a JSON document:\n");
  console.error(text.slice(0, 4000));
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(text.slice(text.indexOf("{")));
} catch (error) {
  console.error("the generator emitted unparseable JSON:\n");
  console.error(text.slice(0, 4000));
  console.error(`\n${String(error.message)}`);
  process.exit(1);
}

// Same normalization as the sports golden: the patch version of the embedded PHP
// must not make the fixture differ between hosts that run the same 8.2 line.
payload.php = { version: "8.2 (normalized)", sapi: String(payload.php?.sapi ?? "unknown") };

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

const cases = payload.cases ?? {};
const counts = {
  rules: Object.keys(cases.rules ?? {}).length,
  validator: Object.keys(cases.validator ?? {}).length,
  statistics: Object.keys(cases.statistics ?? {}).length,
  prng: Object.keys(cases.prng ?? {}).length,
  sandbox: Object.keys(cases.sandbox ?? {}).length,
  official: Object.keys(cases.official ?? {}).length,
  unavailable: Object.keys(cases.unavailable ?? {}).length,
  combinations: Object.keys(cases.combinations ?? {}).length,
  tickets: Object.keys(cases.tickets ?? {}).length,
};
console.log(`wrote ${path.relative(APP_ROOT, OUT)}`);
console.log(`cases: ${JSON.stringify(counts)}`);
// The PHP WASM runtime keeps the event loop alive; exit explicitly.
process.exit(0);
