import { describe, it, expect, beforeEach } from 'vitest';
import type { Trade } from '@loob/db';
import {
  paperTradeOpen,
  paperTradeClose,
  computePnl,
  applyEntrySlippage,
  applyExitSlippage,
  roundTripFeeUsd,
  maxSizeForConfidence,
  type PaperTradeDeps,
} from '../paper-trade.js';
import { ok, err } from '@loob/shared';

const FAKE_DB = {} as never;

function tradeFixture(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 't1',
    run_id: 'r1',
    mode: 'paper',
    instrument_kind: 'crypto',
    instrument_id: 'BTC',
    instrument_label: null,
    side: 'buy',
    size_usd: 1000,
    entry_price: 100,
    exit_price: null,
    status: 'open',
    thesis: 'test',
    exit_criteria: {},
    pnl_usd: null,
    confidence: 0.8,
    opened_at: new Date().toISOString(),
    closed_at: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<PaperTradeDeps> = {}): PaperTradeDeps {
  return {
    insertTrade: async (_db, payload) => ({ ...tradeFixture(), ...payload, id: 'inserted' }),
    closeTrade: async () => undefined,
    getOpenTrades: async () => [],
    updateOpenTradePnl: async () => undefined,
    getCryptoPrice: async (symbol) =>
      ok({ symbol, priceUsd: 100, change24hPct: 0, marketCapUsd: 0, volumeUsd24h: 0 }),
    getPolymarketOrderbook: async (slug, outcome) =>
      ok({
        slug,
        outcome,
        clobTokenId: 'tok',
        bestBid: 0.5,
        bestAsk: 0.52,
        spread: 0.02,
        midPrice: 0.51,
        bidDepthUsd: 100,
        askDepthUsd: 100,
        bids: [],
        asks: [],
        timestamp: new Date().toISOString(),
      }),
    now: () => Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env.MAX_OPEN_EXPOSURE_USD;
  delete process.env.PAPER_SLIPPAGE_BPS;
  delete process.env.PAPER_FEE_BPS;
});

describe('computePnl', () => {
  it('long buy gain: 10% price increase → +size * 10% minus fees', () => {
    const t = tradeFixture({ side: 'buy', entry_price: 100, size_usd: 1000 });
    const pnl = computePnl(t, 110);
    // 10% gain on 1000 = 100, minus 2 * 10bps * 1000 = $2 round-trip = $98
    expect(pnl).toBeCloseTo(98, 5);
  });

  it('long buy loss: 5% price drop → -50 minus fees', () => {
    const t = tradeFixture({ side: 'buy', entry_price: 100, size_usd: 1000 });
    const pnl = computePnl(t, 95);
    expect(pnl).toBeCloseTo(-52, 5);
  });

  it('short sell gain: price drops → positive PnL', () => {
    const t = tradeFixture({ side: 'sell', entry_price: 100, size_usd: 1000 });
    const pnl = computePnl(t, 90);
    // -10% directional but side=sell flips to +10% gross = +100, minus $2 fees
    expect(pnl).toBeCloseTo(98, 5);
  });

  it('short sell loss: price up → negative PnL', () => {
    const t = tradeFixture({ side: 'sell', entry_price: 100, size_usd: 1000 });
    const pnl = computePnl(t, 110);
    expect(pnl).toBeCloseTo(-102, 5);
  });

  it('yes side behaves like buy (long)', () => {
    const t = tradeFixture({ side: 'yes', entry_price: 0.5, size_usd: 1000 });
    const pnl = computePnl(t, 0.6);
    // 20% gain = +200, minus $2 fees
    expect(pnl).toBeCloseTo(198, 5);
  });

  it('zero entry price guard returns 0', () => {
    const t = tradeFixture({ entry_price: 0 });
    expect(computePnl(t, 100)).toBe(0);
  });
});

describe('slippage', () => {
  it('long entry adds slippage (worse price for buyer)', () => {
    const price = applyEntrySlippage(100, 'buy');
    expect(price).toBeGreaterThan(100);
  });
  it('long exit subtracts slippage', () => {
    const price = applyExitSlippage(100, 'buy');
    expect(price).toBeLessThan(100);
  });
  it('short entry subtracts slippage', () => {
    const price = applyEntrySlippage(100, 'sell');
    expect(price).toBeLessThan(100);
  });
  it('short exit adds slippage', () => {
    const price = applyExitSlippage(100, 'sell');
    expect(price).toBeGreaterThan(100);
  });
});

describe('roundTripFeeUsd', () => {
  it('default: 10bps × 2 legs × size', () => {
    expect(roundTripFeeUsd(1000)).toBeCloseTo(2, 5);
  });
  it('honours PAPER_FEE_BPS env', () => {
    process.env.PAPER_FEE_BPS = '25';
    expect(roundTripFeeUsd(1000)).toBeCloseTo(5, 5);
  });
});

