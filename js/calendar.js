// The family calendar. Agenda is the default because it is what reads on a
// phone; month is the overview; tapping a day opens it. All three render the
// same sorted occurrence list, so a change to the data layer cannot make two
// views disagree.
import { sb, api } from './api.js';
import { $, esc, denverToday } from './util.js';
import { expandAll, officeOccurrence, sortOccurrences, addDays, weekday, timeLabel, fetchWindow, PAD_DAYS } from '../supabase/functions/_shared/recur.js';
import { monthMatrix, monthBounds, monthTitle, shiftMonth, groupByDay, dayLabel, WEEKDAY_INITIALS } from './calgrid.js';

const AGENDA_DAYS = 42;
let CATS = {};

// The list the screen last drew, so a click can find the occurrence behind a
// row without re-reading.
let LAST_ITEMS = [];

// What the form needs about a series that an occurrence alone cannot say: the
// real anchor day, and the rule in full. An occurrence carries the date the
// rule produced, which is not the date the series starts.
const SERIES = new Map();

async function loadCategories() {
  const { data, error } = await sb.from('event_categories').select('*').order('sort');
  if (error) throw new Error(error.message);
  CATS = Object.fromEntries(data.map((c) => [c.id, c]));
  return data;
}

// One read path for every view: series, their exceptions, and the office cache.
async function loadWindow(from, to) {
  SERIES.clear();
  // Series are selected over a wider window than they are drawn over, for the
  // reason fetchWindow gives. Office rows are one occurrence each with nothing
  // that can move them, so they are read over the window as asked.
  const fetch = fetchWindow(from, to);
  const [series, office] = await Promise.all([
    sb.from('events').select('id,title,notes,category_id,day,time,minutes,repeat,repeat_until')
      .lte('day', fetch.to),
    sb.from('office_items').select('*').gte('day', from).lte('day', to),
  ]);
  if (series.error) throw new Error(series.error.message);
  if (office.error) throw new Error(office.error.message);

  // The overlap test is more than a column filter can say, so it is applied
  // here: a repeating series that started years ago still counts, a one-off
  // that happened years ago does not.
  const rows = series.data.filter((r) => (r.repeat ? !r.repeat_until || r.repeat_until >= fetch.from : r.day >= fetch.from));
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
  for (const s of mine) SERIES.set(s.id, { day: s.day, repeat: s.repeat, repeatUntil: s.repeatUntil });
  const items = sortOccurrences(expandAll(mine, exceptions, from, to).concat(office.data.map(officeOccurrence)));
  LAST_ITEMS = items;
  return { items, office: office.data };
}

const color = (id) => (CATS[id] && CATS[id].color) || '#8d9bb5';

