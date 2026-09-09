-- Bank sync. Access tokens live in Vault; plaid_items holds only the vault id.
create extension if not exists supabase_vault;

create table public.budget_categories (
  id text primary key,
  name text not null,
  emoji text not null default '',
  kind text not null check (kind in ('spend', 'income', 'transfer', 'wallet')),
  wallet_owner text references public.people(email),
  check ((kind = 'wallet') = (wallet_owner is not null))
);

create table public.plaid_items (
  id text primary key,
  institution text not null default '',
  access_token_id uuid not null,
  cursor text,
  status text not null default 'ok' check (status in ('ok', 'login_required', 'error')),
  error text not null default '',
  linked_by text not null references public.people(email),
  last_synced_at timestamptz
);

create table public.accounts (
  id text primary key,
  item_id text not null references public.plaid_items(id) on delete cascade,
  name text not null,
  type text not null default '',
  subtype text not null default '',
  mask text not null default '',
  current_balance numeric(12,2),
  balance_as_of timestamptz
);

create table public.transactions (
  id text primary key,
  account_id text not null references public.accounts(id) on delete cascade,
  date date not null,
  amount numeric(12,2) not null,
  merchant text not null default '',
  pending boolean not null default false,
  plaid_category text,
  category_id text references public.budget_categories(id),
  note text not null default '',
  removed_at timestamptz,
  categorized_by text check (categorized_by in ('rule', 'user'))
);
create index transactions_inbox on public.transactions (date desc)
  where category_id is null and removed_at is null;
create index transactions_category_date on public.transactions (category_id, date);

create table public.category_rules (
  id serial primary key,
  pattern text not null,
  category_id text not null references public.budget_categories(id) on delete cascade,
  priority integer not null default 100
);

alter table public.budget_categories enable row level security;
alter table public.plaid_items enable row level security;
alter table public.accounts enable row level security;
alter table public.transactions enable row level security;
alter table public.category_rules enable row level security;

-- Signed-in members read the budget tables directly; every write goes through
-- a function. plaid_items has no client policy at all.
create policy members_read_budget_categories on public.budget_categories for select to authenticated using (true);
create policy members_read_accounts on public.accounts for select to authenticated using (true);
create policy members_read_transactions on public.transactions for select to authenticated using (true);
create policy members_read_category_rules on public.category_rules for select to authenticated using (true);

-- What the browser may know about a linked bank: never the vault id or cursor.
create view public.bank_items as
  select id, institution, status, error, linked_by, last_synced_at from public.plaid_items;
revoke all on public.bank_items from anon;
grant select on public.bank_items to authenticated;
