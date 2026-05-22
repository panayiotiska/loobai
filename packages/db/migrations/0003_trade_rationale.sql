-- 0003: structured trade rationale + postmortems
-- Forces the agent to articulate the retail / institutional / adversarial view
-- BEFORE opening a trade, and a structured postmortem when the trade closes.
-- The goal is to make every closed trade produce a readable lesson on the next run.

alter table trades add column if not exists regime_at_entry text;
alter table trades add column if not exists retail_view text;
alter table trades add column if not exists institutional_view text;
alter table trades add column if not exists adversarial_view text;
alter table trades add column if not exists confirming_signals jsonb;
alter table trades add column if not exists invalidation_signal text;
alter table trades add column if not exists expected_holding_period text;
alter table trades add column if not exists postmortem jsonb;
