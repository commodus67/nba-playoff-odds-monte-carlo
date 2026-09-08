/**
 * Kalshi market data and value-bet arithmetic.
 *
 * Kalshi's public read API needs no key. Prices arrive as decimal strings in
 * `yes_bid_dollars` / `yes_ask_dollars`; note that size fields on this endpoint
 * are `open_interest_fp` and `volume_fp`, not the bare names older code expects.
 */

const KALSHI_BASE = 'https://external-api.kalshi.com/trade-api/v2';

/* ------------------------------------------------------------------ names -- */

/**
 * Strip a team name down to something comparable. Note that this deletes a few
 * filler words, which is exactly why the alias table below must be normalised
 * through this same function before anything is looked up in it -- comparing a
 * hand-written alias against an already-normalised name is a bug that shipped
 * once already in this family of Actors.
 */
export function normalizeName(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|club|fc|cf|sc|ac)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Kalshi writes the two Los Angeles teams as "Los Angeles C" and "Los Angeles L",
 * which no name-based matcher should be asked to disambiguate. Abbreviations are
 * the reliable path; these are the six where ESPN and Kalshi disagree.
 */
export const ESPN_TO_KALSHI_ABBR = {
  NY: 'NYK',
  WSH: 'WAS',
  UTAH: 'UTA',
  GS: 'GSW',
  SA: 'SAS',
  NO: 'NOP',
};

/** Fallback only: Kalshi's short label -> the ESPN display name. */
const ALIASES = {
  'New York Knicks': ['New York'],
  'Washington Wizards': ['Washington'],
  'Utah Jazz': ['Utah'],
  'Golden State Warriors': ['Golden State'],
  'San Antonio Spurs': ['San Antonio'],
  'New Orleans Pelicans': ['New Orleans'],
  'LA Clippers': ['Los Angeles C', 'LA Clippers', 'Clippers'],
  'Los Angeles Lakers': ['Los Angeles L', 'LA Lakers', 'Lakers'],
  'Portland Trail Blazers': ['Portland'],
  'Oklahoma City Thunder': ['Oklahoma City'],
};

const NORMALIZED_ALIASES = new Map(
  Object.entries(ALIASES).map(([canonical, list]) => [normalizeName(canonical), list.map(normalizeName)]),
);

/* ------------------------------------------------------------------ fetch -- */

