import { makePool } from "../db.js";
import { runJob } from "./sync.js";
const pool = makePool();
try {
  console.log(JSON.stringify(await runJob(pool, process.argv[2])));
} catch (e) {
  console.error(e.code || e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
