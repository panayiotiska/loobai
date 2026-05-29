# FORMULA

> Loob's evolving strategy document. The agent rewrites this every research run.
> Version 0 — seed.

## Current thesis
None yet. First run will establish one.

## Active hypotheses
*(Each hypothesis: statement, confidence 0-1, supporting evidence, falsification criteria)*

## Open paper positions
None.

## Watchlist
*(MUST cover ≥3 tiers. Update every run. Seed entries — replace with real candidates ASAP.)*
- **Major crypto:** BTC — anchor for regime read
- **Mid-cap crypto:** SOL — funding/OI most informative on a non-BTC liquid name
- **Low-cap rotation candidate:** *(rotate weekly from scan_low_cap_movers; rank 50-250)*
- **Polymarket:** *(rotate weekly from scan_polymarket_trending; pick highest-volume <30d market)*
- **Anti-pattern flag:** *(any instrument flagged by detect_manipulation_signals ≥0.6 — observe, do not trade)*

## Research queue
- Each run: scan_low_cap_movers + scan_polymarket_trending + get_funding_extremes(tier="extended")
- Identify ≥1 scout-eligible setup per run (0.55+ conf, ≥1 signal) OR articulate the missing observation
- Watch for cross-tier confirmation (e.g. crypto risk-off + PM election odds aligning)

## Blockers
None yet.

## Lessons learned
*(Append-only. Every closed losing trade or falsified hypothesis adds an entry.)*

## Changelog
- v0: seed document.
