import { describe, it, expect } from 'vitest';
import { ok, err } from '@loob/shared';
import {
  checkS1,
  checkS2,
  checkS3,
  validateSetup,
  type SetupValidationDeps,
} from '../setup-validation.js';
import type { TrendSignal } from '../trend.js';

function trendFixture(overrides: Partial<TrendSignal> = {}): TrendSignal {
  return {
    symbol: 'BTC',
    close: 105,
    donchian20High: 100,
    donchian20Low: 80,
    donchian55High: 110,
    donchian55Low: 70,
    breakoutState: 'breakout_up_20',
    atr14: 2,
    atrPct: 1.9,
    realizedVol20dAnnPct: 45,
    volumeRatio20d: 1.5,
    ma20: 95,
    ma50: 90,
    maAlignment: 'bullish',
    suggestedTrailingStopPct: 4.8,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SetupValidationDeps> = {}): SetupValidationDeps {
  return {
    getCryptoDerivatives: async () => err('no derivatives fixture'),
    getTrendSignal: async () => ok(trendFixture()),
    ...overrides,
  };
}

const derivWithFunding = (annPct: number) =>
  ok({
    symbol: 'X',
    pair: 'X-USDT-SWAP',
    fundingRatePct: annPct / 1095,
    fundingRateAnnualizedPct: annPct,
    nextFundingTime: null,
    openInterestBase: 0,
    openInterestUsd: 0,
    markPrice: 100,
    source: 'okx' as const,
  });

describe('checkS1 (pure)', () => {
  it('boundary: −29.9 rejected, −30.1 accepted', () => {
    expect(checkS1(-29.9, 'buy', 'ATOM').ok).toBe(false);
    expect(checkS1(-30.1, 'buy', 'ATOM').ok).toBe(true);
  });
  it('rejects shorts', () => {
    const r = checkS1(-50, 'sell', 'ATOM');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/LONG setup/);
  });
  it('rejection quotes the actual funding value', () => {
    const r = checkS1(-13.2, 'buy', 'ATOM');
    expect(!r.ok && r.error).toMatch(/-13\.2%/);
    expect(!r.ok && r.error).toMatch(/mid-June/);
  });
});

describe('checkS2 (pure)', () => {
  it('boundary: +29 rejected, +31 accepted (side sell)', () => {
    expect(checkS2(29, 'sell', 'SUI').ok).toBe(false);
    expect(checkS2(31, 'sell', 'SUI').ok).toBe(true);
  });
  it('rejects side=buy with an explanation of the harvest mechanics', () => {
    const r = checkS2(40, 'buy', 'SUI');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/SHORTS the perp/);
  });
});

describe('checkS3 (pure)', () => {
  it('accepts a confirmed long breakout', () => {
    expect(checkS3(trendFixture(), 'buy').ok).toBe(true);
  });
  it('rejects a long when there is no breakout, quoting levels', () => {
    const r = checkS3(trendFixture({ breakoutState: 'none', close: 95 }), 'buy');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/chop trade/);
  });
  it('rejects a long on a downside breakout', () => {
    expect(checkS3(trendFixture({ breakoutState: 'breakout_down_20' }), 'buy').ok).toBe(false);
  });
  it('accepts a short on a downside breakout', () => {
    expect(checkS3(trendFixture({ breakoutState: 'breakout_down_55' }), 'sell').ok).toBe(true);
  });
  it('rejects when volume confirmation is missing', () => {
    const r = checkS3(trendFixture({ volumeRatio20d: 0.9 }), 'buy');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/fakeout/i);
  });
});

describe('validateSetup (I/O wrapper)', () => {
  const base = {
    instrument_kind: 'crypto',
    instrument_id: 'ATOM',
    side: 'buy' as const,
    size_class: 'scout' as const,
  };

  it('missing / unknown setup_type lists all four options', async () => {
    for (const setup_type of [undefined, 'S9_yolo']) {
      const r = await validateSetup({ ...base, setup_type }, makeDeps());
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(/S1_funding_squeeze/);
      expect(!r.ok && r.error).toMatch(/S2_carry_harvest/);
      expect(!r.ok && r.error).toMatch(/S3_trend_breakout/);
      expect(!r.ok && r.error).toMatch(/D_discretionary/);
    }
  });

  it('D_discretionary: scout allowed, conviction rejected', async () => {
    const scout = await validateSetup({ ...base, setup_type: 'D_discretionary' }, makeDeps());
    expect(scout.ok).toBe(true);
    expect(scout.ok && scout.data.hedged).toBe(false);

    const conviction = await validateSetup(
      { ...base, setup_type: 'D_discretionary', size_class: 'conviction' },
      makeDeps(),
    );
    expect(conviction.ok).toBe(false);
    expect(!conviction.ok && conviction.error).toMatch(/scout/);
  });

  it('S1 verifies live funding: deep negative passes, shallow rejected', async () => {
    const pass = await validateSetup(
      { ...base, setup_type: 'S1_funding_squeeze' },
      makeDeps({ getCryptoDerivatives: async () => derivWithFunding(-45) }),
    );
    expect(pass.ok).toBe(true);
    expect(pass.ok && pass.data.hedged).toBe(false);

    const fail = await validateSetup(
      { ...base, setup_type: 'S1_funding_squeeze' },
      makeDeps({ getCryptoDerivatives: async () => derivWithFunding(-13.2) }),
    );
    expect(fail.ok).toBe(false);
    expect(!fail.ok && fail.error).toMatch(/-13\.2%/);
  });

  it('S1/S2 reject when derivatives are unavailable', async () => {
    const r = await validateSetup({ ...base, setup_type: 'S1_funding_squeeze' }, makeDeps());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/could not verify funding/i);
  });

  it('S2 passes with hedged=true on extreme positive funding + side sell', async () => {
    const r = await validateSetup(
      { ...base, setup_type: 'S2_carry_harvest', side: 'sell' },
      makeDeps({ getCryptoDerivatives: async () => derivWithFunding(42) }),
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.hedged).toBe(true);
  });

  it('S3 verifies via the trend signal', async () => {
    const pass = await validateSetup({ ...base, setup_type: 'S3_trend_breakout' }, makeDeps());
    expect(pass.ok).toBe(true);

    const fail = await validateSetup(
      { ...base, setup_type: 'S3_trend_breakout' },
      makeDeps({ getTrendSignal: async () => ok(trendFixture({ breakoutState: 'none' })) }),
    );
    expect(fail.ok).toBe(false);
  });

  it('non-crypto instruments cannot claim S1/S2/S3', async () => {
    const r = await validateSetup(
      { ...base, setup_type: 'S1_funding_squeeze', instrument_kind: 'polymarket' },
      makeDeps(),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/crypto/);
  });
});
