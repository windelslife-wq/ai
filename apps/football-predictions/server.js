import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  makePool,
  hash,
  verifyPassword,
  utc,
  audit,
  iso,
} from "./server/db.js";
import { generate } from "./server/generation.js";
const root = path.dirname(fileURLToPath(import.meta.url));
export function createApp(pool) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests:
            process.env.NODE_ENV === "production" ? [] : null,
        },
      },
    }),
  );
  app.use(express.json({ limit: "16kb" }));
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  app.use((req, res, next) => {
    if (process.env.NODE_ENV === "production" && !req.secure)
      return res.status(403).json({ error: { code: "HTTPS_REQUIRED" } });
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      if (origin && origin !== `${req.protocol}://${req.get("host")}`)
        return res.status(403).json({ error: { code: "ORIGIN_DENIED" } });
      if (req.get("sec-fetch-site") === "cross-site")
        return res.status(403).json({ error: { code: "ORIGIN_DENIED" } });
    }
    next();
  });
  const sessionHash = (token) =>
    createHmac("sha256", process.env.SESSION_SECRET)
      .update(token)
      .digest("hex");
  const query = async (sql, params = []) =>
    (await pool.execute(sql, params))[0];
  const paginate = (req) => {
    const page = Number(req.query.page || 1),
      limit = Number(req.query.limit || 20);
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 10000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw Object.assign(new Error("INVALID_PAGINATION"), { status: 400 });
    return { limit, offset: (page - 1) * limit, page };
  };
  function same(a, b) {
    const x = Buffer.from(a || ""),
      y = Buffer.from(b || "");
    return x.length === y.length && timingSafeEqual(x, y);
  }
  function cookie(req) {
    return (
      (req.get("cookie") || "")
        .split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("fp_session="))
        ?.slice(11) || ""
    );
  }
  app.use(async (req, res, next) => {
    try {
      const token = cookie(req);
      if (!/^[0-9a-f]{64}$/.test(token)) return next();
      const [session] = await query(
        "SELECT s.*,u.email,u.role,u.active FROM fp_sessions s JOIN fp_users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>UTC_TIMESTAMP(3)",
        [sessionHash(token)],
      );
      if (session?.active) req.session = session;
      next();
    } catch (e) {
      next(e);
    }
  });
  function auth(req, res, next) {
    if (!req.session || req.session.role !== "ADMIN")
      return res.status(403).json({ error: { code: "ADMIN_REQUIRED" } });
    next();
  }
  function csrf(req, res, next) {
    if (
      !same(hash(String(req.get("x-csrf-token") || "")), req.session.csrf_hash)
    )
      return res.status(403).json({ error: { code: "CSRF_INVALID" } });
    next();
  }
  function idParam(req) {
    const n = Number(req.params.id);
    if (!Number.isSafeInteger(n) || n < 1)
      throw Object.assign(new Error("INVALID_ID"), { status: 400 });
    return n;
  }
  function cleanTicket(t) {
    return t
      ? {
          id: t.id,
          day: t.day,
          original_odds: t.original_odds,
          settlement_odds: t.settlement_odds,
          status: t.status,
          result: t.result,
          created_at: iso(t.created_at),
          published_at: iso(t.published_at),
        }
      : null;
  }
  async function selections(ticketId) {
    const s = await query(
      "SELECT s.id,s.fixture_id,s.market,s.bookmaker_snapshot AS bookmaker,s.price_text AS price,s.observed_at,s.source,s.fixture_snapshot AS fixture,s.confidence,s.risk,s.probability,s.result FROM fp_selections s WHERE s.ticket_id=? ORDER BY s.id",
      [ticketId],
    );
    return s.map((x) => ({
      ...x,
      observed_at: iso(x.observed_at),
      fixture:
        typeof x.fixture === "string" ? JSON.parse(x.fixture) : x.fixture,
    }));
  }
  async function current(day, admin = false) {
    const [t] = await query(
      `SELECT * FROM fp_tickets WHERE day=? ${admin ? "" : "AND status='PUBLISHED'"} LIMIT 1`,
      [day],
    );
    return t
      ? { ticket: cleanTicket(t), selections: await selections(t.id) }
      : null;
  }
  app.post(
    "/api/auth/login",
    rateLimit({
      windowMs: 15 * 60_000,
      limit: 8,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
    async (req, res) => {
      const { email, password } = req.body || {};
      if (
        typeof email !== "string" ||
        typeof password !== "string" ||
        email.length > 254 ||
        password.length > 1024
      )
        return res.status(400).json({ error: { code: "INVALID_INPUT" } });
      const [u] = await query(
        "SELECT * FROM fp_users WHERE email=? AND active=1",
        [email.toLowerCase().trim()],
      );
      if (!u || !verifyPassword(password, u.password_hash))
        return res.status(401).json({ error: { code: "INVALID_CREDENTIALS" } });
      const token = randomBytes(32).toString("hex"),
        csrfToken = randomBytes(32).toString("hex");
      await pool.execute(
        "INSERT INTO fp_sessions(id_hash,user_id,csrf_hash,expires_at) VALUES(?,?,?,?)",
        [
          sessionHash(token),
          u.id,
          hash(csrfToken),
          new Date(Date.now() + 8 * 3600_000)
            .toISOString()
            .replace("T", " ")
            .replace("Z", ""),
        ],
      );
      res.cookie("fp_session", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        maxAge: 8 * 3600_000,
      });
      await audit(pool, u.id, "LOGIN", "session", sessionHash(token));
      res.json({ user: { id: u.id, email: u.email, role: u.role }, csrfToken });
    },
  );
  app.get("/api/auth/me", (req, res) => {
    if (!req.session)
      return res.status(401).json({ error: { code: "NOT_AUTHENTICATED" } });
    res.json({
      user: {
        id: req.session.user_id,
        email: req.session.email,
        role: req.session.role,
      },
    });
  });
  // CSRF bootstrap on refresh: replace stored token only for the current session.
  app.post("/api/auth/csrf", auth, async (req, res) => {
    const token = randomBytes(32).toString("hex");
    await pool.execute("UPDATE fp_sessions SET csrf_hash=? WHERE id_hash=?", [
      hash(token),
      req.session.id_hash,
    ]);
    res.json({ csrfToken: token });
  });
  app.post("/api/auth/logout", auth, csrf, async (req, res) => {
    await pool.execute("DELETE FROM fp_sessions WHERE id_hash=?", [
      req.session.id_hash,
    ]);
    res.clearCookie("fp_session", { path: "/" });
    res.json({ ok: true });
  });
  app.get("/api/fixtures", async (req, res) => {
    const { limit, offset, page } = paginate(req);
    const data = await query(
      "SELECT f.id,f.kickoff,f.status,h.name AS homeTeam,a.name AS awayTeam,c.name AS competition FROM fp_fixtures f JOIN fp_teams h ON h.id=f.home_team_id JOIN fp_teams a ON a.id=f.away_team_id JOIN fp_competitions c ON c.id=f.competition_id WHERE f.kickoff>=UTC_TIMESTAMP() ORDER BY f.kickoff LIMIT ? OFFSET ?",
      [limit, offset],
    );
    res.json({
      data: data.map((f) => ({ ...f, kickoff: iso(f.kickoff) })),
      page,
    });
  });
  app.get("/api/odds", async (req, res) => {
    const { limit, offset, page } = paginate(req);
    const data = await query(
      "SELECT o.fixture_id,o.price_text AS price,o.observed_at,b.name AS bookmaker,o.source FROM fp_odds o JOIN fp_bookmakers b ON b.id=o.bookmaker_id JOIN fp_fixtures f ON f.id=o.fixture_id WHERE f.kickoff>UTC_TIMESTAMP() AND f.status='NS' AND o.market='OVER_1_5' AND o.observed_at>DATE_SUB(UTC_TIMESTAMP(),INTERVAL 15 MINUTE) ORDER BY o.observed_at DESC LIMIT ? OFFSET ?",
      [limit, offset],
    );
    res.json({
      data: data.map((x) => ({
        ...x,
        market: "OVER_1_5",
        observed_at: iso(x.observed_at),
      })),
      page,
    });
  });
  app.get("/api/predictions", async (req, res) => {
    const { limit, offset, page } = paginate(req);
    const data = await query(
      "SELECT p.fixture_id,p.probability,p.implied_probability,p.confidence,p.risk,p.quality,p.reason FROM fp_predictions p JOIN fp_selections s ON s.prediction_id=p.id JOIN fp_tickets t ON t.id=s.ticket_id WHERE t.status='PUBLISHED' ORDER BY p.id DESC LIMIT ? OFFSET ?",
      [limit, offset],
    );
    res.json({ data, page, calibration: "NOT_EMPIRICALLY_CALIBRATED" });
  });
  app.get("/api/ticket/today", async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const t = await current(today);
    const [g] = await query(
      "SELECT status,report FROM fp_generation WHERE day=?",
      [today],
    );
    const state = g?.status || "NOT_GENERATED";
    const publicStatus =
      state === "NO_QUALIFYING_TICKET"
        ? "NO QUALIFYING TICKET"
        : state === "QUALIFIED"
          ? "AWAITING_PUBLICATION"
          : state;
    res.json(
      t || {
        status: publicStatus,
        message:
          publicStatus === "NO QUALIFYING TICKET"
            ? "No valid Over 1.5 combination was found within the 2.00–4.00 target range."
            : publicStatus === "AWAITING_PUBLICATION"
              ? "A ticket is awaiting administrator publication."
              : publicStatus === "NOT_GENERATED"
                ? "No administrator has generated a ticket today."
                : "No public ticket is available.",
        generation:
          state === "NO_QUALIFYING_TICKET"
            ? { status: state, report: g.report }
            : null,
      },
    );
  });
  app.get("/api/tickets/history", async (req, res) => {
    const { limit, offset, page } = paginate(req);
    const data = await query(
      "SELECT id,day,original_odds,result,published_at FROM fp_tickets WHERE status='PUBLISHED' ORDER BY day DESC LIMIT ? OFFSET ?",
      [limit, offset],
    );
    res.json({ data: data.map(cleanTicket), page });
  });
  app.get("/api/tickets/:id", async (req, res) => {
    const [t] = await query(
      "SELECT * FROM fp_tickets WHERE id=? AND status='PUBLISHED'",
      [idParam(req)],
    );
    if (!t) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    res.json({ ticket: cleanTicket(t), selections: await selections(t.id) });
  });
  app.use("/api/admin", auth);
  app.get("/api/admin/dashboard", async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const [g] = await query(
      "SELECT id,status,stage,report FROM fp_generation WHERE day=?",
      [today],
    );
    res.json({ generation: g || null, today: await current(today, true) });
  });
  app.post("/api/admin/generate-ticket", csrf, async (req, res) => {
    const result = await generate(pool, req.session.user_id);
    res.json(result);
  });
  app.get("/api/admin/generation-report", async (req, res) => {
    const [g] = await query(
      "SELECT id,day,admin_id,status,stage,report,started_at,finished_at FROM fp_generation ORDER BY id DESC LIMIT 1",
    );
    res.json({ generation: g || null });
  });
  async function publication(req, res, status) {
    const id = idParam(req);
    const [ticket] = await query(
      "SELECT id,status FROM fp_tickets WHERE id=?",
      [id],
    );
    if (!ticket) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    if (ticket.status === status) return res.json({ status, unchanged: true });
    const db = await pool.getConnection();
    try {
      await db.beginTransaction();
      if (status === "PUBLISHED") {
        const [settings] = (
          await db.execute(
            "SELECT max_odds_age_seconds FROM fp_settings WHERE id=1",
          )
        )[0];
        const [legs] = await db.execute(
          "SELECT f.status,f.kickoff,s.observed_at FROM fp_selections s JOIN fp_fixtures f ON f.id=s.fixture_id WHERE s.ticket_id=? FOR UPDATE",
          [id],
        );
        const now = Date.now();
        if (
          !legs.length ||
          legs.some(
            (leg) =>
              leg.status !== "NS" ||
              Date.parse(iso(leg.kickoff)) <= now ||
              Date.parse(iso(leg.observed_at)) > now ||
              now - Date.parse(iso(leg.observed_at)) >
                settings.max_odds_age_seconds * 1000,
          )
        ) {
          await db.rollback();
          return res
            .status(409)
            .json({ error: { code: "TICKET_EXPIRED_OR_INELIGIBLE" } });
        }
      }
      await db.execute(
        "UPDATE fp_tickets SET status=?,published_by=?,published_at=? WHERE id=?",
        [
          status,
          req.session.user_id,
          status === "PUBLISHED" ? utc() : null,
          id,
        ],
      );
      await audit(db, req.session.user_id, status, "ticket", id);
      await db.commit();
      res.json({ status });
    } catch (e) {
      await db.rollback();
      throw e;
    } finally {
      db.release();
    }
  }
  app.post("/api/admin/tickets/:id/publish", csrf, (req, res) =>
    publication(req, res, "PUBLISHED"),
  );
  app.post("/api/admin/tickets/:id/unpublish", csrf, (req, res) =>
    publication(req, res, "UNPUBLISHED"),
  );
  app.get("/api/admin/settings", async (req, res) =>
    res.json({
      settings: (await query("SELECT * FROM fp_settings WHERE id=1"))[0],
      market: "OVER_1_5",
      minCombinedOdds: "2.00",
      maxCombinedOdds: "4.00",
      automaticGeneration: false,
    }),
  );
  app.put("/api/admin/settings", csrf, async (req, res) => {
    const allowed = [
      "min_confidence",
      "max_risk",
      "min_quality",
      "max_odds_age_seconds",
      "max_selections",
      "restrict_teams",
      "max_per_competition",
    ];
    const input = req.body || {};
    if (Object.keys(input).some((k) => !allowed.includes(k)))
      return res
        .status(400)
        .json({ error: { code: "IMMUTABLE_OR_UNKNOWN_SETTING" } });
    const bounds = {
      min_confidence: [50, 95],
      max_risk: [5, 70],
      min_quality: [60, 100],
      max_odds_age_seconds: [60, 3600],
      max_selections: [2, 12],
      restrict_teams: [0, 1],
      max_per_competition: [1, 5],
    };
    for (const [key, value] of Object.entries(input))
      if (
        !Number.isInteger(value) ||
        value < bounds[key][0] ||
        value > bounds[key][1]
      )
        return res
          .status(400)
          .json({ error: { code: "INVALID_SETTING", field: key } });
    if (!Object.keys(input).length)
      return res.status(400).json({ error: { code: "EMPTY_SETTINGS" } });
    const db = await pool.getConnection();
    try {
      await db.beginTransaction();
      const [old] = await (async () =>
        (
          await db.execute("SELECT * FROM fp_settings WHERE id=1 FOR UPDATE")
        )[0])();
      const fields = Object.keys(input);
      await db.execute(
        `UPDATE fp_settings SET ${fields.map((k) => `${k}=?`).join(",")},updated_by=?,updated_at=? WHERE id=1`,
        [...fields.map((k) => input[k]), req.session.user_id, utc()],
      );
      await audit(db, req.session.user_id, "SETTINGS_CHANGED", "settings", 1, {
        previous: Object.fromEntries(fields.map((k) => [k, old[k]])),
        new: input,
      });
      await db.commit();
      res.json({ ok: true });
    } catch (e) {
      await db.rollback();
      throw e;
    } finally {
      db.release();
    }
  });
  app.get("/api/admin/system-logs", async (req, res) => {
    const { limit, offset, page } = paginate(req);
    res.json({
      data: await query(
        "SELECT severity,message,created_at FROM fp_system_logs ORDER BY id DESC LIMIT ? OFFSET ?",
        [limit, offset],
      ),
      page,
    });
  });
  app.get("/api/admin/api-status", async (req, res) => {
    const [last] = await query(
      "SELECT job,status,started_at,finished_at,count,error FROM fp_sync_logs ORDER BY id DESC LIMIT 1",
    );
    res.json({
      configured: !!process.env.API_FOOTBALL_KEY,
      last: last || null,
    });
  });
  app.get("/api/admin/analytics", async (req, res) => {
    const [t] = await query(
      "SELECT COUNT(*) total,SUM(result='WON') won,SUM(result='LOST') lost,SUM(result='VOID') voided,AVG(CAST(original_odds AS DECIMAL(20,6))) avgOdds,MIN(CAST(original_odds AS DECIMAL(20,6))) minOdds,MAX(CAST(original_odds AS DECIMAL(20,6))) maxOdds FROM fp_tickets WHERE status='PUBLISHED'",
    );
    const [s] = await query(
      "SELECT COUNT(*) total,SUM(s.result='WON') won,SUM(s.result='LOST') lost FROM fp_selections s JOIN fp_tickets t ON t.id=s.ticket_id WHERE t.status='PUBLISHED'",
    );
    const months = await query(
      "SELECT DATE_FORMAT(day,'%Y-%m') AS month,COUNT(*) total,SUM(result='WON') won,SUM(result='LOST') lost FROM fp_tickets WHERE status='PUBLISHED' GROUP BY month ORDER BY month DESC LIMIT 24",
    );
    const competition = await query(
      "SELECT JSON_UNQUOTE(JSON_EXTRACT(s.fixture_snapshot,'$.competition')) AS competition,COUNT(*) total,SUM(s.result='WON') won,SUM(s.result='LOST') lost FROM fp_selections s JOIN fp_tickets t ON t.id=s.ticket_id WHERE t.status='PUBLISHED' GROUP BY competition ORDER BY total DESC LIMIT 50",
    );
    const models = await query(
      "SELECT s.model_version,COUNT(*) total,SUM(s.result='WON') won,SUM(s.result='LOST') lost FROM fp_selections s JOIN fp_tickets t ON t.id=s.ticket_id WHERE t.status='PUBLISHED' GROUP BY s.model_version",
    );
    const bins = await query(
      "SELECT FLOOR(s.probability*10)/10 AS probabilityBin,COUNT(*) AS sample,SUM(s.result='WON') AS won FROM fp_selections s JOIN fp_tickets t ON t.id=s.ticket_id WHERE t.status='PUBLISHED' AND s.result IN ('WON','LOST') GROUP BY probabilityBin ORDER BY probabilityBin",
    );
    const settled = await query(
      "SELECT result FROM fp_tickets WHERE status='PUBLISHED' AND result IN ('WON','LOST') ORDER BY day DESC",
    );
    let winStreak = 0,
      lossStreak = 0;
    for (const row of settled) {
      if (row.result === "WON" && lossStreak === 0) winStreak++;
      else if (row.result === "LOST" && winStreak === 0) lossStreak++;
      else break;
    }
    res.json({
      tickets: t,
      selections: s,
      winRate:
        Number(t.won || 0) + Number(t.lost || 0)
          ? Number(t.won) / (Number(t.won) + Number(t.lost))
          : null,
      selectionWinRate:
        Number(s.won || 0) + Number(s.lost || 0)
          ? Number(s.won) / (Number(s.won) + Number(s.lost))
          : null,
      monthly: months,
      competition,
      models,
      probabilityBins: bins,
      currentWinStreak: winStreak,
      currentLossStreak: lossStreak,
      scope:
        "Published only; unresolved and void excluded from win rate denominators. Probability bins are descriptive, not a validated calibration claim.",
    });
  });
  app.get("/api/admin/predictions", async (req, res) => {
    const { limit, offset, page } = paginate(req);
    const data = await query(
      "SELECT p.fixture_id,p.probability,p.implied_probability,p.confidence,p.risk,p.quality,p.reason,p.explanation,g.day FROM fp_predictions p JOIN fp_generation g ON g.id=p.generation_id ORDER BY p.id DESC LIMIT ? OFFSET ?",
      [limit, offset],
    );
    res.json({ data, page, calibration: "NOT_EMPIRICALLY_CALIBRATED" });
  });
  app.get("/api/admin/tickets", async (req, res) => {
    const { limit, offset, page } = paginate(req);
    res.json({
      data: await query(
        "SELECT id,day,status,result,original_odds FROM fp_tickets ORDER BY day DESC LIMIT ? OFFSET ?",
        [limit, offset],
      ),
      page,
    });
  });
  app.get("/api/admin/tickets/:id", async (req, res) => {
    const [t] = await query("SELECT * FROM fp_tickets WHERE id=?", [
      idParam(req),
    ]);
    if (!t) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    res.json({ ticket: cleanTicket(t), selections: await selections(t.id) });
  });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: { code: "NOT_FOUND" } }),
  );
  app.use(
    express.static(path.join(root, "public"), {
      extensions: ["html"],
      index: "index.html",
    }),
  );
  app.use((err, req, res, next) => {
    console.error("Request failed:", err.code || err.message);
    pool
      .execute(
        "INSERT INTO fp_system_logs(severity,message,created_at) VALUES(?,?,?)",
        ["ERROR", String(err.code || err.message).slice(0, 255), utc()],
      )
      .catch(() => {});
    if (res.headersSent) return next(err);
    res
      .status(err.status || 500)
      .json({ error: { code: err.status ? err.message : "INTERNAL_ERROR" } });
  });
  return app;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)
    throw new Error("SESSION_SECRET must have at least 32 characters");
  const pool = makePool();
  await pool.query("SELECT id FROM fp_settings WHERE id=1"); // fail fast if database is inaccessible or migration was skipped
  const app = createApp(pool);
  const port = Number(process.env.PORT || 3000);
  app.listen(port, "0.0.0.0", () =>
    console.log(`Football predictions listening on ${port}`),
  );
}
