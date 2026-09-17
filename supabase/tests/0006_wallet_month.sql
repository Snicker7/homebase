begin;
select plan(10);

select has_view('public', 'wallet_month', 'wallet_month exists');

-- Running the node suite against this database leaves rows behind (see the
-- README), and this view reports one row per person. The whole file rolls back,
-- so clearing first costs nothing and makes the counts mean what they say.
delete from public.transactions;
delete from public.budget_categories;
delete from public.accounts;
delete from public.plaid_items;
delete from public.events;
delete from public.ledger;
delete from public.habit_state;
delete from public.people;

-- Fixture: three people. Ann has one row of every ledger type plus a wallet
-- card buy; Bo has a little of each; Cy has nothing at all.
insert into public.people (email, name) values
  ('ann@x.com', 'Ann'), ('bo@x.com', 'Bo'), ('cy@x.com', 'Cy') on conflict do nothing;
insert into public.plaid_items (id, institution, access_token_id, linked_by)
  values ('item-w', 'Test Bank', gen_random_uuid(), 'ann@x.com');
insert into public.accounts (id, item_id, name) values ('acc-w', 'item-w', 'Checking');
insert into public.budget_categories (id, name, emoji, kind, wallet_owner) values
  ('groceries', 'Groceries', '🥕', 'spend', null),
  ('wallet-ann', 'Ann''s wallet', '🌱', 'wallet', 'ann@x.com'),
  ('wallet-bo', 'Bo''s wallet', '🌻', 'wallet', 'bo@x.com')
  on conflict do nothing;

create temp table t as
  select date_trunc('month', (now() at time zone 'America/Denver'))::date as this_month;
-- A Denver wall-clock moment inside `this_month`, as a timestamptz.
create function pg_temp.den(day_offset int, hhmm text) returns timestamptz
  language sql as $$
    select (((select this_month from t) + day_offset)::timestamp + hhmm::interval)
             at time zone 'America/Denver';
  $$;

-- The two sign conventions this view has to get right: `spend` stores a
-- POSITIVE amount that the wallet subtracts, `penalty` stores a NEGATIVE one
-- that it adds. Summing them alike gives a wrong number that still looks sane.
insert into public.ledger (ts, type, category, period_key, amount, actor) values
  (pg_temp.den(2, '10:00'), 'entry',   'bedtime',  '2026-09-07',  5.00, 'ann@x.com'),
  (pg_temp.den(2, '10:00'), 'bonus',   'bedtime',  '2026-09-07',  1.00, 'ann@x.com'),
  (pg_temp.den(2, '11:00'), 'claim',   'dishes',   '2026-09-09',  2.00, 'ann@x.com'),
  (pg_temp.den(2, '12:00'), 'penalty', 'dishes',   '2026-09-08', -1.50, 'ann@x.com'),
  (pg_temp.den(2, '13:00'), 'spend',   null,       null,         10.00, 'ann@x.com'),
  (pg_temp.den(2, '14:00'), 'deposit', null,       null,         20.00, 'ann@x.com'),
  -- 00:30 on the 1st is inside the Denver month; 23:00 the evening before is not.
  (pg_temp.den(0,  '00:30'), 'entry',  'bedtime',  '2026-09-01',  0.25, 'ann@x.com'),
  (pg_temp.den(-1, '23:00'), 'entry',  'bedtime',  '2026-08-31', 99.00, 'ann@x.com'),
  (pg_temp.den(2, '10:00'), 'entry',   'bedtime',  '2026-09-07',  3.00, 'bo@x.com');

insert into public.transactions (id, account_id, date, amount, merchant, pending, category_id, removed_at) values
  ('wa', 'acc-w', (select this_month from t) + 2, 15,  'Coffee',   false, 'wallet-ann', null),
  ('wb', 'acc-w', (select this_month from t) + 2, 7,   'Bakery',   false, 'wallet-bo',  null),
  ('wg', 'acc-w', (select this_month from t) + 2, 50,  'Costco',   false, 'groceries',  null),
  ('wp', 'acc-w', (select this_month from t) + 3, 30,  'Pending',  true,  'wallet-ann', null),
  ('wr', 'acc-w', (select this_month from t) + 3, 60,  'Removed',  false, 'wallet-ann', now()),
  ('wo', 'acc-w', (select this_month from t) - 5, 40,  'Last month', false, 'wallet-ann', null);

select is((select count(*)::int from public.wallet_month), 3, 'one row per person');
select is((select name from public.wallet_month where email = 'ann@x.com'), 'Ann', 'the row carries the display name');

select is((select earned from public.wallet_month where email = 'ann@x.com'), 6.75::numeric(12,2),
  'earned adds payouts, bonuses and claims, nets the penalty, and ignores a deposit');
select is((select spent from public.wallet_month where email = 'ann@x.com'), 25.00::numeric(12,2),
  'spent is the spend rows plus settled, live wallet card buys');

select is((select earned from public.wallet_month where email = 'bo@x.com'), 3.00::numeric(12,2),
  'each person sees only their own ledger rows');
select is((select spent from public.wallet_month where email = 'bo@x.com'), 7.00::numeric(12,2),
  'a wallet card buy lands on the wallet it is filed to');

select is((select earned from public.wallet_month where email = 'cy@x.com'), 0.00::numeric(12,2),
  'a person with no rows reads as zero, not as nothing');
select is((select spent from public.wallet_month where email = 'cy@x.com'), 0.00::numeric(12,2),
  'and the same for spend');

set local role anon;
select throws_ok('select * from public.wallet_month', '42501', NULL, 'anon cannot read wallet_month');
reset role;

select * from finish();
rollback;
