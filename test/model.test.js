import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pythagoreanExpectation,
  toStrength,
  gameProbability,
  buildRatings,
  simulatePlayIn,
  simulateSeries,
  simulateSeason,
  PYTHAGOREAN_EXPONENT,
} from '../src/model.js';

/** Deterministic RNG so a failure is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONFS = { East: ['AT', 'CE', 'SE'], West: ['NW', 'PA', 'SW'] };

/** 30 teams, five per division, with a spread of talent. */
function makeLeague({ played = 0 } = {}) {
  const teams = [];
  let k = 0;
  for (const [conference, divs] of Object.entries(CONFS)) {
    for (const division of divs) {
      for (let d = 0; d < 5; d += 1) {
        const talent = 0.30 + 0.028 * k;
        teams.push({
          id: k + 1,
          abbreviation: `T${k + 1}`,
          name: `Team ${k + 1}`,
          conference,
          division,
          wins: Math.round(played * talent),
          losses: played - Math.round(played * talent),
          pointsFor: played * 110,
          pointsAgainst: played * 110,
          priorTalent: talent,
        });
        k += 1;
      }
    }
  }
  return teams;
}

/** Round-robin remainder: every team plays every other team twice, home and away. */
function makeSchedule(teams) {
  const games = [];
  for (const a of teams) {
    for (const b of teams) {
      if (a.id !== b.id) games.push({ homeId: a.id, awayId: b.id });
    }
  }
  return games;
}

test('pythagorean expectation is .500 with no data and monotonic with margin', () => {
  assert.equal(pythagoreanExpectation(0, 0), 0.5);
  assert.equal(pythagoreanExpectation(9000, 9000), 0.5);
  assert.ok(pythagoreanExpectation(9400, 8800) > 0.5);
  assert.ok(pythagoreanExpectation(8800, 9400) < 0.5);
  assert.ok(
    pythagoreanExpectation(9600, 8800) > pythagoreanExpectation(9400, 8800),
    'a bigger margin must not lower the expectation',
  );
});

test('the basketball exponent is the basketball one, not baseball or hockey', () => {
  assert.equal(PYTHAGOREAN_EXPONENT, 13.91);
  // Boston 2025-26: 9418 for, 8787 against, 56-26 actual. A hockey exponent of 2.0
  // would put this team near .535; the basketball exponent has to land near .72.
  const p = pythagoreanExpectation(9418, 8787);
  assert.ok(p > 0.68 && p < 0.76, `expected ~.72, got ${p}`);
});

test('toStrength and gameProbability are inverses through the home advantage', () => {
  assert.ok(Math.abs(gameProbability(toStrength(0.5), toStrength(0.5), 0) - 0.5) < 1e-12);
  const even = gameProbability(toStrength(0.5), toStrength(0.5), 0.32);
  assert.ok(even > 0.57 && even < 0.59, `even matchup at home should be ~.579, got ${even}`);
  // Symmetry: swapping the teams and the venue must give the complement.
  const a = gameProbability(toStrength(0.7), toStrength(0.4), 0.32);
  const b = gameProbability(toStrength(0.4), toStrength(0.7), -0.32);
  assert.ok(Math.abs(a - (1 - b)) < 1e-12);
});

test('preseason ratings are driven by the prior, not flattened to .500', () => {
  const rated = buildRatings(makeLeague({ played: 0 }));
  const ratings = rated.map((t) => t.rating);
  const spread = Math.max(...ratings) - Math.min(...ratings);
  assert.ok(spread > 0.1, `preseason teams collapsed to identical ratings (spread ${spread})`);
  // Ordering must follow the prior.
  assert.ok(rated[29].rating > rated[0].rating);
});

test('a played season pulls the rating toward what actually happened', () => {
  const [flat] = buildRatings([{
    id: 1, wins: 60, losses: 10, pointsFor: 7800, pointsAgainst: 6900, priorTalent: 0.5,
  }]);
  assert.ok(flat.rating > 0.6, `70 games at .857 should rate well above .500, got ${flat.rating}`);
});

test('play-in advances exactly two of the four entrants', () => {
  const rand = mulberry32(7);
  const mk = (i, s) => ({ i, strength: s });
  for (let trial = 0; trial < 200; trial += 1) {
    const { sevenSeed, eightSeed } = simulatePlayIn(
      mk(7, 0.4), mk(8, 0.2), mk(9, 0.0), mk(10, -0.2), 0.32, rand,
    );
    assert.notEqual(sevenSeed.i, eightSeed.i, 'the same team cannot take both berths');
    assert.ok([7, 8].includes(sevenSeed.i), 'the 7 seed can only come from the 7/8 game');
    assert.ok([7, 8, 9, 10].includes(eightSeed.i));
  }
});

test('the 10 seed can only reach the playoffs by winning two games', () => {
  // A 10 seed that always loses must never advance; one that always wins must.
  const mk = (i, s) => ({ i, strength: s });
  const alwaysLoses = simulatePlayIn(mk(7, 5), mk(8, 5), mk(9, 5), mk(10, -50), 0.32, () => 0.5);
  assert.notEqual(alwaysLoses.eightSeed.i, 10);
  const dominant = simulatePlayIn(mk(7, 0), mk(8, 0), mk(9, -50), mk(10, 50), 0.32, () => 0.5);
  assert.equal(dominant.eightSeed.i, 10);
});

