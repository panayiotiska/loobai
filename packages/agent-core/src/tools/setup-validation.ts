// v3: code-enforced setup taxonomy.
//
// Late June 2026: with no extreme funding in the market, the agent churned
// "squeeze scouts" at −13% annualized funding — violating its own ≤ −30% rule,
// which lived only in the (prompt-injected) FORMULA document. Fees ate every
// trade. The defining condition of each setup is now verified server-side at
// open time with live market data; rejection messages are written to be
// actionable by the small model.

import type { Trade, SetupType } from '@loob/db';
import type { Result } from '@loob/shared';
import { ok, err } from '@loob/shared';
import { getCryptoDerivatives } from './derivatives.js';
import type { TrendSignal } from './trend.js';
import { getTrendSignal, S3_MIN_VOLUME_RATIO } from './trend.js';
import type { TradeSizeClass } from './paper-trade.js';

export const S1_MAX_FUNDING_ANN_PCT = -30;
export const S2_MIN_FUNDING_ANN_PCT = 30;

export const SETUP_TYPES: SetupType[] = [
  'S1_funding_squeeze',
  'S2_carry_harvest',
  'S3_trend_breakout',
  'D_discretionary',
];

export const SETUP_TYPE_HELP =
  `setup_type must be one of: ` +
  `'S1_funding_squeeze' (long crypto with annualized funding ≤ ${S1_MAX_FUNDING_ANN_PCT}%, verified live), ` +
  `'S2_carry_harvest' (crypto with annualized funding ≥ +${S2_MIN_FUNDING_ANN_PCT}%, side='sell', code models it delta-neutral — PnL is the funding stream), ` +
  `'S3_trend_breakout' (donchian 20/55 breakout with volume ≥ ${S3_MIN_VOLUME_RATIO}× 20d avg, verified via get_trend_signal), ` +
  `'D_discretionary' (anything else — scout size only). Classify the trade and retry.`;

// --- Pure predicates (unit-tested) ---

export function checkS1(fundingAnnPct: number, side: Trade['side'], symbol: string): Result<true> {
  if (side !== 'buy') {
    return err(
      `S1 rejected: S1_funding_squeeze is a LONG setup — crowded shorts pay longs while you wait for the squeeze. side must be 'buy' (got '${side}').`,
    );
  }
  if (fundingAnnPct > S1_MAX_FUNDING_ANN_PCT) {
    return err(
      `S1 rejected: ${symbol} annualized funding is ${fundingAnnPct.toFixed(1)}%, but S1 requires ≤ ${S1_MAX_FUNDING_ANN_PCT}%. ` +
        `At this level the carry does not clear round-trip costs (~0.30%) — this exact churn lost money throughout mid-June 2026. ` +
        `Wait for deeper negative funding, or reclassify as D_discretionary (scout only) if you have a genuine non-funding thesis.`,
    );
  }
  return ok(true);
}

export function checkS2(fundingAnnPct: number, side: Trade['side'], symbol: string): Result<true> {
  if (fundingAnnPct < S2_MIN_FUNDING_ANN_PCT) {
    return err(
      `S2 rejected: ${symbol} annualized funding is ${fundingAnnPct.toFixed(1)}%, but S2_carry_harvest requires ≥ +${S2_MIN_FUNDING_ANN_PCT}%. ` +
        `The edge is harvesting what crowded longs overpay — without extreme positive funding there is nothing to harvest.`,
    );
  }
  if (side !== 'sell') {
    return err(
      `S2 rejected: a carry harvest SHORTS the perp that longs are overpaying to hold, hedged with modeled spot (the code sets hedged=true; your PnL is the funding stream minus doubled fees, no price exposure). side must be 'sell' (got '${side}').`,
    );
  }
  return ok(true);
}

