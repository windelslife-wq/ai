"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";

type Message = { role: "user" | "assistant"; content: string };
const offlineReply = (text: string) => {
  const value = text.toLowerCase();
  if (value.includes("language")) return "Open the AI Language Teacher — translate, listen, and practice speaking with real TTS. Target language only changes when you explicitly select it.";
  if (value.includes("duplicate")) return "Open Intelligence to review duplicate candidates. Provider plus stable source ID is the primary identity rule; merge decisions need a human.";
  if (value.includes("export")) return "Use Intelligence for a formula-safe CSV or JSON export. Every export is recorded in the activity ledger.";
  if (value.includes("admin") || value.includes("user")) return "Use Account to review your session. Administrators are routed securely after login based on backend role — no public Admin Login button is shown.";
  if (value.includes("search") || value.includes("lead")) return "Use Discover to search a city, category, or business type. A configured provider is required and empty results are never filled with fake businesses.";
  return "I can guide you through AI Workforce, Language Teacher, Leads, Trading, and other tools in WINDELS AI WORKFORCE. The live assistant API is temporarily unavailable, so this local guide is answering safely.";
};
export function AssistantWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<Message[]>([{ role: "assistant", content: "Hi, I'm WINDELS Assistant. Ask me how to use the WINDELS AI WORKFORCE platform." }]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setError("");
    setMessages(previous => [...previous, { role: "user", content: message }]);
    setBusy(true);
    try {
      const response = await fetch("/api/v1/chat/respond", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, history: messages.slice(-10) }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "WINDELS Assistant is unavailable");
      setMessages(previous => [...previous, { role: "assistant", content: String(payload.message) }]);
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "WINDELS Assistant API is unavailable");
      setMessages(previous => [...previous, { role: "assistant", content: offlineReply(message) }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed bottom-5 right-5 z-30">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-full border border-cyan-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-white shadow-xl hover:border-cyan-400"
        aria-label="Open WINDELS Assistant"
      >
        <Image src="/images/ai-agent-avatar.png" alt="" width={32} height={32} className="rounded-full object-cover" />
        WINDELS Assistant
      </button>
      {open && (
        <section className="mb-3 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl" aria-label="WINDELS Assistant chat">
          <header className="flex items-center gap-3 border-b border-slate-800 bg-slate-900 p-4">
            <Image src="/images/ai-agent-avatar.png" alt="WINDELS Assistant" width={42} height={42} className="rounded-xl object-cover" />
            <div>
              <p className="font-semibold text-white">WINDELS Assistant</p>
              <p className="text-xs text-slate-500">Product assistant · grounded guidance</p>
            </div>
            <button onClick={() => setOpen(false)} className="ml-auto text-slate-500" aria-label="Close WINDELS Assistant">
              ×
            </button>
          </header>
          <div className="max-h-72 space-y-3 overflow-y-auto p-4">
            {messages.map((message, index) => (
              <p key={`${message.role}-${index}`} className={`max-w-[88%] rounded-xl px-3 py-2 text-sm leading-5 ${message.role === "user" ? "ml-auto bg-cyan-400 text-slate-950" : "bg-slate-900 text-slate-300"}`}>
                {message.content}
              </p>
            ))}
            {busy && <p className="max-w-[88%] rounded-xl bg-slate-900 px-3 py-2 text-sm text-slate-500">Thinking…</p>}
            {error && <p className="text-xs text-red-300">{error}</p>}
          </div>
          <form onSubmit={submit} className="flex gap-2 border-t border-slate-800 p-3">
            <input
              value={input}
              onChange={event => setInput(event.target.value)}
              placeholder="Ask WINDELS Assistant…"
              maxLength={1000}
              className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
            />
            <button disabled={busy} className="rounded-lg bg-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">
              Send
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
