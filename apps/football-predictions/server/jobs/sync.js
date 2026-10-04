import {
  ApiFootball,
  normalizeFixture,
  normalizeOdds,
  normalizeForm,
  saveFixture,
  saveOdds,
} from "../providers/apiFootball.js";
import { utc, hash } from "../db.js";
const dateUTC = () => new Date().toISOString().slice(0, 10);
const rows = async (db, sql, params = []) => (await db.execute(sql, params))[0];
export async function runJob(
  pool,
  job,
  { provider = new ApiFootball(pool), date = dateUTC() } = {},
) {
  if (
    ![
      "fixtures",
      "odds",
      "statistics",
      "results",
      "freshness",
      "health",
    ].includes(job)
  )
    throw new Error("UNKNOWN_JOB");
  const lock = await pool.getConnection();
  let acquired = false,
    logId;
  try {
    const [[value]] = await lock.query("SELECT GET_LOCK(?,0) AS acquired", [
      `fp_job_${job}`,
    ]);
    if (!value.acquired) return { status: "LOCKED" };
    acquired = true;
    const [log] = await pool.execute(
      "INSERT INTO fp_sync_logs(job,status,started_at) VALUES(?,'RUNNING',?)",
      [job, utc()],
    );
    logId = log.insertId;
    let count = 0;
    if (job === "health") {
      await provider.status();
      count = 1;
    }
    if (job === "freshness") {
      const [old] = await pool.execute(
        "SELECT COUNT(*) AS n FROM fp_odds WHERE observed_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 15 MINUTE)",
      );
      count = old[0].n;
      await pool.execute(
        "DELETE FROM fp_sessions WHERE expires_at<UTC_TIMESTAMP()",
      );
      await pool.execute(
        "DELETE FROM fp_provider_cache WHERE expires_at<UTC_TIMESTAMP()",
      );
    }
    if (job === "fixtures") {
      for (const raw of (await provider.fixtures(date)).response) {
        const f = normalizeFixture(raw);
        if (!f) continue;
        await saveFixture(pool, f);
        count++;
      }
    }
    if (job === "odds" || job === "statistics") {
      const fixtures = await rows(
        pool,
        "SELECT id,home_team_id,away_team_id FROM fp_fixtures WHERE kickoff>=UTC_TIMESTAMP() AND kickoff<DATE_ADD(UTC_TIMESTAMP(),INTERVAL 2 DAY) AND status='NS' ORDER BY kickoff LIMIT 30",
      );
      if (job === "odds")
        for (const f of fixtures)
          for (const payload of (await provider.odds(f.id)).response)
            for (const o of normalizeOdds(payload, f.id)) {
              await saveOdds(pool, o);
              count++;
            }
      else {
        const teamIds = [
          ...new Set(fixtures.flatMap((f) => [f.home_team_id, f.away_team_id])),
        ];
        for (const teamId of teamIds) {
          const recent = normalizeForm(
            (await provider.recent(teamId)).response,
            teamId,
          );
          await pool.execute(
            "INSERT INTO fp_team_form(team_id,observed_at,history) VALUES(?,?,?) ON DUPLICATE KEY UPDATE observed_at=VALUES(observed_at),history=VALUES(history)",
            [teamId, utc(), JSON.stringify(recent)],
          );
          count++;
        }
      }
    }
    if (job === "results") {
      const pending = await rows(
        pool,
        "SELECT DISTINCT f.id FROM fp_fixtures f JOIN fp_selections s ON s.fixture_id=f.id WHERE s.result IN ('PENDING','POSTPONED') AND f.kickoff<UTC_TIMESTAMP() LIMIT 40",
      );
      for (const f of pending) {
        const payload = (await provider.get("fixtures", { id: f.id }, 120))
          .response;
        if (!Array.isArray(payload) || payload.length !== 1) continue;
        const result = normalizeFixture(payload[0]);
        if (!result || result.id !== f.id) continue;
        await saveFixture(pool, result);
        // Over/Under settles on regulation time only; never use extra-time or shootout totals.
        if (["AET", "PEN"].includes(result.status)) {
          result.homeGoals = payload[0]?.score?.fulltime?.home;
          result.awayGoals = payload[0]?.score?.fulltime?.away;
        }
        if (!["FT", "AET", "PEN", "PST", "CANC"].includes(result.status))
          continue;
        if (
          ["FT", "AET", "PEN"].includes(result.status) &&
          (!Number.isInteger(result.homeGoals) ||
            !Number.isInteger(result.awayGoals))
        )
          continue;
        await pool.execute(
          "INSERT INTO fp_results(fixture_id,status,home_goals,away_goals,observed_at,payload_hash) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE status=VALUES(status),home_goals=VALUES(home_goals),away_goals=VALUES(away_goals),observed_at=VALUES(observed_at),payload_hash=VALUES(payload_hash)",
          [
            f.id,
            result.status,
            result.homeGoals,
            result.awayGoals,
            utc(),
            hash(JSON.stringify(payload[0])),
          ],
        );
        count++;
      }
      await settle(pool);
    }
    await pool.execute(
      "UPDATE fp_sync_logs SET status='OK',finished_at=?,count=? WHERE id=?",
      [utc(), count, logId],
    );
    return { status: "OK", count };
  } catch (e) {
    if (logId)
      await pool.execute(
        "UPDATE fp_sync_logs SET status='FAILED',finished_at=?,error=? WHERE id=?",
        [utc(), String(e.code || e.message).slice(0, 255), logId],
      );
    throw e;
  } finally {
    if (acquired) await lock.query("SELECT RELEASE_LOCK(?)", [`fp_job_${job}`]);
    lock.release();
  }
}
export async function settle(pool) {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const tickets = await rows(
      db,
      "SELECT id,original_odds FROM fp_tickets WHERE result='PENDING' FOR UPDATE",
    );
    for (const t of tickets) {
      const selections = await rows(
        db,
        "SELECT s.id,s.price_text AS price,s.result,r.status AS fixture_status,r.home_goals,r.away_goals FROM fp_selections s LEFT JOIN fp_results r ON r.fixture_id=s.fixture_id WHERE s.ticket_id=? FOR UPDATE",
        [t.id],
      );
      for (const s of selections) {
        if (s.result === "WON" || s.result === "LOST" || s.result === "VOID")
          continue;
        let result = null;
        if (
          ["FT", "AET", "PEN"].includes(s.fixture_status) &&
          Number.isInteger(s.home_goals) &&
          Number.isInteger(s.away_goals)
        )
          result = s.home_goals + s.away_goals >= 2 ? "WON" : "LOST";
        else if (s.fixture_status === "PST") result = "POSTPONED";
        else if (s.fixture_status === "CANC") result = "VOID";
        if (result && result !== s.result)
          await db.execute(
            "UPDATE fp_selections SET result=?,settled_at=? WHERE id=?",
            [result, utc(), s.id],
          );
        if (result) s.result = result;
      }
      const states = selections.map((s) => s.result);
      if (states.some((s) => s === "PENDING" || s === "POSTPONED")) continue;
      const result = states.includes("LOST")
        ? "LOST"
        : states.every((s) => s === "VOID")
          ? "VOID"
          : "WON";
      // Refunded void legs contribute 1; immutable original_odds and selection prices are never overwritten.
      const { multiply } = await import("../prediction/odds.js");
      const effective = multiply(
        selections
          .filter((s) => s.result !== "VOID")
          .map((s) => String(s.price)),
      );
      await db.execute(
        "UPDATE fp_tickets SET result=?,settlement_odds=? WHERE id=?",
        [result, effective, t.id],
      );
    }
    await db.commit();
  } catch (e) {
    await db.rollback();
    throw e;
  } finally {
    db.release();
  }
}
