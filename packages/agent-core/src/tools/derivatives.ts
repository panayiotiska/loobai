import type { Result } from '@loob/shared';
import { ok, err } from '@loob/shared';

// Binance Futures and Bybit are geo-blocked from GitHub Actions runners (451/403).
// OKX and Deribit public endpoints work; we use OKX as primary and fall back to
// Deribit when OKX returns a non-2xx (or no instrument).

export interface CryptoDerivativesResult {
  symbol: string;
  pair: string;
  fundingRatePct: number;
  fundingRateAnnualizedPct: number;
  nextFundingTime: string | null;
  openInterestBase: number;
  openInterestUsd: number;
  markPrice: number;
  source: 'okx' | 'deribit';
}

// OKX funding cadence: 3 fundings/day → 365 * 3 fundings/year. A handful of pairs
// (ARB, some meme perps) settle every 4h; we accept the small annualization error.
const FUNDINGS_PER_YEAR = 365 * 3;

interface OkxResp<T> {
  code: string;
  msg?: string;
  data?: T[];
}

interface OkxFunding {
  instId: string;
  fundingRate: string;
  // OKX returns `fundingTime` = upcoming settlement timestamp (ms).
  fundingTime: string;
}

interface OkxOpenInterest {
  instId: string;
  oi: string;
  oiCcy: string;
  ts: string;
}

interface OkxTicker {
  instId: string;
  last: string;
  markPx?: string;
}

async function fetchOkx(symbol: string): Promise<Result<CryptoDerivativesResult>> {
  const instId = `${symbol.toUpperCase()}-USDT-SWAP`;
  try {
    const [fundingRes, oiRes, tickerRes] = await Promise.all([
      fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`),
      fetch(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${instId}`),
      fetch(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`),
    ]);

    if (!fundingRes.ok) return err(`OKX funding error: ${fundingRes.status} ${fundingRes.statusText}`);
    if (!oiRes.ok) return err(`OKX OI error: ${oiRes.status} ${oiRes.statusText}`);
    if (!tickerRes.ok) return err(`OKX ticker error: ${tickerRes.status} ${tickerRes.statusText}`);

    const funding = (await fundingRes.json()) as OkxResp<OkxFunding>;
    const oi = (await oiRes.json()) as OkxResp<OkxOpenInterest>;
    const ticker = (await tickerRes.json()) as OkxResp<OkxTicker>;

    const f = funding.data?.[0];
    const o = oi.data?.[0];
    const t = ticker.data?.[0];
    if (!f || !o || !t) return err(`OKX: instrument ${instId} not found`);

    const fundingRate = parseFloat(f.fundingRate);
    const markPrice = parseFloat(t.markPx ?? t.last);
    const openInterestBase = parseFloat(o.oiCcy);
    const openInterestUsd = openInterestBase * markPrice;

    return ok({
      symbol: symbol.toUpperCase(),
      pair: instId,
      fundingRatePct: fundingRate * 100,
      fundingRateAnnualizedPct: fundingRate * FUNDINGS_PER_YEAR * 100,
      nextFundingTime: f.fundingTime ? new Date(parseInt(f.fundingTime, 10)).toISOString() : null,
      openInterestBase,
      openInterestUsd,
      markPrice,
      source: 'okx',
    });
  } catch (e) {
    return err(`OKX fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface DeribitFundingResp {
  result?: number;
  error?: { message: string };
}

interface DeribitTickerResp {
  result?: {
    mark_price?: number;
    last_price?: number;
    open_interest?: number;
  };
  error?: { message: string };
}

async function fetchDeribit(symbol: string): Promise<Result<CryptoDerivativesResult>> {
  // Deribit perpetuals: e.g. BTC-PERPETUAL, ETH-PERPETUAL. Limited symbol set vs OKX.
  const instrument = `${symbol.toUpperCase()}-PERPETUAL`;
  try {
    // 8h funding window — start at now-8h, end now.
    const endTs = Date.now();
    const startTs = endTs - 8 * 60 * 60 * 1000;

    const [fundingRes, tickerRes] = await Promise.all([
      fetch(
        `https://www.deribit.com/api/v2/public/get_funding_rate_value?instrument_name=${instrument}&start_timestamp=${startTs}&end_timestamp=${endTs}`,
      ),
      fetch(`https://www.deribit.com/api/v2/public/ticker?instrument_name=${instrument}`),
    ]);

    if (!fundingRes.ok) return err(`Deribit funding error: ${fundingRes.status} ${fundingRes.statusText}`);
    if (!tickerRes.ok) return err(`Deribit ticker error: ${tickerRes.status} ${tickerRes.statusText}`);

    const funding = (await fundingRes.json()) as DeribitFundingResp;
    const ticker = (await tickerRes.json()) as DeribitTickerResp;

    if (funding.error) return err(`Deribit funding: ${funding.error.message}`);
    if (ticker.error || !ticker.result) {
      return err(`Deribit ticker: ${ticker.error?.message ?? 'no result'}`);
    }

    // Deribit returns funding for the window — treat as the 8h rate.
    const fundingRate = funding.result ?? 0;
    const markPrice = ticker.result.mark_price ?? ticker.result.last_price ?? 0;
    // open_interest on perp tickers is in USD on Deribit.
    const openInterestUsd = ticker.result.open_interest ?? 0;
    const openInterestBase = markPrice > 0 ? openInterestUsd / markPrice : 0;

    return ok({
      symbol: symbol.toUpperCase(),
      pair: instrument,
      fundingRatePct: fundingRate * 100,
      fundingRateAnnualizedPct: fundingRate * FUNDINGS_PER_YEAR * 100,
      nextFundingTime: null, // Deribit funding is continuous; no discrete next-funding timestamp.
      openInterestBase,
      openInterestUsd,
      markPrice,
      source: 'deribit',
    });
  } catch (e) {
    return err(`Deribit fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function getCryptoDerivatives(symbol: string): Promise<Result<CryptoDerivativesResult>> {
  const primary = await fetchOkx(symbol);
  if (primary.ok) return primary;

  const fallback = await fetchDeribit(symbol);
  if (fallback.ok) return fallback;

  return err(`Both OKX and Deribit failed. OKX: ${primary.error}. Deribit: ${fallback.error}`);
}
