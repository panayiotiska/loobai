import type { Result } from '@loob/shared';
import { ok, err } from '@loob/shared';

export interface CryptoDerivativesResult {
  symbol: string;
  pair: string;
  fundingRatePct: number;
  fundingRateAnnualizedPct: number;
  nextFundingTime: string | null;
  openInterestBase: number;
  openInterestUsd: number;
  markPrice: number;
}

// Bybit funding interval defaults to 8h on linear perps → 3 fundings/day → 365 * 3 fundings/year.
// A handful of pairs (notably ARB, MEME-coins) settle every 4h; we accept the small annualization
// error rather than pay an extra API round-trip to /v5/market/instruments-info.
const FUNDINGS_PER_YEAR = 365 * 3;

interface BybitTickersResponse {
  retCode: number;
  retMsg: string;
  result?: {
    list?: Array<{
      symbol: string;
      markPrice: string;
      fundingRate: string;
      nextFundingTime: string;
      openInterest: string;
      openInterestValue: string;
    }>;
  };
}

export async function getCryptoDerivatives(symbol: string): Promise<Result<CryptoDerivativesResult>> {
  const pair = `${symbol.toUpperCase()}USDT`;

  try {
    const res = await fetch(
      `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${pair}`,
    );
    if (!res.ok) return err(`Bybit tickers error: ${res.status} ${res.statusText}`);

    const json = (await res.json()) as BybitTickersResponse;
    if (json.retCode !== 0) return err(`Bybit tickers error: ${json.retMsg}`);

    const ticker = json.result?.list?.[0];
    if (!ticker) return err(`No derivatives data for ${pair}`);

    const fundingRate = parseFloat(ticker.fundingRate);
    const markPrice = parseFloat(ticker.markPrice);
    const openInterestBase = parseFloat(ticker.openInterest);
    const openInterestUsd = parseFloat(ticker.openInterestValue);
    const nextFundingMs = parseInt(ticker.nextFundingTime, 10);

    return ok({
      symbol: symbol.toUpperCase(),
      pair,
      fundingRatePct: fundingRate * 100,
      fundingRateAnnualizedPct: fundingRate * FUNDINGS_PER_YEAR * 100,
      nextFundingTime: Number.isFinite(nextFundingMs) && nextFundingMs > 0
        ? new Date(nextFundingMs).toISOString()
        : null,
      openInterestBase,
      openInterestUsd,
      markPrice,
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
