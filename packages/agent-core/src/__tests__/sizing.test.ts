import { describe, it, expect } from 'vitest';
import { sizingTierForSetup, maxAllowedSize, MIN_TRADE_USD } from '../sizing.js';
import type { SetupStats } from '@loob/db';

function stats(overrides: Partial<SetupStats>): SetupStats {
  return {
    n: 0,
    totalPnlUsd: 0,
    winRate: null,
    avgWinUsd: null,
    avgLossUsd: null,
    profitFactor: null,
    expectancyUsd: null,
    ...overrides,
  };
}

describe('sizingTierForSetup', () => {
  it('empty window → tier 1 ($100)', () => {
    expect(sizingTierForSetup(stats({})).baseUsd).toBe(100);
  });

  it('n boundary for tier 2: 9 stays tier 1, 10 unlocks $250', () => {
    expect(sizingTierForSetup(stats({ n: 9, expectancyUsd: 5, profitFactor: 2 })).baseUsd).toBe(100);
    expect(sizingTierForSetup(stats({ n: 10, expectancyUsd: 5, profitFactor: 1.1 })).baseUsd).toBe(250);
  });

  it('tier 2 requires positive expectancy', () => {
    expect(sizingTierForSetup(stats({ n: 15, expectancyUsd: 0, profitFactor: 1.0 })).baseUsd).toBe(100);
    expect(sizingTierForSetup(stats({ n: 15, expectancyUsd: -1, profitFactor: 0.8 })).baseUsd).toBe(100);
  });

  it('tier 3 boundaries: n 19/20 and PF 1.29/1.3', () => {
    expect(sizingTierForSetup(stats({ n: 19, expectancyUsd: 5, profitFactor: 1.5 })).baseUsd).toBe(250);
    expect(sizingTierForSetup(stats({ n: 20, expectancyUsd: 5, profitFactor: 1.29 })).baseUsd).toBe(250);
    expect(sizingTierForSetup(stats({ n: 20, expectancyUsd: 5, profitFactor: 1.3 })).baseUsd).toBe(500);
  });

  it('tier 4 boundaries: n 29/30 and PF 1.49/1.5', () => {
    expect(sizingTierForSetup(stats({ n: 29, expectancyUsd: 5, profitFactor: 2.0 })).baseUsd).toBe(500);
    expect(sizingTierForSetup(stats({ n: 30, expectancyUsd: 5, profitFactor: 1.49 })).baseUsd).toBe(500);
    expect(sizingTierForSetup(stats({ n: 30, expectancyUsd: 5, profitFactor: 1.5 })).baseUsd).toBe(1000);
  });

  it('Infinity profit factor (no losses) qualifies for upper tiers', () => {
    expect(sizingTierForSetup(stats({ n: 30, expectancyUsd: 5, profitFactor: Infinity })).baseUsd).toBe(1000);
  });

  it('reason names the current tier and the next unlock', () => {
    const t = sizingTierForSetup(stats({ n: 12, expectancyUsd: 2.5, profitFactor: 1.2 }));
    expect(t.tier).toBe(2);
    expect(t.reason).toMatch(/tier 2/);
    expect(t.reason).toMatch(/tier 3/);
  });
});

describe('maxAllowedSize', () => {
  it('conviction band (≥0.65) unlocks the full base', () => {
    expect(maxAllowedSize(1000, 0.65)).toBe(1000);
    expect(maxAllowedSize(250, 0.9)).toBe(250);
  });

  it('scout band gets half, floored at $100', () => {
    expect(maxAllowedSize(1000, 0.64)).toBe(500);
    expect(maxAllowedSize(250, 0.55)).toBe(125);
    expect(maxAllowedSize(100, 0.55)).toBe(MIN_TRADE_USD);
  });
});
