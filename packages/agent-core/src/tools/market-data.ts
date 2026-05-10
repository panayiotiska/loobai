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
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${lookback}`,
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
  outcomes: Array<{ name: string; price: number }>;
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
      .map((m) => {
        let outcomes: PolymarketMarket['outcomes'] = [];
        try {
          const names: string[] = JSON.parse(m.outcomes ?? '[]');
          const prices: string[] = JSON.parse(m.outcomePrices ?? '[]');
          outcomes = names.map((name, i) => ({ name, price: parseFloat(prices[i] ?? '0') }));
        } catch {}
        return {
          id: m.id,
          slug: m.slug,
          question: m.question,
          category: m.category ?? 'unknown',
          volume: parseFloat(m.volume ?? '0'),
          endDate: m.endDate ?? '',
          outcomes,
        };
      });

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
      description?: string;
      resolutionSource?: string;
    }>;

    if (!json.length) return err(`Market not found: ${slug}`);

    const m = json[0];
    let outcomes: PolymarketMarket['outcomes'] = [];
    try {
      const names: string[] = JSON.parse(m.outcomes ?? '[]');
      const prices: string[] = JSON.parse(m.outcomePrices ?? '[]');
      outcomes = names.map((name, i) => ({ name, price: parseFloat(prices[i] ?? '0') }));
    } catch {}

    return ok({
      id: m.id,
      slug: m.slug,
      question: m.question,
      category: m.category ?? 'unknown',
      volume: parseFloat(m.volume ?? '0'),
      endDate: m.endDate ?? '',
      outcomes,
      description: m.description ?? '',
      resolutionSource: m.resolutionSource ?? '',
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
