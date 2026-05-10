import type { SupabaseClient } from '@supabase/supabase-js';
import type { Trade } from '@loob/db';
import {
  insertTrade,
  closeTrade,
  getOpenTrades,
} from '@loob/db';
import type { Result } from '@loob/shared';
import { ok, err } from '@loob/shared';
import { getCryptoPrice } from './market-data.js';

const DEFAULT_MAX_OPEN_EXPOSURE_USD = 10_000;
const DEFAULT_SLIPPAGE_BPS = 5;
const DEFAULT_FEE_BPS = 10;

function maxOpenExposureUsd(): number {
  const raw = process.env.MAX_OPEN_EXPOSURE_USD;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_OPEN_EXPOSURE_USD;
}

function slippageBps(): number {
  const raw = process.env.PAPER_SLIPPAGE_BPS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SLIPPAGE_BPS;
}

function feeBps(): number {
  const raw = process.env.PAPER_FEE_BPS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_FEE_BPS;
}

function applyEntrySlippage(price: number, side: Trade['side']): number {
  const slip = slippageBps() / 10_000;
  return side === 'buy' || side === 'yes' ? price * (1 + slip) : price * (1 - slip);
}

function applyExitSlippage(price: number, side: Trade['side']): number {
  const slip = slippageBps() / 10_000;
  return side === 'buy' || side === 'yes' ? price * (1 - slip) : price * (1 + slip);
}

