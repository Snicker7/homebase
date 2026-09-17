-- Personal wallets this month: what the habit and chore side paid each person,
-- and what left their wallet. Cuts the same month as month_summary by reading
-- pace_window, so the two blocks on the Budget screen can never disagree about
-- which month they mean.

create view public.wallet_month as
  with bounds as (
    select this_month, (this_month + interval '1 month')::date as next_month
      from public.pace_window
  ),
  -- The ledger's two sign conventions: `spend` stores a POSITIVE amount that
  -- the wallet subtracts, every other type stores an amount it adds — so a
  -- penalty is already negative and nets itself out of `earned`. A `deposit`
  -- is money carried in from outside, not something the house paid you.
  earned as (
    select l.actor, sum(l.amount) as total
      from public.ledger l, bounds b
     where l.type in ('entry', 'bonus', 'claim', 'penalty')
       and (l.ts at time zone 'America/Denver')::date >= b.this_month
       and (l.ts at time zone 'America/Denver')::date < b.next_month
     group by l.actor
  ),
  spent_ledger as (
    select l.actor, sum(l.amount) as total
      from public.ledger l, bounds b
     where l.type = 'spend'
       and (l.ts at time zone 'America/Denver')::date >= b.this_month
       and (l.ts at time zone 'America/Denver')::date < b.next_month
     group by l.actor
  ),
  -- A card purchase filed to someone's wallet category drained that wallet
  -- just as surely as a tapped-in spend, and the dashboard balance already
  -- subtracts it.
  spent_card as (
    select c.wallet_owner as actor, sum(t.amount) as total
      from public.transactions t
      join public.budget_categories c on c.id = t.category_id
      cross join bounds b
     where c.kind = 'wallet'
       and t.removed_at is null
       and not t.pending
       and t.date >= b.this_month
       and t.date < b.next_month
     group by c.wallet_owner
  )
  select p.email, p.name,
         coalesce(e.total, 0)::numeric(12,2) as earned,
         (coalesce(sl.total, 0) + coalesce(sc.total, 0))::numeric(12,2) as spent
    from public.people p
    left join earned e on e.actor = p.email
    left join spent_ledger sl on sl.actor = p.email
    left join spent_card sc on sc.actor = p.email;

revoke all on public.wallet_month from anon;
grant select on public.wallet_month to authenticated;
