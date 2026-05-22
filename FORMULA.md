# FORMULA — v1 (adversarial rewrite seed)

> Loob's evolving strategy document. The agent rewrites this every research run
> when a position closes or evidence warrants. Append-only Lessons section.

## Current market regime
**uncertain** — no regime asserted yet (v1 seed). First run will call
`assess_market_regime()` and replace this section with regime + evidence.

## Active theses

### T-001 — "We have no edge yet"
- **Statement**: After 7 days of v1 trading, the agent has not identified a single setup with a positive expectancy supported by ≥3 paper trades.
- **Confidence**: 1.0 (this is observed)
- **Supporting evidence**: Portfolio stats — 40% win rate over 5 closed trades; biggest loss exceeds 4 of 5 wins; 0 formula iterations in v1.
- **Falsification trigger**: 3 paper trades on the same instrument + setup, all in the same regime, with consistent positive PnL after fees and slippage. Until then, every trade is a research probe, not a strategy.
- **Expiry**: open until 20 v2 runs have completed.

## Open paper positions
*(Mirrored from the database — the runner injects current open trades into the prompt every tick.)*

## Watchlist
*(Instruments + the specific observation that would push them into the trade zone.)*

- **SOL** — watching for funding-extreme + orderbook asymmetry confluence.
- **Polymarket** — watching for high-volume markets resolving in 7-21 days with stable orderbook depth (>$5k each side) AND a thesis we can articulate without leaning on news.

## Crowding map
*(Current view on where retail/institutions are positioned across our universe.)*

- Not yet established. First few research runs should call `get_funding_extremes()` and `get_long_short_ratio()` to seed this section.

## Recent lessons
*(Append-only. Each entry references a closed trade UUID and the structured postmortem.)*

- *(none yet — v1 closed 5 trades without recording postmortems. v2 wipes the slate.)*

## Anti-pattern log
*(Patterns where we've been demonstrably wrong. Future trades that look like these get extra scrutiny.)*

- *(none yet)*

## Goal of v2 seed phase
For the next 20 research runs, do not optimize for win rate. Optimize for **lesson density**: every closed trade must produce a structured postmortem that future runs read via `read_lessons_learned()`. Goal: build a regime classifier and identify 2-3 setups where the adversarial view is consistently weak.

## Changelog
- **v1** (v2-rewrite seed): replaces empty v0 seed. Adds adversarial framework, regime section, anti-pattern log, crowding map, structured lesson references. Reason: v1 of the agent never updated FORMULA across 7 days; v2 requires a non-empty starting point to evolve from.
