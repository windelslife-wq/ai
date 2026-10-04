import type { FastifyRequest } from "fastify";

export type LeadPrincipal = { sub: string; organizationId: string; permissions: string[] };
export async function requireLeadAccess(request: FastifyRequest): Promise<LeadPrincipal> {
  await request.jwtVerify();
  const principal = request.user as Partial<LeadPrincipal>;
  if (!principal.sub || !principal.organizationId) throw Object.assign(new Error("invalid lead token"), { statusCode: 401 });
  if (!principal.permissions?.includes("lead.read") && !principal.permissions?.includes("lead.write")) {
    throw Object.assign(new Error("forbidden"), { statusCode: 403 });
  }
  return principal as LeadPrincipal;
}

declare module "@fastify/jwt" { interface FastifyJWT { user: LeadPrincipal } }
