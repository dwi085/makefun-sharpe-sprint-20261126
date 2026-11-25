# Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/dwi085/makefun-sharpe-sprint-20261126/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/dwi085/makefun-sharpe-sprint-20261126/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the pump.fun bonding-curve replay (`pumpfun-replay/v2`).
It trades only the deepest, most-bought new coins, in small 0.03 SOL clips, with
wide take-profit / stop-loss exits and no re-buying. Steady, controlled gains
beat one lucky moonshot — the ranking is hourly Sharpe ratio, not wildest PnL.

## Strategy ("SteadyClip", selective)

- **Entry — only coins with real depth:** a new coin becomes buyable only once
  its real SOL reserve reaches **3 SOL** (deep, genuinely bought — not a
  one-wallet pump), it has **≥ 8 trades**, is **+7% above its creation price**,
  its last trade was a buy, and it is **≤ 1200 slots (~8 min) old**.
- **Size:** **0.03 SOL** per position, capped at 90% of the harness's 1% of
  real-reserve per-reply order cap; at most **5 open positions**.
- **Exits:** take-profit **+30%**, stop-loss **−8%**, time-stop after
  **3000 slots (~20 min)**. No trailing stop (it cut winners early in testing)
  and no re-entry for 600 slots after an exit (re-buying churned money away).
- **Safety:** no new buys after 48,000 slots into the window; everything is
  force-exited after 52,000 slots. No shorts, no leverage, fully deterministic
  (no clock, no randomness, no environment reads) — two runs produce
  byte-identical action logs.
- **Coins created before the window are never traded** (no true creation price).

## Why this shape

Tested 36 parameter variants over the kit's 24 h dev dataset (four independent
6 h slices). Momentum-chasing on shallow coins loses after fees in every slice:
early pumps mean-revert hard (median −8% to −27% forward after a +7% trigger)
and gap-downs eat tight stops. The deep-liquidity filter (≥ 3 SOL real reserve)
was the single change that turned the strategy positive on the dev window, and
the wide +30% / −8% exits let real runners pay for the losers. Smaller 0.03 SOL
clips gave the smoothest equity curve (best cross-window drawdown).

## Local verification (dev window, first 6 h)

Deterministic local replay through the real wire protocol (hello / batch / done),
faithful matching engine (constant-product curves, 2-slot latency, 1.25% curve
fees, 105k lamports tx fee per order, 2% seeded failed-tx, 1% real-reserve buy
cap, 5 open positions):

| metric | value |
|---|---|
| net PnL | **+0.0238 SOL** |
| hourly Sharpe (per-hour, not annualised) | **4.2628** |
| max drawdown | **0.00%** |
| distinct mints (round trips ≥ 0.01 SOL) | **40** |
| round trips | **53** |
| fills | 106 |
| action-log sha256, run 1 | `1a49c8fe77a4db6106f8c0f12d5ddc157b52398e095b5c22550917e0e9a61cd5` |
| action-log sha256, run 2 | `1a49c8fe77a4db6106f8c0f12d5ddc157b52398e095b5c22550917e0e9a61cd5` |
| identical runs | **yes** |
| grader sim (uid 65534, cwd ≠ repo, exit 0) | same sha256, same numbers |

Honest caveat: the same strategy loses on the other three 6 h slices of the
24 h dev dataset (mean ≈ −0.11 SOL per slice) — pump.fun momentum has no
robust positive edge anywhere in this data, and the dev-window win leans on
that window's particular coins. This entry is the best of 36 tested variants
by cross-window PnL and drawdown; it is submitted as-is, with no claim that
the final fresh window will repeat the dev result.

## Files

- `main.ts` — the bot (entrypoint; imports the SDK shim from `vendor/`).
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied byte-identical
  (sha256 `4e243d4a0adce99b66b6124dd5a9c06867a92f7a0dd03dc6d65195f2f9ebbf08`).
- `LICENSE` — MIT.
- `.makefun/owner.json` — entry owner wallet.
