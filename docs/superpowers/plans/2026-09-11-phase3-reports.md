# Homebase Phase 3: Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show where the money goes: each spending category's spend this month against its trailing average with a pace warning, and twelve months of history per category as bar charts.

**Architecture:** Two SQL views do the arithmetic in Postgres: `monthly_actuals` buckets non-removed, non-pending, non-transfer transactions by category and month; `category_pace` derives each spend category's spend so far this month, its trailing average over the last N complete months, the expected spend at this point of the month, and an `over_pace` flag. The browser reads both views directly under row-level security, exactly as it reads `bank_items`, and renders a Month screen and a History screen from one screen module with charts drawn as inline SVG by one pure helper that runs under Node for its tests.

**Tech Stack:** Supabase Postgres views with pgTAP tests, vanilla JS ES modules on GitHub Pages, inline SVG, Node 20 test runner.

**Spec:** `docs/superpowers/specs/2026-09-08-homebase-design.md`, sections Views, Reports, Frontend, Testing.

**Phase 2 reference:** `docs/superpowers/plans/2026-09-09-phase2-bank-sync.md` and the code it produced. Match its conventions.

## Global Constraints

- Time zone is `America/Denver`. "Today" inside a view is `(now() at time zone 'America/Denver')::date`; transaction dates are `date` columns and bucket by calendar month.
- Money is `numeric(12,2)`. Plaid's sign is kept: a positive `amount` is money out, so a spend category's monthly total is positive and an income category's is negative.
- The trailing window is N complete calendar months before the current month, N from `settings` key `trailingMonths` (jsonb), default 6, and never reaching earlier than the first month that holds any non-removed transaction. The average divides by the number of months actually in the window, so a young dataset is not diluted by empty months before data began.
- `expected = average × day_of_month ÷ days_in_month`; `over_pace = spent > expected`.
- Every spend category appears in `category_pace`, including ones with no spend this month. Only kind `spend` appears there.
- Views run as their owner and bypass row-level security, so each gets `revoke all ... from anon` and `grant select ... to authenticated`, exactly like `bank_items` in `0002_budget.sql`.
- The spec's `wallet_balance` view is **deliberately not built**: the dashboard already derives the wallet in the shared service (ledger rule minus wallet-tagged card rows) and a second SQL implementation of the same rule would drift. The spec's other two views are built as written.
- Frontend: vanilla ES modules, no build step, no charting library. Charts are inline SVG from `js/chart.js`, theme-aware through CSS custom properties, never hard-coded colors. Reads go through the exported `sb` client; nothing here writes.
- Routes: `#/budget` is the Month screen, `#/budget/history` is the History screen. A single nav link, Budget, opens `#/budget`.
- Every string from a bank or a person passes through `esc()` before entering innerHTML.
- Tests run with `npm test` from the repo root and must pass before a task is called done. pgTAP runs with `npx supabase test db` against the local stack, which must be started for this phase (`npx supabase start`; the images are already present).
- **The user commits.** No task runs `git push` or any deploy. Each task ends by reporting `git status --short` and a suggested commit subject. If `git commit` is refused by the session's permission classifier, leave the work staged and say so.
- Shipping this phase needs only `npx supabase db push` and a push to `main`. No function changes.

---

## File map

| Path | Responsibility |
| --- | --- |
| `supabase/migrations/0003_reports.sql` | `monthly_actuals` and `category_pace` views, grants |
| `supabase/tests/0003_reports.sql` | pgTAP over a fixture: exclusions, totals, window clamp, pace, settings override, anon denied |
| `js/chart.js` | `barChart(opts) → svg string`, pure |
| `js/chart.test.js` | Node tests for the helper |
| `js/reports.js` | `renderBudget(view)`: Month and History screens |
| `js/app.js` | routes `#/budget` and `#/budget/history`, `setView('budget')`, nav visibility |
| `index.html` | Budget nav link, `budgetView` section |
| `css/style.css` | pace rows, chart sizing, the month/history toggle |
| `package.json` | test glob gains `js/` |
| `README.md` | `trailingMonths` setting, phase 3 ship step |

---

### Task 1: The two views

**Files:**
- Create: `supabase/migrations/0003_reports.sql`
- Create: `supabase/tests/0003_reports.sql`

