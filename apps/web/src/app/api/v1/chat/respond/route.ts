import { NextResponse } from "next/server";

const localGuide = (message: string) => { const value = message.toLowerCase(); if (value.includes("duplicate")) return "Open Intelligence to review duplicate candidates. Provider plus stable source ID is the primary identity rule; merge decisions need a human."; if (value.includes("export")) return "Use Intelligence for a formula-safe CSV or JSON export. Every export is recorded in the activity ledger."; if (value.includes("admin") || value.includes("user")) return "Use Account to review your session. Administrators can use Admin to create members, change roles, and deactivate access."; if (value.includes("search") || value.includes("lead")) return "Use Discover to search a city, category, or business type. A configured provider is required and empty results are never filled with fake businesses."; return "I can guide you through Discover, Pipeline, Collections, Intelligence, exports, and access control."; };

export async function POST(request: Request) {
  const input = await request.json().catch(() => ({})) as { message?: unknown; history?: unknown };
  if (typeof input.message !== "string" || input.message.trim().length < 1 || input.message.length > 1000) return NextResponse.json({ error: "message must contain 1–1000 characters" }, { status: 400 });
  const target = process.env.LEAD_API_INTERNAL_URL;
  if (target) {
    try {
      const response = await fetch(`${target.replace(/\/$/, "")}/api/v1/chat/respond`, { method: "POST", signal: AbortSignal.timeout(8_000), headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      if (response.ok) return NextResponse.json(await response.json());
    } catch { /* The local guide is the safe offline fallback. */ }
  }
  return NextResponse.json({ message: localGuide(input.message.trim()), provider: "next-local-guide", grounded: true, disclaimer: "Product guidance only; the API service is unavailable or no AI provider is configured." });
}
