import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = path.dirname(fileURLToPath(import.meta.url));
const executable = process.platform === "win32" ? "vite.cmd" : "vite";
const child = spawn(executable, ["build"], {
  cwd: path.resolve(directory, ".."),
  env: { ...process.env, CAPACITOR_BUILD: "1" },
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.once("error", (error) => {
  console.error(`Unable to start the native Vite build: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Native Vite build terminated by ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
