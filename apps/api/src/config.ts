export function parseAllowedOrigins(value = process.env.CORS_ORIGINS ?? ""): string[] {
  const configured = value.split(",").map(origin => origin.trim().replace(/\/$/, "")).filter(Boolean);
  if (configured.length || process.env.NODE_ENV === "production") return configured;
  return ["http://localhost:3000", "http://127.0.0.1:3000"];
}
export function requireProductionConfig(): void {
  if (process.env.NODE_ENV === "production" && parseAllowedOrigins().length === 0) throw new Error("CORS_ORIGINS must list the allowed web origins in production");
}
