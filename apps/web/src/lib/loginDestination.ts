export function loginDestination(permissions: readonly string[], adminLogin = false): string | null {
  const isAdmin = permissions.includes("lead.admin");
  if (adminLogin && !isAdmin) return null;
  return isAdmin ? "/admin" : "/app/leads";
}