export async function renderCalendar(view, arg) {
  const body = $('calBody');
  $('calTabAgenda').className = view === 'agenda' ? 'seg-on' : 'ghost';
  $('calTabMonth').className = view === 'month' ? 'seg-on' : 'ghost';
  body.innerHTML = '<p class="muted">Loading…</p>';
  try {
    await loadCategories();
    renderCatList();
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
  // Office items are edited in the office; family events open the editor.
  return o.readOnly && o.url
    ? '<a class="' + cls + '" style="--cat:' + esc(color(o.categoryId)) + '" href="' + esc(o.url) + '" target="_blank" rel="noopener">' + inner + '</a>'
    : '<div class="' + cls + '" style="--cat:' + esc(color(o.categoryId)) + '" data-event="' + esc(o.eventId) + '" data-day="' + esc(o.seriesDay) + '">' + inner + '</div>';
}

$('calTabAgenda').addEventListener('click', () => { location.hash = '#/calendar'; });
$('calTabMonth').addEventListener('click', () => { location.hash = '#/calendar/month'; });
$('calToday').addEventListener('click', () => { location.hash = '#/calendar/day/' + denverToday(); });

/* ── the editor ───────────────────────────────────────────────────────────── */
// What the open form is editing: a new event, a whole series, or one occurrence.
let editing = null; // { id, seriesDay, scope: 'series' | 'occurrence' }

function openEditor(occurrence) {
  const e = occurrence;
  const series = e ? SERIES.get(e.eventId) : null;
  editing = e ? { id: e.eventId, seriesDay: e.seriesDay, title: e.title, scope: 'series' } : null;
  $('calFormError').hidden = true;
  $('calId').value = e ? e.eventId : '';
  $('calTitleInput').value = e ? e.title : '';
  $('calNotes').value = e ? e.notes : '';
  // A series edit acts on the series' own start date; an occurrence edit
  // substitutes the occurrence's date below, once the scope is known.
  $('calDay').value = e ? (series ? series.day : e.day) : denverToday();
  $('calAllDay').checked = !e || !e.time;
  $('calTime').value = e && e.time ? e.time : '09:00';
  $('calMinutes').value = e && e.minutes ? e.minutes : 60;
  // A retired category leaves the picker but keeps its events, so an edit that
  // never touched the category needs an option to round-trip through.
  const options = Object.values(CATS).filter((c) => c.active && !c.system);
  if (e && CATS[e.categoryId] && !options.some((c) => c.id === e.categoryId)) options.push(CATS[e.categoryId]);
  $('calCategory').innerHTML = options
    .map((c) => '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>').join('');
  if (e) $('calCategory').value = e.categoryId;
  $('calRepeat').value = series && series.repeat ? series.repeat.freq : '';
  $('calUntil').value = series && series.repeatUntil ? series.repeatUntil : '';
  $('calDelete').hidden = !e;
  // Only an occurrence edit is bounded, and the click handler sets that bound
  // once it knows the scope; every other open must clear it again.
  $('calDay').min = ''; $('calDay').max = '';
  // An occurrence edit hides this below; every other open must show it again,
  // since nothing else resets it.
  $('calRepeat').closest('label').hidden = false;
  // Only a stored weekly rule seeds these; anything else leaves them empty so
  // the first switch to weekly picks up whatever date is in the form by then.
  // A rule with no day list is one recur.js refuses to expand, guarded here
  // for the same reason it is guarded there.
  const stored = series && series.repeat && series.repeat.freq === 'weekly' && Array.isArray(series.repeat.days)
    ? series.repeat.days : null;
  setWeekdays(stored || []);
  // A stored rule is somebody's choice already; only a set this module seeded
  // is allowed to follow the date around.
  weekdaysPicked = !!stored;
  showScope(e, 'series');
  syncFormBits();
  $('calEditor').hidden = false;
  $('calTitleInput').focus();
}

// Whether the weekday ticks are somebody's choice or this module's default.
let weekdaysPicked = false;

function syncFormBits() {
  $('calTimed').hidden = $('calAllDay').checked;
  $('calUntilWrap').hidden = !$('calRepeat').value;
  const weekly = $('calRepeat').value === 'weekly';
  $('calWeekdays').hidden = !weekly;
  // The start weekday is the one day a weekly rule must contain, so it is the
  // default — and it follows the date until somebody ticks a box themselves,
  // after which their set stands and the validator speaks if it has to.
  if (weekly && !weekdaysPicked) setWeekdays([weekday($('calDay').value)]);
}

const weekdayBoxes = () => [...$('calWeekdays').querySelectorAll('[data-weekday]')];
const weekdaysFromForm = () => weekdayBoxes().filter((b) => b.checked).map((b) => +b.dataset.weekday);
const setWeekdays = (days) => { for (const b of weekdayBoxes()) b.checked = days.includes(+b.dataset.weekday); };

// Which of the two edits is open, said rather than inferred from whether the
// Repeat control happens to be showing. A one-off has only one meaning.
function showScope(occurrence, scope) {
  const el = $('calScope');
  el.hidden = !occurrence || !occurrence.repeating;
  if (el.hidden) return;
  el.textContent = scope === 'occurrence'
    ? 'Editing this occurrence · ' + dayLabel(occurrence.day, denverToday())
    : 'Editing the whole series';
}

function repeatFromForm(day, prev) {
  const freq = $('calRepeat').value;
  if (!freq) return null;
  // An imported series can repeat on several weekdays; re-deriving from the
  // start day alone would silently drop the others.
  if (freq === 'weekly') {
    const chosen = weekdaysFromForm();
    if (chosen.length) return { freq, days: chosen };
    return prev && prev.freq === 'weekly' && prev.days.includes(weekday(day))
      ? { freq, days: prev.days }
      : { freq, days: [weekday(day)] };
  }
  if (freq === 'monthly') return { freq, day: +day.slice(8, 10) };
  return { freq };
}

async function submitEvent(ev) {
  ev.preventDefault();
  const day = $('calDay').value;
  const allDay = $('calAllDay').checked;
  const prevRule = editing && SERIES.get(editing.id) ? SERIES.get(editing.id).repeat : null;
  const payload = {
    id: $('calId').value || undefined,
    title: $('calTitleInput').value,
    notes: $('calNotes').value,
    categoryId: $('calCategory').value,
    day,
    time: allDay ? null : $('calTime').value,
    minutes: allDay ? null : Number($('calMinutes').value),
    repeat: repeatFromForm(day, prevRule),
    repeatUntil: $('calUntil').value || null,
  };
  const res = editing && editing.scope === 'occurrence'
    ? await api('occurrenceSave', {
        eventId: editing.id, day: editing.seriesDay,
        override: { title: payload.title, notes: payload.notes, categoryId: payload.categoryId,
                    day: payload.day, time: payload.time, minutes: payload.minutes },
      })
    : await api('eventSave', payload);
  if (!res.ok) { $('calFormError').hidden = false; $('calFormError').textContent = res.error; return; }
  closeEditor();
  await renderCalendar(currentView(), currentArg());
}

async function deleteEvent() {
  if (!editing) return;
  // Deleting a series takes every occurrence and every exception row with it,
  // and there is no undo anywhere in this app.
  const series = SERIES.get(editing.id);
  if (editing.scope !== 'occurrence' && series && series.repeat &&
      !window.confirm('Delete every occurrence of "' + editing.title + '"?')) return;
  const res = editing.scope === 'occurrence'
    ? await api('occurrenceSkip', { eventId: editing.id, day: editing.seriesDay })
    : await api('eventDelete', { id: editing.id });
  if (!res.ok) { $('calFormError').hidden = false; $('calFormError').textContent = res.error; return; }
  closeEditor();
  await renderCalendar(currentView(), currentArg());
}

function closeEditor() { $('calEditor').hidden = true; editing = null; }

// The hash is the source of truth for which view to re-render after a write.
const currentView = () => {
  const h = location.hash;
  return h.startsWith('#/calendar/month') ? 'month' : h.startsWith('#/calendar/day/') ? 'day' : 'agenda';
};
const currentArg = () => {
  const h = location.hash;
  if (h.startsWith('#/calendar/month/')) return h.slice(17);
  if (h.startsWith('#/calendar/day/')) return h.slice(15);
  return undefined;
};

// A repeating event asks which it means; a one-off has only one answer.
async function askScope(occurrence) {
  if (!occurrence.repeating) return 'series';
  return window.confirm('This event repeats.\n\nOK changes just this one.\nCancel changes the whole series.')
    ? 'occurrence' : 'series';
}

$('calBody').addEventListener('click', async (ev) => {
  const row = ev.target.closest('.cal-item[data-event]');
  if (!row) return;
  const found = LAST_ITEMS.find((o) => o.eventId === row.dataset.event && o.seriesDay === row.dataset.day);
  // Office items are edited in the office; a url-less one still renders as a div.
  if (!found || found.readOnly) return;
  const scope = await askScope(found);
  openEditor(found);
  editing.scope = scope;
  // A whole-series edit keeps the anchor day openEditor already seeded; an
  // occurrence edit is about this one date, so it overrides that back.
  if (scope === 'occurrence') {
    $('calDay').value = found.day;
    // The expander only reaches PAD_DAYS past a view's edge, so a longer move
    // would leave the occurrence in no view at all. Say so in the picker rather
    // than at the far end of a round trip.
    $('calDay').min = addDays(found.seriesDay, -PAD_DAYS);
    $('calDay').max = addDays(found.seriesDay, PAD_DAYS);
  }
  // Editing one occurrence cannot change the rule, so the rule controls go away.
  $('calRepeat').closest('label').hidden = scope === 'occurrence';
  $('calUntilWrap').hidden = scope === 'occurrence' || !$('calRepeat').value;
  $('calWeekdays').hidden = scope === 'occurrence' || $('calRepeat').value !== 'weekly';
  showScope(found, scope);
});

$('calAdd').addEventListener('click', () => openEditor(null));
$('calCancel').addEventListener('click', closeEditor);
$('calDelete').addEventListener('click', deleteEvent);
$('calForm').addEventListener('submit', submitEvent);
$('calAllDay').addEventListener('change', syncFormBits);
$('calRepeat').addEventListener('change', syncFormBits);
$('calDay').addEventListener('change', syncFormBits);
$('calWeekdays').addEventListener('change', () => { weekdaysPicked = true; });

$('calSync').addEventListener('click', async () => {
  $('calSync').disabled = true;
  const res = await api('officeRefresh', {});
  $('calSync').disabled = false;
  if (!res.ok) { $('calOfficeAge').hidden = false; $('calOfficeAge').textContent = res.error; return; }
  await renderCalendar(currentView(), currentArg());
});

/* ── categories ───────────────────────────────────────────────────────────── */
// The three system rows are the importer's and cannot be retired, but their
// colors are as editable as any other: they appear on the same calendar.
function renderCatList() {
  $('calCatList').innerHTML = Object.values(CATS).filter((c) => c.active).map((c) =>
    '<div class="cal-cat" data-id="' + esc(c.id) + '">' +
    '<input type="color" value="' + esc(c.color) + '" data-color />' +
    '<input type="text" value="' + esc(c.name) + '" maxlength="40" data-name />' +
    (c.system ? '<span class="muted cal-cat-tag">office</span>' : '<button type="button" class="ghost" data-retire>Retire</button>') +
    '</div>').join('');
}

async function saveCat(id, name, color) {
  const res = await api('calCategorySave', { id, name, color });
  $('calCatError').hidden = res.ok;
  if (!res.ok) { $('calCatError').textContent = res.error; return false; }
  await renderCalendar(currentView(), currentArg());
  return true;
}

$('calCatList').addEventListener('change', async (ev) => {
  const row = ev.target.closest('.cal-cat');
  if (!row) return;
  await saveCat(row.dataset.id, row.querySelector('[data-name]').value, row.querySelector('[data-color]').value);
});

$('calCatList').addEventListener('click', async (ev) => {
  if (!ev.target.matches('[data-retire]')) return;
  const row = ev.target.closest('.cal-cat');
  if (!window.confirm('Retire this category? Events already using it keep it.')) return;
  const res = await api('calCategoryRetire', { id: row.dataset.id });
  $('calCatError').hidden = res.ok;
  if (!res.ok) { $('calCatError').textContent = res.error; return; }
  await renderCalendar(currentView(), currentArg());
});

// The picker keeps whatever was chosen last, which reads as the next category's
// colour already being decided.
const NEW_CAT_COLOR = $('calCatColor').value;

$('calCatForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (await saveCat(null, $('calCatName').value, $('calCatColor').value)) {
    $('calCatName').value = '';
    $('calCatColor').value = NEW_CAT_COLOR;
  }
});
