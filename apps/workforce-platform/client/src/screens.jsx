/**
 * Console screens (Phase 27).
 *
 * Three screens for three APIs that were ported, tested and then had nothing to
 * click: the notification inbox (`GET /api/v1/notifications`), the audit browser
 * (`GET /api/v1/admin/audit`) and the research-only portfolio optimizer
 * (`POST /api/v1/portfolio/optimize`). Finding **F-29** recorded that no ported
 * module had a console screen; these three are the first, and the finding now
 * names what is still missing (the sports and lottery consoles) rather than the
 * whole platform.
 *
 * Rules these screens hold to, because the API does:
 *
 *  - **No invented data.** Every figure is a value the server returned. Where the
 *    server sends a provenance block, the screen renders it next to the number
 *    rather than quietly dropping it.
 *  - **No silent state.** Loading, empty, error and offline are the default
 *    (`StateBox`), and a 403 is shown as the server's refusal, not as an empty
 *    list that looks like "there was nothing to see".
 *  - **No authority of their own.** Permission checks in the shell are
 *    presentation only; the API re-checks and refuses with 403 regardless.
 */

import { useMemo, useState } from "react";
import { endpoints } from "./api.js";
import { Link } from "./router.jsx";
import { Field, Notice, StateBox, useResource } from "./ui.jsx";
import {
  AUDIT_DIRECTIONS,
  AUDIT_LIMIT_MAX,
  AUDIT_SORTS,
  INBOX_LIMIT_MAX,
  MAX_ASSETS,
  MAX_CANDLE_LIMIT,
  MIN_ASSETS,
  MIN_CANDLE_LIMIT,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_TYPES,
  PORTFOLIO_MARKET_CLASSES,
  PORTFOLIO_OBJECTIVES,
  PORTFOLIO_TIMEFRAMES,
} from "./contracts.js";

/** An ISO-8601 UTC instant, exactly the shape the audit window validator accepts. */
function utcStamp(value) {
  if (!value) return "";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return String(value);
  return new Date(parsed).toISOString();
}

/** Render an instant as `YYYY-MM-DD HH:MM:SS` UTC, labelled as UTC by the caller. */
function utcDisplay(value) {
  const stamp = utcStamp(value);
  return stamp ? `${stamp.slice(0, 10)} ${stamp.slice(11, 19)}` : "";
}

