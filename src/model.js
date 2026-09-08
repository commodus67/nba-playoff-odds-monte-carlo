/**
 * NBA season Monte Carlo model.
 *
 * Pure functions only: no network, no Apify SDK, no globals. Everything in this
 * file can be exercised by `node --test`, which is the point -- the model is the
 * part that has to be right.
 *
 * Basketball differs from the other leagues in this family in three ways that
 * actually change the math:
 *
 *   1. There are no ties and no consolation points. A team's win percentage is
 *      wins / games, full stop, and it averages exactly .500 across the league.
 *   2. Seeding is by conference, not by division. Divisions exist but they only
 *      break ties; they do not reserve playoff berths the way NHL divisions do.
 *   3. Seeds 7 through 10 do not make the playoffs. They enter the play-in
 *      tournament, and only two of those four survive. "Made the play-in" and
 *      "made the playoffs" are therefore different, nearly disjoint events, and
 *      Kalshi prices them as two different markets. The model has to simulate
 *      the play-in games to answer either question honestly.
 */

/** Daryl Morey's exponent for basketball. Baseball uses ~1.83, hockey ~2.0. */
export const PYTHAGOREAN_EXPONENT = 13.91;

/** Regular season length. ESPN publishes 80 of these; two depend on the NBA Cup. */
export const DEFAULT_SEASON_LENGTH = 82;

/** Home win rate for evenly matched teams is about .579, i.e. 0.32 in log-odds. */
export const DEFAULT_HOME_ADVANTAGE = 0.32;

/**
 * How unsure we are of each team's true strength, in log-odds. Without this the
 * simulation treats the ratings as facts and returns absurdly confident numbers
 * -- a 100% playoff team in October, when the market says 97%. Redrawing each
 * team's strength once per simulated season widens the distribution to something
 * a preseason model can actually defend.
 */
