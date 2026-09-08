/**
 * Real ESPN final standings for 2025-26, captured 7 Sep 2026. Used to check the
 * model against actual Kalshi prices without needing network access in tests.
 */
export const STANDINGS_2026 = `
BOS,2,E,Atlantic,56,26,9418,8787
PHI,20,E,Atlantic,45,37,9502,9517
TOR,28,E,Atlantic,46,36,9400,9168
NY,18,E,Atlantic,53,29,9549,9030
BKN,17,E,Atlantic,20,62,8686,9505
DET,8,E,Central,60,22,9657,8988
CLE,5,E,Central,52,30,9800,9464
IND,11,E,Central,19,63,9219,9874
CHI,4,E,Central,31,51,9537,9964
MIL,15,E,Central,32,50,9072,9581
ATL,1,E,Southeast,46,36,9714,9516
ORL,19,E,Southeast,45,37,9491,9439
MIA,14,E,Southeast,43,39,9911,9720
CHA,30,E,Southeast,44,38,9513,9117
WSH,27,E,Southeast,17,65,9258,10240
POR,22,W,Northwest,42,40,9469,9493
MIN,16,W,Northwest,49,33,9676,9401
DEN,7,W,Northwest,54,28,10010,9587
UTAH,26,W,Northwest,22,60,9641,10333
OKC,25,W,Northwest,64,18,9760,8846
LAL,13,W,Pacific,53,29,9540,9395
PHX,21,W,Pacific,45,37,9232,9112
GS,9,W,Pacific,37,45,9398,9444
LAC,12,W,Pacific,42,40,9329,9236
SAC,23,W,Pacific,22,60,9102,9922
SA,24,W,Southwest,62,20,9826,9145
HOU,10,W,Southwest,52,30,9449,9021
MEM,29,W,Southwest,25,57,9403,9896
NO,3,W,Southwest,26,56,9473,9842
DAL,6,W,Southwest,26,56,9358,9810
`.trim();

/** Live Kalshi KXNBAPLAYOFF-27 quotes, captured the same day. suffix,bid,ask */
export const KALSHI_PLAYOFF_27 = `
CLE,0.80,0.81
MIL,0.07,0.11
SAC,0.05,0.08
NYK,0.86,0.94
PHI,0.83,0.91
ATL,0.58,0.60
NOP,0.16,0.20
CHA,0.34,0.38
WAS,0.26,0.31
BKN,0.05,0.07
GSW,0.47,0.51
HOU,0.76,0.80
TOR,0.70,0.71
MEM,0.13,0.16
BOS,0.81,0.86
SAS,0.95,0.99
DEN,0.81,0.87
LAC,0.19,0.23
IND,0.63,0.67
ORL,0.56,0.59
MIA,0.70,0.71
POR,0.59,0.60
MIN,0.86,0.90
DAL,0.31,0.35
PHX,0.51,0.53
LAL,0.76,0.77
OKC,0.96,0.99
UTA,0.42,0.44
DET,0.81,0.82
CHI,0.09,0.13
`.trim();

const NAMES = {
  BOS: 'Boston Celtics', PHI: 'Philadelphia 76ers', TOR: 'Toronto Raptors', NY: 'New York Knicks',
  BKN: 'Brooklyn Nets', DET: 'Detroit Pistons', CLE: 'Cleveland Cavaliers', IND: 'Indiana Pacers',
  CHI: 'Chicago Bulls', MIL: 'Milwaukee Bucks', ATL: 'Atlanta Hawks', ORL: 'Orlando Magic',
  MIA: 'Miami Heat', CHA: 'Charlotte Hornets', WSH: 'Washington Wizards', POR: 'Portland Trail Blazers',
  MIN: 'Minnesota Timberwolves', DEN: 'Denver Nuggets', UTAH: 'Utah Jazz', OKC: 'Oklahoma City Thunder',
  LAL: 'Los Angeles Lakers', PHX: 'Phoenix Suns', GS: 'Golden State Warriors', LAC: 'LA Clippers',
  SAC: 'Sacramento Kings', SA: 'San Antonio Spurs', HOU: 'Houston Rockets', MEM: 'Memphis Grizzlies',
  NO: 'New Orleans Pelicans', DAL: 'Dallas Mavericks',
};

export function parseStandings(text = STANDINGS_2026) {
  return text.split('\n').map((line) => {
    const [abbreviation, id, conf, division, wins, losses, pointsFor, pointsAgainst] = line.split(',');
    return {
      id,
      abbreviation,
      name: NAMES[abbreviation],
      conference: conf === 'E' ? 'Eastern Conference' : 'Western Conference',
      division,
      wins: Number(wins),
      losses: Number(losses),
      pointsFor: Number(pointsFor),
      pointsAgainst: Number(pointsAgainst),
    };
  });
}

export function parseKalshi(text = KALSHI_PLAYOFF_27) {
  return text.split('\n').map((line) => {
    const [suffix, bid, ask] = line.split(',');
    return {
      ticker: `KXNBAPLAYOFF-27-${suffix}`,
      suffix,
      label: suffix,
      status: 'active',
      bid: Number(bid),
      ask: Number(ask),
      mid: (Number(bid) + Number(ask)) / 2,
      spread: Number(ask) - Number(bid),
      openInterest: 0,
      volume: 0,
    };
  });
}

/** A balanced double round-robin stands in for the real 82-game schedule. */
export function balancedSchedule(teams) {
  const games = [];
  for (const a of teams) {
    for (const b of teams) if (a.id !== b.id) games.push({ homeId: a.id, awayId: b.id });
  }
  return games;
}