function percent(weight, digits = 2) {
  const value = Number(weight);
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

function decimal(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toFixed(digits);
}

const SEVERITY_BADGE = { info: "badge", warning: "badge-warn", critical: "badge-critical" };

/* -------------------------------------------------------- notification inbox */

/**
 * The operator inbox. Delivery is the part that does not exist: alerts are
 * stored and read here, and the screen says so using the server's own
 * `deliveryChannels` value rather than a sentence someone could forget to update.
 */
export function NotificationsView() {
  const [query, setQuery] = useState({ unread: false, severity: "", type: "", limit: 50 });
  const [applied, setApplied] = useState({ unread: false, severity: "", type: "", limit: 50 });
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const params = new URLSearchParams({ limit: String(applied.limit) });
  if (applied.unread) params.set("unread", "1");
  if (applied.severity) params.set("severity", applied.severity);
  if (applied.type) params.set("type", applied.type);
  const queryString = `?${params.toString()}`;

  const inbox = useResource(() => endpoints.notifications(queryString), [queryString]);
  const status = useResource(() => endpoints.status(), []);
  const delivery = status.data?.notifications || null;

  async function act(label, call) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await call();
      const marked = result?.markedRead;
      setMessage({ tone: "ok", text: marked === undefined ? `${label} done.` : `${label}: ${marked} notification${marked === 1 ? "" : "s"} marked read.` });
      inbox.retry();
    } catch (error) {
      setMessage({ tone: "error", text: error?.message || `${label} failed.` });
    } finally {
      setBusy(false);
    }
  }

  const notifications = inbox.data?.notifications || [];

  return (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">OPERATIONS <span className="overline-line" /></div><h1>Your alerts, and only yours.</h1></div>
        <Link className="text-button" to="/app/">Back to overview</Link>
      </header>

      {message ? <Notice tone={message.tone === "ok" ? "info" : "error"}>{message.text}</Notice> : null}

      <Notice tone="warn">
        <strong>No outbound delivery channel is configured.</strong>{" "}
        {delivery
          ? `The server reports ${delivery.deliveryChannels?.length ? delivery.deliveryChannels.join(", ") : "no channels"}`
          : "Reading the server's delivery channels…"}
        {delivery?.emailDeliveryAvailable === false ? " and no email transport" : ""} —
        an alert is stored and read here, and nothing on this platform reports one as delivered to an inbox or a device.
      </Notice>

      <section className="panel">
        <h2>Inbox</h2>
        <form className="panel-form inline" onSubmit={(event) => { event.preventDefault(); setApplied({ ...query }); }}>
          <Field label="Unread only" htmlFor="n-unread">
            <label className="checkbox-row" htmlFor="n-unread">
              <input id="n-unread" type="checkbox" checked={query.unread} onChange={(event) => setQuery((current) => ({ ...current, unread: event.target.checked }))} />
              <span>Hide what I have already read</span>
            </label>
          </Field>
          <Field label="Severity" htmlFor="n-severity">
            <select id="n-severity" value={query.severity} onChange={(event) => setQuery((current) => ({ ...current, severity: event.target.value }))}>
              <option value="">any</option>
              {NOTIFICATION_SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
            </select>
          </Field>
          <Field label="Type" htmlFor="n-type">
            <select id="n-type" value={query.type} onChange={(event) => setQuery((current) => ({ ...current, type: event.target.value }))}>
              <option value="">any</option>
              {NOTIFICATION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </Field>
          <Field label="Page size" htmlFor="n-limit" hint={`1–${INBOX_LIMIT_MAX}`}>
            <input id="n-limit" type="number" min="1" max={INBOX_LIMIT_MAX} value={query.limit} onChange={(event) => setQuery((current) => ({ ...current, limit: event.target.value }))} />
          </Field>
          <button className="primary-button" type="submit">Apply</button>
        </form>
        <p className="field-hint">
          Severity and type are applied to the newest page the server returns, as the legacy endpoint did — they narrow
          this page, they do not scan the table. The unread count below always covers every alert visible to you.
        </p>

        <StateBox status={inbox.status} error={inbox.error} retry={inbox.retry} label="Loading alerts"
          empty={<p className="empty">No alerts match this filter. Nothing is fabricated to fill the page.</p>}>
          <div className="inbox-summary">
            <span><strong>{inbox.data?.unread ?? 0}</strong> unread</span>
            <span>{notifications.length} shown{inbox.data?.unreadOnly ? " · unread only" : ""}</span>
            <button className="text-button" type="button" disabled={busy || !inbox.data?.unread} onClick={() => void act("Mark all read", () => endpoints.markAllNotificationsRead())}>
              Mark all read
            </button>
          </div>
          <ul className="activity-list">
            {notifications.map((entry) => (
              <li key={entry.id}>
                <span className={`badge ${SEVERITY_BADGE[entry.severity] || "badge"}`}>{entry.severity}</span>
                <code>{entry.type}</code>
                <strong className="notification-title">{entry.title}</strong>
                {entry.broadcast ? <span className="badge badge-muted">broadcast</span> : null}
                {entry.unread ? <span className="badge badge-live">unread</span> : <span className="muted">read {utcDisplay(entry.readAt)} UTC</span>}
                <span className="muted">{utcDisplay(entry.createdAt)} UTC</span>
                {entry.dedupeKey ? <span className="activity-entity">key {entry.dedupeKey}</span> : null}
                {entry.unread ? (
                  <button className="text-button" type="button" disabled={busy} onClick={() => void act("Mark read", () => endpoints.markNotificationRead(entry.id))}>Mark read</button>
                ) : null}
                {entry.detail && Object.keys(entry.detail).length ? (
                  <dl className="detail-grid">
                    {Object.entries(entry.detail).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </li>
            ))}
          </ul>
        </StateBox>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ audit browser */

/**
 * The audit browser. It is read-only on the server and the screen shows the
 * server's own `meta.mutable: false` rather than promising it in prose — the
 * applied filters come from `meta.filters` too, so the operator sees what the
 * server actually filtered on instead of what the form happens to hold.
 */
export function AuditBrowserView() {
  const [query, setQuery] = useState({
    actor: "any", action: "", entityType: "", entityId: "", from: "", to: "",
    sort: "createdAt", direction: "desc", limit: 50,
  });
  const [applied, setApplied] = useState({ ...query, offset: 0 });
  const [open, setOpen] = useState(null);

  const params = new URLSearchParams({
    limit: String(applied.limit),
    offset: String(applied.offset || 0),
    sort: applied.sort,
    direction: applied.direction,
  });
  if (applied.actor && applied.actor !== "any") params.set("actor", applied.actor);
  if (applied.action) params.set("action", applied.action);
  if (applied.entityType) params.set("entityType", applied.entityType);
  if (applied.entityId) params.set("entityId", applied.entityId);
  if (applied.from) params.set("from", applied.from);
  if (applied.to) params.set("to", applied.to);
  const queryString = `?${params.toString()}`;

  const audit = useResource(() => endpoints.audit(queryString), [queryString]);
  const meta = audit.data?.meta;
  const events = audit.data?.events || [];

  function window_(hours) {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - hours * 3600_000).toISOString();
    setQuery((current) => ({ ...current, from, to }));
  }

  return (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">ADMINISTRATION <span className="overline-line" /></div><h1>The whole trail, attributed and filterable.</h1></div>
        <Link className="text-button" to="/app/">Back to overview</Link>
      </header>

      <Notice tone={meta && meta.mutable === false ? "warn" : "info"}>
        <strong>Read-only.</strong>{" "}
        {meta
          ? `The server states mutable: ${String(meta.mutable)} — no route on either storage adapter can edit, redact or delete an audit event.`
          : "Loading the server's statement about mutability…"}
        {" "}Node widened the authority the legacy endpoint had: this needs <code>identity.users.view</code>, not merely a signed-in session (divergence AV-1).
      </Notice>

      <section className="panel">
        <h2>Filters</h2>
        <form className="panel-form inline" onSubmit={(event) => { event.preventDefault(); setApplied({ ...query, limit: query.limit, offset: 0 }); }}>
          <Field label="Actor" htmlFor="a-actor" hint="any · system · numeric user id">
            <input id="a-actor" maxLength="20" value={query.actor} onChange={(event) => setQuery((current) => ({ ...current, actor: event.target.value }))} />
          </Field>
          <Field label="Action" htmlFor="a-action" hint="Prefix match, e.g. sports.sync">
            <input id="a-action" maxLength="96" value={query.action} onChange={(event) => setQuery((current) => ({ ...current, action: event.target.value }))} />
          </Field>
          <Field label="Entity type" htmlFor="a-entity-type">
            <input id="a-entity-type" maxLength="64" value={query.entityType} onChange={(event) => setQuery((current) => ({ ...current, entityType: event.target.value }))} />
          </Field>
          <Field label="Entity id" htmlFor="a-entity-id">
            <input id="a-entity-id" maxLength="96" value={query.entityId} onChange={(event) => setQuery((current) => ({ ...current, entityId: event.target.value }))} />
          </Field>
          <Field label="From (UTC)" htmlFor="a-from" hint="ISO-8601 ending in Z">
            <input id="a-from" maxLength="40" placeholder="2026-10-01T00:00:00.000Z" value={query.from} onChange={(event) => setQuery((current) => ({ ...current, from: event.target.value }))} />
          </Field>
          <Field label="To (UTC)" htmlFor="a-to" hint="ISO-8601 ending in Z">
            <input id="a-to" maxLength="40" placeholder="2026-10-13T00:00:00.000Z" value={query.to} onChange={(event) => setQuery((current) => ({ ...current, to: event.target.value }))} />
          </Field>
          <Field label="Sort" htmlFor="a-sort">
            <select id="a-sort" value={query.sort} onChange={(event) => setQuery((current) => ({ ...current, sort: event.target.value }))}>
              {AUDIT_SORTS.map((sort) => <option key={sort} value={sort}>{sort}</option>)}
            </select>
          </Field>
          <Field label="Direction" htmlFor="a-direction">
            <select id="a-direction" value={query.direction} onChange={(event) => setQuery((current) => ({ ...current, direction: event.target.value }))}>
              {AUDIT_DIRECTIONS.map((direction) => <option key={direction} value={direction}>{direction}</option>)}
            </select>
          </Field>
          <Field label="Page size" htmlFor="a-limit" hint={`1–${AUDIT_LIMIT_MAX}`}>
            <input id="a-limit" type="number" min="1" max={AUDIT_LIMIT_MAX} value={query.limit} onChange={(event) => setQuery((current) => ({ ...current, limit: event.target.value }))} />
          </Field>
          <button className="primary-button" type="submit">Apply</button>
        </form>
        <div className="row-actions">
          <button className="text-button" type="button" onClick={() => window_(24)}>Last 24 hours</button>
          <button className="text-button" type="button" onClick={() => window_(24 * 7)}>Last 7 days</button>
          <button className="text-button" type="button" onClick={() => setQuery((current) => ({ ...current, from: "", to: "" }))}>Clear window</button>
        </div>
        <p className="field-hint">
          A timezone offset in a window value is refused, not guessed at: the audit timestamp column carries no timezone.
          The quick ranges write canonical UTC instants into the fields above, so what is sent is what is visible.
        </p>

        <StateBox status={audit.status} error={audit.error} retry={audit.retry} label="Loading the trail"
          empty={<p className="empty">No audit events match. An empty result is an empty result — nothing is substituted.</p>}>
          {meta ? (
            <p className="field-hint">
              Applied by the server: action <code>{meta.filters?.action ?? "any"}</code> · entity{" "}
              <code>{meta.filters?.entityType ?? "any"}</code>#{meta.filters?.entityId ?? "—"} · actor{" "}
              <code>{meta.filters?.actor === null || meta.filters?.actor === undefined ? "any" : String(meta.filters.actor)}</code> · from{" "}
              <code>{meta.filters?.from ?? "unbounded"}</code> to <code>{meta.filters?.to ?? "unbounded"}</code> · mutable{" "}
              <code>{String(meta.mutable)}</code>
            </p>
          ) : null}
          <table className="data-table">
            <thead><tr><th>When (UTC)</th><th>Actor</th><th>Action</th><th>Entity</th><th /></tr></thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>{utcDisplay(event.createdAt)}</td>
                  <td>
                    {event.actor?.kind === "system"
                      ? <span className="badge badge-muted">system</span>
                      : <>{event.actor?.username || <span className="muted">unknown user</span>}<small className="muted"> · #{event.actor?.userId}</small></>}
                  </td>
                  <td><code>{event.action}</code></td>
                  <td>{event.entityType ? <>{event.entityType}<small className="muted"> #{event.entityId}</small></> : <span className="muted">—</span>}</td>
                  <td className="row-actions">
                    <button className="text-button" type="button" aria-expanded={open === event.id} onClick={() => setOpen(open === event.id ? null : event.id)}>
                      {open === event.id ? "Hide detail" : "Detail"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {events.some((event) => open === event.id) ? (
            <pre className="json-block">
              {JSON.stringify(events.find((event) => event.id === open)?.details ?? {}, null, 2)}
            </pre>
          ) : null}
          <div className="pagination">
            <button className="text-button" type="button" disabled={(applied.offset || 0) === 0}
              onClick={() => setApplied((current) => ({ ...current, offset: Math.max(0, (current.offset || 0) - Number(current.limit)) }))}>← Previous</button>
            <span>
              {(meta?.total || 0) === 0 ? "0" : `${(applied.offset || 0) + 1}–${Math.min(meta?.total || 0, (applied.offset || 0) + events.length)}`} of {meta?.total ?? 0}
            </span>
            <button className="text-button" type="button" disabled={(applied.offset || 0) + events.length >= (meta?.total || 0)}
              onClick={() => setApplied((current) => ({ ...current, offset: (current.offset || 0) + Number(current.limit) }))}>Next →</button>
          </div>
        </StateBox>
      </section>
    </div>
  );
}

/* ------------------------------------------------------- portfolio optimizer */

const EMPTY_ASSET = { symbol: "", marketClass: "forex" };

/**
 * Research-only portfolio optimization.
 *
 * The screen submits a universe and renders the weights the optimizer solved for.
 * It has no order path because the endpoint has none: `additionalProperties:
 * false` makes an undeclared key like `execute` a 400 rather than a field the
 * caller believes took effect, and the service is never given the paper,
 * strategy or execution services.
 */
export function PortfolioOptimizerView() {
  const [draft, setDraft] = useState({
    assets: [{ symbol: "EURUSD", marketClass: "forex" }, { symbol: "GBPUSD", marketClass: "forex" }],
    timeframe: "1d",
    limit: 500,
    objective: "max_sharpe",
    maxWeight: "",
    riskFreeRate: "",
    shrinkage: "",
    periodsPerYear: "",
    allowSyntheticData: false,
  });
  const [report, setReport] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const problems = useMemo(() => {
    const found = [];
    const filled = draft.assets.filter((asset) => asset.symbol.trim() !== "");
    if (filled.length < MIN_ASSETS) found.push(`At least ${MIN_ASSETS} assets are required.`);
    if (draft.assets.length > MAX_ASSETS) found.push(`At most ${MAX_ASSETS} assets are accepted.`);
    for (const asset of draft.assets) {
      if (asset.symbol.trim() === "") found.push("Every row needs a symbol.");
      else if (asset.symbol.trim().length < 2 || asset.symbol.trim().length > 24) found.push(`"${asset.symbol}" must be 2–24 characters.`);
    }
    const limit = Number(draft.limit);
    if (!Number.isInteger(limit) || limit < MIN_CANDLE_LIMIT || limit > MAX_CANDLE_LIMIT) found.push(`History depth must be ${MIN_CANDLE_LIMIT}–${MAX_CANDLE_LIMIT} candles.`);
    if (new Set(draft.assets.map((asset) => `${asset.symbol.trim().toUpperCase()}|${asset.marketClass}`)).size !== draft.assets.length) found.push("The same symbol and market class is listed twice.");
    return [...new Set(found)];
  }, [draft]);

  async function run(event) {
    event.preventDefault();
    if (problems.length) return;
    setBusy(true);
    setError(null);
    setReport(null);
    setNotice("");
    // Only non-empty optional fields are sent: an omitted key takes the server's
    // declared default, while an empty string would be a validation error.
    const payload = {
      assets: draft.assets.map((asset) => ({ symbol: asset.symbol.trim().toUpperCase(), marketClass: asset.marketClass })),
      timeframe: draft.timeframe,
      limit: Number(draft.limit),
      objective: draft.objective,
    };
    for (const key of ["maxWeight", "riskFreeRate", "shrinkage", "periodsPerYear"]) {
      if (draft[key] !== "") payload[key] = Number(draft[key]);
    }
    if (draft.allowSyntheticData) payload.allowSyntheticData = true;
    try {
      const result = await endpoints.optimizePortfolio(payload);
      setReport(result?.optimization || null);
      setNotice(result?.notice || "");
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  const allocations = report ? Object.entries(report.allocations || {}) : [];

  return (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">RESEARCH <span className="overline-line" /></div><h1>Weights, not instructions.</h1></div>
        <Link className="text-button" to="/app/">Back to overview</Link>
      </header>

      <Notice tone="warn">
        <strong>Research only.</strong>{" "}
        {notice || "This endpoint returns portfolio weights and nothing else. It cannot place an order: the service is not given the paper, strategy or execution services, and an undeclared key such as execute or amount is refused with 400 rather than ignored."}
      </Notice>

      <section className="panel">
        <h2>Universe</h2>
        <form className="panel-form" onSubmit={run}>
          <div className="asset-rows">
            {draft.assets.map((asset, index) => (
              <div className="asset-row" key={index}>
                <Field label={`Symbol ${index + 1}`} htmlFor={`p-symbol-${index}`}>
                  <input id={`p-symbol-${index}`} maxLength="24" value={asset.symbol}
                    onChange={(event) => setDraft((current) => ({ ...current, assets: current.assets.map((row, i) => (i === index ? { ...row, symbol: event.target.value } : row)) }))} />
                </Field>
                <Field label="Market class" htmlFor={`p-class-${index}`}>
                  <select id={`p-class-${index}`} value={asset.marketClass}
                    onChange={(event) => setDraft((current) => ({ ...current, assets: current.assets.map((row, i) => (i === index ? { ...row, marketClass: event.target.value } : row)) }))}>
                    {PORTFOLIO_MARKET_CLASSES.map((marketClass) => <option key={marketClass} value={marketClass}>{marketClass}</option>)}
                  </select>
                </Field>
                <button className="text-button" type="button" disabled={draft.assets.length <= MIN_ASSETS}
                  onClick={() => setDraft((current) => ({ ...current, assets: current.assets.filter((_, i) => i !== index) }))}>Remove</button>
              </div>
            ))}
          </div>
          <button className="text-button" type="button" disabled={draft.assets.length >= MAX_ASSETS}
            onClick={() => setDraft((current) => ({ ...current, assets: [...current.assets, { ...EMPTY_ASSET }] }))}>
            + Add asset ({draft.assets.length}/{MAX_ASSETS})
          </button>

          <div className="panel-form grid">
            <Field label="Timeframe" htmlFor="p-timeframe">
              <select id="p-timeframe" value={draft.timeframe} onChange={(event) => setDraft((current) => ({ ...current, timeframe: event.target.value }))}>
                {PORTFOLIO_TIMEFRAMES.map((timeframe) => <option key={timeframe} value={timeframe}>{timeframe}</option>)}
              </select>
            </Field>
            <Field label="History depth" htmlFor="p-limit" hint={`${MIN_CANDLE_LIMIT}–${MAX_CANDLE_LIMIT} candles`}>
              <input id="p-limit" type="number" min={MIN_CANDLE_LIMIT} max={MAX_CANDLE_LIMIT} value={draft.limit} onChange={(event) => setDraft((current) => ({ ...current, limit: event.target.value }))} />
            </Field>
            <Field label="Objective" htmlFor="p-objective">
              <select id="p-objective" value={draft.objective} onChange={(event) => setDraft((current) => ({ ...current, objective: event.target.value }))}>
                {PORTFOLIO_OBJECTIVES.map((objective) => <option key={objective} value={objective}>{objective}</option>)}
              </select>
            </Field>
            <Field label="Max weight per asset" htmlFor="p-max-weight" hint="Blank = server default. Below 1/n the solver refuses.">
              <input id="p-max-weight" type="number" step="0.01" min="0" max="1" value={draft.maxWeight} onChange={(event) => setDraft((current) => ({ ...current, maxWeight: event.target.value }))} />
            </Field>
            <Field label="Risk-free rate (annual decimal)" htmlFor="p-risk-free" hint="0.04 is 4%">
              <input id="p-risk-free" type="number" step="0.001" min="-0.1" max="1" value={draft.riskFreeRate} onChange={(event) => setDraft((current) => ({ ...current, riskFreeRate: event.target.value }))} />
            </Field>
            <Field label="Covariance shrinkage" htmlFor="p-shrinkage" hint="0 = sample covariance, 1 = diagonal only">
              <input id="p-shrinkage" type="number" step="0.05" min="0" max="1" value={draft.shrinkage} onChange={(event) => setDraft((current) => ({ ...current, shrinkage: event.target.value }))} />
            </Field>
            <Field label="Periods per year" htmlFor="p-periods" hint="Required when the universe mixes market classes.">
              <input id="p-periods" type="number" min="1" max="100000" value={draft.periodsPerYear} onChange={(event) => setDraft((current) => ({ ...current, periodsPerYear: event.target.value }))} />
            </Field>
            <Field label="Synthetic history" htmlFor="p-synthetic" hint="Required on a host with no real provider; the report labels itself SIMULATION.">
              <label className="checkbox-row" htmlFor="p-synthetic">
                <input id="p-synthetic" type="checkbox" checked={draft.allowSyntheticData} onChange={(event) => setDraft((current) => ({ ...current, allowSyntheticData: event.target.checked }))} />
                <span>Allow synthetic (labelled) inputs</span>
              </label>
            </Field>
          </div>

          {problems.length ? <ul className="problem-list">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul> : null}
          <button className="primary-button" type="submit" disabled={busy || problems.length > 0}>{busy ? "Solving…" : "Optimize"}</button>
        </form>
      </section>

      {error ? (
        <Notice tone="error">
          <strong>{error.message}</strong>
          {error.code ? <> <code>{error.code}</code></> : null}
          {error.retryAfter ? <> Try again in about {error.retryAfter}s.</> : null}
          {error.status === 403 ? <> Your role does not carry <code>trading.view</code>; the server refused this run.</> : null}
        </Notice>
      ) : null}

      {report ? (
        <>
          <section className="panel">
            <h2>Run</h2>
            <dl className="status-list">
              <dt>Status</dt><dd><span className="badge badge-warn">{report.status}</span> <span className="muted">computed {utcDisplay(report.computedAt)} UTC</span></dd>
              <dt>Model</dt><dd><code>{report.model}</code></dd>
              <dt>Objective</dt><dd><code>{report.objective}</code></dd>
              <dt>Window</dt><dd>{report.window?.timeframe} · {report.window?.returnObservations} returns from {report.window?.alignedPriceObservations} aligned prices · {report.window?.periodsPerYear} periods/year</dd>
              <dt>Constraints</dt><dd>long-only {String(report.constraints?.longOnly)} · fully invested {String(report.constraints?.fullyInvested)} · cap {decimal(report.constraints?.maximumWeightPerAsset, 2)} · gross leverage {decimal(report.constraints?.grossLeverage, 2)}</dd>
              <dt>Estimation</dt><dd>{report.estimation?.expectedReturn}; {report.estimation?.covariance}{report.estimation?.shrinkage !== undefined ? ` (shrinkage ${decimal(report.estimation.shrinkage, 2)})` : ""}</dd>
            </dl>
            {report.warnings?.length ? (
              <Notice tone="warn">
                <strong>{report.warnings.length} warning{report.warnings.length === 1 ? "" : "s"} from the run:</strong>
                <ul className="problem-list">{report.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              </Notice>
            ) : null}
          </section>

          <section className="panel">
            <h2>Allocations</h2>
            <table className="data-table">
              <thead><tr><th>Allocation</th><th>Expected return</th><th>Volatility</th><th>Sharpe</th><th>Concentration</th><th>Weights</th></tr></thead>
              <tbody>
                {allocations.map(([name, allocation]) => (
                  <tr key={name}>
                    <td>{name === "selected" ? <strong>selected</strong> : name}</td>
                    <td>{percent(allocation.expectedReturnAnnualized, 2)}</td>
                    <td>{percent(allocation.volatilityAnnualized, 2)}</td>
                    <td>{allocation.sharpeRatio === null || allocation.sharpeRatio === undefined ? "—" : decimal(allocation.sharpeRatio, 3)}</td>
                    <td>{decimal(allocation.concentrationIndex, 3)}</td>
                    <td>
                      {Object.entries(allocation.weights || {}).map(([symbol, weight]) => (
                        <span className="weight-chip" key={symbol}>{symbol} {percent(weight, 1)}</span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <h2>Assets and provenance</h2>
            <table className="data-table">
              <thead><tr><th>Symbol</th><th>Class</th><th>Exp. return</th><th>Volatility</th><th>Selected</th><th>Source</th><th>Freshness</th></tr></thead>
              <tbody>
                {(report.assets || []).map((asset) => (
                  <tr key={`${asset.symbol}-${asset.marketClass}`}>
                    <td><code>{asset.symbol}</code></td>
                    <td>{asset.marketClass}</td>
                    <td>{percent(asset.expectedReturnAnnualized, 2)}</td>
                    <td>{percent(asset.volatilityAnnualized, 2)}</td>
                    <td>{percent(asset.selectedWeight, 2)}</td>
                    <td>
                      {asset.provenance?.source || "unknown"}
                      {asset.provenance?.synthetic ? <> <span className="badge badge-warn">SIMULATION</span></> : null}
                    </td>
                    <td>
                      {utcDisplay(asset.provenance?.dataTimestamp) || "—"}
                      {asset.provenance?.stale ? <> <span className="badge badge-warn">stale</span></> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="field-hint">
              A source of <code>synthetic</code> with the SIMULATION badge means these prices were generated for a demo
              host, not observed in a market. Nothing on this screen renames that.
            </p>
          </section>

          <section className="panel">
            <h2>Correlation matrix (unshrunk sample)</h2>
            <table className="data-table">
              <thead><tr><th />{(report.assets || []).map((asset) => <th key={asset.symbol}>{asset.symbol}</th>)}</tr></thead>
              <tbody>
                {(report.assets || []).map((asset) => (
                  <tr key={asset.symbol}>
                    <td><code>{asset.symbol}</code></td>
                    {report.assets.map((column) => {
                      const value = report.correlations?.[asset.symbol]?.[column.symbol];
                      return <td key={column.symbol}>{value === null || value === undefined ? "—" : decimal(value, 3)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="field-hint">Shrinkage regularizes the solver; the correlations reported here are the sample values the solver started from.</p>
            {report.disclaimer ? <p className="empty">{report.disclaimer}</p> : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
