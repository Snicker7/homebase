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
  data.sort((a, b) =>
    ((b.over_pace ? 1 : 0) - (a.over_pace ? 1 : 0)) ||
    ((Number(b.spent) - Number(b.expected)) - (Number(a.spent) - Number(a.expected))) ||
    (Number(b.spent) - Number(a.spent)));
  data.forEach((c) => list.appendChild(paceRow(c)));
}

function paceRow(c) {
  const spent = Number(c.spent), avg = Number(c.average), exp = Number(c.expected);
  const el = document.createElement('div');
  el.className = 'pace' + (c.over_pace ? ' over' : '');
  // The bar is spend against the whole month's average; the tick is where
  // spend should be today.
  const full = Math.max(avg, spent, 0.01);
  const fill = Math.max(0, Math.min(100, spent / full * 100));
  const tick = Math.max(0, Math.min(100, exp / full * 100));
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

// Twelve months per spend category, oldest to newest, the trailing average
// drawn across. Months with no spend are zero bars, not gaps.
async function renderHistory(list, empty, meta) {
  const [pace, rows] = await Promise.all([
    sb.from('category_pace').select('category_id,name,emoji,average'),
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

// "YYYY-MM" for the last twelve calendar months, oldest first. Anchored on
// Denver's date, not the browser's, so the keys line up with the month buckets
// the views cut in Denver time.
const denverDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
function lastTwelveMonths() {
  const [year, month] = denverDate().split('-').map(Number);
  const out = [];
  for (let back = 11; back >= 0; back--) {
    const n = month - 1 - back;
    const y = year + Math.floor(n / 12);
    const m = ((n % 12) + 12) % 12 + 1;
    out.push(y + '-' + ('0' + m).slice(-2));
  }
  return out;
}
const twelveMonthsAgo = () => lastTwelveMonths()[0] + '-01';
