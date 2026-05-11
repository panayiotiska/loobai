-- 0002: observability and safety
-- - system_state: singleton row controlling pause/resume of the agent
-- - tool_calls: append-only audit log of every tool call the agent makes
-- - trades.confidence: per-trade confidence score for confidence-weighted sizing

create table if not exists system_state (
  id int primary key default 1 check (id = 1),
  paused boolean not null default false,
  paused_at timestamptz,
  paused_reason text,
  paused_by text
);

insert into system_state (id, paused) values (1, false)
  on conflict (id) do nothing;

create table if not exists tool_calls (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  tool_name text not null,
  args_json jsonb,
  ok boolean not null,
  result_summary text,
  error text,
  duration_ms int,
  created_at timestamptz not null default now()
);
create index if not exists tool_calls_run_id_idx on tool_calls (run_id, created_at);
create index if not exists tool_calls_tool_name_idx on tool_calls (tool_name, created_at desc);

alter table trades add column if not exists confidence numeric(3,2);

alter table system_state enable row level security;
alter table tool_calls enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'system_state' and policyname = 'owner reads state') then
    create policy "owner reads state" on system_state for select using (auth.role() = 'authenticated');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'tool_calls' and policyname = 'owner reads tool calls') then
    create policy "owner reads tool calls" on tool_calls for select using (auth.role() = 'authenticated');
  end if;
end $$;
