import type { Result } from '@loob/shared';
import { ok, err } from '@loob/shared';
import { getCryptoOHLC } from './market-data.js';
import { getCryptoDerivatives } from './derivatives.js';

export type MarketRegime =
  | 'euphoria'
  | 'fear'
  | 'chop'
  | 'trend-up'
  | 'trend-down'
  | 'uncertain';

export interface RegimeAssessment {
  regime: MarketRegime;
  confidence: number;
  evidence: {
    btc_30d_realized_vol_pct: number | null;
    btc_7d_return_pct: number | null;
    btc_30d_return_pct: number | null;
    btc_funding_rate_annual_pct: number | null;
    fear_and_greed_index: number | null;
    fear_and_greed_label: string | null;
  };
  playbook: string;
}

interface FngResp {
  data?: Array<{ value: string; value_classification: string }>;
}

async function fetchFearAndGreed(): Promise<{ value: number; label: string } | null> {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1');
    if (!res.ok) return null;
    const json = (await res.json()) as FngResp;
    const v = json.data?.[0];
    if (!v) return null;
    const value = parseInt(v.value, 10);
    if (!Number.isFinite(value)) return null;
    return { value, label: v.value_classification };
  } catch {
    return null;
  }
}

function realizedVolPctFromDailyCloses(closes: number[]): number | null {
  if (closes.length < 10) return null;
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const dailyStd = Math.sqrt(variance);
  // Annualize from daily log-returns: σ × √365.
  return dailyStd * Math.sqrt(365) * 100;
}

export async function assessMarketRegime(): Promise<Result<RegimeAssessment>> {
  try {
    const [ohlcRes, derivRes, fng] = await Promise.all([
      getCryptoOHLC('BTC', '1d', 35),
      getCryptoDerivatives('BTC'),
      fetchFearAndGreed(),
    ]);

    if (!ohlcRes.ok) return err(`regime: BTC OHLC failed: ${ohlcRes.error}`);
    const candles = ohlcRes.data.candles;
    if (candles.length < 10) return err('regime: insufficient BTC OHLC history');

    const closes = candles.map((c) => c.close);
    const last = closes[closes.length - 1];
    const seven = closes.length >= 8 ? closes[closes.length - 8] : null;
    const thirty = closes.length >= 31 ? closes[closes.length - 31] : closes[0];

    const ret7 = seven && seven > 0 ? ((last - seven) / seven) * 100 : null;
    const ret30 = thirty > 0 ? ((last - thirty) / thirty) * 100 : null;
    const vol30 = realizedVolPctFromDailyCloses(closes.slice(-30));

    const fundingAnnual = derivRes.ok ? derivRes.data.fundingRateAnnualizedPct : null;
    const fngVal = fng?.value ?? null;

    // Classification — order matters; first matching rule wins.
    let regime: MarketRegime = 'uncertain';
    let conf = 0.5;
    const reasons: string[] = [];

    if (fngVal != null && fngVal >= 80 && (fundingAnnual ?? 0) > 25) {
      regime = 'euphoria';
      conf = 0.8;
      reasons.push(`F&G=${fngVal} (extreme greed)`, `BTC funding ann=${fundingAnnual?.toFixed(1)}%`);
    } else if (fngVal != null && fngVal <= 20 && (ret30 ?? 0) < -10) {
      regime = 'fear';
      conf = 0.8;
      reasons.push(`F&G=${fngVal} (extreme fear)`, `BTC 30d=${ret30?.toFixed(1)}%`);
    } else if (vol30 != null && vol30 < 25 && Math.abs(ret30 ?? 0) < 5) {
      regime = 'chop';
      conf = 0.7;
      reasons.push(`30d vol=${vol30.toFixed(1)}% (low)`, `BTC 30d range±5%`);
    } else if ((ret30 ?? 0) > 15 && (ret7 ?? 0) > 0) {
      regime = 'trend-up';
      conf = 0.7;
      reasons.push(`BTC 30d=${ret30?.toFixed(1)}%`, `7d=${ret7?.toFixed(1)}%`);
    } else if ((ret30 ?? 0) < -15 && (ret7 ?? 0) < 0) {
      regime = 'trend-down';
      conf = 0.7;
      reasons.push(`BTC 30d=${ret30?.toFixed(1)}%`, `7d=${ret7?.toFixed(1)}%`);
    } else {
      regime = 'uncertain';
      conf = 0.4;
      reasons.push('no strong regime signal');
    }

    const playbooks: Record<MarketRegime, string> = {
      euphoria:
        'Suspect pumps. Look for funding-extreme shorts. Do NOT chase. Manipulation risk is highest here.',
      fear: 'Patience. Capitulation longs only on real bounces. Mean-reversion plays favored. No leverage.',
      chop: 'No directional bets. Range trades only or skip. Boring is the right answer.',
      'trend-up': 'Trade with the trend. Fade the fades. Avoid premature shorts.',
      'trend-down': 'Trade with the trend. Fade the bounces. Avoid premature longs.',
      uncertain: 'Research only. No new trades. Wait for a regime to assert itself.',
    };

    return ok({
      regime,
      confidence: conf,
      evidence: {
        btc_30d_realized_vol_pct: vol30,
        btc_7d_return_pct: ret7,
        btc_30d_return_pct: ret30,
        btc_funding_rate_annual_pct: fundingAnnual,
        fear_and_greed_index: fngVal,
        fear_and_greed_label: fng?.label ?? null,
      },
      playbook: `${playbooks[regime]} [why: ${reasons.join(' · ')}]`,
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
