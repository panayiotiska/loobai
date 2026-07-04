import type { SupabaseClient } from '@supabase/supabase-js';
import type { Trade, TradePostmortem } from '@loob/db';
import {
  insertTrade,
  closeTrade,
  getOpenTrades,
  updateOpenTradePnl,
  updateOpenTradeCarry,
  updateOpenTradePeak,
  updateOpenTradeExitCriteria,
  getSetupBreakdown,
} from '@loob/db';
import type { Result } from '@loob/shared';
import { ok, err } from '@loob/shared';
import { getCryptoPrice } from './market-data.js';
import { getPolymarketOrderbook } from './market-data.js';
import { getCryptoDerivatives } from './derivatives.js';
import { validateSetup } from './setup-validation.js';
import { sizingTierForSetup, maxAllowedSize, MIN_TRADE_USD } from '../sizing.js';

const DEFAULT_MAX_OPEN_EXPOSURE_USD = 10_000;
const DEFAULT_SLIPPAGE_BPS = 5;
const DEFAULT_FEE_BPS = 10;
const DEFAULT_CONFIDENCE = 0.5;

// Tiered conviction gate. Scout = small, exploratory; conviction = full size.
// Scout exists so the agent can act on plausible edges without the full
// 0.65/2-signal bar — otherwise it sits in a permanent no-op loop.
const MIN_SCOUT_CONFIDENCE = 0.55;
const MIN_CONVICTION_CONFIDENCE = 0.65;
// Soft post-entry exposure cap. v2 wants 1-2 simultaneous positions, not 5.
const POST_ENTRY_EXPOSURE_FRACTION = 0.5;
// Scouts share a tighter sub-budget so they can't crowd out conviction trades.
const SCOUT_EXPOSURE_FRACTION = 0.2;
// Scouts are size-capped to a fraction of cap, regardless of confidence math.
const SCOUT_SIZE_FRACTION = 0.25;
const MIN_CONFIRMING_SIGNALS_CONVICTION = 2;
const MIN_CONFIRMING_SIGNALS_SCOUT = 1;
// Correlation control: same-regime scouts are effectively one macro bet, not
// independent samples (June 2026: 7 concurrent long-alt scouts in extreme fear
// = a single leveraged "market bounces" wager). Cap concurrency hard.
const MAX_CONCURRENT_SCOUTS = 3;

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
  // 0006: hedged carry positions are delta-neutral — the modeled spot leg
  // cancels the perp price leg. PnL is the funding stream minus doubled fees
  // (two legs to open, two to close).
  if (trade.hedged) {
    return (trade.funding_accrued_usd ?? 0) - 2 * roundTripFeeUsd(trade.size_usd);
  }
  if (!(trade.entry_price > 0)) return 0;
  const priceChangePct = (exitPrice - trade.entry_price) / trade.entry_price;
  const directional = trade.side === 'buy' || trade.side === 'yes'
    ? trade.size_usd * priceChangePct
    : trade.size_usd * -priceChangePct;
  // 0005: funding carry accrued while open (see accrueFundingCarry). Without
  // this the squeeze-scout thesis — "crowded shorts pay longs" — was invisible
  // to the scoreboard: P&L measured price return only.
  return directional + (trade.funding_accrued_usd ?? 0) - roundTripFeeUsd(trade.size_usd);
}

// --- 0006: trailing-stop math (pure, unit-tested) ---

export function nextPeakPrice(
  side: Trade['side'],
  prevPeak: number | null,
  entryPrice: number,
  price: number,
): number {
  const isLong = side === 'buy' || side === 'yes';
  const base = prevPeak ?? entryPrice;
  return isLong ? Math.max(base, price) : Math.min(base, price);
}

export function trailingStopTriggered(
  side: Trade['side'],
  peak: number,
  price: number,
  trailingPct: number,
): boolean {
  if (!(trailingPct > 0) || !(peak > 0)) return false;
  const isLong = side === 'buy' || side === 'yes';
  return isLong
    ? price <= peak * (1 - trailingPct / 100)
    : price >= peak * (1 + trailingPct / 100);
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
  updateOpenTradeCarry: typeof updateOpenTradeCarry;
  updateOpenTradePeak: typeof updateOpenTradePeak;
  updateOpenTradeExitCriteria: typeof updateOpenTradeExitCriteria;
  getSetupBreakdown: typeof getSetupBreakdown;
  getCryptoPrice: typeof getCryptoPrice;
  getCryptoDerivatives: typeof getCryptoDerivatives;
  getPolymarketOrderbook: typeof getPolymarketOrderbook;
  validateSetup: typeof validateSetup;
  now: () => number;
}

