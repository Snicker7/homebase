-- Family calendar. One row per series in `events`; occurrences are expanded on
-- read by _shared/recur.js, never materialized. `office_items` is a cache of the
-- keepsitemedia.com office feed and is owned entirely by the importer.

create table public.event_categories (
  id text primary key,
  name text not null,
  -- Rendered on both themes, so the hex is picked against #1d2356 and #ffffff.
  color text not null check (color ~ '^#[0-9a-f]{6}$'),
  sort int not null default 100,
  -- The importer files items into these three and would break without them.
  system boolean not null default false,
  active boolean not null default true
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 200),
  notes text not null default '',
  category_id text not null references public.event_categories(id),
  -- Always the first occurrence of the series.
  day date not null,
  time time,
  minutes int check (minutes between 1 and 1440),
  -- A duration belongs to a timed event and only to one.
  check ((time is null) = (minutes is null)),
  repeat jsonb,
  repeat_until date check (repeat_until is null or repeat_until >= day),
  -- A rule needs something to repeat until, or forever; an end without a rule
  -- is a contradiction.
  check (repeat is not null or repeat_until is null),
  created_by text not null references public.people(email),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index events_day on public.events (day);
create index events_category on public.events (category_id);

create table public.event_exceptions (
  event_id uuid not null references public.events(id) on delete cascade,
  -- The occurrence's original date, which is how the expander finds it even
  -- after an override has moved the occurrence somewhere else.
  day date not null,
  skipped boolean not null default false,
  override jsonb,
  check (skipped or override is not null),
  primary key (event_id, day)
);

create table public.office_items (
  id text primary key,
  kind text not null check (kind in ('task', 'meeting')),
  brand text check (brand in ('keepsite', 'lova')),
  slug text not null default '',
  business text,
  title text not null default '',
  day date not null,
  time time,
  minutes int,
  done boolean not null default false,
  waits_on_client boolean not null default false,
  source text not null default '',
  stage text,
  project text,
  repeat text,
  link text,
  url text,
  fetched_at timestamptz not null default now()
);
create index office_items_day on public.office_items (day);

-- Deleting a system category would orphan every imported item, and the importer
-- would recreate them with the wrong colors on the next run.
create function public.protect_system_categories() returns trigger
  language plpgsql as $$
begin
  if old.system then
    raise exception 'category % is reserved for the office importer', old.id;
  end if;
  return old;
end $$;

create trigger event_categories_no_delete_system
  before delete on public.event_categories
  for each row execute function public.protect_system_categories();

alter table public.event_categories enable row level security;
alter table public.events enable row level security;
alter table public.event_exceptions enable row level security;
alter table public.office_items enable row level security;

-- Signed-in members read the calendar directly; every write goes through `api`.
create policy members_read_event_categories on public.event_categories for select to authenticated using (true);
create policy members_read_events on public.events for select to authenticated using (true);
create policy members_read_event_exceptions on public.event_exceptions for select to authenticated using (true);
create policy members_read_office_items on public.office_items for select to authenticated using (true);

-- New tables grant anon full privileges by default, so an anon select would
-- silently return zero rows under RLS instead of failing; revoke the grant
-- so the calendar has no anon-readable surface at all.
revoke all on public.event_categories from anon;
revoke all on public.events from anon;
revoke all on public.event_exceptions from anon;
revoke all on public.office_items from anon;
