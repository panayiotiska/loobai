import { describe, it, expect, beforeEach } from 'vitest';
import type { Trade } from '@loob/db';
import {
  autoCloseTriggeredTrades,
  markOpenTradesToMarket,
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
    thesis: 't',
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
  delete process.env.PAPER_SLIPPAGE_BPS;
  delete process.env.PAPER_FEE_BPS;
});

describe('autoCloseTriggeredTrades — take profit', () => {
  it('long: closes when price >= TP', async () => {
    const trade = tradeFixture({
      side: 'buy',
      entry_price: 100,
      exit_criteria: { take_profit: 110 },
    });
    const closes: string[] = [];
    const deps = makeDeps({
      getOpenTrades: async () => [trade],
      getCryptoPrice: async () =>
        ok({ symbol: 'BTC', priceUsd: 115, change24hPct: 0, marketCapUsd: 0, volumeUsd24h: 0 }),
      closeTrade: async (_db, id) => {
        closes.push(id);
      },
    });
    const summary = await autoCloseTriggeredTrades(FAKE_DB, deps);
    expect(summary.closed).toHaveLength(1);
    expect(summary.closed[0].reason).toBe('take_profit_hit');
    expect(closes).toEqual([trade.id]);
  });

  it('long: does NOT close when price < TP', async () => {
    const trade = tradeFixture({
      side: 'buy',
      entry_price: 100,
      exit_criteria: { take_profit: 110 },
    });
    const deps = makeDeps({
      getOpenTrades: async () => [trade],
      getCryptoPrice: async () =>
        ok({ symbol: 'BTC', priceUsd: 105, change24hPct: 0, marketCapUsd: 0, volumeUsd24h: 0 }),
    });
    const summary = await autoCloseTriggeredTrades(FAKE_DB, deps);
    expect(summary.closed).toHaveLength(0);
  });

  it('short: closes when price <= TP (inverted)', async () => {
    const trade = tradeFixture({
      side: 'sell',
      entry_price: 100,
      exit_criteria: { take_profit: 90 },
    });
    const deps = makeDeps({
      getOpenTrades: async () => [trade],
      getCryptoPrice: async () =>
        ok({ symbol: 'BTC', priceUsd: 85, change24hPct: 0, marketCapUsd: 0, volumeUsd24h: 0 }),
    });
    const summary = await autoCloseTriggeredTrades(FAKE_DB, deps);
    expect(summary.closed).toHaveLength(1);
    expect(summary.closed[0].reason).toBe('take_profit_hit');
  });
});

describe('autoCloseTriggeredTrades — stop loss', () => {
  it('long: closes when price <= SL', async () => {
    const trade = tradeFixture({
      side: 'buy',
      entry_price: 100,
      exit_criteria: { stop_loss: 90 },
    });
    const deps = makeDeps({
      getOpenTrades: async () => [trade],
      getCryptoPrice: async () =>
        ok({ symbol: 'BTC', priceUsd: 85, change24hPct: 0, marketCapUsd: 0, volumeUsd24h: 0 }),
    });
    const summary = await autoCloseTriggeredTrades(FAKE_DB, deps);
    expect(summary.closed).toHaveLength(1);
    expect(summary.closed[0].reason).toBe('stop_loss_hit');
  });

  it('short: closes when price >= SL', async () => {
    const trade = tradeFixture({
      side: 'sell',
      entry_price: 100,
      exit_criteria: { stop_loss: 110 },
    });
    const deps = makeDeps({
      getOpenTrades: async () => [trade],
      getCryptoPrice: async () =>
        ok({ symbol: 'BTC', priceUsd: 115, change24hPct: 0, marketCapUsd: 0, volumeUsd24h: 0 }),
    });
    const summary = await autoCloseTriggeredTrades(FAKE_DB, deps);
    expect(summary.closed).toHaveLength(1);
    expect(summary.closed[0].reason).toBe('stop_loss_hit');
  });
});

describe('autoCloseTriggeredTrades — time limit', () => {
  it('closes when time_limit is in the past', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const trade = tradeFixture({ exit_criteria: { time_limit: past } });
    const deps = makeDeps({
      getOpenTrades: async () => [trade],
    });
    const summary = await autoCloseTriggeredTrades(FAKE_DB, deps);
    expect(summary.closed).toHaveLength(1);
    expect(summary.closed[0].reason).toBe('time_limit_reached');
  });

  it('does NOT close when time_limit is in the future', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const trade = tradeFixture({ exit_criteria: { time_limit: future } });
    const deps = makeDeps({
      getOpenTrades: async () => [trade],
    });
    const summary = await autoCloseTriggeredTrades(FAKE_DB, deps);
    expect(summary.closed).toHaveLength(0);
  });

  it('time_limit triggers for ANY instrument kind (no price needed)', async () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    const trade = tradeFixture({
      instrument_kind: 'polymarket',
      side: 'yes',
      exit_criteria: { time_limit: past },
    });
    const deps = makeDeps({
      getOpenTrades: async () => [trade],
    });
    const summary = await autoCloseTriggeredTrades(FAKE_DB, deps);
    expect(summary.closed).toHaveLength(1);
  });
});

