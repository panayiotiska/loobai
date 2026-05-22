export interface Run {
  id: string;
  kind: 'research' | 'monitor';
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'success' | 'failed';
  summary: string | null;
  error: string | null;
  llm_input_tokens: number | null;
  llm_output_tokens: number | null;
  llm_cost_usd: number | null;
}

export interface FormulaVersion {
  id: string;
  run_id: string | null;
  version: number;
  content: string;
  changelog: string | null;
  parent_version: number | null;
  created_at: string;
}

export interface Note {
  id: string;
  source: 'telegram' | 'web' | 'agent_self';
  content: string;
  consumed_by_run_id: string | null;
  created_at: string;
}

export interface Trade {
  id: string;
  run_id: string | null;
  mode: 'paper' | 'live';
  instrument_kind: string;
  instrument_id: string;
  instrument_label: string | null;
  side: 'buy' | 'sell' | 'yes' | 'no';
  size_usd: number;
  entry_price: number;
  exit_price: number | null;
  status: 'open' | 'closed' | 'cancelled';
  thesis: string;
  exit_criteria: Record<string, unknown>;
  pnl_usd: number | null;
  confidence: number | null;
  opened_at: string;
  closed_at: string | null;
  // 0003: structured rationale & postmortems
  regime_at_entry: string | null;
  retail_view: string | null;
  institutional_view: string | null;
  adversarial_view: string | null;
  confirming_signals: Array<{ kind: string; evidence: string }> | null;
  invalidation_signal: string | null;
  expected_holding_period: string | null;
  postmortem: TradePostmortem | null;
}

export interface TradePostmortem {
  thesis_correct: boolean;
  what_we_missed: string;
  luck_or_skill: 'luck' | 'skill' | 'mixed';
  lesson: string;
}

export interface SystemState {
  id: number;
  paused: boolean;
  paused_at: string | null;
  paused_reason: string | null;
  paused_by: string | null;
}

export interface ToolCall {
  id: string;
  run_id: string;
  tool_name: string;
  args_json: unknown;
  ok: boolean;
  result_summary: string | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface AgentRequest {
  id: string;
  run_id: string | null;
  kind: 'api_key' | 'decision' | 'info' | 'approval';
  prompt: string;
  context: string | null;
  status: 'pending' | 'resolved' | 'dismissed';
  resolution: string | null;
  resolved_at: string | null;
  created_at: string;
}

// Supabase Database generic — must match the shape expected by @supabase/supabase-js
export type Database = {
  public: {
    Tables: {
      runs: {
        Row: Run;
        Insert: Partial<Pick<Run, 'id' | 'started_at'>> & Omit<Run, 'id' | 'started_at'>;
        Update: Partial<Run>;
        Relationships: [];
      };
      formula_versions: {
        Row: FormulaVersion;
        Insert: Partial<Pick<FormulaVersion, 'id' | 'created_at'>> & Omit<FormulaVersion, 'id' | 'created_at'>;
        Update: Partial<FormulaVersion>;
        Relationships: [];
      };
      notes: {
        Row: Note;
        Insert: Partial<Pick<Note, 'id' | 'created_at'>> & Omit<Note, 'id' | 'created_at'>;
        Update: Partial<Note>;
        Relationships: [];
      };
      trades: {
        Row: Trade;
        Insert: Partial<Pick<Trade, 'id' | 'opened_at'>> & Omit<Trade, 'id' | 'opened_at'>;
        Update: Partial<Trade>;
        Relationships: [];
      };
      agent_requests: {
        Row: AgentRequest;
        Insert: Partial<Pick<AgentRequest, 'id' | 'created_at'>> & Omit<AgentRequest, 'id' | 'created_at'>;
        Update: Partial<AgentRequest>;
        Relationships: [];
      };
      system_state: {
        Row: SystemState;
        Insert: Partial<SystemState> & Pick<SystemState, 'id'>;
        Update: Partial<SystemState>;
        Relationships: [];
      };
      tool_calls: {
        Row: ToolCall;
        Insert: Partial<Pick<ToolCall, 'id' | 'created_at'>> & Omit<ToolCall, 'id' | 'created_at'>;
        Update: Partial<ToolCall>;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
