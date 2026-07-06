// v3: S3 trend-breakout signal, computed entirely in code.
//
// The LLM is small (Gemma 4 26B MoE, 4B active) — it cannot be trusted with
// donchian/ATR/vol arithmetic. This tool does all the math and returns a
// structured verdict; the same function backs both the agent-visible tool and
// the server-side S3 entry validation, so what the model sees and what code
// enforces cannot diverge.

import type { Result } from '@loob/shared';
import { ok, err } from '@loob/shared';
import type { OHLCCandle } from './market-data.js';
import { getCryptoOHLC } from './market-data.js';

export type BreakoutState =
  | 'breakout_up_20'
  | 'breakout_up_55'
  | 'breakout_down_20'
  | 'breakout_down_55'
  | 'none';

export interface TrendSignal {
  symbol: string;
  close: number;
  donchian20High: number;
  donchian20Low: number;
  donchian55High: number;
  donchian55Low: number;
  /** Close vs the PRIOR-N extreme (current candle excluded). 55 takes precedence over 20. */
  breakoutState: BreakoutState;
  atr14: number;
  atrPct: number;
  realizedVol20dAnnPct: number;
  /** Latest candle volume vs 20d average volume. */
  volumeRatio20d: number;
  ma20: number;
  ma50: number;
  maAlignment: 'bullish' | 'bearish' | 'mixed';
  /** ATR-based trailing stop suggestion for exit_criteria.trailing_stop_pct. */
  suggestedTrailingStopPct: number;
}

export const S3_MIN_CANDLES = 56;
export const S3_MIN_VOLUME_RATIO = 1.25;

export function computeTrendSignal(symbol: string, candles: OHLCCandle[]): Result<TrendSignal> {
  if (candles.length < S3_MIN_CANDLES) {
    return err(
      `need ≥${S3_MIN_CANDLES} daily candles for ${symbol}, got ${candles.length} — instrument too new or OHLC unavailable`,
    );
  }

  const last = candles[candles.length - 1];
  const close = last.close;
  // Prior-N extremes exclude the current candle so "breakout" means the close
  // exceeded what came before it, not itself.
  const prior = candles.slice(0, -1);
  const prior20 = prior.slice(-20);
  const prior55 = prior.slice(-55);
  const donchian20High = Math.max(...prior20.map((c) => c.high));
  const donchian20Low = Math.min(...prior20.map((c) => c.low));
  const donchian55High = Math.max(...prior55.map((c) => c.high));
  const donchian55Low = Math.min(...prior55.map((c) => c.low));

  let breakoutState: BreakoutState = 'none';
  if (close > donchian55High) breakoutState = 'breakout_up_55';
  else if (close > donchian20High) breakoutState = 'breakout_up_20';
  else if (close < donchian55Low) breakoutState = 'breakout_down_55';
  else if (close < donchian20Low) breakoutState = 'breakout_down_20';

  // ATR(14) — simple average of true ranges over the last 14 candles.
  const trs: number[] = [];
  for (let i = candles.length - 14; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  const atr14 = trs.reduce((s, x) => s + x, 0) / trs.length;
  const atrPct = close > 0 ? (atr14 / close) * 100 : 0;

  // Realized vol: stdev of last 20 daily log returns, annualized.
  const rets: number[] = [];
  for (let i = candles.length - 20; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    if (prev > 0 && candles[i].close > 0) rets.push(Math.log(candles[i].close / prev));
  }
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length;
  const realizedVol20dAnnPct = Math.sqrt(variance) * Math.sqrt(365) * 100;

  const vol20 = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
  const volumeRatio20d = vol20 > 0 ? last.volume / vol20 : 0;

  const closes = candles.map((c) => c.close);
  const ma20 = closes.slice(-20).reduce((s, x) => s + x, 0) / 20;
  const ma50 = closes.slice(-50).reduce((s, x) => s + x, 0) / 50;
  const maAlignment: TrendSignal['maAlignment'] =
    close > ma20 && ma20 > ma50 ? 'bullish' : close < ma20 && ma20 < ma50 ? 'bearish' : 'mixed';

  // 2.5×ATR trailing distance, floored at 1.5% — the tick cadence is 2–4h, so
  // tighter trails would be dominated by sampling noise rather than the trend.
  const suggestedTrailingStopPct = Math.max(1.5, Math.round(2.5 * atrPct * 10) / 10);

  return ok({
    symbol,
    close,
    donchian20High,
    donchian20Low,
    donchian55High,
    donchian55Low,
    breakoutState,
    atr14,
    atrPct,
    realizedVol20dAnnPct,
    volumeRatio20d,
    ma20,
    ma50,
    maAlignment,
    suggestedTrailingStopPct,
  });
}

export async function getTrendSignal(symbol: string): Promise<Result<TrendSignal>> {
  const ohlc = await getCryptoOHLC(symbol, '1d', 72);
  if (!ohlc.ok) {
    // Binance answers 400 for unknown symbols — common for low-caps surfaced
    // by scan_low_cap_movers. Tell the model plainly so it moves on.
    if (/400/.test(ohlc.error)) {
      return err(
        `${symbol.toUpperCase()} has no Binance USDT market — S3/get_trend_signal is unavailable for this instrument. ` +
          `Do not retry; low-caps from scan_low_cap_movers are often unlisted. If you still want exposure it can only be D_discretionary.`,
      );
    }
    return err(`could not fetch daily OHLC for ${symbol}: ${ohlc.error}`);
  }
  // Binance returns the current, still-forming daily candle last. Evaluating
  // it live makes the volume ratio meaningless (partial volume) — daily
  // breakout signals are judged on the last CLOSED candle.
  const closed = ohlc.data.candles.slice(0, -1);
  return computeTrendSignal(symbol.toUpperCase(), closed);
}
