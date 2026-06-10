-- 0005: funding carry accrual on paper trades.
-- The squeeze-scout thesis is "crowded shorts pay longs", but pnl_usd only
-- measured price return minus fees — the strategy's core economic mechanism
-- (funding payments) was invisible to the scoreboard. These columns let the
-- agent accrue estimated perp funding on open crypto positions each tick.
alter table trades add column if not exists funding_accrued_usd numeric not null default 0;
alter table trades add column if not exists carry_accrued_at timestamptz;
