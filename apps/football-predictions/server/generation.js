import { utc, iso, sqlDate, audit } from "./db.js";
import {
  ApiFootball,
  normalizeOdds,
  saveOdds,
} from "./providers/apiFootball.js";
import { analyze } from "./prediction/model.js";
import { validateOdds, compare } from "./prediction/odds.js";
import { optimize } from "./prediction/optimizer.js";
const read = async (db, sql, params = []) => (await db.execute(sql, params))[0];
const empty = () => ({
  fixturesScanned: 0,
  over15Candidates: 0,
  verifiedOdds: 0,
  confidenceQualified: 0,
  riskQualified: 0,
  finalCandidates: 0,
  combinationsTested: 0,
  qualifiedCombinations: 0,
  correlationRejections: 0,
  selectedPicks: 0,
  totalOdds: null,
  rejections: {},
  providerStatus: "UNKNOWN",
});
export async function generate(
  pool,
  adminId,
  { provider = new ApiFootball(pool), now = new Date() } = {},
) {
  const day = now.toISOString().slice(0, 10),
    startedAt = Date.now();
  const [insert] = await pool.execute(
    "INSERT IGNORE INTO fp_generation(day,admin_id,status,stage,report,started_at) VALUES(?,?,'RUNNING','Loading fixtures',?,?)",
    [day, adminId, JSON.stringify(empty()), utc()],
  );
  if (!insert.affectedRows) {
    const [existing] = await read(
      pool,
      "SELECT id,status,stage,report FROM fp_generation WHERE day=?",
      [day],
    );
    return { duplicate: true, generation: existing };
  }
  const id = insert.insertId,
    report = empty(),
    rejected = (reason) =>
      (report.rejections[reason] = (report.rejections[reason] || 0) + 1);
  const stage = async (name) => {
    await pool.execute("UPDATE fp_generation SET stage=?,report=? WHERE id=?", [
      name,
      JSON.stringify(report),
      id,
    ]);
  };
  try {
    await provider.status(true);
    report.providerStatus = "OK";
    const settings = (
      await read(pool, "SELECT * FROM fp_settings WHERE id=1")
    )[0];
    const fixtures = await read(
      pool,
      "SELECT f.id,f.kickoff,f.status,f.home_team_id AS homeTeamId,f.away_team_id AS awayTeamId,f.competition_id AS competitionId,h.name AS homeTeam,a.name AS awayTeam,c.name AS competition, hf.history AS homeForm,af.history AS awayForm,hf.observed_at AS homeObserved,af.observed_at AS awayObserved FROM fp_fixtures f JOIN fp_teams h ON h.id=f.home_team_id JOIN fp_teams a ON a.id=f.away_team_id JOIN fp_competitions c ON c.id=f.competition_id LEFT JOIN fp_team_form hf ON hf.team_id=f.home_team_id LEFT JOIN fp_team_form af ON af.team_id=f.away_team_id WHERE f.kickoff>=? AND f.kickoff<DATE_ADD(?,INTERVAL 1 DAY) ORDER BY f.kickoff LIMIT 100",
      [`${day} 00:00:00`, `${day} 00:00:00`],
    );
    report.fixturesScanned = fixtures.length;
    await stage("Loading verified odds");
    const candidates = [];
    for (const f of fixtures) {
      let reason = null,
        chosen = null,
        prediction = null;
      if (f.status !== "NS" || Date.parse(iso(f.kickoff)) <= now.getTime())
        reason = "INELIGIBLE_FIXTURE";
      else {
        // Refresh live prices for each fixture; fail closed on provider failure, never rely on client prices.
        const payload = (await provider.odds(f.id, true)).response;
        const prices = payload.flatMap((x) => normalizeOdds(x, f.id));
        await stage("Filtering Over 1.5 markets");
        if (prices.length) report.over15Candidates++;
        const liveQuotes = new Map(prices.map((x) => [x.payloadHash, x]));
        for (const price of prices) await saveOdds(pool, price);
        const quotes = await read(
          pool,
          "SELECT o.*,b.name AS bookmaker FROM fp_odds o JOIN fp_bookmakers b ON b.id=o.bookmaker_id WHERE o.fixture_id=? AND o.market='OVER_1_5' ORDER BY o.observed_at DESC,o.id DESC LIMIT 20",
          [f.id],
        );
        for (const q of quotes) {
          const live = liveQuotes.get(q.payload_hash);
          if (!live) continue;
          if (
            live.price !== q.price_text ||
            live.bookmakerId !== q.bookmaker_id ||
            sqlDate(live.timestamp) !== q.observed_at ||
            compare(String(q.price), live.price) !== 0
          ) {
            reason = "ODDS_PAYLOAD_MISMATCH";
            continue;
          }
          const candidate = {
            fixtureId: f.id,
            market: q.market,
            bookmakerId: q.bookmaker_id,
            bookmaker: q.bookmaker,
            price: q.price_text,
            source: q.source,
            verified: true,
            manuallyAltered: false,
            timestamp: iso(q.observed_at),
          };
          const fail = validateOdds(
            { id: f.id, status: f.status, kickoff: iso(f.kickoff) },
            candidate,
            {
              now: now.getTime(),
              maxAgeSeconds: settings.max_odds_age_seconds,
            },
          );
          if (!fail) {
            report.verifiedOdds++;
            chosen = {
              ...candidate,
              oddsId: q.id,
              payloadHash: q.payload_hash,
            };
            break;
          }
          reason = fail;
        }
        if (!chosen) reason = reason || "OVER_1_5_ODDS_UNAVAILABLE";
        else {
          await stage("Checking data quality");
          if (
            !f.homeForm ||
            !f.awayForm ||
            now.getTime() - Date.parse(iso(f.homeObserved)) > 86400000 ||
            now.getTime() - Date.parse(iso(f.awayObserved)) > 86400000
          )
            reason = "DATA_UNAVAILABLE";
          else {
            await stage("Analyzing matches");
            prediction = analyze(f, f.homeForm, f.awayForm, {
              now: now.getTime(),
            });
            await stage("Calculating confidence");
            if (prediction.reason) reason = prediction.reason;
            else if (prediction.quality < settings.min_quality)
              reason = "LOW_DATA_QUALITY";
            else if (prediction.confidence < settings.min_confidence)
              reason = "LOW_CONFIDENCE";
            else {
              report.confidenceQualified++;
              await stage("Filtering risk");
              if (prediction.risk > settings.max_risk) reason = "HIGH_RISK";
              else report.riskQualified++;
            }
          }
        }
      }
      if (reason) rejected(reason);
      const [saved] = await pool.execute(
        "INSERT INTO fp_predictions(generation_id,fixture_id,odds_id,probability,confidence,quality,risk,reason,explanation,model_version) VALUES(?,?,?,?,?,?,?,?,?,1)",
        [
          id,
          f.id,
          chosen?.oddsId || null,
          prediction?.probability ?? null,
          prediction?.confidence ?? null,
          prediction?.quality ?? null,
          prediction?.risk ?? null,
          reason,
          JSON.stringify(prediction?.explanation || {}),
        ],
      );
      if (!reason)
        candidates.push({
          ...chosen,
          fixtureId: f.id,
          homeTeamId: f.homeTeamId,
          awayTeamId: f.awayTeamId,
          competitionId: f.competitionId,
          homeTeam: f.homeTeam,
          awayTeam: f.awayTeam,
          competition: f.competition,
          kickoff: iso(f.kickoff),
          probability: prediction.probability,
          confidence: prediction.confidence,
          quality: prediction.quality,
          risk: prediction.risk,
          predictionId: saved.insertId,
        });
    }
    report.finalCandidates = candidates.length;
    await stage("Building combinations");
    const outcome = optimize(candidates, {
      maxSelections: settings.max_selections,
      restrictTeams: !!settings.restrict_teams,
      maxPerCompetition: settings.max_per_competition,
    });
    Object.assign(report, {
      combinationsTested: outcome.tested,
      qualifiedCombinations: outcome.qualified,
      correlationRejections: outcome.correlationRejections,
      searchTruncated: outcome.truncated,
      candidatesExcludedByLimit: outcome.candidatesExcludedByLimit,
    });
    await stage("Checking correlation");
    if (outcome.ticket) {
      await stage("Validating final odds");
      // Revalidate source rows and kickoff under a transaction before snapshotting.
      const db = await pool.getConnection();
      try {
        await db.beginTransaction();
        for (const c of outcome.ticket.selections) {
          const [q] = await read(
            db,
            "SELECT price,price_text,observed_at,payload_hash FROM fp_odds WHERE id=? FOR UPDATE",
            [c.oddsId],
          );
          const [fixture] = await read(
            db,
            "SELECT id,status,kickoff FROM fp_fixtures WHERE id=? FOR UPDATE",
            [c.fixtureId],
          );
          if (
            !q ||
            !fixture ||
            q.price_text !== c.price ||
            compare(String(q.price), c.price) !== 0 ||
            q.payload_hash !== c.payloadHash ||
            validateOdds(
              {
                id: fixture.id,
                status: fixture.status,
                kickoff: iso(fixture.kickoff),
              },
              c,
              { maxAgeSeconds: settings.max_odds_age_seconds },
            )
          )
            throw new Error("FINAL_VALIDATION_FAILED");
        }
        await stage("Creating ticket");
        const [ticket] = await db.execute(
          "INSERT INTO fp_tickets(generation_id,day,created_by,original_odds,created_at) VALUES(?,?,?,?,?)",
          [id, day, adminId, outcome.ticket.odds, utc()],
        );
        for (const c of outcome.ticket.selections)
          await db.execute(
            "INSERT INTO fp_selections(ticket_id,fixture_id,prediction_id,bookmaker_id,price,price_text,observed_at,source,payload_hash,fixture_snapshot,bookmaker_snapshot,model_version,probability,confidence,risk) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [
              ticket.insertId,
              c.fixtureId,
              c.predictionId,
              c.bookmakerId,
              c.price,
              c.price,
              sqlDate(c.timestamp),
              c.source,
              c.payloadHash,
              JSON.stringify({
                home: c.homeTeam,
                away: c.awayTeam,
                competition: c.competition,
                kickoff: c.kickoff,
              }),
              c.bookmaker,
              "empirical-form-1",
              c.probability,
              c.confidence,
              c.risk,
            ],
          );
        await audit(db, adminId, "GENERATED", "ticket", ticket.insertId, {
          generation: id,
          odds: outcome.ticket.odds,
        });
        report.selectedPicks = outcome.ticket.selections.length;
        report.totalOdds = outcome.ticket.odds;
        report.durationMs = Date.now() - startedAt;
        await db.execute(
          "UPDATE fp_generation SET status='QUALIFIED',stage='QUALIFIED',report=?,finished_at=? WHERE id=?",
          [JSON.stringify(report), utc(), id],
        );
        await db.commit();
      } catch (e) {
        await db.rollback();
        throw e;
      } finally {
        db.release();
      }
    }
    const status = outcome.ticket ? "QUALIFIED" : "NO_QUALIFYING_TICKET";
    if (!outcome.ticket) {
      report.durationMs = Date.now() - startedAt;
      await pool.execute(
        "UPDATE fp_generation SET status=?,stage=?,report=?,finished_at=? WHERE id=?",
        [status, status, JSON.stringify(report), utc(), id],
      );
    }
    return { generationId: id, status, report };
  } catch (e) {
    report.providerStatus =
      report.providerStatus === "UNKNOWN" ? "FAILED" : report.providerStatus;
    rejected(e.code || "GENERATION_FAILED");
    await pool.execute(
      "UPDATE fp_generation SET status='FAILED',stage='FAILED',report=?,finished_at=? WHERE id=?",
      [JSON.stringify(report), utc(), id],
    );
    throw e;
  }
}
