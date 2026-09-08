import { Actor } from 'apify';
import {
  buildRatings,
  simulateSeason,
  pythagoreanExpectation,
  DEFAULT_SEASON_LENGTH,
  DEFAULT_HOME_ADVANTAGE,
  DEFAULT_STRENGTH_UNCERTAINTY,
} from './model.js';
import { fetchKalshiEvent, buildValueBets, marketIntegrity } from './marketOdds.js';
import { loadTeams, loadRemainingGames } from './espn.js';

await Actor.init();

const input = (await Actor.getInput()) ?? {};

/* ESPN names a season by the year it ENDS: 2026-27 is season=2027. */
const SEASON = Number(input.season) || defaultSeason();
const ITERATIONS = clampInt(input.iterations, 1000, 200000, 20000);
const PYTHAGOREAN_WEIGHT = clampNum(input.pythagoreanWeight, 0, 1, 0.65);
const REGRESSION_GAMES = clampNum(input.regressionGames, 0, 82, 20);
const HOME_ADVANTAGE = clampNum(input.homeAdvantage, 0, 1, DEFAULT_HOME_ADVANTAGE);
const STRENGTH_UNCERTAINTY = clampNum(input.strengthUncertainty, 0, 1, DEFAULT_STRENGTH_UNCERTAINTY);
const PRIOR_CARRYOVER = clampNum(input.priorCarryover, 0, 1, 0.6);
const SEASON_LENGTH = clampInt(input.seasonLength, 1, 100, DEFAULT_SEASON_LENGTH);
const MIN_GAMES_FOR_VALUE = clampInt(input.minGamesPlayedForValue, 0, 82, 10);

const INCLUDE_MARKET = input.includeMarketComparison !== false;
const INCLUDE_PLAYIN = input.includePlayInMarkets === true;
const INCLUDE_CHAMPIONSHIP = input.includeChampionshipMarket === true;

const EDGE_THRESHOLD = clampNum(input.edgeThreshold, 0, 1, 0.05);
const FEE_RATE = clampNum(input.feeRate, 0, 0.5, 0.07);
const BANKROLL = Math.max(0, Number(input.bankroll) || 0);
const MAX_PER_POSITION_PCT = clampNum(input.maxPerPositionPct, 0, 100, 5);
const MAX_TOTAL_EXPOSURE_PCT = clampNum(input.maxTotalExposurePct, 0, 100, 25);
const ARCHIVE_DATASET = String(input.archiveToNamedDataset ?? '').trim();


function defaultSeason() {
  // A season that tips off in October is named for the following calendar year.
  const now = new Date();
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt;
}

function clampInt(v, lo, hi, dflt) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt;
}

/* -------------------------------------------------------------------------- */

const startedAt = new Date().toISOString();

let teams = await loadTeams(SEASON);
let rosterSeason = SEASON;

/**
 * Before opening night ESPN publishes the 2026-27 division tree with zero teams
 * in it. Fall back to last season for the roster and the conference map, and
 * zero the records so nothing pretends games have been played.
 */
if (!teams.length) {
  rosterSeason = SEASON - 1;
  Actor.log.info(`ESPN has no ${SEASON} standings yet; taking the club list and division map from ${rosterSeason}.`);
  const previous = await loadTeams(rosterSeason);
  teams = previous.map((t) => ({ ...t, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 }));
}

if (!teams.length) throw new Error(`ESPN returned no NBA teams for ${SEASON} or ${SEASON - 1}.`);

/**
 * Preseason prior. Without it every team rates .500 and the Actor returns thirty
 * identical rows -- the failure this family of Actors has hit before.
 */
const priorSeason = rosterSeason === SEASON ? SEASON - 1 : rosterSeason;
try {
  const prior = await loadTeams(priorSeason);
  const priorById = new Map(prior.map((t) => [t.id, t]));
  for (const t of teams) {
    const p = priorById.get(t.id);
    if (!p) continue;
    const talent = pythagoreanExpectation(p.pointsFor, p.pointsAgainst);
    t.priorTalent = 0.5 + (talent - 0.5) * PRIOR_CARRYOVER;
  }
} catch (err) {
  Actor.log.warning(`No ${priorSeason} standings to build a prior from (${err.message}); every team starts at .500.`);
}

