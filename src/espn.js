/**
 * ESPN data loading, kept apart from the Actor so it can be exercised without
 * the SDK. ESPN names a season by the year it ENDS: 2026-27 is season=2027.
 */

const ESPN_SITE = 'https://site.api.espn.com';
const STANDINGS_PATH = '/apis/v2/sports/basketball/nba/standings';
const SCHEDULE_PATH = '/apis/site/v2/sports/basketball/nba/teams';

/* ESPN rejects requests without a browser-shaped user agent. */
const USER_AGENT = 'Mozilla/5.0 (compatible; ApifyActor/1.0; +https://apify.com)';

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

const statValue = (entry, name) => {
  const s = entry.stats?.find((x) => x.name === name);
  return Number.isFinite(s?.value) ? s.value : null;
};

export function normalizeConference(name) {
  if (!name) return 'Unknown';
  if (/east/i.test(name)) return 'Eastern Conference';
  if (/west/i.test(name)) return 'Western Conference';
  return name;
}

/** Walk NBA -> conference -> division; team rows hang off the division groups. */
export async function loadTeams(season) {
  const data = await getJson(`${ESPN_SITE}${STANDINGS_PATH}?level=3&seasontype=2&season=${season}`);
  const teams = [];
  const walk = (node, conference) => {
    const conf = node.name && /conference/i.test(node.name) ? node.name : conference;
    for (const entry of node.standings?.entries ?? []) {
      teams.push({
        id: String(entry.team.id),
        abbreviation: entry.team.abbreviation,
        name: entry.team.displayName,
        conference: normalizeConference(conf),
        division: node.name ?? node.abbreviation ?? 'Unknown',
        wins: statValue(entry, 'wins') ?? 0,
        losses: statValue(entry, 'losses') ?? 0,
        pointsFor: statValue(entry, 'pointsFor') ?? 0,
        pointsAgainst: statValue(entry, 'pointsAgainst') ?? 0,
      });
    }
    for (const child of node.children ?? []) walk(child, conf);
  };
  walk(data, null);
  return teams;
}

/**
 * Remaining games, collected once each from the home team's schedule so that no
 * deduplication pass is needed. Also returns how many games ESPN has published
 * per team, which is how the NBA Cup gap is detected.
 */
export async function loadRemainingGames(teams, season, { log = () => {}, batchSize = 6 } = {}) {
  const games = [];
  const scheduled = new Map(teams.map((t) => [t.id, 0]));

  for (let i = 0; i < teams.length; i += batchSize) {
    const batch = teams.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (t) => {
      const url = `${ESPN_SITE}${SCHEDULE_PATH}/${t.id}/schedule?season=${season}&seasontype=2`;
      try {
        return { team: t, data: await getJson(url) };
      } catch (err) {
        log(`Schedule unavailable for ${t.abbreviation}: ${err.message}`);
        return { team: t, data: null };
      }
    }));

    for (const { team, data } of results) {
      for (const event of data?.events ?? []) {
        const comp = event.competitions?.[0];
        if (!comp) continue;
        scheduled.set(team.id, (scheduled.get(team.id) ?? 0) + 1);
        if (comp.status?.type?.completed) continue;
        const home = comp.competitors?.find((c) => c.homeAway === 'home');
        const away = comp.competitors?.find((c) => c.homeAway === 'away');
        if (!home || !away) continue;
        if (String(home.team?.id) !== team.id) continue;
        games.push({ homeId: String(home.team.id), awayId: String(away.team.id), date: event.date });
      }
    }
  }
  return { games, scheduled };
}
