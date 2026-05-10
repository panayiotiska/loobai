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
    // Fetch current price as entry price
    let entryPrice = 0;
    if (input.instrument_kind === 'crypto') {
      const priceResult = await getCryptoPrice(input.instrument_id);
      if (!priceResult.ok) return err(`Could not fetch entry price: ${priceResult.error}`);
      entryPrice = priceResult.data.priceUsd;
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

    const trade = trades[0];
    let exitPrice = trade.entry_price;

    if (trade.instrument_kind === 'crypto') {
      const priceResult = await getCryptoPrice(trade.instrument_id);
      if (priceResult.ok) exitPrice = priceResult.data.priceUsd;
    }

    const priceChangePct = (exitPrice - trade.entry_price) / trade.entry_price;
    const pnl = trade.side === 'buy' || trade.side === 'yes'
      ? trade.size_usd * priceChangePct
      : trade.size_usd * -priceChangePct;

    await closeTrade(db, input.trade_id, exitPrice, pnl);

    return ok({ trade_id: input.trade_id, pnl_usd: pnl, exit_price: exitPrice });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export async function paperTradeListOpen(db: DB): Promise<Result<Trade[]>> {
  try {
    const trades = await getOpenTrades(db);
    return ok(trades);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
