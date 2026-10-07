create table if not exists public.manual_price_configs (
  id uuid primary key default gen_random_uuid(),
  account_ref text not null default 'PAPER-ACCOUNT',
  mode text not null default 'paper' check (mode = 'paper'),
  symbol text not null default '229200' check (symbol = '229200'),
  version bigint generated always as identity,
  buy_price_krw bigint not null check (buy_price_krw > 0),
  sell_price_krw bigint not null check (sell_price_krw > buy_price_krw),
  budget_krw bigint not null check (budget_krw between 1 and 1000000),
  planned_quantity integer not null check (planned_quantity > 0),
  buy_fee_krw bigint not null check (buy_fee_krw >= 0),
  sell_fee_krw bigint not null check (sell_fee_krw >= 0),
  tax_krw bigint not null default 0 check (tax_krw >= 0),
  expected_net_profit_krw bigint not null check (expected_net_profit_krw > 0),
  commission_rate numeric not null,
  status text not null default 'pending' check (status in ('pending','active','completed','expired','cancelled')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

create unique index if not exists manual_price_configs_account_version_idx
  on public.manual_price_configs(account_ref, version);
create index if not exists manual_price_configs_latest_idx
  on public.manual_price_configs(account_ref, created_at desc);

alter table public.manual_price_configs enable row level security;
drop policy if exists manual_price_configs_paper_access on public.manual_price_configs;
create policy manual_price_configs_paper_access on public.manual_price_configs
  for all to anon, authenticated using (mode = 'paper') with check (mode = 'paper');
