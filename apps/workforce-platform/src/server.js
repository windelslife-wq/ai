import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { createStore } from "./db/store.js";

const config = loadConfig(process.env);
const pool = createPool(config.database);
const store = createStore(pool);
const app = await buildApp({ config, store });

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "Shutting down Node platform");
  try {
    await app.close();
    await pool.end();
  } catch (error) {
    app.log.error({ err: error }, "Shutdown encountered an error");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, "Node platform failed to start");
  await pool.end();
  process.exitCode = 1;
}
