import type { FastifyInstance } from "fastify";
import { z } from "zod";

const ChatInputSchema = z.object({ message: z.string().trim().min(1).max(1000), history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2000) })).max(12).default([]) });
const SYSTEM_PROMPT = "You are Scout Guide, the helpful website assistant for Scout Lead Intelligence. Explain only product navigation, lead discovery, collections, pipeline, coverage, duplicates, exports, account access, and administrator controls. Never claim access to private records, never invent businesses or metrics, and say when a real provider or administrator is required. Keep replies concise and practical.";

const localGuide = (message: string): string => {
  const value = message.toLowerCase();
  if (value.includes("duplicate")) return "Open Intelligence to review secondary duplicate signals. Provider plus stable source ID is the primary identity rule; merge decisions always need a human.";
  if (value.includes("export")) return "Select leads in Discover or use Intelligence for a formula-safe CSV export. Every export is recorded in the activity ledger.";
  if (value.includes("admin") || value.includes("user")) return "Administrators can open Admin to create members, change roles, and deactivate access. Regular users can open Account to review their session.";
  if (value.includes("search")) return "Use Discover to search a city, category, or business type. A configured provider is required; Scout never fills an empty result with synthetic businesses.";
  if (value.includes("pipeline") || value.includes("status")) return "Open Pipeline to use Kanban or table view, change a lead status, assign an organization member, add a note, and review activity.";
  if (value.includes("collection")) return "Create collections from Collections, then select leads in Discover and add them to one or more campaign groups.";
  return "I can guide you through Discover, Pipeline, Collections, Intelligence, exports, and access control. Ask about any of those areas.";
};

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/respond", async request => {
    const input = ChatInputSchema.parse(request.body);
    const rate = await app.operational.consumeRateLimit(`chat:${request.ip}`, 30, 60_000);
    if (!rate.allowed) throw Object.assign(new Error("chat rate limit exceeded"), { statusCode: 429 });
    const configured = process.env.AI_CHAT_ENABLED === "1" && Boolean(process.env.AI_CHAT_API_URL && process.env.AI_CHAT_API_KEY && process.env.AI_CHAT_MODEL);
    if (configured) {
      const response = await providerResponse(input).catch(() => null);
      if (response) return { message: response, provider: "configured-ai", grounded: true, disclaimer: "Product guidance only; no private lead data was provided to the assistant." };
    }
    return { message: localGuide(input.message), provider: "local-guide", grounded: true, disclaimer: "Product guidance only; configure an approved AI provider for generated responses." };
  });
}

async function providerResponse(input: z.infer<typeof ChatInputSchema>): Promise<string> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...input.history.map(item => ({ role: item.role, content: item.content })), { role: "user", content: input.message }];
    const response = await fetch(process.env.AI_CHAT_API_URL!, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json", authorization: `Bearer ${process.env.AI_CHAT_API_KEY!}` }, body: JSON.stringify({ model: process.env.AI_CHAT_MODEL, messages, temperature: 0.2, max_tokens: 260 }) });
    if (!response.ok) throw new Error("assistant provider unavailable");
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("assistant provider returned no content");
    return content.trim().slice(0, 2000);
  } finally { clearTimeout(timer); }
}