const defaultDeps: PaperTradeDeps = {
  insertTrade,
  closeTrade,
  getOpenTrades,
  updateOpenTradePnl,
  updateOpenTradeCarry,
  updateOpenTradePeak,
  updateOpenTradeExitCriteria,
  getSetupBreakdown,
  getCryptoPrice,
  getCryptoDerivatives,
  getPolymarketOrderbook,
  validateSetup,
  now: () => Date.now(),
};

export type TradeSizeClass = 'scout' | 'conviction';

export interface PaperTradeOpenInput {
  instrument_kind: 'crypto' | 'polymarket' | 'other';
  instrument_id: string;
  instrument_label?: string;
  side: Trade['side'];
  size_usd: number;
  size_class?: TradeSizeClass;
  // v3: required setup classification — the setup's defining condition is
  // verified server-side (see setup-validation.ts).
  setup_type?: string;
  thesis: string;
  confidence?: number | null;
  exit_criteria: {
    take_profit?: number;
    stop_loss?: number;
    time_limit?: string;
    // v3: retrace from the favorable price extreme (peak_price) that closes
    // the trade. Preferred over tight fixed TPs — lets winners run.
    trailing_stop_pct?: number;
    conditions?: string;
  };
  // v2: adversarial rationale (REQUIRED for paper_trade_open)
  regime_at_entry?: string;
  retail_view?: string;
  institutional_view?: string;
  adversarial_view?: string;
  confirming_signals?: Array<{ kind: string; evidence: string }>;
  invalidation_signal?: string;
  expected_holding_period?: string;
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
    if (input.size_usd < MIN_TRADE_USD) {
      return err(
        `Minimum trade size is $${MIN_TRADE_USD} (got $${input.size_usd}) — sub-$${MIN_TRADE_USD} positions are noise after 20bps fees + 10bps slippage ` +
          `(this regression appeared after the June 30 formula wipe). Resize to ≥ $${MIN_TRADE_USD} or skip.`,
      );
    }

    const rawConfidence = input.confidence;
    const confidence = rawConfidence == null || !Number.isFinite(rawConfidence)
      ? DEFAULT_CONFIDENCE
      : Math.max(0, Math.min(1, rawConfidence));

    const sizeClass: TradeSizeClass = input.size_class ?? 'conviction';
    const minConfidence = sizeClass === 'scout' ? MIN_SCOUT_CONFIDENCE : MIN_CONVICTION_CONFIDENCE;
    const minSignals =
      sizeClass === 'scout' ? MIN_CONFIRMING_SIGNALS_SCOUT : MIN_CONFIRMING_SIGNALS_CONVICTION;

    if (confidence < minConfidence) {
      return err(
        `Conviction gate (${sizeClass}): confidence ${confidence.toFixed(2)} < ${minConfidence} minimum. ` +
          (sizeClass === 'conviction'
            ? `Downgrade to size_class='scout' (min 0.55) or skip and add to watchlist.`
            : `Even a scout requires ≥${MIN_SCOUT_CONFIDENCE} confidence — articulate what would push it there.`),
      );
    }

    // Three-perspective rationale REQUIRED for both tiers — scout just needs fewer signals.
    const missingFields: string[] = [];
    if (!input.retail_view || input.retail_view.trim().length < 20) missingFields.push('retail_view');
    if (!input.institutional_view || input.institutional_view.trim().length < 20)
      missingFields.push('institutional_view');
    if (!input.adversarial_view || input.adversarial_view.trim().length < 20)
      missingFields.push('adversarial_view');
    if (!input.invalidation_signal || input.invalidation_signal.trim().length < 10)
      missingFields.push('invalidation_signal');
    const signals = input.confirming_signals ?? [];
    if (signals.length < minSignals)
      missingFields.push(`confirming_signals (need ≥${minSignals} for ${sizeClass})`);
    if (missingFields.length > 0) {
      return err(
        `Adversarial rationale incomplete for ${sizeClass}. Missing or too short: ${missingFields.join(', ')}. ` +
          `Articulate retail / institutional / adversarial views (≥20 chars each), a concrete invalidation signal, ` +
          `and at least ${minSignals} independent confirming signals before opening.`,
      );
    }

