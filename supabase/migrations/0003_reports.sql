-- Reports. Two views do the arithmetic; the browser reads them under RLS.

-- Settled, live, non-transfer transactions bucketed by category and month.
-- Plaid's sign is kept: spend totals are positive, income totals negative.
create view public.monthly_actuals as
  select t.category_id,
         c.kind,
         date_trunc('month', t.date)::date as month,
         sum(t.amount)::numeric(12,2) as total,
         count(*)::int as n
    from public.transactions t
    join public.budget_categories c on c.id = t.category_id
   where t.removed_at is null
     and not t.pending
     and c.kind <> 'transfer'
   group by t.category_id, c.kind, date_trunc('month', t.date);

-- Each spend category against its own recent past. The window is the last N
-- complete months (settings.trailingMonths, default 6) but never reaches back
-- before the first month with data, and the average divides by the months
-- actually in the window, so a young dataset is not diluted by empty months.
create view public.category_pace as
  with today as (
    select (now() at time zone 'America/Denver')::date as d
  ),
  n as (
    -- A malformed setting must not blank the screen, so a non-integer reads as
    -- the default and the window is never shorter than a month.
    select greatest(1, coalesce(
      (select case when (value #>> '{}') ~ '^[1-9][0-9]*$' then (value #>> '{}')::int end
         from public.settings where key = 'trailingMonths'), 6)) as months
  ),
  bounds as (
    select date_trunc('month', today.d)::date as this_month,
           extract(day from today.d)::int as day_of_month,
           extract(day from (date_trunc('month', today.d) + interval '1 month' - interval '1 day'))::int as days_in_month,
           greatest(
             (date_trunc('month', today.d) - make_interval(months => n.months))::date,
             coalesce((select min(month) from public.monthly_actuals),
                      date_trunc('month', today.d)::date)
           ) as window_start
      from today, n
  ),
  win as (
    select this_month, day_of_month, days_in_month, window_start,
           ((extract(year from this_month) - extract(year from window_start)) * 12
             + extract(month from this_month) - extract(month from window_start))::int as months_in_window
      from bounds
  ),
  history as (
    select m.category_id, sum(m.total) as window_total
      from public.monthly_actuals m, win
     where m.month >= win.window_start and m.month < win.this_month
     group by m.category_id
  ),
  current as (
    select m.category_id, m.total as spent
      from public.monthly_actuals m, win
     where m.month = win.this_month
  ),
  paced as (
    select c.id as category_id, c.name, c.emoji,
           coalesce(cur.spent, 0)::numeric(12,2) as spent,
           a.average_raw,
           a.average_raw * win.day_of_month / win.days_in_month as expected_raw,
           win.months_in_window, win.day_of_month, win.days_in_month
      from public.budget_categories c
      cross join win
      left join history h on h.category_id = c.id
      left join current cur on cur.category_id = c.id
      cross join lateral (
        select case when win.months_in_window > 0
                    then coalesce(h.window_total, 0) / win.months_in_window
                    else 0 end as average_raw
      ) a
     where c.kind = 'spend'
  )
  select category_id, name, emoji, spent,
         average_raw::numeric(12,2) as average,
         expected_raw::numeric(12,2) as expected,
         months_in_window, day_of_month, days_in_month,
         -- One expected value feeds both the flag and the column, so a rounded
         -- number can never contradict the flag beside it. With no history
         -- there is no pace to be over.
         (months_in_window > 0 and spent > expected_raw) as over_pace
    from paced;

revoke all on public.monthly_actuals from anon;
revoke all on public.category_pace from anon;
grant select on public.monthly_actuals to authenticated;
grant select on public.category_pace to authenticated;
