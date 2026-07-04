# Loob's Trading Strategy — v3 reset

## How to edit this document (read before every update)
This document is the strategy's only long-term memory. Every new version must be the COMPLETE document: preserve the "## Setups", "## Hypotheses", "## Anti-pattern log", and "## Recent lessons" sections and edit incrementally. A validation guard in the runner now REJECTS versions that are short, missing those sections, or >40% smaller than the previous version.

## Postmortem: the v117 wipe (2026-06-30)
A research run emitted `newFormula: "..."` — three characters — and it was persisted as v117, destroying the accumulated strategy: the S1 setup spec, hypotheses H66/H67/H69, the anti-pattern log, and ~47 lessons. Versions v118–v122 were rebuilt from nothing and degraded into generic "watching for volatility breakouts" text with no connection to measured results; position sizes drifted to $25 (below the fee floor). Root cause: no content validation on formula writes plus a full-rewrite output contract. Fixes are now in code (formula guard, $100 minimum size, code-enforced setups). Lesson: never emit a formula shorter than the previous version; the runner will reject it anyway.

## Mission
Discover and refine a strategy that consistently generates positive returns trading online instruments (crypto perps/spot, prediction markets) in a paper environment. Sizing, setup entry conditions, and exit mechanics are now CODE-OWNED — this document records the playbook, evidence, hypotheses, and lessons; the code enforces them.

## Setups
The canonical playbook. Every trade carries a `setup_type`; the defining condition is verified server-side at open time and rejected with a reason if it does not hold.

### S1 — funding-squeeze scout (`S1_funding_squeeze`)
- **Entry (code-verified)**: long crypto with annualized funding ≤ −30%, plus ≥1 independent microstructure confirm (orderbook bid-skew, short-liquidation clusters above mark, capitulation wicks with absorption).
- **Regime**: fear. It fires rarely — when funding is only −10/−15% there is NO S1 trade (that churn bled fees for all of late June 2026).
- **Evidence**: June 4–10, 2026 extreme-fear cluster: +$26.64 over 13 scouts, 62% win rate (HOME +$41.19, SEI +$17.11, INJ +$15.78, WLD +$10.10). Both large losses were discipline violations, not setup failures (see AP-2).
- **Exit**: trailing stop 1.5–2.5%. On a funding flip to positive, the code auto-tightens the stop to breakeven (one-way ratchet) — the trade stays open and the price leg keeps running risk-free. This supersedes the old H66 "immediate close on flip," which realized +$2 wins on squeezes that ran to +$40.

### S2 — carry harvest (`S2_carry_harvest`)
- **Entry (code-verified)**: annualized funding ≥ +30%, side="sell". The code marks the position hedged (delta-neutral): PnL = the funding stream minus doubled fees, no price exposure.
- **Regime**: all — including euphoria and trend-up, where crowded longs overpay most. This is the income engine when S1 is dormant.
- **Basis**: the literature-verified funding strategy (hedged carry capture, documented Sharpe ~1.8 at retail fees). The paper model is optimistic (doubled fees only, no basis risk or borrow costs) — read S2 results with that caveat.
- **Exit**: code auto-closes when the carry decays below +5% annualized. Set a time_limit ~2 weeks out as a backstop; no stop_loss/take_profit (no price leg).

### S3 — trend breakout (`S3_trend_breakout`)
- **Entry (code-verified)**: `get_trend_signal(symbol)` must show breakout_up_20/55 (long) or breakout_down_20/55 (short) AND volume ≥ 1.25× the 20d average. Trend regimes only.
- **Exit**: `exit_criteria.trailing_stop_pct` seeded from the tool's suggestedTrailingStopPct (≈2.5× ATR%). Wide stop; let it run.
- **Status**: new in v3, unproven in our own sample — starts at sizing tier 1 and must earn its way up.

### D — discretionary (`D_discretionary`)
Anything that fits none of the above (Polymarket positions, news catalysts, novel ideas). Scout size only, code-enforced. If it deserves conviction size, it should fit S1/S2/S3; if it fits none, it is not yet a validated setup.

### Regime gating
- fear → S1 (primary), S2
- euphoria → S2 only, NO S1
- trend-up → S3 long, S2
- trend-down → S3 short, S2
- chop → S2 only, or skip
- uncertain → S2 or research only

### Sizing (code-owned)
Per-setup ladder from each setup's last-30 closed trades: tier 1 $100 (default) → tier 2 $250 (n≥10, expectancy>0) → tier 3 $500 (n≥20, PF≥1.3) → tier 4 $1000 (n≥30, PF≥1.5). Confidence ≥0.65 unlocks the full base; 0.55–0.65 gets half. Hard floor $100. This replaces the old "t-stat ≥ 2.0" gate, which froze the system at $100 scouts forever. Historical trades were reclassified as D_discretionary, so every setup restarts at tier 1 — the ladder is the path to size, and it is climbed with closed winners, not confidence claims.

