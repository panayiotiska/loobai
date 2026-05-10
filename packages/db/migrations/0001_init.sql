-- Users (single user for v1, but designed for multi)
-- Supabase Auth handles users table; we just reference auth.users.id

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('research', 'monitor')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','success','failed')),
  summary text,
  error text,
  llm_input_tokens int,
  llm_output_tokens int,
  llm_cost_usd numeric(10,6) default 0
);
create index if not exists runs_started_at_idx on runs (started_at desc);

create table if not exists formula_versions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id) on delete set null,
  version int not null,
  content text not null,
  changelog text,
  parent_version int,
  created_at timestamptz not null default now(),
  unique (version)
);
create index if not exists formula_versions_version_idx on formula_versions (version desc);

create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('telegram','web','agent_self')),
  content text not null,
  consumed_by_run_id uuid references runs(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists notes_unconsumed_idx on notes (created_at) where consumed_by_run_id is null;

create table if not exists trades (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id) on delete set null,
  mode text not null check (mode in ('paper','live')),
  instrument_kind text not null,
  instrument_id text not null,
  instrument_label text,
  side text not null check (side in ('buy','sell','yes','no')),
  size_usd numeric(12,2) not null,
  entry_price numeric(20,8) not null,
  exit_price numeric(20,8),
  status text not null default 'open' check (status in ('open','closed','cancelled')),
  thesis text not null,
  exit_criteria jsonb not null,
  pnl_usd numeric(12,2),
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists trades_status_idx on trades (status);

create table if not exists agent_requests (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id) on delete set null,
  kind text not null check (kind in ('api_key','decision','info','approval')),
  prompt text not null,
  context text,
  status text not null default 'pending' check (status in ('pending','resolved','dismissed')),
  resolution text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists agent_requests_pending_idx on agent_requests (created_at) where status = 'pending';

-- Row Level Security
alter table runs enable row level security;
alter table formula_versions enable row level security;
alter table notes enable row level security;
alter table trades enable row level security;
alter table agent_requests enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'runs' and policyname = 'owner reads all') then
    create policy "owner reads all" on runs for select using (auth.role() = 'authenticated');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'formula_versions' and policyname = 'owner reads all') then
    create policy "owner reads all" on formula_versions for select using (auth.role() = 'authenticated');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'notes' and policyname = 'owner reads all') then
    create policy "owner reads all" on notes for select using (auth.role() = 'authenticated');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'trades' and policyname = 'owner reads all') then
    create policy "owner reads all" on trades for select using (auth.role() = 'authenticated');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'agent_requests' and policyname = 'owner reads all') then
    create policy "owner reads all" on agent_requests for select using (auth.role() = 'authenticated');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'notes' and policyname = 'owner inserts notes') then
    create policy "owner inserts notes" on notes for insert with check (auth.role() = 'authenticated' and source = 'web');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'agent_requests' and policyname = 'owner resolves requests') then
    create policy "owner resolves requests" on agent_requests for update using (auth.role() = 'authenticated');
  end if;
end $$;