describe('maxSizeForConfidence', () => {
  it('1.0 → full cap', () => expect(maxSizeForConfidence(10_000, 1.0)).toBe(10_000));
  it('0.8 → 64% of cap', () => expect(maxSizeForConfidence(10_000, 0.8)).toBeCloseTo(6_400));
  it('0.5 → 25% of cap', () => expect(maxSizeForConfidence(10_000, 0.5)).toBeCloseTo(2_500));
  it('0.0 → 0', () => expect(maxSizeForConfidence(10_000, 0.0)).toBe(0));
  it('clamps above 1', () => expect(maxSizeForConfidence(10_000, 2.0)).toBe(10_000));
  it('clamps below 0', () => expect(maxSizeForConfidence(10_000, -0.5)).toBe(0));
});

describe('paperTradeOpen — exposure cap', () => {
  it('rejects when total open notional would exceed cap', async () => {
    process.env.MAX_OPEN_EXPOSURE_USD = '1000';
    const deps = makeDeps({
      getOpenTrades: async () => [tradeFixture({ size_usd: 600 })],
    });
    const result = await paperTradeOpen(FAKE_DB, 'r1', {
      instrument_kind: 'crypto',
      instrument_id: 'BTC',
      side: 'buy',
      size_usd: 500,
      thesis: 't',
      confidence: 1.0,
      exit_criteria: {},
    }, deps);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/exposure cap/i);
  });

  it('allows when at the boundary', async () => {
    process.env.MAX_OPEN_EXPOSURE_USD = '1000';
    const deps = makeDeps({
      getOpenTrades: async () => [tradeFixture({ size_usd: 500 })],
    });
    const result = await paperTradeOpen(FAKE_DB, 'r1', {
      instrument_kind: 'crypto',
      instrument_id: 'BTC',
      side: 'buy',
      size_usd: 500,
      thesis: 't',
      confidence: 1.0,
      exit_criteria: {},
    }, deps);
    expect(result.ok).toBe(true);
  });

  it('sums multiple open trades correctly', async () => {
    process.env.MAX_OPEN_EXPOSURE_USD = '1000';
    const deps = makeDeps({
      getOpenTrades: async () => [
        tradeFixture({ size_usd: 300 }),
        tradeFixture({ size_usd: 400 }),
      ],
    });
    const result = await paperTradeOpen(FAKE_DB, 'r1', {
      instrument_kind: 'crypto',
      instrument_id: 'BTC',
      side: 'buy',
      size_usd: 301,
      thesis: 't',
      confidence: 1.0,
      exit_criteria: {},
    }, deps);
    expect(result.ok).toBe(false);
  });
});

describe('paperTradeOpen — confidence sizing', () => {
  it('rejects size above cap × conf² at conf 0.5', async () => {
    process.env.MAX_OPEN_EXPOSURE_USD = '10000';
    const deps = makeDeps();
    const result = await paperTradeOpen(FAKE_DB, 'r1', {
      instrument_kind: 'crypto',
      instrument_id: 'BTC',
      side: 'buy',
      size_usd: 3000,
      thesis: 't',
      confidence: 0.5,
      exit_criteria: {},
    }, deps);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/confidence cap/i);
  });

  it('accepts size at boundary for conf 0.5', async () => {
    process.env.MAX_OPEN_EXPOSURE_USD = '10000';
    const deps = makeDeps();
    const result = await paperTradeOpen(FAKE_DB, 'r1', {
      instrument_kind: 'crypto',
      instrument_id: 'BTC',
      side: 'buy',
      size_usd: 2500,
      thesis: 't',
      confidence: 0.5,
      exit_criteria: {},
    }, deps);
    expect(result.ok).toBe(true);
  });

  it('full cap available at conf 1.0', async () => {
    process.env.MAX_OPEN_EXPOSURE_USD = '10000';
    const deps = makeDeps();
    const result = await paperTradeOpen(FAKE_DB, 'r1', {
      instrument_kind: 'crypto',
      instrument_id: 'BTC',
      side: 'buy',
      size_usd: 10_000,
      thesis: 't',
      confidence: 1.0,
      exit_criteria: {},
    }, deps);
    expect(result.ok).toBe(true);
  });

  it('zero confidence rejects any positive size', async () => {
    const deps = makeDeps();
    const result = await paperTradeOpen(FAKE_DB, 'r1', {
      instrument_kind: 'crypto',
      instrument_id: 'BTC',
      side: 'buy',
      size_usd: 1,
      thesis: 't',
      confidence: 0.0,
      exit_criteria: {},
    }, deps);
    expect(result.ok).toBe(false);
  });

  it('null confidence defaults to 0.5 (25% of cap)', async () => {
    process.env.MAX_OPEN_EXPOSURE_USD = '10000';
    const deps = makeDeps();
    const tooBig = await paperTradeOpen(FAKE_DB, 'r1', {
      instrument_kind: 'crypto',
      instrument_id: 'BTC',
      side: 'buy',
      size_usd: 2600,
      thesis: 't',
      confidence: null,
      exit_criteria: {},
    }, deps);
    expect(tooBig.ok).toBe(false);

    const justRight = await paperTradeOpen(FAKE_DB, 'r1', {
      instrument_kind: 'crypto',
      instrument_id: 'BTC',
      side: 'buy',
      size_usd: 2400,
      thesis: 't',
      confidence: null,
      exit_criteria: {},
    }, deps);
    expect(justRight.ok).toBe(true);
  });

  it('persists confidence on insert', async () => {
    let captured: number | null | undefined;
    const deps = makeDeps({
      insertTrade: async (_db, payload) => {
        captured = (payload as { confidence?: number | null }).confidence;
        return { ...tradeFixture(), ...payload, id: 'inserted' };
      },
    });
    await paperTradeOpen(FAKE_DB, 'r1', {
      instrument_kind: 'crypto',
      instrument_id: 'BTC',
      side: 'buy',
      size_usd: 100,
      thesis: 't',
      confidence: 0.75,
      exit_criteria: {},
    }, deps);
    expect(captured).toBeCloseTo(0.75);
  });
});

