// Baseline backtester for the S3 trend-breakout setup.
//
// Replays the SAME entry rule the server enforces (donchian breakout on the
// prior-N extreme + volume ≥ 1.25× the 20d average) over historical daily
// candles, with the same ATR-based trailing stop and the paper-trade cost
// model. Pure and deterministic. It is a sanity check — daily bars, one
// symbol, no survivorship correction — not proof of edge.
//
// S1/S2 depend on funding history that the free APIs don't serve, so they
// are not backtestable here; the realized-results ladder covers them.

import type { OHLCCandle } from './tools/market-data.js';
import { S3_MIN_VOLUME_RATIO } from './tools/trend.js';

/** Round-trip cost: 2×10bps fee + 2×5bps slippage (matches paper-trade defaults). */
export const ROUND_TRIP_COST_PCT = 0.30;
const MAX_HOLD_DAYS = 30;

export interface BacktestTrade {
  side: 'long' | 'short';
  entryIdx: number;
  exitIdx: number;
  entry: number;
  exit: number;
  pnlPct: number;
  reason: 'trailing_stop' | 'time_limit' | 'end_of_data';
}

export interface BacktestSummary {
  symbol: string;
  candles: number;
  lookback: 20 | 55;
  trades: number;
  winRate: number | null;
  expectancyPct: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number;
  avgHoldDays: number | null;
  /** 'insufficient' under 8 trades — too few to say anything. */
  verdict: 'supportive' | 'unsupportive' | 'insufficient';
  caveat: string;
}

function atrPctAt(c: OHLCCandle[], i: number): number {
  let sum = 0;
  for (let k = i - 13; k <= i; k++) {
    const prev = c[k - 1].close;
    sum += Math.max(c[k].high - c[k].low, Math.abs(c[k].high - prev), Math.abs(c[k].low - prev));
  }
  return c[i].close > 0 ? (sum / 14 / c[i].close) * 100 : 0;
}

export function backtestBreakout(
  symbol: string,
  candles: OHLCCandle[],
  lookback: 20 | 55 = 20,
): { summary: BacktestSummary; trades: BacktestTrade[] } {
  const trades: BacktestTrade[] = [];
  const start = Math.max(55, lookback + 1);
  let i = start;

  while (i < candles.length - 1) {
    const c = candles[i];
    const prior = candles.slice(i - lookback, i);
    const hi = Math.max(...prior.map((x) => x.high));
    const lo = Math.min(...prior.map((x) => x.low));
    const vol20 = candles.slice(i - 20, i).reduce((s, x) => s + x.volume, 0) / 20;
    const volOk = vol20 > 0 && c.volume / vol20 >= S3_MIN_VOLUME_RATIO;
    const side: 'long' | 'short' | null = !volOk ? null : c.close > hi ? 'long' : c.close < lo ? 'short' : null;
    if (!side) {
      i++;
      continue;
    }

    const stopPct = Math.max(1.5, Math.round(2.5 * atrPctAt(candles, i) * 10) / 10);
    const entry = c.close;
    let best = entry;
    let exitIdx = candles.length - 1;
    let exit = candles[exitIdx].close;
    let reason: BacktestTrade['reason'] = 'end_of_data';

    for (let j = i + 1; j < candles.length; j++) {
      const d = candles[j];
      const stopLevel = side === 'long' ? best * (1 - stopPct / 100) : best * (1 + stopPct / 100);
      const hit = side === 'long' ? d.low <= stopLevel : d.high >= stopLevel;
      if (hit) {
        // Gap through the stop fills at the open, not at the stop.
        exit = side === 'long' ? Math.min(stopLevel, d.open) : Math.max(stopLevel, d.open);
        exitIdx = j;
        reason = 'trailing_stop';
        break;
      }
      best = side === 'long' ? Math.max(best, d.high) : Math.min(best, d.low);
      if (j - i >= MAX_HOLD_DAYS) {
        exit = d.close;
        exitIdx = j;
        reason = 'time_limit';
        break;
      }
    }

    const gross = side === 'long' ? (exit / entry - 1) * 100 : (entry / exit - 1) * 100;
    trades.push({ side, entryIdx: i, exitIdx, entry, exit, pnlPct: gross - ROUND_TRIP_COST_PCT, reason });
    i = exitIdx + 1; // no overlapping positions
  }

  const pnls = trades.map((t) => t.pnlPct);
  const n = pnls.length;
  const wins = pnls.filter((p) => p > 0);
  const grossWin = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(pnls.filter((p) => p < 0).reduce((s, p) => s + p, 0));
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const p of pnls) {
    equity *= 1 + p / 100;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (1 - equity / peak) * 100);
  }
  const expectancyPct = n ? pnls.reduce((s, p) => s + p, 0) / n : null;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : null;
  const verdict: BacktestSummary['verdict'] =
    n < 8 ? 'insufficient' : expectancyPct! > 0 && (profitFactor ?? 0) >= 1.2 ? 'supportive' : 'unsupportive';

  return {
    trades,
    summary: {
      symbol,
      candles: candles.length,
      lookback,
      trades: n,
      winRate: n ? wins.length / n : null,
      expectancyPct,
      profitFactor,
      maxDrawdownPct: maxDd,
      avgHoldDays: n ? trades.reduce((s, t) => s + (t.exitIdx - t.entryIdx), 0) / n : null,
      verdict,
      caveat:
        'Daily bars, one symbol, in-sample, cost model 0.30% round trip. Advisory only: a supportive verdict is weak evidence, an unsupportive one is a real warning.',
    },
  };
}
