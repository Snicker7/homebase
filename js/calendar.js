// The family calendar. Agenda is the default because it is what reads on a
// phone; month is the overview; tapping a day opens it. All three render the
// same sorted occurrence list, so a change to the data layer cannot make two
// views disagree.
import { sb } from './api.js';
import { $, esc } from './util.js';
import { expandAll, officeOccurrence, sortOccurrences, addDays } from '../supabase/functions/_shared/recur.js';
import { monthMatrix, monthBounds, monthTitle, shiftMonth, groupByDay, dayLabel, timeLabel, WEEKDAY_INITIALS } from './calgrid.js';

// Denver's date, not the browser's: every day and time in this app is Denver
// wall-clock, and a laptop in another zone must not shift what "today" means.
export const denverToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());

const AGENDA_DAYS = 42;
export let CATS = {};

async function loadCategories() {
  const { data, error } = await sb.from('event_categories').select('*').order('sort');
  if (error) throw new Error(error.message);
  CATS = Object.fromEntries(data.map((c) => [c.id, c]));
  return data;
}

// One read path for every view: series, their exceptions, and the office cache.
async function loadWindow(from, to) {
  const [series, office] = await Promise.all([
    sb.from('events').select('id,title,notes,category_id,day,time,minutes,repeat,repeat_until')
      .lte('day', to),
    sb.from('office_items').select('*').gte('day', from).lte('day', to),
  ]);
  if (series.error) throw new Error(series.error.message);
  if (office.error) throw new Error(office.error.message);

  // The overlap test is more than a column filter can say, so it is applied
  // here: a repeating series that started years ago still counts, a one-off
  // that happened years ago does not.
  const rows = series.data.filter((r) => (r.repeat ? !r.repeat_until || r.repeat_until >= from : r.day >= from));
  const ids = rows.map((r) => r.id);
  let exceptions = [];
  if (ids.length) {
    const { data, error } = await sb.from('event_exceptions').select('*').in('event_id', ids);
    if (error) throw new Error(error.message);
    exceptions = data.map((e) => ({ eventId: e.event_id, day: e.day, skipped: e.skipped, override: e.override }));
  }
  const mine = rows.map((r) => ({
    id: r.id, title: r.title, notes: r.notes, categoryId: r.category_id,
    day: r.day, time: r.time, minutes: r.minutes, repeat: r.repeat, repeatUntil: r.repeat_until,
  }));
  const items = expandAll(mine, exceptions, from, to).concat(office.data.map(officeOccurrence));
  return { items: sortOccurrences(items), office: office.data };
}

const color = (id) => (CATS[id] && CATS[id].color) || '#8d9bb5';

export async function renderCalendar(view, arg) {
  const body = $('calBody');
  $('calTabAgenda').className = view === 'agenda' ? 'seg-on' : 'ghost';
  $('calTabMonth').className = view === 'month' ? 'seg-on' : 'ghost';
  body.innerHTML = '<p class="muted">Loading…</p>';
  try {
    await loadCategories();
    if (view === 'month') await renderMonth(body, arg || denverToday().slice(0, 7));
    else if (view === 'day') await renderDay(body, arg || denverToday());
    else await renderAgenda(body);
  } catch (err) {
    body.innerHTML = '<p class="cal-error">' + esc(err.message) + '</p>';
  }
}

function officeAge(rows) {
  const el = $('calOfficeAge');
  if (!rows.length) { el.hidden = true; return; }
  const newest = rows.reduce((a, r) => (r.fetched_at > a ? r.fetched_at : a), rows[0].fetched_at);
  const mins = Math.round((Date.now() - new Date(newest).getTime()) / 60000);
  el.hidden = false;
  el.textContent = 'Office items synced ' + (mins < 2 ? 'just now' : mins < 60 ? mins + ' minutes ago' : Math.round(mins / 60) + ' hours ago') + '.';
}

async function renderAgenda(body) {
  const today = denverToday();
  const to = addDays(today, AGENDA_DAYS);
  const { items, office } = await loadWindow(today, to);
  officeAge(office);
  $('calTitle').textContent = 'Next six weeks';
  $('calPrev').hidden = true; $('calNext').hidden = true;
  const groups = groupByDay(items);
  body.innerHTML = groups.length
    ? '<div class="agenda">' + groups.map((g) =>
        '<section class="agenda-day"><h3>' + esc(dayLabel(g.day, today)) + '</h3>' +
        g.items.map(itemRow).join('') + '</section>').join('') + '</div>'
    : '<p class="muted">Nothing in the next six weeks.</p>';
}