    // v3: verify the setup's defining condition against live market data.
    // The June churn (squeeze scouts at −13% funding when the rule said −30%)
    // happened because the rule lived only in the prompt.
    const setupCheck = await deps.validateSetup({
      setup_type: input.setup_type,
      instrument_kind: input.instrument_kind,
      instrument_id: input.instrument_id,
      side: input.side,
      size_class: sizeClass,
    });
    if (!setupCheck.ok) return setupCheck;
    const { setupType, hedged } = setupCheck.data;

    // v3: deterministic sizing ladder — each setup earns size from its own
    // realized results. The agent proposes, code clamps.
    const breakdown = await deps.getSetupBreakdown(db);
    const tier = sizingTierForSetup(breakdown[setupType]);
    const ladderMax = maxAllowedSize(tier.baseUsd, confidence);
    if (input.size_usd > ladderMax) {
      return err(
        `Sizing ladder (code-decided): ${setupType} is at ${tier.reason}. ` +
          `Requested $${input.size_usd} > allowed $${ladderMax.toFixed(0)} at confidence ${confidence.toFixed(2)}. ` +
          `Sizes scale automatically as the setup proves itself in realized results — resize to ≤ $${ladderMax.toFixed(0)}.`,
      );
    }

    const cap = maxOpenExposureUsd();

    // Scout has a hard per-trade size cap; conviction uses confidence² curve.
    if (sizeClass === 'scout') {
      const scoutMax = cap * SCOUT_SIZE_FRACTION;
      if (input.size_usd > scoutMax) {
        return err(
          `Scout size cap exceeded: scout trades capped at $${scoutMax.toFixed(0)} (${SCOUT_SIZE_FRACTION * 100}% of $${cap}). Reduce size_usd or open as size_class='conviction' (requires ≥${MIN_CONVICTION_CONFIDENCE} confidence + ≥${MIN_CONFIRMING_SIGNALS_CONVICTION} signals).`,
        );
      }
    } else {
      const maxForConfidence = maxSizeForConfidence(cap, confidence);
      if (input.size_usd > maxForConfidence) {
        return err(
          `Confidence cap exceeded: confidence ${confidence.toFixed(2)} permits up to $${maxForConfidence.toFixed(2)} per trade (cap × conf² = $${cap} × ${confidence.toFixed(2)}²). Reduce size_usd or raise confidence honestly.`,
        );
      }
    }

    const openTrades = await deps.getOpenTrades(db);
    const currentExposure = openTrades.reduce((s, t) => s + t.size_usd, 0);
    const postEntryCap = cap * POST_ENTRY_EXPOSURE_FRACTION;
    if (currentExposure + input.size_usd > postEntryCap) {
      return err(
        `Exposure cap exceeded: would push open notional from $${currentExposure.toFixed(2)} to $${(
          currentExposure + input.size_usd
        ).toFixed(2)} (v2 post-entry cap $${postEntryCap.toFixed(0)} = ${POST_ENTRY_EXPOSURE_FRACTION * 100}% of $${cap}). Close a position or reduce size.`,
      );
    }

