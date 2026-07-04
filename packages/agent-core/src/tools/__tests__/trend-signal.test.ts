import { describe, it, expect } from 'vitest';
import type { OHLCCandle } from '../market-data.js';
import { computeTrendSignal, S3_MIN_CANDLES } from '../trend.js';

/** Flat synthetic series: close=100, high=101, low=99, volume=1000. */
function flatCandles(n: number): OHLCCandle[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: i,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
  }));
}

describe('computeTrendSignal', () => {
  it('errors below the minimum candle count', () => {
    const r = computeTrendSignal('NEW', flatCandles(S3_MIN_CANDLES - 1));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/56/);
  });

  it('flat series → no breakout, mixed alignment, volume ratio 1', () => {
    const r = computeTrendSignal('BTC', flatCandles(70));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.breakoutState).toBe('none');
    expect(r.data.donchian20High).toBe(101);
    expect(r.data.donchian20Low).toBe(99);
    expect(r.data.volumeRatio20d).toBeCloseTo(1, 6);
    expect(r.data.ma20).toBeCloseTo(100, 6);
    expect(r.data.realizedVol20dAnnPct).toBeCloseTo(0, 6);
  });

  it('detects a 20d upside breakout with volume, excluding the current candle', () => {
    const candles = flatCandles(70);
    // Higher high 30 candles back: inside the 55-window, outside the 20-window,
    // so the close clears the 20d channel but not the 55d one.
    candles[40] = { ...candles[40], high: 104 };
    candles[69] = { openTime: 69, open: 100, high: 103, low: 100, close: 102.5, volume: 2000 };
    const r = computeTrendSignal('BTC', candles);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.breakoutState).toBe('breakout_up_20');
    expect(r.data.donchian20High).toBe(101); // prior extreme, current candle excluded
    expect(r.data.donchian55High).toBe(104);
    expect(r.data.volumeRatio20d).toBeCloseTo(2, 6);
  });

  it('labels a 55d breakout when the close clears the wider channel too', () => {
    const candles = flatCandles(70);
    // Put a higher high 30 candles back (inside 55-window, outside 20-window).
    candles[40] = { ...candles[40], high: 105 };
    candles[69] = { openTime: 69, open: 100, high: 107, low: 100, close: 106, volume: 3000 };
    const r = computeTrendSignal('BTC', candles);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.donchian55High).toBe(105);
    expect(r.data.breakoutState).toBe('breakout_up_55');
  });

  it('detects downside breakouts', () => {
    const candles = flatCandles(70);
    candles[69] = { openTime: 69, open: 100, high: 100, low: 96, close: 97, volume: 2500 };
    const r = computeTrendSignal('BTC', candles);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(['breakout_down_20', 'breakout_down_55']).toContain(r.data.breakoutState);
  });

  it('ATR matches hand computation on the flat series', () => {
    const r = computeTrendSignal('BTC', flatCandles(70));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // TR each candle = max(101−99, |101−100|, |99−100|) = 2 → ATR 2, atrPct 2%.
    expect(r.data.atr14).toBeCloseTo(2, 6);
    expect(r.data.atrPct).toBeCloseTo(2, 6);
    // suggested trail = max(1.5, 2.5 × 2) = 5
    expect(r.data.suggestedTrailingStopPct).toBeCloseTo(5, 6);
  });

  it('floors the suggested trailing stop at 1.5%', () => {
    const candles = flatCandles(70).map((c) => ({ ...c, high: 100.1, low: 99.9 }));
    const r = computeTrendSignal('BTC', candles);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.suggestedTrailingStopPct).toBe(1.5);
  });
});