async function renderMonth(body, ym) {
  const today = denverToday();
  const { from, to } = monthBounds(ym);
  const { items, office } = await loadWindow(from, to);
  officeAge(office);
  $('calTitle').textContent = monthTitle(ym);
  $('calPrev').hidden = false; $('calNext').hidden = false;
  $('calPrev').onclick = () => { location.hash = '#/calendar/month/' + shiftMonth(ym, -1); };
  $('calNext').onclick = () => { location.hash = '#/calendar/month/' + shiftMonth(ym, 1); };

  const byDay = {};
  for (const o of items) (byDay[o.day] ||= []).push(o);
  const cells = monthMatrix(ym).map((week) => week.map((day) => {
    const list = byDay[day] || [];
    // Three bars and a count: a fourth bar makes the cell unreadable on a phone
    // long before it makes the day clearer.
    const bars = list.slice(0, 3).map((o) =>
      '<span class="cal-bar' + (o.done ? ' done' : '') + (o.waitsOnClient ? ' waiting' : '') +
      '" style="--cat:' + esc(color(o.categoryId)) + '" title="' + esc(o.title) + '"></span>').join('');
    const more = list.length > 3 ? '<span class="cal-more">+' + (list.length - 3) + '</span>' : '';
    return '<a class="cal-cell' + (day.slice(0, 7) === ym ? '' : ' outside') + (day === today ? ' today' : '') +
      '" href="#/calendar/day/' + day + '"><span class="cal-dom">' + (+day.slice(8, 10)) + '</span>' +
      '<span class="cal-bars">' + bars + more + '</span></a>';
  }).join('')).join('');

  body.innerHTML =
    '<div class="cal-grid-head">' + WEEKDAY_INITIALS.map((d) => '<span>' + d + '</span>').join('') + '</div>' +
    '<div class="cal-grid">' + cells + '</div>';
}

async function renderDay(body, day) {
  const today = denverToday();
  const { items, office } = await loadWindow(day, day);
  officeAge(office);
  $('calTitle').textContent = dayLabel(day, today);
  $('calPrev').hidden = false; $('calNext').hidden = false;
  $('calPrev').onclick = () => { location.hash = '#/calendar/day/' + addDays(day, -1); };
  $('calNext').onclick = () => { location.hash = '#/calendar/day/' + addDays(day, 1); };
  body.innerHTML = items.length
    ? '<div class="agenda"><section class="agenda-day">' + items.map(itemRow).join('') + '</section></div>'
    : '<p class="muted">Nothing on this day.</p>';
}

function itemRow(o) {
  const cls = 'cal-item' + (o.readOnly ? ' readonly' : '') + (o.done ? ' done' : '') + (o.waitsOnClient ? ' waiting' : '');
  const inner =
    '<span class="cal-when">' + esc(timeLabel(o.time, o.minutes)) + '</span>' +
    '<span class="cal-what">' +
    (o.business ? '<span class="cal-business">' + esc(o.business) + '</span>' : '') +
    '<span class="cal-title-text">' + esc(o.title) + '</span></span>';
  // Office items are edited in the office; family events open the editor, which
  // arrives with the next task and until then does nothing.
  return o.readOnly && o.url
    ? '<a class="' + cls + '" style="--cat:' + esc(color(o.categoryId)) + '" href="' + esc(o.url) + '" target="_blank" rel="noopener">' + inner + '</a>'
    : '<div class="' + cls + '" style="--cat:' + esc(color(o.categoryId)) + '" data-event="' + esc(o.eventId) + '" data-day="' + esc(o.seriesDay) + '">' + inner + '</div>';
}

$('calTabAgenda').addEventListener('click', () => { location.hash = '#/calendar'; });
$('calTabMonth').addEventListener('click', () => { location.hash = '#/calendar/month'; });
$('calToday').addEventListener('click', () => { location.hash = '#/calendar/day/' + denverToday(); });
