/**
 * Sports and lottery consoles (Phase 28).
 *
 * The last two screens finding **F-29** named: `Sports::index`, `Sports::tickets`
 * (`views/sports/*.php`) and `Lottery::index` (`views/lottery/*.php`). With these
 * ported, every console legacy had for a ported module exists in this SPA. The
 * per-domain dashboards legacy also rendered remain row 3 work, and the labels
 * say so rather than letting "console" imply the whole app shell.
 *
 * What these screens do and do not do, because it is the whole reason they exist:
 *
 *  - They **aggregate stored records** — the words the not-ported matrix used —
 *    and nothing else. Every figure is a value from a `GET` this module already
 *    served; nothing is computed here that the API does not compute, so a number
 *    on screen can always be read back from the endpoint named beside it.
 *  - They **state the module's own limits**: the sports screen renders
 *    `notPorted` from `/sports/status` (stake sizing, and whatever else the
 *    matrix holds at the time), and the lottery screen renders the independence
 *    disclaimer from `/lottery/status` and separates ACTUAL / HISTORICAL /
 *    DEMO sections exactly as the API separates them.
 *  - They **perform only the human-in-the-loop actions legacy's consoles
 *    performed**, each behind its own permission: approve/reject a pending ticket
 *    (`sports.approve`), settle from verified results (`sports.settle`), and the
 *    two lottery administrator controls (`lottery.manage`). Those permissions are
 *    checked here only to decide what to *render*; the API refuses regardless.
 *  - Everything else — sync, evaluate, calibration fit/approve/reject, the daily
 *    ticket run, backtests, drift, results verification, stuck-run recovery — has
 *    no control on these screens. It stays reachable through the API, and the
 *    footer of each screen says which permission each one needs.
 */

import { useState } from "react";
import { endpoints } from "./api.js";
import { Link } from "./router.jsx";
import { Field, Notice, StateBox, useResource } from "./ui.jsx";
import {
  LOTTERY_STATISTICS_KINDS,
  SPORTS_CALIBRATION_STATUSES,
  SPORTS_JOB_TYPES,
  SPORTS_MATCH_STATUSES,
  SPORTS_TICKET_APPROVALS,
} from "./contracts.js";

/* ------------------------------------------------------------------ helpers */

/** `YYYY-MM-DD HH:MM:SS` UTC. Instants arrive canonical; nothing is re-parsed. */
function utc(value) {
  if (!value) return "";
  const text = String(value);
  return text.includes("T") ? `${text.slice(0, 10)} ${text.slice(11, 19)}` : text;
}

