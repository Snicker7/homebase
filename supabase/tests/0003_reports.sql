begin;
select plan(18);

select has_view('public', 'monthly_actuals', 'monthly_actuals exists');
select has_view('public', 'category_pace', 'category_pace exists');

-- Fixture: one bank, one account, categories, and transactions spread over
-- this month and the two before it, dated relative to today in Denver.
insert into public.people (email, name) values ('ann@x.com', 'Ann') on conflict do nothing;
insert into public.plaid_items (id, institution, access_token_id, linked_by)
  values ('item-t', 'Test Bank', gen_random_uuid(), 'ann@x.com');
insert into public.accounts (id, item_id, name) values ('acc-t', 'item-t', 'Checking');
insert into public.budget_categories (id, name, emoji, kind) values
  ('groceries', 'Groceries', '🥕', 'spend'),
  ('fun', 'Fun', '🎉', 'spend'),
  ('paycheck', 'Paycheck', '💵', 'income'),
  ('transfer', 'Transfer', '🔁', 'transfer')
  on conflict do nothing;

create temp table t as
  select date_trunc('month', (now() at time zone 'America/Denver'))::date as this_month;

insert into public.transactions (id, account_id, date, amount, merchant, pending, category_id, removed_at) values
  ('m2', 'acc-t', (select this_month - interval '2 months' from t)::date + 3, 10,  'Costco', false, 'groceries', null),
  ('m1a','acc-t', (select this_month - interval '1 month' from t)::date + 5, 10,  'Costco', false, 'groceries', null),
  ('m1b','acc-t', (select this_month - interval '1 month' from t)::date + 9, 20,  'Trader', false, 'groceries', null),
  ('m1p','acc-t', (select this_month - interval '1 month' from t)::date + 9, 99,  'Pending', true, 'groceries', null),
  ('m1r','acc-t', (select this_month - interval '1 month' from t)::date + 9, 99,  'Removed', false, 'groceries', now()),
  ('m1t','acc-t', (select this_month - interval '1 month' from t)::date + 9, 250, 'Card payment', false, 'transfer', null),
  ('m1i','acc-t', (select this_month - interval '1 month' from t)::date + 1, -1500, 'Payroll', false, 'paycheck', null),
  ('c1', 'acc-t', (select this_month from t), 50, 'Costco', false, 'groceries', null);

-- monthly_actuals
select is(
  (select total from public.monthly_actuals where category_id = 'groceries' and month = (select this_month - interval '1 month' from t)::date),
  30.00::numeric(12,2), 'last month sums the two settled grocery rows');
select is(
  (select count(*)::int from public.monthly_actuals where category_id = 'groceries' and month = (select this_month - interval '1 month' from t)::date),
  1, 'pending and removed rows do not add a bucket');
select is(
  (select count(*)::int from public.monthly_actuals where category_id = 'transfer'),
  0, 'transfers are excluded');
select is(
  (select total from public.monthly_actuals where category_id = 'paycheck'),
  (-1500.00)::numeric(12,2), 'income keeps its negative sign');

-- category_pace: data starts two months ago, so the window is two months even with N = 6.
select is((select spent from public.category_pace where category_id = 'groceries'), 50.00::numeric(12,2), 'spent so far this month');
select is((select months_in_window from public.category_pace where category_id = 'groceries'), 2, 'window clamps to data start');
select is((select average from public.category_pace where category_id = 'groceries'), 20.00::numeric(12,2), '(10 + 30) / 2');
select is(
  (select expected from public.category_pace where category_id = 'groceries'),
  (select (average * day_of_month / days_in_month)::numeric(12,2) from public.category_pace where category_id = 'groceries'),
  'expected is the average prorated to today');
select ok((select over_pace from public.category_pace where category_id = 'groceries'), '50 beats any fraction of 20');
select is((select spent from public.category_pace where category_id = 'fun'), 0.00::numeric(12,2), 'a quiet category still has a row');
select ok((select not over_pace from public.category_pace where category_id = 'fun'), 'and is not over pace');
select is((select count(*)::int from public.category_pace where category_id = 'paycheck'), 0, 'income is not paced');

-- settings override narrows the window.
insert into public.settings (key, value) values ('trailingMonths', '1'::jsonb);
select is((select average from public.category_pace where category_id = 'groceries'), 30.00::numeric(12,2), 'trailingMonths = 1 averages last month only');

-- a malformed setting is ignored rather than raising, so the view still answers.
delete from public.settings where key = 'trailingMonths';
insert into public.settings (key, value) values ('trailingMonths', '"six"'::jsonb);
select is((select average from public.category_pace where category_id = 'groceries'), 20.00::numeric(12,2), 'a non-integer trailingMonths falls back to the default');

-- anon reads nothing.
set local role anon;
select throws_ok('select * from public.monthly_actuals', '42501', NULL, 'anon cannot read monthly_actuals');
select throws_ok('select * from public.category_pace', '42501', NULL, 'anon cannot read category_pace');
reset role;

select * from finish();
rollback;
