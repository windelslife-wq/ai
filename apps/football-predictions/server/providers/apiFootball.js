import { hash, utc, sqlDate } from "../db.js";
export class ProviderError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export class ApiFootball {
  constructor(
    pool,
    { key = process.env.API_FOOTBALL_KEY, fetcher = fetch } = {},
  ) {
    this.pool = pool;
    this.key = key;
    this.fetcher = fetcher;
  }
  async get(path, params = {}, ttl = 0) {
    if (!this.key) throw new ProviderError("PROVIDER_NOT_CONFIGURED");
    const url = new URL(`https://v3.football.api-sports.io/${path}`);
    for (const [k, v] of Object.entries(params))
      url.searchParams.set(k, String(v));
    const cacheKey = hash(url.toString());
    if (ttl) {
      const [rows] = await this.pool.execute(
        "SELECT body FROM fp_provider_cache WHERE cache_key=? AND expires_at>UTC_TIMESTAMP(3)",
        [cacheKey],
      );
      if (rows.length)
        return typeof rows[0].body === "string"
          ? JSON.parse(rows[0].body)
          : rows[0].body;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await this.fetcher(url, {
          headers: { "x-apisports-key": this.key },
          signal: AbortSignal.timeout(9000),
        });
      } catch {
        if (attempt < 2) continue;
        throw new ProviderError("PROVIDER_UNREACHABLE");
      }
      if (response.status === 429)
        throw new ProviderError("PROVIDER_RATE_LIMITED"); // stop immediately; never hammer a quota-limited plan
      if (response.status >= 500) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        throw new ProviderError("PROVIDER_ERROR");
      }
      if (!response.ok)
        throw new ProviderError(
          response.status === 401 || response.status === 403
            ? "PROVIDER_AUTH_FAILED"
            : "PROVIDER_ERROR",
        );
      let json;
      try {
        json = await response.json();
      } catch {
        throw new ProviderError("PROVIDER_INVALID_JSON");
      }
      if (json.errors && Object.keys(json.errors).length)
        throw new ProviderError("PROVIDER_REPORTED_ERROR");
      if (!Array.isArray(json.response) && path !== "status")
        throw new ProviderError("PROVIDER_INVALID_RESPONSE");
      if (ttl)
        await this.pool.execute(
          "INSERT INTO fp_provider_cache(cache_key,body,expires_at) VALUES(?,?,?) ON DUPLICATE KEY UPDATE body=VALUES(body),expires_at=VALUES(expires_at)",
          [cacheKey, JSON.stringify(json), sqlDate(Date.now() + ttl * 1000)],
        );
      return json;
    }
  }
  fixtures(date) {
    return this.get("fixtures", { date }, 300);
  }
  odds(fixtureId, force = false) {
    return this.get("odds", { fixture: fixtureId }, force ? 0 : 120);
  }
  recent(teamId) {
    return this.get("fixtures", { team: teamId, last: 10 }, 3600);
  }
  status(force = false) {
    return this.get("status", {}, force ? 0 : 60);
  }
}
export function normalizeFixture(raw) {
  const id = raw?.fixture?.id,
    league = raw?.league,
    home = raw?.teams?.home,
    away = raw?.teams?.away;
  if (
    !Number.isSafeInteger(id) ||
    !Number.isSafeInteger(league?.id) ||
    !Number.isSafeInteger(home?.id) ||
    !Number.isSafeInteger(away?.id) ||
    !raw.fixture.date ||
    !raw.fixture.status?.short ||
    !home.name ||
    !away.name ||
    !league.name
  )
    return null;
  return {
    id,
    competitionId: league.id,
    competition: league.name,
    country: league.country || null,
    homeTeamId: home.id,
    awayTeamId: away.id,
    homeTeam: home.name,
    awayTeam: away.name,
    kickoff: raw.fixture.date,
    status: raw.fixture.status.short,
    homeGoals: raw.goals?.home ?? null,
    awayGoals: raw.goals?.away ?? null,
  };
}
export function normalizeOdds(raw, fixtureId) {
  const found = [];
  if (
    raw?.fixture?.id !== fixtureId ||
    !raw.update ||
    !Number.isFinite(Date.parse(raw.update))
  )
    return found;
  for (const book of raw.bookmakers || [])
    for (const bet of book.bets || []) {
      if (!/^goals over\/under$/i.test(String(bet.name).trim())) continue;
      for (const value of bet.values || []) {
        if (String(value.value).trim() !== "Over 1.5") continue;
        const price = String(value.odd);
        if (
          !/^\d{1,6}(\.\d{1,12})?$/.test(price) ||
          Number(price) <= 1 ||
          !Number.isSafeInteger(book.id) ||
          !book.name
        )
          continue;
        found.push({
          fixtureId,
          bookmakerId: book.id,
          bookmaker: book.name,
          market: "OVER_1_5",
          price,
          timestamp: raw.update,
          source: "API_FOOTBALL",
          verified: true,
          manuallyAltered: false,
          payloadHash: hash(
            JSON.stringify({
              fixture: fixtureId,
              bookmaker: book.id,
              bet: bet.id,
              value: value.value,
              price,
              update: raw.update,
            }),
          ),
        });
      }
    }
  return found;
}
export function normalizeForm(fixtures, teamId, now = Date.now()) {
  return fixtures
    .map((f) => ({
      fixtureId: f?.fixture?.id,
      timestamp: f?.fixture?.date,
      status: f?.fixture?.status?.short,
      homeId: f?.teams?.home?.id,
      awayId: f?.teams?.away?.id,
      homeGoals: f?.goals?.home,
      awayGoals: f?.goals?.away,
    }))
    .filter(
      (f) =>
        Number.isSafeInteger(f.fixtureId) &&
        ["FT", "AET", "PEN"].includes(f.status) &&
        Date.parse(f.timestamp) < now &&
        (f.homeId === teamId || f.awayId === teamId) &&
        Number.isInteger(f.homeGoals) &&
        f.homeGoals >= 0 &&
        Number.isInteger(f.awayGoals) &&
        f.awayGoals >= 0,
    )
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, 10);
}
export async function saveFixture(db, f) {
  await db.execute(
    "INSERT INTO fp_competitions(id,name,country) VALUES(?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),country=VALUES(country)",
    [f.competitionId, f.competition, f.country],
  );
  for (const [id, name] of [
    [f.homeTeamId, f.homeTeam],
    [f.awayTeamId, f.awayTeam],
  ])
    await db.execute(
      "INSERT INTO fp_teams(id,name) VALUES(?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)",
      [id, name],
    );
  await db.execute(
    "INSERT INTO fp_fixtures(id,competition_id,home_team_id,away_team_id,kickoff,status,home_goals,away_goals,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE kickoff=VALUES(kickoff),status=VALUES(status),home_goals=VALUES(home_goals),away_goals=VALUES(away_goals),updated_at=VALUES(updated_at)",
    [
      f.id,
      f.competitionId,
      f.homeTeamId,
      f.awayTeamId,
      sqlDate(f.kickoff),
      f.status,
      f.homeGoals,
      f.awayGoals,
      utc(),
    ],
  );
}
export async function saveOdds(db, odds) {
  await db.execute(
    "INSERT INTO fp_bookmakers(id,name) VALUES(?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)",
    [odds.bookmakerId, odds.bookmaker],
  );
  await db.execute(
    "INSERT IGNORE INTO fp_odds(fixture_id,bookmaker_id,market,price,price_text,observed_at,source,payload_hash,ingested_at) VALUES(?,?,?,?,?,?,?,?,?)",
    [
      odds.fixtureId,
      odds.bookmakerId,
      odds.market,
      odds.price,
      odds.price,
      sqlDate(odds.timestamp),
      odds.source,
      odds.payloadHash,
      utc(),
    ],
  );
}