export function checkS3(signal: TrendSignal, side: Trade['side']): Result<true> {
  const isLong = side === 'buy';
  const wantStates = isLong
    ? ['breakout_up_20', 'breakout_up_55']
    : ['breakout_down_20', 'breakout_down_55'];
  if (!wantStates.includes(signal.breakoutState)) {
    const level = isLong ? `prior 20d high $${signal.donchian20High}` : `prior 20d low $${signal.donchian20Low}`;
    return err(
      `S3 rejected: ${signal.symbol} close $${signal.close} has not broken the ${level} ` +
        `(state=${signal.breakoutState}, volume ratio ${signal.volumeRatio20d.toFixed(2)}). ` +
        `A breakout trade without a breakout is a chop trade. Requirements: ${wantStates.join(' or ')} + volume ≥ ${S3_MIN_VOLUME_RATIO}× 20d avg.`,
    );
  }
  if (signal.volumeRatio20d < S3_MIN_VOLUME_RATIO) {
    return err(
      `S3 rejected: ${signal.symbol} broke out (${signal.breakoutState}) but volume is only ${signal.volumeRatio20d.toFixed(2)}× the 20d average (need ≥ ${S3_MIN_VOLUME_RATIO}×). ` +
        `Low-volume boundary tests are fakeout fuel, not breakouts. Watch for volume confirmation.`,
    );
  }
  return ok(true);
}

// --- I/O wrapper used by paperTradeOpen ---

export interface SetupValidationDeps {
  getCryptoDerivatives: typeof getCryptoDerivatives;
  getTrendSignal: typeof getTrendSignal;
}

export const defaultSetupValidationDeps: SetupValidationDeps = {
  getCryptoDerivatives,
  getTrendSignal,
};

export interface SetupValidationInput {
  setup_type: string | undefined;
  instrument_kind: string;
  instrument_id: string;
  side: Trade['side'];
  size_class: TradeSizeClass;
}

export async function validateSetup(
  input: SetupValidationInput,
  deps: SetupValidationDeps = defaultSetupValidationDeps,
): Promise<Result<{ setupType: SetupType; hedged: boolean }>> {
  const setupType = input.setup_type as SetupType | undefined;
  if (!setupType || !SETUP_TYPES.includes(setupType)) {
    return err(
      `Invalid setup_type '${input.setup_type ?? '(missing)'}'. ${SETUP_TYPE_HELP}`,
    );
  }

  if (setupType === 'D_discretionary') {
    if (input.size_class === 'conviction') {
      return err(
        `D_discretionary trades are exploratory by definition — open as size_class='scout'. ` +
          `If this deserves conviction size, it should fit S1/S2/S3; if it fits none, it is not yet a validated setup.`,
      );
    }
    return ok({ setupType, hedged: false });
  }

  if (input.instrument_kind !== 'crypto') {
    return err(
      `${setupType} requires instrument_kind='crypto' (got '${input.instrument_kind}') — its defining condition is verified against perp market data. Use D_discretionary (scout) for other instruments.`,
    );
  }

  if (setupType === 'S1_funding_squeeze' || setupType === 'S2_carry_harvest') {
    const deriv = await deps.getCryptoDerivatives(input.instrument_id);
    if (!deriv.ok) {
      return err(
        `${setupType} rejected: could not verify funding for ${input.instrument_id} (${deriv.error}). ` +
          `No perp funding data = no funding setup. Use D_discretionary (scout) if the thesis stands without funding.`,
      );
    }
    const funding = deriv.data.fundingRateAnnualizedPct;
    if (setupType === 'S1_funding_squeeze') {
      const check = checkS1(funding, input.side, input.instrument_id);
      if (!check.ok) return check;
      return ok({ setupType, hedged: false });
    }
    const check = checkS2(funding, input.side, input.instrument_id);
    if (!check.ok) return check;
    return ok({ setupType, hedged: true });
  }

  // S3_trend_breakout
  if (input.side !== 'buy' && input.side !== 'sell') {
    return err(`S3 rejected: side must be 'buy' or 'sell' (got '${input.side}').`);
  }
  const signal = await deps.getTrendSignal(input.instrument_id);
  if (!signal.ok) {
    return err(`S3 rejected: could not compute trend signal for ${input.instrument_id}: ${signal.error}`);
  }
  const check = checkS3(signal.data, input.side);
  if (!check.ok) return check;
  return ok({ setupType, hedged: false });
}