const { games, scheduled } = await loadRemainingGames(teams, SEASON, { log: (m) => Actor.log.warning(m) });

/**
 * ESPN lists 80 of the 82 games before the season starts: the last two depend on
 * how the NBA Cup falls. Simulate the gap against an average opponent rather
 * than quietly projecting an 80-game season.
 */
const gamesShortfall = {};
for (const t of teams) {
  const known = scheduled.get(t.id) ?? 0;
  const played = (t.wins ?? 0) + (t.losses ?? 0);
  const deficit = SEASON_LENGTH - Math.max(known, played);
  if (deficit > 0) gamesShortfall[t.id] = deficit;
}
const totalShortfall = Object.values(gamesShortfall).reduce((a, b) => a + b, 0);

const leagueGamesPlayed = Math.round(
  teams.reduce((a, t) => a + (t.wins ?? 0) + (t.losses ?? 0), 0) / Math.max(teams.length, 1),
);
const allowValue = leagueGamesPlayed >= MIN_GAMES_FOR_VALUE;

Actor.log.info(
  `NBA ${SEASON}: ${teams.length} teams, ${games.length} games left, ${leagueGamesPlayed} played per team, `
  + `${totalShortfall} unscheduled game slots, ${ITERATIONS} iterations.`,
);
if (!allowValue) {
  Actor.log.info(
    `Value calls are held back until each team has played ${MIN_GAMES_FOR_VALUE} games. `
    + 'Edges are still reported in full, but every row is labelled WATCH.',
  );
}

const rated = buildRatings(teams, {
  pythagoreanWeight: PYTHAGOREAN_WEIGHT,
  regressionGames: REGRESSION_GAMES,
});

const projections = simulateSeason(rated, games, {
  iterations: ITERATIONS,
  homeAdvantage: HOME_ADVANTAGE,
  strengthUncertainty: STRENGTH_UNCERTAINTY,
  seasonLength: SEASON_LENGTH,
  gamesShortfall,
  simulatePlayoffs: true,
});

/* ------------------------------------------------------------- the markets -- */

const seasonSuffix = String(SEASON).slice(-2);
const marketBlocks = [];

async function addMarket({ eventTicker, label, probabilityKey, targetSum, rows }) {
  try {
    const outcomes = await fetchKalshiEvent(eventTicker);
    if (!outcomes.length) {
      Actor.log.warning(`Kalshi returned no contracts for ${eventTicker}.`);
      return;
    }
    const integrity = marketIntegrity(outcomes, targetSum);
    const result = buildValueBets(rows, outcomes, {
      probabilityKey,
      edgeThreshold: EDGE_THRESHOLD,
      feeRate: FEE_RATE,
      bankroll: BANKROLL,
      maxPerPositionPct: MAX_PER_POSITION_PCT,
      maxTotalExposurePct: MAX_TOTAL_EXPOSURE_PCT,
      allowValue,
      marketLabel: label,
    });
    Actor.log.info(
      `${label} (${eventTicker}): listed ${result.outcomesListed}, matched ${result.matched}, `
      + `price sum ${integrity.sum} vs target ${targetSum} (${integrity.ok ? 'ok' : 'CHECK'}).`,
    );
    if (result.unmatched.length) Actor.log.warning(`Unmatched contracts: ${result.unmatched.join(', ')}`);
    marketBlocks.push({ eventTicker, label, integrity, ...result });
  } catch (err) {
    Actor.log.warning(`Market ${eventTicker} unavailable (${err.message}); projections are unaffected.`);
  }
}

if (INCLUDE_MARKET) {
  await addMarket({
    eventTicker: `KXNBAPLAYOFF-${seasonSuffix}`,
    label: 'Playoff qualifiers',
    probabilityKey: 'playoffProbability',
    targetSum: 16,
    rows: projections,
  });

  if (INCLUDE_PLAYIN) {
    // Kalshi splits the play-in into one event per conference, and it settles on
    // finishing 7th-10th -- not on making the playoffs. Different question,
    // different column.
    for (const [conf, suffix] of [['Eastern Conference', 'EAST'], ['Western Conference', 'WEST']]) {
      await addMarket({
        eventTicker: `KXNBAPLAYIN-${seasonSuffix}${suffix}`,
        label: `Play-in qualifiers (${suffix === 'EAST' ? 'East' : 'West'})`,
        probabilityKey: 'playInProbability',
        targetSum: 4,
        rows: projections.filter((t) => t.conference === conf),
      });
    }
  }

  if (INCLUDE_CHAMPIONSHIP) {
    await addMarket({
      eventTicker: `KXNBA-${seasonSuffix}`,
      label: 'Champion',
      probabilityKey: 'championshipProbability',
      targetSum: 1,
      rows: projections,
    });
  }
}

