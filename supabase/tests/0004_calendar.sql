begin;
select plan(20);

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

-- The frontend reads all four tables directly under RLS. A missing grant would
-- leave the calendar empty with no error anywhere, so read them as the role the
-- browser actually holds.
set local role authenticated;
select is((select count(*)::int from public.event_categories), 9, 'authenticated reads event_categories');
select is((select count(*)::int from public.events), 0, 'authenticated reads events');
select is((select count(*)::int from public.event_exceptions), 0, 'authenticated reads event_exceptions');
select is((select count(*)::int from public.office_items), 0, 'authenticated reads office_items');
reset role;

-- A series can start after the window it is drawn in, because an exception
-- moved one of its occurrences back into it. The reader pads the window it
-- selects over by recur.js's PAD_DAYS for exactly this; without the pad the day
-- view and the morning email come back empty for a day the month grid draws.
insert into public.events (id, title, category_id, day, repeat, created_by) values
  ('22222222-2222-2222-2222-222222222222', 'Practice', 'family', '2026-10-05',
   '{"freq":"weekly","days":[1]}'::jsonb, 'ann@x.com');
insert into public.event_exceptions (event_id, day, override) values
  ('22222222-2222-2222-2222-222222222222', '2026-10-05', '{"day":"2026-09-28"}'::jsonb);

select is(
  (select count(*)::int from public.events
    where day <= date '2026-09-28'
      and (case when repeat is null then day >= date '2026-09-28'
                else repeat_until is null or repeat_until >= date '2026-09-28' end)),
  0, 'the drawn window alone would drop the series');
select is(
  (select count(*)::int from public.events
    where day <= date '2026-09-28' + 31
      and (case when repeat is null then day >= date '2026-09-28' - 31
                else repeat_until is null or repeat_until >= date '2026-09-28' - 31 end)),
  1, 'the padded window listSeries uses selects it');

select * from finish();
rollback;
