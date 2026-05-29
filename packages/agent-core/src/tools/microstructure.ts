import type { Result } from '@loob/shared';
import { ok, err } from '@loob/shared';
import { getCryptoOHLC } from './market-data.js';
import { getCryptoDerivatives } from './derivatives.js';

// =============================================================================
// get_funding_extremes
// =============================================================================
// Cross-symbol funding survey. Flags any crowded longs/shorts vs a configurable
// |annualized funding| threshold. Uses OKX (via getCryptoDerivatives) because
// it's geoblock-free for our deploy env.

export interface FundingExtreme {
  symbol: string;
  funding_rate_pct: number;
  funding_annualized_pct: number;
  open_interest_usd: number;
  crowded_side: 'longs' | 'shorts' | 'neutral';
  severity: 'extreme' | 'elevated' | 'normal';
}

export const MAJORS_UNIVERSE = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'AVAX', 'LINK'];
export const EXTENDED_UNIVERSE = [
  ...MAJORS_UNIVERSE,
  'SUI', 'APT', 'TIA', 'SEI', 'INJ', 'NEAR', 'OP', 'ARB',
  'HYPE', 'RNDR', 'FET', 'ATOM', 'LDO', 'JUP', 'PYTH', 'ENA',
  'ONDO', 'WLD', 'STRK', 'RON', 'TON', 'TRX', 'LTC', 'ICP',
];

export type FundingTier = 'majors' | 'extended' | 'all';

async function fetchInBatches<T, R>(items: T[], batchSize: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const res = await Promise.all(batch.map(fn));
    out.push(...res);
  }
  return out;
}

