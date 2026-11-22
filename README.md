# Token Radar v2

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/arrahman13/token-radar-01-v2/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/arrahman13/token-radar-01-v2/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Entry for the make.fun bounty [Token Radar](https://make.fun/bounty/token-radar-01): a pre-token launch radar over the sealed DefiLlama snapshot of 2026-11-14 (758 protocols, 40 on the watchlist).

## What it does

`main.ts` reads `/input/snapshot.json` and writes `/output/board.json`, the dashboard, the screenshots and `/output/dossier.json` (built with the kit's own `vendor/makefun-board.ts`, copied unchanged). The board ranks **198 protocols that record no token** — all 40 watchlist protocols plus 158 early finds — and accounts for all 758: 198 ranked · 416 already record a token · 144 excluded by group (bridge 43, liquid staking/restaking 43, exchange products 42, versioned 11, wrapped/staked by name 5).

## The model

Implied value = TVL × fitted multiple × fitted launch odds.

- **Multiple** — ridge regression of log(market cap ÷ TVL) on a log-TVL size curve plus category-group effects, fitted on 87 traded peers with a priced market cap. Terms are admitted only if they lower **both** held-out misses: size and category group survived (leave-one-out miss ×3.05, walk-forward ×3.08, vs ×4.88 for a flat median multiple); 7-day growth and no-token age were tested and rejected, and the page shows the rejected rows.
- **Odds** — logistic fit on 613 protocols with a known listing date (Brier 0.172 vs 0.218 for the base rate), with an age-band calibration table printed beside it.
- **Ranges** — every row prints a P25–P75 band from the model's leave-one-out residuals; the page reports the bands' real coverage on the peers (49% inside P25–P75, 79% inside P10–P90).
- **When** — each row estimates months to a token as the median remaining wait of comparable peers that did record one.
- **Farm verdicts** — a stated scenario (plan size, 5% of launch value to farmers, competing farm capital at 10% of TVL, chain-priced fees) turns every row into expected net $ and $/hour: FARM, MARGINAL or SKIP. Each row carries 3–12 concrete, costed farm steps generated from its category and chains.

## What the leaders do not have

- **Basket builder** — set a total budget and hours per week; the page greedily assembles the best $/hour plans into one basket with totals.
- **When estimate per row** and a **category/chain rollup** of where the board's implied value concentrates.
- **Integrity by recompute** — the dashboard embeds the snapshot and the same `model.js` the program ran, rebuilds the board in the browser, and prints the checksum next to board.json's. Screenshots and code cannot drift apart.

## Run it

```sh
node main.ts --input /input/snapshot.json   # writes /output (or $MAKEFUN_OUTPUT_DIR)
```

Node 22, standard library only. Two runs produce byte-identical outputs.

## Layout

- `main.ts` — the program: board, dashboard data, dossier.
- `lib/model.js` — the model, written once; `dashboard/model.js` is the same file for the browser recompute.
- `dashboard/` — the page (index.html, app.css, app.js, model.js, zz-snapshot-data.js).
- `screenshots/` — the board, a protocol detail, and the watchlist filter, rendered from the built page at 1440×1000.
- `vendor/makefun-board.ts` — the kit's dossier library, unchanged.
