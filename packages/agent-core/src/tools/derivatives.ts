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

// Funding rate is paid every 8 hours → 3 fundings/day → 365 * 3 fundings/year
const FUNDINGS_PER_YEAR = 365 * 3;

export async function getCryptoDerivatives(symbol: string): Promise<Result<CryptoDerivativesResult>> {
  const pair = `${symbol.toUpperCase()}USDT`;

  try {
    const [premiumRes, oiRes] = await Promise.all([
      fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${pair}`),
      fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${pair}`),
    ]);

    if (!premiumRes.ok) return err(`Binance premiumIndex error: ${premiumRes.status} ${premiumRes.statusText}`);
    if (!oiRes.ok) return err(`Binance openInterest error: ${oiRes.status} ${oiRes.statusText}`);

    const premium = await premiumRes.json() as {
      symbol: string;
      markPrice: string;
      lastFundingRate: string;
      nextFundingTime: number;
    };
    const oi = await oiRes.json() as {
      symbol: string;
      openInterest: string;
      time: number;
    };

    const fundingRate = parseFloat(premium.lastFundingRate);
    const markPrice = parseFloat(premium.markPrice);
    const openInterestBase = parseFloat(oi.openInterest);

    return ok({
      symbol: symbol.toUpperCase(),
      pair,
      fundingRatePct: fundingRate * 100,
      fundingRateAnnualizedPct: fundingRate * FUNDINGS_PER_YEAR * 100,
      nextFundingTime: premium.nextFundingTime ? new Date(premium.nextFundingTime).toISOString() : null,
      openInterestBase,
      openInterestUsd: openInterestBase * markPrice,
      markPrice,
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
