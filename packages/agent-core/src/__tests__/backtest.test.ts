import { describe, it, expect } from 'vitest';
import { backtestBreakout, ROUND_TRIP_COST_PCT } from '../backtest.js';
import type { OHLCCandle } from '../tools/market-data.js';

const candle = (i: number, close: number, volume = 100, spread = 0.5): OHLCCandle => ({
  openTime: i * 86_400_000,
  open: close,
  high: close + spread,
  low: close - spread,
  close,
  volume,
});

/** 70 flat candles, then a volume-backed breakout that runs, then a reversal. */
function breakoutSeries(): OHLCCandle[] {
  const c: OHLCCandle[] = [];
  for (let i = 0; i < 70; i++) c.push(candle(i, 100));
  for (let i = 0; i < 12; i++) c.push(candle(70 + i, 110 + i * 3, i === 0 ? 300 : 100)); // trend up
  for (let i = 0; i < 10; i++) c.push(candle(82 + i, 140 - i * 6)); // collapse
  return c;
}

describe('backtestBreakout', () => {
  it('takes a volume-confirmed breakout and exits on the trailing stop', () => {
    const { trades, summary } = backtestBreakout('TEST', breakoutSeries());
    expect(trades.length).toBeGreaterThan(0);
    const t = trades[0];
    expect(t.side).toBe('long');
    expect(t.reason).toBe('trailing_stop');
    expect(t.pnlPct).toBeGreaterThan(10);
    expect(summary.trades).toBe(trades.length);
  });

  it('ignores a breakout without volume confirmation', () => {
    const s = breakoutSeries().map((c, i) => (i === 70 ? { ...c, volume: 100 } : c));
    expect(backtestBreakout('TEST', s).trades.length).toBe(0);
  });

  it('charges the round-trip cost', () => {
    const { trades } = backtestBreakout('TEST', breakoutSeries());
    const t = trades[0];
    const gross = (t.exit / t.entry - 1) * 100;
    expect(t.pnlPct).toBeCloseTo(gross - ROUND_TRIP_COST_PCT);
  });

  it('reports insufficient evidence under 8 trades', () => {
    expect(backtestBreakout('TEST', breakoutSeries()).summary.verdict).toBe('insufficient');
  });

  it('flat market → no trades, null stats', () => {
    const flat = Array.from({ length: 120 }, (_, i) => candle(i, 100));
    const { summary } = backtestBreakout('FLAT', flat);
    expect(summary.trades).toBe(0);
    expect(summary.winRate).toBeNull();
  });
});
