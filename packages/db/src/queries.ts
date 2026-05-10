// Typed query helpers — wrap Supabase JS client calls with explicit return types.
// The `db` parameter uses the SupabaseClient type from the factory (no generic needed here).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Run, FormulaVersion, Note, Trade, AgentRequest } from './types.js';

// Using SupabaseClient without Database generic here keeps things simple.
// The Row types we return are explicitly typed via the type annotations.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any>;

// --- Runs ---

export async function createRun(db: DB, kind: Run['kind']): Promise<Run> {
  const { data, error } = await db
    .from('runs')
    .insert({ kind, status: 'running' })
    .select()
    .single();
  if (error) throw new Error(`createRun: ${error.message}`);
  return data as Run;
}

export async function updateRun(
  db: DB,
  id: string,
  patch: Partial<Omit<Run, 'id' | 'kind' | 'started_at'>>,
): Promise<void> {
  const { error } = await db.from('runs').update(patch).eq('id', id);
  if (error) throw new Error(`updateRun: ${error.message}`);
}

export async function getRecentRuns(db: DB, limit = 10): Promise<Run[]> {
  const { data, error } = await db
    .from('runs')
    .select()
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`getRecentRuns: ${error.message}`);
  return (data ?? []) as Run[];
}

// --- Formula versions ---