describe('paperTradeOpen — entry price fetch', () => {
  it('crypto: applies entry slippage to spot price', async () => {
    let captured = 0;
    const deps = makeDeps({
      getCryptoPrice: async () =>
        ok({ symbol: 'BTC', priceUsd: 50_000, change24hPct: 0, marketCapUsd: 0, volumeUsd24h: 0 }),
      insertTrade: async (_db, payload) => {
        captured = payload.entry_price;
        return { ...tradeFixture(), ...payload, id: 'inserted' };
      },
    });
    await paperTradeOpen(FAKE_DB, 'r1', {
      instrument_kind: 'crypto',
      instrument_id: 'BTC',
      side: 'buy',
      size_usd: 100,
      thesis: 't',
      confidence: 1.0,
      exit_criteria: {},
    }, deps);
    // Entry slippage for buy = 50000 * (1 + 5bps) = 50025
    expect(captured).toBeCloseTo(50_025, 1);
  });

  it('crypto: price fetch failure returns error', async () => {
    const deps = makeDeps({
      getCryptoPrice: async () => err('rate limited'),
    });
    const result = await paperTradeOpen(FAKE_DB, 'r1', {
      instrument_kind: 'crypto',
      instrument_id: 'BTC',
      side: 'buy',
      size_usd: 100,
      thesis: 't',
      confidence: 1.0,
      exit_criteria: {},
    }, deps);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/entry price/i);
  });

  it('polymarket: uses orderbook mid price', async () => {
    let captured = 0;
    const deps = makeDeps({
      insertTrade: async (_db, payload) => {
        captured = payload.entry_price;
        return { ...tradeFixture(), ...payload, id: 'inserted' };
      },
    });
    await paperTradeOpen(FAKE_DB, 'r1', {
      instrument_kind: 'polymarket',
      instrument_id: 'will-x-happen',
      side: 'yes',
      size_usd: 100,
      thesis: 't',
      confidence: 1.0,
      exit_criteria: {},
    }, deps);
    // mid 0.51 with yes entry slippage = 0.51 * 1.0005
    expect(captured).toBeGreaterThan(0.51);
    expect(captured).toBeLessThan(0.52);
  });
});

describe('paperTradeOpen — input validation', () => {
  it('rejects non-positive size', async () => {
    const deps = makeDeps();
    const r = await paperTradeOpen(FAKE_DB, 'r1', {
      instrument_kind: 'crypto',
      instrument_id: 'BTC',
      side: 'buy',
      size_usd: 0,
      thesis: 't',
      confidence: 1.0,
      exit_criteria: {},
    }, deps);
    expect(r.ok).toBe(false);
  });
});

describe('paperTradeClose', () => {
  it('writes correct exit price + PnL via closeTrade', async () => {
    const trade = tradeFixture({ side: 'buy', entry_price: 100, size_usd: 1000 });
    let captured: { id: string; exitPrice: number; pnl: number } | null = null;
    const fakeDb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              limit: async () => ({ data: [trade], error: null }),
            }),
          }),
        }),
      }),
    } as unknown as never;
    const deps = makeDeps({
      getCryptoPrice: async () =>
        ok({ symbol: 'BTC', priceUsd: 110, change24hPct: 0, marketCapUsd: 0, volumeUsd24h: 0 }),
      closeTrade: async (_db, id, exitPrice, pnl) => {
        captured = { id, exitPrice, pnl };
      },
    });
    const result = await paperTradeClose(fakeDb, { trade_id: trade.id, reason: 'manual' }, deps);
    expect(result.ok).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!.id).toBe(trade.id);
    // exit slippage on buy = 110 * 0.9995 = 109.945; PnL > 0
    expect(captured!.exitPrice).toBeCloseTo(109.945, 2);
    expect(captured!.pnl).toBeGreaterThan(0);
  });
});
