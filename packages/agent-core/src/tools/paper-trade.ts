import type { SupabaseClient } from '@supabase/supabase-js';
import type { Trade } from '@loob/db';
import {
  insertTrade,
  closeTrade,
  getOpenTrades,
  updateOpenTradePnl,
} from '@loob/db';
import type { Result } from '@loob/shared';
import { ok, err } from '@loob/shared';
import { getCryptoPrice } from './market-data.js';
import { getPolymarketOrderbook } from './market-data.js';

const DEFAULT_MAX_OPEN_EXPOSURE_USD = 10_000;
const DEFAULT_SLIPPAGE_BPS = 5;
const DEFAULT_FEE_BPS = 10;
const DEFAULT_CONFIDENCE = 0.5;

export function maxOpenExposureUsd(): number {
  const raw = process.env.MAX_OPEN_EXPOSURE_USD;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_OPEN_EXPOSURE_USD;
}

export function slippageBps(): number {
  const raw = process.env.PAPER_SLIPPAGE_BPS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SLIPPAGE_BPS;
}

export function feeBps(): number {
  const raw = process.env.PAPER_FEE_BPS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_FEE_BPS;
}

export function applyEntrySlippage(price: number, side: Trade['side']): number {
  const slip = slippageBps() / 10_000;
  return side === 'buy' || side === 'yes' ? price * (1 + slip) : price * (1 - slip);
}

export function applyExitSlippage(price: number, side: Trade['side']): number {
  const slip = slippageBps() / 10_000;
  return side === 'buy' || side === 'yes' ? price * (1 - slip) : price * (1 + slip);
}

export function roundTripFeeUsd(sizeUsd: number): number {
  return (2 * feeBps() * sizeUsd) / 10_000;
}

export function computePnl(trade: Trade, exitPrice: number): number {
  if (!(trade.entry_price > 0)) return 0;
  const priceChangePct = (exitPrice - trade.entry_price) / trade.entry_price;
  const directional = trade.side === 'buy' || trade.side === 'yes'
    ? trade.size_usd * priceChangePct
    : trade.size_usd * -priceChangePct;
  return directional - roundTripFeeUsd(trade.size_usd);
}

/**
 * Squared confidence curve: max_size = cap * confidence^2.
 * 0.5 conf → 25% of cap; 0.8 conf → 64% of cap; 1.0 conf → full cap.
 * Penalizes low-conviction trades sharply.
 */
