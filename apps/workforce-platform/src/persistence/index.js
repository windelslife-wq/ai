/**
 * Storage adapter boundary.
 *
 * `STORAGE_ADAPTER` selects the persistence implementation:
 *   auto   — mysql when the DB_* variables are present, otherwise file (never in production)
 *   mysql  — the production adapter (MySQL/MariaDB through the bounded pool)
 *   file   — durable JSONL store for local development, tests and demos
 *
 * The file adapter refuses to run in production unless it is explicitly
 * acknowledged, because it has no transactions and no cross-process locking.
 * In-memory storage is not offered at all: it would silently lose data.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createPool } from "../db/pool.js";
import { createStore } from "../db/store.js";
import { createFileStore } from "./file-store.js";
import { assertRepositoryContract } from "./contract.js";

export const SUPPORTED_ADAPTERS = Object.freeze(["auto", "mysql", "file"]);

export function resolveAdapter({ storage, databaseConfigured }) {
  if (storage.adapter === "mysql") return "mysql";
  if (storage.adapter === "file") return "file";
  return databaseConfigured ? "mysql" : "file";
}

/**
 * @returns {Promise<{store: object, pool: {end: Function}|null, adapter: string}>}
 */
export async function createStoreFor({ config, logger = console }) {
  const databaseConfigured = Boolean(config.database?.host && config.database?.name && config.database?.user);
  const adapter = resolveAdapter({ storage: config.storage, databaseConfigured });

  if (adapter === "mysql") {
    if (!databaseConfigured) {
      throw new Error("STORAGE_ADAPTER=mysql requires DB_HOST, DB_NAME and DB_USER to be set");
    }
    const pool = createPool(config.database);
    // Both adapters are checked here, at start-up: an adapter that is missing a
    // method the routes need must fail now, not on the first request that needs it.
    return { store: assertRepositoryContract(createStore(pool), { adapter }), pool, adapter };
  }

  if (config.production && !config.storage.allowFileStoreInProduction) {
    throw new Error(
      "The file storage adapter is not a production database. Configure MySQL (DB_* + STORAGE_ADAPTER=mysql) "
      + "or set ALLOW_FILE_STORE_IN_PRODUCTION=1 to acknowledge single-process durability limits.",
    );
  }

  const directory = path.resolve(config.storage.fileDir);
  await mkdir(directory, { recursive: true });
  const store = await createFileStore({
    dir: directory,
    logger: {
      warn: (fields) => logger.warn?.(fields),
    },
  });
  if (config.production) {
    logger.warn?.({ message: "Running the production application on the file storage adapter — single process only, no transactions" });
  }
  return { store: assertRepositoryContract(store, { adapter }), pool: null, adapter };
}
