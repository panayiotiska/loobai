-- 0004: tiered conviction gate
-- Adds size_class to distinguish scout (small, exploratory, 0.55+ confidence,
-- ≥1 signal) from conviction (full size, 0.65+ confidence, ≥2 signals).
-- Defaults to 'conviction' so existing rows keep their semantics.

alter table trades add column if not exists size_class text not null default 'conviction'
  check (size_class in ('scout', 'conviction'));
