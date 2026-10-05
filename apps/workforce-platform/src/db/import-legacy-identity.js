import { loadDatabaseConfig, loadLegacyDatabaseConfig } from "../config.js";
import { createPool } from "./pool.js";
import { createLegacyIdentityPlan, summarizeLegacyIdentityPlan, applyLegacyIdentityPlan } from "./legacy-identity.js";
import {
  readLegacyIdentitySnapshot,
  createMysqlLegacyIdentityTarget,
  findLegacyIdentityTargetConflicts,
} from "./mysql-legacy-identity.js";

const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => !["--dry-run", "--apply"].includes(arg)) || (args.has("--dry-run") && args.has("--apply"))) {
  console.error("Usage: npm run import:identity -- [--dry-run | --apply] (dry-run is the default)");
  process.exit(2);
}
const apply = args.has("--apply");
let targetPool;
let sourcePool;

try {
  targetPool = createPool(loadDatabaseConfig(process.env));
  sourcePool = createPool(loadLegacyDatabaseConfig(process.env));

  const [migrationRows] = await targetPool.execute(
    `SELECT migration_name FROM wf_schema_migrations
      WHERE migration_name IN (?, ?)`,
    ["001_platform_foundation", "002_identity_import_fields"],
  );
  if (migrationRows.length !== 2) {
    throw new Error("Node identity schema is not current; run npm run migrate --workspace=@windels/workforce-platform first");
  }

  const [completedImports] = await targetPool.execute(
    "SELECT import_key FROM wf_data_imports WHERE import_key = ? LIMIT 1",
    ["legacy_identity_v1"],
  );
  const alreadyImported = completedImports.length > 0;
  const [targetUserCountRows] = await targetPool.execute("SELECT COUNT(*) AS user_count FROM wf_users");
  const targetUsersBeforeImport = Number(targetUserCountRows[0]?.user_count ?? 0);
  const snapshot = await readLegacyIdentitySnapshot(sourcePool);
  const plan = createLegacyIdentityPlan(snapshot);
  const conflicts = alreadyImported ? [] : await findLegacyIdentityTargetConflicts(targetPool, plan);
  const summary = {
    ...summarizeLegacyIdentityPlan(plan),
    targetConflicts: conflicts.length,
    targetUsersBeforeImport,
    alreadyImported,
  };
  console.log(`${apply ? "APPLY" : "DRY RUN"} legacy identity import`);
  console.log(JSON.stringify(summary, null, 2));
  console.log("No credentials, password hashes, usernames, email addresses, or profile names are printed.");

  if (alreadyImported && apply) {
    throw new Error("This identity import was already completed; replay/delta imports are disabled.");
  }
  if (targetUsersBeforeImport > 0 && apply) {
    throw new Error("The Node identity target is not empty; no data was imported. Resolve existing accounts explicitly or use a new target database.");
  }
  if (conflicts.length && apply) {
    throw new Error(`${conflicts.length} target identity conflict(s) detected; no rows were changed. Resolve them explicitly, then rerun the dry run.`);
  }
  if (apply) {
    const result = await applyLegacyIdentityPlan(createMysqlLegacyIdentityTarget(targetPool), plan);
    console.log(`Committed identity import: ${JSON.stringify(result)}`);
  } else {
    console.log("No target rows were changed. Apply requires a reviewed backup and a clean target conflict check.");
  }
} catch (error) {
  console.error(`Legacy identity import failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await Promise.all([targetPool?.end(), sourcePool?.end()].filter(Boolean));
}