export function maxSizeForConfidence(cap: number, confidence: number): number {
  const clamped = Math.max(0, Math.min(1, confidence));
  return cap * clamped * clamped;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any>;

export interface PaperTradeDeps {
  insertTrade: typeof insertTrade;
  closeTrade: typeof closeTrade;
  getOpenTrades: typeof getOpenTrades;
  updateOpenTradePnl: typeof updateOpenTradePnl;
  getCryptoPrice: typeof getCryptoPrice;
  getPolymarketOrderbook: typeof getPolymarketOrderbook;
  now: () => number;
}

const defaultDeps: PaperTradeDeps = {
  insertTrade,
  closeTrade,
  getOpenTrades,
  updateOpenTradePnl,
  getCryptoPrice,
  getPolymarketOrderbook,
  now: () => Date.now(),
};

export interface PaperTradeOpenInput {
  instrument_kind: 'crypto' | 'polymarket' | 'other';
  instrument_id: string;
  instrument_label?: string;
  side: Trade['side'];
  size_usd: number;
  thesis: string;
  confidence?: number | null;
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
  deps: PaperTradeDeps = defaultDeps,
): Promise<Result<Trade>> {
  try {
    if (!(input.size_usd > 0)) {
      return err(`size_usd must be positive (got ${input.size_usd})`);
    }

    const rawConfidence = input.confidence;
    const confidence = rawConfidence == null || !Number.isFinite(rawConfidence)
      ? DEFAULT_CONFIDENCE
      : Math.max(0, Math.min(1, rawConfidence));

    const cap = maxOpenExposureUsd();

    const maxForConfidence = maxSizeForConfidence(cap, confidence);
    if (input.size_usd > maxForConfidence) {
      return err(
        `Confidence cap exceeded: confidence ${confidence.toFixed(2)} permits up to $${maxForConfidence.toFixed(2)} per trade (cap × conf² = $${cap} × ${confidence.toFixed(2)}²). Reduce size_usd or raise confidence honestly.`,
      );
    }

    const openTrades = await deps.getOpenTrades(db);
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
      const priceResult = await deps.getCryptoPrice(input.instrument_id);
      if (!priceResult.ok) return err(`Could not fetch entry price: ${priceResult.error}`);
      entryPrice = applyEntrySlippage(priceResult.data.priceUsd, input.side);
    } else if (input.instrument_kind === 'polymarket') {
      const mark = await polymarketMarkPrice(deps, input.instrument_id, input.side);
      if (mark == null) {
        return err(`Could not fetch Polymarket mark price for ${input.instrument_id}/${input.side}`);
      }
      entryPrice = applyEntrySlippage(mark, input.side);
    } else {
      entryPrice = 1.0;
    }

    const trade = await deps.insertTrade(db, {
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
      confidence,
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
  deps: PaperTradeDeps = defaultDeps,
): Promise<Result<{ trade_id: string; pnl_usd: number; exit_price: number }>> {
  try {
    const { data: trades, error } = await db
      .from('trades')
      .select()
      .eq('id', input.trade_id)
      .eq('status', 'open')
      .limit(1);

    if (error) return err(error.message);
    if (!trades || trades.length === 0) return err(`Trade ${input.trade_id} not found or already closed`);

    const trade = trades[0] as Trade;
    const rawExitPrice = await fetchRawMarkPrice(deps, trade);
    const fallback = rawExitPrice ?? trade.entry_price;
    const exitPrice = applyExitSlippage(fallback, trade.side);
    const pnl = computePnl(trade, exitPrice);

    await deps.closeTrade(db, input.trade_id, exitPrice, pnl);

    return ok({ trade_id: input.trade_id, pnl_usd: pnl, exit_price: exitPrice });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export interface AutoCloseSummary {
  closed: Array<{ trade_id: string; reason: string; exit_price: number; pnl_usd: number }>;
  errors: Array<{ trade_id: string; error: string }>;
}

/**
 * Deterministically close paper trades whose TP/SL/time_limit has been hit.
 * Runs BEFORE the LLM each tick so the agent doesn't need to remember
 * every exit condition itself.
 */
export async function autoCloseTriggeredTrades(
  db: DB,
  deps: PaperTradeDeps = defaultDeps,
): Promise<AutoCloseSummary> {
  const summary: AutoCloseSummary = { closed: [], errors: [] };
  const open = await deps.getOpenTrades(db);
  const now = deps.now();

  for (const trade of open) {
    try {
      const exit = trade.exit_criteria as {
        take_profit?: number;
        stop_loss?: number;
        time_limit?: string;
      };

      if (exit?.time_limit) {
        const limitMs = new Date(exit.time_limit).getTime();
        if (Number.isFinite(limitMs) && limitMs <= now) {
          await closeAt(db, trade, 'time_limit_reached', summary, deps);
          continue;
        }
      }

      const price = await fetchRawMarkPrice(deps, trade);
      if (price == null) continue;

      const isLong = trade.side === 'buy' || trade.side === 'yes';

      if (exit?.take_profit != null) {
        const hit = isLong ? price >= exit.take_profit : price <= exit.take_profit;
        if (hit) {
          await closeAt(db, trade, 'take_profit_hit', summary, deps, price);
          continue;
        }
      }
      if (exit?.stop_loss != null) {
        const hit = isLong ? price <= exit.stop_loss : price >= exit.stop_loss;
        if (hit) {
          await closeAt(db, trade, 'stop_loss_hit', summary, deps, price);
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
  deps: PaperTradeDeps,
  rawPriceOverride?: number,
): Promise<void> {
  const rawExit =
    rawPriceOverride != null
      ? rawPriceOverride
      : ((await fetchRawMarkPrice(deps, trade)) ?? trade.entry_price);
  const exitPrice = applyExitSlippage(rawExit, trade.side);
  const pnl = computePnl(trade, exitPrice);
  await deps.closeTrade(db, trade.id, exitPrice, pnl);
  summary.closed.push({ trade_id: trade.id, reason, exit_price: exitPrice, pnl_usd: pnl });
}

export interface MarkToMarketSummary {
  updated: number;
  skipped: number;
  errors: Array<{ trade_id: string; error: string }>;
}

/**
 * Refresh `pnl_usd` on every open trade by marking to current market.
 * Uses cached spot for crypto and orderbook mid-price for Polymarket.
 * Skips writes that change the value by less than $0.01.
 */
export async function markOpenTradesToMarket(
  db: DB,
  deps: PaperTradeDeps = defaultDeps,
): Promise<MarkToMarketSummary> {
  const summary: MarkToMarketSummary = { updated: 0, skipped: 0, errors: [] };
  const open = await deps.getOpenTrades(db);

  for (const trade of open) {
    try {
      const raw = await fetchRawMarkPrice(deps, trade);
      if (raw == null) {
        summary.skipped++;
        continue;
      }
      const markPrice = applyExitSlippage(raw, trade.side);
      const pnl = computePnl(trade, markPrice);
      if (trade.pnl_usd != null && Math.abs(pnl - trade.pnl_usd) < 0.01) {
        summary.skipped++;
        continue;
      }
      await deps.updateOpenTradePnl(db, trade.id, pnl);
      summary.updated++;
    } catch (e) {
      summary.errors.push({ trade_id: trade.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return summary;
}

async function fetchRawMarkPrice(deps: PaperTradeDeps, trade: Trade): Promise<number | null> {
  if (trade.instrument_kind === 'crypto') {
    const priceResult = await deps.getCryptoPrice(trade.instrument_id);
    return priceResult.ok ? priceResult.data.priceUsd : null;
  }
  if (trade.instrument_kind === 'polymarket') {
    return polymarketMarkPrice(deps, trade.instrument_id, trade.side);
  }
  return null;
}

async function polymarketMarkPrice(
  deps: PaperTradeDeps,
  slug: string,
  side: Trade['side'],
): Promise<number | null> {
  if (side !== 'yes' && side !== 'no') return null;
  const outcome = side === 'yes' ? 'Yes' : 'No';
  const book = await deps.getPolymarketOrderbook(slug, outcome, 5);
  if (!book.ok) return null;
  if (book.data.midPrice != null) return book.data.midPrice;
  if (book.data.bestBid != null) return book.data.bestBid;
  if (book.data.bestAsk != null) return book.data.bestAsk;
  return null;
}

export async function paperTradeListOpen(
  db: DB,
  deps: PaperTradeDeps = defaultDeps,
): Promise<Result<Trade[]>> {
  try {
    const trades = await deps.getOpenTrades(db);
    return ok(trades);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