function text(value, fallback = "—") {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function num(value, digits = 2) {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return String(value);
  return parsed.toFixed(digits).replace(/\.0+$/, (match) => (digits > 0 ? match : ""));
}

function asPercent(value, digits = 1) {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return String(value);
  return `${(parsed * 100).toFixed(digits)}%`;
}

function yesNo(value) {
  return value === true ? "yes" : value === false ? "no" : "—";
}

/** A definition list of label → value pairs, values rendered as text. */
function KeyFacts({ entries }) {
  const rows = entries.filter(([, value]) => value !== undefined);
  if (!rows.length) return null;
  return (
    <dl className="detail-grid">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value === null || value === undefined || value === "" ? "—" : typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The stat grid the workspace overview uses, for headline counts. */
function StatGrid({ items }) {
  return (
    <div className="status-grid">
      {items.map(([label, value]) => (
        <div key={label}><small>{label}</small><strong>{value}</strong></div>
      ))}
    </div>
  );
}

/** A panel whose body is one resource, with the four states rendered. */
function ResourcePanel({ title, resource, empty, label, note, children }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {note ? <p className="field-hint">{note}</p> : null}
      <StateBox status={resource.status} error={resource.error} retry={resource.retry} label={label || `Loading ${title}`} empty={empty}>
        {children}
      </StateBox>
    </section>
  );
}

function isEmptyList(list) {
  return !Array.isArray(list) || list.length === 0;
}

/* ------------------------------------------------------------- sports console */

/**
 * `/app/sports` — `Sports::index` and `Sports::tickets`, in one screen.
 *
 * The legacy pair split the same data across two routes: the index carried the
 * day's intelligence, the ticket engine and the models; the tickets view carried
 * the full ticket table, the daily runs and the all-time performance report.
 * Both are aggregation views over the same stored rows, so they are one screen
 * here — and both legacy sections are present.
 */
export function SportsConsoleView({ permissions }) {
  const [matchStatus, setMatchStatus] = useState("");
  const [ticketApproval, setTicketApproval] = useState("");
  const [predictionDecision, setPredictionDecision] = useState("");
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);

  const status = useResource(() => endpoints.sportsStatus(), []);
  const providers = useResource(() => endpoints.sportsProviders(), []);
  const syncRuns = useResource(() => endpoints.sportsSyncRuns("?limit=10"), []);

  const matchQuery = `?limit=25${matchStatus ? `&status=${matchStatus}` : ""}`;
  const matches = useResource(() => endpoints.sportsMatches(matchQuery), [matchQuery]);

  const predictionQuery = `?limit=25${predictionDecision ? `&decision=${predictionDecision}` : ""}`;
  const predictions = useResource(() => endpoints.sportsPredictions(predictionQuery), [predictionQuery]);

  const ticketQuery = `?limit=25${ticketApproval ? `&approvalStatus=${ticketApproval}` : ""}`;
  const tickets = useResource(() => endpoints.sportsTickets(ticketQuery), [ticketQuery]);
  const dailyRuns = useResource(() => endpoints.sportsDailyTickets("?limit=10"), []);

  const performance = useResource(() => endpoints.sportsPerformance(), []);
  const models = useResource(() => endpoints.sportsModels(), []);
  const calibrations = useResource(() => endpoints.sportsCalibrations("?limit=10"), []);

  const canApprove = permissions.includes("sports.approve");
  const canSettle = permissions.includes("sports.settle");
  const canManage = permissions.includes("sports.manage");

  async function act(key, describe, call) {
    setBusy(key);
    setMessage(null);
    try {
      await call();
      setMessage({ tone: "ok", text: describe });
      tickets.retry();
    } catch (error) {
      setMessage({ tone: "error", text: error?.message || "The action did not complete." });
    } finally {
      setBusy(null);
    }
  }

  const report = status.data;

  return (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">SPORTS <span className="overline-line" /></div><h1>Research, tickets and settlement — nothing executed.</h1></div>
        <Link className="text-button" to="/app/">Back to overview</Link>
      </header>

      {message ? <Notice tone={message.tone === "ok" ? "info" : "error"}>{message.text}</Notice> : null}

      <Notice tone="warn">
        <strong>No stake is ever sized and no bet is ever placed.</strong> Tickets are stored records, a daily run waits for a person, and
        settlement only reads results a person has attested to. This deployment has no external bookmaker.
      </Notice>

      {report?.isDemoData ? (
        <Notice tone="warn"><strong>SANDBOX / DEMO DATA</strong> — sports figures are simulated, not real-world performance.</Notice>
      ) : null}
      {report && report.enabled === false ? (
        <Notice tone="warn">
          <strong>{report.ticketEngine}</strong> — {report.message}
        </Notice>
      ) : null}

      <ResourcePanel title="Module state" resource={status} label="Loading module state">
        <StatGrid items={[
          ["MODE", text(report?.mode)],
          ["ENABLED", yesNo(report?.enabled)],
          ["TICKET ENGINE", text(report?.ticketEngine)],
          ["PROVIDERS CONFIGURED", yesNo(report?.providersConfigured)],
          ["PERSISTENCE", yesNo(report?.persistence)],
          ["LIVE PROBE", report?.probed ? yesNo(report?.probed) : "not probed (no outbound I/O)"],
        ]} />
        {report?.notice ? <p className="field-hint">{report.notice}</p> : null}
        {report?.liveHealth ? <KeyFacts entries={[["LIVE HEALTH", JSON.stringify(report.liveHealth)]]} /> : null}
        {report?.notPorted?.length ? (
          <>
            <h3 className="subheading">Not ported — the module's own matrix</h3>
            <table className="data-table">
              <thead><tr><th>Area</th><th>Legacy</th><th>State</th><th>Detail</th></tr></thead>
              <tbody>
                {report.notPorted.map((entry) => (
                  <tr key={entry.area}>
                    <td><strong>{entry.area}</strong></td>
                    <td className="muted">{entry.legacy}</td>
                    <td><span className="badge badge-warn">{entry.state}</span></td>
                    <td className="muted">{entry.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="field-hint">The module reports no unported areas.</p>
        )}
      </ResourcePanel>

      <ResourcePanel title="Providers" resource={providers} label="Loading providers"
        empty={<p className="empty">No provider is registered. Nothing is fabricated to fill this table.</p>}>
        <table className="data-table">
          <thead><tr><th>Provider</th><th>Code</th><th>Enabled</th><th>Synthetic</th></tr></thead>
          <tbody>
            {(providers.data?.providers || []).map((provider) => (
              <tr key={provider.id || provider.provider_code}>
                <td>{text(provider.display_name || provider.provider_code)}</td>
                <td><code>{text(provider.provider_code)}</code></td>
                <td>{yesNo(provider.enabled)}</td>
                <td>{provider.synthetic ? <span className="badge badge-warn">SYNTHETIC</span> : <span className="muted">no</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResourcePanel>

      <ResourcePanel title="Recent sync runs" resource={syncRuns} label="Loading sync runs"
        empty={<p className="empty">No ingestion run has been recorded yet.</p>}>
        <table className="data-table">
          <thead><tr><th>Job</th><th>Status</th><th>Execution key</th><th>Started (UTC)</th></tr></thead>
          <tbody>
            {(syncRuns.data?.runs || []).map((run) => (
              <tr key={run.id || run.execution_key}>
                <td><code>{text(run.job_type || run.jobType)}</code></td>
                <td><span className="badge badge-muted">{text(run.status)}</span></td>
                <td className="muted">{text(run.execution_key || run.executionKey)}</td>
                <td className="muted">{utc(run.started_at || run.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {syncRuns.data?.unfinished ? <p className="field-hint">{syncRuns.data.unfinished} run(s) not finished.</p> : null}
      </ResourcePanel>

      <section className="panel">
        <h2>Fixtures</h2>
        <form className="panel-form inline" onSubmit={(event) => event.preventDefault()}>
          <Field label="Status" htmlFor="sp-match-status">
            <select id="sp-match-status" value={matchStatus} onChange={(event) => setMatchStatus(event.target.value)}>
              <option value="">any</option>
              {SPORTS_MATCH_STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </Field>
        </form>
        <StateBox status={matches.status} error={matches.error} retry={matches.retry} label="Loading fixtures"
          empty={<p className="empty">No stored fixtures match. An empty list is the honest answer here.</p>}>
          <table className="data-table">
            <thead><tr><th>Kickoff (UTC)</th><th>Match</th><th>Competition</th><th>Status</th><th>Score</th></tr></thead>
            <tbody>
              {(matches.data?.matches || []).map((match) => (
                <tr key={match.id}>
                  <td className="muted">{utc(match.kickoff_at || match.kickoffAt)}</td>
                  <td>{text(match.home_team || match.homeTeam)} vs {text(match.away_team || match.awayTeam)}</td>
                  <td className="muted">{text(match.competition)}</td>
                  <td><span className="badge badge-muted">{text(match.status)}</span></td>
                  <td className="muted">
                    {match.home_score === null || match.home_score === undefined
                      ? "—"
                      : `${text(match.home_score)}–${text(match.away_score)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="field-hint">
            The legacy index computed a per-match data-quality band in its own aggregate. This port renders the stored
            fixture rows the API returns and does not recompute a quality band client-side — the quality engines are
            server-side, and a band invented here could disagree with them.
          </p>
        </StateBox>
      </section>

      <section className="panel">
        <h2>Predictions</h2>
        <form className="panel-form inline" onSubmit={(event) => event.preventDefault()}>
          <Field label="Decision" htmlFor="sp-prediction-decision">
            <select id="sp-prediction-decision" value={predictionDecision} onChange={(event) => setPredictionDecision(event.target.value)}>
              <option value="">any</option>
              <option value="PREDICTION_READY">PREDICTION_READY</option>
              <option value="NO_PREDICTION">NO_PREDICTION</option>
            </select>
          </Field>
        </form>
        <StateBox status={predictions.status} error={predictions.error} retry={predictions.retry} label="Loading predictions"
          empty={<p className="empty">No stored prediction matches this filter.</p>}>
          <table className="data-table">
            <thead><tr><th>Match</th><th>Market</th><th>Selection</th><th>Odds</th><th>Confidence</th><th>Decision</th></tr></thead>
            <tbody>
              {(predictions.data?.predictions || []).map((prediction) => (
                <tr key={prediction.id}>
                  <td><code>#{text(prediction.match_id || prediction.matchId)}</code></td>
                  <td>{text(prediction.market)}</td>
                  <td>{text(prediction.selection)}</td>
                  <td className="muted">{num(prediction.odds)}</td>
                  <td className="muted">{prediction.confidence === null || prediction.confidence === undefined ? "—" : num(prediction.confidence, 1)}</td>
                  <td><span className="badge badge-muted">{text(prediction.decision)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </StateBox>
      </section>

      <section className="panel">
        <h2>Tickets</h2>
        <p className="field-hint">
          Approve and reject need <code>sports.approve</code>; settling needs <code>sports.settle</code>. Buttons appear
          only when your role carries the permission, and the API refuses either way.
        </p>
        <form className="panel-form inline" onSubmit={(event) => event.preventDefault()}>
          <Field label="Approval" htmlFor="sp-ticket-approval">
            <select id="sp-ticket-approval" value={ticketApproval} onChange={(event) => setTicketApproval(event.target.value)}>
              <option value="">any</option>
              {SPORTS_TICKET_APPROVALS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </Field>
        </form>
        <StateBox status={tickets.status} error={tickets.error} retry={tickets.retry} label="Loading tickets"
          empty={<p className="empty">No ticket has been generated. The engine records a PENDING run for a person rather than inventing one.</p>}>
          <table className="data-table">
            <thead><tr><th>Ticket</th><th>Created (UTC)</th><th>Odds</th><th>Sel.</th><th>Risk</th><th>Approval</th><th>Settlement</th><th>P/L</th><th /></tr></thead>
            <tbody>
              {(tickets.data?.tickets || []).map((ticket) => {
                const pending = String(ticket.approval_status || ticket.approvalStatus) === "PENDING_USER_APPROVAL";
                const unsettled = String(ticket.settlement_status || ticket.settlementStatus) === "PENDING";
                return (
                  <tr key={ticket.id}>
                    <td><code>#{text(ticket.id)}</code></td>
                    <td className="muted">{utc(ticket.created_at || ticket.createdAt)}</td>
                    <td className="muted">{num(ticket.total_odds ?? ticket.totalOdds)}</td>
                    <td className="muted">{text(ticket.selection_count ?? ticket.selectionCount)}</td>
                    <td><span className="badge badge-muted">{text(ticket.risk)}</span></td>
                    <td><span className="badge badge-muted">{text(ticket.approval_status || ticket.approvalStatus)}</span></td>
                    <td><span className="badge badge-muted">{text(ticket.settlement_status || ticket.settlementStatus)}</span></td>
                    <td className="muted">{num(ticket.pnl ?? ticket.profit_loss)}</td>
                    <td className="row-actions">
                      {pending && canApprove ? (
                        <>
                          <button className="text-button" type="button" disabled={busy === `approve-${ticket.id}`}
                            onClick={() => void act(`approve-${ticket.id}`, `Ticket #${ticket.id} approved.`, () => endpoints.sportsDecideTicket(ticket.id, { approve: true }))}>Approve</button>
                          <button className="text-button" type="button" disabled={busy === `reject-${ticket.id}`}
                            onClick={() => void act(`reject-${ticket.id}`, `Ticket #${ticket.id} rejected.`, () => endpoints.sportsDecideTicket(ticket.id, { approve: false, reason: "rejected from the sports console" }))}>Reject</button>
                        </>
                      ) : null}
                      {unsettled && canSettle ? (
                        <button className="text-button" type="button" disabled={busy === `settle-${ticket.id}`}
                          onClick={() => void act(`settle-${ticket.id}`, `Settlement swept for ticket #${ticket.id}.`, () => endpoints.sportsSettleTicket(ticket.id, {}))}>Settle</button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!canApprove && !canSettle ? (
            <p className="field-hint">
              Your role carries neither <code>sports.approve</code> nor <code>sports.settle</code>, so no action is offered.
              The same decision and settlement endpoints remain the only way to move a ticket.
            </p>
          ) : null}
        </StateBox>
      </section>

      <ResourcePanel title="Daily ticket runs" resource={dailyRuns} label="Loading daily runs"
        empty={<p className="empty">No daily run recorded yet. Runs are started by the cron or the API, never by this screen.</p>}>
        <table className="data-table">
          <thead><tr><th>Date</th><th>Status</th><th>Fixture date</th><th>Message</th></tr></thead>
          <tbody>
            {(dailyRuns.data?.runs || []).map((run) => (
              <tr key={run.id || run.run_date || run.runDate}>
                <td><code>{text(run.run_date || run.runDate)}</code></td>
                <td><span className="badge badge-muted">{text(run.status)}</span></td>
                <td className="muted">{text(run.fixture_date || run.fixtureDate)}</td>
                <td className="muted">{text(run.message)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResourcePanel>

      <ResourcePanel title="Performance (stored settlements only)" resource={performance} label="Loading performance">
        <p className="field-hint">{text(performance.data?.demoBanner, "")}</p>
        {performance.data?.dataAvailable === false ? (
          <p className="empty">No settled tickets or selections yet — metrics are intentionally unavailable rather than invented.</p>
        ) : (
          <>
            <StatGrid items={[
              ["SETTLED", text(performance.data?.settledTickets)],
              ["WIN RATE", asPercent(performance.data?.winRate)],
              ["ROI", asPercent(performance.data?.roi)],
              ["PROFIT / LOSS", num(performance.data?.profitLoss)],
              ["MAX DRAWDOWN", num(performance.data?.maxDrawdown)],
              ["AVG ODDS", num(performance.data?.averageOdds)],
              ["MODEL ACCURACY", asPercent(performance.data?.modelAccuracy)],
              ["AVG EV / SELECTION", num(performance.data?.expectedValue, 3)],
            ]} />
            <KeyFacts entries={[
              ["WON / LOST / VOID", `${text(performance.data?.won)} / ${text(performance.data?.lost)} / ${text(performance.data?.void)}`],
              ["CALIBRATION (BRIER / ECE)", performance.data?.calibration ? `${num(performance.data?.calibration?.brier, 3)} / ${num(performance.data?.calibration?.ece, 3)}` : "—"],
              ["BY MARKET", performance.data?.byMarket && Object.keys(performance.data.byMarket).length ? Object.entries(performance.data.byMarket).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`).join(" · ") : "—"],
              ["BY MODEL", performance.data?.byModel && Object.keys(performance.data.byModel).length ? Object.entries(performance.data.byModel).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`).join(" · ") : "—"],
            ]} />
          </>
        )}
      </ResourcePanel>

      <ResourcePanel title="Models and calibration" resource={models} label="Loading models"
        empty={<p className="empty">No model version recorded yet.</p>}>
        <table className="data-table">
          <thead><tr><th>Model</th><th>Version</th><th>Features</th><th>Calibration</th><th>Status</th></tr></thead>
          <tbody>
            {(models.data?.models || []).map((model) => (
              <tr key={model.id || `${model.model_name}-${model.model_version}`}>
                <td><strong>{text(model.model_name || model.modelName)}</strong></td>
                <td className="muted">{text(model.model_version || model.modelVersion)}</td>
                <td className="muted">{text(model.feature_version || model.featureVersion)}</td>
                <td className="muted">{text(model.calibration_version || model.calibrationVersion)}</td>
                <td><span className="badge badge-muted">{text(model.status)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <NodeCalibrations resource={calibrations} />
      </ResourcePanel>

      <section className="panel">
        <h2>What this screen does not do</h2>
        <p className="field-hint">
          The console performs only the actions legacy's console performed. Everything else stays on the API, with the
          permission it requires — this screen has no control for any of them:
        </p>
        <table className="data-table">
          <thead><tr><th>Action</th><th>Permission</th></tr></thead>
          <tbody>
            {[
              ["Run an ingestion sync", "sports.manage"],
              ["Update configuration", "sports.manage"],
              ["Fit / approve / reject a calibration", "sports.manage"],
              ["Evaluate a match", "sports.manage"],
              ["Run the daily ticket", "sports.manage"],
              ["Run a backtest", "sports.manage"],
              ["Run the drift monitor", "sports.manage"],
              ["Recover a stuck daily run", "sports.manage"],
              ["Verify a stored result", "sports.settle"],
            ].map(([action, permission]) => (
              <tr key={action}><td>{action}</td><td><code>{permission}</code></td></tr>
            ))}
          </tbody>
        </table>
        <p className="field-hint">
          {canManage
            ? "Your role carries sports.manage, so those endpoints accept your calls directly — the screen simply offers no button for them."
            : "Your role does not carry sports.manage; those endpoints will refuse with 403."}
        </p>
      </section>
    </div>
  );
}

/** The calibration table that belongs to the sports console's model panel. */
function NodeCalibrations({ resource }) {
  if (resource.status === "loading") return <p className="field-hint">Loading calibrations…</p>;
  if (resource.status === "error") return <p className="field-hint">Calibrations unavailable: {resource.error?.message}</p>;
  const rows = resource.data?.calibrations || [];
  return (
    <>
      <h3 className="subheading">Calibrations</h3>
      {isEmptyList(rows) ? (
        <p className="empty">No calibration has been fitted. A calibration is only usable after an administrator approves it.</p>
      ) : (
        <table className="data-table">
          <thead><tr><th>Calibration</th><th>Model version</th><th>Samples</th><th>Status</th><th>Fitted (UTC)</th></tr></thead>
          <tbody>
            {rows.map((calibration) => (
              <tr key={calibration.id}>
                <td><code>#{text(calibration.id)}</code></td>
                <td className="muted">{text(calibration.model_version_id || calibration.modelVersionId)}</td>
                <td className="muted">{text(calibration.sample_size || calibration.sampleSize)}</td>
                <td><span className={`badge ${String(calibration.status) === "APPROVED" ? "badge-live" : "badge-muted"}`}>{text(calibration.status)}</span></td>
                <td className="muted">{utc(calibration.fitted_at || calibration.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/* ------------------------------------------------------------ lottery console */

/**
 * `/app/lottery` — `Lottery::index`, the operations console.
 *
 * Sections in legacy's order: engine state, provider health (live, latest
 * observation, history), the provider registry, the latest stored draw, the
 * decision reports and the disclaimer. The measured half (draws, statistics,
 * tickets, backtests, performance, models, jobs) is rendered too, because the
 * module now has it and a console that hid it would understate the module the
 * way the old hardcoded card list understated sports and lottery.
 */
export function LotteryConsoleView({ permissions }) {
  const [statKind, setStatKind] = useState("numbers");
  const [statWindow, setStatWindow] = useState(0);
  const [openDecision, setOpenDecision] = useState(null);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);

  const status = useResource(() => endpoints.lotteryStatus(), []);
  const health = useResource(() => endpoints.lotteryHealth(), []);
  const registry = useResource(() => endpoints.lotteryProviders(), []);
  const draws = useResource(() => endpoints.lotteryDraws("?limit=10"), []);
  const decisions = useResource(() => endpoints.lotteryDecisions("?limit=20"), []);
  const performance = useResource(() => endpoints.lotteryPerformance(), []);
  const models = useResource(() => endpoints.lotteryModels(), []);
  const jobs = useResource(() => endpoints.lotteryJobs("?limit=10"), []);
  const tickets = useResource(() => endpoints.lotteryTickets("?limit=25"), []);
  const statistics = useResource(() => endpoints.lotteryStatistics(statKind, `?window=${Number(statWindow) || 0}`), [statKind, statWindow]);

  const canManage = permissions.includes("lottery.manage");
  const report = status.data;
  const live = health.data?.live || {};
  const latest = health.data?.latest || null;
  const state = String(live.state || "UNKNOWN").toUpperCase();

  async function manage(key, describe, call) {
    setBusy(key);
    setMessage(null);
    try {
      const result = await call();
      setMessage({ tone: "ok", text: `${describe} — ${JSON.stringify(result).slice(0, 400)}` });
      health.retry();
      draws.retry();
    } catch (error) {
      setMessage({ tone: "error", text: error?.message || "The request did not complete." });
    } finally {
      setBusy(null);
    }
  }

  async function checkTicket(ticket) {
    setBusy(`check-${ticket.id}`);
    setMessage(null);
    try {
      const result = await endpoints.lotteryCheckTicket(ticket.id);
      setMessage({ tone: "ok", text: `Ticket #${ticket.id} checked: ${result?.status ?? "checked"}.${result?.note ? ` ${result.note}` : ""}` });
      tickets.retry();
    } catch (error) {
      setMessage({ tone: "error", text: error?.message || "The check did not complete." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">LOTTERY <span className="overline-line" /></div><h1>Operations.</h1></div>
        <Link className="text-button" to="/app/">Back to overview</Link>
      </header>

      <Notice tone="warn">
        <strong>EuroMillions draws are independent random events.</strong>{" "}
        {text(report?.disclaimer, "Historical frequency, balance scores and generation modes do not predict or improve a line's chance of winning.")}
      </Notice>

      {message ? <Notice tone={message.tone === "ok" ? "info" : "error"}>{message.text}</Notice> : null}

      <ResourcePanel title="Engine" resource={status} label="Loading engine state">
        <StatGrid items={[
          ["ENGINE", text(report?.engine)],
          ["TRACKED DRAWS", text(report?.drawsTracked)],
          ["ACTIVE RULES", report?.rules?.version ? `${report.rules.version} · ${report.rules.main?.count} mains / ${report.rules.stars?.count} stars` : "—"],
          ["MODEL VERSION", text(report?.modelVersion)],
        ]} />
        <KeyFacts entries={[
          ["ACTIVE LOTTERY", text(report?.activeLottery)],
          ["RULES RANGE", report?.rules ? `mains ${report.rules.main?.min}–${report.rules.main?.max}, stars ${report.rules.stars?.min}–${report.rules.stars?.max}` : "—"],
          ["SCHEDULE", report?.rules?.schedule ? `${(report.rules.schedule.days || []).join(", ")} at ${report.rules.schedule.time} ${report.rules.schedule.timezone}` : "—"],
          ["PROVIDER", report?.provider ? `${report.provider.state}${report.provider.synthetic ? " · synthetic" : ""}${report.provider.licensed ? " · licensed" : ""}` : "—"],
          ["PROVIDER MESSAGE", text(report?.provider?.message)],
        ]} />
        {report?.notPorted?.length ? (
          <>
            <h3 className="subheading">Not ported — the module's own matrix</h3>
            <table className="data-table">
              <thead><tr><th>Area</th><th>Legacy</th><th>State</th><th>Detail</th></tr></thead>
              <tbody>
                {report.notPorted.map((entry) => (
                  <tr key={entry.area}>
                    <td><strong>{entry.area}</strong></td>
                    <td className="muted">{entry.legacy}</td>
                    <td><span className="badge badge-warn">{entry.state}</span></td>
                    <td className="muted">{entry.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="field-hint">The module reports no unported areas.</p>
        )}
      </ResourcePanel>

      <section className="panel">
        <h2>Provider health</h2>
        {canManage ? (
          <div className="row-actions">
            <button className="primary-button" type="button" disabled={busy === "probe"}
              onClick={() => void manage("probe", "Provider health check recorded", () => endpoints.lotteryProbe())}>
              {busy === "probe" ? "Checking…" : "Check provider health"}
            </button>
            <button className="text-button" type="button" disabled={busy === "sync"}
              onClick={() => void manage("sync", "Draw sync requested", () => endpoints.lotterySync({ limit: 100 }))}>
              {busy === "sync" ? "Syncing…" : "Sync draw history"}
            </button>
          </div>
        ) : (
          <p className="field-hint">
            Health probes and draw syncs need <code>lottery.manage</code>; your role does not carry it, so no control is offered.
            Both endpoints are CSRF-protected and audited when a permitted operator uses them.
          </p>
        )}
        <StateBox status={health.status} error={health.error} retry={health.retry} label="Loading provider health">
          <KeyFacts entries={[
            ["PROVIDER", text(health.data?.provider)],
            ["LIVE STATE", <span className={`badge ${state === "ONLINE" ? "badge-live" : "badge-warn"}`}>{state}</span>],
            ["SOURCE CLASS", live.synthetic ? "Synthetic sandbox" : live.licensed ? "Authorized provider" : "No live source confirmed"],
            ["LICENSE METADATA", live.licenseConfigured || live.licensed ? "Configured / confirmed" : "Not confirmed"],
            ["LAST RECORDED CHECK", latest ? utc(latest.observed_at || latest.observedAt) : "No persisted health check"],
            ["LAST RESPONSE TIME", latest && latest.response_ms !== null && latest.response_ms !== undefined ? `${latest.response_ms} ms` : "—"],
            ["LAST DRAW RETRIEVED", text(latest?.last_draw_retrieved || latest?.lastDrawRetrieved)],
            ["SYNTHETIC DATA", live.synthetic || latest?.synthetic ? "Yes — simulation only" : "No / not reported"],
          ]} />
          <p className="field-hint">{text(live.message, "")}</p>
          <h3 className="subheading">Health history</h3>
          {isEmptyList(health.data?.history) ? (
            <p className="empty">No health observations have been saved yet. An administrator can record a probe when the source is configured.</p>
          ) : (
            <table className="data-table">
              <thead><tr><th>Observed (UTC)</th><th>State</th><th>Response</th><th>Records</th><th>Invalid</th><th>Data label</th></tr></thead>
              <tbody>
                {(health.data.history || []).map((record) => (
                  <tr key={record.id || record.observed_at}>
                    <td className="muted">{utc(record.observed_at || record.observedAt)}</td>
                    <td><span className="badge badge-muted">{text(record.status)}</span></td>
                    <td className="muted">{record.response_ms === null || record.response_ms === undefined ? "—" : `${record.response_ms} ms`}</td>
                    <td className="muted">{text(record.records_received ?? record.recordsReceived)}</td>
                    <td className="muted">{text(record.invalid_records ?? record.invalidRecords)}</td>
                    <td>{record.synthetic ? <span className="badge badge-warn">SYNTHETIC</span> : <span className="muted">reported live / unavailable</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </StateBox>
      </section>

      <ResourcePanel title="Provider registry" resource={registry} label="Loading provider registry"
        empty={<p className="empty">No provider registry rows yet. A health probe or a successful ingestion creates a source record.</p>}>
        <table className="data-table">
          <thead><tr><th>Provider</th><th>Enabled</th><th>Data class</th></tr></thead>
          <tbody>
            {(registry.data?.providers || []).map((provider) => (
              <tr key={provider.id || provider.provider_code}>
                <td><strong>{text(provider.display_name || provider.provider_code)}</strong><br /><span className="muted"><code>{text(provider.provider_code)}</code></span></td>
                <td>{provider.enabled ? "Enabled" : "Not enabled"}</td>
                <td>{provider.synthetic ? <span className="badge badge-warn">SYNTHETIC</span> : <span className="muted">Non-synthetic</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="field-hint">Registry metadata does not activate a provider. Effective access is controlled by server-side environment settings and source authorization.</p>
      </ResourcePanel>

      <section className="panel">
        <h2>Draws</h2>
        <StateBox status={draws.status} error={draws.error} retry={draws.retry} label="Loading draws"
          empty={<p className="empty">No draws are stored. The console does not generate or substitute official results.</p>}>
          <table className="data-table">
            <thead><tr><th>Draw date</th><th>Mains</th><th>Stars</th><th>Source</th><th>Verification</th><th>Retrieved (UTC)</th></tr></thead>
            <tbody>
              {(draws.data?.draws || []).map((draw) => {
                const numbers = draw.numbers || draw.payload || {};
                const mains = numbers.main || numbers.mains || [];
                const stars = numbers.stars || [];
                return (
                  <tr key={draw.id}>
                    <td><code>{text(draw.draw_date || draw.drawDate)}</code></td>
                    <td>{isEmptyList(mains) ? <span className="muted">—</span> : mains.join(" · ")}</td>
                    <td>{isEmptyList(stars) ? <span className="muted">—</span> : stars.join(" · ")}</td>
                    <td className="muted">{text(draw.source)}</td>
                    <td><span className={`badge ${String(draw.verification_status || draw.verificationStatus) === "VERIFIED" ? "badge-live" : "badge-muted"}`}>{text(draw.verification_status || draw.verificationStatus)}</span></td>
                    <td className="muted">{utc(draw.retrieved_at || draw.retrievedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {report?.lastDraw ? (
            <p className="field-hint">
              Latest stored draw: <code>{text(report.lastDraw.draw_date || report.lastDraw.drawDate)}</code> from{" "}
              <code>{text(report.lastDraw.source)}</code>, {text(report.lastDraw.verification_status || report.lastDraw.verificationStatus)}.
            </p>
          ) : null}
        </StateBox>
      </section>

      <section className="panel">
        <h2>Statistics</h2>
        <form className="panel-form inline" onSubmit={(event) => event.preventDefault()}>
          <Field label="Kind" htmlFor="lo-kind">
            <select id="lo-kind" value={statKind} onChange={(event) => setStatKind(event.target.value)}>
              {LOTTERY_STATISTICS_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
            </select>
          </Field>
          <Field label="Window (draws)" htmlFor="lo-window" hint="0 = all stored draws">
            <input id="lo-window" type="number" min="0" max="10000" value={statWindow} onChange={(event) => setStatWindow(event.target.value)} />
          </Field>
        </form>
        <StateBox status={statistics.status} error={statistics.error} retry={statistics.retry} label="Loading statistics">
          <StatisticsView kind={statistics.data?.kind || statKind} data={statistics.data?.data} />
        </StateBox>
        <p className="field-hint">
          Every figure below is an observation over stored draws. The independence disclaimer the API attaches to each
          output is shown with it; nothing here is a forecast.
        </p>
      </section>

      <section className="panel">
        <h2>AI decision reports <span className="badge badge-muted">Historical records · not predictions</span></h2>
        <StateBox status={decisions.status} error={decisions.error} retry={decisions.retry} label="Loading decision reports"
          empty={<p className="empty">No decision reports stored yet. Generating a combination through the Lottery API creates one linked to its saved combination.</p>}>
          <table className="data-table">
            <thead><tr><th>ID</th><th>Created (UTC)</th><th>Mode</th><th>Model</th><th>Combination</th><th /></tr></thead>
            <tbody>
              {(decisions.data?.decisions || []).map((row) => (
                <tr key={row.id}>
                  <td><code>#{text(row.id)}</code></td>
                  <td className="muted">{utc(row.created_at || row.createdAt)}</td>
                  <td><span className="badge badge-muted">{text(row.mode || row.decision?.mode)}</span></td>
                  <td className="muted">{text(row.model_version || row.modelVersion || row.decision?.model)}</td>
                  <td>{row.combination_id ? <code>#{text(row.combination_id)}</code> : <span className="muted">—</span>}</td>
                  <td className="row-actions">
                    <button className="text-button" type="button" aria-expanded={openDecision === row.id} onClick={() => setOpenDecision(openDecision === row.id ? null : row.id)}>
                      {openDecision === row.id ? "Hide report" : "Inspect report"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {openDecision !== null ? (
            <pre className="json-block">
              {JSON.stringify((decisions.data?.decisions || []).find((row) => row.id === openDecision)?.decision ?? {}, null, 2)}
            </pre>
          ) : null}
        </StateBox>
      </section>

      <section className="panel">
        <h2>Tickets</h2>
        <p className="field-hint">
          A saved ticket is a record of number lines, never a purchase. Checking compares it against stored VERIFIED
          draws and reports official prize-tier labels — never an amount.
        </p>
        <StateBox status={tickets.status} error={tickets.error} retry={tickets.retry} label="Loading tickets"
          empty={<p className="empty">No ticket has been saved for this account.</p>}>
          <table className="data-table">
            <thead><tr><th>Ticket</th><th>Name</th><th>Lines</th><th>Status</th><th>Draw date</th><th>Checked</th><th /></tr></thead>
            <tbody>
              {(tickets.data?.tickets || []).map((ticket) => (
                <tr key={ticket.id}>
                  <td><code>#{text(ticket.id)}</code></td>
                  <td>{text(ticket.name)}</td>
                  <td className="muted">{Array.isArray(ticket.lines) ? ticket.lines.length : text(ticket.line_count ?? ticket.lineCount)}</td>
                  <td><span className="badge badge-muted">{text(ticket.status)}</span>{ticket.archived ? <span className="badge badge-muted">archived</span> : null}</td>
                  <td className="muted">{text(ticket.draw_date || ticket.drawDate)}</td>
                  <td className="muted">{utc(ticket.checked_at || ticket.checkedAt)}</td>
                  <td className="row-actions">
                    {!ticket.archived && String(ticket.status) !== "CHECKED" ? (
                      <button className="text-button" type="button" disabled={busy === `check-${ticket.id}`}
                        onClick={() => void checkTicket(ticket)}>{busy === `check-${ticket.id}` ? "Checking…" : "Check"}</button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </StateBox>
      </section>

      <ResourcePanel title="Performance" resource={performance} label="Loading performance">
        <p className="field-hint">{text(performance.data?.label, "")}</p>
        {[
          ["actualTicketResults", "ACTUAL TICKET RESULTS"],
          ["historicalBacktestResults", "HISTORICAL BACKTEST RESULTS"],
          ["demoSandboxData", "DEMO / SANDBOX DATA"],
        ].map(([key, heading]) => {
          const section = performance.data?.[key];
          if (!section) return null;
          return (
            <div key={key}>
              <h3 className="subheading">{heading}</h3>
              <KeyFacts entries={Object.entries(section).filter(([field]) => field !== "section" && field !== "recent" && field !== "byTier").map(([field, value]) => [field.replace(/([A-Z])/g, " $1").toUpperCase(), value])} />
              {Array.isArray(section.byTier) && section.byTier.length ? (
                <table className="data-table">
                  <thead><tr><th>Tier</th><th>Count</th></tr></thead>
                  <tbody>{section.byTier.map((tier) => <tr key={tier.tier || tier.label}><td>{text(tier.tier || tier.label)}</td><td className="muted">{text(tier.count)}</td></tr>)}</tbody>
                </table>
              ) : null}
            </div>
          );
        })}
        <p className="field-hint">{text(performance.data?.separationNote, "")}</p>
      </ResourcePanel>

      <ResourcePanel title="Models" resource={models} label="Loading models"
        empty={<p className="empty">No model version row exists yet.</p>}>
        <table className="data-table">
          <thead><tr><th>Model</th><th>Version</th><th>Status</th><th>Created (UTC)</th></tr></thead>
          <tbody>
            {(models.data?.models || []).map((model) => (
              <tr key={model.id}>
                <td><strong>{text(model.model_name || model.modelName)}</strong></td>
                <td className="muted">{text(model.model_version || model.modelVersion)}</td>
                <td><span className="badge badge-muted">{text(model.status)}</span></td>
                <td className="muted">{utc(model.created_at || model.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="field-hint">Model versions are never deleted or replaced; historical reports stay connected to the model that produced them.</p>
      </ResourcePanel>

      <ResourcePanel title="Scheduled jobs" resource={jobs} label="Loading jobs"
        empty={<p className="empty">No job run recorded. The lottery cron is CLI-only (<code>npm run lottery:jobs</code>) and this screen cannot start it.</p>}>
        <table className="data-table">
          <thead><tr><th>Job</th><th>Execution key</th><th>Status</th><th>Started (UTC)</th></tr></thead>
          <tbody>
            {(jobs.data?.jobs || []).map((job) => (
              <tr key={job.id || job.execution_key}>
                <td><code>{text(job.job_type || job.jobType)}</code></td>
                <td className="muted">{text(job.execution_key || job.executionKey)}</td>
                <td><span className="badge badge-muted">{text(job.status)}</span></td>
                <td className="muted">{utc(job.started_at || job.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResourcePanel>
    </div>
  );
}

/**
 * One statistics output, rendered by kind.
 *
 * The shapes are the ported PHP engines' own (see `statistics.js`): a per-number
 * map for `numbers`/`stars`, hot/cold maps, a distribution block and a `top`
 * list for the pair families. Anything the layout does not name falls back to a
 * key/value list rather than being dropped, and the API's `disclaimer` is always
 * rendered — a statistic printed without it would read as a forecast.
 */
function StatisticsView({ kind, data }) {
  if (!data) return <p className="empty">No statistics payload was returned.</p>;
  const disclaimer = data.disclaimer ? <p className="notice notice-warn">{data.disclaimer}</p> : null;

  if ((kind === "numbers" || kind === "stars") && data.numbers) {
    const rows = Object.values(data.numbers).filter((row) => row && typeof row === "object");
    return (
      <>
        {disclaimer}
        {!rows.length ? <p className="empty">No numbers were returned for this window.</p> : (
          <table className="data-table">
            <thead><tr><th>Number</th><th>Appearances</th><th>Appearance %</th><th>Current gap</th><th>Avg gap</th><th>Recent</th><th>Trend</th></tr></thead>
            <tbody>
              {rows.slice(0, 60).map((row) => (
                <tr key={row.number}>
                  <td><strong>{text(row.number)}</strong></td>
                  <td className="muted">{text(row.appearances)}</td>
                  <td className="muted">{num(row.appearancePct, 2)}</td>
                  <td className="muted">{text(row.currentGap)}</td>
                  <td className="muted">{num(row.avgGap, 2)}</td>
                  <td className="muted">{text(row.recentAppearances)}</td>
                  <td className="muted">{num(row.trend, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <KeyFacts entries={[["TOTAL DRAWS", text(data.totalDraws)], ["WINDOW", text(data.window)]]} />
      </>
    );
  }

  if (kind === "hot-cold") {
    const chips = (map) => Object.entries(map || {}).map(([number, count]) => `${number}×${count}`).join(" · ");
    return (
      <>
        {disclaimer}
        <KeyFacts entries={[["HOT", chips(data.hot)], ["COLD", chips(data.cold)], ["WINDOW", text(data.window)]]} />
        <p className="field-hint">{text(data.observation, "")}</p>
      </>
    );
  }

  if (kind === "distribution") {
    return (
      <>
        {disclaimer}
        <KeyFacts entries={[
          ["TOTAL DRAWS", text(data.totalDraws)],
          ["ODD / EVEN", Array.isArray(data.oddEven) && data.oddEven.length ? data.oddEven.map((row) => `${text(row.odd)}/${text(row.even)}: ${text(row.count)}`).join(" · ") : "—"],
          ["LOW / HIGH", Array.isArray(data.lowHigh) && data.lowHigh.length ? data.lowHigh.map((row) => `${text(row.low)}/${text(row.high)}: ${text(row.count)}`).join(" · ") : "—"],
          ["SUM", data.sum ? `min ${text(data.sum.min)} · max ${text(data.sum.max)} · avg ${num(data.sum.avg, 1)} · median ${text(data.sum.median)}` : "—"],
          ["SPREAD", data.spread ? `min ${text(data.spread.min)} · max ${text(data.spread.max)} · avg ${num(data.spread.avg, 1)}` : "—"],
          ["CONSECUTIVE", data.consecutive ? `${text(data.consecutive.drawsWithConsecutive)} draw(s) · ${num(data.consecutive.pct, 1)}%` : "—"],
        ]} />
      </>
    );
  }

  // pairs, triplets, star-pairs
  const top = Array.isArray(data.top) ? data.top : [];
  return (
    <>
      {disclaimer}
      <KeyFacts entries={[["TOTAL DRAWS", text(data.totalDraws)], ["K", text(data.k)], ["GROUPS", Array.isArray(data.groups) ? data.groups.length : text(data.groups)]]} />
      {top.length ? (
        <table className="data-table">
          <thead><tr><th>Combination</th><th>Count</th></tr></thead>
          <tbody>
            {top.slice(0, 40).map((row, index) => (
              <tr key={index}>
                <td>{text(row.numbers || row.combination || row.pair || row.key)}</td>
                <td className="muted">{text(row.count ?? row.appearances)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty">No combination groups were returned for this window.</p>
      )}
    </>
  );
}
