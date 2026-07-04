-- 0006: setup taxonomy, hedged carry trades, trailing-stop high-water mark.
--
-- v3 moves trading discipline from prompt to code. Every trade is classified
-- into a named setup whose defining condition is verified server-side at open
-- time; sizing scales per-setup from realized results; exits support trailing
-- stops. Historical rows default to D_discretionary — every setup restarts at
-- the bottom of the sizing ladder (intentional conservative reset).
alter table trades add column if not exists setup_type text not null default 'D_discretionary';
do $$ begin
  alter table trades add constraint trades_setup_type_check
    check (setup_type in ('S1_funding_squeeze','S2_carry_harvest','S3_trend_breakout','D_discretionary'));
exception when duplicate_object then null;
end $$;
-- hedged=true: delta-neutral carry position — PnL = funding accrual only,
-- fees doubled (two legs). No price leg.
alter table trades add column if not exists hedged boolean not null default false;
-- Favorable price extreme since entry (max for long, min for short); drives
-- trailing stops in the auto-close sweep.
alter table trades add column if not exists peak_price numeric;
create index if not exists trades_setup_type_idx on trades (setup_type, status, closed_at desc);