**Interfaces:**
- Produces view `monthly_actuals(category_id text, kind text, month date, total numeric(12,2), n int)` and view `category_pace(category_id text, name text, emoji text, spent numeric(12,2), average numeric(12,2), expected numeric(12,2), months_in_window int, day_of_month int, days_in_month int, over_pace boolean)`, both readable by `authenticated` only.

- [ ] **Step 1: Start the local stack and write the failing pgTAP test**

Run: `cd /mnt/c/Users/Snic9/homebase && npx supabase start`

`supabase/tests/0003_reports.sql`:

```sql
begin;
select plan(14);

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
  ('paycheck', 'Paycheck', '💵', 'income')
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
select ok((select over_pace from public.category_pace where category_id = 'groceries'), '50 beats any fraction of 20');
select is((select spent from public.category_pace where category_id = 'fun'), 0.00::numeric(12,2), 'a quiet category still has a row');
select ok((select not over_pace from public.category_pace where category_id = 'fun'), 'and is not over pace');
select is((select count(*)::int from public.category_pace where category_id = 'paycheck'), 0, 'income is not paced');

-- settings override narrows the window.
insert into public.settings (key, value) values ('trailingMonths', '1'::jsonb);
select is((select average from public.category_pace where category_id = 'groceries'), 30.00::numeric(12,2), 'trailingMonths = 1 averages last month only');

-- anon reads nothing.
set local role anon;
select throws_ok('select * from public.monthly_actuals', '42501', 'permission denied', 'anon cannot read monthly_actuals');
reset role;

select * from finish();
rollback;
```

