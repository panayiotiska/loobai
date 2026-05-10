export type RunKind = 'research' | 'monitor';
export type RunStatus = 'running' | 'success' | 'failed';
export type TradeMode = 'paper' | 'live';
export type TradeSide = 'buy' | 'sell' | 'yes' | 'no';
export type TradeStatus = 'open' | 'closed' | 'cancelled';
export type NoteSource = 'telegram' | 'web' | 'agent_self';
export type AgentRequestKind = 'api_key' | 'decision' | 'info' | 'approval';
export type AgentRequestStatus = 'pending' | 'resolved' | 'dismissed';

export type Result<T, E = string> =
  | { ok: true; data: T }
  | { ok: false; error: E };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function err<E = string>(error: E): Result<never, E> {
  return { ok: false, error };
}
