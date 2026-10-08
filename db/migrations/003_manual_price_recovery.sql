-- Keep cumulative broker execution totals on the order, not fictional individual fills.
alter table public.manual_price_orders
  add column if not exists average_fill_price_krw numeric,
  add column if not exists filled_amount_krw bigint,
  add column if not exists estimated_fee_krw bigint,
  add column if not exists costs_confirmed boolean not null default false;
alter table public.manual_price_cycles
  add column if not exists estimated_pnl_krw bigint;
-- Existing blocked cycles remain visible. Do not silently remove duplicate historical rows.
-- The runner refuses all unfinished account cycles before creating another one.
