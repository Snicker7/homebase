-- Month summary: what is left this month once expected income meets the money
-- already gone. The trailing window that category_pace computed inline moves
-- into its own view so both reports cut the same months.

create view public.pace_window as
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
  )
  select this_month, day_of_month, days_in_month, window_start,
         ((extract(year from this_month) - extract(year from window_start)) * 12
           + extract(month from this_month) - extract(month from window_start))::int as months_in_window
    from bounds;

create or replace view public.category_pace as
  with history as (
    select m.category_id, sum(m.total) as window_total
      from public.monthly_actuals m, public.pace_window win
     where m.month >= win.window_start and m.month < win.this_month
     group by m.category_id
  ),
  current as (
    select m.category_id, m.total as spent
      from public.monthly_actuals m, public.pace_window win
     where m.month = win.this_month
  ),
  paced as (
    select c.id as category_id, c.name, c.emoji,
           coalesce(cur.spent, 0)::numeric(12,2) as spent,
           a.average_raw,
           a.average_raw * win.day_of_month / win.days_in_month as expected_raw,
           win.months_in_window, win.day_of_month, win.days_in_month
      from public.budget_categories c
      cross join public.pace_window win
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

-- One row. Expected income is the trailing average of the income categories,
-- flipped positive. Spent is every settled, live, non-transfer row dated this
-- month: filed ones through monthly_actuals (spend and wallet kinds, since a
-- wallet purchase still leaves the account), unfiled ones summed here, taking
-- only money out so an unfiled deposit cannot hide spend.
create view public.month_summary as
  with income as (
    select case when win.months_in_window > 0
                then -coalesce(sum(m.total), 0) / win.months_in_window
                else 0 end as expected_raw
      from public.pace_window win
      left join public.monthly_actuals m
        on m.kind = 'income' and m.month >= win.window_start and m.month < win.this_month
     group by win.months_in_window
  ),
  filed as (
    select coalesce(sum(m.total), 0) as spent
      from public.pace_window win
      left join public.monthly_actuals m
        on m.kind in ('spend', 'wallet') and m.month = win.this_month
  ),
  unfiled as (
    select coalesce(sum(t.amount), 0) as spent
      from public.pace_window win
      left join public.transactions t
        on t.category_id is null
       and t.removed_at is null
       and not t.pending
       and t.amount > 0
       and t.date >= win.this_month
       and t.date < (win.this_month + interval '1 month')::date
  )
  select income.expected_raw::numeric(12,2) as expected_income,
         filed.spent::numeric(12,2) as spent_filed,
         unfiled.spent::numeric(12,2) as spent_unfiled,
         (income.expected_raw - filed.spent - unfiled.spent)::numeric(12,2) as remaining,
         win.months_in_window, win.day_of_month, win.days_in_month
    from public.pace_window win, income, filed, unfiled;

revoke all on public.pace_window from anon;
revoke all on public.month_summary from anon;
grant select on public.pace_window to authenticated;
grant select on public.month_summary to authenticated;