## Hypotheses
- **H66 (revised)**: A funding flip to positive invalidates the CARRY component of an S1 trade but not the squeeze itself. Correct response: risk removal (stop to breakeven — now automatic in code), not exit. Confidence 0.8. The original "immediate close" version was confirmed as an exit signal on SOL/INJ/SUI/ATOM/SEI/TON/APT/AVAX but systematically cut winners early (realized R:R ~1.3).
- **H67**: Extreme funding anomalies in low-liquidity assets require verified orderbook/price data before entry to avoid manipulation traps. Confidence 0.7.
- **H68**: In macro-dominant fear regimes, asset-specific catalysts (news, legislation, unlocks) are dominated by liquidity flows. Confidence 0.8 (see AP-1).
- **H69**: The durable component of S1 is the carry, not the bounce. Confidence 0.6 — measurement continues via funding_accrued_usd attribution on every closed S1.
- **H70 (new)**: S2 hedged carry harvest has positive expectancy across regimes after doubled fees. Literature-supported; unproven in our sample. Confidence 0.6. Test: 10+ closed S2 trades with expectancy > 0.
- **H71 (new)**: Trailing stops raise realized reward:risk above 2.0 vs the old fixed-TP/immediate-flip-exit regime (realized ~1.3). Confidence 0.6. Test: compare avg win / avg loss over the next 20 closed S1/S3 trades.

## Anti-pattern log
- **AP-1: News-catalyst conviction longs.** 6 conviction trades on narrative theses (AVAX unlock, XRP CLARITY Act ×4) in May 2026: 33% win rate, −$9.49 net. Narrative without microstructure confirmation is not edge. News ideas start at D_discretionary scout size.
- **AP-2: Oversizing / revenge re-entry.** Both oversized scouts lost ($250 SEI → −$18.81; $200 HOME re-entry at 0.75 confidence immediately after the HOME +$41.19 win → −$25.27). A win on a ticker does NOT raise next-trade confidence on the same ticker.
- **AP-3: Treating harness errors as market information.** v71–v77 halted the strategy over "Unknown tool" errors that were a code bug. Tool errors are never trade signals.
- **AP-4: Counting correlated trades as independent evidence.** 7 concurrent long-alt scouts in one extreme-fear week validated nothing as a group. Max 3 scouts is code-enforced.
- **AP-5: Prioritizing funding over price-action invalidation.** Both matter; the invalidation_signal at entry is the contract.
- **AP-6: Marginal-funding churn.** Late June 2026: repeated "squeeze scouts" at −13/−15% annualized funding (rule says ≤ −30%) produced ±$0.30 trades that fees ate. Now code-rejected at open.
- **AP-7: Formula truncation.** The v117 wipe (see postmortem). Now code-rejected.
- **AP-8: Dust sizing.** $25 trades after the wipe — below the ~30bps cost floor by construction. $100 minimum now code-enforced.
- **AP-9: Cutting winners without invalidation.** Discretionary closes of profitable trades whose invalidation had not fired (the +$2 exits). Never close a winner unless its stated invalidation_signal fired.

## Recent lessons
Lessons are append-only; per-trade postmortems live in the trades table and are surfaced by `read_lessons_learned`. Key carried lessons:
- **L-2026-06-30 (the wipe)**: strategy memory is the most valuable asset this system has; it is now guarded in code.
- **L-2026-06 (churn month)**: when the market offers no setup, the correct position size is zero — not a smaller bad trade. Fees are the only guaranteed edge, and it belongs to the exchange.
- **L-2026-06-10 (measurement)**: funding carry is credited to open PnL; postmortems on S1 must split price-leg vs carry-leg attribution (H69).
- The pre-wipe lesson archive is preserved verbatim in the appendix below (recovered v116).

## Watchlist
- Perps with annualized funding ≤ −30% (S1 triggers) — none at the moment of this reset.
- Perps with annualized funding ≥ +30% (S2 triggers) — scan every research run via `get_funding_extremes`.
- BTC/ETH/SOL vs prior 20d/55d extremes on ≥1.25× volume (S3 triggers) — check via `get_trend_signal`.
- Polymarket top-volume markets resolving <30d (D candidates, scout only).

## Changelog
- v3 reset (2026-07-04): restores strategy memory destroyed by the v117 wipe; codifies the S1/S2/S3/D setup taxonomy with code-enforced entry conditions; sizing moved to the code ladder; exits moved to trailing stops + breakeven ratchet; adds H70/H71 and AP-6..AP-9.
