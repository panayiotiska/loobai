import type { GoogleGenAI, FunctionDeclaration } from '@google/genai';
import { Type } from '@google/genai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getRecentRuns, getAllFormulaVersions, getPortfolioStats, getToolHealth } from '@loob/db';
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
import { assessMarketRegime } from './regime.js';
import {
  getFundingExtremes,
  getOrderbookImbalance,
  getLongShortRatio,
  getLiquidationZones,
  detectManipulationSignals,
} from './microstructure.js';
import { getClosedTradesWithPostmortems } from '@loob/db';

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
      description: 'Get OHLC candlestick data for a cryptocurrency spot pair.',
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
      description: 'Get current funding rate, annualized funding, and open interest for a USDT-margined crypto perpetual. Use BEFORE opening directional crypto trades — extreme funding or OI shifts signal crowded positioning.',
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
      name: 'assess_market_regime',
      description: 'Single-call market regime synthesis: classifies the current BTC-led environment as euphoria / fear / chop / trend-up / trend-down / uncertain, with evidence (realized vol, returns, funding, fear&greed) and a playbook. Call this FIRST every research run before considering trades.',
      parameters: { type: Type.OBJECT, properties: {}, required: [] },
    },
    {
      name: 'get_funding_extremes',
      description: 'Survey funding rates across a crypto universe (default: BTC, ETH, SOL, BNB, XRP, DOGE, AVAX, LINK). Returns sorted by |annualized funding| with severity (extreme/elevated/normal) and crowded side. Use to find crowded longs/shorts BEFORE picking an instrument.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          symbols: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Optional list of symbols. Defaults to top-8 majors.',
          },
        },
        required: [],
      },
    },
    {
      name: 'get_orderbook_imbalance',
      description: 'Snapshot of L2 spot orderbook (Binance). Returns USD bid vs ask volume within ±depth_pct of mid, plus the largest single wall on each side. Use to detect walls / asymmetry / possible spoofing BEFORE entering.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          symbol: { type: Type.STRING, description: 'e.g. "BTC", "ETH"' },
          depth_pct: { type: Type.NUMBER, description: 'Band width as % of mid (default 1.0)' },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'get_long_short_ratio',
      description: 'Binance top-trader long/short account ratio (1h). Crowding indicator: ≥2.5 = crowded long, ≤0.7 = crowded short.',
      parameters: {
        type: Type.OBJECT,
        properties: { symbol: { type: Type.STRING, description: 'e.g. "BTC"' } },
        required: ['symbol'],
      },
    },
    {
      name: 'get_liquidation_zones',
      description: 'Estimate where leveraged stops cluster for the crowded side. Combines current funding direction with conventional retail leverage (5x/10x/25x). Returns the side smart money would target and probable % moves to harvest those stops. Heuristic only — no aggregate broker data — but useful for asking "where would a stop-hunt be profitable?".',
      parameters: {
        type: Type.OBJECT,
        properties: { symbol: { type: Type.STRING, description: 'e.g. "BTC"' } },
        required: ['symbol'],
      },
    },
    {
      name: 'detect_manipulation_signals',
      description: 'Composite manipulation-risk heuristic: volume z-scores, wick:body rejection density over 24h, funding/price divergence. Returns a 0-1 risk score with reasoning. Score ≥0.6 = HIGH risk; treat clean-looking setups as traps.',
      parameters: {
        type: Type.OBJECT,
        properties: { symbol: { type: Type.STRING, description: 'e.g. "BTC"' } },
        required: ['symbol'],
      },
    },
    {
      name: 'paper_trade_open',
      description: 'Open a paper (simulated) position. v2 requires: (a) confidence ≥ 0.65; (b) full adversarial rationale — retail_view, institutional_view, adversarial_view (each ≥20 chars); (c) ≥2 independent confirming signals; (d) a concrete invalidation_signal; (e) regime_at_entry from assess_market_regime. Max size = cap × confidence² with a 50% post-entry exposure cap.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          instrument_kind: { type: Type.STRING, description: '"crypto", "polymarket", or "other"' },
          instrument_id: { type: Type.STRING, description: 'Instrument identifier, e.g. "BTC" or Polymarket market slug' },
          instrument_label: { type: Type.STRING, description: 'Human-readable label (optional)' },
          side: { type: Type.STRING, description: '"buy", "sell", "yes", or "no"' },
          size_usd: { type: Type.NUMBER, description: 'Position size in USD' },
          thesis: { type: Type.STRING, description: 'One-line summary of the setup' },
          confidence: { type: Type.NUMBER, description: '0.65-1.0. Below 0.65 is rejected by the conviction gate. Max size = cap × confidence² (0.7→49%, 0.8→64%, 0.9→81%).' },
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
          regime_at_entry: { type: Type.STRING, description: 'Current regime label from assess_market_regime (euphoria/fear/chop/trend-up/trend-down/uncertain).' },
          retail_view: { type: Type.STRING, description: '≥20 chars. What would the crowd / Twitter / news headline say about this setup?' },
          institutional_view: { type: Type.STRING, description: '≥20 chars. How is large money likely positioned? Cite funding, OI, basis, options skew.' },
          adversarial_view: { type: Type.STRING, description: '≥20 chars. If you were smart money, where would you hunt the stops of someone taking this trade? Articulate the manipulation case.' },
          confirming_signals: {
            type: Type.ARRAY,
            description: '≥2 independent confirming signals (e.g. funding+orderbook+news). Each item {kind, evidence}.',
            items: {
              type: Type.OBJECT,
              properties: {
                kind: { type: Type.STRING, description: 'Signal bucket: "funding", "orderbook", "news", "regime", "long_short_ratio", "manipulation", "polymarket_orderbook", etc.' },
                evidence: { type: Type.STRING, description: 'Concrete evidence with values or citation.' },
              },
              required: ['kind', 'evidence'],
            },
          },
          invalidation_signal: { type: Type.STRING, description: 'Specific observable that would prove this thesis WRONG. ≥10 chars. Example: "Daily close below 50d SMA" or "BTC 4h candle close > $72k".' },
          expected_holding_period: { type: Type.STRING, description: 'Rough horizon, e.g. "intraday", "3-7 days", "until resolution".' },
        },
        required: [
          'instrument_kind', 'instrument_id', 'side', 'size_usd', 'thesis', 'confidence', 'exit_criteria',
          'regime_at_entry', 'retail_view', 'institutional_view', 'adversarial_view', 'confirming_signals', 'invalidation_signal',
        ],
      },
    },
    {
      name: 'paper_trade_close',
      description: 'Close an open paper position discretionarily. v2 requires a structured postmortem (thesis_correct, what_we_missed, luck_or_skill, lesson). Auto-close (TP/SL/time_limit) happens automatically before each tick and does NOT need this tool.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          trade_id: { type: Type.STRING, description: 'UUID of the trade to close' },
          reason: { type: Type.STRING, description: 'Short reason for the discretionary close' },
          postmortem: {
            type: Type.OBJECT,
            description: 'Required structured postmortem.',
            properties: {
              thesis_correct: { type: Type.BOOLEAN, description: 'Was the entry thesis right (even if the trade went bad)?' },
              what_we_missed: { type: Type.STRING, description: '≥10 chars. What did we fail to see at entry? E.g. "missed funding flip mid-week", "overlooked Polymarket binary close".' },
              luck_or_skill: { type: Type.STRING, description: 'One of "luck" | "skill" | "mixed". Honest classification of whether outcome reflects process quality.' },
              lesson: { type: Type.STRING, description: '≥10 chars. Specific takeaway to write to FORMULA.md lessons learned.' },
            },
            required: ['thesis_correct', 'what_we_missed', 'luck_or_skill', 'lesson'],
          },
        },
        required: ['trade_id', 'reason', 'postmortem'],
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

    assess_market_regime: async () => {
      return assessMarketRegime();
    },

    get_funding_extremes: async (args) => {
      const symbols = Array.isArray(args.symbols)
        ? (args.symbols as unknown[]).filter((s) => typeof s === 'string').map((s) => s as string)
        : undefined;
      return getFundingExtremes(symbols);
    },

    get_orderbook_imbalance: async (args) => {
      return getOrderbookImbalance(
        String(args.symbol),
        args.depth_pct != null ? Number(args.depth_pct) : 1.0,
      );
    },

    get_long_short_ratio: async (args) => {
      return getLongShortRatio(String(args.symbol));
    },

    get_liquidation_zones: async (args) => {
      return getLiquidationZones(String(args.symbol));
    },

    detect_manipulation_signals: async (args) => {
      return detectManipulationSignals(String(args.symbol));
    },

    paper_trade_open: async (args) => {
      const signals = Array.isArray(args.confirming_signals)
        ? ((args.confirming_signals as unknown[])
            .filter((s): s is { kind: unknown; evidence: unknown } => typeof s === 'object' && s != null)
            .map((s) => ({
              kind: String((s as { kind: unknown }).kind ?? 'unknown'),
              evidence: String((s as { evidence: unknown }).evidence ?? ''),
            })))
        : undefined;
      return paperTradeOpen(db, runId, {
        instrument_kind: args.instrument_kind as 'crypto' | 'polymarket' | 'other',
        instrument_id: String(args.instrument_id),
        instrument_label: args.instrument_label ? String(args.instrument_label) : undefined,
        side: args.side as 'buy' | 'sell' | 'yes' | 'no',
        size_usd: Number(args.size_usd),
        thesis: String(args.thesis),
        confidence: args.confidence != null ? Number(args.confidence) : null,
        exit_criteria: (args.exit_criteria ?? {}) as Record<string, unknown>,
        regime_at_entry: args.regime_at_entry ? String(args.regime_at_entry) : undefined,
        retail_view: args.retail_view ? String(args.retail_view) : undefined,
        institutional_view: args.institutional_view ? String(args.institutional_view) : undefined,
        adversarial_view: args.adversarial_view ? String(args.adversarial_view) : undefined,
        confirming_signals: signals,
        invalidation_signal: args.invalidation_signal ? String(args.invalidation_signal) : undefined,
        expected_holding_period: args.expected_holding_period ? String(args.expected_holding_period) : undefined,
      });
    },

    paper_trade_close: async (args) => {
      const pmRaw = (args.postmortem ?? null) as Record<string, unknown> | null;
      const pm = pmRaw
        ? {
            thesis_correct: Boolean(pmRaw.thesis_correct),
            what_we_missed: String(pmRaw.what_we_missed ?? ''),
            luck_or_skill: String(pmRaw.luck_or_skill ?? '') as 'luck' | 'skill' | 'mixed',
            lesson: String(pmRaw.lesson ?? ''),
          }
        : undefined;
      return paperTradeClose(db, {
        trade_id: String(args.trade_id),
        reason: String(args.reason),
        postmortem: pm,
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
        const limit = args.limit ? Number(args.limit) : 10;
        const [runs, toolHealth] = await Promise.all([
          getRecentRuns(db, limit),
          getToolHealth(db, Math.max(limit, 20)),
        ]);
        // Only surface tools that have failed at least once in the lookback so the agent
        // can see "is this tool currently broken or fine" without noise from healthy tools.
        const flakyTools = toolHealth.filter((t) => t.failures > 0);
        return { ok: true, data: { runs, toolHealth: flakyTools } };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    read_lessons_learned: async () => {
      try {
        const [versions, closedTrades] = await Promise.all([
          getAllFormulaVersions(db),
          getClosedTradesWithPostmortems(db, 20),
        ]);
        const fromFormula = versions
          .map((v) => {
            const match = v.content.match(/## Lessons learned\n([\s\S]*?)(?=\n## |\n# |$)/);
            return match ? `--- FORMULA v${v.version} ---\n${match[1].trim()}` : null;
          })
          .filter(Boolean)
          .slice(0, 10);
        const fromTrades = closedTrades
          .filter((t) => t.postmortem != null)
          .map((t) => {
            const pm = t.postmortem!;
            const result = (t.pnl_usd ?? 0) >= 0 ? 'WIN' : 'LOSS';
            return `--- Trade ${t.id.slice(0, 8)} (${result}, $${(t.pnl_usd ?? 0).toFixed(2)}, ${t.instrument_label ?? t.instrument_id} ${t.side}) ---\n` +
              `thesis_correct=${pm.thesis_correct} luck_or_skill=${pm.luck_or_skill}\n` +
              `what_we_missed: ${pm.what_we_missed}\n` +
              `lesson: ${pm.lesson}`;
          })
          .slice(0, 15);
        const body =
          [...fromTrades, ...fromFormula].join('\n\n') || 'No lessons recorded yet — this is the seed phase.';
        return { ok: true, data: body };
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