export async function getFundingExtremes(
  symbols?: string[],
  tier: FundingTier = 'extended',
): Promise<Result<FundingExtreme[]>> {
  const base = symbols && symbols.length > 0
    ? symbols
    : tier === 'majors'
      ? MAJORS_UNIVERSE
      : EXTENDED_UNIVERSE;
  const universe = base.map((s) => s.toUpperCase());
  try {
    const results = await fetchInBatches(universe, 5, (s) => getCryptoDerivatives(s));
    const out: FundingExtreme[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r.ok) continue;
      const fr = r.data.fundingRatePct;
      const ann = r.data.fundingRateAnnualizedPct;
      const absAnn = Math.abs(ann);
      const severity: FundingExtreme['severity'] =
        absAnn >= 50 ? 'extreme' : absAnn >= 20 ? 'elevated' : 'normal';
      const crowded: FundingExtreme['crowded_side'] =
        fr > 0.005 ? 'longs' : fr < -0.005 ? 'shorts' : 'neutral';
      out.push({
        symbol: universe[i],
        funding_rate_pct: fr,
        funding_annualized_pct: ann,
        open_interest_usd: r.data.openInterestUsd,
        crowded_side: crowded,
        severity,
      });
    }
    // Surface extreme/elevated first so the agent sees the actionable rows.
    out.sort((a, b) => Math.abs(b.funding_annualized_pct) - Math.abs(a.funding_annualized_pct));
    return ok(out);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// =============================================================================
// get_orderbook_imbalance
// =============================================================================
// Spot L2 snapshot from Binance public depth. Returns USD bid vs ask volume
// within ±depth_pct of mid. Highlights walls — possible spoofing or real flow.

export interface OrderbookImbalance {
  symbol: string;
  depth_pct: number;
  mid_price: number;
  bid_usd: number;
  ask_usd: number;
  imbalance_ratio: number; // bid_usd / (bid_usd + ask_usd) — 0.5 = balanced
  largest_bid_wall_usd: number;
  largest_ask_wall_usd: number;
  interpretation: string;
}

interface BinanceDepthResp {
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
}

export async function getOrderbookImbalance(
  symbol: string,
  depthPct = 1.0,
): Promise<Result<OrderbookImbalance>> {
  const pair = `${symbol.toUpperCase()}USDT`;
  try {
    const res = await fetch(`https://data-api.binance.vision/api/v3/depth?symbol=${pair}&limit=500`);
    if (!res.ok) return err(`Binance depth error: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as BinanceDepthResp;
    if (!data.bids?.length || !data.asks?.length) return err('empty orderbook');

    const bestBid = parseFloat(data.bids[0][0]);
    const bestAsk = parseFloat(data.asks[0][0]);
    const mid = (bestBid + bestAsk) / 2;
    const band = mid * (depthPct / 100);
    const lowerBound = mid - band;
    const upperBound = mid + band;

    let bidUsd = 0;
    let largestBidWall = 0;
    for (const [p, q] of data.bids) {
      const price = parseFloat(p);
      if (price < lowerBound) break;
      const usd = price * parseFloat(q);
      bidUsd += usd;
      if (usd > largestBidWall) largestBidWall = usd;
    }
    let askUsd = 0;
    let largestAskWall = 0;
    for (const [p, q] of data.asks) {
      const price = parseFloat(p);
      if (price > upperBound) break;
      const usd = price * parseFloat(q);
      askUsd += usd;
      if (usd > largestAskWall) largestAskWall = usd;
    }

    const total = bidUsd + askUsd;
    const ratio = total > 0 ? bidUsd / total : 0.5;

    let interp: string;
    if (ratio >= 0.65) interp = 'heavy bid skew — buyers stacked, possible support or bid wall';
    else if (ratio <= 0.35) interp = 'heavy ask skew — sellers stacked, possible resistance or distribution';
    else interp = 'roughly balanced';

    return ok({
      symbol: symbol.toUpperCase(),
      depth_pct: depthPct,
      mid_price: mid,
      bid_usd: bidUsd,
      ask_usd: askUsd,
      imbalance_ratio: ratio,
      largest_bid_wall_usd: largestBidWall,
      largest_ask_wall_usd: largestAskWall,
      interpretation: interp,
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// =============================================================================
// get_long_short_ratio
// =============================================================================
// Binance top-trader long/short ratio (account-based). High = retail/top traders
// crowded long. Useful crowding indicator.

export interface LongShortRatio {
  symbol: string;
  ratio: number;
  long_account_pct: number;
  short_account_pct: number;
  interpretation: string;
}

interface BinanceRatioResp {
  symbol: string;
  longShortRatio: string;
  longAccount: string;
  shortAccount: string;
  timestamp: number;
}

export async function getLongShortRatio(symbol: string): Promise<Result<LongShortRatio>> {
  const pair = `${symbol.toUpperCase()}USDT`;
  try {
    const res = await fetch(
      `https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=${pair}&period=1h&limit=1`,
    );
    if (!res.ok) return err(`Binance ratio error: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as BinanceRatioResp[];
    const row = data[0];
    if (!row) return err('no ratio data returned');
    const ratio = parseFloat(row.longShortRatio);
    const longPct = parseFloat(row.longAccount) * 100;
    const shortPct = parseFloat(row.shortAccount) * 100;
    let interp: string;
    if (ratio >= 2.5) interp = 'top-trader accounts heavily long — crowded longs, contrarian short watch';
    else if (ratio <= 0.7) interp = 'top-trader accounts heavily short — crowded shorts, short squeeze risk';
    else interp = 'top-trader positioning roughly balanced';
    return ok({
      symbol: symbol.toUpperCase(),
      ratio,
      long_account_pct: longPct,
      short_account_pct: shortPct,
      interpretation: interp,
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// =============================================================================
// get_liquidation_zones
// =============================================================================
// Cheap heuristic estimate. Combines current funding + OI to estimate which
// side is most levered, then projects probable liquidation cluster levels.
// NOT a true liq-heatmap (we don't have aggregate broker data) — but enough
// for the agent to ask "where would a stop-hunt be most profitable?"

export interface LiquidationZones {
  symbol: string;
  mark_price: number;
  funding_rate_pct: number;
  open_interest_usd: number;
  crowded_side: 'longs' | 'shorts' | 'unclear';
  // Estimated probable cluster levels for the crowded side, expressed as % moves from mark.
  probable_long_liq_pcts: number[];
  probable_short_liq_pcts: number[];
  interpretation: string;
}

export async function getLiquidationZones(symbol: string): Promise<Result<LiquidationZones>> {
  const deriv = await getCryptoDerivatives(symbol);
  if (!deriv.ok) return err(`liquidation zones: ${deriv.error}`);
  const mark = deriv.data.markPrice;
  const fr = deriv.data.fundingRatePct;
  const crowded: LiquidationZones['crowded_side'] =
    fr > 0.005 ? 'longs' : fr < -0.005 ? 'shorts' : 'unclear';

  // Crypto retail commonly uses 5x, 10x, 25x perps. Liq distance for isolated
  // longs at leverage L is roughly -1/L (and +1/L for shorts), ignoring fees/MMR.
  const longLiqPcts = [-20, -10, -4]; // 5x, 10x, 25x
  const shortLiqPcts = [20, 10, 4];

  let interp: string;
  if (crowded === 'longs') {
    interp =
      'Funding positive → longs paying shorts → longs are crowded. Smart-money incentive: drive price DOWN to harvest stops at ~-4% / -10% / -20% from mark.';
  } else if (crowded === 'shorts') {
    interp =
      'Funding negative → shorts paying longs → shorts are crowded. Smart-money incentive: squeeze UP through ~+4% / +10% / +20% from mark.';
  } else {
    interp = 'Funding near zero — no obvious crowded side; stop-hunt thesis weak.';
  }

  return ok({
    symbol: symbol.toUpperCase(),
    mark_price: mark,
    funding_rate_pct: fr,
    open_interest_usd: deriv.data.openInterestUsd,
    crowded_side: crowded,
    probable_long_liq_pcts: longLiqPcts,
    probable_short_liq_pcts: shortLiqPcts,
    interpretation: interp,
  });
}

// =============================================================================
// detect_manipulation_signals
// =============================================================================
// Composite heuristic: volume vs price divergence, OI spikes against price action,
// abnormal candle structure. Returns a 0-1 risk score with reasoning.

export interface ManipulationSignal {
  symbol: string;
  risk_score: number; // 0 = clean, 1 = looks heavily manipulated
  signals: string[];
  recent_24h_volume_zscore: number | null;
  oi_vs_price_divergence: boolean;
  recommendation: string;
}

export async function detectManipulationSignals(symbol: string): Promise<Result<ManipulationSignal>> {
  try {
    const [ohlcRes, derivRes] = await Promise.all([
      getCryptoOHLC(symbol, '1h', 168), // 7 days of 1h candles
      getCryptoDerivatives(symbol),
    ]);
    if (!ohlcRes.ok) return err(`manipulation: OHLC ${ohlcRes.error}`);
    const candles = ohlcRes.data.candles;
    if (candles.length < 48) return err('manipulation: insufficient OHLC history');

    const signals: string[] = [];
    let score = 0;

    // Volume z-score on the last candle vs prior 167.
    const recentVol = candles[candles.length - 1].volume;
    const priorVols = candles.slice(0, -1).map((c) => c.volume);
    const mean = priorVols.reduce((s, v) => s + v, 0) / priorVols.length;
    const variance =
      priorVols.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(priorVols.length - 1, 1);
    const std = Math.sqrt(variance);
    const z = std > 0 ? (recentVol - mean) / std : 0;

    // Price change vs volume spike: a giant volume spike on a tiny move suggests churn,
    // wash trading, or stop-hunt distribution.
    const lastClose = candles[candles.length - 1].close;
    const lastOpen = candles[candles.length - 1].open;
    const pctMove = lastOpen > 0 ? Math.abs((lastClose - lastOpen) / lastOpen) * 100 : 0;
    if (z > 3 && pctMove < 0.5) {
      signals.push(`volume spike (z=${z.toFixed(1)}) with <0.5% price move — possible wash/churn`);
      score += 0.4;
    } else if (z > 5) {
      signals.push(`extreme volume spike (z=${z.toFixed(1)})`);
      score += 0.2;
    }

    // Last 24h: count "wick rejections" — candles with wick >2× body.
    const last24 = candles.slice(-24);
    let rejections = 0;
    for (const c of last24) {
      const body = Math.abs(c.close - c.open);
      const upperWick = c.high - Math.max(c.close, c.open);
      const lowerWick = Math.min(c.close, c.open) - c.low;
      const totalWick = upperWick + lowerWick;
      if (body > 0 && totalWick / body > 2) rejections++;
    }
    if (rejections >= 6) {
      signals.push(`${rejections}/24h candles with wick:body >2:1 — heavy rejection / hunting`);
      score += 0.3;
    }

    // OI vs price divergence: OI rising while price flat is a buildup,
    // OI rising while price falling = shorts piling in.
    let oiDivergence = false;
    if (derivRes.ok) {
      const last24h = candles.slice(-24);
      const ret24h = (last24h[last24h.length - 1].close - last24h[0].open) / last24h[0].open;
      // We don't have OI history; use absolute OI as a noisy signal of crowding.
      // High annualized funding + small price move = lopsided positioning forming.
      const absFundAnn = Math.abs(derivRes.data.fundingRateAnnualizedPct);
      if (absFundAnn > 40 && Math.abs(ret24h) < 0.02) {
        signals.push(`extreme funding (${absFundAnn.toFixed(0)}% ann) with quiet price — pressure building`);
        score += 0.3;
        oiDivergence = true;
      }
    }

    if (signals.length === 0) signals.push('no obvious manipulation signals');

    score = Math.min(1, score);
    const rec =
      score >= 0.6
        ? 'HIGH manipulation risk — do NOT trust the visible setup; assume the obvious side is the trap.'
        : score >= 0.3
          ? 'ELEVATED risk — size down, treat clean-looking setups with suspicion.'
          : 'low risk — standard caution applies.';

    return ok({
      symbol: symbol.toUpperCase(),
      risk_score: Math.round(score * 100) / 100,
      signals,
      recent_24h_volume_zscore: Math.round(z * 100) / 100,
      oi_vs_price_divergence: oiDivergence,
      recommendation: rec,
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
