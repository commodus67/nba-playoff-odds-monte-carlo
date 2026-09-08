import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName,
  matchOutcome,
  feePerContract,
  orderFee,
  kellyFraction,
  evaluateContract,
  marketIntegrity,
  buildValueBets,
  ESPN_TO_KALSHI_ABBR,
} from '../src/marketOdds.js';
import { parseStandings, parseKalshi } from './fixtures/standings2026.js';

const TEAMS = parseStandings();
const OUTCOMES = parseKalshi();

test('every one of the 30 ESPN teams matches a real Kalshi contract', () => {
  const missed = TEAMS.filter((t) => !matchOutcome(t, OUTCOMES));
  assert.deepEqual(missed.map((t) => t.abbreviation), []);
  const tickers = new Set(TEAMS.map((t) => matchOutcome(t, OUTCOMES).ticker));
  assert.equal(tickers.size, 30, 'two teams were matched to the same contract');
});

test('the six abbreviations that differ are mapped, and only those', () => {
  assert.deepEqual(
    Object.keys(ESPN_TO_KALSHI_ABBR).sort(),
    ['GS', 'NO', 'NY', 'SA', 'UTAH', 'WSH'],
  );
  for (const t of TEAMS) {
    const suffix = matchOutcome(t, OUTCOMES).suffix;
    const expected = ESPN_TO_KALSHI_ABBR[t.abbreviation] ?? t.abbreviation;
    assert.equal(suffix, expected, `${t.abbreviation} matched ${suffix}`);
  }
});

test('the two Los Angeles teams are not confused with each other', () => {
  const lac = TEAMS.find((t) => t.abbreviation === 'LAC');
  const lal = TEAMS.find((t) => t.abbreviation === 'LAL');
  assert.equal(matchOutcome(lac, OUTCOMES).suffix, 'LAC');
  assert.equal(matchOutcome(lal, OUTCOMES).suffix, 'LAL');
});

test('the alias table is compared in normalised space, not raw', () => {
  // normalizeName deletes filler words; an alias table searched raw would never
  // match entries containing them. This is the bug that shipped once in the NHL
  // Actor, so it gets a test of its own.
  assert.equal(normalizeName('Utah Hockey Club'), 'utah hockey');
  assert.equal(normalizeName('LA Clippers'), 'la clippers');
  assert.equal(normalizeName('  St. Louis  '), 'st louis');
});

test('live playoff market prices sum close to the 16 berths on offer', () => {
  const integrity = marketIntegrity(OUTCOMES, 16);
  assert.equal(integrity.ok, true, `sum ${integrity.sum}`);
  assert.ok(integrity.sum > 16 && integrity.sum < 18, `sum ${integrity.sum}`);
});

test('a market we have misread fails the integrity check', () => {
  assert.equal(marketIntegrity(OUTCOMES, 4).ok, false, 'playoff prices must not pass as a play-in market');
});

test('Kalshi fees follow the parabola and round up per order', () => {
  assert.ok(Math.abs(feePerContract(0.5) - 0.0175) < 1e-12);
  assert.ok(feePerContract(0.99) < feePerContract(0.5));
  assert.equal(feePerContract(0), 0);
  assert.equal(orderFee(0.5, 100), 1.75);
  assert.equal(orderFee(0.5, 1), 0.02, 'a single contract still rounds up to a cent');
});

test('Kelly is zero without an edge and grows with one', () => {
  assert.equal(kellyFraction(0.5, 0.5), 0);
  assert.equal(kellyFraction(0.4, 0.5), 0, 'a losing bet is never sized');
  assert.ok(kellyFraction(0.7, 0.5, 0.25) > kellyFraction(0.6, 0.5, 0.25));
});

test('both sides of a contract are priced and the better one wins', () => {
  const contract = { bid: 0.60, ask: 0.65, mid: 0.625 };
  const fade = evaluateContract(0.20, contract);
  assert.equal(fade.side, 'NO', 'a contract this overpriced should be faded');
  assert.ok(fade.edge > 0);
  const back = evaluateContract(0.95, contract);
  assert.equal(back.side, 'YES');
});

test('the honesty gate downgrades every call without hiding the edge', () => {
  const rows = TEAMS.map((t, i) => ({ ...t, playoffProbability: i / 30 }));
  const open = buildValueBets(rows, OUTCOMES, { bankroll: 10000, allowValue: true });
  const shut = buildValueBets(rows, OUTCOMES, { bankroll: 10000, allowValue: false });

  assert.ok(open.bets.some((b) => b.call === 'VALUE'), 'the gate open should allow some VALUE calls');
  assert.ok(shut.bets.every((b) => b.call === 'WATCH'), 'the gate shut must silence every VALUE call');
  assert.ok(shut.bets.every((b) => b.suggestedStake === 0), 'nothing is sized while the gate is shut');
  // The edge itself is still reported, unchanged.
  for (let i = 0; i < open.bets.length; i += 1) {
    assert.equal(open.bets[i].edge, shut.bets[i].edge);
  }
});

test('position sizing respects the per-position and total exposure caps', () => {
  const rows = TEAMS.map((t) => ({ ...t, playoffProbability: 0.99 }));
  const res = buildValueBets(rows, OUTCOMES, {
    bankroll: 10000, allowValue: true, maxPerPositionPct: 5, maxTotalExposurePct: 25,
  });
  const staked = res.bets.filter((b) => b.suggestedStake > 0);
  assert.ok(staked.length > 0);
  for (const b of staked) assert.ok(b.suggestedStake <= 500 + 1e-9, `${b.ticker} staked ${b.suggestedStake}`);
  const total = staked.reduce((a, b) => a + b.suggestedStake, 0);
  assert.ok(total <= 2500 + 1e-9, `total exposure ${total}`);
});

test('a contract with no matching team is reported, not silently dropped', () => {
  const res = buildValueBets(TEAMS.slice(0, 5).map((t) => ({ ...t, playoffProbability: 0.5 })), OUTCOMES, {});
  assert.equal(res.matched, 5);
  assert.equal(res.unmatched.length, 25);
});
