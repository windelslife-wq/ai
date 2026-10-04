const $ = (s) => document.querySelector(s);
const esc = (x) =>
  String(x ?? "—").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let csrf = "",
  tab = "dashboard",
  timer;
async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.method ? { "x-csrf-token": csrf } : {}),
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) throw Error(data.error?.code || "Request failed");
  return data;
}
const table = (columns, rows) =>
  `<div class="panel table-wrap"><table><thead><tr>${columns.map((x) => `<th>${esc(x[0])}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${columns.map((x) => `<td>${esc(r[x[1]])}</td>`).join("")}</tr>`).join("")}</tbody></table>${rows.length ? "" : "<p>No records available.</p>"}</div>`;
function summary(t) {
  if (!t)
    return '<div class="panel notice"><h2>No ticket yet</h2><p>No ticket has been saved for today. Review the generation report for the actual outcome.</p></div>';
  return `<div class="panel"><span class="eyebrow">${esc(t.ticket.day)}</span><h2>Ticket #${esc(t.ticket.id)} · ${esc(t.ticket.original_odds)}</h2><p>Status ${esc(t.ticket.status)} · Settlement ${esc(t.ticket.result)} · ${t.selections.length} picks</p><div class="controls"><button class="button primary" id="publish" ${t.ticket.status === "PUBLISHED" ? "disabled" : ""}>Publish ticket</button><button class="button secondary" id="unpublish" ${t.ticket.status !== "PUBLISHED" ? "disabled" : ""}>Unpublish</button></div></div>${t.selections.map((s) => `<article class="panel match"><div><span class="eyebrow">${esc(s.fixture.competition)}</span><h3>${esc(s.fixture.home)} vs ${esc(s.fixture.away)}</h3><div class="meta">Over 1.5 · ${esc(s.bookmaker)} · Kickoff ${esc(s.fixture.kickoff)} · Verified ${esc(s.observed_at)}</div><div class="meta">Confidence ${esc(s.confidence)}% · Risk ${esc(s.risk)} · ${esc(s.result)}</div></div><span class="odds">${esc(s.price)}</span></article>`).join("")}`;
}
async function render(name = tab) {
  tab = name;
  clearInterval(timer);
  $("#heading").textContent =
    {
      today: "Today's ticket",
      api: "API status",
      tickets: "Ticket history",
      logs: "System logs",
    }[name] || name[0].toUpperCase() + name.slice(1);
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $("#content").textContent = "Loading…";
  try {
    if (name === "dashboard" || name === "today") {
      const d = await api("/api/admin/dashboard");
      $("#content").innerHTML =
        `${name === "dashboard" ? '<div class="controls"><button class="button primary" id="generate">GENERATE TODAY\'S TICKET →</button></div>' : ""}<div class="panel"><span class="label">Generation state</span><h3 id="stage">${esc(d.generation?.stage || "Not generated today")}</h3><span class="badge">${esc(d.generation?.status || "AWAITING ADMINISTRATOR")}</span></div><h2>Today</h2>${summary(d.today)}<h2>Generation report</h2><pre class="panel report">${esc(d.generation?.report ? JSON.stringify(d.generation.report, null, 2) : "No generation report yet.")}</pre>`;
      $("#generate")?.addEventListener("click", async (e) => {
        e.target.disabled = true;
        $("#stage").textContent = "Requesting generation…";
        timer = setInterval(async () => {
          try {
            const g = await api("/api/admin/generation-report");
            if (g.generation) $("#stage").textContent = g.generation.stage;
          } catch {}
        }, 1000);
        try {
          await api("/api/admin/generate-ticket", { method: "POST" });
          await render(name);
        } catch (err) {
          clearInterval(timer);
          $("#stage").textContent = err.message;
          e.target.disabled = false;
        }
      });
      for (const action of ["publish", "unpublish"])
        $("#" + action)?.addEventListener("click", async () => {
          if (!confirm(`${action} this ticket?`)) return;
          try {
            await api(`/api/admin/tickets/${d.today.ticket.id}/${action}`, {
              method: "POST",
            });
            await render(name);
          } catch (err) {
            alert(err.message);
          }
        });
    } else if (
      name === "fixtures" ||
      name === "odds" ||
      name === "predictions"
    ) {
      const r = await api(
        (name === "predictions" ? "/api/admin/predictions" : "/api/" + name) +
          "?limit=100",
      );
      let cols =
        name === "fixtures"
          ? [
              ["Kickoff (UTC)", "kickoff"],
              ["Home", "homeTeam"],
              ["Away", "awayTeam"],
              ["Competition", "competition"],
              ["Status", "status"],
            ]
          : name === "odds"
            ? [
                ["Fixture ID", "fixture_id"],
                ["Bookmaker", "bookmaker"],
                ["Over 1.5 odds", "price"],
                ["Verified (UTC)", "observed_at"],
              ]
            : [
                ["Fixture ID", "fixture_id"],
                ["Model probability", "probability"],
                ["Evidence confidence", "confidence"],
                ["Quality", "quality"],
                ["Risk", "risk"],
              ];
      $("#content").innerHTML =
        table(cols, r.data) +
        (name === "predictions"
          ? "<p>Public predictions require a published ticket. Model probabilities are not empirically calibrated.</p>"
          : "");
    } else if (name === "tickets") {
      const { data } = await api("/api/admin/tickets");
      $("#content").innerHTML =
        table(
          [
            ["ID", "id"],
            ["Day", "day"],
            ["Original odds", "original_odds"],
            ["Publication", "status"],
            ["Result", "result"],
          ],
          data,
        ) +
        `<p>Select a ticket ID for details on the public ticket page after publication.</p>`;
    } else if (name === "analytics") {
      const {
        tickets: t,
        selections: s,
        winRate,
        selectionWinRate,
        scope,
        monthly,
        competition,
        models,
        probabilityBins,
        currentWinStreak,
        currentLossStreak,
      } = await api("/api/admin/analytics");
      $("#content").innerHTML = `<div class="grid four">${[
        ["Tickets", t.total],
        ["Won", t.won || 0],
        ["Lost", t.lost || 0],
        ["Void", t.voided || 0],
        ["Win rate", winRate === null ? "—" : (winRate * 100).toFixed(1) + "%"],
        ["Selections", s.total],
        [
          "Selection win rate",
          selectionWinRate === null
            ? "—"
            : (selectionWinRate * 100).toFixed(1) + "%",
        ],
        ["Average odds", t.avgOdds || "—"],
        ["Highest odds", t.maxOdds || "—"],
        ["Lowest odds", t.minOdds || "—"],
      ]
        .map(
          ([k, v]) =>
            `<div class="panel"><span class="label">${esc(k)}</span><span class="metric">${esc(v)}</span></div>`,
        )
        .join(
          "",
        )}</div><p>${esc(scope)}</p><div class="grid four"><div class="panel"><span class="label">Current winning streak</span><span class="metric">${currentWinStreak}</span></div><div class="panel"><span class="label">Current losing streak</span><span class="metric">${currentLossStreak}</span></div></div><h2>Monthly performance</h2>${table(
        [
          ["Month", "month"],
          ["Tickets", "total"],
          ["Won", "won"],
          ["Lost", "lost"],
        ],
        monthly,
      )}<h2>Competition performance</h2>${table(
        [
          ["Competition", "competition"],
          ["Picks", "total"],
          ["Won", "won"],
          ["Lost", "lost"],
        ],
        competition,
      )}<h2>Model performance</h2>${table(
        [
          ["Model", "model_version"],
          ["Picks", "total"],
          ["Won", "won"],
          ["Lost", "lost"],
        ],
        models,
      )}<h2>Probability reliability bins</h2>${table(
        [
          ["Model probability bin", "probabilityBin"],
          ["Resolved sample", "sample"],
          ["Wins", "won"],
        ],
        probabilityBins,
      )}`;
    } else if (name === "settings") {
      const {
        settings: s,
        market,
        minCombinedOdds,
        maxCombinedOdds,
        automaticGeneration,
      } = await api("/api/admin/settings");
      const fields = [
        ["min_confidence", "Minimum confidence", 50, 95],
        ["max_risk", "Maximum risk", 5, 70],
        ["min_quality", "Minimum data quality", 60, 100],
        ["max_odds_age_seconds", "Maximum odds age (seconds)", 60, 3600],
        ["max_selections", "Maximum selections", 2, 12],
        ["restrict_teams", "Restrict shared teams (0/1)", 0, 1],
        ["max_per_competition", "Maximum per competition", 1, 5],
      ];
      $("#content").innerHTML =
        `<div class="panel"><p>Market: ${esc(market)} · Combined odds: ${esc(minCombinedOdds)}–${esc(maxCombinedOdds)} · Automatic generation: ${automaticGeneration ? "ON" : "OFF"}. These are locked.</p><form id="settings" class="grid three">${fields.map(([key, label, min, max]) => `<label>${esc(label)}<input type="number" name="${key}" min="${min}" max="${max}" step="1" required value="${esc(s[key])}"></label>`).join("")}<button class="button primary">Save settings</button></form><p id="save-note" role="status"></p></div>`;
      $("#settings").onsubmit = async (e) => {
        e.preventDefault();
        try {
          const input = Object.fromEntries(
            [...new FormData(e.target)].map(([k, v]) => [k, Number(v)]),
          );
          await api("/api/admin/settings", {
            method: "PUT",
            body: JSON.stringify(input),
          });
          $("#save-note").textContent = "Settings saved and audited.";
        } catch (err) {
          $("#save-note").textContent = err.message;
        }
      };
    } else if (name === "api") {
      const d = await api("/api/admin/api-status");
      $("#content").innerHTML =
        `<div class="panel"><h2>${d.configured ? "Provider configured" : "Provider not configured"}</h2><p>Latest synchronization: ${esc(d.last?.job || "none")} · ${esc(d.last?.status || "unknown")} · ${esc(d.last?.started_at || "—")}</p><p>${esc(d.last?.error || "")}</p><p>Background jobs never generate or publish tickets.</p></div>`;
    } else if (name === "logs") {
      const d = await api("/api/admin/system-logs");
      $("#content").innerHTML = table(
        [
          ["Time", "created_at"],
          ["Severity", "severity"],
          ["Message", "message"],
        ],
        d.data,
      );
    }
  } catch (err) {
    $("#content").innerHTML =
      `<div class="panel error">${esc(err.message)}</div>`;
  }
}
(async () => {
  try {
    await api("/api/auth/me");
    csrf = (await api("/api/auth/csrf", { method: "POST" })).csrfToken;
    $("#tabs").onclick = (e) => {
      const b = e.target.closest("[data-tab]");
      if (b) render(b.dataset.tab);
    };
    $("#logout").onclick = async () => {
      try {
        await api("/api/auth/logout", { method: "POST" });
        location.replace("/login.html");
      } catch (err) {
        alert(err.message);
      }
    };
    await render();
  } catch {
    location.replace("/login.html");
  }
})();
