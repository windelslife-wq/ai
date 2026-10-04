import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
const LoginSchema = z.object({ email: z.string().trim().email().max(190), password: z.string().min(1).max(512), organizationId: z.string().uuid().optional() });
const RefreshSchema = z.object({ refreshToken: z.string().min(40).max(256) });
const permissionsFor = (role: string) => role === "owner" ? ["lead.read", "lead.write", "lead.admin"] : role === "admin" ? ["lead.read", "lead.write", "lead.admin"] : ["lead.read"];
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const issue = async (app: FastifyInstance, user: { id: string; email: string; displayName: string | null }, membership: { organizationId: string; role: string }) => { const permissions = permissionsFor(membership.role); const token = app.jwt.sign({ sub: user.id, organizationId: membership.organizationId, permissions }, { expiresIn: "15m" }); const refreshToken = randomBytes(48).toString("base64url"); const result = await app.db.query("INSERT INTO refresh_tokens (user_id,organization_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '30 days') RETURNING id", [user.id,membership.organizationId,tokenHash(refreshToken)]); return { token, refreshToken, refreshTokenId: result.rows[0]?.id, user, organizationId: membership.organizationId, permissions }; };
export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/login", async request => {
    const input = LoginSchema.parse(request.body); const result = await app.db.query("SELECT id,email,password_hash,display_name,active FROM users WHERE lower(email)=lower($1) LIMIT 1", [input.email]); const account = result.rows[0];
    if (!account || account.active !== true || typeof account.password_hash !== "string" || !(await bcrypt.compare(input.password, account.password_hash))) throw Object.assign(new Error("invalid email or password"), { statusCode: 401 });
    const memberships = await app.db.query("SELECT organization_id,role FROM organization_members WHERE user_id=$1", [account.id]); const row = input.organizationId ? memberships.rows.find(item => item.organization_id === input.organizationId) : memberships.rows[0]; if (!row) throw Object.assign(new Error("no organization membership available"), { statusCode: 403 });
    return issue(app, { id: String(account.id), email: String(account.email), displayName: account.display_name as string | null }, { organizationId: String(row.organization_id), role: String(row.role) });
  });
  app.post("/refresh", async request => { const { refreshToken } = RefreshSchema.parse(request.body); const consumed = await app.db.query("UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() RETURNING id,user_id,organization_id", [tokenHash(refreshToken)]); const token = consumed.rows[0]; if (!token) throw Object.assign(new Error("invalid or expired refresh token"), { statusCode: 401 }); const user = await app.db.query("SELECT id,email,display_name,active FROM users WHERE id=$1", [token.user_id]); const membership = await app.db.query("SELECT role FROM organization_members WHERE user_id=$1 AND organization_id=$2", [token.user_id,token.organization_id]); if (!user.rows[0] || user.rows[0].active !== true || !membership.rows[0]) throw Object.assign(new Error("session is no longer authorized"), { statusCode: 401 }); const next = await issue(app, { id: String(user.rows[0].id), email: String(user.rows[0].email), displayName: user.rows[0].display_name as string | null }, { organizationId: String(token.organization_id), role: String(membership.rows[0].role) }); await app.db.query("UPDATE refresh_tokens SET replaced_by=$1 WHERE id=$2", [next.refreshTokenId,token.id]); return next; });
  app.post("/logout", async request => { const { refreshToken } = RefreshSchema.parse(request.body); await app.db.query("UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL", [tokenHash(refreshToken)]); return { ok: true }; });
  app.get("/me", async request => {
    await request.jwtVerify();
    const principal = request.user as { sub: string; organizationId: string; permissions: string[] };
    const result = await app.db.query("SELECT id,email,display_name,active FROM users WHERE id=$1 LIMIT 1", [principal.sub]);
    const account = result.rows[0];
    if (!account || account.active !== true) throw Object.assign(new Error("session is no longer authorized"), { statusCode: 401 });
    return { user: { id: String(account.id), email: String(account.email), displayName: account.display_name as string | null, organizationId: principal.organizationId, permissions: principal.permissions } };
  });
}