test('a best-of-seven returns one of its two entrants and favours the better team', () => {
  const rand = mulberry32(11);
  const strong = { i: 1, strength: toStrength(0.7) };
  const weak = { i: 2, strength: toStrength(0.35) };
  let strongWins = 0;
  for (let k = 0; k < 4000; k += 1) {
    const w = simulateSeries(strong, weak, 0.32, rand);
    assert.ok(w === strong || w === weak);
    if (w === strong) strongWins += 1;
  }
  const rate = strongWins / 4000;
  assert.ok(rate > 0.85 && rate < 0.999, `expected a strong favourite, got ${rate}`);
});

test('season probabilities close: 16 playoff berths, 8 play-in spots, 1 champion', () => {
  const teams = makeLeague({ played: 0 });
  const rated = buildRatings(teams);
  const rows = simulateSeason(rated, makeSchedule(teams), {
    iterations: 400,
    rand: mulberry32(2026),
  });

  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);

  assert.ok(Math.abs(sum('playoffProbability') - 16) < 1e-9, sum('playoffProbability'));
  assert.ok(Math.abs(sum('topSixProbability') - 12) < 1e-9, sum('topSixProbability'));
  assert.ok(Math.abs(sum('playInProbability') - 8) < 1e-9, sum('playInProbability'));
  assert.ok(Math.abs(sum('divisionWinProbability') - 6) < 1e-9, sum('divisionWinProbability'));
  assert.ok(Math.abs(sum('bestRecordProbability') - 1) < 1e-9);
  assert.ok(Math.abs(sum('conferenceChampProbability') - 2) < 1e-9);
  assert.ok(Math.abs(sum('conferenceFinalsProbability') - 4) < 1e-9);
  assert.ok(Math.abs(sum('championshipProbability') - 1) < 1e-9);
});

test('playoff probability is top-six plus a share of the play-in, per team', () => {
  const teams = makeLeague({ played: 0 });
  const rows = simulateSeason(buildRatings(teams), makeSchedule(teams), {
    iterations: 300,
    rand: mulberry32(5),
  });
  for (const r of rows) {
    assert.ok(
      r.playoffProbability >= r.topSixProbability - 1e-9,
      `${r.abbreviation}: playoff odds below top-six odds`,
    );
    assert.ok(
      r.playoffProbability <= r.topSixProbability + r.playInProbability + 1e-9,
      `${r.abbreviation}: playoff odds exceed top-six plus play-in`,
    );
  }
});

test('every simulated conference fills all ten seeded slots', () => {
  const teams = makeLeague({ played: 0 });
  const rows = simulateSeason(buildRatings(teams), makeSchedule(teams), {
    iterations: 200,
    rand: mulberry32(99),
  });
  for (const conf of ['East', 'West']) {
    const inConf = rows.filter((r) => r.conference === conf);
    assert.equal(inConf.length, 15);
    const playoffs = inConf.reduce((a, r) => a + r.playoffProbability, 0);
    const playIn = inConf.reduce((a, r) => a + r.playInProbability, 0);
    assert.ok(Math.abs(playoffs - 8) < 1e-9, `${conf} playoff berths: ${playoffs}`);
    assert.ok(Math.abs(playIn - 4) < 1e-9, `${conf} play-in spots: ${playIn}`);
  }
});

test('every game produces exactly one winner and totals stay on scale', () => {
  const teams = makeLeague({ played: 0 });
  const games = makeSchedule(teams);
  const rows = simulateSeason(buildRatings(teams), games, {
    iterations: 120,
    seasonLength: 58,
    rand: mulberry32(31),
  });
  const totalWins = rows.reduce((a, r) => a + r.projectedWins, 0);
  assert.ok(Math.abs(totalWins - games.length) < 1e-6, `${totalWins} wins for ${games.length} games`);
  for (const r of rows) {
    assert.ok(Math.abs(r.projectedWins + r.projectedLosses - 58) < 1e-6);
  }
});

test('NBA Cup placeholder games are added to the win total', () => {
  const teams = makeLeague({ played: 0 });
  const withoutFill = simulateSeason(buildRatings(teams), [], {
    iterations: 200, rand: mulberry32(4),
  });
  const shortfall = Object.fromEntries(teams.map((t) => [t.id, 2]));
  const withFill = simulateSeason(buildRatings(teams), [], {
    iterations: 200, gamesShortfall: shortfall, rand: mulberry32(4),
  });
  const before = withoutFill.reduce((a, r) => a + r.projectedWins, 0);
  const after = withFill.reduce((a, r) => a + r.projectedWins, 0);
  assert.ok(Math.abs(after - before - 30) < 1.5, `expected ~30 extra wins, got ${after - before}`);
});

test('a stronger team never projects fewer wins than a weaker one', () => {
  const teams = makeLeague({ played: 0 });
  const rows = simulateSeason(buildRatings(teams), makeSchedule(teams), {
    iterations: 600,
    rand: mulberry32(77),
  });
  const best = rows.find((r) => r.abbreviation === 'T30');
  const worst = rows.find((r) => r.abbreviation === 'T1');
  assert.ok(best.projectedWins > worst.projectedWins + 15, `${best.projectedWins} vs ${worst.projectedWins}`);
  assert.ok(best.playoffProbability > worst.playoffProbability);
});