export async function getLatestFormula(db: DB): Promise<FormulaVersion | null> {
  const { data, error } = await db
    .from('formula_versions')
    .select()
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getLatestFormula: ${error.message}`);
  return data as FormulaVersion | null;
}

export async function insertFormulaVersion(
  db: DB,
  payload: {
    run_id: string;
    version: number;
    content: string;
    changelog: string;
    parent_version: number | null;
  },
): Promise<FormulaVersion> {
  const { data, error } = await db
    .from('formula_versions')
    .insert(payload)
    .select()
    .single();
  if (error) throw new Error(`insertFormulaVersion: ${error.message}`);
  return data as FormulaVersion;
}

export async function getAllFormulaVersions(db: DB): Promise<FormulaVersion[]> {
  const { data, error } = await db
    .from('formula_versions')
    .select()
    .order('version', { ascending: false });
  if (error) throw new Error(`getAllFormulaVersions: ${error.message}`);
  return (data ?? []) as FormulaVersion[];
}

export async function getFormulaVersion(db: DB, version: number): Promise<FormulaVersion | null> {
  const { data, error } = await db
    .from('formula_versions')
    .select()
    .eq('version', version)
    .maybeSingle();
  if (error) throw new Error(`getFormulaVersion: ${error.message}`);
  return data as FormulaVersion | null;
}

// --- Notes ---

export async function getUnconsumedNotes(db: DB): Promise<Note[]> {
  const { data, error } = await db
    .from('notes')
    .select()
    .is('consumed_by_run_id', null)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`getUnconsumedNotes: ${error.message}`);
  return (data ?? []) as Note[];
}

export async function markNotesConsumed(db: DB, noteIds: string[], runId: string): Promise<void> {
  if (noteIds.length === 0) return;
  const { error } = await db
    .from('notes')
    .update({ consumed_by_run_id: runId })
    .in('id', noteIds);
  if (error) throw new Error(`markNotesConsumed: ${error.message}`);
}

export async function insertNote(db: DB, source: Note['source'], content: string): Promise<Note> {
  const { data, error } = await db
    .from('notes')
    .insert({ source, content })
    .select()
    .single();
  if (error) throw new Error(`insertNote: ${error.message}`);
  return data as Note;
}

// --- Trades ---

export async function getOpenTrades(db: DB): Promise<Trade[]> {
  const { data, error } = await db
    .from('trades')
    .select()
    .eq('status', 'open')
    .order('opened_at', { ascending: false });
  if (error) throw new Error(`getOpenTrades: ${error.message}`);
  return (data ?? []) as Trade[];
}

export async function insertTrade(db: DB, payload: Omit<Trade, 'id' | 'opened_at'>): Promise<Trade> {
  const { data, error } = await db
    .from('trades')
    .insert(payload)
    .select()
    .single();
  if (error) throw new Error(`insertTrade: ${error.message}`);
  return data as Trade;
}

export async function closeTrade(
  db: DB,
  id: string,
  exitPrice: number,
  pnlUsd: number,
): Promise<void> {
  const { error } = await db
    .from('trades')
    .update({
      exit_price: exitPrice,
      pnl_usd: pnlUsd,
      status: 'closed',
      closed_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw new Error(`closeTrade: ${error.message}`);
}

export interface PortfolioStats {
  openCount: number;
  closedCount: number;
  openExposureUsd: number;
  openUnrealizedPnlUsd: number;
  realizedPnlUsd: number;
  realizedPnlLast30dUsd: number;
  winRate: number | null;
  wins: number;
  losses: number;
  biggestWinUsd: number | null;
  biggestLossUsd: number | null;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  pnlCurve: Array<{ closedAt: string; cumulativePnlUsd: number }>;
}

export async function getPortfolioStats(db: DB): Promise<PortfolioStats> {
  const { data, error } = await db
    .from('trades')
    .select('size_usd, pnl_usd, status, closed_at, opened_at')
    .order('opened_at', { ascending: true });
  if (error) throw new Error(`getPortfolioStats: ${error.message}`);

  const rows = (data ?? []) as Array<{
    size_usd: number;
    pnl_usd: number | null;
    status: 'open' | 'closed' | 'cancelled';
    closed_at: string | null;
    opened_at: string;
  }>;

  const open = rows.filter((r) => r.status === 'open');
  const closed = rows
    .filter((r) => r.status === 'closed' && r.pnl_usd != null && r.closed_at != null)
    .sort((a, b) => (a.closed_at! < b.closed_at! ? -1 : 1));

  const openExposureUsd = open.reduce((s, r) => s + r.size_usd, 0);
  const openUnrealizedPnlUsd = open.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const realizedPnlUsd = closed.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const realizedPnlLast30dUsd = closed
    .filter((r) => new Date(r.closed_at!).getTime() >= thirtyDaysAgo)
    .reduce((s, r) => s + (r.pnl_usd ?? 0), 0);

  const wins = closed.filter((r) => (r.pnl_usd ?? 0) > 0);
  const losses = closed.filter((r) => (r.pnl_usd ?? 0) < 0);
  const winRate = closed.length ? wins.length / closed.length : null;
  const biggestWinUsd = wins.length ? Math.max(...wins.map((r) => r.pnl_usd!)) : null;
  const biggestLossUsd = losses.length ? Math.min(...losses.map((r) => r.pnl_usd!)) : null;
  const avgWinUsd = wins.length ? wins.reduce((s, r) => s + r.pnl_usd!, 0) / wins.length : null;
  const avgLossUsd = losses.length ? losses.reduce((s, r) => s + r.pnl_usd!, 0) / losses.length : null;

  let running = 0;
  const pnlCurve = closed.map((r) => {
    running += r.pnl_usd ?? 0;
    return { closedAt: r.closed_at!, cumulativePnlUsd: running };
  });

  return {
    openCount: open.length,
    closedCount: closed.length,
    openExposureUsd,
    openUnrealizedPnlUsd,
    realizedPnlUsd,
    realizedPnlLast30dUsd,
    winRate,
    wins: wins.length,
    losses: losses.length,
    biggestWinUsd,
    biggestLossUsd,
    avgWinUsd,
    avgLossUsd,
    pnlCurve,
  };
}

// --- Agent requests ---

export async function getPendingRequests(db: DB): Promise<AgentRequest[]> {
  const { data, error } = await db
    .from('agent_requests')
    .select()
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`getPendingRequests: ${error.message}`);
  return (data ?? []) as AgentRequest[];
}

export async function insertAgentRequest(
  db: DB,
  payload: {
    run_id: string;
    kind: AgentRequest['kind'];
    prompt: string;
    context?: string;
  },
): Promise<AgentRequest> {
  const { data, error } = await db
    .from('agent_requests')
    .insert({ ...payload, status: 'pending' })
    .select()
    .single();
  if (error) throw new Error(`insertAgentRequest: ${error.message}`);
  return data as AgentRequest;
}

export async function resolveAgentRequest(db: DB, id: string, resolution: string): Promise<void> {
  const { error } = await db
    .from('agent_requests')
    .update({
      status: 'resolved',
      resolution,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw new Error(`resolveAgentRequest: ${error.message}`);
}
