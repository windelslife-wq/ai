import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireLeadAccess, type LeadPrincipal } from "../auth.js";

const UserCreateSchema = z.object({ email: z.string().trim().email().max(190), password: z.string().min(12).max(512), displayName: z.string().trim().min(1).max(120), role: z.enum(["admin", "member"]).default("member") });
const UserUpdateSchema = z.object({ active: z.boolean().optional(), role: z.enum(["admin", "member"]).optional(), displayName: z.string().trim().min(1).max(120).optional() }).refine(input => Object.keys(input).length > 0, { message: "at least one user field is required" });
const UserId = (request: FastifyRequest): string => {
  const value = (request.params as Record<string, string | undefined>).id;
  if (!value || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) throw Object.assign(new Error("invalid user id"), { statusCode: 400 });
  return value;
};
const admin = async (request: FastifyRequest): Promise<LeadPrincipal> => {
  const principal = await requireLeadAccess(request);
  if (!principal.permissions.includes("lead.admin")) throw Object.assign(new Error("administrator permission required"), { statusCode: 403 });
  return principal;
};

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/overview", async request => {
    const user = await admin(request);
    const [members, leads, collections, searches] = await Promise.all([
      app.db.query("SELECT COUNT(*)::int AS total FROM organization_members WHERE organization_id=$1", [user.organizationId]),
      app.db.query("SELECT COUNT(*)::int AS total FROM leads WHERE organization_id=$1", [user.organizationId]),
      app.db.query("SELECT COUNT(*)::int AS total FROM collections WHERE organization_id=$1", [user.organizationId]),
      app.db.query("SELECT COUNT(*)::int AS total FROM search_history WHERE organization_id=$1", [user.organizationId]),
    ]);
    return { organizationId: user.organizationId, members: Number(members.rows[0]?.total ?? 0), leads: Number(leads.rows[0]?.total ?? 0), collections: Number(collections.rows[0]?.total ?? 0), searches: Number(searches.rows[0]?.total ?? 0) };
  });

  app.get("/users", async request => {
    const user = await admin(request);
    const result = await app.db.query("SELECT u.id,u.email,u.display_name,u.active,u.created_at,u.updated_at,om.role FROM users u JOIN organization_members om ON om.user_id=u.id WHERE om.organization_id=$1 ORDER BY u.created_at ASC", [user.organizationId]);
    return { users: result.rows.map(row => ({ id: row.id, email: row.email, displayName: row.display_name, active: row.active === true, role: row.role, createdAt: row.created_at, updatedAt: row.updated_at })) };
  });

  app.post("/users", async request => {
    const principal = await admin(request); const input = UserCreateSchema.parse(request.body); const email = input.email.toLowerCase();
    const hash = await bcrypt.hash(input.password, 12);
    let account = await app.db.query("SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1", [email]);
    let userId: string;
    if (account.rows[0]) {
      userId = String(account.rows[0].id);
      const membership = await app.db.query("SELECT 1 FROM organization_members WHERE organization_id=$1 AND user_id=$2", [principal.organizationId, userId]);
      if (membership.rows[0]) throw Object.assign(new Error("that user is already a member of this organization"), { statusCode: 409 });
      await app.db.query("UPDATE users SET display_name=$1,active=true,updated_at=now() WHERE id=$2", [input.displayName, userId]);
    } else {
      account = await app.db.query("INSERT INTO users (email,password_hash,display_name,active) VALUES ($1,$2,$3,true) RETURNING id", [email, hash, input.displayName]);
      if (!account.rows[0]) throw new Error("user creation failed");
      userId = String(account.rows[0].id);
    }
    await app.db.query("INSERT INTO organization_members (organization_id,user_id,role) VALUES ($1,$2,$3)", [principal.organizationId, userId, input.role]);
    return { ok: true, user: { id: userId, email, displayName: input.displayName, active: true, role: input.role } };
  });

  app.patch("/users/:id", async request => {
    const principal = await admin(request); const userId = UserId(request); const input = UserUpdateSchema.parse(request.body);
    if (userId === principal.sub && input.active === false) throw Object.assign(new Error("you cannot deactivate your own administrator account"), { statusCode: 400 });
    const membership = await app.db.query("SELECT 1 FROM organization_members WHERE organization_id=$1 AND user_id=$2", [principal.organizationId, userId]);
    if (!membership.rows[0]) throw Object.assign(new Error("user is not a member of this organization"), { statusCode: 404 });
    if (input.active !== undefined || input.displayName !== undefined) {
      const updates: string[] = []; const values: unknown[] = [];
      if (input.active !== undefined) { values.push(input.active); updates.push(`active=$${values.length}`); }
      if (input.displayName !== undefined) { values.push(input.displayName); updates.push(`display_name=$${values.length}`); }
      values.push(userId); await app.db.query(`UPDATE users SET ${updates.join(",")},updated_at=now() WHERE id=$${values.length}`, values);
    }
    if (input.role !== undefined) await app.db.query("UPDATE organization_members SET role=$1 WHERE organization_id=$2 AND user_id=$3", [input.role, principal.organizationId, userId]);
    return { ok: true };
  });
}
