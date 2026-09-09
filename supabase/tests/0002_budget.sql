begin;
select plan(9);

select has_table('public', 'plaid_items', 'plaid_items exists');
select has_table('public', 'accounts', 'accounts exists');
select has_table('public', 'transactions', 'transactions exists');
select has_table('public', 'budget_categories', 'budget_categories exists');
select has_table('public', 'category_rules', 'category_rules exists');
select has_view('public', 'bank_items', 'bank_items view exists');
select hasnt_column('public', 'bank_items', 'access_token_id', 'the view hides the vault id');

-- Seeded categories: one wallet per person and a transfer bucket.
select is(
  (select count(*)::int from public.budget_categories where kind = 'wallet'),
  2, 'two wallet categories are seeded'
);

-- The browser's anon role sees nothing: RLS is on with no anon policy.
set local role anon;
select is((select count(*)::int from public.transactions), 0, 'anon reads no transactions');
reset role;

select * from finish();
rollback;
