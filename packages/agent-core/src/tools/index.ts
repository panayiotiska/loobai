import type { GoogleGenAI, FunctionDeclaration } from '@google/genai';
import { Type } from '@google/genai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getRecentRuns, getAllFormulaVersions, getPortfolioStats } from '@loob/db';
import { searchNews } from './news-search.js';
import {
  getCryptoPrice,
  getCryptoOHLC,
  listPolymarketMarkets,
  getPolymarketMarket,
  getPolymarketOrderbook,
  getPolymarketPriceHistory,
  type PolymarketHistoryInterval,
} from './market-data.js';
import { getCryptoDerivatives } from './derivatives.js';
import { paperTradeOpen, paperTradeClose, paperTradeListOpen } from './paper-trade.js';
import { requestUserInput } from './request-user-input.js';
import { proposeLiveTrade } from './propose-live-trade.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any>;

export interface ToolCallResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolCallResult>;

export function buildToolDeclarations(): FunctionDeclaration[] {
  return [
    {
      name: 'search_news',
      description: 'Search the web for current news and information using Gemini grounding. Always cite URLs in your analysis.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: { type: Type.STRING, description: 'The search query' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_crypto_price',
      description: 'Get the current spot price and 24h change for a cryptocurrency.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          symbol: { type: Type.STRING, description: 'Ticker symbol, e.g. "BTC", "ETH", "SOL"' },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'get_crypto_ohlc',
      description: 'Get OHLC candlestick data for a cryptocurrency from Binance.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          symbol: { type: Type.STRING, description: 'Ticker symbol, e.g. "BTC"' },
          interval: { type: Type.STRING, description: 'Candlestick interval: 1m, 5m, 15m, 1h, 4h, 1d' },
          lookback: { type: Type.NUMBER, description: 'Number of candles to return (max 500)' },
        },
        required: ['symbol', 'interval', 'lookback'],
      },
    },
    {
      name: 'get_crypto_derivatives',
      description: 'Get current funding rate, annualized funding, and open interest for a crypto perp from Binance Futures. Use BEFORE opening directional crypto trades — extreme funding or OI shifts signal crowded positioning.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          symbol: { type: Type.STRING, description: 'Ticker symbol, e.g. "BTC", "ETH", "SOL"' },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'list_polymarket_markets',
      description: 'Browse open prediction markets on Polymarket.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          category: { type: Type.STRING, description: 'Filter by category (optional)' },
          min_volume: { type: Type.NUMBER, description: 'Minimum trading volume in USD (optional)' },
          max_days_to_resolution: { type: Type.NUMBER, description: 'Only show markets resolving within N days (optional)' },
        },
        required: [],
      },
    },
    {
      name: 'get_polymarket_market',
      description: 'Get full details on a specific Polymarket prediction market.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          slug: { type: Type.STRING, description: 'Market slug from list_polymarket_markets' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'get_polymarket_orderbook',
      description: 'Get the live CLOB order book for one outcome of a Polymarket market. Use this to check liquidity, spread, and depth BEFORE sizing a paper trade.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          slug: { type: Type.STRING, description: 'Market slug from list_polymarket_markets' },
          outcome: { type: Type.STRING, description: 'Outcome name, e.g. "Yes" or "No"' },
          depth: { type: Type.NUMBER, description: 'Number of levels per side to return (default 10, max 50)' },
        },
        required: ['slug', 'outcome'],
      },
    },
    {
      name: 'get_polymarket_price_history',
      description: 'Get historical price series for one outcome of a Polymarket market. Useful for spotting trends, mean-reversion setups, or validating a thesis against past movement.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          slug: { type: Type.STRING, description: 'Market slug from list_polymarket_markets' },
          outcome: { type: Type.STRING, description: 'Outcome name, e.g. "Yes" or "No"' },
          interval: { type: Type.STRING, description: 'One of: 1m, 1h, 6h, 1d, 1w, max (default 1d)' },
        },
        required: ['slug', 'outcome'],
      },
    },
    {
      name: 'paper_trade_open',
      description: 'Open a paper (simulated) trading position. Always include take_profit, stop_loss, time_limit, and conditions in exit_criteria. Max position size scales as cap × confidence² — high size requires high conviction.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          instrument_kind: { type: Type.STRING, description: '"crypto", "polymarket", or "other"' },
          instrument_id: { type: Type.STRING, description: 'Instrument identifier, e.g. "BTC" or Polymarket market slug' },
          instrument_label: { type: Type.STRING, description: 'Human-readable label (optional)' },
          side: { type: Type.STRING, description: '"buy", "sell", "yes", or "no"' },
          size_usd: { type: Type.NUMBER, description: 'Position size in USD' },
          thesis: { type: Type.STRING, description: 'Your reasoning for this trade' },
          confidence: { type: Type.NUMBER, description: '0.0-1.0 conviction in THIS specific trade. Max size = cap × confidence². At 0.5 conf max is 25% of cap; at 0.8 conf max is 64% of cap. Be honest — inflating confidence to clear the bar is self-defeating.' },
          exit_criteria: {
            type: Type.OBJECT,
            description: 'Exit conditions',
            properties: {
              take_profit: { type: Type.NUMBER, description: 'Price to take profit at' },
              stop_loss: { type: Type.NUMBER, description: 'Price to stop loss at' },
              time_limit: { type: Type.STRING, description: 'ISO date after which to exit regardless' },
              conditions: { type: Type.STRING, description: 'Any other exit conditions in plain text' },
            },
          },
        },
        required: ['instrument_kind', 'instrument_id', 'side', 'size_usd', 'thesis', 'exit_criteria'],
      },
    },
    {
      name: 'paper_trade_close',
      description: 'Close an open paper trading position.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          trade_id: { type: Type.STRING, description: 'UUID of the trade to close' },
          reason: { type: Type.STRING, description: 'Why you are closing this position' },
        },
        required: ['trade_id', 'reason'],
      },
    },
    {
      name: 'paper_trade_list_open',
      description: 'List all currently open paper trading positions.',
      parameters: {
        type: Type.OBJECT,
        properties: {},
        required: [],
      },
    },
    {
      name: 'request_user_input',
      description: 'Ask the user for input — an API key, a decision, information, or approval. Do NOT block waiting; note in your FORMULA that you are waiting.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          kind: { type: Type.STRING, description: '"api_key", "decision", "info", or "approval"' },
          prompt: { type: Type.STRING, description: 'What you need from the user' },
          context: { type: Type.STRING, description: 'Why you need it (optional)' },
        },
        required: ['kind', 'prompt'],
      },
    },
    {
      name: 'propose_live_trade',
      description: 'DISABLED in v1. Propose a real-money trade. Calling this will throw an error.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          instrument_kind: { type: Type.STRING },
          instrument_id: { type: Type.STRING },
          side: { type: Type.STRING },
          size_usd: { type: Type.NUMBER },
          thesis: { type: Type.STRING },
        },
        required: ['instrument_kind', 'instrument_id', 'side', 'size_usd', 'thesis'],
      },
    },
    {
      name: 'read_recent_runs',
      description: 'Get summaries of recent agent runs.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          limit: { type: Type.NUMBER, description: 'Number of runs to return (default 10)' },
        },
        required: [],
      },
    },
    {
      name: 'read_lessons_learned',
      description: 'Pull lessons learned across recent FORMULA versions to avoid repeating mistakes.',
      parameters: {
        type: Type.OBJECT,
        properties: {},
        required: [],
      },
    },
    {
      name: 'get_portfolio_stats',
      description: 'Get quantitative performance stats across all paper trades: win rate, realized PnL, open exposure, biggest win/loss, plus the cumulative PnL curve. Use this to self-grade the current formula against actual results.',
      parameters: {
        type: Type.OBJECT,
        properties: {},
        required: [],
      },
    },
  ];
}

