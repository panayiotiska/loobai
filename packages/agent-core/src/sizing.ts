// v3: deterministic, evidence-based sizing ladder.
//
// Replaces the formula's self-imposed "t-stat ≥ 2.0 before scaling" gate,
// which mathematically required hundreds of trades and froze the system at
// $100 positions forever (and, after the June 30 formula wipe, let it drift
// down to $25 dust trades below the ~30bps cost floor).
//
// Each setup earns size from its own realized results over its most recent
// closed-trade window. The agent proposes a size; code clamps it. Pure
// functions — unit-tested, no I/O.

import type { SetupStats } from '@loob/db';

export interface SizingTier {
  tier: 1 | 2 | 3 | 4;
  baseUsd: 100 | 250 | 500 | 1000;
  reason: string;
}

/** Trades smaller than this are noise after 20bps fees + 10bps slippage. */
export const MIN_TRADE_USD = 100;

const fmt = (x: number | null | undefined, digits = 2): string =>
  x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(digits);

/**
 * Highest tier whose condition holds, computed over the setup's last-30
 * closed-trade window:
 *   tier 4 ($1000): n ≥ 30 and profit factor ≥ 1.5
 *   tier 3 ($500):  n ≥ 20 and profit factor ≥ 1.3
 *   tier 2 ($250):  n ≥ 10 and expectancy > 0
 *   tier 1 ($100):  default
 */
export function sizingTierForSetup(s: SetupStats): SizingTier {
  const pf = s.profitFactor ?? 0;
  const exp = s.expectancyUsd ?? 0;
  const stats = `n=${s.n}, expectancy $${fmt(s.expectancyUsd)}/trade, profit factor ${fmt(s.profitFactor)}`;
  if (s.n >= 30 && pf >= 1.5) {
    return { tier: 4, baseUsd: 1000, reason: `tier 4 ($1000): ${stats}` };
  }
  if (s.n >= 20 && pf >= 1.3) {
    return { tier: 3, baseUsd: 500, reason: `tier 3 ($500): ${stats} — tier 4 ($1000) at n≥30 & PF≥1.5` };
  }
  if (s.n >= 10 && exp > 0) {
    return { tier: 2, baseUsd: 250, reason: `tier 2 ($250): ${stats} — tier 3 ($500) at n≥20 & PF≥1.3` };
  }
  return { tier: 1, baseUsd: 100, reason: `tier 1 ($100): ${stats} — tier 2 ($250) at n≥10 & expectancy>0` };
}

/**
 * Confidence ≥ 0.65 (conviction band) unlocks the full tier base; the scout
 * band (0.55–0.65) gets half, floored at the $100 minimum. The ladder keys
 * off realized results — inflating confidence does not unlock size beyond
 * the tier base.
 */
export function maxAllowedSize(baseUsd: number, confidence: number): number {
  return confidence >= 0.65 ? baseUsd : Math.max(MIN_TRADE_USD, baseUsd / 2);
}
