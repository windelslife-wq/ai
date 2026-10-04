import { makePool, migrate } from "./db.js";
const pool = makePool();
try {
  await migrate(pool);
  console.log("Migration complete");
} finally {
  await pool.end();
}
