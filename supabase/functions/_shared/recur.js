// Stored rows in, occurrences out. Pure: no I/O, no clock, no imports, so the
// browser, dispatch, and the import script all run the same expansion.
//
// Days are 'YYYY-MM-DD' and times are 'HH:MM', both Denver wall-clock. They
// stay strings the whole way through: a 09:00 event is 09:00 on both sides of
// a DST boundary, which is only true because nothing here builds a local Date.

const DAY_MS = 86400000;
// Five years. A typo in repeat_until must not become an infinite loop.
export const MAX_WINDOW_DAYS = 1830;

const utc = (day) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
const pad = (n) => (n < 10 ? '0' : '') + n;
const makeDay = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);

export const addDays = (day, n) => new Date(utc(day) + n * DAY_MS).toISOString().slice(0, 10);
// ISO weekday: Monday 1 through Sunday 7.
export const weekday = (day) => ((new Date(utc(day)).getUTCDay() + 6) % 7) + 1;
// month is 1-12. Day zero of the next month is the last day of this one.
export const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const OVERRIDABLE = ['title', 'notes', 'categoryId', 'day', 'time', 'minutes'];

function occurrence(s, day) {
  return {
    eventId: s.id,
    // The date the rule produced, kept even when an override moves the
    // occurrence: it is the key of the exception row.
    seriesDay: day,
    day,
    title: s.title,
    notes: s.notes || '',
    categoryId: s.categoryId,
    time: s.time ? String(s.time).slice(0, 5) : null,
    minutes: s.minutes == null ? null : Number(s.minutes),
    repeating: !!s.repeat,
    readOnly: false,
    url: null,
    business: null,
    done: false,
    waitsOnClient: false,
  };
}

function* occurrenceDays(s, from, to) {
  const start = s.day;
  const last = s.repeatUntil && s.repeatUntil < to ? s.repeatUntil : to;
  if (!s.repeat) {
    if (start >= from && start <= to) yield start;
    return;
  }
  if (start > last) return;
  const r = s.repeat;

  if (r.freq === 'daily' || r.freq === 'weekly') {
    for (let d = start < from ? from : start; d <= last; d = addDays(d, 1)) {
      if (r.freq === 'daily' || r.days.includes(weekday(d))) yield d;
    }
    return;
  }

  if (r.freq === 'monthly') {
    const begin = start < from ? from : start;
    let y = +begin.slice(0, 4);
    let m = +begin.slice(5, 7);
    for (;;) {
      const dim = daysInMonth(y, m);
      // The 31st simply does not happen in a 30-day month. It never slides.
      if (r.day <= dim) {
        const d = makeDay(y, m, r.day);
        if (d > last) return;
        if (d >= from && d >= start) yield d;
      }
      if (makeDay(y, m, dim) >= last) return;
      if (++m > 12) { m = 1; y++; }
    }
  }

  if (r.freq === 'yearly') {
    const mo = +start.slice(5, 7);
    const dy = +start.slice(8, 10);
    const first = Math.max(+start.slice(0, 4), +from.slice(0, 4));
    for (let y = first; y <= +last.slice(0, 4); y++) {
      // 29 February in a common year is skipped, not moved to the 28th.
      if (dy > daysInMonth(y, mo)) continue;
      const d = makeDay(y, mo, dy);
      if (d >= from && d <= last && d >= start) yield d;
    }
  }
}

function expandUnchecked(series, exceptions, from, to) {
  const ex = new Map();
  for (const e of exceptions) if (e.eventId === series.id) ex.set(e.day, e);
  const out = [];
  for (const day of occurrenceDays(series, from, to)) {
    const hit = ex.get(day);
    if (hit && hit.skipped) continue;
    const o = occurrence(series, day);
    if (hit && hit.override) {
      for (const k of OVERRIDABLE) if (hit.override[k] !== undefined) o[k] = hit.override[k];
      if (o.time) o.time = String(o.time).slice(0, 5);
    }
    out.push(o);
  }
  return out;
}

export function expandSeries(series, exceptions, from, to) {
  if ((utc(to) - utc(from)) / DAY_MS > MAX_WINDOW_DAYS) {
    throw new Error('window wider than ' + MAX_WINDOW_DAYS + ' days');
  }
  return expandUnchecked(series, exceptions, from, to);
}

// Pad, then filter on the moved day: an override can carry an occurrence across
// either edge of the window, in or out, and the caller asked about days rather
// than about rules.
const PAD_DAYS = 31;

export function expandAll(seriesList, exceptions, from, to) {
  if ((utc(to) - utc(from)) / DAY_MS > MAX_WINDOW_DAYS) {
    throw new Error('window wider than ' + MAX_WINDOW_DAYS + ' days');
  }
  const out = [];
  for (const s of seriesList) {
    for (const o of expandUnchecked(s, exceptions, addDays(from, -PAD_DAYS), addDays(to, PAD_DAYS))) {
      if (o.day >= from && o.day <= to) out.push(o);
    }
  }
  return sortOccurrences(out);
}

// An office row is already one occurrence; it just speaks snake_case. Items with
// no brand are own tasks and belong to neither business.
export function officeOccurrence(row) {
  return {
    eventId: row.id,
    seriesDay: row.day,
    day: row.day,
    title: row.title || '',
    notes: '',
    categoryId: row.brand || 'office',
    time: row.time ? String(row.time).slice(0, 5) : null,
    minutes: row.minutes == null ? null : Number(row.minutes),
    repeating: false,
    readOnly: true,
    url: row.url || null,
    business: row.business || null,
    done: row.done === true,
    waitsOnClient: row.waits_on_client === true,
  };
}

// All-day first, because that is how a day reads: the backdrop, then the clock.
export function sortOccurrences(list) {
  return list.sort((a, b) =>
    (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) ||
    ((a.time ? 1 : 0) - (b.time ? 1 : 0)) ||
    ((a.time || '') < (b.time || '') ? -1 : (a.time || '') > (b.time || '') ? 1 : 0) ||
    String(a.title).localeCompare(String(b.title)));
}
