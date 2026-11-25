# pump-fun-sharpe-lucy-20261126

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/hellolucyheart/pump-fun-sharpe-lucy-20261126/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/hellolucyheart/pump-fun-sharpe-lucy-20261126/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

**Sharpe Sniper** — a paper-trading bot for make.fun's Pump.fun Sharpe Sprint.
It trades paper money on a 6-hour replay of recorded pump.fun bonding-curve
activity. Places go by hourly Sharpe ratio, so steady, controlled gains beat
one lucky moonshot. Nothing is traded for real.

## How it trades

Small stakes on many coins, fast exits, tight risk control:

- **Entry** — every coin is watched from its CreateEvent. In its first two
  slots the bot reads the opening tape: how big the creator's own buy was
  (at most 2 SOL), how many other wallets piled in with it (at most 3 — a
  launch bundled by many wallets is usually the creator's cluster waiting
  to dump), whether the creator has already sold, and how much real SOL
  the curve holds (0.3–25 SOL), with the run-up since creation inside
  0.98–1.40x. Only launches that pass that rug filter get one small stake
  (0.80% of capital, capped at 90% of 1% of real reserves — the margin
  keeps the order inside the size cap when reserves shrink in the 2-slot
  latency), and only when the stake is at least 0.012 SOL, so the fixed tx
  fee never eats the trade.
- **Exits** — take profit at +18%, stop loss at −9%, a 7% trailing stop
  once up 9%, an 8-slot time limit, a stale exit after 90 slots without a
  trade, and an immediate exit when the creator sells while the bot holds.
- **Guardrail pacing** — the 20-coin guardrail is met by the sniper
  entries themselves. A tiny probe (0.012 SOL, one at a time) opens only
  when the run is genuinely behind pace — the pace target is back-loaded
  over the 6-hour window, so probes stay quiet while launches arrive in
  bursts and only step in late if the guardrail is at risk.
- **Safety** — new entries stop if total equity falls under 80% of starting
  capital (the guardrail allows 50% drawdown; the bot never gets close,
  with at most 5 positions of 0.80% each and a −9% stop on each).

## Run it

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout: a
`hello` line, one `batch` per slot window, one reply per batch echoing its
`seq` with the `orders` for that slot. It is deterministic by construction
— no clock, no randomness, no environment, no network, no model calls —
so two runs on the same replay produce the same action log. Standard
library only, zero dependencies.

## Grade it locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=68wvraae&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
