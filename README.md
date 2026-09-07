# NBA Playoff Odds API — Monte Carlo Simulator & Value Bets

Replays every remaining NBA game thousands of times and returns, for all 30 teams, the
probability of making the playoffs, of falling into the play-in tournament, of winning a
division, a conference and the title — then prices each of those against live **Kalshi**
contracts and reports the edge, the expected value net of fees, and a suggested position
size.

Sports data, simulation, statistics, prediction markets, betting odds, basketball.

---

## The one thing to get right about the NBA

In baseball, football and hockey, "make the playoffs" is a single threshold and Kalshi
lists a single market. Basketball is different, and it is the most common way to get this
wrong:

| Finish in your conference | What it means | Kalshi market |
| --- | --- | --- |
| 1st – 6th | In the playoffs, no questions asked | `KXNBAPLAYOFF-27` |
| 7th – 10th | Into the **play-in tournament**, where only two of the four survive | `KXNBAPLAYIN-27EAST` / `KXNBAPLAYIN-27WEST` |
| 11th – 15th | Season over | — |

Kalshi says it in the contract rules: *"Qualifying for the play-in tournament doesn't
constitute playoff qualification."*

So the play-in market is not a weaker version of the playoff market — it is a **band**, and
the two are almost disjoint. The best team in a conference is a near lock for the playoffs
and a near-zero for the play-in. A 45-win team is the reverse. That is why this Actor
simulates the play-in games themselves (7 v 8 for the seventh seed; the loser then hosts
the winner of 9 v 10 for the eighth) instead of guessing, and why it reports
`fairPlayoffProbability` and `fairPlayInProbability` as two separate columns that are
compared against two separate markets.

## What it does

1. Pulls current standings from ESPN, including points scored and allowed.
2. Rates every team from its point differential — Pythagorean expectation with the
   basketball exponent of 13.91 — blended with its actual record and regressed toward a
   prior built from last season.
3. Simulates each remaining game from the ESPN schedule with home court applied in
   log-odds, redrawing every team's true strength once per simulated season so the output
   is a distribution rather than a single confident guess.
4. Seeds each conference, runs the play-in, then runs the full four-round bracket with
   best-of-seven series and the 2-2-1-1-1 home court pattern.
5. Fetches live Kalshi prices, matches every team to its contract, and computes edge,
   expected value net of fees, and a quarter-Kelly stake capped per position and in total.

## Output

One row per team. Highlights:

| Field | Meaning |
| --- | --- |
| `projectedWins` | Mean win total across all simulations |
| `averageSeed` | Mean finishing seed within the conference |
| `fairPlayoffProbability` | Reaches the playoffs — top six, or survives the play-in |
| `fairTopSixProbability` | Avoids the play-in entirely |
| `fairPlayInProbability` | Finishes 7th to 10th |
| `fairDivisionProbability` | Wins its division |
| `fairConferenceProbability` | Reaches the Finals |
| `fairChampionshipProbability` | Wins the title |
| `marketPrice`, `edge`, `expectedValuePerContract` | The contract and what it is worth |
| `call` | `VALUE`, `PASS` or `WATCH` |
| `suggestedContracts`, `suggestedStake` | Quarter-Kelly sizing, if a bankroll is set |

Four dataset views are provided: **Playoff overview**, **Market edge**, **Play-in race**
and **Title odds**.

## Preseason honesty

Before opening night this model knows exactly one thing: how last season ended. It has not
seen free agency, the draft, a trade, or an injury. Its largest disagreements with the
market are therefore not edges — they are the summer.

Two safeguards make that explicit rather than leaving you to discover it:

- **`minGamesPlayedForValue`** (default 10). Until every team has played that many games,
  no row may call itself `VALUE`. The edge is still reported in full; every row is simply
  labelled `WATCH`.
- **`strengthUncertainty`** (default 0.22). Each simulated season redraws every team's
  rating. Set it to zero and the Actor will happily tell you a team makes the playoffs 100%
  of the time, which is never true in September.

Run against real Kalshi prices in September 2026 the model's rank correlation with the
market was about 0.80, with a mean absolute difference of 13 points. The largest gaps were
teams whose entire case rests on the offseason — exactly what the gate is there for.

## Notes on the data

- ESPN names a season by the year it **ends**: 2026-27 is `season=2027`.
- Before opening night ESPN publishes the new division tree with no teams in it. The Actor
  falls back to last season for the club list and the conference map, with records zeroed.
- ESPN lists **80 of the 82** games until the NBA Cup is decided. The missing games are
  simulated against an average opponent so win totals stay on an 82-game scale rather than
  quietly projecting an 80-game season.
- Kalshi's public read API needs no key. Prices come from `yes_bid_dollars` /
  `yes_ask_dollars`; both sides of every contract are priced and the better one is used, so
  an overpriced favourite shows up as a chance to sell rather than as no signal at all.

## Related Actors

Same engine, other leagues: **MLB Playoff Odds**, **NFL Playoff Odds**, **NHL Playoff
Odds**, **Football (Soccer) Monte Carlo Predictor**, and the **Sports Probabilities MCP
Server** that exposes all of them to AI agents.

## Disclaimer

Statistical simulation for research and analysis. Not betting advice, and not affiliated
with the NBA, ESPN or Kalshi.