Note the plan count: 2 + 4 + 7 + 1 + 1 = 15 assertions. Set `plan(15)`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx supabase db reset && npx supabase test db`
Expected: `0003_reports.sql` fails on `has_view('public', 'monthly_actuals')`.

- [ ] **Step 3: Write the migration**

`supabase/migrations/0003_reports.sql`:

```sql
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
    select coalesce((select (value #>> '{}')::int from public.settings where key = 'trailingMonths'), 6) as months
  ),
  bounds as (
    select date_trunc('month', today.d)::date as this_month,
           extract(day from today.d)::int as day_of_month,
           extract(day from (date_trunc('month', today.d) + interval '1 month' - interval '1 day'))::int as days_in_month,
           greatest(
             (date_trunc('month', today.d) - make_interval(months => n.months))::date,
             coalesce((select date_trunc('month', min(date))::date from public.transactions where removed_at is null),
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
           case when win.months_in_window > 0
                then coalesce(h.window_total, 0) / win.months_in_window
                else 0 end as average_raw,
           win.months_in_window, win.day_of_month, win.days_in_month
      from public.budget_categories c
      cross join win
      left join history h on h.category_id = c.id
      left join current cur on cur.category_id = c.id
     where c.kind = 'spend'
  )
  select category_id, name, emoji, spent,
         average_raw::numeric(12,2) as average,
         (average_raw * day_of_month / days_in_month)::numeric(12,2) as expected,
         months_in_window, day_of_month, days_in_month,
         (spent > average_raw * day_of_month / days_in_month) as over_pace
    from paced;

revoke all on public.monthly_actuals from anon;
revoke all on public.category_pace from anon;
grant select on public.monthly_actuals to authenticated;
grant select on public.category_pace to authenticated;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx supabase db reset && npx supabase test db`
Expected: all three test files pass; `0003_reports.sql` reports 15 of 15. If `average` comes back as `20.00` but the assertion fails on type, cast the expected side the same way the view does.

- [ ] **Step 5: Report**

Run `git status --short`. Suggested commit subject: `Add monthly actuals and pace views`.

---

### Task 2: The chart helper

**Files:**
- Create: `js/chart.js`
- Create: `js/chart.test.js`
- Modify: `package.json` (test glob)

**Interfaces:**
- Produces `barChart({ values, labels, line, width, height, format }) → string` where `values` is an array of numbers (one bar each), `labels` the same length (short strings under each bar), `line` an optional number drawn as a horizontal rule, `width`/`height` in CSS pixels (defaults 320 × 120), `format` an optional function used for the accessible title. The SVG uses `currentColor` for bars and the CSS custom property `--accent` for the line so it follows the theme.

- [ ] **Step 1: Write the failing tests**

`js/chart.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { barChart } from './chart.js';

const count = (s, re) => (s.match(re) || []).length;

test('barChart draws one bar per value and scales the tallest to the top', () => {
  const svg = barChart({ values: [10, 20, 40], labels: ['J', 'F', 'M'] });
  assert.strictEqual(count(svg, /<rect class="bar"/g), 3);
  const heights = [...svg.matchAll(/<rect class="bar"[^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(heights[2] > heights[1] && heights[1] > heights[0]);
  assert.ok(Math.abs(heights[2] - 2 * heights[1]) < 0.01, 'heights are proportional');
});

test('barChart draws the average line when given, at the right height', () => {
  const svg = barChart({ values: [10, 30], labels: ['a', 'b'], line: 20, height: 120 });
  assert.strictEqual(count(svg, /<line class="avg"/g), 1);
  const bar = Number(/<rect class="bar"[^>]*height="([\d.]+)"/.exec(svg)[1]);
  const y = Number(/<line class="avg"[^>]*y1="([\d.]+)"/.exec(svg)[1]);
  // 10 of 30 is a third of the plot height; the line at 20 sits two thirds up.
  const bottom = Number(/<rect class="bar"[^>]*y="([\d.]+)"/.exec(svg)[1]) + bar;
  assert.ok(Math.abs((bottom - y) - 2 * bar) < 0.5);
});

test('barChart survives all-zero and empty input without dividing by zero', () => {
  assert.match(barChart({ values: [0, 0], labels: ['a', 'b'] }), /<svg/);
  assert.match(barChart({ values: [], labels: [] }), /<svg/);
  assert.doesNotMatch(barChart({ values: [0, 0], labels: ['a', 'b'] }), /NaN/);
});

test('barChart escapes labels and carries an accessible title', () => {
  const svg = barChart({ values: [1], labels: ['<b>'], format: (v) => '$' + v });
  assert.match(svg, /&lt;b&gt;/);
  assert.match(svg, /<title>[^<]*\$1/);
});
```

Add `js/` to the test glob in `package.json`: `"test": "node --test supabase/functions/_shared/ scripts/ js/"`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test js/chart.test.js`
Expected: `Cannot find module './chart.js'`.

- [ ] **Step 3: Write the helper**

`js/chart.js`:

```js
// One SVG bar chart, as a string. Pure, so it tests under Node and renders
// anywhere innerHTML does. Colors come from the page: bars use currentColor,
// the average line uses --accent, so both follow the theme.
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function barChart({ values = [], labels = [], line, width = 320, height = 120, format }) {
  const padTop = 6, padBottom = 18, padX = 4;
  const plotH = height - padTop - padBottom;
  const n = values.length;
  const max = Math.max(line || 0, ...values.map((v) => Number(v) || 0), 0);
  const scale = max > 0 ? plotH / max : 0;
  const slot = n ? (width - padX * 2) / n : 0;
  const barW = Math.max(2, slot * 0.6);
  const fmt = format || ((v) => String(v));
  let out = '';
  values.forEach((v, i) => {
    const h = Math.max(0, (Number(v) || 0) * scale);
    const x = padX + i * slot + (slot - barW) / 2;
    const y = padTop + plotH - h;
    out += '<rect class="bar" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2"><title>' + esc(labels[i]) + ' ' + esc(fmt(v)) + '</title></rect>';
    out += '<text class="lbl" x="' + (x + barW / 2).toFixed(1) + '" y="' + (height - 4) + '" text-anchor="middle">' + esc(labels[i]) + '</text>';
  });
  if (line != null && max > 0) {
    const y = (padTop + plotH - (Number(line) || 0) * scale).toFixed(1);
    out += '<line class="avg" x1="' + padX + '" x2="' + (width - padX) + '" y1="' + y + '" y2="' + y + '"><title>average ' + esc(fmt(line)) + '</title></line>';
  }
  return '<svg class="chart" viewBox="0 0 ' + width + ' ' + height + '" width="100%" role="img" aria-label="bar chart">' +
    '<title>' + esc(values.map((v, i) => labels[i] + ' ' + fmt(v)).join(', ')) + '</title>' + out + '</svg>';
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: all pass, four new. If the proportional-height assertion is off by rounding, compare with a tolerance of 0.1 rather than 0.01.

- [ ] **Step 5: Report**

Run `git status --short`. Suggested commit subject: `Add SVG bar chart helper`.

---

### Task 3: The Month screen and the Budget route

**Files:**
- Create: `js/reports.js`
- Modify: `js/app.js` (imports, `setView`, `route`, `wire`)
- Modify: `index.html` (nav link, `budgetView` section)
- Modify: `css/style.css`

**Interfaces:**
- Consumes: `sb` from `js/api.js`; `$`, `esc`, `money` from `js/util.js`; `barChart` from `js/chart.js`; views from Task 1.
- Produces: `renderBudget(view)` with `view` `'month'` or `'history'`; History is filled in by Task 4, so this task renders a placeholder for it.

- [ ] **Step 1: Add the section and nav link**

In `index.html`, in the `.who` div after the Banks link:

```html
          <a id="navBudget" class="link-btn" href="#/budget" hidden>Budget</a>
```

After the `accountsView` section:

```html
      <!-- BUDGET: this month against the trailing average, and history -->
      <section id="budgetView" class="card" hidden>
        <div class="row" style="justify-content:space-between">
          <h2>Budget</h2>
          <a class="link-btn" href="#/">← Dashboard</a>
        </div>
        <div class="row seg">
          <a id="budgetTabMonth" class="seg-on" href="#/budget">This month</a>
          <a id="budgetTabHistory" class="ghost" href="#/budget/history">History</a>
        </div>
        <p id="budgetMeta" class="muted" hidden></p>
        <div id="budgetList"></div>
        <p id="budgetEmpty" class="muted" hidden></p>
      </section>
```

- [ ] **Step 2: Route it**

In `js/app.js`, add the import `import { renderBudget } from './reports.js';`. In `setView`, add `'budgetView'` to the list and `budget: 'budgetView'` to the map, and add `$('navBudget').hidden = !SIGNED_IN;` beside the other nav lines. In `route()`, before the dashboard fallback:

```js
  if (h === '#/budget') { setView('budget'); await renderBudget('month'); return; }
  if (h === '#/budget/history') { setView('budget'); await renderBudget('history'); return; }
```

- [ ] **Step 3: Write the Month screen**

`js/reports.js`:

```js
// Where the money goes. Month: each spending category against its trailing
// average with a pace bar. History: twelve months of bars per category with
// the average as a line. Both read views under RLS; nothing here writes.
import { sb } from './api.js';
import { $, esc, money } from './util.js';
import { barChart } from './chart.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => { const m = /^(\d{4})-(\d{2})/.exec(ym || ''); return m ? MONTHS[+m[2] - 1] : ''; };

export async function renderBudget(view) {
  $('budgetTabMonth').className = view === 'month' ? 'seg-on' : 'ghost';
  $('budgetTabHistory').className = view === 'history' ? 'seg-on' : 'ghost';
  const list = $('budgetList');
  const empty = $('budgetEmpty');
  const meta = $('budgetMeta');
  list.innerHTML = '<p class="muted">Loading…</p>';
  empty.hidden = true; meta.hidden = true;
  try {
    if (view === 'history') await renderHistory(list, empty, meta);
    else await renderMonth(list, empty, meta);
  } catch (err) {
    list.innerHTML = '';
    empty.hidden = false;
    empty.textContent = err.message;
  }
}

async function renderMonth(list, empty, meta) {
  const { data, error } = await sb.from('category_pace').select('*');
  if (error) throw new Error(error.message);
  list.innerHTML = '';
  if (!data.length) { empty.hidden = false; empty.textContent = 'No spending categories yet.'; return; }
  const w = data[0];
  meta.hidden = false;
  meta.textContent = 'Day ' + w.day_of_month + ' of ' + w.days_in_month +
    (w.months_in_window ? ' · average over the last ' + w.months_in_window + ' month' + (w.months_in_window === 1 ? '' : 's') : ' · no history yet');
  // Over-pace first, then by how far over, then by spend.
  data.sort((a, b) => (b.over_pace - a.over_pace) || ((b.spent - b.expected) - (a.spent - a.expected)) || (b.spent - a.spent));
  data.forEach((c) => list.appendChild(paceRow(c)));
}

function paceRow(c) {
  const spent = Number(c.spent), avg = Number(c.average), exp = Number(c.expected);
  const el = document.createElement('div');
  el.className = 'pace' + (c.over_pace ? ' over' : '');
  // The bar is spend against the whole month's average; the tick is where
  // spend should be today.
  const full = Math.max(avg, spent, 0.01);
  const fill = Math.min(100, spent / full * 100);
  const tick = Math.min(100, exp / full * 100);
  const diff = spent - exp;
  const status = !avg && !spent ? 'nothing yet'
    : c.over_pace ? 'over by ' + money(diff)
    : 'under by ' + money(-diff);
  el.innerHTML =
    '<div class="pace-head"><span class="pace-name">' + esc((c.emoji ? c.emoji + ' ' : '') + c.name) + '</span>' +
    '<span class="pace-nums"><b>' + money(spent) + '</b> <span class="muted">of ' + money(avg) + '</span></span></div>' +
    '<div class="pace-bar"><div class="pace-fill" style="width:' + fill.toFixed(1) + '%"></div>' +
    '<div class="pace-tick" style="left:' + tick.toFixed(1) + '%"></div></div>' +
    '<div class="pace-status">' + esc(status) + '</div>';
  return el;
}

async function renderHistory(list, empty) {
  list.innerHTML = '';
  empty.hidden = false;
  empty.textContent = 'History arrives in the next task.';
}
```

- [ ] **Step 4: Style it**

Append to `css/style.css`:

```css
/* ── budget ─────────────────────────────────────────────────────────────── */
.seg a {
  flex: 1;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  text-decoration: none;
  color: var(--ink);
  border: 1px solid var(--line);
}
.seg a.seg-on {
  background: var(--accent);
  color: #0e1230;
  border-color: var(--accent);
}
.pace {
  padding: 12px 0;
  border-bottom: 1px solid var(--line-soft);
}
.pace:last-child { border-bottom: none; }
.pace-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}
.pace-name { font-weight: 600; }
.pace-nums { font-variant-numeric: tabular-nums; white-space: nowrap; }
.pace-bar {
  position: relative;
  height: 10px;
  margin: 8px 0 6px;
  border-radius: 999px;
  background: var(--line-soft);
  overflow: hidden;
}
.pace-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--ok);
  transition: width 0.3s ease;
}
.pace.over .pace-fill { background: var(--danger); }
.pace-tick {
  position: absolute;
  top: -2px;
  width: 2px;
  height: 14px;
  background: var(--ink);
  opacity: 0.7;
}
.pace-status {
  font-size: 0.82rem;
  color: var(--muted);
}
.pace.over .pace-status { color: var(--danger); }
@media (prefers-color-scheme: light) {
  .seg a.seg-on { color: #fff; }
}
```

- [ ] **Step 5: Check it**

`node --check js/reports.js js/app.js`, then `npm test`. Serve the repo and confirm the page boots to the login view with a clean console (`python3 -m http.server 8000`, load with `/mnt/c/Program Files/Google/Chrome/Application/chrome.exe --headless=new --dump-dom http://127.0.0.1:8000/`). The signed-in render is checked by the controller in the mock harness.

- [ ] **Step 6: Report**

Run `git status --short`. Suggested commit subject: `Add the Budget month screen`.

---

### Task 4: The History screen

**Files:**
- Modify: `js/reports.js` (replace `renderHistory`)
- Modify: `css/style.css`

**Interfaces:**
- Consumes: `monthly_actuals` and `category_pace` (Task 1), `barChart` (Task 2).

- [ ] **Step 1: Replace the placeholder**

In `js/reports.js`, replace `renderHistory` with:

```js
// Twelve months per spend category, oldest to newest, the trailing average
// drawn across. Months with no spend are zero bars, not gaps.
async function renderHistory(list, empty, meta) {
  const [pace, rows] = await Promise.all([
    sb.from('category_pace').select('category_id,name,emoji,average,months_in_window'),
    sb.from('monthly_actuals').select('category_id,month,total').eq('kind', 'spend').gte('month', twelveMonthsAgo()),
  ]);
  if (pace.error) throw new Error(pace.error.message);
  if (rows.error) throw new Error(rows.error.message);
  list.innerHTML = '';
  if (!pace.data.length) { empty.hidden = false; empty.textContent = 'No spending categories yet.'; return; }
  const months = lastTwelveMonths();
  meta.hidden = false;
  meta.textContent = monthLabel(months[0]) + ' to ' + monthLabel(months[11]) + ' · line is the trailing average';
  const byCat = {};
  rows.data.forEach((r) => { (byCat[r.category_id] ||= {})[String(r.month).slice(0, 7)] = Number(r.total); });
  pace.data
    .sort((a, b) => Number(b.average) - Number(a.average))
    .forEach((c) => {
      const values = months.map((m) => (byCat[c.category_id] || {})[m] || 0);
      const el = document.createElement('div');
      el.className = 'hist';
      el.innerHTML =
        '<div class="pace-head"><span class="pace-name">' + esc((c.emoji ? c.emoji + ' ' : '') + c.name) + '</span>' +
        '<span class="pace-nums muted">avg ' + money(c.average) + '</span></div>' +
        barChart({ values, labels: months.map((m) => monthLabel(m).slice(0, 1)), line: Number(c.average) || undefined, format: money });
      list.appendChild(el);
    });
}

// "YYYY-MM" for the last twelve calendar months, oldest first, in local time.
function lastTwelveMonths() {
  const out = [];
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 11);
  for (let i = 0; i < 12; i++) {
    out.push(d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2));
    d.setMonth(d.getMonth() + 1);
  }
  return out;
}
const twelveMonthsAgo = () => lastTwelveMonths()[0] + '-01';
```

- [ ] **Step 2: Style the charts**

Append to `css/style.css`:

```css
.hist {
  padding: 12px 0;
  border-bottom: 1px solid var(--line-soft);
}
.hist:last-child { border-bottom: none; }
.chart {
  display: block;
  margin-top: 6px;
  color: var(--accent);
}
.chart .bar { fill: currentColor; opacity: 0.85; }
.chart .avg { stroke: var(--gold); stroke-width: 1.5; stroke-dasharray: 4 3; }
.chart .lbl { fill: var(--muted); font-size: 9px; }
```

- [ ] **Step 3: Check it**

`node --check js/reports.js`, `npm test`, and the headless boot check from Task 3.

- [ ] **Step 4: Report**

Run `git status --short`. Suggested commit subject: `Add the Budget history screen`.

---

### Task 5: Runbook and settings note

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the setting and the ship step**

In the `## Settings` table, add a row:

```markdown
| `trailingMonths` | `6` | How many complete months the Budget screen averages over. |
```

After the "Bank sync (phase 2)" section, add:

```markdown
## Reports (phase 3)

`npx supabase db push` applies `0003_reports.sql`, which adds the two views
the Budget screen reads. No function changes; push `main` and the Budget link
appears in the nav. The Month view compares each spending category with its
trailing average; the History view shows twelve months of bars per category.
```

- [ ] **Step 2: Report**

Run `git status --short`. Suggested commit subject: `Document the Budget screen`.

---

## Self-review

**Spec coverage.** Views `monthly_actuals` and `category_pace`: Task 1. `wallet_balance`: deliberately omitted, recorded under Global Constraints, because the shared service already derives it and the dashboard reads that. Month report with over-pace first: Task 3. History with twelve bars and the average line: Task 4. Accounts report: already the Banks screen from phase 2. Routes `#/budget` and `#/budget/history`: Task 3. Inline SVG from one helper: Task 2. Trailing window from `settings`, default 6: Task 1, documented in Task 5.

**Placeholders.** None: each step carries its code. Task 3's History placeholder is a deliberate stub that Task 4 replaces.

**Type consistency.** `category_pace` columns named in Task 1 are the ones `paceRow` reads in Task 3 and `renderHistory` selects in Task 4. `barChart`'s option names in Task 2 match the call in Task 4. `renderBudget(view)` is what `route()` calls in Task 3.