    // Scout sub-budget — scouts share 20% of cap so they can't crowd conviction trades.
    if (sizeClass === 'scout') {
      const openScouts = openTrades.filter((t) => t.size_class === 'scout');
      // Correlation control: concurrent same-direction scouts in one regime are
      // a single macro bet, not independent samples. Hard cap at 3.
      if (openScouts.length >= MAX_CONCURRENT_SCOUTS) {
        return err(
          `Scout concurrency cap: ${openScouts.length} scouts already open (max ${MAX_CONCURRENT_SCOUTS}). ` +
            `Concurrent scouts in the same regime are correlated — they validate nothing as a group. ` +
            `Close one first, or add this to the watchlist with the trigger that would justify replacing an open scout.`,
        );
      }
      const scoutExposure = openScouts.reduce((s, t) => s + t.size_usd, 0);
      const scoutCap = cap * SCOUT_EXPOSURE_FRACTION;
      if (scoutExposure + input.size_usd > scoutCap) {
        return err(
          `Scout sub-budget exceeded: current scout exposure $${scoutExposure.toFixed(2)} + $${input.size_usd} > scout cap $${scoutCap.toFixed(0)} (${SCOUT_EXPOSURE_FRACTION * 100}% of $${cap}). Close a scout or open this as size_class='conviction'.`,
        );
      }
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
      regime_at_entry: input.regime_at_entry ?? null,
      retail_view: input.retail_view ?? null,
      institutional_view: input.institutional_view ?? null,
      adversarial_view: input.adversarial_view ?? null,
      confirming_signals: signals,
      invalidation_signal: input.invalidation_signal ?? null,
      expected_holding_period: input.expected_holding_period ?? null,
      postmortem: null,
      size_class: sizeClass,
      funding_accrued_usd: 0,
      carry_accrued_at: null,
      setup_type: setupType,
      hedged,
      peak_price: null,
    });

    return ok(trade);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export interface PaperTradeCloseInput {
  trade_id: string;
  reason: string;
  // v2: structured postmortem REQUIRED on discretionary close. The auto-close path
  // (TP/SL/time_limit) skips this requirement since it's mechanical, not discretionary.
  postmortem?: TradePostmortem;
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

    // v2: discretionary closes must carry a structured postmortem so closed trades
    // produce readable lessons on the next run.
    const pm = input.postmortem;
    if (
      !pm ||
      typeof pm.thesis_correct !== 'boolean' ||
      !pm.what_we_missed ||
      pm.what_we_missed.trim().length < 10 ||
      !pm.lesson ||
      pm.lesson.trim().length < 10 ||
      (pm.luck_or_skill !== 'luck' && pm.luck_or_skill !== 'skill' && pm.luck_or_skill !== 'mixed')
    ) {
      return err(
        'Postmortem required: pass postmortem={ thesis_correct: bool, what_we_missed: string (≥10 chars), luck_or_skill: "luck"|"skill"|"mixed", lesson: string (≥10 chars) }. Free-text reason alone is no longer accepted.',
      );
    }

    const rawExitPrice = await fetchRawMarkPrice(deps, trade);
    const fallback = rawExitPrice ?? trade.entry_price;
    const exitPrice = applyExitSlippage(fallback, trade.side);
    const pnl = computePnl(trade, exitPrice);

    await deps.closeTrade(db, input.trade_id, exitPrice, pnl, pm);

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
        trailing_stop_pct?: number;
      };

      if (exit?.time_limit) {
        const limitMs = new Date(exit.time_limit).getTime();
        if (Number.isFinite(limitMs) && limitMs <= now) {
          await closeAt(db, trade, 'time_limit_reached', summary, deps);
          continue;
        }
      }

      // 0006: hedged carry positions have no price leg — price-based triggers
      // don't apply (the carry-decay auto-close lives in accrueFundingCarry).
      if (trade.hedged) continue;

      const price = await fetchRawMarkPrice(deps, trade);
      if (price == null) continue;

      const isLong = trade.side === 'buy' || trade.side === 'yes';

      // 0006: track the favorable extreme since entry for trailing stops.
      const peak = nextPeakPrice(trade.side, trade.peak_price, trade.entry_price, price);
      if (trade.peak_price == null || peak !== trade.peak_price) {
        await deps.updateOpenTradePeak(db, trade.id, peak);
      }

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
      if (exit?.trailing_stop_pct != null && trailingStopTriggered(trade.side, peak, price, exit.trailing_stop_pct)) {
        await closeAt(db, trade, 'trailing_stop_hit', summary, deps, price);
        continue;
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
  // Hedged trades have no price leg — computePnl ignores exit price, so skip the fetch.
  const rawExit =
    rawPriceOverride != null
      ? rawPriceOverride
      : trade.hedged
        ? trade.entry_price
        : ((await fetchRawMarkPrice(deps, trade)) ?? trade.entry_price);
  const exitPrice = applyExitSlippage(rawExit, trade.side);
  const pnl = computePnl(trade, exitPrice);
  await deps.closeTrade(db, trade.id, exitPrice, pnl);
  summary.closed.push({ trade_id: trade.id, reason, exit_price: exitPrice, pnl_usd: pnl });
}

export interface CarryAccrualSummary {
  accrued: number;
  skipped: number;
  // 0006: S1 stops tightened to breakeven because funding flipped positive.
  ratcheted: Array<{ trade_id: string; stop_loss: number }>;
  // 0006: hedged S2 positions closed because the carry decayed.
  closed: Array<{ trade_id: string; reason: string; pnl_usd: number }>;
  errors: Array<{ trade_id: string; error: string }>;
}

const HOURS_PER_YEAR = 24 * 365;

// 0006: a hedged carry harvest earns nothing once funding normalizes — close
// when the annualized rate decays below this threshold (fees already paid).
export const S2_CARRY_DECAY_ANN_PCT = 5;

