import { makePool, passwordHash, utc } from "./db.js";
const [email] = process.argv.slice(2);
const password = process.env.FP_ADMIN_PASSWORD;
if (
  !email ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
  !password ||
  password.length < 16
) {
  console.error(
    "Usage: FP_ADMIN_PASSWORD=<private secret> node server/create-admin.js email (at least 16 chars; unset afterward)",
  );
  process.exit(1);
}
const db = makePool();
try {
  await db.execute(
    "INSERT INTO fp_users(email,password_hash,role,created_at) VALUES(?,?,'ADMIN',?)",
    [email.toLowerCase(), passwordHash(password), utc()],
  );
  console.log("Administrator created");
} finally {
  await db.end();
}
