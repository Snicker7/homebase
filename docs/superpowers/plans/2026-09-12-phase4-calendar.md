# Family calendar implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Google Calendar with a shared, color-coded family calendar in Homebase that imports the Keepsite/Lova office feed and mails a three-day agenda each morning.

**Architecture:** Four new tables read directly by the browser under RLS; one row per repeating series, expanded into occurrences by a pure shared module that the browser, the digest, and the import script all import. Writes ride the `api` function on the same path bank actions take — direct SQL, no snapshot, no advisory lock. The hourly `dispatch` imports the office feed and sends the digest.

**Tech Stack:** Postgres (Supabase), Deno edge functions, vanilla ES modules with no build step, `node --test`, pgTAP, Resend.

**Spec:** `docs/superpowers/specs/2026-09-12-family-calendar-design.md`

## Global Constraints

- Days are `'YYYY-MM-DD'` strings and times are `'HH:MM'` strings, both `America/Denver` wall-clock. Never build a `Date` from them in local time, never convert, never store an instant. Where date arithmetic is needed, use `Date.UTC` on the parts.
- `supabase/functions/_shared/recur.js` must be plain ES: no `npm:` specifiers, no Deno globals, no imports at all. The browser fetches it directly from `/supabase/functions/_shared/recur.js`.
- Every `innerHTML` interpolation goes through `esc()` from `js/util.js`.
- Tests run with `npm test`, which is `node --test supabase/functions/_shared/ scripts/ js/`. Any new `*.test.js` in those three directories runs automatically.
- SQL tests are pgTAP, run against the local database. Follow `supabase/tests/0003_reports.sql`.
- New tables get RLS on, one `for select to authenticated using (true)` policy, and no write policy.
- Seeded category colors, exactly: `family #57c785`, `appointments #ef6f8e`, `school #e8b84b`, `social #f2924b`, `travel #3fbfae`, `birthdays #c97ae0`, `keepsite #7f8cf0`, `lova #5ec8f2`, `office #8d9bb5`.
- The only four `repeat` shapes: `{"freq":"daily"}`, `{"freq":"weekly","days":[1,3,5]}`, `{"freq":"monthly","day":15}`, `{"freq":"yearly"}`. Weekday numbers are ISO: Monday 1 through Sunday 7.
- A monthly rule on a day the month lacks skips that month. A yearly rule on 29 February skips common years. Never slide.
- Commit after every task. Imperative subject under 50 characters.

---

### Task 1: Schema, seed rows, and SQL tests

**Files:**
- Create: `supabase/migrations/0004_calendar.sql`
- Create: `supabase/tests/0004_calendar.sql`
- Modify: `supabase/seed.sql` (append)

**Interfaces:**
- Consumes: `public.people(email)` from `0001_habits.sql`.
- Produces: tables `event_categories`, `events`, `event_exceptions`, `office_items`, with the column names every later task uses verbatim.

- [ ] **Step 1: Write the failing SQL test**

Create `supabase/tests/0004_calendar.sql`:

```sql
begin;
select plan(14);

select has_table('public', 'event_categories', 'event_categories exists');
select has_table('public', 'events', 'events exists');
select has_table('public', 'event_exceptions', 'event_exceptions exists');
select has_table('public', 'office_items', 'office_items exists');

-- The seeded set: six family categories and three the importer owns.
select is((select count(*)::int from public.event_categories), 9, 'nine categories are seeded');
select is((select count(*)::int from public.event_categories where system), 3, 'three are system rows');
select is((select color from public.event_categories where id = 'family'), '#57c785', 'family keeps its color');

insert into public.people (email, name) values ('ann@x.com', 'Ann') on conflict do nothing;
insert into public.events (id, title, category_id, day, created_by) values
  ('11111111-1111-1111-1111-111111111111', 'Soccer', 'family', '2026-09-15', 'ann@x.com');

-- An exception hangs off an event and dies with it.
insert into public.event_exceptions (event_id, day, skipped) values
  ('11111111-1111-1111-1111-111111111111', '2026-09-22', true);
select is((select count(*)::int from public.event_exceptions), 1, 'exception stored');
delete from public.events where id = '11111111-1111-1111-1111-111111111111';
select is((select count(*)::int from public.event_exceptions), 0, 'exceptions cascade with the event');

-- A timed event needs a duration; an all-day event must not have one.
select throws_ok(
  $$insert into public.events (title, category_id, day, time, minutes, created_by)
    values ('Bad', 'family', '2026-09-15', '09:00', null, 'ann@x.com')$$,
  '23514', NULL, 'a timed event without minutes is refused');
select throws_ok(
  $$insert into public.events (title, category_id, day, time, minutes, created_by)
    values ('Bad', 'family', '2026-09-15', null, 30, 'ann@x.com')$$,
  '23514', NULL, 'an all-day event with minutes is refused');

-- A system category cannot be deleted.
select throws_ok(
  $$delete from public.event_categories where id = 'keepsite'$$,
  'P0001', NULL, 'system categories are protected');

-- anon reads nothing.
set local role anon;
select throws_ok('select * from public.events', '42501', NULL, 'anon cannot read events');
select throws_ok('select * from public.office_items', '42501', NULL, 'anon cannot read office_items');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx supabase start
psql "$DB_URL" -f supabase/tests/0004_calendar.sql
```

Expected: FAIL, `relation "public.event_categories" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0004_calendar.sql`:

```sql
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
```

- [ ] **Step 4: Append the seed rows**

Append to `supabase/seed.sql`:

```sql
insert into public.event_categories (id, name, color, sort, system) values
  ('family',       'Family',       '#57c785', 10, false),
  ('appointments', 'Appointments', '#ef6f8e', 20, false),
  ('school',       'School',       '#e8b84b', 30, false),
  ('social',       'Social',       '#f2924b', 40, false),
  ('travel',       'Travel',       '#3fbfae', 50, false),
  ('birthdays',    'Birthdays',    '#c97ae0', 60, false),
  ('keepsite',     'Keepsite',     '#7f8cf0', 70, true),
  ('lova',         'Lova',         '#5ec8f2', 80, true),
  ('office',       'Office',       '#8d9bb5', 90, true)
on conflict do nothing;

insert into public.settings (key, value) values ('calendarDigestTime', '"07:00"'::jsonb)
on conflict do nothing;
```

- [ ] **Step 5: Apply and run the test to verify it passes**

```bash
npx supabase db reset
psql "$DB_URL" -f supabase/tests/0004_calendar.sql
```

Expected: all 14 assertions pass, `ok 14`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0004_calendar.sql supabase/tests/0004_calendar.sql supabase/seed.sql
git commit -m "Add calendar schema and seed categories"
```

---

### Task 2: `recur.js`, the occurrence expander

The one piece of real logic in this phase. Everything downstream reads occurrences from it.

**Files:**
- Create: `supabase/functions/_shared/recur.js`
- Test: `supabase/functions/_shared/recur.test.js`

**Interfaces:**
- Consumes: nothing. No imports at all.
- Produces:
  - `expandAll(seriesList, exceptions, from, to) → Occurrence[]`, sorted.
  - `expandSeries(series, exceptions, from, to) → Occurrence[]`, unsorted, unfiltered by moved day.
  - `officeOccurrence(row) → Occurrence`.
  - `sortOccurrences(list) → list` (sorts in place, returns it).
  - `addDays(day, n)`, `weekday(day)`, `daysInMonth(year, month)`.
  - `MAX_WINDOW_DAYS`.
  - A **Series** is `{ id, title, notes, categoryId, day, time, minutes, repeat, repeatUntil }`.
  - An **Occurrence** is `{ eventId, seriesDay, day, title, notes, categoryId, time, minutes, repeating, readOnly, url, business, done, waitsOnClient }`.
  - An **Exception** is `{ eventId, day, skipped, override }`.

- [ ] **Step 1: Write the failing tests**

Create `supabase/functions/_shared/recur.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { expandAll, expandSeries, officeOccurrence, sortOccurrences, addDays, weekday, daysInMonth } from './recur.js';

const series = (over) => Object.assign({
  id: 'e1', title: 'Thing', notes: '', categoryId: 'family',
  day: '2026-09-15', time: null, minutes: null, repeat: null, repeatUntil: null,
}, over);
const days = (list) => list.map((o) => o.day);

test('day helpers work on strings without touching local time', () => {
  assert.strictEqual(addDays('2026-09-15', 1), '2026-09-16');
  assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(addDays('2026-03-01', -1), '2026-02-28');
  assert.strictEqual(weekday('2026-09-14'), 1, 'Monday is 1');
  assert.strictEqual(weekday('2026-09-20'), 7, 'Sunday is 7');
  assert.strictEqual(daysInMonth(2026, 2), 28);
  assert.strictEqual(daysInMonth(2028, 2), 29);
});

test('a one-off appears only inside the window', () => {
  const s = series();
  assert.deepStrictEqual(days(expandSeries(s, [], '2026-09-01', '2026-09-30')), ['2026-09-15']);
  assert.deepStrictEqual(expandSeries(s, [], '2026-10-01', '2026-10-31'), []);
});