export const DEFAULT_STRENGTH_UNCERTAINTY = 0.22;

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** Standard normal from a uniform source, so tests can inject a seeded RNG. */
export function normalSample(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Expected win percentage from points scored and allowed.
 * Returns 0.5 when there is nothing to go on, which is the honest answer in
 * October rather than a divide-by-zero or a wild extrapolation.
 */
export function pythagoreanExpectation(pointsFor, pointsAgainst, exponent = PYTHAGOREAN_EXPONENT) {
  if (!(pointsFor > 0) || !(pointsAgainst > 0)) return 0.5;
  const f = Math.pow(pointsFor, exponent);
  const a = Math.pow(pointsAgainst, exponent);
  return clamp(f / (f + a), 0.001, 0.999);
}

/** Log-odds of a win percentage. Strength differences are additive in this space. */
export function toStrength(winPct) {
  const p = clamp(winPct, 0.02, 0.98);
  return Math.log(p / (1 - p));
}

/**
 * Turn standings rows into a rating per team.
 *
 * The blend is: pythagorean expectation (signal) against actual win percentage
 * (what happened), then the whole thing is regressed toward a prior. The prior
 * is last season's pythagorean, shrunk by `priorCarryover` toward .500, and it
 * is what keeps the model from returning 30 identical teams in preseason -- with
 * zero games played there is no other information in the standings at all.
 */
export function buildRatings(teams, options = {}) {
  const {
    pythagoreanWeight = 0.65,
    regressionGames = 20,
    exponent = PYTHAGOREAN_EXPONENT,
  } = options;

  return teams.map((t) => {
    const played = (t.wins ?? 0) + (t.losses ?? 0);
    const actual = played > 0 ? t.wins / played : 0.5;
    const pyth = pythagoreanExpectation(t.pointsFor, t.pointsAgainst, exponent);
    const blended = played > 0
      ? pythagoreanWeight * pyth + (1 - pythagoreanWeight) * actual
      : 0.5;

    const prior = t.priorTalent ?? 0.5;
    const regressed = (blended * played + prior * regressionGames) / (played + regressionGames);

    return {
      ...t,
      played,
      pythagorean: pyth,
      rating: clamp(regressed, 0.05, 0.95),
      strength: toStrength(clamp(regressed, 0.05, 0.95)),
    };
  });
}

/** Probability the home team wins a single game. */
export function gameProbability(homeStrength, awayStrength, homeAdvantage = DEFAULT_HOME_ADVANTAGE) {
  const diff = homeStrength - awayStrength + homeAdvantage;
  return 1 / (1 + Math.exp(-diff));
}

/**
 * Best-of-seven with the 2-2-1-1-1 home-court pattern. Simulated game by game
 * rather than closed-form, because home court is not symmetric across the seven.
 */
export function simulateSeries(highSeed, lowSeed, homeAdvantage, rand) {
  const pattern = [true, true, false, false, true, false, true]; // true = high seed at home
  let high = 0;
  let low = 0;
  for (let g = 0; g < 7 && high < 4 && low < 4; g += 1) {
    const p = pattern[g]
      ? gameProbability(highSeed.strength, lowSeed.strength, homeAdvantage)
      : 1 - gameProbability(lowSeed.strength, highSeed.strength, homeAdvantage);
    if (rand() < p) high += 1;
    else low += 1;
  }
  return high > low ? highSeed : lowSeed;
}

/**
 * Order a conference. NBA tiebreakers are a long list (head-to-head, division
 * record, conference record...) that we cannot evaluate from a simulated season,
 * so ties are broken by a coin flip. Over many iterations this is unbiased,
 * which is the property that matters for a probability.
 */
function seedConference(entries, rand) {
  return entries
    .map((e) => ({ ...e, jitter: rand() }))
    .sort((a, b) => (b.wins - a.wins) || (b.jitter - a.jitter));
}

/**
 * Play-in tournament. Seeds 7-10 enter, exactly two advance.
 *   Game 1: 7 vs 8 at 7. Winner is the 7 seed.
 *   Game 2: 9 vs 10 at 9. Loser is eliminated.
 *   Game 3: loser of Game 1 hosts winner of Game 2. Winner is the 8 seed.
 */
export function simulatePlayIn(seventh, eighth, ninth, tenth, homeAdvantage, rand) {
  const g1Home = rand() < gameProbability(seventh.strength, eighth.strength, homeAdvantage);
  const sevenSeed = g1Home ? seventh : eighth;
  const g1Loser = g1Home ? eighth : seventh;

  const g2Home = rand() < gameProbability(ninth.strength, tenth.strength, homeAdvantage);
  const g2Winner = g2Home ? ninth : tenth;

  const g3Home = rand() < gameProbability(g1Loser.strength, g2Winner.strength, homeAdvantage);
  const eightSeed = g3Home ? g1Loser : g2Winner;

  return { sevenSeed, eightSeed };
}

/**
 * Run the season `iterations` times.
 *
 * `games` is the list of remaining regular season games as { homeId, awayId }.
 * `gamesShortfall` maps a team id to the number of scheduled games ESPN has not
 * published yet (the NBA Cup placeholders). Those are simulated against a
 * league-average opponent at a neutral site so that projected win totals land on
 * an 82-game scale instead of an 80-game one.
 */
export function simulateSeason(ratedTeams, games, options = {}) {
  const {
    iterations = 20000,
    homeAdvantage = DEFAULT_HOME_ADVANTAGE,
    simulatePlayoffs = true,
    strengthUncertainty = DEFAULT_STRENGTH_UNCERTAINTY,
    seasonLength = DEFAULT_SEASON_LENGTH,
    gamesShortfall = {},
    rand = Math.random,
  } = options;

  const byId = new Map(ratedTeams.map((t) => [String(t.id), t]));
  const ids = ratedTeams.map((t) => String(t.id));
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;

  const averageStrength = ratedTeams.reduce((a, t) => a + t.strength, 0) / n;

  const totals = {
    wins: new Float64Array(n),
    seed: new Float64Array(n),
    playoffs: new Float64Array(n),
    playIn: new Float64Array(n),
    topSix: new Float64Array(n),
    division: new Float64Array(n),
    bestRecord: new Float64Array(n),
    conferenceFinals: new Float64Array(n),
    conferenceChamp: new Float64Array(n),
    champion: new Float64Array(n),
  };

  const conferences = [...new Set(ratedTeams.map((t) => t.conference))];
  const divisions = [...new Set(ratedTeams.map((t) => t.division))];

  const wins = new Int32Array(n);
  const baseStrength = ratedTeams.map((t) => t.strength);
  const strength = new Float64Array(n);

  for (let it = 0; it < iterations; it += 1) {
    for (let i = 0; i < n; i += 1) {
      wins[i] = byId.get(ids[i]).wins ?? 0;
      // One draw per season, not per game: a team is good or bad for the whole
      // year, which is what makes the tails wide instead of just noisy.
      strength[i] = strengthUncertainty > 0
        ? baseStrength[i] + normalSample(rand) * strengthUncertainty
        : baseStrength[i];
    }

    for (const g of games) {
      const hi = index.get(String(g.homeId));
      const ai = index.get(String(g.awayId));
      if (hi === undefined || ai === undefined) continue;
      const p = gameProbability(strength[hi], strength[ai], homeAdvantage);
      if (rand() < p) wins[hi] += 1;
      else wins[ai] += 1;
    }

    // NBA Cup placeholders: neutral-site games against an average opponent.
    for (const [id, count] of Object.entries(gamesShortfall)) {
      const i = index.get(String(id));
      if (i === undefined || !(count > 0)) continue;
      const p = gameProbability(strength[i], averageStrength, 0);
      for (let k = 0; k < count; k += 1) if (rand() < p) wins[i] += 1;
    }

    for (let i = 0; i < n; i += 1) totals.wins[i] += wins[i];

    // Best regular season record in the league.
    let bestIdx = 0;
    let bestWins = -1;
    let bestJitter = -1;
    for (let i = 0; i < n; i += 1) {
      const j = rand();
      if (wins[i] > bestWins || (wins[i] === bestWins && j > bestJitter)) {
        bestWins = wins[i];
        bestJitter = j;
        bestIdx = i;
      }
    }
    totals.bestRecord[bestIdx] += 1;

    for (const div of divisions) {
      let di = -1;
      let dw = -1;
      let dj = -1;
      for (let i = 0; i < n; i += 1) {
        if (byId.get(ids[i]).division !== div) continue;
        const j = rand();
        if (wins[i] > dw || (wins[i] === dw && j > dj)) { dw = wins[i]; dj = j; di = i; }
      }
      if (di >= 0) totals.division[di] += 1;
    }

    const bracketByConference = {};

    for (const conf of conferences) {
      const entries = [];
      for (let i = 0; i < n; i += 1) {
        const t = byId.get(ids[i]);
        if (t.conference !== conf) continue;
        entries.push({ i, wins: wins[i], strength: strength[i] });
      }
      const ordered = seedConference(entries, rand);

      for (let s = 0; s < ordered.length; s += 1) totals.seed[ordered[s].i] += s + 1;
      for (let s = 0; s < 6 && s < ordered.length; s += 1) {
        totals.topSix[ordered[s].i] += 1;
        totals.playoffs[ordered[s].i] += 1;
      }
      for (let s = 6; s < 10 && s < ordered.length; s += 1) totals.playIn[ordered[s].i] += 1;

      let seven = null;
      let eight = null;
      if (ordered.length >= 10) {
        const r = simulatePlayIn(ordered[6], ordered[7], ordered[8], ordered[9], homeAdvantage, rand);
        seven = r.sevenSeed;
        eight = r.eightSeed;
        totals.playoffs[seven.i] += 1;
        totals.playoffs[eight.i] += 1;
      } else {
        seven = ordered[6] ?? null;
        eight = ordered[7] ?? null;
        if (seven) totals.playoffs[seven.i] += 1;
        if (eight) totals.playoffs[eight.i] += 1;
      }

      if (simulatePlayoffs && seven && eight) {
        bracketByConference[conf] = [
          ordered[0], ordered[1], ordered[2], ordered[3], ordered[4], ordered[5], seven, eight,
        ];
      }
    }

    if (simulatePlayoffs && Object.keys(bracketByConference).length === conferences.length) {
      const finalists = [];
      for (const conf of conferences) {
        const b = bracketByConference[conf];
        const r1a = simulateSeries(b[0], b[7], homeAdvantage, rand);
        const r1b = simulateSeries(b[3], b[4], homeAdvantage, rand);
        const r1c = simulateSeries(b[1], b[6], homeAdvantage, rand);
        const r1d = simulateSeries(b[2], b[5], homeAdvantage, rand);

        const semiA = simulateSeries(...orderBySeed(r1a, r1b, b), homeAdvantage, rand);
        const semiB = simulateSeries(...orderBySeed(r1c, r1d, b), homeAdvantage, rand);

        totals.conferenceFinals[semiA.i] += 1;
        totals.conferenceFinals[semiB.i] += 1;

        const champ = simulateSeries(...orderBySeed(semiA, semiB, b), homeAdvantage, rand);
        totals.conferenceChamp[champ.i] += 1;
        finalists.push({ team: champ, wins: wins[champ.i] });
      }
      if (finalists.length === 2) {
        const [x, y] = finalists;
        const high = x.wins >= y.wins ? x.team : y.team;
        const low = x.wins >= y.wins ? y.team : x.team;
        const winner = simulateSeries(high, low, homeAdvantage, rand);
        totals.champion[winner.i] += 1;
      }
    }
  }

  return ratedTeams.map((t, i) => ({
    ...t,
    projectedWins: totals.wins[i] / iterations,
    projectedLosses: seasonLength - totals.wins[i] / iterations,
    averageSeed: totals.seed[i] / iterations,
    playoffProbability: totals.playoffs[i] / iterations,
    playInProbability: totals.playIn[i] / iterations,
    topSixProbability: totals.topSix[i] / iterations,
    divisionWinProbability: totals.division[i] / iterations,
    bestRecordProbability: totals.bestRecord[i] / iterations,
    conferenceFinalsProbability: totals.conferenceFinals[i] / iterations,
    conferenceChampProbability: totals.conferenceChamp[i] / iterations,
    championshipProbability: totals.champion[i] / iterations,
  }));
}

/** Home court in a series goes to the better seed; the bracket array is seed-ordered. */
function orderBySeed(a, b, bracket) {
  const rank = (x) => bracket.indexOf(x);
  return rank(a) <= rank(b) ? [a, b] : [b, a];
}
