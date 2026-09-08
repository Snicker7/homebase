begin;
select plan(11);

select has_table('public', 'people', 'people exists');
select has_table('public', 'categories', 'categories exists');
select has_table('public', 'ledger', 'ledger exists');
select has_table('public', 'habit_state', 'habit_state exists');
select has_table('public', 'chore_state', 'chore_state exists');
select has_table('public', 'settings', 'settings exists');
select has_table('public', 'holidays', 'holidays exists');

select col_type_is('public', 'ledger', 'amount', 'numeric(10,2)', 'ledger.amount is money');

-- RLS is on and nobody but the service role can read.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.ledger'::regclass),
  'ledger has RLS enabled'
);

-- Only allowlisted emails may become auth users.
insert into public.people (email, name) values ('ann@x.com', 'Ann');
select lives_ok(
  $$ insert into auth.users (id, email, instance_id, aud, role)
     values (gen_random_uuid(), 'ann@x.com', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated') $$,
  'allowlisted email is accepted'
);
select throws_ok(
  $$ insert into auth.users (id, email, instance_id, aud, role)
     values (gen_random_uuid(), 'stranger@x.com', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated') $$,
  'P0001',
  'signups are closed',
  'unknown email is rejected'
);

select * from finish();
rollback;