describe('autoCloseTriggeredTrades — robustness', () => {
  it('does nothing when no triggers fire', async () => {
    const trade = tradeFixture({
      exit_criteria: { take_profit: 200, stop_loss: 50 },
    });
    const deps = makeDeps({
      getOpenTrades: async () => [trade],
    });
    const summary = await autoCloseTriggeredTrades(FAKE_DB, deps);
    expect(summary.closed).toHaveLength(0);
  });

  it('price fetch failure does not spuriously close', async () => {
    const trade = tradeFixture({
      exit_criteria: { take_profit: 110, stop_loss: 90 },
    });
    const closes: string[] = [];
    const deps = makeDeps({
      getOpenTrades: async () => [trade],
      getCryptoPrice: async () => err('rate-limited'),
      closeTrade: async (_db, id) => {
        closes.push(id);
      },
    });
    const summary = await autoCloseTriggeredTrades(FAKE_DB, deps);
    expect(summary.closed).toHaveLength(0);
    expect(closes).toHaveLength(0);
  });
});

describe('markOpenTradesToMarket', () => {
  it('writes unrealized PnL for crypto long', async () => {
    const trade = tradeFixture({
      side: 'buy',
      entry_price: 100,
      size_usd: 1000,
      pnl_usd: null,
      exit_criteria: { take_profit: 200, stop_loss: 50 }, // out of range
    });
    let captured: { id: string; pnl: number } | null = null;
    const deps = makeDeps({
      getOpenTrades: async () => [trade],
      getCryptoPrice: async () =>
        ok({ symbol: 'BTC', priceUsd: 110, change24hPct: 0, marketCapUsd: 0, volumeUsd24h: 0 }),
      updateOpenTradePnl: async (_db, id, pnl) => {
        captured = { id, pnl };
      },
    });
    const summary = await markOpenTradesToMarket(FAKE_DB, deps);
    expect(summary.updated).toBe(1);
    expect(captured).not.toBeNull();
    expect(captured!.id).toBe(trade.id);
    expect(captured!.pnl).toBeGreaterThan(0);
  });

  it('writes unrealized PnL for short', async () => {
    const trade = tradeFixture({
      side: 'sell',
      entry_price: 100,
      size_usd: 1000,
      pnl_usd: null,
    });
    let captured = 0;
    const deps = makeDeps({
      getOpenTrades: async () => [trade],
      getCryptoPrice: async () =>
        ok({ symbol: 'BTC', priceUsd: 110, change24hPct: 0, marketCapUsd: 0, volumeUsd24h: 0 }),
      updateOpenTradePnl: async (_db, _id, pnl) => {
        captured = pnl;
      },
    });
    await markOpenTradesToMarket(FAKE_DB, deps);
    // short up 10% → negative PnL
    expect(captured).toBeLessThan(0);
  });

  it('marks polymarket trades using orderbook mid', async () => {
    const trade = tradeFixture({
      instrument_kind: 'polymarket',
      instrument_id: 'will-x-happen',
      side: 'yes',
      entry_price: 0.5,
      size_usd: 100,
      pnl_usd: null,
    });
    let captured: number | null = null;
    const deps = makeDeps({
      getOpenTrades: async () => [trade],
      getPolymarketOrderbook: async (slug, outcome) =>
        ok({
          slug,
          outcome,
          clobTokenId: 'tok',
          bestBid: 0.59,
          bestAsk: 0.61,
          spread: 0.02,
          midPrice: 0.60,
          bidDepthUsd: 100,
          askDepthUsd: 100,
          bids: [],
          asks: [],
          timestamp: new Date().toISOString(),
        }),
      updateOpenTradePnl: async (_db, _id, pnl) => {
        captured = pnl;
      },
    });
    await markOpenTradesToMarket(FAKE_DB, deps);
    expect(captured).not.toBeNull();
    expect(captured!).toBeGreaterThan(0);
  });

  it('skips write when value is within $0.01 of previous', async () => {
    // For long entry=100, size=1000, exit slippage 5bps, fees 10bps round-trip:
    // exit = 110 * 0.9995 = 109.945; gross = 99.45; minus $2 fees = $97.45
    const trade = tradeFixture({
      side: 'buy',
      entry_price: 100,
      size_usd: 1000,
      pnl_usd: 97.45,
    });
    let writeCount = 0;
    const deps = makeDeps({
      getOpenTrades: async () => [trade],
      getCryptoPrice: async () =>
        ok({ symbol: 'BTC', priceUsd: 110, change24hPct: 0, marketCapUsd: 0, volumeUsd24h: 0 }),
      updateOpenTradePnl: async () => {
        writeCount++;
      },
    });
    const summary = await markOpenTradesToMarket(FAKE_DB, deps);
    expect(writeCount).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it('skips trades when price fetch fails', async () => {
    const trade = tradeFixture({ pnl_usd: null });
    const deps = makeDeps({
      getOpenTrades: async () => [trade],
      getCryptoPrice: async () => err('rate-limited'),
    });
    const summary = await markOpenTradesToMarket(FAKE_DB, deps);
    expect(summary.updated).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it('skips "other" instrument kind', async () => {
    const trade = tradeFixture({ instrument_kind: 'other', pnl_usd: null });
    const deps = makeDeps({
      getOpenTrades: async () => [trade],
    });
    const summary = await markOpenTradesToMarket(FAKE_DB, deps);
    expect(summary.updated).toBe(0);
    expect(summary.skipped).toBe(1);
  });
});