export function buildToolHandlers(
  db: DB,
  genai: GoogleGenAI,
  runId: string,
): Record<string, ToolHandler> {
  return {
    search_news: async (args) => {
      return searchNews(genai, { query: String(args.query) });
    },

    get_crypto_price: async (args) => {
      return getCryptoPrice(String(args.symbol));
    },

    get_crypto_ohlc: async (args) => {
      return getCryptoOHLC(
        String(args.symbol),
        String(args.interval),
        Number(args.lookback),
      );
    },

    get_crypto_derivatives: async (args) => {
      return getCryptoDerivatives(String(args.symbol));
    },

    list_polymarket_markets: async (args) => {
      return listPolymarketMarkets({
        category: args.category ? String(args.category) : undefined,
        min_volume: args.min_volume ? Number(args.min_volume) : undefined,
        max_days_to_resolution: args.max_days_to_resolution
          ? Number(args.max_days_to_resolution)
          : undefined,
      });
    },

    get_polymarket_market: async (args) => {
      return getPolymarketMarket(String(args.slug));
    },

    get_polymarket_orderbook: async (args) => {
      return getPolymarketOrderbook(
        String(args.slug),
        String(args.outcome),
        args.depth ? Math.min(Number(args.depth), 50) : 10,
      );
    },

    get_polymarket_price_history: async (args) => {
      return getPolymarketPriceHistory(
        String(args.slug),
        String(args.outcome),
        (args.interval ? String(args.interval) : '1d') as PolymarketHistoryInterval,
      );
    },

    paper_trade_open: async (args) => {
      return paperTradeOpen(db, runId, {
        instrument_kind: args.instrument_kind as 'crypto' | 'polymarket' | 'other',
        instrument_id: String(args.instrument_id),
        instrument_label: args.instrument_label ? String(args.instrument_label) : undefined,
        side: args.side as 'buy' | 'sell' | 'yes' | 'no',
        size_usd: Number(args.size_usd),
        thesis: String(args.thesis),
        confidence: args.confidence != null ? Number(args.confidence) : null,
        exit_criteria: (args.exit_criteria ?? {}) as Record<string, unknown>,
      });
    },

    paper_trade_close: async (args) => {
      return paperTradeClose(db, {
        trade_id: String(args.trade_id),
        reason: String(args.reason),
      });
    },

    paper_trade_list_open: async () => {
      return paperTradeListOpen(db);
    },

    request_user_input: async (args) => {
      return requestUserInput(db, runId, {
        kind: args.kind as 'api_key' | 'decision' | 'info' | 'approval',
        prompt: String(args.prompt),
        context: args.context ? String(args.context) : undefined,
      });
    },

    propose_live_trade: async (args) => {
      try {
        proposeLiveTrade({
          instrument_kind: String(args.instrument_kind),
          instrument_id: String(args.instrument_id),
          side: args.side as 'buy' | 'sell' | 'yes' | 'no',
          size_usd: Number(args.size_usd),
          thesis: String(args.thesis),
        });
        return { ok: false, error: 'Should not reach here' };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    read_recent_runs: async (args) => {
      try {
        const runs = await getRecentRuns(db, args.limit ? Number(args.limit) : 10);
        return { ok: true, data: runs };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    read_lessons_learned: async () => {
      try {
        const versions = await getAllFormulaVersions(db);
        const lessons = versions
          .map((v) => {
            const match = v.content.match(/## Lessons learned\n([\s\S]*?)(?=\n## |\n# |$)/);
            return match ? `--- v${v.version} ---\n${match[1].trim()}` : null;
          })
          .filter(Boolean)
          .slice(0, 10);
        return { ok: true, data: lessons.join('\n\n') || 'No lessons recorded yet.' };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    get_portfolio_stats: async () => {
      try {
        const stats = await getPortfolioStats(db);
        // Trim the curve in the tool response — agent doesn't need every point
        return { ok: true, data: { ...stats, pnlCurve: stats.pnlCurve.slice(-30) } };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