/* ------------------------------------------------------------------ output -- */

const playoffBets = new Map(
  (marketBlocks.find((b) => b.label === 'Playoff qualifiers')?.bets ?? []).map((b) => [b.teamId, b]),
);

const rows = projections
  .slice()
  .sort((a, b) => b.playoffProbability - a.playoffProbability || b.projectedWins - a.projectedWins)
  .map((t) => {
    const bet = playoffBets.get(String(t.id)) ?? null;
    return {
      team: t.name,
      abbreviation: t.abbreviation,
      conference: t.conference,
      division: t.division,
      season: `${SEASON - 1}-${seasonSuffix}`,
      gamesPlayed: t.played,
      wins: t.wins,
      losses: t.losses,
      rating: Number(t.rating.toFixed(4)),
      pythagorean: Number(t.pythagorean.toFixed(4)),
      projectedWins: Number(t.projectedWins.toFixed(2)),
      projectedLosses: Number(t.projectedLosses.toFixed(2)),
      averageSeed: Number(t.averageSeed.toFixed(2)),
      fairPlayoffProbability: Number(t.playoffProbability.toFixed(4)),
      fairTopSixProbability: Number(t.topSixProbability.toFixed(4)),
      fairPlayInProbability: Number(t.playInProbability.toFixed(4)),
      fairDivisionProbability: Number(t.divisionWinProbability.toFixed(4)),
      fairBestRecordProbability: Number(t.bestRecordProbability.toFixed(4)),
      fairConferenceFinalsProbability: Number(t.conferenceFinalsProbability.toFixed(4)),
      fairConferenceProbability: Number(t.conferenceChampProbability.toFixed(4)),
      fairChampionshipProbability: Number(t.championshipProbability.toFixed(4)),
      marketTicker: bet?.ticker ?? null,
      marketSide: bet?.side ?? null,
      marketPrice: bet?.marketPrice ?? null,
      marketMid: bet?.marketMid ?? null,
      edge: bet?.edge ?? null,
      expectedValuePerContract: bet?.expectedValuePerContract ?? null,
      call: bet?.call ?? (INCLUDE_MARKET ? null : undefined),
      suggestedContracts: bet?.suggestedContracts ?? null,
      suggestedStake: bet?.suggestedStake ?? null,
      valueCallsEnabled: allowValue,
      minGamesPlayedForValue: MIN_GAMES_FOR_VALUE,
      priorCarryover: PRIOR_CARRYOVER,
      strengthUncertainty: STRENGTH_UNCERTAINTY,
      iterations: ITERATIONS,
      marketSource: INCLUDE_MARKET ? 'kalshi' : 'none',
      retrievedAt: startedAt,
    };
  });

await Actor.pushData(rows);
await Actor.charge({ eventName: 'team-projection', count: rows.length });

if (ARCHIVE_DATASET) {
  const archive = await Actor.openDataset(ARCHIVE_DATASET, { forceCloud: true });
  await archive.pushData(rows);
  Actor.log.info(`Also appended ${rows.length} rows to the named dataset "${ARCHIVE_DATASET}".`);
}

await Actor.setValue('MARKET_COMPARISON', {
  season: SEASON,
  retrievedAt: startedAt,
  valueCallsEnabled: allowValue,
  leagueGamesPlayed,
  markets: marketBlocks.map((b) => ({
    eventTicker: b.eventTicker,
    label: b.label,
    integrity: b.integrity,
    outcomesListed: b.outcomesListed,
    matched: b.matched,
    unmatched: b.unmatched,
    bets: b.bets,
  })),
});

Actor.log.info(`Done: ${rows.length} team projections for NBA ${SEASON}.`);
await Actor.exit();
