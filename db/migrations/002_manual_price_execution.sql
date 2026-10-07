-- Existing price configurations are preserved. This migration adds execution state.
alter table public.manual_price_configs
  alter column expires_at drop not null;
update public.manual_price_configs set expires_at = null where expires_at is not null;

create table if not exists public.manual_price_controls (
  account_ref text primary key,
  desired_config_id uuid references public.manual_price_configs(id),
  active_config_id uuid references public.manual_price_configs(id),
  paused boolean not null default false,
  revision bigint not null default 0,
  worker_id text,
  worker_heartbeat_at timestamptz,
  evaluation_started_at timestamptz,
  evaluation_ends_at timestamptz,
  initial_capital_krw bigint,
  last_error text,
  updated_at timestamptz not null default now()
);

create table if not exists public.manual_price_cycles (
  id uuid primary key default gen_random_uuid(),
  account_ref text not null,
  config_id uuid not null references public.manual_price_configs(id),
  status text not null check (status in ('waiting_buy','buy_pending','buying','sell_pending','selling','completed','blocked','needs_reconciliation')),
  quantity integer not null default 0 check (quantity >= 0),
  realized_pnl_krw bigint,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error text
);
create unique index if not exists manual_price_one_open_cycle_idx
  on public.manual_price_cycles(account_ref)
  where status not in ('completed','blocked','needs_reconciliation');

create table if not exists public.manual_price_orders (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.manual_price_cycles(id),
  client_order_key text not null unique,
  side text not null check (side in ('buy','sell')),
  limit_price_krw bigint not null check (limit_price_krw > 0),
  requested_quantity integer not null check (requested_quantity > 0),
  broker_order_id text,
  status text not null check (status in ('intent','accepted','unknown','partially_filled','filled','cancel_pending','cancelled','rejected')),
  filled_quantity integer not null default 0 check (filled_quantity >= 0),
  submitted_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists manual_price_orders_cycle_idx on public.manual_price_orders(cycle_id, side);

create table if not exists public.manual_price_fills (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.manual_price_orders(id),
  broker_fill_key text not null unique,
  quantity integer not null check (quantity > 0),
  price_krw bigint not null check (price_krw > 0),
  fee_krw bigint not null default 0 check (fee_krw >= 0),
  tax_krw bigint not null default 0 check (tax_krw >= 0),
  filled_at timestamptz not null
);

create index if not exists manual_price_configs_account_created_idx
  on public.manual_price_configs(account_ref, created_at desc);

alter table public.manual_price_controls enable row level security;
alter table public.manual_price_cycles enable row level security;
alter table public.manual_price_orders enable row level security;
alter table public.manual_price_fills enable row level security;

drop policy if exists manual_price_controls_paper_access on public.manual_price_controls;
create policy manual_price_controls_paper_access on public.manual_price_controls
  for all to anon, authenticated using (true) with check (true);
drop policy if exists manual_price_cycles_paper_access on public.manual_price_cycles;
create policy manual_price_cycles_paper_access on public.manual_price_cycles
  for all to anon, authenticated using (true) with check (true);
drop policy if exists manual_price_orders_paper_access on public.manual_price_orders;
create policy manual_price_orders_paper_access on public.manual_price_orders
  for all to anon, authenticated using (true) with check (true);
drop policy if exists manual_price_fills_paper_access on public.manual_price_fills;
create policy manual_price_fills_paper_access on public.manual_price_fills
  for all to anon, authenticated using (true) with check (true);