/**
 * 0005: Accrue estimated perp funding carry on open crypto trades.
 * Longs RECEIVE funding when the rate is negative (the squeeze-scout thesis)
 * and pay when positive; shorts are the inverse. Uses the CURRENT annualized
 * funding rate over the window since the last accrual — an approximation of
 * the true 8h-settlement path, accurate enough at the monitor tick cadence
 * (30min) relative to a $100 position.
 * Runs BEFORE auto-close and mark-to-market each tick so computePnl sees
 * up-to-date carry. Failures are per-trade and non-fatal (e.g. instruments
 * with no OKX/Deribit perp simply never accrue).
 */
export async function accrueFundingCarry(
  db: DB,
  deps: PaperTradeDeps = defaultDeps,
): Promise<CarryAccrualSummary> {
  const summary: CarryAccrualSummary = { accrued: 0, skipped: 0, ratcheted: [], closed: [], errors: [] };
  const open = await deps.getOpenTrades(db);
  const nowMs = deps.now();

  for (const trade of open) {
    try {
      if (trade.instrument_kind !== 'crypto' || (trade.side !== 'buy' && trade.side !== 'sell')) {
        summary.skipped++;
        continue;
      }
      const sinceMs = new Date(trade.carry_accrued_at ?? trade.opened_at).getTime();
      const hours = (nowMs - sinceMs) / 3_600_000;
      if (!Number.isFinite(hours) || hours <= 0) {
        summary.skipped++;
        continue;
      }
      const deriv = await deps.getCryptoDerivatives(trade.instrument_id);
      if (!deriv.ok) {
        summary.skipped++;
        continue;
      }
      const fundingAnnPct = deriv.data.fundingRateAnnualizedPct;
      const annualizedFrac = fundingAnnPct / 100;
      // Long pays positive funding / receives negative; short is the inverse.
      const directionSign = trade.side === 'buy' ? -1 : 1;
      const carryUsd = trade.size_usd * directionSign * annualizedFrac * (hours / HOURS_PER_YEAR);
      const total = (trade.funding_accrued_usd ?? 0) + carryUsd;
      await deps.updateOpenTradeCarry(db, trade.id, total, new Date(nowMs).toISOString());
      summary.accrued++;

      // 0006: S1 breakeven ratchet. A funding flip invalidates the squeeze
      // thesis's carry component, but "immediate close" (old H66) cut winners
      // at +$2 that ran to +$40. Instead: tighten the stop to breakeven and
      // let the price leg keep running with risk removed. One-way ratchet.
      if (trade.setup_type === 'S1_funding_squeeze' && trade.side === 'buy' && fundingAnnPct >= 0) {
        const exit = (trade.exit_criteria ?? {}) as Record<string, unknown> & { stop_loss?: number };
        if (exit.stop_loss == null || exit.stop_loss < trade.entry_price) {
          const nextExit = {
            ...exit,
            stop_loss: trade.entry_price,
            conditions: [exit.conditions, `auto: stop→breakeven on funding flip ${new Date(nowMs).toISOString()}`]
              .filter(Boolean)
              .join(' | '),
          };
          await deps.updateOpenTradeExitCriteria(db, trade.id, nextExit);
          summary.ratcheted.push({ trade_id: trade.id, stop_loss: trade.entry_price });
        }
      }

      // 0006: hedged carry harvest earns nothing once funding normalizes —
      // close it (PnL = accrued funding − doubled fees; no price leg).
      if (trade.hedged && fundingAnnPct < S2_CARRY_DECAY_ANN_PCT) {
        const updated: Trade = { ...trade, funding_accrued_usd: total };
        const pnl = computePnl(updated, trade.entry_price);
        await deps.closeTrade(db, trade.id, trade.entry_price, pnl);
        summary.closed.push({ trade_id: trade.id, reason: 'carry_decayed', pnl_usd: pnl });
      }
    } catch (e) {
      summary.errors.push({ trade_id: trade.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return summary;
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
      // 0006: hedged carry positions have no price leg — PnL depends only on
      // accrued funding, so skip the price fetch entirely.
      if (trade.hedged) {
        const pnl = computePnl(trade, trade.entry_price);
        if (trade.pnl_usd != null && Math.abs(pnl - trade.pnl_usd) < 0.01) {
          summary.skipped++;
          continue;
        }
        await deps.updateOpenTradePnl(db, trade.id, pnl);
        summary.updated++;
        continue;
      }
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
