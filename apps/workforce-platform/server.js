import path from "node:path";
import { createPool } from "./src/db/pool.js";
import { createStore } from "./src/db/store.js";
import { loadConfig } from "./src/config.js";
import { buildApp } from "./src/app.js";

const config = loadConfig(process.env);
const appRoot = path.resolve(process.env.WF_APP_ROOT || process.cwd());
const publicDir = process.env.WF_PUBLIC_DIR
  ? path.resolve(appRoot, process.env.WF_PUBLIC_DIR)
  : path.join(appRoot, "public");
const pool = createPool(config.database);
const store = createStore(pool);
const app = await buildApp({ config, store, publicDir });

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "Shutting down Node platform");
  try {
    await app.close();
    await pool.end();
  } catch (error) {
    app.log.error({ errorCode: error?.code || "SHUTDOWN_ERROR" }, "Shutdown encountered an error");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info({ address }, "Node platform listening");
} catch (error) {
  app.log.error({ errorCode: error?.code || "STARTUP_ERROR" }, "Node platform failed to start");
  await pool.end();
  process.exitCode = 1;
}
