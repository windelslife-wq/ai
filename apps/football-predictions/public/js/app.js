const esc = (x) =>
  String(x ?? "—").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
async function get(url) {
  const r = await fetch(url);
  const payload = await r.json().catch(() => null);
  if (!r.ok) {
    const message = payload?.error?.code || payload?.error?.message || `Request failed (${r.status})`;
    throw Object.assign(new Error(message), { status: r.status, code: payload?.error?.code });
  }
  if (payload === null) throw new Error("The server returned an invalid response.");
  return payload;
}
function formatDate(value) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }) + " UTC"
    : "—";
}
function report(data) {
  if (!data) return "";
  const keys = [
    "fixturesScanned",
    "over15Candidates",
    "verifiedOdds",
    "confidenceQualified",
    "riskQualified",
    "finalCandidates",
    "correlationRejections",
    "combinationsTested",
  ];
  return `<div class="grid four">${keys.map((k) => `<div class="panel"><span class="label">${esc(k.replace(/[A-Z]/g, " $&"))}</span><span class="metric">${esc(data[k] ?? 0)}</span></div>`).join("")}</div>`;
}
function card(s) {
  const f = s.fixture || {};
  return `<article class="panel match"><div><span class="eyebrow">${esc(f.competition)}</span><h3>${esc(f.home)} <span class="muted">vs</span> ${esc(f.away)}</h3><div class="meta">Over 1.5 Goals · ${esc(s.bookmaker)} · ${formatDate(f.kickoff)}</div><div class="meta">Verified ${formatDate(s.observed_at)} · Confidence ${esc(s.confidence)}% · Risk ${esc(s.risk)} · ${esc(s.result)}</div></div><div><span class="label">Verified odds</span><div class="odds">${esc(s.price)}</div></div></article>`;
}
function ticketView(data) {
  if (!data?.ticket)
    return `<div class="panel notice"><span class="badge muted">QUALITY GATE</span><h2>${esc(data?.status || "NOT_GENERATED")}</h2><p>${esc(data?.message || "No public ticket available.")}</p></div>${report(data?.generation?.report)}`;
  const t = data.ticket,
    s = data.selections;
  const confidence = s.length
    ? (s.reduce((v, x) => v + Number(x.confidence), 0) / s.length).toFixed(1)
    : "—";
  return `<div class="ticket-summary"><div class="panel"><span class="label">Total odds</span><span class="metric">${esc(Number(t.original_odds).toFixed(2))}</span></div><div class="panel"><span class="label">Number of picks</span><span class="metric">${s.length}</span></div><div class="panel"><span class="label">Confidence · evidence</span><span class="metric">${confidence}%</span></div><div class="panel"><span class="label">Status</span><span class="badge">${esc(t.result)}</span></div></div>${s.map(card).join("")}<p class="meta">Original odds are preserved. Confidence reflects evidence quality, not calibrated success probability. All times UTC.</p>`;
}
(async () => {
  const page = document.body.dataset.page;
  try {
    if (page === "home" || page === "ticket") {
      const id = new URLSearchParams(location.search).get("id");
      const data =
        id && /^\d+$/.test(id)
          ? await get("/api/tickets/" + id)
          : await get("/api/ticket/today");
      document.getElementById("today").innerHTML = ticketView(data);
      if (id && data.ticket)
        document.getElementById("page-title").textContent = "Ticket #" + id;
    }
    if (page === "history") {
      let pageN = 1;
      let loading = false;
      const container = document.getElementById("history"),
        more = document.getElementById("more");
      async function load() {
        if (loading) return;
        loading = true;
        more.disabled = true;
        more.textContent = "Loading…";
        container.setAttribute("aria-busy", "true");
        try {
          const { data } = await get("/api/tickets/history?page=" + pageN);
          container.querySelector("[data-history-error]")?.remove();
          const html = data
            .map(
              (t) =>
                `<a class="panel match" href="/ticket.html?id=${encodeURIComponent(t.id)}"><div><span class="eyebrow">${esc(t.day)}</span><h3>Over 1.5 Goals · Ticket #${esc(t.id)}</h3><span class="badge">${esc(t.result)}</span></div><span class="odds">${esc(Number(t.original_odds).toFixed(2))}</span></a>`,
            )
            .join("");
          if (pageN === 1)
            container.innerHTML =
              html || '<div class="panel">No published tickets yet.</div>';
          else container.insertAdjacentHTML("beforeend", html);
          pageN += 1;
          more.hidden = data.length < 20;
          more.textContent = "Load more";
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to load ticket history.";
          if (pageN === 1) container.textContent = message;
          else {
            container.querySelector("[data-history-error]")?.remove();
            const notice = document.createElement("p");
            notice.dataset.historyError = "true";
            notice.className = "panel error";
            notice.setAttribute("role", "alert");
            notice.textContent = message;
            container.append(notice);
          }
          more.hidden = false;
          more.textContent = "Retry";
        } finally {
          loading = false;
          more.disabled = false;
          container.setAttribute("aria-busy", "false");
        }
      }
      more.onclick = () => void load();
      await load();
    }
    if (page === "login") {
      const form = document.getElementById("login");
      const msg = document.getElementById("message");
      try {
        const existing = await fetch("/api/auth/me");
        if (existing.ok) {
          const session = await existing.json().catch(() => ({}));
          if (session.user?.role === "ADMIN") { location.replace("/admin.html"); return; }
          if (session.user) msg.textContent = "The current account is not an administrator. Sign in with an administrator account.";
        }
      } catch (error) {
        msg.textContent = `Unable to verify the current session: ${error instanceof Error ? error.message : "request failed"}`;
      }
      form.onsubmit = async (e) => {
        e.preventDefault();
        const submit = form.querySelector("button");
        if (submit?.disabled) return;
        const originalText = submit?.textContent;
        if (submit) { submit.disabled = true; submit.textContent = "Signing in…"; }
        msg.textContent = "";
        try {
          const body = Object.fromEntries(new FormData(form));
          const response = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            const message = payload?.error?.code || payload?.error?.message || `Sign in failed (${response.status})`;
            throw new Error(message);
          }
          if (payload?.user?.role !== "ADMIN") throw new Error("This account does not have administrator access.");
          location.replace("/admin.html");
        } catch (error) {
          msg.textContent = error instanceof Error ? error.message : "Sign in failed.";
        } finally {
          if (submit) { submit.disabled = false; submit.textContent = originalText || "Sign in →"; }
        }
      };
    }
  } catch (err) {
    const target = document.getElementById(
      page === "history" ? "history" : "today",
    );
    if (target) target.textContent = err.message;
  }
})();
