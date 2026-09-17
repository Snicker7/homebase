begin;
select plan(10);

select has_view('public', 'month_summary', 'month_summary exists');

-- Running the node suite against this database leaves rows behind (see the
-- README), and the views below read every row in the month, not just this
-- file's. The whole file rolls back, so clearing first costs nothing and makes
-- the numbers below mean what they say.
delete from public.transactions;
delete from public.budget_categories;
delete from public.accounts;
delete from public.plaid_items;
delete from public.events;
delete from public.ledger;
delete from public.habit_state;
delete from public.people;
delete from public.settings;

-- Fixture: income over the two months before this one, and this month a mix
-- of filed spend, wallet spend, and unfiled rows of every shape.
insert into public.people (email, name) values ('ann@x.com', 'Ann') on conflict do nothing;
insert into public.plaid_items (id, institution, access_token_id, linked_by)
  values ('item-t', 'Test Bank', gen_random_uuid(), 'ann@x.com');
insert into public.accounts (id, item_id, name) values ('acc-t', 'item-t', 'Checking');
insert into public.budget_categories (id, name, emoji, kind, wallet_owner) values
  ('groceries', 'Groceries', '🥕', 'spend', null),
  ('paycheck', 'Paycheck', '💵', 'income', null),
  ('wallet-ann', 'Ann''s wallet', '🌱', 'wallet', 'ann@x.com'),
  ('transfer', 'Transfer', '🔁', 'transfer', null)
  on conflict do nothing;

create temp table t as
  select date_trunc('month', (now() at time zone 'America/Denver'))::date as this_month;

insert into public.transactions (id, account_id, date, amount, merchant, pending, category_id, removed_at) values
  ('i2', 'acc-t', (select this_month - interval '2 months' from t)::date + 1, -1000, 'Payroll', false, 'paycheck', null),
  ('i1', 'acc-t', (select this_month - interval '1 month' from t)::date + 1, -1500, 'Payroll', false, 'paycheck', null),
  ('i0', 'acc-t', (select this_month from t) + 1,                              -1200, 'Payroll', false, 'paycheck', null),
  ('g0', 'acc-t', (select this_month from t) + 2, 50,  'Costco',    false, 'groceries',  null),
  ('w0', 'acc-t', (select this_month from t) + 2, 15,  'Coffee',    false, 'wallet-ann', null),
  ('t0', 'acc-t', (select this_month from t) + 2, 250, 'Card pay',  false, 'transfer',   null),
  ('u0', 'acc-t', (select this_month from t) + 3, 40,  'Unknown',   false, null, null),
  ('ud', 'acc-t', (select this_month from t) + 3, -200,'Deposit',   false, null, null),
  ('up', 'acc-t', (select this_month from t) + 3, 30,  'Pending',   true,  null, null),
  ('ur', 'acc-t', (select this_month from t) + 3, 60,  'Removed',   false, null, now());

select is((select count(*)::int from public.month_summary), 1, 'one row');
select is((select expected_income from public.month_summary), 1250.00::numeric(12,2),
  'expected income is the trailing average of income months, as a positive number');
select is((select spent_filed from public.month_summary), 65.00::numeric(12,2),
  'filed spend counts spend and wallet categories, not transfers');
select is((select spent_unfiled from public.month_summary), 40.00::numeric(12,2),
  'unfiled spend is settled, live, positive rows only');
select is((select remaining from public.month_summary), 1145.00::numeric(12,2),
  'remaining is expected income minus both kinds of spend');
select is((select months_in_window from public.month_summary), 2, 'window clamps to data start');

-- With no income history there is nothing to expect, and remaining goes negative.
delete from public.transactions where category_id = 'paycheck';
select is((select expected_income from public.month_summary), 0.00::numeric(12,2), 'no income history reads as zero');
select is((select remaining from public.month_summary), (-105.00)::numeric(12,2), 'and remaining is minus the spend');

set local role anon;
select throws_ok('select * from public.month_summary', '42501', NULL, 'anon cannot read month_summary');
reset role;

select * from finish();
rollback;
