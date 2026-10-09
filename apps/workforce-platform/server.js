/**
 * Canonical production entry point for the WINDELS AI WORKFORCE Node platform.
 *
 * Node core `http` only — no framework. This file owns the process lifecycle
 * (configuration, storage adapter, listener, shutdown); routing, security and
 * business rules live in `src/`.
 */

import path from "node:path";
import { loadConfig } from "./src/config.js";
import { createStoreFor } from "./src/persistence/index.js";
import { buildApp } from "./src/app.js";

const config = loadConfig(process.env);
const appRoot = path.resolve(process.env.WF_APP_ROOT || process.cwd());
const publicDir = process.env.WF_PUBLIC_DIR
  ? path.resolve(appRoot, process.env.WF_PUBLIC_DIR)
  : path.join(appRoot, "public");

const { store, pool, adapter } = await createStoreFor({ config, logger: console });
const app = await buildApp({ config, store, publicDir, adapter });

let closing = false;
async function shutdown(signal, exitCode = 0) {
  if (closing) return;
  closing = true;
  app.log.info({ signal, adapter }, "Shutting down Node platform");
  const failures = [];
  try {
    await app.close();
  } catch (error) {
    failures.push(error?.code || "HTTP_CLOSE_FAILED");
  }
  try {
    await pool?.end();
  } catch (error) {
    failures.push(error?.code || "POOL_CLOSE_FAILED");
  }
  if (failures.length) {
    app.log.error({ errorCode: failures.join(","), adapter }, "Shutdown encountered an error");
    process.exitCode = exitCode || 1;
    return;
  }
  if (exitCode) process.exitCode = exitCode;
}

// A logged fatal keeps Passenger/cPanel evidence; the process then exits so the
// supervisor can restart it rather than continue in an undefined state.
process.once("unhandledRejection", (reason) => {
  app.log.error({ errorCode: reason?.code || "UNHANDLED_REJECTION", message: reason?.message || String(reason) }, "Unhandled promise rejection");
  void shutdown("unhandledRejection", 1);
});
process.once("uncaughtException", (error) => {
  app.log.error({ errorCode: error?.code || "UNCAUGHT_EXCEPTION", message: error?.message }, "Uncaught exception");
  void shutdown("uncaughtException", 1);
});
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info({ address, adapter, node: process.versions.node, routes: app.routes().length }, "Node platform listening");
} catch (error) {
  app.log.error({ errorCode: error?.code || "STARTUP_ERROR", message: error?.message }, "Node platform failed to start");
  await shutdown("startupFailure", 1);
}

export { app, store, adapter };
