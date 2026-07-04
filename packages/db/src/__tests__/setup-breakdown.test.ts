import { describe, it, expect } from 'vitest';
import { computeSetupStats } from '../queries.js';

describe('computeSetupStats', () => {
  it('empty window → nulls and zero counts', () => {
    const s = computeSetupStats([]);
    expect(s.n).toBe(0);
    expect(s.totalPnlUsd).toBe(0);
    expect(s.winRate).toBeNull();
    expect(s.profitFactor).toBeNull();
    expect(s.expectancyUsd).toBeNull();
  });

  it('mixed wins and losses: aggregates match hand computation', () => {
    // wins: 10, 20, 30 (gross 60); losses: -15, -5 (gross 20)
    const s = computeSetupStats([10, -15, 20, -5, 30]);
    expect(s.n).toBe(5);
    expect(s.totalPnlUsd).toBe(40);
    expect(s.winRate).toBeCloseTo(3 / 5, 6);
    expect(s.avgWinUsd).toBeCloseTo(20, 6);
    expect(s.avgLossUsd).toBeCloseTo(-10, 6);
    expect(s.profitFactor).toBeCloseTo(3, 6);
    expect(s.expectancyUsd).toBeCloseTo(8, 6);
  });

  it('all wins → Infinity profit factor', () => {
    const s = computeSetupStats([5, 10]);
    expect(s.profitFactor).toBe(Infinity);
  });

  it('all losses → profit factor 0', () => {
    const s = computeSetupStats([-5, -10]);
    expect(s.profitFactor).toBe(0);
    expect(s.winRate).toBe(0);
  });

  it('breakeven trades count toward n but neither wins nor losses', () => {
    const s = computeSetupStats([0, 10, -10]);
    expect(s.n).toBe(3);
    expect(s.winRate).toBeCloseTo(1 / 3, 6);
    expect(s.profitFactor).toBeCloseTo(1, 6);
  });
});