test('a daily rule fills the window and stops at repeat_until', () => {
  const s = series({ repeat: { freq: 'daily' }, repeatUntil: '2026-09-18' });
  assert.deepStrictEqual(days(expandSeries(s, [], '2026-09-01', '2026-09-30')),
    ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']);
});

test('repeat_until is inclusive', () => {
  const s = series({ repeat: { freq: 'daily' }, repeatUntil: '2026-09-16' });
  assert.deepStrictEqual(days(expandSeries(s, [], '2026-09-01', '2026-09-30')), ['2026-09-15', '2026-09-16']);
});

test('a weekly rule fires on its listed weekdays only', () => {
  // 2026-09-15 is a Tuesday. Tue and Thu.
  const s = series({ repeat: { freq: 'weekly', days: [2, 4] } });
  assert.deepStrictEqual(days(expandSeries(s, [], '2026-09-14', '2026-09-27')),
    ['2026-09-15', '2026-09-17', '2026-09-22', '2026-09-24']);
});

test('a weekly rule crosses the spring and autumn DST boundaries unshifted', () => {
  // DST starts 2027-03-14 and ends 2026-11-01 in Denver. Times are wall-clock,
  // so a 09:00 Sunday event is 09:00 on both sides.
  const s = series({ day: '2026-10-25', time: '09:00', minutes: 60, repeat: { freq: 'weekly', days: [7] } });
  const out = expandSeries(s, [], '2026-10-25', '2026-11-08');
  assert.deepStrictEqual(days(out), ['2026-10-25', '2026-11-01', '2026-11-08']);
  assert.ok(out.every((o) => o.time === '09:00'));
});

test('a monthly rule skips months that lack the day rather than sliding', () => {
  const s = series({ day: '2026-01-31', repeat: { freq: 'monthly', day: 31 } });
  assert.deepStrictEqual(days(expandSeries(s, [], '2026-01-01', '2026-05-31')),
    ['2026-01-31', '2026-03-31', '2026-05-31']);
});

test('a yearly rule on 29 February skips common years', () => {
  const s = series({ day: '2028-02-29', repeat: { freq: 'yearly' } });
  assert.deepStrictEqual(days(expandSeries(s, [], '2028-01-01', '2033-12-31')),
    ['2028-02-29', '2032-02-29']);
});

test('a yearly rule carries a birthday forever', () => {
  const s = series({ day: '1991-06-04', repeat: { freq: 'yearly' } });
  assert.deepStrictEqual(days(expandSeries(s, [], '2026-01-01', '2026-12-31')), ['2026-06-04']);
});

test('a skipped occurrence disappears and the rest stay', () => {
  const s = series({ repeat: { freq: 'weekly', days: [2] } });
  const ex = [{ eventId: 'e1', day: '2026-09-22', skipped: true, override: null }];
  assert.deepStrictEqual(days(expandSeries(s, ex, '2026-09-15', '2026-09-29')), ['2026-09-15', '2026-09-29']);
});

test('an override changes one occurrence and leaves the series alone', () => {
  const s = series({ repeat: { freq: 'weekly', days: [2] }, time: '09:00', minutes: 30 });
  const ex = [{ eventId: 'e1', day: '2026-09-22', skipped: false, override: { title: 'Moved', time: '14:00' } }];
  const out = expandSeries(s, ex, '2026-09-15', '2026-09-29');
  assert.deepStrictEqual(out.map((o) => [o.day, o.title, o.time]), [
    ['2026-09-15', 'Thing', '09:00'],
    ['2026-09-22', 'Moved', '14:00'],
    ['2026-09-29', 'Thing', '09:00'],
  ]);
});

test('an exception belonging to another event is ignored', () => {
  const s = series({ repeat: { freq: 'weekly', days: [2] } });
  const ex = [{ eventId: 'other', day: '2026-09-22', skipped: true, override: null }];
  assert.strictEqual(expandSeries(s, ex, '2026-09-15', '2026-09-29').length, 3);
});

test('expandAll follows an occurrence moved into the window and drops one moved out', () => {
  const s = series({ id: 'e1', day: '2026-09-01', repeat: { freq: 'monthly', day: 1 } });
  const ex = [
    // Moved out of October, and into October from November.
    { eventId: 'e1', day: '2026-10-01', skipped: false, override: { day: '2026-09-30' } },
    { eventId: 'e1', day: '2026-11-01', skipped: false, override: { day: '2026-10-31' } },
  ];
  assert.deepStrictEqual(days(expandAll([s], ex, '2026-10-01', '2026-10-31')), ['2026-10-31']);
});

test('seriesDay stays the original date after a move, so the exception can be found again', () => {
  const s = series({ repeat: { freq: 'weekly', days: [2] } });
  const ex = [{ eventId: 'e1', day: '2026-09-22', skipped: false, override: { day: '2026-09-24' } }];
  const moved = expandSeries(s, ex, '2026-09-15', '2026-09-29').find((o) => o.day === '2026-09-24');
  assert.strictEqual(moved.seriesDay, '2026-09-22');
});

test('a window wider than five years is refused rather than spun over', () => {
  const s = series({ repeat: { freq: 'daily' } });
  assert.throws(() => expandSeries(s, [], '2020-01-01', '2030-01-01'), /window/);
});

test('office rows become occurrences filed under their brand', () => {
  const task = officeOccurrence({
    id: 'abc', kind: 'task', brand: 'keepsite', slug: 'sapphire-stem-floral', business: 'Sapphire Stem Floral',
    title: 'Layouts approved', day: '2026-09-15', time: null, minutes: null, done: false,
    waits_on_client: false, url: 'https://example.com/x',
  });
  assert.strictEqual(task.categoryId, 'keepsite');
  assert.strictEqual(task.readOnly, true);
  assert.strictEqual(task.business, 'Sapphire Stem Floral');

  const own = officeOccurrence({ id: 'd', kind: 'task', brand: null, title: 'Post', day: '2026-09-19', time: '09:00:00' });
  assert.strictEqual(own.categoryId, 'office', 'a brand-free own task files under office');
  assert.strictEqual(own.time, '09:00', 'a Postgres time loses its seconds');
});

test('sorting puts all-day items before timed ones, then by time, then by title', () => {
  const at = (day, time, title) => ({ day, time, title });
  const out = sortOccurrences([
    at('2026-09-16', '09:00', 'B'), at('2026-09-15', '14:00', 'Late'),
    at('2026-09-15', null, 'Zebra'), at('2026-09-15', null, 'Apple'), at('2026-09-15', '09:00', 'Early'),
  ]);
  assert.deepStrictEqual(out.map((o) => o.title), ['Apple', 'Zebra', 'Early', 'Late', 'B']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test supabase/functions/_shared/recur.test.js`
Expected: FAIL, `Cannot find module ... recur.js`.

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/_shared/recur.js`:

```js
// Stored rows in, occurrences out. Pure: no I/O, no clock, no imports, so the
// browser, dispatch, and the import script all run the same expansion.
//
// Days are 'YYYY-MM-DD' and times are 'HH:MM', both Denver wall-clock. They
// stay strings the whole way through: a 09:00 event is 09:00 on both sides of
// a DST boundary, which is only true because nothing here builds a local Date.

const DAY_MS = 86400000;
// Five years. A typo in repeat_until must not become an infinite loop.
export const MAX_WINDOW_DAYS = 1830;

const utc = (day) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
const pad = (n) => (n < 10 ? '0' : '') + n;
const makeDay = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);

export const addDays = (day, n) => new Date(utc(day) + n * DAY_MS).toISOString().slice(0, 10);
// ISO weekday: Monday 1 through Sunday 7.
export const weekday = (day) => ((new Date(utc(day)).getUTCDay() + 6) % 7) + 1;
// month is 1-12. Day zero of the next month is the last day of this one.
export const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const OVERRIDABLE = ['title', 'notes', 'categoryId', 'day', 'time', 'minutes'];

function occurrence(s, day) {
  return {
    eventId: s.id,
    // The date the rule produced, kept even when an override moves the
    // occurrence: it is the key of the exception row.
    seriesDay: day,
    day,
    title: s.title,
    notes: s.notes || '',
    categoryId: s.categoryId,
    time: s.time ? String(s.time).slice(0, 5) : null,
    minutes: s.minutes == null ? null : Number(s.minutes),
    repeating: !!s.repeat,
    readOnly: false,
    url: null,
    business: null,
    done: false,
    waitsOnClient: false,
  };
}

function* occurrenceDays(s, from, to) {
  const start = s.day;
  const last = s.repeatUntil && s.repeatUntil < to ? s.repeatUntil : to;
  if (!s.repeat) {
    if (start >= from && start <= to) yield start;
    return;
  }
  if (start > last) return;
  const r = s.repeat;

  if (r.freq === 'daily' || r.freq === 'weekly') {
    for (let d = start < from ? from : start; d <= last; d = addDays(d, 1)) {
      if (r.freq === 'daily' || r.days.includes(weekday(d))) yield d;
    }
    return;
  }

  if (r.freq === 'monthly') {
    const begin = start < from ? from : start;
    let y = +begin.slice(0, 4);
    let m = +begin.slice(5, 7);
    for (;;) {
      const dim = daysInMonth(y, m);
      // The 31st simply does not happen in a 30-day month. It never slides.
      if (r.day <= dim) {
        const d = makeDay(y, m, r.day);
        if (d > last) return;
        if (d >= from && d >= start) yield d;
      }
      if (makeDay(y, m, dim) >= last) return;
      if (++m > 12) { m = 1; y++; }
    }
  }

  if (r.freq === 'yearly') {
    const mo = +start.slice(5, 7);
    const dy = +start.slice(8, 10);
    const first = Math.max(+start.slice(0, 4), +from.slice(0, 4));
    for (let y = first; y <= +last.slice(0, 4); y++) {
      // 29 February in a common year is skipped, not moved to the 28th.
      if (dy > daysInMonth(y, mo)) continue;
      const d = makeDay(y, mo, dy);
      if (d >= from && d <= last && d >= start) yield d;
    }
  }
}

export function expandSeries(series, exceptions, from, to) {
  if ((utc(to) - utc(from)) / DAY_MS > MAX_WINDOW_DAYS) {
    throw new Error('window wider than ' + MAX_WINDOW_DAYS + ' days');
  }
  const ex = new Map();
  for (const e of exceptions) if (e.eventId === series.id) ex.set(e.day, e);
  const out = [];
  for (const day of occurrenceDays(series, from, to)) {
    const hit = ex.get(day);
    if (hit && hit.skipped) continue;
    const o = occurrence(series, day);
    if (hit && hit.override) {
      for (const k of OVERRIDABLE) if (hit.override[k] !== undefined) o[k] = hit.override[k];
      if (o.time) o.time = String(o.time).slice(0, 5);
    }
    out.push(o);
  }
  return out;
}

// Pad, then filter on the moved day: an override can carry an occurrence across
// either edge of the window, in or out, and the caller asked about days rather
// than about rules.
const PAD_DAYS = 31;

export function expandAll(seriesList, exceptions, from, to) {
  const out = [];
  for (const s of seriesList) {
    for (const o of expandSeries(s, exceptions, addDays(from, -PAD_DAYS), addDays(to, PAD_DAYS))) {
      if (o.day >= from && o.day <= to) out.push(o);
    }
  }
  return sortOccurrences(out);
}

// An office row is already one occurrence; it just speaks snake_case. Items with
// no brand are own tasks and belong to neither business.
export function officeOccurrence(row) {
  return {
    eventId: row.id,
    seriesDay: row.day,
    day: row.day,
    title: row.title || '',
    notes: '',
    categoryId: row.brand || 'office',
    time: row.time ? String(row.time).slice(0, 5) : null,
    minutes: row.minutes == null ? null : Number(row.minutes),
    repeating: false,
    readOnly: true,
    url: row.url || null,
    business: row.business || null,
    done: row.done === true,
    waitsOnClient: row.waits_on_client === true,
  };
}

// All-day first, because that is how a day reads: the backdrop, then the clock.
export function sortOccurrences(list) {
  return list.sort((a, b) =>
    (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) ||
    ((a.time ? 1 : 0) - (b.time ? 1 : 0)) ||
    ((a.time || '') < (b.time || '') ? -1 : (a.time || '') > (b.time || '') ? 1 : 0) ||
    String(a.title).localeCompare(String(b.title)));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test supabase/functions/_shared/recur.test.js`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/recur.js supabase/functions/_shared/recur.test.js
git commit -m "Add recurrence expansion"
```

---

### Task 3: Validators and calendar SQL

**Files:**
- Create: `supabase/functions/_shared/calactions.js`
- Create: `supabase/functions/_shared/caldb.js`
- Test: `supabase/functions/_shared/calactions.test.js`

**Interfaces:**
- Consumes: `weekday` from `recur.js`.
- Produces:
  - `CAL_ACTIONS: string[]`
  - `validateEvent(p) → { error } | { id, title, notes, categoryId, day, time, minutes, repeat, repeatUntil }` — `id` is null on a create.
  - `validateOccurrence(p) → { error } | { eventId, day, skipped, override }`
  - `validateEventCategory(p) → { error } | { id, name, color, sort }`
  - `validateId(p, field) → { error } | { id }`
  - caldb: `saveEvent`, `deleteEvent`, `saveOccurrence`, `saveCategory`, `retireCategory`, `listSeries`, `listExceptions`, `listOfficeItems`, `replaceOfficeWindow`.

- [ ] **Step 1: Write the failing validator tests**

Create `supabase/functions/_shared/calactions.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { CAL_ACTIONS, validateEvent, validateOccurrence, validateEventCategory, validateId } from './calactions.js';

const ok = (over) => Object.assign({
  title: 'Soccer', categoryId: 'family', day: '2026-09-15', time: null, minutes: null,
}, over);

test('the action list is what api routes on', () => {
  assert.deepStrictEqual(CAL_ACTIONS, [
    'eventSave', 'eventDelete', 'occurrenceSkip', 'occurrenceSave',
    'calCategorySave', 'calCategoryRetire', 'officeRefresh',
  ]);
});

test('a minimal all-day event validates and normalizes', () => {
  const v = validateEvent(ok());
  assert.deepStrictEqual(v, {
    id: null, title: 'Soccer', notes: '', categoryId: 'family', day: '2026-09-15',
    time: null, minutes: null, repeat: null, repeatUntil: null,
  });
});

test('a timed event keeps its duration and defaults nothing silently', () => {
  const v = validateEvent(ok({ time: '09:00', minutes: 30 }));
  assert.strictEqual(v.time, '09:00');
  assert.strictEqual(v.minutes, 30);
});

test('titles and dates are required and bounded', () => {
  assert.match(validateEvent(ok({ title: '   ' })).error, /title/);
  assert.match(validateEvent(ok({ title: 'x'.repeat(201) })).error, /200/);
  assert.match(validateEvent(ok({ day: '15/09/2026' })).error, /date/);
  assert.match(validateEvent(ok({ day: '2026-02-30' })).error, /date/);
  assert.match(validateEvent(ok({ categoryId: '' })).error, /category/);
});

test('a time needs a duration and a duration needs a time', () => {
  assert.match(validateEvent(ok({ time: '09:00' })).error, /how long/);
  assert.match(validateEvent(ok({ minutes: 30 })).error, /all-day/);
  assert.match(validateEvent(ok({ time: '9am', minutes: 30 })).error, /time/);
  assert.match(validateEvent(ok({ time: '09:00', minutes: 0 })).error, /1 and 1440/);
  assert.match(validateEvent(ok({ time: '09:00', minutes: 2000 })).error, /1 and 1440/);
});

test('the four repeat shapes are accepted', () => {
  // 2026-09-15 is a Tuesday, so weekly must list 2.
  assert.deepStrictEqual(validateEvent(ok({ repeat: { freq: 'daily' } })).repeat, { freq: 'daily' });
  assert.deepStrictEqual(validateEvent(ok({ repeat: { freq: 'weekly', days: [2, 4] } })).repeat, { freq: 'weekly', days: [2, 4] });
  assert.deepStrictEqual(validateEvent(ok({ repeat: { freq: 'monthly', day: 15 } })).repeat, { freq: 'monthly', day: 15 });
  assert.deepStrictEqual(validateEvent(ok({ repeat: { freq: 'yearly' } })).repeat, { freq: 'yearly' });
});

test('anything outside those four shapes is refused', () => {
  assert.match(validateEvent(ok({ repeat: { freq: 'fortnightly' } })).error, /repeat/);
  assert.match(validateEvent(ok({ repeat: { freq: 'weekly', days: [] } })).error, /weekday/);
  assert.match(validateEvent(ok({ repeat: { freq: 'weekly', days: [9] } })).error, /weekday/);
  // The start day must be one of the repeat's own days, or the first
  // occurrence would not be the day the event says it starts.
  assert.match(validateEvent(ok({ repeat: { freq: 'weekly', days: [3] } })).error, /starts on a Tuesday/);
  // Likewise monthly: the rule's day is the start's day of month.
  assert.match(validateEvent(ok({ repeat: { freq: 'monthly', day: 20 } })).error, /15th/);
});

test('an end date needs a rule and cannot precede the start', () => {
  assert.match(validateEvent(ok({ repeatUntil: '2026-12-31' })).error, /repeat/);
  assert.match(validateEvent(ok({ repeat: { freq: 'daily' }, repeatUntil: '2026-09-01' })).error, /before/);
  assert.strictEqual(validateEvent(ok({ repeat: { freq: 'daily' }, repeatUntil: '2026-09-15' })).repeatUntil, '2026-09-15');
});

test('an occurrence change names its event and its original day', () => {
  const v = validateOccurrence({ eventId: 'e1', day: '2026-09-22', skipped: true });
  assert.deepStrictEqual(v, { eventId: 'e1', day: '2026-09-22', skipped: true, override: null });
  const moved = validateOccurrence({ eventId: 'e1', day: '2026-09-22', override: { day: '2026-09-24', title: 'Moved' } });
  assert.deepStrictEqual(moved.override, { day: '2026-09-24', title: 'Moved' });
  assert.match(validateOccurrence({ day: '2026-09-22', skipped: true }).error, /event/);
  assert.match(validateOccurrence({ eventId: 'e1', day: '2026-09-22' }).error, /nothing to change/);
  assert.match(validateOccurrence({ eventId: 'e1', day: 'x', skipped: true }).error, /date/);
  assert.match(validateOccurrence({ eventId: 'e1', day: '2026-09-22', override: { colour: 'red' } }).error, /nothing to change/);
});

test('a category needs a name and a six-digit hex color', () => {
  assert.deepStrictEqual(validateEventCategory({ name: 'Vet visits', color: '#AABBCC' }),
    { id: 'vet-visits', name: 'Vet visits', color: '#aabbcc', sort: 100 });
  assert.match(validateEventCategory({ name: '', color: '#aabbcc' }).error, /name/);
  assert.match(validateEventCategory({ name: 'x', color: 'red' }).error, /color/);
  assert.match(validateEventCategory({ name: '🙂', color: '#aabbcc' }).error, /letter or digit/);
});

test('validateId trims and refuses empty', () => {
  assert.deepStrictEqual(validateId({ id: ' e1 ' }), { id: 'e1' });
  assert.match(validateId({}).error, /required/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test supabase/functions/_shared/calactions.test.js`
Expected: FAIL, `Cannot find module ... calactions.js`.

- [ ] **Step 3: Write the validators**

Create `supabase/functions/_shared/calactions.js`:

```js
// Input checks for the calendar actions that ride on the api function. Pure, so
// the shapes are tested without a database.
import { weekday, daysInMonth } from './recur.js';

export const CAL_ACTIONS = [
  'eventSave', 'eventDelete', 'occurrenceSkip', 'occurrenceSave',
  'calCategorySave', 'calCategoryRetire', 'officeRefresh',
];

const MAX_TITLE = 200;
const MAX_NOTES = 2000;
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ORDINAL = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');

// A real calendar date, not merely a well-shaped string: 2026-02-30 parses
// nowhere and must not reach Postgres.
const isDay = (v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return false;
  const [y, m, d] = String(v).split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
};
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function validateRepeat(raw, day) {
  if (raw == null) return { repeat: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'repeat must be a rule or nothing' };
  const freq = String(raw.freq || '');
  if (freq === 'daily' || freq === 'yearly') return { repeat: { freq } };
  if (freq === 'weekly') {
    const days = Array.isArray(raw.days) ? raw.days.map(Number) : [];
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      return { error: 'a weekly repeat needs at least one weekday, 1 (Monday) to 7 (Sunday)' };
    }
    const start = weekday(day);
    if (!days.includes(start)) {
      return { error: 'this event starts on a ' + WEEKDAY_NAMES[start - 1] + ', so the repeat has to include it' };
    }
    return { repeat: { freq: 'weekly', days: [...new Set(days)].sort((a, b) => a - b) } };
  }
  if (freq === 'monthly') {
    const dom = +day.slice(8, 10);
    if (Number(raw.day) !== dom) return { error: 'this event starts on the ' + ORDINAL(dom) + ', so a monthly repeat falls on the ' + ORDINAL(dom) };
    return { repeat: { freq: 'monthly', day: dom } };
  }
  return { error: 'repeat must be daily, weekly, monthly, or yearly' };
}

export function validateEvent(p) {
  const title = String(p.title || '').trim();
  const notes = String(p.notes || '').trim();
  const categoryId = String(p.categoryId || '').trim();
  const day = String(p.day || '').trim();
  if (!title) return { error: 'title required' };
  if (title.length > MAX_TITLE) return { error: 'title must be ' + MAX_TITLE + ' characters or fewer' };
  if (notes.length > MAX_NOTES) return { error: 'notes must be ' + MAX_NOTES + ' characters or fewer' };
  if (!categoryId) return { error: 'category required' };
  if (!isDay(day)) return { error: 'date must be a real YYYY-MM-DD date' };

  const hasTime = p.time != null && p.time !== '';
  const hasMinutes = p.minutes != null && p.minutes !== '';
  if (hasTime && !isTime(p.time)) return { error: 'time must be HH:MM' };
  if (hasTime && !hasMinutes) return { error: 'a timed event needs how long it lasts' };
  if (!hasTime && hasMinutes) return { error: 'an all-day event has no length' };
  const minutes = hasMinutes ? Number(p.minutes) : null;
  if (hasMinutes && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) {
    return { error: 'length must be between 1 and 1440 minutes' };
  }

  const r = validateRepeat(p.repeat == null ? null : p.repeat, day);
  if (r.error) return { error: r.error };
  const until = p.repeatUntil == null || p.repeatUntil === '' ? null : String(p.repeatUntil).trim();
  if (until !== null) {
    if (!r.repeat) return { error: 'an end date needs a repeat' };
    if (!isDay(until)) return { error: 'end date must be a real YYYY-MM-DD date' };
    if (until < day) return { error: 'the end date is before the event starts' };
  }
  return {
    id: p.id ? String(p.id).trim() : null,
    title, notes, categoryId, day,
    time: hasTime ? String(p.time) : null,
    minutes,
    repeat: r.repeat,
    repeatUntil: until,
  };
}

const OVERRIDABLE = ['title', 'notes', 'categoryId', 'day', 'time', 'minutes'];

export function validateOccurrence(p) {
  const eventId = String(p.eventId || '').trim();
  const day = String(p.day || '').trim();
  if (!eventId) return { error: 'event required' };
  if (!isDay(day)) return { error: 'date must be a real YYYY-MM-DD date' };
  if (p.skipped === true) return { eventId, day, skipped: true, override: null };

  const raw = p.override && typeof p.override === 'object' ? p.override : {};
  const override = {};
  for (const k of OVERRIDABLE) if (raw[k] !== undefined) override[k] = raw[k];
  if (!Object.keys(override).length) return { error: 'nothing to change' };
  if (override.day !== undefined && !isDay(override.day)) return { error: 'date must be a real YYYY-MM-DD date' };
  if (override.time !== undefined && override.time !== null && !isTime(override.time)) return { error: 'time must be HH:MM' };
  if (override.title !== undefined) {
    const t = String(override.title).trim();
    if (!t) return { error: 'title required' };
    if (t.length > MAX_TITLE) return { error: 'title must be ' + MAX_TITLE + ' characters or fewer' };
    override.title = t;
  }
  return { eventId, day, skipped: false, override };
}

export function validateEventCategory(p) {
  const name = String(p.name || '').trim();
  const color = String(p.color || '').trim().toLowerCase();
  if (!name) return { error: 'name required' };
  if (!/^#[0-9a-f]{6}$/.test(color)) return { error: 'color must be a #rrggbb hex' };
  const id = p.id ? slug(p.id) : slug(name);
  if (!id) return { error: 'name needs a letter or digit' };
  const sort = Number.isInteger(Number(p.sort)) ? Number(p.sort) : 100;
  return { id, name, color, sort };
}

export function validateId(p) {
  const id = String(p.id || '').trim();
  return id ? { id } : { error: 'id required' };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test supabase/functions/_shared/calactions.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Write the SQL layer**

Create `supabase/functions/_shared/caldb.js`:

```js
// Every query the calendar runs. Callers pass a postgres.js handle; nothing
// here decides anything, it just reads and writes rows.

// Series overlapping a window: a repeating event that started years ago still
// counts, a one-off that happened years ago does not.
export async function listSeries(sql, from, to) {
  const rows = await sql`
    select id, title, notes, category_id, to_char(day, 'YYYY-MM-DD') as day,
           to_char(time, 'HH24:MI') as time, minutes, repeat,
           to_char(repeat_until, 'YYYY-MM-DD') as repeat_until
      from events
     where day <= ${to}
       and (case when repeat is null then day >= ${from}
                 else repeat_until is null or repeat_until >= ${from} end)
     order by day, id`;
  return rows.map((r) => ({
    id: r.id, title: r.title, notes: r.notes, categoryId: r.category_id,
    day: r.day, time: r.time, minutes: r.minutes,
    repeat: r.repeat, repeatUntil: r.repeat_until,
  }));
}

export async function listExceptions(sql, eventIds) {
  if (!eventIds.length) return [];
  const rows = await sql`
    select event_id, to_char(day, 'YYYY-MM-DD') as day, skipped, override
      from event_exceptions where event_id = any(${eventIds})`;
  return rows.map((r) => ({ eventId: r.event_id, day: r.day, skipped: r.skipped, override: r.override }));
}

export async function saveEvent(sql, ev) {
  const repeat = ev.repeat ? sql.json(ev.repeat) : null;
  if (ev.id) {
    const [row] = await sql`
      update events set title = ${ev.title}, notes = ${ev.notes}, category_id = ${ev.categoryId},
             day = ${ev.day}, time = ${ev.time}, minutes = ${ev.minutes},
             repeat = ${repeat}, repeat_until = ${ev.repeatUntil}, updated_at = now()
       where id = ${ev.id} returning id`;
    return row ? row.id : null;
  }
  const [row] = await sql`
    insert into events (title, notes, category_id, day, time, minutes, repeat, repeat_until, created_by)
    values (${ev.title}, ${ev.notes}, ${ev.categoryId}, ${ev.day}, ${ev.time}, ${ev.minutes},
            ${repeat}, ${ev.repeatUntil}, ${ev.user})
    returning id`;
  return row.id;
}

export async function deleteEvent(sql, id) {
  const rows = await sql`delete from events where id = ${id} returning id`;
  return rows.length > 0;
}

// One row per changed occurrence, keyed by the date the rule produced. Saving
// over an existing exception replaces it, so skip-then-edit behaves.
export async function saveOccurrence(sql, o) {
  const rows = await sql`
    insert into event_exceptions (event_id, day, skipped, override)
    values (${o.eventId}, ${o.day}, ${o.skipped}, ${o.override ? sql.json(o.override) : null})
    on conflict (event_id, day) do update set skipped = excluded.skipped, override = excluded.override
    returning event_id`;
  return rows.length > 0;
}

export async function saveCategory(sql, c) {
  await sql`
    insert into event_categories (id, name, color, sort) values (${c.id}, ${c.name}, ${c.color}, ${c.sort})
    on conflict (id) do update set name = excluded.name, color = excluded.color, sort = excluded.sort`;
}

// Retiring keeps the events that already point at the category; only the picker
// loses it. Deleting is left to the SQL editor, where the consequences are visible.
export async function retireCategory(sql, id) {
  const rows = await sql`update event_categories set active = false where id = ${id} and not system returning id`;
  return rows.length > 0;
}

export async function listOfficeItems(sql, from, to) {
  return sql`
    select id, kind, brand, slug, business, title, to_char(day, 'YYYY-MM-DD') as day,
           to_char(time, 'HH24:MI') as time, minutes, done, waits_on_client, source,
           stage, project, repeat, link, url, fetched_at
      from office_items where day >= ${from} and day <= ${to} order by day, time nulls first, id`;
}

// The window is the unit of truth: whatever the feed returned for it replaces
// whatever was there, so a deleted or rescheduled office item leaves the calendar.
export async function replaceOfficeWindow(sql, rows, from, to) {
  await sql.begin(async (tx) => {
    for (const r of rows) {
      await tx`
        insert into office_items (id, kind, brand, slug, business, title, day, time, minutes, done,
                                  waits_on_client, source, stage, project, repeat, link, url, fetched_at)
        values (${r.id}, ${r.kind}, ${r.brand}, ${r.slug}, ${r.business}, ${r.title}, ${r.day}, ${r.time},
                ${r.minutes}, ${r.done}, ${r.waits_on_client}, ${r.source}, ${r.stage}, ${r.project},
                ${r.repeat}, ${r.link}, ${r.url}, now())
        on conflict (id) do update set kind = excluded.kind, brand = excluded.brand, slug = excluded.slug,
          business = excluded.business, title = excluded.title, day = excluded.day, time = excluded.time,
          minutes = excluded.minutes, done = excluded.done, waits_on_client = excluded.waits_on_client,
          source = excluded.source, stage = excluded.stage, project = excluded.project,
          repeat = excluded.repeat, link = excluded.link, url = excluded.url, fetched_at = now()`;
    }
    const keep = rows.map((r) => r.id);
    await tx`delete from office_items where day >= ${from} and day <= ${to} and not (id = any(${keep}))`;
  });
}
```

- [ ] **Step 6: Run the whole suite and commit**

Run: `npm test`
Expected: PASS, no regressions.

```bash
git add supabase/functions/_shared/calactions.js supabase/functions/_shared/calactions.test.js supabase/functions/_shared/caldb.js
git commit -m "Add calendar validators and queries"
```

---

### Task 4: Route calendar actions through `api`

**Files:**
- Modify: `supabase/functions/api/index.ts:46-75` (the bank-action branch; add a calendar branch beside it)
- Modify: `js/api.js` (add `cal`)

**Interfaces:**
- Consumes: `CAL_ACTIONS`, `validateEvent`, `validateOccurrence`, `validateEventCategory`, `validateId` from `calactions.js`; `saveEvent`, `deleteEvent`, `saveOccurrence`, `saveCategory`, `retireCategory` from `caldb.js`.
- Produces: `cal(action, extra)` in `js/api.js`, returning `{ ok, ... }`. Every later frontend task calls it.

`officeRefresh` is in `CAL_ACTIONS` but is implemented in Task 7; until then it returns `{ ok: false, error: 'not built yet' }` from an explicit branch, never a silent fallthrough.

- [ ] **Step 1: Add the imports to `api/index.ts`**

After the existing bank imports at the top of `supabase/functions/api/index.ts`:

```ts
import * as cal from '../_shared/caldb.js';
import { CAL_ACTIONS, validateEvent, validateOccurrence, validateEventCategory, validateId } from '../_shared/calactions.js';
```

- [ ] **Step 2: Add the calendar branch**

Insert immediately **after** the closing brace of the `if (BANK_ACTIONS.includes(String(p.action))) { ... }` block and **before** the snapshot path:

```ts
  // Calendar actions carry no reward rule either, so they take the same road as
  // the bank ones: no snapshot, no advisory lock.
  if (CAL_ACTIONS.includes(String(p.action))) {
    try {
      if (p.action === 'eventSave') {
        const v = validateEvent(p);
        if ('error' in v) return json({ ok: false, error: v.error }, 400, cors);
        const id = await cal.saveEvent(sql, Object.assign({}, v, { user: p.user }));
        if (!id) return json({ ok: false, error: 'unknown event' }, 404, cors);
        return json({ ok: true, id }, 200, cors);
      }
      if (p.action === 'eventDelete') {
        const v = validateId(p);
        if ('error' in v) return json({ ok: false, error: v.error }, 400, cors);
        const hit = await cal.deleteEvent(sql, v.id);
        return hit ? json({ ok: true }, 200, cors) : json({ ok: false, error: 'unknown event' }, 404, cors);
      }
      if (p.action === 'occurrenceSkip' || p.action === 'occurrenceSave') {
        const v = validateOccurrence(p.action === 'occurrenceSkip' ? Object.assign({}, p, { skipped: true }) : p);
        if ('error' in v) return json({ ok: false, error: v.error }, 400, cors);
        const hit = await cal.saveOccurrence(sql, v);
        return hit ? json({ ok: true }, 200, cors) : json({ ok: false, error: 'unknown event' }, 404, cors);
      }
      if (p.action === 'calCategorySave') {
        const v = validateEventCategory(p);
        if ('error' in v) return json({ ok: false, error: v.error }, 400, cors);
        await cal.saveCategory(sql, v);
        return json({ ok: true, category: v }, 200, cors);
      }
      if (p.action === 'calCategoryRetire') {
        const v = validateId(p);
        if ('error' in v) return json({ ok: false, error: v.error }, 400, cors);
        const hit = await cal.retireCategory(sql, v.id);
        return hit ? json({ ok: true }, 200, cors) : json({ ok: false, error: 'that category is reserved for the office' }, 400, cors);
      }
      // officeRefresh arrives in the import task.
      return json({ ok: false, error: 'not built yet' }, 501, cors);
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      if (/foreign key/.test(msg)) return json({ ok: false, error: 'unknown category' }, 400, cors);
      if (/duplicate key/.test(msg)) return json({ ok: false, error: 'that category already exists' }, 400, cors);
      return json({ ok: false, error: msg }, 500, cors);
    }
  }
```

- [ ] **Step 3: Add the frontend caller**

In `js/api.js`, beside `bank`:

```js
// Calendar writes. Reads go straight to Postgres under RLS like every other screen.
export async function cal(action, extra) {
  const session = await getSession();
  if (!session) return { ok: false, error: 'not authorized — please log in again' };
  return post('api', Object.assign({ action }, extra || {}), session.access_token);
}
```

- [ ] **Step 4: Verify against the local function**

```bash
npx supabase functions serve --env-file supabase/functions/.env
```

In another shell, with a valid access token in `$TOKEN`:

```bash
curl -s -X POST http://127.0.0.1:54321/functions/v1/api \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"action":"eventSave","title":"Soccer","categoryId":"family","day":"2026-09-15","repeat":{"freq":"weekly","days":[2]}}'
```

Expected: `{"ok":true,"id":"..."}`. Then confirm the rejection path:

```bash
curl -s -X POST http://127.0.0.1:54321/functions/v1/api \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"action":"eventSave","title":"Soccer","categoryId":"family","day":"2026-09-15","repeat":{"freq":"weekly","days":[3]}}'
```

Expected: HTTP 400, `starts on a Tuesday`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/api/index.ts js/api.js
git commit -m "Route calendar actions through api"
```

---

### Task 5: `calgrid.js`, the pure view helpers

**Files:**
- Create: `js/calgrid.js`
- Test: `js/calgrid.test.js`

**Interfaces:**
- Consumes: `addDays`, `weekday` from `../supabase/functions/_shared/recur.js`.
- Produces:
  - `monthMatrix(ym) → string[][]` — six rows of seven `'YYYY-MM-DD'`, Sunday first.
  - `monthBounds(ym) → { from, to }` — the padded grid's first and last day.
  - `groupByDay(occurrences) → Array<{ day, items }>`, ascending, only days that have something.
  - `dayLabel(day, today) → string` — "Today", "Tomorrow", or "Tuesday 15 September".
  - `timeLabel(time, minutes) → string` — "All day" or "9:00 – 9:30 AM".
  - `shiftMonth(ym, n) → string`.

- [ ] **Step 1: Write the failing tests**

Create `js/calgrid.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { monthMatrix, monthBounds, groupByDay, dayLabel, timeLabel, shiftMonth } from './calgrid.js';

test('a month grid is six Sunday-first weeks that contain the month', () => {
  const grid = monthMatrix('2026-09');
  assert.strictEqual(grid.length, 6);
  assert.ok(grid.every((w) => w.length === 7));
  // 1 September 2026 is a Tuesday, so the grid opens on Sunday 30 August.
  assert.strictEqual(grid[0][0], '2026-08-30');
  assert.strictEqual(grid[0][2], '2026-09-01');
  assert.strictEqual(grid[5][6], '2026-10-10');
});

test('a month that starts on a Sunday still gets a leading week, never a gap', () => {
  const grid = monthMatrix('2026-11'); // 1 November 2026 is a Sunday
  assert.strictEqual(grid[0][0], '2026-11-01');
  assert.strictEqual(grid.length, 6);
});

test('monthBounds covers the whole grid, not just the month', () => {
  assert.deepStrictEqual(monthBounds('2026-09'), { from: '2026-08-30', to: '2026-10-10' });
});

test('shiftMonth walks across year ends', () => {
  assert.strictEqual(shiftMonth('2026-09', 1), '2026-10');
  assert.strictEqual(shiftMonth('2026-12', 1), '2027-01');
  assert.strictEqual(shiftMonth('2026-01', -1), '2025-12');
});

test('groupByDay keeps order and drops empty days', () => {
  const out = groupByDay([
    { day: '2026-09-15', title: 'a' }, { day: '2026-09-17', title: 'b' }, { day: '2026-09-15', title: 'c' },
  ]);
  assert.deepStrictEqual(out.map((g) => [g.day, g.items.length]), [['2026-09-15', 2], ['2026-09-17', 1]]);
});

test('dayLabel names today and tomorrow, then falls back to the date', () => {
  assert.strictEqual(dayLabel('2026-09-15', '2026-09-15'), 'Today');
  assert.strictEqual(dayLabel('2026-09-16', '2026-09-15'), 'Tomorrow');
  assert.strictEqual(dayLabel('2026-09-17', '2026-09-15'), 'Thursday 17 September');
  assert.strictEqual(dayLabel('2027-01-02', '2026-09-15'), 'Saturday 2 January 2027');
});

test('timeLabel reads a range and collapses a shared meridiem', () => {
  assert.strictEqual(timeLabel(null, null), 'All day');
  assert.strictEqual(timeLabel('09:00', 30), '9:00 – 9:30 AM');
  assert.strictEqual(timeLabel('11:30', 60), '11:30 AM – 12:30 PM');
  assert.strictEqual(timeLabel('00:00', 15), '12:00 – 12:15 AM');
  assert.strictEqual(timeLabel('23:30', 60), '11:30 PM – 12:30 AM');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test js/calgrid.test.js`
Expected: FAIL, `Cannot find module ... calgrid.js`.

- [ ] **Step 3: Write the implementation**

Create `js/calgrid.js`:

```js
// Date shapes the calendar screen needs, kept pure so they can be tested
// without a DOM. Everything in and out is a 'YYYY-MM-DD' string.
import { addDays, weekday } from '../supabase/functions/_shared/recur.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function shiftMonth(ym, n) {
  const y = +ym.slice(0, 4);
  const m = +ym.slice(5, 7) - 1 + n;
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12 + 1;
  return year + '-' + (month < 10 ? '0' : '') + month;
}

// Always six weeks, so the grid does not change height from month to month and
// the day cells stay where the thumb last found them.
export function monthMatrix(ym) {
  const first = ym + '-01';
  const back = weekday(first) % 7; // Sunday-first: Sunday 7 -> 0
  const start = addDays(first, -back);
  const grid = [];
  for (let w = 0; w < 6; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) week.push(addDays(start, w * 7 + d));
    grid.push(week);
  }
  return grid;
}

export function monthBounds(ym) {
  const grid = monthMatrix(ym);
  return { from: grid[0][0], to: grid[5][6] };
}

export const monthTitle = (ym) => MONTHS[+ym.slice(5, 7) - 1] + ' ' + ym.slice(0, 4);

export function groupByDay(occurrences) {
  const out = [];
  let current = null;
  for (const o of occurrences) {
    if (!current || current.day !== o.day) { current = { day: o.day, items: [] }; out.push(current); }
    current.items.push(o);
  }
  return out;
}

export function dayLabel(day, today) {
  if (day === today) return 'Today';
  if (day === addDays(today, 1)) return 'Tomorrow';
  const name = WEEKDAYS[weekday(day) - 1];
  const dom = +day.slice(8, 10);
  const month = MONTHS[+day.slice(5, 7) - 1];
  // The year only earns its place once it differs from the one we are in.
  const year = day.slice(0, 4) === today.slice(0, 4) ? '' : ' ' + day.slice(0, 4);
  return name + ' ' + dom + ' ' + month + year;
}

const clock = (mins) => {
  const m = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return { text: hour12 + ':' + ('0' + (m % 60)).slice(-2), meridiem: h < 12 ? 'AM' : 'PM' };
};

export function timeLabel(time, minutes) {
  if (!time) return 'All day';
  const start = +time.slice(0, 2) * 60 + +time.slice(3, 5);
  const a = clock(start);
  if (!minutes) return a.text + ' ' + a.meridiem;
  const b = clock(start + minutes);
  // "9:00 – 9:30 AM" reads better than saying AM twice, but a range that
  // crosses noon or midnight needs both.
  return a.meridiem === b.meridiem
    ? a.text + ' – ' + b.text + ' ' + b.meridiem
    : a.text + ' ' + a.meridiem + ' – ' + b.text + ' ' + b.meridiem;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test js/calgrid.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add js/calgrid.js js/calgrid.test.js
git commit -m "Add calendar grid helpers"
```

---

### Task 6: The calendar screen, read-only

Three views over one sorted list. The editor arrives in Task 7.

**Files:**
- Create: `js/calendar.js`
- Modify: `index.html` (nav link after line 20; a `calendarView` section after line 262)
- Modify: `js/app.js` (`setView` line 76-83, `route` line 87-95)
- Modify: `css/style.css` (append)

**Interfaces:**
- Consumes: `sb` from `./api.js`; `expandAll`, `officeOccurrence`, `sortOccurrences` from `../supabase/functions/_shared/recur.js`; `monthMatrix`, `monthBounds`, `monthTitle`, `shiftMonth`, `groupByDay`, `dayLabel`, `timeLabel`, `WEEKDAY_INITIALS` from `./calgrid.js`; `$`, `esc` from `./util.js`.
- Produces: `renderCalendar(view, arg)` where `view` is `'agenda' | 'month' | 'day'` and `arg` is a `'YYYY-MM'`, a `'YYYY-MM-DD'`, or undefined. Also `denverToday()`, used by Task 7.

- [ ] **Step 1: Add the markup**

In `index.html`, after line 20 (`navBudget`):

```html
          <a id="navCalendar" class="link-btn" href="#/calendar" hidden>Calendar</a>
```

After the `budgetView` section:

```html
      <section id="calendarView" class="card" hidden>
        <div class="row cal-head">
          <div class="seg">
            <button id="calTabAgenda" type="button" class="ghost">Agenda</button>
            <button id="calTabMonth" type="button" class="ghost">Month</button>
          </div>
          <div class="row cal-nav">
            <button id="calPrev" type="button" class="ghost" hidden>‹</button>
            <span id="calTitle" class="cal-title"></span>
            <button id="calNext" type="button" class="ghost" hidden>›</button>
          </div>
          <button id="calToday" type="button" class="ghost">Today</button>
        </div>
        <p id="calOfficeAge" class="muted cal-age" hidden></p>
        <div id="calBody"></div>
      </section>
```

- [ ] **Step 2: Wire the routes**

In `js/app.js`, add `'calendarView'` to the array in `setView` and `calendar: 'calendarView'` to the map beside it, then add the nav toggle:

```js
  $('navCalendar').hidden = !SIGNED_IN;
```

Add the import at the top of `js/app.js`:

```js
import { renderCalendar } from './calendar.js';
```

And in `route()`, before the dashboard fallthrough:

```js
  if (h === '#/calendar') { setView('calendar'); await renderCalendar('agenda'); return; }
  if (h.startsWith('#/calendar/month')) { setView('calendar'); await renderCalendar('month', h.slice(17)); return; }
  if (h.startsWith('#/calendar/day/')) { setView('calendar'); await renderCalendar('day', h.slice(15)); return; }
```

Update the comment above `route()` to name the calendar alongside the other screens.

- [ ] **Step 3: Write the screen**

Create `js/calendar.js`:

```js
// The family calendar. Agenda is the default because it is what reads on a
// phone; month is the overview; tapping a day opens it. All three render the
// same sorted occurrence list, so a change to the data layer cannot make two
// views disagree.
import { sb } from './api.js';
import { $, esc } from './util.js';
import { expandAll, officeOccurrence, sortOccurrences, addDays } from '../supabase/functions/_shared/recur.js';
import { monthMatrix, monthBounds, monthTitle, shiftMonth, groupByDay, dayLabel, timeLabel, WEEKDAY_INITIALS } from './calgrid.js';

// Denver's date, not the browser's: every day and time in this app is Denver
// wall-clock, and a laptop in another zone must not shift what "today" means.
export const denverToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());

const AGENDA_DAYS = 42;
export let CATS = {};

async function loadCategories() {
  const { data, error } = await sb.from('event_categories').select('*').order('sort');
  if (error) throw new Error(error.message);
  CATS = Object.fromEntries(data.map((c) => [c.id, c]));
  return data;
}

// One read path for every view: series, their exceptions, and the office cache.
async function loadWindow(from, to) {
  const [series, office] = await Promise.all([
    sb.from('events').select('id,title,notes,category_id,day,time,minutes,repeat,repeat_until')
      .lte('day', to),
    sb.from('office_items').select('*').gte('day', from).lte('day', to),
  ]);
  if (series.error) throw new Error(series.error.message);
  if (office.error) throw new Error(office.error.message);

  // The overlap test is more than a column filter can say, so it is applied
  // here: a repeating series that started years ago still counts, a one-off
  // that happened years ago does not.
  const rows = series.data.filter((r) => (r.repeat ? !r.repeat_until || r.repeat_until >= from : r.day >= from));
  const ids = rows.map((r) => r.id);
  let exceptions = [];
  if (ids.length) {
    const { data, error } = await sb.from('event_exceptions').select('*').in('event_id', ids);
    if (error) throw new Error(error.message);
    exceptions = data.map((e) => ({ eventId: e.event_id, day: e.day, skipped: e.skipped, override: e.override }));
  }
  const mine = rows.map((r) => ({
    id: r.id, title: r.title, notes: r.notes, categoryId: r.category_id,
    day: r.day, time: r.time, minutes: r.minutes, repeat: r.repeat, repeatUntil: r.repeat_until,
  }));
  const items = expandAll(mine, exceptions, from, to).concat(office.data.map(officeOccurrence));
  return { items: sortOccurrences(items), office: office.data };
}

const color = (id) => (CATS[id] && CATS[id].color) || '#8d9bb5';

export async function renderCalendar(view, arg) {
  const body = $('calBody');
  $('calTabAgenda').className = view === 'agenda' ? 'seg-on' : 'ghost';
  $('calTabMonth').className = view === 'month' ? 'seg-on' : 'ghost';
  body.innerHTML = '<p class="muted">Loading…</p>';
  try {
    await loadCategories();
    if (view === 'month') await renderMonth(body, arg || denverToday().slice(0, 7));
    else if (view === 'day') await renderDay(body, arg || denverToday());
    else await renderAgenda(body);
  } catch (err) {
    body.innerHTML = '<p class="cal-error">' + esc(err.message) + '</p>';
  }
}

function officeAge(rows) {
  const el = $('calOfficeAge');
  if (!rows.length) { el.hidden = true; return; }
  const newest = rows.reduce((a, r) => (r.fetched_at > a ? r.fetched_at : a), rows[0].fetched_at);
  const mins = Math.round((Date.now() - new Date(newest).getTime()) / 60000);
  el.hidden = false;
  el.textContent = 'Office items synced ' + (mins < 2 ? 'just now' : mins < 60 ? mins + ' minutes ago' : Math.round(mins / 60) + ' hours ago') + '.';
}

async function renderAgenda(body) {
  const today = denverToday();
  const to = addDays(today, AGENDA_DAYS);
  const { items, office } = await loadWindow(today, to);
  officeAge(office);
  $('calTitle').textContent = 'Next six weeks';
  $('calPrev').hidden = true; $('calNext').hidden = true;
  const groups = groupByDay(items);
  body.innerHTML = groups.length
    ? '<div class="agenda">' + groups.map((g) =>
        '<section class="agenda-day"><h3>' + esc(dayLabel(g.day, today)) + '</h3>' +
        g.items.map(itemRow).join('') + '</section>').join('') + '</div>'
    : '<p class="muted">Nothing in the next six weeks.</p>';
}

async function renderMonth(body, ym) {
  const today = denverToday();
  const { from, to } = monthBounds(ym);
  const { items, office } = await loadWindow(from, to);
  officeAge(office);
  $('calTitle').textContent = monthTitle(ym);
  $('calPrev').hidden = false; $('calNext').hidden = false;
  $('calPrev').onclick = () => { location.hash = '#/calendar/month/' + shiftMonth(ym, -1); };
  $('calNext').onclick = () => { location.hash = '#/calendar/month/' + shiftMonth(ym, 1); };

  const byDay = {};
  for (const o of items) (byDay[o.day] ||= []).push(o);
  const cells = monthMatrix(ym).map((week) => week.map((day) => {
    const list = byDay[day] || [];
    // Three bars and a count: a fourth bar makes the cell unreadable on a phone
    // long before it makes the day clearer.
    const bars = list.slice(0, 3).map((o) =>
      '<span class="cal-bar' + (o.done ? ' done' : '') + (o.waitsOnClient ? ' waiting' : '') +
      '" style="--cat:' + esc(color(o.categoryId)) + '" title="' + esc(o.title) + '"></span>').join('');
    const more = list.length > 3 ? '<span class="cal-more">+' + (list.length - 3) + '</span>' : '';
    return '<a class="cal-cell' + (day.slice(0, 7) === ym ? '' : ' outside') + (day === today ? ' today' : '') +
      '" href="#/calendar/day/' + day + '"><span class="cal-dom">' + (+day.slice(8, 10)) + '</span>' +
      '<span class="cal-bars">' + bars + more + '</span></a>';
  }).join('')).join('');

  body.innerHTML =
    '<div class="cal-grid-head">' + WEEKDAY_INITIALS.map((d) => '<span>' + d + '</span>').join('') + '</div>' +
    '<div class="cal-grid">' + cells + '</div>';
}

async function renderDay(body, day) {
  const today = denverToday();
  const { items, office } = await loadWindow(day, day);
  officeAge(office);
  $('calTitle').textContent = dayLabel(day, today);
  $('calPrev').hidden = false; $('calNext').hidden = false;
  $('calPrev').onclick = () => { location.hash = '#/calendar/day/' + addDays(day, -1); };
  $('calNext').onclick = () => { location.hash = '#/calendar/day/' + addDays(day, 1); };
  body.innerHTML = items.length
    ? '<div class="agenda"><section class="agenda-day">' + items.map(itemRow).join('') + '</section></div>'
    : '<p class="muted">Nothing on this day.</p>';
}

function itemRow(o) {
  const cls = 'cal-item' + (o.readOnly ? ' readonly' : '') + (o.done ? ' done' : '') + (o.waitsOnClient ? ' waiting' : '');
  const inner =
    '<span class="cal-when">' + esc(timeLabel(o.time, o.minutes)) + '</span>' +
    '<span class="cal-what">' +
    (o.business ? '<span class="cal-business">' + esc(o.business) + '</span>' : '') +
    '<span class="cal-title-text">' + esc(o.title) + '</span></span>';
  // Office items are edited in the office; family events open the editor, which
  // arrives with the next task and until then does nothing.
  return o.readOnly && o.url
    ? '<a class="' + cls + '" style="--cat:' + esc(color(o.categoryId)) + '" href="' + esc(o.url) + '" target="_blank" rel="noopener">' + inner + '</a>'
    : '<div class="' + cls + '" style="--cat:' + esc(color(o.categoryId)) + '" data-event="' + esc(o.eventId) + '" data-day="' + esc(o.seriesDay) + '">' + inner + '</div>';
}
```

- [ ] **Step 4: Wire the tabs and Today button**

Append to `js/calendar.js`:

```js
$('calTabAgenda').addEventListener('click', () => { location.hash = '#/calendar'; });
$('calTabMonth').addEventListener('click', () => { location.hash = '#/calendar/month'; });
$('calToday').addEventListener('click', () => { location.hash = '#/calendar/day/' + denverToday(); });
```

- [ ] **Step 5: Add the styles**

Append to `css/style.css`:

```css
/* ── calendar ─────────────────────────────────────────────────────────────── */
.cal-head { justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.cal-nav { align-items: center; gap: 4px; }
.cal-title { font-weight: 600; }
.cal-age { margin: 4px 0 12px; font-size: 0.85rem; }
.cal-error { color: var(--danger); }

.cal-grid-head { display: grid; grid-template-columns: repeat(7, 1fr); text-align: center; color: var(--muted); font-size: 0.75rem; }
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.cal-cell { display: flex; flex-direction: column; gap: 3px; min-height: 60px; padding: 4px; border-radius: 8px;
  background: var(--field); color: var(--ink); text-decoration: none; }
.cal-cell.outside { opacity: 0.42; }
.cal-cell.today { outline: 2px solid var(--accent); }
.cal-dom { font-size: 0.8rem; }
.cal-bars { display: flex; flex-direction: column; gap: 2px; }
.cal-bar { height: 4px; border-radius: 2px; background: var(--cat); }
.cal-bar.waiting { opacity: 0.45; }
.cal-bar.done { opacity: 0.3; }
.cal-more { font-size: 0.7rem; color: var(--muted); }

.agenda-day h3 { margin: 18px 0 6px; font-size: 0.95rem; color: var(--muted); }
.cal-item { display: flex; gap: 10px; align-items: baseline; width: 100%; padding: 8px 10px; margin-bottom: 4px;
  border-left: 4px solid var(--cat); border-radius: 8px; color: var(--ink); text-decoration: none;
  background: color-mix(in oklab, var(--cat) 18%, var(--card)); }
.cal-item.waiting { opacity: 0.55; }
.cal-item.done .cal-title-text { text-decoration: line-through; }
.cal-when { flex: 0 0 auto; color: var(--muted); font-size: 0.85rem; min-width: 7.5em; }
.cal-what { display: flex; flex-direction: column; }
.cal-business { font-size: 0.75rem; color: var(--muted); }
@media (max-width: 420px) {
  .cal-item { flex-direction: column; gap: 2px; }
  .cal-when { min-width: 0; }
}
```

- [ ] **Step 6: Verify in the browser**

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/#/calendar`. With the event created in Task 4 you should see Soccer on every Tuesday of the next six weeks. Check: the month tab shows green bars on those Tuesdays; tapping one opens the day; the Today button lands on today; the console is clean.

- [ ] **Step 7: Commit**

```bash
git add js/calendar.js index.html js/app.js css/style.css
git commit -m "Add calendar screen"
```

---

### Task 7: The event editor and category admin

**Files:**
- Modify: `js/calendar.js` (append the editor; wire `itemRow`'s click)
- Modify: `index.html` (the editor panel inside `calendarView`)
- Modify: `css/style.css` (append)

**Interfaces:**
- Consumes: `cal` from `./api.js`; `validateEvent`'s error strings surface as-is from the function.
- Produces: nothing other tasks import.

- [ ] **Step 1: Add the editor markup**

Inside the `calendarView` section in `index.html`, after `calBody`:

```html
        <button id="calAdd" type="button" class="primary cal-add">＋ New event</button>
        <div id="calEditor" class="cal-editor" hidden>
          <form id="calForm">
            <input type="hidden" id="calId" />
            <input type="hidden" id="calSeriesDay" />
            <label>Title <input id="calTitleInput" type="text" maxlength="200" required /></label>
            <label>Category <select id="calCategory"></select></label>
            <label>Date <input id="calDay" type="date" required /></label>
            <label class="cal-allday"><input id="calAllDay" type="checkbox" checked /> All day</label>
            <div id="calTimed" class="row" hidden>
              <label>Start <input id="calTime" type="time" /></label>
              <label>Minutes <input id="calMinutes" type="number" min="1" max="1440" step="5" value="60" /></label>
            </div>
            <label>Repeats
              <select id="calRepeat">
                <option value="">Never</option>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
                <option value="monthly">Every month</option>
                <option value="yearly">Every year</option>
              </select>
            </label>
            <label id="calUntilWrap" hidden>Until (optional) <input id="calUntil" type="date" /></label>
            <label>Notes <textarea id="calNotes" maxlength="2000" rows="2"></textarea></label>
            <p id="calFormError" class="cal-error" hidden></p>
            <div class="row">
              <button type="submit" class="primary">Save</button>
              <button type="button" id="calDelete" class="ghost" hidden>Delete</button>
              <button type="button" id="calCancel" class="ghost">Cancel</button>
            </div>
          </form>
        </div>
```

- [ ] **Step 2: Write the editor**

Extend the existing imports at the top of `js/calendar.js` — `cal` joins `sb`
from `./api.js`, and `weekday` joins the names already taken from `recur.js`.
Then append the editor to the end of the file:

```js
/* ── the editor ───────────────────────────────────────────────────────────── */
// What the open form is editing: a new event, a whole series, or one occurrence.
let editing = null; // { id, seriesDay, scope: 'series' | 'occurrence' }

function openEditor(occurrence) {
  const e = occurrence;
  editing = e ? { id: e.eventId, seriesDay: e.seriesDay, scope: 'series' } : null;
  $('calFormError').hidden = true;
  $('calId').value = e ? e.eventId : '';
  $('calSeriesDay').value = e ? e.seriesDay : '';
  $('calTitleInput').value = e ? e.title : '';
  $('calNotes').value = e ? e.notes : '';
  $('calDay').value = e ? e.day : denverToday();
  $('calAllDay').checked = !e || !e.time;
  $('calTime').value = e && e.time ? e.time : '09:00';
  $('calMinutes').value = e && e.minutes ? e.minutes : 60;
  $('calCategory').innerHTML = Object.values(CATS).filter((c) => c.active && !c.system)
    .map((c) => '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>').join('');
  if (e) $('calCategory').value = e.categoryId;
  $('calRepeat').value = e && e.repeatFreq ? e.repeatFreq : '';
  $('calUntil').value = e && e.repeatUntil ? e.repeatUntil : '';
  $('calDelete').hidden = !e;
  syncFormBits();
  $('calEditor').hidden = false;
  $('calTitleInput').focus();
}

function syncFormBits() {
  $('calTimed').hidden = $('calAllDay').checked;
  $('calUntilWrap').hidden = !$('calRepeat').value;
}

function repeatFromForm(day) {
  const freq = $('calRepeat').value;
  if (!freq) return null;
  // The rule is anchored on the day the event starts, which is the only reading
  // the validator accepts and the only one that keeps the first occurrence put.
  if (freq === 'weekly') return { freq, days: [weekday(day)] };
  if (freq === 'monthly') return { freq, day: +day.slice(8, 10) };
  return { freq };
}

async function submitEvent(ev) {
  ev.preventDefault();
  const day = $('calDay').value;
  const allDay = $('calAllDay').checked;
  const payload = {
    id: $('calId').value || undefined,
    title: $('calTitleInput').value,
    notes: $('calNotes').value,
    categoryId: $('calCategory').value,
    day,
    time: allDay ? null : $('calTime').value,
    minutes: allDay ? null : Number($('calMinutes').value),
    repeat: repeatFromForm(day),
    repeatUntil: $('calUntil').value || null,
  };
  const res = editing && editing.scope === 'occurrence'
    ? await cal('occurrenceSave', {
        eventId: editing.id, day: editing.seriesDay,
        override: { title: payload.title, notes: payload.notes, categoryId: payload.categoryId,
                    day: payload.day, time: payload.time, minutes: payload.minutes },
      })
    : await cal('eventSave', payload);
  if (!res.ok) { $('calFormError').hidden = false; $('calFormError').textContent = res.error; return; }
  closeEditor();
  await renderCalendar(currentView(), currentArg());
}

async function deleteEvent() {
  if (!editing) return;
  const res = editing.scope === 'occurrence'
    ? await cal('occurrenceSkip', { eventId: editing.id, day: editing.seriesDay })
    : await cal('eventDelete', { id: editing.id });
  if (!res.ok) { $('calFormError').hidden = false; $('calFormError').textContent = res.error; return; }
  closeEditor();
  await renderCalendar(currentView(), currentArg());
}

function closeEditor() { $('calEditor').hidden = true; editing = null; }

// The hash is the source of truth for which view to re-render after a write.
const currentView = () => {
  const h = location.hash;
  return h.startsWith('#/calendar/month') ? 'month' : h.startsWith('#/calendar/day/') ? 'day' : 'agenda';
};
const currentArg = () => {
  const h = location.hash;
  if (h.startsWith('#/calendar/month/')) return h.slice(17);
  if (h.startsWith('#/calendar/day/')) return h.slice(15);
  return undefined;
};

// A repeating event asks which it means; a one-off has only one answer.
async function askScope(occurrence) {
  if (!occurrence.repeating) return 'series';
  return window.confirm('This event repeats.\n\nOK changes just this one.\nCancel changes the whole series.')
    ? 'occurrence' : 'series';
}

$('calBody').addEventListener('click', async (ev) => {
  const row = ev.target.closest('.cal-item[data-event]');
  if (!row) return;
  const found = LAST_ITEMS.find((o) => o.eventId === row.dataset.event && o.seriesDay === row.dataset.day);
  if (!found) return;
  const scope = await askScope(found);
  openEditor(Object.assign({}, found, { repeatFreq: REPEAT_FREQ[found.eventId] || '', repeatUntil: REPEAT_UNTIL[found.eventId] || '' }));
  editing.scope = scope;
  // Editing one occurrence cannot change the rule, so the rule controls go away.
  $('calRepeat').closest('label').hidden = scope === 'occurrence';
  $('calUntilWrap').hidden = scope === 'occurrence' || !$('calRepeat').value;
});

$('calAdd').addEventListener('click', () => openEditor(null));
$('calCancel').addEventListener('click', closeEditor);
$('calDelete').addEventListener('click', deleteEvent);
$('calForm').addEventListener('submit', submitEvent);
$('calAllDay').addEventListener('change', syncFormBits);
$('calRepeat').addEventListener('change', syncFormBits);
```

- [ ] **Step 3: Keep the rendered list and its rules addressable**

The editor needs the occurrence behind a clicked row and the series' rule. Add near the top of `js/calendar.js`, beside `CATS`:

```js
// The list the screen last drew, so a click can find the occurrence behind a
// row without re-reading, and the rule behind the series so the form can show it.
let LAST_ITEMS = [];
const REPEAT_FREQ = {};
const REPEAT_UNTIL = {};
```

In `loadWindow`, after building `mine`, record the rules and remember the list:

```js
  for (const s of mine) {
    REPEAT_FREQ[s.id] = s.repeat ? s.repeat.freq : '';
    REPEAT_UNTIL[s.id] = s.repeatUntil || '';
  }
```

and at the end of `loadWindow`, before the return:

```js
  LAST_ITEMS = items;
```

(`items` there is the sorted array; assign after the `sortOccurrences` call and return the same reference.)

- [ ] **Step 4: Add the editor styles**

Append to `css/style.css`:

```css
.cal-add { margin-top: 16px; }
.cal-editor { margin-top: 12px; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--field); }
.cal-editor label { display: block; margin-bottom: 10px; }
.cal-editor input[type="text"], .cal-editor input[type="date"], .cal-editor input[type="time"],
.cal-editor input[type="number"], .cal-editor select, .cal-editor textarea { width: 100%; }
.cal-editor .cal-allday { display: flex; align-items: center; gap: 8px; }
.cal-editor .cal-allday input { width: auto; }
```

- [ ] **Step 5: Verify by hand**

With the function served and the site up:

1. New event, all-day, category Family, today. It appears in agenda under Today.
2. Edit it, make it timed 09:00 for 30 minutes. The row reads `9:00 – 9:30 AM`.
3. New event repeating weekly. It appears on six Tuesdays.
4. Click one, choose "just this one", change the title. Only that Tuesday changes.
5. Click another, choose "just this one", delete. Only that Tuesday disappears.
6. Click a third, choose the whole series, delete. Every remaining occurrence goes, and so does the exception row (confirm with `select count(*) from event_exceptions;` — zero).
7. Try to save an event with no title. The form shows `title required` rather than clearing.

- [ ] **Step 6: Commit**

```bash
git add js/calendar.js index.html css/style.css
git commit -m "Add calendar event editor"
```

---

### Task 8: The office feed importer

**Files:**
- Create: `supabase/functions/_shared/officefeed.js`
- Test: `supabase/functions/_shared/officefeed.test.js`
- Modify: `supabase/functions/_shared/env.js` (add `keepsiteFeedToken`)
- Modify: `supabase/functions/dispatch/index.ts` (import hourly)
- Modify: `supabase/functions/api/index.ts` (the `officeRefresh` branch that currently 501s)

**Interfaces:**
- Consumes: `replaceOfficeWindow` from `caldb.js`.
- Produces:
  - `feedWindow(today) → { from, to }` — 30 days back, 90 ahead.
  - `normalizeItem(raw) → row | null` — snake_case row for `office_items`, or null if unusable.
  - `importFeed(sql, { token, today, fetchImpl }) → { imported, deleted, failures }`.

The spec says to take the feed's default window. The importer sends `from` and `to` explicitly instead, computed to the same 30/90 span: the delete step has to know exactly which window it is replacing, and a window the two sides each computed separately could drift by a day and silently strand rows.

- [ ] **Step 1: Write the failing tests**

Create `supabase/functions/_shared/officefeed.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { feedWindow, normalizeItem, importFeed } from './officefeed.js';

const SAMPLE = {
  generatedAt: '2026-09-13T15:02:11.000Z',
  timezone: 'America/Denver',
  items: [
    { kind: 'task', id: '20260912T171530abcdef', brand: 'keepsite', slug: 'sapphire-stem-floral',
      business: 'Sapphire Stem Floral', title: 'Layouts approved', due: '2026-09-15', time: null,
      done: false, waitsOnClient: false, source: 'pipeline', stage: 'layouts', project: null, repeat: null,
      url: 'https://www.keepsitemedia.com/office/clients/sapphire-stem-floral/?tab=tasks' },
    { kind: 'task', id: '20260912T180001qrstuv', brand: null, slug: 'office', business: null,
      title: 'Post on LinkedIn', due: '2026-09-19', time: '09:00', done: false, waitsOnClient: false,
      source: 'manual', stage: null, project: 'Marketing', repeat: 'weekly',
      url: 'https://www.keepsitemedia.com/office/tasks/' },
    { kind: 'meeting', id: '20260910T140000mnopqr', brand: 'keepsite', slug: 'hollow-oak-cabinetry',
      business: 'Hollow Oak Cabinetry', title: 'Kickoff call', ymd: '2026-09-16', time: '10:00', minutes: 30,
      link: 'https://meet.google.com/abc-defg-hij',
      url: 'https://www.keepsitemedia.com/office/clients/hollow-oak-cabinetry/?tab=meetings' },
  ],
};

// A stand-in for caldb.replaceOfficeWindow plus a postgres handle.
const fakeDb = () => {
  const calls = [];
  return { calls, replace: async (sql, rows, from, to) => { calls.push({ rows, from, to }); } };
};

test('the window is thirty days back and ninety ahead', () => {
  assert.deepStrictEqual(feedWindow('2026-09-13'), { from: '2026-08-14', to: '2026-12-12' });
});

test('a task keeps its due day and a meeting its ymd', () => {
  assert.strictEqual(normalizeItem(SAMPLE.items[0]).day, '2026-09-15');
  assert.strictEqual(normalizeItem(SAMPLE.items[2]).day, '2026-09-16');
  assert.strictEqual(normalizeItem(SAMPLE.items[2]).minutes, 30);
});

test('camelCase becomes snake_case and absent fields become null', () => {
  const row = normalizeItem(SAMPLE.items[1]);
  assert.strictEqual(row.waits_on_client, false);
  assert.strictEqual(row.brand, null);
  assert.strictEqual(row.business, null);
  assert.strictEqual(row.minutes, null);
  assert.strictEqual(row.project, 'Marketing');
});

test('an item with no id, no day, or an unknown kind is dropped rather than stored', () => {
  assert.strictEqual(normalizeItem({ kind: 'task', title: 'x', due: '2026-09-15' }), null);
  assert.strictEqual(normalizeItem({ kind: 'task', id: 'a', title: 'x' }), null);
  assert.strictEqual(normalizeItem({ kind: 'invoice', id: 'a', title: 'x', due: '2026-09-15' }), null);
  assert.strictEqual(normalizeItem({ kind: 'task', id: 'a', title: 'x', due: '15/09/2026' }), null);
});

test('importFeed sends the token and the window, and replaces what it got', async () => {
  const db = fakeDb();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => SAMPLE, text: async () => '' };
  };
  const res = await importFeed(null, { token: 'tok', today: '2026-09-13', fetchImpl, replace: db.replace });
  assert.match(calls[0].url, /from=2026-08-14&to=2026-12-12/);
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.strictEqual(res.imported, 3);
  assert.deepStrictEqual(res.failures, []);
  assert.strictEqual(db.calls[0].rows.length, 3);
  assert.strictEqual(db.calls[0].from, '2026-08-14');
});

test('a 401 fails loudly and writes nothing', async () => {
  const db = fakeDb();
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => '' });
  const res = await importFeed(null, { token: 'bad', today: '2026-09-13', fetchImpl, replace: db.replace });
  assert.strictEqual(res.imported, 0);
  assert.match(res.failures[0], /401/);
  assert.strictEqual(db.calls.length, 0, 'nothing is replaced when the fetch failed');
});

test('a malformed item is named and the rest still import', async () => {
  const db = fakeDb();
  const body = { items: [SAMPLE.items[0], { kind: 'task', title: 'no id' }] };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
  const res = await importFeed(null, { token: 't', today: '2026-09-13', fetchImpl, replace: db.replace });
  assert.strictEqual(res.imported, 1);
  assert.strictEqual(res.failures.length, 1);
  assert.match(res.failures[0], /unreadable/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test supabase/functions/_shared/officefeed.test.js`
Expected: FAIL, `Cannot find module ... officefeed.js`.

- [ ] **Step 3: Write the importer**

Create `supabase/functions/_shared/officefeed.js`:

```js
// The office feed: fetch, normalize, and hand the window to caldb. The contract
// is docs/office-calendar-feed.md. Days and times arrive as Denver wall-clock
// strings and are stored exactly as they arrive.
import { replaceOfficeWindow } from './caldb.js';
import { addDays } from './recur.js';

export const FEED_URL = 'https://www.keepsitemedia.com/office/api/feed';
const BACK_DAYS = 30;
const AHEAD_DAYS = 90;

// The feed would default to the same span, but the delete step has to know
// exactly which window it is replacing, so the window is stated rather than assumed.
export const feedWindow = (today) => ({ from: addDays(today, -BACK_DAYS), to: addDays(today, AHEAD_DAYS) });

const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const orNull = (v) => (v === undefined || v === '' ? null : v);

export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'task' || raw.kind === 'meeting' ? raw.kind : null;
  const id = String(raw.id || '').trim();
  const day = raw.kind === 'meeting' ? raw.ymd : raw.due;
  if (!kind || !id || !isDay(day)) return null;
  return {
    id,
    kind,
    brand: raw.brand === 'keepsite' || raw.brand === 'lova' ? raw.brand : null,
    slug: String(raw.slug || ''),
    business: orNull(raw.business),
    title: String(raw.title || ''),
    day,
    time: raw.time ? String(raw.time) : null,
    minutes: raw.minutes == null ? null : Number(raw.minutes),
    done: raw.done === true,
    waits_on_client: raw.waitsOnClient === true,
    source: String(raw.source || ''),
    stage: orNull(raw.stage),
    project: orNull(raw.project),
    repeat: orNull(raw.repeat),
    link: orNull(raw.link),
    url: orNull(raw.url),
  };
}

// `replace` is injectable so the tests never need a database.
export async function importFeed(sql, { token, today, fetchImpl, replace }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const write = replace || replaceOfficeWindow;
  const { from, to } = feedWindow(today);
  const failures = [];

  let body;
  try {
    const res = await doFetch(FEED_URL + '?from=' + from + '&to=' + to, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    });
    if (!res.ok) {
      failures.push('office feed ' + res.status + (res.status === 401 ? ' — check KEEPSITE_FEED_TOKEN' : ''));
      return { imported: 0, deleted: 0, failures };
    }
    body = await res.json();
  } catch (e) {
    failures.push('office feed unreachable — ' + ((e && e.message) || e));
    return { imported: 0, deleted: 0, failures };
  }

  const rows = [];
  for (const raw of (body && body.items) || []) {
    const row = normalizeItem(raw);
    // One bad row must not cost the other ninety-nine.
    if (row) rows.push(row);
    else failures.push('unreadable office item: ' + JSON.stringify(raw).slice(0, 120));
  }
  await write(sql, rows, from, to);
  return { imported: rows.length, deleted: 0, failures };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test supabase/functions/_shared/officefeed.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Add the secret to `env.js`**

In `supabase/functions/_shared/env.js`, beside the Plaid defaults:

```js
    // Empty default: the calendar import is the only caller, and every other
    // function must keep booting before the token is set.
    keepsiteFeedToken: get('KEEPSITE_FEED_TOKEN', ''),
```

- [ ] **Step 6: Import hourly from `dispatch`**

In `supabase/functions/dispatch/index.ts`, add the imports:

```ts
import { importFeed } from '../_shared/officefeed.js';
```

and after the mail-sending loop, before `console.log('dispatch', ...)`:

```ts
  // The office import is independent of the habits dispatch: a feed that is
  // down must not cost the hour its reminders.
  if (env.keepsiteFeedToken) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
    const office = await importFeed(sql, { token: env.keepsiteFeedToken, today });
    for (const f of office.failures) { result.failures.push(f); result.ok = false; }
    console.log('office import', JSON.stringify({ imported: office.imported, failures: office.failures.length }));
  }
```

- [ ] **Step 7: Replace the 501 in `api`**

In `supabase/functions/api/index.ts`, replace the `// officeRefresh arrives in the import task.` line and the 501 return with:

```ts
      if (p.action === 'officeRefresh') {
        if (!env.keepsiteFeedToken) return json({ ok: false, error: 'the office feed token is not set' }, 400, cors);
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
        const out = await importFeed(sql, { token: env.keepsiteFeedToken, today });
        return json({ ok: out.failures.length === 0, imported: out.imported, error: out.failures[0] }, 200, cors);
      }
      return json({ ok: false, error: 'unknown action' }, 400, cors);
```

and add the import beside the other calendar ones:

```ts
import { importFeed } from '../_shared/officefeed.js';
```

- [ ] **Step 8: Add the refresh button**

In `index.html`, inside the `cal-head` row, after `calToday`:

```html
          <button id="calSync" type="button" class="ghost">Sync office</button>
```

Append to `js/calendar.js`:

```js
$('calSync').addEventListener('click', async () => {
  $('calSync').disabled = true;
  const res = await cal('officeRefresh', {});
  $('calSync').disabled = false;
  if (!res.ok) { $('calOfficeAge').hidden = false; $('calOfficeAge').textContent = res.error; return; }
  await renderCalendar(currentView(), currentArg());
});
```

- [ ] **Step 9: Verify end to end**

Set the secret locally in `supabase/functions/.env`:

```
KEEPSITE_FEED_TOKEN=<the token from the keepsite Netlify env>
```

Restart `npx supabase functions serve --env-file supabase/functions/.env`, open the calendar, press Sync office. Expect office items to appear under their brand colors, meetings with a time range, and the age line to say "just now". Then:

```bash
psql "$DB_URL" -c "select brand, count(*) from office_items group by brand;"
```

If the feed has not deployed yet, expect `office feed 404` in the age line and an otherwise working calendar — that is the designed behavior, not a failure of this task.

- [ ] **Step 10: Commit**

```bash
git add supabase/functions/_shared/officefeed.js supabase/functions/_shared/officefeed.test.js \
        supabase/functions/_shared/env.js supabase/functions/dispatch/index.ts \
        supabase/functions/api/index.ts index.html js/calendar.js
git commit -m "Import the office feed"
```

---

### Task 9: The morning email

**Files:**
- Create: `supabase/functions/_shared/caldigest.js`
- Test: `supabase/functions/_shared/caldigest.test.js`
- Modify: `supabase/functions/dispatch/index.ts`

**Interfaces:**
- Consumes: `listSeries`, `listExceptions`, `listOfficeItems` from `caldb.js`; `expandAll`, `officeOccurrence`, `sortOccurrences`, `addDays` from `recur.js`; `timeLabel`, `dayLabel` logic — reimplemented here rather than imported, because `js/calgrid.js` is browser-side and the digest must not reach across into `js/`.
- Produces:
  - `digestDays(items, today) → Array<{ day, heading, items }>` — exactly three entries.
  - `renderDigest(days, dashboardUrl) → { subject, html } | null` — null when there is nothing worth sending.
  - `gatherDigest(sql, today, deps) → Occurrence[]`.

- [ ] **Step 1: Write the failing tests**

Create `supabase/functions/_shared/caldigest.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { digestDays, renderDigest, gatherDigest } from './caldigest.js';

const occ = (over) => Object.assign({
  eventId: 'e1', seriesDay: '2026-09-15', day: '2026-09-15', title: 'Soccer', notes: '',
  categoryId: 'family', time: null, minutes: null, repeating: false, readOnly: false,
  url: null, business: null, done: false, waitsOnClient: false,
}, over);
const CATS = { family: { color: '#57c785' }, keepsite: { color: '#7f8cf0' } };

test('three days, headed Today, Tomorrow, and a weekday name', () => {
  const days = digestDays([occ()], '2026-09-15');
  assert.deepStrictEqual(days.map((d) => d.heading), ['Today', 'Tomorrow', 'Thursday']);
  assert.deepStrictEqual(days.map((d) => d.day), ['2026-09-15', '2026-09-16', '2026-09-17']);
});

test('items land on their own day and nothing outside the three appears', () => {
  const days = digestDays([occ(), occ({ day: '2026-09-17', title: 'Dentist' }), occ({ day: '2026-09-20', title: 'Far' })], '2026-09-15');
  assert.deepStrictEqual(days[0].items.map((i) => i.title), ['Soccer']);
  assert.deepStrictEqual(days[1].items, []);
  assert.deepStrictEqual(days[2].items.map((i) => i.title), ['Dentist']);
});

test('done and waiting-on-client office items are left out of the email', () => {
  const days = digestDays([
    occ({ readOnly: true, done: true, title: 'Finished' }),
    occ({ readOnly: true, waitsOnClient: true, title: 'Waiting' }),
    occ({ title: 'Real' }),
  ], '2026-09-15');
  assert.deepStrictEqual(days[0].items.map((i) => i.title), ['Real']);
});

test('an empty three days sends nothing at all', () => {
  assert.strictEqual(renderDigest(digestDays([], '2026-09-15'), CATS, 'https://x/'), null);
  assert.strictEqual(
    renderDigest(digestDays([occ({ readOnly: true, done: true })], '2026-09-15'), CATS, 'https://x/'),
    null, 'a day of nothing but filtered items is still empty');
});

test('the subject names today and the html carries times, colors, and the business', () => {
  const days = digestDays([
    occ({ title: 'Soccer', time: '09:00', minutes: 30 }),
    occ({ title: 'Kickoff call', categoryId: 'keepsite', readOnly: true, business: 'Hollow Oak Cabinetry', time: '10:00', minutes: 30 }),
    occ({ day: '2026-09-16', title: 'Bin day' }),
  ], '2026-09-15');
  const out = renderDigest(days, CATS, 'https://homebase.samnichols.dev/');
  assert.match(out.subject, /Soccer/);
  assert.match(out.html, /9:00 – 9:30 AM/);
  assert.match(out.html, /#57c785/);
  assert.match(out.html, /Hollow Oak Cabinetry/);
  assert.match(out.html, /All day/);
  assert.match(out.html, /homebase\.samnichols\.dev/);
});

test('the subject says how many when there is more than one', () => {
  const days = digestDays([occ({ title: 'A' }), occ({ title: 'B' }), occ({ title: 'C' })], '2026-09-15');
  assert.match(renderDigest(days, CATS, 'https://x/').subject, /3 things today/);
});

test('a title with angle brackets is escaped', () => {
  const days = digestDays([occ({ title: '<script>x</script>' })], '2026-09-15');
  assert.match(renderDigest(days, CATS, 'https://x/').html, /&lt;script&gt;/);
  assert.doesNotMatch(renderDigest(days, CATS, 'https://x/').html, /<script>/);
});

test('an empty today still reports tomorrow', () => {
  const days = digestDays([occ({ day: '2026-09-16', title: 'Bin day' })], '2026-09-15');
  const out = renderDigest(days, CATS, 'https://x/');
  assert.match(out.subject, /Nothing today/);
  assert.match(out.html, /Bin day/);
});

test('gatherDigest asks for exactly three days and merges both sources', async () => {
  const asked = [];
  const deps = {
    listSeries: async (_sql, from, to) => { asked.push([from, to]); return [{ id: 'e1', title: 'Soccer', notes: '', categoryId: 'family', day: '2026-09-15', time: null, minutes: null, repeat: null, repeatUntil: null }]; },
    listExceptions: async () => [],
    listOfficeItems: async () => [{ id: 'o1', title: 'Kickoff', day: '2026-09-16', time: '10:00', minutes: 30, brand: 'keepsite', business: 'Hollow Oak', done: false, waits_on_client: false, url: 'https://x' }],
  };
  const items = await gatherDigest(null, '2026-09-15', deps);
  assert.deepStrictEqual(asked[0], ['2026-09-15', '2026-09-17']);
  assert.deepStrictEqual(items.map((i) => i.title), ['Soccer', 'Kickoff']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test supabase/functions/_shared/caldigest.test.js`
Expected: FAIL, `Cannot find module ... caldigest.js`.

- [ ] **Step 3: Write the digest**

Create `supabase/functions/_shared/caldigest.js`:

```js
// The morning email: today and the next two days, one message per person.
// Email has no custom properties, so every color is written inline.
import { listSeries, listExceptions, listOfficeItems } from './caldb.js';
import { expandAll, officeOccurrence, sortOccurrences, addDays, weekday } from './recur.js';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DEFAULT_COLOR = '#8d9bb5';

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const clock = (mins) => {
  const m = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return { text: (h % 12 === 0 ? 12 : h % 12) + ':' + ('0' + (m % 60)).slice(-2), meridiem: h < 12 ? 'AM' : 'PM' };
};

export function timeLabel(time, minutes) {
  if (!time) return 'All day';
  const start = +time.slice(0, 2) * 60 + +time.slice(3, 5);
  const a = clock(start);
  if (!minutes) return a.text + ' ' + a.meridiem;
  const b = clock(start + minutes);
  return a.meridiem === b.meridiem
    ? a.text + ' – ' + b.text + ' ' + b.meridiem
    : a.text + ' ' + a.meridiem + ' – ' + b.text + ' ' + b.meridiem;
}

// Read the three days the calendar needs, from both sources.
export async function gatherDigest(sql, today, deps) {
  const d = deps || { listSeries, listExceptions, listOfficeItems };
  const to = addDays(today, 2);
  const series = await d.listSeries(sql, today, to);
  const exceptions = await d.listExceptions(sql, series.map((s) => s.id));
  const office = await d.listOfficeItems(sql, today, to);
  return sortOccurrences(expandAll(series, exceptions, today, to).concat(office.map(officeOccurrence)));
}

// Items already done, and office tasks waiting on somebody else, are calendar
// texture rather than morning reading.
const worthSending = (o) => !o.done && !o.waitsOnClient;

export function digestDays(items, today) {
  return [0, 1, 2].map((n) => {
    const day = addDays(today, n);
    return {
      day,
      heading: n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : WEEKDAYS[weekday(day) - 1],
      items: items.filter((o) => o.day === day && worthSending(o)),
    };
  });
}

export function renderDigest(days, cats, dashboardUrl) {
  const total = days.reduce((n, d) => n + d.items.length, 0);
  // A daily email that usually says "nothing scheduled" trains you to ignore it.
  if (!total) return null;

  const today = days[0].items;
  const subject = !today.length
    ? '📅 Nothing today · ' + days[1].items.concat(days[2].items).length + ' coming up'
    : today.length === 1
      ? '📅 ' + today[0].title
      : '📅 ' + today.length + ' things today: ' + today.map((o) => o.title).join(', ');

  const row = (o) => {
    const color = (cats[o.categoryId] && cats[o.categoryId].color) || DEFAULT_COLOR;
    const link = o.readOnly && o.url;
    const title = link
      ? '<a href="' + esc(o.url) + '" style="color:inherit">' + esc(o.title) + '</a>'
      : esc(o.title);
    return '<tr><td style="padding:0 0 8px">' +
      '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>' +
      '<td style="width:4px;background:' + esc(color) + ';border-radius:2px">&nbsp;</td>' +
      '<td style="padding-left:10px">' +
      (o.business ? '<div style="font-size:12px;color:#5b639a">' + esc(o.business) + '</div>' : '') +
      '<div><b>' + title + '</b></div>' +
      '<div style="font-size:13px;color:#5b639a">' + esc(timeLabel(o.time, o.minutes)) + '</div>' +
      '</td></tr></table></td></tr>';
  };

  const section = (d) =>
    '<h3 style="margin:18px 0 8px;font-size:15px">' + esc(d.heading) + '</h3>' +
    (d.items.length
      ? '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">' + d.items.map(row).join('') + '</table>'
      : '<p style="margin:0;color:#5b639a">Nothing scheduled.</p>');

  const html =
    '<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">' +
    days.map(section).join('') +
    '<p style="margin-top:20px"><a href="' + esc(dashboardUrl) + '#/calendar">Open the calendar</a></p></div>';

  return { subject, html };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test supabase/functions/_shared/caldigest.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Send it from `dispatch`**

In `supabase/functions/dispatch/index.ts`, add:

```ts
import { gatherDigest, digestDays, renderDigest } from '../_shared/caldigest.js';
```

and after the office import block:

```ts
  // The calendar digest reads tables the habits snapshot does not carry, so it
  // runs here rather than inside the service.
  const denver = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' });
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Denver', hour: '2-digit', hour12: false }).format(new Date()) + ':00';
  const [digestSetting] = await sql`select value #>> '{}' as v from settings where key = 'calendarDigestTime'`;
  if ((digestSetting?.v || '07:00') === hour) {
    try {
      const today = denver.format(new Date());
      const items = await gatherDigest(sql, today);
      const cats = Object.fromEntries(
        (await sql`select id, color from event_categories`).map((c) => [c.id, { color: c.color }]),
      );
      const mail0 = renderDigest(digestDays(items, today), cats, env.dashboardUrl);
      if (mail0) {
        for (const p of await sql`select email from people order by email`) {
          try {
            await mail.send({ to: p.email, subject: mail0.subject, html: mail0.html });
          } catch (e) {
            result.failures.push('calendar digest to ' + p.email + ' — ' + ((e as Error)?.message || e));
            result.ok = false;
          }
        }
      }
    } catch (e) {
      result.failures.push('calendar digest — ' + ((e as Error)?.message || e));
      result.ok = false;
    }
  }
```

- [ ] **Step 6: Verify against the real function**

Set `calendarDigestTime` to the current Denver hour, then fire dispatch by hand:

```bash
psql "$DB_URL" -c "update settings set value = to_jsonb(to_char(now() at time zone 'America/Denver', 'HH24') || ':00') where key = 'calendarDigestTime';"
curl -s -X POST http://127.0.0.1:54321/functions/v1/dispatch -H "Authorization: Bearer $DISPATCH_SECRET"
```

Expected: `{"ok":true,...}` and one email in each inbox listing the three days. Then delete every event in the window and fire it again: expected `ok` with no email sent. Put the setting back to `"07:00"`.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/caldigest.js supabase/functions/_shared/caldigest.test.js supabase/functions/dispatch/index.ts
git commit -m "Send the morning calendar email"
```

---

### Task 10: The Google Calendar import script

**Files:**
- Create: `scripts/import-ics.js`
- Test: `scripts/import-ics.test.js`

**Interfaces:**
- Consumes: `weekday` from `../supabase/functions/_shared/recur.js`; `postgres` from the dev dependency, as `scripts/migrate-from-sheet.js` does.
- Produces: `parseIcs(text) → { events, skipped }` where each event is `{ title, notes, day, time, minutes, repeat, repeatUntil, exdates }` and each `skipped` entry is `{ title, day, why }`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/import-ics.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { parseIcs } from './import-ics.js';

const ics = (body) => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' + body + 'END:VCALENDAR\r\n';
const vevent = (lines) => 'BEGIN:VEVENT\r\n' + lines.join('\r\n') + '\r\nEND:VEVENT\r\n';

test('an all-day event keeps its day and has no time', () => {
  const out = parseIcs(ics(vevent(['SUMMARY:Bin day', 'DTSTART;VALUE=DATE:20260915', 'DTEND;VALUE=DATE:20260916'])));
  assert.deepStrictEqual(out.events[0], {
    title: 'Bin day', notes: '', day: '2026-09-15', time: null, minutes: null,
    repeat: null, repeatUntil: null, exdates: [],
  });
});

test('a timed event becomes a day, a time, and a length in minutes', () => {
  const out = parseIcs(ics(vevent(['SUMMARY:Soccer', 'DTSTART;TZID=America/Denver:20260915T090000', 'DTEND;TZID=America/Denver:20260915T093000'])));
  assert.strictEqual(out.events[0].day, '2026-09-15');
  assert.strictEqual(out.events[0].time, '09:00');
  assert.strictEqual(out.events[0].minutes, 30);
});

test('the four supported RRULEs map across', () => {
  const rule = (r) => parseIcs(ics(vevent(['SUMMARY:x', 'DTSTART;VALUE=DATE:20260915', r]))).events[0].repeat;
  assert.deepStrictEqual(rule('RRULE:FREQ=DAILY'), { freq: 'daily' });
  assert.deepStrictEqual(rule('RRULE:FREQ=WEEKLY;BYDAY=TU,TH'), { freq: 'weekly', days: [2, 4] });
  assert.deepStrictEqual(rule('RRULE:FREQ=MONTHLY'), { freq: 'monthly', day: 15 });
  assert.deepStrictEqual(rule('RRULE:FREQ=YEARLY'), { freq: 'yearly' });
});

test('UNTIL becomes repeatUntil as a plain day', () => {
  const out = parseIcs(ics(vevent(['SUMMARY:x', 'DTSTART;VALUE=DATE:20260915', 'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T235959Z'])));
  assert.strictEqual(out.events[0].repeatUntil, '2026-12-31');
});

test('a weekly rule with no BYDAY takes the start weekday', () => {
  const out = parseIcs(ics(vevent(['SUMMARY:x', 'DTSTART;VALUE=DATE:20260915', 'RRULE:FREQ=WEEKLY'])));
  assert.deepStrictEqual(out.events[0].repeat, { freq: 'weekly', days: [2] });
});

test('rules we cannot express are skipped by name rather than approximated', () => {
  const out = parseIcs(ics(
    vevent(['SUMMARY:Third Thursday', 'DTSTART;VALUE=DATE:20260917', 'RRULE:FREQ=MONTHLY;BYDAY=3TH']) +
    vevent(['SUMMARY:Ten times', 'DTSTART;VALUE=DATE:20260915', 'RRULE:FREQ=WEEKLY;COUNT=10']) +
    vevent(['SUMMARY:Fortnightly', 'DTSTART;VALUE=DATE:20260915', 'RRULE:FREQ=WEEKLY;INTERVAL=2'])));
  assert.strictEqual(out.events.length, 0);
  assert.deepStrictEqual(out.skipped.map((s) => s.title), ['Third Thursday', 'Ten times', 'Fortnightly']);
  assert.match(out.skipped[0].why, /BYDAY/);
});

test('EXDATE becomes skipped occurrences', () => {
  const out = parseIcs(ics(vevent(['SUMMARY:x', 'DTSTART;VALUE=DATE:20260915', 'RRULE:FREQ=WEEKLY;BYDAY=TU',
    'EXDATE;VALUE=DATE:20260922,20260929'])));
  assert.deepStrictEqual(out.events[0].exdates, ['2026-09-22', '2026-09-29']);
});

test('folded lines and escaped text are unwrapped', () => {
  const out = parseIcs(ics('BEGIN:VEVENT\r\nSUMMARY:A very long tit\r\n le\r\nDESCRIPTION:one\\ntwo\\, three\r\nDTSTART;VALUE=DATE:20260915\r\nEND:VEVENT\r\n'));
  assert.strictEqual(out.events[0].title, 'A very long title');
  assert.strictEqual(out.events[0].notes, 'one\ntwo, three');
});

test('an event with no start is skipped, not guessed at', () => {
  const out = parseIcs(ics(vevent(['SUMMARY:Nowhere'])));
  assert.strictEqual(out.events.length, 0);
  assert.match(out.skipped[0].why, /no start/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/import-ics.test.js`
Expected: FAIL, `Cannot find module ... import-ics.js`.

- [ ] **Step 3: Write the script**

Create `scripts/import-ics.js`:

```js
#!/usr/bin/env node
// One-off import of Google Calendar exports. Dry run by default; --apply writes.
//
//   node scripts/import-ics.js --file family.ics --category family --db "$PROD_DB_URL"
//   node scripts/import-ics.js --file family.ics --category family --db "$PROD_DB_URL" --apply
//
// Only the four repeat rules the calendar supports are imported. Anything else
// is listed at the end and re-entered by hand: a rule half-mapped is worse than
// a rule the report told you about.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { weekday } from '../supabase/functions/_shared/recur.js';

const DAYS = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

// RFC 5545 folds long lines with CRLF plus one space or tab.
const unfold = (text) => text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
const unescape = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const ymd = (v) => v.slice(0, 4) + '-' + v.slice(4, 6) + '-' + v.slice(6, 8);
const hm = (v) => (v.length >= 15 ? v.slice(9, 11) + ':' + v.slice(11, 13) : null);

const minutesBetween = (a, b) => {
  const at = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10), +a.slice(11, 13) || 0, +a.slice(14, 16) || 0);
  const bt = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10), +b.slice(11, 13) || 0, +b.slice(14, 16) || 0);
  return Math.round((bt - at) / 60000);
};

function parseRule(value, day) {
  const parts = Object.fromEntries(value.split(';').map((p) => p.split('=')));
  if (parts.INTERVAL && parts.INTERVAL !== '1') return { why: 'INTERVAL is not supported' };
  if (parts.COUNT) return { why: 'COUNT is not supported; use an end date' };
  if (parts.BYSETPOS) return { why: 'BYSETPOS is not supported' };
  if (parts.BYMONTHDAY && Number(parts.BYMONTHDAY) !== +day.slice(8, 10)) return { why: 'BYMONTHDAY differs from the start day' };
  const until = parts.UNTIL ? ymd(parts.UNTIL) : null;

  if (parts.FREQ === 'DAILY') return { repeat: { freq: 'daily' }, until };
  if (parts.FREQ === 'YEARLY') return { repeat: { freq: 'yearly' }, until };
  if (parts.FREQ === 'WEEKLY') {
    const byday = parts.BYDAY ? parts.BYDAY.split(',') : [];
    if (byday.some((d) => !DAYS[d])) return { why: 'BYDAY with an ordinal is not supported' };
    const days = byday.length ? byday.map((d) => DAYS[d]).sort((a, b) => a - b) : [weekday(day)];
    if (!days.includes(weekday(day))) return { why: 'BYDAY does not include the start weekday' };
    return { repeat: { freq: 'weekly', days }, until };
  }
  if (parts.FREQ === 'MONTHLY') {
    if (parts.BYDAY) return { why: 'BYDAY with an ordinal is not supported' };
    return { repeat: { freq: 'monthly', day: +day.slice(8, 10) }, until };
  }
  return { why: 'FREQ ' + parts.FREQ + ' is not supported' };
}

export function parseIcs(text) {
  const events = [];
  const skipped = [];
  const blocks = unfold(text).split(/BEGIN:VEVENT/).slice(1);
  for (const block of blocks) {
    const body = block.split('END:VEVENT')[0];
    const lines = body.split(/\r?\n/).filter(Boolean);
    const get = (name) => lines.find((l) => l.split(/[;:]/)[0] === name) || '';
    const value = (line) => line.slice(line.indexOf(':') + 1).trim();

    const title = unescape(value(get('SUMMARY'))) || '(untitled)';
    const start = get('DTSTART');
    if (!start) { skipped.push({ title, day: '', why: 'no start date' }); continue; }
    const rawStart = value(start);
    const day = ymd(rawStart);
    const time = /VALUE=DATE(?!-TIME)/.test(start) ? null : hm(rawStart);

    let minutes = null;
    if (time) {
      const end = get('DTEND');
      minutes = end ? minutesBetween(day + 'T' + time, ymd(value(end)) + 'T' + (hm(value(end)) || '00:00')) : 60;
      if (!(minutes > 0 && minutes <= 1440)) { skipped.push({ title, day, why: 'length is ' + minutes + ' minutes' }); continue; }
    }

    let repeat = null;
    let repeatUntil = null;
    const rrule = get('RRULE');
    if (rrule) {
      const r = parseRule(value(rrule), day);
      if (r.why) { skipped.push({ title, day, why: r.why }); continue; }
      repeat = r.repeat;
      repeatUntil = r.until;
    }

    const exdates = lines.filter((l) => l.split(/[;:]/)[0] === 'EXDATE')
      .flatMap((l) => value(l).split(',').map((v) => ymd(v.trim())));

    events.push({ title, notes: unescape(value(get('DESCRIPTION'))), day, time, minutes, repeat, repeatUntil, exdates });
  }
  return { events, skipped };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf('--' + name); return i === -1 ? null : args[i + 1]; };
  const file = arg('file');
  const category = arg('category');
  const db = arg('db');
  const apply = args.includes('--apply');
  const owner = arg('owner') || 'snic9004@gmail.com';
  if (!file || !category || !db) {
    console.error('usage: import-ics.js --file X.ics --category <id> --db <url> [--owner <email>] [--apply]');
    process.exit(2);
  }

  const { events, skipped } = parseIcs(readFileSync(file, 'utf8'));
  const sql = postgres(db, { max: 1, prepare: false });
  try {
    const [cat] = await sql`select id from event_categories where id = ${category}`;
    if (!cat) throw new Error('no such category: ' + category);
    if (apply) {
      for (const e of events) {
        const [row] = await sql`
          insert into events (title, notes, category_id, day, time, minutes, repeat, repeat_until, created_by)
          values (${e.title}, ${e.notes}, ${category}, ${e.day}, ${e.time}, ${e.minutes},
                  ${e.repeat ? sql.json(e.repeat) : null}, ${e.repeatUntil}, ${owner})
          returning id`;
        for (const day of e.exdates) {
          await sql`insert into event_exceptions (event_id, day, skipped) values (${row.id}, ${day}, true)
                    on conflict do nothing`;
        }
      }
    }
    console.log((apply ? 'imported ' : 'would import ') + events.length + ' events into ' + category);
    if (skipped.length) {
      console.log('\nleft out, re-enter these by hand:');
      for (const s of skipped) console.log('  ' + s.day + '  ' + s.title + ' — ' + s.why);
    }
    console.log('\n' + skipped.length + ' skipped');
  } finally {
    await sql.end();
  }
}

// Only run when invoked directly, so the tests can import parseIcs.
if (process.argv[1] && process.argv[1].endsWith('import-ics.js')) await main();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/import-ics.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Dry-run against a real export**

Export one Google calendar, then:

```bash
node scripts/import-ics.js --file ~/Downloads/family.ics --category family --db "$DB_URL"
```

Expected: a count and a list of anything skipped. Read the skipped list before applying — it is the only place the lossy part of the migration is visible.

- [ ] **Step 6: Commit**

```bash
git add scripts/import-ics.js scripts/import-ics.test.js
git commit -m "Add Google Calendar ics import"
```

---

### Task 11: The category panel

The spec puts category management on the calendar screen. `calCategorySave` and
`calCategoryRetire` already exist from Task 4; this is the panel over them.

**Files:**
- Modify: `index.html` (a `calCats` panel inside `calendarView`)
- Modify: `js/calendar.js`
- Modify: `css/style.css` (append)

**Interfaces:**
- Consumes: `cal` from `./api.js`; `CATS` and `loadCategories` from within `calendar.js`.
- Produces: nothing other tasks import.

- [ ] **Step 1: Add the markup**

In `index.html`, after the `calEditor` div:

```html
        <details id="calCats" class="cal-cats">
          <summary>Categories</summary>
          <div id="calCatList"></div>
          <form id="calCatForm" class="row">
            <input id="calCatName" type="text" placeholder="New category" maxlength="40" required />
            <input id="calCatColor" type="color" value="#57c785" />
            <button type="submit" class="ghost">Add</button>
          </form>
          <p id="calCatError" class="cal-error" hidden></p>
        </details>
```

- [ ] **Step 2: Render and wire it**

Append to `js/calendar.js`:

```js
/* ── categories ───────────────────────────────────────────────────────────── */
// The three system rows are the importer's and cannot be retired, but their
// colors are as editable as any other: they appear on the same calendar.
function renderCatList() {
  $('calCatList').innerHTML = Object.values(CATS).filter((c) => c.active).map((c) =>
    '<div class="cal-cat" data-id="' + esc(c.id) + '">' +
    '<input type="color" value="' + esc(c.color) + '" data-color />' +
    '<input type="text" value="' + esc(c.name) + '" maxlength="40" data-name />' +
    (c.system ? '<span class="muted cal-cat-tag">office</span>' : '<button type="button" class="ghost" data-retire>Retire</button>') +
    '</div>').join('');
}

async function saveCat(id, name, color) {
  const res = await cal('calCategorySave', { id, name, color });
  $('calCatError').hidden = res.ok;
  if (!res.ok) { $('calCatError').textContent = res.error; return false; }
  await renderCalendar(currentView(), currentArg());
  return true;
}

$('calCatList').addEventListener('change', async (ev) => {
  const row = ev.target.closest('.cal-cat');
  if (!row) return;
  await saveCat(row.dataset.id, row.querySelector('[data-name]').value, row.querySelector('[data-color]').value);
});

$('calCatList').addEventListener('click', async (ev) => {
  if (!ev.target.matches('[data-retire]')) return;
  const row = ev.target.closest('.cal-cat');
  if (!window.confirm('Retire this category? Events already using it keep it.')) return;
  const res = await cal('calCategoryRetire', { id: row.dataset.id });
  $('calCatError').hidden = res.ok;
  if (!res.ok) { $('calCatError').textContent = res.error; return; }
  await renderCalendar(currentView(), currentArg());
});

$('calCatForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (await saveCat(null, $('calCatName').value, $('calCatColor').value)) $('calCatName').value = '';
});
```

In `renderCalendar`, after `await loadCategories()`, add `renderCatList();` so the
panel redraws with the rest of the screen.

- [ ] **Step 3: Add the styles**

Append to `css/style.css`:

```css
.cal-cats { margin-top: 20px; }
.cal-cats summary { cursor: pointer; color: var(--muted); }
.cal-cat { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
.cal-cat input[type="color"] { width: 36px; height: 28px; padding: 0; border: none; background: none; }
.cal-cat input[type="text"] { flex: 1; }
.cal-cat-tag { font-size: 0.75rem; }
```

- [ ] **Step 4: Verify by hand**

1. Open Categories. Nine rows, three tagged "office".
2. Recolor Family. Every Family bar on the month grid changes on the redraw.
3. Rename School to "Kids". The picker in the editor shows the new name.
4. Add "Vet visits" in any color. It appears in the list and in the picker.
5. Retire it. It leaves both. `select active from event_categories where id = 'vet-visits';` is false.
6. Try to retire Keepsite. The panel says it is reserved for the office and the row stays.

- [ ] **Step 5: Commit**

```bash
git add index.html js/calendar.js css/style.css
git commit -m "Add calendar category panel"
```

---

### Task 12: Documentation and production setup

**Files:**
- Modify: `README.md` (a "Calendar (phase 4)" section after "Reports (phase 3)"; a row in the settings table)

- [ ] **Step 1: Add the phase section**

After the "Reports (phase 3)" section in `README.md`:

```markdown
## Calendar (phase 4)

1. **Migrate.** `npx supabase db push` applies `0004_calendar.sql`. Then
   `psql "$PROD_DB_URL" -f supabase/seed.sql` adds the nine event categories
   and the digest-time setting (it skips rows that already exist).

2. **Office feed token.** Get `KEEPSITE_FEED_TOKEN` from the keepsite site's
   Netlify environment — the same value on both sides — then:

       npx supabase secrets set KEEPSITE_FEED_TOKEN=...
       npx supabase functions deploy api
       npx supabase functions deploy dispatch --no-verify-jwt

   Until the keepsite `office-additions` branch deploys, the hourly import
   logs a failed fetch and `office_items` stays empty. The calendar and the
   morning email work regardless; only the business items are missing.

3. **Import Google Calendar.** Export each calendar from its Google settings
   page, then per file:

       node scripts/import-ics.js --file family.ics --category family --db "$PROD_DB_URL"
       node scripts/import-ics.js --file family.ics --category family --db "$PROD_DB_URL" --apply

   The dry run lists every event whose repeat rule the calendar cannot express
   — an nth-weekday rule, a `COUNT`, a `BYSETPOS`. Re-enter those by hand.
   Then turn off Google Calendar's own notifications so the morning email is
   the only one.

4. **Verify.** Push `main` and the Calendar link appears in the nav. Add an
   event; it shows in Agenda under Today. Press Sync office; the office items
   appear under their brand colors. At `calendarDigestTime` the next morning,
   both inboxes get one email covering three days.
```

- [ ] **Step 2: Add the settings row**

In the settings table at the end of `README.md`, after `choreDigestTime`:

```markdown
| `calendarDigestTime` | `07:00` | Hour (Denver, whole hour) the calendar email goes out. One email per person covering today and the next two days. Nothing sends when all three days are empty. |
```

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: PASS, including the four new test files.

Run: `psql "$DB_URL" -f supabase/tests/0004_calendar.sql`
Expected: `ok 14`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Document the calendar phase"
```

---

## Self-review notes

Checked against the spec:

- Every spec section maps to a task: data model and RLS to Task 1, recurrence to Task 2, the action path to Tasks 3 and 4, the three views to Tasks 5 and 6, the editor and occurrence semantics to Task 7, the importer and `officeRefresh` to Task 8, the email to Task 9, the `.ics` migration to Task 10, security and setup to Task 11.
- Two deliberate departures from the spec, both noted where they occur: the importer sends an explicit `from`/`to` rather than relying on the feed's default, so the delete step knows its own window; and `caldigest.js` carries its own copy of `timeLabel` rather than importing `js/calgrid.js`, because an edge function must not reach into browser code.
- The spec lists `catSave`/`catRetire`; the action names in the plan are `calCategorySave` and `calCategoryRetire`, because `api` already routes a bank action named `addBudgetCategory` and a bare `catSave` would read as though it belonged to the habits categories.
- The first draft left the spec's category panel unbuilt, with only the editor's picker covering it. Task 11 adds the panel over the actions Task 4 already exposes.
