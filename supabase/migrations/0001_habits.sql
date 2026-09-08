create extension if not exists pgtap with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create table public.people (
  email text primary key check (email = lower(email)),
  name text not null
);

create table public.categories (
  id text primary key,
  kind text not null check (kind in ('habit', 'chore')),
  name text not null,
  active boolean not null default true,
  config jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.ledger (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  type text not null check (type in ('entry', 'bonus', 'spend', 'deposit', 'claim', 'penalty')),
  category text,
  period_key text,
  result text,
  freeze_used boolean not null default false,
  amount numeric(10,2) not null default 0,
  balance_after numeric(10,2),
  actor text not null references public.people(email),
  note text not null default ''
);
create index ledger_actor_ts on public.ledger (actor, ts);
create index ledger_category_period on public.ledger (category, period_key);

create table public.habit_state (
  actor text not null references public.people(email),
  category text not null,
  state jsonb not null,
  primary key (actor, category)
);

create table public.chore_state (
  category text primary key,
  state jsonb not null
);

create table public.settings (
  key text primary key,
  value jsonb not null
);

create table public.holidays (
  day date primary key
);

-- Nothing is readable from the browser in phase 1; every access goes through
-- an edge function running as the service role.
alter table public.people enable row level security;
alter table public.categories enable row level security;
alter table public.ledger enable row level security;
alter table public.habit_state enable row level security;
alter table public.chore_state enable row level security;
alter table public.settings enable row level security;
alter table public.holidays enable row level security;

-- Signups are closed: only the two rows in people may authenticate.
create or replace function public.enforce_allowlist()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.people where email = lower(new.email)) then
    raise exception 'signups are closed';
  end if;
  return new;
end $$;

drop trigger if exists enforce_allowlist on auth.users;
create trigger enforce_allowlist
  before insert on auth.users
  for each row execute function public.enforce_allowlist();
