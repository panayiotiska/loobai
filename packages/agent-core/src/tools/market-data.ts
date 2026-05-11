import type { Result } from '@loob/shared';
import { ok, err } from '@loob/shared';

// Simple in-memory cache scoped to the process lifetime (one run)
const priceCache = new Map<string, { data: CryptoPriceResult; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface CryptoPriceResult {
  symbol: string;
  priceUsd: number;
  change24hPct: number;
  marketCapUsd: number;
  volumeUsd24h: number;
}

const COINGECKO_SYMBOL_MAP: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  DOGE: 'dogecoin',
  ADA: 'cardano',
  AVAX: 'avalanche-2',
  MATIC: 'matic-network',
  DOT: 'polkadot',
};

export async function getCryptoPrice(symbol: string): Promise<Result<CryptoPriceResult>> {
  const upper = symbol.toUpperCase();
  const cached = priceCache.get(upper);
  if (cached && cached.expiresAt > Date.now()) {
    return ok(cached.data);
  }

  const coinId = COINGECKO_SYMBOL_MAP[upper] ?? upper.toLowerCase();
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${coinId}&price_change_percentage=24h`,
    );
    if (!res.ok) return err(`CoinGecko error: ${res.status} ${res.statusText}`);

    const json = await res.json() as Array<{
      symbol: string;
      current_price: number;
      price_change_percentage_24h: number;
      market_cap: number;
      total_volume: number;
    }>;

    if (!json.length) return err(`No data found for symbol: ${symbol}`);

    const coin = json[0];
    const data: CryptoPriceResult = {
      symbol: coin.symbol.toUpperCase(),
      priceUsd: coin.current_price,
      change24hPct: coin.price_change_percentage_24h,
      marketCapUsd: coin.market_cap,
      volumeUsd24h: coin.total_volume,
    };

    priceCache.set(upper, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return ok(data);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export interface OHLCCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OHLCResult {
  symbol: string;
  interval: string;
  candles: OHLCCandle[];
}

export async function getCryptoOHLC(
  symbol: string,
  interval: string,
  lookback: number,
): Promise<Result<OHLCResult>> {
  const pair = `${symbol.toUpperCase()}USDT`;
  try {
    const res = await fetch(
      `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${lookback}`,
    );
    if (!res.ok) return err(`Binance error: ${res.status} ${res.statusText}`);

    const raw = await res.json() as Array<[number, string, string, string, string, string, ...unknown[]]>;
    const candles: OHLCCandle[] = raw.map((c) => ({
      openTime: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));

    return ok({ symbol: symbol.toUpperCase(), interval, candles });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export interface PolymarketMarket {
  id: string;
  slug: string;
  question: string;
  category: string;
  volume: number;
  endDate: string;
  outcomes: Array<{ name: string; price: number; clobTokenId: string }>;
}

function parseOutcomes(
  rawNames: string | undefined,
  rawPrices: string | undefined,
  rawTokenIds: string | undefined,
): PolymarketMarket['outcomes'] {
  try {
    const names: string[] = JSON.parse(rawNames ?? '[]');
    const prices: string[] = JSON.parse(rawPrices ?? '[]');
    const tokenIds: string[] = JSON.parse(rawTokenIds ?? '[]');
    return names.map((name, i) => ({
      name,
      price: parseFloat(prices[i] ?? '0'),
      clobTokenId: tokenIds[i] ?? '',
    }));
  } catch {
    return [];
  }
}

function resolveOutcomeTokenId(
  outcomes: PolymarketMarket['outcomes'],
  outcome: string,
): string | null {
  const wanted = outcome.trim().toLowerCase();
  const match = outcomes.find((o) => o.name.toLowerCase() === wanted);
  return match?.clobTokenId || null;
}

export async function listPolymarketMarkets(filters?: {
  category?: string;
  min_volume?: number;
  max_days_to_resolution?: number;
}): Promise<Result<PolymarketMarket[]>> {
  try {
    const params = new URLSearchParams({
      active: 'true',
      closed: 'false',
      limit: '20',
      order: 'volume',
      ascending: 'false',
    });

    const res = await fetch(`https://gamma-api.polymarket.com/markets?${params.toString()}`);
    if (!res.ok) return err(`Polymarket error: ${res.status} ${res.statusText}`);

    const json = await res.json() as Array<{
      id: string;
      slug: string;
      question: string;
      category?: string;
      volume?: string;
      endDate?: string;
      outcomes?: string;
      outcomePrices?: string;
      clobTokenIds?: string;
    }>;

    const now = Date.now();
    const markets: PolymarketMarket[] = json
      .filter((m) => {
        if (filters?.min_volume && parseFloat(m.volume ?? '0') < filters.min_volume) return false;
        if (filters?.category && m.category !== filters.category) return false;
        if (filters?.max_days_to_resolution && m.endDate) {
          const daysLeft = (new Date(m.endDate).getTime() - now) / (1000 * 60 * 60 * 24);
          if (daysLeft > filters.max_days_to_resolution) return false;
        }
        return true;
      })
      .map((m) => ({
        id: m.id,
        slug: m.slug,
        question: m.question,
        category: m.category ?? 'unknown',
        volume: parseFloat(m.volume ?? '0'),
        endDate: m.endDate ?? '',
        outcomes: parseOutcomes(m.outcomes, m.outcomePrices, m.clobTokenIds),
      }));

    return ok(markets);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export interface PolymarketMarketDetail extends PolymarketMarket {
  description: string;
  resolutionSource: string;
}

export async function getPolymarketMarket(slug: string): Promise<Result<PolymarketMarketDetail>> {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
    if (!res.ok) return err(`Polymarket error: ${res.status} ${res.statusText}`);

    const json = await res.json() as Array<{
      id: string;
      slug: string;
      question: string;
      category?: string;
      volume?: string;
      endDate?: string;
      outcomes?: string;
      outcomePrices?: string;
      clobTokenIds?: string;
      description?: string;
      resolutionSource?: string;
    }>;

    if (!json.length) return err(`Market not found: ${slug}`);

    const m = json[0];
    return ok({
      id: m.id,
      slug: m.slug,
      question: m.question,
      category: m.category ?? 'unknown',
      volume: parseFloat(m.volume ?? '0'),
      endDate: m.endDate ?? '',
      outcomes: parseOutcomes(m.outcomes, m.outcomePrices, m.clobTokenIds),
      description: m.description ?? '',
      resolutionSource: m.resolutionSource ?? '',
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export interface PolymarketOrderbookLevel {
  price: number;
  size: number;
}

export interface PolymarketOrderbookResult {
  slug: string;
  outcome: string;
  clobTokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  midPrice: number | null;
  bidDepthUsd: number;
  askDepthUsd: number;
  bids: PolymarketOrderbookLevel[];
  asks: PolymarketOrderbookLevel[];
  timestamp: string;
}

export async function getPolymarketOrderbook(
  slug: string,
  outcome: string,
  depth = 10,
): Promise<Result<PolymarketOrderbookResult>> {
  const market = await getPolymarketMarket(slug);
  if (!market.ok) return err(market.error);

  const tokenId = resolveOutcomeTokenId(market.data.outcomes, outcome);
  if (!tokenId) {
    const available = market.data.outcomes.map((o) => o.name).join(', ');
    return err(`Outcome "${outcome}" not found. Available: ${available}`);
  }

  try {
    const res = await fetch(
      `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`,
    );
    if (!res.ok) return err(`Polymarket CLOB error: ${res.status} ${res.statusText}`);

    const json = await res.json() as {
      bids?: Array<{ price: string; size: string }>;
      asks?: Array<{ price: string; size: string }>;
      timestamp?: string;
    };

    const parseLevels = (raw?: Array<{ price: string; size: string }>): PolymarketOrderbookLevel[] =>
      (raw ?? [])
        .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
        .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size));

    const allBids = parseLevels(json.bids).sort((a, b) => b.price - a.price);
    const allAsks = parseLevels(json.asks).sort((a, b) => a.price - b.price);
    const bids = allBids.slice(0, depth);
    const asks = allAsks.slice(0, depth);

    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
    const midPrice = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
    const bidDepthUsd = allBids.reduce((sum, l) => sum + l.price * l.size, 0);
    const askDepthUsd = allAsks.reduce((sum, l) => sum + l.price * l.size, 0);

    return ok({
      slug,
      outcome,
      clobTokenId: tokenId,
      bestBid,
      bestAsk,
      spread,
      midPrice,
      bidDepthUsd,
      askDepthUsd,
      bids,
      asks,
      timestamp: json.timestamp ?? new Date().toISOString(),
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export type PolymarketHistoryInterval = '1m' | '1h' | '6h' | '1d' | '1w' | 'max';

export interface PolymarketPricePoint {
  timestamp: number;
  price: number;
}

export interface PolymarketPriceHistoryResult {
  slug: string;
  outcome: string;
  clobTokenId: string;
  interval: PolymarketHistoryInterval;
  points: PolymarketPricePoint[];
  firstPrice: number | null;
  lastPrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  changePct: number | null;
}

const VALID_INTERVALS: PolymarketHistoryInterval[] = ['1m', '1h', '6h', '1d', '1w', 'max'];

export async function getPolymarketPriceHistory(
  slug: string,
  outcome: string,
  interval: PolymarketHistoryInterval = '1d',
): Promise<Result<PolymarketPriceHistoryResult>> {
  if (!VALID_INTERVALS.includes(interval)) {
    return err(`Invalid interval "${interval}". Use one of: ${VALID_INTERVALS.join(', ')}`);
  }

  const market = await getPolymarketMarket(slug);
  if (!market.ok) return err(market.error);

  const tokenId = resolveOutcomeTokenId(market.data.outcomes, outcome);
  if (!tokenId) {
    const available = market.data.outcomes.map((o) => o.name).join(', ');
    return err(`Outcome "${outcome}" not found. Available: ${available}`);
  }

  try {
    const params = new URLSearchParams({ market: tokenId, interval });
    const res = await fetch(`https://clob.polymarket.com/prices-history?${params.toString()}`);
    if (!res.ok) return err(`Polymarket CLOB error: ${res.status} ${res.statusText}`);

    const json = await res.json() as { history?: Array<{ t: number; p: number }> };
    const points: PolymarketPricePoint[] = (json.history ?? [])
      .map((pt) => ({ timestamp: pt.t, price: pt.p }))
      .filter((pt) => Number.isFinite(pt.price));

    const firstPrice = points[0]?.price ?? null;
    const lastPrice = points[points.length - 1]?.price ?? null;
    const minPrice = points.length ? Math.min(...points.map((p) => p.price)) : null;
    const maxPrice = points.length ? Math.max(...points.map((p) => p.price)) : null;
    const changePct =
      firstPrice != null && lastPrice != null && firstPrice > 0
        ? ((lastPrice - firstPrice) / firstPrice) * 100
        : null;

    return ok({
      slug,
      outcome,
      clobTokenId: tokenId,
      interval,
      points,
      firstPrice,
      lastPrice,
      minPrice,
      maxPrice,
      changePct,
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