/* ESPN rejects requests without a browser-shaped user agent. */
const USER_AGENT = 'Mozilla/5.0 (compatible; ApifyActor/1.0; +https://apify.com)';

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Kalshi ${res.status} for ${url}`);
  return res.json();
}

const toNumber = (value) => {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * All markets in one Kalshi event, normalised to a common shape.
 * `mid` is the bid/ask midpoint, which is what we compare the model against;
 * `ask` is what an entry would actually cost.
 */
export async function fetchKalshiEvent(eventTicker, { limit = 200 } = {}) {
  const data = await getJson(`${KALSHI_BASE}/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=${limit}`);
  const markets = Array.isArray(data?.markets) ? data.markets : [];
  return markets.map((m) => {
    const bid = toNumber(m.yes_bid_dollars) ?? (toNumber(m.yes_bid) !== null ? toNumber(m.yes_bid) / 100 : null);
    const ask = toNumber(m.yes_ask_dollars) ?? (toNumber(m.yes_ask) !== null ? toNumber(m.yes_ask) / 100 : null);
    const mid = bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask);
    return {
      ticker: m.ticker,
      suffix: String(m.ticker ?? '').split('-').pop(),
      label: m.yes_sub_title || m.title || '',
      status: m.status,
      bid,
      ask,
      mid,
      spread: bid !== null && ask !== null ? ask - bid : null,
      openInterest: toNumber(m.open_interest_fp) ?? toNumber(m.open_interest) ?? 0,
      volume: toNumber(m.volume_fp) ?? toNumber(m.volume) ?? 0,
    };
  });
}

/** Sum of midpoints. For a market with N winners this should sit near N. */
export function marketIntegrity(outcomes, targetSum) {
  const sum = outcomes.reduce((a, o) => a + (o.mid ?? 0), 0);
  return {
    sum: Number(sum.toFixed(4)),
    targetSum,
    // A wide bid/ask inflates the midpoint sum; 12% is loose enough for an
    // October book and tight enough to catch a market we have misread.
    ok: targetSum ? Math.abs(sum - targetSum) / targetSum <= 0.12 : null,
  };
}

/* ---------------------------------------------------------------- matching -- */

/** Match one model row to one Kalshi contract: abbreviation first, name second. */
export function matchOutcome(row, outcomes) {
  const wanted = ESPN_TO_KALSHI_ABBR[row.abbreviation] ?? row.abbreviation;
  const byAbbr = outcomes.find((o) => o.suffix?.toUpperCase() === String(wanted).toUpperCase());
  if (byAbbr) return byAbbr;

  const target = normalizeName(row.name);
  const aliases = NORMALIZED_ALIASES.get(target) ?? [];
  const byAlias = outcomes.find((o) => {
    const label = normalizeName(o.label);
    return label === target || aliases.includes(label);
  });
  if (byAlias) return byAlias;

  for (const [canonical, list] of NORMALIZED_ALIASES) {
    if (canonical !== target) continue;
    const hit = outcomes.find((o) => list.includes(normalizeName(o.label)));
    if (hit) return hit;
  }
  return null;
}

/* -------------------------------------------------------------------- fees -- */

/**
 * Kalshi's fee is a parabola: rate x P x (1-P) per contract, charged to the
 * taker, then rounded up to the cent per order. 0.07 is the taker rate; a maker
 * pays roughly a quarter of that. Assuming taker is deliberate and conservative.
 */
export function feePerContract(price, rate = 0.07) {
  const p = Math.min(Math.max(price, 0), 1);
  return rate * p * (1 - p);
}

export function orderFee(price, contracts, rate = 0.07) {
  const raw = feePerContract(price, rate) * contracts;
  return Math.ceil(Number(raw.toFixed(10)) * 100) / 100;
}

/* ------------------------------------------------------------- value bets -- */

/**
 * Compare one model probability against one contract, on both sides.
 *
 * Buying YES at the ask costs `ask` and returns 1. Buying NO costs `1 - bid`
 * and returns 1 if the event does not happen. Both sides are priced and the
 * better expected value wins, which is how a contract that is cheap to fade
 * still shows up as an opportunity.
 */
export function evaluateContract(modelProbability, outcome, { feeRate = 0.07 } = {}) {
  const p = Math.min(Math.max(modelProbability, 0), 1);
  const sides = [];

  if (outcome.ask !== null && outcome.ask > 0 && outcome.ask < 1) {
    const cost = outcome.ask;
    const fee = feePerContract(cost, feeRate);
    sides.push({
      side: 'YES',
      price: cost,
      winProbability: p,
      edge: p - cost,
      expectedValue: p * (1 - cost) - (1 - p) * cost - fee,
    });
  }
  if (outcome.bid !== null && outcome.bid > 0 && outcome.bid < 1) {
    const cost = 1 - outcome.bid;
    const q = 1 - p;
    const fee = feePerContract(cost, feeRate);
    sides.push({
      side: 'NO',
      price: cost,
      winProbability: q,
      edge: q - cost,
      expectedValue: q * (1 - cost) - (1 - q) * cost - fee,
    });
  }
  if (!sides.length) return null;
  return sides.sort((a, b) => b.expectedValue - a.expectedValue)[0];
}

/** Fractional Kelly on a binary contract priced in [0,1]. */
export function kellyFraction(winProbability, price, fraction = 0.25) {
  if (!(price > 0) || !(price < 1)) return 0;
  const b = (1 - price) / price;
  const q = 1 - winProbability;
  const full = (b * winProbability - q) / b;
  return Math.max(0, full * fraction);
}

/**
 * Build the ranked list of opportunities for one market.
 *
 * `allowValue` is the honesty gate. In preseason the model knows only how last
 * season ended, so every large "edge" it reports is really the offseason -- free
 * agency, trades, a rookie class -- that the market has priced and the model has
 * not seen. When the gate is shut the edge is still reported in full, but no row
 * is allowed to call itself VALUE and no position is ever sized.
 */
export function buildValueBets(rows, outcomes, options = {}) {
  const {
    probabilityKey = 'playoffProbability',
    edgeThreshold = 0.05,
    feeRate = 0.07,
    kellyMultiplier = 0.25,
    bankroll = 0,
    maxPerPositionPct = 5,
    maxTotalExposurePct = 25,
    allowValue = true,
    marketLabel = '',
  } = options;

  const used = new Set();
  const evaluated = [];

  for (const row of rows) {
    const outcome = matchOutcome(row, outcomes);
    if (!outcome) {
      evaluated.push({ row, outcome: null, best: null });
      continue;
    }
    used.add(outcome.ticker);
    const best = evaluateContract(row[probabilityKey] ?? 0, outcome, { feeRate });
    evaluated.push({ row, outcome, best });
  }

  const unmatched = outcomes.filter((o) => !used.has(o.ticker)).map((o) => o.ticker);

  const ranked = evaluated
    .filter((e) => e.best)
    .sort((a, b) => b.best.edge - a.best.edge);

  let remainingExposure = bankroll * (maxTotalExposurePct / 100);
  const perPositionCap = bankroll * (maxPerPositionPct / 100);

  const results = ranked.map((e) => {
    const { row, outcome, best } = e;
    const qualifies = best.edge >= edgeThreshold && best.expectedValue > 0;
    const call = !allowValue ? 'WATCH' : qualifies ? 'VALUE' : 'PASS';

    let stake = 0;
    let contracts = 0;
    let fee = 0;
    if (call === 'VALUE' && bankroll > 0) {
      const kelly = kellyFraction(best.winProbability, best.price, kellyMultiplier);
      stake = Math.min(bankroll * kelly, perPositionCap, remainingExposure);
      if (stake > 0) {
        contracts = Math.floor(stake / best.price);
        stake = Number((contracts * best.price).toFixed(2));
        fee = orderFee(best.price, contracts, feeRate);
        remainingExposure -= stake;
      }
    }

    return {
      market: marketLabel,
      teamId: String(row.id),
      teamAbbreviation: row.abbreviation,
      ticker: outcome.ticker,
      contractLabel: outcome.label,
      side: best.side,
      marketPrice: Number(best.price.toFixed(4)),
      marketMid: outcome.mid === null ? null : Number(outcome.mid.toFixed(4)),
      bidAskSpread: outcome.spread === null ? null : Number(outcome.spread.toFixed(4)),
      openInterest: outcome.openInterest,
      volume: outcome.volume,
      modelProbability: Number((row[probabilityKey] ?? 0).toFixed(4)),
      sideWinProbability: Number(best.winProbability.toFixed(4)),
      edge: Number(best.edge.toFixed(4)),
      expectedValuePerContract: Number(best.expectedValue.toFixed(4)),
      call,
      suggestedContracts: contracts,
      suggestedStake: stake,
      estimatedFee: fee,
    };
  });

  return {
    bets: results,
    unmatched,
    matched: results.length,
    outcomesListed: outcomes.length,
  };
}
