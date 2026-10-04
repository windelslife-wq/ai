import bcrypt from "bcryptjs";
import { createDatabase } from "./db.js";

const email = process.env.BOOTSTRAP_EMAIL?.trim().toLowerCase();
const password = process.env.BOOTSTRAP_PASSWORD;
const organizationName = process.env.BOOTSTRAP_ORGANIZATION?.trim() || "Lead Discovery";
if (!email || !password || password.length < 12) throw new Error("BOOTSTRAP_EMAIL and a BOOTSTRAP_PASSWORD of at least 12 characters are required");

const db = createDatabase();
try {
  const existingOrganization = await db.query("SELECT id FROM organizations WHERE name=$1 ORDER BY created_at ASC LIMIT 1", [organizationName]);
  const organization = existingOrganization.rows[0] ? existingOrganization : await db.query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [organizationName]);
  const organizationId = String(organization.rows[0]?.id);
  if (!organizationId || organizationId === "undefined") throw new Error("organization creation failed");
  const hash = await bcrypt.hash(password, 12);
  const user = await db.query("INSERT INTO users (email,password_hash,display_name) VALUES ($1,$2,$3) ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash,updated_at=now(),active=true RETURNING id", [email, hash, process.env.BOOTSTRAP_DISPLAY_NAME?.trim() || email]);
  const userId = String(user.rows[0]?.id);
  await db.query("INSERT INTO organization_members (organization_id,user_id,role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING", [organizationId, userId]);
  console.log(`Bootstrap owner ready: ${email} (${organizationName})`);
} finally { await db.end(); }
