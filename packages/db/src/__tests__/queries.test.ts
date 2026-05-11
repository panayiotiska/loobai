import { describe, it, expect } from 'vitest';
import { getPortfolioStats } from '../queries.js';

interface FakeRow {
  size_usd: number;
  pnl_usd: number | null;
  status: 'open' | 'closed' | 'cancelled';
  closed_at: string | null;
  opened_at: string;
}

function fakeDb(rows: FakeRow[]) {
  // Mimics: db.from('trades').select(...).order(...) → { data, error }
  const orderable = {
    order: async () => ({ data: rows, error: null }),
  };
  return {
    from: () => ({
      select: () => orderable,
    }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function days(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe('getPortfolioStats', () => {
  it('handles empty trades', async () => {
    const stats = await getPortfolioStats(fakeDb([]));
    expect(stats.openCount).toBe(0);
    expect(stats.closedCount).toBe(0);
    expect(stats.realizedPnlUsd).toBe(0);
    expect(stats.openExposureUsd).toBe(0);
    expect(stats.winRate).toBeNull();
    expect(stats.pnlCurve).toEqual([]);
  });

  it('sums open exposure correctly', async () => {
    const stats = await getPortfolioStats(
      fakeDb([
        { size_usd: 500, pnl_usd: 10, status: 'open', closed_at: null, opened_at: days(1) },
        { size_usd: 300, pnl_usd: null, status: 'open', closed_at: null, opened_at: days(2) },
      ]),
    );
    expect(stats.openCount).toBe(2);
    expect(stats.openExposureUsd).toBe(800);
    expect(stats.openUnrealizedPnlUsd).toBe(10);
  });

  it('computes win rate and totals on closed trades', async () => {
    const stats = await getPortfolioStats(
      fakeDb([
        { size_usd: 100, pnl_usd: 20, status: 'closed', closed_at: days(5), opened_at: days(6) },
        { size_usd: 100, pnl_usd: -10, status: 'closed', closed_at: days(4), opened_at: days(5) },
        { size_usd: 100, pnl_usd: 30, status: 'closed', closed_at: days(3), opened_at: days(4) },
      ]),
    );
    expect(stats.closedCount).toBe(3);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.winRate).toBeCloseTo(2 / 3);
    expect(stats.realizedPnlUsd).toBe(40);
    expect(stats.biggestWinUsd).toBe(30);
    expect(stats.biggestLossUsd).toBe(-10);
  });

  it('30-day window excludes older closes', async () => {
    const stats = await getPortfolioStats(
      fakeDb([
        { size_usd: 100, pnl_usd: 50, status: 'closed', closed_at: days(45), opened_at: days(46) },
        { size_usd: 100, pnl_usd: 20, status: 'closed', closed_at: days(10), opened_at: days(11) },
      ]),
    );
    expect(stats.realizedPnlUsd).toBe(70);
    expect(stats.realizedPnlLast30dUsd).toBe(20);
  });

  it('produces cumulative pnlCurve in close order', async () => {
    const stats = await getPortfolioStats(
      fakeDb([
        { size_usd: 100, pnl_usd: 10, status: 'closed', closed_at: days(5), opened_at: days(6) },
        { size_usd: 100, pnl_usd: -3, status: 'closed', closed_at: days(4), opened_at: days(5) },
        { size_usd: 100, pnl_usd: 7, status: 'closed', closed_at: days(3), opened_at: days(4) },
      ]),
    );
    expect(stats.pnlCurve.map((p) => p.cumulativePnlUsd)).toEqual([10, 7, 14]);
  });

  it('handles mixed open/closed/cancelled rows', async () => {
    const stats = await getPortfolioStats(
      fakeDb([
        { size_usd: 500, pnl_usd: null, status: 'open', closed_at: null, opened_at: days(1) },
        { size_usd: 100, pnl_usd: 25, status: 'closed', closed_at: days(2), opened_at: days(3) },
        { size_usd: 200, pnl_usd: null, status: 'cancelled', closed_at: null, opened_at: days(3) },
      ]),
    );
    expect(stats.openCount).toBe(1);
    expect(stats.closedCount).toBe(1);
    expect(stats.openExposureUsd).toBe(500);
    expect(stats.realizedPnlUsd).toBe(25);
  });

  it('skips closed rows missing pnl_usd or closed_at', async () => {
    const stats = await getPortfolioStats(
      fakeDb([
        { size_usd: 100, pnl_usd: null, status: 'closed', closed_at: days(1), opened_at: days(2) },
        { size_usd: 100, pnl_usd: 10, status: 'closed', closed_at: null, opened_at: days(2) },
        { size_usd: 100, pnl_usd: 50, status: 'closed', closed_at: days(1), opened_at: days(2) },
      ]),
    );
    expect(stats.closedCount).toBe(1);
    expect(stats.realizedPnlUsd).toBe(50);
  });
});