function roundTripFeeUsd(sizeUsd: number): number {
  return (2 * feeBps() * sizeUsd) / 10_000;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any>;

export interface PaperTradeOpenInput {
  instrument_kind: 'crypto' | 'polymarket' | 'other';
  instrument_id: string;
  instrument_label?: string;
  side: Trade['side'];
  size_usd: number;
  thesis: string;
  exit_criteria: {
    take_profit?: number;
    stop_loss?: number;
    time_limit?: string;
    conditions?: string;
  };
}

export async function paperTradeOpen(
  db: DB,
  runId: string,
  input: PaperTradeOpenInput,
): Promise<Result<Trade>> {
  try {
    if (!(input.size_usd > 0)) {
      return err(`size_usd must be positive (got ${input.size_usd})`);
    }

    const cap = maxOpenExposureUsd();
    const openTrades = await getOpenTrades(db);
    const currentExposure = openTrades.reduce((s, t) => s + t.size_usd, 0);
    if (currentExposure + input.size_usd > cap) {
      return err(
        `Exposure cap exceeded: would push open notional from $${currentExposure.toFixed(2)} to $${(
          currentExposure + input.size_usd
        ).toFixed(2)} (cap $${cap}). Close a position or reduce size.`,
      );
    }

    // Fetch current price as entry price
    let entryPrice = 0;
    if (input.instrument_kind === 'crypto') {
      const priceResult = await getCryptoPrice(input.instrument_id);
      if (!priceResult.ok) return err(`Could not fetch entry price: ${priceResult.error}`);
      entryPrice = applyEntrySlippage(priceResult.data.priceUsd, input.side);
    } else {
      // For non-crypto instruments, caller must provide price via instrument_id hack
      // TODO: fetch from appropriate source based on instrument_kind
      entryPrice = 1.0;
    }

    const trade = await insertTrade(db, {
      run_id: runId,
      mode: 'paper',
      instrument_kind: input.instrument_kind,
      instrument_id: input.instrument_id,
      instrument_label: input.instrument_label ?? null,
      side: input.side,
      size_usd: input.size_usd,
      entry_price: entryPrice,
      exit_price: null,
      status: 'open',
      thesis: input.thesis,
      exit_criteria: input.exit_criteria,
      pnl_usd: null,
      closed_at: null,
    });

    return ok(trade);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export interface PaperTradeCloseInput {
  trade_id: string;
  reason: string;
}

export async function paperTradeClose(
  db: DB,
  input: PaperTradeCloseInput,
): Promise<Result<{ trade_id: string; pnl_usd: number; exit_price: number }>> {
  try {
    // Fetch the trade first
    const { data: trades, error } = await db
      .from('trades')
      .select()
      .eq('id', input.trade_id)
      .eq('status', 'open')
      .limit(1);

    if (error) return err(error.message);
    if (!trades || trades.length === 0) return err(`Trade ${input.trade_id} not found or already closed`);

    const trade = trades[0] as Trade;
    let rawExitPrice = trade.entry_price;

    if (trade.instrument_kind === 'crypto') {
      const priceResult = await getCryptoPrice(trade.instrument_id);
      if (priceResult.ok) rawExitPrice = priceResult.data.priceUsd;
    }

    const exitPrice = applyExitSlippage(rawExitPrice, trade.side);
    const pnl = computePnl(trade, exitPrice);

    await closeTrade(db, input.trade_id, exitPrice, pnl);

    return ok({ trade_id: input.trade_id, pnl_usd: pnl, exit_price: exitPrice });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

function computePnl(trade: Trade, exitPrice: number): number {
  if (!(trade.entry_price > 0)) return 0;
  const priceChangePct = (exitPrice - trade.entry_price) / trade.entry_price;
  const directional = trade.side === 'buy' || trade.side === 'yes'
    ? trade.size_usd * priceChangePct
    : trade.size_usd * -priceChangePct;
  return directional - roundTripFeeUsd(trade.size_usd);
}

export interface AutoCloseSummary {
  closed: Array<{ trade_id: string; reason: string; exit_price: number; pnl_usd: number }>;
  errors: Array<{ trade_id: string; error: string }>;
}

/**
 * Deterministically close paper trades whose TP/SL/time_limit has been hit.
 * Runs BEFORE the LLM in monitor ticks so the agent doesn't need to remember
 * every exit condition itself.
 */
export async function autoCloseTriggeredTrades(db: DB): Promise<AutoCloseSummary> {
  const summary: AutoCloseSummary = { closed: [], errors: [] };
  const open = await getOpenTrades(db);
  const now = Date.now();

  for (const trade of open) {
    try {
      const exit = trade.exit_criteria as {
        take_profit?: number;
        stop_loss?: number;
        time_limit?: string;
      };

      // Time limit hit
      if (exit?.time_limit) {
        const limitMs = new Date(exit.time_limit).getTime();
        if (Number.isFinite(limitMs) && limitMs <= now) {
          await closeAt(db, trade, 'time_limit_reached', summary);
          continue;
        }
      }

      // Price-based exits only meaningful for crypto right now (we have spot price)
      if (trade.instrument_kind !== 'crypto') continue;

      const priceResult = await getCryptoPrice(trade.instrument_id);
      if (!priceResult.ok) continue;
      const price = priceResult.data.priceUsd;

      const isLong = trade.side === 'buy' || trade.side === 'yes';

      if (exit?.take_profit != null) {
        const hit = isLong ? price >= exit.take_profit : price <= exit.take_profit;
        if (hit) {
          await closeAt(db, trade, 'take_profit_hit', summary, price);
          continue;
        }
      }
      if (exit?.stop_loss != null) {
        const hit = isLong ? price <= exit.stop_loss : price >= exit.stop_loss;
        if (hit) {
          await closeAt(db, trade, 'stop_loss_hit', summary, price);
          continue;
        }
      }
    } catch (e) {
      summary.errors.push({ trade_id: trade.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return summary;
}

async function closeAt(
  db: DB,
  trade: Trade,
  reason: string,
  summary: AutoCloseSummary,
  rawPriceOverride?: number,
): Promise<void> {
  let rawExit = trade.entry_price;
  if (rawPriceOverride != null) {
    rawExit = rawPriceOverride;
  } else if (trade.instrument_kind === 'crypto') {
    const priceResult = await getCryptoPrice(trade.instrument_id);
    if (priceResult.ok) rawExit = priceResult.data.priceUsd;
  }
  const exitPrice = applyExitSlippage(rawExit, trade.side);
  const pnl = computePnl(trade, exitPrice);
  await closeTrade(db, trade.id, exitPrice, pnl);
  summary.closed.push({ trade_id: trade.id, reason, exit_price: exitPrice, pnl_usd: pnl });
}

export async function paperTradeListOpen(db: DB): Promise<Result<Trade[]>> {
  try {
    const trades = await getOpenTrades(db);
    return ok(trades);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
